'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { Banner } from './Banner';
import { Building2, Loader2 } from 'lucide-react';

const FIELDS = [
  { key: 'registration_number', label: 'Registration number' },
  { key: 'address_line1', label: 'Address' },
  { key: 'address_line2', label: 'Address line 2' },
  { key: 'contact_email', label: 'Society email' },
  { key: 'contact_phone', label: 'Society phone' },
] as const;
type Key = (typeof FIELDS)[number]['key'];

/** The details setup leaves for later (spec 9.1): printed in the header of bills and receipts. */
export const SocietyProfile: React.FC<{ societyId: string }> = ({ societyId }) => {
  const [form, setForm] = useState<Record<Key, string>>({ registration_number: '', address_line1: '', address_line2: '', contact_email: '', contact_phone: '' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    supabase?.from('societies').select('registration_number, address_line1, address_line2, contact_email, contact_phone').eq('id', societyId).maybeSingle()
      .then(({ data }) => {
        if (data) setForm(Object.fromEntries(FIELDS.map(f => [f.key, (data as Record<string, string | null>)[f.key] ?? ''])) as Record<Key, string>);
      });
  }, [societyId]);

  const save = async () => {
    if (!supabase) return;
    const email = form.contact_email.trim();
    if (email && !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return setError('Enter a valid email');
    setBusy(true);
    setError(null);
    const { error: err } = await supabase.from('societies').update({
      registration_number: form.registration_number.trim() || null,
      address_line1: form.address_line1.trim(),
      address_line2: form.address_line2.trim() || null,
      contact_email: email.toLowerCase(),
      contact_phone: form.contact_phone.trim(),
    }).eq('id', societyId);
    setBusy(false);
    if (err) return setError(err.message);
    setNotice('Society profile saved. It appears on bills and receipts.');
  };

  return (
    <section className="p-5 rounded-xl bg-surface border border-border space-y-3 text-xs">
      <div className="font-semibold text-fg text-sm flex items-center gap-2"><Building2 className="w-4 h-4 text-brand" /> Society profile</div>
      <p className="text-fg-muted">Printed at the top of every bill and receipt.</p>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {FIELDS.map(f => (
          <label key={f.key} className={`space-y-1 ${f.key === 'address_line1' ? 'sm:col-span-2' : ''}`}>
            <span className="text-fg-muted">{f.label}</span>
            <input className="w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand"
              value={form[f.key]} onChange={e => setForm({ ...form, [f.key]: e.target.value })} />
          </label>
        ))}
      </div>
      <button onClick={save} disabled={busy} className="px-4 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer disabled:opacity-50 flex items-center gap-1.5">
        {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />} Save profile
      </button>
    </section>
  );
};
