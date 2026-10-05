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
