/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Office Attendance -> Unlinked PINs (Office Attendance's "Link Device PINs"
// layer). A ZKTeco punch only reaches someone's attendance through their
// Employee record's Device PIN — a PIN no Employee carries is punched in
// every day yet that person still reads Absent. This lists those PINs (with a
// likely Employee when their Employee ID matches) and links one in a click.

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Fingerprint, Link2, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

export interface UnlinkedPin {
  pin: string;
  punches: number;
  days: number;
  first_punch: string;
  last_punch: string;
  devices: string[];
  suggestion: { id: number; name: string; employee_code: string | null } | null;
}
export interface PinlessEmployee {
  id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  has_login: boolean;
}

const when = (v: string) => {
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true });
};

export const UnlinkedPinsModal: React.FC<{
  token: string;
  data: { unlinked: UnlinkedPin[]; employees_without_pin: PinlessEmployee[]; days: number };
  onClose: () => void;
  onLinked: () => void;
}> = ({ token, data, onClose, onLinked }) => {
  const [choice, setChoice] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ ok: boolean; text: string } | null>(null);

  useEffect(() => {
    const init: Record<string, string> = {};
    for (const u of data.unlinked) if (u.suggestion) init[u.pin] = String(u.suggestion.id);
    setChoice(init);
  }, [data]);

  const link = async (pin: string) => {
    const employeeId = Number(choice[pin]);
    if (!employeeId) return;
    setBusy(pin);
    setMsg(null);
    try {
      const res = await fetch(apiUrl('/api/office-attendance/link-pin'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ pin, employee_id: employeeId })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not link the PIN.');
      const name = data.employees_without_pin.find((e) => e.id === employeeId)?.name || 'the employee';
      setMsg({ ok: true, text: `PIN ${pin} linked to ${name} — their punches now count.` });
      onLinked();
    } catch (e: any) {
      setMsg({ ok: false, text: e.message });
    } finally {
      setBusy(null);
    }
  };

  return createPortal(
    <div className="liquid-glass-backdrop fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 max-h-[85vh] flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Fingerprint className="w-4 h-4 text-emerald-600" /> Unlinked device PINs
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Punched on a device in the last {data.days} days, but no Employee has the PIN — so these punches count for nobody. Pick
                who each one is.
              </p>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center text-slate-500 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          {msg && (
            <div className={`mt-3 text-xs px-3 py-2 rounded-xl ${msg.ok ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'}`}>{msg.text}</div>
          )}
          <div className="liquid-glass-inset rounded-2xl mt-4 overflow-y-auto">
            {data.unlinked.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-10">Every PIN with punches belongs to an Employee.</p>
            ) : (
              <table className="w-full text-xs">
                <thead className="text-slate-500">
                  <tr>
                    <th className="px-3 py-2 text-left">PIN</th>
                    <th className="px-3 py-2 text-left">Punches</th>
                    <th className="px-3 py-2 text-left">Last punch</th>
                    <th className="px-3 py-2 text-left">Employee</th>
                    <th className="px-3 py-2" />
                  </tr>
                </thead>
                <tbody>
                  {data.unlinked.map((u) => (
                    <tr key={u.pin} className="border-t border-white/60 align-middle">
                      <td className="px-3 py-2 font-mono font-semibold text-slate-800">{u.pin}</td>
                      <td className="px-3 py-2 text-slate-600">
                        {u.punches} on {u.days} day{u.days === 1 ? '' : 's'}
                        {u.devices.length > 0 && <div className="text-[10px] text-slate-400">{u.devices.join(', ')}</div>}
                      </td>
                      <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{when(u.last_punch)}</td>
                      <td className="px-3 py-2 min-w-[220px]">
                        <select
                          value={choice[u.pin] || ''}
                          onChange={(e) => setChoice((c) => ({ ...c, [u.pin]: e.target.value }))}
                          className="w-full px-2 py-1.5 bg-white/80 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-emerald-200 focus:outline-none"
                        >
                          <option value="">Pick employee…</option>
                          {data.employees_without_pin.map((e) => (
                            <option key={e.id} value={e.id}>
                              {e.name}
                              {e.employee_code ? ` (${e.employee_code})` : ''}
                              {u.suggestion?.id === e.id ? ' — matches Employee ID' : ''}
                            </option>
                          ))}
                        </select>
                      </td>
                      <td className="px-3 py-2 text-right">
                        <button
                          type="button"
                          disabled={!choice[u.pin] || busy === u.pin}
                          onClick={() => link(u.pin)}
                          className="liquid-glass-button rounded-full px-3.5 py-1.5 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-50"
                        >
                          {busy === u.pin ? <Spinner size={12} /> : <Link2 className="w-3 h-3" />} Link
                        </button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-[11px] text-slate-500 mt-3">
            {data.employees_without_pin.filter((e) => e.has_login).length} active employee
            {data.employees_without_pin.filter((e) => e.has_login).length === 1 ? '' : 's'} with a login still have no Device PIN — their office
            punches can't count until one is set (here, or in Employees → Edit → Device PIN).
          </p>
        </div>
      </div>
    </div>,
    document.body
  );
};
