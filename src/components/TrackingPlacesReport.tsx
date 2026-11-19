/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, FileSpreadsheet, FileDown, AlertTriangle } from 'lucide-react';
import jsPDF from '../lib/jspdf';
import autoTable from 'jspdf-autotable';
import { LocationPing } from '../types';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform, saveWorkbookCrossPlatform } from '../lib/saveFile';
import { STD_STYLES, STD_HEAD } from '../lib/pdfStandard';
import credenceLogo from '../assets/credence-logo.png';

// Employee Tracking -> Employees by place -> "Open report": everyone's latest
// location against the nearest company project and their own branch
// (GET /api/tracking/live adds nearest_project / own_branch). Same access as
// the page itself — no extra permission; each viewer sees only the people
// Employee Tracking already shows them (TrackingScope.ts).

export type ProjectState = 'at_site' | 'near' | 'away' | 'off';
export const PROJECT_LABEL: Record<ProjectState, string> = { at_site: 'At site', near: 'Near', away: 'Away', off: 'Not reporting' };
export const PROJECT_CHIP: Record<ProjectState, string> = {
  at_site: 'bg-emerald-50 text-emerald-700',
  near: 'bg-amber-50 text-amber-700',
  away: 'bg-slate-100 text-slate-600',
  off: 'bg-rose-50 text-rose-700'
};
export const BRANCH_LABEL = { at_branch: 'At own branch', away: 'Away from branch', no_location: 'Branch has no location' } as const;
export const BRANCH_CHIP = { at_branch: 'bg-emerald-50 text-emerald-700', away: 'bg-slate-100 text-slate-600', no_location: 'bg-slate-50 text-slate-400' } as const;

export const metres = (m: number | null | undefined) => (m == null ? '—' : m < 1000 ? `${m} m` : `${(m / 1000).toFixed(1)} km`);

export const StateChip: React.FC<{ cls: string; label: string }> = ({ cls, label }) => (
  <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-semibold whitespace-nowrap ${cls}`}>
    <span className="w-1.5 h-1.5 rounded-full bg-current" />
    {label}
  </span>
);

const WINDOWS = [
  { key: '30', label: 'Right now (30 min)', minutes: 30 },
  { key: '120', label: 'Last 2 hours', minutes: 120 },
  { key: 'today', label: 'Today', minutes: null }
] as const;
type WindowKey = (typeof WINDOWS)[number]['key'];
type Group = 'place' | 'project' | 'person';
type Tile = '' | ProjectState | 'b:at_branch' | 'b:away';
const NOT_REPORTING = 'Not reporting';

const minutesSince = (iso: string) => (Date.now() - new Date(iso).getTime()) / 60000;
const dhakaDay = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(d);
const agoText = (iso: string) => {
  const m = Math.round(minutesSince(iso));
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  return `${h} h ${m % 60} min ago`;
};

interface Row {
  p: LocationPing;
  fresh: boolean;
  state: ProjectState;
  place: string;
}

export const TrackingPlacesReport: React.FC<{
  pings: LocationPing[];
  placeOf: (p: LocationPing) => string;
  unlocatedProjects: string[];
  onClose: () => void;
}> = ({ pings, placeOf, unlocatedProjects, onClose }) => {
  const [win, setWin] = useState<WindowKey>('30');
  const [q, setQ] = useState('');
  const [dept, setDept] = useState('');
  const [proj, setProj] = useState('');
  const [tile, setTile] = useState<Tile>('');
  const [group, setGroup] = useState<Group>('place');
  const [busy, setBusy] = useState('');

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const winDef = WINDOWS.find((w) => w.key === win)!;
  const today = dhakaDay(new Date());
  const rows: Row[] = useMemo(
    () =>
      pings.map((p) => {
        const fresh = winDef.minutes != null ? minutesSince(p.recorded_at) <= winDef.minutes : dhakaDay(new Date(p.recorded_at)) === today;
        const state: ProjectState = !fresh ? 'off' : (p.nearest_project?.status as ProjectState) || 'away';
        return { p, fresh, state, place: fresh ? placeOf(p) : NOT_REPORTING };
      }),
    [pings, winDef, today, placeOf]
  );

  const departments = useMemo(() => [...new Set(pings.map((p) => p.department).filter(Boolean) as string[])].sort(), [pings]);
  const projects = useMemo(() => [...new Set(pings.map((p) => p.nearest_project?.name).filter(Boolean) as string[])].sort(), [pings]);

  const branchState = (r: Row) => (r.fresh ? r.p.own_branch?.status : undefined);
  const shown = rows.filter((r) => {
    if (dept && r.p.department !== dept) return false;
    if (proj && r.p.nearest_project?.name !== proj) return false;
    if (tile === 'b:at_branch' || tile === 'b:away') {
      if (branchState(r) !== tile.slice(2)) return false;
    } else if (tile && r.state !== tile) return false;
    if (q) {
      const hay = [r.p.user_name, r.p.employee_code, r.p.designation, r.p.department, r.place, r.p.nearest_project?.name, r.p.own_branch?.name].join(' ').toLowerCase();
      if (!hay.includes(q.toLowerCase())) return false;
    }
    return true;
  });

  const count = (f: (r: Row) => boolean) => rows.filter(f).length;
  const tiles: { key: Tile; label: string; hint: string; value: number; cls: string }[] = [
    { key: '', label: 'Everyone', hint: 'with a location', value: rows.length, cls: 'text-slate-900' },
    { key: 'at_site', label: 'At a project', hint: "inside a project's radius", value: count((r) => r.state === 'at_site'), cls: 'text-emerald-600' },
    { key: 'near', label: 'Near a project', hint: 'within 1 km', value: count((r) => r.state === 'near'), cls: 'text-amber-600' },
    { key: 'away', label: 'Away from projects', hint: 'farther than 1 km', value: count((r) => r.state === 'away'), cls: 'text-slate-600' },
    { key: 'b:at_branch', label: 'At own branch', hint: "inside their branch's radius", value: count((r) => branchState(r) === 'at_branch'), cls: 'text-emerald-600' },
    { key: 'b:away', label: 'Away from branch', hint: 'outside their own branch', value: count((r) => branchState(r) === 'away'), cls: 'text-rose-600' },
    { key: 'off', label: 'Not reporting', hint: `no location ${winDef.minutes != null ? `in ${winDef.label.match(/\(([^)]+)\)/)?.[1] || winDef.label.toLowerCase()}` : 'today'}`, value: count((r) => r.state === 'off'), cls: 'text-rose-600' }
  ];

  const groupsBy = (key: (r: Row) => string) => {
    const m = new Map<string, Row[]>();
    shown.forEach((r) => m.set(key(r), [...(m.get(key(r)) || []), r]));
    // People not reporting go last, as their own group.
    return [...m.entries()].sort((a, b) => Number(a[0] === NOT_REPORTING) - Number(b[0] === NOT_REPORTING) || b[1].length - a[1].length || a[0].localeCompare(b[0]));
  };
  const byPlace = group === 'place' ? groupsBy((r) => r.place) : [];
  const byProject = group === 'project' ? groupsBy((r) => r.p.nearest_project?.name || 'No project with a location') : [];
  const nearestOf = (list: Row[]) => list.reduce<Row | null>((b, r) => (r.fresh && r.p.nearest_project && (!b || r.p.nearest_project.distance_m < (b.p.nearest_project?.distance_m ?? Infinity)) ? r : b), null);

  const who = (r: Row) => `${r.p.user_name || 'User'}${r.p.employee_code ? ` (${r.p.employee_code})` : ''}`;
  const branchText = (r: Row) => (r.p.own_branch ? `${r.p.own_branch.name}${r.fresh && r.p.own_branch.distance_m != null ? ` · ${metres(r.p.own_branch.distance_m)}` : ''}` : 'no branch on record');
  const filterLine: [string, string][] = [
    ['Time', winDef.label],
    ['Department', dept || 'All'],
    ['Project', proj || 'All'],
    ['Showing', `${shown.length} of ${rows.length}`]
  ];

  const personRows = () =>
    shown.map((r) => [
      r.p.user_name || 'User',
      r.p.employee_code || '',
      r.p.designation || '',
      r.p.department || '',
      r.place,
      r.fresh ? r.p.nearest_project?.name || '—' : '—',
      r.fresh ? metres(r.p.nearest_project?.distance_m) : '—',
      PROJECT_LABEL[r.state],
      r.p.own_branch?.name || '—',
      r.fresh ? metres(r.p.own_branch?.distance_m) : '—',
      r.fresh && r.p.own_branch ? BRANCH_LABEL[r.p.own_branch.status] : '—',
      agoText(r.p.recorded_at)
    ]);
  const PERSON_HEAD = ['Employee', 'Employee ID', 'Designation', 'Department', 'Now at', 'Nearest project', 'Distance', 'Status', 'Own branch', 'From branch', 'Branch status', 'Last seen'];

  const excel = async () => {
    setBusy('excel');
    try {
      const XLSX = await import('xlsx');
      const wb = XLSX.utils.book_new();
      XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([PERSON_HEAD, ...personRows()]), 'By person');
      const places = groupsBy((r) => r.place);
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['Place', 'Nearest project', 'Distance', 'People', 'Who'],
          ...places.map(([k, l]) => {
            const n = nearestOf(l);
            return [k, n?.p.nearest_project?.name || '—', n ? metres(n.p.nearest_project?.distance_m) : '—', l.length, l.map(who).join(', ')];
          })
        ]),
        'By place'
      );
      const projs = groupsBy((r) => r.p.nearest_project?.name || 'No project with a location');
      XLSX.utils.book_append_sheet(
        wb,
        XLSX.utils.aoa_to_sheet([
          ['Project', 'At site', 'Near', 'Away', 'Not reporting', 'Who'],
          ...projs.map(([k, l]) => [k, ...(['at_site', 'near', 'away', 'off'] as ProjectState[]).map((s) => l.filter((r) => r.state === s).length), l.map(who).join(', ')])
        ]),
        'By project'
      );
      await saveWorkbookCrossPlatform(wb, `Employees-by-place-${today}.xlsx`);
    } finally {
      setBusy('');
    }
  };

  const pdf = async () => {
    setBusy('pdf');
    try {
      const logo = await loadImageElement(credenceLogo);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const opts = { reportTitle: 'Employees by Place', filters: filterLine };
      const y = drawPdfLetterhead(doc, logo, opts);
      autoTable(doc, {
        theme: 'grid',
        startY: y,
        margin: { top: y, left: 8, right: 8 },
        head: [PERSON_HEAD],
        body: personRows(),
        styles: { ...STD_STYLES, fontSize: 7, cellPadding: 1.2, overflow: 'linebreak' },
        headStyles: { ...STD_HEAD, fontSize: 7 },
        didDrawPage: () => {
          drawPdfLetterhead(doc, logo, opts);
        }
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `Employees-by-place-${today}.pdf`);
    } finally {
      setBusy('');
    }
  };

  const th = 'sticky top-0 z-[1] bg-white/95 backdrop-blur-sm px-3 py-2 text-left text-[10px] font-semibold uppercase tracking-wider text-slate-500 border-b border-slate-200';
  const td = 'px-3 py-2.5 border-b border-slate-100 align-top';

  // On document.body, so no transformed / clipped parent of the page can cut it.
  return createPortal(
    <div className="fixed inset-0 z-[1100] liquid-glass-backdrop flex items-stretch sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Employees by place report"
        className="liquid-glass liquid-glass-in sm:rounded-[32px] w-full max-w-6xl h-full sm:h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 px-4 sm:px-6 pt-[max(1rem,env(safe-area-inset-top,0px))] sm:pt-5 pb-2">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900">Employees by place — report</h3>
            <p className="text-xs text-slate-500">
              {new Date().toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' })} · nearest of all the company's projects, and each person's own branch
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => void excel()} disabled={!!busy} className="liquid-glass-button rounded-full inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
              <FileSpreadsheet className="w-3.5 h-3.5" /> {busy === 'excel' ? 'Preparing…' : 'Excel'}
            </button>
            <button type="button" onClick={() => void pdf()} disabled={!!busy} className="liquid-glass-button rounded-full inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold disabled:opacity-50">
              <FileDown className="w-3.5 h-3.5" /> {busy === 'pdf' ? 'Preparing…' : 'PDF'}
            </button>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex flex-wrap items-center gap-2 px-4 sm:px-6 pb-3">
          <label className="flex items-center gap-2 flex-1 min-w-[200px] bg-white/80 border border-slate-200 rounded-xl px-3 py-1.5">
            <Search className="w-3.5 h-3.5 text-slate-400" />
            <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, Employee ID, place, project or branch" className="bg-transparent text-xs outline-none flex-1 min-w-0" aria-label="Search" />
          </label>
          <select value={dept} onChange={(e) => setDept(e.target.value)} aria-label="Department" className="text-xs px-3 py-2 rounded-xl bg-white/80 border border-slate-200">
            <option value="">All departments</option>
            {departments.map((d) => <option key={d}>{d}</option>)}
          </select>
          <select value={proj} onChange={(e) => setProj(e.target.value)} aria-label="Nearest project" className="text-xs px-3 py-2 rounded-xl bg-white/80 border border-slate-200">
            <option value="">All projects</option>
            {projects.map((d) => <option key={d}>{d}</option>)}
          </select>
          <select value={win} onChange={(e) => setWin(e.target.value as WindowKey)} aria-label="Time" className="text-xs px-3 py-2 rounded-xl bg-white/80 border border-slate-200">
            {WINDOWS.map((w) => <option key={w.key} value={w.key}>{w.label}</option>)}
          </select>
          <div className="inline-flex rounded-xl bg-white/80 border border-slate-200 p-0.5" role="group" aria-label="Group by">
            {(['place', 'project', 'person'] as Group[]).map((g) => (
              <button
                key={g}
                type="button"
                aria-pressed={group === g}
                onClick={() => setGroup(g)}
                className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${group === g ? 'bg-[color:var(--g-accent,#ea580c)] text-white' : 'text-slate-500 hover:text-slate-800'}`}
              >
                By {g}
              </button>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 sm:grid-cols-4 lg:grid-cols-7 gap-2 px-4 sm:px-6 pb-3">
          {tiles.map((t) => (
            <button
              key={t.key || 'all'}
              type="button"
              aria-pressed={tile === t.key}
              onClick={() => setTile(tile === t.key ? '' : t.key)}
              className={`text-left rounded-2xl border bg-white/80 px-3 py-2 ${tile === t.key ? 'border-[color:var(--g-accent,#ea580c)] ring-2 ring-[color:var(--g-accent,#ea580c)]/30' : 'border-slate-200'}`}
            >
              <div className="text-[11px] font-semibold text-slate-500">{t.label}</div>
              <div className={`text-xl font-bold tabular-nums ${t.cls}`}>{t.value}</div>
              <div className="text-[10px] text-slate-400">{t.hint}</div>
            </button>
          ))}
        </div>

        {unlocatedProjects.length > 0 && (
          <div className="mx-4 sm:mx-6 mb-3 flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
            <AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
            <span>
              {unlocatedProjects.length} project{unlocatedProjects.length === 1 ? ' has' : 's have'} no location set ({unlocatedProjects.slice(0, 4).join(', ')}
              {unlocatedProjects.length > 4 ? '…' : ''}), so nobody is measured against {unlocatedProjects.length === 1 ? 'it' : 'them'}. Set it in Admin Panel → Projects.
            </span>
          </div>
        )}

        <div className="flex-1 min-h-0 overflow-auto mx-4 sm:mx-6 rounded-2xl border border-slate-200 bg-white/90">
          {shown.length === 0 ? (
            <p className="p-6 text-center text-sm text-slate-400">Nobody matches these filters.</p>
          ) : group === 'person' ? (
            <table className="w-full min-w-[900px] text-xs">
              <thead>
                <tr>
                  {['Employee', 'Department', 'Now at', 'Nearest project', 'Distance', 'Own branch', 'From branch', 'Last seen'].map((h) => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {shown.map((r) => (
                  <tr key={r.p.user_id}>
                    <td className={td}>
                      <div className="font-semibold text-slate-900">{r.p.user_name || 'User'}</div>
                      <div className="text-[11px] text-slate-500">{[r.p.employee_code, r.p.designation].filter(Boolean).join(' · ')}</div>
                    </td>
                    <td className={td}>{r.p.department || '—'}</td>
                    <td className={td}>{r.place}</td>
                    <td className={td}>
                      <div>{r.fresh ? r.p.nearest_project?.name || '—' : '—'}</div>
                      <StateChip cls={PROJECT_CHIP[r.state]} label={PROJECT_LABEL[r.state]} />
                    </td>
                    <td className={`${td} tabular-nums whitespace-nowrap`}>{r.fresh ? metres(r.p.nearest_project?.distance_m) : '—'}</td>
                    <td className={td}>
                      <div>{r.p.own_branch?.name || '—'}</div>
                      {r.fresh && r.p.own_branch && <StateChip cls={BRANCH_CHIP[r.p.own_branch.status]} label={BRANCH_LABEL[r.p.own_branch.status]} />}
                    </td>
                    <td className={`${td} tabular-nums whitespace-nowrap`}>{r.fresh ? metres(r.p.own_branch?.distance_m) : '—'}</td>
                    <td className={`${td} whitespace-nowrap text-slate-500`}>{agoText(r.p.recorded_at)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          ) : group === 'place' ? (
            <table className="w-full min-w-[860px] text-xs">
              <thead>
                <tr>
                  {['Place', 'Nearest project', 'Distance', 'People', 'Who (own branch · distance from it)'].map((h) => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {byPlace.map(([k, l]) => {
                  const n = nearestOf(l);
                  const st = n ? n.state : l[0].state;
                  return (
                    <tr key={k}>
                      <td className={`${td} font-semibold text-slate-900`}>{k}</td>
                      <td className={td}>
                        <div>{n?.p.nearest_project?.name || '—'}</div>
                        {(n || st === 'off') && <StateChip cls={PROJECT_CHIP[st]} label={PROJECT_LABEL[st]} />}
                      </td>
                      <td className={`${td} tabular-nums whitespace-nowrap`}>{n ? metres(n.p.nearest_project?.distance_m) : '—'}</td>
                      <td className={`${td} tabular-nums font-bold`}>{l.length}</td>
                      <td className={td}>
                        <ul className="space-y-1">
                          {l.map((r) => (
                            <li key={r.p.user_id} className="flex flex-wrap items-center gap-1.5 text-slate-600">
                              <span className="text-slate-800">{who(r)}</span>
                              <span className="text-slate-400">· {branchText(r)}</span>
                              {r.fresh && r.p.own_branch && <StateChip cls={BRANCH_CHIP[r.p.own_branch.status]} label={BRANCH_LABEL[r.p.own_branch.status]} />}
                            </li>
                          ))}
                        </ul>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          ) : (
            <table className="w-full min-w-[760px] text-xs">
              <thead>
                <tr>
                  {['Project', 'At site', 'Near', 'Away', 'Not reporting', 'Who'].map((h) => <th key={h} className={th}>{h}</th>)}
                </tr>
              </thead>
              <tbody>
                {byProject.map(([k, l]) => {
                  const n = (s: ProjectState) => l.filter((r) => r.state === s).length;
                  return (
                    <tr key={k}>
                      <td className={`${td} font-semibold text-slate-900`}>{k}</td>
                      <td className={`${td} tabular-nums font-bold text-emerald-600`}>{n('at_site')}</td>
                      <td className={`${td} tabular-nums text-amber-600`}>{n('near')}</td>
                      <td className={`${td} tabular-nums text-slate-600`}>{n('away')}</td>
                      <td className={`${td} tabular-nums text-rose-600`}>{n('off')}</td>
                      <td className={`${td} text-slate-600`}>{l.map(who).join(', ')}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
        <div className="flex flex-wrap justify-between gap-2 px-4 sm:px-6 py-3 pb-[max(0.75rem,env(safe-area-inset-bottom,0px))] text-[11px] text-slate-500">
          <span>
            {shown.length} of {rows.length} employees shown
          </span>
          <span>Straight-line distance from the latest location. At site = inside the project's radius (200 m when none is set); Near = within 1 km.</span>
        </div>
      </div>
    </div>,
    document.body
  );
};
