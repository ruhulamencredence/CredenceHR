/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { Navigation, RefreshCw, Route, X, BatteryMedium, Clock, MapPin, Search, FileDown } from 'lucide-react';
import { LocationPing } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';

// "18-Aug-2026, 02:19 PM" — same dd-MMM-yyyy date as formatDate, plus a local
// 12-hour time, for report rows where the exact moment (not just the day)
// matters. Reads local (not UTC) components, same reasoning as
// todayDateOnlyString in formatDate.ts — a ping's clock time is what an Admin
// pointing at a report row actually cares about.
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
}

// How often the Live board silently re-fetches while this tab is open — the
// device itself only pings every 5-10 minutes, so a tight poll here wouldn't
// see anything new; this just keeps "X min ago" honest and catches new pings
// promptly without hammering the server.
const LIVE_REFRESH_MS = 60_000;

// A user's dot turns from "recent" to "stale" grey after this many minutes of
// silence — the device is still supposed to ping every 5-10 min, so 20 min of
// nothing usually means the app was killed, the phone is off, or it has no
// signal, not that the person hasn't moved.
const STALE_AFTER_MIN = 20;

// Deterministic fallback avatar colors (same idea as GlobalSidebar/Navbar's
// initials bubble) — no profile photo on file yet, so every user still gets a
// stable, distinguishable dot color instead of everyone showing identical grey.
const AVATAR_PALETTE = ['#7F00FF', '#059669', '#0891b2', '#d97706', '#dc2626', '#4f46e5', '#be185d', '#0d9488'];
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
const liveMarkerIcon = (stale: boolean, name: string, photoUrl: string | null | undefined) => {
  const ringColor = stale ? '#94a3b8' : '#059669';
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
  html: `<div style="width:10px;height:10px;border-radius:9999px;background:#7F00FF;border:2px solid white;box-shadow:0 1px 3px rgba(0,0,0,0.35);"></div>`,
  iconSize: [10, 10],
  iconAnchor: [5, 5]
});

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
export const EmployeeTrackingPanel: React.FC<EmployeeTrackingPanelProps> = ({ token }) => {
  const [live, setLive] = useState<LocationPing[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [selectedUser, setSelectedUser] = useState<{ id: number; name: string } | null>(null);
  const [history, setHistory] = useState<LocationPing[]>([]);
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

  // user_id -> object URL of their Personal Data profile photo, or null once
  // we've confirmed they have none on file (so the marker/list fall back to
  // an initials avatar instead of retrying the fetch every redraw).
  const [photoUrls, setPhotoUrls] = useState<Record<number, string | null>>({});
  const photoUrlsRef = useRef<Record<number, string | null>>({});

  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markersLayerRef = useRef<L.LayerGroup | null>(null);

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

  // Fetch each reporting user's Personal Data profile photo once (GET
  // /api/profile/photo/:userId — Admin/Superadmin can read anyone's, see
  // profileRoutes.ts), then cache it as an object URL keyed by user_id.
  // Skips ids we've already resolved (whether that resolved to a real photo
  // or to `null` = no photo on file), so this doesn't re-fetch every 60s poll.
  useEffect(() => {
    const missing = Array.from(new Set(live.map(p => p.user_id))).filter(
      id => !(id in photoUrlsRef.current)
    );
    if (missing.length === 0) return;
    let cancelled = false;
    (async () => {
      for (const userId of missing) {
        try {
          const res = await fetch(apiUrl(`/api/profile/photo/${userId}`), {
            headers: { Authorization: `Bearer ${token}` }
          });
          if (cancelled) return;
          if (!res.ok) {
            photoUrlsRef.current[userId] = null;
          } else {
            const blob = await res.blob();
            photoUrlsRef.current[userId] = URL.createObjectURL(blob);
          }
        } catch {
          photoUrlsRef.current[userId] = null;
        }
      }
      if (!cancelled) setPhotoUrls({ ...photoUrlsRef.current });
    })();
    return () => { cancelled = true; };
  }, [live, token]);

  // Revoke every cached object URL on unmount only (not per-render — the
  // effect above never overwrites an already-resolved id, so there's nothing
  // to revoke mid-life).
  useEffect(() => {
    return () => {
      Object.values(photoUrlsRef.current).forEach(url => { if (url) URL.revokeObjectURL(url); });
    };
  }, []);

  // Employee filter (Live board only) — narrows both the "Reporting now" list
  // and the map markers to names matching the search box, so an Admin can
  // find one person on a crowded map instead of scanning every dot.
  const filteredLive = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    if (!q) return live;
    return live.filter(p => (p.user_name || '').toLowerCase().includes(q));
  }, [live, searchQuery]);

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

  // Exports whatever's currently loaded in `history` (already scoped to
  // selectedUser + the date/time filters above) as a printable PDF — oldest
  // point first, one row per ping, so an Admin can hand someone "where was
  // this employee between X and Y" as a document instead of a map they'd have
  // to screenshot.
  const handleExportReport = useCallback(async () => {
    if (!selectedUser || history.length === 0) return;
    setExportingReport(true);
    try {
      const logoImg = await loadImageElement(credenceLogo);
      const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });
      const sorted = [...history].sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1));

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
        startY: contentStartY,
        margin: { top: contentStartY, left: 8, right: 8 },
        head: [['SL', 'Date & Time', 'Latitude', 'Longitude', 'Accuracy (m)', 'Battery']],
        body: sorted.map((p, idx) => [
          String(idx + 1),
          formatDateTime(p.recorded_at),
          Number(p.lat).toFixed(6),
          Number(p.lng).toFixed(6),
          p.accuracy_m != null ? String(p.accuracy_m) : '—',
          p.battery_pct != null ? `${p.battery_pct}%` : '—'
        ]),
        styles: { fontSize: 8, cellPadding: 1.5, overflow: 'linebreak' },
        headStyles: { fillColor: [5, 150, 105], textColor: 255, fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        didDrawPage: () => { drawPdfLetterhead(doc, logoImg, letterheadOptions); }
      });

      finalizePdfPageNumbers(doc);
      const safeName = selectedUser.name.replace(/[^a-zA-Z0-9]+/g, '-').replace(/^-+|-+$/g, '') || 'Employee';
      await savePdfCrossPlatform(doc, `Tracking-History-${safeName}.pdf`);
    } catch (err: any) {
      setError(err.message || 'Failed to export report');
    } finally {
      setExportingReport(false);
    }
  }, [selectedUser, history, fromDate, toDate, fromTime, toTime]);

  useEffect(() => {
    if (selectedUser) fetchHistory(selectedUser.id);
  }, [selectedUser, fetchHistory]);

  // Initialize the map once.
  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = L.map(mapContainerRef.current, { zoomControl: true }).setView([23.8103, 90.4125], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    markersLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 100);
  }, []);

  // Redraw whenever the live board OR the selected user's path changes.
  useEffect(() => {
    const map = mapRef.current;
    const layer = markersLayerRef.current;
    if (!map || !layer) return;
    layer.clearLayers();

    if (selectedUser) {
      // Path playback mode — connected trail, oldest -> newest.
      const sorted = [...history].sort((a, b) => (a.recorded_at < b.recorded_at ? -1 : 1));
      if (sorted.length === 0) return;
      const latlngs = sorted.map(p => [Number(p.lat), Number(p.lng)] as [number, number]);
      L.polyline(latlngs, { color: '#7F00FF', weight: 3, opacity: 0.7, dashArray: '6 6' }).addTo(layer);
      sorted.forEach((p, i) => {
        const marker = L.marker([Number(p.lat), Number(p.lng)], { icon: pathPointIcon }).addTo(layer);
        marker.bindPopup(
          `<div style="font-size:12px;"><b>${i === 0 ? 'Start' : i === sorted.length - 1 ? 'Latest' : 'Point ' + (i + 1)}</b><br/>${formatDate(p.recorded_at)}${p.battery_pct != null ? `<br/>Battery: ${p.battery_pct}%` : ''}</div>`
        );
      });
      map.fitBounds(L.latLngBounds(latlngs), { padding: [40, 40], maxZoom: 16 });
    } else {
      // Live board mode — one dot (now an avatar/photo) per user, latest
      // position only, restricted to whoever matches the employee filter.
      if (filteredLive.length === 0) return;
      const bounds: [number, number][] = [];
      filteredLive.forEach(p => {
        const stale = minutesAgo(p.recorded_at) > STALE_AFTER_MIN;
        const name = p.user_name || 'User';
        const icon = liveMarkerIcon(stale, name, photoUrls[p.user_id]);
        const marker = L.marker([Number(p.lat), Number(p.lng)], { icon }).addTo(layer);
        marker.bindPopup(
          `<div style="font-size:12px;"><b>${name}</b><br/>${agoLabel(p.recorded_at)}${p.battery_pct != null ? `<br/>Battery: ${p.battery_pct}%` : ''}</div>`
        );
        bounds.push([Number(p.lat), Number(p.lng)]);
      });
      if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 15 });
    }
  }, [filteredLive, history, selectedUser, photoUrls]);

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-semibold text-slate-900 flex items-center gap-2">
            <Navigation className="w-5 h-5 text-emerald-600" /> Employee Tracking
          </h3>
          <p className="text-sm text-slate-500 mt-0.5">
            {selectedUser
              ? `Showing ${selectedUser.name}'s movement path`
              : searchQuery
              ? `${filteredLive.length} of ${live.length} user${live.length === 1 ? '' : 's'} matching "${searchQuery}"`
              : `${live.length} user${live.length === 1 ? '' : 's'} reporting location`}
          </p>
        </div>
        <div className="flex items-center gap-2">
          {selectedUser && (
            <button
              onClick={() => { setSelectedUser(null); setHistory([]); }}
              className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50"
            >
              <X className="w-3.5 h-3.5" /> Back to Live
            </button>
          )}
          <button
            onClick={() => fetchLive()}
            className="flex items-center gap-1.5 px-3 py-2 text-sm rounded-lg bg-emerald-600 text-white hover:bg-emerald-700"
          >
            <RefreshCw className="w-3.5 h-3.5" /> Refresh
          </button>
        </div>
      </div>

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
          {!historyLoading && <span className="text-xs text-slate-500">{history.length} point{history.length === 1 ? '' : 's'}</span>}
          <button
            onClick={handleExportReport}
            disabled={history.length === 0 || exportingReport}
            className="flex items-center gap-1.5 text-xs px-2.5 py-1 rounded bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40 disabled:cursor-not-allowed ml-auto"
          >
            <FileDown className="w-3.5 h-3.5" /> {exportingReport ? 'Exporting…' : 'Export Report (PDF)'}
          </button>
        </div>
      )}

      {!selectedUser && (
        <div className="relative">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            value={searchQuery}
            onChange={e => setSearchQuery(e.target.value)}
            placeholder="Filter by employee name…"
            className="w-full sm:w-72 pl-9 pr-8 py-2 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-emerald-500/30 focus:border-emerald-400"
          />
          {searchQuery && (
            <button
              onClick={() => setSearchQuery('')}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 text-slate-400 hover:text-slate-600"
              aria-label="Clear filter"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      )}

      {error && (
        <div className="text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-lg px-3 py-2">{error}</div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 rounded-xl overflow-hidden border border-slate-200" style={{ height: 460 }}>
          <div ref={mapContainerRef} className="w-full h-full" />
        </div>

        <div className="border border-slate-200 rounded-xl overflow-hidden flex flex-col" style={{ height: 460 }}>
          <div className="px-3 py-2 bg-slate-50 border-b border-slate-200 text-xs font-medium text-slate-500 flex items-center gap-1.5">
            <MapPin className="w-3.5 h-3.5" /> Reporting now
          </div>
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100">
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
                const isSelected = selectedUser?.id === p.user_id;
                const name = p.user_name || 'User';
                const photoUrl = photoUrls[p.user_id];
                return (
                  <button
                    key={p.user_id}
                    onClick={() => setSelectedUser({ id: p.user_id, name })}
                    className={`w-full text-left px-3 py-2.5 hover:bg-slate-50 transition-colors ${isSelected ? 'bg-violet-50' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="relative shrink-0 w-6 h-6 rounded-full overflow-hidden border border-white ring-1 ring-slate-200">
                          {photoUrl ? (
                            <img src={photoUrl} alt={name} className="w-full h-full object-cover" />
                          ) : (
                            <span
                              className="w-full h-full flex items-center justify-center text-[10px] font-bold text-white"
                              style={{ background: avatarColor(name) }}
                            >
                              {getInitials(name)}
                            </span>
                          )}
                          <span className={`absolute -bottom-0.5 -right-0.5 w-2 h-2 rounded-full border border-white ${stale ? 'bg-slate-300' : 'bg-emerald-500'}`} />
                        </span>
                        <span className="text-sm font-medium text-slate-800 truncate">{name}</span>
                      </div>
                      <Route className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-400 pl-8">
                      <span className="flex items-center gap-1"><Clock className="w-3 h-3" /> {agoLabel(p.recorded_at)}</span>
                      {p.battery_pct != null && (
                        <span className="flex items-center gap-1"><BatteryMedium className="w-3 h-3" /> {p.battery_pct}%</span>
                      )}
                    </div>
                  </button>
                );
              })
            )}
          </div>
        </div>
      </div>
    </div>
  );
};

export default EmployeeTrackingPanel;
