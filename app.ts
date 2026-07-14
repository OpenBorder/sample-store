import { createHash, createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import express, { type Request, type Response } from 'express';
import rateLimit from 'express-rate-limit';
import {
  OpenBorderApiError,
  OpenBorderClient,
  type CreatePaymentIntentInput,
  type PaymentIntentResponse,
  type TaxQuoteResponse,
} from '@open-border/node';

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
  createTaxQuote(input: Parameters<OpenBorderClient['createTaxQuote']>[0]): Promise<TaxQuoteResponse>;
  createPaymentIntent(
    input: CreatePaymentIntentInput,
    options: { idempotencyKey: string },
  ): Promise<PaymentIntentResponse>;
}

interface AppConfig {
  publishableKey: string;
  apiBaseUrl?: string;
}

interface QuoteTokenPayload {
  v: 1;
  checkoutId: string;
  productId: ProductId;
  currency: Currency;
  amount: number;
  total: number;
  taxQuoteId: string | null;
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
  if (requireBuyer && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) fields.email = 'Enter a valid email.';

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
  if (code === 'payment_declined') return 'The test payment was declined. Try another test card.';
  if (code === 'idempotency_conflict') return 'This checkout changed after submission. Start a new checkout.';
  return 'Open Border could not complete this test request. Please try again.';
};

function sendError(res: Response, error: unknown) {
  const requestId = res.locals.requestId as string | undefined;
  if (error instanceof RequestValidationError) {
    res.status(400).json({ ok: false, code: 'validation_error', message: error.message, fields: error.fields, requestId });
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
    !/^\d{4}\.\d{2,4}$/.test(payload.normalizedHsCode)
  ) {
    throw new RequestValidationError({ quoteToken: 'The displayed quote expired or no longer matches this checkout.' });
  }
  return payload;
}

export function createApp(config: AppConfig, client: OpenBorderGateway, signingSecret: string) {
  if (signingSecret.length < 16) throw new Error('Quote signing secret must be at least 16 characters.');
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
  app.use(express.json({ limit: '24kb' }));

  const quoteLimiter = rateLimit({ windowMs: 60_000, limit: 60, standardHeaders: 'draft-7', legacyHeaders: false });
  const chargeLimiter = rateLimit({ windowMs: 60_000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false });

  app.get('/health', (_req, res) => res.json({ ok: true, mode: 'test' }));

  app.get('/config.js', (_req, res) => {
    res
      .setHeader('Cache-Control', 'no-store')
      .type('application/javascript')
      .send(`window.OB_CONFIG = ${JSON.stringify(config)};`);
  });

  app.post('/quote', quoteLimiter, async (req, res) => {
    try {
      const input = parseCheckoutInput(req.body, false);
      const product = CATALOG[input.productId];
      try {
        const quote = await client.createTaxQuote({
          destination_country: input.address.country,
          ...(input.address.postal_code ? { destination_postal_code: input.address.postal_code } : {}),
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
          domestic: false,
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
        if (error instanceof OpenBorderApiError && error.code === 'domestic_not_supported') {
          res.json({
            ok: true,
            domestic: true,
            taxQuoteId: null,
            normalizedHsCode: product.hsCode,
            quoteToken: signQuote(
              {
                v: 1,
                checkoutId: input.checkoutId,
                productId: input.productId,
                currency: input.currency,
                amount: input.amount,
                total: input.amount,
                taxQuoteId: null,
                normalizedHsCode: product.hsCode,
                buyerFingerprint: buyerFingerprintFor(input),
                expiresAt: Date.now() + 15 * 60_000,
              },
              signingSecret,
            ),
            amount_breakdown: {
              subtotal: input.amount,
              shipping: 0,
              tax: 0,
              duty: 0,
              total: input.amount,
              currency: input.currency,
            },
          });
          return;
        }
        throw error;
      }
    } catch (error) {
      sendError(res, error);
    }
  });

  app.post('/charge', chargeLimiter, async (req, res) => {
    try {
      const input = parseChargeInput(req.body);
      const quote = verifyQuote(input.quoteToken, signingSecret, input);
      const paymentInput: CreatePaymentIntentInput = {
        ...(quote.taxQuoteId ? { tax_quote_id: quote.taxQuoteId } : {}),
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

      const paymentIntent = await client.createPaymentIntent(paymentInput, {
        idempotencyKey: `sample-store:${input.checkoutId}`,
      });
      res.json({ ok: true, checkoutId: input.checkoutId, paymentIntent });
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

export function createConfiguredApp(env: NodeJS.ProcessEnv = process.env) {
  const secretKey = env.OB_SECRET_KEY;
  const publishableKey = env.OB_PUBLISHABLE_KEY;
  const apiBaseUrl = env.OB_API_URL;

  if (!secretKey || !publishableKey) {
    throw new Error('Set OB_SECRET_KEY and OB_PUBLISHABLE_KEY (see .env.example).');
  }
  if (!secretKey.startsWith('sk_test_') || !publishableKey.startsWith('pk_test_')) {
    throw new Error('This public demo accepts Open Border test keys only. Live keys are refused.');
  }
  if (apiBaseUrl) {
    const url = new URL(apiBaseUrl);
    const local = ['localhost', '127.0.0.1'].includes(url.hostname);
    const safeRemote =
      url.protocol === 'https:' &&
      ['api-staging.openborderpayments.com', 'api-dev.openborderpayments.com'].includes(url.hostname);
    if (url.username || url.password || (!local && !safeRemote)) {
      throw new Error('OB_API_URL must be localhost or an approved HTTPS Open Border staging/dev host.');
    }
  }

  const fetchWithTimeout: typeof fetch = (input, init = {}) =>
    fetch(input, { ...init, signal: init.signal ?? AbortSignal.timeout(10_000) });

  const client = new OpenBorderClient({
    apiKey: secretKey,
    ...(apiBaseUrl ? { baseUrl: apiBaseUrl } : {}),
    fetch: fetchWithTimeout,
  });
  return createApp(
    { publishableKey, ...(apiBaseUrl ? { apiBaseUrl } : {}) },
    client,
    secretKey,
  );
}
