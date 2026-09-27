/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Book a Ride -> "Set On Map": full-screen map with a fixed pin in the
// centre. The user drags the map until the pin sits on the place they want;
// the address under the pin is looked up (GET /api/vehicles/places/reverse)
// each time the map stops moving.

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { ArrowLeft, LocateFixed, MapPin } from 'lucide-react';
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
