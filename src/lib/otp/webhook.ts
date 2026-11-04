import { createHmac, timingSafeEqual } from 'node:crypto';

// Standard Webhooks (https://www.standardwebhooks.com), as Supabase Auth hooks sign their calls.
const TOLERANCE_SECONDS = 5 * 60;

/** The hook secret Supabase shows is "v1,whsec_<base64>"; the HMAC key is the decoded part. */
function hookKey(secret: string): Buffer | null {
  const b64 = secret.trim().replace(/^v1,/, '').replace(/^whsec_/, '');
  if (!b64) return null;
  const key = Buffer.from(b64, 'base64');
  return key.length > 0 ? key : null;
}

/** True only for a call signed with this secret, unchanged, and no more than 5 minutes old or early. */
export function verifyWebhook(secret: string, headers: Headers, body: string, nowSeconds: number): boolean {
  const key = hookKey(secret);
  const id = headers.get('webhook-id');
  const ts = Number(headers.get('webhook-timestamp'));
  const sigHeader = headers.get('webhook-signature');
  if (!key || !id || !sigHeader || !Number.isFinite(ts)) return false;
  if (Math.abs(nowSeconds - ts) > TOLERANCE_SECONDS) return false;
  const expected = createHmac('sha256', key).update(`${id}.${ts}.${body}`).digest();
  return sigHeader.split(' ').some(part => {
    const [version, sig] = part.split(',');
    if (version !== 'v1' || !sig) return false;
    const given = Buffer.from(sig, 'base64');
    return given.length === expected.length && timingSafeEqual(given, expected);
  });
}
