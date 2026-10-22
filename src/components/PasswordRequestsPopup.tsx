/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Users -> Password requests (Users layer "password_requests",
// PasswordResetRoutes.ts): people who asked HR for a new password from the
// login page. "Reset" gives a one-time temporary password to pass on — they
// set their own at the next sign-in. A Superadmin also turns the two ways of
// "Forgot password?" on or off here.

import React, { useCallback, useEffect, useState } from 'react';
import { KeyRound, Loader2, Copy, Check, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { confirmDialog } from '../lib/confirmDialog';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn, Toggle } from './mail/MailPopup';

interface Req {
  id: number;
  user_id: number;
  name: string;
  email: string | null;
  username: string | null;
  role: string;
  employee_code: string | null;
  department: string | null;
  note: string | null;
  status: 'pending' | 'done' | 'rejected';
  created_at: string;
  handled_at: string | null;
  handled_by_name: string | null;
  reject_reason: string | null;
}
interface Settings {
  email_code_enabled: boolean;
  hr_request_enabled: boolean;
  mailer: boolean;
}

const timeOf = (v: string | null) => (v ? `${formatDate(v)} ${String(v).slice(11, 16)}` : '');

export const PasswordRequestsPopup: React.FC<{ token: string; onClose: () => void; onChanged?: () => void }> = ({ token, onClose, onChanged }) => {
  const [view, setView] = useState<'pending' | 'done'>('pending');
  const [rows, setRows] = useState<Req[] | null>(null);
  const [settings, setSettings] = useState<Settings | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [given, setGiven] = useState<{ name: string; temp: string } | null>(null);
  const [copied, setCopied] = useState(false);
  const [rejecting, setRejecting] = useState<Req | null>(null);
  const [reason, setReason] = useState('');
  const auth = { Authorization: `Bearer ${token}` };

  const load = useCallback(() => {
    setError('');
    fetch(apiUrl(`/api/password-requests?view=${view}`), { headers: auth })
      .then(async (r) => {
        const j = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(j.error || 'Could not load the requests');
        setRows(j.rows);
        if (j.settings) setSettings(j.settings);
      })
      .catch((e) => setError(e.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, view]);
  useEffect(() => {
    setRows(null);
    load();
  }, [load]);

  const call = async (path: string, body?: unknown) => {
    const r = await fetch(apiUrl(path), { method: 'POST', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(body || {}) });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw new Error(j.error || 'Something went wrong');
    return j;
  };
  const reset = async (q: Req) => {
    if (!(await confirmDialog(`Give ${q.name} a temporary password? Their current password stops working and every device they're signed in on is signed out.`, { confirmLabel: 'Reset password', tone: 'danger' }))) return;
    setBusy(q.id);
    setError('');
    try {
      const j = await call(`/api/password-requests/${q.id}/reset`);
      setGiven({ name: j.name, temp: j.temp_password });
      setCopied(false);
      load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
      load();
    } finally {
      setBusy(null);
    }
  };
  const reject = async () => {
    if (!rejecting) return;
    setBusy(rejecting.id);
    try {
      await call(`/api/password-requests/${rejecting.id}/reject`, { reason });
      setRejecting(null);
      setReason('');
      load();
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };
  const saveSettings = async (next: Partial<Settings>) => {
    if (!settings) return;
    const s = { ...settings, ...next };
    setSettings(s);
    const r = await fetch(apiUrl('/api/password-reset-settings'), { method: 'PUT', headers: { ...auth, 'Content-Type': 'application/json' }, body: JSON.stringify(s) });
    const j = await r.json().catch(() => ({}));
    if (r.ok) setSettings(j);
    else setError(j.error || 'Could not save');
  };

  return (
    <>
      <Popup
        title="Password requests"
        icon={<KeyRound className="w-4 h-4" />}
        size="lg"
        onClose={onClose}
        head={
          <div className="inline-flex rounded-xl bg-slate-100 p-1">
            {(['pending', 'done'] as const).map((k) => (
              <button key={k} type="button" onClick={() => setView(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${view === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>
                {k === 'pending' ? 'Waiting' : 'Handled (30 days)'}
              </button>
            ))}
          </div>
        }
      >
        <div className="space-y-3 text-left">
          {settings && (
            <div className="liquid-glass-inset rounded-[22px] p-4 space-y-3">
              <div className="text-xs font-semibold text-slate-500 uppercase tracking-wider">"Forgot password?" on the login page (Superadmin)</div>
              <Toggle
                checked={settings.email_code_enabled}
                onChange={(v) => void saveSettings({ email_code_enabled: v })}
                label="Code by email"
                hint={
                  <>
                    A 6-digit code to the account's email; they set a new password themselves.
                    {!settings.mailer && <span className="text-amber-700"> Email isn't set up on the server (SMTP in .env), so this stays hidden.</span>}
                  </>
                }
              />
              <Toggle
                checked={settings.hr_request_enabled}
                onChange={(v) => void saveSettings({ hr_request_enabled: v })}
                label="Ask HR"
                hint="The request comes here; you give a temporary password."
              />
            </div>
          )}
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          {!rows ? (
            <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
          ) : rows.length === 0 ? (
            <div className="py-8 text-center text-sm text-slate-500">{view === 'pending' ? 'No one is waiting for a new password.' : 'Nothing handled in the last 30 days.'}</div>
          ) : (
            <div className="liquid-glass-inset rounded-[22px] divide-y divide-slate-200/60">
              {rows.map((q) => (
                <div key={q.id} className="p-3 flex items-start gap-3 flex-wrap">
                  <div className="flex-1 min-w-[12rem]">
                    <div className="font-semibold text-slate-900 text-sm">
                      {q.name} <span className="text-xs font-normal text-slate-500">{[q.employee_code, q.department].filter(Boolean).join(' · ')}</span>
                    </div>
                    <div className="text-xs text-slate-500">{q.email || q.username || '—'} · asked {timeOf(q.created_at)}</div>
                    {q.note && <div className="text-xs text-slate-700 mt-0.5">“{q.note}”</div>}
                    {q.status !== 'pending' && (
                      <div className={`text-xs mt-0.5 ${q.status === 'done' ? 'text-emerald-700' : 'text-rose-700'}`}>
                        {q.status === 'done' ? 'Temporary password given' : `Turned down${q.reject_reason ? ` — ${q.reject_reason}` : ''}`} by {q.handled_by_name || '—'} · {timeOf(q.handled_at)}
                      </div>
                    )}
                  </div>
                  {q.status === 'pending' && (
                    <div className="flex gap-2">
                      <button type="button" className={ghostBtn} onClick={() => setRejecting(q)} disabled={busy === q.id}>
                        Turn down
                      </button>
                      <button type="button" className={primaryBtn} onClick={() => void reset(q)} disabled={busy === q.id}>
                        {busy === q.id && <Loader2 className="w-4 h-4 animate-spin" />} Reset password
                      </button>
                    </div>
                  )}
                </div>
              ))}
            </div>
          )}
          <p className="text-[11px] text-slate-500">Check who is asking (call them, or see them in person) before resetting — anyone who knows a Login ID can send a request.</p>
        </div>
      </Popup>

      {given && (
        <Popup
          title="Temporary password"
          icon={<KeyRound className="w-4 h-4" />}
          size="md"
          onClose={() => setGiven(null)}
          footer={<button type="button" className={primaryBtn} onClick={() => setGiven(null)}>Done</button>}
        >
          <div className="space-y-3 text-left">
            <p className="text-sm text-slate-700">Give this to <b>{given.name}</b>. It is shown only now. They choose their own password when they sign in with it.</p>
            <div className="liquid-glass-inset rounded-[22px] p-4 flex items-center justify-between gap-3">
              <span className="text-2xl font-bold tracking-wider text-slate-900 select-all">{given.temp}</span>
              <button
                type="button"
                className="liquid-glass-chip w-10 h-10 rounded-full flex items-center justify-center"
                aria-label="Copy"
                onClick={() => {
                  navigator.clipboard?.writeText(given.temp).then(() => setCopied(true)).catch(() => {});
                }}
              >
                {copied ? <Check className="w-4 h-4 text-emerald-600" /> : <Copy className="w-4 h-4" />}
              </button>
            </div>
          </div>
        </Popup>
      )}

      {rejecting && (
        <Popup
          title={`Turn down ${rejecting.name}'s request`}
          icon={<X className="w-4 h-4" />}
          size="md"
          onClose={() => setRejecting(null)}
          footer={
            <>
              <button type="button" className={ghostBtn} onClick={() => setRejecting(null)}>Cancel</button>
              <button type="button" className={primaryBtn} style={{ '--g-accent': '#e11d48' } as React.CSSProperties} onClick={() => void reject()} disabled={busy === rejecting.id}>
                Turn down
              </button>
            </>
          }
        >
          <div className="space-y-2 text-left">
            <p className="text-sm text-slate-700">Their password stays as it is. Use this for a request they didn't send.</p>
            <label className={labelCls}>Reason (optional)</label>
            <input className={inputCls} value={reason} maxLength={255} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Not sent by them" />
          </div>
        </Popup>
      )}
    </>
  );
};
