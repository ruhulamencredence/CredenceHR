/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Module Access -> Remote Attendance: the Projects one account may check in
// at (user_attendance_projects, AttendanceProjects.ts). "Any project" = no
// list; "Only these projects" = the chips below, each with optional From / To
// dates (a temporary site). Plus the Users bulk bar's popup that adds, removes
// or sets the same Projects for many accounts at once.

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { CalendarDays, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { SearchSelect } from './Combobox';
import { Spinner } from './Spinner';
import { useBackButtonClose } from '../lib/useBackButtonClose';

export interface AttendanceProjectPick {
  project_id: number;
  project_name?: string;
  valid_from: string | null;
  valid_to: string | null;
  active?: boolean;
}
type ProjectOption = { id: number; project_name: string };
type BranchInfo = { branch_name: string | null; project_id: number | null; project_name: string | null };

const fmt = (d: string | null) => {
  if (!d) return '';
  const t = new Date(`${d}T00:00:00`);
  return isNaN(t.getTime()) ? d : t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short' });
};
const span = (p: AttendanceProjectPick) =>
  p.valid_from && p.valid_to ? `${fmt(p.valid_from)} – ${fmt(p.valid_to)}` : p.valid_from ? `from ${fmt(p.valid_from)}` : p.valid_to ? `until ${fmt(p.valid_to)}` : '';

// The From / To popup for one Project (house liquid-glass card).
const DatesPopup: React.FC<{
  pick: AttendanceProjectPick;
  name: string;
  onClose: () => void;
  onSave: (from: string | null, to: string | null) => void;
  onRemove: () => void;
}> = ({ pick, name, onClose, onSave, onRemove }) => {
  const [from, setFrom] = useState(pick.valid_from || '');
  const [to, setTo] = useState(pick.valid_to || '');
  useBackButtonClose(true, onClose);
  const bad = !!(from && to && to < from);
  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 mx-auto max-w-sm">
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <div className="text-base font-bold text-slate-900 truncate">{name}</div>
              <div className="text-xs text-slate-500 mt-0.5">Leave both empty for always. Past the To date it stops counting by itself.</div>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-2 gap-2 mt-4">
            <label className="text-[11px] font-semibold text-slate-500">
              From
              <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} className="mt-1 w-full text-sm px-3 py-2 rounded-xl bg-white/80 border border-white" />
            </label>
            <label className="text-[11px] font-semibold text-slate-500">
              To
              <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className="mt-1 w-full text-sm px-3 py-2 rounded-xl bg-white/80 border border-white" />
            </label>
          </div>
          {bad && <p className="text-xs text-rose-600 mt-2">To can't be before From.</p>}
          <div className="flex items-center gap-2 mt-5">
            <button type="button" onClick={onRemove} className="px-4 py-2 rounded-full text-sm font-semibold text-rose-600 bg-white/70">
              Remove
            </button>
            <button type="button" disabled={bad} onClick={() => onSave(from || null, to || null)} className="liquid-glass-button rounded-full flex-1 py-2 text-sm font-semibold disabled:opacity-50">
              Save
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};

// Chips + type-to-add for a list of picks (used by both the editor and the bulk popup).
const PickList: React.FC<{
  picks: AttendanceProjectPick[];
  projects: ProjectOption[];
  disabled?: boolean;
  onChange: (next: AttendanceProjectPick[]) => void;
}> = ({ picks, projects, disabled, onChange }) => {
  const [editing, setEditing] = useState<number | null>(null);
  const nameOf = (id: number) => picks.find((p) => p.project_id === id)?.project_name || projects.find((p) => p.id === id)?.project_name || `Project #${id}`;
  const open = editing != null ? picks.find((p) => p.project_id === editing) : null;
  return (
    <div>
      <SearchSelect
        value=""
        disabled={disabled}
        onChange={(e) => {
          const id = Number(e.target.value);
          if (id && !picks.some((p) => p.project_id === id)) onChange([...picks, { project_id: id, project_name: nameOf(id), valid_from: null, valid_to: null, active: true }]);
        }}
        className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
      >
        <option value="">— Type to add a project —</option>
        {projects
          .filter((p) => !picks.some((x) => x.project_id === p.id))
          .map((p) => (
            <option key={p.id} value={p.id}>
              {p.project_name}
            </option>
          ))}
      </SearchSelect>
      {picks.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-2">
          {picks.map((p) => {
            const ended = p.active === false && !!p.valid_to;
            const later = p.active === false && !ended;
            return (
              <span
                key={p.project_id}
                className={`inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-[11.5px] font-semibold ${
                  ended ? 'bg-slate-100 text-slate-400 line-through' : later || p.valid_from || p.valid_to ? 'bg-amber-50 text-amber-800' : 'bg-violet-50 text-violet-700'
                }`}
              >
                <button type="button" disabled={disabled} onClick={() => setEditing(p.project_id)} className="inline-flex items-center gap-1" title="Set From / To dates">
                  {nameOf(p.project_id)}
                  {span(p) && <span className="font-normal">· {span(p)}</span>}
                  <CalendarDays className="w-3 h-3 opacity-60" />
                </button>
                <button
                  type="button"
                  disabled={disabled}
                  onClick={() => onChange(picks.filter((x) => x.project_id !== p.project_id))}
                  className="w-5 h-5 rounded-full flex items-center justify-center hover:bg-black/5"
                  aria-label={`Remove ${nameOf(p.project_id)}`}
                >
                  <X className="w-3 h-3" />
                </button>
              </span>
            );
          })}
        </div>
      )}
      {open && (
        <DatesPopup
          pick={open}
          name={nameOf(open.project_id)}
          onClose={() => setEditing(null)}
          onRemove={() => {
            setEditing(null);
            onChange(picks.filter((x) => x.project_id !== open.project_id));
          }}
          onSave={(from, to) => {
            setEditing(null);
            const today = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());
            onChange(picks.map((x) => (x.project_id === open.project_id ? { ...x, valid_from: from, valid_to: to, active: (!from || from <= today) && (!to || to >= today) } : x)));
          }}
        />
      )}
    </div>
  );
};

// One account's list — saved as soon as it changes.
export const AttendanceProjectsEditor: React.FC<{
  token: string;
  userId: number;
  projects: ProjectOption[];
  disabled?: boolean;
  onChanged?: () => void;
}> = ({ token, userId, projects, disabled, onChanged }) => {
  const [picks, setPicks] = useState<AttendanceProjectPick[] | null>(null);
  // 'any' | 'list' (Only these projects) | 'branch' (Their Branch's Project).
  const [mode, setMode] = useState<'any' | 'list' | 'branch'>('any');
  const limited = mode === 'list';
  const [branch, setBranch] = useState<BranchInfo | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const apply = (d: any) => {
    setPicks(d.projects || []);
    setBranch(d.branch || null);
    setMode(d.by_branch ? 'branch' : (d.projects || []).length > 0 ? 'list' : 'any');
  };
  useEffect(() => {
    let alive = true;
    fetch(apiUrl(`/api/users/${userId}/attendance-projects`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => {
        if (!alive) return;
        if (!ok) throw new Error(d?.error || 'Could not load');
        apply(d);
      })
      .catch((e) => alive && (setError(e.message), setPicks([])));
    return () => {
      alive = false;
    };
  }, [token, userId]);

  const save = async (next: AttendanceProjectPick[] | 'branch', keepList = false) => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl(`/api/users/${userId}/attendance-projects`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(next === 'branch' ? { by_branch: true } : { projects: next.map((p) => ({ project_id: p.project_id, valid_from: p.valid_from, valid_to: p.valid_to })) })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save');
      if (keepList) {
        setPicks(d.projects || []);
        setBranch(d.branch || null);
      } else apply(d);
      onChanged?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (!picks) return <div className="py-2"><Spinner size={14} /></div>;
  return (
    <div className="space-y-2">
      <span className="text-[11px] text-slate-500">Allowed projects for check-in</span>
      <div className="flex rounded-full bg-slate-100 p-0.5 text-[11px] font-semibold" role="radiogroup" aria-label="Allowed projects for check-in">
        {(
          [
            ['any', 'Any project'],
            ['list', 'Only these projects'],
            ['branch', 'Their Branch']
          ] as const
        ).map(([v, label]) => (
          <button
            key={label}
            type="button"
            role="radio"
            aria-checked={mode === v}
            disabled={disabled || busy}
            onClick={() => {
              if (v === mode) return;
              const was = mode;
              setMode(v);
              if (v === 'branch') void save('branch', true);
              // From "Their Branch": the stored list (if any) counts again.
              else if (v === 'list') {
                if (was === 'branch') void save(picks, true);
              } else if (picks.length || was === 'branch') void save([]);
            }}
            className={`flex-1 py-1.5 rounded-full transition-colors ${mode === v ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
          >
            {label}
          </button>
        ))}
      </div>
      {limited ? (
        <>
          <PickList picks={picks} projects={projects} disabled={disabled || busy} onChange={(next) => void save(next)} />
          {!picks.some((p) => p.active !== false) && (
            <p className="text-[11px] text-amber-700">{picks.length ? 'None of these counts today — this person can’t check in anywhere until one starts.' : 'Add at least one project.'}</p>
          )}
        </>
      ) : mode === 'branch' ? (
        branch?.project_id ? (
          <p className="text-[11px] text-slate-600">
            Only <span className="font-semibold text-violet-700">{branch.project_name}</span> — the project of their Branch “{branch.branch_name}”. Changes by itself when their Branch changes.
          </p>
        ) : (
          <p className="text-[11px] text-amber-700">
            {branch?.branch_name
              ? `Their Branch “${branch.branch_name}” has no project linked (Admin Panel → Branches) — they can’t check in anywhere until it has one.`
              : 'No Branch in their Employee record — they can’t check in anywhere until one is set.'}
          </p>
        )
      ) : (
        <p className="text-[11px] text-slate-500">Any project this person can otherwise see.</p>
      )}
      {busy && <Spinner size={12} />}
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
    </div>
  );
};

// Users bulk bar: the same Projects for many accounts at once.
export const BulkAttendanceProjectsPopup: React.FC<{
  token: string;
  userIds: number[];
  projects: ProjectOption[];
  onClose: () => void;
  onDone: (msg: string) => void;
}> = ({ token, userIds, projects, onClose, onDone }) => {
  const [mode, setMode] = useState<'add' | 'remove' | 'replace' | 'branch'>('add');
  const [picks, setPicks] = useState<AttendanceProjectPick[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useBackButtonClose(true, onClose);
  const apply = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/users/attendance-projects/bulk'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_ids: userIds, mode, projects: picks.map((p) => ({ project_id: p.project_id, valid_from: p.valid_from, valid_to: p.valid_to })) })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save');
      onDone(`Check-in projects updated for ${d.changed} account${d.changed === 1 ? '' : 's'}${d.skipped?.length ? ` · skipped ${d.skipped.join(', ')}` : ''}.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return createPortal(
    <div className="fixed inset-0 z-[80]">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 mx-auto max-w-md">
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-bold text-slate-900">Check-in projects</div>
              <div className="text-xs text-slate-500 mt-0.5">For {userIds.length} selected account{userIds.length === 1 ? '' : 's'} (Remote Attendance).</div>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex rounded-full bg-white/60 p-0.5 text-xs font-semibold mt-4" role="radiogroup" aria-label="What to do">
            {(
              [
                ['add', 'Add'],
                ['remove', 'Remove'],
                ['replace', 'Make it the list'],
                ['branch', 'Their Branch']
              ] as const
            ).map(([k, label]) => (
              <button
                key={k}
                type="button"
                role="radio"
                aria-checked={mode === k}
                onClick={() => setMode(k)}
                className={`flex-1 py-1.5 rounded-full ${mode === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}
              >
                {label}
              </button>
            ))}
          </div>
          <p className="text-[11px] text-slate-500 mt-2">
            {mode === 'add'
              ? 'Adds these to each person’s list (dates of one already there are updated).'
              : mode === 'remove'
              ? 'Takes these off each person’s list.'
              : mode === 'branch'
              ? 'Each person checks in only at the project of their own Branch (Employees → Branch, linked in Admin Panel → Branches). It follows their Branch when it changes.'
              : 'Each person’s list becomes exactly these — empty means Any project.'}
          </p>
          {mode !== 'branch' && (
            <div className="liquid-glass-inset rounded-2xl p-3 mt-3">
              <PickList picks={picks} projects={projects} disabled={busy} onChange={setPicks} />
            </div>
          )}
          {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
          <button
            type="button"
            disabled={busy || (mode !== 'replace' && mode !== 'branch' && picks.length === 0)}
            onClick={() => void apply()}
            className="liquid-glass-button rounded-full w-full py-2.5 text-sm font-semibold mt-4 disabled:opacity-50"
          >
            {busy ? 'Saving…' : 'Apply'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};
