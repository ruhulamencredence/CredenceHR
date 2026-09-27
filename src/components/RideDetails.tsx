/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Ride Details — the record of a finished (or running) ride: map of the path
// the driver and employee actually travelled (Employee Tracking pings between
// assignment and return, from GET /api/vehicles/requisitions/:id/trip-details),
// plus vehicle, driver, timing, extension and approval history.

import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

type LatLng = [number, number];

interface TrackPoint {
  lat: number;
  lng: number;
  recorded_at: string;
}

interface TripDetails {
  id: number;
  employee_name: string | null;
  purpose: string;
  pickup_location: string;
  destination: string;
  ride_date: string;
  start_time: string;
  estimated_duration_hours: number;
  expected_return_at: string | null;
  status: string;
  decided_by_name: string | null;
  decided_at: string | null;
  vehicle_no: string | null;
  vehicle_model: string | null;
  driver_name: string | null;
  driver_mobile: string | null;
  actual_return_at: string | null;
  returned_late: boolean | null;
  time_extension_status: string;
  time_extension_note: string | null;
  time_extension_decided_by_name: string | null;
  hr_notice_flag: boolean;
  hr_manual_note: string | null;
  created_at: string;
  destination_point: { lat: number; lng: number } | null;
  approval_history: { approver_name: string | null; action: string; remarks: string | null; acted_at: string | null }[];
  driver_track: TrackPoint[];
  employee_track: TrackPoint[];
}

function metersBetween(a: LatLng, b: LatLng): number {
  const toRad = (d: number) => (d * Math.PI) / 180;
  const dLat = toRad(b[0] - a[0]);
  const dLng = toRad(b[1] - a[1]);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(a[0])) * Math.cos(toRad(b[0])) * Math.sin(dLng / 2) ** 2;
  return 2 * 6371000 * Math.asin(Math.sqrt(h));
}

function trackKm(track: TrackPoint[]): number {
  let m = 0;
  for (let i = 1; i < track.length; i++) m += metersBetween([track[i - 1].lat, track[i - 1].lng], [track[i].lat, track[i].lng]);
  return m / 1000;
}

function fmt(iso: string | null): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return isNaN(d.getTime()) ? String(iso) : d.toLocaleString();
}

function durationLabel(fromIso: string | null, toIso: string | null): string | null {
  if (!fromIso || !toIso) return null;
  const mins = Math.round((new Date(toIso).getTime() - new Date(fromIso).getTime()) / 60000);
  if (!Number.isFinite(mins) || mins < 0) return null;
  const h = Math.floor(mins / 60);
  return h > 0 ? `${h} hr ${mins % 60} min` : `${mins} min`;
}

const pinIcon = (bg: string, emoji: string) =>
  L.divIcon({
    className: '',
    html: `<div style="width:30px;height:30px;border-radius:9999px;background:${bg};border:2.5px solid white;box-shadow:0 1px 4px rgba(0,0,0,0.4);display:flex;align-items:center;justify-content:center;color:#fff;font-size:14px;">${emoji}</div>`,
    iconSize: [30, 30],
    iconAnchor: [15, 15]
  });
const startIcon = pinIcon('#059669', '🚗');
const endIcon = pinIcon('#334155', '⏹');
const destinationIcon = pinIcon('#dc2626', '🏁');

function Row({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div className="flex gap-3 py-1.5">
      <div className="w-32 shrink-0 text-gray-500">{label}</div>
      <div className="min-w-0 flex-1 text-gray-800 break-words">{value}</div>
    </div>
  );
}

interface RideDetailsProps {
  requisitionId: number;
  onClose: () => void;
}

export function RideDetails({ requisitionId, onClose }: RideDetailsProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const [data, setData] = useState<TripDetails | null>(null);
  const [error, setError] = useState<string | null>(null);

  useBackButtonClose(true, onClose);

  useEffect(() => {
    const token = localStorage.getItem('mpr_token');
    fetch(apiUrl(`/api/vehicles/requisitions/${requisitionId}/trip-details`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        const json = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(json.error || 'Could not load ride details.');
        setData(json);
      })
      .catch((err) => setError(err.message));
  }, [requisitionId]);

  const hasMap = !!data && (data.driver_track.length > 0 || data.employee_track.length > 0 || !!data.destination_point);

  useEffect(() => {
    if (!hasMap || !data || !mapContainerRef.current || mapRef.current) return;
    const map = L.map(mapContainerRef.current).setView([23.8103, 90.4125], 12);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '&copy; OpenStreetMap contributors',
      maxZoom: 19
    }).addTo(map);
    mapRef.current = map;

    const addMarker = (pos: LatLng, icon: L.DivIcon, label: string) => {
      const popup = document.createElement('div');
      popup.style.fontSize = '12px';
      popup.textContent = label;
      L.marker(pos, { icon }).addTo(map).bindPopup(popup);
    };

    const bounds: LatLng[] = [];
    const employeeLine = data.employee_track.map((p) => [p.lat, p.lng] as LatLng);
    const driverLine = data.driver_track.map((p) => [p.lat, p.lng] as LatLng);
    if (employeeLine.length > 1) L.polyline(employeeLine, { color: '#2563eb', weight: 3, opacity: 0.7, dashArray: '6 6' }).addTo(map);
    if (driverLine.length > 1) L.polyline(driverLine, { color: '#7F00FF', weight: 5, opacity: 0.85 }).addTo(map);
    bounds.push(...employeeLine, ...driverLine);

    const main = data.driver_track.length > 0 ? data.driver_track : data.employee_track;
    if (main.length > 0) {
      const first = main[0];
      const last = main[main.length - 1];
      addMarker([first.lat, first.lng], startIcon, `Start — ${fmt(first.recorded_at)}`);
      if (main.length > 1) addMarker([last.lat, last.lng], endIcon, `Last position — ${fmt(last.recorded_at)}`);
    }
    if (data.destination_point) {
      const dest: LatLng = [data.destination_point.lat, data.destination_point.lng];
      addMarker(dest, destinationIcon, `Destination — ${data.destination}`);
      bounds.push(dest);
    }
    if (bounds.length > 0) map.fitBounds(L.latLngBounds(bounds), { padding: [40, 40], maxZoom: 16 });
    setTimeout(() => map.invalidateSize(), 100);

    return () => {
      map.remove();
      mapRef.current = null;
    };
  }, [hasMap, data]);

  const mainTrack = data ? (data.driver_track.length > 0 ? data.driver_track : data.employee_track) : [];
  const travelledKm = mainTrack.length > 1 ? trackKm(mainTrack) : null;
  const tripTime = data ? durationLabel(data.decided_at, data.actual_return_at) : null;

  return (
    // Full screen on phones, so keep the header (and its close button) below
    // the status bar / notch.
    <div
      className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-0 sm:p-4"
      style={{
        paddingTop: 'var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px))',
        paddingBottom: 'var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))'
      }}
    >
      <div className="bg-white sm:rounded-lg shadow-xl w-full max-w-2xl h-full sm:h-auto sm:max-h-[92vh] flex flex-col">
        <div className="flex items-center justify-between px-4 py-3 border-b shrink-0">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-gray-800">Ride Details #{requisitionId}</div>
            {data && (
              <div className="text-xs text-gray-500 truncate">
                {data.pickup_location} → {data.destination}
              </div>
            )}
          </div>
          <button onClick={onClose} className="p-2 -mr-1 rounded-full hover:bg-gray-100 shrink-0" aria-label="Close">
            <X className="w-5 h-5 text-gray-500" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {error && <div className="px-4 py-3 text-sm text-red-600">{error}</div>}
          {!data && !error && (
            <div className="px-4 py-10 flex justify-center">
              <Spinner size={20} />
            </div>
          )}

          {data && (
            <>
              {hasMap ? (
                <div ref={mapContainerRef} style={{ height: 320 }} />
              ) : (
                <div className="px-4 py-6 text-center text-xs text-gray-500 bg-gray-50 border-b">
                  No location was recorded for this ride (Employee Tracking was off for both accounts).
                </div>
              )}

              {hasMap && (
                <div className="px-4 py-2 border-b bg-purple-50 text-xs text-purple-900 flex flex-wrap gap-x-4 gap-y-1">
                  {travelledKm != null && (
                    <span>
                      Travelled <span className="font-semibold">{travelledKm.toFixed(1)} km</span>
                    </span>
                  )}
                  {tripTime && (
                    <span>
                      Trip time <span className="font-semibold">{tripTime}</span>
                    </span>
                  )}
                  <span className="text-purple-700/70">
                    ━ Driver path{data.employee_track.length > 1 ? ' · ┅ Employee path' : ''} · 🏁 Destination
                  </span>
                </div>
              )}

              <div className="px-4 py-3 text-sm divide-y divide-gray-100">
                <Row label="Status" value={<span className="capitalize">{data.status}</span>} />
                <Row label="Requested by" value={data.employee_name || '—'} />
                <Row label="Requested on" value={fmt(data.created_at)} />
                <Row label="Purpose" value={data.purpose} />
                <Row label="Pickup" value={data.pickup_location} />
                <Row label="Destination" value={data.destination} />
                <Row
                  label="Scheduled"
                  value={`${String(data.ride_date).slice(0, 10)} at ${data.start_time} · Est. ${data.estimated_duration_hours} hr`}
                />
                <Row label="Vehicle" value={data.vehicle_no ? `${data.vehicle_model || ''} (${data.vehicle_no})` : '—'} />
                <Row label="Driver" value={data.driver_name ? `${data.driver_name}${data.driver_mobile ? ` — ${data.driver_mobile}` : ''}` : '—'} />
                <Row label="Assigned" value={data.decided_by_name ? `${fmt(data.decided_at)} by ${data.decided_by_name}` : fmt(data.decided_at)} />
                <Row label="Expected back" value={fmt(data.expected_return_at)} />
                <Row
                  label="Returned"
                  value={
                    data.actual_return_at ? (
                      <span>
                        {fmt(data.actual_return_at)}{' '}
                        <span className={data.returned_late ? 'text-amber-700 font-medium' : 'text-green-700 font-medium'}>
                          ({data.returned_late ? 'late' : 'on time'})
                        </span>
                      </span>
                    ) : (
                      '—'
                    )
                  }
                />
                {data.time_extension_status !== 'none' && (
                  <Row
                    label="Time extension"
                    value={`${data.time_extension_status}${data.time_extension_note ? ` — ${data.time_extension_note}` : ''}${
                      data.time_extension_decided_by_name ? ` (by ${data.time_extension_decided_by_name})` : ''
                    }`}
                  />
                )}
                {(data.hr_notice_flag || data.hr_manual_note) && (
                  <Row label="HR note" value={data.hr_manual_note || 'Late return without notice — flagged'} />
                )}
              </div>

              {data.approval_history.length > 0 && (
                <div className="px-4 pb-4">
                  <div className="text-xs font-semibold text-gray-500 mb-2">Approval history</div>
                  <ol className="space-y-2 border-l-2 border-gray-200 pl-3">
                    {data.approval_history.map((a, i) => (
                      <li key={i} className="text-xs">
                        <div className="text-gray-800">
                          <span className="font-medium">{a.approver_name || 'Unknown'}</span>{' '}
                          <span className={a.action === 'rejected' ? 'text-red-600' : 'text-green-700'}>{a.action}</span>
                        </div>
                        <div className="text-gray-400">{fmt(a.acted_at)}</div>
                        {a.remarks && <div className="text-gray-600">“{a.remarks}”</div>}
                      </li>
                    ))}
                  </ol>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}
