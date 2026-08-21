import type { Sql, TransactionSql } from 'postgres';

export type OrderStatus =
  | 'awaiting_payment'
  | 'payment_submitted'
  | 'paid'
  | 'payment_failed';

export interface StoredOrder {
  readonly checkoutId: string;
  readonly idempotencyKey: string;
  readonly status: OrderStatus;
  readonly productId: string;
  readonly amount: number;
  readonly currency: string;
}

export interface OrderStoreUsage {
  readonly activeCheckout: boolean;
  readonly transactionsUsedToday: number;
}

/** Serializes the UTC-day cap and active-checkout checks across application instances. */
const TRANSACTION_CAP_LOCK_KEY = 194_837_201;
const PENDING_WEBHOOK_LOCK_KEY = 194_837_202;
const PAYMENT_REFERENCE_LOCK_SEED = 645;
const MAX_PENDING_WEBHOOKS = 8;
const PENDING_WEBHOOK_RETENTION_MS = 15 * 60 * 1000;

export interface OrderStore {
  checkReady(): Promise<boolean>;
  getUsage(): Promise<OrderStoreUsage>;
  createOrGetWithinCap(
    order: StoredOrder,
    transactionCap: number,
  ): Promise<StoredOrder | 'active_checkout' | 'cap_reached'>;
  getByCheckoutId(checkoutId: string): Promise<StoredOrder | undefined>;
  attachPaymentReference(
    checkoutId: string,
    paymentReferenceHash: string,
  ): Promise<'attached' | 'terminal_noop'>;
  markPaymentFailed(checkoutId: string): Promise<'applied' | 'terminal_noop'>;
  applyWebhook(input: {
    deliveryHash: string;
    paymentReferenceHash: string;
    status: Extract<OrderStatus, 'paid' | 'payment_failed'>;
    occurredAt: Date;
  }): Promise<
    | 'applied'
    | 'capacity_reached'
    | 'duplicate'
    | 'staged'
    | 'terminal_noop'
    | 'unowned'
  >;
  purgeDeliveriesBefore(cutoff: Date): Promise<number>;
}

export function createMemoryOrderStore(
  options: { readonly now?: () => Date; readonly onWrite?: () => void } = {},
): OrderStore & { deliveryCount(): number } {
  const orders = new Map<string, StoredOrder>();
  const createdAt = new Map<string, Date>();
  const paymentReferences = new Map<string, string>();
  const deliveries = new Map<string, Date>();
  const pendingDeliveries = new Map<
    string,
    {
      paymentReferenceHash: string;
      status: Extract<OrderStatus, 'paid' | 'payment_failed'>;
      occurredAt: Date;
      receivedAt: Date;
    }
  >();
  const now = options.now ?? (() => new Date());

  return {
    checkReady: async () => true,
    getUsage: async () => {
      const startOfToday = startOfUtcDay(now());
      const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
      return {
        activeCheckout: [...orders.values()].some(
          (stored) =>
            stored.status === 'awaiting_payment' || stored.status === 'payment_submitted',
        ),
        transactionsUsedToday: [...createdAt.values()].filter(
          (created) => created >= startOfToday && created < startOfTomorrow,
        ).length,
      };
    },
    createOrGetWithinCap: async (order, transactionCap) => {
      const existing = orders.get(order.checkoutId);
      if (existing) {
        assertSameOrder(existing, order);
        return existing;
      }
      if (
        [...orders.values()].some(
          (stored) =>
            stored.status === 'awaiting_payment' || stored.status === 'payment_submitted',
        )
      ) {
        return 'active_checkout';
      }
      const admissionTime = now();
      const startOfToday = startOfUtcDay(admissionTime);
      const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
      const usedToday = [...createdAt.values()].filter(
        (created) => created >= startOfToday && created < startOfTomorrow,
      ).length;
      if (usedToday >= transactionCap) return 'cap_reached';
      orders.set(order.checkoutId, { ...order });
      createdAt.set(order.checkoutId, admissionTime);
      options.onWrite?.();
      return order;
    },
    getByCheckoutId: async (checkoutId) => orders.get(checkoutId),
    attachPaymentReference: async (checkoutId, paymentReferenceHash) => {
      const order = requireOrder(orders, checkoutId);
      paymentReferences.set(paymentReferenceHash, checkoutId);
      if (isTerminal(order.status)) return 'terminal_noop';
      orders.set(checkoutId, { ...order, status: 'payment_submitted' });
      const pending = [...pendingDeliveries.entries()]
        .filter(([, delivery]) => delivery.paymentReferenceHash === paymentReferenceHash)
        .sort((left, right) => {
          const byTime = left[1].occurredAt.getTime() - right[1].occurredAt.getTime();
          return byTime || left[0].localeCompare(right[0]);
        });
      for (const [deliveryHash, delivery] of pending) {
        pendingDeliveries.delete(deliveryHash);
        deliveries.set(deliveryHash, now());
        const current = requireOrder(orders, checkoutId);
        if (!isTerminal(current.status)) {
          orders.set(checkoutId, { ...current, status: delivery.status });
        }
      }
      return 'attached';
    },
    markPaymentFailed: async (checkoutId) => {
      const order = requireOrder(orders, checkoutId);
      if (isTerminal(order.status)) return 'terminal_noop';
      orders.set(checkoutId, { ...order, status: 'payment_failed' });
      return 'applied';
    },
    applyWebhook: async (input) => {
      if (deliveries.has(input.deliveryHash) || pendingDeliveries.has(input.deliveryHash)) {
        return 'duplicate';
      }
      const checkoutId = paymentReferences.get(input.paymentReferenceHash);
      if (!checkoutId) {
        const pendingCutoff = new Date(now().getTime() - PENDING_WEBHOOK_RETENTION_MS);
        for (const [deliveryHash, delivery] of pendingDeliveries) {
          if (delivery.receivedAt < pendingCutoff) pendingDeliveries.delete(deliveryHash);
        }
        const hasActiveCheckout = [...orders.values()].some(
          (stored) =>
            stored.status === 'awaiting_payment' || stored.status === 'payment_submitted',
        );
        if (!hasActiveCheckout) return 'unowned';
        if (pendingDeliveries.size >= MAX_PENDING_WEBHOOKS) return 'capacity_reached';
        pendingDeliveries.set(input.deliveryHash, {
          paymentReferenceHash: input.paymentReferenceHash,
          status: input.status,
          occurredAt: input.occurredAt,
          receivedAt: now(),
        });
        return 'staged';
      }
      const order = requireOrder(orders, checkoutId);
      deliveries.set(input.deliveryHash, now());
      if (isTerminal(order.status)) return 'terminal_noop';
      orders.set(checkoutId, { ...order, status: input.status });
      return 'applied';
    },
    purgeDeliveriesBefore: async (cutoff) => {
      let purged = 0;
      for (const [deliveryHash, receivedAt] of deliveries) {
        if (receivedAt < cutoff) {
          deliveries.delete(deliveryHash);
          purged += 1;
        }
      }
      for (const [deliveryHash, delivery] of pendingDeliveries) {
        if (delivery.receivedAt < cutoff) {
          pendingDeliveries.delete(deliveryHash);
          purged += 1;
        }
      }
      return purged;
    },
    deliveryCount: () => deliveries.size,
  };
}

export function createPostgresOrderStore(sql: Sql): OrderStore {
  return {
    checkReady: async () => {
      const rows = await sql<{
        activeCheckout: string | null;
        dailyCap: string | null;
        deliveries: string | null;
        deliveryRetention: string | null;
        orders: string | null;
        pendingDeliveries: string | null;
        pendingReference: string | null;
        pendingRetention: string | null;
      }[]>`
        SELECT
          to_regclass('sample_store_orders')::text AS orders,
          to_regclass('sample_store_webhook_deliveries')::text AS deliveries,
          to_regclass('sample_store_webhook_deliveries_retention_idx')::text
            AS "deliveryRetention",
          to_regclass('sample_store_orders_utc_day_idx')::text AS "dailyCap",
          to_regclass('sample_store_orders_single_active_idx')::text
            AS "activeCheckout",
          to_regclass('sample_store_pending_webhooks')::text
            AS "pendingDeliveries",
          to_regclass('sample_store_pending_webhooks_reference_idx')::text
            AS "pendingReference",
          to_regclass('sample_store_pending_webhooks_retention_idx')::text
            AS "pendingRetention"
      `;
      return Boolean(
        rows[0]?.orders &&
          rows[0]?.deliveries &&
          rows[0]?.deliveryRetention &&
          rows[0]?.dailyCap &&
          rows[0]?.activeCheckout &&
          rows[0]?.pendingDeliveries &&
          rows[0]?.pendingReference &&
          rows[0]?.pendingRetention,
      );
    },
    getUsage: async () => {
      const rows = await sql<OrderStoreUsage[]>`
        SELECT
          EXISTS (
            SELECT 1
            FROM sample_store_orders
            WHERE status IN ('awaiting_payment', 'payment_submitted')
          ) AS "activeCheckout",
          count(*) FILTER (
            WHERE created_at >= (
              date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
            )
              AND created_at < (
                (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day')
                AT TIME ZONE 'UTC'
              )
          )::int AS "transactionsUsedToday"
        FROM sample_store_orders
      `;
      return rows[0] ?? { activeCheckout: false, transactionsUsedToday: 0 };
    },
    createOrGetWithinCap: async (order, transactionCap) =>
      sql.begin(async (transaction) => {
        await transaction`SELECT pg_advisory_xact_lock(${TRANSACTION_CAP_LOCK_KEY})`;
        const existingRows = await transaction<StoredOrder[]>`
          SELECT
            checkout_id AS "checkoutId",
            idempotency_key AS "idempotencyKey",
            status,
            product_id AS "productId",
            amount,
            currency
          FROM sample_store_orders
          WHERE checkout_id = ${order.checkoutId}
        `;
        const existing = existingRows[0];
        if (existing) {
          assertSameOrder(existing, order);
          return existing;
        }
        const activeRows = await transaction<{ active: boolean }[]>`
          SELECT EXISTS (
            SELECT 1
            FROM sample_store_orders
            WHERE status IN ('awaiting_payment', 'payment_submitted')
          ) AS active
        `;
        if (activeRows[0]?.active) return 'active_checkout' as const;
        const [counted] = await transaction<{ count: number }[]>`
          SELECT count(*)::int AS count
          FROM sample_store_orders
          WHERE created_at >= (
            date_trunc('day', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
          )
            AND created_at < (
              (date_trunc('day', now() AT TIME ZONE 'UTC') + interval '1 day')
              AT TIME ZONE 'UTC'
            )
        `;
        if ((counted?.count ?? 0) >= transactionCap) return 'cap_reached' as const;
        await transaction`
          INSERT INTO sample_store_orders (
            checkout_id,
            idempotency_key,
            status,
            product_id,
            amount,
            currency
          )
          VALUES (
            ${order.checkoutId},
            ${order.idempotencyKey},
            ${order.status},
            ${order.productId},
            ${order.amount},
            ${order.currency}
          )
        `;
        return order;
      }),
    getByCheckoutId: (checkoutId) => getOrder(sql, checkoutId),
    attachPaymentReference: async (checkoutId, paymentReferenceHash) => {
      return sql.begin(async (transaction) => {
        await lockPaymentReference(transaction, paymentReferenceHash);
        const orders = await transaction<{ status: OrderStatus; paymentReferenceHash: string | null }[]>`
          SELECT status, payment_reference_hash AS "paymentReferenceHash"
          FROM sample_store_orders
          WHERE checkout_id = ${checkoutId}
          FOR UPDATE
        `;
        const order = orders[0];
        if (!order) throw new Error('order_not_found');
        if (order.paymentReferenceHash && order.paymentReferenceHash !== paymentReferenceHash) {
          throw new Error('payment_reference_conflict');
        }
        if (!order.paymentReferenceHash) {
          await transaction`
            UPDATE sample_store_orders
            SET payment_reference_hash = ${paymentReferenceHash},
                status = CASE
                  WHEN status IN ('awaiting_payment', 'payment_submitted')
                    THEN 'payment_submitted'
                  ELSE status
                END,
                updated_at = now()
            WHERE checkout_id = ${checkoutId}
          `;
        }
        const pending = await transaction<{
          deliveryHash: string;
          status: Extract<OrderStatus, 'paid' | 'payment_failed'>;
          occurredAt: Date;
        }[]>`
          SELECT
            delivery_hash AS "deliveryHash",
            terminal_status AS status,
            occurred_at AS "occurredAt"
          FROM sample_store_pending_webhooks
          WHERE payment_reference_hash = ${paymentReferenceHash}
          ORDER BY occurred_at, delivery_hash
          FOR UPDATE
        `;
        let terminalApplied = isTerminal(order.status);
        for (const delivery of pending) {
          await transaction`
            INSERT INTO sample_store_webhook_deliveries (
              delivery_hash,
              checkout_id,
              received_at
            )
            VALUES (${delivery.deliveryHash}, ${checkoutId}, now())
            ON CONFLICT (delivery_hash) DO NOTHING
          `;
          if (!terminalApplied) {
            await transaction`
              UPDATE sample_store_orders
              SET status = ${delivery.status}, updated_at = now()
              WHERE checkout_id = ${checkoutId}
                AND status IN ('awaiting_payment', 'payment_submitted')
            `;
            terminalApplied = true;
          }
        }
        if (pending.length > 0) {
          await transaction`
            DELETE FROM sample_store_pending_webhooks
            WHERE payment_reference_hash = ${paymentReferenceHash}
          `;
        }
        return isTerminal(order.status) ? 'terminal_noop' as const : 'attached' as const;
      });
    },
    markPaymentFailed: async (checkoutId) => {
      const rows = await sql`
        UPDATE sample_store_orders
        SET status = 'payment_failed', updated_at = now()
        WHERE checkout_id = ${checkoutId}
          AND status IN ('awaiting_payment', 'payment_submitted')
      `;
      if (rows.count === 1) return 'applied' as const;
      const existing = await getOrder(sql, checkoutId);
      if (!existing) throw new Error('order_not_found');
      return 'terminal_noop' as const;
    },
    applyWebhook: async (input) =>
      sql.begin(async (transaction) => {
        await lockPaymentReference(transaction, input.paymentReferenceHash);
        const accepted = await transaction<{ present: boolean }[]>`
          SELECT EXISTS (
            SELECT 1
            FROM sample_store_webhook_deliveries
            WHERE delivery_hash = ${input.deliveryHash}
          ) AS present
        `;
        if (accepted[0]?.present) return 'duplicate' as const;
        const orders = await transaction<{ checkoutId: string }[]>`
          SELECT checkout_id AS "checkoutId"
          FROM sample_store_orders
          WHERE payment_reference_hash = ${input.paymentReferenceHash}
          FOR UPDATE
        `;
        const order = orders[0];
        if (!order) {
          await transaction`SELECT pg_advisory_xact_lock(${PENDING_WEBHOOK_LOCK_KEY})`;
          await transaction`
            DELETE FROM sample_store_pending_webhooks
            WHERE received_at < now() - interval '15 minutes'
          `;
          const ownership = await transaction<{ active: boolean; pending: number }[]>`
            SELECT
              EXISTS (
                SELECT 1
                FROM sample_store_orders
                WHERE status IN ('awaiting_payment', 'payment_submitted')
              ) AS active,
              (SELECT count(*)::int FROM sample_store_pending_webhooks) AS pending
          `;
          if (!ownership[0]?.active) return 'unowned' as const;
          if ((ownership[0]?.pending ?? 0) >= MAX_PENDING_WEBHOOKS) {
            return 'capacity_reached' as const;
          }
          const staged = await transaction`
            INSERT INTO sample_store_pending_webhooks (
              delivery_hash,
              payment_reference_hash,
              terminal_status,
              occurred_at
            )
            VALUES (
              ${input.deliveryHash},
              ${input.paymentReferenceHash},
              ${input.status},
              ${input.occurredAt}
            )
            ON CONFLICT (delivery_hash) DO NOTHING
          `;
          return staged.count === 1 ? 'staged' as const : 'duplicate' as const;
        }
        const deliveries = await transaction`
          INSERT INTO sample_store_webhook_deliveries (
            delivery_hash,
            checkout_id,
            received_at
          )
          VALUES (${input.deliveryHash}, ${order.checkoutId}, now())
          ON CONFLICT (delivery_hash) DO NOTHING
        `;
        if (deliveries.count === 0) return 'duplicate' as const;
        const updated = await transaction`
          UPDATE sample_store_orders
          SET status = ${input.status}, updated_at = now()
          WHERE checkout_id = ${order.checkoutId}
            AND status IN ('awaiting_payment', 'payment_submitted')
        `;
        return updated.count === 1 ? 'applied' as const : 'terminal_noop' as const;
      }),
    purgeDeliveriesBefore: async (cutoff) => {
      const rows = await sql`
        DELETE FROM sample_store_webhook_deliveries
        WHERE received_at < ${cutoff}
      `;
      const pending = await sql`
        DELETE FROM sample_store_pending_webhooks
        WHERE received_at < ${cutoff}
      `;
      return rows.count + pending.count;
    },
  };
}

async function lockPaymentReference(
  sql: Sql | TransactionSql,
  paymentReferenceHash: string,
): Promise<void> {
  await sql`
    SELECT pg_advisory_xact_lock(
      hashtextextended(${paymentReferenceHash}, ${PAYMENT_REFERENCE_LOCK_SEED})
    )
  `;
}

function isTerminal(status: OrderStatus): status is 'paid' | 'payment_failed' {
  return status === 'paid' || status === 'payment_failed';
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

async function getOrder(sql: Sql, checkoutId: string): Promise<StoredOrder | undefined> {
  const rows = await sql<StoredOrder[]>`
    SELECT
      checkout_id AS "checkoutId",
      idempotency_key AS "idempotencyKey",
      status,
      product_id AS "productId",
      amount,
      currency
    FROM sample_store_orders
    WHERE checkout_id = ${checkoutId}
  `;
  return rows[0];
}

function assertSameOrder(existing: StoredOrder, requested: StoredOrder) {
  if (
    existing.productId !== requested.productId ||
    existing.amount !== requested.amount ||
    existing.currency !== requested.currency
  ) {
    throw new Error('order_reference_conflict');
  }
}

function requireOrder(orders: Map<string, StoredOrder>, checkoutId: string): StoredOrder {
  const order = orders.get(checkoutId);
  if (!order) throw new Error('order_not_found');
  return order;
}
