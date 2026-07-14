import { strict as assert } from 'node:assert';
import { test } from 'node:test';
import request from 'supertest';
import { OpenBorderApiError, type PaymentIntentResponse, type TaxQuoteResponse } from '@open-border/node';
import { createApp, createConfiguredApp, type OpenBorderGateway } from '../app';

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
  destination_postal_code: 'SW1A 1AA',
  currency: 'GBP',
  amount_breakdown: { subtotal: 3400, shipping: 0, tax: 680, duty: 170, total: 4250, currency: 'GBP' },
  classifications: [{ index: 0, hs_code: '6110.20', confidence: 1 }],
  expires_at: new Date(Date.now() + 10 * 60_000).toISOString(),
};

const paymentIntent: PaymentIntentResponse = {
  id: 'pi_test_123',
  status: 'succeeded',
  entity: 'obmor_uk',
  amount_breakdown: quote.amount_breakdown,
  client_secret: null,
};

class FakeGateway implements OpenBorderGateway {
  quoteCalls = 0;
  paymentCalls: Array<{ input: Parameters<OpenBorderGateway['createPaymentIntent']>[0]; key: string }> = [];
  paymentError: Error | null = null;
  private readonly completed = new Map<string, PaymentIntentResponse>();

  async createTaxQuote() {
    this.quoteCalls += 1;
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

const createTestApp = (gateway = new FakeGateway()) => ({
  app: createApp({ publishableKey: 'pk_test_public_example' }, gateway, 'unit-test-signing-secret'),
  gateway,
});

async function getQuoteToken(app: ReturnType<typeof createApp>) {
  const response = await request(app).post('/quote').send(baseInput).expect(200);
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

test('catalog tampering is rejected before an upstream request', async () => {
  const { app, gateway } = createTestApp();
  const response = await request(app).post('/quote').send({ ...baseInput, amount: 1 }).expect(400);
  assert.equal(response.body.code, 'validation_error');
  assert.equal(response.body.fields.amount, 'Amount does not match the public demo catalog.');
  assert.equal(gateway.quoteCalls, 0);
});

test('the displayed signed quote is charged with a stable retry key', async () => {
  const { app, gateway } = createTestApp();
  const quoteToken = await getQuoteToken(app);
  const chargeBody = { ...baseInput, quoteToken, paymentMethodId: 'pm_test_4242' };

  const first = await request(app).post('/charge').send(chargeBody).expect(200);
  const replay = await request(app).post('/charge').send(chargeBody).expect(200);

  assert.equal(first.body.paymentIntent.id, 'pi_test_123');
  assert.equal(replay.body.paymentIntent.id, 'pi_test_123');
  assert.equal(gateway.paymentCalls[0]?.key, `sample-store:${checkoutId}`);
  assert.equal(gateway.paymentCalls[1]?.key, `sample-store:${checkoutId}`);
  assert.equal(gateway.paymentCalls[0]?.input.tax_quote_id, 'tq_test_123');
  assert.equal(gateway.paymentCalls[0]?.input.amount, 3400);
  assert.equal(gateway.paymentCalls[0]?.input.line_items[0]?.hs_code, '6110.20');
  assert.equal(gateway.paymentCalls[0]?.input.merchant_reference, `sample-store-${checkoutId}`);
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
  const { app, gateway } = createTestApp();
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
  assert.equal(response.body.message, 'Open Border could not complete this test request. Please try again.');
  assert.doesNotMatch(JSON.stringify(response.body), /acct_secret|raw response/);
  assert.match(response.body.requestId, /^[0-9a-f-]{36}$/);
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

test('charge attempts are rate limited for public-demo safety', async () => {
  const { app } = createTestApp();
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await request(app).post('/charge').send({}).expect(400);
  }
  const limited = await request(app).post('/charge').send({}).expect(429);
  assert.equal(limited.body.error, undefined);
});

test('public demo startup refuses live, mixed, and unsafe custom endpoints', () => {
  assert.throws(
    () => createConfiguredApp({ OB_SECRET_KEY: 'sk_live_example', OB_PUBLISHABLE_KEY: 'pk_live_example' }),
    /test keys only/,
  );
  assert.throws(
    () => createConfiguredApp({ OB_SECRET_KEY: 'sk_test_example', OB_PUBLISHABLE_KEY: 'pk_live_example' }),
    /test keys only/,
  );
  assert.throws(
    () =>
      createConfiguredApp({
        OB_SECRET_KEY: 'sk_test_example',
        OB_PUBLISHABLE_KEY: 'pk_test_example',
        OB_API_URL: 'https://api.openborderpayments.com',
      }),
    /staging\/dev host/,
  );
  assert.doesNotThrow(() =>
    createConfiguredApp({
      OB_SECRET_KEY: `sk_test_${'x'.repeat(24)}`,
      OB_PUBLISHABLE_KEY: 'pk_test_example',
      OB_API_URL: 'https://api-staging.openborderpayments.com',
    }),
  );
});
