/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> HRM -> "HR Operations" — the HR department's day-to-day
// work on Employees in one module (HROperationsRoutes.ts): the monthly
// report, Personnel Actions (promotion / increment / transfer /
// confirmation / separation… with approval), each Employee's Service Book
// (Employee 360 — everything about one Employee on one page),
// Letters (templates, register, requests), the Onboarding checklist,
// Increment planning, company-wide Employee Reports, and Settings — plus
// Grievance & Disciplinary (the same page as HR Advanced's), shown only to an
// account that also holds that module.

import React, { useCallback, useEffect, useState } from 'react';
import { Briefcase, LayoutDashboard, ClipboardList, BookOpen, FileText, ClipboardCheck, TrendingUp, Settings, FileSpreadsheet, Gavel, CreditCard, Building2 } from 'lucide-react';
import { EmployeeHeadcountSheet, exportEmployees } from './EmployeeHeadcountSheet';
import { HrOpsBodySkeleton } from './HrOpsSkeleton';
import { useHrApi, Notice, type HrOpsEmployee, type HrOpsMeta } from './HrOpsShared';
import { HrOpsDashboard } from './HrOpsDashboard';
import { HrOpsActions } from './HrOpsActions';
import { Employee360 } from './HrOps360';
import { HrOpsLetters } from './HrOpsLetters';
import { HrOpsOnboarding } from './HrOpsOnboarding';
import { HrOpsIncrements } from './HrOpsIncrements';
import { HrOpsSettings } from './HrOpsSettings';
import { HrOpsReports } from './HrOpsReports';
import { HrQuickReports } from './HrQuickReports';
import { GrievanceDisciplinaryPanel } from './GrievanceDisciplinaryPanel';
import { HrRequisitions } from './HrRequisitions';

export type HrOpsTab = 'dashboard' | 'actions' | 'service_book' | 'letters' | 'onboarding' | 'increments' | 'reports' | 'grievance' | 'requisitions' | 'settings';

const TABS: { key: HrOpsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'dashboard', label: 'Monthly Report', icon: LayoutDashboard },
  { key: 'actions', label: 'Personnel Actions', icon: ClipboardList },
  { key: 'grievance', label: 'Grievance & Disciplinary', icon: Gavel },
  { key: 'service_book', label: 'Service Book (360°)', icon: BookOpen },
  { key: 'letters', label: 'Letters', icon: FileText },
  { key: 'onboarding', label: 'Onboarding', icon: ClipboardCheck },
  { key: 'increments', label: 'Increments', icon: TrendingUp },
  { key: 'reports', label: 'Reports', icon: FileSpreadsheet },
  { key: 'requisitions', label: 'SIM & ID Card Requests', icon: CreditCard },
  { key: 'settings', label: 'Settings', icon: Settings }
];

// The sidebar's HR Operations sub-items open a specific tab through this
// event (the Admin Panel itself only knows the module, not its tabs).
export const HR_OPS_TAB_EVENT = 'credence:hr-ops-tab';
const TAB_STORAGE_KEY = 'hr_ops_tab';
// Reports tab: "quick" (ready reports, with the quick_reports layer) or
// "build" (Employee Reports — build your own).
export const REPORTS_VIEW_STORAGE_KEY = 'hr_ops_reports_view';
// Fired with the open tab, so the sidebar can highlight its own item for it.
export const HR_OPS_ACTIVE_EVENT = 'credence:hr-ops-active';

export const HROperationsPanel: React.FC<{
  token: string;
  canGrievance?: boolean;
  canRequisitions?: boolean;
  canQuickReports?: boolean;
  canQuickOt?: boolean;
  // HR Operations layers "hr_headcount" / "hr_emp_export" (EmployeeHeadcount.ts).
  canHeadcount?: boolean;
  canExportEmployees?: boolean;
}> = ({ token, canGrievance = false, canRequisitions = false, canQuickReports = false, canQuickOt = false, canHeadcount = false, canExportEmployees = false }) => {
  const [headcountOpen, setHeadcountOpen] = useState(false);
  const [exportBusy, setExportBusy] = useState(false);
  const [exportMsg, setExportMsg] = useState('');
  const api = useHrApi(token);
  // A tab only for an account with its permission (grievance module / "requisitions" layer).
  const allowed = (t: HrOpsTab) => (t !== 'grievance' || canGrievance) && (t !== 'requisitions' || canRequisitions);
  const tabs = TABS.filter((t) => allowed(t.key));
  const [tab, setTab] = useState<HrOpsTab>(() => {
    try {
      const t = sessionStorage.getItem(TAB_STORAGE_KEY) as HrOpsTab | null;
      if (t && TABS.some((x) => x.key === t) && allowed(t)) return t;
    } catch {
      // storage unavailable
    }
    return 'dashboard';
  });
  const [meta, setMeta] = useState<HrOpsMeta | null>(null);
  const [employees, setEmployees] = useState<HrOpsEmployee[]>([]);
  const [error, setError] = useState('');
  const [bookEmployee, setBookEmployee] = useState<number | null>(null);
  const [refreshKey, setRefreshKey] = useState(0);
  const [settingsSection, setSettingsSection] = useState<'increments' | undefined>(undefined);
  const [reportsView, setReportsView] = useState<'quick' | 'build'>(() => {
    try {
      return sessionStorage.getItem(REPORTS_VIEW_STORAGE_KEY) === 'build' ? 'build' : 'quick';
    } catch {
      return 'quick';
    }
  });
  const showQuick = canQuickReports && reportsView === 'quick';
  const [reportsOpened, setReportsOpened] = useState(0);

  const loadMeta = useCallback(() => api.get<HrOpsMeta>('/api/hr-ops/meta').then(setMeta), [api]);
  const loadEmployees = useCallback(() => api.get<HrOpsEmployee[]>('/api/hr-ops/employees').then(setEmployees), [api]);
  useEffect(() => {
    Promise.all([loadMeta(), loadEmployees()]).catch((e) => setError(e.message));
  }, [loadMeta, loadEmployees]);

  useEffect(() => {
    try {
      sessionStorage.setItem(TAB_STORAGE_KEY, tab);
    } catch {
      // ignore
    }
    window.dispatchEvent(new CustomEvent(HR_OPS_ACTIVE_EVENT, { detail: tab }));
  }, [tab]);
  useEffect(() => {
    try {
      sessionStorage.setItem(REPORTS_VIEW_STORAGE_KEY, reportsView);
    } catch {
      // ignore
    }
  }, [reportsView]);
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = (e as CustomEvent).detail as HrOpsTab;
      if (TABS.some((x) => x.key === t) && allowed(t)) {
        setTab(t);
        // Opened on Reports from elsewhere: which view, and (Quick reports)
        // which report — HrQuickReports re-reads it when it mounts again.
        if (t === 'reports') {
          try {
            setReportsView(sessionStorage.getItem(REPORTS_VIEW_STORAGE_KEY) === 'build' ? 'build' : 'quick');
          } catch {
            // storage unavailable
          }
          setReportsOpened((n) => n + 1);
        }
      }
    };
    window.addEventListener(HR_OPS_TAB_EVENT, onTab);
    return () => window.removeEventListener(HR_OPS_TAB_EVENT, onTab);
  }, [canGrievance, canRequisitions]);

  const changed = () => {
    loadEmployees();
    setRefreshKey((k) => k + 1);
  };
  const openEmployee = (id: number) => {
    setBookEmployee(id);
    setTab('service_book');
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 pb-0 border-b border-slate-200">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <Briefcase className="w-5 h-5 text-blue-600" />
          </div>
          <div className="flex-1 min-w-0">
            <h1 className="text-lg font-semibold text-slate-800">HR Operations</h1>
            <p className="text-xs text-slate-500 mt-0.5 max-w-xl">
              Promotions, increments, transfers and every other change to an employee — approved, recorded in their service book, with letters and a monthly report.
            </p>
            {exportMsg && <p className="text-xs text-rose-600 mt-1">{exportMsg}</p>}
          </div>
          {(canHeadcount || canExportEmployees) && (
            <div className="flex flex-wrap gap-2 shrink-0">
              {canHeadcount && (
                <button
                  type="button"
                  onClick={() => setHeadcountOpen(true)}
                  className="flex items-center gap-1.5 py-2 px-3 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold rounded-xl text-xs"
                  title="How many work at each Head Office / Project and Branch, with the list"
                >
                  <Building2 className="w-3.5 h-3.5" /> Office / Project
                </button>
              )}
              {canExportEmployees && (
                <button
                  type="button"
                  disabled={exportBusy}
                  onClick={async () => {
                    setExportBusy(true);
                    setExportMsg('');
                    try {
                      await exportEmployees(token, 'hr', 'all');
                    } catch (e: any) {
                      setExportMsg(e.message);
                    } finally {
                      setExportBusy(false);
                    }
                  }}
                  className="flex items-center gap-1.5 py-2 px-3 bg-white border border-slate-200 hover:bg-slate-50 text-slate-700 font-semibold rounded-xl text-xs disabled:opacity-50"
                  title="Every employee's details as Excel, in the HR Data Import layout"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> {exportBusy ? 'Exporting…' : 'Export employees'}
                </button>
              )}
            </div>
          )}
        </div>
        {headcountOpen && <EmployeeHeadcountSheet token={token} source="hr" canExport={canExportEmployees} onClose={() => setHeadcountOpen(false)} />}
        <div className="flex gap-1 mt-5 overflow-x-auto -mb-px">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => {
                setTab(t.key);
                if (t.key === 'settings') setSettingsSection(undefined);
              }}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2.5 border-b-2 whitespace-nowrap transition-colors ${
                tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-800'
              }`}
            >
              <t.icon className="w-3.5 h-3.5" /> {t.label}
            </button>
          ))}
        </div>
      </div>
      <div className="p-6">
        {error && <Notice msg={{ type: 'error', text: error }} />}
        {!meta ? (
          !error && <HrOpsBodySkeleton tab={tab} employeeChosen={!!bookEmployee} />
        ) : tab === 'dashboard' ? (
          <HrOpsDashboard token={token} onOpenEmployee={openEmployee} meta={meta} employees={employees} onChanged={changed} />
        ) : tab === 'actions' ? (
          <HrOpsActions token={token} meta={meta} employees={employees} onChanged={changed} refreshKey={refreshKey} />
        ) : tab === 'service_book' ? (
          <Employee360 token={token} meta={meta} employees={employees} employeeId={bookEmployee} onPick={setBookEmployee} onChanged={changed} />
        ) : tab === 'letters' ? (
          <HrOpsLetters token={token} meta={meta} employees={employees} refreshKey={refreshKey} />
        ) : tab === 'onboarding' ? (
          <HrOpsOnboarding token={token} meta={meta} employees={employees} />
        ) : tab === 'grievance' && canGrievance ? (
          <GrievanceDisciplinaryPanel token={token} embedded />
        ) : tab === 'requisitions' && canRequisitions ? (
          <HrRequisitions token={token} />
        ) : tab === 'reports' ? (
          <div className="space-y-4">
            {canQuickReports && (
              <div className="flex gap-2" role="tablist" aria-label="Reports">
                {(
                  [
                    ['quick', 'Quick reports'],
                    ['build', 'Build your own']
                  ] as const
                ).map(([k, label]) => (
                  <button
                    key={k}
                    type="button"
                    role="tab"
                    aria-selected={reportsView === k}
                    onClick={() => setReportsView(k)}
                    className={`text-xs font-semibold px-3.5 py-1.5 rounded-full border transition-colors ${
                      reportsView === k ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
            {showQuick ? <HrQuickReports key={reportsOpened} token={token} onOpenEmployee={openEmployee} canOt={canQuickOt} /> : <HrOpsReports token={token} onOpenEmployee={openEmployee} />}
          </div>
        ) : tab === 'increments' ? (
          <HrOpsIncrements
            token={token}
            meta={meta}
            onGoSettings={() => {
              setSettingsSection('increments');
              setTab('settings');
            }}
            onCreated={changed}
          />
        ) : (
          <HrOpsSettings
            token={token}
            meta={meta}
            initialSection={settingsSection}
            onMetaChanged={() => {
              loadMeta();
            }}
          />
        )}
      </div>
    </div>
  );
};
