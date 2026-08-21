import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import type {
  CheckoutConfigResponse,
  PaymentIntentResponse,
  TaxQuoteResponse,
} from '@open-border/node';
import {
  createApp,
  createConfiguredApp,
  type OpenBorderGateway,
} from '../app';
import { createMemoryOrderStore } from '../order-store';
import { hashPrivateReference } from '../webhook';

const checkoutId = '018f4f31-86d4-7b2e-b6bd-7f53f5f98c71';
const input = {
  checkoutId,
  productId: 'hoodie',
  currency: 'GBP',
  amount: 3400,
  email: 'buyer@example.com',
  name: 'Demo Buyer',
  address: {
    line1: '1 High Street',
    city: 'London',
    postal_code: 'SW1A 1AA',
    country: 'GB',
  },
};
const quote: TaxQuoteResponse = {
  id: 'quote_test',
  destination_country: 'GB',
  currency: 'GBP',
  amount_breakdown: {
    subtotal: 3400,
    shipping: 0,
    tax: 680,
    duty: 170,
    total: 4250,
    currency: 'GBP',
  },
  classifications: [{ index: 0, hs_code: '6110.20', confidence: 1 }],
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
};

type ProvenanceCheckoutConfig = CheckoutConfigResponse & {
  readonly demo_store?: 'custom_api';
};

class Gateway implements OpenBorderGateway {
  paymentCalls = 0;

  constructor(private readonly onPayment?: () => void) {}

  async getCheckoutConfig(): Promise<ProvenanceCheckoutConfig> {
    return {
      entity: 'obmor_uk',
      provider: 'stripe',
      publishable_key: 'pk_test_public_example',
      currency: 'GBP',
      country: 'GB',
      demo_store: 'custom_api',
    };
  }

  async createTaxQuote() {
    return quote;
  }

  async createPaymentIntent(): Promise<PaymentIntentResponse> {
    this.paymentCalls += 1;
    this.onPayment?.();
    return {
      id: 'provider_reference_must_stay_private',
      status: 'processing',
      entity: 'private_routing_value' as PaymentIntentResponse['entity'],
      order_id: null,
      amount_breakdown: quote.amount_breakdown,
      client_secret: null,
      next_action: null,
    };
  }
}

test('hosted runtime is healthy but transaction routes fail closed by default', async () => {
  const gateway = new Gateway();
  const app = createApp(
    { publishableKey: '', transactionCap: 0 },
    gateway,
    'quote-signing-secret-for-tests',
  );

  const health = await request(app).get('/health').expect(200);
  const quoteResponse = await request(app).post('/quote').send(input).expect(503);
  const chargeResponse = await request(app).post('/charge').send(input).expect(503);

  assert.deepEqual(health.body, {
    ok: true,
    mode: 'production-sandbox',
    transactionsEnabled: false,
    transactionCap: 0,
    transactionsUsedToday: 0,
    activeCheckout: false,
    durableOrders: false,
    authenticWebhooks: false,
    trustedDemoProvenance: true,
  });
  assert.equal(quoteResponse.body.code, 'demo_not_enabled');
  assert.equal(chargeResponse.body.code, 'demo_not_enabled');
  assert.equal(gateway.paymentCalls, 0);
});

test('cap zero proves durable order, webhook, and trusted provenance readiness without opening routes', async () => {
  const gateway = new Gateway();
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 0 },
    gateway,
    'quote-signing-secret-for-tests',
    {
      store: createMemoryOrderStore(),
      referenceSecret: 'private-reference-secret-for-tests',
      webhookSecret: 'whsec_test_receiver',
    },
  );

  const health = await request(app).get('/health').expect(200);
  await request(app).post('/quote').send(input).expect(503);
  await request(app).post('/charge').send(input).expect(503);

  assert.deepEqual(health.body, {
    ok: true,
    mode: 'production-sandbox',
    transactionsEnabled: false,
    transactionCap: 0,
    transactionsUsedToday: 0,
    activeCheckout: false,
    durableOrders: true,
    authenticWebhooks: true,
    trustedDemoProvenance: true,
  });
  assert.equal(gateway.paymentCalls, 0);
});

test('charge persists an order first and never returns provider references', async () => {
  const calls: string[] = [];
  const store = createMemoryOrderStore({ onWrite: () => calls.push('order.persisted') });
  const gateway = new Gateway(() => calls.push('payment.requested'));
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 1 },
    gateway,
    'quote-signing-secret-for-tests',
    {
      store,
      referenceSecret: 'private-reference-secret-for-tests',
      webhookSecret: 'whsec_test_receiver',
    },
  );
  const quoteToken = (await request(app).post('/quote').send(input).expect(200)).body
    .quoteToken as string;
  const response = await request(app)
    .post('/charge')
    .send({ ...input, quoteToken, paymentMethodId: 'pm_test_token' })
    .expect(200);

  assert.deepEqual(calls, ['order.persisted', 'payment.requested']);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.status, 'payment_submitted');
  assert.equal(JSON.stringify(response.body).includes('provider_reference'), false);
  assert.equal(JSON.stringify(response.body).includes('private_routing_value'), false);
});

test('an authentic terminal webhook updates the durable order exactly once', async () => {
  const store = createMemoryOrderStore();
  const gateway = new Gateway();
  const webhookSecret = 'whsec_test_receiver';
  const referenceSecret = 'private-reference-secret-for-tests';
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 1 },
    gateway,
    'quote-signing-secret-for-tests',
    { store, referenceSecret, webhookSecret },
  );
  const quoteToken = (await request(app).post('/quote').send(input).expect(200)).body
    .quoteToken as string;
  await request(app)
    .post('/charge')
    .send({ ...input, quoteToken, paymentMethodId: 'pm_test_token' })
    .expect(200);

  const timestamp = String(Math.floor(Date.now() / 1000));
  const delivery = 'delivery_test';
  const body = JSON.stringify({
    type: 'payment_intent.succeeded',
    mode: 'test',
    occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
    data: {
      paymentIntentId: 'provider_reference_must_stay_private',
      demoStore: 'custom_api',
    },
  });
  const signature = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${delivery}.${body}`)
    .digest('hex');

  for (let attempt = 0; attempt < 2; attempt += 1) {
    await request(app)
      .post('/webhooks/openborder')
      .set('Content-Type', 'application/json')
      .set('OpenBorder-Webhook-Id', delivery)
      .set('OpenBorder-Webhook-Timestamp', timestamp)
      .set('OpenBorder-Webhook-Signature', `v1=${signature},t=${timestamp}`)
      .send(body)
      .expect(204);
  }

  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'paid');
  assert.equal(store.deliveryCount(), 1);

  const terminalRetry = await request(app)
    .post('/charge')
    .send({ ...input, quoteToken, paymentMethodId: 'pm_test_token' })
    .expect(200);
  assert.equal(terminalRetry.body.status, 'reconciled');
  assert.equal(gateway.paymentCalls, 1);
});

test('an owned terminal webhook received before reference attachment is staged and reconciled', async () => {
  const store = createMemoryOrderStore();
  const paymentReferenceHash = 'private_payment_hash';
  await store.createOrGetWithinCap(
    {
      checkoutId,
      idempotencyKey: 'stable-key',
      status: 'awaiting_payment',
      productId: 'hoodie',
      amount: 3400,
      currency: 'GBP',
    },
    50,
  );

  const first = await store.applyWebhook({
    deliveryHash: 'private_delivery_hash',
    paymentReferenceHash,
    status: 'paid',
    occurredAt: new Date('2026-08-21T13:00:00.000Z'),
  });
  const duplicateBeforeAttachment = await store.applyWebhook({
    deliveryHash: 'private_delivery_hash',
    paymentReferenceHash,
    status: 'paid',
    occurredAt: new Date('2026-08-21T13:00:00.000Z'),
  });

  assert.equal(first, 'staged');
  assert.equal(duplicateBeforeAttachment, 'duplicate');
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'awaiting_payment');

  await store.attachPaymentReference(checkoutId, paymentReferenceHash);

  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'paid');
  assert.equal(store.deliveryCount(), 1);
  assert.equal(
    await store.applyWebhook({
      deliveryHash: 'private_delivery_hash',
      paymentReferenceHash,
      status: 'paid',
      occurredAt: new Date('2026-08-21T13:00:00.000Z'),
    }),
    'duplicate',
  );
});

test('unknown signed events are staged only inside one bounded active-checkout window', async () => {
  let now = new Date('2026-08-21T13:00:00.000Z');
  const store = createMemoryOrderStore({ now: () => now });
  const beforeCheckout = await store.applyWebhook({
    deliveryHash: 'delivery_before_checkout',
    paymentReferenceHash: 'reference_before_checkout',
    status: 'paid',
    occurredAt: now,
  });
  assert.equal(beforeCheckout, 'unowned');

  await store.createOrGetWithinCap(
    {
      checkoutId,
      idempotencyKey: 'stable-key',
      status: 'awaiting_payment',
      productId: 'hoodie',
      amount: 3400,
      currency: 'GBP',
    },
    50,
  );
  for (let index = 1; index <= 8; index += 1) {
    assert.equal(
      await store.applyWebhook({
        deliveryHash: `bounded_delivery_${index}`,
        paymentReferenceHash: `bounded_reference_${index}`,
        status: 'paid',
        occurredAt: now,
      }),
      'staged',
    );
  }
  assert.equal(
    await store.applyWebhook({
      deliveryHash: 'bounded_delivery_9',
      paymentReferenceHash: 'bounded_reference_9',
      status: 'paid',
      occurredAt: now,
    }),
    'capacity_reached',
  );

  now = new Date(now.getTime() + 16 * 60 * 1000);
  assert.equal(
    await store.applyWebhook({
      deliveryHash: 'bounded_delivery_after_expiry',
      paymentReferenceHash: 'bounded_reference_after_expiry',
      status: 'paid',
      occurredAt: now,
    }),
    'staged',
  );
});

test('terminal orders cannot regress on retry or a contradictory delivery', async () => {
  const store = createMemoryOrderStore();
  const paymentReferenceHash = 'private_payment_hash';
  await store.createOrGetWithinCap(
    {
      checkoutId,
      idempotencyKey: 'stable-key',
      status: 'awaiting_payment',
      productId: 'hoodie',
      amount: 3400,
      currency: 'GBP',
    },
    50,
  );
  await store.attachPaymentReference(checkoutId, paymentReferenceHash);
  await store.applyWebhook({
    deliveryHash: 'delivery_success',
    paymentReferenceHash,
    status: 'paid',
    occurredAt: new Date('2026-08-21T13:00:00.000Z'),
  });

  assert.equal(
    await store.attachPaymentReference(checkoutId, paymentReferenceHash),
    'terminal_noop',
  );
  assert.equal(
    await store.applyWebhook({
      deliveryHash: 'delivery_late_failure',
      paymentReferenceHash,
      status: 'payment_failed',
      occurredAt: new Date('2026-08-21T13:01:00.000Z'),
    }),
    'terminal_noop',
  );
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'paid');
  assert.equal(store.deliveryCount(), 2);
});

test('signed non-Test terminal events are acknowledged without reconciliation evidence', async () => {
  const store = createMemoryOrderStore();
  const gateway = new Gateway();
  const webhookSecret = 'whsec_test_receiver';
  const referenceSecret = 'private-reference-secret-for-tests';
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 1 },
    gateway,
    'quote-signing-secret-for-tests',
    { store, referenceSecret, webhookSecret },
  );
  const quoteToken = (await request(app).post('/quote').send(input).expect(200)).body
    .quoteToken as string;
  await request(app)
    .post('/charge')
    .send({ ...input, quoteToken, paymentMethodId: 'pm_test_token' })
    .expect(200);

  const timestamp = String(Math.floor(Date.now() / 1000));
  for (const [index, mode] of ['live', undefined, 'sandbox'].entries()) {
    const delivery = `delivery_non_test_${index}`;
    const body = JSON.stringify({
      type: 'payment_intent.succeeded',
      ...(mode === undefined ? {} : { mode }),
      occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
      data: {
        paymentIntentId: 'provider_reference_must_stay_private',
        demoStore: 'custom_api',
      },
    });
    const signature = createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${delivery}.${body}`)
      .digest('hex');
    await request(app)
      .post('/webhooks/openborder')
      .set('Content-Type', 'application/json')
      .set('OpenBorder-Webhook-Id', delivery)
      .set('OpenBorder-Webhook-Timestamp', timestamp)
      .set('OpenBorder-Webhook-Signature', `v1=${signature},t=${timestamp}`)
      .send(body)
      .expect(204);
  }

  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'payment_submitted');
  assert.equal(store.deliveryCount(), 0);
});

test('signed Test events with missing or foreign demo provenance are not staged', async () => {
  const store = createMemoryOrderStore();
  const webhookSecret = 'whsec_test_receiver';
  const referenceSecret = 'private-reference-secret-for-tests';
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    new Gateway(),
    'quote-signing-secret-for-tests',
    { store, referenceSecret, webhookSecret },
  );
  await store.createOrGetWithinCap(
    {
      checkoutId,
      idempotencyKey: 'stable-key',
      status: 'awaiting_payment',
      productId: 'hoodie',
      amount: 3400,
      currency: 'GBP',
    },
    50,
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const paymentIntentId = 'provider_reference_must_stay_private';
  for (const [index, demoStore] of [undefined, 'medusa', 'custom-api'].entries()) {
    const delivery = `delivery_foreign_provenance_${index}`;
    const body = JSON.stringify({
      type: 'payment_intent.succeeded',
      mode: 'test',
      occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
      data: {
        paymentIntentId,
        ...(demoStore ? { demoStore } : {}),
      },
    });
    const signature = createHmac('sha256', webhookSecret)
      .update(`${timestamp}.${delivery}.${body}`)
      .digest('hex');
    await request(app)
      .post('/webhooks/openborder')
      .set('Content-Type', 'application/json')
      .set('OpenBorder-Webhook-Id', delivery)
      .set('OpenBorder-Webhook-Timestamp', timestamp)
      .set('OpenBorder-Webhook-Signature', `v1=${signature},t=${timestamp}`)
      .send(body)
      .expect(204);
  }

  await store.attachPaymentReference(
    checkoutId,
    hashPrivateReference(referenceSecret, paymentIntentId),
  );
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'payment_submitted');
  assert.equal(store.deliveryCount(), 0);
});

test('an owned signed webhook returns retryable failure when durable staging fails', async () => {
  const baseStore = createMemoryOrderStore();
  const store = {
    ...baseStore,
    applyWebhook: async () => {
      throw new Error('database unavailable');
    },
  };
  const gateway = new Gateway();
  const webhookSecret = 'whsec_test_receiver';
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    'quote-signing-secret-for-tests',
    {
      store,
      referenceSecret: 'private-reference-secret-for-tests',
      webhookSecret,
    },
  );
  const timestamp = String(Math.floor(Date.now() / 1000));
  const delivery = 'delivery_retryable';
  const body = JSON.stringify({
    type: 'payment_intent.succeeded',
    mode: 'test',
    occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
    data: {
      paymentIntentId: 'provider_reference_must_stay_private',
      demoStore: 'custom_api',
    },
  });
  const signature = createHmac('sha256', webhookSecret)
    .update(`${timestamp}.${delivery}.${body}`)
    .digest('hex');

  const response = await request(app)
    .post('/webhooks/openborder')
    .set('Content-Type', 'application/json')
    .set('OpenBorder-Webhook-Id', delivery)
    .set('OpenBorder-Webhook-Timestamp', timestamp)
    .set('OpenBorder-Webhook-Signature', `v1=${signature},t=${timestamp}`)
    .send(body)
    .expect(503);

  assert.deepEqual(response.body, { ok: false, code: 'webhook_retry' });
});

test('production starts at zero cap without credentials and enabling requires every prerequisite', async () => {
  const disabled = createConfiguredApp({ VERCEL_ENV: 'production' });
  const health = await request(disabled).get('/health').expect(200);
  assert.equal(health.body.transactionsEnabled, false);

  assert.throws(
    () =>
      createConfiguredApp({
        VERCEL_ENV: 'production',
        DEMO_TRANSACTION_CAP: '1',
        OB_API_URL: 'https://api-staging.openborderpayments.com',
        OB_SECRET_KEY: 'sk_test_example',
        OB_PUBLISHABLE_KEY: 'pk_test_example',
      }),
    /exact production Sandbox API/,
  );
});

test('configured cap zero constructs readiness dependencies while keeping transaction routes closed', async () => {
  const app = createConfiguredApp({
    VERCEL_ENV: 'production',
    DEMO_TRANSACTION_CAP: '0',
    OB_SECRET_KEY: 'sk_test_example',
    OB_PUBLISHABLE_KEY: 'pk_test_example',
    OB_API_URL: 'https://api-sandbox.openborderpayments.com',
    DATABASE_URL: 'postgres://example.invalid/sample_store',
    OB_WEBHOOK_SECRET: 'whsec_example',
    ORDER_REFERENCE_HMAC_SECRET: 'r'.repeat(32),
  });

  const config = await request(app).get('/config.js').expect(200);
  await request(app).post('/quote').send(input).expect(503);

  assert.match(config.text, /pk_test_example/);
  assert.match(config.text, /"transactionsEnabled":false/);
});
