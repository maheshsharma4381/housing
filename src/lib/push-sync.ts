// What the bell does about phone notifications on this browser (Phase 3A).
export type PushSync = 'resubscribe' | 'offer' | 'blocked' | 'unsupported';

/** Allowed before: save the subscription again quietly (a new login, a lost or replaced subscription). */
export function pushSyncAction(supported: boolean, permission: 'default' | 'granted' | 'denied'): PushSync {
  if (!supported) return 'unsupported';
  if (permission === 'granted') return 'resubscribe';
  if (permission === 'denied') return 'blocked';
  return 'offer';
}
