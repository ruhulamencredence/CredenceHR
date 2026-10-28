/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Target Reports (module "target_reports", TargetRoutes.ts):
// every Employee's monthly / yearly targets in the active company — filter by
// year, month, type, department, employee and status; see them by
// department, by employee or one by one; open any target for its tasks and
// update history. Excel / PDF only with the "Targets — Excel / PDF" layer;
// cancelling / closing someone's target with "Targets — Cancel / Close".

import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from '../lib/jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { FileDown, FileSpreadsheet, Search, Target as TargetIcon } from 'lucide-react';
import { User } from '../types';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { drawStandardHeader, loadPdfCompany, standardTable } from '../lib/pdfStandard';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { fmtDate, periodLabel, ProgressBar, STATUS_LABEL, StatusBadge, Target, TargetDrawer, targetApi, TASK_STATUS_LABEL, TargetStatus, todayYmd } from './TargetParts';
import { LoadingBlock } from './LoadingBlock';
import { EmailReportButton, emailReport, useCanEmailReports } from '../lib/reportEmail';

import { SearchSelect } from './Combobox';
interface Counts {
  targets: number;
  counted: number;
  avg_progress: number;
  tasks: number;
  completed_tasks: number;
  in_progress_tasks: number;
  not_started_tasks: number;
  blocked_tasks: number;
  late_tasks: number;
  overdue: number;
  pending: number;
  fully_done: number;
}
interface Report {
  year: string;
  month: string;
  period_type: '' | 'monthly' | 'yearly';
  summary: Counts & { people: number };
  by_department: (Counts & { department: string; people: number })[];
  by_employee: (Counts & { user_id: number; name: string; employee_code: string | null; designation: string | null; department: string | null })[];
  targets: Target[];
  departments: string[];
  people: { user_id: number; name: string; employee_code: string | null; department: string | null }[];
  can_export: boolean;
  can_cancel: boolean;
}
type View = 'department' | 'employee' | 'targets';
const sel = 'rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm';
const lbl = 'block text-[11px] font-semibold text-slate-500 mb-1';

const Tile: React.FC<{ label: string; value: React.ReactNode; tone?: string }> = ({ label, value, tone = 'text-slate-900' }) => (
  <div className="rounded-2xl bg-white border border-slate-200 px-3.5 py-3">
    <div className="text-[11px] text-slate-500">{label}</div>
    <div className={`text-xl font-bold mt-0.5 ${tone}`}>{value}</div>
  </div>
);

export const TargetReports: React.FC<{ token: string; user: User }> = ({ token }) => {
  const now = todayYmd();
  const [year, setYear] = useState(now.slice(0, 4));
  const [type, setType] = useState<'' | 'monthly' | 'yearly'>('monthly');
  const [month, setMonth] = useState(now.slice(0, 7));
  const [department, setDepartment] = useState('');
  const [userId, setUserId] = useState('');
  const [status, setStatus] = useState('');
  const [overdue, setOverdue] = useState(false);
  const [search, setSearch] = useState('');
  const [view, setView] = useState<View>('department');
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [openId, setOpenId] = useState<number | null>(null);
  const [reload, setReload] = useState(0);
  const canEmailReports = useCanEmailReports();

  // A real month of the chosen year is picked ("Every month" leaves YYYY-00).
  const monthOn = type === 'monthly' && month.startsWith(year) && /-(0[1-9]|1[0-2])$/.test(month);
  const query = useMemo(() => {
    const p = new URLSearchParams({ year, period_type: type });
    if (monthOn) p.set('month', month);
    if (department) p.set('department', department);
    if (userId) p.set('user_id', userId);
    if (status) p.set('status', status);
    if (overdue) p.set('overdue', '1');
    if (search.trim()) p.set('search', search.trim());
    return p.toString();
  }, [year, type, month, monthOn, department, userId, status, overdue, search]);

  useEffect(() => {
    setError('');
    const t = setTimeout(() => {
      targetApi<Report>(token, `/api/target-reports?${query}`)
        .then(setData)
        .catch((e) => setError(e.message));
    }, 250);
    return () => clearTimeout(t);
  }, [token, query, reload]);

  const periodText = type === 'yearly' ? `Yearly targets ${year}` : type === 'monthly' ? (monthOn ? periodLabel('monthly', month) : `Every month of ${year}`) : `All targets of ${year}`;
  const filterText: [string, string][] = [
    ['Period', periodText],
    ['Department', department || 'All'],
    ...(userId ? ([['Employee', data?.people.find((p) => String(p.user_id) === userId)?.name || userId]] as [string, string][]) : []),
    ['Status', status ? STATUS_LABEL[status as TargetStatus] : 'All'],
    ...(overdue ? ([['Only', 'Overdue']] as [string, string][]) : [])
  ];

  const exportRows = async () => (await targetApi<{ rows: any[] }>(token, `/api/target-reports/export?${query}`)).rows;
  const head = ['SL', 'Employee', 'Emp. ID', 'Department', 'Period', 'Target', 'Deadline', 'Target status', 'Target %', 'Task', 'Task due', 'Weight', 'Task %', 'Task status', 'Completed', 'Late'];
  const toBody = (rows: any[]) =>
    rows.map((r, i) => [
      i + 1,
      r.employee,
      r.employee_code || '',
      r.department || '',
      periodLabel(r.period_type, r.period),
      r.target,
      r.deadline,
      `${STATUS_LABEL[r.target_status as TargetStatus] || r.target_status}${r.overdue ? ' (overdue)' : ''}`,
      `${r.target_progress}%`,
      r.task,
      r.task_due || '',
      r.weight,
      `${r.task_progress}%`,
      TASK_STATUS_LABEL[r.task_status as keyof typeof TASK_STATUS_LABEL] || r.task_status,
      r.completed_at ? fmtDate(r.completed_at) : '',
      r.late ? 'Yes' : ''
    ]);
  const fileBase = `Target-Report-${monthOn ? month : year}`;
  const excel = async () => {
    setBusy(true);
    setError('');
    try {
      const rows = await exportRows();
      const wb = XLSX.utils.book_new();
      const tasks = XLSX.utils.aoa_to_sheet([['Target Report'], filterText.map(([k, v]) => `${k}: ${v}`), [], head, ...toBody(rows)]);
      tasks['!cols'] = [5, 22, 11, 18, 11, 26, 11, 16, 8, 32, 11, 7, 7, 12, 12, 6].map((wch) => ({ wch }));
      XLSX.utils.book_append_sheet(wb, tasks, 'Tasks');
      if (data) {
        const emp = XLSX.utils.aoa_to_sheet([
          ['Employee', 'Emp. ID', 'Department', 'Targets', 'Avg %', 'Tasks', 'Completed', 'In progress', 'Not started', 'Blocked', 'Late', 'Overdue targets'],
          ...data.by_employee.map((e) => [e.name, e.employee_code || '', e.department || '', e.targets, e.avg_progress, e.tasks, e.completed_tasks, e.in_progress_tasks, e.not_started_tasks, e.blocked_tasks, e.late_tasks, e.overdue])
        ]);
        XLSX.utils.book_append_sheet(wb, emp, 'By employee');
        const dep = XLSX.utils.aoa_to_sheet([
          ['Department', 'People', 'Targets', 'Avg %', 'Tasks', 'Completed', 'In progress', 'Not started', 'Blocked', 'Overdue targets'],
          ...data.by_department.map((d) => [d.department, d.people, d.targets, d.avg_progress, d.tasks, d.completed_tasks, d.in_progress_tasks, d.not_started_tasks, d.blocked_tasks, d.overdue])
        ]);
        XLSX.utils.book_append_sheet(wb, dep, 'By department');
      }
      XLSX.writeFile(wb, `${fileBase}.xlsx`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const pdf = async (mode: 'save' | 'email' = 'save') => {
    setBusy(true);
    setError('');
    try {
      const rows = await exportRows();
      const co = await loadPdfCompany(token);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      let y = drawStandardHeader(doc, co, 'Target Report', filterText);
      if (data) {
        autoTable(doc, {
          ...standardTable(y),
          head: [['Department', 'People', 'Targets', 'Avg %', 'Tasks', 'Completed', 'In progress', 'Not started', 'Blocked', 'Overdue']],
          body: data.by_department.map((d) => [d.department, d.people, d.targets, `${d.avg_progress}%`, d.tasks, d.completed_tasks, d.in_progress_tasks, d.not_started_tasks, d.blocked_tasks, d.overdue].map(String))
        });
        y = (doc as any).lastAutoTable.finalY + 6;
      }
      autoTable(doc, {
        ...standardTable(y),
        head: [head],
        body: toBody(rows).map((r) => r.map(String)),
        styles: { ...standardTable(y).styles, fontSize: 6.5 },
        columnStyles: { 0: { halign: 'center', cellWidth: 8 } }
      });
      finalizePdfPageNumbers(doc);
      if (mode === 'email') {
        await emailReport(doc, { fileName: `${fileBase}.pdf`, title: 'Target Report' });
        return;
      }
      await savePdfCrossPlatform(doc, `${fileBase}.pdf`);
    } catch (e: any) {
      setError(e.message || 'Could not make the PDF.');
    } finally {
      setBusy(false);
    }
  };

  const s = data?.summary;
  const years = Array.from({ length: 6 }, (_, i) => String(Number(now.slice(0, 4)) + 1 - i));

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <TargetIcon className="w-5 h-5 text-fuchsia-600" /> Target Reports
        </h2>
        {data?.can_export && (
          <div className="flex gap-2">
            <button type="button" disabled={busy} onClick={() => pdf()} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              <FileDown className="w-3.5 h-3.5" /> PDF
            </button>
            {canEmailReports && (
              <EmailReportButton onClick={() => pdf('email')} disabled={busy} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50" />
            )}
            <button type="button" disabled={busy} onClick={excel} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
              <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
            </button>
          </div>
        )}
      </div>

      <div className="rounded-2xl bg-white border border-slate-200 p-3 flex flex-wrap items-end gap-2">
        <div>
          <label className={lbl}>Year</label>
          <select className={sel} value={year} onChange={(e) => { setYear(e.target.value); setMonth(`${e.target.value}${month.slice(4)}`); }}>
            {years.map((y) => (
              <option key={y}>{y}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={lbl}>Type</label>
          <select className={sel} value={type} onChange={(e) => setType(e.target.value as any)}>
            <option value="">All (year view)</option>
            <option value="monthly">Monthly</option>
            <option value="yearly">Yearly</option>
          </select>
        </div>
        {type === 'monthly' && (
          <div>
            <label className={lbl}>Month</label>
            <select className={sel} value={monthOn ? month : ''} onChange={(e) => setMonth(e.target.value || `${year}-00`)}>
              <option value="">Every month</option>
              {Array.from({ length: 12 }, (_, i) => `${year}-${String(i + 1).padStart(2, '0')}`).map((m) => (
                <option key={m} value={m}>
                  {periodLabel('monthly', m)}
                </option>
              ))}
            </select>
          </div>
        )}
        <div>
          <label className={lbl}>Department</label>
          <select className={sel} value={department} onChange={(e) => { setDepartment(e.target.value); setUserId(''); }}>
            <option value="">All</option>
            {(data?.departments || []).map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </div>
        <div>
          <label className={lbl}>Employee</label>
          <SearchSelect className={`${sel} max-w-[200px]`} value={userId} onChange={(e) => setUserId(e.target.value)}>
            <option value="">All</option>
            {(data?.people || [])
              .filter((p) => !department || String(p.department || '').toLowerCase() === department.toLowerCase())
              .map((p) => (
                <option key={p.user_id} value={p.user_id}>
                  {p.name}
                  {p.employee_code ? ` (${p.employee_code})` : ''}
                </option>
              ))}
          </SearchSelect>
        </div>
        <div>
          <label className={lbl}>Status</label>
          <select className={sel} value={status} onChange={(e) => setStatus(e.target.value)}>
            <option value="">All</option>
            {(['active', 'pending', 'closed', 'cancelled', 'rejected'] as TargetStatus[]).map((k) => (
              <option key={k} value={k}>
                {STATUS_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-1.5 text-xs font-semibold text-slate-600 pb-2.5">
          <input type="checkbox" className="accent-fuchsia-600" checked={overdue} onChange={(e) => setOverdue(e.target.checked)} /> Only overdue
        </label>
        <div className="relative flex-1 min-w-[160px]">
          <label className={lbl}>Search</label>
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 bottom-3" />
          <input className={`${sel} w-full pl-8`} value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Name, ID, target, task…" />
        </div>
      </div>

      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!data ? (
        !error && (
          <LoadingBlock />
        )
      ) : (
        <>
          <p className="text-xs text-slate-500">
            {periodText} · averages leave out cancelled and rejected targets.
          </p>
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
            <Tile label="Targets" value={s!.targets} />
            <Tile label="Employees" value={s!.people} />
            <Tile label="Average progress" value={`${s!.avg_progress}%`} tone="text-fuchsia-700" />
            <Tile label="Tasks 100% done" value={`${s!.completed_tasks}/${s!.tasks}`} tone="text-emerald-700" />
            <Tile label="Targets fully done" value={s!.fully_done} tone="text-emerald-700" />
            <Tile label="Overdue targets" value={s!.overdue} tone={s!.overdue ? 'text-rose-600' : 'text-slate-900'} />
          </div>
          <div className="text-[11px] text-slate-500 flex flex-wrap gap-x-3">
            <span>In progress: {s!.in_progress_tasks}</span>
            <span>Not started: {s!.not_started_tasks}</span>
            <span>Blocked: {s!.blocked_tasks}</span>
            <span>Late tasks: {s!.late_tasks}</span>
            <span>Waiting for approval: {s!.pending}</span>
          </div>

          <div className="flex gap-1.5">
            {(
              [
                ['department', 'By department'],
                ['employee', 'By employee'],
                ['targets', 'Targets']
              ] as [View, string][]
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                onClick={() => setView(k)}
                className={`px-3.5 py-2 rounded-full text-xs font-semibold ${view === k ? 'bg-fuchsia-600 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
              >
                {label}
              </button>
            ))}
          </div>

          <div className="rounded-2xl bg-white border border-slate-200 overflow-x-auto">
            {view === 'department' && (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Department</th>
                    <th className="px-3 py-2 text-center">People</th>
                    <th className="px-3 py-2 text-center">Targets</th>
                    <th className="px-3 py-2 text-left w-[30%]">Average</th>
                    <th className="px-3 py-2 text-center">Tasks done</th>
                    <th className="px-3 py-2 text-center">In progress</th>
                    <th className="px-3 py-2 text-center">Not started</th>
                    <th className="px-3 py-2 text-center">Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_department.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-slate-400">No targets for these filters.</td>
                    </tr>
                  )}
                  {data.by_department.map((d) => (
                    <tr key={d.department} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => { if (d.department !== '—') setDepartment(d.department); setView('employee'); }}>
                      <td className="px-3 py-2 font-semibold text-slate-800">{d.department}</td>
                      <td className="px-3 py-2 text-center">{d.people}</td>
                      <td className="px-3 py-2 text-center">{d.targets}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <ProgressBar value={d.avg_progress} thin />
                          <span className="font-bold w-9 text-right">{d.avg_progress}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">{d.completed_tasks}/{d.tasks}</td>
                      <td className="px-3 py-2 text-center">{d.in_progress_tasks}</td>
                      <td className="px-3 py-2 text-center">{d.not_started_tasks}</td>
                      <td className={`px-3 py-2 text-center ${d.overdue ? 'text-rose-600 font-semibold' : ''}`}>{d.overdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view === 'employee' && (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Employee</th>
                    <th className="px-3 py-2 text-center">Targets</th>
                    <th className="px-3 py-2 text-left w-[28%]">Average</th>
                    <th className="px-3 py-2 text-center">Tasks done</th>
                    <th className="px-3 py-2 text-center">In progress</th>
                    <th className="px-3 py-2 text-center">Not started</th>
                    <th className="px-3 py-2 text-center">Late</th>
                    <th className="px-3 py-2 text-center">Overdue</th>
                  </tr>
                </thead>
                <tbody>
                  {data.by_employee.length === 0 && (
                    <tr>
                      <td colSpan={8} className="px-3 py-8 text-center text-slate-400">No targets for these filters.</td>
                    </tr>
                  )}
                  {data.by_employee.map((e) => (
                    <tr key={e.user_id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => { setUserId(String(e.user_id)); setView('targets'); }}>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-800">{e.name}</div>
                        <div className="text-[11px] text-slate-500">{[e.employee_code, e.designation, e.department].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td className="px-3 py-2 text-center">{e.targets}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <ProgressBar value={e.avg_progress} thin />
                          <span className="font-bold w-9 text-right">{e.avg_progress}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">{e.completed_tasks}/{e.tasks}</td>
                      <td className="px-3 py-2 text-center">{e.in_progress_tasks}</td>
                      <td className="px-3 py-2 text-center">{e.not_started_tasks}</td>
                      <td className="px-3 py-2 text-center">{e.late_tasks}</td>
                      <td className={`px-3 py-2 text-center ${e.overdue ? 'text-rose-600 font-semibold' : ''}`}>{e.overdue}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
            {view === 'targets' && (
              <table className="w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">Employee</th>
                    <th className="px-3 py-2 text-left">Target</th>
                    <th className="px-3 py-2 text-left">Period</th>
                    <th className="px-3 py-2 text-left">Deadline</th>
                    <th className="px-3 py-2 text-left w-[22%]">Progress</th>
                    <th className="px-3 py-2 text-center">Tasks done</th>
                    <th className="px-3 py-2 text-left">Status</th>
                  </tr>
                </thead>
                <tbody>
                  {data.targets.length === 0 && (
                    <tr>
                      <td colSpan={7} className="px-3 py-8 text-center text-slate-400">No targets for these filters.</td>
                    </tr>
                  )}
                  {data.targets.map((t) => (
                    <tr key={t.id} className="border-t border-slate-100 hover:bg-slate-50 cursor-pointer" onClick={() => setOpenId(t.id)}>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-800">{t.owner_name}</div>
                        <div className="text-[11px] text-slate-500">{[t.employee_code, t.department].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td className="px-3 py-2 text-slate-800">{t.title}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{periodLabel(t.period_type, t.period)}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(t.deadline)}</td>
                      <td className="px-3 py-2">
                        <div className="flex items-center gap-2">
                          <ProgressBar value={t.progress} thin />
                          <span className="font-bold w-9 text-right">{t.progress}%</span>
                        </div>
                      </td>
                      <td className="px-3 py-2 text-center">{t.completed_count}/{t.task_count}</td>
                      <td className="px-3 py-2">
                        <StatusBadge t={t} />
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </>
      )}
      {openId && <TargetDrawer token={token} targetId={openId} onClose={() => setOpenId(null)} onChanged={() => setReload((n) => n + 1)} />}
    </div>
  );
};
