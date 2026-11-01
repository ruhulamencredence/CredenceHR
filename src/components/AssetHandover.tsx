/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Who an asset passed through, hand to hand:
//  - PersonPicker: "the employee themself / another Employee / someone
//    else (name + mobile)" — used on the Fulfill form (who received it) and
//    on the Return popup (who brings it back).
//  - ReturnAssetModal: My Asset -> Return. It goes back to the store keeper
//    who handed it over (POST /api/assets/assignments/:id/request-return).
//  - ReturnsToReceive + ReceiveReturnModal: that store keeper's (and Asset
//    Management's) list of items on their way back, and the Receive step
//    (POST /api/assets/assignments/:id/receive).
//  - AssetTimelineModal: the item's history (GET /api/assets/:id/timeline).
// Every popup uses the liquid-glass house style (CLAUDE.md).

import React, { useEffect, useState } from 'react';
import { X, Undo2, PackageCheck, History, Inbox } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { SearchSelect } from './Combobox';
import { Spinner } from './Spinner';

export interface PersonValue {
  kind: 'self' | 'employee' | 'other';
  employee_id: string;
  name: string;
  mobile: string;
}
export const SELF_PERSON: PersonValue = { kind: 'self', employee_id: '', name: '', mobile: '' };

interface PersonOption {
  id: number;
  name: string;
  employee_code: string;
  designation: string;
  department: string;
}

const authHeaders = (token: string): HeadersInit => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });
export const glassInput =
  'w-full text-sm px-3 py-2 bg-white/80 border border-slate-200 rounded-xl focus:ring-2 focus:ring-violet-500 focus:outline-none';
const label = 'block text-[11px] font-semibold text-slate-600 mb-1';

// The active Employees for the pickers, loaded once per popup.
function usePeople(token: string, enabled: boolean) {
  const [people, setPeople] = useState<PersonOption[] | null>(null);
  useEffect(() => {
    if (!enabled || people) return;
    fetch(apiUrl('/api/assets/people'), { headers: authHeaders(token) })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setPeople(Array.isArray(rows) ? rows : []))
      .catch(() => setPeople([]));
  }, [enabled, token, people]);
  return people;
}

export function personBody(p: PersonValue) {
  if (p.kind === 'employee') return { kind: 'employee', employee_id: Number(p.employee_id) || null };
  if (p.kind === 'other') return { kind: 'other', name: p.name.trim(), mobile: p.mobile.trim() };
  return { kind: 'self' };
}
// Returns an error to show, or null when the choice is complete.
export function personProblem(p: PersonValue, what: string): string | null {
  if (p.kind === 'employee' && !p.employee_id) return `${what}: pick the employee.`;
  if (p.kind === 'other' && !p.name.trim()) return `${what}: type the person's name.`;
  if (p.kind === 'other' && !p.mobile.trim()) return `${what}: type the person's mobile number.`;
  return null;
}

export function PersonPicker({
  token,
  value,
  onChange,
  selfLabel,
  otherLabel,
  pickLabel
}: {
  token: string;
  value: PersonValue;
  onChange: (v: PersonValue) => void;
  selfLabel: string;
  otherLabel: string;
  pickLabel: string;
}) {
  const people = usePeople(token, value.kind === 'employee');
  const choice = (kind: PersonValue['kind'], text: string) => (
    <label
      className={`flex items-center gap-2.5 rounded-xl border px-3 py-2 text-sm cursor-pointer transition-colors ${
        value.kind === kind || (kind === 'employee' && value.kind === 'other') ? 'border-violet-500 bg-violet-50/70' : 'border-slate-200 bg-white/70'
      }`}
    >
      <input
        type="radio"
        className="accent-violet-600"
        checked={value.kind === kind || (kind === 'employee' && value.kind === 'other')}
        onChange={() => onChange({ ...value, kind })}
      />
      {text}
    </label>
  );
  return (
    <div className="space-y-2">
      {choice('self', selfLabel)}
      {choice('employee', otherLabel)}
      {value.kind === 'employee' && (
        <div className="pl-1">
          <SearchSelect value={value.employee_id} onChange={(e) => onChange({ ...value, employee_id: e.target.value })} className={glassInput} aria-label={pickLabel}>
            <option value="">— Select employee —</option>
            {(people || []).map((o) => (
              <option key={o.id} value={o.id}>
                {[o.name, o.employee_code, o.designation, o.department].filter(Boolean).join(' · ')}
              </option>
            ))}
          </SearchSelect>
          {people === null && <p className="text-[11px] text-slate-400 mt-1">Loading employees…</p>}
          <button type="button" onClick={() => onChange({ ...value, kind: 'other' })} className="text-[11px] text-violet-700 underline mt-1">
            Not an employee? Type a name and mobile instead
          </button>
        </div>
      )}
      {value.kind === 'other' && (
        <div className="pl-1 space-y-2">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <input value={value.name} onChange={(e) => onChange({ ...value, name: e.target.value })} placeholder="Name" aria-label="Name" className={glassInput} />
            <input
              value={value.mobile}
              onChange={(e) => onChange({ ...value, mobile: e.target.value })}
              placeholder="Mobile"
              aria-label="Mobile"
              inputMode="tel"
              className={glassInput}
            />
          </div>
          <button type="button" onClick={() => onChange({ ...value, kind: 'employee' })} className="text-[11px] text-violet-700 underline">
            Pick an employee instead
          </button>
        </div>
      )}
    </div>
  );
}

function Chips({ value, options, onChange, name }: { value: string; options: [string, string][]; onChange: (v: string) => void; name: string }) {
  return (
    <div className="flex flex-wrap gap-1.5" role="radiogroup" aria-label={name}>
      {options.map(([k, text]) => (
        <button
          key={k}
          type="button"
          role="radio"
          aria-checked={value === k}
          onClick={() => onChange(k)}
          className={`px-3 py-1.5 rounded-full text-xs font-semibold border transition-colors ${
            value === k ? 'bg-violet-600 text-white border-violet-600' : 'bg-white/80 text-slate-600 border-slate-200 hover:border-violet-300'
          }`}
        >
          {text}
        </button>
      ))}
    </div>
  );
}

function GlassModal({ title, sub, onClose, busy, children, footer }: { title: string; sub?: React.ReactNode; onClose: () => void; busy?: boolean; children: React.ReactNode; footer?: React.ReactNode }) {
  useBackButtonClose(true, onClose);
  return (
    <div className="fixed inset-0 z-[90] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4" onClick={() => !busy && onClose()}>
      <div className="liquid-glass liquid-glass-in rounded-[32px] w-full max-w-lg max-h-[92vh] overflow-y-auto" onClick={(e) => e.stopPropagation()} role="dialog" aria-label={title}>
        <button type="button" onClick={onClose} disabled={busy} aria-label="Close" className="liquid-glass-chip absolute top-3.5 right-3.5 z-10 p-1.5 text-slate-600 hover:text-slate-900 rounded-full">
          <X className="w-4 h-4" />
        </button>
        <div className="px-5 sm:px-6 pt-5 pb-5 space-y-3.5">
          <div className="pr-8">
            <h2 className="text-base font-bold text-slate-900">{title}</h2>
            {sub && <p className="text-xs text-slate-500 mt-0.5">{sub}</p>}
          </div>
          {children}
          {footer && <div className="flex justify-end gap-2 pt-1">{footer}</div>}
        </div>
      </div>
    </div>
  );
}

const ErrorBox = ({ error }: { error: string | null }) =>
  error ? <div className="rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3.5 py-2.5">{error}</div> : null;

// ---------- Return (employee) ----------
export function ReturnAssetModal({
  token,
  assignmentId,
  itemLabel,
  givenBy,
  onClose,
  onDone
}: {
  token: string;
  assignmentId: number;
  itemLabel: string;
  givenBy?: string | null;
  onClose: () => void;
  onDone: () => void;
}) {
  const [reason, setReason] = useState<'not_needed' | 'replace_faulty' | 'leaving' | 'other'>('not_needed');
  const [condition, setCondition] = useState<'good' | 'damaged' | 'lost'>('good');
  const [via, setVia] = useState<PersonValue>(SELF_PERSON);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const send = async () => {
    const problem = personProblem(via, 'How it reaches the store');
    if (problem) return setError(problem);
    if ((reason === 'other' || condition !== 'good') && !note.trim()) return setError('Add a short note — what happened, or why.');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/assets/assignments/${assignmentId}/request-return`), {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ reason, condition, via: personBody(via), note: note.trim() || undefined })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send the return.');
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassModal
      title={`Return ${itemLabel}`}
      sub={givenBy ? <>Goes back to <b>{givenBy}</b>, who handed it over.</> : 'Goes back to the store (Asset Management).'}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="liquid-glass-chip px-4 py-2 text-sm font-semibold text-slate-700 rounded-full">
            Cancel
          </button>
          <button type="button" onClick={send} disabled={busy} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Spinner size={14} /> : <Undo2 className="w-4 h-4" />} Send return
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div>
        <span className={label}>Why</span>
        <Chips
          name="Why"
          value={reason}
          onChange={(v) => setReason(v as typeof reason)}
          options={[
            ['not_needed', 'Not needed'],
            ['replace_faulty', 'Replace — faulty'],
            ['leaving', 'Leaving'],
            ['other', 'Other']
          ]}
        />
      </div>
      <div>
        <span className={label}>Condition (as you see it)</span>
        <Chips
          name="Condition"
          value={condition}
          onChange={(v) => setCondition(v as typeof condition)}
          options={[
            ['good', 'Good'],
            ['damaged', 'Damaged'],
            ['lost', 'Lost']
          ]}
        />
      </div>
      <div>
        <span className={label}>How will it reach the store?</span>
        <PersonPicker token={token} value={via} onChange={setVia} selfLabel="I'll bring it myself" otherLabel="Sending it through someone" pickLabel="Sending through" />
      </div>
      <label className="block">
        <span className={label}>Note {reason === 'other' || condition !== 'good' ? '' : '(optional)'}</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className={glassInput} placeholder="e.g. Screen flickers — sending with today's site vehicle" />
      </label>
    </GlassModal>
  );
}

// ---------- Returns to receive (store keeper / Asset Management) ----------
export interface ReturnRow {
  assignment_id: number;
  asset_id: number;
  asset_tag: string;
  asset_name: string;
  employee_name: string | null;
  given_by_name: string | null;
  return_requested_at: string;
  return_reason: string | null;
  return_condition_said: string | null;
  return_via_kind: string | null;
  return_via_name: string | null;
  return_via_mobile: string | null;
  return_note: string | null;
  quantity?: number | string | null;
  unit?: string | null;
}

export function useReturnsToReceive(token: string) {
  const [rows, setRows] = useState<ReturnRow[]>([]);
  const [all, setAll] = useState(false);
  const load = async () => {
    try {
      const r = await fetch(apiUrl('/api/assets/returns-to-receive'), { headers: authHeaders(token) });
      const d = await r.json();
      if (r.ok) {
        setRows(d.rows || []);
        setAll(!!d.all);
      }
    } catch {
      /* the list just stays as it was */
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  return { rows, all, reload: load };
}

const fmtWhen = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const saidPill = (c?: string | null) =>
  c ? (
    <span className={`inline-block text-[11px] font-semibold rounded-full px-2 py-0.5 capitalize ${c === 'good' ? 'bg-emerald-50 text-emerald-700' : 'bg-amber-50 text-amber-700'}`}>{c}</span>
  ) : (
    <span className="text-slate-400">—</span>
  );
const viaText = (r: ReturnRow) => (r.return_via_kind === 'employee' || r.return_via_kind === 'other' ? `${r.return_via_name}${r.return_via_mobile ? ` · ${r.return_via_mobile}` : ''}` : 'Self');

export function ReturnsToReceive({ token, rows, all, onChanged, onHistory }: { token: string; rows: ReturnRow[]; all: boolean; onChanged: () => void; onHistory: (assetId: number) => void }) {
  const [receiving, setReceiving] = useState<ReturnRow | null>(null);
  return (
    <div className="bg-white rounded-2xl border border-slate-200 shadow-sm overflow-hidden">
      <div className="px-4 sm:px-5 py-3 border-b border-slate-100">
        <div className="text-sm font-bold text-slate-900">Returns to receive</div>
        <div className="text-xs text-slate-500">
          {all ? 'Every item on its way back to the store.' : 'Items you handed over that are coming back to you.'} Receive them when they reach the store.
        </div>
      </div>
      {rows.length === 0 ? (
        <div className="flex flex-col items-center gap-1.5 text-center py-10 text-slate-400">
          <Inbox className="w-6 h-6 text-slate-300" />
          <p className="text-xs font-semibold text-slate-500">Nothing on its way back right now.</p>
        </div>
      ) : (
        <ul className="divide-y divide-slate-100">
          {rows.map((r) => (
            <li key={r.assignment_id} className="px-4 sm:px-5 py-3 flex flex-col md:flex-row md:items-center gap-2 md:gap-4">
              <div className="min-w-0 md:w-[26%]">
                <div className="font-semibold text-sm text-slate-800 truncate">{r.asset_name}</div>
                <div className="text-xs text-slate-500">{r.asset_tag}</div>
              </div>
              <div className="text-xs text-slate-600 md:w-[20%]">
                <span className="text-slate-400 md:hidden">From: </span>
                {r.employee_name || '—'}
                <div className="text-[11px] text-slate-400">{fmtWhen(r.return_requested_at)}</div>
              </div>
              <div className="text-xs text-slate-600 md:w-[22%]">
                <span className="text-slate-400">Coming through: </span>
                {viaText(r)}
                {r.return_note && <div className="text-[11px] text-slate-400 truncate" title={r.return_note}>"{r.return_note}"</div>}
              </div>
              <div className="text-xs md:w-[12%]">
                <span className="text-slate-400 md:hidden">Said: </span>
                {saidPill(r.return_condition_said)}
              </div>
              <div className="flex gap-1.5 md:ml-auto">
                <button type="button" onClick={() => onHistory(r.asset_id)} className="px-2.5 py-1 text-xs font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" aria-label={`History of ${r.asset_tag}`}>
                  History
                </button>
                <button type="button" onClick={() => setReceiving(r)} className="px-3 py-1 text-xs font-semibold rounded-lg bg-violet-600 text-white hover:bg-violet-700">
                  Receive
                </button>
              </div>
            </li>
          ))}
        </ul>
      )}
      {receiving && (
        <ReceiveReturnModal
          token={token}
          row={receiving}
          onClose={() => setReceiving(null)}
          onDone={() => {
            setReceiving(null);
            onChanged();
          }}
        />
      )}
    </div>
  );
}

export function ReceiveReturnModal({ token, row, onClose, onDone }: { token: string; row: ReturnRow; onClose: () => void; onDone: () => void }) {
  const said = row.return_condition_said;
  const [condition, setCondition] = useState<'good' | 'damaged' | 'lost'>(said === 'damaged' || said === 'lost' ? said : 'good');
  const [from, setFrom] = useState(row.return_via_kind === 'employee' || row.return_via_kind === 'other' ? row.return_via_name || '' : row.employee_name || '');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const goesTo = condition === 'good' ? 'back to stock (available)' : condition === 'damaged' ? 'to Maintenance' : 'marked disposed';

  const receive = async () => {
    if (!from.trim()) return setError('Who handed it to you?');
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/assets/assignments/${row.assignment_id}/receive`), {
        method: 'POST',
        headers: authHeaders(token),
        body: JSON.stringify({ condition, received_from: from.trim(), note: note.trim() || undefined })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not record the return.');
      onDone();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <GlassModal
      title={`Receive ${row.asset_name}`}
      sub={`${row.asset_tag} — returned by ${row.employee_name || 'the employee'}`}
      onClose={onClose}
      busy={busy}
      footer={
        <>
          <button type="button" onClick={onClose} disabled={busy} className="liquid-glass-chip px-4 py-2 text-sm font-semibold text-slate-700 rounded-full">
            Cancel
          </button>
          <button type="button" onClick={receive} disabled={busy} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold flex items-center gap-1.5 disabled:opacity-50">
            {busy ? <Spinner size={14} /> : <PackageCheck className="w-4 h-4" />} Mark received
          </button>
        </>
      }
    >
      <ErrorBox error={error} />
      <div className="liquid-glass-inset rounded-2xl px-4 py-3 text-xs text-slate-600 space-y-0.5">
        <div>
          Coming through: <b>{viaText(row)}</b>
        </div>
        <div>Employee said: {saidPill(row.return_condition_said)}</div>
        {row.return_reason && <div>Reason: {row.return_reason.replace(/_/g, ' ')}</div>}
        {row.return_note && <div>"{row.return_note}"</div>}
      </div>
      <label className="block">
        <span className={label}>Received from</span>
        <input value={from} onChange={(e) => setFrom(e.target.value)} maxLength={150} className={glassInput} aria-label="Received from" />
      </label>
      <div>
        <span className={label}>Condition checked</span>
        <Chips
          name="Condition checked"
          value={condition}
          onChange={(v) => setCondition(v as typeof condition)}
          options={[
            ['good', 'Good'],
            ['damaged', 'Damaged'],
            ['lost', 'Lost']
          ]}
        />
        <p className="text-[11px] text-slate-500 mt-1">The item goes {goesTo}.</p>
      </div>
      <label className="block">
        <span className={label}>Note (optional)</span>
        <textarea value={note} onChange={(e) => setNote(e.target.value)} rows={2} maxLength={500} className={glassInput} />
      </label>
    </GlassModal>
  );
}

// ---------- History ----------
interface TimelineEvent {
  at: string;
  kind: 'handed_over' | 'acknowledged' | 'return_sent' | 'received';
  title: string;
  detail: string;
}
const DOT: Record<TimelineEvent['kind'], string> = {
  handed_over: 'bg-violet-600',
  acknowledged: 'bg-sky-500',
  return_sent: 'bg-amber-500',
  received: 'bg-emerald-600'
};

export function AssetTimelineModal({ token, assetId, onClose }: { token: string; assetId: number; onClose: () => void }) {
  const [data, setData] = useState<{ asset: { asset_tag: string; name: string; status: string }; events: TimelineEvent[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetch(apiUrl(`/api/assets/${assetId}/timeline`), { headers: authHeaders(token) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load the history.');
        setData(d);
      })
      .catch((e) => setError(e.message));
  }, [assetId, token]);
  return (
    <GlassModal title={data ? `${data.asset.name} · ${data.asset.asset_tag}` : 'Asset history'} sub={data ? `Now: ${data.asset.status}` : undefined} onClose={onClose}>
      <ErrorBox error={error} />
      {!data && !error && (
        <div className="py-6 flex justify-center">
          <Spinner size={20} />
        </div>
      )}
      {data && data.events.length === 0 && <p className="text-xs text-slate-500">Nothing recorded yet.</p>}
      {data && data.events.length > 0 && (
        <ol className="liquid-glass-inset rounded-2xl px-4 py-3">
          {data.events.map((ev, i) => (
            <li key={i} className="relative pl-6 pb-3.5 last:pb-0">
              <span className={`absolute left-0.5 top-1 w-3 h-3 rounded-full ${DOT[ev.kind]}`} />
              {i < data.events.length - 1 && <span className="absolute left-[7px] top-4 bottom-0 w-px bg-violet-200" />}
              <div className="text-sm font-semibold text-slate-800">{ev.title}</div>
              <div className="text-[11px] text-slate-500">
                {fmtWhen(ev.at)}
                {ev.detail ? ` · ${ev.detail}` : ''}
              </div>
            </li>
          ))}
        </ol>
      )}
    </GlassModal>
  );
}

export function HistoryButton({ onClick, label: text = 'History', small }: { onClick: () => void; label?: string; small?: boolean }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={`inline-flex items-center gap-1 ${small ? 'px-2 py-1 text-[11px]' : 'px-2.5 py-1 text-xs'} font-medium rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50`}
    >
      <History className="w-3 h-3" /> {text}
    </button>
  );
}
