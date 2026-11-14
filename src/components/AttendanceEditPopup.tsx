/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Monthly Attendance Report -> a day -> Edit attendance (Attendance Reports
// layer "attendance_edit"): give or correct someone's In / Out for that day,
// with a reason that is required. AttendanceAdminEdit.ts.

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Loader2, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { SearchSelect } from './Combobox';

const hm = (v: string | null) => {
  if (!v) return '';
  const m = /(\d{2}):(\d{2})/.exec(String(v).replace('T', ' ').slice(11));
  return m ? `${m[1]}:${m[2]}` : '';
};
const ampm = (v: string | null) => {
  const t = hm(v);
  if (!t) return '—';
  const h = Number(t.slice(0, 2));
  return `${String(h % 12 || 12).padStart(2, '0')}:${t.slice(3)} ${h < 12 ? 'AM' : 'PM'}`;
};

export const AttendanceEditPopup: React.FC<{
  token: string;
  userId: number;
  userName: string;
  date: string;
  onClose: () => void;
  onSaved: () => void;
}> = ({ token, userId, userName, date, onClose, onSaved }) => {
  const [info, setInfo] = useState<any>(null);
  const [inT, setInT] = useState('');
  const [outT, setOutT] = useState('');
  const [projectId, setProjectId] = useState('');
  const [remarks, setRemarks] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useBackButtonClose(true, () => !busy && onClose());

  useEffect(() => {
    fetch(apiUrl(`/api/attendance/admin-edit?user_id=${userId}&date=${date}`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!ok) throw new Error(d?.error || 'Could not load');
        setInfo(d);
        const row = d.rows?.[0];
        setInT(hm(row?.check_in_at || null));
        setOutT(hm(row?.check_out_at || null));
        setProjectId(d.suggested_project_id ? String(d.suggested_project_id) : '');
      })
      .catch((e) => setError(e.message));
  }, [token, userId, date]);

  const row = info?.rows?.[0] || null;
  const save = async () => {
    setError('');
    if (!remarks.trim()) return setError('Write the reason (remarks).');
    if (!inT && !outT) return setError('Give an In time, an Out time or both.');
    if (!row && !inT) return setError('A day with no attendance needs an In time.');
    if (!row && !projectId) return setError('Pick the Project.');
    setBusy(true);
    try {
      const r = await fetch(apiUrl('/api/attendance/admin-edit'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          user_id: userId,
          date,
          // Only what changed; an unchanged time stays as it is.
          check_in: inT && inT !== hm(row?.check_in_at || null) ? inT : null,
          check_out: outT && outT !== hm(row?.check_out_at || null) ? outT : null,
          project_id: projectId ? Number(projectId) : null,
          remarks: remarks.trim()
        })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save');
      onSaved();
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  const nothingChanged = !!row && (inT || '') === hm(row.check_in_at || null) && (outT || '') === hm(row.check_out_at || null);
  const dayText = new Date(`${date}T00:00:00`).toLocaleDateString('en-GB', { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

  return createPortal(
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label="Edit attendance">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={() => !busy && onClose()} />
      <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 mx-auto max-w-md">
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 max-h-[88vh] overflow-y-auto">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-slate-900">Edit attendance</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {userName}
                {info?.employee?.employee_code ? ` · ${info.employee.employee_code}` : ''} · {dayText}
              </p>
            </div>
            <button type="button" onClick={onClose} disabled={busy} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          {!info ? (
            <div className="flex justify-center py-10">{!error && <Loader2 className="w-5 h-5 animate-spin text-slate-400" />}</div>
          ) : info.closed ? (
            <p className="mt-4 text-sm text-amber-700">{info.closed}</p>
          ) : (
            <>
              <div className="liquid-glass-inset rounded-2xl px-3 py-2.5 mt-4 text-xs text-slate-600">
                {row ? (
                  <>
                    Now: In <b>{ampm(row.check_in_at)}</b> · Out <b>{ampm(row.check_out_at)}</b>
                    {row.project_name ? ` · ${row.project_name}` : ''}
                  </>
                ) : (
                  'No app attendance this day (office machine punches, if any, stay as they are).'
                )}
              </div>
              <div className="grid grid-cols-2 gap-2 mt-3">
                <label className="text-[11px] font-semibold text-slate-500">
                  In
                  <input type="time" value={inT} onChange={(e) => setInT(e.target.value)} className="mt-1 w-full text-sm px-3 py-2 rounded-xl bg-white/80 border border-white" />
                </label>
                <label className="text-[11px] font-semibold text-slate-500">
                  Out
                  <input type="time" value={outT} onChange={(e) => setOutT(e.target.value)} className="mt-1 w-full text-sm px-3 py-2 rounded-xl bg-white/80 border border-white" />
                </label>
              </div>
              {inT && outT && outT < inT && <p className="text-[11px] text-slate-500 mt-1">Out is the next day (night shift).</p>}
              {!row && (
                <label className="block text-[11px] font-semibold text-slate-500 mt-3">
                  Project
                  <SearchSelect value={projectId} onChange={(e) => setProjectId(e.target.value)} className="mt-1 w-full text-sm px-3 py-2 rounded-xl bg-white/80 border border-white">
                    <option value="">— Select project —</option>
                    {info.projects.map((p: any) => (
                      <option key={p.id} value={p.id}>
                        {p.project_name}
                      </option>
                    ))}
                  </SearchSelect>
                </label>
              )}
              <label className="block text-[11px] font-semibold text-slate-500 mt-3">
                Reason <span className="text-rose-500">*</span>
                <textarea
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  rows={3}
                  maxLength={500}
                  required
                  placeholder="e.g. Was at the site visit, phone had no internet"
                  className="mt-1 w-full text-sm px-3 py-2 rounded-xl bg-white/80 border border-white resize-none"
                />
              </label>
              {info.edits?.length > 0 && (
                <div className="mt-3">
                  <div className="text-[11px] font-semibold text-slate-500 mb-1">Earlier edits of this day</div>
                  <div className="space-y-1">
                    {info.edits.map((e: any, i: number) => (
                      <div key={i} className="liquid-glass-inset rounded-xl px-3 py-2 text-[11px] text-slate-600">
                        {ampm(e.old_in)}–{ampm(e.old_out)} → <b>{ampm(e.new_in)}–{ampm(e.new_out)}</b> · {e.remarks}
                        {e.by && <span className="text-slate-400"> · {e.by}</span>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {error && <p className="text-xs font-semibold text-rose-700 mt-3">{error}</p>}
              <button
                type="button"
                onClick={() => void save()}
                disabled={busy || nothingChanged || !remarks.trim()}
                className="liquid-glass-button rounded-full w-full py-2.5 text-sm font-semibold mt-4 disabled:opacity-50 flex items-center justify-center gap-1.5"
              >
                {busy && <Loader2 className="w-4 h-4 animate-spin" />}
                Save attendance
              </button>
            </>
          )}
          {!info && error && <p className="text-xs font-semibold text-rose-700 mt-3">{error}</p>}
        </div>
      </div>
    </div>,
    document.body
  );
};

export default AttendanceEditPopup;
