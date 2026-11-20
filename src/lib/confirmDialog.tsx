/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The app's own "Are you sure?" popup, in place of the browser's
// window.confirm() — same liquid-glass look as every other popup (see
// CLAUDE.md -> Popup style). Promise-based, so a call site reads:
//
//   if (!(await confirmDialog('Delete this notice? This cannot be undone.'))) return;
//
// Mounts itself into <body> on first use; no provider needed.

import React, { useEffect, useRef } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { AlertTriangle, HelpCircle } from 'lucide-react';

export interface ConfirmOptions {
  title?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // 'danger' = red confirm button and warning icon. Worked out from the
  // message when not given (delete / remove / reject / cancel …).
  tone?: 'danger' | 'default';
}

const DANGER_RE = /\b(delete|remove|erase|reject|cancel|unlink|stop|leave|end|undo|permanently|close)\b/i;
// First words of the message that make a better button than "Confirm".
const VERB_RE =
  /^(permanently delete|permanently erase|final submit|mark|delete|remove|reject|cancel|unlink|stop|leave|close|end|open|import|apply|submit|turn on|turn off|erase)\b/i;

let root: Root | null = null;
let host: HTMLDivElement | null = null;

function ConfirmCard({
  message,
  options,
  onDone
}: {
  message: string;
  options: Required<Pick<ConfirmOptions, 'tone'>> & ConfirmOptions;
  onDone: (ok: boolean) => void;
}) {
  const okRef = useRef<HTMLButtonElement>(null);
  const danger = options.tone === 'danger';
  useEffect(() => {
    okRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);
  const Icon = danger ? AlertTriangle : HelpCircle;
  return (
    <div
      className="liquid-glass-backdrop fixed inset-0 z-[1000] flex items-center justify-center p-4"
      onClick={() => onDone(false)}
      role="presentation"
    >
      <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()} role="alertdialog" aria-modal="true" aria-label={options.title}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5">
          <div className="flex items-start gap-3.5">
            <div
              className={`liquid-glass-inset w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${
                danger ? 'text-rose-600' : 'text-violet-600'
              }`}
            >
              <Icon className="w-5 h-5" />
            </div>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-base font-bold text-slate-900">{options.title}</h3>
              <p className="mt-1 text-sm text-slate-600 whitespace-pre-line break-words">{message}</p>
            </div>
          </div>
          <div className="mt-5 flex gap-2.5">
            <button
              type="button"
              onClick={() => onDone(false)}
              className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700"
            >
              {options.cancelLabel}
            </button>
            <button
              ref={okRef}
              type="button"
              onClick={() => onDone(true)}
              className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold"
              style={danger ? ({ '--g-accent': '#e11d48' } as React.CSSProperties) : undefined}
            >
              {options.confirmLabel}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

let pending: Promise<unknown> = Promise.resolve();

export function confirmDialog(message: string, opts: ConfirmOptions = {}): Promise<boolean> {
  const text = String(message ?? '').trim();
  const tone = opts.tone || (DANGER_RE.test(text) ? 'danger' : 'default');
  const verb = text.match(VERB_RE)?.[1];
  const verbLabel = verb ? verb.charAt(0).toUpperCase() + verb.slice(1).toLowerCase() : null;
  // "Cancel this request?" — the cancel button can't also say "Cancel".
  const isCancelVerb = verbLabel === 'Cancel';
  const options = {
    tone,
    title: opts.title || (tone === 'danger' ? 'Are you sure?' : 'Please confirm'),
    confirmLabel: opts.confirmLabel || (isCancelVerb ? 'Yes, cancel' : verbLabel || 'Confirm'),
    cancelLabel: opts.cancelLabel || (isCancelVerb ? 'Keep' : 'Cancel')
  };
  // One popup at a time; a second call waits for the first to close.
  const result = pending.then(
    () =>
      new Promise<boolean>((resolve) => {
        if (!host) {
          host = document.createElement('div');
          host.setAttribute('data-confirm-dialog', '');
          document.body.appendChild(host);
          root = createRoot(host);
        }
        const done = (ok: boolean) => {
          root!.render(<></>);
          resolve(ok);
        };
        root!.render(<ConfirmCard key={Date.now()} message={text} options={options} onDone={done} />);
      })
  );
  pending = result.catch(() => undefined);
  return result;
}

// The same card with a box to type in — e.g. why a ride starts early.
// Resolves with the trimmed text, or null when cancelled.
export interface PromptOptions {
  title?: string;
  placeholder?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  // The confirm button stays off until this many characters are typed.
  minLength?: number;
}

function PromptCard({ message, options, onDone }: { message: string; options: PromptOptions; onDone: (v: string | null) => void }) {
  const [text, setText] = React.useState('');
  const boxRef = useRef<HTMLTextAreaElement>(null);
  const min = options.minLength ?? 1;
  const ready = text.trim().length >= min;
  useEffect(() => {
    boxRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onDone(null);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onDone]);
  return (
    <div className="liquid-glass-backdrop fixed inset-0 z-[1000] flex items-center justify-center p-4" onClick={() => onDone(null)} role="presentation">
      <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={options.title}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5">
          <div className="flex items-start gap-3.5">
            <div className="liquid-glass-inset w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 text-violet-600">
              <HelpCircle className="w-5 h-5" />
            </div>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-base font-bold text-slate-900">{options.title}</h3>
              <p className="mt-1 text-sm text-slate-600 whitespace-pre-line break-words">{message}</p>
            </div>
          </div>
          <textarea
            ref={boxRef}
            value={text}
            onChange={(e) => setText(e.target.value)}
            rows={3}
            maxLength={255}
            placeholder={options.placeholder}
            aria-label={options.placeholder || options.title}
            className="liquid-glass-inset mt-4 block w-full rounded-2xl px-3 py-2 text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
          />
          <div className="mt-4 flex gap-2.5">
            <button type="button" onClick={() => onDone(null)} className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700">
              {options.cancelLabel || 'Cancel'}
            </button>
            <button
              type="button"
              disabled={!ready}
              onClick={() => onDone(text.trim())}
              className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold disabled:opacity-50"
            >
              {options.confirmLabel || 'Continue'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

export function promptDialog(message: string, opts: PromptOptions = {}): Promise<string | null> {
  const options = { ...opts, title: opts.title || 'Please confirm' };
  const result = pending.then(
    () =>
      new Promise<string | null>((resolve) => {
        if (!host) {
          host = document.createElement('div');
          host.setAttribute('data-confirm-dialog', '');
          document.body.appendChild(host);
          root = createRoot(host);
        }
        const done = (v: string | null) => {
          root!.render(<></>);
          resolve(v);
        };
        root!.render(<PromptCard key={Date.now()} message={String(message ?? '').trim()} options={options} onDone={done} />);
      })
  );
  pending = result.catch(() => undefined);
  return result;
}
