/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> Personnel Actions -> New -> Transfer: "Also changes" — what
// moves with the person to the new Branch on the effective date (PEPM
// projects, Remote Attendance check-in, department team), each with a tick.
// A Branch with no linked Project (Head Office) gives no project; HR may pick
// some. POST /api/hr-ops/actions/transfer-plan; done by applyTransferAccess
// (HROperationsRoutes.ts) on the day.

import React, { useEffect, useState } from 'react';
import { X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { SearchSelect } from './Combobox';

type Named = { id: number; name: string };
export interface TransferPlan {
  from_branch: Named | null;
  to_branch: Named | null;
  from_project: Named | null;
  to_project: Named | null;
  employee: { id: number; name: string; user_id: number | null };
  pepm: { remove: Named[]; add: Named[]; keep: Named[] };
  attendance: { by_branch: boolean; end: (Named & { valid_to: string })[]; start: (Named & { valid_from: string })[] };
  team: { from: Named | null; to: Named | null };
}
export interface TransferAccess {
  pepm: boolean;
  attendance: boolean;
  team: boolean;
  extra_project_ids: number[];
}

const pill = 'inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full';
const del = `${pill} bg-rose-50 text-rose-700 line-through`;
const add = `${pill} bg-emerald-50 text-emerald-700`;
const keep = `${pill} bg-slate-100 text-slate-600`;
const fmt = (d: string) => {
  const [y, m, day] = d.split('-').map(Number);
  return new Date(y, m - 1, day).toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
};

export const TransferAccessPanel: React.FC<{
  token: string;
  employeeId: number;
  branchId: string;
  departmentId: string;
  effectiveDate: string;
  projects: Named[];
  value: TransferAccess;
  onChange: (v: TransferAccess) => void;
}> = ({ token, employeeId, branchId, departmentId, effectiveDate, projects, value, onChange }) => {
  const [plan, setPlan] = useState<TransferPlan | null>(null);
  const [pick, setPick] = useState('');
  useEffect(() => {
    let cancelled = false;
    setPlan(null);
    fetch(apiUrl('/api/hr-ops/actions/transfer-plan'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ employee_id: employeeId, branch_id: branchId || null, department_id: departmentId || null, effective_date: effectiveDate || null })
    })
      .then((r) => (r.ok ? r.json() : null))
      .then((p) => !cancelled && setPlan(p))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token, employeeId, branchId, departmentId, effectiveDate]);

  if (!plan || !plan.to_branch) return null;
  const noLogin = !plan.employee.user_id;
  const pepmNothing = !plan.pepm.remove.length && !plan.pepm.add.length;
  const attNothing = plan.attendance.by_branch || (!plan.attendance.end.length && !plan.attendance.start.length);
  const extra = projects.filter((p) => value.extra_project_ids.includes(p.id));
  const row = (k: 'pepm' | 'attendance' | 'team', title: string, body: React.ReactNode, disabled = false) => (
    <div className={`rounded-xl border border-slate-200 bg-white p-3 space-y-1.5 ${value[k] && !disabled ? '' : 'opacity-60'}`}>
      <label className="flex items-center gap-2 text-sm font-semibold text-slate-800">
        <input type="checkbox" checked={value[k] && !disabled} disabled={disabled} onChange={(e) => onChange({ ...value, [k]: e.target.checked })} className="w-4 h-4 accent-blue-600" />
        {title}
      </label>
      {body}
    </div>
  );

  return (
    <div className="rounded-2xl border border-blue-100 bg-blue-50/50 p-3 space-y-2">
      <div className="text-xs font-bold text-slate-800">Also changes on {effectiveDate ? fmt(effectiveDate) : 'the effective date'}</div>
      {noLogin && <p className="text-[11px] text-amber-700">This employee has no login, so there are no PEPM projects or check-in to move.</p>}
      {row(
        'pepm',
        'PEPM projects (Budget / Jobs / MPR)',
        <>
          <div className="flex flex-wrap gap-1.5">
            {plan.pepm.remove.map((p) => (
              <span key={`r${p.id}`} className={del}>
                {p.name}
              </span>
            ))}
            {plan.pepm.add.map((p) => (
              <span key={`a${p.id}`} className={add}>
                + {p.name}
              </span>
            ))}
            {plan.pepm.keep.map((p) => (
              <span key={`k${p.id}`} className={keep}>
                {p.name} stays
              </span>
            ))}
          </div>
          <p className="text-[11px] text-slate-500">
            {plan.to_project
              ? `${plan.to_project.name} (linked to ${plan.to_branch.name}) comes in${plan.pepm.remove.length ? `; ${plan.from_project?.name} goes` : ''}. Old entries stay where they are.`
              : `${plan.to_branch.name} has no linked project, so none comes in${plan.pepm.remove.length ? ` and ${plan.from_project?.name} goes` : ''}. Give one below if they need it.`}
          </p>
        </>,
        noLogin || pepmNothing
      )}
      {!noLogin && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-1.5">
          <div className="text-sm font-semibold text-slate-800">Also give PEPM projects (optional)</div>
          {extra.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {extra.map((p) => (
                <span key={p.id} className={add}>
                  + {p.name}
                  <button type="button" aria-label={`Remove ${p.name}`} onClick={() => onChange({ ...value, extra_project_ids: value.extra_project_ids.filter((x) => x !== p.id) })}>
                    <X className="w-3 h-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
          <SearchSelect
            value={pick}
            onChange={(e) => {
              const id = Number(e.target.value);
              setPick('');
              if (id && !value.extra_project_ids.includes(id)) onChange({ ...value, extra_project_ids: [...value.extra_project_ids, id] });
            }}
            aria-label="Give a PEPM project"
            className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm"
          >
            <option value="">— Add a project —</option>
            {projects
              .filter((p) => !value.extra_project_ids.includes(p.id) && !plan.pepm.keep.some((k) => k.id === p.id) && !plan.pepm.add.some((k) => k.id === p.id))
              .map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
          </SearchSelect>
        </div>
      )}
      {row(
        'attendance',
        'Remote Attendance (where they can Check In / Out)',
        plan.attendance.by_branch ? (
          <p className="text-[11px] text-slate-500">They check in by their Branch already, so this follows the new Branch by itself.</p>
        ) : (
          <>
            <div className="flex flex-wrap gap-1.5">
              {plan.attendance.end.map((a) => (
                <span key={`e${a.id}`} className={del}>
                  {a.name} · ends {fmt(a.valid_to)}
                </span>
              ))}
              {plan.attendance.start.map((a) => (
                <span key={`s${a.id}`} className={add}>
                  + {a.name} · from {fmt(a.valid_from)}
                </span>
              ))}
              {attNothing && <span className={keep}>Nothing to change</span>}
            </div>
            {!plan.to_project && <p className="text-[11px] text-slate-500">{plan.to_branch.name} has no linked project — they check in with the office machine there.</p>}
          </>
        ),
        noLogin || attNothing
      )}
      {row(
        'team',
        'Department team',
        plan.team.to ? (
          <div className="flex flex-wrap gap-1.5">
            {plan.team.from && <span className={del}>{plan.team.from.name}</span>}
            <span className={add}>+ {plan.team.to.name}</span>
          </div>
        ) : (
          <p className="text-[11px] text-slate-500">No team is set to take people at {plan.to_branch.name} (Departments → Teams)
            {plan.team.from ? `; they stay in ${plan.team.from.name}` : ''}.</p>
        ),
        !plan.team.to
      )}
    </div>
  );
};
