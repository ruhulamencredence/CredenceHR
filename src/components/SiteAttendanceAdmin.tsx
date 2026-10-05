/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Office Attendance -> "Site Attendance (Supervisor)": the HR
// side of the supervisor muster roll (SiteAttendanceRoutes.ts, supervisor
// screen in TeamAttendance.tsx).
//   Today     — every team for a date: submitted or not, P/L/A/LV counts,
//               location check; open any sheet to correct it.
//   Review    — sheets waiting for approval (only when approval is on).
//   Register  — monthly muster register (person x day), Excel export.
//   Teams     — teams, their supervisor / backup, site and members.
//   Settings  — approval, photo / location requirements, back-dating window.
//
// OfficeAttendanceHub switches between this and the ZKTeco device view.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { CalendarDays, CheckCircle2, ClipboardCheck, Download, Fingerprint, MapPin, Pencil, Plus, Settings, Trash2, Users } from 'lucide-react';
import { Spinner } from './Spinner';
import { OfficeAttendancePanel } from './OfficeAttendancePanel';
import { SheetEditor, SheetStatusChip, SiteSheet, Counts } from './TeamAttendance';
import { useHrApi, Modal, Notice, fmtDate, monthLabel, inputCls, labelCls, btnPrimary, btnGhost } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

interface TeamMember {
  employee_id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  has_login: boolean;
}
interface Team {
  id: number;
  name: string;
  project_id: number | null;
  project_name: string | null;
  site_location: string | null;
  supervisor_user_id: number;
  supervisor_name: string | null;
  backup_user_id: number | null;
  backup_name: string | null;
  lat: number | null;
  lng: number | null;
  radius_m: number | null;
  has_site_circle: boolean;
  is_active: boolean;
  members: TeamMember[];
}
interface TeamsData {
  teams: Team[];
  employees: (TeamMember & { team_id: number | null; team_name: string | null; department: string | null })[];
  users: { id: number; name: string; email: string | null }[];
  projects: { id: number; name: string; has_location: boolean }[];
}
interface SettingsData {
  require_approval: boolean;
  require_photo: boolean;
  require_location: boolean;
  backdate_days: number;
  reminder_time: string;
}
type Msg = { type: 'success' | 'error'; text: string } | null;

const today = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
const CountsLine: React.FC<{ c: Counts }> = ({ c }) => (
  <span className="inline-flex gap-2 font-semibold text-[11px]">
    <span className="text-emerald-700">P {c.present}</span>
    <span className="text-amber-700">L {c.late}</span>
    <span className="text-rose-700">A {c.absent}</span>
    <span className="text-sky-700">LV {c.leave}</span>
    {c.unmarked > 0 && <span className="text-slate-400">– {c.unmarked}</span>}
  </span>
);

// Opens one team's sheet for a date, editable by HR.
const SheetModal: React.FC<{ token: string; teamId: number; date: string; title: string; onClose: () => void; onChanged: () => void }> = ({
  token,
  teamId,
  date: initial,
  title,
  onClose,
  onChanged
}) => {
  const [date, setDate] = useState(initial);
  return (
    <Modal title={title} onClose={onClose} wide>
      <SheetEditor key={date} token={token} teamId={teamId} date={date} onDateChange={setDate} onSaved={onChanged} hrMode />
    </Modal>
  );
};

// ---------------------------- Today ----------------------------
const TodayView: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [date, setDate] = useState(today());
  const [data, setData] = useState<any>(null);
  const [open, setOpen] = useState<{ id: number; name: string } | null>(null);
  const load = useCallback(() => {
    api
      .get(`/api/site-attendance/overview?date=${date}`)
      .then(setData)
      .catch(() => setData({ teams: [], total: null }));
  }, [api, date]);
  useEffect(() => {
    load();
  }, [load]);
  if (!data) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const t = data.total;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-2 flex-wrap">
        <input type="date" value={date} max={today()} onChange={(e) => e.target.value && setDate(e.target.value)} className={`${inputCls} !w-auto`} />
        {data.pending_review > 0 && <span className="text-xs font-semibold text-amber-700">{data.pending_review} sheet(s) waiting for review</span>}
      </div>
      {t && (
        <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
          {[
            ['Teams submitted', `${t.submitted}/${t.teams}`, 'text-slate-800'],
            ['Present', t.present, 'text-emerald-700'],
            ['Late', t.late, 'text-amber-700'],
            ['Absent', t.absent, 'text-rose-700'],
            ['Leave', t.leave, 'text-sky-700'],
            ['Not marked', t.unmarked, 'text-slate-500']
          ].map(([label, v, cls]) => (
            <div key={label as string} className="rounded-xl border border-slate-200 bg-white p-3">
              <div className="text-[10px] font-semibold text-slate-500">{label}</div>
              <div className={`text-lg font-bold ${cls}`}>{v}</div>
            </div>
          ))}
        </div>
      )}
      <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="bg-slate-50 text-slate-500">
            <tr>
              <th className="text-left px-3 py-2">Team</th>
              <th className="text-left px-3 py-2">Supervisor</th>
              <th className="text-left px-3 py-2">Status</th>
              <th className="text-left px-3 py-2">Counts</th>
              <th className="text-left px-3 py-2">Location</th>
              <th />
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-100">
            {data.teams.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-6 text-center text-slate-400">
                  No teams yet — create one under Teams.
                </td>
              </tr>
            )}
            {data.teams.map((tm: any) => (
              <tr key={tm.id}>
                <td className="px-3 py-2">
                  <div className="font-semibold text-slate-800">{tm.name}</div>
                  <div className="text-[10px] text-slate-500">{[tm.project_name, tm.site_location].filter(Boolean).join(' · ') || '—'} · {tm.member_count} people</div>
                </td>
                <td className="px-3 py-2">{tm.supervisor_name || '—'}</td>
                <td className="px-3 py-2">
                  <SheetStatusChip sheet={tm.sheet} />
                </td>
                <td className="px-3 py-2">{tm.sheet ? <CountsLine c={tm.counts} /> : <span className="text-slate-400">—</span>}</td>
                <td className="px-3 py-2">
                  {tm.sheet?.distance_m != null ? (
                    <span className={tm.sheet.outside_site ? 'text-rose-600 font-semibold' : 'text-slate-600'}>
                      {tm.sheet.distance_m} m{tm.sheet.outside_site ? ' — outside' : ''}
                    </span>
                  ) : tm.sheet ? (
                    <span className="text-slate-400">{tm.sheet.lat != null ? 'attached' : 'none'}</span>
                  ) : (
                    '—'
                  )}
                </td>
                <td className="px-3 py-2 text-right">
                  <button type="button" className={btnGhost} onClick={() => setOpen({ id: tm.id, name: tm.name })}>
                    {tm.sheet ? 'Open' : 'Mark'}
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {open && <SheetModal token={token} teamId={open.id} date={date} title={open.name} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
};

// ---------------------------- Review ----------------------------
const ReviewView: React.FC<{ token: string; requireApproval: boolean }> = ({ token, requireApproval }) => {
  const api = useHrApi(token);
  const [status, setStatus] = useState('submitted');
  const [rows, setRows] = useState<(SiteSheet & { team_name: string; counts: Counts })[] | null>(null);
  const [picked, setPicked] = useState<Set<number>>(new Set());
  const [open, setOpen] = useState<{ team: number; date: string; name: string } | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const load = useCallback(() => {
    api
      .get(`/api/site-attendance/sheets?status=${status}`)
      .then((d) => setRows(d.sheets))
      .catch(() => setRows([]));
    setPicked(new Set());
  }, [api, status]);
  useEffect(() => {
    load();
  }, [load]);
  const approveAll = async () => {
    try {
      const d = await api.post('/api/site-attendance/sheets/review-bulk', { ids: [...picked] });
      setMsg({ type: 'success', text: `${d.approved} sheet(s) approved.` });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  return (
    <div className="space-y-3">
      {!requireApproval && (
        <div className="text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
          HR approval is off (Settings), so supervisors' sheets count straight away. You can still open and correct any sheet, or send one back.
        </div>
      )}
      <div className="flex items-center gap-2 flex-wrap">
        <select value={status} onChange={(e) => setStatus(e.target.value)} className={`${inputCls} !w-auto`}>
          <option value="submitted">Waiting for review</option>
          <option value="rejected">Sent back</option>
          <option value="approved">Confirmed</option>
          <option value="all">All</option>
        </select>
        {picked.size > 0 && (
          <button type="button" className={`${btnPrimary} !bg-emerald-600`} onClick={approveAll}>
            <CheckCircle2 className="w-3.5 h-3.5" /> Approve {picked.size} selected
          </button>
        )}
      </div>
      <Notice msg={msg} onClose={() => setMsg(null)} />
      {rows === null ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
          {rows.length === 0 && <div className="p-6 text-center text-xs text-slate-400">Nothing here.</div>}
          {rows.map((s) => (
            <div key={s.id} className="p-3 flex items-center gap-3">
              {s.status === 'submitted' && (
                <input
                  type="checkbox"
                  aria-label={`Select ${s.team_name} ${s.date}`}
                  checked={picked.has(s.id)}
                  onChange={(e) =>
                    setPicked((p) => {
                      const n = new Set(p);
                      if (e.target.checked) n.add(s.id);
                      else n.delete(s.id);
                      return n;
                    })
                  }
                />
              )}
              <div className="flex-1 min-w-0">
                <div className="text-xs font-semibold text-slate-800">
                  {s.team_name} · {fmtDate(s.date)}
                </div>
                <div className="text-[11px] text-slate-500 flex items-center gap-2 flex-wrap">
                  <CountsLine c={s.counts} /> · by {s.submitted_by_name || '—'}
                  {s.outside_site && <span className="text-rose-600 font-semibold">· {s.distance_m} m from site</span>}
                  {s.has_photo && <span>· photo</span>}
                  {s.note && <span className="italic">· “{s.note}”</span>}
                </div>
              </div>
              <SheetStatusChip sheet={s} />
              <button type="button" className={btnGhost} onClick={() => setOpen({ team: s.team_id, date: s.date, name: s.team_name })}>
                Open
              </button>
            </div>
          ))}
        </div>
      )}
      {open && <SheetModal token={token} teamId={open.team} date={open.date} title={open.name} onClose={() => setOpen(null)} onChanged={load} />}
    </div>
  );
};

// ---------------------------- Register ----------------------------
const CELL_CLS: Record<string, string> = {
  P: 'bg-emerald-50 text-emerald-700',
  L: 'bg-amber-50 text-amber-700',
  A: 'bg-rose-50 text-rose-700',
  LV: 'bg-sky-50 text-sky-700',
  W: 'bg-slate-100 text-slate-400',
  H: 'bg-violet-50 text-violet-600'
};
const RegisterView: React.FC<{ token: string; teams: Team[] }> = ({ token, teams }) => {
  const api = useHrApi(token);
  const [month, setMonth] = useState(today().slice(0, 7));
  const [teamId, setTeamId] = useState('');
  const [data, setData] = useState<any>(null);
  useEffect(() => {
    setData(null);
    api
      .get(`/api/site-attendance/register?month=${month}${teamId ? `&team_id=${teamId}` : ''}`)
      .then(setData)
      .catch(() => setData({ rows: [], days: 0 }));
  }, [api, month, teamId]);
  const days = useMemo(() => Array.from({ length: data?.days || 0 }, (_, i) => `${month}-${String(i + 1).padStart(2, '0')}`), [data, month]);
  const exportXlsx = () => {
    const sheet = [
      ['Team', 'Employee ID', 'Name', 'Designation', ...days.map((d) => Number(d.slice(8))), 'Present', 'Late', 'Absent', 'Leave', 'Not marked'],
      ...data.rows.map((r: any) => [
        r.team_name || '',
        r.employee_code || '',
        r.name,
        r.designation || '',
        ...days.map((d) => r.cells[d]?.code || ''),
        r.totals.present,
        r.totals.late,
        r.totals.absent,
        r.totals.leave,
        r.totals.not_marked
      ])
    ];
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(sheet), 'Muster register');
    XLSX.writeFile(wb, `site-attendance-${month}.xlsx`);
  };
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-2 flex-wrap">
        <input type="month" value={month} onChange={(e) => e.target.value && setMonth(e.target.value)} className={`${inputCls} !w-auto`} />
        <select value={teamId} onChange={(e) => setTeamId(e.target.value)} className={`${inputCls} !w-auto`}>
          <option value="">All teams</option>
          {teams.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button type="button" className={btnGhost} disabled={!data?.rows?.length} onClick={exportXlsx}>
          <Download className="w-3.5 h-3.5" /> Excel
        </button>
        <span className="text-[11px] text-slate-500">
          P present · L late · A absent · LV leave · W weekend · H holiday · faded = not yet approved
        </span>
      </div>
      {!data ? (
        <div className="py-10 flex justify-center"><Spinner /></div>
      ) : (
        <div className="rounded-xl border border-slate-200 bg-white overflow-auto max-h-[70vh]">
          <table className="text-[11px] border-collapse">
            <thead className="bg-slate-50 text-slate-500 sticky top-0 z-10">
              <tr>
                <th className="text-left px-2 py-1.5 sticky left-0 bg-slate-50 min-w-[160px]">{monthLabel(month)}</th>
                {days.map((d) => (
                  <th key={d} className="px-1 py-1.5 w-7 text-center">
                    {Number(d.slice(8))}
                  </th>
                ))}
                <th className="px-2">P</th>
                <th className="px-2">L</th>
                <th className="px-2">A</th>
                <th className="px-2">LV</th>
                <th className="px-2 whitespace-nowrap">Not marked</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.length === 0 && (
                <tr>
                  <td colSpan={days.length + 6} className="px-3 py-6 text-center text-slate-400">
                    No one yet.
                  </td>
                </tr>
              )}
              {data.rows.map((r: any) => (
                <tr key={r.employee_id} className="border-t border-slate-100">
                  <td className="px-2 py-1 sticky left-0 bg-white">
                    <div className="font-semibold text-slate-800 whitespace-nowrap">{r.name}</div>
                    <div className="text-[10px] text-slate-400 whitespace-nowrap">{[r.employee_code, r.team_name].filter(Boolean).join(' · ')}</div>
                  </td>
                  {days.map((d) => {
                    const c = r.cells[d];
                    return (
                      <td
                        key={d}
                        title={c ? [c.in && `In ${c.in}`, c.out && `Out ${c.out}`, !c.confirmed && 'Waiting for approval'].filter(Boolean).join(' · ') : ''}
                        className={`text-center font-bold ${c ? CELL_CLS[c.code] : ''} ${c && !c.confirmed ? 'opacity-40' : ''}`}
                      >
                        {c?.code || ''}
                      </td>
                    );
                  })}
                  <td className="px-2 text-center text-emerald-700 font-semibold">{r.totals.present}</td>
                  <td className="px-2 text-center text-amber-700 font-semibold">{r.totals.late}</td>
                  <td className="px-2 text-center text-rose-700 font-semibold">{r.totals.absent}</td>
                  <td className="px-2 text-center text-sky-700 font-semibold">{r.totals.leave}</td>
                  <td className="px-2 text-center text-slate-500">{r.totals.not_marked}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
};

// ---------------------------- Teams ----------------------------
const TeamForm: React.FC<{ token: string; data: TeamsData; team: Team | null; onClose: () => void; onSaved: (t: string) => void }> = ({
  token,
  data,
  team,
  onClose,
  onSaved
}) => {
  const api = useHrApi(token);
  const [f, setF] = useState({
    name: team?.name || '',
    project_id: team?.project_id ? String(team.project_id) : '',
    site_location: team?.site_location || '',
    supervisor_user_id: team ? String(team.supervisor_user_id) : '',
    backup_user_id: team?.backup_user_id ? String(team.backup_user_id) : '',
    lat: team?.lat != null ? String(team.lat) : '',
    lng: team?.lng != null ? String(team.lng) : '',
    radius_m: team?.radius_m != null ? String(team.radius_m) : '',
    is_active: team ? team.is_active : true
  });
  const [members, setMembers] = useState<Set<number>>(new Set(team?.members.map((m) => m.employee_id) || []));
  const [q, setQ] = useState('');
  const [onlyPicked, setOnlyPicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  const list = data.employees.filter((e) => {
    if (onlyPicked && !members.has(e.employee_id)) return false;
    const s = q.trim().toLowerCase();
    return !s || [e.name, e.employee_code, e.designation, e.department, e.team_name].some((v) => String(v || '').toLowerCase().includes(s));
  });
  const moving = data.employees.filter((e) => members.has(e.employee_id) && e.team_id && e.team_id !== team?.id).length;

  const useMyLocation = () =>
    navigator.geolocation?.getCurrentPosition(
      (p) => setF((x) => ({ ...x, lat: p.coords.latitude.toFixed(6), lng: p.coords.longitude.toFixed(6), radius_m: x.radius_m || '300' })),
      () => setMsg({ type: 'error', text: 'Could not read your location.' })
    );

  const save = async () => {
    setBusy(true);
    setMsg(null);
    const body = {
      ...f,
      project_id: f.project_id ? Number(f.project_id) : null,
      supervisor_user_id: Number(f.supervisor_user_id) || null,
      backup_user_id: f.backup_user_id ? Number(f.backup_user_id) : null,
      lat: f.lat === '' ? null : Number(f.lat),
      lng: f.lng === '' ? null : Number(f.lng),
      radius_m: f.radius_m === '' ? null : Number(f.radius_m),
      employee_ids: [...members]
    };
    try {
      if (team) await api.put(`/api/site-attendance/teams/${team.id}`, body);
      else await api.post('/api/site-attendance/teams', body);
      onSaved(team ? 'Team updated.' : 'Team created — the supervisor has been notified.');
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const project = data.projects.find((p) => String(p.id) === f.project_id);
  return (
    <Modal
      title={team ? `Edit ${team.name}` : 'New team'}
      onClose={onClose}
      wide
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={save}>
            {busy ? <Spinner /> : null} Save team
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Team name *</label>
            <input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Uttara Site — Civil crew" />
          </div>
          <div>
            <label className={labelCls}>Project</label>
            <select className={inputCls} value={f.project_id} onChange={(e) => set('project_id', e.target.value)}>
              <option value="">— none —</option>
              {data.projects.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                  {p.has_location ? ' (has location)' : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Supervisor (marks attendance) *</label>
            <select className={inputCls} value={f.supervisor_user_id} onChange={(e) => set('supervisor_user_id', e.target.value)}>
              <option value="">— pick an account —</option>
              {data.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                  {u.email ? ` — ${u.email}` : ''}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Backup supervisor (when the supervisor is away)</label>
            <select className={inputCls} value={f.backup_user_id} onChange={(e) => set('backup_user_id', e.target.value)}>
              <option value="">— none —</option>
              {data.users.map((u) => (
                <option key={u.id} value={u.id}>
                  {u.name}
                </option>
              ))}
            </select>
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Site / location name</label>
            <input className={inputCls} value={f.site_location} onChange={(e) => set('site_location', e.target.value)} placeholder="e.g. Plot 12, Sector 10, Uttara" />
          </div>
        </div>
        <div className="rounded-lg border border-slate-200 p-3 space-y-2">
          <div className="text-[11px] font-semibold text-slate-600 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5" /> Site circle — each sheet shows how far the supervisor's phone was from here
          </div>
          <div className="grid grid-cols-3 gap-2">
            <input className={inputCls} value={f.lat} onChange={(e) => set('lat', e.target.value)} placeholder="Latitude" />
            <input className={inputCls} value={f.lng} onChange={(e) => set('lng', e.target.value)} placeholder="Longitude" />
            <input className={inputCls} value={f.radius_m} onChange={(e) => set('radius_m', e.target.value)} placeholder="Radius m (300)" />
          </div>
          <div className="flex items-center gap-3 text-[11px] text-slate-500 flex-wrap">
            <button type="button" className="text-blue-600 font-semibold" onClick={useMyLocation}>
              Use my current location
            </button>
            {!f.lat && project?.has_location && <span>Blank = use the project's location.</span>}
            {!f.lat && !project?.has_location && <span>Blank = no distance check.</span>}
          </div>
        </div>
        <div>
          <div className="flex items-center justify-between gap-2 mb-1">
            <label className={labelCls}>
              Members ({members.size}){moving > 0 && <span className="text-amber-700"> — {moving} will move from another team</span>}
            </label>
            <label className="text-[11px] text-slate-500 flex items-center gap-1">
              <input type="checkbox" checked={onlyPicked} onChange={(e) => setOnlyPicked(e.target.checked)} /> Show selected only
            </label>
          </div>
          <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search by name, ID, designation, department, team…" />
          <div className="mt-2 max-h-72 overflow-y-auto rounded-lg border border-slate-200 divide-y divide-slate-100">
            {list.slice(0, 400).map((e) => (
              <label key={e.employee_id} className="flex items-center gap-2 px-3 py-1.5 text-xs cursor-pointer hover:bg-slate-50">
                <input
                  type="checkbox"
                  checked={members.has(e.employee_id)}
                  onChange={(ev) =>
                    setMembers((m) => {
                      const n = new Set(m);
                      if (ev.target.checked) n.add(e.employee_id);
                      else n.delete(e.employee_id);
                      return n;
                    })
                  }
                />
                <span className="flex-1 min-w-0 truncate">
                  <span className="font-semibold text-slate-800">{e.name}</span>
                  <span className="text-slate-500"> · {[e.employee_code, e.designation].filter(Boolean).join(' · ')}</span>
                </span>
                {e.team_name && e.team_id !== team?.id && <span className="text-[10px] text-amber-700 shrink-0">in {e.team_name}</span>}
                {!e.has_login && <span className="text-[10px] text-slate-400 shrink-0">no login</span>}
              </label>
            ))}
            {list.length === 0 && <div className="px-3 py-4 text-center text-xs text-slate-400">No match</div>}
          </div>
        </div>
        {team && (
          <label className="text-xs flex items-center gap-2">
            <input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active
          </label>
        )}
      </div>
    </Modal>
  );
};

const TeamsView: React.FC<{ token: string; data: TeamsData; reload: () => void }> = ({ token, data, reload }) => {
  const api = useHrApi(token);
  const [edit, setEdit] = useState<Team | 'new' | null>(null);
  const [msg, setMsg] = useState<Msg>(null);
  const remove = async (t: Team) => {
    if (!(await confirmDialog(`Remove "${t.name}"? A team with attendance history is only deactivated.`))) return;
    try {
      const d = await api.del(`/api/site-attendance/teams/${t.id}`);
      setMsg({ type: 'success', text: d.deactivated ? 'Team deactivated (its attendance history is kept).' : 'Team deleted.' });
      reload();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  const unassigned = data.employees.filter((e) => !e.team_id).length;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <div className="text-xs text-slate-500">
          {data.teams.filter((t) => t.is_active).length} active team(s) · {data.employees.length - unassigned} people in teams
        </div>
        <button type="button" className={btnPrimary} onClick={() => setEdit('new')}>
          <Plus className="w-3.5 h-3.5" /> New team
        </button>
      </div>
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="grid md:grid-cols-2 gap-3">
        {data.teams.length === 0 && (
          <div className="md:col-span-2 rounded-xl border border-dashed border-slate-300 p-6 text-center text-xs text-slate-500">
            Create a team for each site or crew, pick the supervisor who will mark attendance on their phone, and add the workers.
          </div>
        )}
        {data.teams.map((t) => (
          <div key={t.id} className={`rounded-xl border bg-white p-3 ${t.is_active ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">
                  {t.name} {!t.is_active && <span className="text-[10px] text-slate-500">(inactive)</span>}
                </div>
                <div className="text-[11px] text-slate-500">{[t.project_name, t.site_location].filter(Boolean).join(' · ') || 'No site set'}</div>
              </div>
              <div className="flex gap-1 shrink-0">
                <button type="button" className={btnGhost} onClick={() => setEdit(t)} aria-label="Edit team">
                  <Pencil className="w-3.5 h-3.5" />
                </button>
                <button type="button" className={btnGhost} onClick={() => remove(t)} aria-label="Remove team">
                  <Trash2 className="w-3.5 h-3.5" />
                </button>
              </div>
            </div>
            <div className="text-[11px] text-slate-600 mt-2 space-y-0.5">
              <div>
                Supervisor: <span className="font-semibold">{t.supervisor_name || '—'}</span>
                {t.backup_name && <> · Backup: {t.backup_name}</>}
              </div>
              <div className="flex items-center gap-1">
                <MapPin className="w-3 h-3" /> {t.has_site_circle ? 'Distance check on' : 'No site location — distance not checked'}
              </div>
              <div>
                <Users className="inline w-3 h-3" /> {t.members.length} member(s)
                {t.members.length > 0 && (
                  <span className="text-slate-400">
                    {' '}
                    — {t.members.slice(0, 4).map((m) => m.name).join(', ')}
                    {t.members.length > 4 ? ` +${t.members.length - 4}` : ''}
                  </span>
                )}
              </div>
            </div>
          </div>
        ))}
      </div>
      {edit && (
        <TeamForm
          token={token}
          data={data}
          team={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={(text) => {
            setEdit(null);
            setMsg({ type: 'success', text });
            reload();
          }}
        />
      )}
    </div>
  );
};

// ---------------------------- Settings ----------------------------
const SettingsView: React.FC<{ token: string; settings: SettingsData; onSaved: (s: SettingsData) => void }> = ({ token, settings, onSaved }) => {
  const api = useHrApi(token);
  const [f, setF] = useState(settings);
  const [msg, setMsg] = useState<Msg>(null);
  const save = async () => {
    try {
      const d = await api.put<SettingsData>('/api/site-attendance/settings', f);
      onSaved(d);
      setMsg({ type: 'success', text: 'Settings saved.' });
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  const Toggle: React.FC<{ k: keyof SettingsData; title: string; hint: string }> = ({ k, title, hint }) => (
    <label className="flex items-start gap-3 p-3 rounded-lg border border-slate-200 bg-white cursor-pointer">
      <input type="checkbox" className="mt-0.5" checked={!!f[k]} onChange={(e) => setF((p) => ({ ...p, [k]: e.target.checked }))} />
      <span>
        <span className="block text-xs font-semibold text-slate-800">{title}</span>
        <span className="block text-[11px] text-slate-500">{hint}</span>
      </span>
    </label>
  );
  return (
    <div className="space-y-3 max-w-xl">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <Toggle k="require_approval" title="HR approves each sheet" hint="On: a sheet counts only after HR approves it (Review tab). Off: it counts as soon as the supervisor saves it." />
      <Toggle k="require_photo" title="Team photo required" hint="The supervisor must attach a photo of the team with each sheet." />
      <Toggle k="require_location" title="Location required" hint="A sheet can't be submitted with the phone's location turned off." />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className={labelCls}>Supervisors can fill in up to … days back</label>
          <input type="number" min={0} max={31} className={inputCls} value={f.backdate_days} onChange={(e) => setF((p) => ({ ...p, backdate_days: Number(e.target.value) }))} />
        </div>
        <div>
          <label className={labelCls}>Remind supervisors who haven't submitted by</label>
          <input type="time" className={inputCls} value={f.reminder_time} onChange={(e) => setF((p) => ({ ...p, reminder_time: e.target.value }))} />
        </div>
      </div>
      <button type="button" className={btnPrimary} onClick={save}>
        Save settings
      </button>
    </div>
  );
};

// ---------------------------- Shell ----------------------------
const TABS = [
  { key: 'today', label: 'Today', icon: CalendarDays },
  { key: 'review', label: 'Review', icon: ClipboardCheck },
  { key: 'register', label: 'Register', icon: Download },
  { key: 'teams', label: 'Teams', icon: Users },
  { key: 'settings', label: 'Settings', icon: Settings }
] as const;

export const SiteAttendanceAdmin: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [tab, setTab] = useState<(typeof TABS)[number]['key']>('today');
  const [teams, setTeams] = useState<TeamsData | null>(null);
  const [settings, setSettings] = useState<SettingsData | null>(null);
  const load = useCallback(() => {
    api.get<TeamsData>('/api/site-attendance/teams').then(setTeams).catch(() => setTeams({ teams: [], employees: [], users: [], projects: [] }));
    api.get<SettingsData>('/api/site-attendance/settings').then(setSettings).catch(() => {});
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);
  return (
    <div className="space-y-4">
      <div className="flex gap-1 flex-wrap border-b border-slate-200">
        {TABS.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-2 border-b-2 -mb-px ${tab === t.key ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500 hover:text-slate-700'}`}
          >
            <t.icon className="w-3.5 h-3.5" /> {t.label}
          </button>
        ))}
      </div>
      {tab === 'today' && <TodayView token={token} />}
      {tab === 'review' && <ReviewView token={token} requireApproval={!!settings?.require_approval} />}
      {tab === 'register' && <RegisterView token={token} teams={teams?.teams || []} />}
      {tab === 'teams' && (teams ? <TeamsView token={token} data={teams} reload={load} /> : <Spinner />)}
      {tab === 'settings' && (settings ? <SettingsView token={token} settings={settings} onSaved={setSettings} /> : <Spinner />)}
    </div>
  );
};

// Office Attendance tab: ZKTeco device punches, or the supervisor muster roll.
export const OfficeAttendanceHub: React.FC<{ token: string }> = ({ token }) => {
  const [view, setView] = useState<'devices' | 'site'>(() => {
    try {
      const v = sessionStorage.getItem('office_att_view');
      sessionStorage.removeItem('office_att_view');
      return v === 'site' ? 'site' : 'devices';
    } catch {
      return 'devices';
    }
  });
  useEffect(() => {
    const on = (e: Event) => setView((e as CustomEvent).detail === 'site' ? 'site' : 'devices');
    window.addEventListener('credence:office-att-view', on);
    return () => window.removeEventListener('credence:office-att-view', on);
  }, []);
  return (
    <div className="space-y-4">
      <div className="flex gap-1 bg-slate-100 rounded-lg p-1 w-fit">
        {(
          [
            ['devices', 'Device punches (ZKTeco)', Fingerprint],
            ['site', 'Site Attendance (Supervisor)', Users]
          ] as const
        ).map(([k, label, Icon]) => (
          <button
            key={k}
            type="button"
            onClick={() => setView(k)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-md ${view === k ? 'bg-white shadow text-blue-700' : 'text-slate-600'}`}
          >
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>
      {view === 'devices' ? <OfficeAttendancePanel token={token} /> : <SiteAttendanceAdmin token={token} />}
    </div>
  );
};
