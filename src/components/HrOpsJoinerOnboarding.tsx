/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> Onboarding -> "New Joiners" (OnboardingSelfServiceRoutes.ts):
// open an application for a hired candidate (or anyone, by hand) — this
// creates the joiner's temporary login, whose password is shown once — and
// follow each application until HR approves it into an Employee.
// Every control is shown only for the layer it needs (onboarding_create /
// onboarding_review / onboarding_approve); the server checks them too.

import React, { useEffect, useState } from 'react';
import { UserPlus, X, Copy, Check, KeyRound, Clock } from 'lucide-react';
import { useHrApi, Notice, fmtDate, inputCls, labelCls, btnPrimary, btnGhost, type HrOpsMeta } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

export interface OnboardingAccess {
  onboarding_create: boolean;
  onboarding_review: boolean;
  onboarding_approve: boolean;
}

interface Application {
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
  submitted_at: string | null;
  expires_in_seconds: number | null;
  created_by_name: string | null;
  created_at: string | null;
  documents: number;
}
interface HiredCandidate {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  posting_title: string | null;
  designation: string | null;
  department: string | null;
}
interface Credentials {
  name: string;
  login_id: string;
  password: string;
}

const STATUS: Record<Application['status'], { label: string; cls: string }> = {
  draft: { label: 'Waiting for joiner', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  submitted: { label: 'Submitted — to review', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  rejected: { label: 'Sent back', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  approved: { label: 'Approved', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  cancelled: { label: 'Cancelled', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  expired: { label: 'Expired', cls: 'bg-slate-100 text-slate-500 border-slate-200' }
};

// Same liquid-glass card as every other popup (CLAUDE.md).
const GlassModal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode }> = ({ title, onClose, children, footer }) => (
  <div className="liquid-glass-backdrop fixed inset-0 z-[90] flex items-end sm:items-center justify-center p-3 sm:p-4" onClick={onClose} role="presentation">
    <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
      <div className="liquid-glass liquid-glass-in rounded-[32px] max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 pb-4 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="px-5 pb-5 flex gap-2.5">{footer}</div>}
      </div>
    </div>
  </div>
);

const ListSkeleton: React.FC = () => (
  <div className="rounded-xl border border-slate-200 overflow-hidden animate-pulse" aria-busy="true" aria-label="Loading new joiners">
    <div className="bg-slate-50 px-3 py-2.5 grid grid-cols-[2fr_2fr_1fr_1fr] gap-4">
      {[16, 20, 12, 14].map((w, i) => (
        <div key={i} className="h-3 rounded bg-slate-200" style={{ width: `${w * 4}px` }} />
      ))}
    </div>
    {Array.from({ length: 5 }, (_, i) => (
      <div key={i} className="border-t border-slate-100 px-3 py-3 grid grid-cols-[2fr_2fr_1fr_1fr] gap-4 items-center">
        <div className="space-y-1.5">
          <div className={`h-3 rounded bg-slate-200 ${i % 2 ? 'w-28' : 'w-36'}`} />
          <div className="h-2.5 w-16 rounded bg-slate-100" />
        </div>
        <div className="h-3 w-32 rounded bg-slate-100" />
        <div className="h-5 w-20 rounded-full bg-slate-100" />
        <div className="h-3 w-16 rounded bg-slate-100" />
      </div>
    ))}
  </div>
);

const CredentialsCard: React.FC<{ creds: Credentials; onClose: () => void }> = ({ creds, onClose }) => {
  const [copied, setCopied] = useState(false);
  const text = `Login ID: ${creds.login_id}\nTemporary password: ${creds.password}`;
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(true);
    } catch {
      // clipboard blocked — the values stay on screen to copy by hand
    }
  };
  return (
    <GlassModal
      title="Joiner's login"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={copy} className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700 inline-flex items-center justify-center gap-1.5">
            {copied ? <Check className="w-4 h-4" /> : <Copy className="w-4 h-4" />} {copied ? 'Copied' : 'Copy'}
          </button>
          <button type="button" onClick={onClose} className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold">
            Done
          </button>
        </>
      }
    >
      <p className="text-sm text-slate-600">
        Give these to <b>{creds.name}</b>. They sign in with them, set their own password and fill in their details.
      </p>
      <div className="liquid-glass-inset rounded-2xl mt-3 px-4 py-3 space-y-2 font-mono text-sm">
        <div className="flex justify-between gap-3">
          <span className="text-slate-500">Login ID</span>
          <span className="font-bold text-slate-900 select-all">{creds.login_id}</span>
        </div>
        <div className="flex justify-between gap-3">
          <span className="text-slate-500">Password</span>
          <span className="font-bold text-slate-900 select-all">{creds.password}</span>
        </div>
      </div>
      <p className="text-xs text-amber-700 mt-3">This password is not shown again. If it's lost, use "New password" on the application.</p>
    </GlassModal>
  );
};

const NewJoinerForm: React.FC<{ token: string; meta: HrOpsMeta; onClose: () => void; onCreated: (c: Credentials) => void }> = ({ token, meta, onClose, onCreated }) => {
  const api = useHrApi(token);
  const [candidates, setCandidates] = useState<HiredCandidate[] | null>(null);
  const [candidateId, setCandidateId] = useState<number | ''>('');
  const [f, setF] = useState({ name: '', email: '', phone: '', designation: '', department_id: '', branch_id: '', joining_date: '' });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    api.get<HiredCandidate[]>('/api/hr-ops/joiner-onboarding/hired-candidates').then(setCandidates).catch(() => setCandidates([]));
  }, [api]);
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setF((p) => ({ ...p, [k]: e.target.value }));
  const pick = (id: string) => {
    setCandidateId(id ? Number(id) : '');
    const c = candidates?.find((x) => x.id === Number(id));
    if (!c) return;
    const dept = meta.departments.find((d) => c.department && d.name.toLowerCase() === c.department.toLowerCase());
    setF((p) => ({
      ...p,
      name: c.name || '',
      email: c.email || '',
      phone: c.phone || '',
      designation: c.designation || p.designation,
      department_id: dept ? String(dept.id) : p.department_id
    }));
  };
  const submit = async () => {
    setError('');
    if (!f.name.trim()) return setError('Name is required.');
    if (!f.joining_date) return setError('Joining date is required.');
    setSaving(true);
    try {
      const r = await api.post<{ login_id: string; password: string }>('/api/hr-ops/joiner-onboarding', {
        ...f,
        candidate_id: candidateId || null,
        department_id: f.department_id ? Number(f.department_id) : null,
        branch_id: f.branch_id ? Number(f.branch_id) : null
      });
      onCreated({ name: f.name.trim(), login_id: r.login_id, password: r.password });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <GlassModal
      title="New joiner"
      onClose={onClose}
      footer={
        <>
          <button type="button" onClick={onClose} className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700">
            Cancel
          </button>
          <button type="button" onClick={submit} disabled={saving} className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold disabled:opacity-50">
            {saving ? 'Creating…' : 'Create login'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Hired candidate (Recruitment)</label>
          <select value={candidateId} onChange={(e) => pick(e.target.value)} className={inputCls} disabled={!candidates}>
            <option value="">{candidates === null ? 'Loading…' : candidates.length ? '— Not from Recruitment —' : 'No hired candidates waiting'}</option>
            {(candidates || []).map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
                {c.posting_title ? ` — ${c.posting_title}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Full name *</label>
          <input value={f.name} onChange={set('name')} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Email</label>
            <input type="email" value={f.email} onChange={set('email')} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Phone</label>
            <input value={f.phone} onChange={set('phone')} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Designation</label>
          <input value={f.designation} onChange={set('designation')} className={inputCls} />
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Department</label>
            <select value={f.department_id} onChange={set('department_id')} className={inputCls}>
              <option value="">—</option>
              {meta.departments.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Branch</label>
            <select value={f.branch_id} onChange={set('branch_id')} className={inputCls}>
              <option value="">—</option>
              {meta.branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.name}
                </option>
              ))}
            </select>
          </div>
        </div>
        <div>
          <label className={labelCls}>Joining date *</label>
          <input type="date" value={f.joining_date} onChange={set('joining_date')} className={inputCls} />
        </div>
        <p className="text-[11px] text-slate-500">
          The joiner gets a temporary login (ONB-…) and a password shown to you once. They aren't an Employee until you approve their details.
        </p>
        {error && <div className="text-xs text-rose-600">{error}</div>}
      </div>
    </GlassModal>
  );
};

export const HrOpsJoinerOnboarding: React.FC<{ token: string; meta: HrOpsMeta; access: OnboardingAccess }> = ({ token, meta, access }) => {
  const api = useHrApi(token);
  const [apps, setApps] = useState<Application[] | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [creds, setCreds] = useState<Credentials | null>(null);

  const load = () =>
    api
      .get<Application[]>('/api/hr-ops/joiner-onboarding')
      .then(setApps)
      .catch((e) => {
        setApps([]);
        setMsg({ type: 'error', text: e.message });
      });
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const resetPassword = async (a: Application) => {
    if (!(await confirmDialog(`Make a new temporary password for ${a.name}? The old one stops working and they are signed out.`, { title: 'New password', confirmLabel: 'Make new password', tone: 'default' }))) return;
    try {
      const r = await api.post<{ login_id: string; password: string }>(`/api/hr-ops/joiner-onboarding/${a.id}/reset-password`);
      setCreds({ name: a.name, login_id: r.login_id, password: r.password });
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };

  const daysLeft = (secs: number | null) => (secs === null ? null : Math.max(0, Math.ceil(secs / 86_400)));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <p className="text-xs text-slate-500 max-w-xl">
          A hired candidate gets a temporary login to fill in their own details and documents. They become an Employee only when you approve them.
        </p>
        {access.onboarding_create && (
          <button type="button" className={btnPrimary} onClick={() => setCreating(true)}>
            <UserPlus className="w-3.5 h-3.5" /> New joiner
          </button>
        )}
      </div>
      <Notice msg={msg} onClose={() => setMsg(null)} />

      {!apps ? (
        <ListSkeleton />
      ) : apps.length === 0 ? (
        <div className="rounded-xl border border-dashed border-slate-300 py-12 text-center text-sm text-slate-500">No new joiners yet.</div>
      ) : (
        <div className="overflow-x-auto rounded-xl border border-slate-200">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500">
              <tr>
                <th className="px-3 py-2 font-semibold">Joiner</th>
                <th className="px-3 py-2 font-semibold">Position</th>
                <th className="px-3 py-2 font-semibold">Status</th>
                <th className="px-3 py-2 font-semibold">Joining</th>
                <th className="px-3 py-2 font-semibold" />
              </tr>
            </thead>
            <tbody>
              {apps.map((a) => {
                const left = ['draft', 'rejected'].includes(a.status) ? daysLeft(a.expires_in_seconds) : null;
                return (
                  <tr key={a.id} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2.5">
                      <div className="font-semibold text-slate-800">{a.name}</div>
                      <div className="text-slate-500 font-mono">{a.onb_code}</div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">{[a.designation, a.department, a.branch].filter(Boolean).join(' · ') || '—'}</td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${STATUS[a.status].cls}`}>{STATUS[a.status].label}</span>
                      {left !== null && (
                        <div className={`mt-1 flex items-center gap-1 text-[10px] ${left <= 3 ? 'text-amber-700' : 'text-slate-400'}`}>
                          <Clock className="w-3 h-3" /> {left} day{left === 1 ? '' : 's'} left
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{fmtDate(a.joining_date)}</td>
                    <td className="px-3 py-2.5 text-right">
                      {access.onboarding_create && ['draft', 'rejected', 'submitted'].includes(a.status) && (
                        <button type="button" className={btnGhost} onClick={() => resetPassword(a)} title="Make a new temporary password">
                          <KeyRound className="w-3.5 h-3.5" /> New password
                        </button>
                      )}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {creating && (
        <NewJoinerForm
          token={token}
          meta={meta}
          onClose={() => setCreating(false)}
          onCreated={(c) => {
            setCreating(false);
            setCreds(c);
            load();
          }}
        />
      )}
      {creds && <CredentialsCard creds={creds} onClose={() => setCreds(null)} />}
    </div>
  );
};
