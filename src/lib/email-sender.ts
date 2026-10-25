import 'server-only';
import type { EmailContent } from './messages';

export interface OutgoingEmail extends EmailContent {
  to: string;
}

export interface SendResult {
  configured: boolean;
  sent: number;
  failed: number;
  error?: string;
}

/**
 * Sends through Resend's batch API (https://resend.com/docs/api-reference/emails/send-batch-emails).
 * Without RESEND_API_KEY / EMAIL_FROM nothing is sent and `configured` is false,
 * so the app keeps working (WhatsApp share remains available).
 */
export async function sendEmails(emails: OutgoingEmail[]): Promise<SendResult> {
  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM; // e.g. "Sahvaas <noreply@yourdomain.in>" (domain verified in Resend)
  if (!apiKey || !from) return { configured: false, sent: 0, failed: 0 };

  let sent = 0;
  let failed = 0;
  let lastError: string | undefined;
  for (let i = 0; i < emails.length; i += 100) {
    const chunk = emails.slice(i, i + 100);
    try {
      const res = await fetch('https://api.resend.com/emails/batch', {
        method: 'POST',
        headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(chunk.map(e => ({ from, to: [e.to], subject: e.subject, html: e.html, text: e.text }))),
      });
      if (res.ok) {
        sent += chunk.length;
      } else {
        failed += chunk.length;
        lastError = `Email provider returned ${res.status}`;
      }
    } catch (err) {
      failed += chunk.length;
      lastError = err instanceof Error ? err.message : String(err);
    }
  }
  return { configured: true, sent, failed, error: lastError };
}
