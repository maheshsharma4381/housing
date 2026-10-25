'use client';

import React from 'react';
import { amountInWords, formatINR } from '../lib/inr';
import { gstSplit } from '../lib/billing';
import { PlatformInvoice } from '../types/database';

const d = (iso: string | null) => (iso ? new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—');

/** Printable Sahvaas tax invoice (white sheet, prints on its own). */
export const InvoiceView: React.FC<{ invoice: PlatformInvoice }> = ({ invoice: inv }) => (
  <article className="bg-white text-slate-900 rounded-2xl p-6 space-y-4 text-xs print:rounded-none print:p-0">
    <header className="flex flex-wrap justify-between gap-4 border-b border-slate-200 pb-3">
      <div>
        <div className="text-lg font-extrabold">{inv.seller.name || 'Sahvaas'}</div>
        {inv.seller.address && <div className="text-slate-600">{inv.seller.address}</div>}
        <div className="text-slate-600">GSTIN {inv.seller.gstin || '— (to be added)'} · SAC {inv.seller.sac || '—'}</div>
      </div>
      <div className="text-right">
        <div className="text-[11px] font-extrabold tracking-[0.15em]">TAX INVOICE</div>
        <div className="font-mono font-bold">{inv.invoice_number}</div>
        <div className="text-slate-600">Date {d(inv.issued_on)} · Due {d(inv.due_on)}</div>
        <div className={`mt-1 inline-block px-2 py-0.5 rounded-full text-[10px] font-bold uppercase ${inv.status === 'paid' ? 'bg-emerald-100 text-emerald-800' : inv.status === 'void' ? 'bg-slate-100 text-slate-500' : 'bg-amber-100 text-amber-800'}`}>{inv.status}</div>
      </div>
    </header>
    <div className="text-slate-700">
      Bill to <strong className="text-slate-900">{inv.bill_to.name}</strong>
      {inv.bill_to.address && <>, {inv.bill_to.address}</>}{inv.bill_to.state && <> · {inv.bill_to.state}</>}
      {inv.bill_to.gstin && <> · GSTIN {inv.bill_to.gstin}</>}
    </div>
    <table className="w-full">
      <tbody>
        <tr>
          <td className="py-1">
            Sahvaas {inv.plan_code.charAt(0).toUpperCase() + inv.plan_code.slice(1)} plan ({inv.kind === 'upgrade' ? 'upgrade, prorated' : inv.billing_term}) · {d(inv.period_start)} – {d(inv.period_end)}
            <div className="text-slate-500">{inv.billable_units} flats × {formatINR(inv.rate)} × {Number(inv.months_charged)} month{Number(inv.months_charged) === 1 ? '' : 's'}</div>
          </td>
          <td className="py-1 text-right align-top">{formatINR(inv.gross)}</td>
        </tr>
        {Number(inv.discount) > 0 && <tr><td className="py-1 text-slate-600">Discount</td><td className="py-1 text-right">−{formatINR(inv.discount)}</td></tr>}
        <tr className="border-t border-slate-200"><td className="py-1 text-slate-600">Taxable value</td><td className="py-1 text-right">{formatINR(inv.taxable)}</td></tr>
        {gstSplit(inv).map(g => <tr key={g.label}><td className="py-1 text-slate-600">{g.label}</td><td className="py-1 text-right">{formatINR(g.amount)}</td></tr>)}
        <tr className="border-t border-slate-300 font-extrabold text-sm"><td className="pt-2">Total</td><td className="pt-2 text-right">{formatINR(inv.total)}</td></tr>
      </tbody>
    </table>
    <p className="italic text-slate-600">{amountInWords(Number(inv.total))}</p>
    {inv.status === 'paid' && <p className="text-emerald-700">Paid on {d(inv.paid_on)} via {inv.payment_method === 'gateway' ? 'online payment' : 'bank transfer'}{inv.payment_reference ? ` (${inv.payment_reference})` : ''}.</p>}
    <footer className="text-[10px] text-slate-500 border-t border-slate-200 pt-2">Computer-generated invoice.</footer>
  </article>
);
