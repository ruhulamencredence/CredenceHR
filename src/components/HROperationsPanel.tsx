/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> HRM -> "HR Operations" — the HR department's day-to-day
// work on Employees in one module (HROperationsRoutes.ts): the monthly
// report, Personnel Actions (promotion / increment / transfer /
// confirmation / separation… with approval), each Employee's Service Book,
// Letters (templates, register, requests), the Onboarding checklist,
// Increment planning, and Settings.

import React, { useCallback, useEffect, useState } from 'react';
import { Briefcase, LayoutDashboard, ClipboardList, BookOpen, FileText, ClipboardCheck, TrendingUp, Settings } from 'lucide-react';
import { Spinner } from './Spinner';
import { useHrApi, Notice, type HrOpsEmployee, type HrOpsMeta } from './HrOpsShared';
import { HrOpsDashboard } from './HrOpsDashboard';
import { HrOpsActions } from './HrOpsActions';
import { HrOpsServiceBook } from './HrOpsServiceBook';
import { HrOpsLetters } from './HrOpsLetters';
import { HrOpsOnboarding } from './HrOpsOnboarding';
import { HrOpsIncrements } from './HrOpsIncrements';
import { HrOpsSettings } from './HrOpsSettings';

export type HrOpsTab = 'dashboard' | 'actions' | 'service_book' | 'letters' | 'onboarding' | 'increments' | 'settings';

const TABS: { key: HrOpsTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { key: 'dashboard', label: 'Monthly Report', icon: LayoutDashboard },
  { key: 'actions', label: 'Personnel Actions', icon: ClipboardList },
  { key: 'service_book', label: 'Service Book', icon: BookOpen },
  { key: 'letters', label: 'Letters', icon: FileText },
  { key: 'onboarding', label: 'Onboarding', icon: ClipboardCheck },
  { key: 'increments', label: 'Increments', icon: TrendingUp },
  { key: 'settings', label: 'Settings', icon: Settings }
];

// The sidebar's HR Operations sub-items open a specific tab through this
// event (the Admin Panel itself only knows the module, not its tabs).
export const HR_OPS_TAB_EVENT = 'credence:hr-ops-tab';
const TAB_STORAGE_KEY = 'hr_ops_tab';

export const HROperationsPanel: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [tab, setTab] = useState<HrOpsTab>(() => {
    try {
      const t = sessionStorage.getItem(TAB_STORAGE_KEY) as HrOpsTab | null;
      if (t && TABS.some((x) => x.key === t)) return t;
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
  }, [tab]);
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = (e as CustomEvent).detail as HrOpsTab;
      if (TABS.some((x) => x.key === t)) setTab(t);
    };
    window.addEventListener(HR_OPS_TAB_EVENT, onTab);
    return () => window.removeEventListener(HR_OPS_TAB_EVENT, onTab);
  }, []);

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
          <div>
            <h1 className="text-lg font-semibold text-slate-800">HR Operations</h1>
            <p className="text-xs text-slate-500 mt-0.5 max-w-xl">
              Promotions, increments, transfers and every other change to an employee — approved, recorded in their service book, with letters and a monthly report.
            </p>
          </div>
        </div>
        <div className="flex gap-1 mt-5 overflow-x-auto -mb-px">
          {TABS.map((t) => (
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
          !error && (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <Spinner size={16} /> Loading…
            </div>
          )
        ) : tab === 'dashboard' ? (
          <HrOpsDashboard token={token} onOpenEmployee={openEmployee} />
        ) : tab === 'actions' ? (
          <HrOpsActions token={token} meta={meta} employees={employees} onChanged={changed} refreshKey={refreshKey} />
        ) : tab === 'service_book' ? (
          <HrOpsServiceBook token={token} meta={meta} employees={employees} employeeId={bookEmployee} onPick={setBookEmployee} onChanged={changed} />
        ) : tab === 'letters' ? (
          <HrOpsLetters token={token} meta={meta} employees={employees} refreshKey={refreshKey} />
        ) : tab === 'onboarding' ? (
          <HrOpsOnboarding token={token} meta={meta} employees={employees} />
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
