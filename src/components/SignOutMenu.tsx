'use client';

import React, { useState } from 'react';
import { useAuth } from '../context/AuthContext';
import { LogOut, MonitorSmartphone } from 'lucide-react';

const confirmText = 'Log out of all devices? Every phone and computer signed in to this account will need to log in again.';

/** Lost phone (spec 8.1): ends every session of this account, on every device. */
export const LogoutEverywhereButton: React.FC<{ className?: string }> = ({ className }) => {
  const { logoutEverywhere } = useAuth();
  return (
    <button
      onClick={() => { if (window.confirm(confirmText)) logoutEverywhere(); }}
      className={className ?? 'w-full flex items-center justify-center gap-2 py-1.5 text-slate-500 hover:text-rose-400 text-[11px] cursor-pointer'}
    >
      <MonitorSmartphone className="w-3.5 h-3.5" /> <span>Log out of all devices</span>
    </button>
  );
};

/** The phone header's sign-out icon: Sign out here, or everywhere. */
export const SignOutMenu: React.FC = () => {
  const { logout } = useAuth();
  const [open, setOpen] = useState(false);
  return (
    <div className="relative">
      <button onClick={() => setOpen(o => !o)} className="p-2 rounded-xl bg-slate-800 text-slate-300 hover:text-rose-400 cursor-pointer" title="Sign Out" aria-expanded={open}>
        <LogOut className="w-4 h-4" />
      </button>
      {open && (
        <div className="absolute right-0 top-full mt-2 z-50 w-56 p-2 rounded-xl bg-slate-900 border border-slate-700 shadow-2xl text-xs space-y-1">
          <button onClick={() => logout()} className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-rose-400 cursor-pointer">
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
          <LogoutEverywhereButton className="w-full flex items-center gap-2 px-3 py-2 rounded-lg hover:bg-slate-800 text-slate-300 cursor-pointer" />
        </div>
      )}
    </div>
  );
};
