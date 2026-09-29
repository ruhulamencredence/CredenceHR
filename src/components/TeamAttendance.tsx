/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> Team Attendance: the supervisor's daily muster roll for a
// Site Attendance team (SiteAttendanceRoutes.ts) — for workers who never use
// the app themselves. Tap P / L / A / LV per person (or "All present"), add
// the arrival time for anyone Late, optionally a team photo, and submit; the
// phone's location goes with it. Works on a weak connection: marks are kept
// on the phone as a draft, and a submission that can't reach the server is
// queued and sent automatically once the phone is back online.
//
// SheetEditor is also what HR opens from Office Attendance -> Site
// Attendance to correct / approve a sheet.

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import {
  ArrowLeft,
  Camera,
  CheckCircle2,
  ChevronLeft,
  ChevronRight,
  Clock,
  CloudOff,
  MapPin,
  MessageSquare,
  Search,
  Send,
  Users,
  XCircle
} from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';
import { useHrApi, Notice, fmtDate, inputCls, btnPrimary, btnGhost } from './HrOpsShared';

export type SiteStatus = 'present' | 'late' | 'absent' | 'leave';
export interface SiteTeam {
  id: number;
  name: string;
  project_name: string | null;
  site_location: string | null;
  supervisor_name: string | null;
  backup_name: string | null;
  members: { employee_id: number; name: string; employee_code: string | null; designation: string | null; has_login: boolean }[];
  today?: { sheet: SiteSheet | null; counts: Counts };
}
export interface SiteSheet {
  id: number;
  team_id: number;
  date: string;
  status: 'submitted' | 'approved' | 'rejected';
  submitted_by_name: string | null;
  submitted_at: string | null;
  distance_m: number | null;
  accuracy_m: number | null;
  outside_site: boolean;
  has_photo: boolean;
  note: string | null;
  reviewed_by_name: string | null;
  review_note: string | null;
  lat: number | null;
  lng: number | null;
}
export interface Counts {
  present: number;
  late: number;
  absent: number;
  leave: number;
  unmarked: number;
  total: number;
}
interface SheetRow {
  employee_id: number;
  employee_code: string | null;
  name: string;
  designation: string | null;
  has_login: boolean;
  status: SiteStatus | null;
  in_time: string | null;
  out_time: string | null;
  remarks: string | null;
  app_leave: string | null;
  holiday: { title: string; type: string } | null;
  marked_by_other_team: string | null;
}
interface SheetData {
  team: SiteTeam;
  date: string;
  today: string;
  is_hr: boolean;
  editable: boolean;
  locked_reason: string | null;
  min_date: string | null;
  settings: { require_approval: boolean; require_photo: boolean; require_location: boolean; backdate_days: number };
  sheet: SiteSheet | null;
  rows: SheetRow[];
}
type Mark = { status: SiteStatus | null; in_time: string; out_time: string; remarks: string };

export const SITE_STATUS_META: Record<SiteStatus, { short: string; label: string; on: string; off: string }> = {
  present: { short: 'P', label: 'Present', on: 'bg-emerald-600 text-white border-emerald-600', off: 'text-emerald-700 border-emerald-200 bg-white' },
  late: { short: 'L', label: 'Late', on: 'bg-amber-500 text-white border-amber-500', off: 'text-amber-700 border-amber-200 bg-white' },
  absent: { short: 'A', label: 'Absent', on: 'bg-rose-600 text-white border-rose-600', off: 'text-rose-700 border-rose-200 bg-white' },
  leave: { short: 'LV', label: 'Leave', on: 'bg-sky-600 text-white border-sky-600', off: 'text-sky-700 border-sky-200 bg-white' }
};
const ORDER: SiteStatus[] = ['present', 'late', 'absent', 'leave'];

export const SheetStatusChip: React.FC<{ sheet: SiteSheet | null; requireApproval?: boolean }> = ({ sheet }) => {
  if (!sheet) return <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full border bg-slate-50 text-slate-600 border-slate-200">Not submitted</span>;
  const map = {
    submitted: ['Waiting for HR', 'bg-amber-50 text-amber-700 border-amber-200'],
    approved: ['Confirmed', 'bg-emerald-50 text-emerald-700 border-emerald-200'],
    rejected: ['Sent back', 'bg-rose-50 text-rose-700 border-rose-200']
  } as const;
  const [label, cls] = map[sheet.status];
  return <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border whitespace-nowrap ${cls}`}>{label}</span>;
};

const addDays = (d: string, n: number) => {
  const t = new Date(`${d}T00:00:00Z`);
  t.setUTCDate(t.getUTCDate() + n);
  return t.toISOString().slice(0, 10);
};

// ---- offline queue + drafts (per-phone conveniences; the server is the record) ----
const QUEUE_KEY = 'site_att_queue_v1';
const draftKey = (team: number, date: string) => `site_att_draft_${team}_${date}`;
const readJson = <T,>(key: string, fb: T): T => {
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fb;
  } catch {
    return fb;
  }
};
const writeJson = (key: string, v: any) => {
  try {
    if (v === null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(v));
    return true;
  } catch {
    return false;
  }
};
export function queuedCount() {
  return readJson<any[]>(QUEUE_KEY, []).length;
}
// Sends whatever is queued; keeps anything that still can't get through.
export async function flushSiteQueue(token: string): Promise<{ sent: number; failed: string[] }> {
  const queue = readJson<any[]>(QUEUE_KEY, []);
  if (!queue.length) return { sent: 0, failed: [] };
  const keep: any[] = [];
  const failed: string[] = [];
  let sent = 0;
  for (const item of queue) {
    try {
      const res = await fetch(apiUrl('/api/site-attendance/sheet'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(item.payload)
      });
      if (res.ok) {
        sent++;
        writeJson(draftKey(item.payload.team_id, item.payload.date), null);
      } else {
        // The server refused it (e.g. date now locked) — no point retrying.
        const d = await res.json().catch(() => ({}));
        failed.push(`${item.team_name || 'Team'} ${item.payload.date}: ${d.error || res.status}`);
      }
    } catch {
      keep.push(item);
    }
  }
  writeJson(QUEUE_KEY, keep.length ? keep : null);
  return { sent, failed };
}

// Shrinks a camera photo to ≤1280px JPEG so it uploads over a weak connection.
async function compressPhoto(file: File): Promise<{ mime: string; data: string; preview: string }> {
  const url = URL.createObjectURL(file);
  try {
    const img = await new Promise<HTMLImageElement>((resolve, reject) => {
      const i = new Image();
      i.onload = () => resolve(i);
      i.onerror = reject;
      i.src = url;
    });
    const scale = Math.min(1, 1280 / Math.max(img.width, img.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(img.width * scale);
    canvas.height = Math.round(img.height * scale);
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height);
    const preview = canvas.toDataURL('image/jpeg', 0.7);
    return { mime: 'image/jpeg', data: preview.split(',')[1], preview };
  } finally {
    URL.revokeObjectURL(url);
  }
}

const getPosition = () =>
  new Promise<{ lat: number; lng: number; accuracy: number } | null>((resolve) => {
    if (!('geolocation' in navigator)) return resolve(null);
    navigator.geolocation.getCurrentPosition(
      (p) => resolve({ lat: p.coords.latitude, lng: p.coords.longitude, accuracy: Math.round(p.coords.accuracy) }),
      () => resolve(null),
      { enableHighAccuracy: true, timeout: 12000, maximumAge: 60000 }
    );
  });

// Is this account a Site Attendance supervisor? (sidebar item / home tile)
let supervisorCache: { token: string; at: number; value: { teams: number; notSubmitted: number } } | null = null;
export function useSiteSupervisor(token: string) {
  const [value, setValue] = useState(() => (supervisorCache && supervisorCache.token === token ? supervisorCache.value : { teams: 0, notSubmitted: 0 }));
  useEffect(() => {
    if (!token) return;
    if (supervisorCache && supervisorCache.token === token && Date.now() - supervisorCache.at < 60000) {
      setValue(supervisorCache.value);
      return;
    }
    let alive = true;
    fetch(apiUrl('/api/site-attendance/my-teams'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (!d || !alive) return;
        const v = { teams: d.teams.length, notSubmitted: d.teams.filter((t: SiteTeam) => t.members.length && !t.today?.sheet).length };
        supervisorCache = { token, at: Date.now(), value: v };
        setValue(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token]);
  return value;
}

// ============================ Sheet editor ============================

export const SheetEditor: React.FC<{
  token: string;
  teamId: number;
  date: string;
  onDateChange?: (d: string) => void;
  onSaved?: () => void;
  hrMode?: boolean;
}> = ({ token, teamId, date, onDateChange, onSaved, hrMode }) => {
  const api = useHrApi(token);
  const [data, setData] = useState<SheetData | null>(null);
  const [marks, setMarks] = useState<Record<number, Mark>>({});
  const [dirty, setDirty] = useState(false);
  const [open, setOpen] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const [photo, setPhoto] = useState<{ mime: string; data: string; preview: string } | null>(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const fileRef = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setMsg(null);
    try {
      const d = await api.get<SheetData>(`/api/site-attendance/sheet?team_id=${teamId}&date=${date}`);
      setData(d);
      const fromServer: Record<number, Mark> = {};
      for (const r of d.rows)
        fromServer[r.employee_id] = { status: r.status, in_time: r.in_time || '', out_time: r.out_time || '', remarks: r.remarks || '' };
      // An unsent draft on this phone wins over what the server has.
      const draft = d.editable ? readJson<Record<number, Mark> | null>(draftKey(teamId, date), null) : null;
      setMarks(draft ? { ...fromServer, ...draft } : fromServer);
      setDirty(!!draft);
      setOpen(new Set(d.rows.filter((r) => r.remarks || r.out_time).map((r) => r.employee_id)));
      setNote(d.sheet?.note || '');
      setPhoto(null);
      if (draft) setMsg({ type: 'success', text: 'Restored your unsent marks from this phone.' });
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  }, [api, teamId, date]);
  useEffect(() => {
    load();
  }, [load]);

  const update = (id: number, patch: Partial<Mark>) => {
    setMarks((m) => {
      const next = { ...m, [id]: { ...(m[id] || { status: null, in_time: '', out_time: '', remarks: '' }), ...patch } };
      writeJson(draftKey(teamId, date), next);
      return next;
    });
    setDirty(true);
  };
  const markRest = (status: SiteStatus) => {
    if (!data) return;
    setMarks((m) => {
      const next = { ...m };
      for (const r of data.rows) {
        if (r.marked_by_other_team || next[r.employee_id]?.status) continue;
        next[r.employee_id] = { status: r.app_leave ? 'leave' : status, in_time: '', out_time: '', remarks: '' };
      }
      writeJson(draftKey(teamId, date), next);
      return next;
    });
    setDirty(true);
  };

  const counts = useMemo(() => {
    const c: Counts = { present: 0, late: 0, absent: 0, leave: 0, unmarked: 0, total: 0 };
    for (const r of data?.rows || []) {
      if (r.marked_by_other_team) continue;
      c.total++;
      const s = marks[r.employee_id]?.status;
      if (s) c[s]++;
      else c.unmarked++;
    }
    return c;
  }, [data, marks]);

  const onPhoto = async (f: File | undefined) => {
    if (!f) return;
    try {
      setPhoto(await compressPhoto(f));
      setDirty(true);
    } catch {
      setMsg({ type: 'error', text: 'Could not read that photo — try again.' });
    }
  };

  const submit = async () => {
    if (!data) return;
    const missingTime = data.rows.find((r) => marks[r.employee_id]?.status === 'late' && !marks[r.employee_id]?.in_time);
    if (missingTime) {
      setOpen((o) => new Set(o).add(missingTime.employee_id));
      return setMsg({ type: 'error', text: `Enter the arrival time for ${missingTime.name} (marked Late).` });
    }
    if (counts.unmarked && !window.confirm(`${counts.unmarked} ${counts.unmarked === 1 ? 'person is' : 'people are'} not marked yet. Submit anyway?`)) return;
    if (!hrMode && data.settings.require_photo && !photo && !data.sheet?.has_photo) return setMsg({ type: 'error', text: 'Take a team photo first.' });
    setBusy(true);
    setMsg(null);
    const pos = hrMode ? null : await getPosition();
    if (!hrMode && data.settings.require_location && !pos) {
      setBusy(false);
      return setMsg({ type: 'error', text: 'Location is off or blocked. Turn on location for this app and try again.' });
    }
    const payload = {
      team_id: teamId,
      date,
      entries: data.rows
        .filter((r) => !r.marked_by_other_team && marks[r.employee_id]?.status)
        .map((r) => ({ employee_id: r.employee_id, ...marks[r.employee_id] })),
      note: note || null,
      photo: photo ? { mime: photo.mime, data: photo.data } : null,
      lat: pos?.lat ?? null,
      lng: pos?.lng ?? null,
      accuracy: pos?.accuracy ?? null
    };
    try {
      const res = await fetch(apiUrl('/api/site-attendance/sheet'), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw Object.assign(new Error(d.error || `Request failed (${res.status})`), { server: true });
      writeJson(draftKey(teamId, date), null);
      setDirty(false);
      const parts = [d.status === 'submitted' ? 'Submitted — waiting for HR approval.' : 'Saved — attendance is confirmed.'];
      if (d.conflicts?.length) parts.push(`Skipped: ${d.conflicts.join(', ')}.`);
      if (d.outside_site) parts.push(`Note: your location was ${d.distance_m} m from the site.`);
      await load();
      setMsg({ type: d.conflicts?.length ? 'error' : 'success', text: parts.join(' ') });
      onSaved?.();
    } catch (e: any) {
      if (!e.server && !hrMode) {
        // No connection — queue it on the phone and send later.
        const queue = readJson<any[]>(QUEUE_KEY, []).filter((q) => !(q.payload.team_id === teamId && q.payload.date === date));
        const ok = writeJson(QUEUE_KEY, [...queue, { payload, team_name: data.team.name, queued_at: new Date().toISOString() }]);
        setMsg({
          type: ok ? 'success' : 'error',
          text: ok
            ? 'No internet right now — saved on this phone. It will be sent automatically when the connection is back.'
            : 'No internet, and this phone could not store the sheet. Try again when you are online.'
        });
        setDirty(false);
      } else setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  const review = async (decision: 'approve' | 'reject') => {
    if (!data?.sheet) return;
    let note: string | null = null;
    if (decision === 'reject') {
      note = window.prompt('What needs fixing? The supervisor will see this.') || '';
      if (!note.trim()) return;
    }
    setBusy(true);
    try {
      await api.post(`/api/site-attendance/sheets/${data.sheet.id}/review`, { decision, note });
      await load();
      setMsg({ type: 'success', text: decision === 'approve' ? 'Approved — the attendance now counts.' : 'Sent back to the supervisor.' });
      onSaved?.();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  if (loading && !data) return <div className="py-10 flex justify-center"><Spinner /></div>;
  if (!data) return <Notice msg={msg} />;

  const q = query.trim().toLowerCase();
  const rows = data.rows.filter((r) => !q || [r.name, r.employee_code, r.designation].some((v) => String(v || '').toLowerCase().includes(q)));
  const allHoliday = data.rows.length > 0 && data.rows.every((r) => r.holiday);
  const canEdit = data.editable;
  const minDate = data.min_date;

  return (
    <div className="space-y-3">
      {/* Date */}
      <div className="flex items-center gap-2">
        <button
          type="button"
          className={btnGhost}
          disabled={!onDateChange || (!!minDate && date <= minDate)}
          onClick={() => onDateChange?.(addDays(date, -1))}
          aria-label="Previous day"
        >
          <ChevronLeft className="w-4 h-4" />
        </button>
        <input
          type="date"
          value={date}
          max={data.today}
          min={minDate || undefined}
          onChange={(e) => e.target.value && onDateChange?.(e.target.value)}
          disabled={!onDateChange}
          className={`${inputCls} text-center font-semibold`}
        />
        <button
          type="button"
          className={btnGhost}
          disabled={!onDateChange || date >= data.today}
          onClick={() => onDateChange?.(addDays(date, 1))}
          aria-label="Next day"
        >
          <ChevronRight className="w-4 h-4" />
        </button>
      </div>

      {/* Sheet status */}
      <div className="rounded-xl border border-slate-200 bg-white p-3 text-xs space-y-1.5">
        <div className="flex items-center justify-between gap-2 flex-wrap">
          <div className="font-semibold text-slate-800">
            {date === data.today ? 'Today' : fmtDate(date)} · {data.team.name}
          </div>
          <SheetStatusChip sheet={data.sheet} />
        </div>
        {data.sheet && (
          <div className="text-slate-500">
            By {data.sheet.submitted_by_name || '—'}
            {data.sheet.submitted_at && ` · ${new Date(data.sheet.submitted_at).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' })}`}
            {data.sheet.distance_m !== null && (
              <span className={data.sheet.outside_site ? 'text-rose-600 font-semibold' : ''}>
                {' '}
                · <MapPin className="inline w-3 h-3" /> {data.sheet.distance_m} m from site{data.sheet.outside_site ? ' (outside)' : ''}
              </span>
            )}
            {data.sheet.distance_m === null && data.sheet.lat !== null && ' · location attached'}
          </div>
        )}
        {data.sheet?.status === 'rejected' && data.sheet.review_note && (
          <div className="text-rose-700 bg-rose-50 border border-rose-200 rounded-lg px-2 py-1.5">
            <span className="font-semibold">HR sent this back:</span> {data.sheet.review_note}
          </div>
        )}
        {allHoliday && <div className="text-violet-700">{data.rows[0].holiday!.title} — mark only people who actually worked.</div>}
        {data.locked_reason && <div className="text-slate-500 italic">{data.locked_reason}</div>}
        {data.sheet?.has_photo && (
          <a
            href="#"
            onClick={async (e) => {
              e.preventDefault();
              const res = await fetch(apiUrl(`/api/site-attendance/sheets/${data.sheet!.id}/photo`), { headers: { Authorization: `Bearer ${token}` } });
              if (res.ok) window.open(URL.createObjectURL(await res.blob()), '_blank');
            }}
            className="inline-flex items-center gap-1 text-blue-600 font-semibold"
          >
            <Camera className="w-3.5 h-3.5" /> View team photo
          </a>
        )}
      </div>

      <Notice msg={msg} onClose={() => setMsg(null)} />

      {/* Tools */}
      {canEdit && (
        <div className="flex items-center gap-2 flex-wrap">
          <button type="button" className={`${btnGhost} !border-emerald-300 !text-emerald-700`} onClick={() => markRest('present')}>
            <CheckCircle2 className="w-3.5 h-3.5" /> Mark the rest present
          </button>
          <button type="button" className={btnGhost} onClick={() => markRest('absent')}>
            <XCircle className="w-3.5 h-3.5" /> Rest absent
          </button>
        </div>
      )}
      {data.rows.length > 8 && (
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Find a person…" className={`${inputCls} pl-8`} />
        </div>
      )}

      {/* People */}
      <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
        {rows.length === 0 && <div className="p-4 text-xs text-slate-400 text-center">No members in this team yet — ask HR to add them.</div>}
        {rows.map((r) => {
          const m = marks[r.employee_id] || { status: null, in_time: '', out_time: '', remarks: '' };
          const expanded = open.has(r.employee_id) || m.status === 'late';
          const worked = m.status === 'present' || m.status === 'late';
          return (
            <div key={r.employee_id} className={`p-3 ${r.marked_by_other_team ? 'opacity-50' : ''}`}>
              <div className="flex items-center gap-2">
                <div className="min-w-0 flex-1">
                  <div className="text-sm font-semibold text-slate-800 truncate">{r.name}</div>
                  <div className="text-[11px] text-slate-500 truncate">
                    {[r.employee_code, r.designation].filter(Boolean).join(' · ') || '—'}
                  </div>
                  {r.app_leave && <div className="text-[10px] font-semibold text-sky-700">On approved leave ({r.app_leave})</div>}
                  {r.marked_by_other_team && <div className="text-[10px] font-semibold text-slate-600">Already marked by {r.marked_by_other_team}</div>}
                </div>
                <div className="flex gap-1 shrink-0">
                  {ORDER.map((s) => (
                    <button
                      key={s}
                      type="button"
                      disabled={!canEdit || !!r.marked_by_other_team}
                      onClick={() => update(r.employee_id, { status: m.status === s ? null : s })}
                      title={SITE_STATUS_META[s].label}
                      className={`h-9 min-w-[38px] px-1.5 rounded-lg border text-xs font-bold transition-colors disabled:cursor-not-allowed ${
                        m.status === s ? SITE_STATUS_META[s].on : SITE_STATUS_META[s].off
                      }`}
                    >
                      {SITE_STATUS_META[s].short}
                    </button>
                  ))}
                  {canEdit && !r.marked_by_other_team && (
                    <button
                      type="button"
                      onClick={() =>
                        setOpen((o) => {
                          const n = new Set(o);
                          if (n.has(r.employee_id)) n.delete(r.employee_id);
                          else n.add(r.employee_id);
                          return n;
                        })
                      }
                      className="h-9 w-8 rounded-lg text-slate-400 hover:bg-slate-100 flex items-center justify-center"
                      aria-label="Times and note"
                    >
                      <MessageSquare className="w-4 h-4" />
                    </button>
                  )}
                </div>
              </div>
              {expanded && (
                <div className="grid grid-cols-2 sm:grid-cols-[120px_120px_1fr] gap-2 mt-2">
                  <label className="text-[10px] font-semibold text-slate-500">
                    Arrived {m.status === 'late' && <span className="text-rose-600">*</span>}
                    <input
                      type="time"
                      value={m.in_time}
                      disabled={!canEdit || !worked}
                      onChange={(e) => update(r.employee_id, { in_time: e.target.value })}
                      className={`${inputCls} !py-1.5 mt-0.5`}
                    />
                  </label>
                  <label className="text-[10px] font-semibold text-slate-500">
                    Left
                    <input
                      type="time"
                      value={m.out_time}
                      disabled={!canEdit || !worked}
                      onChange={(e) => update(r.employee_id, { out_time: e.target.value })}
                      className={`${inputCls} !py-1.5 mt-0.5`}
                    />
                  </label>
                  <label className="text-[10px] font-semibold text-slate-500 col-span-2 sm:col-span-1">
                    Note
                    <input
                      value={m.remarks}
                      disabled={!canEdit}
                      maxLength={255}
                      onChange={(e) => update(r.employee_id, { remarks: e.target.value })}
                      placeholder="e.g. sick, went home at 2pm"
                      className={`${inputCls} !py-1.5 mt-0.5`}
                    />
                  </label>
                </div>
              )}
            </div>
          );
        })}
      </div>

      {/* Photo + note */}
      {canEdit && (
        <div className="rounded-xl border border-slate-200 bg-white p-3 space-y-2">
          <div className="flex items-center gap-3">
            <input ref={fileRef} type="file" accept="image/*" capture="environment" className="hidden" onChange={(e) => onPhoto(e.target.files?.[0])} />
            <button type="button" className={btnGhost} onClick={() => fileRef.current?.click()}>
              <Camera className="w-3.5 h-3.5" /> {photo || data.sheet?.has_photo ? 'Retake team photo' : 'Team photo'}
              {!hrMode && data.settings.require_photo && <span className="text-rose-600">*</span>}
            </button>
            {photo && <img src={photo.preview} alt="Team" className="h-12 w-16 object-cover rounded-md border border-slate-200" />}
          </div>
          <input value={note} onChange={(e) => setNote(e.target.value)} maxLength={500} placeholder="Note for HR (optional)" className={inputCls} />
        </div>
      )}

      {/* Summary + submit */}
      <div className="sticky bottom-20 md:bottom-3 z-10 rounded-xl border border-slate-200 bg-white/95 backdrop-blur p-3 shadow-lg">
        <div className="flex items-center justify-between gap-2 flex-wrap text-[11px] font-semibold">
          <div className="flex gap-2 flex-wrap">
            <span className="text-emerald-700">P {counts.present}</span>
            <span className="text-amber-700">L {counts.late}</span>
            <span className="text-rose-700">A {counts.absent}</span>
            <span className="text-sky-700">LV {counts.leave}</span>
            {counts.unmarked > 0 && <span className="text-slate-500">Not marked {counts.unmarked}</span>}
          </div>
          <div className="flex gap-2">
            {hrMode && data.sheet?.status === 'submitted' && !dirty && (
              <>
                <button type="button" className={`${btnGhost} !text-rose-700`} disabled={busy} onClick={() => review('reject')}>
                  Send back
                </button>
                <button type="button" className={`${btnPrimary} !bg-emerald-600 hover:!bg-emerald-700`} disabled={busy} onClick={() => review('approve')}>
                  <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                </button>
              </>
            )}
            {canEdit && (
              <button type="button" className={btnPrimary} disabled={busy || counts.total === counts.unmarked} onClick={submit}>
                {busy ? <Spinner /> : <Send className="w-3.5 h-3.5" />}
                {data.sheet ? (dirty ? 'Save changes' : 'Submit again') : 'Submit attendance'}
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

// ============================ Supervisor page ============================

export const TeamAttendance: React.FC<{ token: string; onBack?: () => void }> = ({ token, onBack }) => {
  const api = useHrApi(token);
  const [teams, setTeams] = useState<SiteTeam[] | null>(null);
  const [today, setToday] = useState('');
  const [teamId, setTeamId] = useState<number | null>(null);
  const [date, setDate] = useState('');
  const [view, setView] = useState<'mark' | 'history'>('mark');
  const [history, setHistory] = useState<(SiteSheet & { counts: Counts })[]>([]);
  const [queued, setQueued] = useState(queuedCount());
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const isNativeApp = Capacitor.isNativePlatform();

  const loadTeams = useCallback(async () => {
    try {
      const d = await api.get<{ today: string; teams: SiteTeam[] }>('/api/site-attendance/my-teams');
      setTeams(d.teams);
      setToday(d.today);
      setDate((cur) => cur || d.today);
      setTeamId((cur) => cur ?? d.teams[0]?.id ?? null);
    } catch (e: any) {
      setTeams([]);
      setMsg({ type: 'error', text: e.message });
    }
  }, [api]);

  const flush = useCallback(async () => {
    if (!queuedCount()) return;
    const r = await flushSiteQueue(token);
    setQueued(queuedCount());
    if (r.sent || r.failed.length)
      setMsg({
        type: r.failed.length ? 'error' : 'success',
        text: [r.sent ? `${r.sent} saved sheet(s) sent to the server.` : '', r.failed.length ? `Could not send: ${r.failed.join('; ')}` : ''].filter(Boolean).join(' ')
      });
    if (r.sent) loadTeams();
  }, [token, loadTeams]);

  useEffect(() => {
    loadTeams();
    flush();
    const onOnline = () => flush();
    window.addEventListener('online', onOnline);
    return () => window.removeEventListener('online', onOnline);
  }, [loadTeams, flush]);

  useEffect(() => {
    if (view !== 'history' || !teamId) return;
    api
      .get<{ sheets: (SiteSheet & { counts: Counts })[] }>(`/api/site-attendance/history?team_id=${teamId}&month=${(date || today).slice(0, 7)}`)
      .then((d) => setHistory(d.sheets))
      .catch(() => setHistory([]));
  }, [api, view, teamId, date, today]);

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900" style={{ background: 'var(--g-bg-gradient)' }}>
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-3xl mx-auto">
        {!isNativeApp && <ModulePath path={['Self Service', 'Team Attendance']} />}
        <div className="flex items-center gap-2 mb-3 mt-2">
          {onBack && (
            <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-slate-500" />
            </button>
          )}
          <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
            <Users className="w-5 h-5 text-blue-600 shrink-0" /> Team Attendance
          </h1>
        </div>

        {queued > 0 && (
          <div className="mb-3 flex items-center justify-between gap-2 text-xs px-3 py-2 rounded-lg border bg-amber-50 border-amber-200 text-amber-800">
            <span className="flex items-center gap-1.5">
              <CloudOff className="w-4 h-4" /> {queued} sheet(s) saved on this phone, waiting for internet.
            </span>
            <button type="button" className="font-semibold underline" onClick={flush}>
              Send now
            </button>
          </div>
        )}
        <div className="mb-3">
          <Notice msg={msg} onClose={() => setMsg(null)} />
        </div>

        {teams === null ? (
          <div className="py-10 flex justify-center">
            <Spinner />
          </div>
        ) : teams.length === 0 ? (
          <div className="rounded-xl border border-slate-200 bg-white p-6 text-center text-sm text-slate-500">
            You are not the attendance supervisor of any team. HR sets this up in Office Attendance → Site Attendance.
          </div>
        ) : (
          <>
            {teams.length > 1 && (
              <div className="flex gap-2 overflow-x-auto pb-2 mb-2">
                {teams.map((t) => (
                  <button
                    key={t.id}
                    type="button"
                    onClick={() => setTeamId(t.id)}
                    className={`shrink-0 text-left rounded-xl border px-3 py-2 ${teamId === t.id ? 'border-blue-500 bg-blue-50' : 'border-slate-200 bg-white'}`}
                  >
                    <div className="text-xs font-semibold text-slate-800">{t.name}</div>
                    <div className="text-[10px] text-slate-500 flex items-center gap-1.5">
                      {t.members.length} people · <SheetStatusChip sheet={t.today?.sheet || null} />
                    </div>
                  </button>
                ))}
              </div>
            )}
            {(() => {
              const t = teams.find((x) => x.id === teamId);
              return t ? (
                <div className="text-[11px] text-slate-500 mb-3 flex items-center gap-1.5 flex-wrap">
                  <MapPin className="w-3.5 h-3.5" /> {[t.project_name, t.site_location].filter(Boolean).join(' · ') || 'No site set'} · {t.members.length} people
                </div>
              ) : null;
            })()}
            <div className="flex gap-1 mb-3 bg-white rounded-lg border border-slate-200 p-1 w-fit">
              {(['mark', 'history'] as const).map((v) => (
                <button
                  key={v}
                  type="button"
                  onClick={() => setView(v)}
                  className={`text-xs font-semibold px-3 py-1.5 rounded-md ${view === v ? 'bg-blue-600 text-white' : 'text-slate-600'}`}
                >
                  {v === 'mark' ? 'Mark attendance' : 'This month'}
                </button>
              ))}
            </div>
            {teamId && view === 'mark' && (
              <SheetEditor
                key={`${teamId}-${date}`}
                token={token}
                teamId={teamId}
                date={date}
                onDateChange={setDate}
                onSaved={() => {
                  supervisorCache = null;
                  loadTeams();
                }}
              />
            )}
            {teamId && view === 'history' && (
              <div className="rounded-xl border border-slate-200 bg-white divide-y divide-slate-100">
                {history.length === 0 && <div className="p-4 text-xs text-slate-400 text-center">No sheets this month yet.</div>}
                {history.map((s) => (
                  <button
                    key={s.id}
                    type="button"
                    onClick={() => {
                      setDate(s.date);
                      setView('mark');
                    }}
                    className="w-full text-left p-3 flex items-center justify-between gap-2 hover:bg-slate-50"
                  >
                    <div>
                      <div className="text-xs font-semibold text-slate-800 flex items-center gap-1.5">
                        <Clock className="w-3.5 h-3.5 text-slate-400" /> {fmtDate(s.date)}
                      </div>
                      <div className="text-[11px] mt-0.5 flex gap-2 font-semibold">
                        <span className="text-emerald-700">P {s.counts.present}</span>
                        <span className="text-amber-700">L {s.counts.late}</span>
                        <span className="text-rose-700">A {s.counts.absent}</span>
                        <span className="text-sky-700">LV {s.counts.leave}</span>
                      </div>
                    </div>
                    <SheetStatusChip sheet={s} />
                  </button>
                ))}
              </div>
            )}
          </>
        )}
      </div>
    </div>
  );
};

export default TeamAttendance;
