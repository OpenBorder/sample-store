import { randomUUID } from 'node:crypto';
import express from 'express';
import {
  OpenBorderApiError,
  OpenBorderClient,
  type CreatePaymentIntentInput,
} from '@open-border/node';

const OB_SECRET_KEY = process.env.OB_SECRET_KEY;
const OB_PUBLISHABLE_KEY = process.env.OB_PUBLISHABLE_KEY;
const OB_API_URL = process.env.OB_API_URL;

if (!OB_SECRET_KEY || !OB_PUBLISHABLE_KEY) {
  throw new Error('Set OB_SECRET_KEY and OB_PUBLISHABLE_KEY (see .env.example).');
}

// When OB_API_URL is unset, the SDK and the browser embed both default to the deployed
// Open Border host matching the key's rail (test or live).
const client = new OpenBorderClient({
  apiKey: OB_SECRET_KEY,
  ...(OB_API_URL ? { baseUrl: OB_API_URL } : {}),
});

const app = express();
app.use(express.json());

app.get('/config.js', (_req, res) => {
  res
    .type('application/javascript')
    .send(
      `window.OB_CONFIG = ${JSON.stringify({
        publishableKey: OB_PUBLISHABLE_KEY,
        ...(OB_API_URL ? { apiBaseUrl: OB_API_URL } : {}),
      })};`,
    );
});

const lineItemsFor = (body: any) => [
  {
    description: body.productName ?? 'Sample product',
    quantity: 1,
    unit_amount: body.amount,
    hs_code: body.hsCode,
  },
];

// Duties & taxes follow the ship-to destination. A domestic order (ship-from == ship-to) has
// no cross-border quote — the API signals `domestic_not_supported` and the order is charged
// as subtotal only. Any other quote failure fails the request: no charge without the quote.
async function taxQuoteFor(body: any, address: any) {
  try {
    return await client.createTaxQuote({
      destination_country: address.country,
      ...(address.postal_code ? { destination_postal_code: address.postal_code } : {}),
      currency: body.currency,
      line_items: lineItemsFor(body),
      ...(body.email ? { customer: { email: body.email } } : {}),
    });
  } catch (error) {
    if (error instanceof OpenBorderApiError && error.code === 'domestic_not_supported') {
      return null;
    }
    throw error;
  }
}

function sendError(res: express.Response, error: unknown) {
  if (error instanceof OpenBorderApiError) {
    res.status(error.status || 502).json({ ok: false, code: error.code, message: error.message });
    return;
  }
  res.status(500).json({ ok: false, code: 'internal_error', message: 'Request failed.' });
}

app.post('/quote', async (req, res) => {
  const body = req.body ?? {};
  const address = body.address ?? {};

  try {
    const quote = await taxQuoteFor(body, address);
    res.json({
      ok: true,
      domestic: !quote,
      amount_breakdown: quote?.amount_breakdown ?? {
        subtotal: body.amount,
        shipping: 0,
        tax: 0,
        duty: 0,
        total: body.amount,
        currency: body.currency,
      },
    });
  } catch (error) {
    sendError(res, error);
  }
});

app.post('/charge', async (req, res) => {
  const body = req.body ?? {};
  const address = body.address ?? {};

  try {
    const quote = await taxQuoteFor(body, address);

    const input: CreatePaymentIntentInput = {
      ...(quote ? { tax_quote_id: quote.id } : {}),
      amount: body.amount,
      currency: body.currency,
      payment_method: body.paymentMethodId,
      customer: { email: body.email, ...(body.name ? { name: body.name } : {}) },
      billing_address: address,
      shipping_address: address,
      // The intent's line items must match the quote's, so re-use the quote's normalized
      // HS codes.
      line_items: quote
        ? lineItemsFor(body).map((item, index) => ({
            ...item,
            hs_code: quote.classifications.find((c) => c.index === index)?.hs_code || item.hs_code,
          }))
        : lineItemsFor(body),
      merchant_reference: `sample-store-${randomUUID()}`,
    };

    const paymentIntent = await client.createPaymentIntent(input, {
      idempotencyKey: randomUUID(),
    });
    res.json({ ok: true, paymentIntent });
  } catch (error) {
    sendError(res, error);
  }
});

export default app;
