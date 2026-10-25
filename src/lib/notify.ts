export type NotifyType = 'member_invite' | 'professional_invite' | 'bills_issued' | 'receipt';

export interface NotifyResult {
  configured: boolean;
  sent: number;
  failed: number;
  error?: string;
  /** Why nothing was sent (already emailed / daily limit) */
  skipped?: string;
}

/** Ask the server to email the people affected by an action. Never throws. */
export async function notify(type: NotifyType, id: string): Promise<NotifyResult> {
  try {
    const res = await fetch('/api/notify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ type, id }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) return { configured: true, sent: 0, failed: 1, error: data.error ?? `HTTP ${res.status}` };
    return { configured: data.configured ?? false, sent: data.sent ?? 0, failed: data.failed ?? 0, error: data.error, skipped: data.skipped };
  } catch (err) {
    return { configured: false, sent: 0, failed: 0, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Short suffix for success banners, e.g. " Email sent to 12 members." */
export function describeNotify(r: NotifyResult, noun = 'member'): string {
  if (!r.configured) return '';
  if (r.skipped) return ` (No email sent: ${r.skipped}.)`;
  if (r.sent > 0) return ` Email sent to ${r.sent} ${noun}${r.sent > 1 ? 's' : ''}.`;
  if (r.failed > 0) return ' (Email could not be sent — share on WhatsApp instead.)';
  return '';
}
