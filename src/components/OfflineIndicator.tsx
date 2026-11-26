'use client';

import React from 'react';
import { useOnlineStatus } from '../hooks/usePWAInstall';
import { WifiOff } from 'lucide-react';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div role="status" className="fixed bottom-[calc(5rem+env(safe-area-inset-bottom))] md:bottom-4 left-4 right-4 sm:right-auto sm:max-w-md z-50 flex items-center gap-2.5 rounded-xl bg-warning-soft text-warning px-4 py-3 text-[13px] font-medium shadow-pop border border-warning/20">
      <WifiOff className="w-4 h-4 shrink-0" aria-hidden="true" />
      <div>
        <span className="font-semibold">You are offline.</span> What you see may be out of date, and payments need the internet.
      </div>
    </div>
  );
};
