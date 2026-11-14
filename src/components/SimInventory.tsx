/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// SIM & Mobile Bill -> SIM Inventory (layer "sim_inventory", SimInventory.ts):
// every company SIM — who has it now and where, since when, how many people
// have had it, its limit and its bills. Tap one for its whole story: every
// holder with dates and days, every limit change, every month's bill (with
// who held it that month), as one Excel too.

import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { FileSpreadsheet, History, Loader2, Search, X } from 'lucide-react';
import { mbApi, monthLabel, fmtDate, OperatorBadge, tk } from './MobileBillParts';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { useIsPhone } from '../lib/useScrolling';
import { saveWorkbookCrossPlatform } from '../lib/saveFile';

interface Holder {
  id: number | null;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
}
interface InvSim {
  id: number;
  phone_number: string;
  operator: string;
  package_name: string | null;
  status: string;
  holder: Holder | null;
  duty_location: string | null;
  since: string | null;
  days: number | null;
  holders: number;
  limit_amount: number;
  bills: number;
  total_billed: number;
  average_bill: number;
  over_limit_months: number;
  last_bill: { month: string; amount: number; limit_amount: number } | null;
}
interface SimStory {
  id: number;
  phone_number: string;
  operator: string;
  package_name: string | null;
  status: string;
  issued_on: string | null;
  holder: Holder | null;
  duty_location: string | null;
  limit_amount: number;
  holders: { holder: Holder | null; duty_location: string | null; from: string; to: string | null; current: boolean; days: number; from_log: boolean }[];
  limits: { date: string | null; old_limit: number | null; new_limit: number | null; kind: string | null; for_month: string | null; note: string; by: string | null }[];
  bills: { month: string; amount: number; limit_amount: number; over: number; holder: Holder | null; paid_at: string | null }[];
}

const days = (n: number | null) => (n == null ? '' : n === 0 ? 'today' : n === 1 ? '1 day' : n < 60 ? `${n} days` : `${n} days (~${Math.round(n / 30)} mo)`);
const KIND: Record<string, string> = { added: 'First limit', manual: 'Changed by HR', type: 'Employee type limit', permanent: 'Approved request (from then on)', month: 'Approved request (one month)' };
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

export const SimInventoryTab: React.FC<{ token: string }> = ({ token }) => {
  const [sims, setSims] = useState<InvSim[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [op, setOp] = useState('');
  const [where, setWhere] = useState<'' | 'person' | 'stock'>('');
  const [status, setStatus] = useState<'' | 'active' | 'inactive'>('');
  const [open, setOpen] = useState<number | null>(null);

  useEffect(() => {
    mbApi<InvSim[]>(token, '/api/mobile-bill/inventory')
      .then(setSims)
      .catch((e) => {
        setError(e.message);
        setSims([]);
      });
  }, [token]);

  const operators = useMemo(() => Array.from(new Set((sims || []).map((s) => s.operator))).sort(), [sims]);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (sims || []).filter(
      (s) =>
        (!op || s.operator === op) &&
        (!status || s.status === status) &&
        (!where || (where === 'person' ? !!s.holder : !s.holder)) &&
        (!t || [s.phone_number, s.holder?.name, s.holder?.employee_code, s.holder?.department, s.duty_location, s.package_name].some((v) => String(v || '').toLowerCase().includes(t)))
    );
  }, [sims, q, op, where, status]);
  const inStock = (sims || []).filter((s) => !s.holder).length;

  const excel = () => {
    const rows: (string | number)[][] = [
      ['Number', 'Operator', 'Package', 'Status', 'With', 'Employee ID', 'Department', 'Duty location', 'Since', 'Days', 'People had it', 'Limit', 'Bills', 'Total billed', 'Average bill', 'Months over limit', 'Last bill month', 'Last bill']
    ];
    for (const s of shown)
      rows.push([
        s.phone_number,
        s.operator,
        s.package_name || '',
        s.status,
        s.holder?.name || 'In stock',
        s.holder?.employee_code || '',
        s.holder?.department || '',
        s.duty_location || '',
        s.since || '',
        s.days ?? '',
        s.holders,
        s.limit_amount,
        s.bills,
        s.total_billed,
        s.average_bill,
        s.over_limit_months,
        s.last_bill ? s.last_bill.month : '',
        s.last_bill ? s.last_bill.amount : ''
      ]);
    const wb = XLSX.utils.book_new();
    const ws = XLSX.utils.aoa_to_sheet(rows);
    ws['!cols'] = rows[0].map(() => ({ wch: 15 }));
    XLSX.utils.book_append_sheet(wb, ws, 'SIM Inventory');
    void saveWorkbookCrossPlatform(wb, `SIM_Inventory_${today()}.xlsx`);
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          ['SIMs', (sims || []).length],
          ['With a person', (sims || []).length - inStock],
          ['In stock', inStock],
          ['Inactive', (sims || []).filter((s) => s.status !== 'active').length]
        ].map(([l, v]) => (
          <div key={String(l)} className="rounded-xl border border-slate-200 bg-white px-3 py-2.5">
            <div className="text-[11px] font-semibold text-slate-500">{l}</div>
            <div className="text-xl font-bold text-slate-900">{sims ? v : '—'}</div>
          </div>
        ))}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <label className="flex items-center gap-2 bg-white border border-slate-200 rounded-full px-3 py-1.5 flex-1 min-w-[200px] max-w-sm">
          <Search className="w-3.5 h-3.5 text-slate-400" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Number, name, ID, department, location…" className="bg-transparent text-xs outline-none flex-1 min-w-0" />
        </label>
        <select value={op} onChange={(e) => setOp(e.target.value)} className="text-xs px-3 py-1.5 rounded-full bg-white border border-slate-200">
          <option value="">All operators</option>
          {operators.map((o) => (
            <option key={o}>{o}</option>
          ))}
        </select>
        <select value={where} onChange={(e) => setWhere(e.target.value as any)} className="text-xs px-3 py-1.5 rounded-full bg-white border border-slate-200">
          <option value="">With anyone / in stock</option>
          <option value="person">With a person</option>
          <option value="stock">In stock</option>
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="text-xs px-3 py-1.5 rounded-full bg-white border border-slate-200">
          <option value="">Active & inactive</option>
          <option value="active">Active</option>
          <option value="inactive">Inactive</option>
        </select>
        <button type="button" onClick={excel} disabled={!sims} className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-slate-200 text-slate-700 disabled:opacity-50">
          <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
        </button>
      </div>
      {error && <p className="text-xs text-rose-600">{error}</p>}
      <div className="rounded-2xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-xs" data-phone-card>
          <thead className="bg-slate-50 text-slate-500">
            <tr className="text-left">
              <th className="px-3 py-2.5 font-semibold">SIM</th>
              <th className="px-3 py-2.5 font-semibold">Now with</th>
              <th className="px-3 py-2.5 font-semibold">Duty location</th>
              <th className="px-3 py-2.5 font-semibold">Since</th>
              <th className="px-3 py-2.5 font-semibold text-right">People had it</th>
              <th className="px-3 py-2.5 font-semibold text-right">Limit</th>
              <th className="px-3 py-2.5 font-semibold text-right">Last bill</th>
              <th className="px-3 py-2.5 font-semibold text-right">Average</th>
              <th className="px-3 py-2.5 font-semibold text-right">Over limit</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {!sims ? (
              <tr>
                <td colSpan={9} className="py-10 text-center">
                  <Loader2 className="w-5 h-5 animate-spin text-slate-400 inline" />
                </td>
              </tr>
            ) : shown.length === 0 ? (
              <tr>
                <td colSpan={9} className="py-10 text-center text-slate-500">
                  No SIM.
                </td>
              </tr>
            ) : (
              shown.map((s) => (
                <tr key={s.id} className="hover:bg-slate-50 cursor-pointer" onClick={() => setOpen(s.id)}>
                  <td className="px-3 py-2.5">
                    <span className="block font-semibold text-slate-900">{s.phone_number}</span>
                    <span className="inline-flex items-center gap-1 mt-0.5">
                      <OperatorBadge op={s.operator} />
                      {s.status !== 'active' && <span className="text-[10px] font-semibold text-slate-400">Inactive</span>}
                    </span>
                  </td>
                  <td className="px-3 py-2.5">
                    {s.holder ? (
                      <>
                        <span className="block font-semibold text-slate-800">{s.holder.name}</span>
                        <span className="block text-[11px] text-slate-500">{[s.holder.employee_code, s.holder.department].filter(Boolean).join(' · ')}</span>
                      </>
                    ) : (
                      <span className="text-amber-700 font-semibold">In stock</span>
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-slate-600">{s.duty_location || '—'}</td>
                  <td className="px-3 py-2.5 text-slate-600 whitespace-nowrap">
                    {s.since ? fmtDate(s.since) : '—'}
                    {s.days != null && <span className="block text-[11px] text-slate-400">{days(s.days)}</span>}
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-700">{s.holders}</td>
                  <td className="px-3 py-2.5 text-right font-semibold text-slate-800">{tk(s.limit_amount)}</td>
                  <td className="px-3 py-2.5 text-right text-slate-700 whitespace-nowrap">
                    {s.last_bill ? (
                      <>
                        <span className={s.last_bill.amount > s.last_bill.limit_amount ? 'text-rose-600 font-semibold' : ''}>{tk(s.last_bill.amount)}</span>
                        <span className="block text-[11px] text-slate-400">{monthLabel(s.last_bill.month, true)}</span>
                      </>
                    ) : (
                      '—'
                    )}
                  </td>
                  <td className="px-3 py-2.5 text-right text-slate-700">{s.bills ? tk(s.average_bill) : '—'}</td>
                  <td className="px-3 py-2.5 text-right">{s.over_limit_months ? <span className="text-rose-600 font-semibold">{s.over_limit_months} mo</span> : <span className="text-slate-400">—</span>}</td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {open != null && <SimStorySheet token={token} id={open} onClose={() => setOpen(null)} />}
    </div>
  );
};

const SimStorySheet: React.FC<{ token: string; id: number; onClose: () => void }> = ({ token, id, onClose }) => {
  const [s, setS] = useState<SimStory | null>(null);
  const [error, setError] = useState('');
  const phone = useIsPhone();
  useBackButtonClose(true, onClose);
  useEffect(() => {
    mbApi<SimStory>(token, `/api/mobile-bill/inventory/${id}`)
      .then(setS)
      .catch((e) => setError(e.message));
  }, [token, id]);

  const total = s ? s.bills.reduce((t, b) => t + b.amount, 0) : 0;
  const excel = () => {
    if (!s) return;
    const wb = XLSX.utils.book_new();
    const h = XLSX.utils.aoa_to_sheet([
      ['With', 'Employee ID', 'Department', 'Duty location', 'From', 'To', 'Days'],
      ...s.holders.map((x) => [x.holder?.name || 'In stock', x.holder?.employee_code || '', x.holder?.department || '', x.duty_location || '', x.from, x.to || 'now', x.days])
    ]);
    XLSX.utils.book_append_sheet(wb, h, 'Holders');
    const l = XLSX.utils.aoa_to_sheet([['Date', 'From', 'To', 'Kind', 'For month', 'By', 'Note'], ...s.limits.map((x) => [x.date || '', x.old_limit ?? '', x.new_limit ?? '', KIND[x.kind || ''] || x.kind || '', x.for_month || '', x.by || '', x.note])]);
    XLSX.utils.book_append_sheet(wb, l, 'Limits');
    const b = XLSX.utils.aoa_to_sheet([['Month', 'Bill', 'Limit', 'Over limit', 'With', 'Paid'], ...s.bills.map((x) => [x.month, x.amount, x.limit_amount, x.over, x.holder?.name || '', x.paid_at ? 'Yes' : 'No'])]);
    XLSX.utils.book_append_sheet(wb, b, 'Bills');
    void saveWorkbookCrossPlatform(wb, `SIM_${s.phone_number}_history_${today()}.xlsx`);
  };

  const section = (title: string, n: number, body: React.ReactNode) => (
    <div className="liquid-glass-inset rounded-2xl p-3">
      <h4 className="text-xs font-bold text-slate-800 mb-2">
        {title} <span className="text-slate-400 font-semibold">({n})</span>
      </h4>
      {n === 0 ? <p className="text-xs text-slate-500 py-2">Nothing yet.</p> : <div className="overflow-x-auto">{body}</div>}
    </div>
  );

  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="SIM history">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-0 sm:inset-4 lg:inset-6 flex">
        <div className="liquid-glass liquid-glass-in rounded-none sm:rounded-[32px] w-full h-full flex flex-col overflow-hidden">
          <div className="flex items-start gap-3 px-4 sm:px-6 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-5 pb-3 shrink-0">
            <div className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center shrink-0">
              <History className="w-5 h-5 text-slate-700" />
            </div>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2 flex-wrap">
                {s?.phone_number || 'SIM'} {s && <OperatorBadge op={s.operator} />}
                {s && s.status !== 'active' && <span className="text-[11px] font-semibold text-slate-400">Inactive</span>}
              </h3>
              {s && (
                <p className="text-xs text-slate-500 mt-0.5">
                  Now {s.holder ? `with ${s.holder.name}${s.holder.employee_code ? ` (${s.holder.employee_code})` : ''}` : 'in stock'}
                  {s.duty_location ? ` · ${s.duty_location}` : ''} · limit {tk(s.limit_amount)}
                  {s.package_name ? ` · ${s.package_name}` : ''}
                  {s.issued_on ? ` · issued ${fmtDate(s.issued_on)}` : ''}
                </p>
              )}
            </div>
            <button type="button" onClick={excel} disabled={!s} className="liquid-glass-chip rounded-full px-3 h-9 text-xs font-semibold flex items-center gap-1.5 disabled:opacity-50">
              <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
            </button>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-600" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 pb-5">
            {error && <p className="text-xs text-rose-600">{error}</p>}
            {!s ? (
              !error && (
                <div className="flex justify-center py-16">
                  <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                </div>
              )
            ) : (
              <div className={phone ? 'space-y-3' : 'grid grid-cols-2 gap-3 items-start'}>
                <div className={phone ? '' : 'col-span-2'}>
                  {section(
                    'Who had it, where, how long',
                    s.holders.length,
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-left text-slate-500">
                          <th className="px-2 py-1.5 font-semibold">With</th>
                          <th className="px-2 py-1.5 font-semibold">Duty location</th>
                          <th className="px-2 py-1.5 font-semibold">From</th>
                          <th className="px-2 py-1.5 font-semibold">To</th>
                          <th className="px-2 py-1.5 font-semibold text-right">Days</th>
                        </tr>
                      </thead>
                      <tbody>
                        {s.holders.map((h, i) => (
                          <tr key={i} className={`border-t border-slate-200/60 ${h.current ? 'font-semibold' : ''}`}>
                            <td className="px-2 py-1.5">
                              {h.holder ? (
                                <>
                                  <span className="text-slate-800">{h.holder.name}</span>
                                  <span className="block text-[11px] font-normal text-slate-500">{[h.holder.employee_code, h.holder.department].filter(Boolean).join(' · ')}</span>
                                </>
                              ) : (
                                <span className="text-amber-700">In stock</span>
                              )}
                            </td>
                            <td className="px-2 py-1.5 text-slate-600">{h.duty_location || '—'}</td>
                            <td className="px-2 py-1.5 text-slate-600 whitespace-nowrap">{fmtDate(h.from)}</td>
                            <td className="px-2 py-1.5 text-slate-600 whitespace-nowrap">{h.current ? <span className="text-emerald-700">Now</span> : fmtDate(h.to)}</td>
                            <td className="px-2 py-1.5 text-right text-slate-700 whitespace-nowrap">{days(h.days)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  )}
                  {s.holders.some((h) => h.from_log) && (
                    <p className="text-[11px] text-slate-400 mt-1 px-1">Older rows were rebuilt from the SIM’s activity log; their duty location wasn’t recorded then.</p>
                  )}
                </div>
                {section(
                  'Limit changes',
                  s.limits.length,
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500">
                        <th className="px-2 py-1.5 font-semibold">Date</th>
                        <th className="px-2 py-1.5 font-semibold">Limit</th>
                        <th className="px-2 py-1.5 font-semibold">Why</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.limits.map((l, i) => (
                        <tr key={i} className="border-t border-slate-200/60 align-top">
                          <td className="px-2 py-1.5 text-slate-600 whitespace-nowrap">{fmtDate(l.date)}</td>
                          <td className="px-2 py-1.5 font-semibold text-slate-800 whitespace-nowrap">
                            {l.old_limit != null ? `${tk(l.old_limit)} → ` : ''}
                            {tk(l.new_limit)}
                          </td>
                          <td className="px-2 py-1.5 text-slate-600">
                            {KIND[l.kind || ''] || l.note}
                            {l.for_month && <span className="text-slate-400"> · {monthLabel(l.for_month, true)}</span>}
                            {l.by && <span className="block text-[11px] text-slate-400">by {l.by}</span>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {section(
                  `Monthly bills · total ${tk(total)}`,
                  s.bills.length,
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500">
                        <th className="px-2 py-1.5 font-semibold">Month</th>
                        <th className="px-2 py-1.5 font-semibold text-right">Bill</th>
                        <th className="px-2 py-1.5 font-semibold text-right">Limit</th>
                        <th className="px-2 py-1.5 font-semibold text-right">Over</th>
                        <th className="px-2 py-1.5 font-semibold">With</th>
                      </tr>
                    </thead>
                    <tbody>
                      {s.bills.map((b) => (
                        <tr key={b.month} className="border-t border-slate-200/60">
                          <td className="px-2 py-1.5 text-slate-700 whitespace-nowrap">
                            {monthLabel(b.month, true)}
                            {b.paid_at && <span className="ml-1 text-[10px] text-emerald-700">paid</span>}
                          </td>
                          <td className="px-2 py-1.5 text-right font-semibold text-slate-800">{tk(b.amount)}</td>
                          <td className="px-2 py-1.5 text-right text-slate-600">{tk(b.limit_amount)}</td>
                          <td className="px-2 py-1.5 text-right">{b.over > 0 ? <span className="text-rose-600 font-semibold">{tk(b.over)}</span> : <span className="text-slate-400">—</span>}</td>
                          <td className="px-2 py-1.5 text-slate-600">{b.holder?.name || '—'}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default SimInventoryTab;

// SIMs tab -> "From Employees": office SIMs from each employee's own
// "Contact No." (POST /api/mobile-bill/sims/from-employees). First a preview
// — new / already listed / listed for someone else / not a number / no
// limit — then "Add" creates only the new ones (confirmDialog).
type FromEmpRow = {
  employee_id: number;
  employee_code: string | null;
  name: string;
  department: string | null;
  phone_number: string;
  duty_location: string | null;
  operator?: string | null;
  limit_amount?: number | null;
  status: 'new' | 'already' | 'other' | 'shared' | 'invalid' | 'no_limit';
  note: string | null;
};
const FROM_EMP_LABEL: Record<FromEmpRow['status'], string> = {
  new: 'Will be added',
  already: 'Already listed',
  other: 'Listed for someone else',
  shared: 'Same number on two people',
  invalid: 'Not a mobile number',
  no_limit: 'No limit set'
};
export const SimsFromEmployeesSheet: React.FC<{ token: string; onClose: () => void; onDone: (n: number) => void }> = ({ token, onClose, onDone }) => {
  const [data, setData] = useState<{ summary: Record<string, number>; rows: FromEmpRow[] } | null>(null);
  const [show, setShow] = useState<FromEmpRow['status'] | ''>('new');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useBackButtonClose(true, () => !busy && onClose());
  useEffect(() => {
    mbApi<any>(token, '/api/mobile-bill/sims/from-employees', 'POST', { dry_run: true })
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token]);
  const rows = (data?.rows || []).filter((r) => !show || r.status === show);
  const add = async () => {
    if (!data?.summary.new) return;
    const { confirmDialog } = await import('../lib/confirmDialog');
    if (!(await confirmDialog(`Add ${data.summary.new} SIM${data.summary.new === 1 ? '' : 's'} from the employees' Contact No., each given to that employee with their type's limit?`, { confirmLabel: 'Add SIMs', tone: 'default' }))) return;
    setBusy(true);
    setError('');
    try {
      const r = await mbApi<any>(token, '/api/mobile-bill/sims/from-employees', 'POST', { dry_run: false });
      onDone(r.summary?.new ?? 0);
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="SIMs from Employees">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={() => !busy && onClose()} />
      <div className="absolute inset-0 sm:inset-4 lg:inset-6 flex">
        <div className="liquid-glass liquid-glass-in rounded-none sm:rounded-[32px] w-full h-full flex flex-col overflow-hidden">
          <div className="flex items-start gap-3 px-4 sm:px-6 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-5 pb-3 shrink-0">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-slate-900">Office SIMs from Employees</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Each active employee’s Contact No. (Employees → Contact No.) not yet in the SIM list is added as their SIM — operator from the number, limit from their employee type (Limits), duty location = their Branch. Numbers already listed are left as they are.
              </p>
            </div>
            <button type="button" onClick={onClose} disabled={busy} className="liquid-glass-chip w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-600" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="px-4 sm:px-6 pb-3 flex flex-wrap gap-1.5 shrink-0">
            {(['new', 'already', 'other', 'shared', 'invalid', 'no_limit'] as const).map((k) => (
              <button
                key={k}
                type="button"
                onClick={() => setShow(show === k ? '' : k)}
                className={`px-3 py-1.5 rounded-full text-xs font-semibold ${show === k ? 'bg-slate-900 text-white' : 'liquid-glass-chip text-slate-700'}`}
              >
                {FROM_EMP_LABEL[k]} · {data ? data.summary[k] ?? 0 : '…'}
              </button>
            ))}
          </div>
          {error && <p className="mx-4 sm:mx-6 mb-2 text-xs font-semibold text-rose-700">{error}</p>}
          <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 pb-4">
            {!data ? (
              !error && (
                <div className="flex justify-center py-16">
                  <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
                </div>
              )
            ) : rows.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-16">Nobody here.</p>
            ) : (
              <div className="liquid-glass-inset rounded-2xl overflow-x-auto">
                <table className="w-full text-xs" data-phone-card>
                  <thead className="bg-white/80">
                    <tr className="text-left text-slate-500">
                      <th className="px-3 py-2 font-semibold">Employee</th>
                      <th className="px-3 py-2 font-semibold">Contact No.</th>
                      <th className="px-3 py-2 font-semibold">Duty location</th>
                      <th className="px-3 py-2 font-semibold text-right">Limit</th>
                      <th className="px-3 py-2 font-semibold">What happens</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={`${r.employee_id}-${r.phone_number}`} className="border-t border-slate-200/60">
                        <td className="px-3 py-2">
                          <span className="block font-semibold text-slate-800">{r.name}</span>
                          <span className="block text-[11px] text-slate-500">{[r.employee_code, r.department].filter(Boolean).join(' · ')}</span>
                        </td>
                        <td className="px-3 py-2 text-slate-700 whitespace-nowrap">
                          {r.phone_number} {r.operator && <OperatorBadge op={r.operator} />}
                        </td>
                        <td className="px-3 py-2 text-slate-600">{r.duty_location || '—'}</td>
                        <td className="px-3 py-2 text-right text-slate-700">{r.limit_amount != null ? tk(r.limit_amount) : '—'}</td>
                        <td className={`px-3 py-2 ${r.status === 'new' ? 'text-emerald-700 font-semibold' : r.status === 'already' ? 'text-slate-500' : 'text-amber-700'}`}>
                          {r.note || FROM_EMP_LABEL[r.status]}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
          <div className="px-4 sm:px-6 py-3 border-t border-white/60 shrink-0 flex items-center gap-2 pb-[max(0.75rem,env(safe-area-inset-bottom))]">
            <span className="text-xs text-slate-500 flex-1">Nothing changes until you press Add.</span>
            <button type="button" onClick={() => void add()} disabled={busy || !data?.summary.new} className="liquid-glass-button rounded-full px-4 py-2 text-xs font-semibold disabled:opacity-50 flex items-center gap-1.5">
              {busy && <Loader2 className="w-3.5 h-3.5 animate-spin" />}
              Add {data?.summary.new ?? 0} SIMs
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
