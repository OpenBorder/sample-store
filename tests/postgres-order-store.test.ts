import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import postgres from 'postgres';
import { createPostgresOrderStore, type StoredOrder } from '../order-store';

const databaseUrl = process.env.PAY645_POSTGRES_TEST_URL;

if (databaseUrl) assertDisposableDatabase(databaseUrl);

before(async () => {
  if (!databaseUrl) return;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`DROP TABLE IF EXISTS sample_store_pending_webhooks, sample_store_webhook_deliveries, sample_store_orders CASCADE`;
    for (const migration of [
      '001_durable_orders.sql',
      '002_daily_transaction_cap.sql',
      '003_webhook_reconciliation.sql',
    ]) {
      const contents = await readFile(join(process.cwd(), 'migrations', migration), 'utf8');
      await sql.unsafe(contents);
    }
  } finally {
    await sql.end();
  }
});

after(async () => {
  if (!databaseUrl) return;
  const sql = postgres(databaseUrl, { max: 1 });
  try {
    await sql`DROP TABLE IF EXISTS sample_store_pending_webhooks, sample_store_webhook_deliveries, sample_store_orders CASCADE`;
  } finally {
    await sql.end();
  }
});

test(
  'PostgreSQL serializes admission and durably reconciles an early terminal webhook',
  { skip: databaseUrl ? false : 'PAY645_POSTGRES_TEST_URL is not configured' },
  async () => {
    const sql = postgres(databaseUrl!, { max: 8 });
    try {
      await sql`TRUNCATE sample_store_pending_webhooks, sample_store_webhook_deliveries, sample_store_orders`;

      const store = createPostgresOrderStore(sql);
      assert.equal(await store.checkReady(), true);

      const orders = Array.from({ length: 4 }, (_, index): StoredOrder => ({
        checkoutId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        idempotencyKey: `stable-key-${index + 1}`,
        status: 'awaiting_payment',
        productId: 'hoodie',
        amount: 3400,
        currency: 'GBP',
      }));
      const admitted = await Promise.all(
        orders.map((order) => store.createOrGetWithinCap(order, 50)),
      );
      assert.equal(admitted.filter((result) => result === 'active_checkout').length, 3);
      const accepted = admitted.find(
        (result): result is StoredOrder =>
          result !== 'active_checkout' && result !== 'cap_reached',
      );
      assert.ok(accepted);

      const paymentReferenceHash = 'private-payment-reference-hash';
      const webhook = {
        deliveryHash: 'private-delivery-hash',
        paymentReferenceHash,
        status: 'paid' as const,
        occurredAt: new Date('2026-08-21T13:00:00.000Z'),
      };
      const staged = await Promise.all([
        store.applyWebhook(webhook),
        store.applyWebhook(webhook),
      ]);
      assert.deepEqual([...staged].sort(), ['duplicate', 'staged']);

      await store.attachPaymentReference(accepted.checkoutId, paymentReferenceHash);
      assert.equal((await store.getByCheckoutId(accepted.checkoutId))?.status, 'paid');
      assert.equal(
        await store.applyWebhook({
          ...webhook,
          deliveryHash: 'private-contradictory-delivery-hash',
          status: 'payment_failed',
          occurredAt: new Date('2026-08-21T13:01:00.000Z'),
        }),
        'terminal_noop',
      );
      assert.equal((await store.getByCheckoutId(accepted.checkoutId))?.status, 'paid');

      await sql`TRUNCATE sample_store_pending_webhooks, sample_store_webhook_deliveries, sample_store_orders`;
      const expiredCheckoutId = '30000000-0000-4000-8000-000000000001';
      await store.createOrGetWithinCap(
        {
          checkoutId: expiredCheckoutId,
          idempotencyKey: 'expired-race-key',
          status: 'awaiting_payment',
          productId: 'hoodie',
          amount: 3400,
          currency: 'GBP',
        },
        50,
      );
      await store.applyWebhook({
        deliveryHash: 'expired-private-delivery-hash',
        paymentReferenceHash: 'expired-private-reference-hash',
        status: 'paid',
        occurredAt: new Date('2026-08-21T13:00:00.000Z'),
      });
      await sql`
        UPDATE sample_store_pending_webhooks
        SET received_at = now() - interval '16 minutes'
      `;
      await store.attachPaymentReference(expiredCheckoutId, 'expired-private-reference-hash');
      assert.equal((await store.getByCheckoutId(expiredCheckoutId))?.status, 'payment_submitted');
      const expiredAggregates = await sql<{ deliveries: number; pending: number }[]>`
        SELECT
          (SELECT count(*)::int FROM sample_store_webhook_deliveries) AS deliveries,
          (SELECT count(*)::int FROM sample_store_pending_webhooks) AS pending
      `;
      assert.deepEqual(expiredAggregates[0], { deliveries: 0, pending: 0 });

      await sql`TRUNCATE sample_store_pending_webhooks, sample_store_webhook_deliveries, sample_store_orders`;
      let lastRaceCheckoutId = '';
      for (let index = 1; index <= 25; index += 1) {
        const raceCheckoutId = `20000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        const raceReferenceHash = `private-race-reference-hash-${index}`;
        const raceDeliveryHash = `private-race-delivery-hash-${index}`;
        const raceOrder = await store.createOrGetWithinCap(
          {
            checkoutId: raceCheckoutId,
            idempotencyKey: `race-key-${index}`,
            status: 'awaiting_payment',
            productId: 'hoodie',
            amount: 3400,
            currency: 'GBP',
          },
          50,
        );
        assert.notEqual(raceOrder, 'active_checkout');
        assert.notEqual(raceOrder, 'cap_reached');
        await Promise.all([
          store.attachPaymentReference(raceCheckoutId, raceReferenceHash),
          store.applyWebhook({
            deliveryHash: raceDeliveryHash,
            paymentReferenceHash: raceReferenceHash,
            status: 'paid',
            occurredAt: new Date(`2026-08-21T13:00:${String(index).padStart(2, '0')}.000Z`),
          }),
        ]);
        assert.equal((await store.getByCheckoutId(raceCheckoutId))?.status, 'paid');
        lastRaceCheckoutId = raceCheckoutId;
      }

      const aggregates = await sql<{
        deliveries: number;
        orders: number;
        pending: number;
      }[]>`
        SELECT
          (SELECT count(*)::int FROM sample_store_orders) AS orders,
          (SELECT count(*)::int FROM sample_store_webhook_deliveries) AS deliveries,
          (SELECT count(*)::int FROM sample_store_pending_webhooks) AS pending
      `;
      assert.deepEqual(aggregates[0], { orders: 25, deliveries: 25, pending: 0 });

      const restartSql = postgres(databaseUrl!, { max: 2 });
      const restarted = createPostgresOrderStore(restartSql);
      try {
        assert.equal((await restarted.getByCheckoutId(lastRaceCheckoutId))?.status, 'paid');
        assert.deepEqual(await restarted.getUsage(), {
          activeCheckout: false,
          transactionsUsedToday: 25,
        });
      } finally {
        await restartSql.end();
      }
    } finally {
      await sql.end();
    }
  },
);

function assertDisposableDatabase(value: string): void {
  const url = new URL(value);
  const localHost = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (!localHost || url.pathname !== '/pay645_test') {
    throw new Error(
      'PAY645_POSTGRES_TEST_URL must target the dedicated local pay645_test database.',
    );
  }
}

test(
  'PostgreSQL enforces the 50-per-UTC-day boundary and resets on a later UTC day',
  { skip: databaseUrl ? false : 'PAY645_POSTGRES_TEST_URL is not configured' },
  async () => {
    const sql = postgres(databaseUrl!, { max: 8 });
    try {
      await sql`TRUNCATE sample_store_pending_webhooks, sample_store_webhook_deliveries, sample_store_orders`;
      const store = createPostgresOrderStore(sql);
      for (let index = 1; index <= 50; index += 1) {
        const checkoutId = `10000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
        const admitted = await store.createOrGetWithinCap(
          {
            checkoutId,
            idempotencyKey: `cap-key-${index}`,
            status: 'awaiting_payment',
            productId: 'hoodie',
            amount: 3400,
            currency: 'GBP',
          },
          50,
        );
        assert.notEqual(admitted, 'active_checkout');
        assert.notEqual(admitted, 'cap_reached');
        await store.markPaymentFailed(checkoutId);
      }

      const boundary = await store.createOrGetWithinCap(
        {
          checkoutId: '10000000-0000-4000-8000-000000000051',
          idempotencyKey: 'cap-key-51',
          status: 'awaiting_payment',
          productId: 'hoodie',
          amount: 3400,
          currency: 'GBP',
        },
        50,
      );
      assert.equal(boundary, 'cap_reached');

      await sql`UPDATE sample_store_orders SET created_at = now() - interval '1 day'`;
      const nextDay = await store.createOrGetWithinCap(
        {
          checkoutId: '10000000-0000-4000-8000-000000000051',
          idempotencyKey: 'cap-key-51',
          status: 'awaiting_payment',
          productId: 'hoodie',
          amount: 3400,
          currency: 'GBP',
        },
        50,
      );
      assert.notEqual(nextDay, 'active_checkout');
      assert.notEqual(nextDay, 'cap_reached');
    } finally {
      await sql.end();
    }
  },
);
