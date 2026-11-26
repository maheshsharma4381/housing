'use client';

import React, { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { AlertTriangle, CheckCircle2, Info, X, XCircle } from 'lucide-react';
import { Button } from './Button';
import { cn } from './cn';

/*
 * Confirm and prompt dialogs and toasts (brief section 6), in place of window.confirm, window.prompt
 * and success boxes that stay on the page. Call confirmDialog / promptDialog / toast from any handler;
 * <FeedbackHost /> in the root layout draws them.
 */

export interface ConfirmOptions {
  title: string;
  /** what will happen, in plain words */
  body?: React.ReactNode;
  confirmText?: string;
  cancelText?: string;
  /** danger: a red button, for anything that removes, cancels or cannot be undone */
  tone?: 'primary' | 'danger';
}

export interface PromptOptions extends ConfirmOptions {
  label: string;
  defaultValue?: string;
  placeholder?: string;
  /** at least this many characters (after trimming); 1 makes it required */
  minLength?: number;
  multiline?: boolean;
}

type DialogState =
  | { kind: 'confirm'; opts: ConfirmOptions; resolve: (ok: boolean) => void }
  | { kind: 'prompt'; opts: PromptOptions; resolve: (value: string | null) => void };

export type ToastTone = 'success' | 'error' | 'info';
interface Toast { id: number; tone: ToastTone; message: React.ReactNode }

let dialog: DialogState | null = null;
let toasts: Toast[] = [];
let nextId = 1;
const listeners = new Set<() => void>();
const emit = () => listeners.forEach(l => l());
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

/** A new dialog replaces one still open, which counts as cancelled. */
function cancelOpen() {
  const d = dialog;
  dialog = null;
  if (d?.kind === 'confirm') d.resolve(false);
  else if (d) d.resolve(null);
}

/** Asks a yes/no question in a dialog; resolves true when confirmed. */
export function confirmDialog(opts: ConfirmOptions): Promise<boolean> {
  return new Promise(resolve => {
    cancelOpen();
    dialog = { kind: 'confirm', opts, resolve };
    emit();
  });
}

/** Asks for a line of text (a reason, a note); resolves null when cancelled. */
export function promptDialog(opts: PromptOptions): Promise<string | null> {
  return new Promise(resolve => {
    cancelOpen();
    dialog = { kind: 'prompt', opts, resolve };
    emit();
  });
}

/** Hook names from the brief; they return the same functions. */
export const useConfirm = () => confirmDialog;
export const usePrompt = () => promptDialog;

function push(tone: ToastTone, message: React.ReactNode, ms: number) {
  const id = nextId++;
  toasts = [...toasts, { id, tone, message }].slice(-3);
  emit();
  window.setTimeout(() => dismissToast(id), ms);
}
export function dismissToast(id: number) {
  toasts = toasts.filter(t => t.id !== id);
  emit();
}

/** Short messages that disappear on their own; errors that need action stay inline instead. */
export const toast = {
  success: (message: React.ReactNode) => push('success', message, 4000),
  info: (message: React.ReactNode) => push('info', message, 5000),
  error: (message: React.ReactNode) => push('error', message, 7000),
};

const close = (value: boolean | string | null) => {
  const d = dialog;
  dialog = null;
  emit();
  if (!d) return;
  if (d.kind === 'confirm') d.resolve(value === true);
  else d.resolve(typeof value === 'string' ? value : null);
};

const TOAST_ICON = { success: CheckCircle2, error: XCircle, info: Info };
const TOAST_TONE = { success: 'text-success', error: 'text-danger', info: 'text-info' };

/** Draws the open dialog and the toasts. Mount once, in the root layout. */
export const FeedbackHost: React.FC = () => {
  const d = useSyncExternalStore(subscribe, () => dialog, () => null);
  const list = useSyncExternalStore(subscribe, () => toasts, () => toasts);
  return (
    <>
      {d && <FeedbackDialog key={d.opts.title + d.kind} state={d} />}
      <div aria-live="polite" className="fixed z-[60] left-4 right-4 bottom-[calc(5rem+env(safe-area-inset-bottom))] md:left-auto md:right-6 md:bottom-6 md:w-96 flex flex-col gap-2 pointer-events-none print:hidden">
        {list.map(t => {
          const Icon = TOAST_ICON[t.tone];
          return (
            <div key={t.id} role={t.tone === 'error' ? 'alert' : 'status'}
              className="pointer-events-auto flex items-start gap-3 rounded-xl bg-surface border border-border shadow-pop px-4 py-3 text-sm text-fg">
              <Icon className={cn('w-5 h-5 shrink-0 mt-px', TOAST_TONE[t.tone])} aria-hidden="true" />
              <div className="flex-1 min-w-0 leading-5">{t.message}</div>
              <button type="button" aria-label="Dismiss" onClick={() => dismissToast(t.id)} className="text-fg-subtle hover:text-fg cursor-pointer">
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
      </div>
    </>
  );
};

const FeedbackDialog: React.FC<{ state: DialogState }> = ({ state }) => {
  const ref = useRef<HTMLDialogElement>(null);
  const titleId = useId();
  const fieldId = useId();
  const { opts } = state;
  const prompt = state.kind === 'prompt' ? state.opts : null;
  const [value, setValue] = useState(prompt?.defaultValue ?? '');
  const [touched, setTouched] = useState(false);
  const min = prompt?.minLength ?? 0;
  const tooShort = prompt != null && value.trim().length < min;

  useEffect(() => {
    const el = ref.current;
    if (el && !el.open) el.showModal();
  }, []);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!prompt) return close(true);
    setTouched(true);
    if (tooShort) return;
    close(value.trim());
  };

  const danger = opts.tone === 'danger';
  const fieldCls = 'w-full rounded-lg border border-border-strong bg-surface px-3 text-base sm:text-sm text-fg outline-none focus:border-brand focus:ring-2 focus:ring-brand/20';

  return (
    <dialog
      ref={ref}
      aria-labelledby={titleId}
      onCancel={e => { e.preventDefault(); close(state.kind === 'confirm' ? false : null); }}
      onClick={e => { if (e.target === ref.current) close(state.kind === 'confirm' ? false : null); }}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-2xl bg-surface text-fg p-0 shadow-pop backdrop:bg-fg/40"
    >
      <form onSubmit={submit} className="p-5 sm:p-6 space-y-4">
        <div className="flex items-start gap-3">
          {danger && (
            <span className="w-10 h-10 shrink-0 rounded-full bg-danger-soft text-danger flex items-center justify-center">
              <AlertTriangle className="w-5 h-5" aria-hidden="true" />
            </span>
          )}
          <div className="min-w-0 space-y-1">
            <h2 id={titleId} className="text-base font-semibold">{opts.title}</h2>
            {opts.body && <div className="text-sm text-fg-muted leading-relaxed">{opts.body}</div>}
          </div>
        </div>
        {prompt && (
          <div className="space-y-1.5">
            <label htmlFor={fieldId} className="block text-xs font-medium text-fg-muted">{prompt.label}</label>
            {prompt.multiline ? (
              <textarea id={fieldId} autoFocus rows={3} value={value} placeholder={prompt.placeholder}
                onChange={e => setValue(e.target.value)} onBlur={() => setTouched(true)} className={cn(fieldCls, 'py-2')} />
            ) : (
              <input id={fieldId} autoFocus value={value} placeholder={prompt.placeholder}
                onChange={e => setValue(e.target.value)} onBlur={() => setTouched(true)} className={cn(fieldCls, 'h-10')} />
            )}
            {touched && tooShort && <p className="text-xs text-danger">{min <= 1 ? 'This is needed.' : `Write at least ${min} characters.`}</p>}
          </div>
        )}
        <div className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2 pt-1">
          <Button variant="secondary" onClick={() => close(state.kind === 'confirm' ? false : null)}>{opts.cancelText ?? 'Cancel'}</Button>
          <Button type="submit" variant={danger ? 'danger' : 'primary'} autoFocus={!prompt}>{opts.confirmText ?? 'Confirm'}</Button>
        </div>
      </form>
    </dialog>
  );
};
