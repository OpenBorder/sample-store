import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { OrderStatus, OrderStore } from './order-store';

const TOLERANCE_MS = 5 * 60 * 1000;

export const hashPrivateReference = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value, 'utf8').digest('hex');

export function createWebhookReceiver(options: {
  readonly webhookSecret: string;
  readonly referenceSecret: string;
  readonly store: OrderStore;
  readonly now?: () => number;
}): RequestHandler {
  const now = options.now ?? Date.now;
  return async (req, res) => {
    const deliveryId = req.get('OpenBorder-Webhook-Id');
    const timestampHeader = req.get('OpenBorder-Webhook-Timestamp');
    const signatureHeader = req.get('OpenBorder-Webhook-Signature');
    const rawBody = Buffer.isBuffer(req.body) ? req.body : undefined;
    const signature = readSignature(signatureHeader);
    const timestamp = Number(timestampHeader);

    if (
      !deliveryId ||
      !rawBody ||
      !signature ||
      signature.timestamp !== timestampHeader ||
      !Number.isSafeInteger(timestamp) ||
      Math.abs(now() - timestamp * 1000) > TOLERANCE_MS ||
      !validSignature(
        options.webhookSecret,
        timestampHeader,
        deliveryId,
        rawBody,
        signature.digest,
      )
    ) {
      res.status(401).json({ ok: false, code: 'invalid_webhook' });
      return;
    }

    const event = readTerminalEvent(rawBody);
    if (event) {
      await options.store.applyWebhook({
        deliveryHash: hashPrivateReference(options.referenceSecret, deliveryId),
        paymentReferenceHash: hashPrivateReference(
          options.referenceSecret,
          event.paymentIntentId,
        ),
        status: event.orderStatus,
        occurredAt: new Date(timestamp * 1000),
      });
    }
    res.status(204).send();
  };
}

function readSignature(
  value: string | undefined,
): { digest: string; timestamp: string } | undefined {
  if (!value) return undefined;
  const fields = Object.fromEntries(
    value.split(',').map((field) => {
      const [name, ...rest] = field.trim().split('=');
      return [name, rest.join('=')];
    }),
  );
  if (!/^[0-9a-f]{64}$/.test(fields.v1 ?? '') || !/^[0-9]+$/.test(fields.t ?? '')) {
    return undefined;
  }
  return { digest: fields.v1, timestamp: fields.t };
}

function validSignature(
  secret: string,
  timestamp: string,
  deliveryId: string,
  rawBody: Buffer,
  suppliedHex: string,
) {
  const expected = createHmac('sha256', secret)
    .update(`${timestamp}.${deliveryId}.`)
    .update(rawBody)
    .digest();
  const supplied = Buffer.from(suppliedHex, 'hex');
  return supplied.length === expected.length && timingSafeEqual(supplied, expected);
}

function readTerminalEvent(rawBody: Buffer): {
  paymentIntentId: string;
  orderStatus: Extract<OrderStatus, 'paid' | 'payment_failed'>;
} | null {
  try {
    const event = JSON.parse(rawBody.toString('utf8')) as {
      type?: unknown;
      data?: { paymentIntentId?: unknown };
    };
    const paymentIntentId = event.data?.paymentIntentId;
    if (typeof paymentIntentId !== 'string' || !paymentIntentId) return null;
    if (
      event.type === 'payment_intent.succeeded' ||
      event.type === 'payment_intent.captured'
    ) {
      return { paymentIntentId, orderStatus: 'paid' };
    }
    if (
      event.type === 'payment_intent.failed' ||
      event.type === 'payment_intent.canceled'
    ) {
      return { paymentIntentId, orderStatus: 'payment_failed' };
    }
    return null;
  } catch {
    return null;
  }
}
