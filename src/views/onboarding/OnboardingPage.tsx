'use client';

import React, { useState } from 'react';
import { useRouter } from '../../router/RouterContext';
import { useAuth } from '../../context/AuthContext';
import { supabase } from '../../lib/supabase/client';
import { Building2, AlertCircle, Loader2, ArrowRight, LogOut, MailCheck } from 'lucide-react';

const CREATOR_ROLES = [
  { value: 'secretary', label: 'Secretary' },
  { value: 'chairman', label: 'Chairman' },
  { value: 'treasurer', label: 'Treasurer' },
  { value: 'society_admin', label: 'Society Manager / Admin' },
] as const;

const INDIAN_STATES = [
  'Andhra Pradesh', 'Assam', 'Bihar', 'Chhattisgarh', 'Delhi', 'Goa', 'Gujarat', 'Haryana',
  'Himachal Pradesh', 'Jharkhand', 'Karnataka', 'Kerala', 'Madhya Pradesh', 'Maharashtra',
  'Odisha', 'Punjab', 'Rajasthan', 'Tamil Nadu', 'Telangana', 'Uttar Pradesh', 'Uttarakhand',
  'West Bengal', 'Other',
];

interface FormState {
  name: string;
  registrationNumber: string;
  addressLine1: string;
  addressLine2: string;
  city: string;
  state: string;
  pincode: string;
  contactEmail: string;
  contactPhone: string;
  creatorRole: (typeof CREATOR_ROLES)[number]['value'];
}

export const OnboardingPage: React.FC = () => {
  const { profile, societyMemberships, refreshUserData, logout } = useAuth();
  const { navigate } = useRouter();

  const [form, setForm] = useState<FormState>({
    name: '',
    registrationNumber: '',
    addressLine1: '',
    addressLine2: '',
    city: '',
    state: 'Maharashtra',
    pincode: '',
    contactEmail: profile?.email ?? '',
    contactPhone: '',
    creatorRole: 'secretary',
  });
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const set = <K extends keyof FormState>(key: K, value: FormState[K]) => setForm(f => ({ ...f, [key]: value }));

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!supabase) return;
    setError(null);

    if (!/^\d{6}$/.test(form.pincode)) {
      setError('Pincode must be 6 digits.');
      return;
    }

    setSubmitting(true);
    const { data, error: rpcError } = await supabase.rpc('create_society', {
      p_name: form.name,
      p_address_line1: form.addressLine1,
      p_city: form.city,
      p_state: form.state,
      p_pincode: form.pincode,
      p_contact_email: form.contactEmail || profile?.email || '',
      p_contact_phone: form.contactPhone,
      p_registration_number: form.registrationNumber || null,
      p_address_line2: form.addressLine2 || null,
      p_creator_role: form.creatorRole,
    });

    if (rpcError) {
      setSubmitting(false);
      setError(rpcError.message);
      return;
    }

    await refreshUserData(data as string);
    setSubmitting(false);
    navigate('/society', { replace: true });
  };

  const inputClass = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-white outline-none focus:border-sky-500';

  return (
    <div className="min-h-screen bg-slate-950 text-slate-100 py-10 px-4">
      <div className="max-w-2xl mx-auto space-y-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <span className="text-[11px] font-bold uppercase tracking-wider text-sky-400">Step 1 of 3</span>
            <h1 className="text-2xl font-bold text-white tracking-tight">Register Your Society</h1>
            <p className="text-xs text-slate-400">
              Takes 2 minutes. Next you&apos;ll add flats and invite members. 30-day free trial, no card required.
            </p>
          </div>
          <button
            onClick={() => logout()}
            className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-slate-900 border border-slate-800 text-xs text-slate-300 hover:text-rose-400 cursor-pointer"
          >
            <LogOut className="w-3.5 h-3.5" />
            <span>Sign Out</span>
          </button>
        </div>

        {societyMemberships.length === 0 && (
          <div className="p-4 rounded-2xl bg-slate-900 border border-slate-800 text-xs text-slate-300 flex items-start gap-3">
            <MailCheck className="w-5 h-5 text-emerald-400 shrink-0" />
            <div>
              <div className="font-semibold text-white">Are you a resident?</div>
              <p className="text-slate-400 mt-0.5">
                You don&apos;t need to register. Ask your secretary to invite <strong className="text-slate-200">{profile?.email}</strong> —
                the invitation appears at the top of this page — tap Accept.
              </p>
            </div>
          </div>
        )}

        <form onSubmit={handleSubmit} className="p-6 sm:p-8 rounded-3xl bg-slate-900 border border-slate-800 space-y-5 text-xs">
          <div className="flex items-center gap-2 text-sm font-bold text-white">
            <Building2 className="w-4 h-4 text-sky-400" />
            <span>Society Details</span>
          </div>

          {error && (
            <div className="p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300 flex items-start gap-2">
              <AlertCircle className="w-4 h-4 text-rose-400 shrink-0 mt-0.5" />
              <span>{error}</span>
            </div>
          )}

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <label className="sm:col-span-2 space-y-1">
              <span className="block text-slate-400 font-medium">Society Name *</span>
              <input required minLength={3} value={form.name} onChange={e => set('name', e.target.value)} placeholder="e.g. Palm Heights Co-op Housing Society" className={inputClass} />
            </label>

            <label className="space-y-1">
              <span className="block text-slate-400 font-medium">Registration Number</span>
              <input value={form.registrationNumber} onChange={e => set('registrationNumber', e.target.value)} placeholder="e.g. TNA/HSG/1234/2010" className={inputClass} />
            </label>

            <label className="space-y-1">
              <span className="block text-slate-400 font-medium">Your Role *</span>
              <select value={form.creatorRole} onChange={e => set('creatorRole', e.target.value as FormState['creatorRole'])} className={inputClass}>
                {CREATOR_ROLES.map(r => <option key={r.value} value={r.value}>{r.label}</option>)}
              </select>
            </label>

            <label className="sm:col-span-2 space-y-1">
              <span className="block text-slate-400 font-medium">Address Line 1 *</span>
              <input required value={form.addressLine1} onChange={e => set('addressLine1', e.target.value)} placeholder="Plot / Sector / Road" className={inputClass} />
            </label>

            <label className="sm:col-span-2 space-y-1">
              <span className="block text-slate-400 font-medium">Address Line 2</span>
              <input value={form.addressLine2} onChange={e => set('addressLine2', e.target.value)} placeholder="Landmark / Area" className={inputClass} />
            </label>

            <label className="space-y-1">
              <span className="block text-slate-400 font-medium">City *</span>
              <input required value={form.city} onChange={e => set('city', e.target.value)} placeholder="e.g. Navi Mumbai" className={inputClass} />
            </label>

            <label className="space-y-1">
              <span className="block text-slate-400 font-medium">State *</span>
              <select value={form.state} onChange={e => set('state', e.target.value)} className={inputClass}>
                {INDIAN_STATES.map(s => <option key={s} value={s}>{s}</option>)}
              </select>
            </label>

            <label className="space-y-1">
              <span className="block text-slate-400 font-medium">Pincode *</span>
              <input required inputMode="numeric" maxLength={6} value={form.pincode} onChange={e => set('pincode', e.target.value.replace(/\D/g, ''))} placeholder="400706" className={inputClass} />
            </label>

            <label className="space-y-1">
              <span className="block text-slate-400 font-medium">Office Phone *</span>
              <input required type="tel" value={form.contactPhone} onChange={e => set('contactPhone', e.target.value)} placeholder="+91 98200 00000" className={inputClass} />
            </label>

            <label className="sm:col-span-2 space-y-1">
              <span className="block text-slate-400 font-medium">Society Contact Email *</span>
              <input required type="email" value={form.contactEmail} onChange={e => set('contactEmail', e.target.value)} placeholder="secretary@palmheights.in" className={inputClass} />
            </label>
          </div>

          <button
            type="submit"
            disabled={submitting}
            className="w-full py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold flex items-center justify-center gap-2 shadow-lg shadow-sky-600/30 transition cursor-pointer disabled:opacity-50"
          >
            {submitting ? (
              <>
                <Loader2 className="w-4 h-4 animate-spin" />
                <span>Creating Society...</span>
              </>
            ) : (
              <>
                <span>Create Society & Continue</span>
                <ArrowRight className="w-4 h-4" />
              </>
            )}
          </button>
        </form>
      </div>
    </div>
  );
};
