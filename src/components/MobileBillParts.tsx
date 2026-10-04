/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared bits of Mobile Bill (MobileBillRoutes.ts): types, the API helper,
// money/month formatting, reading an Excel sheet's columns, and the limit
// request form used by My Mobile SIM.

import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { apiUrl } from '../lib/api';

export interface MbEmployee {
  id: number;
  employee_code: string | null;
  name: string;
  designation: string | null;
  department: string | null;
  work_station: string | null;
  employee_type: string | null;
  user_id: number | null;
  type_limit?: number | null;
}
export interface MbSim {
  id: number;
  phone_number: string;
  operator: string;
  sim_type: string;
  package_name: string | null;
  employee_id: number | null;
  employee: MbEmployee | null;
  duty_location: string | null;
  limit_amount: number;
  limit_source: 'type' | 'custom';
  status: 'active' | 'inactive';
  issued_on: string | null;
  note: string | null;
  pending_requests: number;
  last_bill: { month: string; amount: number; limit_amount: number } | null;
}
export interface MbRequest {
  id: number;
  sim_id: number;
  phone_number: string | null;
  operator: string | null;
  employee: MbEmployee | null;
  user_id: number;
  user_name: string | null;
  current_limit: number;
  requested_limit: number;
  scope: 'month' | 'permanent';
  for_month: string;
  reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled';
  decided_by_name: string | null;
  decided_at: string | null;
  decision_note: string | null;
  created_at: string;
  chain: { status: string; step: number; total: number; waiting_on: string[] } | null;
}
export interface MbPolicy {
  id: number;
  employee_type: string;
  limit_amount: number;
  note: string | null;
  sims?: number;
}

export async function mbApi<T = any>(token: string, path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
    body: body ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

export const OPERATOR_STYLE: Record<string, string> = {
  Grameenphone: 'bg-sky-50 text-sky-700 border-sky-200',
  Robi: 'bg-rose-50 text-rose-700 border-rose-200',
  Airtel: 'bg-red-50 text-red-700 border-red-200',
  Banglalink: 'bg-orange-50 text-orange-700 border-orange-200',
  Teletalk: 'bg-emerald-50 text-emerald-700 border-emerald-200'
};
export const OperatorBadge: React.FC<{ op: string | null }> = ({ op }) =>
  op ? <span className={`inline-block px-1.5 py-0.5 rounded-md border text-[10px] font-semibold ${OPERATOR_STYLE[op] || 'bg-slate-50 text-slate-600 border-slate-200'}`}>{op}</span> : null;

export const tk = (n: number | null | undefined) => (n == null ? '—' : `৳${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`);
export const num = (n: number | null | undefined) => (n == null ? '' : Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 }));
export const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date()).slice(0, 7);
export const shiftMonth = (m: string, n: number) => {
  const [y, mo] = m.split('-').map(Number);
  const d = new Date(Date.UTC(y, mo - 1 + n, 1));
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
};
export const monthLabel = (m: string, short = false) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-GB', { month: short ? 'short' : 'long', year: short ? '2-digit' : 'numeric' });
};
export const monthsBetween = (from: string, to: string) => {
  const out: string[] = [];
  for (let m = from; m <= to && out.length < 60; m = shiftMonth(m, 1)) out.push(m);
  return out;
};
export const fmtDate = (d: string | null) => {
  if (!d) return '';
  const t = new Date(d.length <= 10 ? `${d}T00:00:00` : d.replace(' ', 'T'));
  return isNaN(t.getTime()) ? d : t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};

// "Sep-26", "Sep 2026", "September-2026", "2026-09" → "2026-09".
const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];
export function parseMonthHeader(v: any): string | null {
  const s = String(v ?? '').trim().toLowerCase();
  // An Excel date cell whose month format was lost reads as its serial day.
  if (/^\d{5}$/.test(s) && +s > 36000 && +s < 73000) {
    const d = new Date(Date.UTC(1899, 11, 30) + Number(s) * 86400000);
    return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
  }
  let m = s.match(/^(\d{4})-(\d{1,2})$/);
  if (m && +m[2] >= 1 && +m[2] <= 12) return `${m[1]}-${m[2].padStart(2, '0')}`;
  m = s.match(/^([a-z]{3})[a-z]*[\s\-'/,.]*(\d{2}|\d{4})$/);
  if (m) {
    const i = MONTHS.indexOf(m[1]);
    if (i < 0) return null;
    const y = m[2].length === 2 ? 2000 + Number(m[2]) : Number(m[2]);
    return `${y}-${String(i + 1).padStart(2, '0')}`;
  }
  return null;
}

// Rows of a sheet (array of arrays) → the header row index: the first row in
// the top 15 that has a cell matching `want`.
export function findHeaderRow(rows: any[][], want: RegExp): number {
  for (let i = 0; i < Math.min(rows.length, 15); i++) if ((rows[i] || []).some((c) => want.test(String(c ?? '')))) return i;
  return 0;
}
export function guessColumn(headers: string[], ...patterns: RegExp[]): number {
  for (const p of patterns) {
    const i = headers.findIndex((h) => p.test(h));
    if (i >= 0) return i;
  }
  return -1;
}

export const StatusPill: React.FC<{ status: MbRequest['status'] }> = ({ status }) => {
  const cls =
    status === 'approved'
      ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
      : status === 'rejected'
        ? 'bg-rose-50 text-rose-700 border-rose-200'
        : status === 'cancelled'
          ? 'bg-slate-100 text-slate-500 border-slate-200'
          : 'bg-amber-50 text-amber-700 border-amber-200';
  return <span className={`inline-block px-2 py-0.5 rounded-full border text-[10px] font-semibold capitalize ${cls}`}>{status}</span>;
};

// Where a request stands, in one line.
export const requestStage = (r: MbRequest) =>
  r.status !== 'pending'
    ? `${r.status === 'approved' ? 'Approved' : r.status === 'rejected' ? 'Rejected' : 'Cancelled'}${r.decided_by_name ? ` by ${r.decided_by_name}` : ''}${r.decided_at ? ` · ${fmtDate(r.decided_at)}` : ''}`
    : r.chain && r.chain.status === 'pending'
      ? `Layer ${r.chain.step} of ${r.chain.total}${r.chain.waiting_on.length ? ` — waiting on ${r.chain.waiting_on.join(', ')}` : ''}`
      : 'Waiting for HR';

export const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }> = ({ title, onClose, children, wide }) =>
  createPortal(
    <div className="fixed inset-0 z-[90] bg-slate-900/40 flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div
        className={`bg-white w-full ${wide ? 'sm:max-w-4xl' : 'sm:max-w-lg'} max-h-[92vh] overflow-y-auto rounded-t-2xl sm:rounded-2xl shadow-xl`}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="sticky top-0 bg-white border-b border-slate-100 px-5 py-3.5 flex items-center justify-between z-10">
          <h3 className="font-bold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="w-8 h-8 rounded-full hover:bg-slate-100 flex items-center justify-center" aria-label="Close">
            <X className="w-4 h-4 text-slate-500" />
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>,
    document.body
  );

export const inputCls = 'w-full px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-200 bg-white';
// Same look, sized to its content — for filter rows.
export const filterCls = 'px-3 py-2 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-teal-200 bg-white';
export const labelCls = 'block text-[11px] font-semibold text-slate-500 mb-1';

// Self Service: ask for a higher limit on one SIM.
export const LimitRequestForm: React.FC<{
  token: string;
  sims: MbSim[];
  defaultSimId?: number;
  onClose: () => void;
  onDone: () => void;
}> = ({ token, sims, defaultSimId, onClose, onDone }) => {
  const active = sims.filter((s) => s.status === 'active');
  const [simId, setSimId] = useState<number>(defaultSimId || active[0]?.id || 0);
  const [scope, setScope] = useState<'month' | 'permanent'>('month');
  const [month, setMonth] = useState(thisMonth());
  const [amount, setAmount] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const sim = active.find((s) => s.id === simId);

  const submit = async () => {
    setError('');
    setSaving(true);
    try {
      await mbApi(token, '/api/mobile-bill/my/requests', 'POST', { sim_id: simId, scope, for_month: month, requested_limit: Number(amount), reason });
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title="Apply for a higher limit" onClose={onClose}>
      {active.length === 0 ? (
        <p className="text-sm text-slate-500">You have no active company SIM.</p>
      ) : (
        <div className="space-y-3">
          <div>
            <label className={labelCls}>SIM</label>
            <select className={inputCls} value={simId} onChange={(e) => setSimId(Number(e.target.value))}>
              {active.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.phone_number} · {s.operator} · limit {tk(s.limit_amount)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>For</label>
            <div className="grid grid-cols-2 gap-2">
              {(
                [
                  ['month', 'One month only'],
                  ['permanent', 'From this month on']
                ] as const
              ).map(([k, l]) => (
                <button
                  key={k}
                  type="button"
                  onClick={() => setScope(k)}
                  className={`px-3 py-2 rounded-xl border text-xs font-semibold ${scope === k ? 'bg-teal-600 border-teal-600 text-white' : 'bg-white border-slate-200 text-slate-600'}`}
                >
                  {l}
                </button>
              ))}
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>{scope === 'month' ? 'Month' : 'Starting month'}</label>
              <input type="month" className={inputCls} value={month} min={shiftMonth(thisMonth(), -1)} onChange={(e) => setMonth(e.target.value)} />
            </div>
            <div>
              <label className={labelCls}>New limit (৳)</label>
              <input type="number" min={0} inputMode="decimal" className={inputCls} value={amount} onChange={(e) => setAmount(e.target.value)} placeholder={sim ? `more than ${sim.limit_amount}` : ''} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Why do you need it?</label>
            <textarea className={`${inputCls} min-h-[80px]`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. Site work this month — many calls with suppliers" />
          </div>
          <p className="text-[11px] text-slate-500">It goes through your approval chain (your supervisor, then HR). Your limit changes as soon as it is approved.</p>
          {error && <p className="text-sm text-rose-600">{error}</p>}
          <div className="flex justify-end gap-2">
            <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100">
              Cancel
            </button>
            <button
              type="button"
              disabled={saving || !simId || !amount || !reason.trim()}
              onClick={submit}
              className="px-4 py-2 rounded-xl text-sm font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50"
            >
              {saving ? 'Sending…' : 'Send request'}
            </button>
          </div>
        </div>
      )}
    </Modal>
  );
};
