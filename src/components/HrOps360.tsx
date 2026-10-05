/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> "Service Book" — Employee 360: everything about one
// Employee on one page (HrOps360Routes.ts). A header with summary tiles,
// then tabs that each load their own section: Overview (service timeline),
// Personal & Family, Experience & Education, Documents, Attendance, Leave,
// Claims & Conveyance, Salary and Loans (Payroll module only), and Assets /
// Discipline / Performance. "Actions" runs the common operations from here —
// each one through the module that owns it, so its permission and workflow
// still apply. "Dossier" exports any mix of sections as PDF or Excel.
//
// The same page, read only, is the employee's own Service Book in Self
// Service -> My Letters & Service Record (`self`): it loads from
// /api/hr-ops/my/p360 (users.can_view_service_book) and offers no picker,
// actions or edit buttons.

import React, { createContext, useCallback, useContext, useEffect, useRef, useState } from 'react';
import { CompanyAssignmentsModal } from './HrOpsCompanyTools';
import {
  BookOpen,
  Briefcase,
  CalendarCheck,
  CalendarDays,
  CheckCircle2,
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ClipboardList,
  ExternalLink,
  FileDown,
  FileText,
  FolderOpen,
  GraduationCap,
  HandCoins,
  Landmark,
  LayoutDashboard,
  Package,
  Paperclip,
  Pencil,
  Plus,
  Receipt,
  ShieldCheck,
  Trash2,
  User,
  Users,
  Wallet,
  Building2
} from 'lucide-react';
import { Spinner } from './Spinner';
import { apiUrl } from '../lib/api';
import { NewActionModal } from './HrOpsActions';
import { LetterComposer } from './HrOpsLetters';
import { ServiceTimeline, serviceLength, saveServiceBookPdf } from './HrOpsServiceBook';
import {
  useHrApi,
  EmployeePicker,
  Modal,
  Notice,
  Field,
  Badge,
  fmtDate,
  monthLabel,
  taka,
  inputCls,
  labelCls,
  btnPrimary,
  btnGhost,
  SERVICE_STATUS_LABEL,
  type HrOpsEmployee,
  type HrOpsMeta
} from './HrOpsShared';
import {
  RecordModal,
  UploadDocumentModal,
  LoanModal,
  DisciplineModal,
  DossierModal,
  RECORD_FIELDS,
  DISCIPLINE_LABEL,
  type P360Overview,
  type RecordKind
} from './HrOps360Parts';
import { confirmDialog } from '../lib/confirmDialog';

type TabKey = 'overview' | 'personal' | 'career' | 'documents' | 'attendance' | 'leave' | 'claims' | 'salary' | 'loans' | 'discipline' | 'other';

// True inside the employee's own (read-only) Service Book.
const SelfBook = createContext(false);
// HR paths -> the employee's own ones (/api/hr-ops/my/p360/...).
const p360Path = (self: boolean, path: string) =>
  self ? path.replace(/^\/api\/hr-ops\/p360\/\d+(?=\/section|$)/, '/api/hr-ops/my/p360').replace(/^\/api\/hr-ops\/p360\/(records|documents)\//, '/api/hr-ops/my/p360/$1/') : path;

const TABS: { key: TabKey; label: string; icon: React.ComponentType<{ className?: string }>; payroll?: boolean }[] = [
  { key: 'overview', label: 'Overview', icon: LayoutDashboard },
  { key: 'personal', label: 'Personal & Family', icon: User },
  { key: 'career', label: 'Experience & Education', icon: GraduationCap },
  { key: 'documents', label: 'Documents', icon: FolderOpen },
  { key: 'attendance', label: 'Attendance', icon: CalendarCheck },
  { key: 'leave', label: 'Leave', icon: CalendarDays },
  { key: 'claims', label: 'Claims & Conveyance', icon: Receipt },
  { key: 'salary', label: 'Salary', icon: Wallet, payroll: true },
  { key: 'loans', label: 'Loans', icon: HandCoins, payroll: true },
  { key: 'discipline', label: 'Disciplinary', icon: ShieldCheck },
  { key: 'other', label: 'Assets & Records', icon: Package }
];

const thisYear = new Date().getFullYear();
const thisMonth = `${thisYear}-${String(new Date().getMonth() + 1).padStart(2, '0')}`;
const shiftMonth = (ym: string, by: number) => {
  const [y, m] = ym.split('-').map(Number);
  const d = new Date(y, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const initials = (name: string) =>
  name
    .split(/\s+/)
    .filter(Boolean)
    .slice(0, 2)
    .map((w) => w[0]!.toUpperCase())
    .join('');

// Opens a protected file (Authorization header) in a new tab.
async function openFile(token: string, path: string) {
  const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return;
  const url = URL.createObjectURL(await res.blob());
  window.open(url, '_blank');
}

// Loads one section when its tab opens (and again when `deps` change).
function useSection<T>(api: ReturnType<typeof useHrApi>, rawPath: string | null, reloadKey: number) {
  const self = useContext(SelfBook);
  const path = rawPath && p360Path(self, rawPath);
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  useEffect(() => {
    if (!path) return;
    let alive = true;
    setLoading(true);
    setError('');
    api
      .get<T>(path)
      .then((d) => alive && setData(d))
      .catch((e) => alive && setError(e.message))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, [api, path, reloadKey]);
  return { data, error, loading };
}

const Loading = () => (
  <div className="flex items-center justify-center gap-2 py-14 text-sm text-slate-500">
    <Spinner size={16} /> Loading…
  </div>
);
const Empty: React.FC<{ children: React.ReactNode }> = ({ children }) => <p className="text-xs text-slate-400 text-center py-8">{children}</p>;
const Card: React.FC<{ title: string; action?: React.ReactNode; children: React.ReactNode; className?: string }> = ({ title, action, children, className }) => (
  <div className={`rounded-xl border border-slate-200 bg-white ${className || ''}`}>
    <div className="flex items-center justify-between gap-2 px-4 py-2.5 border-b border-slate-100">
      <div className="text-xs font-bold text-slate-700">{title}</div>
      {action}
    </div>
    <div className="p-4">{children}</div>
  </div>
);
const Table: React.FC<{ head: string[]; rows: React.ReactNode[][]; empty?: string }> = ({ head, rows, empty }) =>
  rows.length === 0 ? (
    <Empty>{empty || 'No records.'}</Empty>
  ) : (
    <div className="overflow-x-auto -mx-4 px-4">
      <table className="min-w-full text-xs">
        <thead className="text-slate-500">
          <tr>
            {head.map((h) => (
              <th key={h} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap border-b border-slate-100">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-slate-50">
          {rows.map((r, i) => (
            <tr key={i}>
              {r.map((c, j) => (
                <td key={j} className="px-2 py-1.5 text-slate-700 align-top">
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
const Tile: React.FC<{ label: string; value: React.ReactNode; sub?: React.ReactNode; tone?: string; onClick?: () => void }> = ({ label, value, sub, tone, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    className={`text-left rounded-xl border px-3 py-2.5 transition-colors ${onClick ? 'hover:border-blue-300 hover:bg-blue-50/40' : 'cursor-default'} ${tone || 'border-slate-200 bg-white'}`}
  >
    <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
    <div className="text-sm font-bold text-slate-800 mt-0.5">{value}</div>
    {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
  </button>
);
const YearSelect: React.FC<{ value: number; onChange: (y: number) => void }> = ({ value, onChange }) => (
  <select value={value} onChange={(e) => onChange(Number(e.target.value))} className="text-xs px-2 py-1 border border-slate-200 rounded-md bg-white">
    {Array.from({ length: 6 }, (_, i) => thisYear - i).map((y) => (
      <option key={y} value={y}>
        {y}
      </option>
    ))}
  </select>
);
const statusTone = (s: string) => (s === 'approved' || s === 'paid' || s === 'completed' ? 'approved' : s === 'rejected' ? 'rejected' : s === 'pending' || s === 'active' || s === 'unpaid' ? 'pending' : 'na');

// ---------------------------------------------------------------------------

export const Employee360: React.FC<{
  token: string;
  meta?: HrOpsMeta;
  employees?: HrOpsEmployee[];
  employeeId: number | null;
  onPick?: (id: number | null) => void;
  onChanged?: () => void;
  // The employee's own read-only book (Self Service).
  self?: boolean;
}> = ({ token, meta: metaProp, employees = [], employeeId: employeeIdProp, onPick = () => {}, onChanged = () => {}, self = false }) => {
  const meta = metaProp as HrOpsMeta;
  // Own book: the server finds the Employee from the login.
  const employeeId = self ? -1 : employeeIdProp;
  const api = useHrApi(token);
  const [ov, setOv] = useState<P360Overview | null>(null);
  const [loading, setLoading] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [tab, setTab] = useState<TabKey>('overview');
  const [reloadKey, setReloadKey] = useState(0);
  const [menuOpen, setMenuOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement>(null);
  const [modal, setModal] = useState<
    | null
    | { kind: 'action' }
    | { kind: 'letter' }
    | { kind: 'service' }
    | { kind: 'record'; record: RecordKind; row: any | null }
    | { kind: 'document'; missing: string[] }
    | { kind: 'loan' }
    | { kind: 'discipline' }
    | { kind: 'dossier' }
    | { kind: 'companies' }
    | { kind: 'transfer' }
  >(null);
  const emp = employees.find((e) => e.id === employeeId) || null;

  const load = useCallback(async () => {
    if (!employeeId) {
      setOv(null);
      return;
    }
    setLoading(true);
    try {
      setOv(await api.get<P360Overview>(self ? '/api/hr-ops/my/p360' : `/api/hr-ops/p360/${employeeId}`));
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  }, [api, employeeId, self]);
  useEffect(() => {
    load();
  }, [load]);
  useEffect(() => {
    setTab('overview');
  }, [employeeId]);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) setMenuOpen(false);
    };
    document.addEventListener('mousedown', onDoc);
    return () => document.removeEventListener('mousedown', onDoc);
  }, []);

  const refresh = (text?: string) => {
    setModal(null);
    if (text) setMsg({ type: 'success', text });
    setReloadKey((k) => k + 1);
    load();
  };

  const perms = ov?.permissions;
  const e = ov?.employee;
  const s = ov?.summary;
  const needsLogin = (what: string) => setMsg({ type: 'error', text: `${e?.name} has no app login yet, so ${what} can't be recorded. Create the login from Employees first.` });

  const ACTIONS: { label: string; icon: React.ComponentType<{ className?: string }>; run: () => void; show?: boolean; group: string }[] = [
    { group: 'HR', label: 'New HR Action (promotion, increment…)', icon: ClipboardList, run: () => setModal({ kind: 'action' }) },
    { group: 'HR', label: 'Issue Letter', icon: FileText, run: () => setModal({ kind: 'letter' }) },
    { group: 'HR', label: 'Service Details (grade, probation)', icon: Pencil, run: () => setModal({ kind: 'service' }) },
    { group: 'HR', label: 'Other companies (also works for / transfer)', icon: Building2, run: () => setModal({ kind: 'companies' }) },
    { group: 'Records', label: 'Add Previous Experience', icon: Briefcase, run: () => setModal({ kind: 'record', record: 'experience', row: null }) },
    { group: 'Records', label: 'Add Education', icon: GraduationCap, run: () => setModal({ kind: 'record', record: 'education', row: null }) },
    { group: 'Records', label: 'Add Training', icon: BookOpen, run: () => setModal({ kind: 'record', record: 'training', row: null }) },
    { group: 'Records', label: 'Add Family / Nominee', icon: Users, run: () => setModal({ kind: 'record', record: 'family', row: null }) },
    {
      group: 'Other modules',
      label: 'Upload Document',
      icon: FolderOpen,
      show: !!perms?.document_vault,
      run: () => (e?.user_id ? setModal({ kind: 'document', missing: [] }) : needsLogin('a document'))
    },
    { group: 'Other modules', label: 'Give Loan / Advance', icon: HandCoins, show: !!perms?.payroll, run: () => setModal({ kind: 'loan' }) },
    {
      group: 'Other modules',
      label: 'Disciplinary Action',
      icon: ShieldCheck,
      show: !!perms?.grievance_disciplinary,
      run: () => (e?.user_id ? setModal({ kind: 'discipline' }) : needsLogin('a disciplinary action'))
    },
    {
      group: 'Other modules',
      label: 'Edit Personal Info (Employees)',
      icon: ExternalLink,
      show: !!perms?.employees,
      run: () => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'employees' }))
    }
  ];
  const visibleActions = ACTIONS.filter((a) => a.show !== false);

  return (
    <SelfBook.Provider value={self}>
    <div className="space-y-4">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      {!self && (
        <div className="max-w-md">
          <label className={labelCls}>Employee</label>
          <EmployeePicker employees={employees} value={employeeId} onChange={onPick} includeInactive />
        </div>
      )}

      {!employeeId ? (
        <div className="text-center py-16 text-sm text-slate-400">
          <BookOpen className="w-9 h-9 mx-auto mb-2 text-slate-300" />
          Pick an employee to see everything about them — service history, experience, documents, attendance, leave, claims, salary and loans.
        </div>
      ) : loading && !ov ? (
        <Loading />
      ) : !ov || !e || !s ? null : (
        <>
          {/* Header */}
          <div className="rounded-xl border border-slate-200 bg-gradient-to-r from-blue-50/60 to-white p-4">
            <div className="flex flex-wrap items-start gap-4">
              <div className="w-14 h-14 rounded-full bg-blue-600 text-white flex items-center justify-center text-lg font-bold shrink-0">{initials(e.name)}</div>
              <div className="flex-1 min-w-[200px]">
                <div className="flex flex-wrap items-center gap-2">
                  <h2 className="text-base font-bold text-slate-900">{e.name}</h2>
                  <Badge tone={e.service_status === 'separated' ? 'rejected' : e.service_status === 'confirmed' ? 'approved' : 'pending'}>
                    {SERVICE_STATUS_LABEL[e.service_status] || e.service_status}
                  </Badge>
                  {e.grade && <Badge tone="na">Grade {e.grade}</Badge>}
                </div>
                <div className="text-xs text-slate-600 mt-0.5">{[e.employee_code, e.designation, e.department].filter(Boolean).join(' · ')}</div>
                <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 mt-3">
                  <Field label="Joined" value={fmtDate(e.joining_date)} />
                  <Field label="Service" value={serviceLength(s.service_months)} />
                  <Field label="Total experience" value={serviceLength(s.total_experience_months)} />
                  <Field label="Supervisor" value={e.supervisor} />
                  <Field label="Branch / Project" value={[e.branch, e.project].filter(Boolean).join(' / ')} />
                  <Field label="Education" value={s.highest_education} />
                </div>
              </div>
              {!self && (
              <div className="flex flex-wrap gap-2">
                <div className="relative" ref={menuRef}>
                  <button type="button" className={btnPrimary} onClick={() => setMenuOpen((o) => !o)}>
                    <Plus className="w-3.5 h-3.5" /> Actions <ChevronDown className="w-3.5 h-3.5" />
                  </button>
                  {menuOpen && (
                    <div className="absolute right-0 z-30 mt-1 w-72 max-w-[calc(100vw-2rem)] bg-white border border-slate-200 rounded-xl shadow-lg py-1">
                      {Array.from(new Set(visibleActions.map((a) => a.group))).map((g) => (
                        <div key={g}>
                          <div className="px-3 pt-2 pb-1 text-[10px] font-bold uppercase tracking-wide text-slate-400">{g}</div>
                          {visibleActions
                            .filter((a) => a.group === g)
                            .map((a) => (
                              <button
                                key={a.label}
                                type="button"
                                onClick={() => {
                                  setMenuOpen(false);
                                  a.run();
                                }}
                                className="w-full flex items-center gap-2 px-3 py-2 text-xs text-slate-700 hover:bg-slate-50 text-left"
                              >
                                <a.icon className="w-3.5 h-3.5 text-slate-400" /> {a.label}
                              </button>
                            ))}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                <button type="button" className={btnGhost} onClick={() => setModal({ kind: 'dossier' })}>
                  <FileDown className="w-3.5 h-3.5" /> Dossier
                </button>
              </div>
              )}
            </div>
          </div>

          {/* Summary tiles */}
          <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-2">
            {perms?.payroll && <Tile label="Gross salary" value={taka(s.gross_salary)} sub="per month" onClick={() => setTab('salary')} />}
            {perms?.payroll && (
              <Tile
                label="Loan outstanding"
                value={taka(s.loan_outstanding)}
                sub={s.active_loans ? `${s.active_loans} active` : 'none active'}
                tone={s.loan_outstanding ? 'border-amber-200 bg-amber-50/50' : undefined}
                onClick={() => setTab('loans')}
              />
            )}
            <Tile label={`Attendance · ${monthLabel(s.attendance_month)}`} value={s.attendance_percent != null ? `${s.attendance_percent}%` : '—'} sub={`${s.absent_this_month} absent · ${s.late_this_month} late`} onClick={() => setTab('attendance')} />
            <Tile label={`Leave · ${thisYear}`} value={`${s.leave_taken} taken`} sub={`${s.leave_remaining} days left`} onClick={() => setTab('leave')} />
            <Tile
              label="Claims pending"
              value={s.claims_pending_count ? taka(s.claims_pending_amount) : 'None'}
              sub={`${taka(s.claims_approved_year)} approved this year`}
              tone={s.claims_pending_count ? 'border-amber-200 bg-amber-50/50' : undefined}
              onClick={() => setTab('claims')}
            />
            <Tile
              label="Documents"
              value={`${s.documents} on file`}
              sub={s.documents_missing ? `${s.documents_missing} missing${s.documents_expired ? ` · ${s.documents_expired} expired` : ''}` : s.documents_expired ? `${s.documents_expired} expired` : 'complete'}
              tone={s.documents_missing || s.documents_expired ? 'border-rose-200 bg-rose-50/50' : undefined}
              onClick={() => setTab('documents')}
            />
            <Tile label="Previous experience" value={serviceLength(s.prior_experience_months)} sub="before joining" onClick={() => setTab('career')} />
            <Tile label="Assets held" value={s.assets_held} sub={`${s.nominees} nominee · ${s.emergency_contacts} emergency`} onClick={() => setTab('other')} />
          </div>

          {/* Tabs */}
          <div className="flex gap-1 overflow-x-auto border-b border-slate-200 -mx-1 px-1">
            {TABS.filter((t) => !t.payroll || perms?.payroll).map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setTab(t.key)}
                className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-2 border-b-2 whitespace-nowrap -mb-px ${
                  tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'
                }`}
              >
                <t.icon className="w-3.5 h-3.5" /> {t.label}
              </button>
            ))}
          </div>

          {tab === 'overview' && <OverviewTab ov={ov} emp={emp} onEditService={() => setModal({ kind: 'service' })} />}
          {tab === 'personal' && (
            <PersonalTab api={api} ov={ov} reloadKey={reloadKey} onEdit={(row) => setModal({ kind: 'record', record: 'family', row })} onChanged={() => refresh('Saved.')} />
          )}
          {tab === 'career' && (
            <CareerTab api={api} token={token} ov={ov} reloadKey={reloadKey} onEdit={(record, row) => setModal({ kind: 'record', record, row })} onChanged={(t) => refresh(t)} />
          )}
          {tab === 'documents' && (
            <DocumentsTab
              api={api}
              token={token}
              ov={ov}
              reloadKey={reloadKey}
              onUpload={(missing) => (perms?.document_vault ? (e.user_id ? setModal({ kind: 'document', missing }) : needsLogin('a document')) : setMsg({ type: 'error', text: 'Uploading needs the Document Vault module.' }))}
            />
          )}
          {tab === 'attendance' && <AttendanceTab api={api} ov={ov} reloadKey={reloadKey} />}
          {tab === 'leave' && <LeaveTab api={api} ov={ov} reloadKey={reloadKey} />}
          {tab === 'claims' && <ClaimsTab api={api} ov={ov} reloadKey={reloadKey} />}
          {tab === 'salary' && perms?.payroll && <SalaryTab api={api} ov={ov} reloadKey={reloadKey} onNewAction={() => setModal({ kind: 'action' })} />}
          {tab === 'loans' && perms?.payroll && <LoansTab api={api} ov={ov} reloadKey={reloadKey} onNew={() => setModal({ kind: 'loan' })} />}
          {tab === 'discipline' && <DisciplineTab api={api} ov={ov} reloadKey={reloadKey} />}
          {tab === 'other' && <OtherTab api={api} ov={ov} reloadKey={reloadKey} />}
        </>
      )}

      {modal?.kind === 'action' && (
        <NewActionModal
          token={token}
          meta={meta}
          employees={employees}
          initialEmployeeId={employeeId}
          onClose={() => setModal(null)}
          onSaved={(st) => {
            onChanged();
            refresh(st === 'approved' ? 'Saved and approved.' : 'Submitted for approval.');
          }}
        />
      )}
      {modal?.kind === 'transfer' && (
        <NewActionModal
          token={token}
          meta={meta}
          employees={employees}
          initialEmployeeId={employeeId}
          initialType="company_transfer"
          onClose={() => setModal(null)}
          onSaved={(st) => {
            onChanged();
            refresh(st === 'approved' ? 'Transfer approved.' : 'Transfer submitted for approval.');
          }}
        />
      )}
      {modal?.kind === 'companies' && employeeId && (
        <CompanyAssignmentsModal
          token={token}
          employeeId={employeeId}
          employeeName={emp?.name || 'This employee'}
          onClose={() => setModal(null)}
          onTransfer={() => setModal({ kind: 'transfer' })}
        />
      )}
      {modal?.kind === 'letter' && (
        <LetterComposer
          token={token}
          meta={meta}
          employees={employees}
          init={{ employee_id: employeeId }}
          onClose={() => setModal(null)}
          onIssued={(ref) => refresh(`Letter ${ref} issued.`)}
        />
      )}
      {modal?.kind === 'service' && emp && (
        <ServiceDetailsModal
          token={token}
          emp={emp}
          onClose={() => setModal(null)}
          onSaved={() => {
            onChanged();
            refresh('Service details saved.');
          }}
        />
      )}
      {modal?.kind === 'record' && employeeId && (
        <RecordModal token={token} employeeId={employeeId} kind={modal.record} record={modal.row} onClose={() => setModal(null)} onSaved={() => refresh(`${RECORD_FIELDS[modal.record].title} saved.`)} />
      )}
      {modal?.kind === 'document' && e?.user_id && (
        <UploadDocumentModal token={token} userId={e.user_id} missing={modal.missing} onClose={() => setModal(null)} onSaved={() => refresh('Document uploaded.')} />
      )}
      {modal?.kind === 'loan' && employeeId && <LoanModal token={token} employeeId={employeeId} onClose={() => setModal(null)} onSaved={() => refresh('Loan / advance saved.')} />}
      {modal?.kind === 'discipline' && e?.user_id && <DisciplineModal token={token} userId={e.user_id} onClose={() => setModal(null)} onSaved={() => refresh('Disciplinary action issued.')} />}
      {modal?.kind === 'dossier' && ov && <DossierModal token={token} overview={ov} onClose={() => setModal(null)} />}
    </div>
    </SelfBook.Provider>
  );
};

// ---------------------------------------------------------------------------
// Tabs
// ---------------------------------------------------------------------------

type Api = ReturnType<typeof useHrApi>;

const OverviewTab: React.FC<{ ov: P360Overview; emp: HrOpsEmployee | null; onEditService: () => void }> = ({ ov, emp, onEditService }) => {
  const self = useContext(SelfBook);
  const e = ov.employee;
  return (
    <div className="grid lg:grid-cols-[300px_1fr] gap-4">
      <Card
        title="Service details"
        action={
          self ? undefined : (
            <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={onEditService}>
              <Pencil className="w-3 h-3" /> Edit
            </button>
          )
        }
      >
        <div className="grid grid-cols-2 gap-3">
          <Field label="Job base" value={e.job_base} />
          <Field label="Grade" value={e.grade} />
          <Field label="Probation" value={e.probation_months != null ? `${e.probation_months} months` : null} />
          <Field label="Probation until" value={fmtDate(e.probation_end_date || emp?.probation_end_date)} />
          <Field label="Confirmed" value={fmtDate(e.confirmation_date)} />
          <Field label="Contract until" value={fmtDate(e.contract_end_date)} />
          <Field label="Category" value={ov.profile.employment_category} />
          <Field label="Job status" value={ov.profile.job_status} />
          <Field label="Division / Unit" value={[ov.profile.division, ov.profile.unit].filter(Boolean).join(' / ')} />
          <Field label="Review month" value={ov.profile.review_month} />
        </div>
      </Card>
      <Card
        title="Service history (latest first)"
        action={
          <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={() => saveServiceBookPdf({ employee: ov.employee, events: ov.events })}>
            <FileDown className="w-3 h-3" /> PDF
          </button>
        }
      >
        <ServiceTimeline events={ov.events} />
      </Card>
    </div>
  );
};

const PersonalTab: React.FC<{ api: Api; ov: P360Overview; reloadKey: number; onEdit: (row: any | null) => void; onChanged: () => void }> = ({ api, ov, reloadKey, onEdit, onChanged }) => {
  const self = useContext(SelfBook);
  const { data, loading } = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/records`, reloadKey);
  const p = ov.profile;
  const del = async (id: number) => {
    if (!(await confirmDialog('Delete this family member?'))) return;
    await api.del(`/api/hr-ops/p360/records/family/${id}`);
    onChanged();
  };
  const nomineeTotal = (data?.family || []).filter((f: any) => f.is_nominee).reduce((t: number, f: any) => t + Number(f.nominee_percent || 0), 0);
  return (
    <div className="grid lg:grid-cols-2 gap-4">
      <Card title="Personal information">
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <Field label="Date of birth" value={p.date_of_birth ? `${fmtDate(p.date_of_birth)}${p.age_years != null ? ` (${p.age_years})` : ''}` : null} />
          <Field label="Gender" value={p.gender} />
          <Field label="Blood group" value={p.blood_group} />
          <Field label="Marital status" value={p.marital_status} />
          <Field label="Religion" value={p.religion} />
          <Field label="Nationality" value={p.nationality} />
          <Field label="NID" value={p.nid} />
          <Field label="Mobile" value={p.phone} />
          <Field label="Office email" value={p.email} />
          <Field label="Personal email" value={p.personal_email} />
          <Field label="Device PIN" value={p.zk_device_pin} />
          <Field label="Login" value={ov.employee.user_id ? 'Yes' : 'No login'} />
        </div>
        <div className="grid sm:grid-cols-2 gap-3 mt-3">
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Present address</div>
            <div className="text-xs text-slate-800">{p.present_address || '—'}</div>
          </div>
          <div>
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Permanent address</div>
            <div className="text-xs text-slate-800">{p.permanent_address || '—'}</div>
          </div>
        </div>
      </Card>
      <Card
        title="Family, nominee & emergency contact"
        action={
          self ? undefined : (
            <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={() => onEdit(null)}>
              <Plus className="w-3 h-3" /> Add
            </button>
          )
        }
      >
        {loading && !data ? (
          <Loading />
        ) : !data?.family.length ? (
          <Empty>No family members, nominees or emergency contacts recorded.</Empty>
        ) : (
          <div className="space-y-2">
            {nomineeTotal > 0 && nomineeTotal !== 100 && <p className="text-[11px] text-amber-700">Nominee shares add up to {nomineeTotal}% (should be 100%).</p>}
            {data.family.map((f: any) => (
              <div key={f.id} className="flex items-start justify-between gap-2 rounded-lg border border-slate-100 p-2.5">
                <div className="min-w-0">
                  <div className="text-xs font-semibold text-slate-800">
                    {f.name} <span className="font-normal text-slate-500">{f.relation && `· ${f.relation}`}</span>
                  </div>
                  <div className="text-[11px] text-slate-500">{[f.phone, f.occupation, f.date_of_birth && fmtDate(f.date_of_birth)].filter(Boolean).join(' · ') || '—'}</div>
                  <div className="flex flex-wrap gap-1 mt-1">
                    {f.is_nominee && <Badge tone="approved">Nominee{f.nominee_percent != null ? ` ${f.nominee_percent}%` : ''}</Badge>}
                    {f.is_emergency && <Badge tone="rejected">Emergency contact</Badge>}
                    {f.is_dependent && <Badge tone="na">Dependent</Badge>}
                  </div>
                </div>
                <div className={self ? 'hidden' : 'flex gap-1 shrink-0'}>
                  <button type="button" className="p-1 text-slate-400 hover:text-blue-600" onClick={() => onEdit(f)} aria-label="Edit">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" className="p-1 text-slate-400 hover:text-rose-600" onClick={() => del(f.id)} aria-label="Delete">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

const CareerTab: React.FC<{ api: Api; token: string; ov: P360Overview; reloadKey: number; onEdit: (k: RecordKind, row: any | null) => void; onChanged: (text: string) => void }> = ({
  api,
  token,
  ov,
  reloadKey,
  onEdit,
  onChanged
}) => {
  const self = useContext(SelfBook);
  const { data, loading } = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/records`, reloadKey);
  const del = async (kind: RecordKind, id: number) => {
    if (!(await confirmDialog('Delete this record?'))) return;
    await api.del(`/api/hr-ops/p360/records/${kind}/${id}`);
    onChanged('Deleted.');
  };
  const verify = async (kind: RecordKind, row: any) => {
    const note = row.verified ? '' : window.prompt('Verification note (optional) — e.g. "Called previous HR, confirmed"') ?? null;
    if (note === null) return;
    await api.post(`/api/hr-ops/p360/records/${kind}/${row.id}/verify`, { verified: !row.verified, verify_note: note });
    onChanged(row.verified ? 'Marked as not verified.' : 'Marked as verified.');
  };
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const rowTools = (kind: RecordKind, r: any) => (
    <div className="flex items-center gap-1 shrink-0">
      {r.has_file && (
        <button type="button" className="p-1 text-slate-400 hover:text-blue-600" title={r.file_name} onClick={() => openFile(token, p360Path(self, `/api/hr-ops/p360/records/${kind}/${r.id}/file`))}>
          <Paperclip className="w-3.5 h-3.5" />
        </button>
      )}
      {self && r.verified && (
        <span className="p-1 text-emerald-600" title="Verified by HR">
          <CheckCircle2 className="w-3.5 h-3.5" />
        </span>
      )}
      {!self && RECORD_FIELDS[kind].hasVerify && (
        <button type="button" className={`p-1 ${r.verified ? 'text-emerald-600' : 'text-slate-300 hover:text-emerald-600'}`} title={r.verified ? `Verified by ${r.verified_by_name || '—'}${r.verify_note ? ` — ${r.verify_note}` : ''}` : 'Mark verified'} onClick={() => verify(kind, r)}>
          <CheckCircle2 className="w-3.5 h-3.5" />
        </button>
      )}
      {!self && (
        <>
          <button type="button" className="p-1 text-slate-400 hover:text-blue-600" onClick={() => onEdit(kind, r)} aria-label="Edit">
            <Pencil className="w-3.5 h-3.5" />
          </button>
          <button type="button" className="p-1 text-slate-400 hover:text-rose-600" onClick={() => del(kind, r.id)} aria-label="Delete">
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </>
      )}
    </div>
  );
  const addBtn = (kind: RecordKind) => self ? undefined : (
    <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={() => onEdit(kind, null)}>
      <Plus className="w-3 h-3" /> Add
    </button>
  );
  const period = (a: string | null, b: string | null) => `${fmtDate(a)} – ${b ? fmtDate(b) : 'present'}`;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-3 gap-2 max-w-xl">
        <Tile label="Previous experience" value={serviceLength(data.prior_experience_months)} />
        <Tile label="In this company" value={serviceLength(ov.summary.service_months)} />
        <Tile label="Total" value={serviceLength(ov.summary.total_experience_months)} />
      </div>
      <Card title={`Previous experience (${data.experience.length})`} action={addBtn('experience')}>
        {data.experience.length === 0 ? (
          <Empty>No previous employer recorded.</Empty>
        ) : (
          <ol className="relative border-l-2 border-slate-100 ml-2 space-y-3">
            {data.experience.map((x: any) => (
              <li key={x.id} className="ml-4">
                <span className="absolute -left-[7px] w-3 h-3 rounded-full bg-blue-200 ring-4 ring-white" />
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-slate-800">
                      {x.designation || '—'} <span className="font-normal text-slate-500">at</span> {x.company_name}
                      {x.verified && <Badge tone="approved">Verified</Badge>}
                    </div>
                    <div className="text-[11px] text-slate-500">
                      {period(x.from_date, x.to_date)}
                      {x.from_date && ` · ${serviceLength(monthsBetweenClient(x.from_date, x.to_date))}`}
                      {[x.department, x.location, x.company_business].filter(Boolean).length > 0 && ` · ${[x.department, x.location, x.company_business].filter(Boolean).join(' · ')}`}
                    </div>
                    {x.responsibilities && <p className="text-[11px] text-slate-600 mt-0.5 whitespace-pre-line">{x.responsibilities}</p>}
                    <div className="text-[11px] text-slate-500 mt-0.5">
                      {[x.last_salary != null && ov.permissions.payroll ? `Last salary ${taka(x.last_salary)}` : null, x.leaving_reason && `Left: ${x.leaving_reason}`, x.reference_name && `Ref: ${x.reference_name}${x.reference_contact ? ` (${x.reference_contact})` : ''}`]
                        .filter(Boolean)
                        .join(' · ')}
                    </div>
                  </div>
                  {rowTools('experience', x)}
                </div>
              </li>
            ))}
          </ol>
        )}
      </Card>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title={`Education (${data.education.length})`} action={addBtn('education')}>
          {data.education.length === 0 ? (
            <Empty>No education recorded.</Empty>
          ) : (
            <div className="space-y-2">
              {data.education.map((x: any) => (
                <div key={x.id} className="flex items-start justify-between gap-2 rounded-lg border border-slate-100 p-2.5">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-800">
                      {x.degree} {x.verified && <Badge tone="approved">Verified</Badge>}
                    </div>
                    <div className="text-[11px] text-slate-500">{[x.major, x.institute, x.board_university].filter(Boolean).join(' · ') || '—'}</div>
                    <div className="text-[11px] text-slate-500">{[x.passing_year && `Passed ${x.passing_year}`, x.result, x.level].filter(Boolean).join(' · ')}</div>
                  </div>
                  {rowTools('education', x)}
                </div>
              ))}
            </div>
          )}
        </Card>
        <Card title={`Training (${data.training.length})`} action={addBtn('training')}>
          {data.training.length === 0 ? (
            <Empty>No training recorded.</Empty>
          ) : (
            <div className="space-y-2">
              {data.training.map((x: any) => (
                <div key={x.id} className="flex items-start justify-between gap-2 rounded-lg border border-slate-100 p-2.5">
                  <div className="min-w-0">
                    <div className="text-xs font-semibold text-slate-800">
                      {x.title} {x.training_type && <Badge tone="na">{x.training_type}</Badge>}
                    </div>
                    <div className="text-[11px] text-slate-500">{[x.organizer, x.location].filter(Boolean).join(' · ') || '—'}</div>
                    <div className="text-[11px] text-slate-500">{[x.from_date && period(x.from_date, x.to_date || x.from_date), x.hours != null && `${x.hours} hrs`, x.result].filter(Boolean).join(' · ')}</div>
                  </div>
                  {rowTools('training', x)}
                </div>
              ))}
            </div>
          )}
        </Card>
      </div>
    </div>
  );
};

// Inclusive period length in whole months (same rule as the server's
// coveredMonths: 1 Jan – 31 Dec is 12 months).
const monthsBetweenClient = (from: string, to: string | null) => {
  const end = to ? new Date(`${to}T00:00:00`) : new Date();
  end.setDate(end.getDate() + 1);
  const [y1, m1, d1] = from.split('-').map(Number);
  return Math.max(0, (end.getFullYear() - y1) * 12 + (end.getMonth() + 1 - m1) - (end.getDate() < d1 ? 1 : 0));
};

const DocumentsTab: React.FC<{ api: Api; token: string; ov: P360Overview; reloadKey: number; onUpload: (missing: string[]) => void }> = ({ api, token, ov, reloadKey, onUpload }) => {
  const self = useContext(SelfBook);
  const { data, loading } = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/documents`, reloadKey);
  if (loading && !data) return <Loading />;
  if (!data) return null;
  return (
    <div className="space-y-4">
      {!data.linked && <Notice msg={{ type: 'error', text: 'This employee has no app login, so Document Vault files cannot be attached yet.' }} />}
      {data.missing.length > 0 && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3">
          <div className="text-xs font-bold text-rose-800 mb-1.5">Missing documents</div>
          <div className="flex flex-wrap gap-1.5">
            {data.missing.map((m: string) => (
              <button key={m} type="button" disabled={self} onClick={() => onUpload([m])} className="text-[11px] px-2 py-1 rounded-md bg-white border border-rose-200 text-rose-700 hover:bg-rose-100">
                <Plus className="w-3 h-3 inline" /> {m}
              </button>
            ))}
          </div>
          <p className="text-[10px] text-rose-700/80 mt-1.5">
            {self ? 'HR still needs these from you — hand them to HR or upload them where HR asks (Pending Items).' : 'The required list is set in Settings → Company & Letters.'}
          </p>
        </div>
      )}
      <Card
        title={`Documents on file (${data.documents.length})`}
        action={
          self ? undefined : (
            <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={() => onUpload(data.missing)}>
              <Plus className="w-3 h-3" /> Upload
            </button>
          )
        }
      >
        <Table
          head={['Type', 'File', 'Uploaded', 'Expiry', 'Signature', '']}
          empty="No documents uploaded yet."
          rows={data.documents.map((d: any) => [
            <span className="font-semibold">{d.doc_type}</span>,
            d.file_name,
            <span className="whitespace-nowrap">
              {fmtDate(d.uploaded_at)}
              {d.uploaded_by_name && <span className="text-slate-400"> · {d.uploaded_by_name}</span>}
            </span>,
            d.expiry_date ? d.expired ? <Badge tone="rejected">Expired {fmtDate(d.expiry_date)}</Badge> : fmtDate(d.expiry_date) : '—',
            d.requires_signature ? <Badge tone={d.is_signed ? 'approved' : 'pending'}>{d.is_signed ? 'Signed' : 'Awaiting'}</Badge> : '—',
            <button type="button" className="text-blue-600 font-semibold" onClick={() => openFile(token, p360Path(self, `/api/hr-ops/p360/documents/${d.id}/file`))}>
              Open
            </button>
          ])}
        />
      </Card>
    </div>
  );
};

const DAY_STYLE: Record<string, string> = {
  present: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  absent: 'bg-rose-50 border-rose-200 text-rose-700',
  leave: 'bg-sky-50 border-sky-200 text-sky-800',
  holiday: 'bg-violet-50 border-violet-200 text-violet-700',
  weekend: 'bg-slate-50 border-slate-200 text-slate-400',
  future: 'bg-white border-slate-100 text-slate-300',
  not_joined: 'bg-white border-slate-100 text-slate-300',
  separated: 'bg-white border-slate-100 text-slate-300'
};
const WEEKDAYS = ['Sat', 'Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri'];

const AttendanceTab: React.FC<{ api: Api; ov: P360Overview; reloadKey: number }> = ({ api, ov, reloadKey }) => {
  const [month, setMonth] = useState(thisMonth);
  const [view, setView] = useState<'calendar' | 'list'>('calendar');
  const { data, loading } = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/attendance?month=${month}`, reloadKey);
  const year = Number(month.slice(0, 4));
  const yearData = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/attendance_year?year=${year}`, reloadKey);
  const sm = data?.summary;
  // Saturday-first grid (Bangladesh work week).
  const lead = data?.days?.length ? (data.days[0].weekday + 1) % 7 : 0;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex items-center gap-1">
          <button type="button" className={btnGhost} onClick={() => setMonth(shiftMonth(month, -1))} aria-label="Previous month">
            <ChevronLeft className="w-3.5 h-3.5" />
          </button>
          <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className="text-xs px-2 py-1.5 border border-slate-200 rounded-lg" />
          <button type="button" className={btnGhost} onClick={() => setMonth(shiftMonth(month, 1))} aria-label="Next month">
            <ChevronRight className="w-3.5 h-3.5" />
          </button>
        </div>
        <div className="flex rounded-lg border border-slate-200 overflow-hidden text-xs">
          {(['calendar', 'list'] as const).map((v) => (
            <button key={v} type="button" onClick={() => setView(v)} className={`px-3 py-1.5 font-semibold ${view === v ? 'bg-blue-600 text-white' : 'bg-white text-slate-600'}`}>
              {v === 'calendar' ? 'Calendar' : 'List'}
            </button>
          ))}
        </div>
      </div>
      {loading && !data ? (
        <Loading />
      ) : !data ? null : (
        <>
          {!data.linked && <Notice msg={{ type: 'error', text: 'No login and no attendance device PIN — attendance cannot be recorded for this employee.' }} />}
          <div className="grid grid-cols-3 sm:grid-cols-7 gap-2">
            <Tile label="Working days" value={sm.working_days} />
            <Tile label="Present" value={sm.present} tone="border-emerald-200 bg-emerald-50/40" />
            <Tile label="Leave" value={sm.leave} tone="border-sky-200 bg-sky-50/40" />
            <Tile label="Absent" value={sm.absent} tone={sm.absent ? 'border-rose-200 bg-rose-50/40' : undefined} />
            <Tile label="Late" value={sm.late} tone={sm.late ? 'border-amber-200 bg-amber-50/40' : undefined} />
            <Tile label="Extreme late" value={sm.extreme_late} tone={sm.extreme_late ? 'border-amber-200 bg-amber-50/40' : undefined} />
            <Tile label="Attendance" value={sm.attendance_percent != null ? `${sm.attendance_percent}%` : '—'} />
          </div>
          {view === 'calendar' ? (
            <div className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="grid grid-cols-7 gap-1 text-[10px] font-semibold text-slate-400 text-center mb-1">
                {WEEKDAYS.map((w) => (
                  <div key={w}>{w}</div>
                ))}
              </div>
              <div className="grid grid-cols-7 gap-1">
                {Array.from({ length: lead }).map((_, i) => (
                  <div key={`x${i}`} />
                ))}
                {data.days.map((d: any) => (
                  <div key={d.date} className={`rounded-lg border p-1 sm:p-1.5 min-h-[52px] sm:min-h-[64px] ${DAY_STYLE[d.status]}`} title={[d.holiday, d.leave_type, d.source, d.correction && `Correction ${d.correction}`].filter(Boolean).join(' · ')}>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-bold">{Number(d.date.slice(8))}</span>
                      {d.late && !d.waived && <span className={`w-1.5 h-1.5 rounded-full ${d.late === 'extreme' ? 'bg-rose-500' : 'bg-amber-500'}`} />}
                    </div>
                    <div className="text-[9px] sm:text-[10px] leading-tight mt-0.5 truncate">
                      {d.status === 'present' ? (
                        <>
                          {d.in}
                          {d.out ? `–${d.out}` : ''}
                        </>
                      ) : d.status === 'leave' ? (
                        d.leave_type
                      ) : d.status === 'holiday' || d.status === 'weekend' ? (
                        d.holiday
                      ) : d.status === 'absent' ? (
                        'Absent'
                      ) : (
                        ''
                      )}
                    </div>
                  </div>
                ))}
              </div>
              <div className="flex flex-wrap gap-3 mt-3 text-[10px] text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-amber-500" /> Late
                </span>
                <span className="inline-flex items-center gap-1">
                  <span className="w-2 h-2 rounded-full bg-rose-500" /> Extreme late
                </span>
                <span>Late is counted with the Payroll late policy; waived days are not marked.</span>
              </div>
            </div>
          ) : (
            <Card title={`Day by day · ${monthLabel(month)}`}>
              <Table
                head={['Date', 'Status', 'In', 'Out', 'Late', 'Source', 'Note']}
                rows={data.days
                  .filter((d: any) => !['future', 'not_joined', 'separated'].includes(d.status))
                  .map((d: any) => [
                    <span className="whitespace-nowrap">
                      {fmtDate(d.date)} <span className="text-slate-400">{WEEKDAYS[(d.weekday + 1) % 7]}</span>
                    </span>,
                    <span className="capitalize">{d.status}</span>,
                    d.in || '—',
                    d.out || '—',
                    d.late ? (d.waived ? 'Waived' : d.late === 'extreme' ? 'Extreme' : 'Late') : '',
                    d.source || '',
                    [d.holiday, d.leave_type, d.correction && `Correction ${d.correction}`].filter(Boolean).join(' · ')
                  ])}
              />
            </Card>
          )}
          <Card title={`Month by month · ${year}`}>
            {yearData.loading && !yearData.data ? (
              <Loading />
            ) : (
              <Table
                head={['Month', 'Working', 'Present', 'Leave', 'Absent', 'Late', 'Extreme', 'Attendance']}
                rows={(yearData.data?.months || []).map((m: any) => [
                  <button type="button" className="text-blue-600 font-semibold" onClick={() => setMonth(m.month)}>
                    {monthLabel(m.month)}
                  </button>,
                  m.working_days,
                  m.present,
                  m.leave,
                  m.absent,
                  m.late,
                  m.extreme_late,
                  m.attendance_percent != null ? `${m.attendance_percent}%` : '—'
                ])}
              />
            )}
          </Card>
        </>
      )}
    </div>
  );
};

const LeaveTab: React.FC<{ api: Api; ov: P360Overview; reloadKey: number }> = ({ api, ov, reloadKey }) => {
  const [year, setYear] = useState(thisYear);
  const { data, loading } = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/leave?year=${year}`, reloadKey);
  if (loading && !data) return <Loading />;
  if (!data) return null;
  if (!data.linked) return <Empty>This employee has no app login, so no leave has been recorded.</Empty>;
  const apps = data.applications.filter((a: any) => (a.start_date || '').startsWith(String(year)));
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between">
        <div className="text-xs text-slate-500">Balance is what is left now; taken/pending are for {year}.</div>
        <YearSelect value={year} onChange={setYear} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-2">
        {data.balances.map((b: any) => (
          <div key={b.key} className="rounded-xl border border-slate-200 bg-white p-3">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{b.label}</div>
            <div className="text-lg font-bold text-slate-800">{b.balance}</div>
            <div className="text-[10px] text-slate-500">
              {b.taken} taken{b.pending ? ` · ${b.pending} pending` : ''}
            </div>
          </div>
        ))}
      </div>
      <Card title={`Applications · ${year} (${apps.length})`}>
        <Table
          head={['Type', 'From', 'To', 'Days', 'Status', 'Purpose', 'Decided by']}
          empty="No leave in this year."
          rows={apps.map((a: any) => [
            a.leave_label,
            fmtDate(a.start_date),
            fmtDate(a.end_date),
            a.day_count,
            <Badge tone={statusTone(a.status)}>{a.status}</Badge>,
            a.purpose || '—',
            a.decided_by || '—'
          ])}
        />
      </Card>
    </div>
  );
};

const ClaimsTab: React.FC<{ api: Api; ov: P360Overview; reloadKey: number }> = ({ api, ov, reloadKey }) => {
  const [year, setYear] = useState(thisYear);
  const { data, loading } = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/claims?year=${year}`, reloadKey);
  if (loading && !data) return <Loading />;
  if (!data) return null;
  if (!data.linked) return <Empty>This employee has no app login, so no claims have been recorded.</Empty>;
  const t = data.totals;
  return (
    <div className="space-y-4">
      <div className="flex justify-end">
        <YearSelect value={year} onChange={setYear} />
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-2">
        <Tile label="Claimed" value={taka(t.claimed)} />
        <Tile label="Approved" value={taka(t.approved)} tone="border-emerald-200 bg-emerald-50/40" />
        <Tile label="Pending" value={taka(t.pending)} sub={`${t.pending_count} claim(s)`} tone={t.pending_count ? 'border-amber-200 bg-amber-50/40' : undefined} />
        <Tile label="On bills" value={taka(t.billed)} />
        <Tile label="Paid out" value={taka(t.disbursed)} />
        <Tile label="Movement" value={`${Math.round(t.distance_km * 10) / 10} km`} sub={`${data.movements.length} trip(s)`} />
      </div>
      <Card title="Month by month">
        <Table
          head={['Month', 'Claimed', 'Approved', 'Billed', 'Paid']}
          empty="Nothing claimed in this year."
          rows={data.monthly.map((m: any) => [monthLabel(m.month), taka(m.claimed), taka(m.approved), taka(m.billed), taka(m.paid)])}
        />
      </Card>
      <Card title={`Conveyance claims (${data.claims.length})`}>
        <Table
          head={['Date', 'Category', 'Claimed', 'Approved', 'Status', 'Description']}
          rows={data.claims.map((c: any) => [
            <span className="whitespace-nowrap">{fmtDate(c.claim_date)}</span>,
            c.category,
            taka(c.amount),
            c.status === 'approved' ? taka(c.approved_amount ?? c.amount) : '—',
            <Badge tone={statusTone(c.status)}>{c.status}</Badge>,
            [c.description, c.admin_remarks].filter(Boolean).join(' — ') || '—'
          ])}
        />
      </Card>
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title={`Conveyance bills (${data.bills.length})`}>
          <Table
            head={['Date', 'Items', 'Amount', 'Paid', 'Voucher']}
            rows={data.bills.map((b: any) => [fmtDate(b.bill_date), b.items, taka(b.amount), b.is_disbursed ? <Badge tone="approved">Paid</Badge> : <Badge tone="pending">Unpaid</Badge>, b.voucher_no || '—'])}
          />
        </Card>
        <Card title={`Movement (check-in / out) trips (${data.movements.length})`}>
          <Table head={['Date', 'Purpose', 'Distance', 'Status']} rows={data.movements.map((m: any) => [fmtDate(m.date), m.purpose, m.distance_km != null ? `${m.distance_km} km` : '—', m.status])} />
        </Card>
      </div>
    </div>
  );
};

const SalaryTab: React.FC<{ api: Api; ov: P360Overview; reloadKey: number; onNewAction: () => void }> = ({ api, ov, reloadKey, onNewAction }) => {
  const self = useContext(SelfBook);
  const { data, loading, error } = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/salary`, reloadKey);
  if (error) return <Notice msg={{ type: 'error', text: error }} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  const cur = data.structures[0];
  return (
    <div className="space-y-4">
      <div className="grid lg:grid-cols-[320px_1fr] gap-4">
        <Card
          title="Current salary structure"
          action={
            self ? undefined : (
              <button type="button" className="text-[11px] font-semibold text-blue-600" onClick={onNewAction}>
                Revise
              </button>
            )
          }
        >
          {!cur ? (
            <Empty>No salary set in Payroll.</Empty>
          ) : (
            <div className="space-y-1.5 text-xs">
              {[
                ['Basic', cur.basic_salary],
                ['House rent', cur.house_rent],
                ['Medical', cur.medical_allowance],
                ['Conveyance', cur.conveyance_allowance],
                ['Other', cur.other_allowance]
              ].map(([l, v]) => (
                <div key={l as string} className="flex justify-between">
                  <span className="text-slate-500">{l}</span>
                  <span className="font-medium">{taka(v as number)}</span>
                </div>
              ))}
              <div className="flex justify-between border-t border-slate-100 pt-1.5 font-bold">
                <span>Gross</span>
                <span>{taka(cur.gross_salary)}</span>
              </div>
              {(cur.tax_deduction > 0 || cur.pf_deduction > 0) && (
                <div className="text-[11px] text-slate-500">
                  Tax {taka(cur.tax_deduction)} · PF {taka(cur.pf_deduction)}
                </div>
              )}
              <div className="text-[11px] text-slate-400">Effective {fmtDate(cur.effective_date)}</div>
            </div>
          )}
        </Card>
        <Card title="Salary revisions">
          <Table
            head={['Effective', 'Basic', 'Gross', 'Change']}
            rows={data.structures.map((r: any) => [
              fmtDate(r.effective_date),
              taka(r.basic_salary),
              <span className="font-semibold">{taka(r.gross_salary)}</span>,
              r.change != null ? (
                <span className={r.change >= 0 ? 'text-emerald-700' : 'text-rose-700'}>
                  {r.change >= 0 ? '+' : ''}
                  {taka(r.change)} ({r.change_percent ?? 0}%)
                </span>
              ) : (
                <span className="text-slate-400">Starting salary</span>
              )
            ])}
          />
        </Card>
      </div>
      {data.yearly.length > 0 && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          {data.yearly.slice(0, 4).map((y: any) => (
            <Tile key={y.year} label={`Earned in ${y.year}`} value={taka(y.net)} sub={`${y.months} payslip(s) · gross ${taka(y.gross)}${y.bonus ? ` · bonus ${taka(y.bonus)}` : ''}`} />
          ))}
        </div>
      )}
      <Card title={`Payslips (${data.payrolls.length})`}>
        <Table
          head={['Month', 'Present', 'Absent', 'Leave', 'Gross earned', 'Bonus', 'Deductions', 'Net', 'Status']}
          empty="No payroll has been run for this employee yet."
          rows={data.payrolls.map((p: any) => [
            monthLabel(p.month_year),
            p.present_days,
            p.absent_days,
            p.leave_days,
            taka(p.gross_earned),
            p.bonus_amount ? taka(p.bonus_amount) : '—',
            taka(p.total_deduction),
            <span className="font-semibold">{taka(p.net_salary)}</span>,
            <Badge tone={statusTone(p.payment_status)}>{p.payment_status}</Badge>
          ])}
        />
      </Card>
      {data.bonuses.length > 0 && (
        <Card title="Bonuses">
          <Table head={['Month', 'Amount', 'Reason']} rows={data.bonuses.map((b: any) => [monthLabel(b.month_year), taka(b.amount), b.reason || '—'])} />
        </Card>
      )}
    </div>
  );
};

const LoansTab: React.FC<{ api: Api; ov: P360Overview; reloadKey: number; onNew: () => void }> = ({ api, ov, reloadKey, onNew }) => {
  const self = useContext(SelfBook);
  const { data, loading, error } = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/loans`, reloadKey);
  if (error) return <Notice msg={{ type: 'error', text: error }} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="text-sm">
          Outstanding: <span className="font-bold">{taka(data.outstanding)}</span>
        </div>
        {!self && (
          <button type="button" className={btnPrimary} onClick={onNew}>
            <Landmark className="w-3.5 h-3.5" /> Give Loan / Advance
          </button>
        )}
      </div>
      {data.loans.length === 0 ? (
        <Empty>No loan or salary advance.</Empty>
      ) : (
        <div className="grid md:grid-cols-2 gap-3">
          {data.loans.map((l: any) => {
            const pct = l.total_amount ? Math.min(100, Math.round((l.paid_amount / l.total_amount) * 100)) : 0;
            return (
              <div key={l.id} className="rounded-xl border border-slate-200 bg-white p-3">
                <div className="flex items-center justify-between">
                  <div className="text-sm font-bold text-slate-800">{taka(l.total_amount)}</div>
                  <Badge tone={l.status === 'active' ? 'pending' : 'approved'}>{l.status === 'active' ? 'Running' : 'Completed'}</Badge>
                </div>
                <div className="text-[11px] text-slate-500">
                  Given {fmtDate(l.created_at)}
                  {l.reason && ` · ${l.reason}`}
                </div>
                <div className="h-2 rounded-full bg-slate-100 mt-2 overflow-hidden">
                  <div className="h-full bg-emerald-500" style={{ width: `${pct}%` }} />
                </div>
                <div className="flex justify-between text-[11px] text-slate-600 mt-1">
                  <span>
                    Recovered {taka(l.paid_amount)} ({pct}%)
                  </span>
                  <span>Left {taka(l.remaining)}</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {taka(l.monthly_installment)} / month{l.status === 'active' && l.installments_left != null ? ` · ${l.installments_left} installment(s) left` : ''}
                </div>
              </div>
            );
          })}
        </div>
      )}
      <div className="grid lg:grid-cols-2 gap-4">
        <Card title="Recovered through payroll">
          <Table head={['Month', 'Deducted', 'Payslip']} empty="No deductions yet." rows={data.deductions.map((d: any) => [monthLabel(d.month_year), taka(d.amount), d.payment_status])} />
        </Card>
        <Card title="Employee's advance requests">
          <Table
            head={['Date', 'Amount', 'Installment', 'Status', 'Remarks']}
            empty="No requests."
            rows={data.requests.map((r: any) => [fmtDate(r.created_at), taka(r.total_amount), taka(r.monthly_installment), <Badge tone={statusTone(r.status)}>{r.status}</Badge>, r.decision_remarks || r.reason || '—'])}
          />
        </Card>
      </div>
    </div>
  );
};

// Every disciplinary action issued to the employee, newest first, with the
// letter text, acknowledgement and the feedback thread (the employee's
// explanation and HR's notes).
const DisciplineTab: React.FC<{ api: Api; ov: P360Overview; reloadKey: number }> = ({ api, ov, reloadKey }) => {
  const self = useContext(SelfBook);
  const { data, loading, error } = useSection<any>(api, `/api/hr-ops/p360/${ov.employee.id}/section/discipline`, reloadKey);
  if (error) return <Notice msg={{ type: 'error', text: error }} />;
  if (loading && !data) return <Loading />;
  if (!data) return null;
  if (!data.linked) return <Empty>{self ? 'No disciplinary record.' : 'This employee has no app login, so no disciplinary action can be recorded against them.'}</Empty>;
  const actions: any[] = data.actions || [];
  const open = actions.filter((a) => a.status !== 'closed').length;
  const byType = actions.reduce((m: Record<string, number>, a) => ({ ...m, [a.action_type]: (m[a.action_type] || 0) + 1 }), {});
  const statusLabel = (a: any) => (a.status === 'closed' ? 'Closed' : a.acknowledged ? 'Acknowledged' : 'Pending acknowledgement');
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Tile label="Total actions" value={actions.length} sub={actions[0] ? `latest ${fmtDate(actions[0].issued_at)}` : 'clean record'} />
        <Tile label="Open" value={open} tone={open ? 'border-amber-200 bg-amber-50/50' : undefined} sub="not closed yet" />
        <Tile label="Warnings" value={(byType.verbal_warning || 0) + (byType.written_warning || 0)} sub={`${byType.verbal_warning || 0} verbal · ${byType.written_warning || 0} written`} />
        <Tile
          label="Show cause / suspension"
          value={(byType.show_cause || 0) + (byType.suspension || 0) + (byType.termination || 0)}
          sub={byType.termination ? `${byType.termination} termination` : `${byType.show_cause || 0} show cause · ${byType.suspension || 0} suspension`}
          tone={byType.suspension || byType.termination ? 'border-rose-200 bg-rose-50/50' : undefined}
        />
      </div>
      <Card title={`Disciplinary history (${actions.length})`}>
        {actions.length === 0 ? (
          <Empty>No disciplinary action on record.</Empty>
        ) : (
          <div className="space-y-3">
            {actions.map((a) => (
              <div key={a.id} className="rounded-lg border border-slate-100 p-3">
                <div className="flex flex-wrap items-start justify-between gap-2">
                  <div className="min-w-0">
                    <div className="text-xs font-bold text-rose-700">{DISCIPLINE_LABEL[a.action_type] || a.action_type}</div>
                    <div className="text-xs text-slate-800 mt-0.5">{a.reason}</div>
                    <div className="text-[11px] text-slate-400 mt-0.5">
                      {fmtDate(a.issued_at)}
                      {a.issued_by ? ` · issued by ${a.issued_by}` : ''}
                      {a.acknowledged_at ? ` · acknowledged ${fmtDate(a.acknowledged_at)}` : ''}
                    </div>
                  </div>
                  <Badge tone={a.status === 'closed' ? 'na' : a.acknowledged ? 'approved' : 'pending'}>{statusLabel(a)}</Badge>
                </div>
                {a.document_text && <div className="mt-2 text-[11px] text-slate-600 whitespace-pre-wrap rounded-md bg-slate-50 p-2">{a.document_text}</div>}
                {(a.feedback || []).length > 0 && (
                  <div className="mt-2 space-y-1.5">
                    {a.feedback.map((f: any, i: number) => (
                      <div key={i} className={`rounded-md px-2.5 py-1.5 text-[11px] ${f.role === 'named' ? 'bg-blue-50 text-slate-700' : 'bg-slate-50 text-slate-600'}`}>
                        <span className="font-semibold">{f.role === 'named' ? 'Employee' : 'HR'}{f.by ? ` · ${f.by}` : ''}</span>
                        {f.at ? <span className="text-slate-400"> · {fmtDate(f.at)}</span> : null}
                        <div className="whitespace-pre-wrap">{f.message}</div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
};

const OtherTab: React.FC<{ api: Api; ov: P360Overview; reloadKey: number }> = ({ api, ov, reloadKey }) => {
  const id = ov.employee.id;
  const assets = useSection<any>(api, `/api/hr-ops/p360/${id}/section/assets`, reloadKey);
  const disc = useSection<any>(api, `/api/hr-ops/p360/${id}/section/discipline`, reloadKey);
  const perf = useSection<any>(api, `/api/hr-ops/p360/${id}/section/performance`, reloadKey);
  return (
    <div className="space-y-4">
      {disc.data?.exit && (
        <div className="rounded-xl border border-rose-200 bg-rose-50/60 p-3 text-xs text-rose-800">
          <span className="font-bold">{disc.data.exit.exit_type === 'termination' ? 'Termination' : 'Resignation'}</span> · notice {fmtDate(disc.data.exit.notice_date)} · last working day{' '}
          {fmtDate(disc.data.exit.last_working_day)} · <span className="capitalize">{disc.data.exit.status}</span>
          {disc.data.exit.reason && <div className="text-rose-700/80 mt-0.5">{disc.data.exit.reason}</div>}
        </div>
      )}
      <Card title={`Assets (${assets.data?.assets.filter((a: any) => !a.returned_date).length ?? 0} with employee)`}>
        {assets.loading && !assets.data ? (
          <Loading />
        ) : (
          <Table
            head={['Asset', 'Tag / Serial', 'Qty', 'Assigned', 'Returned', 'Acknowledged']}
            empty="No assets assigned."
            rows={(assets.data?.assets || []).map((a: any) => [
              <span className="font-semibold">{a.name}</span>,
              [a.asset_tag, a.serial_number].filter(Boolean).join(' · ') || '—',
              a.quantity != null ? `${a.quantity} ${a.unit || ''}` : '—',
              fmtDate(a.assigned_date),
              a.returned_date ? `${fmtDate(a.returned_date)}${a.condition_on_return ? ` (${a.condition_on_return})` : ''}` : <Badge tone="pending">With employee</Badge>,
              a.acknowledged ? 'Yes' : 'No'
            ])}
          />
        )}
      </Card>
      <div>
        <Card title="Performance reviews">
          {perf.loading && !perf.data ? (
            <Loading />
          ) : (
            <Table
              head={['Cycle', 'Rating', 'Reviewer', 'Status']}
              empty="No reviews."
              rows={(perf.data?.reviews || []).map((r: any) => [
                <div>
                  <div className="font-semibold">{r.cycle}</div>
                  <div className="text-[10px] text-slate-400">
                    {fmtDate(r.period_start)} – {fmtDate(r.period_end)}
                  </div>
                </div>,
                r.overall_rating != null ? `${r.overall_rating} / 5` : '—',
                r.reviewer || '—',
                r.status
              ])}
            />
          )}
        </Card>
      </div>
    </div>
  );
};

// Grade / probation / contract — the starting values; later changes go
// through HR Actions.
const ServiceDetailsModal: React.FC<{ token: string; emp: HrOpsEmployee; onClose: () => void; onSaved: () => void }> = ({ token, emp, onClose, onSaved }) => {
  const api = useHrApi(token);
  const [form, setForm] = useState<Record<string, string>>({
    grade: emp.grade || '',
    probation_months: emp.probation_months != null ? String(emp.probation_months) : '',
    probation_end_date: emp.probation_end_date || '',
    confirmation_date: emp.confirmation_date || '',
    contract_end_date: emp.contract_end_date || '',
    service_status: emp.service_status || ''
  });
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const save = async () => {
    try {
      await api.put(`/api/hr-ops/service/${emp.id}`, form);
      onSaved();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  return (
    <Modal
      title="Service Details"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} onClick={save}>
            Save
          </button>
        </>
      }
    >
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Grade</label>
          <input value={form.grade} onChange={(e) => setForm({ ...form, grade: e.target.value })} className={inputCls} placeholder="e.g. G-5" />
        </div>
        <div>
          <label className={labelCls}>Service status</label>
          <select value={form.service_status} onChange={(e) => setForm({ ...form, service_status: e.target.value })} className={inputCls}>
            <option value="">Auto</option>
            {Object.entries(SERVICE_STATUS_LABEL).map(([k, v]) => (
              <option key={k} value={k}>
                {v}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>Probation (months)</label>
          <input type="number" min={0} value={form.probation_months} onChange={(e) => setForm({ ...form, probation_months: e.target.value, probation_end_date: '' })} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Probation end date</label>
          <input type="date" value={form.probation_end_date} onChange={(e) => setForm({ ...form, probation_end_date: e.target.value })} className={inputCls} />
          <p className="text-[10px] text-slate-400 mt-0.5">Leave empty to count from the joining date.</p>
        </div>
        <div>
          <label className={labelCls}>Confirmation date</label>
          <input type="date" value={form.confirmation_date} onChange={(e) => setForm({ ...form, confirmation_date: e.target.value })} className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Contract end date</label>
          <input type="date" value={form.contract_end_date} onChange={(e) => setForm({ ...form, contract_end_date: e.target.value })} className={inputCls} />
        </div>
      </div>
      <p className="text-[11px] text-slate-400 mt-3">Use these for the starting values. Later changes (promotion, confirmation, extension…) should go through an HR Action so they are approved and recorded.</p>
    </Modal>
  );
};
