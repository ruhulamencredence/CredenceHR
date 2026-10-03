/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking -> "Currently Under Tracking" / "Currently Not Tracked".
// Shown at the top of Admin Panel -> Employee Tracking and as a quick access
// card (web) / tile (app) on the user Dashboard, next to Book a Ride and My
// Asset. Each number opens its employees, grouped by
// Department, with a search box. GET /api/tracking/status needs the
// 'tracking' module, so without it this renders nothing (and the API refuses).

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { Navigation, Search, X } from 'lucide-react';
import { apiUrl } from '../lib/api';

interface TrackingRow {
  employee_pk: number;
  employee_id: string;
  name: string;
  designation: string;
  department: string;
  user_id: number | null;
  tracking_enabled: boolean;
  tracked: boolean;
  last_ping: string | null;
  minutes_ago: number | null;
  reason: string | null;
}
export interface TrackingStatus {
  live_minutes: number;
  tracked: number;
  not_tracked: number;
  employees: TrackingRow[];
}

const REFRESH_MS = 60_000;

// The counts, refreshed every minute; null without the tracking module.
export function useTrackingStatus(token: string, enabled = true): TrackingStatus | null {
  const [data, setData] = useState<TrackingStatus | null>(null);
  useEffect(() => {
    if (!enabled) return;
    let alive = true;
    const load = () =>
      fetch(apiUrl('/api/tracking/status'), { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => alive && setData(d))
        .catch(() => {});
    load();
    const t = setInterval(load, REFRESH_MS);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [token, enabled]);
  return data;
}

function ago(min: number | null): string {
  if (min == null) return '';
  if (min < 1) return 'just now';
  if (min < 60) return `${min} min ago`;
  const h = Math.floor(min / 60);
  if (h < 24) return `${h}h ${min % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d} day${d === 1 ? '' : 's'} ago`;
}

function initials(name: string): string {
  return name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
}

interface Props {
  token: string;
  // 'panel': two big tiles (Admin Panel -> Employee Tracking).
  // 'card': the web Dashboard's quick access card (like My Asset).
  // 'chooser': no tile of its own — the app Dashboard's quick access tile
  // (UserPanel.tsx) opens it via chooserOpen; it shows both numbers.
  variant?: 'panel' | 'card' | 'chooser';
  className?: string;
  // Counts already loaded by the caller (useTrackingStatus) — skips this
  // component's own fetch.
  status?: TrackingStatus | null;
  chooserOpen?: boolean;
  onChooserClose?: () => void;
}

// Admin Panel -> Employee Tracking (the live map).
const openTrackingMap = () => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'tracking' }));

export const TrackingStatusCards: React.FC<Props> = ({ token, variant = 'panel', className = '', status, chooserOpen = false, onChooserClose }) => {
  const own = useTrackingStatus(token, status === undefined);
  const data = status === undefined ? own : status;
  const chooser = chooserOpen;
  const setChooser = (v: boolean) => {
    if (!v) onChooserClose?.();
  };
  const [open, setOpen] = useState<'tracked' | 'not_tracked' | null>(null);
  const [query, setQuery] = useState('');

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(null);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const groups = useMemo(() => {
    if (!data || !open) return [];
    const q = query.trim().toLowerCase();
    const rows = data.employees
      .filter((r) => (open === 'tracked' ? r.tracked : !r.tracked))
      .filter((r) => !q || [r.name, r.employee_id, r.designation, r.department, r.reason || ''].some((v) => v.toLowerCase().includes(q)));
    const map = new Map<string, TrackingRow[]>();
    for (const r of rows) {
      const list = map.get(r.department) || [];
      list.push(r);
      map.set(r.department, list);
    }
    return Array.from(map.entries())
      .map(([department, list]) => ({ department, list: list.sort((a, b) => a.name.localeCompare(b.name)) }))
      .sort((a, b) => (a.department === 'Unassigned' ? 1 : b.department === 'Unassigned' ? -1 : a.department.localeCompare(b.department)));
  }, [data, open, query]);

  if (!data) return null;

  const openList = (which: 'tracked' | 'not_tracked') => {
    setChooser(false);
    setQuery('');
    setOpen(which);
  };
  const shown = groups.reduce((n, g) => n + g.list.length, 0);
  const total = open === 'tracked' ? data.tracked : data.not_tracked;

  return (
    <>
      {variant === 'panel' ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {(
            [
              ['tracked', 'Currently Under Tracking', data.tracked, `Sent a location in the last ${data.live_minutes} min`, 'bg-emerald-50 border-emerald-200 text-emerald-700', 'bg-emerald-500'],
              ['not_tracked', 'Currently Not Tracked', data.not_tracked, 'Tracking off, or no recent location', 'bg-slate-50 border-slate-200 text-slate-700', 'bg-slate-400']
            ] as const
          ).map(([key, label, count, hint, cls, dot]) => (
            <button
              key={key}
              type="button"
              onClick={() => openList(key)}
              className={`text-left rounded-2xl border p-4 hover:shadow-sm transition-shadow ${cls}`}
            >
              <div className="flex items-center gap-2 text-xs font-semibold">
                <span className={`w-2 h-2 rounded-full ${dot}`} /> {label}
              </div>
              <div className="text-3xl font-bold mt-1 text-slate-900">{count}</div>
              <div className="text-[11px] text-slate-500 mt-0.5">{hint} · tap to see who</div>
            </button>
          ))}
        </div>
      ) : variant === 'card' ? (
        <div className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col ${className}`}>
          <div className="px-5 pt-5 pb-4 sm:px-6 border-b border-slate-200 flex items-start justify-between gap-3">
            <div>
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Navigation className="w-4 h-4 text-blue-600" /> Employee Tracking
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">Who is sending their location right now</p>
            </div>
            <button type="button" onClick={openTrackingMap} className="text-xs font-medium text-blue-600 hover:underline shrink-0">
              Open map
            </button>
          </div>
          <div className="p-5 sm:px-6 flex-1">
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => openList('tracked')} className="rounded-xl border border-slate-200 px-2 py-2.5 text-center hover:bg-slate-50 transition-colors">
                <div className="text-lg font-bold text-emerald-600">{data.tracked}</div>
                <div className="text-[11px] text-slate-500 leading-tight">Currently Under Tracking</div>
              </button>
              <button type="button" onClick={() => openList('not_tracked')} className="rounded-xl border border-slate-200 px-2 py-2.5 text-center hover:bg-slate-50 transition-colors">
                <div className="text-lg font-bold text-slate-900">{data.not_tracked}</div>
                <div className="text-[11px] text-slate-500 leading-tight">Currently Not Tracked</div>
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-3">Under tracking = a location in the last {data.live_minutes} min. Tap a number to see who, by Department.</p>
          </div>
        </div>
      ) : null}

      {/* Portalled to <body>: the Dashboard's glass tiles use backdrop-blur,
          which would otherwise trap these fixed overlays inside the tile. */}
      {chooser && createPortal(
        <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={() => setChooser(false)}>
          <div role="dialog" aria-label="Employee Tracking" className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-sm p-4" onClick={(e) => e.stopPropagation()}>
            <div className="flex items-center justify-between mb-3">
              <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
                <Navigation className="w-4 h-4 text-emerald-600" /> Employee Tracking
              </h3>
              <button type="button" onClick={() => setChooser(false)} className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="grid grid-cols-2 gap-2">
              <button type="button" onClick={() => openList('tracked')} className="rounded-xl bg-emerald-50 border border-emerald-100 px-3 py-3 text-left">
                <div className="text-2xl font-bold text-emerald-700">{data.tracked}</div>
                <div className="text-[11px] font-semibold text-emerald-700">Currently Under Tracking</div>
              </button>
              <button type="button" onClick={() => openList('not_tracked')} className="rounded-xl bg-slate-50 border border-slate-100 px-3 py-3 text-left">
                <div className="text-2xl font-bold text-slate-700">{data.not_tracked}</div>
                <div className="text-[11px] font-semibold text-slate-600">Currently Not Tracked</div>
              </button>
            </div>
            <p className="text-[11px] text-slate-400 mt-3">Under tracking = a location in the last {data.live_minutes} min. Tap a number to see who, by Department.</p>
          </div>
        </div>,
        document.body
      )}

      {open && createPortal(
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-4" onClick={() => setOpen(null)}>
          <div
            role="dialog"
            aria-label={open === 'tracked' ? 'Currently Under Tracking' : 'Currently Not Tracked'}
            className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-lg max-h-[85vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100 shrink-0">
              <div>
                <h3 className="text-sm font-bold text-slate-900">{open === 'tracked' ? 'Currently Under Tracking' : 'Currently Not Tracked'}</h3>
                <p className="text-xs text-slate-400 mt-0.5">
                  {total} employee{total === 1 ? '' : 's'} · by Department
                </p>
              </div>
              <button
                type="button"
                onClick={() => setOpen(null)}
                className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                aria-label="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
            <div className="px-5 pt-3 shrink-0">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  autoFocus
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Search name, ID, department…"
                  className="w-full pl-8 pr-3 py-2 text-xs bg-slate-50 border border-slate-200 rounded-full focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>
            <div className="overflow-y-auto px-5 py-4 space-y-4">
              {shown === 0 && <p className="text-xs text-slate-400 text-center py-6">{total === 0 ? 'Nobody here right now.' : 'No matching employees.'}</p>}
              {groups.map((g) => (
                <div key={g.department}>
                  <div className="flex items-center justify-between mb-1.5">
                    <span className="text-xs font-semibold text-slate-700">{g.department}</span>
                    <span className="inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] font-bold">{g.list.length}</span>
                  </div>
                  <div className="space-y-1">
                    {g.list.map((r) => (
                      <div key={r.employee_pk} className="flex items-center gap-2 text-xs px-2.5 py-2 bg-slate-50 border border-slate-100 rounded-lg">
                        <span className={`w-6 h-6 rounded-full flex items-center justify-center text-[9px] font-bold text-white shrink-0 ${r.tracked ? 'bg-emerald-500' : 'bg-slate-400'}`}>
                          {initials(r.name)}
                        </span>
                        <span className="min-w-0 flex-1">
                          <span className="block text-slate-800 font-semibold truncate">{r.name}</span>
                          <span className="block text-[10px] text-slate-400 truncate">{[r.employee_id, r.designation].filter(Boolean).join(' · ') || '—'}</span>
                        </span>
                        <span className={`text-[10px] font-semibold text-right shrink-0 ${r.tracked ? 'text-emerald-600' : 'text-slate-500'}`}>
                          {r.tracked ? ago(r.minutes_ago) : r.reason}
                          {!r.tracked && r.minutes_ago != null && <span className="block font-normal text-slate-400">last {ago(r.minutes_ago)}</span>}
                        </span>
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </div>
        </div>,
        document.body
      )}
    </>
  );
};
