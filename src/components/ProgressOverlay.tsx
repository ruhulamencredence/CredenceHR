/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { apiUrl } from '../lib/api';

// A "% done" loader for long Data Import jobs (Excel import, Rate File import,
// Delete budget, Remove unused rows, Approve & Calculate), so the wait doesn't
// feel stuck. Uploads report real progress (xhrJson below); the server's own
// work can't report back, so that part eases toward the cap and jumps to 100%
// the moment the server answers.

export interface LongTaskState {
  title: string;
  stage: string;
  pct: number;
}

export function useLongTask() {
  const [state, setState] = useState<LongTaskState | null>(null);
  const timer = useRef<number | null>(null);
  const cap = useRef(0);

  const stopTimer = () => {
    if (timer.current != null) window.clearInterval(timer.current);
    timer.current = null;
  };
  useEffect(() => stopTimer, []);

  const start = useCallback((title: string, stage: string) => {
    stopTimer();
    setState({ title, stage, pct: 0 });
  }, []);

  /** Jump to (at least) pct, optionally with a new stage line. */
  const step = useCallback((pct: number, stage?: string) => {
    setState((s) => (s ? { ...s, pct: Math.max(s.pct, Math.min(99, pct)), stage: stage ?? s.stage } : s));
  }, []);

  /**
   * While waiting on the server: ease toward `to` without ever reaching it,
   * covering most of the way in about `expectedMs` (a bigger job moves slower).
   */
  const creep = useCallback((to: number, stage?: string, expectedMs = 6000) => {
    cap.current = Math.min(99, to);
    const k = Math.min(0.2, (250 * 2.5) / Math.max(1000, expectedMs));
    if (stage) setState((s) => (s ? { ...s, stage } : s));
    stopTimer();
    timer.current = window.setInterval(() => {
      setState((s) => (s ? { ...s, pct: s.pct + Math.max(0, cap.current - s.pct) * k } : s));
    }, 250);
  }, []);

  const finish = useCallback(async () => {
    stopTimer();
    setState((s) => (s ? { ...s, pct: 100, stage: 'Done' } : s));
    await new Promise((r) => setTimeout(r, 450));
    setState(null);
  }, []);

  const close = useCallback(() => {
    stopTimer();
    setState(null);
  }, []);

  return { state, start, step, creep, finish, close };
}

export const ProgressOverlay: React.FC<{ state: LongTaskState | null }> = ({ state }) => {
  if (!state) return null;
  const pct = Math.floor(state.pct);
  return createPortal(
    <div className="fixed inset-0 z-[70] bg-slate-950/50 backdrop-blur-sm flex items-center justify-center p-4" role="dialog" aria-modal="true" aria-label={state.title}>
      <div className="bg-white rounded-2xl shadow-2xl w-full max-w-sm p-6">
        <div className="flex items-start justify-between gap-3">
          <h3 className="text-sm font-bold text-slate-900">{state.title}</h3>
          <span className="text-2xl font-bold text-blue-600 tabular-nums leading-none" aria-live="polite">
            {pct}%
          </span>
        </div>
        <div
          className="mt-4 h-2.5 w-full rounded-full bg-slate-100 overflow-hidden"
          role="progressbar"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={pct}
        >
          <div className="h-full rounded-full bg-blue-600 transition-[width] duration-300 ease-out" style={{ width: `${pct}%` }} />
        </div>
        <p className="mt-3 text-xs text-slate-600">{state.stage}</p>
        <p className="mt-1 text-[11px] text-slate-400">Please keep this page open until it finishes.</p>
      </div>
    </div>,
    document.body
  );
};

/**
 * fetch-like JSON request that reports upload progress (0–1). Resolves like
 * fetch: { ok, status, data } — never rejects on an HTTP error status.
 */
export function xhrJson(
  path: string,
  opts: { method?: string; token: string; body?: any; onUpload?: (fraction: number) => void }
): Promise<{ ok: boolean; status: number; data: any }> {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    xhr.open(opts.method || 'GET', apiUrl(path));
    xhr.setRequestHeader('Authorization', `Bearer ${opts.token}`);
    if (opts.body !== undefined) xhr.setRequestHeader('Content-Type', 'application/json');
    if (opts.onUpload) {
      xhr.upload.onprogress = (e) => {
        if (e.lengthComputable && e.total > 0) opts.onUpload!(e.loaded / e.total);
      };
    }
    xhr.onload = () => {
      let data: any = {};
      try {
        data = xhr.responseText ? JSON.parse(xhr.responseText) : {};
      } catch {
        data = {};
      }
      resolve({ ok: xhr.status >= 200 && xhr.status < 300, status: xhr.status, data });
    };
    xhr.onerror = () => reject(new Error('Network error — check the connection and try again.'));
    xhr.send(opts.body !== undefined ? JSON.stringify(opts.body) : null);
  });
}
