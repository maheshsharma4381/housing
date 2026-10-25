import { formatINR } from './inr.ts';

/**
 * Message templates shared by WhatsApp share links and transactional email.
 * Pure functions: no network, no secrets — safe to unit test and to use in the browser.
 */

export interface InviteMessageInput {
  societyName: string;
  inviteeName?: string | null;
  role: string;
  email: string;
  appUrl: string;
  flat?: string | null;
}

export interface BillMessageInput {
  societyName: string;
  ownerName?: string | null;
  flat: string;
  billNumber: string;
  amount: number;
  dueDate: string;
  appUrl: string;
}

export interface ReceiptMessageInput {
  societyName: string;
  ownerName?: string | null;
  flat: string;
  receiptNumber: string;
  amount: number;
  utr: string;
  receiptUrl: string;
}

const greet = (name?: string | null) => (name ? `Hello ${name.split(' ')[0]},` : 'Hello,');
const fmtDate = (iso: string) => {
  const d = new Date(`${iso.slice(0, 10)}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? iso : d.toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
};

export function inviteText(i: InviteMessageInput): string {
  return [
    greet(i.inviteeName),
    `${i.societyName} has invited you to Sahvaas as ${i.role}${i.flat ? ` for flat ${i.flat}` : ''}.`,
    `Sign up with ${i.email} at ${i.appUrl}/signup, verify your email and accept the invitation.`,
  ].join('\n');
}

export function billText(b: BillMessageInput): string {
  return [
    greet(b.ownerName),
    `${b.societyName}: maintenance bill ${b.billNumber} for flat ${b.flat} is ${formatINR(b.amount)}, due ${fmtDate(b.dueDate)}.`,
    `Pay by UPI and submit the UTR at ${b.appUrl}/resident`,
  ].join('\n');
}

export function receiptText(r: ReceiptMessageInput): string {
  return [
    greet(r.ownerName),
    `${r.societyName} received ${formatINR(r.amount)} for flat ${r.flat} (UTR ${r.utr}).`,
    `Receipt ${r.receiptNumber}: ${r.receiptUrl}`,
  ].join('\n');
}

/**
 * wa.me link. Indian 10-digit numbers get the 91 country code; without a valid number
 * WhatsApp opens its contact picker so the sender chooses the chat.
 */
export function whatsappLink(text: string, phone?: string | null): string {
  let digits = (phone ?? '').replace(/\D/g, '');
  if (digits.length === 11 && digits.startsWith('0')) digits = digits.slice(1);
  if (digits.length === 10) digits = `91${digits}`;
  const target = digits.length >= 11 && digits.length <= 15 ? digits : '';
  return `https://wa.me/${target}?text=${encodeURIComponent(text)}`;
}

// ----- Email -----

export interface EmailContent {
  subject: string;
  text: string;
  html: string;
}

const escapeHtml = (s: string) =>
  s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');

/** Plain-text body → simple, accessible HTML (links made clickable after escaping). */
function toHtml(text: string, footer: string): string {
  const body = escapeHtml(text)
    .split('\n')
    .map(line => `<p style="margin:0 0 12px">${line.replace(/(https?:\/\/[^\s<]+)/g, '<a href="$1">$1</a>')}</p>`)
    .join('');
  return `<div style="font-family:Arial,sans-serif;font-size:14px;color:#0f172a;max-width:560px">${body}<p style="margin-top:24px;font-size:12px;color:#64748b">${escapeHtml(footer)}</p></div>`;
}

const FOOTER = 'Sent by Sahvaas on behalf of your housing society. Reply to your society office for questions.';

export function inviteEmail(i: InviteMessageInput): EmailContent {
  const text = inviteText(i);
  return { subject: `${i.societyName} invited you to Sahvaas`, text: `${text}\n\n${FOOTER}`, html: toHtml(text, FOOTER) };
}

export function billEmail(b: BillMessageInput): EmailContent {
  const text = billText(b);
  return { subject: `${b.societyName}: bill ${b.billNumber} — ${formatINR(b.amount)} due ${fmtDate(b.dueDate)}`, text: `${text}\n\n${FOOTER}`, html: toHtml(text, FOOTER) };
}

export function receiptEmail(r: ReceiptMessageInput): EmailContent {
  const text = receiptText(r);
  return { subject: `${r.societyName}: payment received — receipt ${r.receiptNumber}`, text: `${text}\n\n${FOOTER}`, html: toHtml(text, FOOTER) };
}
