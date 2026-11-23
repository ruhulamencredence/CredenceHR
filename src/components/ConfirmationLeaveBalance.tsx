/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { CalendarDays } from 'lucide-react';
import { apiUrl } from '../lib/api';

// Shown to HR right after an Employee's Job Base moves from Probation to
// something else (Employees -> Edit): the Leave days to add now
// (GET /api/leave-joiner/confirmation-preview, Leave Manage layer
// "joiner_rules"). The proposal is pro-rata from the confirmation month; HR
// can change every number before "Add balance". Skipping leaves the balance
// as it is. House popup style: liquid glass.
export interface ConfirmationItem {
  category_key: string;
  label: string;
  full: number;
  months: number;
  used: number;
  current: number;
  add: number;
  note?: string;
}
export interface ConfirmationPreview {
  employee: { id: number; name: string; employee_id: string | null; joining_date: string | null };
  confirmation_date: string;
  months: number;
  items: ConfirmationItem[];
}

export const ConfirmationLeaveBalance: React.FC<{
  token: string;
  preview: ConfirmationPreview;
  onClose: () => void;
  onDone: (text: string) => void;
}> = ({ token, preview, onClose, onDone }) => {
  const [adds, setAdds] = useState<Record<string, string>>(Object.fromEntries(preview.items.map((i) => [i.category_key, String(i.add)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const apply = async () => {
    const items = preview.items.map((i) => ({ category_key: i.category_key, add: Number(adds[i.category_key]) }));
    if (items.some((i) => !Number.isFinite(i.add) || i.add < 0)) {
      setError('Each amount must be 0 or more days.');
      return;
    }
    setBusy(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/leave-joiner/confirmation-apply'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ employee_id: preview.employee.id, items })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add the balance.');
      const added = (data.added || []).map((a: any) => `${a.category_key === 'casual' ? 'Casual' : 'Sick'} +${a.added}`).join(', ');
      onDone(added ? `Leave balance added for ${preview.employee.name}: ${added}.` : `No leave balance was added for ${preview.employee.name}.`);
    } catch (e: any) {
      setError(e.message || 'Could not add the balance.');
      setBusy(false);
    }
  };

  return (
    <div className="liquid-glass-backdrop fixed inset-0 z-[1000] flex items-center justify-center p-4" role="presentation">
      <div className="w-full max-w-lg" role="dialog" aria-modal="true" aria-label="Confirmation: Leave balance">
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 max-h-[90vh] overflow-y-auto">
          <div className="flex items-start gap-3.5">
            <div className="liquid-glass-inset w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 text-violet-600">
              <CalendarDays className="w-5 h-5" />
            </div>
            <div className="min-w-0 pt-0.5">
              <h3 className="text-base font-bold text-slate-900">Confirmation: set the Leave balance</h3>
              <p className="mt-1 text-sm text-slate-600">
                {preview.employee.name}
                {preview.employee.employee_id ? ` (${preview.employee.employee_id})` : ''}
                {preview.employee.joining_date ? ` · joined ${preview.employee.joining_date}` : ''} · confirmed {preview.confirmation_date}.
                <br />
                {preview.months} month{preview.months === 1 ? '' : 's'} of the year left, so the days are worked out over 12 months. You can change any number.
              </p>
            </div>
          </div>
          <div className="liquid-glass-inset rounded-2xl mt-3 p-3 overflow-x-auto">
            <table className="w-full text-[12.5px] text-slate-800">
              <thead>
                <tr className="text-[10.5px] uppercase text-slate-500 text-left">
                  <th className="py-1 pr-2">Type</th>
                  <th className="py-1 pr-2">Now</th>
                  <th className="py-1 pr-2">Worked out</th>
                  <th className="py-1 pr-2">Add</th>
                  <th className="py-1">After</th>
                </tr>
              </thead>
              <tbody>
                {preview.items.map((i) => {
                  const add = Number(adds[i.category_key]);
                  return (
                    <tr key={i.category_key} className="border-t border-slate-300/40">
                      <td className="py-2 pr-2 font-semibold">{i.label}</td>
                      <td className="py-2 pr-2">{i.current}</td>
                      <td className="py-2 pr-2 text-slate-500">
                        {i.note ? i.note : `${i.full} × ${i.months} ÷ 12${i.used ? ` − ${i.used} used` : ''}`}
                      </td>
                      <td className="py-2 pr-2">
                        <input
                          type="number"
                          min={0}
                          step={0.5}
                          value={adds[i.category_key]}
                          onChange={(e) => setAdds((p) => ({ ...p, [i.category_key]: e.target.value }))}
                          className="w-16 px-2 py-1 text-center font-bold text-orange-800 bg-white border border-orange-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-orange-400"
                        />
                      </td>
                      <td className="py-2 font-bold">{Number.isFinite(add) ? i.current + add : i.current}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="mt-2 text-xs text-slate-500">Leave already taken this year is already off the balance.</p>
          {error && <p className="mt-2 text-xs text-rose-600">{error}</p>}
          <div className="mt-4 flex gap-2.5">
            <button type="button" onClick={onClose} disabled={busy} className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700">
              Later
            </button>
            <button type="button" onClick={apply} disabled={busy} className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold">
              {busy ? 'Adding…' : 'Add balance'}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
};
