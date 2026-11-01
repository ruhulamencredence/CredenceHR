// Admin Panel -> Monthly Attendance Report -> Department Summary.
// Per department: employees, Present, Absent, Leave, Delay, Extreme Delay
// and Attendance % — on one day, or added up over a month (person-days).
// GET /api/attendance/report/department-summary (needs the Attendance
// Reports layer "dept_summary"; the server keeps to the account's
// Departments). Clicking a number lists who it is. PDF and Excel export.
import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import jsPDF from '../lib/jspdf';
import autoTable from 'jspdf-autotable';
import { FileDown, FileSpreadsheet, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { drawStandardHeader, loadPdfCompany, standardTable } from '../lib/pdfStandard';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { MultiSelectFilter } from './MultiSelectFilter';
import { SearchSelect } from './Combobox';
import { Spinner } from './Spinner';
import { Project } from '../types';

type Kind = 'present' | 'absent' | 'leave' | 'delay' | 'extreme';
interface DeptRow {
  department: string;
  employees: number;
  working: number;
  present: number;
  absent: number;
  leave: number;
  delay: number;
  extreme: number;
  attendance_pct: number | null;
}
interface Person {
  user_id: number;
  name: string;
  employee_code: string;
  designation: string;
  department: string;
  working: number;
  present: number;
  absent: number;
  leave: number;
  delay: number;
  extreme: number;
  check_in_at: string | null;
  leave_type: string | null;
  off: string | null;
}
interface Summary {
  mode: 'day' | 'month';
  date: string | null;
  year: number;
  month: number;
  from: string;
  to: string;
  departments: DeptRow[];
  total: Omit<DeptRow, 'department'>;
  people: Person[];
}

const KINDS: { key: Kind; label: string; text: string; dot: string; soft: string }[] = [
  { key: 'present', label: 'Present', text: 'text-emerald-700', dot: 'bg-emerald-600', soft: '' },
  { key: 'absent', label: 'Absent', text: 'text-rose-700', dot: 'bg-rose-600', soft: 'bg-rose-50' },
  { key: 'leave', label: 'Leave', text: 'text-blue-700', dot: 'bg-blue-600', soft: '' },
  { key: 'delay', label: 'Delay', text: 'text-yellow-700', dot: 'bg-yellow-600', soft: '' },
  { key: 'extreme', label: 'Extreme Delay', text: 'text-orange-700', dot: 'bg-orange-600', soft: 'bg-orange-50' }
];
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const todayStr = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const fmt = (n: number) => n.toLocaleString('en-US');
const pctText = (p: number | null) => (p == null ? '—' : `${p}%`);
const pctBar = (p: number | null) => (p == null ? 'bg-slate-300' : p >= 92 ? 'bg-emerald-600' : p >= 85 ? 'bg-amber-500' : 'bg-rose-600');
const timeOf = (v: string | null) => {
  if (!v) return '';
  const m = String(v).match(/(\d{2}):(\d{2})/);
  return m ? `${m[1]}:${m[2]}` : '';
};
const leaveName = (t: string | null) => (t ? t.charAt(0).toUpperCase() + t.slice(1).replace(/_/g, ' ') : 'Leave');

export const DepartmentAttendanceSummary: React.FC<{ token: string; projects: Project[]; departments: string[] }> = ({ token, projects, departments }) => {
  const [mode, setMode] = useState<'day' | 'month'>('day');
  const [date, setDate] = useState(todayStr());
  const [year, setYear] = useState(Number(todayStr().slice(0, 4)));
  const [month, setMonth] = useState(Number(todayStr().slice(5, 7)));
  const [deptFilter, setDeptFilter] = useState<string[]>([]);
  const [projectId, setProjectId] = useState('');
  const [data, setData] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [who, setWho] = useState<{ department: string | null; kind: Kind } | null>(null);
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    let live = true;
    const params = new URLSearchParams({ mode });
    if (mode === 'day') params.set('date', date);
    else {
      params.set('year', String(year));
      params.set('month', String(month));
    }
    if (deptFilter.length) params.set('departments', deptFilter.join(','));
    if (projectId) params.set('project_id', projectId);
    setLoading(true);
    setError('');
    fetch(apiUrl(`/api/attendance/report/department-summary?${params.toString()}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load the Department Summary.');
        return d as Summary;
      })
      .then((d) => live && setData(d))
      .catch((e) => {
        if (!live) return;
        setData(null);
        setError(e.message);
      })
      .finally(() => live && setLoading(false));
    return () => {
      live = false;
    };
  }, [token, mode, date, year, month, deptFilter.join(','), projectId]);

  const periodText = data
    ? data.mode === 'day'
      ? new Date(`${data.date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' })
      : `${MONTHS[data.month - 1]} ${data.year}${data.to < data.from ? '' : ` (to ${data.to.slice(8)} ${MONTHS[data.month - 1].slice(0, 3)})`}`
    : '';
  const unit = mode === 'day' ? 'people' : 'person-days';

  const whoList = useMemo(() => {
    if (!who || !data) return [];
    return data.people
      .filter((p) => (who.department == null || p.department === who.department) && p[who.kind] > 0)
      .sort((a, b) => b[who.kind] - a[who.kind] || a.name.localeCompare(b.name));
  }, [who, data]);
  const whoKind = who ? KINDS.find((k) => k.key === who.kind)! : null;
  const detailOf = (p: Person, kind: Kind) => {
    if (mode === 'month') return `${p[kind]} day${p[kind] === 1 ? '' : 's'}`;
    if (kind === 'leave') return leaveName(p.leave_type);
    if (kind === 'absent') return 'No punch, no leave';
    return p.check_in_at ? `In ${timeOf(p.check_in_at)}` : '';
  };

  const fileBase = () => (data ? `Department_Attendance_${data.mode === 'day' ? data.date : `${data.year}-${String(data.month).padStart(2, '0')}`}` : 'Department_Attendance');

  const exportExcel = () => {
    if (!data) return;
    const wb = XLSX.utils.book_new();
    const head = ['Department', 'Employees', 'Working ' + (data.mode === 'day' ? '(people)' : '(person-days)'), 'Present', 'Absent', 'Leave', 'Delay', 'Extreme Delay', 'Attendance %'];
    const rows = data.departments.map((d) => [d.department, d.employees, d.working, d.present, d.absent, d.leave, d.delay, d.extreme, d.attendance_pct ?? '']);
    const t = data.total;
    rows.push(['All departments', t.employees, t.working, t.present, t.absent, t.leave, t.delay, t.extreme, t.attendance_pct ?? '']);
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([[`Department Summary — ${periodText}`], [], head, ...rows]), 'Summary');
    const pHead = ['Name', 'Employee ID', 'Designation', 'Department', 'Working', 'Present', 'Absent', 'Leave', 'Delay', 'Extreme Delay'];
    if (data.mode === 'day') pHead.push('Check in', 'Leave type');
    const pRows = [...data.people]
      .sort((a, b) => a.department.localeCompare(b.department) || a.name.localeCompare(b.name))
      .map((p) => {
        const r: (string | number)[] = [p.name, p.employee_code, p.designation, p.department, p.working, p.present, p.absent, p.leave, p.delay, p.extreme];
        if (data.mode === 'day') r.push(timeOf(p.check_in_at), p.leave_type ? leaveName(p.leave_type) : '');
        return r;
      });
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([pHead, ...pRows]), 'People');
    XLSX.writeFile(wb, `${fileBase()}.xlsx`);
  };

  const exportPdf = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const co = await loadPdfCompany(token);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const y = drawStandardHeader(doc, co, 'Department Attendance Summary', [
        [data.mode === 'day' ? 'Date' : 'Month', periodText],
        ['Departments', deptFilter.length ? deptFilter.join(', ') : 'All'],
        ['Counted as', data.mode === 'day' ? 'People on the day' : 'Person-days (each day added up)']
      ]);
      const t = data.total;
      autoTable(doc, {
        ...standardTable(y + 4),
        head: [['Department', 'Employees', 'Present', 'Absent', 'Leave', 'Delay', 'Extreme Delay', 'Attendance %']],
        body: data.departments.map((d) => [d.department, fmt(d.employees), fmt(d.present), fmt(d.absent), fmt(d.leave), fmt(d.delay), fmt(d.extreme), pctText(d.attendance_pct)]),
        foot: [[{ content: 'All departments', styles: { halign: 'left' } }, fmt(t.employees), fmt(t.present), fmt(t.absent), fmt(t.leave), fmt(t.delay), fmt(t.extreme), pctText(t.attendance_pct)]],
        columnStyles: { 0: { halign: 'left' }, 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' }, 6: { halign: 'right' }, 7: { halign: 'right' } }
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `${fileBase()}.pdf`);
    } catch (e: any) {
      setError(e.message || 'Could not make the PDF.');
    } finally {
      setExporting(false);
    }
  };

  const cell = (d: DeptRow | null, kind: Kind, value: number, highlight: boolean) => {
    const k = KINDS.find((x) => x.key === kind)!;
    return (
      <button
        type="button"
        disabled={value === 0}
        onClick={() => setWho({ department: d ? d.department : null, kind })}
        title={value ? `Who — ${k.label}` : undefined}
        className={`justify-self-end min-w-[52px] h-9 px-2 rounded-lg text-right text-sm font-bold tabular-nums ${k.text} ${highlight ? k.soft : ''} hover:bg-slate-100 disabled:cursor-default disabled:hover:bg-transparent`}
      >
        {fmt(value)}
      </button>
    );
  };
  const GRID = 'grid grid-cols-[minmax(160px,2.2fr)_repeat(6,minmax(64px,1fr))_minmax(150px,2fr)] items-center';

  return (
    <div className="p-4 sm:p-6 flex flex-col gap-4">
      <div className="flex flex-wrap items-end gap-3">
        <div>
          <span className="block text-[10px] font-semibold text-slate-500 mb-1">Period</span>
          <div className="flex bg-slate-100 rounded-lg p-0.5">
            {(['day', 'month'] as const).map((m) => (
              <button
                key={m}
                type="button"
                aria-pressed={mode === m}
                onClick={() => setMode(m)}
                className={`px-3 py-1.5 rounded-md text-xs font-semibold ${mode === m ? 'bg-white text-blue-700 shadow-sm' : 'text-slate-500 hover:text-slate-800'}`}
              >
                {m === 'day' ? 'One day' : 'Whole month'}
              </button>
            ))}
          </div>
        </div>
        {mode === 'day' ? (
          <div>
            <label htmlFor="ds-date" className="block text-[10px] font-semibold text-slate-500 mb-1">Date</label>
            <input id="ds-date" type="date" value={date} max={todayStr()} onChange={(e) => e.target.value && setDate(e.target.value)} className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none" />
          </div>
        ) : (
          <>
            <div>
              <label htmlFor="ds-month" className="block text-[10px] font-semibold text-slate-500 mb-1">Month</label>
              <select id="ds-month" value={month} onChange={(e) => setMonth(Number(e.target.value))} className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none">
                {MONTHS.map((m, i) => (
                  <option key={m} value={i + 1}>{m}</option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="ds-year" className="block text-[10px] font-semibold text-slate-500 mb-1">Year</label>
              <input id="ds-year" type="number" value={year} min={2000} max={2100} onChange={(e) => Number(e.target.value) > 1999 && setYear(Number(e.target.value))} className="text-xs px-2.5 py-2 w-24 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none" />
            </div>
          </>
        )}
        <div>
          <span className="block text-[10px] font-semibold text-slate-500 mb-1">Departments</span>
          <MultiSelectFilter label="Department" options={departments.map((d) => ({ value: d, label: d }))} selected={deptFilter} onChange={setDeptFilter} />
        </div>
        <div>
          <span className="block text-[10px] font-semibold text-slate-500 mb-1">Project</span>
          <SearchSelect value={projectId} onChange={(e) => setProjectId(e.target.value)} className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none">
            <option value="">All Projects</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name}</option>
            ))}
          </SearchSelect>
        </div>
        <div className="flex gap-2 sm:ml-auto">
          <button type="button" onClick={exportPdf} disabled={!data || exporting} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium whitespace-nowrap disabled:opacity-50">
            <FileDown className="w-3.5 h-3.5" /> {exporting ? 'Preparing…' : 'Export PDF'}
          </button>
          <button type="button" onClick={exportExcel} disabled={!data} className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg border border-emerald-600 bg-white hover:bg-emerald-50 text-emerald-700 font-medium whitespace-nowrap disabled:opacity-50">
            <FileSpreadsheet className="w-3.5 h-3.5" /> Export Excel
          </button>
        </div>
      </div>
      <p className="text-[11px] text-slate-500 -mt-1">
        {mode === 'day'
          ? 'One day: each person counted once. Delay and Extreme Delay are counted as Present too.'
          : 'Whole month: days added up for everyone (person-days), up to today. Attendance % = (Present + Leave) ÷ working days.'}
      </p>

      {error && <p className="text-xs text-rose-600">{error}</p>}
      {loading && !data ? (
        <div className="flex justify-center py-12"><Spinner /></div>
      ) : data ? (
        <>
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-7 gap-2.5">
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500"><span className="w-2 h-2 rounded-sm bg-violet-600" />Employees</div>
              <div className="text-2xl font-extrabold text-slate-900 mt-1">{fmt(data.total.employees)}</div>
              <div className="text-[11px] text-slate-500">{data.departments.length} departments</div>
            </div>
            {KINDS.map((k) => (
              <button key={k.key} type="button" onClick={() => data.total[k.key] && setWho({ department: null, kind: k.key })} className="text-left rounded-xl border border-slate-200 bg-white p-3 hover:border-slate-300">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500"><span className={`w-2 h-2 rounded-sm ${k.dot}`} />{k.label}</div>
                <div className={`text-2xl font-extrabold mt-1 ${k.text}`}>{fmt(data.total[k.key])}</div>
                <div className="text-[11px] text-slate-500">{unit}</div>
              </button>
            ))}
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500"><span className="w-2 h-2 rounded-sm bg-slate-500" />Attendance</div>
              <div className="text-2xl font-extrabold text-slate-900 mt-1">{pctText(data.total.attendance_pct)}</div>
              <div className="text-[11px] text-slate-500">present + leave</div>
            </div>
          </div>

          <div className="border border-slate-200 rounded-xl overflow-x-auto">
            <div className="min-w-[860px]">
              <div className={`${GRID} px-4 py-2.5 bg-slate-50 border-b border-slate-200 text-[10px] font-bold text-slate-500 tracking-wide`}>
                <span>DEPARTMENT</span>
                <span className="text-right pr-2">EMPLOYEES</span>
                {KINDS.map((k) => (
                  <span key={k.key} className="text-right pr-2">{k.label.toUpperCase()}</span>
                ))}
                <span className="pl-6">ATTENDANCE %</span>
              </div>
              {data.departments.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-10">No employees match these filters.</p>
              ) : (
                data.departments.map((d) => {
                  const base = d.working || 1;
                  return (
                    <div key={d.department} className={`${GRID} px-4 py-1 border-b border-slate-100 text-sm`}>
                      <span className="font-semibold text-slate-800 py-2 truncate">{d.department}</span>
                      <span className="text-right pr-2 font-semibold text-slate-600 tabular-nums">{fmt(d.employees)}</span>
                      {cell(d, 'present', d.present, false)}
                      {cell(d, 'absent', d.absent, d.absent / base > 0.1)}
                      {cell(d, 'leave', d.leave, false)}
                      {cell(d, 'delay', d.delay, false)}
                      {cell(d, 'extreme', d.extreme, d.extreme > 0)}
                      <span className="flex items-center gap-2.5 pl-6">
                        <span className="flex-1 h-2 rounded-full bg-slate-100 overflow-hidden">
                          <span className={`block h-2 rounded-full ${pctBar(d.attendance_pct)}`} style={{ width: `${Math.min(100, d.attendance_pct ?? 0)}%` }} />
                        </span>
                        <span className="w-12 text-right font-bold text-slate-700 tabular-nums">{pctText(d.attendance_pct)}</span>
                      </span>
                    </div>
                  );
                })
              )}
              {data.departments.length > 0 && (
                <div className={`${GRID} px-4 py-2 bg-slate-50 text-sm font-extrabold`}>
                  <span>All departments</span>
                  <span className="text-right pr-2 tabular-nums">{fmt(data.total.employees)}</span>
                  {cell(null, 'present', data.total.present, false)}
                  {cell(null, 'absent', data.total.absent, false)}
                  {cell(null, 'leave', data.total.leave, false)}
                  {cell(null, 'delay', data.total.delay, false)}
                  {cell(null, 'extreme', data.total.extreme, false)}
                  <span className="pl-6">{pctText(data.total.attendance_pct)}</span>
                </div>
              )}
            </div>
          </div>
          <p className="text-[11px] text-slate-500">Click any number to see who it is. Highlighted: absent over 10% of working {mode === 'day' ? 'people' : 'days'}, or any extreme delay.</p>
        </>
      ) : null}

      {who && whoKind && (
        <div className="fixed inset-0 z-[1000] liquid-glass-backdrop" onClick={() => setWho(null)}>
          <div className="absolute right-0 top-0 h-full w-full max-w-[440px] p-3" onClick={(e) => e.stopPropagation()}>
            <div role="dialog" aria-label={`${whoKind.label} — who`} className="liquid-glass liquid-glass-in rounded-[32px] h-full flex flex-col p-5 gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <div className={`text-[11px] font-bold tracking-wide ${whoKind.text}`}>{whoKind.label.toUpperCase()}</div>
                  <div className="text-lg font-extrabold text-slate-900">
                    {who.department ?? 'All departments'} · {fmt(whoList.reduce((a, p) => a + p[who.kind], 0))} {mode === 'day' ? (whoList.length === 1 ? 'person' : 'people') : 'days'}
                  </div>
                  <div className="text-xs text-slate-500">{periodText}</div>
                </div>
                <button type="button" aria-label="Close" onClick={() => setWho(null)} className="liquid-glass-chip w-10 h-10 rounded-full flex items-center justify-center shrink-0">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="liquid-glass-inset rounded-2xl flex-1 overflow-y-auto">
                {whoList.length === 0 ? (
                  <p className="text-xs text-slate-500 text-center py-8">Nobody.</p>
                ) : (
                  whoList.map((p) => (
                    <div key={p.user_id} className="flex items-center justify-between gap-3 px-4 py-2.5 border-b border-white/40 last:border-0">
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-800 truncate">{p.name}</div>
                        <div className="text-[11px] text-slate-500 truncate">{[p.employee_code, p.designation, who.department == null ? p.department : ''].filter(Boolean).join(' · ')}</div>
                      </div>
                      <span className={`text-xs font-bold whitespace-nowrap ${whoKind.text}`}>{detailOf(p, who.kind)}</span>
                    </div>
                  ))
                )}
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
