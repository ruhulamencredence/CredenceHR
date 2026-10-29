/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Book a Ride -> "Set On Map" (pickup or destination): a full-screen OpenStreetMap with
// a fixed pin in the centre and a sheet at the bottom. The user drags the
// map until the pin sits on the place they want; the address under the pin
// is looked up (GET /api/vehicles/places/reverse) each time the map stops.
//
// The sheet suggests, besides the address under the pin: the nearest
// offices / project sites (GET /api/vehicles/places/nearby), the account's
// saved places and recent destinations. The search icon opens a place search
// (GET /api/vehicles/places/search) right on the map: the box sits at the
// top, the results fill the sheet, and the map follows them. "Projects" lists every Project with a
// location set, nearest to the pin first (GET /api/vehicles/places/projects).
// "Add missing place" names the spot
// under the pin by hand. The bookmark saves it as Home / Work / Other with a
// note for the driver — only with users.can_save_ride_places (the server
// checks it too).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowLeft, Bookmark, Building2, Clock3, Home, LocateFixed, MapPin, Plus, Search, Star, Trash2, X, Briefcase } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

const DHAKA: [number, number] = [23.8103, 90.4125];

type LatLng = { lat: number; lng: number };
interface Place {
  label: string;
  detail?: string | null;
  lat: number;
  lng: number;
}
interface SavedPlace {
  id: number;
  kind: 'home' | 'work' | 'other';
  name: string;
  address: string | null;
  lat: number;
  lng: number;
  driver_note: string | null;
}
interface Suggestion {
  key: string;
  label: string;
  detail: string | null;
  lat: number;
  lng: number;
  tag: 'office' | 'saved' | 'recent';
  saved?: SavedPlace;
  distance_m?: number;
}

interface RideMapPickerProps {
  title: string;
  point?: 'pickup' | 'destination';
  start: LatLng | null;
  onLocateMe: () => Promise<LatLng | null>;
  onCancel: () => void;
  onConfirm: (place: { label: string; lat: number; lng: number }) => void;
}

const authHeaders = () => ({ Authorization: `Bearer ${localStorage.getItem('mpr_token')}` });
const fmtDistance = (m: number) => (m < 1000 ? `${Math.max(10, Math.round(m / 10) * 10)} m away` : `${(m / 1000).toFixed(1)} km away`);
const sameSpot = (a: LatLng, b: LatLng) => Math.abs(a.lat - b.lat) < 1e-5 && Math.abs(a.lng - b.lng) < 1e-5;
// What goes on the ride: "Home — House 15, Road 13/A (wait at the gate)".
const savedLabel = (p: SavedPlace) => {
  const base = p.address && p.address !== p.name ? `${p.name} — ${p.address}` : p.name;
  return (p.driver_note ? `${base} (${p.driver_note})` : base).slice(0, 255);
};

const KIND_ICON = { home: Home, work: Briefcase, other: Star } as const;

// Same liquid-glass sheet as every other popup (CLAUDE.md).
// Every one of these has a text box, so on a phone it sits at the top of the
// screen — at the bottom the keyboard covered it — and is never taller than
// what the keyboard leaves visible.
function useVisibleHeight(): number | null {
  const [h, setH] = useState<number | null>(() => (typeof window !== 'undefined' && window.visualViewport ? window.visualViewport.height : null));
  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const on = () => setH(vv.height);
    vv.addEventListener('resize', on);
    return () => vv.removeEventListener('resize', on);
  }, []);
  return h;
}

const Sheet: React.FC<{ title: string; onClose: () => void; children: React.ReactNode }> = ({ title, onClose, children }) => {
  const visible = useVisibleHeight();
  return (
  <div
    className="liquid-glass-backdrop fixed inset-0 z-[1100] flex items-start sm:items-center justify-center px-3 pb-3 sm:p-4"
    style={{ paddingTop: 'calc(12px + var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)))' }}
    onClick={onClose}
    role="presentation"
  >
    <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
      <div className="liquid-glass liquid-glass-in rounded-[32px] max-h-[88vh] flex flex-col overflow-hidden" style={visible ? { maxHeight: Math.min(visible - 24, window.innerHeight * 0.88) } : undefined}>
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-2">
          <h3 className="text-lg font-bold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 pb-5 overflow-y-auto">{children}</div>
      </div>
    </div>
  </div>
  );
};

export function RideMapPicker({ title, point, start, onLocateMe, onCancel, onConfirm }: RideMapPickerProps) {
  const kind: 'pickup' | 'destination' = point || (/pickup/i.test(title) ? 'pickup' : 'destination');
  const word = kind === 'pickup' ? 'pickup' : 'destination';
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [center, setCenter] = useState<LatLng>(start || { lat: DHAKA[0], lng: DHAKA[1] });
  const [label, setLabel] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [moving, setMoving] = useState(false);
  const [locating, setLocating] = useState(false);
  // A suggestion / search result / hand-typed name chosen for the spot under the pin.
  const [chosen, setChosen] = useState<{ key: string; label: string; at: LatLng } | null>(null);
  const [offices, setOffices] = useState<Suggestion[]>([]);
  const [saved, setSaved] = useState<SavedPlace[]>([]);
  const [recent, setRecent] = useState<Place[]>([]);
  const [canSave, setCanSave] = useState(false);
  const [sheet, setSheet] = useState<'projects' | 'missing' | 'save' | null>(null);
  // Search a place: the box sits on the map, the results fill the bottom
  // sheet, and the map follows them (the pin on the first one, a numbered
  // dot on each).
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchErr, setSearchErr] = useState<string | null>(null);
  const [activeResult, setActiveResult] = useState(0);
  const resultLayerRef = useRef<L.LayerGroup | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Label of a place picked from a list — used instead of a reverse lookup once the map lands there.
  const pickedRef = useRef<{ key: string; label: string } | null>(null);

  useBackButtonClose(true, () => (sheet ? setSheet(null) : searchOpen ? closeSearch() : onCancel()));

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: false, attributionControl: false }).setView(start ? [start.lat, start.lng] : DHAKA, start ? 17 : 13);
    // OpenStreetMap tiles, same as every other map in the app.
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19
    }).addTo(map);
    // Top right, below the status bar and the search box, clear of the sheet.
    L.control.attribution({ position: 'topright', prefix: false }).addAttribution('&copy; OpenStreetMap contributors').addTo(map);
    const topRight = map.getContainer().querySelector('.leaflet-top.leaflet-right') as HTMLElement | null;
    if (topRight) topRight.style.marginTop = 'calc(64px + var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)))';
    map.on('movestart', () => setMoving(true));
    map.on('moveend', () => {
      const c = map.getCenter();
      setMoving(false);
      setCenter({ lat: c.lat, lng: c.lng });
    });
    resultLayerRef.current = L.layerGroup().addTo(map);
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 100);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Saved places (only with the switch) and recent destinations, once.
  useEffect(() => {
    fetch(apiUrl('/api/vehicles/places/recent'), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setRecent(Array.isArray(rows) ? rows.filter((p: Place) => p.lat != null && p.lng != null) : []))
      .catch(() => setRecent([]));
  }, []);
  const loadSaved = () =>
    fetch(apiUrl('/api/vehicles/places/saved'), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setSaved(Array.isArray(rows) ? rows : []))
      .catch(() => setSaved([]));
  useEffect(() => {
    if (canSave) loadSaved();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSave]);

  const chosenRef = useRef(chosen);
  chosenRef.current = chosen;

  // Once the map settles: the address under the pin and the offices near it.
  useEffect(() => {
    if (pickedRef.current) {
      const p = pickedRef.current;
      pickedRef.current = null;
      setLabel(p.label);
      setChosen({ key: p.key, label: p.label, at: center });
    } else if (chosen && !sameSpot(chosen.at, center)) {
      setChosen(null);
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setResolving(true);
      try {
        const [rev, near] = await Promise.all([
          fetch(apiUrl(`/api/vehicles/places/reverse?lat=${center.lat}&lng=${center.lng}`), { headers: authHeaders(), signal: controller.signal })
            .then((r) => r.json())
            .catch(() => null),
          fetch(apiUrl(`/api/vehicles/places/nearby?lat=${center.lat}&lng=${center.lng}`), { headers: authHeaders(), signal: controller.signal })
            .then((r) => (r.ok ? r.json() : null))
            .catch(() => null)
        ]);
        if (controller.signal.aborted) return;
        setLabel((prev) => (chosenRef.current ? prev : rev?.label || null));
        if (near) {
          setCanSave(!!near.can_save);
          setOffices(
            (near.offices || []).map((o: any) => ({ key: `o-${o.lat},${o.lng}`, label: o.label, detail: o.detail, lat: o.lat, lng: o.lng, tag: 'office' as const, distance_m: o.distance_m }))
          );
        }
      } finally {
        if (!controller.signal.aborted) setResolving(false);
      }
    }, 500);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [center.lat, center.lng]);
  const flyTo = (s: { key: string; label: string; lat: number; lng: number }, keepSearch = false) => {
    const map = mapRef.current;
    setSheet(null);
    if (!keepSearch) {
      closeSearch();
      (document.activeElement as HTMLElement | null)?.blur();
    }
    if (!map) return;
    const target = { lat: s.lat, lng: s.lng };
    if (sameSpot(map.getCenter(), target)) {
      // No move happens, so no moveend: apply it here.
      setLabel(s.label);
      setChosen({ key: s.key, label: s.label, at: center });
      return;
    }
    pickedRef.current = { key: s.key, label: s.label };
    map.setView([s.lat, s.lng], 17);
  };

  function closeSearch() {
    setSearchOpen(false);
    setQuery('');
    setResults([]);
    setSearchErr(null);
    resultLayerRef.current?.clearLayers();
  }

  // Debounced place search while the box is open.
  useEffect(() => {
    const q = query.trim();
    if (!searchOpen || q.length < 3) {
      setResults([]);
      setSearchErr(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(apiUrl(`/api/vehicles/places/search?q=${encodeURIComponent(q)}`), { headers: authHeaders(), signal: controller.signal });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || 'Place search failed.');
        setResults(Array.isArray(data) ? data.filter((p: any) => p.lat != null && p.lng != null) : []);
        setActiveResult(0);
        setSearchErr(null);
      } catch (e: any) {
        if (!controller.signal.aborted) setSearchErr(e.message || 'Place search failed.');
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 450);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query, searchOpen]);

  // The map follows the results: a numbered dot on each (tap = pick it),
  // and the pin moves onto the highlighted one.
  useEffect(() => {
    const layer = resultLayerRef.current;
    if (!layer) return;
    layer.clearLayers();
    if (!searchOpen) return;
    results.forEach((r, i) => {
      const on = i === activeResult;
      L.marker([r.lat, r.lng], {
        icon: L.divIcon({
          className: '',
          html: `<div style="width:24px;height:24px;border-radius:50%;background:${on ? '#7c3aed' : '#fff'};color:${on ? '#fff' : '#5b21b6'};border:2px solid ${on ? '#fff' : '#7c3aed'};box-shadow:0 2px 6px rgba(0,0,0,.3);font:700 12px system-ui;display:flex;align-items:center;justify-content:center">${i + 1}</div>`,
          iconSize: [24, 24],
          iconAnchor: [12, 12]
        })
      })
        .on('click', () => flyTo({ key: `q-${r.lat},${r.lng}`, label: r.label, lat: r.lat, lng: r.lng }))
        .addTo(layer);
    });
    const a = results[activeResult];
    if (a) flyTo({ key: `q-${a.lat},${a.lng}`, label: a.label, lat: a.lat, lng: a.lng }, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [results, activeResult, searchOpen]);

  const locate = async () => {
    setLocating(true);
    try {
      const here = await onLocateMe();
      if (here && mapRef.current) mapRef.current.setView([here.lat, here.lng], 17);
    } finally {
      setLocating(false);
    }
  };

  const suggestions: Suggestion[] = useMemo(() => {
    const out: Suggestion[] = [...offices];
    for (const p of saved) out.push({ key: `s-${p.id}`, label: p.name, detail: p.address, lat: p.lat, lng: p.lng, tag: 'saved', saved: p });
    for (const p of recent.slice(0, 3)) out.push({ key: `r-${p.label}`, label: p.label, detail: null, lat: p.lat, lng: p.lng, tag: 'recent' });
    const seen = new Set<string>();
    return out.filter((s) => {
      const k = s.label.toLowerCase();
      if (seen.has(k)) return false;
      seen.add(k);
      return true;
    });
  }, [offices, saved, recent]);

  const coordsText = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
  const pinLabel = chosen?.label || label || coordsText;
  const busy = moving || resolving;
  const chosenSaved = chosen?.key.startsWith('s-') ? saved.find((p) => `s-${p.id}` === chosen.key) : undefined;
  const confirm = () => onConfirm({ label: chosenSaved ? savedLabel(chosenSaved) : pinLabel, lat: center.lat, lng: center.lng });

  return (
    <div className="fixed inset-0 z-[60] bg-slate-100">
      {/* The map's centre — the point that is picked — is where the pin's tip
          sits (38% down); the part under the sheet doesn't need map. */}
      <div ref={containerRef} className="absolute inset-x-0 top-0 h-[76%]" />

      {searchOpen ? (
        <div className="absolute inset-x-3 z-[600] flex items-center gap-2 rounded-2xl bg-white px-2 py-1.5 shadow-lg ring-1 ring-violet-200" style={{ top: 'calc(12px + var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)))' }}>
          <button type="button" onClick={closeSearch} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-700 hover:bg-slate-100" aria-label="Close search">
            <ArrowLeft className="w-5 h-5" />
          </button>
          <input
            autoFocus
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              const a = results[activeResult];
              if (e.key === 'Enter' && a) flyTo({ key: `q-${a.lat},${a.lng}`, label: a.label, lat: a.lat, lng: a.lng });
            }}
            placeholder="Area, road, building…"
            aria-label="Search a place"
            className="min-w-0 flex-1 bg-transparent text-[15px] text-slate-900 placeholder:text-slate-400 focus:outline-none"
          />
          {searching ? (
            <span className="px-2">
              <Spinner size={14} />
            </span>
          ) : (
            query && (
              <button type="button" onClick={() => setQuery('')} className="w-8 h-8 shrink-0 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700" aria-label="Clear search">
                <X className="w-4 h-4" />
              </button>
            )
          )}
        </div>
      ) : (
      <button
        type="button"
        onClick={onCancel}
        className="absolute left-4 z-[500] w-11 h-11 rounded-full bg-white/90 backdrop-blur shadow-lg flex items-center justify-center text-slate-800"
        style={{ top: 'calc(14px + var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)))' }}
        aria-label="Back"
        title={title}
      >
        <ArrowLeft className="w-5 h-5" />
      </button>
      )}

      {/* Fixed centre pin with its label; its tip is the map's centre (38%). */}
      <div className="pointer-events-none absolute left-1/2 top-[38%] z-[500] -translate-x-1/2 -translate-y-1/2 rounded-full bg-black/35 w-2.5 h-1" />
      <div className="pointer-events-none absolute left-1/2 top-[38%] z-[500] flex flex-col items-center" style={{ transform: 'translate(-50%, -100%)' }}>
        <div className={`relative mb-1.5 rounded-full bg-white px-3.5 py-1.5 text-[13px] text-slate-800 shadow-lg whitespace-nowrap transition-opacity ${moving ? 'opacity-0' : 'opacity-100'}`}>
          This is your {word} point
          <span className="absolute left-1/2 -bottom-1 -ml-1 w-2 h-2 rotate-45 bg-white" />
        </div>
        <svg width="38" height="50" viewBox="0 0 36 48" className={`drop-shadow-md transition-transform ${moving ? '-translate-y-2.5' : ''}`} aria-hidden="true">
          <path d="M18 0C8 0 0 8 0 18c0 13 18 30 18 30s18-17 18-30C36 8 28 0 18 0z" fill="#7c3aed" stroke="#fff" strokeWidth="2.5" />
          <circle cx="18" cy="18" r="7" fill="#fff" />
        </svg>
      </div>

      {/* The bottom sheet. */}
      <div className={`absolute inset-x-0 bottom-0 z-[550] ${searchOpen ? 'max-h-[50%]' : 'max-h-[62%]'} flex flex-col rounded-t-[28px] bg-white/95 backdrop-blur-xl shadow-[0_-10px_30px_rgba(0,0,0,0.12)]`}>
        <button
          type="button"
          onClick={locate}
          className="absolute -top-14 right-4 w-11 h-11 rounded-full bg-white shadow-lg flex items-center justify-center text-slate-800"
          aria-label="Go to my location"
        >
          {locating ? <Spinner size={16} /> : <LocateFixed className="w-5 h-5" />}
        </button>
        <div className="mx-auto mt-2.5 mb-1 h-1 w-10 rounded-full bg-slate-300" />
        {searchOpen ? (
          <div className="px-4 sm:px-5 pt-1 overflow-y-auto" style={{ paddingBottom: 'calc(14px + var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))' }}>
            <h2 className="text-xl font-extrabold text-slate-900">Search a place</h2>
            <div className="mt-2.5 space-y-2">
              {results.map((r, i) => (
                <button
                  key={`${r.label}-${i}`}
                  type="button"
                  onClick={() => flyTo({ key: `q-${r.lat},${r.lng}`, label: r.label, lat: r.lat, lng: r.lng })}
                  onMouseEnter={() => setActiveResult(i)}
                  className={`flex w-full items-center gap-3 rounded-2xl px-3.5 py-3 text-left ${i === activeResult ? 'bg-violet-50 ring-1 ring-violet-200' : 'bg-slate-100/80'}`}
                >
                  <span className={`w-6 h-6 shrink-0 rounded-full flex items-center justify-center text-[12px] font-bold ${i === activeResult ? 'bg-violet-600 text-white' : 'bg-white text-violet-700 ring-1 ring-violet-300'}`}>{i + 1}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[14.5px] font-semibold text-slate-900">{r.label}</span>
                    {r.detail && <span className="block truncate text-[11.5px] text-slate-500">{r.detail}</span>}
                  </span>
                </button>
              ))}
              {query.trim().length >= 3 && !searching && results.length === 0 && <p className="px-1 py-2 text-sm text-slate-500">{searchErr || 'No matching places found.'}</p>}
              {query.trim().length < 3 && <p className="px-1 py-2 text-sm text-slate-500">Type at least 3 letters — the map follows the results.</p>}
            </div>
          </div>
        ) : (
        <div className="px-4 sm:px-5 pt-1 overflow-y-auto">
          <h2 className="text-xl font-extrabold text-slate-900">{kind === 'pickup' ? 'Pickup point' : 'Destination point'}</h2>
          <p className="mt-2.5 mb-2 text-[13px] font-semibold text-slate-500">Suggested addresses</p>

          {/* The spot under the pin; the search icon looks for a place by name. */}
          <div className="flex items-center gap-3 rounded-2xl border-[1.5px] border-violet-600 bg-white px-3.5 py-3 shadow-[0_0_0_3px_rgba(124,58,237,0.12)]">
            <MapPin className="w-5 h-5 text-violet-600 shrink-0" fill="currentColor" stroke="white" />
            <div className="min-w-0 flex-1">
              {busy && !chosen ? (
                <span className="flex items-center gap-2 text-sm text-slate-500">
                  <Spinner size={14} /> Finding the address…
                </span>
              ) : (
                <>
                  <span className="block truncate text-[15px] font-semibold text-slate-900">{chosenSaved ? chosenSaved.name : pinLabel}</span>
                  <span className="block truncate text-[11.5px] text-slate-500">
                    {chosenSaved ? [chosenSaved.address, chosenSaved.driver_note].filter(Boolean).join(' · ') || 'Saved place' : label || chosen ? coordsText : 'Under the pin'}
                  </span>
                </>
              )}
            </div>
            <button type="button" onClick={() => setSearchOpen(true)} className="p-1 text-slate-400 hover:text-slate-700" aria-label="Search a place">
              <Search className="w-5 h-5" />
            </button>
          </div>

          <div className="mt-2 space-y-2">
            {suggestions.map((s) => {
              const Icon = s.tag === 'office' ? Building2 : s.tag === 'saved' ? KIND_ICON[s.saved!.kind] : Clock3;
              const active = chosen?.key === s.key;
              return (
                <div key={s.key} className={`flex items-center gap-3 rounded-2xl px-3.5 py-3 ${active ? 'bg-violet-50 ring-1 ring-violet-200' : 'bg-slate-100/80'}`}>
                  <button type="button" onClick={() => flyTo(s)} className="flex min-w-0 flex-1 items-center gap-3 text-left">
                    <Icon className={`w-5 h-5 shrink-0 ${s.tag === 'office' ? 'text-violet-600' : s.tag === 'saved' ? 'text-amber-500' : 'text-slate-500'}`} />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[14.5px] font-semibold text-slate-900">{s.label}</span>
                      <span className="block truncate text-[11.5px] text-slate-500">
                        {s.tag === 'office' ? [s.detail, s.distance_m != null ? fmtDistance(s.distance_m) : null].filter(Boolean).join(' · ') : s.tag === 'saved' ? [s.saved!.address, s.saved!.driver_note].filter(Boolean).join(' · ') || 'Saved place' : 'Used before'}
                      </span>
                    </span>
                    <span
                      className={`shrink-0 rounded-full px-2 py-0.5 text-[10.5px] font-bold ${
                        s.tag === 'office' ? 'bg-violet-100 text-violet-700' : s.tag === 'saved' ? 'bg-amber-100 text-amber-700' : 'bg-slate-200 text-slate-600'
                      }`}
                    >
                      {s.tag === 'office' ? 'Office' : s.tag === 'saved' ? 'Saved' : 'Recent'}
                    </span>
                  </button>
                  {s.tag === 'saved' && (
                    <button
                      type="button"
                      onClick={async () => {
                        if (!(await confirmDialog(`Remove "${s.label}" from your saved places?`, { tone: 'danger', confirmLabel: 'Remove' }))) return;
                        const r = await fetch(apiUrl(`/api/vehicles/places/saved/${s.saved!.id}`), { method: 'DELETE', headers: authHeaders() }).catch(() => null);
                        if (r?.ok) loadSaved();
                      }}
                      className="p-1 text-slate-400 hover:text-rose-600"
                      aria-label={`Remove ${s.label}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  )}
                </div>
              );
            })}
          </div>

          <div className="mt-1 flex items-center justify-between gap-2">
            <button type="button" onClick={() => setSheet('missing')} className="flex items-center gap-2 px-1 py-3 text-[14.5px] font-bold text-violet-700">
              <Plus className="w-4.5 h-4.5" /> Add missing place
            </button>
            <button
              type="button"
              onClick={() => setSheet('projects')}
              className="flex items-center gap-1.5 rounded-full bg-violet-50 px-3.5 py-2 text-[13px] font-bold text-violet-800 hover:bg-violet-100"
            >
              <Building2 className="w-4 h-4" /> Projects
            </button>
          </div>
        </div>
        )}

        {/* While searching, a result is picked by tapping it. */}
        <div className={`${searchOpen ? 'hidden' : 'flex'} items-center gap-2.5 border-t border-slate-100 px-4 sm:px-5 pt-3`} style={{ paddingBottom: 'calc(14px + var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))' }}>
          <button type="button" disabled={busy && !chosen} onClick={confirm} className="liquid-glass-button flex-1 rounded-full py-3.5 text-base font-bold disabled:opacity-50">
            Confirm {word}
          </button>
          {canSave && (
            <button
              type="button"
              onClick={() => setSheet('save')}
              disabled={busy && !chosen}
              className="w-[52px] h-[52px] shrink-0 rounded-full bg-violet-50 flex items-center justify-center text-violet-800 disabled:opacity-50"
              aria-label="Save this place"
              title="Save this place"
            >
              <Bookmark className="w-5 h-5" fill={chosenSaved ? 'currentColor' : 'none'} />
            </button>
          )}
        </div>
      </div>

      {sheet === 'projects' && (
        <ProjectsSheet at={center} onClose={() => setSheet(null)} onPick={(p) => flyTo({ key: `o-${p.lat},${p.lng}`, label: p.label, lat: p.lat, lng: p.lng })} />
      )}
      {sheet === 'missing' && (
        <MissingPlaceSheet
          address={label}
          onClose={() => setSheet(null)}
          onUse={(name) => {
            setChosen({ key: 'typed', label: name, at: center });
            setSheet(null);
          }}
        />
      )}
      {sheet === 'save' && (
        <SavePlaceSheet
          address={chosenSaved?.address || label}
          suggestedName={chosen && !chosenSaved ? chosen.label : ''}
          at={center}
          onClose={() => setSheet(null)}
          onSaved={(p) => {
            setSheet(null);
            setError(null);
            loadSaved().then(() => setChosen({ key: `s-${p.id}`, label: p.name, at: center }));
          }}
          onError={setError}
        />
      )}
      {error && (
        <div className="absolute left-4 right-4 top-16 z-[600] rounded-2xl bg-rose-600 px-4 py-2.5 text-sm text-white shadow-lg" role="alert" onClick={() => setError(null)}>
          {error}
        </div>
      )}
    </div>
  );
}

// ---------- Projects with a location set ----------
interface ProjectPlace extends Place {
  id: number;
  distance_m: number | null;
}
const ProjectsSheet: React.FC<{ at: LatLng; onClose: () => void; onPick: (p: ProjectPlace) => void }> = ({ at, onClose, onPick }) => {
  const [list, setList] = useState<ProjectPlace[] | null>(null);
  const [query, setQuery] = useState('');
  useEffect(() => {
    fetch(apiUrl(`/api/vehicles/places/projects?lat=${at.lat}&lng=${at.lng}`), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setList(Array.isArray(rows) ? rows : []))
      .catch(() => setList([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const q = query.trim().toLowerCase();
  const shown = (list || []).filter((p) => !q || p.label.toLowerCase().includes(q) || String(p.detail || '').toLowerCase().includes(q));
  return (
    <Sheet title="Projects" onClose={onClose}>
      <div className="flex items-center gap-2 rounded-2xl border-[1.5px] border-violet-600 bg-white px-3.5 py-2.5">
        <Search className="w-4 h-4 text-slate-400 shrink-0" />
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && shown[0]) onPick(shown[0]);
          }}
          placeholder="Type a project name or area"
          className="min-w-0 flex-1 bg-transparent text-[15px] text-slate-900 placeholder:text-slate-400 focus:outline-none"
          aria-label="Search projects"
        />
      </div>
      <div className="liquid-glass-inset mt-3 rounded-2xl divide-y divide-slate-200/60">
        {list === null && (
          <p className="flex items-center gap-2 px-3.5 py-3 text-sm text-slate-500">
            <Spinner size={14} /> Loading…
          </p>
        )}
        {shown.map((p) => (
          <button key={p.id} type="button" onClick={() => onPick(p)} className="flex w-full items-center gap-3 px-3.5 py-3 text-left">
            <Building2 className="w-5 h-5 text-violet-600 shrink-0" />
            <span className="min-w-0 flex-1">
              <span className="block truncate text-sm font-semibold text-slate-800">{p.label}</span>
              <span className="block truncate text-[11.5px] text-slate-500">{[p.detail, p.distance_m != null ? fmtDistance(p.distance_m) : null].filter(Boolean).join(' · ')}</span>
            </span>
          </button>
        ))}
        {list !== null && shown.length === 0 && (
          <p className="px-3.5 py-3 text-sm text-slate-500">{list.length === 0 ? 'No project has its location set yet.' : 'No project matches.'}</p>
        )}
      </div>
    </Sheet>
  );
};

// ---------- Name the spot under the pin ----------
const MissingPlaceSheet: React.FC<{ address: string | null; onClose: () => void; onUse: (name: string) => void }> = ({ address, onClose, onUse }) => {
  const [name, setName] = useState('');
  return (
    <Sheet title="Add missing place" onClose={onClose}>
      <p className="text-[12.5px] text-slate-600 mb-3">
        The map doesn't know this spot by name? Type what people call it — the pin stays where it is{address ? ` (${address})` : ''}.
      </p>
      <input
        autoFocus
        value={name}
        onChange={(e) => setName(e.target.value)}
        maxLength={120}
        placeholder="e.g. Green Tower gate, Road 27"
        className="w-full rounded-2xl border-[1.5px] border-violet-600 bg-white px-3.5 py-3 text-[15px] text-slate-900 focus:outline-none"
      />
      <button type="button" disabled={!name.trim()} onClick={() => onUse(name.trim())} className="liquid-glass-button mt-4 w-full rounded-full py-3 text-[15px] font-bold disabled:opacity-50">
        Use this name
      </button>
    </Sheet>
  );
};

// ---------- Save the spot as Home / Work / Other ----------
const SavePlaceSheet: React.FC<{
  address: string | null;
  suggestedName: string;
  at: LatLng;
  onClose: () => void;
  onSaved: (p: SavedPlace) => void;
  onError: (msg: string) => void;
}> = ({ address, suggestedName, at, onClose, onSaved, onError }) => {
  const [kind, setKind] = useState<'home' | 'work' | 'other'>('home');
  const [name, setName] = useState(suggestedName || 'Home');
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [touched, setTouched] = useState(!!suggestedName);
  const pickKind = (k: typeof kind) => {
    setKind(k);
    if (!touched) setName(k === 'home' ? 'Home' : k === 'work' ? 'Work' : '');
  };
  const save = async () => {
    setSaving(true);
    try {
      const r = await fetch(apiUrl('/api/vehicles/places/saved'), {
        method: 'POST',
        headers: { ...authHeaders(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind, name: name.trim(), address, driver_note: note.trim(), lat: at.lat, lng: at.lng })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save the place.');
      onSaved(d);
    } catch (e: any) {
      onError(e.message || 'Could not save the place.');
      onClose();
    } finally {
      setSaving(false);
    }
  };
  const chip = (k: typeof kind, text: string, Icon: React.ComponentType<{ className?: string }>) => (
    <button
      type="button"
      onClick={() => pickKind(k)}
      aria-pressed={kind === k}
      className={`flex items-center gap-1.5 rounded-full px-3.5 py-2 text-[13px] font-semibold ${kind === k ? 'liquid-glass-button' : 'liquid-glass-chip text-violet-900'}`}
    >
      <Icon className="w-4 h-4" /> {text}
    </button>
  );
  return (
    <Sheet title="Save this place" onClose={onClose}>
      <p className="text-[12.5px] text-slate-600">{address ? `${address} — ` : ''}saved only for you, and suggested first next time.</p>
      <div className="mt-3 mb-3 flex gap-2">
        {chip('home', 'Home', Home)}
        {chip('work', 'Work', Briefcase)}
        {chip('other', 'Other', Star)}
      </div>
      {kind !== 'other' && <p className="-mt-1 mb-2 text-[11.5px] text-slate-500">Saving a new {kind === 'home' ? 'Home' : 'Work'} replaces the old one.</p>}
      <label className="block text-[12.5px] font-semibold text-slate-500 mb-1.5" htmlFor="rsp-name">
        Name (as you'd say it)
      </label>
      <input
        id="rsp-name"
        value={name}
        onChange={(e) => {
          setName(e.target.value);
          setTouched(true);
        }}
        maxLength={120}
        className="w-full rounded-2xl border-[1.5px] border-violet-600 bg-white px-3.5 py-3 text-[15px] text-slate-900 focus:outline-none"
      />
      <label className="mt-3 block text-[12.5px] font-semibold text-slate-500 mb-1.5" htmlFor="rsp-note">
        Directions for the driver (optional)
      </label>
      <input
        id="rsp-note"
        value={note}
        onChange={(e) => setNote(e.target.value)}
        maxLength={255}
        placeholder="e.g. wait at the gate by the pharmacy"
        className="w-full rounded-2xl border border-slate-200 bg-white px-3.5 py-3 text-[15px] text-slate-900 focus:outline-none focus:border-violet-600"
      />
      <div className="mt-4 flex gap-2.5">
        <button type="button" onClick={onClose} className="liquid-glass-chip rounded-full px-5 py-3 text-[15px] font-semibold text-violet-900">
          Cancel
        </button>
        <button type="button" disabled={saving || !name.trim()} onClick={save} className="liquid-glass-button flex-1 rounded-full py-3 text-[15px] font-bold disabled:opacity-50">
          {saving ? 'Saving…' : 'Save place'}
        </button>
      </div>
    </Sheet>
  );
};
