import { NextResponse, type NextRequest } from 'next/server';
import { createServerSupabaseClient } from '../../../../lib/supabase/server';

/**
 * POST /api/billing/order  { invoiceId }
 * Creates a Razorpay order for an unpaid Sahvaas invoice (committee only) and returns what
 * Razorpay Checkout needs. Without RAZORPAY_KEY_ID / RAZORPAY_KEY_SECRET it answers
 * { configured: false } and the page shows bank-transfer details instead.
 */
export async function POST(request: NextRequest) {
  let body: { invoiceId?: string };
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'Invalid JSON' }, { status: 400 });
  }
  if (!body.invoiceId || !/^[0-9a-f-]{36}$/i.test(body.invoiceId)) {
    return NextResponse.json({ error: 'invoiceId is required' }, { status: 400 });
  }

  const keyId = process.env.RAZORPAY_KEY_ID;
  const keySecret = process.env.RAZORPAY_KEY_SECRET;
  if (!keyId || !keySecret || !process.env.SAHVAAS_GATEWAY_SECRET) return NextResponse.json({ configured: false });

  const supabase = await createServerSupabaseClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return NextResponse.json({ error: 'Not signed in' }, { status: 401 });

  const { data: invoice } = await supabase.from('platform_invoices')
    .select('id, invoice_number, society_id, total, status, plan_code, period_start, period_end, bill_to')
    .eq('id', body.invoiceId).maybeSingle();
  if (!invoice) return NextResponse.json({ error: 'Invoice not found' }, { status: 404 });
  if (invoice.status !== 'issued') return NextResponse.json({ error: `This invoice is ${invoice.status}` }, { status: 409 });
  const { data: isAdmin } = await supabase.rpc('is_society_admin', { target_society_id: invoice.society_id });
  if (!isAdmin) return NextResponse.json({ error: 'Only the society committee can pay' }, { status: 403 });

  const amount = Math.round(Number(invoice.total) * 100);
  const res = await fetch('https://api.razorpay.com/v1/orders', {
    method: 'POST',
    headers: {
      authorization: `Basic ${Buffer.from(`${keyId}:${keySecret}`).toString('base64')}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      amount,
      currency: 'INR',
      receipt: invoice.invoice_number,
      notes: { invoice_id: invoice.id, society_id: invoice.society_id },
    }),
  });
  if (!res.ok) {
    console.warn('Razorpay order failed:', res.status, (await res.text()).slice(0, 300));
    return NextResponse.json({ configured: true, error: 'Could not start the payment — try again or pay by bank transfer' }, { status: 502 });
  }
  const order = await res.json() as { id: string };
  const { error: attachErr } = await supabase.rpc('attach_gateway_order', { p_invoice_id: invoice.id, p_order_id: order.id });
  if (attachErr) return NextResponse.json({ error: attachErr.message }, { status: 400 });

  return NextResponse.json({
    configured: true,
    keyId,
    orderId: order.id,
    amount,
    currency: 'INR',
    description: `${invoice.invoice_number} · Sahvaas ${invoice.plan_code} plan`,
    societyName: (invoice.bill_to as { name?: string } | null)?.name ?? '',
    email: user.email ?? '',
    invoiceId: invoice.id,
  });
}
