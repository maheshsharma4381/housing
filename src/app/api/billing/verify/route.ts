import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '../../../../lib/supabase/server';
import { verifyCheckoutSignature } from '../../../../lib/razorpay-signature';

/**
 * POST /api/billing/verify  { invoiceId, razorpay_order_id, razorpay_payment_id, razorpay_signature }
 * Called by the page after Razorpay Checkout succeeds. Checks the signature, confirms with
 * Razorpay that the payment is captured, then records it (gateway_record_payment).
 * The webhook does the same if the browser closes first; recording twice is harmless.
 */
export async function POST(request: NextRequest) {
  let body: { invoiceId?: string; razorpay_order_id?: string; razorpay_payment_id?: string; razorpay_signature?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  const gatewaySecret = process.env.SAHVAAS_GATEWAY_SECRET;
  if (!keyId || !keySecret || !gatewaySecret) return NextResponse.json({ error: 'Online payment is not configured' }, { status: 503 });

  const { invoiceId, razorpay_order_id: orderId, razorpay_payment_id: paymentId, razorpay_signature: signature } = body;
  if (!invoiceId || !orderId || !paymentId || !signature || !verifyCheckoutSignature(orderId, paymentId, signature, keySecret)) {
    return NextResponse.json({ error: 'Payment could not be verified' }, { status: 400 });
  }

  // Trust Razorpay's record of the payment, not the browser
  const res = await fetch(`https://api.razorpay.com/v1/payments/${encodeURIComponent(paymentId)}`, {
    headers: { authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}` },
  });
  if (!res.ok) return NextResponse.json({ error: 'Could not confirm the payment with Razorpay' }, { status: 502 });
  const payment = await res.json() as { status: string; amount: number; order_id: string };
  if (payment.order_id !== orderId) return NextResponse.json({ error: 'Payment does not belong to this order' }, { status: 400 });
  if (payment.status !== 'captured') {
    return NextResponse.json({ pending: true, message: 'Payment received by the bank; it will be confirmed in a few minutes.' });
  }

  const supabase = await createServerSupabaseClient();
  const { data, error } = await supabase.rpc('gateway_record_payment', {
    p_secret: gatewaySecret, p_invoice_id: invoiceId, p_order_id: orderId, p_payment_id: paymentId, p_amount_paise: payment.amount,
  });
  if (error) return NextResponse.json({ error: error.message }, { status: 400 });
  return NextResponse.json(data);
}
