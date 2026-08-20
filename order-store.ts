import type { Sql } from 'postgres';

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

/** Serializes the lifetime cap check against concurrent order creation. */
const TRANSACTION_CAP_LOCK_KEY = 194_837_201;

export interface OrderStore {
  checkReady(): Promise<boolean>;
  createOrGetWithinCap(
    order: StoredOrder,
    transactionCap: 0 | 1,
  ): Promise<StoredOrder | 'cap_reached'>;
  getByCheckoutId(checkoutId: string): Promise<StoredOrder | undefined>;
  attachPaymentReference(checkoutId: string, paymentReferenceHash: string): Promise<void>;
  applyWebhook(input: {
    deliveryHash: string;
    paymentReferenceHash: string;
    status: Extract<OrderStatus, 'paid' | 'payment_failed'>;
    occurredAt: Date;
  }): Promise<'applied' | 'duplicate' | 'unknown_order'>;
  purgeDeliveriesBefore(cutoff: Date): Promise<number>;
}

export function createMemoryOrderStore(
  options: { readonly onWrite?: () => void } = {},
): OrderStore & { deliveryCount(): number } {
  const orders = new Map<string, StoredOrder>();
  const paymentReferences = new Map<string, string>();
  const deliveries = new Map<string, Date>();

  return {
    checkReady: async () => true,
    createOrGetWithinCap: async (order, transactionCap) => {
      const existing = orders.get(order.checkoutId);
      if (existing) {
        assertSameOrder(existing, order);
        return existing;
      }
      if (orders.size >= transactionCap) return 'cap_reached';
      orders.set(order.checkoutId, { ...order });
      options.onWrite?.();
      return order;
    },
    getByCheckoutId: async (checkoutId) => orders.get(checkoutId),
    attachPaymentReference: async (checkoutId, paymentReferenceHash) => {
      const order = requireOrder(orders, checkoutId);
      paymentReferences.set(paymentReferenceHash, checkoutId);
      orders.set(checkoutId, { ...order, status: 'payment_submitted' });
    },
    applyWebhook: async (input) => {
      if (deliveries.has(input.deliveryHash)) return 'duplicate';
      const checkoutId = paymentReferences.get(input.paymentReferenceHash);
      if (!checkoutId) return 'unknown_order';
      const order = requireOrder(orders, checkoutId);
      deliveries.set(input.deliveryHash, input.occurredAt);
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
      return purged;
    },
    deliveryCount: () => deliveries.size,
  };
}

export function createPostgresOrderStore(sql: Sql): OrderStore {
  return {
    checkReady: async () => {
      const rows = await sql<{ orders: string | null; deliveries: string | null }[]>`
        SELECT
          to_regclass('sample_store_orders')::text AS orders,
          to_regclass('sample_store_webhook_deliveries')::text AS deliveries
      `;
      return Boolean(rows[0]?.orders && rows[0]?.deliveries);
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
        const [counted] = await transaction<{ count: number }[]>`
          SELECT count(*)::int AS count FROM sample_store_orders
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
      const rows = await sql`
        UPDATE sample_store_orders
        SET payment_reference_hash = ${paymentReferenceHash},
            status = 'payment_submitted',
            updated_at = now()
        WHERE checkout_id = ${checkoutId}
      `;
      if (rows.count !== 1) throw new Error('order_not_found');
    },
    applyWebhook: async (input) =>
      sql.begin(async (transaction) => {
        const orders = await transaction<{ checkoutId: string }[]>`
          SELECT checkout_id AS "checkoutId"
          FROM sample_store_orders
          WHERE payment_reference_hash = ${input.paymentReferenceHash}
          FOR UPDATE
        `;
        const order = orders[0];
        if (!order) return 'unknown_order' as const;
        const deliveries = await transaction`
          INSERT INTO sample_store_webhook_deliveries (
            delivery_hash,
            checkout_id,
            received_at
          )
          VALUES (${input.deliveryHash}, ${order.checkoutId}, ${input.occurredAt})
          ON CONFLICT (delivery_hash) DO NOTHING
        `;
        if (deliveries.count === 0) return 'duplicate' as const;
        await transaction`
          UPDATE sample_store_orders
          SET status = ${input.status}, updated_at = now()
          WHERE checkout_id = ${order.checkoutId}
        `;
        return 'applied' as const;
      }),
    purgeDeliveriesBefore: async (cutoff) => {
      const rows = await sql`
        DELETE FROM sample_store_webhook_deliveries
        WHERE received_at < ${cutoff}
      `;
      return rows.count;
    },
  };
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
