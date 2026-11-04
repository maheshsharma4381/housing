// Payload-free Web Push (Phase 3A): only a VAPID-signed empty POST, so no amount or name reaches the lock
// screen and no encryption library is needed. The service worker shows a generic message.
import { sign } from 'node:crypto';

const b64url = (b: Buffer | string) => Buffer.from(b).toString('base64url');

/** An ES256 JWT for the push service at `audience` (the endpoint's origin) */
export function vapidJwt(audience: string, subject: string, privateKeyPem: string, expiresInSec = 12 * 3600, now = Date.now()): string {
  const header = b64url(JSON.stringify({ typ: 'JWT', alg: 'ES256' }));
  const claims = b64url(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + expiresInSec, sub: subject }));
  const signature = sign('sha256', Buffer.from(`${header}.${claims}`), { key: privateKeyPem, dsaEncoding: 'ieee-p1363' });
  return `${header}.${claims}.${b64url(signature)}`;
}

export function pushHeaders(jwt: string, publicKeyB64url: string): Record<string, string> {
  return { Authorization: `vapid t=${jwt}, k=${publicKeyB64url}`, TTL: '86400' };
}

export const endpointAudience = (endpoint: string) => new URL(endpoint).origin;

/** The browser has dropped this subscription: delete it */
export const deadSubscription = (status: number) => status === 404 || status === 410;
