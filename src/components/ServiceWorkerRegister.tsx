'use client';

import { useEffect } from 'react';
import { installStore } from '../lib/install-prompt';

/**
 * Registers /sw.js for every visitor (Phase 7), so the installed app shows an offline page instead of the
 * browser's error. Push (push-client.ts) registers the same file and scope, so the two never clash.
 */
export const ServiceWorkerRegister: React.FC = () => {
  useEffect(() => {
    // catch Android's one-time install prompt now, before any dashboard (and its Install button) has mounted
    installStore();
    if (process.env.NODE_ENV !== 'production' || typeof navigator === 'undefined' || !('serviceWorker' in navigator)) return;
    navigator.serviceWorker.register('/sw.js').catch(() => { /* the app works without it */ });
  }, []);
  return null;
};
