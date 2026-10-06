/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Employee Tracking -> Live Follow: one person on the map in real time, like
// Google Maps. Opening it asks the server to put that person's phone in live
// mode (POST /api/tracking/live/:id/watch, renewed every RENEW_MS); each ping
// then arrives over the socket ("tracking:location") and the marker glides to
// it, turned the way they're heading, with today's path drawn behind.
// Closing it tells the server to stop (the phone slows down again).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { BatteryMedium, Crosshair, Gauge, Radio, Target, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { getChatSocket } from '../lib/chatSocket';

const RENEW_MS = 45_000;
// Marker glide time between two fixes.
const GLIDE_MS = 1200;

type LatLng = [number, number];
interface Fix {
  lat: number;
  lng: number;
  accuracy_m: number | null;
  battery_pct: number | null;
  recorded_at: string;
}

const metersBetween = (a: LatLng, b: LatLng) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const h = Math.sin(r(b[0] - a[0]) / 2) ** 2 + Math.cos(r(a[0])) * Math.cos(r(b[0])) * Math.sin(r(b[1] - a[1]) / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
};
const bearing = (a: LatLng, b: LatLng) => {
  const r = (d: number) => (d * Math.PI) / 180;
  const y = Math.sin(r(b[1] - a[1])) * Math.cos(r(b[0]));
  const x = Math.cos(r(a[0])) * Math.sin(r(b[0])) - Math.sin(r(a[0])) * Math.cos(r(b[0])) * Math.cos(r(b[1] - a[1]));
  return ((Math.atan2(y, x) * 180) / Math.PI + 360) % 360;
};

const markerIcon = () =>
  L.divIcon({
    className: '',
    html: `<div class="lf-marker" style="position:relative;width:46px;height:46px;">
      <span style="position:absolute;inset:0;border-radius:9999px;background:color-mix(in srgb,var(--g-accent,#7f00ff) 25%,transparent);animation:lf-pulse 1.8s ease-out infinite"></span>
      <span class="lf-arrow" style="position:absolute;inset:9px;border-radius:9999px;background:var(--g-accent,#7f00ff);border:3px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,.35);display:flex;align-items:center;justify-content:center;transition:transform .4s ease">
        <svg width="14" height="14" viewBox="0 0 24 24" fill="#fff"><path d="M12 2l7 19-7-4-7 4z"/></svg>
      </span>
    </div>`,
    iconSize: [46, 46],
    iconAnchor: [23, 23]
  });

interface Props {
  token: string;
  userId: number;
  name: string;
  onClose: () => void;
}

export function LiveFollowModal({ token, userId, name, onClose }: Props) {
  const boxRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const trailRef = useRef<L.Polyline | null>(null);
  const accRef = useRef<L.Circle | null>(null);
  const posRef = useRef<LatLng | null>(null);
  const animRef = useRef<number | null>(null);
  const followRef = useRef(true);
  const lastRef = useRef<{ p: LatLng; t: number } | null>(null);

  const [fix, setFix] = useState<Fix | null>(null);
  const [speed, setSpeed] = useState<number | null>(null);
  const [follow, setFollow] = useState(true);
  const [onRide, setOnRide] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, tick] = useState(0);

  followRef.current = follow;

  // Map once.
  useEffect(() => {
    if (!boxRef.current || mapRef.current) return;
    const map = L.map(boxRef.current, { zoomControl: true }).setView([23.8103, 90.4125], 15);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', { attribution: '&copy; OpenStreetMap contributors', maxZoom: 19 }).addTo(map);
    trailRef.current = L.polyline([], { color: '#7f00ff', weight: 5, opacity: 0.55, lineCap: 'round' }).addTo(map);
    map.on('dragstart', () => setFollow(false));
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 120);
    return () => {
      if (animRef.current) cancelAnimationFrame(animRef.current);
      map.remove();
      mapRef.current = null;
    };
  }, []);

  // Glide the marker to a new fix and extend the path.
  const moveTo = useCallback((f: Fix, instant = false) => {
    const map = mapRef.current;
    if (!map) return;
    const to: LatLng = [Number(f.lat), Number(f.lng)];
    const from = posRef.current;
    if (!markerRef.current) {
      markerRef.current = L.marker(to, { icon: markerIcon(), zIndexOffset: 1000 }).addTo(map);
      map.setView(to, 17);
    }
    if (f.accuracy_m) {
      if (!accRef.current) accRef.current = L.circle(to, { radius: f.accuracy_m, color: '#7f00ff', weight: 1, fillOpacity: 0.08 }).addTo(map);
      else accRef.current.setLatLng(to).setRadius(f.accuracy_m);
    }
    trailRef.current?.addLatLng(to);

    // Heading + speed from the previous fix.
    const prev = lastRef.current;
    const t = new Date(f.recorded_at).getTime();
    if (prev && metersBetween(prev.p, to) > 3) {
      const el = (markerRef.current.getElement()?.querySelector('.lf-arrow') as HTMLElement) || null;
      if (el) el.style.transform = `rotate(${bearing(prev.p, to)}deg)`;
      const secs = (t - prev.t) / 1000;
      if (secs > 0) setSpeed(Math.round(((metersBetween(prev.p, to) / secs) * 3.6) * 10) / 10);
    } else if (prev && t - prev.t > 20_000) setSpeed(0);
    lastRef.current = { p: to, t };

    if (animRef.current) cancelAnimationFrame(animRef.current);
    if (!from || instant || metersBetween(from, to) > 2000) {
      posRef.current = to;
      markerRef.current.setLatLng(to);
      if (followRef.current) map.panTo(to, { animate: !instant });
      return;
    }
    const start = performance.now();
    const step = (now: number) => {
      const k = Math.min(1, (now - start) / GLIDE_MS);
      const e = k < 0.5 ? 2 * k * k : 1 - Math.pow(-2 * k + 2, 2) / 2;
      const p: LatLng = [from[0] + (to[0] - from[0]) * e, from[1] + (to[1] - from[1]) * e];
      posRef.current = p;
      markerRef.current?.setLatLng(p);
      if (followRef.current) map.panTo(p, { animate: false });
      if (k < 1) animRef.current = requestAnimationFrame(step);
    };
    animRef.current = requestAnimationFrame(step);
  }, []);

  // Watch (and keep renewing) on the server; first call brings today's path.
  useEffect(() => {
    let stopped = false;
    const watch = async (withTrail: boolean) => {
      try {
        const res = await fetch(apiUrl(`/api/tracking/live/${userId}/watch`), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ with_trail: withTrail })
        });
        const d = await res.json();
        if (!res.ok) throw new Error(d.error || 'Could not start live tracking.');
        if (stopped) return;
        setOnRide(!!d.on_ride);
        if (withTrail) {
          const pts: LatLng[] = (d.trail || []).map((p: any) => [p.lat, p.lng]);
          trailRef.current?.setLatLngs(pts);
          const f: Fix = { ...d.latest, lat: Number(d.latest.lat), lng: Number(d.latest.lng) };
          setFix(f);
          moveTo(f, true);
          if (pts.length > 1 && mapRef.current) mapRef.current.setView([f.lat, f.lng], 16);
        }
        setError(null);
      } catch (e: any) {
        if (!stopped) setError(e.message);
      }
    };
    void watch(true);
    const renew = setInterval(() => void watch(false), RENEW_MS);
    return () => {
      stopped = true;
      clearInterval(renew);
      void fetch(apiUrl(`/api/tracking/live/${userId}/unwatch`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        keepalive: true
      }).catch(() => undefined);
    };
  }, [token, userId, moveTo]);

  // Live pings over the socket.
  useEffect(() => {
    const socket = getChatSocket();
    if (!socket) return;
    const onLoc = (d: any) => {
      if (Number(d?.user_id) !== userId) return;
      const f: Fix = { lat: Number(d.lat), lng: Number(d.lng), accuracy_m: d.accuracy_m, battery_pct: d.battery_pct, recorded_at: d.recorded_at };
      setFix(f);
      moveTo(f);
    };
    socket.on('tracking:location', onLoc);
    return () => {
      socket.off('tracking:location', onLoc);
    };
  }, [userId, moveTo]);

  // "updated 4s ago" ticks every second.
  useEffect(() => {
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => clearInterval(t);
  }, []);

  const secsAgo = fix ? Math.max(0, Math.round((Date.now() - new Date(fix.recorded_at).getTime()) / 1000)) : null;
  const fresh = secsAgo != null && secsAgo < 60;
  const ago =
    secsAgo == null ? '—' : secsAgo < 60 ? `${secsAgo}s ago` : secsAgo < 3600 ? `${Math.round(secsAgo / 60)} min ago` : `${Math.round(secsAgo / 3600)} hr ago`;

  return (
    <div className="fixed inset-0 z-[1100] liquid-glass-backdrop flex items-center justify-center p-3 sm:p-6" onClick={onClose}>
      <style>{`@keyframes lf-pulse{0%{transform:scale(.6);opacity:.9}100%{transform:scale(1.6);opacity:0}}`}</style>
      <div className="w-full max-w-4xl" onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-3 sm:p-4">
          <div className="flex items-center justify-between gap-3 px-2 pb-3">
            <div className="min-w-0">
              <div className="flex items-center gap-2">
                <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-[11px] font-bold ${fresh ? 'bg-emerald-500 text-white' : 'bg-slate-200 text-slate-600'}`}>
                  <Radio className="w-3 h-3" /> {fresh ? 'LIVE' : 'WAITING'}
                </span>
                <h3 className="text-base font-bold text-slate-900 truncate">{name}</h3>
                {onRide && <span className="text-[11px] font-semibold rounded-full px-2 py-0.5 bg-[var(--g-accent-soft)] text-[color:var(--g-accent-700)]">On a ride</span>}
              </div>
              <p className="text-xs text-slate-500 mt-1">
                Updated {ago}
                {!fresh && fix && ' — their phone is switching to live; it can take up to a few minutes if the app is in the background.'}
              </p>
            </div>
            <button onClick={onClose} className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          <div className="liquid-glass-inset relative rounded-[24px] overflow-hidden h-[60vh] min-h-[340px]">
            <div ref={boxRef} className="absolute inset-0" />
            {!follow && fix && (
              <button
                onClick={() => {
                  setFollow(true);
                  if (posRef.current) mapRef.current?.panTo(posRef.current);
                }}
                className="liquid-glass-button rounded-full absolute bottom-4 right-4 z-[500] inline-flex items-center gap-1.5 px-4 py-2 text-xs font-semibold"
              >
                <Crosshair className="w-3.5 h-3.5" /> Follow
              </button>
            )}
          </div>

          {error && <div className="mt-3 mx-2 text-sm text-rose-700 bg-rose-50 border border-rose-200 rounded-2xl px-3 py-2">{error}</div>}

          <div className="grid grid-cols-3 gap-2 mt-3">
            {[
              { icon: Gauge, label: 'Speed', value: speed != null ? `${speed} km/h` : '—' },
              { icon: Target, label: 'GPS accuracy', value: fix?.accuracy_m != null ? `±${fix.accuracy_m} m` : '—' },
              { icon: BatteryMedium, label: 'Battery', value: fix?.battery_pct != null ? `${fix.battery_pct}%` : '—' }
            ].map(({ icon: Icon, label, value }) => (
              <div key={label} className="liquid-glass-inset rounded-2xl px-3 py-2.5">
                <div className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                  <Icon className="w-3.5 h-3.5" /> {label}
                </div>
                <div className="text-sm font-bold text-slate-900 mt-0.5">{value}</div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
