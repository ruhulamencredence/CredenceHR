/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Office Attendance -> "Double punch": a machine punch within N minutes of
// the day's In is the same arrival tapped twice, not the Out (server:
// zkPunchRule.ts, GET/PUT /api/office-attendance/punch-rule). Everyone with
// Office Attendance sees it; changing it needs the "Double punch rule" layer.
// A change starts today — past days keep the rule they had.

import React, { useEffect, useState } from 'react';
import { Timer, Loader2 } from 'lucide-react';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';

export interface PunchRule {
  minutes: number;
  effective_from: string | null;
  history: { minutes: number; effective_from: string; by: string | null; at: string }[];
  max_minutes: number;
  can_edit: boolean;
}

export async function fetchPunchRule(token: string): Promise<PunchRule | null> {
  try {
    const res = await fetch(apiUrl('/api/office-attendance/punch-rule'), { headers: { Authorization: `Bearer ${token}` } });
    return res.ok ? await res.json() : null;
  } catch {
    return null;
  }
}

export const PunchRuleModal: React.FC<{ token: string; rule: PunchRule; onClose: () => void; onSaved: () => void }> = ({ token, rule, onClose, onSaved }) => {
  const [minutes, setMinutes] = useState(String(rule.minutes));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => setMinutes(String(rule.minutes)), [rule.minutes]);
  const n = Number(minutes);
  const valid = minutes.trim() !== '' && Number.isInteger(n) && n >= 0 && n <= rule.max_minutes;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/office-attendance/punch-rule'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ minutes: n })
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not save');
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popup
      title="Double punch"
      icon={<Timer className="w-4 h-4" />}
      size="md"
      onClose={busy ? () => {} : onClose}
      footer={
        rule.can_edit ? (
          <>
            <button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button>
            <button type="button" className={primaryBtn} onClick={() => void save()} disabled={busy || !valid || n === rule.minutes}>
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save from today
            </button>
          </>
        ) : (
          <button type="button" className={primaryBtn} onClick={onClose}>Close</button>
        )
      }
    >
      <div className="space-y-4 text-left">
        <p className="text-sm text-slate-600">
          Someone who taps the office machine twice on arrival used to get an Out a few seconds after the In. A machine punch this many minutes or less after the day's In is now taken as the same arrival — it stays on record, it just isn't the Out.
        </p>
        <div className="liquid-glass-inset rounded-[20px] px-4 py-3 text-sm text-slate-700">
          {rule.minutes > 0 ? (
            <>
              Now: a punch within <b>{rule.minutes} minute{rule.minutes === 1 ? '' : 's'}</b> of the In isn't the Out
              {rule.effective_from && <span className="text-slate-500"> · since {formatDate(rule.effective_from)}</span>}
            </>
          ) : (
            <>Now: off — any later punch is the Out.</>
          )}
        </div>
        {rule.can_edit && (
          <div>
            <label className={labelCls} htmlFor="punch-rule-minutes">Minutes after the In (0 = off)</label>
            <input id="punch-rule-minutes" type="number" inputMode="numeric" min={0} max={rule.max_minutes} step={1} className={inputCls} value={minutes} onChange={(e) => setMinutes(e.target.value)} />
            <p className="text-[11px] text-slate-500 mt-1">Starts today. Days before today keep the rule they had, so closed months and sent reports don't change. Salary, Present / Absent and late marks don't use the Out.</p>
          </div>
        )}
        {rule.history.length > 1 && (
          <div>
            <div className={labelCls}>Earlier</div>
            <ul className="text-xs text-slate-600 space-y-0.5">
              {rule.history.slice(1).map((h, i) => (
                <li key={i}>
                  {h.minutes > 0 ? `${h.minutes} min` : 'Off'} from {formatDate(h.effective_from)}
                  {h.by && <span className="text-slate-400"> · {h.by}</span>}
                </li>
              ))}
            </ul>
          </div>
        )}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};
