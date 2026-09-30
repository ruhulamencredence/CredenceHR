/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared pieces for Admin Panel -> HRM -> HR Operations (HROperationsPanel
// and its tab files): the API helper, types mirrored from
// HROperationsRoutes.ts, a searchable Employee picker, formatters and small
// layout helpers.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { buildLetterPdf, letterFileName, type LetterPdfCompany } from '../lib/hrLetterPdf';
import { savePdfCrossPlatform } from '../lib/saveFile';

export interface HrOpsEmployee {
  id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department_id: number | null;
  department: string | null;
  branch_id: number | null;
  branch: string | null;
  grade: string | null;
  project: string | null;
  supervisor_id: number | null;
  supervisor: string | null;
  joining_date: string | null;
  is_active: boolean;
  user_id: number | null;
  gender: string | null;
  job_base: string | null;
  employment_category: string | null;
  gross_salary: number | null;
  basic_salary: number | null;
  probation_months: number | null;
  probation_end_date: string | null;
  confirmation_date: string | null;
  contract_end_date: string | null;
  service_status: string;
}

export interface HrOpsMeta {
  settings: Record<string, string>;
  action_types: { key: string; label: string; letter: string | null }[];
  letter_types: { key: string; label: string; code: string }[];
  placeholders: { key: string; label: string }[];
  users: { id: number; name: string; role: string }[];
  departments: { id: number; name: string }[];
  branches: { id: number; name: string }[];
  projects: { id: number; name: string }[];
}

export interface HrLetter {
  id: number;
  ref_no: string;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  designation: string | null;
  letter_type: string;
  letter_label: string;
  subject: string;
  body: string;
  letter_date: string;
  status: 'issued' | 'cancelled';
  requires_ack: number | boolean;
  acknowledged_at: string | null;
  ack_note: string | null;
  cancelled_reason: string | null;
  issued_by_name: string | null;
  hr_action_id: number | null;
}

export function useHrApi(token: string) {
  return useMemo(() => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const call = async <T = any,>(method: string, path: string, body?: any): Promise<T> => {
      const res = await fetch(apiUrl(path), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data as T;
    };
    return {
      get: <T = any,>(path: string) => call<T>('GET', path),
      post: <T = any,>(path: string, body?: any) => call<T>('POST', path, body ?? {}),
      put: <T = any,>(path: string, body?: any) => call<T>('PUT', path, body ?? {}),
      del: <T = any,>(path: string, body?: any) => call<T>('DELETE', path, body)
    };
  }, [token]);
}

export const taka = (v: number | null | undefined) => (v === null || v === undefined ? '—' : `৳${Number(v).toLocaleString('en-BD', { maximumFractionDigits: 2 })}`);
const SHORT_MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export const fmtDate = (d: string | null | undefined) => {
  if (!d) return '—';
  const [y, m, day] = String(d).slice(0, 10).split('-').map(Number);
  if (!y || !m || !day) return String(d);
  return `${String(day).padStart(2, '0')}-${SHORT_MONTHS[m - 1]}-${y}`;
};
export const monthLabel = (ym: string) => {
  const [y, m] = ym.split('-').map(Number);
  return `${SHORT_MONTHS[m - 1]} ${y}`;
};

export const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  approved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200',
  issued: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  na: 'bg-slate-100 text-slate-500 border-slate-200'
};
export const Badge: React.FC<{ tone: string; children: React.ReactNode }> = ({ tone, children }) => (
  <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${STATUS_STYLE[tone] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>
    {children}
  </span>
);

export const SERVICE_STATUS_LABEL: Record<string, string> = {
  probation: 'On Probation',
  confirmed: 'Confirmed',
  contract: 'Contractual',
  suspended: 'Suspended',
  separated: 'Separated'
};

export const inputCls = 'w-full text-sm px-3 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none';
export const labelCls = 'block text-[11px] font-semibold text-slate-500 mb-1';
export const btnPrimary = 'inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors';
export const btnGhost = 'inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50 transition-colors';

export const Notice: React.FC<{ msg: { type: 'success' | 'error'; text: string } | null; onClose?: () => void }> = ({ msg, onClose }) =>
  msg ? (
    <div className={`flex items-start justify-between gap-2 text-xs px-3 py-2 rounded-lg border ${msg.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
      <span>{msg.text}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  ) : null;

// Type-to-search Employee picker (name, ID, designation).
export const EmployeePicker: React.FC<{
  employees: HrOpsEmployee[];
  value: number | null;
  onChange: (id: number | null) => void;
  placeholder?: string;
  includeInactive?: boolean;
}> = ({ employees, value, onChange, placeholder, includeInactive }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const boxRef = useRef<HTMLDivElement>(null);
  const selected = employees.find((e) => e.id === value) || null;
  useEffect(() => {
    const onDoc = (ev: MouseEvent) => {
      if (boxRef.current && !boxRef.current.contains(ev.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);
  const list = employees
    .filter((e) => includeInactive || e.is_active)
    .filter((e) => {
      const q = query.trim().toLowerCase();
      if (!q) return true;
      return [e.name, e.employee_code, e.designation, e.department].some((v) => String(v || '').toLowerCase().includes(q));
    })
    .slice(0, 50);
  return (
    <div className="relative" ref={boxRef}>
      <div className="relative">
        <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={open ? query : selected ? `${selected.name}${selected.employee_code ? ` (${selected.employee_code})` : ''}` : query}
          onFocus={() => {
            setOpen(true);
            setQuery('');
          }}
          onChange={(e) => {
            setQuery(e.target.value);
            setOpen(true);
          }}
          placeholder={placeholder || 'Search employee by name or ID…'}
          className={`${inputCls} pl-8`}
        />
      </div>
      {open && (
        <div className="absolute z-30 mt-1 w-full max-h-64 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
          {list.length === 0 ? (
            <div className="px-3 py-2 text-xs text-slate-400">No matching employee</div>
          ) : (
            list.map((e) => (
              <button
                key={e.id}
                type="button"
                onMouseDown={(ev) => ev.preventDefault()}
                onClick={() => {
                  onChange(e.id);
                  setOpen(false);
                  setQuery('');
                }}
                className={`w-full text-left px-3 py-2 text-xs hover:bg-slate-50 ${e.id === value ? 'bg-blue-50' : ''}`}
              >
                <div className="font-semibold text-slate-800">
                  {e.name} {e.employee_code && <span className="font-normal text-slate-400">({e.employee_code})</span>}
                  {!e.is_active && <span className="ml-1 text-rose-500 font-normal">· inactive</span>}
                </div>
                <div className="text-[11px] text-slate-500">{[e.designation, e.department].filter(Boolean).join(' · ') || '—'}</div>
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};

// Small labelled value, used in employee summary cards.
export const Field: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div className="min-w-0">
    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
    <div className="text-xs font-medium text-slate-800 truncate">{value || '—'}</div>
  </div>
);

export const Modal: React.FC<{ title: string; onClose: () => void; wide?: boolean; children: React.ReactNode; footer?: React.ReactNode }> = ({ title, onClose, wide, children, footer }) => (
  <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4" role="dialog" aria-modal="true">
    <div className="absolute inset-0 bg-black/40" onClick={onClose} />
    <div className={`relative w-full ${wide ? 'sm:max-w-4xl' : 'sm:max-w-lg'} max-h-[92vh] flex flex-col bg-white rounded-t-2xl sm:rounded-2xl shadow-xl`}>
      <div className="flex items-center justify-between gap-3 px-5 py-3.5 border-b border-slate-200">
        <h3 className="text-sm font-bold text-slate-900">{title}</h3>
        <button type="button" onClick={onClose} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Close">
          <X className="w-5 h-5" />
        </button>
      </div>
      <div className="p-5 overflow-y-auto flex-1">{children}</div>
      {footer && <div className="px-5 py-3 border-t border-slate-200 flex justify-end gap-2 flex-wrap">{footer}</div>}
    </div>
  </div>
);

// Deleting something that can't be undone: the person types its code first.
export const TypeToDelete: React.FC<{
  title: string;
  code: string;
  children: React.ReactNode;
  onClose: () => void;
  onDelete: (typed: string) => Promise<void>;
}> = ({ title, code, children, onClose, onDelete }) => {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);
  const ok = typed.trim().toLowerCase() === code.toLowerCase();
  const go = async () => {
    setBusy(true);
    setErr(null);
    try {
      await onDelete(typed.trim());
    } catch (e: any) {
      setErr(e.message);
      setBusy(false);
    }
  };
  return (
    <Modal
      title={title}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            disabled={!ok || busy}
            onClick={go}
            className="inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white disabled:opacity-50"
          >
            Delete for good
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs text-slate-600">
        {err && <div className="px-3 py-2 rounded-lg border bg-rose-50 border-rose-200 text-rose-700">{err}</div>}
        {children}
        <div>
          <label className={labelCls}>
            Type <span className="font-mono font-bold text-slate-800">{code}</span> to confirm
          </label>
          <input className={inputCls} value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Type to confirm" autoFocus />
        </div>
      </div>
    </Modal>
  );
};

export const companyFromSettings = (s: Record<string, string>): LetterPdfCompany => ({
  name: s.company_name,
  address: s.company_address,
  signatory_name: s.signatory_name,
  signatory_designation: s.signatory_designation
});

// Opens a letter's PDF bytes for PdfPreviewModal, or saves it.
export async function letterPdfBytes(company: LetterPdfCompany, l: { ref_no: string; letter_date: string | null; subject: string; body: string; acknowledged_at?: string | null; employee_name?: string }, draft = false) {
  const doc = await buildLetterPdf({ company, ref_no: l.ref_no, letter_date: l.letter_date, subject: l.subject, body: l.body, draft, acknowledged_at: l.acknowledged_at, employee_name: l.employee_name });
  return new Uint8Array(doc.output('arraybuffer'));
}
export async function saveLetterPdf(company: LetterPdfCompany, l: { ref_no: string; letter_date: string | null; subject: string; body: string; acknowledged_at?: string | null; employee_name?: string }) {
  const doc = await buildLetterPdf({ company, ref_no: l.ref_no, letter_date: l.letter_date, subject: l.subject, body: l.body, acknowledged_at: l.acknowledged_at, employee_name: l.employee_name });
  await savePdfCrossPlatform(doc, letterFileName(l.ref_no, l.employee_name));
}
