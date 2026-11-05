// What the bell does about phone notifications on this browser (Phase 3A).
export type PushSync = 'resubscribe' | 'offer' | 'blocked' | 'unsupported';

/** The VAPID public key (base64url) as the bytes PushManager.subscribe wants. */
export function keyBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob(b64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
}

/** Was this browser's subscription made with the current server key? After a key change the push service refuses the old one. */
export function sameServerKey(existing: ArrayBuffer | null | undefined, publicKeyB64url: string): boolean {
  if (!existing) return false;
  const a = new Uint8Array(existing);
  const b = keyBytes(publicKeyB64url);
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** Allowed before: save the subscription again quietly (a new login, a lost or replaced subscription). */
export function pushSyncAction(supported: boolean, permission: 'default' | 'granted' | 'denied'): PushSync {
  if (!supported) return 'unsupported';
  if (permission === 'granted') return 'resubscribe';
  if (permission === 'denied') return 'blocked';
  return 'offer';
}
