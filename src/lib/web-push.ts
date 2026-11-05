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

/**
 * The subscription will never work again: delete it. 404/410: the browser dropped it.
 * 403: it was made with another server key (after a VAPID key change). The browser saves a fresh one
 * with the current key the next time the app opens (enablePush), so deleting is safe even if every push 403s.
 */
export const deadSubscription = (status: number) => status === 403 || status === 404 || status === 410;
