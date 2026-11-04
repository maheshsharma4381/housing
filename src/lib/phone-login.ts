import { normalizeMobile } from './mobile.ts';

/** Supabase phone auth wants +<country code><number>; a 10-digit number is Indian. */
export function toE164(input: string): string | null {
  const n = normalizeMobile(input);
  return n ? `+${n}` : null;
}

export const RESEND_SECONDS = 60;

/** Seconds until "Resend code" opens again (the server enforces the same 60 seconds). */
export function resendWait(lastSentMs: number | null, nowMs: number): number {
  if (lastSentMs === null) return 0;
  return Math.max(0, Math.ceil((lastSentMs + RESEND_SECONDS * 1000 - nowMs) / 1000));
}

/** Mobile login is switched on (the Send SMS hook works): until then nobody can log in with a mobile alone. */
export const PHONE_LOGIN_ON = process.env.NEXT_PUBLIC_PHONE_LOGIN === '1';
