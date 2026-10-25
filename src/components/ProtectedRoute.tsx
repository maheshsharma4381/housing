'use client';

import React, { useEffect } from 'react';
import { useRouter } from '../router/RouterContext';
import { useAuth, COMMITTEE_ROLES } from '../context/AuthContext';
import { ShieldAlert, Loader2 } from 'lucide-react';
import { PendingInvites } from './PendingInvites';

type Portal = 'platform' | 'society' | 'professional' | 'resident';

interface ProtectedRouteProps {
  children: React.ReactNode;
  requiredPortal?: Portal;
}

const DENIED_COPY: Record<Portal, { title: string; description: string; tone: 'rose' | 'amber' }> = {
  platform: {
    title: 'Platform Owner Access Required',
    description: 'Your authenticated account is not authorized as a Platform Owner. Access is strictly controlled.',
    tone: 'rose',
  },
  society: {
    title: 'Committee Access Required',
    description: 'This workspace is for society committee members (Secretary, Chairman, Treasurer, Admin). If you are a member, please contact your society secretary for an invitation.',
    tone: 'amber',
  },
  resident: {
    title: 'No Society Membership Found',
    description: 'You do not have an active membership in any registered society. Please contact your society secretary for an invitation.',
    tone: 'amber',
  },
  professional: {
    title: 'No Active Society Grants',
    description: 'Professionals can only access society records after a society explicitly grants access. You currently have no active grants.',
    tone: 'amber',
  },
};

export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  requiredPortal
}) => {
  const {
    isAuthenticated,
    isLoading,
    isPlatformOwner,
    societyMemberships,
    professionalGrants,
    getRedirectPath,
    logout,
  } = useAuth();
  const { navigate, pathname } = useRouter();

  useEffect(() => {
    if (!isLoading && !isAuthenticated) {
      navigate(`/login?returnUrl=${encodeURIComponent(pathname)}`, { replace: true });
    }
  }, [isLoading, isAuthenticated, navigate, pathname]);

  if (isLoading) {
    return (
      <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 text-slate-300">
        <Loader2 className="w-8 h-8 animate-spin text-sky-500 mb-3" />
        <p className="text-xs font-medium">Verifying Supabase authentication & permissions...</p>
      </div>
    );
  }

  if (!isAuthenticated) {
    return null; // Navigation will trigger
  }

  const isAllowed = (() => {
    if (!requiredPortal || isPlatformOwner) return true;
    switch (requiredPortal) {
      case 'platform':
        return false;
      case 'society':
        return societyMemberships.some(m => COMMITTEE_ROLES.includes(m.role));
      case 'resident':
        return societyMemberships.length > 0;
      case 'professional':
        return professionalGrants.length > 0;
    }
  })();

  if (isAllowed) {
    return (
      <>
        <PendingInvites />
        {children}
      </>
    );
  }

  const copy = DENIED_COPY[requiredPortal!];
  const fallbackPath = getRedirectPath();
  // Avoid a redirect loop when the user's default workspace is this same portal
  const canRedirect = !fallbackPath.startsWith(`/${requiredPortal}`);
  const toneClasses = copy.tone === 'rose' ? 'bg-rose-500/20 text-rose-400' : 'bg-amber-500/20 text-amber-400';

  return (
    <div className="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-4 gap-4">
      <div className="w-full"><PendingInvites /></div>
      <div className="max-w-md w-full bg-slate-900 border border-slate-800 rounded-2xl p-6 text-center space-y-4">
        <div className={`w-12 h-12 rounded-2xl mx-auto flex items-center justify-center ${toneClasses}`}>
          <ShieldAlert className="w-6 h-6" />
        </div>
        <h2 className="text-base font-bold text-white">{copy.title}</h2>
        <p className="text-xs text-slate-400">{copy.description}</p>
        {canRedirect ? (
          <button
            onClick={() => navigate(fallbackPath, { replace: true })}
            className="w-full py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white text-xs font-semibold cursor-pointer"
          >
            Return to My Workspace
          </button>
        ) : (
          <button
            onClick={async () => {
              await logout();
              navigate('/', { replace: true });
            }}
            className="w-full py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-xs font-semibold cursor-pointer"
          >
            Sign Out
          </button>
        )}
      </div>
    </div>
  );
};
