/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import jsPDF from '../lib/jspdf';
import autoTable from 'jspdf-autotable';
import { Navigation, Radio, RefreshCw, Route, X, BatteryMedium, Clock, MapPin, Search, FileDown, FileText, Timer, Maximize2, Minimize2, ChevronDown, ChevronUp, Send, BarChart3, Building2, Smartphone } from 'lucide-react';
import { LocationPing } from '../types';
import { cleanPath, ROUGH_LABEL, MAX_ACCURACY_M, RoughReason } from '../lib/trackPath';
import { apiUrl } from '../lib/api';
import { reverseGeocode } from '../lib/reverseGeocode';
import { TrackingStatusCards, useTrackingStatus } from './TrackingStatusCards';
import { TrackingStayReport } from './TrackingStayReport';
import { LiveFollowModal } from './LiveFollowModal';
import { getChatSocket } from '../lib/chatSocket';
import { formatDate } from '../lib/formatDate';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { EmailReportButton, emailReport, useCanEmailReports } from '../lib/reportEmail';
import credenceLogo from '../assets/credence-logo.png';

import { STD_STYLES, STD_HEAD } from '../lib/pdfStandard';
import { fetchPhoto, photoKnownMissing } from './UserAvatar';
// "18-Aug-2026, 02:19 PM" — same dd-MMM-yyyy date as formatDate, plus a local
// 12-hour time, for report rows where the exact moment (not just the day)
// matters. Reads local (not UTC) components, same reasoning as
// todayDateOnlyString in formatDate.ts — a ping's clock time is what an Admin
// pointing at a report row actually cares about.
// Points within ~10 m share one address lookup (Nominatim allows about one
// request a second, and a phone standing still sends many near-identical
// points).
const addressKey = (p: { lat: any; lng: any }) => `${Number(p.lat).toFixed(4)},${Number(p.lng).toFixed(4)}`;

function formatDateTime(iso: string): string {
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const datePart = formatDate(iso);
  let hours = d.getHours();
  const minutes = String(d.getMinutes()).padStart(2, '0');
  const ampm = hours >= 12 ? 'PM' : 'AM';
  hours = hours % 12 || 12;
  return `${datePart}, ${String(hours).padStart(2, '0')}:${minutes} ${ampm}`;
}

interface EmployeeTrackingPanelProps {
  token: string;
  // Module Access -> Employee Tracking -> "Stay Report" layer.
  canStayReport?: boolean;
  // Module Access -> Employee Tracking -> "Live Follow" layer.
  canLive?: boolean;
}

// How often the Live board silently re-fetches while this tab is open — the
// device itself only pings every 5-10 minutes, so a tight poll here wouldn't
// see anything new; this just keeps "X min ago" honest and catches new pings
// promptly without hammering the server.
const LIVE_REFRESH_MS = 60_000;
// "Live all": everyone on the map in live mode at once (the tracking "live"
// layer, POST /api/tracking/live/watch-many). Renewed like Live Follow, ends
// by itself after LIVE_ALL_MS — live mode is hard on the phones' batteries.
const LIVE_ALL_RENEW_MS = 45_000;
const LIVE_ALL_MS = 15 * 60_000;
const LIVE_ALL_MAX = 100;
// Live pings are gathered and drawn together this often (not one redraw per ping).
const LIVE_ALL_FLUSH_MS = 2_000;

// A user's dot turns from "recent" to "stale" grey after this many minutes of
// silence — the device is still supposed to ping every 5-10 min, so 20 min of
// nothing usually means the app was killed, the phone is off, or it has no
// signal, not that the person hasn't moved.
const STALE_AFTER_MIN = 20;

// Deterministic fallback avatar colors (same idea as GlobalSidebar/Navbar's
// initials bubble) — no profile photo on file yet, so every user still gets a
// stable, distinguishable dot color instead of everyone showing identical grey.
const AVATAR_PALETTE = ['var(--g-avatar-1, #7F00FF)', '#059669', '#0891b2', '#d97706', '#dc2626', '#4f46e5', '#be185d', '#0d9488'];
function avatarColor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}
function getInitials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

// Live board marker — the user's profile photo (fetched separately, see
// photoUrls state below) inside a colored ring, falling back to an initials
// avatar when the account has no Personal Data photo uploaded. Replaces the
// old plain colored dot so an Admin can recognize who's who on the map at a
// glance instead of hovering every marker.
const liveMarkerIcon = (stale: boolean, name: string, photoUrl: string | null | undefined, mock = false) => {
  // Red ring: the last fix came from a mock-location ("fake GPS") app.
  const ringColor = mock ? '#e11d48' : stale ? '#94a3b8' : '#059669';
  const avatarHtml = photoUrl
    ? `<img src="${photoUrl}" style="width:100%;height:100%;object-fit:cover;" />`
    : `<div style="width:100%;height:100%;display:flex;align-items:center;justify-content:center;background:${avatarColor(name)};color:#fff;font-size:13px;font-weight:700;">${getInitials(name)}</div>`;
  return L.divIcon({
    className: '',
    html: `<div style="position:relative;width:38px;height:38px;">
    ${stale ? '' : `<div style="position:absolute;inset:-4px;border-radius:9999px;background:#10b981;opacity:0.3;animation:pulse-tracking 1.8s ease-out infinite;"></div>`}
    <div style="position:absolute;inset:0;border-radius:9999px;overflow:hidden;border:2.5px solid ${ringColor};box-shadow:0 1px 4px rgba(0,0,0,0.4);background:#fff;">${avatarHtml}</div>
  </div>
  <style>@keyframes pulse-tracking{0%{transform:scale(0.8);opacity:0.5;}100%{transform:scale(1.5);opacity:0;}}</style>`,
    iconSize: [38, 38],
    iconAnchor: [19, 19]
  });
};

const pathPointIcon = L.divIcon({
  className: '',
  html: `<div style="width:10px;height:10px;border-radius:9999px;background:var(--g-accent,#7F00FF);border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.35);"></div>`,
  iconSize: [10, 10],
  iconAnchor: [5, 5]
});
// Left out of the route (lib/trackPath.ts): grey for a rough fix / jump,
// red with a ! for a fake-GPS fix.
const roughPointIcon = L.divIcon({
  className: '',
  html: `<div style="width:9px;height:9px;border-radius:9999px;background:#94a3b8;border:2px solid white;opacity:.85;box-shadow:0 1px 2px rgba(0,0,0,0.3);"></div>`,
  iconSize: [9, 9],
  iconAnchor: [4.5, 4.5]
});
const mockPointIcon = L.divIcon({
  className: '',
  html: `<div style="width:16px;height:16px;border-radius:9999px;background:#e11d48;border:2px solid white;color:#fff;font:700 10px/12px system-ui;text-align:center;box-shadow:0 1px 3px rgba(0,0,0,0.4);">!</div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

// Which Live-board cards are folded down to their title bar — kept per
// browser so an Admin's layout survives a reload.
const COLLAPSE_KEY = 'credence.tracking.collapsed';
const CARD_IDS = ['kpi', 'dept', 'notTracked', 'places', 'phone', 'people'] as const;
type CardId = (typeof CARD_IDS)[number];
function readCollapsed(): Partial<Record<CardId, boolean>> {
  try {
    return JSON.parse(localStorage.getItem(COLLAPSE_KEY) || '{}') || {};
  } catch {
    return {};
  }
}
// Pings within ~100 m count as the same place on "Employees by Place".
const placeKey = (p: { lat: any; lng: any }) => `${Number(p.lat).toFixed(3)},${Number(p.lng).toFixed(3)}`;
const MAX_PLACE_LOOKUPS = 25;
const LOW_BATTERY = 15;

// One card under the Live map, foldable to its title bar.
const MiniCard: React.FC<{
  title: string;
  subtitle?: string;
  icon?: React.ReactNode;
  collapsed: boolean;
  onToggle: () => void;
  action?: React.ReactNode;
  className?: string;
  children: React.ReactNode;
}> = ({ title, subtitle, icon, collapsed, onToggle, action, className = '', children }) => (
  <section className={`bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden ${className}`}>
    <header className={`flex items-start justify-between gap-2 px-4 py-3 ${collapsed ? '' : 'border-b border-slate-100'}`}>
      <div className="min-w-0">
        <h4 className="text-sm font-semibold text-slate-900 flex items-center gap-1.5 truncate">
          {icon}
          {title}
        </h4>
        {subtitle && !collapsed && <p className="text-[11px] text-slate-400 mt-0.5 truncate">{subtitle}</p>}
      </div>
      <div className="flex items-center gap-1 shrink-0">
        {!collapsed && action}
        <button
          type="button"
          onClick={onToggle}
          className="w-7 h-7 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600"
          aria-label={collapsed ? `Expand ${title}` : `Minimize ${title}`}
          aria-expanded={!collapsed}
          title={collapsed ? 'Expand' : 'Minimize'}
        >
          {collapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </button>
      </div>
    </header>
    {!collapsed && children}
  </section>
);

// A labelled count with a bar sized against the largest row.
const BarRow: React.FC<{ label: string; count: number; max: number; color: string; onClick?: () => void; hint?: string }> = ({ label, count, max, color, onClick, hint }) => (
  <button type="button" onClick={onClick} disabled={!onClick} title={hint} className="w-full text-left px-4 py-2 hover:bg-slate-50 disabled:hover:bg-transparent disabled:cursor-default">
    <div className="flex items-center justify-between gap-2 text-xs">
      <span className="text-slate-700 truncate">{label}</span>
      <span className="font-semibold text-slate-900 tabular-nums">{count}</span>
    </div>
    <div className="mt-1 h-1.5 rounded-full bg-slate-100 overflow-hidden">
      <div className="h-full rounded-full" style={{ width: `${max ? Math.max(4, (count / max) * 100) : 0}%`, background: color }} />
    </div>
  </button>
);

function minutesAgo(iso: string): number {
  return Math.max(0, Math.round((Date.now() - new Date(iso).getTime()) / 60000));
}

function agoLabel(iso: string): string {
  const m = minutesAgo(iso);
  if (m < 1) return 'just now';
  if (m < 60) return `${m} min ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ${m % 60}m ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// Admin Panel -> Employee Tracking. Two views sharing one map:
//  - Live board (default): every user's SINGLE most recent ping, refreshed on
//    an interval, green pulsing dot if seen within STALE_AFTER_MIN, grey if not.
//  - Path playback: click a user's row (or "View Path") to instead draw their
//    full ping history for an optional date range as a connected purple trail.
export const EmployeeTrackingPanel: React.FC<EmployeeTrackingPanelProps> = ({ token, canStayReport = false, canLive = false }) => {
  const canEmailReports = useCanEmailReports();
  // Live Follow (LiveFollowModal) — who is open, if anyone.
  const [following, setFollowing] = useState<{ id: number; name: string } | null>(null);
  // "Live all" — on until this time (ms), else null.
  const [liveAllUntil, setLiveAllUntil] = useState<number | null>(null);
  const [liveAllError, setLiveAllError] = useState<string | null>(null);
  const [, setLiveAllTick] = useState(0);
  // Stay Report (TrackingStayReport.tsx) — the tracking module's "Stay Report" layer.
  const [showStay, setShowStay] = useState(false);
  // The map filling the whole screen (button on the map, Esc to leave).
  const [mapFull, setMapFull] = useState(false);
  const [live, setLive] = useState<LocationPing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<{ id: number; name: string } | null>(null);
  // Opened from a person's map elsewhere (Dashboard -> Under tracking ->
  // a person -> "Full path & live follow", TrackingPersonMap.tsx): show them.
  useEffect(() => {
    const take = (u: any) => u && Number(u.id) && setSelectedUser({ id: Number(u.id), name: String(u.name || 'User') });
    const pending = (window as any).__credenceTrackingFocus;
    if (pending && Date.now() - Number(pending.at || 0) < 60_000) {
      take(pending);
      (window as any).__credenceTrackingFocus = null;
    }
    const on = (e: Event) => {
      take((e as CustomEvent).detail);
      (window as any).__credenceTrackingFocus = null;
    };
    window.addEventListener('credence:tracking-focus', on);
    return () => window.removeEventListener('credence:tracking-focus', on);
  }, []);
  const [history, setHistory] = useState<LocationPing[]>([]);
  // The route without rough fixes, jumps and fake-GPS points (kept apart).
  const cleaned = useMemo(() => cleanPath(history), [history]);
  const mockCount = useMemo(() => cleaned.rough.filter((p) => p.rough === 'mock').length, [cleaned]);
  const [showRough, setShowRough] = useState(false);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [fromDate, setFromDate] = useState('');
  const [toDate, setToDate] = useState('');
  // Time-of-day window (24h "HH:MM"), separate from the date range above — lets
  // an Admin ask "where was this person between 9am and 6pm" across whatever
  // dates are selected, not just "where were they on this day".
  const [fromTime, setFromTime] = useState('');
  const [toTime, setToTime] = useState('');
  const [searchQuery, setSearchQuery] = useState('');
  const [exportingReport, setExportingReport] = useState(false);
  // History report: previewed on screen first, then downloaded as PDF.
  const [showReport, setShowReport] = useState(false);
  const [addresses, setAddresses] = useState<Record<string, string | null>>({});

  // user_id -> object URL of their Personal Data profile photo, or null once
  // we've confirmed they have none on file (so the marker/list fall back to
  // an initials avatar instead of retrying the fetch every redraw).
  const [photoUrls, setPhotoUrls] = useState<Record<number, string | null>>({});
  const photoUrlsRef = useRef<Record<number, string | null>>({});

  // Counts, reasons and the per-minute chart (GET /api/tracking/status).
  const status = useTrackingStatus(token);
  const [listRequest, setListRequest] = useState<{ which: 'tracked' | 'not_tracked'; query?: string; at: number } | null>(null);
  const [noticeReportRequest, setNoticeReportRequest] = useState(0);
  const openList = (which: 'tracked' | 'not_tracked', query?: string) => setListRequest({ which, query, at: Date.now() });
  const [collapsed, setCollapsed] = useState<Partial<Record<CardId, boolean>>>(readCollapsed);
  const saveCollapsed = (next: Partial<Record<CardId, boolean>>) => {
    setCollapsed(next);
    try {
      localStorage.setItem(COLLAPSE_KEY, JSON.stringify(next));
    } catch {
      /* private window — just don't remember */
    }
  };
  const toggleCard = (id: CardId) => saveCollapsed({ ...collapsed, [id]: !collapsed[id] });
  const allCollapsed = CARD_IDS.every((id) => collapsed[id]);
  const setAllCollapsed = (v: boolean) => saveCollapsed(Object.fromEntries(CARD_IDS.map((id) => [id, v])));
  const [openPhoneRow, setOpenPhoneRow] = useState<string | null>(null);
  const [placeNames, setPlaceNames] = useState<Record<string, string | null>>({});

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);
  const lastFitRef = useRef<string | null>(null);

  const fetchLive = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/tracking/live'), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load live locations');
      }
      setLive(await res.json());
    } catch (err: any) {
      setError(err.message || 'Failed to load live locations');
    } finally {
      setLoading(false);
    }
  }, [token]);

  useEffect(() => {
    fetchLive();
    const interval = setInterval(() => fetchLive(true), LIVE_REFRESH_MS);
    return () => clearInterval(interval);
  }, [fetchLive]);

  // Each reporting user's profile photo (GET /api/profile/photo/:userId),
  // through the app's shared photo cache (UserAvatar.tsx fetchPhoto — one
  // request per person, shared with every other avatar). Each photo shows
  // as soon as it arrives. Before, they were fetched one by one and only
  // shown once ALL had arrived — the map's refresh every minute cut that
  // short, and with many people the photos never appeared.
  useEffect(() => {
    const missing = Array.from(new Set(live.map(p => p.user_id))).filter(
      id => !(id in photoUrlsRef.current)
    );
    if (missing.length === 0) return;
    for (const userId of missing) {
      void fetchPhoto(userId, token).then(url => {
        // A failed request (offline, server error) is tried again next refresh.
        if (url === null && !photoKnownMissing(userId)) return;
        if (photoUrlsRef.current[userId] === url) return;
        photoUrlsRef.current[userId] = url;
        setPhotoUrls(prev => ({ ...prev, [userId]: url }));
      });
    }
  }, [live, token]);

  // Employee filter (Live board only) — narrows both the "Reporting now" list
  // and the map markers to names matching the search box, so an Admin can
  // find one person on a crowded map instead of scanning every dot.
  const filteredLive = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return live;
    return live.filter(p => (p.user_name || '').toLowerCase().includes(q));
  }, [live, searchQuery]);

  // "Live all": put everyone on the map (as filtered, at most LIVE_ALL_MAX)
  // in live mode, keep renewing, and move their markers as pings arrive.
  const liveAllIdsRef = useRef<number[]>([]);
  useEffect(() => {
    if (!liveAllUntil || !canLive) return;
    const ids = liveAllIdsRef.current;
    if (!ids.length) return;
    let stopped = false;
    const watch = async () => {
      try {
        const res = await fetch(apiUrl('/api/tracking/live/watch-many'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ user_ids: ids })
        });
        const d = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(d.error || 'Could not start live tracking.');
        if (!stopped) setLiveAllError(null);
      } catch (e: any) {
        if (!stopped) setLiveAllError(e.message || 'Could not start live tracking.');
      }
    };
    void watch();
    const renew = setInterval(() => void watch(), LIVE_ALL_RENEW_MS);
    // Pings over the socket, drawn together every LIVE_ALL_FLUSH_MS.
    const pending = new Map<number, any>();
    const socket = getChatSocket();
    const onLoc = (d: any) => {
      const id = Number(d?.user_id);
      if (ids.includes(id)) pending.set(id, d);
    };
    socket?.on('tracking:location', onLoc);
    const flush = setInterval(() => {
      if (!pending.size) return;
      const got = new Map(pending);
      pending.clear();
      setLive((prev) =>
        prev.map((p) => {
          const d = got.get(Number(p.user_id));
          return d
            ? { ...p, lat: Number(d.lat), lng: Number(d.lng), recorded_at: d.recorded_at, battery_pct: d.battery_pct ?? p.battery_pct, accuracy_m: d.accuracy_m ?? (p as any).accuracy_m }
            : p;
        })
      );
    }, LIVE_ALL_FLUSH_MS);
    // Countdown on the button; off by itself when the time is up.
    const tick = setInterval(() => {
      setLiveAllTick((n) => n + 1);
      if (Date.now() >= liveAllUntil) setLiveAllUntil(null);
    }, 1000);
    return () => {
      stopped = true;
      clearInterval(renew);
      clearInterval(flush);
      clearInterval(tick);
      socket?.off('tracking:location', onLoc);
      void fetch(apiUrl('/api/tracking/live/unwatch-many'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ user_ids: ids }),
        keepalive: true
      }).catch(() => undefined);
    };
  }, [liveAllUntil, canLive, token]);
  const startLiveAll = () => {
    liveAllIdsRef.current = Array.from(new Set(filteredLive.map((p) => Number(p.user_id)))).slice(0, LIVE_ALL_MAX);
    if (!liveAllIdsRef.current.length) return;
    setLiveAllError(null);
    setLiveAllUntil(Date.now() + LIVE_ALL_MS);
  };
  const liveAllLeft = liveAllUntil ? Math.max(0, liveAllUntil - Date.now()) : 0;
  const liveAllClock = `${Math.floor(liveAllLeft / 60000)}:${String(Math.floor((liveAllLeft % 60000) / 1000)).padStart(2, '0')}`;

  // Live board cards ------------------------------------------------------
  const employees = status?.employees || [];
  const onTheMove = employees.filter((r) => r.tracked && !r.standing_still).length;
  const byDept = (tracked: boolean) => {
    const m = new Map<string, number>();
    employees.filter((r) => r.tracked === tracked).forEach((r) => m.set(r.department, (m.get(r.department) || 0) + 1));
    return Array.from(m.entries()).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]));
  };
  const trackedDepts = useMemo(() => byDept(true), [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const notTrackedDepts = useMemo(() => byDept(false), [status]); // eslint-disable-line react-hooks/exhaustive-deps
  const noticeTargets = employees.filter((r) => !r.tracked && r.user_id).length;

  // Fresh pings grouped by place (~100 m), biggest first.
  const freshLive = useMemo(() => live.filter((p) => minutesAgo(p.recorded_at) <= STALE_AFTER_MIN), [live]);
  const places = useMemo(() => {
    const m = new Map<string, LocationPing[]>();
    freshLive.forEach((p) => {
      const k = placeKey(p);
      m.set(k, [...(m.get(k) || []), p]);
    });
    return Array.from(m.entries()).sort((a, b) => b[1].length - a[1].length);
  }, [freshLive]);
  useEffect(() => {
    let alive = true;
    places.slice(0, MAX_PLACE_LOOKUPS).forEach(([k, list]) => {
      if (k in placeNames) return;
      reverseGeocode(Number(list[0].lat), Number(list[0].lng), 'en').then((name) => {
        if (alive) setPlaceNames((prev) => (k in prev ? prev : { ...prev, [k]: name }));
      });
    });
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [places]);
  const flyToPings = (list: LocationPing[]) => {
    const map = mapRef.current;
    if (!map || list.length === 0) return;
    map.fitBounds(L.latLngBounds(list.map((p) => [Number(p.lat), Number(p.lng)] as [number, number])), { padding: [60, 60], maxZoom: 17 });
    mapContainerRef.current?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  };

  // Phone problems, from the phone's own heartbeat (reason) and the battery
  // level in each person's latest location.
  const phoneRows = useMemo(() => {
    const names = (pred: (r: (typeof employees)[number]) => boolean) => employees.filter(pred).map((r) => r.name).sort();
    const low = live
      .filter((p) => p.battery_pct != null && Number(p.battery_pct) < LOW_BATTERY && minutesAgo(p.recorded_at) <= 120)
      .map((p) => `${p.user_name || 'User'} · ${p.battery_pct}%`)
      .sort();
    const has = (txt: string) => (r: (typeof employees)[number]) => !r.tracked && !!r.reason && r.reason.includes(txt);
    return [
      { key: 'battery', label: `Battery below ${LOW_BATTERY}%`, color: '#dc2626', names: low },
      { key: 'gps', label: 'Location (GPS) off', color: '#dc2626', names: names(has('GPS) is OFF')) },
      { key: 'saver', label: 'No GPS fix (battery saver / weak signal)', color: '#d97706', names: names(has('no GPS fix')) },
      { key: 'allTime', label: "Location only 'While using the app'", color: '#d97706', names: names(has('Allow all the time')) },
      { key: 'perm', label: 'Location permission removed', color: '#d97706', names: names(has('permission removed')) },
      { key: 'offline', label: 'App closed or phone offline', color: '#64748b', names: names(has('App closed')) },
      { key: 'never', label: 'Never sent a location', color: '#94a3b8', names: names(has('Never sent')) },
      { key: 'off', label: 'Tracking not turned on / no login', color: '#94a3b8', names: names((r) => !r.tracked && (r.reason === 'Tracking not turned on' || r.reason === 'No login account')) }
    ];
  }, [status, live]); // eslint-disable-line react-hooks/exhaustive-deps

  const fetchHistory = useCallback(async (userId: number) => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('user_id', String(userId));
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
      if (fromTime) params.set('from_time', fromTime);
      if (toTime) params.set('to_time', toTime);
      const res = await fetch(apiUrl(`/api/tracking/history?${params.toString()}`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error || 'Failed to load path history');
      }
      setHistory(await res.json());
    } catch (err: any) {
      setError(err.message || 'Failed to load path history');
    } finally {
      setHistoryLoading(false);
    }
  }, [token, fromDate, toDate, fromTime, toTime]);

  const reportRows = useMemo(() => [...history].sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1)), [history]);
  // Which report rows were left out of the route, and why (by the row itself).
  const roughById = useMemo(() => {
    const byTime = new Map<string, RoughReason>(cleaned.rough.map((p) => [`${p.recorded_at}|${p.lat}|${p.lng}`, p.rough]));
    const m = new Map<LocationPing, RoughReason>();
    for (const p of history) {
      const r = byTime.get(`${p.recorded_at}|${p.lat}|${p.lng}`);
      if (r) m.set(p, r);
    }
    return m;
  }, [cleaned, history]);

  // While the report is open, look up the address of every distinct spot
  // (cached across openings; one request at a time, see reverseGeocode.ts).
  useEffect(() => {
    if (!showReport) return;
    let alive = true;
    const keys = Array.from(new Set(reportRows.map(addressKey))).filter((k) => !(k in addresses));
    for (const k of keys) {
      const [lat, lng] = k.split(',').map(Number);
      reverseGeocode(lat, lng, 'en', true).then((addr) => {
        if (alive) setAddresses((prev) => (k in prev ? prev : { ...prev, [k]: addr }));
      });
    }
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [showReport, reportRows]);

  const addressOf = (p: LocationPing): string => {
    const a = addresses[addressKey(p)];
    return a || `${Number(p.lat).toFixed(6)}, ${Number(p.lng).toFixed(6)}`;
  };
  const addressKeys = useMemo(() => Array.from(new Set(reportRows.map(addressKey))), [reportRows]);
  const addressesFound = addressKeys.filter((k) => k in addresses).length;

  // Exports whatever's currently loaded in `history` (already scoped to
  // selectedUser + the date/time filters above) as a printable PDF — oldest
  // point first, one row per ping, so an Admin can hand someone "where was
  // this employee between X and Y" as a document instead of a map they'd have
  // to screenshot.
  const handleExportReport = useCallback(async (mode: 'save' | 'email' = 'save') => {
    if (!selectedUser || history.length === 0) return;
    setExportingReport(true);
    try {
      const logoImg = await loadImageElement(credenceLogo);
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const sorted = reportRows;

      const letterheadOptions = {
        reportTitle: 'Employee Tracking History Report',
        filters: [
          ['Employee', selectedUser.name],
          ['Date Range', fromDate || toDate ? `${fromDate || 'Any'} to ${toDate || 'Any'}` : 'All dates'],
          ['Time Range', fromTime || toTime ? `${fromTime || '00:00'} to ${toTime || '23:59'}` : 'All day'],
          ['Total Points', String(sorted.length)]
        ] as [string, string][]
      };
      const contentStartY = drawPdfLetterhead(doc, logoImg, letterheadOptions);

      autoTable(doc, {
      theme: 'grid',
        startY: contentStartY,
        margin: { top: contentStartY, left: 8, right: 8 },
        head: [['SL', 'Date & Time', 'Location', 'Accuracy (m)', 'Battery']],
        body: sorted.map((p, idx) => [
          String(idx + 1),
          formatDateTime(p.recorded_at),
          addressOf(p),
          (p.accuracy_m != null ? String(p.accuracy_m) : '—') + (roughById.get(p) ? ` (${roughById.get(p) === 'mock' ? 'Fake GPS' : roughById.get(p) === 'jump' ? 'jump' : 'rough'})` : ''),
          p.battery_pct != null ? `${p.battery_pct}%` : '—'
        ]),
        styles: { ...STD_STYLES, fontSize: 8, cellPadding: 1.5, overflow: 'linebreak' },
        columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 38 }, 3: { cellWidth: 22 }, 4: { cellWidth: 16 } },
        headStyles: { ...STD_HEAD, fontSize: 8 },
        didDrawPage: () => { drawPdfLetterhead(doc, logoImg, letterheadOptions); }
      });

      finalizePdfPageNumbers(doc);
      const safeName = selectedUser.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Employee';
      if (mode === 'email') {
        await emailReport(doc, { fileName: `Tracking-History-${safeName}.pdf`, title: letterheadOptions.reportTitle });
        return;
      }
      await savePdfCrossPlatform(doc, `Tracking-History-${safeName}.pdf`);
    } catch (err: any) {
      setError(err.message || 'Failed to export report');
    } finally {
      setExportingReport(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedUser, reportRows, addresses, fromDate, toDate, fromTime, toTime]);

  useEffect(() => {
    if (selectedUser) fetchHistory(selectedUser.id);
  }, [selectedUser, fetchHistory]);

  // Initialize the map once.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    // Half-step zoom, and two levels past the tiles' own 19 (the last tiles
    // are enlarged) so a single street or building can be looked at closely.
    const map = L.map(mapContainerRef.current, { zoomControl: false, zoomSnap: 0.5, zoomDelta: 0.5, wheelPxPerZoomLevel: 90, maxZoom: 21 }).setView([23.8103, 90.4125], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      className: 'tracking-tiles',
      maxNativeZoom: 19,
      maxZoom: 21
    }).addTo(map);
    // Zoom box bottom-left: the title, search and KPI card sit top-left.
    L.control.zoom({ position: 'bottomleft' }).addTo(map);
    L.control.scale({ imperial: false }).addTo(map);
    markersLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 100);
  }, []);

  // Full screen on/off: Leaflet has to re-measure its box.
  useEffect(() => {
    const t = setTimeout(() => mapRef.current?.invalidateSize(), 60);
    if (!mapFull) return () => clearTimeout(t);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMapFull(false);
    window.addEventListener('keydown', onKey);
    return () => {
      clearTimeout(t);
      window.removeEventListener('keydown', onKey);
    };
  }, [mapFull]);

  // Redraw whenever the live board OR the selected user's path changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    if (selectedUser) {
      lastFitRef.current = null;
      // Path playback mode — connected trail, oldest -> newest.
      // The route: only fixes good enough to draw (lib/trackPath.ts).
      const sorted = cleaned.route;
      const shownRough = cleaned.rough.filter((p) => p.rough === 'mock' || showRough);
      if (sorted.length === 0 && shownRough.length === 0) return;
      const latlngs = sorted.map(p => [Number(p.lat), Number(p.lng)] as [number, number]);
      if (latlngs.length > 1) L.polyline(latlngs, { color: '#7F00FF', weight: 3, opacity: 0.7, dashArray: '6 6' }).addTo(layer);
      // Tapping a point also shows how far off it may be (the phone's own
      // accuracy estimate) as a faint circle.
      const withAccuracyCircle = (marker: L.Marker, p: LocationPing, color: string) => {
        let circle: L.Circle | null = null;
        marker.on('popupopen', () => {
          if (p.accuracy_m != null && Number(p.accuracy_m) > 0)
            circle = L.circle([Number(p.lat), Number(p.lng)], { radius: Number(p.accuracy_m), color, weight: 1, fillOpacity: 0.08 }).addTo(layer);
        });
        marker.on('popupclose', () => {
          if (circle) layer.removeLayer(circle);
          circle = null;
        });
      };
      const acc = (p: LocationPing) => (p.accuracy_m != null ? `<br/>Accuracy: ± ${p.accuracy_m} m` : '');
      sorted.forEach((p, i) => {
        const marker = L.marker([Number(p.lat), Number(p.lng)], { icon: pathPointIcon }).addTo(layer);
        marker.bindPopup(
          `<div style="font-size:12px;"><b>${i === 0 ? 'Start' : i === sorted.length - 1 ? 'Latest' : 'Point ' + (i + 1)}</b><br/>${formatDate(p.recorded_at)}${acc(p)}${p.battery_pct != null ? `<br/>Battery: ${p.battery_pct}%` : ''}</div>`
        );
        withAccuracyCircle(marker, p, '#7F00FF');
      });
      shownRough.forEach((p) => {
        const mock = p.rough === 'mock';
        const marker = L.marker([Number(p.lat), Number(p.lng)], { icon: mock ? mockPointIcon : roughPointIcon, zIndexOffset: mock ? 500 : -100 }).addTo(layer);
        marker.bindPopup(
          `<div style="font-size:12px;"><b style="color:${mock ? '#e11d48' : '#475569'}">${ROUGH_LABEL[p.rough as RoughReason]}</b><br/>${formatDate(p.recorded_at)}${acc(p)}<br/><span style="color:#64748b">Not part of the route.</span></div>`
        );
        withAccuracyCircle(marker, p, mock ? '#e11d48' : '#64748b');
      });
      const all = [...latlngs, ...shownRough.map((p) => [Number(p.lat), Number(p.lng)] as [number, number])];
      map.fitBounds(L.latLngBounds(all), { padding: [40, 40], maxZoom: 17 });
    } else {
      // Live board mode — one dot (now an avatar/photo) per user, latest
      // position only, restricted to whoever matches the employee filter.
      if (filteredLive.length === 0) return;
      const bounds: [number, number][] = [];
      filteredLive.forEach(p => {
        const stale = minutesAgo(p.recorded_at) > STALE_AFTER_MIN;
        const name = p.user_name || 'User';
        const mock = Number((p as any).is_mock) === 1;
        const icon = liveMarkerIcon(stale, name, photoUrls[p.user_id], mock);
        const marker = L.marker([Number(p.lat), Number(p.lng)], { icon }).addTo(layer);
        // Built as elements (a name is text, never HTML), with Live (opens
        // Live Follow, needs the tracking "live" layer) and Path buttons.
        const box = document.createElement('div');
        box.style.fontSize = '12px';
        box.style.minWidth = '150px';
        const b = document.createElement('b');
        b.textContent = name;
        box.appendChild(b);
        if (mock) {
          const w = document.createElement('div');
          w.textContent = '⚠ Fake GPS — this location came from a mock-location app';
          w.style.cssText = 'color:#e11d48;font-weight:600;margin-top:2px;';
          box.appendChild(w);
        }
        const info = document.createElement('div');
        info.textContent = agoLabel(p.recorded_at);
        box.appendChild(info);
        if (p.battery_pct != null) {
          const bat = document.createElement('div');
          bat.textContent = `Battery: ${p.battery_pct}%`;
          box.appendChild(bat);
        }
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:6px;margin-top:8px';
        const btn = (label: string, primary: boolean, onClick: () => void) => {
          const el = document.createElement('button');
          el.type = 'button';
          el.textContent = label;
          el.style.cssText = `flex:1;padding:5px 10px;border-radius:999px;font-size:11.5px;font-weight:600;cursor:pointer;border:1px solid ${primary ? '#059669' : '#cbd5e1'};background:${primary ? '#059669' : '#fff'};color:${primary ? '#fff' : '#334155'}`;
          el.addEventListener('click', (e) => {
            e.stopPropagation();
            marker.closePopup();
            onClick();
          });
          row.appendChild(el);
        };
        const who = { id: Number(p.user_id), name };
        if (canLive) btn('● Live', true, () => setFollowing(who));
        btn('Path', false, () => setSelectedUser(who));
        box.appendChild(row);
        marker.bindPopup(box);
        bounds.push([Number(p.lat), Number(p.lng)]);
      });
      // Re-fit only when who is shown changes, so the minute refresh doesn't
      // throw away a zoom the Admin chose (or a place picked from the cards).
      const sig = filteredLive.map((p) => p.user_id).sort().join(',');
      if (bounds.length > 0 && sig !== lastFitRef.current) map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 15 });
      lastFitRef.current = sig;
    }
  }, [filteredLive, history, cleaned, showRough, selectedUser, photoUrls, canLive]);

  const bars = status?.updates_per_minute || [];
  const barMax = Math.max(1, ...bars);
  const updatesLast30 = bars.reduce((a, b) => a + b, 0);
  const deptMax = Math.max(1, ...trackedDepts.map(([, n]) => n));
  const notDeptMax = Math.max(1, ...notTrackedDepts.map(([, n]) => n));
  const placeMax = Math.max(1, ...places.map(([, l]) => l.length));
  const phoneMax = Math.max(1, ...phoneRows.map((r) => r.names.length));

  return (
    <div className="space-y-4">
      {selectedUser && (
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
              <Navigation className="w-5 h-5 text-emerald-600" /> Employee Tracking
            </h3>
            <p className="text-sm text-slate-500 mt-0.5">Showing {selectedUser.name}'s movement path</p>
          </div>
          <div className="flex items-center gap-2">
            {canLive && (
              <button
                onClick={() => setFollowing(selectedUser)}
                className="liquid-glass-button rounded-full flex items-center gap-1.5 px-3.5 py-2 text-sm font-semibold"
              >
                <Radio className="w-3.5 h-3.5" /> Live Follow
              </button>
            )}
            <button
              onClick={() => { setSelectedUser(null); setHistory([]); }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              <X className="w-3.5 h-3.5" /> Back to Live
            </button>
          </div>
        </div>
      )}

      {selectedUser && (
        <div className="flex flex-wrap items-center gap-2 bg-violet-50 border border-violet-200 rounded-lg px-3 py-2">
          <span className="text-xs font-medium text-violet-700">Date range:</span>
          <input type="date" value={fromDate} onChange={e => setFromDate(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" />
          <span className="text-xs text-slate-400">to</span>
          <input type="date" value={toDate} onChange={e => setToDate(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" />
          <span className="text-xs font-medium text-violet-700 ml-2">Time range:</span>
          <input type="time" value={fromTime} onChange={e => setFromTime(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" />
          <span className="text-xs text-slate-400">to</span>
          <input type="time" value={toTime} onChange={e => setToTime(e.target.value)} className="text-xs border border-slate-200 rounded px-2 py-1" />
          <button
            onClick={() => fetchHistory(selectedUser.id)}
            className="text-xs px-2.5 py-1 rounded bg-violet-600 text-white hover:bg-violet-700"
          >
            Apply
          </button>
          {historyLoading && <span className="text-xs text-slate-400">Loading…</span>}
          {!historyLoading && (
            <span className="text-xs text-slate-500 inline-flex items-center gap-1.5 flex-wrap">
              {cleaned.route.length} point{cleaned.route.length === 1 ? '' : 's'}
              {cleaned.rough.length - mockCount > 0 && (
                <button
                  type="button"
                  onClick={() => setShowRough((v) => !v)}
                  className={`px-2 py-0.5 rounded-full border text-[11px] font-semibold ${showRough ? 'bg-slate-700 text-white border-slate-700' : 'bg-white text-slate-600 border-slate-300 hover:bg-slate-50'}`}
                  title={`Rough fixes (worse than ± ${MAX_ACCURACY_M} m — Wi-Fi / mobile-tower guesses, not GPS) and jumps out of line are left out of the route. Tap to show them in grey.`}
                >
                  {showRough ? 'Hide' : 'Show'} {cleaned.rough.length - mockCount} rough
                </button>
              )}
              {mockCount > 0 && (
                <span className="px-2 py-0.5 rounded-full bg-rose-50 border border-rose-200 text-rose-700 text-[11px] font-semibold" title="The phone said these locations came from a mock-location (fake GPS) app.">
                  {mockCount} fake GPS
                </span>
              )}
            </span>
          )}
          <button
            onClick={() => setShowReport(true)}
            disabled={history.length === 0}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
          >
            <FileText className="w-3.5 h-3.5" /> View Report
          </button>
          {canStayReport && (
            <button
              onClick={() => setShowStay(true)}
              className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-violet-600 text-white hover:bg-violet-700"
              title="How long at each place, day by day, inside the time range"
            >
              <Timer className="w-3.5 h-3.5" /> Stay Report
            </button>
          )}
        </div>
      )}
      {showStay && selectedUser && canStayReport && (
        <TrackingStayReport
          token={token}
          user={selectedUser}
          initial={{ from: fromDate, to: toDate, fromTime, toTime }}
          onClose={() => setShowStay(false)}
        />
      )}

      {error && (
        <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>
      )}

      {/* The map fills the width; title, search, tools, the KPI card and the
          legend float over it (Analytics "Realtime" style). `isolate`: those
          float at z-[1000] (above Leaflet's own layers) — kept inside the map,
          so a popup opened over the page (Chat, Alerts…) stays on top of them.
          The outer box too (the "Right now" card sits beside the map in it) —
          but not in full screen, where the map itself must cover the page. */}
      <div className={mapFull ? 'relative' : 'relative isolate'}>
        <div
          className={
            mapFull
              ? 'map-fullscreen fixed inset-0 z-[1040] bg-white isolate'
              : 'relative isolate rounded-2xl overflow-hidden border border-slate-200 h-[420px] sm:h-[480px] lg:h-[max(560px,calc(100vh-260px))]'
          }
        >
          <div ref={mapContainerRef} className="w-full h-full bg-slate-100" />

          {!selectedUser && (
            <div className="absolute top-3 left-3 right-14 z-[1000] flex flex-wrap items-center gap-2 pointer-events-none">
              <span className="pointer-events-auto inline-flex items-center gap-2 whitespace-nowrap rounded-full bg-white/95 border border-slate-200 shadow-sm px-3 sm:px-3.5 py-1.5 text-xs sm:text-sm font-semibold text-slate-900">
                <Navigation className="w-4 h-4 text-emerald-600" /> Employee Tracking
                <span className="inline-flex items-center gap-1 rounded-full bg-emerald-50 text-emerald-700 px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide">
                  <span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" /> Live
                </span>
              </span>
              <span className="pointer-events-auto relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={searchQuery}
                  onChange={e => setSearchQuery(e.target.value)}
                  placeholder="Find an employee on the map…"
                  aria-label="Filter the map by employee name"
                  className="w-48 sm:w-64 pl-8 pr-7 py-1.5 text-xs bg-white/95 border border-slate-200 shadow-sm rounded-full focus:outline-none focus:ring-2 focus:ring-emerald-500/30"
                />
                {searchQuery && (
                  <button
                    onClick={() => setSearchQuery('')}
                    className="absolute right-2 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
                    aria-label="Clear filter"
                  >
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </span>
              {searchQuery && (
                <span className="pointer-events-auto rounded-full bg-white/95 border border-slate-200 shadow-sm px-2.5 py-1 text-[11px] text-slate-600">
                  {filteredLive.length} of {live.length}
                </span>
              )}
            </div>
          )}

          <div className="absolute top-3 right-3 z-[1000] flex flex-col gap-2">
            <button
              type="button"
              onClick={() => setMapFull((v) => !v)}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-white border border-slate-200 shadow-sm text-slate-700 hover:bg-slate-50"
              title={mapFull ? 'Exit full screen (Esc)' : 'Full screen map'}
              aria-label={mapFull ? 'Exit full screen' : 'Full screen map'}
            >
              {mapFull ? <Minimize2 className="w-4 h-4" /> : <Maximize2 className="w-4 h-4" />}
            </button>
            <button
              type="button"
              onClick={() => fetchLive()}
              className="w-9 h-9 flex items-center justify-center rounded-full bg-white border border-slate-200 shadow-sm text-slate-700 hover:bg-slate-50"
              title="Refresh now"
              aria-label="Refresh now"
            >
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
            {canLive && !selectedUser && (
              <button
                type="button"
                onClick={() => (liveAllUntil ? setLiveAllUntil(null) : startLiveAll())}
                disabled={!liveAllUntil && filteredLive.length === 0}
                className={`h-9 px-3 flex items-center justify-center gap-1.5 rounded-full border shadow-sm text-xs font-semibold disabled:opacity-40 ${
                  liveAllUntil ? 'bg-emerald-600 border-emerald-600 text-white hover:bg-emerald-700' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'
                }`}
                title={
                  liveAllUntil
                    ? 'Stop live for everyone on the map'
                    : `Live for everyone on the map (${Math.min(filteredLive.length, LIVE_ALL_MAX)}) for ${LIVE_ALL_MS / 60000} minutes — uses more of their phones' battery`
                }
                aria-pressed={!!liveAllUntil}
              >
                <Radio className={`w-3.5 h-3.5 ${liveAllUntil ? 'animate-pulse' : ''}`} />
                {liveAllUntil ? `Live · ${liveAllClock}` : 'Live all'}
              </button>
            )}
          </div>
          {liveAllUntil && (
            <div className="absolute bottom-14 left-1/2 -translate-x-1/2 z-[1000] rounded-full bg-emerald-600/95 text-white text-[11px] font-medium px-3 py-1 shadow-sm">
              {liveAllError ? liveAllError : `Live: ${liveAllIdsRef.current.length} on the map · positions move as they arrive`}
            </div>
          )}

          {!selectedUser && (
            <div className="absolute bottom-6 right-3 z-[1000] hidden sm:flex items-center gap-3 rounded-full bg-white/95 border border-slate-200 shadow-sm px-3 py-1.5 text-[11px] text-slate-600">
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-emerald-500" /> Sent a location in the last {STALE_AFTER_MIN} min</span>
              <span className="flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-full bg-slate-400" /> No update for {STALE_AFTER_MIN}+ min</span>
            </div>
          )}
        </div>

        {/* Floating KPI card (over the map on wide screens, under it on phones). */}
        {!selectedUser && !mapFull && status && (
          <div className="mt-3 lg:mt-0 lg:absolute lg:top-16 lg:left-3 lg:w-[300px] z-[1000]">
            <MiniCard
              title="Right now"
              subtitle={`Under tracking = a location in the last ${status.live_minutes} min`}
              collapsed={!!collapsed.kpi}
              onToggle={() => toggleCard('kpi')}
              className="shadow-lg"
            >
              <div className="px-4 pt-3 pb-4">
                <button type="button" onClick={() => openList('tracked')} className="block text-left w-full group" title="See who, by Department">
                  <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Under tracking now</div>
                  <div className="text-4xl font-bold text-slate-900 leading-tight group-hover:text-emerald-700 tabular-nums">{status.tracked}</div>
                </button>
                <div className="grid grid-cols-2 gap-2 mt-2">
                  <button type="button" onClick={() => openList('not_tracked')} className="text-left rounded-xl bg-slate-50 border border-slate-100 px-2.5 py-2 hover:bg-slate-100">
                    <div className="text-lg font-bold text-slate-900 tabular-nums">{status.not_tracked}</div>
                    <div className="text-[10px] text-slate-500">Not tracked</div>
                  </button>
                  <div className="rounded-xl bg-emerald-50 border border-emerald-100 px-2.5 py-2">
                    <div className="text-lg font-bold text-emerald-700 tabular-nums">{onTheMove}</div>
                    <div className="text-[10px] text-emerald-700">On the move</div>
                  </div>
                </div>
                <div className="mt-3">
                  <div className="flex items-center justify-between text-[10px] text-slate-500 mb-1">
                    <span>Location updates per minute</span>
                    <span className="tabular-nums">{updatesLast30} in 30 min</span>
                  </div>
                  <div className="flex items-end gap-[2px] h-12" role="img" aria-label={`Location updates per minute over the last 30 minutes: ${updatesLast30} in total`}>
                    {(bars.length ? bars : new Array(30).fill(0)).map((n, i) => (
                      <div
                        key={i}
                        className="flex-1 rounded-t-sm bg-emerald-500/80"
                        style={{ height: `${n ? Math.max(8, (n / barMax) * 100) : 3}%`, opacity: n ? 1 : 0.25 }}
                        title={`${30 - i} min ago: ${n} update${n === 1 ? '' : 's'}`}
                      />
                    ))}
                  </div>
                  <div className="flex justify-between text-[9px] text-slate-400 mt-0.5">
                    <span>-30 min</span>
                    <span>now</span>
                  </div>
                </div>
              </div>
            </MiniCard>
          </div>
        )}
      </div>

      {!selectedUser && (
        <>
          <div className="flex items-center justify-between gap-2">
            <p className="text-xs text-slate-500">
              {loading ? 'Loading…' : `${live.length} employee${live.length === 1 ? '' : 's'} on the map · refreshes every minute`}
            </p>
            <button
              type="button"
              onClick={() => setAllCollapsed(!allCollapsed)}
              className="flex items-center gap-1 text-xs font-semibold text-slate-600 rounded-full border border-slate-200 bg-white px-3 py-1.5 hover:bg-slate-50"
            >
              {allCollapsed ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronUp className="w-3.5 h-3.5" />}
              {allCollapsed ? 'Expand all' : 'Collapse all cards'}
            </button>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-4 items-start">
            <MiniCard
              title="Under tracking"
              subtitle="by Department · tap a row to see who"
              icon={<Building2 className="w-4 h-4 text-emerald-600" />}
              collapsed={!!collapsed.dept}
              onToggle={() => toggleCard('dept')}
            >
              <div className="py-1 max-h-72 overflow-y-auto">
                {trackedDepts.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-slate-400">Nobody is under tracking right now.</p>
                ) : (
                  trackedDepts.map(([d, n]) => <BarRow key={d} label={d} count={n} max={deptMax} color="#10b981" onClick={() => openList('tracked', d)} />)
                )}
              </div>
            </MiniCard>

            <MiniCard
              title="Not tracked"
              subtitle="by Department · tap a row to see who and why"
              icon={<Navigation className="w-4 h-4 text-slate-400" />}
              collapsed={!!collapsed.notTracked}
              onToggle={() => toggleCard('notTracked')}
              action={
                <button type="button" onClick={() => setNoticeReportRequest(Date.now())} className="text-[11px] font-semibold text-blue-600 hover:underline flex items-center gap-1" title="Not Tracked Notice Report">
                  <BarChart3 className="w-3.5 h-3.5" /> Report
                </button>
              }
            >
              <div className="py-1 max-h-60 overflow-y-auto">
                {notTrackedDepts.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-slate-400">Everyone is under tracking.</p>
                ) : (
                  notTrackedDepts.map(([d, n]) => <BarRow key={d} label={d} count={n} max={notDeptMax} color="#94a3b8" onClick={() => openList('not_tracked', d)} />)
                )}
              </div>
              {status?.can_send_notice && noticeTargets > 0 && (
                <div className="px-4 py-3 border-t border-slate-100">
                  <button
                    type="button"
                    onClick={() => openList('not_tracked')}
                    className="w-full flex items-center justify-center gap-1.5 rounded-full bg-blue-600 text-white text-xs font-semibold px-3 py-2 hover:bg-blue-700"
                  >
                    <Send className="w-3.5 h-3.5" /> Send notice to {noticeTargets}
                  </button>
                </div>
              )}
            </MiniCard>

            <MiniCard
              title="Employees by place"
              subtitle={`Right now · last ${STALE_AFTER_MIN} min · tap to see on the map`}
              icon={<MapPin className="w-4 h-4 text-emerald-600" />}
              collapsed={!!collapsed.places}
              onToggle={() => toggleCard('places')}
            >
              <div className="py-1 max-h-72 overflow-y-auto">
                {places.length === 0 ? (
                  <p className="px-4 py-4 text-xs text-slate-400">No fresh locations in the last {STALE_AFTER_MIN} min.</p>
                ) : (
                  places.map(([k, list]) => {
                    const name = placeNames[k];
                    const label = name || (k in placeNames ? `${Number(list[0].lat).toFixed(4)}, ${Number(list[0].lng).toFixed(4)}` : 'Finding place…');
                    return (
                      <BarRow
                        key={k}
                        label={label}
                        count={list.length}
                        max={placeMax}
                        color="#0891b2"
                        hint={list.map((p) => p.user_name || 'User').join(', ')}
                        onClick={() => flyToPings(list)}
                      />
                    );
                  })
                )}
              </div>
            </MiniCard>

            <MiniCard
              title="Phone status"
              subtitle="What is stopping tracking · tap to see who"
              icon={<Smartphone className="w-4 h-4 text-amber-600" />}
              collapsed={!!collapsed.phone}
              onToggle={() => toggleCard('phone')}
            >
              <div className="py-1 max-h-72 overflow-y-auto">
                {phoneRows.every((r) => r.names.length === 0) ? (
                  <p className="px-4 py-4 text-xs text-slate-400">No phone problems right now.</p>
                ) : (
                  phoneRows
                    .filter((r) => r.names.length > 0)
                    .map((r) => (
                      <div key={r.key}>
                        <BarRow label={r.label} count={r.names.length} max={phoneMax} color={r.color} onClick={() => setOpenPhoneRow(openPhoneRow === r.key ? null : r.key)} />
                        {openPhoneRow === r.key && (
                          <ul className="mx-4 mb-2 rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-[11px] text-slate-600 space-y-0.5 max-h-40 overflow-y-auto">
                            {r.names.map((n, i) => <li key={i} className="truncate">{n}</li>)}
                          </ul>
                        )}
                      </div>
                    ))
                )}
              </div>
            </MiniCard>
          </div>

          <MiniCard
            title="Reporting now"
            subtitle="Latest location of each employee · tap a name for their path"
            icon={<Clock className="w-4 h-4 text-slate-500" />}
            collapsed={!!collapsed.people}
            onToggle={() => toggleCard('people')}
          >
            <div className="max-h-[420px] overflow-y-auto divide-y divide-slate-100">
              {loading ? (
                <div className="p-4 text-sm text-slate-400">Loading…</div>
              ) : live.length === 0 ? (
                <div className="p-4 text-sm text-slate-400">
                  No one has reported a location yet. Grant "Employee Tracking" access to a user
                  (Admin Panel -&gt; Users) and it'll appear here once their app sends its first ping.
                </div>
              ) : filteredLive.length === 0 ? (
                <div className="p-4 text-sm text-slate-400">No employee matches "{searchQuery}".</div>
              ) : (
                filteredLive.map(p => {
                  const stale = minutesAgo(p.recorded_at) > STALE_AFTER_MIN;
                  const name = p.user_name || 'User';
                  const photoUrl = photoUrls[p.user_id];
                  const lowBattery = p.battery_pct != null && Number(p.battery_pct) < LOW_BATTERY;
                  return (
                    <div key={p.user_id} className="flex items-center gap-3 px-4 py-2.5 hover:bg-slate-50">
                      <button onClick={() => setSelectedUser({ id: p.user_id, name })} className="flex items-center gap-2.5 min-w-0 flex-1 text-left" title={`Show ${name}'s path`}>
                        <span className="relative shrink-0 w-8 h-8 rounded-full overflow-hidden border border-white ring-1 ring-slate-200">
                          {photoUrl ? (
                            <img src={photoUrl} alt={name} className="w-full h-full object-cover" />
                          ) : (
                            <span className="w-full h-full flex items-center justify-center text-[11px] font-bold text-white" style={{ background: avatarColor(name) }}>
                              {getInitials(name)}
                            </span>
                          )}
                          <span className={`absolute -bottom-0.5 -right-0.5 w-2.5 h-2.5 rounded-full border border-white ${stale ? 'bg-slate-300' : 'bg-emerald-500'}`} />
                        </span>
                        <span className="min-w-0">
                          <span className="block text-sm font-medium text-slate-800 truncate">{name}</span>
                          <span className="flex flex-wrap items-center gap-x-3 text-[11px] text-slate-400 whitespace-nowrap">
                            <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {agoLabel(p.recorded_at)}</span>
                            {p.battery_pct != null && (
                              <span className={`flex items-center gap-1 ${lowBattery ? 'text-rose-600 font-semibold' : ''}`}><BatteryMedium className="w-3 h-3" /> {p.battery_pct}%</span>
                            )}
                          </span>
                        </span>
                      </button>
                      <button onClick={() => flyToPings([p])} className="hidden sm:flex shrink-0 w-8 h-8 rounded-full items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-emerald-700" title={`Show ${name} on the map`} aria-label={`Show ${name} on the map`}>
                        <MapPin className="w-4 h-4" />
                      </button>
                      <button onClick={() => setSelectedUser({ id: p.user_id, name })} className="shrink-0 w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-violet-700" title={`Show ${name}'s path`} aria-label={`Show ${name}'s path`}>
                        <Route className="w-4 h-4" />
                      </button>
                      {canLive && (
                        <button
                          onClick={() => setFollowing({ id: p.user_id, name })}
                          title={`Follow ${name} live`}
                          className="shrink-0 inline-flex items-center gap-1 rounded-full px-2.5 py-1 text-[11px] font-bold bg-emerald-50 text-emerald-700 ring-1 ring-emerald-200 hover:bg-emerald-100"
                        >
                          <Radio className="w-3 h-3" /> Live
                        </button>
                      )}
                    </div>
                  );
                })
              )}
            </div>
          </MiniCard>

          {/* The who-list / Send Notice / Notice Report popups. */}
          <TrackingStatusCards token={token} variant="lists" external status={status} openRequest={listRequest} reportRequest={noticeReportRequest} onFullPath={(u) => setSelectedUser(u)} />
        </>
      )}

      {following && canLive && (
        <LiveFollowModal token={token} userId={following.id} name={following.name} onClose={() => setFollowing(null)} />
      )}

      {/* History report preview — read it on screen, then download the PDF. */}
      {showReport && selectedUser && (
        <div className="fixed inset-0 z-[1000] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-3 sm:p-6" onClick={() => setShowReport(false)}>
          <div
            role="dialog"
            aria-label="Employee Tracking History Report"
            className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b border-slate-100 shrink-0">
              <div className="min-w-0">
                <h3 className="text-sm font-bold text-slate-900">Employee Tracking History Report</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {selectedUser.name} · {fromDate || toDate ? `${fromDate || 'Any'} to ${toDate || 'Any'}` : 'All dates'} ·{' '}
                  {fromTime || toTime ? `${fromTime || '00:00'}–${toTime || '23:59'}` : 'All day'} · {reportRows.length} point{reportRows.length === 1 ? '' : 's'}
                </p>
                {addressesFound < addressKeys.length && (
                  <p className="text-[11px] text-amber-600 mt-1">
                    Finding addresses… {addressesFound} of {addressKeys.length} places. Places not found yet show their coordinates.
                  </p>
                )}
              </div>
              <div className="flex items-center gap-2 shrink-0">
                <button
                  onClick={() => handleExportReport()}
                  disabled={exportingReport}
                  className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
                >
                  <FileDown className="w-3.5 h-3.5" /> {exportingReport ? 'Preparing…' : 'Download PDF'}
                </button>
                {canEmailReports && (
                  <EmailReportButton
                    onClick={() => handleExportReport('email')}
                    disabled={exportingReport}
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-emerald-600 bg-white text-emerald-700 hover:bg-emerald-50 disabled:opacity-50"
                  />
                )}
                <button
                  onClick={() => setShowReport(false)}
                  className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100 hover:text-slate-600"
                  aria-label="Close"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>
            <div className="overflow-auto">
              <table className="w-full text-xs">
                <thead className="sticky top-0 bg-emerald-600 text-white">
                  <tr className="text-left">
                    <th className="px-3 py-2 font-semibold w-10">SL</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Date &amp; Time</th>
                    <th className="px-3 py-2 font-semibold">Location</th>
                    <th className="px-3 py-2 font-semibold whitespace-nowrap">Accuracy (m)</th>
                    <th className="px-3 py-2 font-semibold">Battery</th>
                  </tr>
                </thead>
                <tbody>
                  {reportRows.map((p, i) => {
                    const k = addressKey(p);
                    const found = k in addresses;
                    return (
                      <tr key={p.id ?? i} className="border-b border-slate-100 odd:bg-white even:bg-slate-50 align-top">
                        <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-2 text-slate-700 whitespace-nowrap">{formatDateTime(p.recorded_at)}</td>
                        <td className="px-3 py-2 text-slate-800">
                          <span className="flex items-start gap-1.5">
                            <MapPin className="w-3.5 h-3.5 text-emerald-600 shrink-0 mt-0.5" />
                            <span>
                              {addressOf(p)}
                              {!found && <span className="block text-[10px] text-slate-400">finding address…</span>}
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-600">
                          {p.accuracy_m != null ? p.accuracy_m : '—'}
                          {roughById.get(p) && (
                            <span className={`block text-[10px] font-semibold ${roughById.get(p) === 'mock' ? 'text-rose-600' : 'text-slate-400'}`}>
                              {roughById.get(p) === 'mock' ? 'Fake GPS' : roughById.get(p) === 'jump' ? 'Jump' : 'Rough'}
                            </span>
                          )}
                        </td>
                        <td className="px-3 py-2 text-slate-600">{p.battery_pct != null ? `${p.battery_pct}%` : '—'}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default EmployeeTrackingPanel;
