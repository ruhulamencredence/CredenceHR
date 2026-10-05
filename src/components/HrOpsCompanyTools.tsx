/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Multi-company tools for one Employee (Employee 360 -> Actions -> "Other
// companies"): the company they belong to, the sister companies they also
// work for (each with its own Employee ID / designation there), adding or
// ending such an assignment. Moving them to another company for good is an HR
// Action ("Company Transfer"), so it goes through approval and the letter.

import React, { useCallback, useEffect, useState } from 'react';
import { Building2, CalendarX, Plus } from 'lucide-react';
import { Spinner } from './Spinner';
import { useHrApi, Modal, Notice, fmtDate, inputCls, labelCls, btnPrimary, btnGhost } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

interface GroupCompany {
  id: number;
  name: string;
  short_code: string;
  is_mother: boolean;
}
interface Assignment {
  id: number;
  company_id: number;
  company_name: string;
  short_code: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  start_date: string | null;
  end_date: string | null;
  is_active: boolean;
  note: string | null;
}

export function useGroupCompanies(token: string) {
  const api = useHrApi(token);
  const [list, setList] = useState<GroupCompany[]>([]);
  useEffect(() => {
    api
      .get<GroupCompany[]>('/api/companies/group')
      .then(setList)
      .catch(() => setList([]));
  }, [api]);
  return list;
}

export const CompanyAssignmentsModal: React.FC<{ token: string; employeeId: number; employeeName: string; onClose: () => void; onTransfer: () => void }> = ({
  token,
  employeeId,
  employeeName,
  onClose,
  onTransfer
}) => {
  const api = useHrApi(token);
  const companies = useGroupCompanies(token);
  const [data, setData] = useState<{ home_company: { id: number; name: string; short_code: string } | null; assignments: Assignment[] } | null>(null);
  const [adding, setAdding] = useState(false);
  const [f, setF] = useState({ company_id: '', employee_code: '', designation: '', department: '', start_date: '', note: '' });
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const load = useCallback(() => {
    api
      .get(`/api/companies/assignments?employee_id=${employeeId}`)
      .then(setData)
      .catch((e) => setMsg({ type: 'error', text: e.message }));
  }, [api, employeeId]);
  useEffect(() => {
    load();
  }, [load]);
  // Suggest the next Employee ID of the chosen company.
  useEffect(() => {
    if (!f.company_id) return;
    api
      .get<{ code: string }>(`/api/companies/next-employee-code?company_id=${f.company_id}`)
      .then((d) => setF((p) => ({ ...p, employee_code: d.code })))
      .catch(() => {});
  }, [api, f.company_id]);

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      await api.post('/api/companies/assignments', { employee_id: employeeId, ...f, company_id: Number(f.company_id) });
      setAdding(false);
      setF({ company_id: '', employee_code: '', designation: '', department: '', start_date: '', note: '' });
      setMsg({ type: 'success', text: `${employeeName} now also works for that company — they show in its lists, and can switch to it if they have a login.` });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  const end = async (a: Assignment) => {
    if (!(await confirmDialog(`End ${employeeName}'s work at ${a.company_name}?`))) return;
    try {
      await api.post(`/api/companies/assignments/${a.id}/end`, {});
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };

  const homeId = data?.home_company?.id;
  const choices = companies.filter((c) => c.id !== homeId);
  return (
    <Modal title={`Companies — ${employeeName}`} onClose={onClose} wide>
      {!data ? (
        <div className="py-8 flex justify-center">
          <Spinner />
        </div>
      ) : (
        <div className="space-y-4">
          <Notice msg={msg} onClose={() => setMsg(null)} />
          <div className="rounded-lg border border-slate-200 bg-slate-50 p-3 flex items-center justify-between gap-2 flex-wrap">
            <div className="text-xs">
              <div className="text-slate-500">Belongs to (salary, leave balance, service record)</div>
              <div className="font-semibold text-slate-800 flex items-center gap-1.5">
                <Building2 className="w-3.5 h-3.5" /> {data.home_company?.name || '—'}
              </div>
            </div>
            {choices.length > 0 && (
              <button type="button" className={btnGhost} onClick={onTransfer}>
                Transfer to another company…
              </button>
            )}
          </div>

          <div>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-semibold text-slate-700">Also works for</div>
              {!adding && choices.length > 0 && (
                <button type="button" className={btnGhost} onClick={() => setAdding(true)}>
                  <Plus className="w-3.5 h-3.5" /> Add company
                </button>
              )}
            </div>
            {data.assignments.length === 0 && !adding && <div className="text-xs text-slate-400">Only their own company.</div>}
            <div className="space-y-2">
              {data.assignments.map((a) => (
                <div key={a.id} className={`rounded-lg border p-3 text-xs flex items-start justify-between gap-2 ${a.is_active ? 'border-slate-200 bg-white' : 'border-slate-100 bg-slate-50 opacity-70'}`}>
                  <div>
                    <div className="font-semibold text-slate-800">
                      {a.company_name} {a.employee_code && <span className="font-mono text-slate-500">· {a.employee_code}</span>}
                    </div>
                    <div className="text-slate-500">{[a.designation, a.department].filter(Boolean).join(' · ') || '—'}</div>
                    <div className="text-slate-400">
                      {a.start_date ? `From ${fmtDate(a.start_date)}` : ''}
                      {a.end_date ? ` · until ${fmtDate(a.end_date)}` : ''}
                      {!a.is_active && ' · ended'}
                    </div>
                  </div>
                  {a.is_active && (
                    <button type="button" className={btnGhost} onClick={() => end(a)}>
                      <CalendarX className="w-3.5 h-3.5" /> End
                    </button>
                  )}
                </div>
              ))}
            </div>
            {adding && (
              <div className="mt-3 rounded-lg border border-blue-200 bg-blue-50/40 p-3 space-y-3">
                <div className="grid sm:grid-cols-2 gap-3">
                  <div>
                    <label className={labelCls}>Company *</label>
                    <select className={inputCls} value={f.company_id} onChange={(e) => setF((p) => ({ ...p, company_id: e.target.value }))}>
                      <option value="">Pick…</option>
                      {choices.map((c) => (
                        <option key={c.id} value={c.id}>
                          {c.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>Employee ID there</label>
                    <input className={inputCls} value={f.employee_code} onChange={(e) => setF((p) => ({ ...p, employee_code: e.target.value }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Designation there</label>
                    <input className={inputCls} value={f.designation} onChange={(e) => setF((p) => ({ ...p, designation: e.target.value }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Department there</label>
                    <input className={inputCls} value={f.department} onChange={(e) => setF((p) => ({ ...p, department: e.target.value }))} />
                  </div>
                  <div>
                    <label className={labelCls}>From</label>
                    <input type="date" className={inputCls} value={f.start_date} onChange={(e) => setF((p) => ({ ...p, start_date: e.target.value }))} />
                  </div>
                  <div>
                    <label className={labelCls}>Note</label>
                    <input className={inputCls} value={f.note} onChange={(e) => setF((p) => ({ ...p, note: e.target.value }))} />
                  </div>
                </div>
                <p className="text-[11px] text-slate-500">Their salary stays with their own company; they appear in this company's lists and attendance.</p>
                <div className="flex justify-end gap-2">
                  <button type="button" className={btnGhost} onClick={() => setAdding(false)}>
                    Cancel
                  </button>
                  <button type="button" className={btnPrimary} disabled={busy || !f.company_id} onClick={save}>
                    {busy && <Spinner />} Save
                  </button>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};
