import type { PlanFeature, PlatformInvoice } from '../types/database';

export const FEATURES: { key: PlanFeature; label: string; plan: 'Basic' | 'Pro' }[] = [
  { key: 'ca_portal', label: 'CA & auditor portal', plan: 'Basic' },
  { key: 'asset_register', label: 'Asset register & depreciation', plan: 'Basic' },
  { key: 'gst_recon', label: 'GSTR-2B reconciliation', plan: 'Pro' },
  { key: 'tds_register', label: 'TDS register', plan: 'Pro' },
  { key: 'bank_match', label: 'Bank statement match', plan: 'Pro' },
  { key: 'tally_export', label: 'Tally export', plan: 'Pro' },
];

export const featureLabel = (key: string) => FEATURES.find(f => f.key === key)?.label ?? key;
export const featurePlan = (key: string) => FEATURES.find(f => f.key === key)?.plan ?? 'Pro';

/** Intra-state supply: CGST + SGST halves; otherwise IGST. */
export function gstSplit(inv: Pick<PlatformInvoice, 'gst_amount' | 'gst_rate' | 'seller' | 'bill_to'>) {
  const same = !!inv.seller.state && !!inv.bill_to.state && inv.seller.state.trim().toLowerCase() === inv.bill_to.state.trim().toLowerCase();
  const gst = Number(inv.gst_amount);
  if (!same) return [{ label: `IGST ${inv.gst_rate}%`, amount: gst }];
  const half = Math.round((gst / 2) * 100) / 100;
  return [
    { label: `CGST ${Number(inv.gst_rate) / 2}%`, amount: half },
    { label: `SGST ${Number(inv.gst_rate) / 2}%`, amount: Math.round((gst - half) * 100) / 100 },
  ];
}

export const daysUntil = (iso: string | null | undefined) => {
  if (!iso) return null;
  const ms = new Date(`${iso}T00:00:00`).getTime() - new Date(new Date().toDateString()).getTime();
  return Math.round(ms / 86400000);
};

type CheckoutResponse = { razorpay_order_id: string; razorpay_payment_id: string; razorpay_signature: string };
type RazorpayCtor = new (options: Record<string, unknown>) => { open: () => void; on: (event: string, cb: (e: unknown) => void) => void };

function loadCheckout(): Promise<RazorpayCtor> {
  const w = window as unknown as { Razorpay?: RazorpayCtor };
  if (w.Razorpay) return Promise.resolve(w.Razorpay);
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://checkout.razorpay.com/v1/checkout.js';
    s.onload = () => (w.Razorpay ? resolve(w.Razorpay) : reject(new Error('Payment window did not load')));
    s.onerror = () => reject(new Error('Payment window did not load — check your connection'));
    document.body.appendChild(s);
  });
}

export type PayResult =
  | { kind: 'not_configured' }
  | { kind: 'paid' }
  | { kind: 'pending'; message: string }
  | { kind: 'cancelled' }
  | { kind: 'error'; message: string };

/** Create an order, open Razorpay Checkout and verify the result on the server. */
export async function payInvoiceOnline(invoiceId: string): Promise<PayResult> {
  const orderRes = await fetch('/api/billing/order', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoiceId }) });
  const order = await orderRes.json() as {
    configured?: boolean; error?: string; keyId?: string; orderId?: string; amount?: number; currency?: string;
    description?: string; societyName?: string; email?: string;
  };
  if (order.configured === false) return { kind: 'not_configured' };
  if (!orderRes.ok || order.error || !order.orderId) return { kind: 'error', message: order.error ?? 'Could not start the payment' };

  const Razorpay = await loadCheckout();
  return new Promise<PayResult>((resolve) => {
    const rzp = new Razorpay({
      key: order.keyId,
      order_id: order.orderId,
      amount: order.amount,
      currency: order.currency,
      name: 'Sahvaas',
      description: order.description,
      notes: { invoice_id: invoiceId },
      prefill: { email: order.email, name: order.societyName },
      theme: { color: '#0369a1' },
      modal: { ondismiss: () => resolve({ kind: 'cancelled' }) },
      handler: async (resp: CheckoutResponse) => {
        const v = await fetch('/api/billing/verify', {
          method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ invoiceId, ...resp }),
        });
        const body = await v.json() as { status?: string; pending?: boolean; message?: string; error?: string };
        if (body.pending) resolve({ kind: 'pending', message: body.message ?? 'Payment is being confirmed.' });
        else if (v.ok && body.status === 'paid') resolve({ kind: 'paid' });
        else resolve({ kind: 'error', message: body.error ?? 'Payment could not be verified' });
      },
    });
    rzp.on('payment.failed', (e) => {
      const err = (e as { error?: { description?: string } }).error;
      resolve({ kind: 'error', message: err?.description ?? 'Payment failed' });
    });
    rzp.open();
  });
}
