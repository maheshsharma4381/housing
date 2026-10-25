import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hmacSha256Hex, paymentFromWebhook, verifyCheckoutSignature, verifyWebhookSignature } from '../../src/lib/razorpay-signature.ts';

test('HMAC matches the published SHA-256 test vector', () => {
  // RFC 4231 test case 2
  assert.equal(hmacSha256Hex('Jefe', 'what do ya want for nothing?'), '5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843');
});

test('checkout signature: order|payment signed with the key secret', () => {
  const sig = hmacSha256Hex('key_secret_x', 'order_9A33XWu170gUtm|pay_29QQoUBi66xm2f');
  assert.equal(verifyCheckoutSignature('order_9A33XWu170gUtm', 'pay_29QQoUBi66xm2f', sig, 'key_secret_x'), true);
  assert.equal(verifyCheckoutSignature('order_9A33XWu170gUtm', 'pay_OTHER', sig, 'key_secret_x'), false);
  assert.equal(verifyCheckoutSignature('order_9A33XWu170gUtm', 'pay_29QQoUBi66xm2f', sig, 'wrong'), false);
  assert.equal(verifyCheckoutSignature('', 'p', sig, 'k'), false);
});

test('webhook signature is over the raw body', () => {
  const body = JSON.stringify({ event: 'payment.captured' });
  const sig = hmacSha256Hex('whsec', body);
  assert.equal(verifyWebhookSignature(body, sig, 'whsec'), true);
  assert.equal(verifyWebhookSignature(body + ' ', sig, 'whsec'), false, 'any change to the body breaks it');
  assert.equal(verifyWebhookSignature(body, null, 'whsec'), false);
});

test('payment details are read only from captured payments', () => {
  const captured = {
    event: 'payment.captured',
    payload: { payment: { entity: { id: 'pay_1', order_id: 'order_1', amount: 377600, status: 'captured', notes: { invoice_id: 'inv-1' } } } },
  };
  assert.deepEqual(paymentFromWebhook(captured), { invoiceId: 'inv-1', orderId: 'order_1', paymentId: 'pay_1', amount: 377600 });
  const orderPaid = {
    event: 'order.paid',
    payload: { order: { entity: { id: 'order_2', notes: { invoice_id: 'inv-2' } } }, payment: { entity: { id: 'pay_2', amount: 100, status: 'captured' } } },
  };
  assert.deepEqual(paymentFromWebhook(orderPaid), { invoiceId: 'inv-2', orderId: 'order_2', paymentId: 'pay_2', amount: 100 });
  assert.equal(paymentFromWebhook({ ...captured, event: 'payment.failed' }), null);
  assert.equal(paymentFromWebhook({ event: 'payment.captured', payload: { payment: { entity: { id: 'p', status: 'authorized', amount: 1, order_id: 'o', notes: { invoice_id: 'i' } } } } }), null);
});
