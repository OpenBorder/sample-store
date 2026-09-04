import { createHmac, timingSafeEqual } from 'node:crypto';
import type { RequestHandler } from 'express';
import type { OrderStatus, OrderStore } from './order-store';

const TOLERANCE_MS = 5 * 60 * 1000;
const DELIVERY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const hashPrivateReference = (secret: string, value: string) =>
  createHmac('sha256', secret).update(value, 'utf8').digest('hex');

export function createWebhookReceiver(options: {
  readonly webhookSecret: string;
  readonly referenceSecret: string;
  readonly store: OrderStore;
  /**
   * Whether a terminal event must carry the `custom_api` demo attestation to be acted on.
   *
   * Only the demo stage issues it, so against any other API host every terminal event would
   * be dropped and no order could EVER reconcile — which reads exactly like an abandoned
   * payment and strands the checkout permanently. Passed in from the same host-derived value
   * `/quote` and `/charge` gate on, so the request path and the webhook path cannot disagree
   * about whether this deployment can observe provenance at all.
   *
   * The `mode: 'test'` check is NOT conditional and never becomes so: that one keeps live
   * money off this store regardless of host.
   */
  readonly requireDemoProvenance: boolean;
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

    const event = readTerminalEvent(rawBody, options.requireDemoProvenance);
    if (event) {
      try {
        await options.store.purgeDeliveriesBefore(
          new Date(now() - DELIVERY_RETENTION_MS),
        );
        const result = await options.store.applyWebhook({
          deliveryHash: hashPrivateReference(options.referenceSecret, deliveryId),
          paymentReferenceHash: hashPrivateReference(
            options.referenceSecret,
            event.paymentIntentId,
          ),
          status: event.orderStatus,
          occurredAt: event.occurredAt,
        });
        if (result === 'capacity_reached') {
          res.status(503).json({ ok: false, code: 'webhook_retry' });
          return;
        }
      } catch {
        res.status(503).json({ ok: false, code: 'webhook_retry' });
        return;
      }
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

function readTerminalEvent(
  rawBody: Buffer,
  requireDemoProvenance: boolean,
): {
  paymentIntentId: string;
  orderStatus: Extract<OrderStatus, 'paid' | 'payment_failed'>;
  occurredAt: Date;
} | null {
  try {
    const event = JSON.parse(rawBody.toString('utf8')) as {
      type?: unknown;
      mode?: unknown;
      occurredAt?: unknown;
      data?: { paymentIntentId?: unknown; demoStore?: unknown };
    };
    if (event.mode !== 'test') return null;
    if (requireDemoProvenance && event.data?.demoStore !== 'custom_api') return null;
    const paymentIntentId = event.data?.paymentIntentId;
    if (typeof paymentIntentId !== 'string' || !paymentIntentId) return null;
    if (typeof event.occurredAt !== 'string') return null;
    const occurredAt = new Date(event.occurredAt);
    if (!Number.isFinite(occurredAt.getTime())) return null;
    if (
      event.type === 'payment_intent.succeeded' ||
      event.type === 'payment_intent.captured'
    ) {
      return { paymentIntentId, orderStatus: 'paid', occurredAt };
    }
    if (
      event.type === 'payment_intent.failed' ||
      event.type === 'payment_intent.canceled'
    ) {
      return { paymentIntentId, orderStatus: 'payment_failed', occurredAt };
    }
    return null;
  } catch {
    return null;
  }
}
