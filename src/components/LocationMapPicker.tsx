import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import { Geolocation } from '@capacitor/geolocation';
import { X, MapPin, LocateFixed, Check, Search, CircleDot } from 'lucide-react';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface LocationMapPickerProps {
  title?: string;
  initialLat?: number | null;
  initialLng?: number | null;
  initialLabel?: string | null;
  initialRadius?: number | null; // meters
  onCancel: () => void;
  onConfirm: (lat: number, lng: number, label: string | null, radius: number | null) => void;
}

interface GeocodeResult {
  display_name: string;
  lat: string;
  lon: string;
}

// Dhaka, Bangladesh — sensible default center when a project has no pin yet.
const DEFAULT_CENTER: [number, number] = [23.8103, 90.4125];
const DEFAULT_ZOOM = 12;
const PINNED_ZOOM = 16;
const MIN_RADIUS = 10;
const MAX_RADIUS = 50000;
const DEFAULT_RADIUS = 200;

// A small blue SVG pin, drawn inline as a divIcon so nothing depends on
// Leaflet's default marker image assets (which don't resolve correctly once
// bundled by Vite unless separately worked around).
const pinIcon = L.divIcon({
  className: '',
  html: `<svg width="34" height="34" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter: drop-shadow(0 2px 3px rgba(0,0,0,0.35));">
    <path d="M12 0C7.03 0 3 4.03 3 9c0 6.75 9 15 9 15s9-8.25 9-15c0-4.97-4.03-9-9-9z" fill="#7F00FF"/>
    <circle cx="12" cy="9" r="3.4" fill="white"/>
  </svg>`,
  iconSize: [34, 34],
  iconAnchor: [17, 34],
  popupAnchor: [0, -30]
});

// Small round drag-handle sitting on the circle's edge — dragging it toward or
// away from the center pin resizes the radius circle live.
const handleIcon = L.divIcon({
  className: '',
  html: `<div style="width:16px;height:16px;border-radius:50%;background:#ffffff;border:3px solid #7F00FF;box-shadow:0 1px 4px rgba(0,0,0,0.4);cursor:ew-resize;"></div>`,
  iconSize: [16, 16],
  iconAnchor: [8, 8]
});

// Returns the point `distanceMeters` away from (lat, lng) along `bearingDeg`
// (0 = north, 90 = east). Used to place the radius drag-handle on the circle's
// eastern edge and to translate handle drags back into a radius in meters.
function destinationPoint(lat: number, lng: number, distanceMeters: number, bearingDeg: number): { lat: number; lng: number } {
  const R = 6371000;
  const brng = (bearingDeg * Math.PI) / 180;
  const lat1 = (lat * Math.PI) / 180;
  const lng1 = (lng * Math.PI) / 180;
  const angDist = distanceMeters / R;
  const lat2 = Math.asin(Math.sin(lat1) * Math.cos(angDist) + Math.cos(lat1) * Math.sin(angDist) * Math.cos(brng));
  const lng2 = lng1 + Math.atan2(
    Math.sin(brng) * Math.sin(angDist) * Math.cos(lat1),
    Math.cos(angDist) - Math.sin(lat1) * Math.sin(lat2)
  );
  return { lat: (lat2 * 180) / Math.PI, lng: (((lng2 * 180) / Math.PI + 540) % 360) - 180 };
}

function formatRadius(m: number): string {
  return m >= 1000 ? `${(m / 1000).toFixed(m % 1000 === 0 ? 0 : 1)} km` : `${Math.round(m)} m`;
}

// Free, no-API-key map picker — uses OpenStreetMap tiles via the Leaflet library
// (installed as a plain npm dependency, no paid maps API key or billing account
// required). Click/tap anywhere on the map, or drag the pin, to choose a spot;
// a place-name search box (OpenStreetMap/Nominatim geocoding, also free/no-key)
// lets you jump straight to an address instead of hunting for coordinates; an
// optional radius circle can be toggled on and resized either by dragging its
// edge handle or typing a value. "Use current location" reuses the same
// @capacitor/geolocation flow AuthScreen uses for login-location capture, so it
// also works inside the Android app build.
export default function LocationMapPicker({
  title = 'Set Location on Map',
  initialLat,
  initialLng,
  initialLabel,
  initialRadius,
  onCancel,
  onConfirm
}: LocationMapPickerProps) {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const markerRef = useRef<L.Marker | null>(null);
  const circleRef = useRef<L.Circle | null>(null);
  const handleRef = useRef<L.Marker | null>(null);
  const radiusRef = useRef<number>(initialRadius ?? DEFAULT_RADIUS);
  const searchAbortRef = useRef<AbortController | null>(null);
  const searchDebounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const searchBoxRef = useRef<HTMLDivElement | null>(null);

  const hasInitial = typeof initialLat === 'number' && typeof initialLng === 'number';
  const [coords, setCoords] = useState<{ lat: number; lng: number } | null>(
    hasInitial ? { lat: initialLat as number, lng: initialLng as number } : null
  );
  const [label, setLabel] = useState(initialLabel || '');
  const [locating, setLocating] = useState(false);
  const [locateError, setLocateError] = useState<string | null>(null);

  const [radiusEnabled, setRadiusEnabled] = useState<boolean>(typeof initialRadius === 'number' && initialRadius > 0);
  const [radius, setRadius] = useState<number>(initialRadius ?? DEFAULT_RADIUS);

  const [searchQuery, setSearchQuery] = useState('');
  const [searchResults, setSearchResults] = useState<GeocodeResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [showResults, setShowResults] = useState(false);

  useBackButtonClose(true, onCancel);

  // Kept in refs (in addition to state) so the Leaflet event handlers set up
  // once in the mount effect always see the latest values without re-binding.
  const radiusEnabledRef = useRef(radiusEnabled);
  useEffect(() => { radiusEnabledRef.current = radiusEnabled; }, [radiusEnabled]);
  useEffect(() => { radiusRef.current = radius; }, [radius]);

  const removeCircle = () => {
    if (circleRef.current) {
      circleRef.current.remove();
      circleRef.current = null;
    }
    if (handleRef.current) {
      handleRef.current.remove();
      handleRef.current = null;
    }
  };

  const positionHandle = (lat: number, lng: number, r: number) => {
    const map = mapRef.current;
    if (!map) return;
    const edge = destinationPoint(lat, lng, r, 90);
    if (handleRef.current) {
      handleRef.current.setLatLng([edge.lat, edge.lng]);
    } else {
      const h = L.marker([edge.lat, edge.lng], { icon: handleIcon, draggable: true }).addTo(map);
      h.on('drag', () => {
        const center = markerRef.current?.getLatLng();
        if (!center) return;
        const pos = h.getLatLng();
        const newRadius = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, map.distance(center, pos)));
        radiusRef.current = newRadius;
        setRadius(Math.round(newRadius));
        circleRef.current?.setRadius(newRadius);
      });
      h.on('dragend', () => {
        const center = markerRef.current?.getLatLng();
        if (!center) return;
        // Snap the handle back onto the exact eastern edge for the final radius,
        // so it doesn't visually drift off the circle after a diagonal drag.
        positionHandle(center.lat, center.lng, radiusRef.current);
      });
      handleRef.current = h;
    }
  };

  const upsertCircle = (lat: number, lng: number, r: number) => {
    const map = mapRef.current;
    if (!map) return;
    if (circleRef.current) {
      circleRef.current.setLatLng([lat, lng]);
      circleRef.current.setRadius(r);
    } else {
      circleRef.current = L.circle([lat, lng], {
        radius: r,
        color: '#7F00FF',
        weight: 2,
        fillColor: '#7F00FF',
        fillOpacity: 0.12
      }).addTo(map);
    }
    positionHandle(lat, lng, r);
  };

  const placeMarker = (lat: number, lng: number) => {
    setCoords({ lat, lng });
    const map = mapRef.current;
    if (!map) return;
    if (markerRef.current) {
      markerRef.current.setLatLng([lat, lng]);
    } else {
      markerRef.current = L.marker([lat, lng], { icon: pinIcon, draggable: true }).addTo(map);
      markerRef.current.on('drag', () => {
        const pos = markerRef.current!.getLatLng();
        if (radiusEnabledRef.current) upsertCircle(pos.lat, pos.lng, radiusRef.current);
      });
      markerRef.current.on('dragend', () => {
        const pos = markerRef.current!.getLatLng();
        setCoords({ lat: pos.lat, lng: pos.lng });
      });
    }
    if (radiusEnabledRef.current) {
      upsertCircle(lat, lng, radiusRef.current);
    } else {
      removeCircle();
    }
  };

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;

    const center: [number, number] = hasInitial ? [initialLat as number, initialLng as number] : DEFAULT_CENTER;
    const map = L.map(mapContainerRef.current, {
      center,
      zoom: hasInitial ? PINNED_ZOOM : DEFAULT_ZOOM
    });
    mapRef.current = map;

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      attribution: '&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
    }).addTo(map);

    if (hasInitial) {
      placeMarker(initialLat as number, initialLng as number);
    }

    map.on('click', (e: L.LeafletMouseEvent) => {
      placeMarker(e.latlng.lat, e.latlng.lng);
    });

    // The map is created inside an animated modal, so its container may still be
    // 0x0 at the moment Leaflet measures it — this fixes the grey-tile issue.
    setTimeout(() => map.invalidateSize(), 80);

    return () => {
      map.remove();
      mapRef.current = null;
      markerRef.current = null;
      circleRef.current = null;
      handleRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Close the search results dropdown on outside click.
  useEffect(() => {
    const handleClick = (e: MouseEvent) => {
      if (searchBoxRef.current && !searchBoxRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    };
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, []);

  // Debounced place-name search against OpenStreetMap's free Nominatim
  // geocoder — no API key required, mirroring the rest of this picker.
  useEffect(() => {
    if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    const q = searchQuery.trim();
    if (q.length < 3) {
      setSearchResults([]);
      setSearching(false);
      return;
    }
    setSearching(true);
    searchDebounceRef.current = setTimeout(async () => {
      searchAbortRef.current?.abort();
      const controller = new AbortController();
      searchAbortRef.current = controller;
      try {
        const res = await fetch(
          `https://nominatim.openstreetmap.org/search?format=jsonv2&limit=6&q=${encodeURIComponent(q)}`,
          { signal: controller.signal }
        );
        const data = await res.json();
        setSearchResults(Array.isArray(data) ? data : []);
        setShowResults(true);
      } catch (err: any) {
        if (err?.name !== 'AbortError') setSearchResults([]);
      } finally {
        setSearching(false);
      }
    }, 400);
    return () => {
      if (searchDebounceRef.current) clearTimeout(searchDebounceRef.current);
    };
  }, [searchQuery]);

  const handleSelectResult = (r: GeocodeResult) => {
    const lat = parseFloat(r.lat);
    const lng = parseFloat(r.lon);
    if (!Number.isFinite(lat) || !Number.isFinite(lng)) return;
    placeMarker(lat, lng);
    mapRef.current?.setView([lat, lng], PINNED_ZOOM);
    setSearchQuery(r.display_name);
    setShowResults(false);
    setSearchResults([]);
  };

  const handleUseCurrentLocation = async () => {
    setLocating(true);
    setLocateError(null);
    try {
      let status = (await Geolocation.checkPermissions()).location;
      if (status !== 'granted') {
        status = (await Geolocation.requestPermissions()).location;
      }
      if (status !== 'granted') {
        throw new Error('Location permission was not granted');
      }
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      const { latitude, longitude } = pos.coords;
      placeMarker(latitude, longitude);
      mapRef.current?.setView([latitude, longitude], PINNED_ZOOM);
    } catch (err: any) {
      setLocateError(err?.message || 'Could not get current location');
    } finally {
      setLocating(false);
    }
  };

  const handleToggleRadius = (enabled: boolean) => {
    setRadiusEnabled(enabled);
    radiusEnabledRef.current = enabled;
    if (!coords) return;
    if (enabled) {
      upsertCircle(coords.lat, coords.lng, radius);
    } else {
      removeCircle();
    }
  };

  const handleRadiusChange = (r: number) => {
    const clamped = Math.min(MAX_RADIUS, Math.max(MIN_RADIUS, r));
    setRadius(clamped);
    radiusRef.current = clamped;
    if (coords && radiusEnabled) {
      upsertCircle(coords.lat, coords.lng, clamped);
    }
  };

  const handleConfirm = () => {
    if (!coords) return;
    onConfirm(coords.lat, coords.lng, label.trim() || null, radiusEnabled ? Math.round(radius) : null);
  };

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
      <div className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[92vh] overflow-hidden shadow-2xl flex flex-col">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-blue-50 text-blue-600 p-2 rounded-xl border border-blue-100">
              <MapPin className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">{title}</h3>
              <p className="text-xs text-slate-500">Search a place, or tap the map / drag the pin to mark the exact spot</p>
            </div>
          </div>
          <button
            onClick={onCancel}
            className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto">
          <div ref={searchBoxRef} className="relative">
            <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              onFocus={() => searchResults.length > 0 && setShowResults(true)}
              placeholder="Search for a place or address..."
              className="w-full pl-9 pr-9 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-sm text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
            {searching && (
              <Spinner size={16} className="text-slate-400 absolute right-3 top-1/2 -translate-y-1/2" />
            )}
            {showResults && searchResults.length > 0 && (
              <div className="absolute z-10 top-full mt-1 left-0 right-0 bg-white border border-slate-200 rounded-xl shadow-lg max-h-52 overflow-y-auto">
                {searchResults.map((r, i) => (
                  <button
                    key={i}
                    type="button"
                    onClick={() => handleSelectResult(r)}
                    className="w-full text-left px-3 py-2 text-xs text-slate-700 hover:bg-blue-50 border-b border-slate-100 last:border-b-0 flex items-start gap-2"
                  >
                    <MapPin className="w-3.5 h-3.5 text-blue-500 shrink-0 mt-0.5" />
                    <span className="truncate">{r.display_name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          <div
            ref={mapContainerRef}
            className="w-full h-80 sm:h-96 rounded-xl border border-slate-200 overflow-hidden"
          />

          <div className="flex flex-wrap items-center gap-3">
            <button
              type="button"
              onClick={handleUseCurrentLocation}
              disabled={locating}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-slate-100 hover:bg-slate-200 disabled:opacity-60 text-slate-700 text-xs font-semibold rounded-xl border border-slate-200 transition-colors"
            >
              <LocateFixed className="w-3.5 h-3.5" />
              {locating ? 'Locating…' : 'Use current location'}
            </button>
            <div className="text-xs font-mono text-slate-600">
              {coords ? (
                <span className="inline-flex items-center gap-1.5 px-2.5 py-1 bg-blue-50 text-blue-800 border border-blue-100 rounded-full">
                  <MapPin className="w-3.5 h-3.5" />
                  {coords.lat.toFixed(6)}, {coords.lng.toFixed(6)}
                </span>
              ) : (
                <span className="text-slate-400">No point selected yet</span>
              )}
            </div>
          </div>
          {locateError && <p className="text-xs text-rose-600">{locateError}</p>}

          <div className="border border-slate-200 rounded-xl p-3 bg-slate-50/60">
            <label className="flex items-center gap-2 cursor-pointer select-none">
              <input
                type="checkbox"
                checked={radiusEnabled}
                onChange={(e) => handleToggleRadius(e.target.checked)}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
              />
              <CircleDot className="w-3.5 h-3.5 text-blue-600" />
              <span className="text-xs font-semibold text-slate-700">Add a radius circle</span>
            </label>
            {radiusEnabled && (
              <div className="mt-3 space-y-2">
                <p className="text-[11px] text-slate-400">Drag the small handle on the circle's edge, or set an exact value below.</p>
                <div className="flex items-center gap-3">
                  <input
                    type="range"
                    min={MIN_RADIUS}
                    max={MAX_RADIUS}
                    step={10}
                    value={radius}
                    onChange={(e) => handleRadiusChange(Number(e.target.value))}
                    className="flex-1 accent-blue-600"
                  />
                  <div className="flex items-center gap-1 shrink-0">
                    <input
                      type="number"
                      min={MIN_RADIUS}
                      max={MAX_RADIUS}
                      value={Math.round(radius)}
                      onChange={(e) => handleRadiusChange(Number(e.target.value))}
                      className="w-20 px-2 py-1.5 bg-white border border-slate-200 rounded-lg text-xs text-slate-900 focus:outline-none focus:ring-2 focus:ring-blue-600"
                    />
                    <span className="text-xs text-slate-500">m</span>
                  </div>
                </div>
                <span className="inline-block text-[11px] font-semibold text-blue-700 bg-blue-50 border border-blue-100 rounded-full px-2 py-0.5">
                  ≈ {formatRadius(radius)} radius
                </span>
              </div>
            )}
          </div>

          <div>
            <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
              Location Label (optional)
            </label>
            <input
              type="text"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              placeholder="e.g. Main Site Gate"
              maxLength={255}
              className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
            />
          </div>
        </div>

        <div className="p-5 border-t border-slate-200 flex justify-end gap-3 shrink-0">
          <button
            type="button"
            onClick={onCancel}
            className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl border border-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleConfirm}
            disabled={!coords}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 disabled:hover:bg-blue-600 text-white font-semibold rounded-xl text-sm transition-all shadow-sm"
          >
            <Check className="w-4 h-4" />
            Use This Location
          </button>
        </div>
      </div>
    </div>
  );
}
