// Flat requests and NOC letters (Phase 11A)

export const REQUEST_STATUS_LABELS: Record<string, string> = {
  submitted: 'Waiting for the committee',
  changes_asked: 'Changes needed',
  approved: 'Approved',
  rejected: 'Declined',
  withdrawn: 'Withdrawn',
  done: 'Done',
};

export const PENDING_NOTE = 'A NOC must be decided within one month of the application.';

/** Whole days since the request was submitted */
export function pendingDays(submittedAt: string, now: Date): number {
  return Math.max(0, Math.floor((now.getTime() - new Date(submittedAt).getTime()) / 86400_000));
}

/** NOC and transfer requests turn amber after 25 days: the society must decide within a month */
export function pendingTone(kind: string, days: number): 'normal' | 'amber' {
  return (kind === 'noc' || kind === 'transfer') && days >= 25 ? 'amber' : 'normal';
}

export interface ChecklistItem { key: string; label: string; required: boolean }

export function missingRequired(checklist: ChecklistItem[], docs: { item_key: string }[]): string[] {
  return checklist.filter(c => c.required && !docs.some(d => d.item_key === c.key)).map(c => c.label);
}

const MAX_BYTES = 10 * 1024 * 1024;
const TYPES = ['application/pdf', 'image/jpeg', 'image/png', 'image/webp'];

export function requestFileError(file: { size: number; type: string }): string | null {
  if (file.size > MAX_BYTES) return 'File is larger than 10 MB.';
  if (!TYPES.includes(file.type)) return 'Use a PDF, JPG, PNG or WEBP file.';
  return null;
}

export interface NocLetter { number: string; issued_on: string; title: string; body: string; signatory: string }
export interface LetterSociety { name: string; registration_number: string | null; address: string }

const esc = (v: unknown) => String(v ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const longDate = (iso: string) => { const [y, m, d] = iso.slice(0, 10).split('-').map(Number); return `${String(d).padStart(2, '0')} ${MONTHS[m - 1]} ${y}`; };
const SIGNATORY: Record<string, string> = { secretary: 'Secretary', chairman: 'Chairman', treasurer: 'Treasurer' };

/** The NOC as a page of its own, to print or save as PDF (like the flat statement) */
export function nocLetterHtml(letter: NocLetter, society: LetterSociety): string {
  const paragraphs = letter.body.split(/\n\s*\n/).map(p => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`).join('');
  return `<!DOCTYPE html><html><head><meta charset="utf-8"><title>${esc(letter.number)}</title>
<style>body{font-family:Georgia,serif;color:#111;margin:48px;max-width:720px}header{text-align:center;border-bottom:2px solid #111;padding-bottom:12px}
header h1{font-size:22px;margin:0}header div{font-size:13px}.meta{display:flex;justify-content:space-between;margin:20px 0;font-size:14px}
h2{text-align:center;font-size:17px;text-decoration:underline}p{font-size:15px;line-height:1.6}.sign{margin-top:64px;font-size:15px}</style></head>
<body><header><h1>${esc(society.name)}</h1>${society.registration_number ? `<div>Registration No. ${esc(society.registration_number)}</div>` : ''}<div>${esc(society.address)}</div></header>
<div class="meta"><span>Ref: ${esc(letter.number)}</span><span>Date: ${longDate(letter.issued_on)}</span></div>
<h2>${esc(letter.title)}</h2>${paragraphs}
<div class="sign">For ${esc(society.name)}<br><br><br>${SIGNATORY[letter.signatory] ?? 'Secretary'}</div>
<script>window.print()</script></body></html>`;
}
