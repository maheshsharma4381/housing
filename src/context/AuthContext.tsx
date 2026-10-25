'use client';

import React, { createContext, useContext, useState, useEffect, useCallback, useRef } from 'react';
import { User, Session } from '@supabase/supabase-js';
import { supabase, isSupabaseConfigured } from '../lib/supabase/client';
import { 
  Profile, 
  Society, 
  SocietyMembership, 
  SocietyProfessionalAccess, 
  SocietyRole, 
  ProfessionalRole 
} from '../types/database';

export interface SocietyMembershipWithDetails extends SocietyMembership {
  society: Society;
}

export interface ProfessionalGrantWithDetails extends SocietyProfessionalAccess {
  society: Society;
}

/** Row returned by my_pending_invites() (012) */
export interface PendingInvite {
  kind: 'member' | 'professional';
  id: string;
  society_name: string;
  society_city: string | null;
  role: string;
  flat: string | null;
  permissions: string[] | null;
  invited_by_name: string | null;
  invited_at: string;
  expires_at: string | null;
}

export interface AuthContextType {
  // Supabase Auth
  user: User | null;
  session: Session | null;
  profile: Profile | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  authError: string | null;
  isSupabaseConfigured: boolean;

  // Multi-Tenant Hierarchy (Verified from Supabase DB)
  isPlatformOwner: boolean;
  societyMemberships: SocietyMembershipWithDetails[];
  professionalGrants: ProfessionalGrantWithDetails[];
  activeSociety: Society | null;
  activeMembership: SocietyMembership | null;
  activeProfessionalGrant: SocietyProfessionalAccess | null;
  effectiveRole: SocietyRole | ProfessionalRole | 'super_admin' | 'none';

  // Actions
  login: (email: string, password: string) => Promise<{ error: Error | null; redirectPath?: string }>;
  signUp: (email: string, password: string, fullName: string) => Promise<{ error: Error | null; message?: string }>;
  forgotPassword: (email: string) => Promise<{ error: Error | null; message?: string }>;
  resetPassword: (newPassword: string) => Promise<{ error: Error | null }>;
  logout: () => Promise<void>;
  selectSociety: (societyId: string) => void;
  clearAuthError: () => void;
  refreshUserData: (preferSocietyId?: string) => Promise<void>;
  pendingInvites: PendingInvite[];
  respondToInvite: (invite: PendingInvite, accept: boolean) => Promise<{ error: string | null }>;
  getRedirectPath: () => string;
}

const AuthContext = createContext<AuthContextType | undefined>(undefined);

export const COMMITTEE_ROLES: SocietyRole[] = ['society_admin', 'secretary', 'chairman', 'treasurer', 'committee_member'];

type MembershipRow = SocietyMembership & { societies: Society | null };
type GrantRow = SocietyProfessionalAccess & { societies: Society | null };

interface LoadedAuthorizations {
  isOwner: boolean;
  memberships: SocietyMembershipWithDetails[];
  grants: ProfessionalGrantWithDetails[];
}

// Remember the last workspace per user (convenience only; authorization is re-checked on load)
const savedSocietyKey = (userId: string) => `sahvaas.activeSociety.${userId}`;
function readSavedSociety(userId: string): string | undefined {
  try {
    return window.localStorage.getItem(savedSocietyKey(userId)) ?? undefined;
  } catch {
    return undefined;
  }
}
function saveSociety(userId: string, societyId: string) {
  try {
    window.localStorage.setItem(savedSocietyKey(userId), societyId);
  } catch {
    // storage unavailable (private mode) — ignore
  }
}

/**
 * Determine redirect destination based on user's verified roles
 */
function computeRedirectPath({ isOwner, memberships, grants }: LoadedAuthorizations): string {
  if (isOwner) {
    return '/platform';
  }

  if (memberships.length > 0) {
    return memberships.some(m => COMMITTEE_ROLES.includes(m.role)) ? '/society' : '/resident';
  }

  if (grants.length > 0) {
    return '/professional';
  }

  // Authenticated but not yet attached to any society: register one
  return '/onboarding';
}

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [user, setUser] = useState<User | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [profile, setProfile] = useState<Profile | null>(null);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [authError, setAuthError] = useState<string | null>(null);

  // Authorizations
  const [isPlatformOwner, setIsPlatformOwner] = useState<boolean>(false);
  const [societyMemberships, setSocietyMemberships] = useState<SocietyMembershipWithDetails[]>([]);
  const [professionalGrants, setProfessionalGrants] = useState<ProfessionalGrantWithDetails[]>([]);
  const [activeSociety, setActiveSociety] = useState<Society | null>(null);
  const [pendingInvites, setPendingInvites] = useState<PendingInvite[]>([]);

  // Refs let the auth listener read current values without re-subscribing
  const loadedUserIdRef = useRef<string | null>(null);
  const activeSocietyIdRef = useRef<string | null>(null);
  useEffect(() => {
    activeSocietyIdRef.current = activeSociety?.id ?? null;
    if (activeSociety && loadedUserIdRef.current) saveSociety(loadedUserIdRef.current, activeSociety.id);
  }, [activeSociety]);

  const clearAuthError = useCallback(() => {
    setAuthError(null);
  }, []);

  /**
   * Fetch user's profile, platform status, memberships and professional grants
   * directly from Supabase tables with strict RLS enforcement.
   * Returns the freshly loaded values so callers don't depend on async state updates.
   */
  const loadUserAuthorizations = useCallback(async (sbUser: User, preferSocietyId?: string): Promise<LoadedAuthorizations> => {
    const empty: LoadedAuthorizations = { isOwner: false, memberships: [], grants: [] };
    if (!supabase) return empty;
    loadedUserIdRef.current = sbUser.id;

    try {
      // 0. Invitations wait for an explicit Accept / Decline (never auto-joined)
      const { data: invitesData, error: invitesErr } = await supabase.rpc('my_pending_invites');
      if (invitesErr) console.warn('Pending invites warning:', invitesErr.message);
      setPendingInvites((invitesData ?? []) as PendingInvite[]);

      // 1. Fetch Profile
      const { data: profileData, error: profileErr } = await supabase
        .from('profiles')
        .select('*')
        .eq('id', sbUser.id)
        .maybeSingle();

      if (profileErr) {
        console.warn('Profile fetch warning:', profileErr.message);
      }

      const userProfile: Profile = profileData || {
        id: sbUser.id,
        full_name: sbUser.user_metadata?.full_name || sbUser.email?.split('@')[0] || 'User',
        email: sbUser.email || '',
        phone: sbUser.phone || '',
        is_platform_admin: false,
        created_at: sbUser.created_at || new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      setProfile(userProfile);

      // 2. Check Platform Owner status from platform_admins
      const { data: platformAdminData } = await supabase
        .from('platform_admins')
        .select('id, is_active')
        .eq('user_id', sbUser.id)
        .eq('is_active', true)
        .maybeSingle();

      const isOwner = Boolean(platformAdminData || userProfile.is_platform_admin);
      setIsPlatformOwner(isOwner);

      // 3. Fetch Society Memberships (with joined societies table)
      const { data: membershipsData } = await supabase
        .from('society_memberships')
        .select(`
          id, society_id, user_id, role, unit_id, is_primary_contact, is_active, joined_date, created_at, updated_at,
          societies:society_id (*)
        `)
        .eq('user_id', sbUser.id)
        .eq('is_active', true);

      const typedMemberships: SocietyMembershipWithDetails[] = ((membershipsData || []) as unknown as MembershipRow[])
        .map((m) => ({
          id: m.id,
          society_id: m.society_id,
          user_id: m.user_id,
          role: m.role,
          unit_id: m.unit_id,
          is_primary_contact: m.is_primary_contact,
          is_active: m.is_active,
          joined_date: m.joined_date,
          created_at: m.created_at,
          updated_at: m.updated_at,
          society: m.societies as Society,
        }))
        .filter(m => m.society && m.society.is_active);

      setSocietyMemberships(typedMemberships);

      // 4. Fetch Professional Grants
      const { data: grantsData } = await supabase
        .from('society_professional_access')
        .select(`
          id, society_id, professional_user_id, role, status, permissions, granted_by, granted_at, expires_at,
          societies:society_id (*)
        `)
        .eq('professional_user_id', sbUser.id)
        .eq('status', 'active');

      const now = Date.now();
      const typedGrants: ProfessionalGrantWithDetails[] = ((grantsData || []) as unknown as GrantRow[])
        .filter((g) => !g.expires_at || new Date(g.expires_at).getTime() > now)
        .map((g) => ({
          id: g.id,
          society_id: g.society_id,
          professional_user_id: g.professional_user_id,
          role: g.role,
          status: g.status,
          permissions: Array.isArray(g.permissions) ? g.permissions : [],
          granted_by: g.granted_by,
          granted_at: g.granted_at,
          expires_at: g.expires_at,
          society: g.societies as Society,
        }))
        .filter(g => g.society && g.society.is_active);

      setProfessionalGrants(typedGrants);

      // 5. Set Active Society: keep the preferred one if still authorized, else first available
      const authorizedSocieties = [
        ...typedMemberships.map(m => m.society),
        ...typedGrants.map(g => g.society),
      ];
      const preferred = preferSocietyId
        ? authorizedSocieties.find(s => s.id === preferSocietyId)
        : undefined;
      setActiveSociety(preferred ?? authorizedSocieties[0] ?? null);

      return { isOwner, memberships: typedMemberships, grants: typedGrants };
    } catch (err: unknown) {
      console.error('Error loading user authorizations:', err);
      return empty;
    }
  }, []);

  const refreshUserData = useCallback(async (preferSocietyId?: string) => {
    if (user) {
      await loadUserAuthorizations(user, preferSocietyId ?? activeSociety?.id);
    }
  }, [user, activeSociety?.id, loadUserAuthorizations]);

  // Accept switches straight into the new society; decline just removes the invite
  const respondToInvite = useCallback(async (invite: PendingInvite, accept: boolean) => {
    if (!supabase || !user) return { error: 'Not signed in' };
    const { data, error } = await supabase.rpc('respond_to_invite', {
      p_kind: invite.kind,
      p_invite_id: invite.id,
      p_accept: accept,
    });
    if (error) return { error: error.message };
    const societyId = (data as { society_id?: string } | null)?.society_id;
    await loadUserAuthorizations(user, accept ? societyId : activeSociety?.id);
    return { error: null };
  }, [user, activeSociety?.id, loadUserAuthorizations]);

  // Session Initialization & Supabase Auth Listener
  useEffect(() => {
    let isMounted = true;

    async function initSession() {
      setIsLoading(true);

      if (!isSupabaseConfigured || !supabase) {
        setIsLoading(false);
        return;
      }

      try {
        const { data: { session: existingSession }, error } = await supabase.auth.getSession();
        if (error) throw error;

        if (isMounted) {
          setSession(existingSession);
          setUser(existingSession?.user || null);
          if (existingSession?.user) {
            await loadUserAuthorizations(existingSession.user, readSavedSociety(existingSession.user.id));
          }
        }
      } catch (err: unknown) {
        if (isMounted) {
          const msg = err instanceof Error ? err.message : String(err);
          setAuthError(msg);
        }
      } finally {
        if (isMounted) {
          setIsLoading(false);
        }
      }
    }

    initSession();

    let authSub: { unsubscribe: () => void } | null = null;
    if (isSupabaseConfigured && supabase) {
      // Keep this callback synchronous: awaiting other Supabase calls inside it can
      // dead-lock supabase-js (documented). Data loading is dispatched afterwards.
      const { data } = supabase.auth.onAuthStateChange((event, newSession) => {
        if (!isMounted) return;
        setSession(newSession);
        setUser(newSession?.user || null);

        if (event === 'SIGNED_OUT' || !newSession?.user) {
          loadedUserIdRef.current = null;
          setProfile(null);
          setIsPlatformOwner(false);
          setSocietyMemberships([]);
          setProfessionalGrants([]);
          setActiveSociety(null);
          setPendingInvites([]);
          setIsLoading(false);
          return;
        }

        // INITIAL_SESSION is handled by initSession(); TOKEN_REFRESHED (hourly) needs no reload.
        const sbUser = newSession.user;
        const needsLoad = event === 'USER_UPDATED' || (event === 'SIGNED_IN' && loadedUserIdRef.current !== sbUser.id);
        if (needsLoad) {
          setTimeout(() => {
            if (!isMounted) return;
            loadUserAuthorizations(sbUser, activeSocietyIdRef.current ?? undefined).finally(() => {
              if (isMounted) setIsLoading(false);
            });
          }, 0);
        }
      });
      authSub = data.subscription;
    }

    return () => {
      isMounted = false;
      if (authSub) authSub.unsubscribe();
    };
  }, [loadUserAuthorizations]);

  // Action: Login via Supabase
  const login = async (email: string, password: string): Promise<{ error: Error | null; redirectPath?: string }> => {
    setIsLoading(true);
    setAuthError(null);

    if (!isSupabaseConfigured || !supabase) {
      const err = new Error('Supabase client is not configured. Please ensure NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY are set.');
      setAuthError(err.message);
      setIsLoading(false);
      return { error: err };
    }

    try {
      const { data, error } = await supabase.auth.signInWithPassword({
        email: email.trim(),
        password,
      });

      if (error) {
        setAuthError(error.message);
        setIsLoading(false);
        return { error };
      }

      setUser(data.user);
      setSession(data.session);

      const loaded = data.user
        ? await loadUserAuthorizations(data.user)
        : { isOwner: false, memberships: [], grants: [] };

      setIsLoading(false);
      return { error: null, redirectPath: computeRedirectPath(loaded) };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      setAuthError(error.message);
      setIsLoading(false);
      return { error };
    }
  };

  // Action: Sign Up via Supabase
  const signUp = async (email: string, password: string, fullName: string): Promise<{ error: Error | null; message?: string }> => {
    setIsLoading(true);
    setAuthError(null);

    if (!isSupabaseConfigured || !supabase) {
      const err = new Error('Supabase is not configured. Please supply valid project credentials.');
      setAuthError(err.message);
      setIsLoading(false);
      return { error: err };
    }

    try {
      const { data, error } = await supabase.auth.signUp({
        email: email.trim(),
        password,
        options: {
          data: {
            full_name: fullName.trim(),
          },
          emailRedirectTo: typeof window !== 'undefined' ? `${window.location.origin}/login` : undefined,
        },
      });

      if (error) {
        setAuthError(error.message);
        setIsLoading(false);
        return { error };
      }

      setIsLoading(false);
      if (data.session) {
        setUser(data.user);
        setSession(data.session);
        if (data.user) await loadUserAuthorizations(data.user);
        return { error: null, message: 'Account created and signed in successfully.' };
      }

      return { 
        error: null, 
        message: 'Account registered. Please verify your email address to complete registration.' 
      };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      setAuthError(error.message);
      setIsLoading(false);
      return { error };
    }
  };

  // Action: Forgot Password via Supabase
  const forgotPassword = async (email: string): Promise<{ error: Error | null; message?: string }> => {
    setIsLoading(true);
    setAuthError(null);

    if (!isSupabaseConfigured || !supabase) {
      const err = new Error('Supabase client is not configured.');
      setAuthError(err.message);
      setIsLoading(false);
      return { error: err };
    }

    try {
      const redirectUrl = typeof window !== 'undefined' ? `${window.location.origin}/reset-password` : '';
      const { error } = await supabase.auth.resetPasswordForEmail(email.trim(), {
        redirectTo: redirectUrl,
      });

      if (error) {
        setAuthError(error.message);
        setIsLoading(false);
        return { error };
      }

      setIsLoading(false);
      return { error: null, message: 'Password reset link sent to your email.' };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      setAuthError(error.message);
      setIsLoading(false);
      return { error };
    }
  };

  // Action: Reset Password (after link click)
  const resetPassword = async (newPassword: string): Promise<{ error: Error | null }> => {
    setIsLoading(true);
    setAuthError(null);

    if (!isSupabaseConfigured || !supabase) {
      const err = new Error('Supabase client is not configured.');
      setAuthError(err.message);
      setIsLoading(false);
      return { error: err };
    }

    try {
      const { error } = await supabase.auth.updateUser({
        password: newPassword,
      });

      if (error) {
        setAuthError(error.message);
        setIsLoading(false);
        return { error };
      }

      setIsLoading(false);
      return { error: null };
    } catch (err: unknown) {
      const error = err instanceof Error ? err : new Error(String(err));
      setAuthError(error.message);
      setIsLoading(false);
      return { error };
    }
  };

  // Action: Logout
  const logout = async (): Promise<void> => {
    setIsLoading(true);
    if (isSupabaseConfigured && supabase) {
      try {
        await supabase.auth.signOut();
      } catch (err) {
        console.warn('Supabase sign out error:', err);
      }
    }

    setUser(null);
    setSession(null);
    setProfile(null);
    setIsPlatformOwner(false);
    setSocietyMemberships([]);
    setProfessionalGrants([]);
    setActiveSociety(null);
          setPendingInvites([]);
    setAuthError(null);
    setIsLoading(false);
  };

  // Action: Select Active Society (Strictly verified against authorized memberships/grants)
  const selectSociety = (societyId: string) => {
    const matchedMembership = societyMemberships.find(m => m.society_id === societyId);
    if (matchedMembership) {
      setActiveSociety(matchedMembership.society);
      return;
    }

    const matchedGrant = professionalGrants.find(g => g.society_id === societyId);
    if (matchedGrant) {
      setActiveSociety(matchedGrant.society);
      return;
    }

    console.warn(`Unauthorized attempt to switch to society ID ${societyId}. Access denied.`);
  };

  // Derived effective membership & role
  const activeMembership = societyMemberships.find(
    m => activeSociety && m.society_id === activeSociety.id
  ) || null;

  const activeProfessionalGrant = professionalGrants.find(
    g => activeSociety && g.society_id === activeSociety.id
  ) || null;

  const effectiveRole: SocietyRole | ProfessionalRole | 'super_admin' | 'none' = (() => {
    if (isPlatformOwner) return 'super_admin';
    if (activeMembership) return activeMembership.role;
    if (activeProfessionalGrant) return activeProfessionalGrant.role;
    return 'none';
  })();

  const getRedirectPath = () => {
    return computeRedirectPath({
      isOwner: isPlatformOwner,
      memberships: societyMemberships,
      grants: professionalGrants,
    });
  };

  return (
    <AuthContext.Provider
      value={{
        user,
        session,
        profile,
        isAuthenticated: Boolean(user),
        isLoading,
        authError,
        isSupabaseConfigured,
        isPlatformOwner,
        societyMemberships,
        professionalGrants,
        activeSociety,
        activeMembership,
        activeProfessionalGrant,
        effectiveRole,
        login,
        signUp,
        forgotPassword,
        resetPassword,
        logout,
        selectSociety,
        clearAuthError,
        refreshUserData,
        pendingInvites,
        respondToInvite,
        getRedirectPath,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth() {
  const context = useContext(AuthContext);
  if (!context) {
    throw new Error('useAuth must be used within an AuthProvider');
  }
  return context;
}
