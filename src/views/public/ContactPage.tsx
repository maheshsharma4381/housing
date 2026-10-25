'use client';

import React, { useState } from 'react';
import { supabase } from '../../lib/supabase/client';
import { Mail, Phone, MapPin, CheckCircle2, Send, Loader2 } from 'lucide-react';

const CONTACT_EMAIL = 'contact@sahvaas.in';

export const ContactPage: React.FC = () => {
  const [submitted, setSubmitted] = useState(false);
  const [formData, setFormData] = useState({
    name: '',
    email: '',
    phone: '',
    societyName: '',
    city: '',
    units: '',
    message: '',
  });

  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [website, setWebsite] = useState(''); // honeypot: humans never fill this

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    if (website) {
      setSubmitted(true); // silently drop bots
      return;
    }
    if (!supabase) {
      setError(`Online form is unavailable right now. Please email us at ${CONTACT_EMAIL}.`);
      return;
    }
    setSending(true);
    const { error: insErr } = await supabase.from('leads').insert({
      name: formData.name.trim(),
      email: formData.email.trim().toLowerCase(),
      phone: formData.phone.trim(),
      society_name: formData.societyName.trim(),
      city: formData.city.trim() || null,
      units: formData.units ? Number(formData.units) : null,
      message: formData.message.trim() || null,
    });
    setSending(false);
    if (insErr) {
      setError(
        insErr.message.includes('already have your request')
          ? 'We already have your request — our team will contact you shortly.'
          : 'Please check the details (valid email and a 10-digit phone number) and try again.'
      );
      return;
    }
    setSubmitted(true);
  };

  return (
    <div className="bg-slate-950 text-slate-100 min-h-screen py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <span className="text-xs font-bold uppercase tracking-wider text-sky-400">
            Get in Touch
          </span>
          <h1 className="text-3xl sm:text-5xl font-black text-white tracking-tight">
            Schedule a Demo for Your Managing Committee
          </h1>
          <p className="text-xs sm:text-sm text-slate-400 leading-relaxed">
            Our onboarding team helps societies import member directories, configure maintenance rules, and walk your Chairman & Secretary through the mobile PWA.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {/* Contact Details Column */}
          <div className="p-8 rounded-3xl bg-slate-900 border border-slate-800 space-y-6">
            <h3 className="font-bold text-white text-base">Direct Inquiries</h3>
            <div className="space-y-4 text-xs text-slate-300">
              <div className="flex items-start gap-3">
                <Mail className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-white">Email Us</div>
                  <div className="text-slate-400">contact@sahvaas.in</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Phone className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-white">Call Support</div>
                  <div className="text-slate-400">+91 (022) 2780-9900</div>
                  <div className="text-[10px] text-slate-500">Mon - Sat (9:30 AM - 6:30 PM IST)</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPin className="w-4 h-4 text-sky-400 shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-white">Headquarters</div>
                  <div className="text-slate-400">Sector 19A, Nerul West, Navi Mumbai, Maharashtra 400706</div>
                </div>
              </div>
            </div>

            <div className="pt-6 border-t border-slate-800 text-[11px] text-slate-400 space-y-1">
              <div>• Free 30-day trial for new societies</div>
              <div>• Data migration assistance included</div>
              <div>• Training for society managers and security guards</div>
            </div>
          </div>

          {/* Form Column */}
          <div className="lg:col-span-2 p-8 rounded-3xl bg-slate-900 border border-slate-800">
            {submitted ? (
              <div className="p-8 text-center space-y-4">
                <div className="w-12 h-12 rounded-2xl bg-emerald-500/20 text-emerald-400 mx-auto flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-bold text-white">Thank You for Your Inquiry!</h3>
                <p className="text-xs text-slate-400 max-w-md mx-auto">
                  Our housing society specialist will reach out to schedule an interactive presentation for your managing committee within 24 business hours.
                </p>
                <button
                  onClick={() => setSubmitted(false)}
                  className="px-4 py-2 rounded-xl bg-slate-800 text-xs text-slate-200 hover:text-white"
                >
                  Submit Another Inquiry
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4 text-xs">
                <h3 className="font-bold text-white text-base">Society Information</h3>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-slate-400 mb-1 font-medium">Your Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Vikram Joshi"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1 font-medium">Phone Number *</label>
                    <input
                      type="tel"
                      required
                      placeholder="+91 98200 00000"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-slate-400 mb-1 font-medium">Official Email Address *</label>
                    <input
                      type="email"
                      required
                      placeholder="secretary@palmheights.in"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1 font-medium">Society Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Palm Heights Co-op Housing Society"
                      value={formData.societyName}
                      onChange={(e) => setFormData({ ...formData, societyName: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-slate-400 mb-1 font-medium">City / Location</label>
                    <input
                      type="text"
                      placeholder="e.g. Navi Mumbai, Maharashtra"
                      value={formData.city}
                      onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500"
                    />
                  </div>

                  <div>
                    <label className="block text-slate-400 mb-1 font-medium">Approx. Number of Flats</label>
                    <input
                      type="number"
                      placeholder="e.g. 96"
                      value={formData.units}
                      onChange={(e) => setFormData({ ...formData, units: e.target.value })}
                      className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-slate-400 mb-1 font-medium">Any Specific Requirements</label>
                  <textarea
                    rows={3}
                    placeholder="e.g. Need assistance transitioning from offline registers and setting up GSTR-2B matching."
                    value={formData.message}
                    onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                    className="w-full bg-slate-950 border border-slate-700 rounded-xl px-3 py-2 text-white outline-none focus:border-sky-500"
                  />
                </div>

                {/* Honeypot: hidden from people, bots tend to fill it */}
                <input
                  type="text"
                  name="website"
                  tabIndex={-1}
                  autoComplete="off"
                  value={website}
                  onChange={(e) => setWebsite(e.target.value)}
                  className="hidden"
                  aria-hidden="true"
                />

                {error && (
                  <div className="p-3 rounded-xl bg-rose-500/10 border border-rose-500/30 text-rose-300">{error}</div>
                )}

                <button
                  type="submit"
                  disabled={sending}
                  className="w-full py-3 rounded-xl bg-sky-600 hover:bg-sky-500 text-white font-semibold text-xs flex items-center justify-center gap-2 shadow-sm transition cursor-pointer disabled:opacity-50"
                >
                  {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />}
                  <span>{sending ? 'Sending…' : 'Submit Consultation Request'}</span>
                </button>
              </form>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
