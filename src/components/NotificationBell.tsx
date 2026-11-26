'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { enablePush, pushSupported } from '../lib/push-client';
import { pushSyncAction, type PushSync } from '../lib/push-sync';
import { Bell, BellRing, CheckCheck } from 'lucide-react';

interface Item { id: string; title: string; body: string | null; link: string | null; created_at: string; read_at: string | null }

const ago = (iso: string) => {
  const mins = Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
  if (mins < 60) return `${mins}m ago`;
  if (mins < 60 * 24) return `${Math.round(mins / 60)}h ago`;
  return new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' });
};

/** The in-app inbox (Phase 3A): bell with an unread badge, latest 30 notifications, phone notifications switch. */
export const NotificationBell: React.FC<{ onOpen?: (link: string) => void; align?: 'left' | 'right' }> = ({ onOpen, align = 'right' }) => {
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const [items, setItems] = useState<Item[]>([]);
  const [pushState, setPushState] = useState<string | null>(null);
  const [sync, setSync] = useState<PushSync>('unsupported');
  const box = useRef<HTMLDivElement>(null);

  // Allowed before on this phone: save the subscription again quietly (new login, lost or replaced subscription)
  useEffect(() => {
    const action = pushSyncAction(pushSupported(), typeof Notification === 'undefined' ? 'default' : Notification.permission);
    setSync(action);
    if (action === 'resubscribe') enablePush().catch(() => undefined);
  }, []);

  const refreshCount = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.rpc('unread_notification_count');
    setUnread(Number(data ?? 0));
  }, []);

  const loadItems = useCallback(async () => {
    if (!supabase) return;
    const { data } = await supabase.from('notifications').select('id, title, body, link, created_at, read_at')
      .order('created_at', { ascending: false }).limit(30);
    setItems((data ?? []) as Item[]);
  }, []);

  useEffect(() => {
    refreshCount();
    const timer = setInterval(refreshCount, 60_000);
    return () => clearInterval(timer);
  }, [refreshCount]);

  useEffect(() => {
    if (!open) return;
    loadItems();
    refreshCount();
    const close = (e: MouseEvent) => { if (box.current && !box.current.contains(e.target as Node)) setOpen(false); };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open, loadItems, refreshCount]);

  const markRead = async (ids: string[] | null) => {
    if (!supabase) return;
    await supabase.rpc('mark_notifications_read', { p_ids: ids });
    await Promise.all([loadItems(), refreshCount()]);
  };

  const openItem = async (item: Item) => {
    if (!item.read_at) await markRead([item.id]);
    setOpen(false);
    if (item.link) onOpen?.(item.link);
  };

  const turnOnPush = async () => {
    const result = await enablePush();
    setPushState(result === 'enabled' ? 'Phone notifications are on.'
      : result === 'denied' ? 'Notifications are blocked in this browser’s settings.'
      : result === 'unsupported' ? 'This browser cannot show phone notifications. On iPhone, add Sahvaas to the Home Screen first.'
      : 'Phone notifications are not set up yet.');
  };

  const showPushButton = sync === 'offer';
  const iphoneHint = sync === 'unsupported' && typeof navigator !== 'undefined' && /iPhone|iPad/.test(navigator.userAgent);

  return (
    <div className="relative" ref={box}>
      <button onClick={() => setOpen(o => !o)} className="relative p-1.5 rounded-lg bg-surface-muted text-fg hover:text-fg cursor-pointer" title="Notifications">
        {unread > 0 ? <BellRing className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
        {unread > 0 && (
          <span className="absolute -top-1 -right-1 min-w-4 h-4 px-1 rounded-full bg-danger-solid text-on-brand text-xs font-semibold flex items-center justify-center">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
      {open && (
        <div className={`fixed inset-x-2 top-14 sm:absolute sm:inset-x-auto sm:top-auto sm:mt-2 sm:w-80 ${align === 'left' ? 'sm:left-0' : 'sm:right-0'} max-h-[70vh] overflow-y-auto rounded-xl bg-surface border border-border shadow-card z-40 text-xs`}>
          <div className="flex items-center justify-between p-3 border-b border-border">
            <span className="font-semibold text-fg">Notifications</span>
            {unread > 0 && (
              <button onClick={() => markRead(null)} className="flex items-center gap-1 text-brand hover:underline cursor-pointer">
                <CheckCheck className="w-3.5 h-3.5" /> Mark all read
              </button>
            )}
          </div>
          {items.length === 0 ? (
            <p className="p-4 text-fg-muted">Nothing new.</p>
          ) : (
            <ul className="divide-y divide-border">
              {items.map(item => (
                <li key={item.id}>
                  <button onClick={() => openItem(item)} className="w-full text-left p-3 hover:bg-surface-muted/60 cursor-pointer">
                    <div className={item.read_at ? 'text-fg' : 'text-fg font-semibold'}>{item.title}</div>
                    {item.body && <div className="text-fg-muted mt-0.5">{item.body}</div>}
                    <div className="text-fg-subtle mt-0.5">{ago(item.created_at)}</div>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {iphoneHint && !pushState && (
            <p className="p-3 border-t border-border text-fg-muted">To get notifications on iPhone, add Sahvaas to the Home Screen (Share → Add to Home Screen), then open it from there.</p>
          )}
          {(showPushButton || pushState) && (
            <div className="p-3 border-t border-border space-y-1">
              {showPushButton && !pushState && (
                <button onClick={turnOnPush} className="w-full py-2 rounded-lg bg-surface-muted hover:bg-border text-fg cursor-pointer">Turn on phone notifications</button>
              )}
              {pushState && <p className="text-fg-muted">{pushState}</p>}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
