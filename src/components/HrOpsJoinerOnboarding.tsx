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
import { UserPlus, X, Copy, Check, KeyRound, Clock, Eye, FileText, AlertTriangle, CheckCircle2, XCircle, Ban, ShieldAlert, FileSignature } from 'lucide-react';
import { useHrApi, Notice, fmtDate, inputCls, labelCls, btnPrimary, btnGhost, type HrOpsMeta, type HrOpsEmployee } from './HrOpsShared';
import { LetterComposer } from './HrOpsLetters';
import { confirmDialog } from '../lib/confirmDialog';
import { OnboardingSummary, openOnboardingFile, type OnboardingFormState } from './OnboardingForm';

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
  employee_code: string | null;
  employee_id: number | null;
  posting_title: string | null;
  // The approved joiner's Appointment Letter, once issued (HR Operations -> Letters).
  appointment_letter: { id: number; ref_no: string } | null;
  appointment_template: boolean;
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

const NewJoinerForm: React.FC<{ token: string; meta: HrOpsMeta; candidateId?: number; onClose: () => void; onCreated: (c: Credentials) => void }> = ({
  token,
  meta,
  candidateId: startCandidate,
  onClose,
  onCreated
}) => {
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
  // Opened from Recruitment for one candidate: pick them as soon as the list is in.
  useEffect(() => {
    if (startCandidate && candidates?.some((c) => c.id === startCandidate)) pick(String(startCandidate));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [candidates, startCandidate]);
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

// Recruitment (RecruitmentPanel.tsx) -> a Hired candidate's "Start onboarding":
// the same New joiner form with that candidate picked, then their login.
export const StartJoinerOnboarding: React.FC<{ token: string; candidateId: number; onClose: () => void; onCreated: () => void }> = ({ token, candidateId, onClose, onCreated }) => {
  const api = useHrApi(token);
  const [meta, setMeta] = useState<HrOpsMeta | null>(null);
  const [error, setError] = useState('');
  const [creds, setCreds] = useState<Credentials | null>(null);
  useEffect(() => {
    api.get<HrOpsMeta>('/api/hr-ops/meta').then(setMeta).catch((e) => setError(e.message));
  }, [api]);
  if (creds) return <CredentialsCard creds={creds} onClose={onClose} />;
  if (error)
    return (
      <GlassModal title="New joiner" onClose={onClose}>
        <div className="text-sm text-rose-600">{error}</div>
      </GlassModal>
    );
  if (!meta)
    return (
      <GlassModal title="New joiner" onClose={onClose}>
        <div className="space-y-3 animate-pulse" aria-busy="true" aria-label="Loading">
          {Array.from({ length: 5 }, (_, i) => (
            <div key={i} className="h-9 rounded-lg bg-slate-100" />
          ))}
        </div>
      </GlassModal>
    );
  return (
    <NewJoinerForm
      token={token}
      meta={meta}
      candidateId={candidateId}
      onClose={onClose}
      onCreated={(c) => {
        setCreds(c);
        onCreated();
      }}
    />
  );
};

interface ReviewDetail extends Omit<Application, 'documents'>, OnboardingFormState {
  review_remarks: string | null;
  reviewed_by_name: string | null;
  reviewed_at: string | null;
  duplicates: { field: string; value: string; match: string }[];
  approve_blocked: string | null;
  employee_code: string | null;
}

const DrawerSkeleton: React.FC = () => (
  <div className="space-y-4 animate-pulse" aria-busy="true" aria-label="Loading application">
    <div className="h-5 w-48 rounded bg-slate-200" />
    <div className="h-3 w-64 rounded bg-slate-100" />
    <div className="grid grid-cols-3 gap-3 pt-2">
      {Array.from({ length: 9 }, (_, i) => (
        <div key={i} className="space-y-1.5">
          <div className="h-2.5 w-14 rounded bg-slate-100" />
          <div className="h-3 w-24 rounded bg-slate-200" />
        </div>
      ))}
    </div>
    <div className="h-24 rounded-2xl bg-slate-100" />
  </div>
);

// HR's look at one application: what the joiner gave, their documents, what
// is still missing and any Employee / login it would clash with.
const ReviewDrawer: React.FC<{
  token: string;
  id: number;
  access: OnboardingAccess;
  onClose: () => void;
  onChanged: () => void;
  onIssueLetter: (employeeId: number, name: string) => void;
}> = ({ token, id, access, onClose, onChanged, onIssueLetter }) => {
  const api = useHrApi(token);
  const [d, setD] = useState<ReviewDetail | null>(null);
  const [error, setError] = useState('');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () => api.get<ReviewDetail>(`/api/hr-ops/joiner-onboarding/${id}`).then(setD).catch((e) => setError(e.message));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [api, id]);
  const act = async (fn: () => Promise<string>) => {
    setBusy(true);
    setMsg(null);
    try {
      setMsg({ type: 'success', text: await fn() });
      setRejecting(false);
      setReason('');
      await load();
      onChanged();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const approve = async () => {
    if (!d) return;
    if (!(await confirmDialog(`Approve ${d.name}? This creates their Employee record with a new Employee ID, and their login becomes a normal account.`, { title: 'Approve new joiner', confirmLabel: 'Approve', tone: 'default' })))
      return;
    act(async () => {
      const r = await api.post<{ employee_code?: string; already_approved?: boolean; access_applied?: boolean }>(`/api/hr-ops/joiner-onboarding/${d.id}/approve`);
      if (r.already_approved) return 'This application was already approved.';
      return `Approved — ${d.name} is now Employee ${r.employee_code}.${r.access_applied ? ' Default access was applied.' : ' Set their Module Access in Users.'} Next: issue their Appointment Letter.`;
    });
  };
  const cancel = async () => {
    if (!d) return;
    if (!(await confirmDialog(`Cancel ${d.name}'s onboarding? Their temporary login is blocked and no Employee is created.`, { title: 'Cancel onboarding', confirmLabel: 'Cancel onboarding', cancelLabel: 'Keep', tone: 'danger' })))
      return;
    act(async () => {
      await api.post(`/api/hr-ops/joiner-onboarding/${d.id}/cancel`);
      return 'Onboarding cancelled and the login blocked.';
    });
  };
  const sendBack = () =>
    d &&
    act(async () => {
      await api.post(`/api/hr-ops/joiner-onboarding/${d.id}/reject`, { reason });
      return `Sent back to ${d.name}. They can fix it and submit again.`;
    });
  const open = d && ['draft', 'submitted', 'rejected'].includes(d.status);
  return (
    <div className="liquid-glass-backdrop fixed inset-0 z-[80] flex justify-end" onClick={onClose} role="presentation">
      <div className="w-full sm:max-w-2xl h-full p-0 sm:p-3" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Review new joiner">
        <div className="liquid-glass liquid-glass-in h-full sm:rounded-[32px] flex flex-col overflow-hidden">
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
            <div className="min-w-0">
              <div className="text-base font-bold text-slate-900 truncate">{d?.name || 'New joiner'}</div>
              <div className="text-xs text-slate-500">
                {d ? [d.onb_code, d.designation, d.department, d.branch, d.joining_date ? `joins ${fmtDate(d.joining_date)}` : null].filter(Boolean).join(' · ') : ' '}
              </div>
              {d?.posting_title && <div className="text-[11px] text-violet-700 mt-0.5">From Recruitment: {d.posting_title}</div>}
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 overflow-y-auto px-5 pb-5 space-y-4">
            {error && <Notice msg={{ type: 'error', text: error }} />}
            <Notice msg={msg} onClose={() => setMsg(null)} />
            {!d ? (
              !error && <DrawerSkeleton />
            ) : (
              <>
                <div className="flex flex-wrap items-center gap-2">
                  <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS[d.status].cls}`}>{STATUS[d.status].label}</span>
                  {d.submitted_at && <span className="text-[11px] text-slate-500">Submitted {String(d.submitted_at).slice(0, 16)}</span>}
                  {d.created_by_name && <span className="text-[11px] text-slate-500">· Opened by {d.created_by_name}</span>}
                </div>
                {d.status === 'approved' && d.employee_code && (
                  <div className="liquid-glass-inset rounded-2xl px-4 py-3 text-xs space-y-2.5">
                    <div className="text-emerald-800 flex items-center gap-2">
                      <CheckCircle2 className="w-4 h-4" /> Employee <b>{d.employee_code}</b>
                      {d.reviewed_by_name ? ` · approved by ${d.reviewed_by_name}` : ''}
                    </div>
                    {d.appointment_letter ? (
                      <div className="flex items-center gap-2 text-slate-700">
                        <FileSignature className="w-4 h-4 text-emerald-600" /> Appointment Letter <b className="font-mono">{d.appointment_letter.ref_no}</b> issued.
                      </div>
                    ) : d.appointment_template && d.employee_id ? (
                      <div className="flex flex-wrap items-center justify-between gap-2">
                        <span className="text-slate-600">Appointment Letter not issued yet.</span>
                        <button type="button" className="liquid-glass-button rounded-full px-4 py-2 text-xs font-semibold inline-flex items-center gap-1.5" onClick={() => onIssueLetter(d.employee_id!, d.name)}>
                          <FileSignature className="w-3.5 h-3.5" /> Issue Appointment Letter
                        </button>
                      </div>
                    ) : (
                      <div className="text-amber-700">No active Appointment Letter template — add one in Settings → Letter Templates, then issue the letter from here.</div>
                    )}
                  </div>
                )}
                {['rejected', 'cancelled'].includes(d.status) && d.review_remarks && (
                  <div className="liquid-glass-inset rounded-2xl px-4 py-3 text-xs text-rose-700">
                    <b>
                      {d.status === 'cancelled' ? 'Cancelled' : 'Sent back'}
                      {d.reviewed_by_name ? ` by ${d.reviewed_by_name}` : ''}:
                    </b>{' '}
                    {d.review_remarks}
                  </div>
                )}
                {d.duplicates.length > 0 && (
                  <div className="rounded-2xl border border-rose-200 bg-rose-50/80 px-4 py-3 text-xs text-rose-800">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <ShieldAlert className="w-4 h-4" /> Already on file — approval will be refused until this is sorted out
                    </div>
                    <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
                      {d.duplicates.map((x, i) => (
                        <li key={i}>
                          {x.field} <b>{x.value}</b> belongs to {x.match}
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
                {d.status !== 'draft' && d.missing.length > 0 && (
                  <div className="rounded-2xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-xs text-amber-900">
                    <div className="flex items-center gap-1.5 font-semibold">
                      <AlertTriangle className="w-4 h-4" /> Missing
                    </div>
                    <div className="mt-1">{d.missing.join(' · ')}</div>
                  </div>
                )}
                {d.status === 'draft' ? (
                  <div className="liquid-glass-inset rounded-2xl px-4 py-6 text-center text-sm text-slate-500">
                    The joiner hasn't submitted yet. {d.missing.length ? `${d.missing.length} item${d.missing.length === 1 ? '' : 's'} still to fill in.` : 'Everything is filled in.'}
                  </div>
                ) : (
                  <div className="liquid-glass-inset rounded-2xl p-4">
                    <OnboardingSummary data={d.data} />
                  </div>
                )}
                <div>
                  <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1.5">Documents</div>
                  <ul className="liquid-glass-inset rounded-2xl divide-y divide-white/70">
                    {[...d.required_documents, ...d.documents.map((x) => x.doc_type).filter((t) => !d.required_documents.includes(t))].map((t) => {
                      const doc = d.documents.find((x) => x.doc_type === t);
                      return (
                        <li key={t} className="flex items-center gap-3 px-4 py-2.5">
                          <FileText className={`w-4 h-4 shrink-0 ${doc ? 'text-emerald-600' : 'text-slate-300'}`} />
                          <div className="flex-1 min-w-0">
                            <div className="text-xs font-semibold text-slate-800">
                              {t}
                              {d.required_documents.includes(t) && <span className="text-rose-500"> *</span>}
                            </div>
                            <div className="text-[11px] text-slate-500 truncate">{doc ? doc.file_name : 'Not uploaded'}</div>
                          </div>
                          {doc && (
                            <button
                              type="button"
                              onClick={() => openOnboardingFile(token, `/api/hr-ops/joiner-onboarding/${d.id}/documents/${doc.id}`)}
                              className="liquid-glass-chip p-1.5 rounded-full text-slate-600"
                              aria-label={`View ${t}`}
                            >
                              <Eye className="w-3.5 h-3.5" />
                            </button>
                          )}
                        </li>
                      );
                    })}
                  </ul>
                </div>
              </>
            )}
          </div>
          {d && open && (access.onboarding_review || access.onboarding_approve) && (
            <div className="px-5 py-4 border-t border-white/60 space-y-2.5">
              {rejecting ? (
                <>
                  <textarea
                    autoFocus
                    rows={3}
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="What should the joiner fix? They see this."
                    className="liquid-glass-inset w-full rounded-2xl px-4 py-3 text-sm focus:outline-none"
                  />
                  <div className="flex gap-2.5">
                    <button type="button" onClick={() => setRejecting(false)} className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700">
                      Back
                    </button>
                    <button type="button" disabled={busy || !reason.trim()} onClick={sendBack} className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold disabled:opacity-50">
                      {busy ? 'Sending…' : 'Send back'}
                    </button>
                  </div>
                </>
              ) : (
                <>
                  {d.status === 'submitted' && access.onboarding_approve && (d.approve_blocked || d.duplicates.length > 0) && (
                    <p className="text-[11px] text-slate-500">{d.approve_blocked || 'Sort out the records already on file before approving.'}</p>
                  )}
                  <div className="flex flex-wrap gap-2.5">
                    {access.onboarding_review && (
                      <button type="button" disabled={busy} onClick={cancel} className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-rose-600 inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
                        <Ban className="w-4 h-4" /> Cancel
                      </button>
                    )}
                    {access.onboarding_review && d.status === 'submitted' && (
                      <button type="button" disabled={busy} onClick={() => setRejecting(true)} className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700 inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
                        <XCircle className="w-4 h-4" /> Send back
                      </button>
                    )}
                    {access.onboarding_approve && d.status === 'submitted' && (
                      <button
                        type="button"
                        disabled={busy || !!d.approve_blocked || d.duplicates.length > 0 || d.missing.length > 0}
                        onClick={approve}
                        className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50"
                      >
                        <CheckCircle2 className="w-4 h-4" /> {busy ? 'Working…' : 'Approve'}
                      </button>
                    )}
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};

export const HrOpsJoinerOnboarding: React.FC<{ token: string; meta: HrOpsMeta; access: OnboardingAccess }> = ({ token, meta, access }) => {
  const api = useHrApi(token);
  const [apps, setApps] = useState<Application[] | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [creating, setCreating] = useState(false);
  const [creds, setCreds] = useState<Credentials | null>(null);
  const [reviewing, setReviewing] = useState<number | null>(null);
  // Appointment Letter for an approved joiner: the normal Letters composer,
  // with the new Employee and the Appointment Letter type already picked.
  const [letterFor, setLetterFor] = useState<{ employeeId: number; name: string } | null>(null);
  const [employees, setEmployees] = useState<HrOpsEmployee[] | null>(null);
  const issueLetter = (employeeId: number, name: string) => {
    setReviewing(null);
    setLetterFor({ employeeId, name });
    api
      .get<HrOpsEmployee[]>('/api/hr-ops/employees')
      .then(setEmployees)
      .catch((e) => {
        setLetterFor(null);
        setMsg({ type: 'error', text: e.message });
      });
  };
  const canReview = access.onboarding_review || access.onboarding_approve;

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
                      <div className="text-slate-500 font-mono">
                        {a.onb_code}
                        {a.employee_code ? ` → ${a.employee_code}` : ''}
                      </div>
                    </td>
                    <td className="px-3 py-2.5 text-slate-600">
                      {[a.designation, a.department, a.branch].filter(Boolean).join(' · ') || '—'}
                      {a.posting_title && <div className="text-[10px] text-violet-700 mt-0.5">From Recruitment: {a.posting_title}</div>}
                    </td>
                    <td className="px-3 py-2.5">
                      <span className={`inline-flex text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${STATUS[a.status].cls}`}>{STATUS[a.status].label}</span>
                      {a.status === 'approved' &&
                        a.employee_id &&
                        (a.appointment_letter ? (
                          <div className="mt-1 flex items-center gap-1 text-[10px] text-emerald-700 whitespace-nowrap">
                            <FileSignature className="w-3 h-3" /> {a.appointment_letter.ref_no}
                          </div>
                        ) : a.appointment_template ? (
                          <button
                            type="button"
                            onClick={() => issueLetter(a.employee_id!, a.name)}
                            className="mt-1 flex items-center gap-1 text-[10px] font-semibold text-amber-700 hover:text-amber-800 whitespace-nowrap"
                            title="Issue the Appointment Letter"
                          >
                            <FileSignature className="w-3 h-3" /> Appointment letter: not issued
                          </button>
                        ) : (
                          <div className="mt-1 text-[10px] text-amber-700 whitespace-nowrap">Appointment letter: not issued</div>
                        ))}
                      {left !== null && (
                        <div className={`mt-1 flex items-center gap-1 text-[10px] ${left <= 3 ? 'text-amber-700' : 'text-slate-400'}`}>
                          <Clock className="w-3 h-3" /> {left} day{left === 1 ? '' : 's'} left
                        </div>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">{fmtDate(a.joining_date)}</td>
                    <td className="px-3 py-2.5 text-right whitespace-nowrap space-x-1.5">
                      {canReview && (
                        <button type="button" className={a.status === 'submitted' ? btnPrimary : btnGhost} onClick={() => setReviewing(a.id)}>
                          <Eye className="w-3.5 h-3.5" /> {a.status === 'submitted' ? 'Review' : 'Open'}
                        </button>
                      )}
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
      {letterFor && employees && (
        <LetterComposer
          token={token}
          meta={meta}
          employees={employees}
          init={{ employee_id: letterFor.employeeId, letter_type: 'appointment' }}
          onClose={() => setLetterFor(null)}
          onIssued={(ref) => {
            setMsg({ type: 'success', text: `Appointment Letter ${ref} issued to ${letterFor.name}.` });
            setLetterFor(null);
            load();
          }}
        />
      )}
      {reviewing && <ReviewDrawer token={token} id={reviewing} access={access} onClose={() => setReviewing(null)} onChanged={load} onIssueLetter={issueLetter} />}
    </div>
  );
};
