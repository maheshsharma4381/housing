// What the printed bill (/bill/<id>) says about itself.

/** A cancelled or paid bill must not read like a demand for money (it may be saved as a PDF). */
export function billView(status: string, balanceDue: number): { heading: string; asksForPayment: boolean } {
  if (status === 'cancelled') return { heading: 'MAINTENANCE BILL — CANCELLED', asksForPayment: false };
  if (status === 'paid' || balanceDue <= 0.005) return { heading: 'MAINTENANCE BILL — PAID', asksForPayment: false };
  return { heading: 'MAINTENANCE BILL', asksForPayment: true };
}
