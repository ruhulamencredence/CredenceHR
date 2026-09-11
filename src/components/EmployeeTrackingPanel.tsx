/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Navigation, RefreshCw, Route, X, BatteryMedium, Clock, MapPin } from 'lucide-react';
import { LocationPing } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';

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

const liveMarkerIcon = (stale: boolean) => L.divIcon({
  className: '',
  html: `<div style="position:relative;width:22px;height:22px;">
    ${stale ? '' : `<div style="position:absolute;inset:0;border-radius:9999px;background:#10b981;opacity:0.35;animation:pulse-tracking 1.8s ease-out infinite;"></div>`}
    <div style="position:absolute;inset:5px;border-radius:9999px;background:${stale ? '#94a3b8' : '#059669'};border:2px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);"></div>
  </div>
  <style>@keyframes pulse-tracking{0%{transform:scale(0.6);opacity:0.5;}100%{transform:scale(2.2);opacity:0;}}</style>`,
  iconSize: [22, 22],
  iconAnchor: [11, 11]
});

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

  const fetchHistory = useCallback(async (userId: number) => {
    setHistoryLoading(true);
    try {
      const params = new URLSearchParams();
      params.set('user_id', String(userId));
      if (fromDate) params.set('from', fromDate);
      if (toDate) params.set('to', toDate);
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
  }, [token, fromDate, toDate]);

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
      // Live board mode — one dot per user, latest position only.
      if (live.length === 0) return;
      const bounds: [number, number][] = [];
      live.forEach(p => {
        const stale = minutesAgo(p.recorded_at) > STALE_AFTER_MIN;
        const marker = L.marker([Number(p.lat), Number(p.lng)], { icon: liveMarkerIcon(stale) }).addTo(layer);
        marker.bindPopup(
          `<div style="font-size:12px;"><b>${p.user_name || 'User'}</b><br/>${agoLabel(p.recorded_at)}${p.battery_pct != null ? `<br/>Battery: ${p.battery_pct}%` : ''}</div>`
        );
        bounds.push([Number(p.lat), Number(p.lng)]);
      });
      if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 15 });
    }
  }, [live, history, selectedUser]);

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
          <button
            onClick={() => fetchHistory(selectedUser.id)}
            className="text-xs px-2.5 py-1 rounded bg-violet-600 text-white hover:bg-violet-700"
          >
            Apply
          </button>
          {historyLoading && <span className="text-xs text-slate-400">Loading…</span>}
          {!historyLoading && <span className="text-xs text-slate-500">{history.length} point{history.length === 1 ? '' : 's'}</span>}
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
            ) : (
              live.map(p => {
                const stale = minutesAgo(p.recorded_at) > STALE_AFTER_MIN;
                const isSelected = selectedUser?.id === p.user_id;
                return (
                  <button
                    key={p.user_id}
                    onClick={() => setSelectedUser({ id: p.user_id, name: p.user_name || 'User' })}
                    className={`w-full text-left px-3 py-2.5 hover:bg-slate-50 transition-colors ${isSelected ? 'bg-violet-50' : ''}`}
                  >
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className={`w-2 h-2 rounded-full shrink-0 ${stale ? 'bg-slate-300' : 'bg-emerald-500'}`} />
                        <span className="text-sm font-medium text-slate-800 truncate">{p.user_name || 'User'}</span>
                      </div>
                      <Route className="w-3.5 h-3.5 text-slate-300 shrink-0" />
                    </div>
                    <div className="mt-1 flex items-center gap-3 text-[11px] text-slate-400 pl-4">
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
