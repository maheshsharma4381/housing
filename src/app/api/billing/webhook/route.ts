import { NextResponse, type NextRequest } from 'next/server';
import { createClient } from '@supabase/supabase-js';
import { paymentFromWebhook, verifyWebhookSignature } from '../../../../lib/razorpay-signature';

/**
 * POST /api/billing/webhook — Razorpay webhook (events: payment.captured, order.paid).
 * Verifies X-Razorpay-Signature over the raw body, then records the payment with the
 * shared gateway secret. No user session and no service-role key are involved.
 */
export async function POST(request: NextRequest) {
  const webhookSecret = process.env.RAZORPAY_WEBHOOK_SECRET;
  const gatewaySecret = process.env.SAHVAAS_GATEWAY_SECRET;
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!webhookSecret || !gatewaySecret || !url || !anonKey) return NextResponse.json({ error: 'Not configured' }, { status: 503 });

  const raw = await request.text();
  if (!verifyWebhookSignature(raw, request.headers.get('x-razorpay-signature'), webhookSecret)) {
    return NextResponse.json({ error: 'Bad signature' }, { status: 401 });
  }

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  const payment = paymentFromWebhook(event);
  if (!payment) return NextResponse.json({ ignored: true });

  const supabase = createClient(url, anonKey, { auth: { persistSession: false, autoRefreshToken: false } });
  const { data, error } = await supabase.rpc('gateway_record_payment', {
    p_secret: gatewaySecret, p_invoice_id: payment.invoiceId, p_order_id: payment.orderId,
    p_payment_id: payment.paymentId, p_amount_paise: payment.amount,
  });
  if (error) {
    console.warn('Webhook payment not recorded:', error.message);
    // Razorpay retries any non-2xx; mismatches will not fix themselves, so acknowledge those and let others retry
    const permanent = /does not match|not found/i.test(error.message);
    return NextResponse.json({ error: error.message }, { status: permanent ? 200 : 500 });
  }
  return NextResponse.json(data);
}
