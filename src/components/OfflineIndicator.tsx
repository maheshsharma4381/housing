'use client';

import React from 'react';
import { useOnlineStatus } from '../hooks/usePWAInstall';
import { WifiOff } from 'lucide-react';

export const OfflineIndicator: React.FC = () => {
  const isOnline = useOnlineStatus();

  if (isOnline) return null;

  return (
    <div className="fixed bottom-4 left-4 right-4 sm:right-auto sm:max-w-md z-50 flex items-center gap-2.5 rounded-xl bg-amber-500/95 text-white px-4 py-2.5 text-xs font-medium shadow-xl backdrop-blur-xs border border-amber-400">
      <WifiOff className="w-4 h-4 shrink-0 animate-pulse text-white" />
      <div>
        <span className="font-semibold">You are offline.</span> What you see may be out of date, and payments need the internet.
      </div>
    </div>
  );
};
