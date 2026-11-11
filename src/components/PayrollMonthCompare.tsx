// Payroll -> Approval -> Month comparison (Payroll layer "month_compare"):
// this month's salaries against last month's (or any month picked) —
// headcount and totals, a bridge from last month's net to this month's
// (new joiners, people who left, and each salary part that moved for
// everyone else), departments side by side, and per person what changed
// and why. Excel of all of it. GET /api/payroll/approval/:month/compare.
import { maskMoney } from '../lib/payrollAmounts';
import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { ArrowDownRight, ArrowUpRight, ChevronDown, ChevronRight, FileSpreadsheet, GitCompare, Search } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { LoadingBlock } from './LoadingBlock';
import { PagerBar } from './PagerBar';
import { saveWorkbookCrossPlatform } from '../lib/saveFile';

interface Reason {
  label: string;
  effect: number;
  note: string;
}
interface PersonRow {
  employee_id: number;
  employee_code: string;
  employee_name: string;
  department: string;
  designation: string;
  last_net: number | null;
  this_net: number | null;
  diff: number;
  held: boolean;
  kind: 'new' | 'left' | 'changed' | 'same';
  why?: string;
  reasons: Reason[];
}
interface DeptRow {
  department: string;
  last_count: number;
  last_net: number;
  this_count: number;
  this_net: number;
  new_count: number;
  left_count: number;
  changed_count: number;
  diff: number;
}
interface Compare {
  month_year: string;
  previous_month: string;
  summary: {
    last_count: number;
    last_net: number;
    last_gross: number;
    this_count: number;
    this_net: number;
    this_gross: number;
    diff: number;
    diff_pct: number | null;
    new_count: number;
    left_count: number;
    changed_count: number;
    same_count: number;
  };
  bridge: { key: string; label: string; amount: number }[];
  departments: DeptRow[];
  people: PersonRow[];
}

const n2 = maskMoney((v: number) => (Number(v) || 0).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
const signed = (v: number) => `${v > 0 ? '+' : v < 0 ? '−' : ''}${n2(Math.abs(v))}`;
const tone = (v: number) => (v > 0 ? 'text-emerald-700' : v < 0 ? 'text-rose-700' : 'text-slate-500');
const monthName = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(Date.UTC(y, mo - 1, 1)).toLocaleString('en-GB', { month: 'short', year: 'numeric', timeZone: 'UTC' });
};
type Tab = 'changed' | 'new' | 'left' | 'all';

export const PayrollMonthCompare: React.FC<{ token: string; month: string }> = ({ token, month }) => {
  const [vs, setVs] = useState('');
  const [data, setData] = useState<Compare | null>(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<Tab>('changed');
  const [dept, setDept] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [page, setPage] = useState(1);
  const [pageSize, setPageSize] = useState(50);

  useEffect(() => setVs(''), [month]);
  useEffect(() => {
    let live = true;
    setData(null);
    setError('');
    fetch(apiUrl(`/api/payroll/approval/${month}/compare${vs ? `?vs=${vs}` : ''}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load the comparison.');
        return d as Compare;
      })
      .then((d) => live && setData(d))
      .catch((e) => live && setError(e.message));
    return () => {
      live = false;
    };
  }, [token, month, vs]);
  useEffect(() => setPage(1), [tab, dept, q, month, vs]);

  const list = useMemo(() => {
    if (!data) return [];
    const needle = q.trim().toLowerCase();
    return data.people.filter(
      (p) =>
        (tab === 'all' ? true : p.kind === tab) &&
        (!dept || p.department === dept) &&
        (!needle || `${p.employee_name} ${p.employee_code} ${p.designation}`.toLowerCase().includes(needle))
    );
  }, [data, tab, dept, q]);

  const exportExcel = () => {
    if (!data) return;
    const { summary: s, previous_month: pm, month_year: m } = data;
    const wb = XLSX.utils.book_new();
    const sum = [
      [`Payroll month comparison — ${m} vs ${pm}`],
      [],
      ['', pm, m, 'Difference'],
      ['Employees paid', s.last_count, s.this_count, s.this_count - s.last_count],
      ['Gross', s.last_gross, s.this_gross, s.this_gross - s.last_gross],
      ['Net', s.last_net, s.this_net, s.diff],
      [],
      ['Why the net total changed', 'Amount'],
      [`Net ${pm}`, s.last_net],
      ...data.bridge.map((b) => [b.label, b.amount]),
      [`Net ${m}`, s.this_net]
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sum), 'Summary');
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Department', `Employees ${pm}`, `Net ${pm}`, `Employees ${m}`, `Net ${m}`, 'Difference', 'New', 'Left', 'Changed'],
        ...data.departments.map((d) => [d.department, d.last_count, d.last_net, d.this_count, d.this_net, d.diff, d.new_count, d.left_count, d.changed_count])
      ]),
      'Departments'
    );
    const KIND: Record<string, string> = { new: 'New', left: 'Left', changed: 'Changed', same: 'No change' };
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['Employee ID', 'Name', 'Department', 'Designation', 'Type', `Net ${pm}`, `Net ${m}`, 'Difference', 'Why'],
        ...data.people.map((p) => [
          p.employee_code, p.employee_name, p.department, p.designation, KIND[p.kind], p.last_net ?? '', p.this_net ?? '', p.diff,
          p.why || p.reasons.map((r) => `${r.label} ${r.effect ? signed(r.effect) : ''}${r.note ? ` [${r.note}]` : ''}`.trim()).join('; ')
        ])
      ]),
      'Employees'
    );
    void saveWorkbookCrossPlatform(wb, `Payroll-Comparison-${m}-vs-${pm}.xlsx`);
  };

  const s = data?.summary;
  const maxBridge = data ? Math.max(1, ...data.bridge.map((b) => Math.abs(b.amount))) : 1;
  const TABS: { key: Tab; label: string; count: number }[] = s
    ? [
        { key: 'changed', label: 'Changed', count: s.changed_count },
        { key: 'new', label: 'New', count: s.new_count },
        { key: 'left', label: 'Left / not paid', count: s.left_count },
        { key: 'all', label: 'Everyone', count: data!.people.length }
      ]
    : [];

  return (
    <div className="bg-white rounded-2xl border border-slate-200">
      <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left">
        <span className="flex items-center gap-2">
          <GitCompare className="w-4 h-4 text-violet-600" />
          <span className="text-sm font-bold text-slate-800">Month comparison</span>
          {data && (
            <span className="text-[11px] text-slate-500">
              {monthName(data.month_year)} vs {monthName(data.previous_month)} — who is new, who left, and why each salary changed
            </span>
          )}
        </span>
        {open ? <ChevronDown className="w-4 h-4 text-slate-400" /> : <ChevronRight className="w-4 h-4 text-slate-400" />}
      </button>
      {open && (
        <div className="border-t border-slate-100 p-4 space-y-4">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label htmlFor="cmp-vs" className="block text-[10px] font-semibold text-slate-500 mb-1">Compare with</label>
              <input id="cmp-vs" type="month" value={vs || data?.previous_month || ''} max={month} onChange={(e) => setVs(e.target.value)} className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg" />
            </div>
            <button type="button" onClick={exportExcel} disabled={!data} className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-lg text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              <FileSpreadsheet className="w-3.5 h-3.5" /> Excel (summary, departments, employees)
            </button>
          </div>
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          {!data ? (
            !error && <LoadingBlock />
          ) : (
            <>
              {/* Totals */}
              <div className="grid grid-cols-2 lg:grid-cols-6 gap-2">
                {(
                  [
                    [`Net ${monthName(data.previous_month)}`, n2(s!.last_net), `${s!.last_count} employees`, ''],
                    [`Net ${monthName(data.month_year)}`, n2(s!.this_net), `${s!.this_count} employees`, ''],
                    ['Difference', signed(s!.diff), s!.diff_pct == null ? '—' : `${s!.diff_pct > 0 ? '+' : ''}${s!.diff_pct}%`, tone(s!.diff)],
                    ['New', String(s!.new_count), 'first salary this month', 'text-blue-700'],
                    ['Left / not paid', String(s!.left_count), `paid in ${monthName(data.previous_month)}, not now`, 'text-amber-700'],
                    ['Salary changed', String(s!.changed_count), `${s!.same_count} unchanged`, 'text-violet-700']
                  ] as [string, string, string, string][]
                ).map(([k, v, sub, t]) => (
                  <div key={k} className="rounded-xl border border-slate-200 px-3 py-2.5">
                    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                    <div className={`text-base font-extrabold tabular-nums ${t || 'text-slate-900'}`}>{v}</div>
                    <div className="text-[11px] text-slate-500">{sub}</div>
                  </div>
                ))}
              </div>

              <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
                {/* Bridge */}
                <div className="rounded-xl border border-slate-200 p-3">
                  <div className="text-xs font-bold text-slate-700 mb-2">Why the net total changed</div>
                  <div className="flex justify-between text-xs font-semibold text-slate-700 border-b border-slate-100 pb-1.5 mb-1.5">
                    <span>Net {monthName(data.previous_month)}</span>
                    <span className="tabular-nums">{n2(s!.last_net)}</span>
                  </div>
                  {data.bridge.length === 0 && <p className="text-[11px] text-slate-400 py-2">Nothing changed.</p>}
                  {data.bridge.map((b) => (
                    <div key={b.key} className="grid grid-cols-[minmax(130px,1fr)_minmax(80px,1.2fr)_110px] items-center gap-2 py-1 text-xs">
                      <span className="text-slate-600">{b.label}</span>
                      <span className="h-2 rounded-full bg-slate-100 overflow-hidden">
                        <span className={`block h-2 rounded-full ${b.amount >= 0 ? 'bg-emerald-500' : 'bg-rose-500'}`} style={{ width: `${(Math.abs(b.amount) / maxBridge) * 100}%` }} />
                      </span>
                      <span className={`text-right font-semibold tabular-nums ${tone(b.amount)}`}>{signed(b.amount)}</span>
                    </div>
                  ))}
                  <div className="flex justify-between text-xs font-bold text-slate-900 border-t border-slate-100 pt-1.5 mt-1.5">
                    <span>Net {monthName(data.month_year)}</span>
                    <span className="tabular-nums">{n2(s!.this_net)}</span>
                  </div>
                </div>

                {/* Departments */}
                <div className="rounded-xl border border-slate-200 overflow-x-auto">
                  <table className="min-w-full text-xs">
                    <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500">
                      <tr>
                        <th className="px-2.5 py-2 text-left font-semibold">Department</th>
                        <th className="px-2.5 py-2 text-right font-semibold">{monthName(data.previous_month)}</th>
                        <th className="px-2.5 py-2 text-right font-semibold">{monthName(data.month_year)}</th>
                        <th className="px-2.5 py-2 text-right font-semibold">Difference</th>
                        <th className="px-2.5 py-2 text-right font-semibold" title="New / Left / Changed">N / L / C</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {data.departments.map((d) => (
                        <tr key={d.department} className={dept === d.department ? 'bg-violet-50' : ''}>
                          <td className="px-2.5 py-1.5">
                            <button type="button" onClick={() => setDept(dept === d.department ? null : d.department)} className="font-semibold text-slate-800 hover:text-violet-700 text-left">
                              {d.department}
                            </button>
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-600">
                            {n2(d.last_net)} <span className="text-slate-400">({d.last_count})</span>
                          </td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-800">
                            {n2(d.this_net)} <span className="text-slate-400">({d.this_count})</span>
                          </td>
                          <td className={`px-2.5 py-1.5 text-right tabular-nums font-semibold ${tone(d.diff)}`}>{signed(d.diff)}</td>
                          <td className="px-2.5 py-1.5 text-right tabular-nums text-slate-600">
                            {d.new_count} / {d.left_count} / {d.changed_count}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  <p className="text-[10px] text-slate-400 px-2.5 py-1.5">Click a department to see only its people below.</p>
                </div>
              </div>

              {/* People */}
              <div className="space-y-2">
                <div className="flex flex-wrap items-center gap-2">
                  <div className="flex flex-wrap bg-slate-100 rounded-lg p-0.5">
                    {TABS.map((t) => (
                      <button
                        key={t.key}
                        type="button"
                        aria-pressed={tab === t.key}
                        onClick={() => setTab(t.key)}
                        className={`px-2.5 py-1.5 rounded-md text-[11px] font-semibold ${tab === t.key ? 'bg-white text-violet-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
                      >
                        {t.label} <span className="text-slate-400">{t.count}</span>
                      </button>
                    ))}
                  </div>
                  {dept && (
                    <button type="button" onClick={() => setDept(null)} className="text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-violet-50 text-violet-700">
                      {dept} ✕
                    </button>
                  )}
                  <label className="relative ml-auto">
                    <span className="sr-only">Search</span>
                    <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                    <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, ID or designation" className="text-xs pl-8 pr-3 py-2 w-56 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-violet-600 focus:outline-none" />
                  </label>
                </div>
                <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                  {list.length === 0 && <p className="text-xs text-slate-400 text-center py-8">Nobody here.</p>}
                  {list.slice((page - 1) * pageSize, page * pageSize).map((p) => (
                    <div key={p.employee_id} className="px-3 py-2.5 grid grid-cols-1 md:grid-cols-[minmax(200px,1.2fr)_minmax(220px,1fr)_minmax(260px,2fr)] gap-2 items-start">
                      <div className="min-w-0">
                        <div className="flex items-center gap-1.5">
                          <span className="text-sm font-semibold text-slate-800 truncate">{p.employee_name}</span>
                          {p.kind === 'new' && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-blue-100 text-blue-800">NEW</span>}
                          {p.kind === 'left' && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-amber-100 text-amber-800">LEFT</span>}
                          {p.held && <span className="text-[10px] font-bold px-1.5 py-0.5 rounded bg-slate-200 text-slate-700">ON HOLD</span>}
                        </div>
                        <div className="text-[11px] text-slate-500 truncate">{[p.employee_code, p.designation, p.department].filter(Boolean).join(' · ')}</div>
                      </div>
                      <div className="flex items-center gap-2 text-xs tabular-nums">
                        <span className="text-slate-500">{p.last_net == null ? '—' : n2(p.last_net)}</span>
                        <span className="text-slate-300">→</span>
                        <span className="font-semibold text-slate-800">{p.this_net == null ? '—' : n2(p.this_net)}</span>
                        <span className={`inline-flex items-center font-bold ${tone(p.diff)}`}>
                          {p.diff > 0 ? <ArrowUpRight className="w-3.5 h-3.5" /> : p.diff < 0 ? <ArrowDownRight className="w-3.5 h-3.5" /> : null}
                          {signed(p.diff)}
                        </span>
                      </div>
                      <div className="text-[11px] text-slate-600 space-y-0.5">
                        {p.why && <div className="font-medium text-slate-700">{p.why}</div>}
                        {p.reasons.map((r, i) => (
                          <div key={i}>
                            <span className="font-semibold text-slate-700">{r.label}</span>
                            {r.effect !== 0 && <span className={`font-semibold ${tone(r.effect)}`}> {signed(r.effect)}</span>}
                            {r.note && <span className="text-slate-500"> — {r.note}</span>}
                          </div>
                        ))}
                        {!p.why && p.reasons.length === 0 && <span className="text-slate-400">No change</span>}
                      </div>
                    </div>
                  ))}
                </div>
                {list.length > pageSize || page > 1 ? (
                  <PagerBar page={page} pageSize={pageSize} total={list.length} onPage={setPage} onPageSize={(sz) => { setPageSize(sz); setPage(1); }} />
                ) : null}
                <p className="text-[11px] text-slate-500">
                  Amounts are each part's effect on net salary: green raises it, red lowers it (a bigger deduction shows red). "Left / not paid" = paid last time, no salary this month — with the exit request when there is one.
                </p>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
