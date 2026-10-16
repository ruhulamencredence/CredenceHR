/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared pieces of Targets (TargetRoutes.ts): the target card, the detail
// sheet (tasks, progress, update history, share / approve / reject / cancel /
// close / copy), the new / edit draft form and the task update popup. Used by
// Self Service -> My Targets (MyTargets.tsx) and Admin Panel -> Target
// Reports (TargetReports.tsx). Every popup is the house liquid-glass card.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CalendarDays, CheckCircle2, ChevronDown, ChevronUp, Copy, Download, Lock, Paperclip, Plus, Send, Trash2, X, XCircle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { Spinner } from './Spinner';
import { LoadingBlock } from './LoadingBlock';

export type TargetStatus = 'draft' | 'pending' | 'active' | 'rejected' | 'cancelled' | 'closed';
export type TaskStatus = 'not_started' | 'in_progress' | 'completed' | 'blocked';

export interface TargetUpdate {
  id: number;
  user_id: number;
  user_name: string;
  from_progress: number;
  to_progress: number;
  from_status: TaskStatus | null;
  to_status: TaskStatus | null;
  note: string;
  file_name: string | null;
  has_file: boolean;
  created_at: string;
}
export interface TargetTask {
  id: number;
  title: string;
  description?: string;
  due_date: string | null;
  weight: number;
  progress: number;
  status: TaskStatus;
  completed_at: string | null;
  late: boolean;
  updates?: TargetUpdate[];
}
export interface Target {
  id: number;
  user_id: number;
  owner_name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  period_type: 'monthly' | 'yearly';
  period: string;
  title: string;
  deadline: string;
  status: TargetStatus;
  source: 'supervisor' | 'self';
  created_by: number;
  created_by_name: string | null;
  shared_at: string | null;
  approved_by_name: string | null;
  approved_at: string | null;
  rejected_by_name: string | null;
  reject_reason: string | null;
  cancelled_by_name: string | null;
  cancelled_at: string | null;
  cancel_reason: string | null;
  closed_by_name: string | null;
  closed_at: string | null;
  progress: number;
  task_count: number;
  completed_count: number;
  in_progress_count: number;
  not_started_count: number;
  blocked_count: number;
  overdue: boolean;
  tasks: TargetTask[];
}
export interface TargetRights {
  see: boolean;
  edit: boolean;
  delete: boolean;
  share: boolean;
  approve: boolean;
  update: boolean;
  cancel: boolean;
  close: boolean;
  copy: boolean;
}
export interface TeamMember {
  user_id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  has_access: boolean;
}

export async function targetApi<T = any>(token: string, path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

export const STATUS_LABEL: Record<TargetStatus, string> = {
  draft: 'Draft',
  pending: 'Waiting for approval',
  active: 'Active',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  closed: 'Closed'
};
const STATUS_STYLE: Record<TargetStatus, string> = {
  draft: 'bg-slate-100 text-slate-600 border-slate-200',
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  active: 'bg-sky-50 text-sky-700 border-sky-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200',
  closed: 'bg-emerald-50 text-emerald-700 border-emerald-200'
};
export const TASK_STATUS_LABEL: Record<TaskStatus, string> = {
  not_started: 'Not started',
  in_progress: 'In progress',
  completed: 'Completed',
  blocked: 'Blocked'
};
const TASK_STATUS_STYLE: Record<TaskStatus, string> = {
  not_started: 'bg-slate-100 text-slate-600',
  in_progress: 'bg-amber-50 text-amber-700',
  completed: 'bg-emerald-50 text-emerald-700',
  blocked: 'bg-rose-50 text-rose-700'
};

export const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
export const fmtDate = (d: string | null | undefined) => {
  if (!d) return '';
  const t = new Date(d.length <= 10 ? `${d}T00:00:00` : d.replace(' ', 'T'));
  return isNaN(t.getTime()) ? d : t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtWhen = (d: string) => {
  const t = new Date(String(d).replace(' ', 'T'));
  return isNaN(t.getTime()) ? d : t.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
export const periodLabel = (type: string, period: string) =>
  type === 'yearly'
    ? `Year ${period}`
    : (() => {
        const t = new Date(`${period}-01T00:00:00`);
        return isNaN(t.getTime()) ? period : t.toLocaleDateString('en-GB', { month: 'short', year: 'numeric' });
      })();
const lastDay = (type: string, period: string) => {
  if (type === 'yearly') return `${period}-12-31`;
  const [y, m] = period.split('-').map(Number);
  return `${period}-${String(new Date(y, m, 0).getDate()).padStart(2, '0')}`;
};

export const inputCls = 'w-full rounded-xl border border-slate-200 bg-white/80 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-fuchsia-300';
export const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';

// The bar colour follows how far it got.
export const ProgressBar: React.FC<{ value: number; thin?: boolean }> = ({ value, thin }) => {
  const v = Math.min(100, Math.max(0, value));
  const color = v >= 100 ? 'bg-emerald-500' : v >= 60 ? 'bg-sky-500' : v >= 30 ? 'bg-amber-500' : 'bg-rose-400';
  return (
    <div className={`w-full rounded-full bg-slate-200/80 overflow-hidden ${thin ? 'h-1.5' : 'h-2.5'}`} role="progressbar" aria-valuenow={v} aria-valuemin={0} aria-valuemax={100}>
      <div className={`h-full rounded-full ${color} transition-all`} style={{ width: `${v}%` }} />
    </div>
  );
};

export const StatusBadge: React.FC<{ t: Pick<Target, 'status' | 'overdue'> }> = ({ t }) => (
  <span className="flex items-center gap-1 shrink-0">
    {t.overdue && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-600 text-white">Overdue</span>}
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[t.status]}`}>{STATUS_LABEL[t.status]}</span>
  </span>
);

export const TargetCard: React.FC<{ t: Target; onOpen: () => void; showOwner?: boolean }> = ({ t, onOpen, showOwner }) => (
  <button
    type="button"
    onClick={onOpen}
    className={`w-full text-left rounded-2xl border bg-white p-3.5 hover:shadow-md transition-shadow ${t.overdue ? 'border-rose-300' : 'border-slate-200'}`}
  >
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900 truncate flex items-center gap-1.5">
          {t.status !== 'draft' && <Lock className="w-3 h-3 text-slate-400 shrink-0" aria-label="Locked" />}
          {t.title}
        </div>
        <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-x-2">
          {showOwner && <span className="font-semibold text-slate-700">{t.owner_name}</span>}
          <span>{periodLabel(t.period_type, t.period)}</span>
          <span className="inline-flex items-center gap-0.5">
            <CalendarDays className="w-3 h-3" /> Deadline {fmtDate(t.deadline)}
          </span>
          <span>{t.source === 'self' ? 'Shared by the employee' : t.created_by_name ? `From ${t.created_by_name}` : 'From supervisor'}</span>
        </div>
      </div>
      <StatusBadge t={t} />
    </div>
    <div className="mt-2.5 flex items-center gap-2">
      <ProgressBar value={t.progress} />
      <span className="text-xs font-bold text-slate-800 w-10 text-right">{t.progress}%</span>
    </div>
    <div className="mt-2 flex flex-wrap gap-1.5 text-[11px]">
      <span className="px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">✓ {t.completed_count} done</span>
      {t.in_progress_count > 0 && <span className="px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">{t.in_progress_count} in progress</span>}
      {t.not_started_count > 0 && <span className="px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{t.not_started_count} not started</span>}
      {t.blocked_count > 0 && <span className="px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">{t.blocked_count} blocked</span>}
      <span className="text-slate-400">of {t.task_count}</span>
    </div>
  </button>
);

// The house popup: liquid-glass card over a dimmed, blurred page; a sheet
// from the bottom on phones. Portalled so blurred ancestors never trap it.
export const GlassSheet: React.FC<{ title: string; subtitle?: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; wide?: boolean; z?: number }> = ({
  title,
  subtitle,
  onClose,
  children,
  footer,
  wide,
  z = 80
}) => {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return createPortal(
    <div className="liquid-glass-backdrop fixed inset-0 flex items-end sm:items-center justify-center p-0 sm:p-4" style={{ zIndex: z }} onClick={onClose} role="presentation">
      <div className={`w-full ${wide ? 'sm:max-w-3xl' : 'sm:max-w-lg'} max-h-[94vh] flex`} onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
        <div className="liquid-glass liquid-glass-in rounded-t-[32px] sm:rounded-[32px] w-full flex flex-col overflow-hidden">
          <div className="flex items-start justify-between gap-3 px-5 pt-5 pb-3">
            <div className="min-w-0">
              <h3 className="text-base font-bold text-slate-900 leading-tight">{title}</h3>
              {subtitle && <p className="text-xs text-slate-500 mt-0.5">{subtitle}</p>}
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="overflow-y-auto px-5 pb-4 flex-1">{children}</div>
          {footer && <div className="px-5 py-3 border-t border-white/40 flex flex-wrap gap-2 justify-end">{footer}</div>}
        </div>
      </div>
    </div>,
    document.body
  );
};

export const primaryBtn = 'liquid-glass-button rounded-full px-4 py-2 text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50';
export const chipBtn = 'liquid-glass-chip rounded-full px-4 py-2 text-sm font-semibold text-slate-700 inline-flex items-center gap-1.5 disabled:opacity-50';
const dangerStyle = { '--g-accent': '#e11d48' } as React.CSSProperties;

// ---- reason popup (reject / cancel) ---------------------------------------
const ReasonPopup: React.FC<{ title: string; label: string; button: string; onClose: () => void; onSubmit: (reason: string) => Promise<void> }> = ({ title, label, button, onClose, onSubmit }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const go = async () => {
    if (!reason.trim()) return setError('Write the reason.');
    setBusy(true);
    setError('');
    try {
      await onSubmit(reason.trim());
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <GlassSheet
      title={title}
      onClose={onClose}
      z={95}
      footer={
        <>
          <button type="button" className={chipBtn} onClick={onClose}>
            Back
          </button>
          <button type="button" className={primaryBtn} style={dangerStyle} disabled={busy} onClick={go}>
            {busy ? <Spinner size={14} /> : <XCircle className="w-4 h-4" />} {button}
          </button>
        </>
      }
    >
      <label className={labelCls}>{label}</label>
      <textarea className={inputCls} rows={3} value={reason} onChange={(e) => setReason(e.target.value)} autoFocus maxLength={1000} />
      {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
    </GlassSheet>
  );
};

// ---- task update popup ------------------------------------------------------
const UpdateTaskPopup: React.FC<{ token: string; task: TargetTask; onClose: () => void; onSaved: (t: Target) => void }> = ({ token, task, onClose, onSaved }) => {
  const [progress, setProgress] = useState(task.progress);
  const [status, setStatus] = useState<TaskStatus>(task.status);
  const [note, setNote] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const setP = (v: number) => {
    setProgress(v);
    if (v === 100) setStatus('completed');
    else if (status === 'completed') setStatus('in_progress');
    else if (v > 0 && status === 'not_started') setStatus('in_progress');
  };
  const setS = (s: TaskStatus) => {
    setStatus(s);
    if (s === 'completed') setProgress(100);
    if (s === 'not_started') setProgress(0);
  };
  const save = async () => {
    setError('');
    if (file && file.size > 5 * 1024 * 1024) return setError('The file is larger than 5 MB.');
    setBusy(true);
    try {
      const body: any = { progress, status, note };
      if (file) {
        const b64 = await new Promise<string>((resolve, reject) => {
          const r = new FileReader();
          r.onload = () => resolve(String(r.result).split(',')[1] || '');
          r.onerror = () => reject(new Error('Could not read the file.'));
          r.readAsDataURL(file);
        });
        Object.assign(body, { file_base64: b64, file_name: file.name, file_mime: file.type || 'application/octet-stream' });
      }
      onSaved(await targetApi<Target>(token, `/api/target-tasks/${task.id}/update`, 'POST', body));
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <GlassSheet
      title={task.title}
      subtitle="Update progress"
      onClose={onClose}
      z={95}
      footer={
        <>
          <button type="button" className={chipBtn} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={primaryBtn} disabled={busy} onClick={save}>
            {busy ? <Spinner size={14} /> : <CheckCircle2 className="w-4 h-4" />} Save
          </button>
        </>
      }
    >
      <div className="space-y-4">
        <div className="liquid-glass-inset rounded-2xl p-4">
          <div className="flex items-center justify-between mb-2">
            <span className={labelCls + ' mb-0'}>Progress</span>
            <span className="text-2xl font-bold text-slate-900">{progress}%</span>
          </div>
          <input type="range" min={0} max={100} step={5} value={progress} onChange={(e) => setP(Number(e.target.value))} className="w-full accent-fuchsia-600" aria-label="Progress" />
          <div className="flex gap-1.5 mt-2">
            {[0, 25, 50, 75, 100].map((v) => (
              <button key={v} type="button" onClick={() => setP(v)} className={`flex-1 rounded-full py-1 text-[11px] font-semibold ${progress === v ? 'liquid-glass-button' : 'liquid-glass-chip text-slate-600'}`}>
                {v}%
              </button>
            ))}
          </div>
        </div>
        <div>
          <label className={labelCls}>Status</label>
          <select className={inputCls} value={status} onChange={(e) => setS(e.target.value as TaskStatus)}>
            {(Object.keys(TASK_STATUS_LABEL) as TaskStatus[]).map((s) => (
              <option key={s} value={s}>
                {TASK_STATUS_LABEL[s]}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Details / note</label>
          <textarea className={inputCls} rows={3} value={note} onChange={(e) => setNote(e.target.value)} placeholder="What was done, what is left, what is blocking it…" maxLength={3000} />
        </div>
        <div>
          <label className={labelCls}>Attachment (optional, up to 5 MB)</label>
          <input type="file" onChange={(e) => setFile(e.target.files?.[0] || null)} className="text-xs" />
        </div>
        {error && <p className="text-xs text-rose-600">{error}</p>}
      </div>
    </GlassSheet>
  );
};

async function downloadUpdateFile(token: string, u: TargetUpdate) {
  const res = await fetch(apiUrl(`/api/target-updates/${u.id}/file`), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) throw new Error('Could not download the file.');
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = u.file_name || 'file';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

// ---- the detail sheet -------------------------------------------------------
export const TargetDrawer: React.FC<{
  token: string;
  targetId: number;
  onClose: () => void;
  onChanged: () => void;
  onEdit?: (t: Target) => void;
  onOpenOther?: (id: number) => void;
}> = ({ token, targetId, onClose, onChanged, onEdit, onOpenOther }) => {
  const [t, setT] = useState<(Target & { rights: TargetRights }) | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [updating, setUpdating] = useState<TargetTask | null>(null);
  const [reason, setReason] = useState<'reject' | 'cancel' | null>(null);
  const [openHistory, setOpenHistory] = useState<Set<number>>(new Set());

  const load = () =>
    targetApi<Target & { rights: TargetRights }>(token, `/api/targets/${targetId}`)
      .then(setT)
      .catch((e) => setError(e.message));
  useEffect(() => {
    setT(null);
    load();
  }, [targetId]);

  const act = async (path: string, body?: any) => {
    setBusy(true);
    setError('');
    try {
      const r = await targetApi(token, `/api/targets/${targetId}/${path}`, 'POST', body || {});
      onChanged();
      if (path === 'copy' && r?.id && onOpenOther) onOpenOther(r.id);
      else await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const share = async () => {
    if (!t) return;
    const ok = await confirmDialog(
      t.user_id === t.created_by
        ? 'Share this target with your supervisor? After sharing it cannot be edited or deleted — only each task’s progress, status and details.'
        : `Share this target with ${t.owner_name}? After sharing it cannot be edited or deleted — only each task’s progress, status and details.`,
      { title: 'Share target', confirmLabel: 'Share', tone: 'default' }
    );
    if (ok) act('share');
  };
  const del = async () => {
    if (!(await confirmDialog('Delete this draft? This cannot be undone.'))) return;
    setBusy(true);
    try {
      await targetApi(token, `/api/targets/${targetId}`, 'DELETE');
      onChanged();
      onClose();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  const close = async () => {
    if (!t) return;
    if (!(await confirmDialog(`Close this target at ${t.progress}%? Nothing can change after it is closed.`, { title: 'Close target', confirmLabel: 'Close target' }))) return;
    act('close');
  };
  const toggleHistory = (id: number) =>
    setOpenHistory((prev) => {
      const n = new Set(prev);
      if (n.has(id)) n.delete(id);
      else n.add(id);
      return n;
    });

  const footer = t && (
    <>
      {t.rights.delete && (
        <button type="button" className={chipBtn} disabled={busy} onClick={del}>
          <Trash2 className="w-4 h-4 text-rose-600" /> Delete draft
        </button>
      )}
      {t.rights.edit && onEdit && (
        <button type="button" className={chipBtn} disabled={busy} onClick={() => onEdit(t)}>
          Edit draft
        </button>
      )}
      {t.rights.share && (
        <button type="button" className={primaryBtn} disabled={busy} onClick={share}>
          <Send className="w-4 h-4" /> Share
        </button>
      )}
      {t.rights.approve && (
        <>
          <button type="button" className={chipBtn} disabled={busy} onClick={() => setReason('reject')}>
            <XCircle className="w-4 h-4 text-rose-600" /> Reject
          </button>
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => act('approve')}>
            <CheckCircle2 className="w-4 h-4" /> Approve
          </button>
        </>
      )}
      {t.rights.cancel && (
        <button type="button" className={chipBtn} disabled={busy} onClick={() => setReason('cancel')}>
          <XCircle className="w-4 h-4 text-rose-600" /> Cancel target
        </button>
      )}
      {t.rights.close && (
        <button type="button" className={chipBtn} disabled={busy} onClick={close}>
          <Lock className="w-4 h-4" /> Close
        </button>
      )}
      {t.rights.copy && (
        <button type="button" className={primaryBtn} disabled={busy} onClick={() => act('copy')}>
          <Copy className="w-4 h-4" /> Copy as new draft
        </button>
      )}
    </>
  );
  const hasFooter = !!t && Object.entries(t.rights).some(([k, v]) => k !== 'see' && k !== 'update' && v);

  return (
    <>
      <GlassSheet
        title={t ? t.title : 'Target'}
        subtitle={t ? `${t.owner_name}${t.employee_code ? ` · ${t.employee_code}` : ''}${t.department ? ` · ${t.department}` : ''}` : undefined}
        onClose={onClose}
        wide
        footer={hasFooter ? footer : undefined}
      >
        {!t ? (
          error ? <p className="text-sm text-rose-600">{error}</p> : <LoadingBlock />
        ) : (
          <div className="space-y-4">
            <div className="liquid-glass-inset rounded-2xl p-4">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="text-xs text-slate-600 flex flex-wrap gap-x-3 gap-y-1">
                  <span className="font-semibold text-slate-800">{periodLabel(t.period_type, t.period)} · {t.period_type === 'yearly' ? 'Yearly' : 'Monthly'}</span>
                  <span className="inline-flex items-center gap-1">
                    <CalendarDays className="w-3.5 h-3.5" /> Deadline {fmtDate(t.deadline)}
                  </span>
                </div>
                <StatusBadge t={t} />
              </div>
              <div className="mt-3 flex items-center gap-3">
                <ProgressBar value={t.progress} />
                <span className="text-xl font-bold text-slate-900 w-14 text-right">{t.progress}%</span>
              </div>
              <div className="mt-2 text-[11px] text-slate-600 flex flex-wrap gap-x-3">
                <span>✅ {t.completed_count} complete</span>
                <span>🔄 {t.in_progress_count} in progress</span>
                <span>⏸ {t.not_started_count} not started</span>
                {t.blocked_count > 0 && <span>⛔ {t.blocked_count} blocked</span>}
              </div>
            </div>

            {t.status === 'draft' && <Notice tone="slate">Draft — only you can see it. Share it when it is ready; after that it is locked.</Notice>}
            {t.status === 'pending' && <Notice tone="amber">Waiting for the supervisor’s approval. Progress can be updated once it is approved.</Notice>}
            {t.status !== 'draft' && t.status !== 'pending' && (
              <Notice tone="slate">
                <Lock className="w-3.5 h-3.5 inline -mt-0.5" /> Shared {t.shared_at ? fmtWhen(t.shared_at) : ''}
                {t.approved_by_name ? ` · approved by ${t.approved_by_name}` : ''} — locked: tasks can’t be edited or deleted, only their progress, status and details.
              </Notice>
            )}
            {t.status === 'rejected' && <Notice tone="rose">Rejected by {t.rejected_by_name || 'the supervisor'}: {t.reject_reason}</Notice>}
            {t.status === 'cancelled' && <Notice tone="rose">Cancelled by {t.cancelled_by_name || '—'} {t.cancelled_at ? `on ${fmtDate(t.cancelled_at)}` : ''}: {t.cancel_reason}</Notice>}
            {t.status === 'closed' && <Notice tone="emerald">Closed by {t.closed_by_name || '—'} {t.closed_at ? `on ${fmtDate(t.closed_at)}` : ''} at {t.progress}%.</Notice>}

            <ol className="space-y-2.5">
              {t.tasks.map((k, i) => {
                const history = k.updates || [];
                const open = openHistory.has(k.id);
                return (
                  <li key={k.id} className="rounded-2xl bg-white/80 border border-slate-200 p-3.5">
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900">
                          {i + 1}. {k.title}
                        </div>
                        {k.description && <p className="text-xs text-slate-600 mt-0.5 whitespace-pre-line">{k.description}</p>}
                        <div className="text-[11px] text-slate-500 mt-1 flex flex-wrap gap-x-2">
                          {k.due_date && <span>Due {fmtDate(k.due_date)}</span>}
                          {k.weight > 1 && <span>Weight {k.weight}</span>}
                          {k.late && <span className="text-rose-600 font-semibold">{k.status === 'completed' ? 'Finished late' : 'Past due'}</span>}
                          {k.completed_at && <span>Done {fmtDate(k.completed_at)}</span>}
                        </div>
                      </div>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full shrink-0 ${TASK_STATUS_STYLE[k.status]}`}>{TASK_STATUS_LABEL[k.status]}</span>
                    </div>
                    <div className="mt-2 flex items-center gap-2">
                      <ProgressBar value={k.progress} thin />
                      <span className="text-xs font-bold text-slate-800 w-10 text-right">{k.progress}%</span>
                      {t.rights.update && (
                        <button type="button" onClick={() => setUpdating(k)} className="liquid-glass-button rounded-full px-3 py-1 text-xs font-semibold shrink-0">
                          Update
                        </button>
                      )}
                    </div>
                    {history.length > 0 && (
                      <div className="mt-2">
                        <button type="button" onClick={() => toggleHistory(k.id)} className="text-[11px] font-semibold text-slate-500 hover:text-slate-800 inline-flex items-center gap-0.5">
                          {open ? <ChevronUp className="w-3 h-3" /> : <ChevronDown className="w-3 h-3" />} {history.length} update{history.length === 1 ? '' : 's'}
                        </button>
                        {open && (
                          <ul className="mt-1.5 space-y-1.5 border-l-2 border-slate-200 pl-3">
                            {history
                              .slice()
                              .reverse()
                              .map((u) => (
                                <li key={u.id} className="text-[11px] text-slate-600">
                                  <span className="font-semibold text-slate-800">{fmtWhen(u.created_at)}</span> · {u.user_name} · {u.from_progress}% → {u.to_progress}%
                                  {u.to_status && u.to_status !== u.from_status ? ` · ${TASK_STATUS_LABEL[u.to_status]}` : ''}
                                  {u.note && <div className="text-slate-700 whitespace-pre-line">“{u.note}”</div>}
                                  {u.has_file && (
                                    <button
                                      type="button"
                                      onClick={() => downloadUpdateFile(token, u).catch((e) => setError(e.message))}
                                      className="inline-flex items-center gap-1 text-fuchsia-700 hover:underline"
                                    >
                                      <Paperclip className="w-3 h-3" /> {u.file_name} <Download className="w-3 h-3" />
                                    </button>
                                  )}
                                </li>
                              ))}
                          </ul>
                        )}
                      </div>
                    )}
                  </li>
                );
              })}
            </ol>
            {error && <p className="text-sm text-rose-600">{error}</p>}
          </div>
        )}
      </GlassSheet>
      {updating && (
        <UpdateTaskPopup
          token={token}
          task={updating}
          onClose={() => setUpdating(null)}
          onSaved={(fresh) => {
            setUpdating(null);
            setT((prev) => (prev ? { ...fresh, rights: prev.rights } : prev));
            onChanged();
          }}
        />
      )}
      {reason && (
        <ReasonPopup
          title={reason === 'reject' ? 'Reject target' : 'Cancel target'}
          label={reason === 'reject' ? 'Why is it rejected? (the employee sees this)' : 'Why is it cancelled? (kept in the report)'}
          button={reason === 'reject' ? 'Reject' : 'Cancel target'}
          onClose={() => setReason(null)}
          onSubmit={async (r) => {
            await targetApi(token, `/api/targets/${targetId}/${reason}`, 'POST', { reason: r });
            setReason(null);
            onChanged();
            await load();
          }}
        />
      )}
    </>
  );
};

const Notice: React.FC<{ tone: 'slate' | 'amber' | 'rose' | 'emerald'; children: React.ReactNode }> = ({ tone, children }) => {
  const cls = { slate: 'bg-slate-50 text-slate-600 border-slate-200', amber: 'bg-amber-50 text-amber-800 border-amber-200', rose: 'bg-rose-50 text-rose-700 border-rose-200', emerald: 'bg-emerald-50 text-emerald-700 border-emerald-200' }[tone];
  return <div className={`rounded-xl border px-3 py-2 text-xs ${cls}`}>{children}</div>;
};

// ---- new / edit draft --------------------------------------------------------
interface TaskRow {
  key: number;
  title: string;
  description: string;
  due_date: string;
  weight: number;
}
let rowKey = 1;
const blankRow = (): TaskRow => ({ key: rowKey++, title: '', description: '', due_date: '', weight: 1 });

export const TargetForm: React.FC<{
  token: string;
  // People under this account (Team tab); empty = a target for myself.
  members?: TeamMember[];
  preselect?: number[];
  editing?: Target | null;
  onClose: () => void;
  onSaved: () => void;
}> = ({ token, members, preselect, editing, onClose, onSaved }) => {
  const now = todayYmd();
  const forTeam = !!members && !editing;
  const [owners, setOwners] = useState<number[]>(preselect || []);
  const [q, setQ] = useState('');
  const [periodType, setPeriodType] = useState<'monthly' | 'yearly'>(editing?.period_type || 'monthly');
  const [month, setMonth] = useState(editing?.period_type === 'monthly' ? editing.period : now.slice(0, 7));
  const [year, setYear] = useState(editing?.period_type === 'yearly' ? editing.period : now.slice(0, 4));
  const period = periodType === 'monthly' ? month : year;
  const [deadline, setDeadline] = useState(editing?.deadline || lastDay('monthly', now.slice(0, 7)));
  const [deadlineTouched, setDeadlineTouched] = useState(!!editing);
  const [title, setTitle] = useState(editing?.title || '');
  const [rows, setRows] = useState<TaskRow[]>(
    editing?.tasks?.length
      ? editing.tasks.map((k) => ({ key: rowKey++, title: k.title, description: k.description || '', due_date: k.due_date || '', weight: k.weight || 1 }))
      : [blankRow(), blankRow()]
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  // The deadline follows the period until it is changed by hand.
  useEffect(() => {
    if (!deadlineTouched && /^\d{4}(-\d{2})?$/.test(period)) setDeadline(lastDay(periodType, period));
  }, [periodType, period, deadlineTouched]);

  // Loaded drafts carry no task details in the list; fetch them.
  useEffect(() => {
    if (!editing) return;
    targetApi<Target>(token, `/api/targets/${editing.id}`)
      .then((full) =>
        setRows(full.tasks.map((k) => ({ key: rowKey++, title: k.title, description: k.description || '', due_date: k.due_date || '', weight: k.weight || 1 })))
      )
      .catch(() => undefined);
  }, [editing?.id]);

  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    const all = members || [];
    return s ? all.filter((m) => [m.name, m.employee_code, m.department, m.designation].some((v) => String(v || '').toLowerCase().includes(s))) : all;
  }, [members, q]);
  const allPicked = !!members?.length && members.every((m) => owners.includes(m.user_id));
  const setRow = (key: number, patch: Partial<TaskRow>) => setRows((rs) => rs.map((r) => (r.key === key ? { ...r, ...patch } : r)));

  const save = async (doShare: boolean) => {
    setError('');
    if (forTeam && !owners.length) return setError('Pick at least one person.');
    const tasks = rows.filter((r) => r.title.trim()).map((r) => ({ title: r.title.trim(), description: r.description.trim(), due_date: r.due_date || null, weight: r.weight }));
    if (!tasks.length) return setError('Add at least one task.');
    if (doShare) {
      const who = forTeam ? (owners.length === 1 ? members!.find((m) => m.user_id === owners[0])?.name || '1 person' : `${owners.length} people`) : 'your supervisor';
      const ok = await confirmDialog(`Share this target with ${who}? After sharing it cannot be edited or deleted — only each task’s progress, status and details.`, {
        title: 'Share target',
        confirmLabel: 'Share',
        tone: 'default'
      });
      if (!ok) return;
    }
    setBusy(true);
    try {
      const body = { period_type: periodType, period, deadline, title: title.trim(), tasks, share: doShare, owner_ids: forTeam ? owners : undefined };
      if (editing) await targetApi(token, `/api/targets/${editing.id}`, 'PUT', body);
      else await targetApi(token, '/api/targets', 'POST', body);
      onSaved();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };

  return (
    <GlassSheet
      title={editing ? 'Edit draft' : forTeam ? 'Give a target' : 'New target'}
      subtitle={forTeam ? 'Each person picked gets their own copy to update.' : editing ? undefined : 'It goes to your supervisor for approval when you share it.'}
      onClose={onClose}
      wide
      z={90}
      footer={
        <>
          <button type="button" className={chipBtn} disabled={busy} onClick={() => save(false)}>
            Save draft
          </button>
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => save(true)}>
            {busy ? <Spinner size={14} /> : <Send className="w-4 h-4" />} Share
          </button>
        </>
      }
    >
      <div className="space-y-4">
        {forTeam && (
          <div>
            <div className="flex items-center justify-between mb-1">
              <label className={labelCls + ' mb-0'}>For</label>
              <button type="button" onClick={() => setOwners(allPicked ? [] : members!.map((m) => m.user_id))} className="text-[11px] font-semibold text-fuchsia-700 hover:underline">
                {allPicked ? 'Clear' : `Whole team (${members!.length})`}
              </button>
            </div>
            <div className="liquid-glass-inset rounded-2xl overflow-hidden">
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, department" className="w-full bg-transparent px-3 py-2 text-sm outline-none border-b border-white/40" />
              <ul className="max-h-44 overflow-y-auto">
                {list.map((m) => (
                  <li key={m.user_id}>
                    <label className="flex items-center gap-2.5 px-3 py-1.5 cursor-pointer hover:bg-white/40">
                      <input
                        type="checkbox"
                        className="accent-fuchsia-600"
                        checked={owners.includes(m.user_id)}
                        onChange={() => setOwners((o) => (o.includes(m.user_id) ? o.filter((x) => x !== m.user_id) : [...o, m.user_id]))}
                        aria-label={`Pick ${m.name}`}
                      />
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm text-slate-800 truncate">{m.name}</span>
                        <span className="block text-[11px] text-slate-500 truncate">{[m.employee_code, m.designation, m.department].filter(Boolean).join(' · ')}</span>
                      </span>
                      {!m.has_access && <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">No My Targets access</span>}
                    </label>
                  </li>
                ))}
                {!list.length && <li className="px-3 py-3 text-xs text-slate-500">No one found.</li>}
              </ul>
            </div>
            {owners.length > 0 && <p className="text-[11px] text-fuchsia-700 mt-1 font-semibold">{owners.length} picked</p>}
          </div>
        )}
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Type</label>
            <select className={inputCls} value={periodType} onChange={(e) => setPeriodType(e.target.value as 'monthly' | 'yearly')}>
              <option value="monthly">Monthly</option>
              <option value="yearly">Yearly</option>
            </select>
          </div>
          <div>
            <label className={labelCls}>{periodType === 'monthly' ? 'Month' : 'Year'}</label>
            {periodType === 'monthly' ? (
              <input type="month" className={inputCls} value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} />
            ) : (
              <input type="number" className={inputCls} value={year} min={2000} max={2100} onChange={(e) => setYear(e.target.value.slice(0, 4))} />
            )}
          </div>
          <div className="col-span-2 sm:col-span-1">
            <label className={labelCls}>Deadline</label>
            <input
              type="date"
              className={inputCls}
              value={deadline}
              onChange={(e) => {
                setDeadline(e.target.value);
                setDeadlineTouched(true);
              }}
            />
          </div>
        </div>
        <div>
          <label className={labelCls}>Title (optional)</label>
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder={`${periodLabel(periodType, period)} target`} maxLength={200} />
        </div>
        <div>
          <label className={labelCls}>Tasks</label>
          <div className="space-y-2">
            {rows.map((r, i) => (
              <div key={r.key} className="liquid-glass-inset rounded-2xl p-3 space-y-2">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-bold text-slate-500 w-5">{i + 1}.</span>
                  <input className={inputCls} value={r.title} onChange={(e) => setRow(r.key, { title: e.target.value })} placeholder="e.g. 50 new client calls" maxLength={200} aria-label={`Task ${i + 1} title`} />
                  <button
                    type="button"
                    onClick={() => setRows((rs) => (rs.length > 1 ? rs.filter((x) => x.key !== r.key) : rs))}
                    className="liquid-glass-chip p-1.5 rounded-full text-rose-600 shrink-0 disabled:opacity-40"
                    disabled={rows.length <= 1}
                    aria-label={`Remove task ${i + 1}`}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
                <textarea className={inputCls} rows={1} value={r.description} onChange={(e) => setRow(r.key, { description: e.target.value })} placeholder="Details (optional)" />
                <div className="grid grid-cols-2 gap-2">
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">Own due date (optional)</label>
                    <input type="date" className={inputCls} value={r.due_date} max={deadline} onChange={(e) => setRow(r.key, { due_date: e.target.value })} />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 mb-0.5">Weight (1–100)</label>
                    <input type="number" min={1} max={100} className={inputCls} value={r.weight} onChange={(e) => setRow(r.key, { weight: Math.min(100, Math.max(1, Number(e.target.value) || 1)) })} />
                  </div>
                </div>
              </div>
            ))}
          </div>
          {rows.length < 30 && (
            <button type="button" onClick={() => setRows((rs) => [...rs, blankRow()])} className={`${chipBtn} mt-2 text-xs py-1.5`}>
              <Plus className="w-3.5 h-3.5" /> Add task
            </button>
          )}
          <p className="text-[11px] text-slate-500 mt-2 flex items-start gap-1">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 text-amber-600" /> Once shared, the target and its tasks are locked — no editing or deleting.
          </p>
        </div>
        {error && <p className="text-sm text-rose-600">{error}</p>}
      </div>
    </GlassSheet>
  );
};

// An alert for a target (AlertsBell / AlertsPage) leaves its id here.
export function takePendingTargetId(): number | null {
  try {
    const v = sessionStorage.getItem('open_target_id');
    if (!v) return null;
    sessionStorage.removeItem('open_target_id');
    return Number(v) || null;
  } catch {
    return null;
  }
}
