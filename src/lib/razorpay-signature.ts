// Razorpay signature checks (server-side only — needs the key / webhook secret).
import { createHmac, timingSafeEqual } from 'node:crypto';

export const hmacSha256Hex = (secret: string, payload: string) => createHmac('sha256', secret).update(payload).digest('hex');

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a, 'utf8');
  const y = Buffer.from(b, 'utf8');
  return x.length === y.length && timingSafeEqual(x, y);
}

/** Checkout success handler: signature = HMAC_SHA256(order_id + "|" + payment_id, key_secret). */
export function verifyCheckoutSignature(orderId: string, paymentId: string, signature: string, keySecret: string): boolean {
  if (!orderId || !paymentId || !signature || !keySecret) return false;
  return safeEqual(hmacSha256Hex(keySecret, `${orderId}|${paymentId}`), signature);
}

/** Webhook: X-Razorpay-Signature = HMAC_SHA256(raw request body, webhook_secret). */
export function verifyWebhookSignature(rawBody: string, signature: string | null, webhookSecret: string): boolean {
  if (!signature || !webhookSecret) return false;
  return safeEqual(hmacSha256Hex(webhookSecret, rawBody), signature);
}

/** Pull the ids we need from a payment.captured / order.paid webhook body. */
export function paymentFromWebhook(event: unknown): { invoiceId: string; orderId: string; paymentId: string; amount: number } | null {
  const e = event as {
    event?: string;
    payload?: {
      payment?: { entity?: { id?: string; order_id?: string; amount?: number; status?: string; notes?: Record<string, string> } };
      order?: { entity?: { id?: string; notes?: Record<string, string> } };
    };
  };
  if (e?.event !== 'payment.captured' && e?.event !== 'order.paid') return null;
  const payment = e.payload?.payment?.entity;
  const invoiceId = e.payload?.order?.entity?.notes?.invoice_id ?? payment?.notes?.invoice_id;
  const orderId = payment?.order_id ?? e.payload?.order?.entity?.id;
  if (!payment?.id || !orderId || !invoiceId || typeof payment.amount !== 'number' || payment.status !== 'captured') return null;
  return { invoiceId, orderId, paymentId: payment.id, amount: payment.amount };
}
