'use client';
// Turns on phone notifications for this browser (Phase 3A): registers /sw.js, asks permission,
// subscribes with the VAPID public key and saves the subscription for the logged-in user.
import { supabase } from './supabase/client';

export type PushResult = 'enabled' | 'denied' | 'unsupported' | 'not-configured';

const keyBytes = (b64url: string) => {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/') + '='.repeat((4 - (b64url.length % 4)) % 4);
  const raw = atob(b64);
  return Uint8Array.from(raw, c => c.charCodeAt(0));
};

export function pushSupported(): boolean {
  return typeof window !== 'undefined' && 'serviceWorker' in navigator && 'PushManager' in window && 'Notification' in window;
}

/** On logout: this browser stops getting the user's notifications (their own row only, by RLS). */
export async function forgetPush(): Promise<void> {
  if (!pushSupported() || !supabase) return;
  try {
    const registration = await navigator.serviceWorker.getRegistration('/sw.js');
    const subscription = await registration?.pushManager.getSubscription();
    if (subscription) await supabase.from('push_subscriptions').delete().eq('endpoint', subscription.endpoint);
  } catch {
    // logging out must never fail because of push
  }
}

export async function enablePush(): Promise<PushResult> {
  if (!pushSupported()) return 'unsupported';
  const publicKey = process.env.NEXT_PUBLIC_VAPID_PUBLIC_KEY;
  if (!publicKey || !supabase) return 'not-configured';
  const permission = await Notification.requestPermission();
  if (permission !== 'granted') return 'denied';
  const registration = await navigator.serviceWorker.register('/sw.js');
  await navigator.serviceWorker.ready;
  const subscription = (await registration.pushManager.getSubscription())
    ?? await registration.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: keyBytes(publicKey) });
  const json = subscription.toJSON();
  const { error } = await supabase.rpc('save_push_subscription', {
    p_endpoint: json.endpoint, p_p256dh: json.keys?.p256dh ?? null, p_auth: json.keys?.auth ?? null,
  });
  return error ? 'not-configured' : 'enabled';
}
