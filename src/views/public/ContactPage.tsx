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
    <div className="bg-canvas text-fg min-h-screen py-16">
      <div className="max-w-7xl mx-auto px-4 sm:px-6 lg:px-8 space-y-12">
        <div className="text-center max-w-3xl mx-auto space-y-4">
          <span className="text-xs font-semibold text-brand">
            Get in Touch
          </span>
          <h1 className="text-3xl sm:text-5xl font-semibold text-fg tracking-tight">
            Schedule a Demo for Your Managing Committee
          </h1>
          <p className="text-xs sm:text-sm text-fg-muted leading-relaxed">
            Our onboarding team helps societies import member directories, configure maintenance rules, and walk your Chairman & Secretary through the mobile PWA.
          </p>
        </div>

        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8 max-w-5xl mx-auto">
          {/* Contact Details Column */}
          <div className="p-8 rounded-2xl bg-surface border border-border space-y-6">
            <h3 className="font-semibold text-fg text-base">Direct Inquiries</h3>
            <div className="space-y-4 text-xs text-fg">
              <div className="flex items-start gap-3">
                <Mail className="w-4 h-4 text-brand shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-fg">Email Us</div>
                  <div className="text-fg-muted">contact@sahvaas.in</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <Phone className="w-4 h-4 text-brand shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-fg">Call Support</div>
                  <div className="text-fg-muted">+91 (022) 2780-9900</div>
                  <div className="text-xs text-fg-subtle">Mon - Sat (9:30 AM - 6:30 PM IST)</div>
                </div>
              </div>
              <div className="flex items-start gap-3">
                <MapPin className="w-4 h-4 text-brand shrink-0 mt-0.5" />
                <div>
                  <div className="font-semibold text-fg">Headquarters</div>
                  <div className="text-fg-muted">Sector 19A, Nerul West, Navi Mumbai, Maharashtra 400706</div>
                </div>
              </div>
            </div>

            <div className="pt-6 border-t border-border text-xs text-fg-muted space-y-1">
              <div>• Free 30-day trial for new societies</div>
              <div>• Data migration assistance included</div>
              <div>• Training for society managers and security guards</div>
            </div>
          </div>

          {/* Form Column */}
          <div className="lg:col-span-2 p-8 rounded-2xl bg-surface border border-border">
            {submitted ? (
              <div className="p-8 text-center space-y-4">
                <div className="w-12 h-12 rounded-xl bg-success-soft text-success mx-auto flex items-center justify-center">
                  <CheckCircle2 className="w-6 h-6" />
                </div>
                <h3 className="text-lg font-semibold text-fg">Thank You for Your Inquiry!</h3>
                <p className="text-xs text-fg-muted max-w-md mx-auto">
                  Our housing society specialist will reach out to schedule an interactive presentation for your managing committee within 24 business hours.
                </p>
                <button
                  onClick={() => setSubmitted(false)}
                  className="px-4 py-2 rounded-lg bg-surface-muted text-xs text-fg hover:text-fg"
                >
                  Submit Another Inquiry
                </button>
              </div>
            ) : (
              <form onSubmit={handleSubmit} className="space-y-4 text-xs">
                <h3 className="font-semibold text-fg text-base">Society Information</h3>
                
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-fg-muted mb-1 font-medium">Your Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Vikram Joshi"
                      value={formData.name}
                      onChange={(e) => setFormData({ ...formData, name: e.target.value })}
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand"
                    />
                  </div>

                  <div>
                    <label className="block text-fg-muted mb-1 font-medium">Phone Number *</label>
                    <input
                      type="tel"
                      required
                      placeholder="+91 98200 00000"
                      value={formData.phone}
                      onChange={(e) => setFormData({ ...formData, phone: e.target.value })}
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-fg-muted mb-1 font-medium">Official Email Address *</label>
                    <input
                      type="email"
                      required
                      placeholder="secretary@palmheights.in"
                      value={formData.email}
                      onChange={(e) => setFormData({ ...formData, email: e.target.value })}
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand"
                    />
                  </div>

                  <div>
                    <label className="block text-fg-muted mb-1 font-medium">Society Name *</label>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Palm Heights Co-op Housing Society"
                      value={formData.societyName}
                      onChange={(e) => setFormData({ ...formData, societyName: e.target.value })}
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand"
                    />
                  </div>
                </div>

                <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
                  <div>
                    <label className="block text-fg-muted mb-1 font-medium">City / Location</label>
                    <input
                      type="text"
                      placeholder="e.g. Navi Mumbai, Maharashtra"
                      value={formData.city}
                      onChange={(e) => setFormData({ ...formData, city: e.target.value })}
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand"
                    />
                  </div>

                  <div>
                    <label className="block text-fg-muted mb-1 font-medium">Approx. Number of Flats</label>
                    <input
                      type="number"
                      placeholder="e.g. 96"
                      value={formData.units}
                      onChange={(e) => setFormData({ ...formData, units: e.target.value })}
                      className="w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand"
                    />
                  </div>
                </div>

                <div>
                  <label className="block text-fg-muted mb-1 font-medium">Any Specific Requirements</label>
                  <textarea
                    rows={3}
                    placeholder="e.g. Need assistance transitioning from offline registers and setting up GSTR-2B matching."
                    value={formData.message}
                    onChange={(e) => setFormData({ ...formData, message: e.target.value })}
                    className="w-full bg-surface border border-border-strong rounded-lg px-3 py-2 text-fg outline-none focus:border-brand"
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
                  <div className="p-3 rounded-xl bg-danger-soft border border-danger/30 text-danger">{error}</div>
                )}

                <button
                  type="submit"
                  disabled={sending}
                  className="w-full py-3 rounded-xl bg-brand hover:bg-brand-hover text-on-brand font-semibold text-xs flex items-center justify-center gap-2 shadow-card transition cursor-pointer disabled:opacity-50"
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
