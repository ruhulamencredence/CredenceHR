/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Dashboard -> "HR reports": the five Quick reports' numbers
// (HrQuickReports.ts). Shown only with HR Operations and its layer
// "quick_reports" — the parent checks it, the API checks it again (a 403
// hides the card). A tap opens that report in HR Operations.

import React, { useEffect, useState } from 'react';
import { FileSpreadsheet, ChevronRight } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { type QuickKind, type QuickSummary, QUICK_KINDS, quickCardText, presetQuickReport } from './hrQuickShared';

const TONE: Record<QuickKind, string> = {
  probation: 'bg-orange-50 border-orange-200 text-orange-800',
  joiners: 'bg-emerald-50 border-emerald-200 text-emerald-800',
  transfers: 'bg-blue-50 border-blue-200 text-blue-800',
  resignations: 'bg-rose-50 border-rose-200 text-rose-800',
  religion: 'bg-violet-50 border-violet-200 text-violet-800',
  attendance: 'bg-amber-50 border-amber-200 text-amber-800',
  leave: 'bg-sky-50 border-sky-200 text-sky-800',
  contracts: 'bg-orange-50 border-orange-200 text-orange-800',
  headcount: 'bg-slate-50 border-slate-200 text-slate-800',
  records: 'bg-rose-50 border-rose-200 text-rose-800'
};
const ORDER: QuickKind[] = ['probation', 'joiners', 'transfers', 'resignations', 'religion', 'attendance', 'leave', 'contracts', 'headcount', 'records'];
// The cards added later show their own card text (quickCardText).
const NEWER = new Set<QuickKind>(['attendance', 'leave', 'contracts', 'headcount', 'records']);

export const AdminDashboardHrReports: React.FC<{ token: string; onNavigate?: (tab: string) => void }> = ({ token, onNavigate }) => {
  const [s, setS] = useState<QuickSummary | null>(null);
  useEffect(() => {
    let live = true;
    fetch(apiUrl('/api/hr-ops/quick/summary'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => live && d && setS(d))
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [token]);
  if (!s) return null;
  const open = (k: QuickKind) => {
    presetQuickReport(k);
    onNavigate?.('hr_operations');
  };
  return (
    <section className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm" data-testid="dashboard-hr-reports">
      <div className="flex items-center justify-between gap-3 mb-3">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
          <FileSpreadsheet className="w-4 h-4 text-blue-600" /> HR reports
        </h3>
        {onNavigate && (
          <button type="button" onClick={() => open('probation')} className="text-[11px] font-semibold text-blue-600 hover:underline flex items-center gap-0.5">
            All reports in HR Operations <ChevronRight className="w-3 h-3" />
          </button>
        )}
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-5 gap-3">
        {ORDER.map((k) => {
          const t = quickCardText(k, s);
          const title = QUICK_KINDS.find((x) => x.key === k)!.title;
          return (
            <button
              key={k}
              type="button"
              data-dash-quick={k}
              onClick={() => open(k)}
              disabled={!onNavigate}
              title={`Open ${title}`}
              className={`text-left rounded-2xl border p-3.5 flex flex-col gap-1 hover:shadow-md transition-shadow ${TONE[k]}`}
            >
              <span className="text-[11px] font-bold">{NEWER.has(k) ? t.label : k === 'probation' ? 'Probation ends ≤ 30 days' : k === 'resignations' ? 'Resignations in notice' : k === 'religion' ? 'Religion' : `${t.label} · this month`}</span>
              {k === 'religion' ? (
                <span className="text-xs leading-relaxed">{s.religion.top.length ? s.religion.top.map((g) => `${g.label} ${g.count}`).join(' · ') : 'Nothing recorded yet'}</span>
              ) : (
                <b className="text-2xl">{t.big}</b>
              )}
              <span className="text-[11px] opacity-90">
                {NEWER.has(k)
                  ? t.small
                  : k === 'probation'
                  ? s.probation.overdue
                    ? `${s.probation.overdue} already overdue`
                    : 'none overdue'
                  : k === 'joiners'
                    ? s.joiners.top.map((g) => `${g.label} ${g.count}`).join(' · ') || ' '
                    : k === 'transfers'
                      ? s.transfers.scheduled
                        ? `${s.transfers.scheduled} take${s.transfers.scheduled === 1 ? 's' : ''} effect later`
                        : ' '
                      : k === 'resignations'
                        ? s.resignations.leaving_30
                          ? `${s.resignations.leaving_30} leave in 30 days`
                          : ' '
                        : s.religion.not_recorded
                          ? `${s.religion.not_recorded} not recorded`
                          : 'all recorded'}
              </span>
            </button>
          );
        })}
      </div>
    </section>
  );
};
