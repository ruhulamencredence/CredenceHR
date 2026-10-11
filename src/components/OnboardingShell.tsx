/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "My Onboarding" — the whole app for a new joiner's temporary login
// (OnboardingSelfServiceRoutes.ts). Shown instead of <App /> (see main.tsx),
// so none of the normal app's background calls (alerts, chat, push,
// tracking…) run for this account; the server refuses them anyway.
// First the joiner replaces the temporary password HR gave them, then fills
// in their details and documents and submits them to HR.

import React, { useCallback, useEffect, useState } from 'react';
import { ClipboardCheck, Lock, LogOut, Clock, CheckCircle2, AlertTriangle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import type { User } from '../types';

export const SESSION_CHANGED_EVENT = 'credence:session-changed';

interface MyApplication {
  id: number;
  onb_code: string;
  name: string;
  designation: string | null;
  department: string | null;
  branch: string | null;
  joining_date: string | null;
  email: string | null;
  phone: string | null;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  review_remarks: string | null;
  submitted_at: string | null;
  expires_in_seconds: number | null;
  must_change_password: boolean;
}

// Ends this sign-in on this device and goes back to the sign-in page.
export function signOutOnboarding(token: string | null) {
  if (token) void fetch(apiUrl('/api/auth/logout'), { method: 'POST', headers: { Authorization: `Bearer ${token}` }, keepalive: true }).catch(() => {});
  try {
    localStorage.removeItem('mpr_token');
    localStorage.removeItem('mpr_user');
  } catch {
    // storage unavailable
  }
  window.dispatchEvent(new Event(SESSION_CHANGED_EVENT));
}

const daysLeft = (secs: number | null) => (secs === null || !Number.isFinite(secs) ? null : Math.max(0, Math.ceil(secs / 86_400)));
const fmtDate = (d: string | null) => (d ? new Date(`${String(d).slice(0, 10)}T00:00:00`).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }) : '—');

const inputCls = 'w-full text-sm px-3 py-2.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none';

const ShellSkeleton: React.FC = () => (
  <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading">
    <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
      <div className="h-4 w-40 rounded bg-slate-200" />
      <div className="h-3 w-64 rounded bg-slate-100" />
      <div className="grid grid-cols-2 gap-3 pt-2">
        {Array.from({ length: 4 }, (_, i) => (
          <div key={i} className="space-y-1.5">
            <div className="h-2.5 w-16 rounded bg-slate-100" />
            <div className="h-3 w-28 rounded bg-slate-200" />
          </div>
        ))}
      </div>
    </div>
    <div className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
      <div className="h-4 w-32 rounded bg-slate-200" />
      <div className="h-10 rounded-xl bg-slate-100" />
      <div className="h-10 rounded-xl bg-slate-100" />
    </div>
  </div>
);

const ChangeTempPassword: React.FC<{ token: string; onDone: () => void }> = ({ token, onDone }) => {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const [confirm, setConfirm] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    if (next.length < 6) return setError('New password must be at least 6 characters.');
    if (next !== confirm) return setError('New password and confirmation do not match.');
    if (next === current) return setError('Choose a password different from the temporary one.');
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/profile/password'), {
        method: 'PUT',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: current, new_password: next })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not change your password.');
      onDone();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <form onSubmit={submit} className="rounded-2xl border border-slate-200 bg-white p-5 space-y-3">
      <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
        <Lock className="w-4 h-4 text-blue-600" /> Set your own password
      </div>
      <p className="text-xs text-slate-500">HR gave you a temporary password. Replace it with one only you know before you continue.</p>
      <input type="password" autoComplete="current-password" placeholder="Temporary password" value={current} onChange={(e) => setCurrent(e.target.value)} className={inputCls} />
      <input type="password" autoComplete="new-password" placeholder="New password (at least 6 characters)" value={next} onChange={(e) => setNext(e.target.value)} className={inputCls} />
      <input type="password" autoComplete="new-password" placeholder="Confirm new password" value={confirm} onChange={(e) => setConfirm(e.target.value)} className={inputCls} />
      {error && <div className="text-xs text-rose-600">{error}</div>}
      <button type="submit" disabled={saving || !current || !next} className="w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50">
        {saving ? 'Saving…' : 'Save password'}
      </button>
    </form>
  );
};

export const OnboardingShell: React.FC<{ token: string; user: User }> = ({ token, user }) => {
  const [app, setApp] = useState<MyApplication | null>(null);
  const [error, setError] = useState('');

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/onboarding/me'), { headers: { Authorization: `Bearer ${token}` } });
      // Signed out elsewhere, expired, blocked or already approved — back to sign-in.
      if (res.status === 401) return signOutOnboarding(null);
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not load your onboarding.');
      setApp(json);
    } catch (err: any) {
      setError(err.message);
    }
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);

  const left = daysLeft(app?.expires_in_seconds ?? null);

  return (
    <div className="min-h-screen bg-slate-50">
      <header className="sticky top-0 z-10 bg-white/90 backdrop-blur border-b border-slate-200" style={{ paddingTop: 'var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px))' }}>
        <div className="max-w-2xl mx-auto px-4 h-14 flex items-center justify-between gap-3">
          <div className="flex items-center gap-2 min-w-0">
            <div className="w-8 h-8 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
              <ClipboardCheck className="w-4 h-4 text-blue-600" />
            </div>
            <div className="min-w-0">
              <div className="text-sm font-bold text-slate-900 leading-tight">My Onboarding</div>
              <div className="text-[11px] text-slate-500 truncate">
                {user.name} · {app?.onb_code || user.username}
              </div>
            </div>
          </div>
          <button
            type="button"
            onClick={() => signOutOnboarding(token)}
            className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50"
          >
            <LogOut className="w-3.5 h-3.5" /> Sign out
          </button>
        </div>
      </header>

      <main className="max-w-2xl mx-auto px-4 py-5 space-y-4">
        {error && <div className="rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm text-rose-700">{error}</div>}
        {!app ? (
          !error && <ShellSkeleton />
        ) : (
          <>
            <section className="rounded-2xl border border-slate-200 bg-white p-5">
              <div className="text-base font-bold text-slate-900">Welcome, {app.name}</div>
              <p className="text-xs text-slate-500 mt-0.5">Give HR your details and documents here. Once HR approves them you get your Employee ID and full access.</p>
              <dl className="grid grid-cols-2 gap-x-4 gap-y-3 mt-4 text-xs">
                {[
                  ['Designation', app.designation],
                  ['Department', app.department],
                  ['Branch', app.branch],
                  ['Joining date', fmtDate(app.joining_date)]
                ].map(([k, v]) => (
                  <div key={k as string} className="min-w-0">
                    <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</dt>
                    <dd className="font-medium text-slate-800 truncate">{v || '—'}</dd>
                  </div>
                ))}
              </dl>
              {app.status === 'submitted' ? (
                <div className="mt-4 flex items-center gap-2 rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2 text-xs text-emerald-800">
                  <CheckCircle2 className="w-4 h-4 shrink-0" /> Submitted — HR is reviewing your details.
                </div>
              ) : left !== null ? (
                <div className={`mt-4 flex items-center gap-2 rounded-xl px-3 py-2 text-xs border ${left <= 3 ? 'bg-amber-50 border-amber-200 text-amber-800' : 'bg-slate-50 border-slate-200 text-slate-600'}`}>
                  <Clock className="w-4 h-4 shrink-0" /> {left === 0 ? 'Your onboarding login expires today.' : `Submit within ${left} day${left === 1 ? '' : 's'} — after that this login stops working.`}
                </div>
              ) : null}
              {app.status === 'rejected' && app.review_remarks && (
                <div className="mt-3 flex items-start gap-2 rounded-xl bg-rose-50 border border-rose-200 px-3 py-2 text-xs text-rose-800">
                  <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>
                    <b>HR sent this back:</b> {app.review_remarks}
                  </span>
                </div>
              )}
            </section>

            {app.must_change_password ? (
              <ChangeTempPassword
                token={token}
                onDone={() => {
                  setApp((a) => (a ? { ...a, must_change_password: false } : a));
                  load();
                }}
              />
            ) : (
              <section className="rounded-2xl border border-dashed border-slate-300 bg-white p-6 text-center">
                <div className="text-sm font-semibold text-slate-800">Your details form</div>
                <p className="text-xs text-slate-500 mt-1">Personal details, address, emergency contact, nominee and documents will be filled in here.</p>
              </section>
            )}
          </>
        )}
      </main>
    </div>
  );
};
