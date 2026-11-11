/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Employees -> "Unlinked logins": every login with no
// Employee record linked to it (Employee Tracking shows them under "No
// employee record" — e.g. after the employees were deleted and imported
// again, when the login's username isn't its Employee ID). Each row offers
// the Employee it most likely belongs to (GET /api/employees/link-suggestions:
// same email, Employee ID = username, or the same name), changeable with a
// type-to-search picker; Link (or "Link all suggested") attaches it through
// PUT /api/employees/:id/link-user. Behind the Employees module, like
// "Link Existing".

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Link2, X, Check } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { SearchSelect } from './Combobox';

interface Emp {
  id: number;
  employee_id: string | null;
  name: string;
  designation: string | null;
  department: string | null;
  is_active: boolean;
}
interface Row {
  user: { id: number; name: string; email: string | null; username: string | null; role: string };
  suggestion: (Emp & { why: string }) | null;
  candidates: number;
}

const empLabel = (e: Emp) => [e.name, e.employee_id, e.designation, e.department].filter(Boolean).join(' · ') + (e.is_active ? '' : ' (inactive)');
const initials = (n: string) => n.split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0]).join('').toUpperCase() || '?';

export const UnlinkedLoginsPopup: React.FC<{ token: string; onClose: () => void; onLinked?: () => void }> = ({ token, onClose, onLinked }) => {
  const [rows, setRows] = useState<Row[] | null>(null);
  const [emps, setEmps] = useState<Emp[]>([]);
  const [pick, setPick] = useState<Record<number, string>>({});
  const [busy, setBusy] = useState<number | 'all' | null>(null);
  const [error, setError] = useState('');
  const [done, setDone] = useState(0);
  useBackButtonClose(true, onClose);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(apiUrl('/api/employees/link-suggestions'), { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || 'Could not load the logins.');
        if (!alive) return;
        setRows(d.rows);
        setEmps(d.employees);
        setPick(Object.fromEntries(d.rows.filter((x: Row) => x.suggestion).map((x: Row) => [x.user.id, String(x.suggestion!.id)])));
      } catch (e: any) {
        if (alive) {
          setError(e.message);
          setRows([]);
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [token]);

  // An Employee already picked on another row isn't offered again.
  const taken = useMemo(() => new Set(Object.values(pick).filter(Boolean)), [pick]);

  const link = async (userId: number, empId: string): Promise<boolean> => {
    const r = await fetch(apiUrl(`/api/employees/${empId}/link-user`), {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ user_id: userId })
    });
    if (!r.ok) {
      const d = await r.json().catch(() => null);
      setError(d?.error || 'Could not link.');
      return false;
    }
    setRows((rs) => (rs || []).filter((x) => x.user.id !== userId));
    setEmps((es) => es.filter((e) => String(e.id) !== empId));
    setPick((p) => {
      const n = { ...p };
      delete n[userId];
      return n;
    });
    setDone((n) => n + 1);
    return true;
  };

  const linkOne = async (userId: number) => {
    const empId = pick[userId];
    if (!empId) return;
    setBusy(userId);
    setError('');
    if (await link(userId, empId)) onLinked?.();
    setBusy(null);
  };

  const ready = (rows || []).filter((x) => pick[x.user.id]);
  const linkAll = async () => {
    if (!ready.length) return;
    if (!(await confirmDialog(`Link ${ready.length} login${ready.length === 1 ? '' : 's'} to the employee shown next to each?`))) return;
    setBusy('all');
    setError('');
    for (const x of ready) {
      if (!(await link(x.user.id, pick[x.user.id]))) break;
    }
    setBusy(null);
    onLinked?.();
  };

  return createPortal(
    <div className="fixed inset-0 z-[95] liquid-glass-backdrop flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Unlinked logins"
        onClick={(e) => e.stopPropagation()}
        className="liquid-glass liquid-glass-in w-full sm:max-w-2xl rounded-t-[32px] sm:rounded-[32px] max-h-[90vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <span className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center text-blue-600 shrink-0">
            <Link2 className="w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1">
            <h3 className="text-base font-bold text-slate-900">Unlinked logins</h3>
            <p className="text-xs text-slate-500 leading-snug">
              Login accounts with no employee record linked — Employee Tracking and other HR pages show them as "No employee record". Check the employee next to each, then link.
            </p>
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 pb-3 space-y-2">
          {error && <div className="rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2">{error}</div>}
          {done > 0 && <div className="rounded-2xl bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs px-3 py-2">{done} linked.</div>}
          {rows === null ? (
            <div className="liquid-glass-inset rounded-2xl px-4 py-10 text-center text-sm text-slate-400">Loading…</div>
          ) : rows.length === 0 ? (
            <div className="liquid-glass-inset rounded-2xl px-4 py-10 text-center text-sm text-slate-500">Every login is linked to an employee.</div>
          ) : (
            rows.map((x) => {
              const sel = pick[x.user.id] || '';
              const options = emps.filter((e) => String(e.id) === sel || !taken.has(String(e.id)));
              const suggested = x.suggestion && String(x.suggestion.id) === sel;
              return (
                <div key={x.user.id} className="liquid-glass-inset rounded-2xl p-3">
                  <div className="flex items-center gap-2.5">
                    <span className="w-9 h-9 rounded-full bg-emerald-500 text-white text-xs font-bold flex items-center justify-center shrink-0">{initials(x.user.name || '?')}</span>
                    <div className="min-w-0 flex-1">
                      <p className="text-sm font-semibold text-slate-900 truncate">
                        {x.user.name}
                        {x.user.role !== 'user' && <span className="ml-1.5 text-[10px] font-bold uppercase text-violet-600">{x.user.role}</span>}
                      </p>
                      <p className="text-[11px] text-slate-500 truncate">{[x.user.username, x.user.email].filter(Boolean).join(' · ') || '—'}</p>
                    </div>
                    {suggested ? (
                      <span className="text-[10px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-full px-2 py-0.5 shrink-0">{x.suggestion!.why}</span>
                    ) : !sel && x.candidates > 1 ? (
                      <span className="text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5 shrink-0">{x.candidates} possible — pick one</span>
                    ) : null}
                  </div>
                  <div className="mt-2 flex items-center gap-2">
                    <SearchSelect
                      aria-label={`Employee for ${x.user.name}`}
                      value={sel}
                      onChange={(e) => setPick((p) => ({ ...p, [x.user.id]: e.target.value }))}
                      className="flex-1 min-w-0 py-2 px-3 bg-white border border-slate-200 rounded-xl text-sm text-slate-800"
                    >
                      <option value="">— Select employee —</option>
                      {options.map((e) => (
                        <option key={e.id} value={String(e.id)}>
                          {empLabel(e)}
                        </option>
                      ))}
                    </SearchSelect>
                    <button
                      type="button"
                      disabled={!sel || busy !== null}
                      onClick={() => void linkOne(x.user.id)}
                      className="liquid-glass-button rounded-full px-4 py-2 text-xs font-semibold inline-flex items-center gap-1.5 shrink-0 disabled:opacity-50"
                    >
                      <Link2 className="w-3.5 h-3.5" /> {busy === x.user.id ? 'Linking…' : 'Link'}
                    </button>
                  </div>
                </div>
              );
            })
          )}
        </div>

        {!!rows?.length && (
          <div className="px-5 pt-3 pb-5 border-t border-white/60 flex items-center justify-between gap-3">
            <p className="text-xs text-slate-500">
              {ready.length} of {rows.length} have an employee picked.
            </p>
            <button
              type="button"
              disabled={!ready.length || busy !== null}
              onClick={() => void linkAll()}
              className="liquid-glass-button rounded-full px-4 py-2 text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-50"
            >
              <Check className="w-4 h-4" /> {busy === 'all' ? 'Linking…' : `Link all picked (${ready.length})`}
            </button>
          </div>
        )}
      </div>
    </div>,
    document.body
  );
};
