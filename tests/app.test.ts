import { strict as assert } from 'node:assert';
import { createHmac } from 'node:crypto';
import { test } from 'node:test';
import request from 'supertest';
import {
  OpenBorderApiError,
  type CheckoutConfigResponse,
  type PaymentIntentResponse,
  type TaxQuoteResponse,
} from '@open-border/node';
import { createApp, createConfiguredApp, type OpenBorderGateway } from '../app';
import { createMemoryOrderStore } from '../order-store';

const checkoutId = '018f4f31-86d4-7b2e-b6bd-7f53f5f98c71';
const baseInput = {
  checkoutId,
  productId: 'hoodie',
  currency: 'GBP',
  amount: 3400,
  email: 'buyer@example.com',
  name: 'Ada Lovelace',
  address: { line1: '1 High Street', city: 'London', postal_code: 'SW1A 1AA', country: 'GB' },
};

const quote: TaxQuoteResponse = {
  id: 'tq_test_123',
  destination_country: 'GB',
  currency: 'GBP',
  amount_breakdown: { subtotal: 3400, shipping: 0, tax: 680, duty: 170, total: 4250, currency: 'GBP' },
  classifications: [{ index: 0, hs_code: '6110.20', confidence: 1 }],
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
};

const paymentIntent: PaymentIntentResponse = {
  id: 'pi_test_123',
  status: 'succeeded',
  entity: 'obmor_uk',
  order_id: null,
  amount_breakdown: quote.amount_breakdown,
  client_secret: null,
  next_action: null,
};

type ProvenanceCheckoutConfig = CheckoutConfigResponse & {
  readonly demo_store?: 'custom_api' | 'medusa';
};

class FakeGateway implements OpenBorderGateway {
  configCalls = 0;
  demoStore: ProvenanceCheckoutConfig['demo_store'] = 'custom_api';
  quoteCalls = 0;
  quoteInputs: Array<Parameters<OpenBorderGateway['createTaxQuote']>[0]> = [];
  paymentCalls: Array<{ input: Parameters<OpenBorderGateway['createPaymentIntent']>[0]; key: string }> = [];
  paymentError: Error | null = null;
  private readonly completed = new Map<string, PaymentIntentResponse>();

  async getCheckoutConfig(): Promise<ProvenanceCheckoutConfig> {
    this.configCalls += 1;
    return {
      entity: 'obmor_uk',
      provider: 'stripe',
      publishable_key: 'pk_test_public_example',
      currency: 'GBP',
      country: 'GB',
      ...(this.demoStore ? { demo_store: this.demoStore } : {}),
    };
  }

  async createTaxQuote(input: Parameters<OpenBorderGateway['createTaxQuote']>[0]) {
    this.quoteCalls += 1;
    this.quoteInputs.push(input);
    return quote;
  }

  async createPaymentIntent(
    input: Parameters<OpenBorderGateway['createPaymentIntent']>[0],
    options: { idempotencyKey: string },
  ) {
    this.paymentCalls.push({ input, key: options.idempotencyKey });
    if (this.paymentError) throw this.paymentError;
    const existing = this.completed.get(options.idempotencyKey);
    if (existing) return existing;
    this.completed.set(options.idempotencyKey, paymentIntent);
    return paymentIntent;
  }
}

class UniquePaymentGateway extends FakeGateway {
  readonly paymentIds: string[] = [];

  override async createPaymentIntent(
    input: Parameters<OpenBorderGateway['createPaymentIntent']>[0],
    options: { idempotencyKey: string },
  ) {
    this.paymentCalls.push({ input, key: options.idempotencyKey });
    const id = `pi_test_${input.merchant_reference}`;
    this.paymentIds.push(id);
    return { ...paymentIntent, id };
  }
}

/**
 * An issuer that wants the card authenticated: the intent comes back `requires_action`
 * with the credential that completes it. The secret is deliberately NOT built from
 * `paymentIntent.id` — a client secret names the PROCESSOR's intent, never the Open
 * Border one, and the no-leak assertions below depend on the two staying distinct.
 */
class ChallengeGateway extends FakeGateway {
  override async createPaymentIntent(
    input: Parameters<OpenBorderGateway['createPaymentIntent']>[0],
    options: { idempotencyKey: string },
  ) {
    this.paymentCalls.push({ input, key: options.idempotencyKey });
    return {
      ...paymentIntent,
      status: 'requires_action',
      client_secret: 'ps_challenge_secret_example',
    };
  }
}

const createTestApp = (gateway = new FakeGateway()) => ({
  app: createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 1 },
    gateway,
    'unit-test-signing-secret',
  ),
  gateway,
});

async function getQuoteToken(app: ReturnType<typeof createApp>, input = baseInput) {
  const response = await request(app).post('/quote').send(input).expect(200);
  assert.equal(response.body.ok, true);
  assert.equal(response.body.amount_breakdown.total, 4250);
  assert.equal(typeof response.body.quoteToken, 'string');
  return response.body.quoteToken as string;
}

test('config endpoint exposes only the publishable key', async () => {
  const { app } = createTestApp();
  const response = await request(app).get('/config.js').expect(200);
  assert.match(response.text, /pk_test_public_example/);
  assert.doesNotMatch(response.text, /sk_test_/);
  assert.equal(response.headers['cache-control'], 'no-store');
});

test('a buyer who gives no postal code sends no destination_postal_code at all', async () => {
  const { app, gateway } = createTestApp();

  await request(app)
    .post('/quote')
    .send({ ...baseInput, address: { line1: '1 High Street', city: 'London', country: 'GB' } })
    .expect(200);

  // An empty string would bind the quote to a detail nobody supplied, and the API treats a
  // blank region/postal code as absent anyway — so the key must not be present.
  assert.equal(gateway.quoteInputs.length, 1);
  assert.ok(!('destination_postal_code' in gateway.quoteInputs[0]!));
});

test('catalog tampering is rejected before an upstream request', async () => {
  const { app, gateway } = createTestApp();
  const response = await request(app).post('/quote').send({ ...baseInput, amount: 1 }).expect(400);
  assert.equal(response.body.code, 'validation_error');
  assert.equal(response.body.fields.amount, 'Amount does not match the public demo catalog.');
  assert.equal(gateway.quoteCalls, 0);
});

test('tax quote uses the current closed trade-lane contract', async () => {
  const { app, gateway } = createTestApp();

  await request(app).post('/quote').send(baseInput).expect(200);

  assert.deepEqual(gateway.quoteInputs, [
    {
      destination_country: 'GB',
      destination_postal_code: 'SW1A 1AA',
      ship_from_country: 'US',
      currency: 'GBP',
      line_items: [
        {
          description: 'Classic Pullover Hoodie',
          quantity: 1,
          unit_amount: 3400,
          hs_code: '6110.20',
        },
      ],
      customer: { email: 'buyer@example.com' },
    },
  ]);
});

test('Germany destination stays independent from USD through quote and payment mapping', async () => {
  class GermanyUsdGateway extends FakeGateway {
    override async createTaxQuote(
      input: Parameters<OpenBorderGateway['createTaxQuote']>[0],
    ): Promise<TaxQuoteResponse> {
      this.quoteCalls += 1;
      this.quoteInputs.push(input);
      return {
        ...quote,
        destination_country: 'DE',
        currency: 'USD',
        amount_breakdown: {
          subtotal: 4200,
          shipping: 0,
          tax: 798,
          duty: 210,
          total: 5208,
          currency: 'USD',
        },
      };
    }
  }

  const gateway = new GermanyUsdGateway();
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 1 },
    gateway,
    'unit-test-signing-secret',
  );
  const germanyUsdInput = {
    ...baseInput,
    currency: 'USD' as const,
    amount: 4200,
    address: {
      ...baseInput.address,
      line1: '1 Teststrasse',
      city: 'Berlin',
      postal_code: '10115',
      country: 'DE',
    },
  };

  const quoted = await request(app).post('/quote').send(germanyUsdInput).expect(200);
  await request(app)
    .post('/charge')
    .send({
      ...germanyUsdInput,
      quoteToken: quoted.body.quoteToken,
      paymentMethodId: 'pm_test_germany_usd',
    })
    .expect(200);

  assert.equal(gateway.quoteInputs[0]?.destination_country, 'DE');
  assert.equal(gateway.quoteInputs[0]?.currency, 'USD');
  assert.equal(gateway.quoteInputs[0]?.line_items[0]?.unit_amount, 4200);
  assert.equal(gateway.paymentCalls[0]?.input.currency, 'USD');
  assert.equal(gateway.paymentCalls[0]?.input.amount, 4200);
  assert.equal(gateway.paymentCalls[0]?.input.shipping_address.country, 'DE');
  assert.equal(gateway.paymentCalls[0]?.input.billing_address.country, 'DE');
  assert.equal(gateway.paymentCalls[0]?.input.tax_quote_id, 'tq_test_123');
});

test('quote fails closed before tax provider I/O without trusted Custom API provenance', async () => {
  const { app, gateway } = createTestApp();
  gateway.demoStore = 'medusa';

  const response = await request(app).post('/quote').send(baseInput).expect(503);

  assert.equal(response.body.code, 'demo_provenance_unavailable');
  assert.equal(gateway.configCalls, 1);
  assert.equal(gateway.quoteCalls, 0);
});

test('quote and charge fail closed before provider I/O when durable storage is not ready', async () => {
  const gateway = new FakeGateway();
  const store = {
    ...createMemoryOrderStore(),
    checkReady: async () => false,
  };
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    'unit-test-signing-secret',
    { store },
  );

  assert.equal((await request(app).post('/quote').send(baseInput).expect(503)).body.code, 'demo_not_ready');
  assert.equal((await request(app).post('/charge').send(baseInput).expect(503)).body.code, 'demo_not_ready');
  assert.equal(gateway.configCalls, 0);
  assert.equal(gateway.quoteCalls, 0);
  assert.equal(gateway.paymentCalls.length, 0);
});

test('domestic checkout still uses a server-issued tax quote', async () => {
  const { app, gateway } = createTestApp();
  const domesticInput = {
    ...baseInput,
    currency: 'USD' as const,
    amount: 4200,
    address: { ...baseInput.address, postal_code: '10001', country: 'US' },
  };

  const response = await request(app).post('/quote').send(domesticInput).expect(200);

  assert.equal(response.body.domestic, true);
  assert.equal(response.body.taxQuoteId, 'tq_test_123');
  assert.equal(gateway.quoteInputs[0]?.ship_from_country, 'US');
  assert.equal(gateway.quoteInputs[0]?.destination_country, 'US');
});

test('the displayed signed quote is charged with a stable retry key', async () => {
  const { app, gateway } = createTestApp();
  const quoteToken = await getQuoteToken(app);
  const chargeBody = { ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' };

  const first = await request(app).post('/charge').send(chargeBody).expect(200);
  const replay = await request(app).post('/charge').send(chargeBody).expect(200);

  assert.equal(first.body.status, 'payment_submitted');
  assert.equal(replay.body.status, 'payment_submitted');
  assert.equal(gateway.paymentCalls[0]?.key, gateway.paymentCalls[1]?.key);
  assert.match(gateway.paymentCalls[0]?.key ?? '', /^[0-9a-f]{64}$/);
  assert.doesNotMatch(JSON.stringify(first.body), /pi_test_123|obmor_uk/);
  assert.equal(gateway.paymentCalls[0]?.input.tax_quote_id, 'tq_test_123');
  assert.equal(gateway.paymentCalls[0]?.input.amount, 3400);
  assert.equal(gateway.paymentCalls[0]?.input.line_items[0]?.hs_code, '6110.20');
  assert.equal(gateway.paymentCalls[0]?.input.merchant_reference, `sample-store-${checkoutId}`);
});

test('charge rechecks trusted Custom API provenance before order admission or payment', async () => {
  const gateway = new FakeGateway();
  const store = createMemoryOrderStore();
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 1 },
    gateway,
    'unit-test-signing-secret',
    { store },
  );
  const quoteToken = await getQuoteToken(app);
  gateway.demoStore = undefined;

  const response = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(503);

  assert.equal(response.body.code, 'demo_provenance_unavailable');
  assert.equal(gateway.paymentCalls.length, 0);
  assert.equal(await store.getByCheckoutId(checkoutId), undefined);
});

test('an unresolved checkout holds the single active claim before another payment', async () => {
  const gateway = new FakeGateway();
  const store = createMemoryOrderStore();
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    'unit-test-signing-secret',
    {
      store,
      referenceSecret: 'private-reference-secret-for-tests',
      webhookSecret: 'whsec_test_receiver',
    },
  );
  const secondInput = {
    ...baseInput,
    checkoutId: '018f4f31-86d4-7b2e-b6bd-7f53f5f98c72',
  };
  const firstQuote = await getQuoteToken(app, baseInput);
  const secondQuote = await getQuoteToken(app, secondInput);

  await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken: firstQuote, paymentMethodId: 'pm_test_4242' })
    .expect(200);
  const capped = await request(app)
    .post('/charge')
    .send({ ...secondInput, quoteToken: secondQuote, paymentMethodId: 'pm_test_4242' })
    .expect(409);

  assert.equal(capped.body.code, 'checkout_in_progress');
  assert.equal(gateway.paymentCalls.length, 1);
  assert.equal(await store.getByCheckoutId(secondInput.checkoutId), undefined);
});

test('a UTC-day cap admits fifty reconciled checkouts, refuses the fifty-first, and resets next day', async () => {
  let now = new Date('2026-08-21T09:00:00.000Z');
  const store = createMemoryOrderStore({ now: () => now });
  const gateway = new UniquePaymentGateway();
  const webhookSecret = 'whsec_test_receiver';
  const referenceSecret = 'private-reference-secret-for-tests';
  const signingSecret = 'unit-test-signing-secret';

  const createCappedApp = () =>
    createApp(
      { publishableKey: 'pk_test_public_example', transactionCap: 50 },
      gateway,
      signingSecret,
      { store, referenceSecret, webhookSecret },
    );

  const inputFor = (attempt: number) => ({
    ...baseInput,
    checkoutId: `00000000-0000-4000-8000-${String(attempt).padStart(12, '0')}`,
  });

  const submitAndReconcile = async (attempt: number) => {
    const app = createCappedApp();
    const input = inputFor(attempt);
    const quoteToken = await getQuoteToken(app, input);
    await request(app)
      .post('/charge')
      .send({ ...input, quoteToken, paymentMethodId: 'pm_test_4242' })
      .expect(200);

    const timestamp = String(Math.floor(Date.now() / 1000));
    const delivery = `delivery_${attempt}`;
    const body = JSON.stringify({
      type: 'payment_intent.succeeded',
      mode: 'test',
      occurredAt: new Date(Number(timestamp) * 1000).toISOString(),
      data: { paymentIntentId: gateway.paymentIds.at(-1), demoStore: 'custom_api' },
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
  };

  for (let attempt = 1; attempt <= 50; attempt += 1) {
    await submitAndReconcile(attempt);
  }

  const cappedApp = createCappedApp();
  const cappedInput = inputFor(51);
  const cappedQuote = await getQuoteToken(cappedApp, cappedInput);
  const capped = await request(cappedApp)
    .post('/charge')
    .send({ ...cappedInput, quoteToken: cappedQuote, paymentMethodId: 'pm_test_4242' })
    .expect(503);
  assert.equal(capped.body.code, 'transaction_cap_reached');
  assert.equal(gateway.paymentCalls.length, 50);

  now = new Date('2026-08-22T00:00:01.000Z');
  await submitAndReconcile(51);
  assert.equal(gateway.paymentCalls.length, 51);
});

test('health reports the configured cap, UTC-day usage, and active checkout state', async () => {
  const store = createMemoryOrderStore();
  const gateway = new UniquePaymentGateway();
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    'unit-test-signing-secret',
    {
      store,
      referenceSecret: 'private-reference-secret-for-tests',
      webhookSecret: 'whsec_test_receiver',
    },
  );

  const initial = await request(app).get('/health').expect(200);
  assert.deepEqual(
    {
      transactionCap: initial.body.transactionCap,
      transactionsUsedToday: initial.body.transactionsUsedToday,
      activeCheckout: initial.body.activeCheckout,
    },
    { transactionCap: 50, transactionsUsedToday: 0, activeCheckout: false },
  );

  const quoteToken = await getQuoteToken(app);
  await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(200);

  const active = await request(app).get('/health').expect(200);
  assert.deepEqual(
    {
      transactionCap: active.body.transactionCap,
      transactionsUsedToday: active.body.transactionsUsedToday,
      activeCheckout: active.body.activeCheckout,
    },
    { transactionCap: 50, transactionsUsedToday: 1, activeCheckout: true },
  );
});

test('concurrent distinct charges admit only one active checkout', async () => {
  const gateway = new FakeGateway();
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 1 },
    gateway,
    'unit-test-signing-secret',
  );
  const inputs = ['71', '72', '73', '74'].map((suffix) => ({
    ...baseInput,
    checkoutId: `018f4f31-86d4-7b2e-b6bd-7f53f5f98c${suffix}`,
  }));
  const tokens = await Promise.all(inputs.map((input) => getQuoteToken(app, input)));
  const responses = await Promise.all(
    inputs.map((input, index) =>
      request(app)
        .post('/charge')
        .send({ ...input, quoteToken: tokens[index], paymentMethodId: 'pm_test_4242' }),
    ),
  );

  assert.deepEqual(
    responses.map((response) => response.status).sort(),
    [200, 409, 409, 409],
  );
  assert.equal(gateway.paymentCalls.length, 1);
});

test('a changed request cannot reuse a signed displayed quote', async () => {
  const { app, gateway } = createTestApp();
  const quoteToken = await getQuoteToken(app);
  const response = await request(app)
    .post('/charge')
    .send({ ...baseInput, checkoutId: '018f4f31-86d4-7b2e-b6bd-7f53f5f98c72', quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(400);
  assert.equal(response.body.code, 'validation_error');
  assert.equal(gateway.paymentCalls.length, 0);
});

test('a changed destination cannot reuse a signed displayed quote', async () => {
  const { app, gateway } = createTestApp();
  const quoteToken = await getQuoteToken(app);
  const response = await request(app)
    .post('/charge')
    .send({
      ...baseInput,
      address: { ...baseInput.address, postal_code: '10001', country: 'US' },
      quoteToken,
      paymentMethodId: 'pm_test_4242',
    })
    .expect(400);
  assert.equal(response.body.code, 'validation_error');
  assert.equal(gateway.paymentCalls.length, 0);
});

test('a modified quote token is rejected', async () => {
  const { app, gateway } = createTestApp();
  const quoteToken = await getQuoteToken(app);
  const response = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken: `${quoteToken.slice(0, -1)}x`, paymentMethodId: 'pm_test_4242' })
    .expect(400);
  assert.equal(response.body.code, 'validation_error');
  assert.equal(gateway.paymentCalls.length, 0);
});

test('provider errors return stable safe text and a request id', async () => {
  const gateway = new FakeGateway();
  const store = createMemoryOrderStore();
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    'unit-test-signing-secret',
    { store },
  );
  const quoteToken = await getQuoteToken(app);
  gateway.paymentError = new OpenBorderApiError(
    'provider_unavailable',
    502,
    'Internal provider account acct_secret failed with raw response',
  );
  const response = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(502);
  assert.equal(response.body.code, 'provider_unavailable');
  assert.equal(response.body.outcomeUnknown, true);
  assert.equal(response.body.message, 'Open Border could not complete this test request. Please try again.');
  assert.doesNotMatch(JSON.stringify(response.body), /acct_secret|raw response/);
  assert.match(response.body.requestId, /^[0-9a-f-]{36}$/);
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'awaiting_payment');

  gateway.paymentError = null;
  await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(200);
  assert.equal(gateway.paymentCalls[0]?.key, gateway.paymentCalls[1]?.key);
});

test('post-provider attachment failure stays ambiguous and an exact retry drains staged success', async () => {
  const gateway = new FakeGateway();
  const durableStore = createMemoryOrderStore();
  const referenceSecret = 'unit-test-signing-secret';
  let failAttachment = true;
  const store = {
    ...durableStore,
    attachPaymentReference: async (retryCheckoutId: string, paymentReferenceHash: string) => {
      if (failAttachment) {
        failAttachment = false;
        throw new Error('simulated_attachment_failure');
      }
      return durableStore.attachPaymentReference(retryCheckoutId, paymentReferenceHash);
    },
  };
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    referenceSecret,
    { store, referenceSecret },
  );
  const quoteToken = await getQuoteToken(app);
  const chargeBody = { ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' };

  const ambiguous = await request(app).post('/charge').send(chargeBody).expect(502);
  assert.equal(ambiguous.body.code, 'payment_status_unknown');
  assert.equal(ambiguous.body.outcomeUnknown, true);
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'awaiting_payment');
  assert.equal((await store.getUsage()).activeCheckout, true);

  assert.equal(
    await store.applyWebhook({
      deliveryHash: 'attachment-success-delivery',
      paymentReferenceHash: createHmac('sha256', referenceSecret)
        .update(paymentIntent.id)
        .digest('hex'),
      status: 'paid',
      occurredAt: new Date('2026-08-21T13:00:00.000Z'),
    }),
    'staged',
  );

  await request(app).post('/charge').send(chargeBody).expect(200);
  assert.equal(gateway.paymentCalls.length, 2);
  assert.equal(gateway.paymentCalls[0]?.key, gateway.paymentCalls[1]?.key);
  assert.deepEqual(gateway.paymentCalls[0]?.input, gateway.paymentCalls[1]?.input);
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'paid');
  assert.equal((await store.getUsage()).activeCheckout, false);
});

test('a definitive payment decline closes the order and releases the active slot', async () => {
  const gateway = new FakeGateway();
  const store = createMemoryOrderStore();
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    'unit-test-signing-secret',
    { store },
  );
  const quoteToken = await getQuoteToken(app);
  gateway.paymentError = new OpenBorderApiError(
    'payment_declined',
    402,
    'Unsafe provider detail must not escape',
  );

  const declined = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(402);

  assert.equal(declined.body.code, 'payment_declined');
  assert.equal(declined.body.checkoutClosed, true);
  assert.equal(
    declined.body.message,
    'The test payment was declined. Close this checkout and start a new one with another test card.',
  );
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'payment_failed');
  assert.equal((await store.getUsage()).activeCheckout, false);

  const closedRetry = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(409);
  assert.equal(closedRetry.body.code, 'checkout_closed');
  assert.equal(closedRetry.body.checkoutClosed, true);

  gateway.paymentError = null;
  const nextInput = {
    ...baseInput,
    checkoutId: '018f4f31-86d4-7b2e-b6bd-7f53f5f98c72',
  };
  const nextQuote = await getQuoteToken(app, nextInput);
  await request(app)
    .post('/charge')
    .send({ ...nextInput, quoteToken: nextQuote, paymentMethodId: 'pm_test_4242' })
    .expect(200);
  assert.equal(gateway.paymentCalls.length, 2);
});

test('a failed definitive-state write requires an exact locked retry', async () => {
  const gateway = new FakeGateway();
  const durableStore = createMemoryOrderStore();
  let failStateWrite = true;
  const store = {
    ...durableStore,
    markPaymentFailed: async (retryCheckoutId: string) => {
      if (failStateWrite) {
        failStateWrite = false;
        throw new Error('simulated_state_write_failure');
      }
      return durableStore.markPaymentFailed(retryCheckoutId);
    },
  };
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    'unit-test-signing-secret',
    { store },
  );
  const quoteToken = await getQuoteToken(app);
  const chargeBody = { ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' };
  gateway.paymentError = new OpenBorderApiError(
    'payment_declined',
    402,
    'Unsafe provider detail must not escape',
  );

  const retryRequired = await request(app).post('/charge').send(chargeBody).expect(503);
  assert.equal(retryRequired.body.code, 'checkout_state_retry_required');
  assert.equal(retryRequired.body.retrySameCheckout, true);
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'awaiting_payment');
  assert.equal((await store.getUsage()).activeCheckout, true);

  const declined = await request(app).post('/charge').send(chargeBody).expect(402);
  assert.equal(declined.body.checkoutClosed, true);
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'payment_failed');
  assert.equal((await store.getUsage()).activeCheckout, false);
  assert.equal(gateway.paymentCalls.length, 2);
  assert.equal(gateway.paymentCalls[0]?.key, gateway.paymentCalls[1]?.key);
  assert.deepEqual(gateway.paymentCalls[0]?.input, gateway.paymentCalls[1]?.input);
});

test('authentic paid truth wins a definitive provider failure race', async () => {
  const gateway = new FakeGateway();
  const durableStore = createMemoryOrderStore();
  const referenceSecret = 'unit-test-signing-secret';
  const paymentReferenceHash = createHmac('sha256', referenceSecret)
    .update(paymentIntent.id)
    .digest('hex');
  const store = {
    ...durableStore,
    markPaymentFailed: async (retryCheckoutId: string) => {
      await durableStore.attachPaymentReference(retryCheckoutId, paymentReferenceHash);
      await durableStore.applyWebhook({
        deliveryHash: 'paid-wins-decline-race',
        paymentReferenceHash,
        status: 'paid',
        occurredAt: new Date('2026-08-21T13:00:00.000Z'),
      });
      return durableStore.markPaymentFailed(retryCheckoutId);
    },
  };
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    referenceSecret,
    { store, referenceSecret },
  );
  const quoteToken = await getQuoteToken(app);
  gateway.paymentError = new OpenBorderApiError(
    'payment_declined',
    402,
    'Unsafe provider detail must not escape',
  );

  const response = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(200);

  assert.deepEqual(response.body, {
    ok: true,
    checkoutId,
    status: 'reconciled',
  });
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'paid');
  assert.equal((await store.getUsage()).activeCheckout, false);
  assert.equal(gateway.paymentCalls.length, 1);
});

test('an idempotency conflict cannot overwrite authentic success and only the original body retries', async () => {
  const gateway = new FakeGateway();
  const store = createMemoryOrderStore();
  const referenceSecret = 'unit-test-signing-secret';
  const app = createApp(
    { publishableKey: 'pk_test_public_example', transactionCap: 50 },
    gateway,
    referenceSecret,
    { store, referenceSecret },
  );
  const quoteToken = await getQuoteToken(app);
  gateway.paymentError = new OpenBorderApiError(
    'idempotency_key_conflict',
    409,
    'The idempotency key already has a different body',
  );

  const conflict = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(409);

  assert.equal(conflict.body.code, 'idempotency_key_conflict');
  assert.equal(conflict.body.outcomeUnknown, true);
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'awaiting_payment');
  assert.equal((await store.getUsage()).activeCheckout, true);

  assert.equal(
    await store.applyWebhook({
      deliveryHash: 'conflict-success-delivery',
      paymentReferenceHash: createHmac('sha256', referenceSecret)
        .update(paymentIntent.id)
        .digest('hex'),
      status: 'paid',
      occurredAt: new Date('2026-08-21T13:00:00.000Z'),
    }),
    'staged',
  );

  const changedRetry = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_changed' })
    .expect(409);
  assert.equal(changedRetry.body.code, 'checkout_retry_mismatch');
  assert.equal(changedRetry.body.outcomeUnknown, true);
  assert.equal(gateway.paymentCalls.length, 1);
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'awaiting_payment');

  gateway.paymentError = null;
  await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(200);

  assert.equal(gateway.paymentCalls.length, 2);
  assert.equal(gateway.paymentCalls[0]?.key, gateway.paymentCalls[1]?.key);
  assert.equal((await store.getByCheckoutId(checkoutId))?.status, 'paid');
  assert.equal((await store.getUsage()).activeCheckout, false);
});

test('malformed JSON returns the normal safe validation envelope', async () => {
  const { app } = createTestApp();
  const response = await request(app)
    .post('/quote')
    .set('Content-Type', 'application/json')
    .send('{not-json')
    .expect(400);
  assert.equal(response.body.code, 'validation_error');
  assert.equal(response.body.fields.body, 'Send valid JSON.');
});

test('local tutorial needs only Test keys and permits one non-durable checkout per restart', async () => {
  const gateway = new FakeGateway();
  gateway.demoStore = undefined;
  const app = createConfiguredApp(
    {
      OB_SECRET_KEY: 'sk_test_local_tutorial',
      OB_PUBLISHABLE_KEY: 'pk_test_local_tutorial',
    },
    { runtime: 'local-tutorial', gateway },
  );

  const health = await request(app).get('/health').expect(200);
  assert.deepEqual(health.body, {
    ok: true,
    mode: 'local-tutorial',
    transactionsEnabled: true,
    transactionCap: 1,
    transactionsUsedToday: 0,
    activeCheckout: false,
    durableOrders: false,
    authenticWebhooks: false,
    trustedDemoProvenance: false,
    trustedDemoProvenanceRequired: false,
  });

  const config = await request(app).get('/config.js').expect(200);
  assert.match(config.text, /"transactionsEnabled":true/);
  assert.match(config.text, /pk_test_local_tutorial/);
  assert.doesNotMatch(config.text, /sk_test_local_tutorial/);

  const quoteToken = await getQuoteToken(app);
  await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(200);

  const secondInput = {
    ...baseInput,
    checkoutId: '018f4f31-86d4-7b2e-b6bd-7f53f5f98c72',
  };
  const secondQuoteToken = await getQuoteToken(app, secondInput);
  const blocked = await request(app)
    .post('/charge')
    .send({ ...secondInput, quoteToken: secondQuoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(409);

  assert.equal(blocked.body.code, 'checkout_in_progress');
  assert.equal(gateway.configCalls, 1);
  assert.equal(gateway.paymentCalls.length, 1);
});

test('local tutorial refuses untouched credential placeholders at startup', () => {
  assert.throws(
    () =>
      createConfiguredApp(
        {
          OB_SECRET_KEY: 'sk_test_...',
          OB_PUBLISHABLE_KEY: 'pk_test_...',
        },
        { runtime: 'local-tutorial' },
      ),
    /replace the placeholder Test credentials/i,
  );
});

test('charge attempts are rate limited for public-demo safety', async () => {
  const { app } = createTestApp();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await request(app).post('/charge').send({}).expect(400);
  }
  const limited = await request(app).post('/charge').send({}).expect(429);
  assert.equal(limited.body.error, undefined);
});

test('transaction cap defaults closed and accepts exact integers through fifty', async () => {
  const disabled = createConfiguredApp({ VERCEL_ENV: 'production' });
  assert.equal((await request(disabled).get('/health').expect(200)).body.transactionsEnabled, false);

  const enabled = createConfiguredApp({
    VERCEL_ENV: 'production',
    DEMO_TRANSACTION_CAP: ' 50 ',
    OB_SECRET_KEY: 'sk_test_example',
    OB_PUBLISHABLE_KEY: 'pk_test_example',
    OB_API_URL: 'https://api-sandbox.openborderpayments.com',
    DATABASE_URL: 'postgres://example.invalid/sample_store',
    OB_WEBHOOK_SECRET: 'whsec_example',
    ORDER_REFERENCE_HMAC_SECRET: 'r'.repeat(32),
  });
  assert.match(
    (await request(enabled).get('/config.js').expect(200)).text,
    /"transactionsEnabled":true/,
  );

  for (const value of ['-1', '1.0', '01', 'true', '51', '9007199254740993']) {
    assert.throws(
      () => createConfiguredApp({ VERCEL_ENV: 'production', DEMO_TRANSACTION_CAP: value }),
      /DEMO_TRANSACTION_CAP must be an integer from 0 through 50/,
    );
  }

  for (const transactionCap of [-1, 1.5, 51, Number.MAX_SAFE_INTEGER]) {
    assert.throws(
      () =>
        createApp(
          { publishableKey: 'pk_test_public_example', transactionCap },
          new FakeGateway(),
          'unit-test-signing-secret',
        ),
      /transaction cap must be an integer from 0 through 50/i,
    );
  }
});

test('capped public demo startup refuses live, mixed, and unsafe custom endpoints', () => {
  assert.throws(
    () =>
      createConfiguredApp({
        DEMO_TRANSACTION_CAP: '1',
        OB_SECRET_KEY: 'sk_test_example',
        OB_PUBLISHABLE_KEY: 'pk_test_example',
        OB_API_URL: 'https://api-demo.openborderpayments.com',
      }),
    /exact production Sandbox API/,
  );
  assert.throws(
    () =>
      createConfiguredApp({
        DEMO_TRANSACTION_CAP: '1',
        OB_SECRET_KEY: 'sk_live_example',
        OB_PUBLISHABLE_KEY: 'pk_live_example',
      }),
    /test keys only/,
  );
  assert.throws(
    () =>
      createConfiguredApp({
        DEMO_TRANSACTION_CAP: '1',
        OB_SECRET_KEY: 'sk_test_example',
        OB_PUBLISHABLE_KEY: 'pk_live_example',
      }),
    /test keys only/,
  );
  assert.throws(
    () =>
      createConfiguredApp({
        DEMO_TRANSACTION_CAP: '1',
        OB_SECRET_KEY: 'sk_test_example',
        OB_PUBLISHABLE_KEY: 'pk_test_example',
        OB_API_URL: 'https://api.openborderpayments.com',
      }),
    /exact production Sandbox API/,
  );
  assert.throws(
    () =>
      createConfiguredApp({
        DEMO_TRANSACTION_CAP: '1',
        OB_SECRET_KEY: `sk_test_${'x'.repeat(24)}`,
        OB_PUBLISHABLE_KEY: 'pk_test_example',
        OB_API_URL: 'https://api-staging.openborderpayments.com',
      }),
    /exact production Sandbox API/,
  );
});

test('a card the issuer wants authenticated hands the embed its continuation', async () => {
  const { app } = createTestApp(new ChallengeGateway());
  const quoteToken = await getQuoteToken(app);

  const response = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(200);

  // The embed performs the challenge from exactly this pair, so both halves must travel.
  assert.equal(response.body.ok, true);
  assert.equal(response.body.paymentStatus, 'requires_action');
  assert.equal(response.body.clientSecret, 'ps_challenge_secret_example');
  // The continuation is not a licence to leak the Open Border intent id or the entity.
  assert.doesNotMatch(JSON.stringify(response.body), /pi_test_123|obmor_uk/);
});

test('a settled charge sends no client secret at all', async () => {
  const { app } = createTestApp();
  const quoteToken = await getQuoteToken(app);

  const response = await request(app)
    .post('/charge')
    .send({ ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' })
    .expect(200);

  // Nothing is outstanding, so the credential is absent rather than null — a browser that
  // hands this back gives the embed nothing to do.
  assert.equal(response.body.paymentStatus, 'succeeded');
  assert.equal(Object.hasOwn(response.body, 'clientSecret'), false);
});
