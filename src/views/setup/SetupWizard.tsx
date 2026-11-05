'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '../../context/AuthContext';
import { useRouter } from '../../router/RouterContext';
import { supabase } from '../../lib/supabase/client';
import { generateFlats } from '../../lib/flat-generator';
import { nextSetupStep, firstBillDates, isValidUpiId, type SetupStatus, type SetupStep } from '../../lib/setup';
import { normalizeMobile } from '../../lib/mobile';
import { formatINR } from '../../lib/inr';
import { Banner } from '../../components/Banner';
import { OwnerPaste } from '../../components/OwnerContacts';
import { JoinLinkCard } from '../../components/JoinLinkCard';
import { Loader2, Plus, X, CheckCircle2 } from 'lucide-react';

// Spec 9.1: Society → Flats → Maintenance → UPI → Owners → Done (the login is step 1).
const STEPS: { id: SetupStep; label: string }[] = [
  { id: 'society', label: 'Society' }, { id: 'flats', label: 'Flats' }, { id: 'maintenance', label: 'Maintenance' },
  { id: 'upi', label: 'UPI' }, { id: 'owners', label: 'Owners' }, { id: 'done', label: 'Done' },
];
const ADMIN_ROLES = ['secretary', 'chairman', 'treasurer', 'society_admin'];
const ROLES = [
  { value: 'secretary', label: 'Secretary' }, { value: 'chairman', label: 'Chairman' },
  { value: 'treasurer', label: 'Treasurer' }, { value: 'society_admin', label: 'Manager' },
];

const input = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-white outline-none focus:border-sky-500';
const primary = 'px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2';
const secondary = 'px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold cursor-pointer';
const fmt = (iso: string) => new Date(`${iso}T00:00:00`).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' });

/** `startNew`: register another society even though this login already runs one. */
export const SetupWizard: React.FC<{ startNew?: boolean }> = ({ startNew = false }) => {
  const { profile, user, societyMemberships, activeSociety, refreshUserData } = useAuth();
  const { navigate } = useRouter();
  const [creating, setCreating] = useState(startNew);
  // The society being set up: the one open in the app, else any the user runs
  const membership = creating ? undefined
    : societyMemberships.find(m => m.society_id === activeSociety?.id && ADMIN_ROLES.includes(m.role))
      ?? societyMemberships.find(m => ADMIN_ROLES.includes(m.role));
  const societyId = membership?.society_id ?? null;
  const [status, setStatus] = useState<SetupStatus | null>(null);
  const [step, setStep] = useState<SetupStep>('society');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => setCreating(startNew), [startNew]);

  const loadStatus = useCallback(async (pickStep: boolean) => {
    if (!supabase || !societyId) return;
    const { data, error: err } = await supabase.rpc('setup_status', { p_society_id: societyId });
    if (err) return setError(err.message);
    const s = data as SetupStatus;
    setStatus(s);
    if (pickStep) setStep(nextSetupStep(s));
  }, [societyId]);

  useEffect(() => {
    if (societyId) loadStatus(true);
    else setStep('society');
  }, [loadStatus, societyId]);

  const record = async (s: string) => {
    if (supabase && societyId) await supabase.rpc('record_setup_step', { p_society_id: societyId, p_step: s });
  };
  const run = async (fn: () => Promise<string | null>, next: SetupStep) => {
    setBusy(true);
    setError(null);
    const problem = await fn();
    setBusy(false);
    if (problem) return setError(problem);
    await loadStatus(false);
    setStep(next);
  };

  const current = STEPS.findIndex(s => s.id === step);

  return (
    <div className="space-y-5 text-xs">
      <ol className="flex flex-wrap gap-1.5">
        {STEPS.map((s, i) => (
          <li key={s.id} className={`px-2.5 py-1 rounded-full font-semibold ${i === current ? 'bg-sky-600 text-white' : i < current ? 'bg-emerald-500/15 text-emerald-300' : 'bg-slate-800 text-slate-400'}`}>
            {i + 2}. {s.label}
          </li>
        ))}
      </ol>
      <Banner tone="error">{error}</Banner>
      <div className="p-5 sm:p-6 rounded-3xl bg-slate-900 border border-slate-800 space-y-4">
        {step === 'society' && !societyId && (
          <SocietyStep busy={busy} onCreate={(f) => run(async () => {
            const { data, error: err } = await supabase!.rpc('create_society', {
              p_name: f.name, p_address_line1: null, p_city: f.city, p_state: f.state, p_pincode: f.pincode,
              p_contact_email: profile?.email || null, p_contact_phone: profile?.phone || user?.phone || null,
              p_registration_number: null, p_address_line2: null, p_creator_role: f.role,
            });
            if (err) return err.message;
            // the new society becomes the open one, so the wizard carries on with it
            await refreshUserData(data as string);
            setCreating(false);
            return null;
          }, 'flats')} />
        )}
        {step === 'flats' && societyId && (
          <FlatsStep busy={busy} existing={status?.flats ?? 0}
            onCreate={(rows) => run(async () => {
              const { error: err } = await supabase!.rpc('bulk_upsert_units', { p_society_id: societyId, p_units: rows });
              if (err) return err.message;
              await record('flats');
              return null;
            }, 'maintenance')}
            onContinue={() => run(async () => { await record('flats'); return null; }, 'maintenance')} />
        )}
        {step === 'maintenance' && societyId && (
          <MaintenanceStep busy={busy} societyId={societyId} onSave={(m) => run(async () => {
            const { error: err } = await supabase!.rpc('setup_maintenance', {
              p_society_id: societyId, p_mode: m.mode, p_rate: m.rate, p_extras: m.extras, p_due_day: m.dueDay, p_first: m.first, p_every: m.every,
            });
            if (err) return err.message;
            // areas only once the charges are saved, and only the area changes (set_unit_areas)
            if (m.areas.length) {
              const { error: aErr } = await supabase!.rpc('set_unit_areas', { p_society_id: societyId, p_rows: m.areas });
              if (aErr) return aErr.message;
            }
            return null;
          }, 'upi')} />
        )}
        {step === 'upi' && societyId && (
          <UpiStep busy={busy} societyName={membership?.society?.name ?? ''} onSave={(u) => run(async () => {
            const { error: err } = await supabase!.from('society_settings').update({ upi_id: u.upi, upi_payee_name: u.payee }).eq('society_id', societyId);
            if (err) return err.message;
            await record('upi');
            return null;
          }, 'owners')} onSkip={() => run(async () => { await record('upi_skipped'); return null; }, 'owners')} />
        )}
        {step === 'owners' && societyId && (
          <OwnersStep societyId={societyId}
            onNext={(skipped) => run(async () => { await record(skipped ? 'owners_skipped' : 'owners'); return null; }, 'done')} />
        )}
        {step === 'done' && societyId && (
          <DoneStep societyId={societyId} societyName={membership?.society?.name ?? ''} billsAlready={status?.bills ?? 0}
            onSent={async () => { await record('first_bill'); await loadStatus(false); }}
            onDashboard={() => navigate('/society', { replace: true })} />
        )}
      </div>
    </div>
  );
};

const SocietyStep: React.FC<{ busy: boolean; onCreate: (f: { name: string; pincode: string; city: string; state: string; role: string }) => void }> = ({ busy, onCreate }) => {
  const [f, setF] = useState({ name: '', pincode: '', city: '', state: '', role: 'secretary' });
  const [looking, setLooking] = useState(false);
  const lookup = async (pin: string) => {
    if (!/^[1-9][0-9]{5}$/.test(pin)) return;
    setLooking(true);
    try {
      const res = await fetch(`/api/pincode/${pin}`);
      if (res.ok) {
        const place = await res.json() as { city: string; state: string };
        setF(v => (v.pincode === pin ? { ...v, city: place.city, state: place.state } : v));
      }
    } catch { /* manual entry */ }
    setLooking(false);
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); onCreate(f); }} className="space-y-4">
      <h2 className="text-base font-bold text-white">Your society</h2>
      <label className="block space-y-1"><span className="text-slate-400">Society name</span>
        <input className={input} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Palm Heights CHS" required /></label>
      <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
        <label className="block space-y-1"><span className="text-slate-400">Pincode</span>
          <input className={input} inputMode="numeric" maxLength={6} value={f.pincode} required
            onChange={e => { const pin = e.target.value.replace(/\D/g, ''); setF({ ...f, pincode: pin }); if (pin.length === 6) lookup(pin); }} /></label>
        <label className="block space-y-1"><span className="text-slate-400">City {looking && <Loader2 className="inline w-3 h-3 animate-spin" />}</span>
          <input className={input} value={f.city} onChange={e => setF({ ...f, city: e.target.value })} required /></label>
        <label className="block space-y-1"><span className="text-slate-400">State</span>
          <input className={input} value={f.state} onChange={e => setF({ ...f, state: e.target.value })} required /></label>
      </div>
      <div className="space-y-1.5">
        <span className="text-slate-400">Your role</span>
        <div className="flex flex-wrap gap-2">
          {ROLES.map(r => (
            <button type="button" key={r.value} onClick={() => setF({ ...f, role: r.value })}
              className={`px-3 py-1.5 rounded-full border cursor-pointer ${f.role === r.value ? 'bg-sky-600 border-sky-500 text-white' : 'border-slate-700 text-slate-300'}`}>{r.label}</button>
          ))}
        </div>
      </div>
      <p className="text-slate-500">Address, registration number and contact details can be added later in Society settings → Society profile.</p>
      <button type="submit" disabled={busy} className={`${primary} w-full`}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Continue</button>
    </form>
  );
};

const FlatsStep: React.FC<{ busy: boolean; existing: number; onCreate: (rows: unknown[]) => void; onContinue: () => void }> = ({ busy, existing, onCreate, onContinue }) => {
  const [wings, setWings] = useState<string[]>(['A']);
  const [newWing, setNewWing] = useState('');
  const [floors, setFloors] = useState(7);
  const [perFloor, setPerFloor] = useState(4);
  const plan = useMemo(() => generateFlats({ wings, floors, perFloor }), [wings, floors, perFloor]);
  const noWings = wings.length === 1 && wings[0] === '';
  const addWing = () => {
    const w = newWing.trim();
    if (w && !wings.includes(w)) setWings(noWings ? [w] : [...wings, w]);
    setNewWing('');
  };
  return (
    <div className="space-y-4">
      <h2 className="text-base font-bold text-white">Flats</h2>
      {existing > 0 && (
        <div className="p-3 rounded-xl bg-emerald-500/10 text-emerald-300 flex items-center justify-between gap-2">
          <span>{existing} flats are already added.</span>
          <button onClick={onContinue} className="text-white font-semibold underline cursor-pointer">Continue</button>
        </div>
      )}
      <div className="space-y-1.5">
        <span className="text-slate-400">Wings</span>
        <div className="flex flex-wrap items-center gap-2">
          <button type="button" onClick={() => setWings(noWings ? ['A'] : [''])}
            className={`px-3 py-1.5 rounded-full border cursor-pointer ${noWings ? 'bg-sky-600 border-sky-500 text-white' : 'border-slate-700 text-slate-300'}`}>
            No wings (101, 102…)
          </button>
          {!noWings && wings.map(w => (
            <span key={w} className="px-3 py-1.5 rounded-full bg-slate-800 text-white flex items-center gap-1.5">
              {w}{wings.length > 1 && <button onClick={() => setWings(wings.filter(x => x !== w))} aria-label={`Remove wing ${w}`} className="cursor-pointer"><X className="w-3 h-3" /></button>}
            </span>
          ))}
          <input className="w-20 bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-white" value={newWing} onChange={e => setNewWing(e.target.value)} placeholder="B" />
          <button onClick={addWing} className="flex items-center gap-1 text-sky-400 cursor-pointer"><Plus className="w-3.5 h-3.5" /> Add wing</button>
        </div>
      </div>
      <div className="grid grid-cols-2 gap-3">
        <label className="block space-y-1"><span className="text-slate-400">Number of floors</span>
          <input className={input} type="number" min={1} value={floors} onChange={e => setFloors(Number(e.target.value))} /></label>
        <label className="block space-y-1"><span className="text-slate-400">Flats per floor</span>
          <input className={input} type="number" min={1} value={perFloor} onChange={e => setPerFloor(Number(e.target.value))} /></label>
      </div>
      {plan.error ? <Banner tone="error">{plan.error}</Banner> : <p className="text-white font-semibold">{plan.preview}</p>}
      <button disabled={busy || !!plan.error} onClick={() => onCreate(plan.rows)} className={`${primary} w-full`}>
        {busy && <Loader2 className="w-4 h-4 animate-spin" />} Create {plan.rows.length} flats
      </button>
      <p className="text-slate-500">Or upload from Excel in Flats &amp; residents (<a href="/society?tab=flats" className="text-sky-400 hover:underline">open</a>), then come back here. You can edit any flat afterwards.</p>
    </div>
  );
};

type MaintenanceForm = { mode: 'flat' | 'sqft'; rate: number; extras: { key: string; amount: number }[]; dueDay: number; first: number; every: number; areas: { unit_id: string; carpet_area_sqft: number }[] };
const EXTRAS = [{ key: 'sinking', label: 'Sinking fund' }, { key: 'repair', label: 'Repair fund' }, { key: 'parking', label: 'Parking (you choose the flats later)' }];

const MaintenanceStep: React.FC<{ busy: boolean; societyId: string; onSave: (m: MaintenanceForm) => void }> = ({ busy, societyId, onSave }) => {
  const [mode, setMode] = useState<'flat' | 'sqft'>('flat');
  const [rate, setRate] = useState('');
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [dueDay, setDueDay] = useState(10);
  const [first, setFirst] = useState(3);
  const [every, setEvery] = useState(7);
  const [units, setUnits] = useState<{ id: string; unit_number: string; carpet_area_sqft: number }[]>([]);
  const [areas, setAreas] = useState<Record<string, string>>({});

  useEffect(() => {
    supabase?.from('units').select('id, unit_number, carpet_area_sqft').eq('society_id', societyId)
      .then(({ data }) => setUnits((data ?? []) as { id: string; unit_number: string; carpet_area_sqft: number }[]));
  }, [societyId]);
  // "…01", "…02": the position of a flat on its floor; positions whose flats all have an area need nothing
  const positions = useMemo(() => [...new Set(units.map(u => u.unit_number.slice(-2)))].sort(), [units]);
  const missing = positions.filter(p => !(Number(areas[p]) > 0) && units.some(u => u.unit_number.slice(-2) === p && !(Number(u.carpet_area_sqft) > 0)));

  const save = () => onSave({
    mode, rate: Number(rate), dueDay, first, every,
    areas: mode === 'sqft'
      ? units.filter(u => Number(areas[u.unit_number.slice(-2)]) > 0).map(u => ({ unit_id: u.id, carpet_area_sqft: Number(areas[u.unit_number.slice(-2)]) }))
      : [],
    extras: Object.entries(extras).filter(([, v]) => Number(v) > 0).map(([key, v]) => ({ key, amount: Number(v) })),
  });

  return (
    <div className="space-y-4">
      <h2 className="text-base font-bold text-white">Maintenance</h2>
      <div className="flex gap-2">
        {(['flat', 'sqft'] as const).map(m => (
          <button key={m} onClick={() => setMode(m)} className={`px-3 py-1.5 rounded-full border cursor-pointer ${mode === m ? 'bg-sky-600 border-sky-500 text-white' : 'border-slate-700 text-slate-300'}`}>
            {m === 'flat' ? 'Same for all' : 'Per sq.ft'}
          </button>
        ))}
      </div>
      <label className="block space-y-1"><span className="text-slate-400">{mode === 'flat' ? '₹ per flat per month' : '₹ per sq.ft per month'}</span>
        <input className={input} type="number" min={0} step="0.01" value={rate} onChange={e => setRate(e.target.value)} /></label>
      {mode === 'sqft' && positions.length > 0 && (
        <div className="space-y-1.5">
          <span className="text-slate-400">Area of each flat position (sq.ft) — you can change single flats later</span>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {positions.map(p => (
              <label key={p} className="space-y-1"><span className="text-slate-500">All …{p} flats</span>
                <input className={input} type="number" min={0} value={areas[p] ?? ''} onChange={e => setAreas({ ...areas, [p]: e.target.value })} /></label>
            ))}
          </div>
          {missing.length > 0 && <p className="text-amber-300">Enter the area for …{missing.join(', …')} — those flats would not be billed.</p>}
        </div>
      )}
      <div className="space-y-2">
        <span className="text-slate-400">Extra charges (₹ per flat per month)</span>
        {EXTRAS.map(x => (
          <label key={x.key} className="flex items-center gap-2">
            <input type="checkbox" checked={x.key in extras} onChange={e => setExtras(v => { const n = { ...v }; if (e.target.checked) n[x.key] = ''; else delete n[x.key]; return n; })} />
            <span className="text-slate-300 flex-1">{x.label}</span>
            {x.key in extras && <input className="w-28 bg-slate-950 border border-slate-700 rounded-xl px-2 py-1.5 text-white" type="number" min={0} value={extras[x.key]} onChange={e => setExtras({ ...extras, [x.key]: e.target.value })} />}
          </label>
        ))}
      </div>
      <label className="block space-y-1"><span className="text-slate-400">Due day of the month</span>
        <input className={input} type="number" min={1} max={28} value={dueDay} onChange={e => setDueDay(Number(e.target.value))} /></label>
      <p className="text-slate-300 flex flex-wrap items-center gap-1.5">
        Remind <input className="w-14 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white" type="number" min={1} value={first} onChange={e => setFirst(Number(e.target.value))} />
        days after the due date, then every <input className="w-14 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white" type="number" min={1} value={every} onChange={e => setEvery(Number(e.target.value))} /> days
      </p>
      <button disabled={busy || !(Number(rate) > 0) || (mode === 'sqft' && missing.length > 0)} onClick={save} className={`${primary} w-full`}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Continue</button>
    </div>
  );
};

const UpiStep: React.FC<{ busy: boolean; societyName: string; onSave: (u: { upi: string; payee: string }) => void; onSkip: () => void }> = ({ busy, societyName, onSave, onSkip }) => {
  const [upi, setUpi] = useState('');
  const [payee, setPayee] = useState(societyName);
  const valid = isValidUpiId(upi);
  return (
    <div className="space-y-4">
      <h2 className="text-base font-bold text-white">UPI</h2>
      <label className="block space-y-1"><span className="text-slate-400">Society UPI ID</span>
        <input className={input} value={upi} onChange={e => setUpi(e.target.value)} placeholder="palmheights@okaxis" /></label>
      {upi.trim() && !valid && <p className="text-amber-300">A UPI ID looks like name@bank (palmheights@icici), not an email address.</p>}
      <label className="block space-y-1"><span className="text-slate-400">Payee name</span>
        <input className={input} value={payee} onChange={e => setPayee(e.target.value)} /></label>
      {valid && (
        <div className="flex items-center gap-4 p-3 rounded-xl bg-white text-slate-900">
          <QRCodeSVG value={`upi://pay?${new URLSearchParams({ pa: upi.trim(), pn: payee, cu: 'INR' }).toString()}`} size={96} />
          <span>Residents scan this QR, with the exact amount of their bill filled in.</span>
        </div>
      )}
      <div className="flex gap-2">
        <button disabled={busy || !valid} onClick={() => onSave({ upi: upi.trim(), payee: payee.trim() })} className={`${primary} flex-1`}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Continue</button>
        <button onClick={onSkip} className={secondary}>Later</button>
      </div>
    </div>
  );
};

const OwnersStep: React.FC<{ societyId: string; onNext: (skipped: boolean) => void }> = ({ societyId, onNext }) => {
  const [units, setUnits] = useState<{ id: string; unit_number: string }[]>([]);
  const [rows, setRows] = useState<Record<string, { name: string; mobile: string }>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    if (!supabase) return;
    const [u, c] = await Promise.all([
      supabase.from('units').select('id, unit_number').eq('society_id', societyId),
      supabase.from('unit_owner_contacts').select('unit_id, owner_name, owner_mobile').eq('society_id', societyId),
    ]);
    const list = ((u.data ?? []) as { id: string; unit_number: string }[]).sort((a, b) => a.unit_number.localeCompare(b.unit_number, undefined, { numeric: true }));
    setUnits(list);
    const known = Object.fromEntries(((c.data ?? []) as { unit_id: string; owner_name: string | null; owner_mobile: string | null }[])
      .map(x => [x.unit_id, { name: x.owner_name ?? '', mobile: x.owner_mobile ?? '' }]));
    setRows(Object.fromEntries(list.map(f => [f.id, known[f.id] ?? { name: '', mobile: '' }])));
  }, [societyId]);
  useEffect(() => { load(); }, [load]);

  const entered = Object.values(rows).filter(r => r.mobile.trim()).length;

  const saveTable = async () => {
    if (!supabase) return;
    const bad = units.find(f => rows[f.id]?.mobile.trim() && !normalizeMobile(rows[f.id].mobile));
    if (bad) return setError(`Flat ${bad.unit_number}: mobile ${rows[bad.id].mobile} is not a valid number`);
    setBusy(true);
    setError(null);
    const payload = units.filter(f => rows[f.id]?.name.trim() || rows[f.id]?.mobile.trim())
      .map(f => ({ unit_id: f.id, name: rows[f.id].name, mobile: rows[f.id].mobile }));
    const { data, error: err } = await supabase.rpc('set_flat_owner_contacts', { p_society_id: societyId, p_rows: payload });
    setBusy(false);
    if (err) return setError(err.message);
    setNotice(`Saved owners for ${data} flats.`);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-base font-bold text-white">Owners</h2>
      <p className="text-slate-400">Owners whose mobile you enter join their flat straight away from your joining link.</p>
      <Banner tone="error">{error}</Banner>
      <Banner tone="success">{notice}</Banner>
      <div className="max-h-80 overflow-y-auto rounded-xl border border-slate-800 divide-y divide-slate-800">
        {units.map(f => (
          <div key={f.id} className="p-2 grid grid-cols-[4rem_1fr_1fr] gap-2 items-center">
            <span className="font-semibold text-white">{f.unit_number}</span>
            <input className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-white" placeholder="Owner name" value={rows[f.id]?.name ?? ''}
              onChange={e => setRows({ ...rows, [f.id]: { ...rows[f.id], name: e.target.value } })} />
            <input className="bg-slate-950 border border-slate-700 rounded-lg px-2 py-1.5 text-white" inputMode="tel" placeholder="Mobile" value={rows[f.id]?.mobile ?? ''}
              onChange={e => setRows({ ...rows, [f.id]: { ...rows[f.id], mobile: e.target.value } })} />
          </div>
        ))}
      </div>
      <button onClick={saveTable} disabled={busy} className={`${secondary} w-full flex items-center justify-center gap-2`}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save owners</button>
      <details className="text-slate-300">
        <summary className="cursor-pointer text-sky-400">Or paste from Excel</summary>
        <div className="pt-2"><OwnerPaste societyId={societyId} units={units} onDone={load} /></div>
      </details>
      <p className="text-slate-300">{entered} of {units.length} flats have an owner mobile.</p>
      <div className="flex gap-2">
        <button onClick={() => onNext(false)} disabled={entered === 0} className={`${primary} flex-1`}>Continue</button>
        <button onClick={() => onNext(true)} className={secondary}>Skip — fill later</button>
      </div>
    </div>
  );
};

interface Preview { bills: number; total_amount: number; skipped_units: { unit_number: string; reason: string }[] }

const DoneStep: React.FC<{ societyId: string; societyName: string; billsAlready: number; onSent: () => Promise<void>; onDashboard: () => void }> = ({ societyId, societyName, billsAlready, onSent, onDashboard }) => {
  const [preview, setPreview] = useState<Preview | null>(null);
  const [sent, setSent] = useState(billsAlready > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<{ start: string; end: string; due: string } | null>(null);

  useEffect(() => {
    if (!supabase || billsAlready > 0) return;
    supabase.from('society_settings').select('due_day_of_month').eq('society_id', societyId).maybeSingle().then(async ({ data }) => {
      // never due within a week: a bill overdue the night it is sent would get a late fee
      const p = firstBillDates(new Date(), Number(data?.due_day_of_month ?? 10));
      setPeriod(p);
      const { data: r, error: err } = await supabase!.rpc('generate_bills', { p_society_id: societyId, p_period_start: p.start, p_period_end: p.end, p_due_date: p.due, p_dry_run: true });
      if (err) setError(err.message);
      else setPreview(r as Preview);
    });
  }, [societyId, billsAlready]);

  const send = async () => {
    if (!supabase || !period || busy) return;
    setBusy(true);
    const { error: err } = await supabase.rpc('generate_bills', { p_society_id: societyId, p_period_start: period.start, p_period_end: period.end, p_due_date: period.due });
    if (err) {
      setBusy(false);
      return setError(err.message);
    }
    await onSent();
    setBusy(false);
    setSent(true);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-base font-bold text-white flex items-center gap-2"><CheckCircle2 className="w-5 h-5 text-emerald-400" /> Your society is ready</h2>
      <Banner tone="error">{error}</Banner>
      {!sent && preview && period && (
        <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-3">
          <p className="text-white">This month: <strong>{preview.bills} bills</strong>, total <strong>{formatINR(Number(preview.total_amount))}</strong>, due <strong>{fmt(period.due)}</strong>.</p>
          {preview.skipped_units.length > 0 && (
            <p className="text-amber-300">
              {preview.skipped_units.length} flats not billed: {preview.skipped_units.slice(0, 8).map(s => s.unit_number).join(', ')}
              {preview.skipped_units.length > 8 ? '…' : ''} ({preview.skipped_units[0].reason}).
            </p>
          )}
          <button onClick={send} disabled={busy || preview.bills === 0} className={`${primary} w-full`}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Send bills</button>
          <p className="text-slate-500">Owners see their bills as soon as they join through your link.</p>
        </div>
      )}
      {sent && <p className="text-emerald-300">Bills are issued. Now share the joining link in your society&apos;s WhatsApp group.</p>}
      <JoinLinkCard societyId={societyId} societyName={societyName} canChange />
      <div className="grid sm:grid-cols-2 gap-2">
        <a href="/society?tab=professionals" className={secondary + ' text-center'}>Invite your CA (opening balances and ledgers)</a>
        <a href="/society?tab=members" className={secondary + ' text-center'}>Add your treasurer or chairman</a>
      </div>
      <button onClick={onDashboard} className="w-full text-slate-400 hover:text-white cursor-pointer">Not now, go to dashboard</button>
    </div>
  );
};
