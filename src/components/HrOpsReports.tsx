/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> "Employee Reports" (HrOpsReportsRoutes.ts): every
// Employee's Service Book (360) facts side by side.
//   Ready Reports — one-click presets (joined from which company, experience
//     bands, pending documents, nominee gaps, attendance, salary…).
//   Report Builder — pick columns, filters (all / any), group-and-count,
//     month / year; export to Excel / PDF; save privately, optionally on a
//     schedule that notifies chosen HR users.
//   My Reports — the viewer's own saved reports.
//   Received — results a schedule (or "Send now") delivered to the viewer.
//   Requests — what employees submitted for their gaps, to approve / reject
//     (asked from any report: tick employees -> Request from employees, or
//     "Fix" a row directly — HrOpsGapTools.tsx).
//   Company Names — previous-employer spellings, merged into one.

import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import {
  Building2,
  CalendarCheck,
  CalendarClock,
  Cake,
  ClipboardX,
  Droplet,
  FileDown,
  FileSpreadsheet,
  FileWarning,
  GraduationCap,
  HandCoins,
  Inbox,
  MailQuestion,
  Wrench,
  Layers,
  ListFilter,
  Package,
  Play,
  Plus,
  Receipt,
  Save,
  Send,
  ShieldAlert,
  Sparkles,
  Trash2,
  TrendingUp,
  UserCheck,
  Users,
  Wallet,
  X
} from 'lucide-react';
import { Spinner } from './Spinner';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';
import { pdfSafe } from './HrOps360Parts';
import { FixGapsModal, RequestInfoModal, InfoRequestsReview } from './HrOpsGapTools';
import { useHrApi, Modal, Notice, Badge, fmtDate, monthLabel, taka, inputCls, labelCls, btnPrimary, btnGhost } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

// ---------------------------------------------------------------------------
// Types (mirror HrOpsReportsRoutes.ts)
// ---------------------------------------------------------------------------

type ColType = 'text' | 'number' | 'money' | 'date' | 'list' | 'bool';
interface ColumnDef {
  key: string;
  label: string;
  group: string;
  type: ColType;
  stage: string;
  payroll?: boolean;
}
interface Filter {
  key: string;
  op: string;
  value?: any;
}
export interface ReportConfig {
  columns: string[];
  filters: Filter[];
  match: 'all' | 'any';
  group_by: string | null;
  month: string;
  year: string;
  include_inactive: boolean;
}
interface ReportResult {
  columns: ColumnDef[];
  group_by: ColumnDef | null;
  rows: Record<string, any>[];
  groups: { key: string; count: number; employee_ids: number[] }[] | null;
  total: number;
  month: string;
  year: number;
  generated_at: string;
  truncated?: boolean;
}
interface Schedule {
  frequency: 'daily' | 'weekly' | 'monthly';
  weekday: number;
  day: number;
  hour: number;
  recipients: number[];
  only_if_rows: boolean;
}
interface SavedReport {
  id: number;
  name: string;
  config: ReportConfig;
  schedule: Schedule | null;
  last_period: string | null;
  last_run_at: string | null;
}
interface RunRow {
  id: number;
  report_id: number | null;
  report_name: string;
  period: string | null;
  row_count: number;
  run_at: string;
  sent_by: string | null;
  mine: boolean;
}

const EMPTY: ReportConfig = { columns: ['name', 'employee_code', 'designation', 'department'], filters: [], match: 'all', group_by: null, month: 'current', year: 'current', include_inactive: false };
const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const PERIOD_STAGES = new Set(['attendance', 'leave', 'claims', 'salary']);

// ---------------------------------------------------------------------------
// Ready reports — presets for the builder
// ---------------------------------------------------------------------------

const thisMonthName = MONTHS[new Date().getMonth()];
const cfg = (p: Partial<ReportConfig>): ReportConfig => ({ ...EMPTY, ...p, filters: p.filters || [] });
const PRESETS: { key: string; title: string; desc: string; icon: React.ComponentType<{ className?: string }>; payroll?: boolean; config: ReportConfig }[] = [
  {
    key: 'companies',
    title: 'Joined from which company',
    desc: 'How many employees came from each previous employer.',
    icon: Building2,
    config: cfg({ columns: ['name', 'employee_code', 'designation', 'department', 'last_company', 'previous_companies', 'prior_experience_years'], group_by: 'previous_companies' })
  },
  {
    key: 'exp_band',
    title: 'Experience bands',
    desc: 'Employees by total experience: <1, 1–3, 3–5, 5–10, 10+ years.',
    icon: TrendingUp,
    config: cfg({ columns: ['name', 'designation', 'department', 'prior_experience_years', 'service_years', 'total_experience_years'], group_by: 'total_experience_band' })
  },
  {
    key: 'education',
    title: 'Education levels',
    desc: 'Highest qualification of every employee, grouped by level.',
    icon: GraduationCap,
    config: cfg({ columns: ['name', 'designation', 'department', 'highest_degree', 'institutes'], group_by: 'highest_level' })
  },
  {
    key: 'unverified',
    title: 'Experience / education not verified',
    desc: 'Records still waiting for certificate or reference check.',
    icon: UserCheck,
    config: cfg({
      columns: ['name', 'department', 'experience_unverified', 'experience_no_certificate', 'education_unverified', 'education_no_certificate'],
      match: 'any',
      filters: [
        { key: 'experience_unverified', op: 'gt', value: 0 },
        { key: 'education_unverified', op: 'gt', value: 0 }
      ]
    })
  },
  {
    key: 'no_education',
    title: 'No education recorded',
    desc: 'Employees whose education has not been entered yet.',
    icon: ClipboardX,
    config: cfg({ columns: ['name', 'employee_code', 'designation', 'department', 'joining_date'], filters: [{ key: 'education_records', op: 'eq', value: 0 }] })
  },
  {
    key: 'docs_pending',
    title: 'Pending documents',
    desc: 'Who is still missing a required document, and which.',
    icon: FileWarning,
    config: cfg({ columns: ['name', 'employee_code', 'department', 'missing_documents', 'expired_documents'], filters: [{ key: 'missing_documents_count', op: 'gt', value: 0 }] })
  },
  {
    key: 'docs_by_type',
    title: 'Missing documents by type',
    desc: '"NID missing for 12" — count per required document.',
    icon: Layers,
    config: cfg({ columns: ['name', 'department', 'missing_documents'], group_by: 'missing_documents', filters: [{ key: 'missing_documents_count', op: 'gt', value: 0 }] })
  },
  {
    key: 'nominee',
    title: 'Nominee / emergency contact gaps',
    desc: 'No nominee, shares not 100%, or no emergency contact.',
    icon: ShieldAlert,
    config: cfg({
      columns: ['name', 'department', 'nominee_status', 'nominees', 'has_emergency_contact'],
      match: 'any',
      filters: [
        { key: 'nominee_status', op: 'neq', value: 'OK' },
        { key: 'has_emergency_contact', op: 'is_false' }
      ]
    })
  },
  {
    key: 'training',
    title: 'Training summary',
    desc: 'Trainings attended, hours and cost per employee.',
    icon: GraduationCap,
    config: cfg({ columns: ['name', 'department', 'trainings', 'training_count', 'training_hours', 'training_cost', 'last_training_date'] })
  },
  {
    key: 'attendance',
    title: 'Monthly attendance',
    desc: 'Present, absent, leave, late and % for everyone.',
    icon: CalendarCheck,
    config: cfg({ columns: ['name', 'department', 'att_working', 'att_present', 'att_leave', 'att_absent', 'att_late', 'att_extreme_late', 'att_percent'] })
  },
  {
    key: 'leave',
    title: 'Leave summary',
    desc: 'Taken, pending and remaining leave this year.',
    icon: CalendarClock,
    config: cfg({ columns: ['name', 'department', 'casual_taken', 'casual_balance', 'sick_taken', 'sick_balance', 'lwp_taken', 'leave_pending', 'leave_remaining'] })
  },
  {
    key: 'claims',
    title: 'Claims & conveyance',
    desc: 'Claimed, approved, pending and paid this year.',
    icon: Receipt,
    config: cfg({ columns: ['name', 'department', 'claims_count', 'claims_claimed', 'claims_approved', 'claims_pending', 'conveyance_paid', 'movement_km'] })
  },
  {
    key: 'salary',
    title: 'Salary register',
    desc: 'Current gross, last increment and pay this year.',
    icon: Wallet,
    payroll: true,
    config: cfg({ columns: ['name', 'employee_code', 'designation', 'department', 'grade', 'basic_salary', 'gross_salary', 'last_increment_date', 'last_increment_percent', 'net_paid_year'] })
  },
  {
    key: 'loans',
    title: 'Loans outstanding',
    desc: 'Who owes how much, and how many installments are left.',
    icon: HandCoins,
    payroll: true,
    config: cfg({ columns: ['name', 'department', 'loan_outstanding', 'active_loans', 'loan_installment', 'installments_left'], filters: [{ key: 'loan_outstanding', op: 'gt', value: 0 }] })
  },
  {
    key: 'probation',
    title: 'Probation ending (60 days)',
    desc: 'Employees whose probation ends soon — plan confirmations.',
    icon: CalendarClock,
    config: cfg({
      columns: ['name', 'designation', 'department', 'joining_date', 'probation_end_date', 'supervisor'],
      filters: [
        { key: 'service_status', op: 'eq', value: 'probation' },
        { key: 'probation_end_date', op: 'next_days', value: 60 }
      ]
    })
  },
  {
    key: 'birthdays',
    title: `Birthdays in ${thisMonthName}`,
    desc: 'For greetings this month.',
    icon: Cake,
    config: cfg({ columns: ['name', 'designation', 'department', 'date_of_birth', 'age'], filters: [{ key: 'birth_month', op: 'eq', value: thisMonthName }] })
  },
  {
    key: 'anniversaries',
    title: `Service anniversaries in ${thisMonthName}`,
    desc: 'Employees completing another year this month.',
    icon: Sparkles,
    config: cfg({ columns: ['name', 'designation', 'department', 'joining_date', 'service_years'], filters: [{ key: 'joining_month', op: 'eq', value: thisMonthName }] })
  },
  {
    key: 'assets',
    title: 'Assets with employees',
    desc: 'Who holds which company asset.',
    icon: Package,
    config: cfg({ columns: ['name', 'department', 'assets_held', 'asset_names'], filters: [{ key: 'assets_held', op: 'gt', value: 0 }] })
  },
  {
    key: 'blood',
    title: 'Blood group directory',
    desc: 'Grouped by blood group, with mobile numbers.',
    icon: Droplet,
    config: cfg({ columns: ['name', 'department', 'blood_group', 'mobile'], group_by: 'blood_group' })
  },
  {
    key: 'headcount',
    title: 'Headcount by department',
    desc: 'Active employees per department.',
    icon: Users,
    config: cfg({ columns: ['name', 'employee_code', 'designation', 'department', 'joining_date'], group_by: 'department' })
  }
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const OPS: Record<ColType, [string, string][]> = {
  text: [
    ['eq', 'is'],
    ['neq', 'is not'],
    ['contains', 'contains'],
    ['not_contains', "doesn't contain"],
    ['empty', 'is blank'],
    ['not_empty', 'is not blank']
  ],
  list: [
    ['contains', 'includes'],
    ['not_contains', "doesn't include"],
    ['empty', 'is empty'],
    ['not_empty', 'has any'],
    ['count_gt', 'count more than']
  ],
  number: [
    ['gt', '>'],
    ['gte', '≥'],
    ['lt', '<'],
    ['lte', '≤'],
    ['eq', '='],
    ['neq', '≠'],
    ['empty', 'is blank']
  ],
  money: [
    ['gt', '>'],
    ['gte', '≥'],
    ['lt', '<'],
    ['lte', '≤'],
    ['eq', '='],
    ['empty', 'is blank']
  ],
  date: [
    ['before', 'before'],
    ['after', 'after'],
    ['between', 'between'],
    ['next_days', 'in the next … days'],
    ['past_days', 'in the last … days'],
    ['empty', 'is blank'],
    ['not_empty', 'is set']
  ],
  bool: [
    ['is_true', 'is Yes'],
    ['is_false', 'is No']
  ]
};
const NO_VALUE = new Set(['empty', 'not_empty', 'is_true', 'is_false']);

function display(v: any, type: ColType): string {
  if (v === null || v === undefined || v === '') return '';
  if (type === 'list') return Array.isArray(v) ? v.join(', ') : String(v);
  if (type === 'bool') return v ? 'Yes' : 'No';
  if (type === 'date') return fmtDate(v);
  if (type === 'money') return taka(Number(v));
  if (type === 'number') return Number(v).toLocaleString('en-IN', { maximumFractionDigits: 1 });
  return String(v);
}
// Plain values for Excel (numbers stay numbers).
function raw(v: any, type: ColType): any {
  if (v === null || v === undefined) return '';
  if (type === 'list') return Array.isArray(v) ? v.join(', ') : String(v);
  if (type === 'bool') return v ? 'Yes' : 'No';
  if (type === 'date') return fmtDate(v);
  return v;
}
const periodText = (r: ReportResult) => {
  const stages = new Set([...r.columns.map((c) => c.stage), r.group_by?.stage]);
  const parts: string[] = [];
  if (stages.has('attendance')) parts.push(monthLabel(r.month));
  if (stages.has('leave') || stages.has('claims') || stages.has('salary')) parts.push(String(r.year));
  return parts.join(' · ');
};

function exportExcel(title: string, r: ReportResult) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(
    wb,
    XLSX.utils.aoa_to_sheet([r.columns.map((c) => c.label), ...r.rows.map((row) => r.columns.map((c) => raw(row[c.key], c.type)))]),
    'Employees'
  );
  if (r.groups && r.group_by) {
    const byId = new Map(r.rows.map((x) => [x.employee_id, x.name]));
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([[r.group_by.label, 'Employees', 'Names'], ...r.groups.map((g) => [g.key, g.count, g.employee_ids.map((id) => byId.get(id)).join(', ')])]),
      'Summary'
    );
  }
  XLSX.writeFile(wb, `${title.replace(/[^\w]+/g, '_')}.xlsx`);
}

async function exportPdf(title: string, r: ReportResult, filtersText: string) {
  const logo = await loadImageElement(credenceLogo);
  const wide = r.columns.length > 6;
  const doc = new jsPDF({ orientation: wide ? 'landscape' : 'portrait' });
  let y = drawPdfLetterhead(doc, logo, {
    reportTitle: pdfSafe(title),
    filters: [
      ['Employees', String(r.total)],
      ...(periodText(r) ? ([['Period', periodText(r)]] as [string, string][]) : []),
      ...(filtersText ? ([['Filters', pdfSafe(filtersText)]] as [string, string][]) : [])
    ]
  });
  if (r.groups && r.group_by) {
    autoTable(doc, {
      startY: y,
      head: [[pdfSafe(r.group_by.label), 'Employees']],
      body: r.groups.map((g) => [pdfSafe(g.key), String(g.count)]),
      styles: { fontSize: 8, cellPadding: 1.6 },
      headStyles: { fillColor: [37, 99, 235] },
      tableWidth: 120
    });
    y = (doc as any).lastAutoTable.finalY + 6;
  }
  autoTable(doc, {
    startY: y,
    head: [r.columns.map((c) => pdfSafe(c.label))],
    body: r.rows.map((row) => r.columns.map((c) => pdfSafe(display(row[c.key], c.type)))),
    styles: { fontSize: wide ? 6.5 : 7.5, cellPadding: 1.4 },
    headStyles: { fillColor: [37, 99, 235] }
  });
  finalizePdfPageNumbers(doc);
  await savePdfCrossPlatform(doc, `${title.replace(/[^\w]+/g, '_')}.pdf`);
}

// ---------------------------------------------------------------------------
// Result view (builder, saved and received runs)
// ---------------------------------------------------------------------------

// Columns that make a report about gaps HR can fix from the row.
const GAP_KEYS = new Set(['missing_documents', 'missing_documents_count', 'documents_status', 'expired_documents', 'nominee_status', 'nominees', 'nominee_share_total', 'has_emergency_contact', 'emergency_contact']);

const ResultView: React.FC<{
  title: string;
  result: ReportResult;
  filtersText?: string;
  onOpenEmployee?: (id: number) => void;
  // Row selection + "Request from employees" + per-row "Fix" (Report Builder).
  gapTools?: { token: string; canUpload: boolean; onChanged: () => void };
}> = ({ title, result, filtersText, onOpenEmployee, gapTools }) => {
  const [groupKey, setGroupKey] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [fixing, setFixing] = useState<{ employee_id: number; name: string; user_id: number | null } | null>(null);
  const [requesting, setRequesting] = useState(false);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  useEffect(() => setSelected(new Set()), [result]);
  const showFix = !!gapTools && [...result.columns.map((c) => c.key), result.group_by?.key].some((k) => k && GAP_KEYS.has(k));
  const [sort, setSort] = useState<{ key: string; dir: 1 | -1 }>({ key: 'name', dir: 1 });
  const [q, setQ] = useState('');
  useEffect(() => setGroupKey(null), [result]);
  const group = result.groups?.find((g) => g.key === groupKey) || null;
  const rows = useMemo(() => {
    let rs = result.rows;
    if (group) {
      const ids = new Set(group.employee_ids);
      rs = rs.filter((r) => ids.has(r.employee_id));
    }
    const needle = q.trim().toLowerCase();
    if (needle) rs = rs.filter((r) => result.columns.some((c) => display(r[c.key], c.type).toLowerCase().includes(needle)));
    const col = result.columns.find((c) => c.key === sort.key);
    return [...rs].sort((a, b) => {
      const av = a[sort.key];
      const bv = b[sort.key];
      if (col && (col.type === 'number' || col.type === 'money')) return ((Number(av ?? -Infinity) || 0) - (Number(bv ?? -Infinity) || 0)) * sort.dir;
      if (col?.type === 'list') return ((av?.length || 0) - (bv?.length || 0)) * sort.dir;
      return String(av ?? '').localeCompare(String(bv ?? '')) * sort.dir;
    });
  }, [result, group, q, sort]);
  const maxCount = Math.max(1, ...(result.groups || []).map((g) => g.count));
  const allVisibleSelected = rows.length > 0 && rows.every((r) => selected.has(r.employee_id));
  const requestTargets = (selected.size ? result.rows.filter((r) => selected.has(r.employee_id)) : rows).map((r) => ({ employee_id: r.employee_id, name: r.name }));
  return (
    <div className="space-y-3">
      <Notice msg={notice} onClose={() => setNotice(null)} />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          <span className="font-bold text-slate-900">{result.total}</span> <span className="text-slate-500">employee(s)</span>
          {periodText(result) && <span className="text-slate-400"> · {periodText(result)}</span>}
          {result.truncated && <span className="text-amber-600"> · showing first 5,000</span>}
        </div>
        <div className="flex gap-2">
          <button type="button" className={btnGhost} onClick={() => exportExcel(title, result)}>
            <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
          </button>
          <button type="button" className={btnGhost} onClick={() => exportPdf(title, result, filtersText || '')}>
            <FileDown className="w-3.5 h-3.5" /> PDF
          </button>
        </div>
      </div>
      {result.groups && result.group_by && (
        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="text-xs font-bold text-slate-700 mb-2">By {result.group_by.label}</div>
          <div className="space-y-1 max-h-72 overflow-y-auto">
            {result.groups.map((g) => (
              <button
                key={g.key}
                type="button"
                onClick={() => setGroupKey(groupKey === g.key ? null : g.key)}
                className={`w-full flex items-center gap-2 text-left rounded-md px-2 py-1 ${groupKey === g.key ? 'bg-blue-50 ring-1 ring-blue-200' : 'hover:bg-slate-50'}`}
              >
                <span className="w-40 sm:w-60 shrink-0 truncate text-xs text-slate-700" title={g.key}>
                  {g.key}
                </span>
                <span className="flex-1 h-2.5 rounded-full bg-slate-100 overflow-hidden">
                  <span className="block h-full bg-blue-500 rounded-full" style={{ width: `${(g.count / maxCount) * 100}%` }} />
                </span>
                <span className="w-10 text-right text-xs font-bold text-slate-800">{g.count}</span>
              </button>
            ))}
          </div>
          <p className="text-[10px] text-slate-400 mt-1.5">Click a bar to list those employees.{result.group_by.type === 'list' ? ' An employee can count in more than one bar.' : ''}</p>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search in results…" className={`${inputCls} max-w-xs`} />
        {gapTools && rows.length > 0 && (
          <button type="button" className={btnPrimary} onClick={() => setRequesting(true)}>
            <MailQuestion className="w-3.5 h-3.5" /> Request from employees ({selected.size || rows.length})
          </button>
        )}
        {group && (
          <span className="inline-flex items-center gap-1 text-xs bg-blue-50 text-blue-700 px-2 py-1 rounded-md">
            {result.group_by?.label}: {group.key}
            <button type="button" onClick={() => setGroupKey(null)} aria-label="Clear">
              <X className="w-3 h-3" />
            </button>
          </span>
        )}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto max-h-[60vh]">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-slate-500 sticky top-0">
            <tr>
              {gapTools && (
                <th className="px-3 py-2 w-8">
                  <input
                    type="checkbox"
                    checked={allVisibleSelected}
                    onChange={(e) => setSelected(e.target.checked ? new Set(rows.map((r) => r.employee_id)) : new Set())}
                    aria-label="Select all"
                  />
                </th>
              )}
              {result.columns.map((c) => (
                <th
                  key={c.key}
                  onClick={() => setSort((s) => ({ key: c.key, dir: s.key === c.key ? (s.dir === 1 ? -1 : 1) : 1 }))}
                  className="px-3 py-2 text-left font-semibold whitespace-nowrap cursor-pointer select-none hover:text-slate-800"
                >
                  {c.label} {sort.key === c.key ? (sort.dir === 1 ? '▲' : '▼') : ''}
                </th>
              ))}
              {showFix && <th className="px-3 py-2" />}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {rows.length === 0 ? (
              <tr>
                <td colSpan={result.columns.length + (gapTools ? 1 : 0) + (showFix ? 1 : 0)} className="px-3 py-8 text-center text-slate-400">
                  No employee matches.
                </td>
              </tr>
            ) : (
              rows.map((r) => (
                <tr key={r.employee_id} className={`hover:bg-slate-50/60 ${selected.has(r.employee_id) ? 'bg-blue-50/40' : ''}`}>
                  {gapTools && (
                    <td className="px-3 py-1.5 align-top">
                      <input
                        type="checkbox"
                        checked={selected.has(r.employee_id)}
                        onChange={(e) =>
                          setSelected((sel) => {
                            const n = new Set(sel);
                            if (e.target.checked) n.add(r.employee_id);
                            else n.delete(r.employee_id);
                            return n;
                          })
                        }
                        aria-label={`Select ${r.name}`}
                      />
                    </td>
                  )}
                  {result.columns.map((c) => (
                    <td key={c.key} className={`px-3 py-1.5 align-top ${c.type === 'number' || c.type === 'money' ? 'text-right whitespace-nowrap' : ''} ${c.type === 'list' ? 'min-w-[160px]' : ''}`}>
                      {c.key === 'name' && onOpenEmployee ? (
                        <button type="button" className="font-semibold text-blue-700 hover:underline text-left" onClick={() => onOpenEmployee(r.employee_id)}>
                          {r.name}
                        </button>
                      ) : (
                        display(r[c.key], c.type) || <span className="text-slate-300">—</span>
                      )}
                    </td>
                  ))}
                  {showFix && (
                    <td className="px-3 py-1.5 align-top text-right">
                      <button
                        type="button"
                        className="inline-flex items-center gap-1 text-[11px] font-semibold text-blue-600 whitespace-nowrap"
                        onClick={() => setFixing({ employee_id: r.employee_id, name: r.name, user_id: r.user_id ?? null })}
                      >
                        <Wrench className="w-3 h-3" /> Fix
                      </button>
                    </td>
                  )}
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {fixing && gapTools && (
        <FixGapsModal
          token={gapTools.token}
          employee={fixing}
          canUpload={gapTools.canUpload}
          onClose={(changed) => {
            setFixing(null);
            if (changed) gapTools.onChanged();
          }}
        />
      )}
      {requesting && gapTools && (
        <RequestInfoModal
          token={gapTools.token}
          employees={requestTargets}
          onClose={() => setRequesting(false)}
          onSent={(text) => {
            setRequesting(false);
            setSelected(new Set());
            setNotice({ type: 'success', text: `${text} Track them under Requests.` });
          }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Builder
// ---------------------------------------------------------------------------

const Builder: React.FC<{
  token: string;
  canUpload: boolean;
  columns: ColumnDef[];
  recipients: { id: number; name: string }[];
  initial: { config: ReportConfig; title: string; saved?: SavedReport | null; autorun?: boolean; ts: number };
  onSaved: () => void;
  onOpenEmployee: (id: number) => void;
}> = ({ token, canUpload, columns, recipients, initial, onSaved, onOpenEmployee }) => {
  const api = useHrApi(token);
  const colBy = useMemo(() => new Map(columns.map((c) => [c.key, c])), [columns]);
  const clean = (c: ReportConfig): ReportConfig => ({
    ...c,
    columns: c.columns.filter((k) => colBy.has(k)),
    filters: c.filters.filter((f) => colBy.has(f.key)),
    group_by: c.group_by && colBy.has(c.group_by) ? c.group_by : null
  });
  const [config, setConfig] = useState<ReportConfig>(() => clean(initial.config));
  const [title, setTitle] = useState(initial.title);
  const [result, setResult] = useState<ReportResult | null>(null);
  const [running, setRunning] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [colSearch, setColSearch] = useState('');
  const [saving, setSaving] = useState(false);
  const [showSave, setShowSave] = useState(false);

  const run = async (c = config) => {
    setRunning(true);
    setMsg(null);
    try {
      setResult(await api.post<ReportResult>('/api/hr-ops/reports/run', c));
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setRunning(false);
    }
  };
  useEffect(() => {
    const c = clean(initial.config);
    setConfig(c);
    setTitle(initial.title);
    setResult(null);
    if (initial.autorun) run(c);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initial.ts]);

  const groups = useMemo(() => Array.from(new Set(columns.map((c) => c.group))), [columns]);
  const toggleCol = (k: string) =>
    setConfig((c) => ({ ...c, columns: c.columns.includes(k) ? c.columns.filter((x) => x !== k) : [...c.columns, k] }));
  const usedStages = new Set([...config.columns, ...config.filters.map((f) => f.key), ...(config.group_by ? [config.group_by] : [])].map((k) => colBy.get(k)?.stage));
  const needsMonth = usedStages.has('attendance');
  const needsYear = usedStages.has('leave') || usedStages.has('claims') || usedStages.has('salary');
  const filtersText = config.filters
    .map((f) => {
      const c = colBy.get(f.key);
      const op = c ? OPS[c.type].find(([k]) => k === f.op)?.[1] : f.op;
      return `${c?.label || f.key} ${op}${NO_VALUE.has(f.op) ? '' : ` ${Array.isArray(f.value) ? f.value.join('–') : f.value ?? ''}`}`;
    })
    .join(config.match === 'any' ? ' OR ' : ' AND ');

  const now = new Date();
  const monthOptions: [string, string][] = [
    ['current', 'This month'],
    ['previous', 'Last month'],
    ...Array.from({ length: 12 }, (_, i) => {
      const d = new Date(now.getFullYear(), now.getMonth() - i, 1);
      const v = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
      return [v, monthLabel(v)] as [string, string];
    })
  ];
  const yearOptions: [string, string][] = [
    ['current', 'This year'],
    ['previous', 'Last year'],
    ...Array.from({ length: 5 }, (_, i) => String(now.getFullYear() - i)).map((y) => [y, y] as [string, string])
  ];

  return (
    <div className="grid xl:grid-cols-[340px_1fr] gap-4">
      <div className="space-y-3">
        <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
          <label className={labelCls}>Report title</label>
          <input value={title} onChange={(e) => setTitle(e.target.value)} className={inputCls} />
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Group &amp; count by</label>
              <select value={config.group_by || ''} onChange={(e) => setConfig({ ...config, group_by: e.target.value || null })} className={inputCls}>
                <option value="">No grouping</option>
                {groups.map((g) => (
                  <optgroup key={g} label={g}>
                    {columns
                      .filter((c) => c.group === g && c.type !== 'money' && c.type !== 'date')
                      .map((c) => (
                        <option key={c.key} value={c.key}>
                          {c.label}
                        </option>
                      ))}
                  </optgroup>
                ))}
              </select>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700 pt-5">
              <input type="checkbox" checked={config.include_inactive} onChange={(e) => setConfig({ ...config, include_inactive: e.target.checked })} /> Include inactive
            </label>
          </div>
          {(needsMonth || needsYear) && (
            <div className="grid grid-cols-2 gap-2">
              {needsMonth && (
                <div>
                  <label className={labelCls}>Attendance month</label>
                  <select value={config.month} onChange={(e) => setConfig({ ...config, month: e.target.value })} className={inputCls}>
                    {monthOptions.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {needsYear && (
                <div>
                  <label className={labelCls}>Leave / claims / pay year</label>
                  <select value={config.year} onChange={(e) => setConfig({ ...config, year: e.target.value })} className={inputCls}>
                    {yearOptions.map(([v, l]) => (
                      <option key={v} value={v}>
                        {l}
                      </option>
                    ))}
                  </select>
                </div>
              )}
            </div>
          )}
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold text-slate-700 flex items-center gap-1">
              <ListFilter className="w-3.5 h-3.5" /> Filters
            </div>
            {config.filters.length > 1 && (
              <select value={config.match} onChange={(e) => setConfig({ ...config, match: e.target.value as 'all' | 'any' })} className="text-[11px] border border-slate-200 rounded px-1 py-0.5">
                <option value="all">Match all</option>
                <option value="any">Match any</option>
              </select>
            )}
          </div>
          <div className="space-y-2">
            {config.filters.map((f, i) => {
              const c = colBy.get(f.key)!;
              const set = (p: Partial<Filter>) => setConfig({ ...config, filters: config.filters.map((x, j) => (j === i ? { ...x, ...p } : x)) });
              return (
                <div key={i} className="rounded-lg border border-slate-100 bg-slate-50/60 p-2 space-y-1.5">
                  <div className="flex gap-1">
                    <select value={f.key} onChange={(e) => set({ key: e.target.value, op: OPS[colBy.get(e.target.value)!.type][0][0], value: '' })} className={`${inputCls} !py-1 !text-xs`}>
                      {groups.map((g) => (
                        <optgroup key={g} label={g}>
                          {columns
                            .filter((x) => x.group === g)
                            .map((x) => (
                              <option key={x.key} value={x.key}>
                                {x.label}
                              </option>
                            ))}
                        </optgroup>
                      ))}
                    </select>
                    <button type="button" className="p-1 text-slate-400 hover:text-rose-600" onClick={() => setConfig({ ...config, filters: config.filters.filter((_, j) => j !== i) })} aria-label="Remove filter">
                      <Trash2 className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  <div className="flex gap-1">
                    <select value={f.op} onChange={(e) => set({ op: e.target.value })} className={`${inputCls} !py-1 !text-xs !w-auto`}>
                      {OPS[c.type].map(([k, l]) => (
                        <option key={k} value={k}>
                          {l}
                        </option>
                      ))}
                    </select>
                    {!NO_VALUE.has(f.op) &&
                      (f.op === 'between' ? (
                        <>
                          <input
                            type={c.type === 'date' ? 'date' : 'number'}
                            value={Array.isArray(f.value) ? f.value[0] : ''}
                            onChange={(e) => set({ value: [e.target.value, Array.isArray(f.value) ? f.value[1] : ''] })}
                            className={`${inputCls} !py-1 !text-xs`}
                          />
                          <input
                            type={c.type === 'date' ? 'date' : 'number'}
                            value={Array.isArray(f.value) ? f.value[1] : ''}
                            onChange={(e) => set({ value: [Array.isArray(f.value) ? f.value[0] : '', e.target.value] })}
                            className={`${inputCls} !py-1 !text-xs`}
                          />
                        </>
                      ) : (
                        <input
                          type={c.type === 'date' && f.op !== 'next_days' && f.op !== 'past_days' ? 'date' : c.type === 'number' || c.type === 'money' || f.op.endsWith('_days') || f.op === 'count_gt' ? 'number' : 'text'}
                          value={f.value ?? ''}
                          onChange={(e) => set({ value: e.target.value })}
                          className={`${inputCls} !py-1 !text-xs`}
                          placeholder={c.type === 'list' ? 'e.g. XYZ Company' : ''}
                        />
                      ))}
                  </div>
                </div>
              );
            })}
            <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={() => setConfig({ ...config, filters: [...config.filters, { key: 'department', op: 'eq', value: '' }] })}>
              <Plus className="w-3 h-3" /> Add filter
            </button>
          </div>
        </div>

        <div className="rounded-xl border border-slate-200 bg-white p-3">
          <div className="flex items-center justify-between mb-2">
            <div className="text-xs font-bold text-slate-700">Columns ({config.columns.length})</div>
            <input value={colSearch} onChange={(e) => setColSearch(e.target.value)} placeholder="Find…" className="text-[11px] border border-slate-200 rounded px-2 py-0.5 w-28" />
          </div>
          <div className="max-h-80 overflow-y-auto space-y-2 pr-1">
            {groups.map((g) => {
              const cs = columns.filter((c) => c.group === g && c.label.toLowerCase().includes(colSearch.toLowerCase()));
              if (!cs.length) return null;
              return (
                <div key={g}>
                  <div className="text-[10px] font-bold uppercase tracking-wide text-slate-400 mb-0.5">{g}</div>
                  <div className="grid grid-cols-2 gap-x-2">
                    {cs.map((c) => (
                      <label key={c.key} className="flex items-center gap-1.5 text-[11px] text-slate-700 py-0.5">
                        <input type="checkbox" checked={config.columns.includes(c.key)} disabled={c.key === 'name'} onChange={() => toggleCol(c.key)} />
                        <span className="truncate" title={c.label}>
                          {c.label}
                        </span>
                      </label>
                    ))}
                  </div>
                </div>
              );
            })}
          </div>
        </div>

        <div className="flex gap-2">
          <button type="button" className={`${btnPrimary} flex-1`} disabled={running} onClick={() => run()}>
            {running ? <Spinner size={14} /> : <Play className="w-3.5 h-3.5" />} Run
          </button>
          <button type="button" className={btnGhost} onClick={() => setShowSave(true)}>
            <Save className="w-3.5 h-3.5" /> {initial.saved ? 'Update' : 'Save'}
          </button>
        </div>
      </div>

      <div className="min-w-0">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        {running && !result ? (
          <div className="flex items-center justify-center gap-2 py-20 text-sm text-slate-500">
            <Spinner size={16} /> Building report…
          </div>
        ) : result ? (
          <>
            <h3 className="text-sm font-bold text-slate-900 mb-1">{title}</h3>
            {filtersText && <p className="text-[11px] text-slate-500 mb-2">Filters: {filtersText}</p>}
            <ResultView title={title} result={result} filtersText={filtersText} onOpenEmployee={onOpenEmployee} gapTools={{ token, canUpload, onChanged: () => run() }} />
          </>
        ) : (
          <div className="text-center py-20 text-sm text-slate-400">
            <Play className="w-8 h-8 mx-auto mb-2 text-slate-300" />
            Choose columns and filters, then Run.
          </div>
        )}
      </div>

      {showSave && (
        <SaveModal
          token={token}
          saved={initial.saved || null}
          title={title}
          config={config}
          recipients={recipients}
          saving={saving}
          setSaving={setSaving}
          onClose={() => setShowSave(false)}
          onSaved={() => {
            setShowSave(false);
            setMsg({ type: 'success', text: 'Report saved — find it under My Reports.' });
            onSaved();
          }}
        />
      )}
    </div>
  );
};

// ---------------------------------------------------------------------------
// Save / schedule
// ---------------------------------------------------------------------------

const scheduleText = (s: Schedule | null) => {
  if (!s) return null;
  const at = `${String(s.hour).padStart(2, '0')}:00`;
  return s.frequency === 'daily' ? `Every day at ${at}` : s.frequency === 'weekly' ? `Every ${WEEKDAYS[s.weekday]} at ${at}` : `Monthly on day ${s.day} at ${at}`;
};

const SaveModal: React.FC<{
  token: string;
  saved: SavedReport | null;
  title: string;
  config: ReportConfig;
  recipients: { id: number; name: string }[];
  saving: boolean;
  setSaving: (b: boolean) => void;
  onClose: () => void;
  onSaved: () => void;
}> = ({ token, saved, title, config, recipients, saving, setSaving, onClose, onSaved }) => {
  const api = useHrApi(token);
  const [name, setName] = useState(saved?.name || title);
  const [scheduled, setScheduled] = useState(!!saved?.schedule);
  const [s, setS] = useState<Schedule>(saved?.schedule || { frequency: 'monthly', weekday: 0, day: 1, hour: 9, recipients: [], only_if_rows: true });
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const save = async () => {
    if (scheduled && s.recipients.length === 0) return setMsg({ type: 'error', text: 'Pick at least one person to notify.' });
    setSaving(true);
    try {
      const body = { name, config, schedule: scheduled ? s : null };
      if (saved) await api.put(`/api/hr-ops/saved-reports/${saved.id}`, body);
      else await api.post('/api/hr-ops/saved-reports', body);
      onSaved();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal
      title={saved ? 'Update Saved Report' : 'Save Report'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={saving} onClick={save}>
            {saving && <Spinner size={14} />} Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <div>
          <label className={labelCls}>Name</label>
          <input value={name} onChange={(e) => setName(e.target.value)} className={inputCls} />
          <p className="text-[11px] text-slate-400 mt-1">Only you can see and run your saved reports.</p>
        </div>
        <label className="flex items-center gap-2 text-xs font-semibold text-slate-700">
          <input type="checkbox" checked={scheduled} onChange={(e) => setScheduled(e.target.checked)} /> Send automatically on a schedule
        </label>
        {scheduled && (
          <div className="rounded-lg border border-slate-200 p-3 space-y-3">
            <div className="grid grid-cols-3 gap-2">
              <div>
                <label className={labelCls}>Frequency</label>
                <select value={s.frequency} onChange={(e) => setS({ ...s, frequency: e.target.value as Schedule['frequency'] })} className={inputCls}>
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                </select>
              </div>
              {s.frequency === 'weekly' && (
                <div>
                  <label className={labelCls}>Day</label>
                  <select value={s.weekday} onChange={(e) => setS({ ...s, weekday: Number(e.target.value) })} className={inputCls}>
                    {WEEKDAYS.map((w, i) => (
                      <option key={w} value={i}>
                        {w}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {s.frequency === 'monthly' && (
                <div>
                  <label className={labelCls}>Day of month</label>
                  <select value={s.day} onChange={(e) => setS({ ...s, day: Number(e.target.value) })} className={inputCls}>
                    {Array.from({ length: 28 }, (_, i) => i + 1).map((d) => (
                      <option key={d} value={d}>
                        {d}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              <div>
                <label className={labelCls}>Time</label>
                <select value={s.hour} onChange={(e) => setS({ ...s, hour: Number(e.target.value) })} className={inputCls}>
                  {Array.from({ length: 24 }, (_, h) => h).map((h) => (
                    <option key={h} value={h}>
                      {String(h).padStart(2, '0')}:00
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <label className={labelCls}>Notify</label>
              <div className="max-h-40 overflow-y-auto grid grid-cols-2 gap-1">
                {recipients.map((u) => (
                  <label key={u.id} className="flex items-center gap-1.5 text-xs text-slate-700">
                    <input
                      type="checkbox"
                      checked={s.recipients.includes(u.id)}
                      onChange={(e) => setS({ ...s, recipients: e.target.checked ? [...s.recipients, u.id] : s.recipients.filter((x) => x !== u.id) })}
                    />
                    {u.name}
                  </label>
                ))}
              </div>
              <p className="text-[10px] text-slate-400 mt-1">Only people with HR Operations access are listed. They get an alert and can open the result under Received — not the report itself.</p>
            </div>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={s.only_if_rows} onChange={(e) => setS({ ...s, only_if_rows: e.target.checked })} /> Skip when no employee matches
            </label>
            {(config.month === 'current' || config.year === 'current') && s.frequency === 'monthly' && s.day <= 5 && (
              <p className="text-[11px] text-amber-700">Tip: early in the month, "Last month" usually makes more sense for attendance / leave figures.</p>
            )}
          </div>
        )}
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// Company names
// ---------------------------------------------------------------------------

const CompanyNames: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [rows, setRows] = useState<{ key: string; name: string; variants: { name: string; count: number }[]; employee_count: number; employees: string[] }[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [target, setTarget] = useState('');
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [q, setQ] = useState('');
  const load = () => api.get<any[]>('/api/hr-ops/companies').then(setRows).catch((e) => setMsg({ type: 'error', text: e.message }));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const merge = async (names: string[], to: string) => {
    try {
      const r = await api.post<{ updated: number }>('/api/hr-ops/companies/merge', { names, to });
      setMsg({ type: 'success', text: `${r.updated} record(s) now read "${to}".` });
      setPicked(new Set());
      setTarget('');
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  if (!rows) return <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500"><Spinner size={16} /> Loading…</div>;
  const list = rows.filter((r) => !q || r.name.toLowerCase().includes(q.toLowerCase()) || r.variants.some((v) => v.name.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="space-y-3">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <p className="text-xs text-slate-500 max-w-3xl">
        Spellings like "XYZ Ltd", "XYZ Limited" and "xyz ltd." are already counted as one company in reports. To clean the records themselves, tick companies
        (or use "Use one spelling" on a row) and merge them into one name — new entries are then suggested with that spelling.
      </p>
      <div className="flex flex-wrap items-end gap-2">
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search company…" className={`${inputCls} max-w-xs`} />
        {picked.size > 1 && (
          <>
            <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Keep as…" className={`${inputCls} max-w-xs`} />
            <button type="button" className={btnPrimary} disabled={!target.trim()} onClick={() => merge([...picked], target.trim())}>
              Merge {picked.size} companies
            </button>
          </>
        )}
      </div>
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="min-w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="px-3 py-2" />
              <th className="px-3 py-2 text-left font-semibold">Company</th>
              <th className="px-3 py-2 text-left font-semibold">Spellings on record</th>
              <th className="px-3 py-2 text-right font-semibold">Employees</th>
              <th className="px-3 py-2" />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {list.length === 0 ? (
              <tr>
                <td colSpan={5} className="px-3 py-8 text-center text-slate-400">
                  No previous employers recorded yet.
                </td>
              </tr>
            ) : (
              list.map((r) => (
                <tr key={r.key}>
                  <td className="px-3 py-2">
                    <input
                      type="checkbox"
                      checked={picked.has(r.name)}
                      onChange={(e) =>
                        setPicked((p) => {
                          const n = new Set(p);
                          if (e.target.checked) n.add(r.name);
                          else n.delete(r.name);
                          if (!target) setTarget(r.name);
                          return n;
                        })
                      }
                    />
                  </td>
                  <td className="px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                  <td className="px-3 py-2">
                    <div className="flex flex-wrap gap-1">
                      {r.variants.map((v) => (
                        <Badge key={v.name} tone={r.variants.length > 1 ? 'pending' : 'na'}>
                          {v.name} ×{v.count}
                        </Badge>
                      ))}
                    </div>
                  </td>
                  <td className="px-3 py-2 text-right" title={r.employees.join(', ')}>
                    {r.employee_count}
                  </td>
                  <td className="px-3 py-2 text-right">
                    {r.variants.length > 1 && (
                      <button type="button" className="text-[11px] font-semibold text-blue-600 whitespace-nowrap" onClick={() => merge([r.name], r.name)}>
                        Use one spelling
                      </button>
                    )}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Page
// ---------------------------------------------------------------------------

type View = 'ready' | 'builder' | 'saved' | 'received' | 'requests' | 'companies';
const VIEW_KEY = 'hr_reports_view';

export const HrOpsReports: React.FC<{ token: string; onOpenEmployee: (id: number) => void }> = ({ token, onOpenEmployee }) => {
  const api = useHrApi(token);
  const [view, setView] = useState<View>(() => {
    try {
      const v = sessionStorage.getItem(VIEW_KEY) as View | null;
      if (v) sessionStorage.removeItem(VIEW_KEY);
      if (v && ['ready', 'builder', 'saved', 'received', 'requests', 'companies'].includes(v)) return v;
    } catch {
      // storage unavailable
    }
    return 'ready';
  });
  const [catalog, setCatalog] = useState<{ columns: ColumnDef[]; payroll: boolean; document_vault: boolean; recipients: { id: number; name: string }[] } | null>(null);
  const [error, setError] = useState('');
  const [builderInit, setBuilderInit] = useState<{ config: ReportConfig; title: string; saved?: SavedReport | null; autorun?: boolean; ts: number }>({
    config: EMPTY,
    title: 'Employee Report',
    ts: 0
  });
  const [saved, setSaved] = useState<SavedReport[]>([]);
  const [runs, setRuns] = useState<RunRow[]>([]);
  const [openRun, setOpenRun] = useState<(ReportResult & { report_name: string; run_at: string }) | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  useEffect(() => {
    api.get<any>('/api/hr-ops/reports/catalog').then(setCatalog).catch((e) => setError(e.message));
  }, [api]);
  // An alert (Received / Requests) clicked while this page is already open.
  useEffect(() => {
    const onTab = (e: Event) => {
      if ((e as CustomEvent).detail !== 'reports') return;
      try {
        const v = sessionStorage.getItem(VIEW_KEY) as View | null;
        if (v) {
          sessionStorage.removeItem(VIEW_KEY);
          setView(v);
          setOpenRun(null);
        }
      } catch {
        // storage unavailable
      }
    };
    window.addEventListener('credence:hr-ops-tab', onTab);
    return () => window.removeEventListener('credence:hr-ops-tab', onTab);
  }, []);
  const loadSaved = () => api.get<SavedReport[]>('/api/hr-ops/saved-reports').then(setSaved).catch(() => {});
  const loadRuns = () => api.get<RunRow[]>('/api/hr-ops/report-runs').then(setRuns).catch(() => {});
  useEffect(() => {
    if (view === 'saved') loadSaved();
    if (view === 'received') loadRuns();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const openBuilder = (config: ReportConfig, title: string, savedReport: SavedReport | null = null, autorun = true) => {
    setBuilderInit({ config, title, saved: savedReport, autorun, ts: Date.now() });
    setView('builder');
  };

  if (error) return <Notice msg={{ type: 'error', text: error }} />;
  if (!catalog)
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Spinner size={16} /> Loading…
      </div>
    );

  const VIEWS: { key: View; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
    { key: 'ready', label: 'Ready Reports', icon: Sparkles },
    { key: 'builder', label: 'Report Builder', icon: ListFilter },
    { key: 'saved', label: 'My Reports', icon: Save },
    { key: 'received', label: 'Received', icon: Inbox },
    { key: 'requests', label: 'Requests', icon: MailQuestion },
    { key: 'companies', label: 'Company Names', icon: Building2 }
  ];

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap gap-1 rounded-xl bg-slate-100 p-1 w-fit max-w-full overflow-x-auto">
        {VIEWS.map((v) => (
          <button
            key={v.key}
            type="button"
            onClick={() => {
              setView(v.key);
              setOpenRun(null);
            }}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg whitespace-nowrap ${view === v.key ? 'bg-white shadow-sm text-blue-700' : 'text-slate-600 hover:text-slate-900'}`}
          >
            <v.icon className="w-3.5 h-3.5" /> {v.label}
          </button>
        ))}
      </div>
      <Notice msg={msg} onClose={() => setMsg(null)} />

      {view === 'ready' && (
        <div className="grid sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {PRESETS.filter((p) => !p.payroll || catalog.payroll).map((p) => (
            <button key={p.key} type="button" onClick={() => openBuilder(p.config, p.title)} className="text-left rounded-xl border border-slate-200 bg-white p-4 hover:border-blue-300 hover:shadow-sm transition">
              <div className="w-8 h-8 rounded-lg bg-blue-50 text-blue-600 flex items-center justify-center mb-2">
                <p.icon className="w-4 h-4" />
              </div>
              <div className="text-sm font-bold text-slate-800">{p.title}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{p.desc}</div>
            </button>
          ))}
          <button type="button" onClick={() => openBuilder(EMPTY, 'Employee Report', null, false)} className="text-left rounded-xl border border-dashed border-slate-300 p-4 hover:border-blue-300">
            <div className="w-8 h-8 rounded-lg bg-slate-100 text-slate-500 flex items-center justify-center mb-2">
              <Plus className="w-4 h-4" />
            </div>
            <div className="text-sm font-bold text-slate-800">Build your own</div>
            <div className="text-[11px] text-slate-500 mt-0.5">Any columns, filters and grouping — {catalog.columns.length} fields available.</div>
          </button>
        </div>
      )}

      {view === 'builder' && (
        <Builder token={token} canUpload={catalog.document_vault} columns={catalog.columns} recipients={catalog.recipients} initial={builderInit} onSaved={loadSaved} onOpenEmployee={onOpenEmployee} />
      )}

      {view === 'saved' && (
        <div className="space-y-2">
          {saved.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-14">No saved reports yet. Open any report, then "Save".</p>
          ) : (
            saved.map((r) => (
              <div key={r.id} className="flex flex-wrap items-center justify-between gap-2 rounded-xl border border-slate-200 bg-white p-3">
                <div className="min-w-0">
                  <div className="text-sm font-bold text-slate-800">{r.name}</div>
                  <div className="text-[11px] text-slate-500">
                    {r.config.columns.length} columns · {r.config.filters.length} filter(s)
                    {r.schedule ? (
                      <>
                        {' '}
                        · <CalendarClock className="w-3 h-3 inline" /> {scheduleText(r.schedule)} → {r.schedule.recipients.map((id) => catalog.recipients.find((u) => u.id === id)?.name || `#${id}`).join(', ')}
                      </>
                    ) : (
                      ' · not scheduled'
                    )}
                    {r.last_run_at && ` · last sent ${fmtDate(r.last_run_at)}`}
                  </div>
                </div>
                <div className="flex gap-2">
                  <button type="button" className={btnPrimary} onClick={() => openBuilder(r.config, r.name, r)}>
                    <Play className="w-3.5 h-3.5" /> Open
                  </button>
                  {r.schedule && (
                    <button
                      type="button"
                      className={btnGhost}
                      onClick={async () => {
                        try {
                          const x = await api.post<any>(`/api/hr-ops/saved-reports/${r.id}/send`);
                          setMsg({ type: 'success', text: `Sent: ${x.count} employee(s), ${x.notified} person(s) notified.` });
                          loadSaved();
                        } catch (e: any) {
                          setMsg({ type: 'error', text: e.message });
                        }
                      }}
                    >
                      <Send className="w-3.5 h-3.5" /> Send now
                    </button>
                  )}
                  <button
                    type="button"
                    className={btnGhost}
                    onClick={async () => {
                      if (!(await confirmDialog(`Delete "${r.name}"?`))) return;
                      await api.del(`/api/hr-ops/saved-reports/${r.id}`).catch(() => {});
                      loadSaved();
                    }}
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))
          )}
        </div>
      )}

      {view === 'received' &&
        (openRun ? (
          <div className="space-y-2">
            <button type="button" className="text-xs font-semibold text-blue-600" onClick={() => setOpenRun(null)}>
              ← All received reports
            </button>
            <h3 className="text-sm font-bold text-slate-900">
              {openRun.report_name} <span className="font-normal text-slate-400">· {new Date(openRun.run_at).toLocaleString()}</span>
            </h3>
            <ResultView title={openRun.report_name} result={openRun} onOpenEmployee={onOpenEmployee} />
          </div>
        ) : runs.length === 0 ? (
          <p className="text-sm text-slate-400 text-center py-14">Nothing received yet. Scheduled reports sent to you appear here.</p>
        ) : (
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="min-w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  {['Report', 'Sent', 'By', 'Employees', ''].map((h) => (
                    <th key={h} className="px-3 py-2 text-left font-semibold">
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {runs.map((r) => (
                  <tr key={r.id}>
                    <td className="px-3 py-2 font-semibold text-slate-800">{r.report_name}</td>
                    <td className="px-3 py-2 whitespace-nowrap">{new Date(r.run_at).toLocaleString()}</td>
                    <td className="px-3 py-2">{r.mine ? 'You' : r.sent_by || '—'}</td>
                    <td className="px-3 py-2">{r.row_count}</td>
                    <td className="px-3 py-2 text-right">
                      <button
                        type="button"
                        className="font-semibold text-blue-600"
                        onClick={async () => {
                          try {
                            setOpenRun(await api.get<any>(`/api/hr-ops/report-runs/${r.id}`));
                          } catch (e: any) {
                            setMsg({ type: 'error', text: e.message });
                          }
                        }}
                      >
                        Open
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ))}

      {view === 'requests' && <InfoRequestsReview token={token} canApproveDocs={catalog.document_vault} onOpenEmployee={onOpenEmployee} />}

      {view === 'companies' && <CompanyNames token={token} />}
    </div>
  );
};
