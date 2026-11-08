// Monthly Attendance Report -> Custom Report: the Attendance Report Builder.
// Ask anything about attendance — "who came after 09:05 today", "who left
// before 18:00", "absent today", "no check-out this month", "late 3+ times
// this month by person", "this month by department" — by picking a period,
// departments / a person, any number of conditions on any column, and
// Detail rows or a Summary grouped by employee / department / designation /
// date / weekday / status (with "only where late >= 3"). PDF and Excel.
// POST /api/attendance/report/custom (Attendance Reports layer
// "custom_report"; the server keeps to the account's Departments).
import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import jsPDF from '../lib/jspdf';
import autoTable from 'jspdf-autotable';
import { FileDown, FileSpreadsheet, Play, Plus, Sparkles, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { drawStandardHeader, loadPdfCompany, standardTable } from '../lib/pdfStandard';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform, saveWorkbookCrossPlatform } from '../lib/saveFile';
import { MultiSelectFilter } from './MultiSelectFilter';
import { SearchSelect } from './Combobox';
import { Spinner } from './Spinner';

type FieldType = 'time' | 'number' | 'enum' | 'text' | 'bool' | 'date';
const FIELDS: { key: string; label: string; type: FieldType; values?: { v: string; l: string }[] }[] = [
  { key: 'date', label: 'Date', type: 'date' },
  { key: 'weekday', label: 'Weekday', type: 'enum', values: ['Saturday', 'Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday'].map((d) => ({ v: d, l: d })) },
  { key: 'employee_name', label: 'Name', type: 'text' },
  { key: 'employee_code', label: 'Employee ID', type: 'text' },
  { key: 'designation', label: 'Designation', type: 'text' },
  { key: 'department', label: 'Department', type: 'text' },
  { key: 'status', label: 'Status', type: 'enum', values: [{ v: 'present', l: 'Present' }, { v: 'absent', l: 'Absent' }, { v: 'leave', l: 'Leave' }, { v: 'holiday', l: 'Holiday' }, { v: 'weekend', l: 'Weekend' }, { v: 'off', l: 'Off (roster)' }] },
  { key: 'in_time', label: 'In time', type: 'time' },
  { key: 'out_time', label: 'Out time', type: 'time' },
  { key: 'work_hours', label: 'Work hours', type: 'number' },
  { key: 'late', label: 'Late', type: 'enum', values: [{ v: 'none', l: 'On time' }, { v: 'delay', l: 'Delay' }, { v: 'extreme', l: 'Extreme Delay' }] },
  { key: 'late_minutes', label: 'Minutes late', type: 'number' },
  { key: 'early_leave_minutes', label: 'Minutes left early', type: 'number' },
  { key: 'overtime_minutes', label: 'Overtime minutes', type: 'number' },
  { key: 'missing_out', label: 'No check-out', type: 'bool' },
  { key: 'shift', label: 'Shift', type: 'text' },
  { key: 'shift_start', label: 'Shift start', type: 'time' },
  { key: 'shift_end', label: 'Shift end', type: 'time' },
  { key: 'source', label: 'Source', type: 'enum', values: [{ v: 'remote', l: 'Remote (GPS)' }, { v: 'office', l: 'Office device' }, { v: 'site', l: 'Team sheet (site)' }] },
  { key: 'project', label: 'Project', type: 'text' },
  { key: 'leave_type', label: 'Leave type', type: 'text' },
  { key: 'holiday', label: 'Holiday', type: 'text' }
];
const FIELD = Object.fromEntries(FIELDS.map((f) => [f.key, f]));
const OPS: Record<FieldType, { v: string; l: string }[]> = {
  time: [{ v: 'after', l: 'after' }, { v: 'at_or_after', l: 'at or after' }, { v: 'before', l: 'before' }, { v: 'at_or_before', l: 'at or before' }, { v: 'between', l: 'between' }, { v: 'is_empty', l: 'is empty' }, { v: 'not_empty', l: 'is not empty' }],
  number: [{ v: 'gt', l: '>' }, { v: 'gte', l: '≥' }, { v: 'lt', l: '<' }, { v: 'lte', l: '≤' }, { v: 'eq', l: '=' }, { v: 'between', l: 'between' }],
  enum: [{ v: 'in', l: 'is any of' }, { v: 'not_in', l: 'is none of' }],
  text: [{ v: 'contains', l: 'contains' }, { v: 'eq', l: 'is' }, { v: 'neq', l: 'is not' }, { v: 'is_empty', l: 'is empty' }, { v: 'not_empty', l: 'is not empty' }],
  bool: [{ v: 'is_true', l: 'yes' }, { v: 'is_false', l: 'no' }],
  date: [{ v: 'eq', l: 'is' }, { v: 'after', l: 'after' }, { v: 'before', l: 'before' }]
};
const GROUPS = [
  { v: 'employee', l: 'Employee' },
  { v: 'department', l: 'Department' },
  { v: 'designation', l: 'Designation' },
  { v: 'date', l: 'Date' },
  { v: 'weekday', l: 'Weekday' },
  { v: 'status', l: 'Status' }
];
const METRICS = [
  { v: 'employees', l: 'Employees' },
  { v: 'days', l: 'Days' },
  { v: 'present', l: 'Present' },
  { v: 'absent', l: 'Absent' },
  { v: 'leave', l: 'Leave' },
  { v: 'late', l: 'Late (all)' },
  { v: 'delay', l: 'Delay' },
  { v: 'extreme', l: 'Extreme Delay' },
  { v: 'missing_out', l: 'No check-out' },
  { v: 'early_leave', l: 'Left early' },
  { v: 'overtime_days', l: 'Overtime days' },
  { v: 'avg_in', l: 'Avg in' },
  { v: 'avg_out', l: 'Avg out' },
  { v: 'avg_hours', l: 'Avg hours' },
  { v: 'total_ot_hours', l: 'Overtime hours' },
  { v: 'attendance_pct', l: 'Attendance %' }
];
const NUM_METRICS = METRICS.filter((m) => !['avg_in', 'avg_out'].includes(m.v));
const DEFAULT_COLS = ['date', 'employee_name', 'employee_code', 'department', 'status', 'in_time', 'out_time', 'work_hours', 'late', 'late_minutes', 'early_leave_minutes'];

interface Cond {
  field: string;
  op: string;
  value: any;
  value2?: any;
}
type Period = 'today' | 'yesterday' | 'this_week' | 'this_month' | 'last_month' | 'custom';
interface Query {
  period: Period;
  from: string;
  to: string;
  departments: string[];
  employeeId: string;
  conditions: Cond[];
  match: 'all' | 'any';
  view: 'detail' | 'summary';
  groupBy: string;
  having: { metric: string; op: string; value: string } | null;
  sort: string;
  officeEnd: string;
  columns: string[];
}

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * 864e5).toISOString().slice(0, 10);
function periodRange(p: Period, from: string, to: string): [string, string] {
  const t = today();
  if (p === 'today') return [t, t];
  if (p === 'yesterday') return [addDays(t, -1), addDays(t, -1)];
  if (p === 'this_week') {
    // Week starts Saturday (Bangladesh office week).
    const wd = new Date(`${t}T00:00:00Z`).getUTCDay();
    return [addDays(t, -((wd + 1) % 7)), t];
  }
  if (p === 'this_month') return [`${t.slice(0, 7)}-01`, t];
  if (p === 'last_month') {
    const first = `${t.slice(0, 7)}-01`;
    const lastPrev = addDays(first, -1);
    return [`${lastPrev.slice(0, 7)}-01`, lastPrev];
  }
  return [from || t, to || from || t];
}
const blank = (): Query => ({
  period: 'today', from: today(), to: today(), departments: [], employeeId: '', conditions: [], match: 'all', view: 'detail', groupBy: 'employee', having: null, sort: '', officeEnd: '18:00', columns: DEFAULT_COLS
});
// One-click questions an HR person asks most.
const PRESETS: { label: string; q: Partial<Query> }[] = [
  { label: 'আজ ৯:০৫-এর পরে এসেছে', q: { period: 'today', conditions: [{ field: 'in_time', op: 'after', value: '09:05' }] } },
  { label: 'আজ ৬টার আগে বের হয়েছে', q: { period: 'today', conditions: [{ field: 'out_time', op: 'before', value: '18:00' }] } },
  { label: 'আজ অনুপস্থিত', q: { period: 'today', conditions: [{ field: 'status', op: 'in', value: ['absent'] }] } },
  { label: 'আজ ছুটিতে', q: { period: 'today', conditions: [{ field: 'status', op: 'in', value: ['leave'] }] } },
  { label: 'Check-out দেয়নি (এ মাস)', q: { period: 'this_month', conditions: [{ field: 'missing_out', op: 'is_true', value: true }] } },
  { label: 'এ মাসে ৩+ বার দেরি', q: { period: 'this_month', view: 'summary', groupBy: 'employee', having: { metric: 'late', op: 'gte', value: '3' }, sort: 'late' } },
  { label: 'অনেক দেরি (এ মাস)', q: { period: 'this_month', conditions: [{ field: 'late', op: 'in', value: ['extreme'] }] } },
  { label: '৮ ঘণ্টার কম কাজ (এ সপ্তাহ)', q: { period: 'this_week', conditions: [{ field: 'work_hours', op: 'lt', value: '8' }] } },
  { label: 'Overtime (এ মাস)', q: { period: 'this_month', view: 'summary', groupBy: 'employee', conditions: [{ field: 'overtime_minutes', op: 'gt', value: '0' }], sort: 'total_ot_hours' } },
  { label: 'Department অনুযায়ী (এ মাস)', q: { period: 'this_month', view: 'summary', groupBy: 'department' } },
  { label: 'দিনভিত্তিক (এ সপ্তাহ)', q: { period: 'this_week', view: 'summary', groupBy: 'date' } },
  { label: 'কর্মী অনুযায়ী (গত মাস)', q: { period: 'last_month', view: 'summary', groupBy: 'employee', sort: 'absent' } }
];

const fmtVal = (key: string, v: any) => {
  if (v === null || v === undefined || v === '') return '';
  if (typeof v === 'boolean') return v ? 'Yes' : '';
  if (key === 'status' || key === 'late' || key === 'source') return FIELD[key]?.values?.find((x) => x.v === v)?.l || String(v);
  return String(v);
};
const describe = (q: Query, from: string, to: string) => {
  const bits = [`${from}${to !== from ? ` → ${to}` : ''}`];
  if (q.departments.length) bits.push(q.departments.join(', '));
  for (const c of q.conditions) {
    const f = FIELD[c.field];
    const op = OPS[f.type].find((o) => o.v === c.op)?.l || c.op;
    const val = Array.isArray(c.value) ? c.value.map((x: string) => fmtVal(c.field, x)).join(' / ') : c.op === 'between' ? `${c.value} – ${c.value2}` : f.type === 'bool' ? '' : c.value;
    bits.push(`${f.label} ${op}${val ? ` ${val}` : ''}`);
  }
  if (q.view === 'summary') bits.push(`by ${GROUPS.find((g) => g.v === q.groupBy)?.l}`);
  if (q.view === 'summary' && q.having) bits.push(`only ${METRICS.find((m) => m.v === q.having!.metric)?.l} ${q.having.op === 'gte' ? '≥' : q.having.op === 'lte' ? '≤' : q.having.op === 'gt' ? '>' : q.having.op === 'lt' ? '<' : '='} ${q.having.value}`);
  return bits.join(' · ');
};

export const AttendanceReportBuilder: React.FC<{ token: string; departments: string[] }> = ({ token, departments }) => {
  const [q, setQ] = useState<Query>(blank());
  const [people, setPeople] = useState<{ user_id: number; name: string; employee_code: string; designation: string; department: string }[]>([]);
  const [result, setResult] = useState<any>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showCols, setShowCols] = useState(false);
  const headers = { Authorization: `Bearer ${token}` };

  useEffect(() => {
    fetch(apiUrl('/api/attendance/report/custom/people'), { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((d) => setPeople(Array.isArray(d) ? d : []))
      .catch(() => setPeople([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const [from, to] = periodRange(q.period, q.from, q.to);
  const run = async (query: Query = q) => {
    const [f, t] = periodRange(query.period, query.from, query.to);
    setLoading(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/attendance/report/custom'), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          from: f,
          to: t,
          departments: query.departments,
          employee_ids: query.employeeId ? [Number(query.employeeId)] : [],
          conditions: query.conditions.filter((c) => FIELD[c.field]),
          match: query.match,
          view: query.view,
          group_by: query.groupBy,
          having: query.view === 'summary' && query.having && query.having.value !== '' ? { ...query.having, value: Number(query.having.value) } : null,
          sort: query.sort,
          office_end: query.officeEnd
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not build the report.');
      setResult({ ...d, query, description: describe(query, f, t) });
    } catch (e: any) {
      setError(e.message);
      setResult(null);
    } finally {
      setLoading(false);
    }
  };
  const preset = (p: Partial<Query>) => {
    const next = { ...blank(), departments: q.departments, officeEnd: q.officeEnd, columns: q.columns, ...p };
    setQ(next);
    void run(next);
  };
  const setCond = (i: number, c: Partial<Cond>) => setQ((x) => ({ ...x, conditions: x.conditions.map((y, j) => (j === i ? { ...y, ...c } : y)) }));
  const addCond = () => setQ((x) => ({ ...x, conditions: [...x.conditions, { field: 'in_time', op: 'after', value: '09:05' }] }));

  const deptOptions = useMemo(() => departments.map((d) => ({ value: d, label: d })), [departments]);
  const cols = q.columns.filter((c) => FIELD[c]);
  const input = 'text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none';
  const isSummary = result?.view === 'summary';
  const groupLabel = GROUPS.find((g) => g.v === result?.group_by)?.l || 'Group';
  const sumCols = METRICS;
  const tableHead = isSummary ? [groupLabel, ...(result?.group_by === 'employee' ? ['Department'] : []), ...sumCols.map((m) => m.l)] : (result?.query?.columns || cols).map((c: string) => FIELD[c]?.label || c);
  const tableRows: (string | number)[][] = !result
    ? []
    : isSummary
      ? (result.groups || []).map((g: any) => [g.key, ...(result.group_by === 'employee' ? [g.department || ''] : []), ...sumCols.map((m) => g[m.v] ?? '')])
      : (result.rows || []).map((r: any) => (result.query.columns as string[]).map((c) => fmtVal(c, r[c])));
  const fileBase = `Attendance-Report-${from}${to !== from ? `-to-${to}` : ''}`;

  const exportExcel = () => {
    const ws = XLSX.utils.aoa_to_sheet([[`Attendance report — ${result.description}`], [], tableHead, ...tableRows]);
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, isSummary ? 'Summary' : 'Detail');
    void saveWorkbookCrossPlatform(wb, `${fileBase}.xlsx`);
  };
  const exportPdf = async () => {
    const co = await loadPdfCompany(token);
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
    const y = drawStandardHeader(doc, co, 'Attendance Report', [['Report', result.description], ['Rows', String(tableRows.length)]]);
    autoTable(doc, { ...standardTable(y + 4), head: [tableHead], body: tableRows.map((r) => r.map((v) => String(v))) });
    finalizePdfPageNumbers(doc);
    await savePdfCrossPlatform(doc, `${fileBase}.pdf`);
  };

  return (
    <div className="p-4 sm:p-6 space-y-4">
      {/* One-click questions */}
      <div>
        <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500 mb-1.5"><Sparkles className="w-3.5 h-3.5 text-violet-600" /> এক ক্লিকে</div>
        <div className="flex flex-wrap gap-1.5">
          {PRESETS.map((p) => (
            <button key={p.label} type="button" onClick={() => preset(p.q)} className="text-[11px] font-semibold px-2.5 py-1.5 rounded-full border border-violet-200 bg-violet-50 text-violet-800 hover:bg-violet-100">
              {p.label}
            </button>
          ))}
        </div>
      </div>

      {/* Who and when */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <label htmlFor="arb-period" className="block text-[10px] font-semibold text-slate-500 mb-1">Period</label>
          <select id="arb-period" value={q.period} onChange={(e) => setQ({ ...q, period: e.target.value as Period })} className={input}>
            <option value="today">Today</option>
            <option value="yesterday">Yesterday</option>
            <option value="this_week">This week</option>
            <option value="this_month">This month</option>
            <option value="last_month">Last month</option>
            <option value="custom">Custom dates</option>
          </select>
        </div>
        {q.period === 'custom' && (
          <>
            <div>
              <label htmlFor="arb-from" className="block text-[10px] font-semibold text-slate-500 mb-1">From</label>
              <input id="arb-from" type="date" value={q.from} max={today()} onChange={(e) => setQ({ ...q, from: e.target.value })} className={input} />
            </div>
            <div>
              <label htmlFor="arb-to" className="block text-[10px] font-semibold text-slate-500 mb-1">To</label>
              <input id="arb-to" type="date" value={q.to} max={today()} onChange={(e) => setQ({ ...q, to: e.target.value })} className={input} />
            </div>
          </>
        )}
        <div>
          <span className="block text-[10px] font-semibold text-slate-500 mb-1">Departments</span>
          <MultiSelectFilter label="Department" options={deptOptions} selected={q.departments} onChange={(v) => setQ({ ...q, departments: v })} />
        </div>
        <div className="min-w-[240px]">
          <span className="block text-[10px] font-semibold text-slate-500 mb-1">Employee</span>
          <SearchSelect value={q.employeeId} onChange={(e) => setQ({ ...q, employeeId: e.target.value })} className={`${input} w-full`}>
            <option value="">— All employees —</option>
            {people.map((p) => (
              <option key={p.user_id} value={p.user_id}>{[p.name, p.employee_code, p.designation, p.department].filter(Boolean).join(' · ')}</option>
            ))}
          </SearchSelect>
        </div>
        <div>
          <label htmlFor="arb-end" className="block text-[10px] font-semibold text-slate-500 mb-1" title="Used for left early / overtime when no Duty Roster shift is set">Office ends</label>
          <input id="arb-end" type="time" value={q.officeEnd} onChange={(e) => setQ({ ...q, officeEnd: e.target.value || '18:00' })} className={input} />
        </div>
      </div>

      {/* Conditions */}
      <div className="rounded-xl border border-slate-200 p-3 space-y-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-slate-700">
          শর্ত
          {q.conditions.length > 1 && (
            <span className="flex bg-slate-100 rounded-md p-0.5 text-[11px]">
              {(['all', 'any'] as const).map((m) => (
                <button key={m} type="button" onClick={() => setQ({ ...q, match: m })} aria-pressed={q.match === m} className={`px-2 py-0.5 rounded ${q.match === m ? 'bg-white shadow-sm text-blue-700' : 'text-slate-500'}`}>
                  {m === 'all' ? 'সবগুলো মিলবে' : 'যেকোনো একটা'}
                </button>
              ))}
            </span>
          )}
        </div>
        {q.conditions.length === 0 && <p className="text-[11px] text-slate-400">কোনো শর্ত নেই — সবার সব দিন দেখাবে।</p>}
        {q.conditions.map((c, i) => {
          const f = FIELD[c.field];
          return (
            <div key={i} className="flex flex-wrap items-center gap-2">
              <select aria-label="Column" value={c.field} onChange={(e) => { const nf = FIELD[e.target.value]; setCond(i, { field: nf.key, op: OPS[nf.type][0].v, value: nf.type === 'enum' ? [] : nf.type === 'bool' ? true : '', value2: '' }); }} className={input}>
                {FIELDS.map((x) => (
                  <option key={x.key} value={x.key}>{x.label}</option>
                ))}
              </select>
              <select aria-label="Condition" value={c.op} onChange={(e) => setCond(i, { op: e.target.value })} className={input}>
                {OPS[f.type].map((o) => (
                  <option key={o.v} value={o.v}>{o.l}</option>
                ))}
              </select>
              {f.type === 'enum' ? (
                <span className="flex flex-wrap gap-1">
                  {f.values!.map((v) => {
                    const on = Array.isArray(c.value) && c.value.includes(v.v);
                    return (
                      <button key={v.v} type="button" aria-pressed={on} onClick={() => setCond(i, { value: on ? c.value.filter((x: string) => x !== v.v) : [...(Array.isArray(c.value) ? c.value : []), v.v] })} className={`text-[11px] px-2 py-1 rounded-md border ${on ? 'bg-blue-600 text-white border-blue-600' : 'bg-white border-slate-200 text-slate-600'}`}>
                        {v.l}
                      </button>
                    );
                  })}
                </span>
              ) : f.type === 'bool' || ['is_empty', 'not_empty'].includes(c.op) ? null : (
                <>
                  <input aria-label="Value" type={f.type === 'time' ? 'time' : f.type === 'number' ? 'number' : f.type === 'date' ? 'date' : 'text'} value={c.value ?? ''} onChange={(e) => setCond(i, { value: e.target.value })} className={`${input} w-32`} />
                  {c.op === 'between' && (
                    <>
                      <span className="text-[11px] text-slate-500">and</span>
                      <input aria-label="Second value" type={f.type === 'time' ? 'time' : 'number'} value={c.value2 ?? ''} onChange={(e) => setCond(i, { value2: e.target.value })} className={`${input} w-32`} />
                    </>
                  )}
                </>
              )}
              <button type="button" aria-label="Remove condition" onClick={() => setQ((x) => ({ ...x, conditions: x.conditions.filter((_, j) => j !== i) }))} className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-rose-600 hover:bg-rose-50">
                <X className="w-4 h-4" />
              </button>
            </div>
          );
        })}
        <button type="button" onClick={addCond} className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-700 hover:underline">
          <Plus className="w-3.5 h-3.5" /> শর্ত যোগ করুন
        </button>
      </div>

      {/* How to show it */}
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="block text-[10px] font-semibold text-slate-500 mb-1">দেখাবে</span>
          <div className="flex bg-slate-100 rounded-lg p-0.5">
            {(['detail', 'summary'] as const).map((v) => (
              <button key={v} type="button" aria-pressed={q.view === v} onClick={() => setQ({ ...q, view: v })} className={`px-3 py-1.5 rounded-md text-xs font-semibold ${q.view === v ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500'}`}>
                {v === 'detail' ? 'বিস্তারিত (প্রতিদিন)' : 'সারাংশ'}
              </button>
            ))}
          </div>
        </div>
        {q.view === 'summary' ? (
          <>
            <div>
              <label htmlFor="arb-group" className="block text-[10px] font-semibold text-slate-500 mb-1">ভাগ করে</label>
              <select id="arb-group" value={q.groupBy} onChange={(e) => setQ({ ...q, groupBy: e.target.value })} className={input}>
                {GROUPS.map((g) => (
                  <option key={g.v} value={g.v}>{g.l}</option>
                ))}
              </select>
            </div>
            <div className="flex items-end gap-1.5">
              <div>
                <label htmlFor="arb-having" className="block text-[10px] font-semibold text-slate-500 mb-1">শুধু যেখানে</label>
                <select id="arb-having" value={q.having?.metric || ''} onChange={(e) => setQ({ ...q, having: e.target.value ? { metric: e.target.value, op: q.having?.op || 'gte', value: q.having?.value || '1' } : null })} className={input}>
                  <option value="">— সব —</option>
                  {NUM_METRICS.map((m) => (
                    <option key={m.v} value={m.v}>{m.l}</option>
                  ))}
                </select>
              </div>
              {q.having && (
                <>
                  <select aria-label="Comparison" value={q.having.op} onChange={(e) => setQ({ ...q, having: { ...q.having!, op: e.target.value } })} className={input}>
                    <option value="gte">≥</option>
                    <option value="gt">&gt;</option>
                    <option value="eq">=</option>
                    <option value="lte">≤</option>
                    <option value="lt">&lt;</option>
                  </select>
                  <input aria-label="Count" type="number" value={q.having.value} onChange={(e) => setQ({ ...q, having: { ...q.having!, value: e.target.value } })} className={`${input} w-20`} />
                </>
              )}
            </div>
            <div>
              <label htmlFor="arb-sort" className="block text-[10px] font-semibold text-slate-500 mb-1">বেশি থেকে কম সাজাও</label>
              <select id="arb-sort" value={q.sort} onChange={(e) => setQ({ ...q, sort: e.target.value })} className={input}>
                <option value="">— নাম অনুযায়ী —</option>
                {NUM_METRICS.map((m) => (
                  <option key={m.v} value={m.v}>{m.l}</option>
                ))}
              </select>
            </div>
          </>
        ) : (
          <div className="relative">
            <button type="button" onClick={() => setShowCols((v) => !v)} aria-expanded={showCols} className={`${input} font-semibold`}>
              কলাম ({cols.length})
            </button>
            {showCols && (
              <div className="absolute z-20 mt-1 w-64 max-h-72 overflow-y-auto rounded-xl border border-slate-200 bg-white shadow-lg p-2 grid grid-cols-1 gap-0.5">
                {FIELDS.map((f) => (
                  <label key={f.key} className="flex items-center gap-2 text-xs px-1.5 py-1 rounded hover:bg-slate-50">
                    <input type="checkbox" checked={q.columns.includes(f.key)} onChange={(e) => setQ({ ...q, columns: e.target.checked ? FIELDS.map((x) => x.key).filter((k) => k === f.key || q.columns.includes(k)) : q.columns.filter((k) => k !== f.key) })} />
                    {f.label}
                  </label>
                ))}
              </div>
            )}
          </div>
        )}
        <button type="button" onClick={() => run()} disabled={loading} className="inline-flex items-center gap-1.5 text-xs px-4 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50">
          {loading ? <Spinner size={14} /> : <Play className="w-3.5 h-3.5" />} রিপোর্ট দেখাও
        </button>
      </div>

      {error && <p className="text-xs text-rose-600">{error}</p>}

      {result && (
        <div className="space-y-2.5">
          <div className="flex flex-wrap items-center gap-2">
            <p className="text-xs text-slate-600 flex-1 min-w-[240px]"><span className="font-semibold text-slate-800">{isSummary ? `${tableRows.length} groups` : `${result.total_rows} rows`}</span> · {result.description}</p>
            <button type="button" onClick={exportPdf} disabled={!tableRows.length} className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium disabled:opacity-50">
              <FileDown className="w-3.5 h-3.5" /> PDF
            </button>
            <button type="button" onClick={exportExcel} disabled={!tableRows.length} className="inline-flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-emerald-600 bg-white hover:bg-emerald-50 text-emerald-700 font-medium disabled:opacity-50">
              <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
            </button>
          </div>
          {result.totals && (
            <div className="flex flex-wrap gap-2 text-[11px]">
              {[
                ['Employees', result.totals.employees],
                ['Present', result.totals.present],
                ['Absent', result.totals.absent],
                ['Leave', result.totals.leave],
                ['Late', result.totals.late],
                ['Extreme', result.totals.extreme],
                ['No check-out', result.totals.missing_out],
                ['Left early', result.totals.early_leave],
                ['Avg in', result.totals.avg_in || '—'],
                ['Avg out', result.totals.avg_out || '—']
              ].map(([k, v]) => (
                <span key={k as string} className="px-2 py-1 rounded-md bg-slate-100 text-slate-700"><span className="text-slate-500">{k}:</span> <b>{v as any}</b></span>
              ))}
            </div>
          )}
          <div className="overflow-x-auto border border-slate-200 rounded-xl max-h-[60vh]">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-[10px] uppercase tracking-wide text-slate-500 sticky top-0">
                <tr>
                  {tableHead.map((h: string) => (
                    <th key={h} className="px-2.5 py-2 text-left font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {tableRows.length === 0 ? (
                  <tr>
                    <td colSpan={tableHead.length} className="px-3 py-8 text-center text-slate-400">এই শর্তে কেউ নেই।</td>
                  </tr>
                ) : (
                  tableRows.slice(0, 2000).map((r, i) => (
                    <tr key={i} className="hover:bg-slate-50">
                      {r.map((v, j) => (
                        <td key={j} className="px-2.5 py-1.5 whitespace-nowrap text-slate-700 tabular-nums">{String(v)}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {tableRows.length > 2000 && <p className="text-[11px] text-slate-500">প্রথম ২০০০টা সারি দেখাচ্ছে — পুরোটা Excel-এ।</p>}
        </div>
      )}
    </div>
  );
};
