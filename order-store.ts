export type OrderStatus =
  | 'awaiting_payment'
  | 'payment_submitted'
  | 'abandoned'
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
  /**
   * How long the active checkout has held the claim, or null when none does. Reported
   * on /health so an unreconciled checkout is one look rather than a log dig: an age past
   * {@link ABANDONED_CHECKOUT_AFTER_SECONDS} says the next admission will reclaim it. The
   * checkout's ID is deliberately NOT reported — /health is public, and the reason to want
   * the ID was to repair the record by hand, which no longer arises.
   */
  readonly activeCheckoutAgeSeconds: number | null;
  readonly transactionsUsedToday: number;
}

const MAX_PENDING_WEBHOOKS = 8;
const PENDING_WEBHOOK_RETENTION_SECONDS = 15 * 60;
const PENDING_WEBHOOK_RETENTION_MS = PENDING_WEBHOOK_RETENTION_SECONDS * 1000;
/**
 * How long an unreconciled checkout may hold the single-active-checkout claim before
 * the next admission reclaims it as `abandoned`. Matches the pending-webhook retention
 * above: past that point this store has already stopped waiting for a delivery it
 * cannot match, so it is the same judgement about the same latency.
 *
 * Measured from `updated_at`, not `created_at`, so the window runs from the last thing
 * that actually happened to the order. A payment submitted late in a slow checkout then
 * gets the full window from its submission, which is the transition a real terminal
 * webhook follows.
 */
export const ABANDONED_CHECKOUT_AFTER_SECONDS = 15 * 60;
const ABANDONED_CHECKOUT_AFTER_MS = ABANDONED_CHECKOUT_AFTER_SECONDS * 1000;

export interface OrderStore {
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
  const updatedAt = new Map<string, Date>();
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

  const save = (checkoutId: string, order: StoredOrder) => {
    orders.set(checkoutId, order);
    updatedAt.set(checkoutId, now());
  };
  /** The one entry holding the single-active-checkout claim, if any. */
  const claimHolder = () =>
    [...orders.entries()].find(([, stored]) => holdsClaim(stored.status));
  /**
   * Release a claim nothing has advanced inside the window. Runs on the admission path
   * only: a claim is genuinely held until it is reclaimed, so a read must not report
   * otherwise, and /health must not mutate.
   */
  const reclaimStaleClaim = () => {
    const cutoff = new Date(now().getTime() - ABANDONED_CHECKOUT_AFTER_MS);
    for (const [checkoutId, stored] of orders) {
      const touched = updatedAt.get(checkoutId);
      if (holdsClaim(stored.status) && touched && touched < cutoff) {
        save(checkoutId, { ...stored, status: 'abandoned' });
      }
    }
  };

  return {
    getUsage: async () => {
      const startOfToday = startOfUtcDay(now());
      const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
      const holder = claimHolder();
      const heldSince = holder ? updatedAt.get(holder[0]) : undefined;
      return {
        activeCheckout: holder !== undefined,
        activeCheckoutAgeSeconds: heldSince
          ? Math.floor((now().getTime() - heldSince.getTime()) / 1000)
          : null,
        transactionsUsedToday: [...createdAt.values()].filter(
          (created) => created >= startOfToday && created < startOfTomorrow,
        ).length,
      };
    },
    createOrGetWithinCap: async (order, transactionCap) => {
      // Before the lookup below, so a retry of the STUCK checkout reclaims it too. The
      // shopper holding a claim nothing reconciled is the likeliest person to try again,
      // and reclaiming first is what turns their retry into the repair: they are told to
      // start a new checkout instead of submitting against an order that can no longer
      // reconcile. Reclaiming after the lookup would heal the store only for whoever
      // came next.
      reclaimStaleClaim();
      const existing = orders.get(order.checkoutId);
      if (existing) {
        assertSameOrder(existing, order);
        return existing;
      }
      if (claimHolder()) return 'active_checkout';
      const admissionTime = now();
      const startOfToday = startOfUtcDay(admissionTime);
      const startOfTomorrow = new Date(startOfToday.getTime() + 24 * 60 * 60 * 1000);
      const usedToday = [...createdAt.values()].filter(
        (created) => created >= startOfToday && created < startOfTomorrow,
      ).length;
      if (usedToday >= transactionCap) return 'cap_reached';
      save(order.checkoutId, { ...order });
      createdAt.set(order.checkoutId, admissionTime);
      options.onWrite?.();
      return order;
    },
    getByCheckoutId: async (checkoutId) => orders.get(checkoutId),
    attachPaymentReference: async (checkoutId, paymentReferenceHash) => {
      const order = requireOrder(orders, checkoutId);
      paymentReferences.set(paymentReferenceHash, checkoutId);
      if (isTerminal(order.status)) return 'terminal_noop';
      // A reclaimed checkout does NOT re-take the claim: another checkout may hold it by
      // now, and two holders is the one thing the unique index refuses. The reference is
      // still attached above, which is what lets a late terminal webhook find the order.
      if (holdsClaim(order.status)) {
        save(checkoutId, { ...order, status: 'payment_submitted' });
      }
      const pendingCutoff = new Date(now().getTime() - PENDING_WEBHOOK_RETENTION_MS);
      for (const [deliveryHash, delivery] of pendingDeliveries) {
        if (delivery.receivedAt < pendingCutoff) pendingDeliveries.delete(deliveryHash);
      }
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
          save(checkoutId, { ...current, status: delivery.status });
        }
      }
      return 'attached';
    },
    markPaymentFailed: async (checkoutId) => {
      const order = requireOrder(orders, checkoutId);
      if (isTerminal(order.status)) return 'terminal_noop';
      save(checkoutId, { ...order, status: 'payment_failed' });
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
        if (!claimHolder()) return 'unowned';
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
      save(checkoutId, { ...order, status: input.status });
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

function isTerminal(status: OrderStatus): status is 'paid' | 'payment_failed' {
  return status === 'paid' || status === 'payment_failed';
}

/**
 * Whether a status holds the single-active-checkout claim. The same two statuses spell
 * the predicate of `sample_store_orders_single_active_idx`; `abandoned` is outside it,
 * which is the whole of how a reclaimed checkout stops blocking the store.
 */
function holdsClaim(status: OrderStatus): boolean {
  return status === 'awaiting_payment' || status === 'payment_submitted';
}

function startOfUtcDay(value: Date): Date {
  return new Date(
    Date.UTC(value.getUTCFullYear(), value.getUTCMonth(), value.getUTCDate()),
  );
}

function assertSameOrder(existing: StoredOrder, requested: StoredOrder) {
  if (
    existing.idempotencyKey !== requested.idempotencyKey ||
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
