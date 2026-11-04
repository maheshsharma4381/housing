'use client';

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { QRCodeSVG } from 'qrcode.react';
import { useAuth } from '../../context/AuthContext';
import { useRouter } from '../../router/RouterContext';
import { supabase } from '../../lib/supabase/client';
import { generateFlats } from '../../lib/flat-generator';
import { formatINR } from '../../lib/inr';
import { Banner } from '../../components/Banner';
import { OwnerPaste } from '../../components/OwnerContacts';
import { JoinLinkCard } from '../../components/JoinLinkCard';
import { Loader2, Plus, X, CheckCircle2 } from 'lucide-react';

// Spec 9.1: Society → Flats → Maintenance → UPI → Owners → Done (the login is step 1).
type Step = 'society' | 'flats' | 'maintenance' | 'upi' | 'owners' | 'done';
const STEPS: { id: Step; label: string }[] = [
  { id: 'society', label: 'Society' }, { id: 'flats', label: 'Flats' }, { id: 'maintenance', label: 'Maintenance' },
  { id: 'upi', label: 'UPI' }, { id: 'owners', label: 'Owners' }, { id: 'done', label: 'Done' },
];
const ADMIN_ROLES = ['secretary', 'chairman', 'treasurer', 'society_admin'];
const ROLES = [
  { value: 'secretary', label: 'Secretary' }, { value: 'chairman', label: 'Chairman' },
  { value: 'treasurer', label: 'Treasurer' }, { value: 'society_admin', label: 'Manager' },
];
interface Status { steps: string[]; flats: number; rules: number; upi: boolean; owners_entered: number; bills: number }

const input = 'w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2.5 text-white outline-none focus:border-sky-500';
const primary = 'px-4 py-2.5 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-bold cursor-pointer disabled:opacity-50 flex items-center justify-center gap-2';
const secondary = 'px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 font-semibold cursor-pointer';

const monthBounds = (dueDay: number) => {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth();
  const iso = (dt: Date) => `${dt.getFullYear()}-${String(dt.getMonth() + 1).padStart(2, '0')}-${String(dt.getDate()).padStart(2, '0')}`;
  return { start: iso(new Date(y, m, 1)), end: iso(new Date(y, m + 1, 0)), due: iso(new Date(y, m, Math.min(dueDay, 28))) };
};

export const SetupWizard: React.FC = () => {
  const { profile, user, societyMemberships, refreshUserData } = useAuth();
  const { navigate } = useRouter();
  const membership = societyMemberships.find(m => ADMIN_ROLES.includes(m.role));
  const societyId = membership?.society_id ?? null;
  const [status, setStatus] = useState<Status | null>(null);
  const [step, setStep] = useState<Step>('society');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const loadStatus = useCallback(async (pickStep: boolean) => {
    if (!supabase || !societyId) return;
    const { data, error: err } = await supabase.rpc('setup_status', { p_society_id: societyId });
    if (err) return setError(err.message);
    const s = data as Status;
    setStatus(s);
    if (pickStep) {
      // Resume at the first unfinished step
      const done = new Set(s.steps);
      const next = !done.has('flats') && s.flats === 0 ? 'flats'
        : !done.has('maintenance') && s.rules === 0 ? 'maintenance'
        : !done.has('upi') && !s.upi ? 'upi'
        : !done.has('owners') && !done.has('owners_skipped') ? 'owners'
        : 'done';
      setStep(next);
    }
  }, [societyId]);

  useEffect(() => {
    loadStatus(true);
  }, [loadStatus]);

  const record = async (s: string) => {
    if (supabase && societyId) await supabase.rpc('record_setup_step', { p_society_id: societyId, p_step: s });
  };
  const run = async (fn: () => Promise<string | null>, next: Step) => {
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
            await refreshUserData(data as string);
            return null;
          }, 'flats')} />
        )}
        {step === 'society' && societyId && <p className="text-slate-300">Your society is registered. <button className="text-sky-400 hover:underline cursor-pointer" onClick={() => loadStatus(true)}>Continue</button></p>}
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
            if (m.areas) {
              const { error: aErr } = await supabase!.rpc('bulk_upsert_units', { p_society_id: societyId, p_units: m.areas });
              if (aErr) return aErr.message;
            }
            const { error: err } = await supabase!.rpc('setup_maintenance', {
              p_society_id: societyId, p_mode: m.mode, p_rate: m.rate, p_extras: m.extras, p_due_day: m.dueDay, p_first: m.first, p_every: m.every,
            });
            return err?.message ?? null;
          }, 'upi')} />
        )}
        {step === 'upi' && societyId && (
          <UpiStep busy={busy} societyName={membership?.society?.name ?? ''} onSave={(u) => run(async () => {
            const { error: err } = await supabase!.from('society_settings').update({ upi_id: u.upi, upi_payee_name: u.payee }).eq('society_id', societyId);
            if (err) return err.message;
            await record('upi');
            return null;
          }, 'owners')} onSkip={() => setStep('owners')} />
        )}
        {step === 'owners' && societyId && (
          <OwnersStep societyId={societyId} entered={status?.owners_entered ?? 0}
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
        setF(v => ({ ...v, city: v.city || place.city, state: v.state || place.state }));
      }
    } catch { /* manual entry */ }
    setLooking(false);
  };
  return (
    <form onSubmit={(e) => { e.preventDefault(); onCreate(f); }} className="space-y-4">
      <h2 className="text-base font-bold text-white">Your society</h2>
      <label className="block space-y-1"><span className="text-slate-400">Society name</span>
        <input className={input} value={f.name} onChange={e => setF({ ...f, name: e.target.value })} placeholder="Palm Heights CHS" required /></label>
      <div className="grid grid-cols-3 gap-3">
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
      <p className="text-slate-500">Address, registration number and contact details can be added later in Society settings.</p>
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
  const addWing = () => {
    const w = newWing.trim();
    if (w && !wings.includes(w)) setWings([...wings, w]);
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
          {wings.map(w => (
            <span key={w} className="px-3 py-1.5 rounded-full bg-slate-800 text-white flex items-center gap-1.5">
              {w || 'No wing'}{wings.length > 1 && <button onClick={() => setWings(wings.filter(x => x !== w))} aria-label={`Remove wing ${w}`} className="cursor-pointer"><X className="w-3 h-3" /></button>}
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
      <p className="text-slate-500">Or upload from Excel later in Flats &amp; residents. You can edit any flat afterwards.</p>
    </div>
  );
};

type MaintenanceForm = { mode: 'flat' | 'sqft'; rate: number; extras: { key: string; amount: number }[]; dueDay: number; first: number; every: number; areas: unknown[] | null };
const EXTRAS = [{ key: 'sinking', label: 'Sinking fund' }, { key: 'repair', label: 'Repair fund' }, { key: 'parking', label: 'Parking (you choose the flats later)' }];

const MaintenanceStep: React.FC<{ busy: boolean; societyId: string; onSave: (m: MaintenanceForm) => void }> = ({ busy, societyId, onSave }) => {
  const [mode, setMode] = useState<'flat' | 'sqft'>('flat');
  const [rate, setRate] = useState('');
  const [extras, setExtras] = useState<Record<string, string>>({});
  const [dueDay, setDueDay] = useState(10);
  const [first, setFirst] = useState(3);
  const [every, setEvery] = useState(7);
  const [units, setUnits] = useState<{ unit_number: string; wing: string }[]>([]);
  const [areas, setAreas] = useState<Record<string, string>>({});

  useEffect(() => {
    if (!supabase) return;
    supabase.from('units').select('unit_number, wings:wing_id (name)').eq('society_id', societyId).then(({ data }) =>
      setUnits((data ?? []).map((u: { unit_number: string; wings: { name: string } | { name: string }[] | null }) => ({
        unit_number: u.unit_number, wing: (Array.isArray(u.wings) ? u.wings[0]?.name : u.wings?.name) ?? 'A',
      }))));
  }, [societyId]);
  // "…01", "…02": the position of a flat on its floor
  const positions = useMemo(() => [...new Set(units.map(u => u.unit_number.slice(-2)))].sort(), [units]);

  const save = () => {
    const areaRows = mode === 'sqft'
      ? units.filter(u => Number(areas[u.unit_number.slice(-2)]) > 0).map(u => ({ wing: u.wing, unit_number: u.unit_number, carpet_area_sqft: Number(areas[u.unit_number.slice(-2)]) }))
      : null;
    onSave({
      mode, rate: Number(rate), dueDay, first, every, areas: areaRows && areaRows.length ? areaRows : null,
      extras: Object.entries(extras).filter(([, v]) => Number(v) > 0).map(([key, v]) => ({ key, amount: Number(v) })),
    });
  };

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
        Remind <input className="w-14 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white" type="number" min={0} value={first} onChange={e => setFirst(Number(e.target.value))} />
        days after the due date, then every <input className="w-14 bg-slate-950 border border-slate-700 rounded-lg px-2 py-1 text-white" type="number" min={1} value={every} onChange={e => setEvery(Number(e.target.value))} /> days
      </p>
      <button disabled={busy || !(Number(rate) > 0)} onClick={save} className={`${primary} w-full`}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Continue</button>
    </div>
  );
};

const UpiStep: React.FC<{ busy: boolean; societyName: string; onSave: (u: { upi: string; payee: string }) => void; onSkip: () => void }> = ({ busy, societyName, onSave, onSkip }) => {
  const [upi, setUpi] = useState('');
  const [payee, setPayee] = useState(societyName);
  const valid = /^[\w.-]{2,}@[\w.-]{2,}$/.test(upi.trim());
  return (
    <div className="space-y-4">
      <h2 className="text-base font-bold text-white">UPI</h2>
      <label className="block space-y-1"><span className="text-slate-400">Society UPI ID</span>
        <input className={input} value={upi} onChange={e => setUpi(e.target.value)} placeholder="palmheights@okaxis" /></label>
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

const OwnersStep: React.FC<{ societyId: string; entered: number; onNext: (skipped: boolean) => void }> = ({ societyId, entered, onNext }) => {
  const [units, setUnits] = useState<{ id: string; unit_number: string }[]>([]);
  const [count, setCount] = useState(entered);
  const loadUnits = useCallback(() => {
    supabase?.from('units').select('id, unit_number').eq('society_id', societyId).then(({ data }) => setUnits(data ?? []));
    supabase?.rpc('setup_status', { p_society_id: societyId }).then(({ data }) => setCount((data as Status | null)?.owners_entered ?? 0));
  }, [societyId]);
  useEffect(() => { loadUnits(); }, [loadUnits]);
  return (
    <div className="space-y-4">
      <h2 className="text-base font-bold text-white">Owners</h2>
      <p className="text-slate-400">Owners whose mobile you enter join their flat straight away from your joining link.</p>
      <OwnerPaste societyId={societyId} units={units} onDone={loadUnits} />
      <p className="text-slate-300">{count} of {units.length} flats have an owner mobile.</p>
      <div className="flex gap-2">
        <button onClick={() => onNext(false)} disabled={count === 0} className={`${primary} flex-1`}>Continue</button>
        <button onClick={() => onNext(true)} className={secondary}>Skip — fill later</button>
      </div>
    </div>
  );
};

const DoneStep: React.FC<{ societyId: string; societyName: string; billsAlready: number; onSent: () => Promise<void>; onDashboard: () => void }> = ({ societyId, societyName, billsAlready, onSent, onDashboard }) => {
  const [preview, setPreview] = useState<{ bills: number; total_amount: number } | null>(null);
  const [sent, setSent] = useState(billsAlready > 0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [period, setPeriod] = useState<{ start: string; end: string; due: string } | null>(null);

  useEffect(() => {
    if (!supabase || billsAlready > 0) return;
    supabase.from('society_settings').select('due_day_of_month').eq('society_id', societyId).maybeSingle().then(async ({ data }) => {
      const p = monthBounds(Number(data?.due_day_of_month ?? 10));
      setPeriod(p);
      const { data: r, error: err } = await supabase!.rpc('generate_bills', { p_society_id: societyId, p_period_start: p.start, p_period_end: p.end, p_due_date: p.due, p_dry_run: true });
      if (err) setError(err.message);
      else setPreview(r as { bills: number; total_amount: number });
    });
  }, [societyId, billsAlready]);

  const send = async () => {
    if (!supabase || !period) return;
    setBusy(true);
    const { error: err } = await supabase.rpc('generate_bills', { p_society_id: societyId, p_period_start: period.start, p_period_end: period.end, p_due_date: period.due });
    setBusy(false);
    if (err) return setError(err.message);
    await onSent();
    setSent(true);
  };

  return (
    <div className="space-y-4">
      <h2 className="text-base font-bold text-white flex items-center gap-2"><CheckCircle2 className="w-5 h-5 text-emerald-400" /> Your society is ready</h2>
      <Banner tone="error">{error}</Banner>
      {!sent && preview && (
        <div className="p-4 rounded-2xl bg-slate-950 border border-slate-800 space-y-3">
          <p className="text-white">This month: <strong>{preview.bills} bills</strong>, total <strong>{formatINR(Number(preview.total_amount))}</strong>.</p>
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
