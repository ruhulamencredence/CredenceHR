// Payroll -> Approval -> Salary sheet (Payroll layer "approval_sheet"):
// the month's salaries on screen, one row per employee, so Audit and
// Accounts can check them before approving / paying instead of only
// exporting a file. Search, department filter, "needs a look" filters
// (big change from last month, new this month, on hold, deductions), a
// totals row, a row's full breakdown on click, and Excel of exactly what is
// shown. GET /api/payroll/approval/:month/salary-sheet.
import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { ChevronDown, ChevronRight, FileSpreadsheet, Search, Table2 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { MultiSelectFilter } from './MultiSelectFilter';
import { PagerBar } from './PagerBar';
import { LoadingBlock } from './LoadingBlock';

interface SheetRow {
  id: number;
  employee_id: number;
  employee_code: string;
  employee_name: string;
  department: string;
  designation: string;
  working_days: number;
  present_days: number;
  absent_days: number;
  leave_days: number;
  lwp_days: number;
  late_count: number;
  late_deduction_days: number;
  overtime_hours: number;
  basic: number;
  allowances: number;
  overtime: number;
  bonus: number;
  extra_pay: number;
  gross: number;
  absent_deduction: number;
  late_deduction: number;
  tax: number;
  pf: number;
  advance: number;
  other_deduction: number;
  extra_deduction: number;
  total_deduction: number;
  net: number;
  last_net: number | null;
  status: string;
  hold_reason: string | null;
  remarks: string | null;
  paid_to: string;
}

type Show = 'all' | 'changed' | 'new' | 'held' | 'deducted';
const SHOW: { key: Show; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'changed', label: 'Net changed 10%+' },
  { key: 'new', label: 'New this month' },
  { key: 'held', label: 'On hold' },
  { key: 'deducted', label: 'Absent / late cut' }
];
const n2 = (v: number) => (Number(v) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const changePct = (r: SheetRow) => (r.last_net && r.last_net > 0 ? ((r.net - r.last_net) / r.last_net) * 100 : null);
const matches = (r: SheetRow, show: Show) => {
  if (show === 'held') return r.status === 'held';
  if (show === 'new') return r.last_net == null;
  if (show === 'deducted') return r.absent_deduction > 0 || r.late_deduction > 0 || r.lwp_days > 0;
  if (show === 'changed') {
    const c = changePct(r);
    return c != null && Math.abs(c) >= 10;
  }
  return true;
};

export const PayrollSalarySheet: React.FC<{ token: string; month: string }> = ({ token, month }) => {
  const [rows, setRows] = useState<SheetRow[] | null>(null);
  const [prevMonth, setPrevMonth] = useState('');
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const [q, setQ] = useState('');
  const [depts, setDepts] = useState<string[]>([]);
  const [show, setShow] = useState<Show>('all');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);
  const [expanded, setExpanded] = useState<number | null>(null);

  useEffect(() => {
    let live = true;
    setRows(null);
    setError('');
    fetch(apiUrl(`/api/payroll/approval/${month}/salary-sheet`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load the salary sheet.');
        return d;
      })
      .then((d) => {
        if (!live) return;
        setRows(d.rows || []);
        setPrevMonth(d.previous_month || '');
      })
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [token, month]);

  const deptOptions = useMemo(() => {
    const c = new Map<string, number>();
    for (const r of rows || []) c.set(r.department || '—', (c.get(r.department || '—') || 0) + 1);
    return [...c.entries()].sort((a, b) => a[0].localeCompare(b[0])).map(([d, n]) => ({ value: d, label: d, count: n }));
  }, [rows]);
  const shownRows = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return (rows || []).filter(
      (r) =>
        matches(r, show) &&
        (!depts.length || depts.includes(r.department || '—')) &&
        (!needle || `${r.employee_name} ${r.employee_code} ${r.designation}`.toLowerCase().includes(needle))
    );
  }, [rows, q, depts, show]);
  useEffect(() => setPage(1), [q, depts.join('|'), show, month]);
  const counts = useMemo(() => Object.fromEntries(SHOW.map((s) => [s.key, (rows || []).filter((r) => matches(r, s.key)).length])), [rows]);
  const sum = (k: keyof SheetRow) => shownRows.reduce((a, r) => a + (Number(r[k]) || 0), 0);
  const pageRows = shownRows.slice((page - 1) * pageSize, page * pageSize);

  const exportExcel = () => {
    const head = [
      'SL', 'Employee ID', 'Name', 'Department', 'Designation', 'Working days', 'Present', 'Absent', 'Leave', 'LWP', 'Late', 'Late cut (days)', 'OT hours',
      'Basic', 'Allowances', 'Overtime', 'Bonus', 'Extra pay', 'Gross', 'Absent cut', 'Late cut', 'Tax', 'PF', 'Advance / Loan', 'Other ded.', 'Extra ded.',
      'Total deduction', 'Net', `Net ${prevMonth}`, 'Change %', 'Status', 'Paid to'
    ];
    const body = shownRows.map((r, i) => {
      const c = changePct(r);
      return [
        i + 1, r.employee_code, r.employee_name, r.department, r.designation, r.working_days, r.present_days, r.absent_days, r.leave_days, r.lwp_days, r.late_count,
        r.late_deduction_days, r.overtime_hours, r.basic, r.allowances, r.overtime, r.bonus, r.extra_pay, r.gross, r.absent_deduction, r.late_deduction, r.tax, r.pf,
        r.advance, r.other_deduction, r.extra_deduction, r.total_deduction, r.net, r.last_net ?? '', c == null ? '' : Math.round(c * 10) / 10, r.status, r.paid_to
      ];
    });
    const ws = XLSX.utils.aoa_to_sheet([[`Salary Sheet — ${month}`], [], head, ...body]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Salary Sheet');
    XLSX.writeFile(wb, `Salary-Sheet-${month}.xlsx`);
  };

  const th = 'px-2.5 py-2 text-right font-semibold whitespace-nowrap';
  const td = 'px-2.5 py-2 text-right whitespace-nowrap tabular-nums';

  return (
    <div className="bg-white rounded-2xl border border-slate-200">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="flex items-center gap-2">
          <Table2 className="w-4 h-4 text-blue-600" />
          <span className="text-sm font-bold text-slate-800">Salary sheet</span>
          {rows && <span className="text-[11px] text-slate-500">{rows.length} employees — check every row here before approving or paying</span>}
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>
      {open && (
        <div className="border-t border-slate-100 p-4 space-y-3">
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          {!rows ? (
            !error && <LoadingBlock />
          ) : rows.length === 0 ? (
            <p className="text-xs text-slate-500">No salary for this month yet.</p>
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-2">
                <label className="relative">
                  <span className="sr-only">Search</span>
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, ID or designation" className="text-xs pl-8 pr-3 py-2 w-56 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none" />
                </label>
                <MultiSelectFilter label="Department" options={deptOptions} selected={depts} onChange={setDepts} />
                <div className="flex flex-wrap bg-slate-100 rounded-lg p-0.5">
                  {SHOW.map((s) => (
                    <button
                      key={s.key}
                      type="button"
                      aria-pressed={show === s.key}
                      onClick={() => setShow(s.key)}
                      className={`px-2.5 py-1.5 rounded-md text-[11px] font-semibold whitespace-nowrap ${show === s.key ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                    >
                      {s.label} <span className="text-slate-400">{counts[s.key]}</span>
                    </button>
                  ))}
                </div>
                <button type="button" onClick={exportExcel} disabled={!shownRows.length} className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
                  <FileSpreadsheet className="w-3.5 h-3.5" /> Excel (as shown)
                </button>
              </div>

              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="min-w-full text-xs">
                  <thead className="bg-slate-50 text-slate-500 text-[10px] uppercase tracking-wide">
                    <tr>
                      <th className="px-2.5 py-2 text-left font-semibold sticky left-0 z-10 bg-slate-50">Employee</th>
                      <th className="px-2.5 py-2 text-left font-semibold">Department</th>
                      <th className={th} title="Working / Present / Absent / Leave / Leave without pay">Days W / P / A / L / LWP</th>
                      <th className={th}>Late</th>
                      <th className={th}>Gross</th>
                      <th className={th} title="Absent + late deduction">Absent / late cut</th>
                      <th className={th} title="Tax + PF + advance / loan + other + extra deductions">Other deductions</th>
                      <th className={th}>Total ded.</th>
                      <th className={th}>Net</th>
                      <th className={th} title={`Net salary in ${prevMonth}`}>vs {prevMonth}</th>
                      <th className="px-2.5 py-2 text-left font-semibold">Paid to</th>
                      <th className="px-2.5 py-2 text-left font-semibold">Status</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {pageRows.length === 0 && (
                      <tr>
                        <td colSpan={12} className="px-4 py-8 text-center text-slate-400">Nobody matches these filters.</td>
                      </tr>
                    )}
                    {pageRows.map((r) => {
                      const c = changePct(r);
                      const big = c != null && Math.abs(c) >= 10;
                      const others = r.tax + r.pf + r.advance + r.other_deduction + r.extra_deduction;
                      const isOpen = expanded === r.id;
                      return (
                        <React.Fragment key={r.id}>
                          <tr className={`hover:bg-slate-50 cursor-pointer ${isOpen ? 'bg-blue-50/40' : ''}`} onClick={() => setExpanded(isOpen ? null : r.id)}>
                            <td className="px-2.5 py-2 sticky left-0 z-10 bg-white">
                              <button type="button" aria-expanded={isOpen} className="text-left">
                                <span className="block font-semibold text-slate-800 whitespace-nowrap">{r.employee_name}</span>
                                <span className="block text-[10px] text-slate-500 whitespace-nowrap">{[r.employee_code, r.designation].filter(Boolean).join(' · ')}</span>
                              </button>
                            </td>
                            <td className="px-2.5 py-2 whitespace-nowrap text-slate-600">{r.department || '—'}</td>
                            <td className={`${td} text-slate-600`}>
                              {r.working_days} / {r.present_days} / <span className={r.absent_days ? 'text-rose-700 font-semibold' : ''}>{r.absent_days}</span> / {r.leave_days} /{' '}
                              <span className={r.lwp_days ? 'text-rose-700 font-semibold' : ''}>{r.lwp_days}</span>
                            </td>
                            <td className={`${td} ${r.late_count ? 'text-amber-700 font-semibold' : 'text-slate-400'}`}>{r.late_count}</td>
                            <td className={`${td} text-slate-800`}>{n2(r.gross)}</td>
                            <td className={`${td} ${r.absent_deduction + r.late_deduction ? 'text-rose-700' : 'text-slate-400'}`}>{n2(r.absent_deduction + r.late_deduction)}</td>
                            <td className={`${td} text-slate-600`}>{n2(others)}</td>
                            <td className={`${td} text-rose-700`}>{n2(r.total_deduction)}</td>
                            <td className={`${td} font-bold text-slate-900`}>{n2(r.net)}</td>
                            <td className={`${td} ${r.last_net == null ? 'text-blue-700' : big ? (c! > 0 ? 'text-amber-700 font-semibold' : 'text-rose-700 font-semibold') : 'text-slate-500'}`}>
                              {r.last_net == null ? 'New' : `${c! > 0 ? '+' : ''}${Math.round(c! * 10) / 10}%`}
                            </td>
                            <td className="px-2.5 py-2 text-slate-600 max-w-[220px] truncate" title={r.paid_to}>{r.paid_to || <span className="text-amber-700">No account</span>}</td>
                            <td className="px-2.5 py-2 whitespace-nowrap">
                              <span
                                className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${
                                  r.status === 'held' ? 'bg-amber-100 text-amber-800' : r.status === 'paid' ? 'bg-emerald-100 text-emerald-800' : r.status === 'processed' ? 'bg-blue-100 text-blue-800' : 'bg-slate-100 text-slate-700'
                                }`}
                              >
                                {r.status === 'held' ? 'On hold' : r.status === 'processed' ? 'Approved' : r.status.charAt(0).toUpperCase() + r.status.slice(1)}
                              </span>
                            </td>
                          </tr>
                          {isOpen && (
                            <tr className="bg-slate-50/70">
                              <td colSpan={12} className="px-4 py-3">
                                <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-6 gap-x-6 gap-y-1.5 text-[11px]">
                                  {(
                                    [
                                      ['Basic', n2(r.basic)],
                                      ['Allowances', n2(r.allowances)],
                                      ['Overtime', `${n2(r.overtime)} (${r.overtime_hours} h)`],
                                      ['Bonus', n2(r.bonus)],
                                      ['Extra pay', n2(r.extra_pay)],
                                      ['Gross', n2(r.gross)],
                                      ['Absent cut', n2(r.absent_deduction)],
                                      ['Late cut', `${n2(r.late_deduction)} (${r.late_deduction_days} day)`],
                                      ['Tax', n2(r.tax)],
                                      ['PF', n2(r.pf)],
                                      ['Advance / Loan', n2(r.advance)],
                                      ['Other ded.', n2(r.other_deduction)],
                                      ['Extra ded.', n2(r.extra_deduction)],
                                      ['Total deduction', n2(r.total_deduction)],
                                      ['Net', n2(r.net)],
                                      [`Net ${prevMonth}`, r.last_net == null ? '—' : n2(r.last_net)]
                                    ] as [string, string][]
                                  ).map(([k, v]) => (
                                    <div key={k} className="flex justify-between gap-2 border-b border-slate-200/70 py-0.5">
                                      <span className="text-slate-500">{k}</span>
                                      <span className="font-semibold text-slate-800 tabular-nums">{v}</span>
                                    </div>
                                  ))}
                                </div>
                                {(r.hold_reason || r.remarks) && (
                                  <p className="text-[11px] text-slate-600 mt-2">
                                    {r.hold_reason && <><b>On hold:</b> {r.hold_reason} </>}
                                    {r.remarks && <><b>Remarks:</b> {r.remarks}</>}
                                  </p>
                                )}
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      );
                    })}
                  </tbody>
                  {shownRows.length > 0 && (
                    <tfoot className="bg-slate-50 font-bold text-slate-800">
                      <tr>
                        <td className="px-2.5 py-2 sticky left-0 z-10 bg-slate-50 whitespace-nowrap">Total ({shownRows.length})</td>
                        <td />
                        <td />
                        <td className={td}>{sum('late_count')}</td>
                        <td className={td}>{n2(sum('gross'))}</td>
                        <td className={td}>{n2(sum('absent_deduction') + sum('late_deduction'))}</td>
                        <td className={td}>{n2(sum('tax') + sum('pf') + sum('advance') + sum('other_deduction') + sum('extra_deduction'))}</td>
                        <td className={td}>{n2(sum('total_deduction'))}</td>
                        <td className={td}>{n2(sum('net'))}</td>
                        <td className={td}>{n2(shownRows.reduce((a, r) => a + (r.last_net || 0), 0))}</td>
                        <td colSpan={2} />
                      </tr>
                    </tfoot>
                  )}
                </table>
              </div>
              {shownRows.length > pageSize || page > 1 ? (
                <PagerBar page={page} pageSize={pageSize} total={shownRows.length} onPage={setPage} onPageSize={(sz) => { setPageSize(sz); setPage(1); }} />
              ) : null}
              <p className="text-[11px] text-slate-500">Click a row for the full breakdown. "vs {prevMonth}" is the change in net salary from last month; 10% or more is marked.</p>
            </>
          )}
        </div>
      )}
    </div>
  );
};
