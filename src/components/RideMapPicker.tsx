/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Book a Ride -> "Set On Map": full-screen map with a fixed pin in the
// centre. The user drags the map until the pin sits on the place they want;
// the address under the pin is looked up (GET /api/vehicles/places/reverse)
// each time the map stops moving. A search box on top (GET
// /api/vehicles/places/search) jumps the map straight to a named place.

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowLeft, LocateFixed, MapPin, Search, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

const DHAKA: [number, number] = [23.8103, 90.4125];

interface RideMapPickerProps {
  title: string;
  start: { lat: number; lng: number } | null;
  onLocateMe: () => Promise<{ lat: number; lng: number } | null>;
  onCancel: () => void;
  onConfirm: (place: { label: string; lat: number; lng: number }) => void;
}

export function RideMapPicker({ title, start, onLocateMe, onCancel, onConfirm }: RideMapPickerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [center, setCenter] = useState<{ lat: number; lng: number }>(start || { lat: DHAKA[0], lng: DHAKA[1] });
  const [label, setLabel] = useState<string | null>(null);
  const [resolving, setResolving] = useState(false);
  const [moving, setMoving] = useState(false);
  const [locating, setLocating] = useState(false);
  const [query, setQuery] = useState('');
  const [results, setResults] = useState<{ label: string; detail?: string; lat: number; lng: number }[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [showResults, setShowResults] = useState(false);
  // Label of a place picked from search — used instead of a reverse lookup once the map lands there.
  const pickedLabelRef = useRef<string | null>(null);

  useBackButtonClose(true, onCancel);

  useEffect(() => {
    if (!containerRef.current || mapRef.current) return;
    const map = L.map(containerRef.current, { zoomControl: false }).setView(start ? [start.lat, start.lng] : DHAKA, start ? 16 : 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    L.control.zoom({ position: 'bottomright' }).addTo(map);
    map.on('movestart', () => setMoving(true));
    map.on('dragstart', () => setShowResults(false));
    map.on('moveend', () => {
      const c = map.getCenter();
      setMoving(false);
      setCenter({ lat: c.lat, lng: c.lng });
    });
    mapRef.current = map;
    setTimeout(() => map.invalidateSize(), 100);
    return () => {
      map.remove();
      mapRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Look up the address under the pin once the map has settled.
  useEffect(() => {
    if (pickedLabelRef.current) {
      setLabel(pickedLabelRef.current);
      pickedLabelRef.current = null;
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setResolving(true);
      try {
        const token = localStorage.getItem('mpr_token');
        const res = await fetch(apiUrl(`/api/vehicles/places/reverse?lat=${center.lat}&lng=${center.lng}`), {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        const data = await res.json().catch(() => null);
        setLabel(data?.label || null);
      } catch {
        if (!controller.signal.aborted) setLabel(null);
      } finally {
        if (!controller.signal.aborted) setResolving(false);
      }
    }, 600);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [center.lat, center.lng]);

  // Debounced place search.
  useEffect(() => {
    const q = query.trim();
    if (q.length < 3) {
      setResults([]);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const token = localStorage.getItem('mpr_token');
        const res = await fetch(apiUrl(`/api/vehicles/places/search?q=${encodeURIComponent(q)}`), {
          headers: { Authorization: `Bearer ${token}` },
          signal: controller.signal
        });
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.error || 'Place search failed.');
        setResults(Array.isArray(data) ? data.filter((p: any) => p.lat != null && p.lng != null) : []);
        setSearchError(null);
      } catch (err: any) {
        if (!controller.signal.aborted) setSearchError(err.message || 'Place search failed.');
      } finally {
        if (!controller.signal.aborted) setSearching(false);
      }
    }, 450);
    return () => {
      controller.abort();
      clearTimeout(timer);
    };
  }, [query]);

  const goTo = (place: { label: string; lat: number; lng: number }) => {
    setShowResults(false);
    (document.activeElement as HTMLElement | null)?.blur();
    setQuery(place.label);
    const map = mapRef.current;
    if (!map) return;
    pickedLabelRef.current = place.label;
    map.setView([place.lat, place.lng], 17);
    // setView on the same spot fires no moveend — apply the label directly.
    const c = map.getCenter();
    if (Math.abs(c.lat - center.lat) < 1e-7 && Math.abs(c.lng - center.lng) < 1e-7) {
      setLabel(place.label);
      pickedLabelRef.current = null;
    }
  };

  const locate = async () => {
    setLocating(true);
    try {
      const here = await onLocateMe();
      if (here && mapRef.current) mapRef.current.setView([here.lat, here.lng], 17);
    } finally {
      setLocating(false);
    }
  };

  const coordsText = `${center.lat.toFixed(5)}, ${center.lng.toFixed(5)}`;
  const shownLabel = label || coordsText;

  return (
    <div className="fixed inset-0 z-[60] bg-white flex flex-col">
      <div className="flex items-center gap-3 px-4 py-3 border-b">
        <button type="button" onClick={onCancel} className="p-1 -ml-1 text-slate-700" aria-label="Back">
          <ArrowLeft className="w-5 h-5" />
        </button>
        <div className="text-base font-semibold text-slate-900">{title}</div>
      </div>

      <div className="relative flex-1">
        <div ref={containerRef} className="absolute inset-0" />
        <div className="absolute left-3 right-16 top-3 z-[600]">
          <div className="flex items-center gap-2 bg-white rounded-xl shadow-md px-3 py-2.5">
            <Search className="w-4 h-4 text-slate-400 shrink-0" />
            <input
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                setShowResults(true);
              }}
              onFocus={() => setShowResults(true)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && results[0]) {
                  e.preventDefault();
                  goTo(results[0]);
                }
              }}
              placeholder="Search a place"
              className="flex-1 min-w-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
            />
            {searching ? (
              <Spinner size={14} />
            ) : (
              query && (
                <button type="button" onClick={() => { setQuery(''); setResults([]); }} className="p-0.5 text-slate-400 hover:text-slate-600" aria-label="Clear search">
                  <X className="w-4 h-4" />
                </button>
              )
            )}
          </div>
          {showResults && query.trim().length >= 3 && !searching && (
            <div className="mt-1 bg-white rounded-xl shadow-lg max-h-72 overflow-y-auto divide-y divide-slate-100">
              {results.map((place, i) => (
                <button
                  key={`${place.label}-${i}`}
                  type="button"
                  onClick={() => goTo(place)}
                  className="w-full flex items-start gap-3 px-3 py-2.5 text-left hover:bg-slate-50"
                >
                  <MapPin className="w-4 h-4 text-slate-400 shrink-0 mt-0.5" />
                  <span className="min-w-0">
                    <span className="block text-sm text-slate-800 truncate">{place.label}</span>
                    {place.detail && <span className="block text-[11px] text-slate-400 truncate">{place.detail}</span>}
                  </span>
                </button>
              ))}
              {results.length === 0 && <div className="px-3 py-2.5 text-sm text-slate-400">{searchError || 'No matching places found.'}</div>}
            </div>
          )}
        </div>
        {/* Fixed centre pin — the map moves underneath it. */}
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-full z-[500]">
          <MapPin className={`w-10 h-10 text-red-500 drop-shadow-md transition-transform ${moving ? '-translate-y-2' : ''}`} fill="currentColor" stroke="white" strokeWidth={1.5} />
        </div>
        <div className="pointer-events-none absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 w-2 h-2 rounded-full bg-black/40 z-[499]" />
        <button
          type="button"
          onClick={locate}
          className="absolute right-3 top-3 z-[500] w-10 h-10 rounded-full bg-white shadow-md flex items-center justify-center text-slate-700"
          aria-label="Go to my location"
        >
          {locating ? <Spinner size={16} /> : <LocateFixed className="w-5 h-5" />}
        </button>
      </div>

      <div className="border-t px-4 pt-3 pb-5 space-y-3 bg-white">
        <div className="flex items-start gap-3">
          <MapPin className="w-5 h-5 text-red-500 shrink-0 mt-0.5" />
          <div className="min-w-0">
            <div className="text-sm font-medium text-slate-900 truncate">{moving || resolving ? 'Finding address…' : shownLabel}</div>
            {label && <div className="text-[11px] text-slate-400">{coordsText}</div>}
          </div>
        </div>
        <button
          type="button"
          disabled={moving}
          onClick={() => onConfirm({ label: shownLabel, lat: center.lat, lng: center.lng })}
          className="w-full py-3 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700 disabled:opacity-50"
        >
          Confirm Location
        </button>
      </div>
    </div>
  );
}
