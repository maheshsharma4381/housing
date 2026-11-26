'use client';

import React, { useEffect, useState } from 'react';
import { supabase } from '../lib/supabase/client';
import { whatsappLink } from '../lib/messages';
import { Banner } from './Banner';
import { Link2, Copy, MessageCircle, RefreshCw, Check } from 'lucide-react';
import { confirmDialog } from './ui/feedback';

/** The society's one joining link (031), shared in the residents' WhatsApp group. */
export const JoinLinkCard: React.FC<{ societyId: string; societyName?: string; canChange: boolean }> = ({ societyId, societyName, canChange }) => {
  const [code, setCode] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!supabase) return;
    supabase.rpc('society_join_code', { p_society_id: societyId }).then(({ data, error: err }) => {
      if (err) setError(err.message);
      else setCode(data as string);
    });
  }, [societyId]);

  const link = code && typeof window !== 'undefined' ? `${window.location.origin}/join/${code}` : '';

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(link);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      setError('Copy did not work on this browser — select the link and copy it.');
    }
  };

  const renew = async () => {
    if (!supabase || !(await confirmDialog({ title: 'Make a new joining link?', body: 'The old link stops working. Share the new one in your WhatsApp group.', confirmText: 'Make new link' }))) return;
    setBusy(true);
    const { data, error: err } = await supabase.rpc('new_join_code', { p_society_id: societyId });
    setBusy(false);
    if (err) return setError(err.message);
    setCode(data as string);
  };

  return (
    <div className="p-5 rounded-xl bg-surface border border-brand/30 space-y-3 text-xs">
      <div className="flex items-center gap-2 font-semibold text-fg text-sm">
        <Link2 className="w-4 h-4 text-brand" /> Joining link
      </div>
      <p className="text-fg-muted">
        Post this link in your society&apos;s WhatsApp group. Owners whose mobile you entered join their flat straight away; anyone else comes to Approvals.
      </p>
      <Banner tone="error">{error}</Banner>
      {link && (
        <>
          <div className="px-3 py-2 rounded-lg bg-canvas border border-border-strong font-mono text-brand break-all select-all">{link}</div>
          <div className="flex flex-wrap gap-2">
            <button onClick={copy} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-brand hover:bg-brand-hover text-on-brand font-semibold cursor-pointer">
              {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />} {copied ? 'Copied' : 'Copy'}
            </button>
            <a
              href={whatsappLink(`Join ${societyName ?? 'our society'} on Sahvaas: ${link}`)}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-success hover:bg-success/90 text-on-brand font-semibold"
            >
              <MessageCircle className="w-3.5 h-3.5" /> Share on WhatsApp
            </a>
            {canChange && (
              <button onClick={renew} disabled={busy} className="flex items-center gap-1.5 px-3 py-2 rounded-lg bg-surface-muted hover:bg-border text-fg font-semibold cursor-pointer disabled:opacity-50">
                <RefreshCw className="w-3.5 h-3.5" /> Make a new link
              </button>
            )}
          </div>
        </>
      )}
    </div>
  );
};
