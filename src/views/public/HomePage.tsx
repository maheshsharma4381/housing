import React from 'react';
import { Link } from '../../router/RouterContext';
import { Users, Smartphone, Briefcase, CheckCircle2, ArrowRight, ShieldCheck, Lock, FileCheck2, ClipboardList } from 'lucide-react';
import { buttonClass } from '../../components/ui/Button';
import { Badge } from '../../components/ui/Badge';

const PERSONAS = [
  {
    Icon: Users,
    title: 'For the committee',
    body: 'Issue every flat’s bill in one go, see who has paid, verify UPI payments and approve vendor bills from your phone.',
    points: ['Bills for all flats in three steps', 'Payments to verify, in one list', 'Two-person approval for spending'],
    href: '/societies',
    link: 'For societies',
  },
  {
    Icon: Smartphone,
    title: 'For residents',
    body: 'Owners see what they owe and pay by UPI in one tap. Everyone reads notices and raises complaints without calling anyone.',
    points: ['Pay by UPI, get a receipt', 'Notices on the phone', 'Complaints with status'],
    href: '/features',
    link: 'All features',
  },
  {
    Icon: Briefcase,
    title: 'For your CA',
    body: 'Double-entry books keep themselves. Your CA opens only what the committee allows and exports to Excel or Tally.',
    points: ['I&E, Balance Sheet, Trial Balance', 'GSTR-2B and TDS register', 'Tally XML export'],
    href: '/accountants',
    link: 'For CAs',
  },
];

const STEPS = [
  { n: 1, title: 'Add your society', body: 'Name, address and your flats: type them, or paste them from Excel.' },
  { n: 2, title: 'Set the maintenance charge', body: 'Per flat or per sq.ft, and the society’s UPI ID for payments.' },
  { n: 3, title: 'Share one link', body: 'Post the joining link in your WhatsApp group. Owners join, then you issue the first bills.' },
];

const FAQ = [
  { q: 'Do residents have to install an app?', a: 'No. Sahvaas opens in the phone’s browser, and anyone can add it to the home screen like an app.' },
  { q: 'Who can see our society’s data?', a: 'Only your members. Each society’s data is kept apart, a resident sees only their own flat, and a CA sees only the modules your committee allows.' },
  { q: 'What does it cost?', a: 'There is a free plan. Basic is ₹10 per flat per month and Pro is ₹18 (minimum 20 flats), with two months free when you pay yearly. New societies get a free trial of everything.' },
  { q: 'Do we need to know accounting?', a: 'No. You record bills and payments; the ledgers, receipts and reports are made for you, and your CA can check them.' },
];

/** A small, faithful picture of the resident home screen (what the app really shows). */
const PhonePreview: React.FC = () => (
  <div aria-hidden="true" className="mx-auto w-[280px] rounded-[2rem] border border-border-strong bg-surface p-2 shadow-pop">
    <div className="rounded-[1.6rem] bg-canvas overflow-hidden">
      <div className="flex items-center gap-2 px-4 py-3 bg-surface border-b border-border">
        <span className="w-7 h-7 rounded-lg bg-brand" />
        <div>
          <div className="text-[13px] font-semibold text-fg">Your society</div>
          <div className="text-xs text-fg-subtle">Flat A-101 · Owner</div>
        </div>
      </div>
      <div className="p-3 space-y-3">
        <div className="rounded-xl bg-surface border border-border p-4 space-y-1">
          <div className="text-xs text-fg-muted">December maintenance</div>
          <div className="text-2xl font-semibold text-fg tabular-nums">₹2,000</div>
          <Badge tone="warning" dot>Due 10 Dec</Badge>
          <div className="mt-3 h-10 rounded-lg bg-brand text-on-brand text-[13px] font-semibold flex items-center justify-center">Pay ₹2,000 via UPI</div>
        </div>
        <div className="rounded-xl bg-surface border border-border p-3 space-y-2">
          <div className="text-[12px] font-semibold text-fg">Paid already? Enter the UTR</div>
          <div className="h-9 rounded-lg border border-border-strong" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-surface border border-border p-3 text-xs font-medium text-fg">Raise a complaint</div>
          <div className="rounded-xl bg-surface border border-border p-3 text-xs font-medium text-fg">Ask for an NOC</div>
        </div>
      </div>
    </div>
  </div>
);

export const HomePage: React.FC = () => {
  return (
    <div className="bg-canvas text-fg min-h-screen">
      {/* Hero */}
      <section className="border-b border-border bg-surface">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 py-14 sm:py-20 grid gap-12 lg:grid-cols-2 items-center">
          <div className="space-y-6 text-center lg:text-left">
            <Badge tone="brand">For housing societies in India</Badge>
            <h1 className="text-[34px] sm:text-5xl lg:text-[56px] leading-[1.1] font-semibold tracking-tight text-fg">
              Run your society without registers and WhatsApp chaos
            </h1>
            <p className="text-base sm:text-lg text-fg-muted leading-relaxed max-w-xl mx-auto lg:mx-0">
              Maintenance bills, UPI payments, receipts, notices and complaints in one place, for the committee and every flat.
              The books keep themselves, ready for your CA.
            </p>
            <div className="flex flex-col sm:flex-row gap-3 justify-center lg:justify-start">
              <Link href="/signup" className={buttonClass('primary', 'lg')}>Start free <ArrowRight className="w-4 h-4" /></Link>
              <Link href="/contact" className={buttonClass('secondary', 'lg')}>Book a demo</Link>
            </div>
            <ul className="flex flex-wrap gap-x-6 gap-y-2 justify-center lg:justify-start text-sm text-fg-muted">
              {['Free trial of everything', 'No app to install', 'Works on any phone'].map(t => (
                <li key={t} className="flex items-center gap-1.5"><CheckCircle2 className="w-4 h-4 text-success" aria-hidden="true" />{t}</li>
              ))}
            </ul>
          </div>
          <PhonePreview />
        </div>
      </section>

      {/* Who it is for */}
      <section className="py-16 sm:py-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="max-w-2xl mb-10">
            <h2 className="text-3xl sm:text-[34px] font-semibold tracking-tight">One app, three kinds of people</h2>
            <p className="mt-2 text-fg-muted">Everyone sees what is theirs, and nothing else.</p>
          </div>
          <div className="grid gap-4 md:grid-cols-3">
            {PERSONAS.map(p => (
              <article key={p.title} className="flex flex-col p-6 rounded-xl bg-surface border border-border shadow-card">
                <span className="w-11 h-11 rounded-full bg-brand-soft text-brand flex items-center justify-center"><p.Icon className="w-5 h-5" aria-hidden="true" /></span>
                <h3 className="mt-4 text-lg font-semibold">{p.title}</h3>
                <p className="mt-2 text-sm text-fg-muted leading-relaxed">{p.body}</p>
                <ul className="mt-4 space-y-2 text-sm flex-1">
                  {p.points.map(pt => (
                    <li key={pt} className="flex items-start gap-2"><CheckCircle2 className="w-4 h-4 mt-0.5 text-success shrink-0" aria-hidden="true" />{pt}</li>
                  ))}
                </ul>
                <Link href={p.href} className="mt-5 inline-flex items-center gap-1.5 text-sm font-semibold text-brand hover:text-brand-hover">
                  {p.link} <ArrowRight className="w-4 h-4" />
                </Link>
              </article>
            ))}
          </div>
        </div>
      </section>

      {/* How it works */}
      <section className="py-16 sm:py-20 bg-surface border-y border-border">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <h2 className="text-3xl sm:text-[34px] font-semibold tracking-tight">Start in one sitting</h2>
          <p className="mt-2 text-fg-muted">You can issue your first bills the same day you sign up.</p>
          <ol className="mt-10 grid gap-6 md:grid-cols-3">
            {STEPS.map(s => (
              <li key={s.n} className="space-y-2">
                <span className="w-9 h-9 rounded-full bg-brand text-on-brand font-semibold flex items-center justify-center">{s.n}</span>
                <h3 className="text-lg font-semibold">{s.title}</h3>
                <p className="text-sm text-fg-muted leading-relaxed">{s.body}</p>
              </li>
            ))}
          </ol>
        </div>
      </section>

      {/* Trust */}
      <section className="py-16 sm:py-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8 grid gap-10 lg:grid-cols-2 items-center">
          <div className="space-y-4">
            <h2 className="text-3xl sm:text-[34px] font-semibold tracking-tight">Your society’s money, kept safe and in order</h2>
            <p className="text-fg-muted leading-relaxed">
              Every society’s data is locked apart from every other. Residents see only their own flat. Your CA sees only what the committee allows,
              and every approval and change is recorded with a name and a date.
            </p>
            <Link href="/security" className={buttonClass('secondary', 'md')}>How we keep data safe <ArrowRight className="w-4 h-4" /></Link>
          </div>
          <div className="grid grid-cols-2 gap-3">
            {[
              { Icon: Lock, t: 'Kept apart', d: 'One society can never see another’s data.' },
              { Icon: ShieldCheck, t: 'You decide access', d: 'The CA gets only the modules you tick.' },
              { Icon: ClipboardList, t: 'Every change recorded', d: 'Approvals and edits carry a name and date.' },
              { Icon: FileCheck2, t: 'Real accounting', d: 'Double-entry books, not guesses.' },
            ].map(({ Icon, t, d }) => (
              <div key={t} className="p-4 rounded-xl bg-surface border border-border shadow-card space-y-1.5">
                <Icon className="w-5 h-5 text-brand" aria-hidden="true" />
                <div className="font-semibold">{t}</div>
                <div className="text-sm text-fg-muted">{d}</div>
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* Pricing teaser */}
      <section className="pb-16 sm:pb-20">
        <div className="max-w-6xl mx-auto px-4 sm:px-6 lg:px-8">
          <div className="rounded-xl bg-surface border border-border shadow-card p-6 sm:p-10 flex flex-col md:flex-row md:items-center justify-between gap-6">
            <div>
              <h2 className="text-2xl sm:text-3xl font-semibold tracking-tight">Free to start. From ₹10 per flat a month.</h2>
              <p className="mt-2 text-fg-muted">A free plan for every society, Basic without ads, Pro with GST and Tally tools. Pay yearly and get two months free.</p>
            </div>
            <Link href="/pricing" className={buttonClass('primary', 'lg', 'shrink-0')}>See pricing</Link>
          </div>
        </div>
      </section>

      {/* FAQ */}
      <section className="py-16 sm:py-20 bg-surface border-y border-border">
        <div className="max-w-3xl mx-auto px-4 sm:px-6">
          <h2 className="text-3xl sm:text-[34px] font-semibold tracking-tight">Questions secretaries ask</h2>
          <div className="mt-8 divide-y divide-border border-y border-border">
            {FAQ.map(f => (
              <details key={f.q} className="group py-4">
                <summary className="flex items-center justify-between gap-4 cursor-pointer list-none font-semibold text-fg">
                  {f.q}
                  <span aria-hidden="true" className="text-fg-subtle transition group-open:rotate-45 text-xl leading-none">+</span>
                </summary>
                <p className="mt-2 text-fg-muted leading-relaxed">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* Final call */}
      <section className="py-16 sm:py-20 text-center">
        <div className="max-w-2xl mx-auto px-4 space-y-5">
          <h2 className="text-3xl sm:text-4xl font-semibold tracking-tight">Ready when your committee is</h2>
          <p className="text-fg-muted">Sign up, add your flats and share one link. We can also walk your committee through it.</p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link href="/signup" className={buttonClass('primary', 'lg')}>Start free</Link>
            <Link href="/contact" className={buttonClass('secondary', 'lg')}>Talk to us</Link>
          </div>
        </div>
      </section>
    </div>
  );
};
