import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import postgres from 'postgres';
import {
  OpenBorderApiError,
  OpenBorderClient,
  type CheckoutConfigResponse,
  type CreatePaymentIntentInput,
  type PaymentIntentResponse,
  type TaxQuoteResponse,
} from '@open-border/node';
import {
  createMemoryOrderStore,
  createPostgresOrderStore,
  type OrderStore,
} from './order-store';
import { createWebhookReceiver, hashPrivateReference } from './webhook';

const CATALOG = {
  hoodie: {
    name: 'Classic Pullover Hoodie',
    hsCode: '6110.20',
    prices: { USD: 4200, GBP: 3400, EUR: 3900, CAD: 5700, AUD: 6300 },
  },
  scarf: {
    name: 'Merino Wool Scarf',
    hsCode: '6214.20',
    prices: { USD: 2800, GBP: 2200, EUR: 2600, CAD: 3800, AUD: 4200 },
  },
  sneakers: {
    name: 'Suede Runner Sneakers',
    hsCode: '6403.19',
    prices: { USD: 8900, GBP: 6900, EUR: 7900, CAD: 11900, AUD: 13500 },
  },
  flannel: {
    name: 'Heavyweight Flannel Shirt',
    hsCode: '6205.20',
    prices: { USD: 4900, GBP: 3900, EUR: 4500, CAD: 6500, AUD: 7500 },
  },
  shades: {
    name: 'Polarized Sunglasses',
    hsCode: '9004.10',
    prices: { USD: 2900, GBP: 2300, EUR: 2700, CAD: 3900, AUD: 4400 },
  },
} as const;

type ProductId = keyof typeof CATALOG;
type Currency = keyof (typeof CATALOG)['hoodie']['prices'];

export interface OpenBorderGateway {
  getCheckoutConfig(
    input: Parameters<OpenBorderClient['getCheckoutConfig']>[0],
  ): Promise<CheckoutConfigResponse>;
  createTaxQuote(input: Parameters<OpenBorderClient['createTaxQuote']>[0]): Promise<TaxQuoteResponse>;
  createPaymentIntent(
    input: CreatePaymentIntentInput,
    options: { idempotencyKey: string },
  ): Promise<PaymentIntentResponse>;
}

interface AppConfig {
  publishableKey: string;
  apiBaseUrl?: string;
  transactionCap: number;
  mode?: 'local-tutorial' | 'production-sandbox';
  requireTrustedDemoProvenance?: boolean;
}

interface AppOptions {
  store?: OrderStore;
  webhookSecret?: string;
  referenceSecret?: string;
}

interface ConfiguredAppOptions {
  runtime?: 'hosted' | 'local-tutorial';
  gateway?: OpenBorderGateway;
}

type ProvenanceCheckoutConfigResponse = CheckoutConfigResponse & {
  readonly demo_store?: unknown;
};

interface QuoteTokenPayload {
  v: 1;
  checkoutId: string;
  productId: ProductId;
  currency: Currency;
  amount: number;
  total: number;
  taxQuoteId: string;
  normalizedHsCode: string;
  buyerFingerprint: string;
  expiresAt: number;
}

interface AddressInput {
  line1?: string;
  city?: string;
  postal_code?: string;
  country: string;
}

interface CheckoutInput {
  checkoutId: string;
  productId: ProductId;
  currency: Currency;
  amount: number;
  email?: string;
  name?: string;
  address: AddressInput;
}

interface ChargeInput extends CheckoutInput {
  paymentMethodId: string;
  quoteToken: string;
}

class RequestValidationError extends Error {
  constructor(readonly fields: Record<string, string>) {
    super('Check the highlighted checkout details and try again.');
  }
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const isCurrency = (value: unknown): value is Currency =>
  typeof value === 'string' && ['USD', 'GBP', 'EUR', 'CAD', 'AUD'].includes(value);

const isProductId = (value: unknown): value is ProductId =>
  typeof value === 'string' && Object.hasOwn(CATALOG, value);

const cleanString = (value: unknown, max: number) =>
  typeof value === 'string' && value.trim().length <= max ? value.trim() : '';

function isValidEmail(value: string) {
  if (!value || [...value].some((character) => character.trim() === '')) return false;
  const at = value.indexOf('@');
  if (at <= 0 || at !== value.lastIndexOf('@')) return false;
  const dot = value.indexOf('.', at + 2);
  return dot > at + 1 && dot < value.length - 1;
}

function parseCheckoutInput(value: unknown, requireBuyer: boolean): CheckoutInput {
  if (!isObject(value)) throw new RequestValidationError({ body: 'Expected a JSON object.' });

  const fields: Record<string, string> = {};
  const checkoutId = cleanString(value.checkoutId, 64);
  const productId = value.productId;
  const currency = value.currency;
  const amount = value.amount;
  const addressValue = value.address;

  if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(checkoutId)) fields.checkoutId = 'Invalid checkout reference.';
  if (!isProductId(productId)) fields.productId = 'Choose a listed product.';
  if (!isCurrency(currency)) fields.currency = 'Choose a supported currency.';
  if (!Number.isSafeInteger(amount) || Number(amount) <= 0) fields.amount = 'Amount must be positive minor units.';
  if (!isObject(addressValue)) fields.address = 'Address is required.';

  const address: AddressInput = {
    line1: isObject(addressValue) ? cleanString(addressValue.line1, 200) : '',
    city: isObject(addressValue) ? cleanString(addressValue.city, 100) : '',
    postal_code: isObject(addressValue) ? cleanString(addressValue.postal_code, 32) : '',
    country: isObject(addressValue) ? cleanString(addressValue.country, 2).toUpperCase() : '',
  };

  if (!/^[A-Z]{2}$/.test(address.country)) fields.country = 'Choose a destination country.';
  if (requireBuyer && !address.line1) fields.line1 = 'Address is required.';

  const email = cleanString(value.email, 254);
  if (requireBuyer && !isValidEmail(email)) fields.email = 'Enter a valid email.';

  if (isProductId(productId) && isCurrency(currency)) {
    const expected = CATALOG[productId].prices[currency];
    if (amount !== expected) fields.amount = 'Amount does not match the public demo catalog.';
  }

  if (Object.keys(fields).length) throw new RequestValidationError(fields);

  return {
    checkoutId,
    productId: productId as ProductId,
    currency: currency as Currency,
    amount: amount as number,
    email: email || undefined,
    name: cleanString(value.name, 120) || undefined,
    address,
  };
}

function parseChargeInput(value: unknown): ChargeInput {
  const base = parseCheckoutInput(value, true);
  const object = value as Record<string, unknown>;
  const fields: Record<string, string> = {};
  const paymentMethodId = cleanString(object.paymentMethodId, 255);
  const quoteToken = cleanString(object.quoteToken, 4096);

  if (!/^pm_[A-Za-z0-9_]+$/.test(paymentMethodId)) fields.paymentMethodId = 'Invalid payment method token.';
  if (!quoteToken.includes('.')) fields.quoteToken = 'A valid displayed quote is required.';
  if (Object.keys(fields).length) throw new RequestValidationError(fields);

  return { ...base, paymentMethodId, quoteToken };
}

const lineItemsFor = (input: CheckoutInput, hsCode: string) => [
  {
    description: CATALOG[input.productId].name,
    quantity: 1,
    unit_amount: input.amount,
    hs_code: hsCode,
  },
];

const buyerFingerprintFor = (input: CheckoutInput) =>
  createHash('sha256')
    .update(
      JSON.stringify([
        input.email ?? '',
        input.name ?? '',
        input.address.line1 ?? '',
        input.address.city ?? '',
        input.address.postal_code ?? '',
        input.address.country,
      ]),
    )
    .digest('base64url');

const providerMessage = (code: string) => {
  if (code === 'validation_error') return 'Check the checkout details and try again.';
  if (code === 'payment_declined') return 'The test payment was declined.';
  if (code === 'idempotency_key_conflict') {
    return 'Payment status is unknown. Retry only this locked checkout.';
  }
  return 'Open Border could not complete this test request. Please try again.';
};

const isDefinitivePaymentFailure = (error: unknown): error is OpenBorderApiError =>
  error instanceof OpenBorderApiError &&
  ['payment_declined', 'validation_error'].includes(error.code);

function sendPaymentOutcomeUnknown(res: Response, error: unknown): void {
  const requestId = res.locals.requestId as string | undefined;
  if (error instanceof OpenBorderApiError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    res.status(status).json({
      ok: false,
      code: error.code,
      message: providerMessage(error.code),
      outcomeUnknown: true,
      requestId,
    });
    return;
  }
  res.status(502).json({
    ok: false,
    code: 'payment_status_unknown',
    message: 'Payment status is unknown. Retry only this locked checkout.',
    outcomeUnknown: true,
    requestId,
  });
}

function sendClosedCheckout(res: Response, error: OpenBorderApiError): void {
  const message = error.code === 'payment_declined'
    ? 'The test payment was declined. Close this checkout and start a new one with another test card.'
    : 'The payment request was rejected. Close this checkout and start a new one.';
  res.status(error.status >= 400 && error.status < 500 ? error.status : 502).json({
    ok: false,
    code: error.code,
    message,
    checkoutClosed: true,
    requestId: res.locals.requestId,
  });
}

function sendCheckoutStateRetryRequired(res: Response): void {
  res.status(503).json({
    ok: false,
    code: 'checkout_state_retry_required',
    message: 'The payment was declined, but the checkout could not be safely closed. Retry only this locked checkout.',
    retrySameCheckout: true,
    requestId: res.locals.requestId,
  });
}

async function hasTrustedCustomApiProvenance(
  client: OpenBorderGateway,
  currency: Currency,
): Promise<boolean> {
  try {
    const config = await client.getCheckoutConfig({ currency });
    return (config as ProvenanceCheckoutConfigResponse).demo_store === 'custom_api';
  } catch {
    return false;
  }
}

function sendDemoProvenanceUnavailable(res: Response): void {
  res.status(503).json({
    ok: false,
    code: 'demo_provenance_unavailable',
    message: 'The verified Custom API Sandbox provenance is unavailable.',
    requestId: res.locals.requestId,
  });
}

function sendError(res: Response, error: unknown) {
  const requestId = res.locals.requestId as string | undefined;
  if (error instanceof RequestValidationError) {
    res.status(400).json({ ok: false, code: 'validation_error', message: error.message, fields: error.fields, requestId });
    return;
  }
  if (error instanceof Error && error.message === 'order_reference_conflict') {
    res.status(409).json({
      ok: false,
      code: 'checkout_retry_mismatch',
      message: 'This request does not match the locked checkout. Retry only the original payment.',
      outcomeUnknown: true,
      requestId,
    });
    return;
  }
  if (error instanceof OpenBorderApiError) {
    const status = error.status >= 400 && error.status < 500 ? error.status : 502;
    res.status(status).json({ ok: false, code: error.code, message: providerMessage(error.code), requestId });
    return;
  }
  res.status(500).json({ ok: false, code: 'internal_error', message: 'The demo request failed safely.', requestId });
}

const encode = (value: string) => Buffer.from(value).toString('base64url');
const signatureFor = (encodedPayload: string, signingSecret: string) =>
  createHmac('sha256', signingSecret).update(encodedPayload).digest('base64url');

function signQuote(payload: QuoteTokenPayload, signingSecret: string) {
  const encodedPayload = encode(JSON.stringify(payload));
  return `${encodedPayload}.${signatureFor(encodedPayload, signingSecret)}`;
}

function verifyQuote(token: string, signingSecret: string, input: CheckoutInput): QuoteTokenPayload {
  const [encodedPayload, suppliedSignature, extra] = token.split('.');
  if (!encodedPayload || !suppliedSignature || extra) {
    throw new RequestValidationError({ quoteToken: 'The displayed quote is invalid.' });
  }
  const expectedSignature = signatureFor(encodedPayload, signingSecret);
  const supplied = Buffer.from(suppliedSignature);
  const expected = Buffer.from(expectedSignature);
  if (supplied.length !== expected.length || !timingSafeEqual(supplied, expected)) {
    throw new RequestValidationError({ quoteToken: 'The displayed quote is invalid.' });
  }

  let payload: QuoteTokenPayload;
  try {
    payload = JSON.parse(Buffer.from(encodedPayload, 'base64url').toString('utf8')) as QuoteTokenPayload;
  } catch {
    throw new RequestValidationError({ quoteToken: 'The displayed quote is invalid.' });
  }

  if (
    payload.v !== 1 ||
    payload.checkoutId !== input.checkoutId ||
    payload.productId !== input.productId ||
    payload.currency !== input.currency ||
    payload.amount !== input.amount ||
    payload.buyerFingerprint !== buyerFingerprintFor(input) ||
    payload.expiresAt <= Date.now() ||
    typeof payload.taxQuoteId !== 'string' ||
    payload.taxQuoteId.length === 0 ||
    !/^\d{4}\.\d{2,4}$/.test(payload.normalizedHsCode)
  ) {
    throw new RequestValidationError({ quoteToken: 'The displayed quote expired or no longer matches this checkout.' });
  }
  return payload;
}

export function createApp(
  config: AppConfig,
  client: OpenBorderGateway,
  signingSecret: string,
  options: AppOptions = {},
) {
  assertTransactionCap(config.transactionCap);
  if (signingSecret.length < 16) throw new Error('Quote signing secret must be at least 16 characters.');
  const transactionCap = config.transactionCap;
  const transactionsEnabled = transactionCap > 0;
  const trustedDemoProvenanceRequired = config.requireTrustedDemoProvenance ?? true;
  const store = options.store ?? createMemoryOrderStore();
  const referenceSecret = options.referenceSecret ?? signingSecret;
  const durableOrders = options.store !== undefined;
  const authenticWebhooks =
    durableOrders && Boolean(options.webhookSecret && options.referenceSecret);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', 1);
  app.use((_req, res, next) => {
    res.locals.requestId = randomUUID();
    res.setHeader('X-Request-ID', res.locals.requestId);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
    next();
  });
  app.post(
    '/webhooks/openborder',
    express.raw({ type: 'application/json', limit: '64kb' }),
    authenticWebhooks
      ? createWebhookReceiver({
          webhookSecret: options.webhookSecret!,
          referenceSecret: options.referenceSecret!,
          store,
        })
      : (_req, res) =>
          res.status(503).json({ ok: false, code: 'demo_not_enabled' }),
  );
  app.use(express.json({ limit: '24kb' }));

  const quoteLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
  const chargeLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

  app.get('/health', async (_req, res) => {
    const [storeReady, usage, trustedDemoProvenance] = await Promise.all([
      durableOrders ? store.checkReady().catch(() => false) : false,
      durableOrders
        ? store
            .getUsage()
            .catch(() => null)
        : { activeCheckout: false, transactionsUsedToday: 0 },
      hasTrustedCustomApiProvenance(client, 'USD'),
    ]);
    const durableStoreReady = storeReady && usage !== null;
    res.json({
      ok: true,
      mode: config.mode ?? 'production-sandbox',
      transactionsEnabled,
      transactionCap,
      transactionsUsedToday: usage?.transactionsUsedToday ?? 0,
      activeCheckout: usage?.activeCheckout ?? false,
      durableOrders: durableStoreReady,
      authenticWebhooks: authenticWebhooks && durableStoreReady,
      trustedDemoProvenance,
      ...(trustedDemoProvenanceRequired ? {} : { trustedDemoProvenanceRequired: false }),
    });
  });

  app.get('/config.js', (_req, res) => {
    res
      .setHeader('Cache-Control', 'no-store')
      .type('application/javascript')
      .send(
        `window.OB_CONFIG = ${JSON.stringify({
          publishableKey: config.publishableKey,
          ...(config.apiBaseUrl ? { apiBaseUrl: config.apiBaseUrl } : {}),
          transactionsEnabled,
        })};`,
      );
  });

  app.post('/quote', quoteLimiter, async (req, res) => {
    if (!transactionsEnabled) {
      res.status(503).json({ ok: false, code: 'demo_not_enabled' });
      return;
    }
    try {
      if (!(await store.checkReady().catch(() => false))) {
        res.status(503).json({ ok: false, code: 'demo_not_ready' });
        return;
      }
      const input = parseCheckoutInput(req.body, false);
      const product = CATALOG[input.productId];
      if (
        trustedDemoProvenanceRequired &&
        !(await hasTrustedCustomApiProvenance(client, input.currency))
      ) {
        sendDemoProvenanceUnavailable(res);
        return;
      }
      const quote = await client.createTaxQuote({
        destination_country: input.address.country,
        // US states and CA provinces carry the whole tax rate, so the API refuses a quote
        // priced on the country alone there — it requires a region or a postal code. The
        // postal code resolves it; Open Border infers the state/province from it. Sent from
        // the SAME value the charge's shipping address uses, because the quote is bound to
        // it: a quote priced for one state cannot price a sale in another. Omitted entirely
        // when the buyer gave none, rather than sent empty.
        ...(input.address.postal_code
          ? { destination_postal_code: input.address.postal_code }
          : {}),
        ship_from_country: 'US',
        currency: input.currency,
        line_items: lineItemsFor(input, product.hsCode),
        ...(input.email ? { customer: { email: input.email } } : {}),
      });
      const parsedExpiry = Date.parse(quote.expires_at);
      const expiresAt = Number.isFinite(parsedExpiry)
        ? Math.min(parsedExpiry, Date.now() + 15 * 60_000)
        : Date.now() + 15 * 60_000;
      res.json({
        ok: true,
        domestic: input.address.country === 'US',
        taxQuoteId: quote.id,
        normalizedHsCode: quote.classifications[0]?.hs_code ?? product.hsCode,
        quoteToken: signQuote(
          {
            v: 1,
            checkoutId: input.checkoutId,
            productId: input.productId,
            currency: input.currency,
            amount: input.amount,
            total: quote.amount_breakdown.total,
            taxQuoteId: quote.id,
            normalizedHsCode: quote.classifications[0]?.hs_code ?? product.hsCode,
            buyerFingerprint: buyerFingerprintFor(input),
            expiresAt,
          },
          signingSecret,
        ),
        amount_breakdown: quote.amount_breakdown,
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/charge', chargeLimiter, async (req, res) => {
    if (!transactionsEnabled) {
      res.status(503).json({ ok: false, code: 'demo_not_enabled' });
      return;
    }
    try {
      if (!(await store.checkReady().catch(() => false))) {
        res.status(503).json({ ok: false, code: 'demo_not_ready' });
        return;
      }
      const input = parseChargeInput(req.body);
      const quote = verifyQuote(input.quoteToken, signingSecret, input);
      if (
        trustedDemoProvenanceRequired &&
        !(await hasTrustedCustomApiProvenance(client, input.currency))
      ) {
        sendDemoProvenanceUnavailable(res);
        return;
      }
      const paymentInput: CreatePaymentIntentInput = {
        tax_quote_id: quote.taxQuoteId,
        amount: input.amount,
        currency: input.currency,
        payment_method: input.paymentMethodId,
        customer: { email: input.email!, ...(input.name ? { name: input.name } : {}) },
        billing_address: input.address as Required<Pick<AddressInput, 'line1' | 'country'>> & AddressInput,
        shipping_address: input.address as Required<Pick<AddressInput, 'line1' | 'country'>> & AddressInput,
        line_items: lineItemsFor(input, quote.normalizedHsCode),
        merchant_reference: `sample-store-${input.checkoutId}`,
        metadata: { demo: 'custom-api-reference', checkout_id: input.checkoutId },
      };
      const order = await store.createOrGetWithinCap({
        checkoutId: input.checkoutId,
        idempotencyKey: hashPrivateReference(
          referenceSecret,
          `payment-submission\0${JSON.stringify(paymentInput)}`,
        ),
        status: 'awaiting_payment',
        productId: input.productId,
        amount: input.amount,
        currency: input.currency,
      }, transactionCap);
      if (order === 'cap_reached') {
        res.status(503).json({
          ok: false,
          code: 'transaction_cap_reached',
          message: 'The public demo transaction limit has been reached.',
          requestId: res.locals.requestId,
        });
        return;
      }
      if (order === 'active_checkout') {
        res.status(409).json({
          ok: false,
          code: 'checkout_in_progress',
          message: 'Another demo checkout is still being reconciled. Try again later.',
          requestId: res.locals.requestId,
        });
        return;
      }
      if (order.status === 'paid') {
        res.json({ ok: true, checkoutId: input.checkoutId, status: 'reconciled' });
        return;
      }
      if (order.status === 'payment_failed') {
        res.status(409).json({
          ok: false,
          code: 'checkout_closed',
          message: 'This test checkout is already closed. Start a new checkout.',
          checkoutClosed: true,
          requestId: res.locals.requestId,
        });
        return;
      }

      let paymentIntent: PaymentIntentResponse;
      try {
        paymentIntent = await client.createPaymentIntent(paymentInput, {
          idempotencyKey: order.idempotencyKey,
        });
      } catch (error) {
        if (isDefinitivePaymentFailure(error)) {
          try {
            const failureResult = await store.markPaymentFailed(input.checkoutId);
            if (failureResult === 'terminal_noop') {
              const terminalOrder = await store.getByCheckoutId(input.checkoutId);
              if (terminalOrder?.status === 'paid') {
                res.json({
                  ok: true,
                  checkoutId: input.checkoutId,
                  status: 'reconciled',
                });
                return;
              }
              if (terminalOrder?.status !== 'payment_failed') {
                sendCheckoutStateRetryRequired(res);
                return;
              }
            }
          } catch {
            sendCheckoutStateRetryRequired(res);
            return;
          }
          sendClosedCheckout(res, error);
          return;
        }
        sendPaymentOutcomeUnknown(res, error);
        return;
      }
      try {
        await store.attachPaymentReference(
          input.checkoutId,
          hashPrivateReference(referenceSecret, paymentIntent.id),
        );
      } catch (error) {
        sendPaymentOutcomeUnknown(res, error);
        return;
      }
      res.json({
        ok: true,
        checkoutId: input.checkoutId,
        status: 'payment_submitted',
        // A card the issuer wants authenticated (3DS/SCA) comes back `requires_action`,
        // and the buyer still has a step to take. The embed performs it when the browser
        // hands this pair back, so the two fields travel together or not at all. The
        // client secret is publishable by design — it can only complete THIS payment and
        // moves no money on its own — but it is still only sent when a challenge is
        // actually outstanding, and it never reveals the Open Border intent id that
        // `attachPaymentReference` above deliberately keeps hashed.
        paymentStatus: paymentIntent.status,
        ...(paymentIntent.status === 'requires_action' && paymentIntent.client_secret
          ? { clientSecret: paymentIntent.client_secret }
          : {}),
      });
    } catch (error) {
      sendError(res, error);
    }
  });

  app.use((error: unknown, _req: Request, res: Response, _next: express.NextFunction) => {
    if (error instanceof SyntaxError) {
      sendError(res, new RequestValidationError({ body: 'Send valid JSON.' }));
      return;
    }
    sendError(res, error);
  });

  return app;
}

export function createConfiguredApp(
  env: NodeJS.ProcessEnv = process.env,
  options: ConfiguredAppOptions = {},
) {
  const secretKey = env.OB_SECRET_KEY;
  const publishableKey = env.OB_PUBLISHABLE_KEY;
  const apiBaseUrl = env.OB_API_URL ?? 'https://api-sandbox.openborderpayments.com';

  if (options.runtime === 'local-tutorial') {
    assertTestCredentials(secretKey, publishableKey);
    assertSandboxApiUrl(apiBaseUrl);
    const client = options.gateway ?? createOpenBorderClient(secretKey!, apiBaseUrl);
    const signingSecret = createHash('sha256')
      .update(`local-tutorial\0${secretKey}`)
      .digest('hex');
    return createApp(
      {
        publishableKey: publishableKey!,
        apiBaseUrl,
        transactionCap: 1,
        mode: 'local-tutorial',
        requireTrustedDemoProvenance: false,
      },
      client,
      signingSecret,
    );
  }

  const transactionCap = readTransactionCap(env.DEMO_TRANSACTION_CAP);
  const databaseUrl = env.DATABASE_URL;
  const webhookSecret = env.OB_WEBHOOK_SECRET;
  const referenceSecret = env.ORDER_REFERENCE_HMAC_SECRET;
  const readinessPrerequisitesPresent = Boolean(
    secretKey && publishableKey && databaseUrl && webhookSecret && referenceSecret,
  );

  if (transactionCap === 0 && !readinessPrerequisitesPresent) {
    const disabledGateway: OpenBorderGateway = {
      getCheckoutConfig: async () => {
        throw new Error('demo_not_enabled');
      },
      createTaxQuote: async () => {
        throw new Error('demo_not_enabled');
      },
      createPaymentIntent: async () => {
        throw new Error('demo_not_enabled');
      },
    };
    return createApp(
      { publishableKey: '', transactionCap: 0 },
      disabledGateway,
      'zero-cap-quote-signing-secret',
    );
  }

  assertTestCredentials(secretKey, publishableKey);
  assertSandboxApiUrl(apiBaseUrl);
  if (!databaseUrl || !webhookSecret || !referenceSecret) {
    throw new Error(
      'Configured demo readiness requires durable storage and webhook prerequisites.',
    );
  }
  if (!webhookSecret.startsWith('whsec_')) {
    throw new Error('Configured demo readiness requires an authentic webhook signing secret.');
  }
  if (referenceSecret.length < 32) {
    throw new Error('ORDER_REFERENCE_HMAC_SECRET must contain at least 32 characters.');
  }

  const client = options.gateway ?? createOpenBorderClient(secretKey!, apiBaseUrl);
  const sql = postgres(databaseUrl, { max: 1, prepare: false });
  return createApp(
    { publishableKey: publishableKey!, apiBaseUrl, transactionCap },
    client,
    referenceSecret,
    {
      store: createPostgresOrderStore(sql),
      webhookSecret,
      referenceSecret,
    },
  );
}

function assertTestCredentials(
  secretKey: string | undefined,
  publishableKey: string | undefined,
): void {
  if (!secretKey || !publishableKey) {
    throw new Error('Configured demo readiness requires Test credentials.');
  }
  if (secretKey.includes('...') || publishableKey.includes('...')) {
    throw new Error('Replace the placeholder Test credentials before starting the demo.');
  }
  if (!secretKey.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')) {
    throw new Error('This public demo accepts Open Border test keys only. Live keys are refused.');
  }
}

function assertSandboxApiUrl(apiBaseUrl: string): void {
  const url = new URL(apiBaseUrl);
  if (
    url.origin !== 'https://api-sandbox.openborderpayments.com' ||
    url.pathname !== '/' ||
    url.search ||
    url.hash ||
    url.username ||
    url.password
  ) {
    throw new Error('OB_API_URL must target the exact production Sandbox API.');
  }
}

function createOpenBorderClient(secretKey: string, apiBaseUrl: string): OpenBorderGateway {
  const fetchWithTimeout: typeof fetch = (input, init = {}) =>
    fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });
  return new OpenBorderClient({
    apiKey: secretKey,
    baseUrl: apiBaseUrl,
    fetch: fetchWithTimeout,
  });
}

function readTransactionCap(value: string | undefined): number {
  const raw = value?.trim();
  if (!raw || raw === '0') return 0;
  if (/^(?:[1-9]|[1-4][0-9]|50)$/.test(raw)) return Number(raw);
  throw new Error('DEMO_TRANSACTION_CAP must be an integer from 0 through 50.');
}

function assertTransactionCap(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > 50) {
    throw new Error('Transaction cap must be an integer from 0 through 50.');
  }
}
