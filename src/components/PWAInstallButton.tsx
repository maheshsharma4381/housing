'use client';

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { usePWAInstall } from '../hooks/usePWAInstall';
import { Download, Smartphone, X } from 'lucide-react';
import { Button, IconButton } from './ui/Button';
import { LogoMark } from './ui/Logo';

export const PWAInstallButton: React.FC = () => {
  const { isInstallable, isInstalled, isIOS, install } = usePWAInstall();
  const [showIOSGuide, setShowIOSGuide] = useState(false);

  // Hide button if already installed in standalone mode
  if (isInstalled) {
    return null;
  }

  // Chromium / Android / Desktop flow
  if (isInstallable) {
    return (
      <Button size="sm" onClick={install} title="Add Sahvaas to your home screen" leftIcon={<Download className="w-4 h-4" />}>
        <span className="sr-only sm:not-sr-only">Install app</span>
      </Button>
    );
  }

  // iOS Safari flow
  if (isIOS) {
    return (
      <>
        <Button size="sm" variant="secondary" onClick={() => setShowIOSGuide(true)} leftIcon={<Smartphone className="w-4 h-4" />}>
          <span className="sr-only sm:not-sr-only">Install app</span>
        </Button>

        {/* portalled: a blurred sticky header would otherwise trap a fixed overlay inside it (WebKit) */}
        {showIOSGuide && typeof document !== 'undefined' && createPortal(
          <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-fg/40 p-0 sm:p-4" onClick={() => setShowIOSGuide(false)}>
            <div role="dialog" aria-modal="true" aria-labelledby="ios-install-title" onClick={e => e.stopPropagation()}
              className="w-full sm:max-w-sm rounded-t-2xl sm:rounded-2xl bg-surface p-6 shadow-pop">
              <div className="flex items-center justify-between gap-3 pb-3 border-b border-border">
                <div className="flex items-center gap-2.5">
                  <LogoMark size={32} />
                  <h3 id="ios-install-title" className="text-base font-semibold text-fg">Install on iPhone or iPad</h3>
                </div>
                <IconButton variant="ghost" label="Close" onClick={() => setShowIOSGuide(false)}><X className="w-5 h-5" /></IconButton>
              </div>
              <ol className="mt-4 space-y-3 text-sm text-fg-muted">
                {[
                  <>Tap the <strong className="text-fg">Share</strong> button in Safari&apos;s toolbar.</>,
                  <>Scroll down and tap <strong className="text-fg">Add to Home Screen</strong>.</>,
                  <>Tap <strong className="text-fg">Add</strong> at the top right. Sahvaas opens full screen from your home screen.</>,
                ].map((step, i) => (
                  <li key={i} className="flex items-start gap-3">
                    <span className="w-6 h-6 rounded-full bg-brand-soft text-brand-ink text-xs font-semibold flex items-center justify-center shrink-0">{i + 1}</span>
                    <p className="pt-0.5">{step}</p>
                  </li>
                ))}
              </ol>
              <p className="mt-3 text-xs text-fg-subtle">Opened the link inside WhatsApp? Open it in Safari first (⋯ → Open in Safari).</p>
              <Button className="mt-5 w-full" onClick={() => setShowIOSGuide(false)}>Got it</Button>
            </div>
          </div>, document.body)}
      </>
    );
  }

  return null;
};
