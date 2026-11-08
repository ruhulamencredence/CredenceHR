/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Book a Ride, step 1 — ride-hailing style "Where are you going?" screen.
// Pickup defaults to the phone's current location (turned into an address by
// GET /api/vehicles/places/reverse); the destination is picked from typed
// suggestions (GET /api/vehicles/places/search), the Recent list (GET
// /api/vehicles/places/recent), or used exactly as typed.
//
// On a phone: one route card (pickup → destination), quick chips (Home /
// Work from saved places, Projects, Map), three recent places, and while
// typing a single suggestions list that also holds "Use as typed" and
// "Choose on map".
//
// On a desktop web browser (useWideWeb) the panel sits beside a live map
// (RideBookingMap): clicking the map sets the pickup or the destination, and
// the user confirms with Continue instead of a pick jumping straight ahead.

import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Armchair, MapPin, MapPinned, History, Search, PencilLine, LocateFixed, X, ArrowRight, Home, Briefcase, Building2, Map as MapIcon } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { RideMapPicker, savedLabel, type SavedPlace } from './RideMapPicker';
import { RideBookingMap, RidePoint, RidePointKind } from './RideBookingMap';
import { useWideWeb } from '../lib/useWideWeb';
import { RIDE_CARD } from './rideTheme';

export interface RidePlaces {
  pickup_location: string;
  destination: string;
  destination_lat: number | null;
  destination_lng: number | null;
  pickup_lat?: number | null;
  pickup_lng?: number | null;
}

interface Place {
  label: string;
  detail?: string;
  lat: number | null;
  lng: number | null;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}` };
}

async function getCurrentCoords(): Promise<{ latitude: number; longitude: number }> {
  if (Capacitor.isNativePlatform()) {
    let status: string;
    try {
      status = (await Geolocation.checkPermissions()).location;
    } catch {
      status = 'prompt';
    }
    if (status !== 'granted') status = (await Geolocation.requestPermissions()).location;
    if (status !== 'granted') throw new Error('Location permission denied.');
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  }
  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) return reject(new Error('No location access.'));
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => reject(new Error('Could not get your location.')),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}

// Mobile: the app's liquid glass card (soft violet-to-white fill, big rounded
// corners, bright top edge) so Book a Ride matches the rest of the app.
export const GLASS_CARD =
  'rounded-[24px] border border-white/70 bg-gradient-to-br from-violet-100/60 via-white/60 to-white/40 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.7)]';

interface RideDestinationPickerProps {
  initial?: RidePlaces | null;
  onDone: (places: RidePlaces) => void;
}

export function RideDestinationPicker({ initial, onDone }: RideDestinationPickerProps) {
  const [pickup, setPickup] = useState(initial?.pickup_location || '');
  const [locating, setLocating] = useState(false);
  const [query, setQuery] = useState(initial?.destination || '');
  const [suggestions, setSuggestions] = useState<Place[]>([]);
  const [searching, setSearching] = useState(false);
  const [searchError, setSearchError] = useState<string | null>(null);
  const [recent, setRecent] = useState<Place[]>([]);
  const [message, setMessage] = useState<string | null>(null);
  const [pickupCoords, setPickupCoords] = useState<{ lat: number; lng: number } | null>(null);
  const [mapFor, setMapFor] = useState<'pickup' | 'destination' | null>(null);
  const [locateFailed, setLocateFailed] = useState(false);
  // Destination picked before a pickup was set — finished once the pickup is chosen on the map.
  const [pendingDestination, setPendingDestination] = useState<Place | null>(null);
  const destinationRef = useRef<HTMLInputElement | null>(null);
  const wideWeb = useWideWeb();
  const [here, setHere] = useState<RidePoint | null>(null);
  // Web only: the destination chosen so far (confirmed with Continue) and
  // which point a map click sets.
  const [destPlace, setDestPlace] = useState<Place | null>(
    initial?.destination ? { label: initial.destination, lat: initial.destination_lat, lng: initial.destination_lng } : null
  );
  const [activePoint, setActivePoint] = useState<RidePointKind>(initial?.pickup_location ? 'destination' : 'pickup');
  // Set when the destination box is filled in by a pick, so it isn't searched.
  const skipSearchRef = useRef(false);
  // Phone: saved Home / Work (only with users.can_save_ride_places — the
  // list answers 403 otherwise and the chips stay hidden), project sites for
  // the suggestions, the full recent list, and the map opened on Projects.
  const [saved, setSaved] = useState<SavedPlace[]>([]);
  const [projects, setProjects] = useState<{ id: number; label: string; detail: string | null; lat: number; lng: number; distance_m: number | null }[]>([]);
  const [allRecent, setAllRecent] = useState(false);
  const [destFocused, setDestFocused] = useState(false);
  const [mapOpenWith, setMapOpenWith] = useState<'projects' | undefined>(undefined);

  useEffect(() => {
    if (initial?.pickup_lat != null && initial?.pickup_lng != null) setPickupCoords({ lat: initial.pickup_lat, lng: initial.pickup_lng });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const reverseLabel = async (point: RidePoint): Promise<string> => {
    const fallback = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    try {
      const res = await fetch(apiUrl(`/api/vehicles/places/reverse?lat=${point.lat}&lng=${point.lng}`), { headers: authHeaders() });
      const data = await res.json().catch(() => null);
      return data?.label || fallback;
    } catch {
      return fallback;
    }
  };

  const setDestinationBox = (text: string) => {
    skipSearchRef.current = true;
    setSuggestions([]);
    setQuery(text);
  };

  const pickOnMap = async (kind: RidePointKind, point: RidePoint) => {
    setMessage(null);
    const coordsText = `${point.lat.toFixed(5)}, ${point.lng.toFixed(5)}`;
    if (kind === 'pickup') {
      setPickupCoords(point);
      setPickup(coordsText);
      if (!destPlace) setActivePoint('destination');
      const label = await reverseLabel(point);
      setPickup(label);
    } else {
      setDestPlace({ label: coordsText, lat: point.lat, lng: point.lng });
      setDestinationBox(coordsText);
      const label = await reverseLabel(point);
      setDestPlace({ label, lat: point.lat, lng: point.lng });
      setDestinationBox(label);
    }
  };

  // Web map: a project picked from its Projects list / pins, under its own name.
  const pickProject = (p: { label: string; lat: number; lng: number }) => {
    setMessage(null);
    const point = { lat: p.lat, lng: p.lng };
    if (activePoint === 'pickup') {
      setPickupCoords(point);
      setPickup(p.label);
      if (!destPlace) setActivePoint('destination');
    } else {
      setDestPlace({ label: p.label, lat: p.lat, lng: p.lng });
      setDestinationBox(p.label);
    }
  };

  const locateCoords = async (): Promise<{ lat: number; lng: number } | null> => {
    try {
      const { latitude, longitude } = await getCurrentCoords();
      const point = { lat: latitude, lng: longitude };
      setPickupCoords(point);
      setHere(point);
      return point;
    } catch {
      return null;
    }
  };

  const locate = async () => {
    setLocating(true);
    try {
      const { latitude, longitude } = await getCurrentCoords();
      setPickupCoords({ lat: latitude, lng: longitude });
      setHere({ lat: latitude, lng: longitude });
      const res = await fetch(apiUrl(`/api/vehicles/places/reverse?lat=${latitude}&lng=${longitude}`), { headers: authHeaders() });
      const data = await res.json().catch(() => null);
      setPickup(data?.label || `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`);
      setLocateFailed(false);
    } catch {
      // Location unavailable (common on desktop browsers) — pickup can be typed or set on the map.
      setLocateFailed(true);
    } finally {
      setLocating(false);
    }
  };

  useEffect(() => {
    // Projects: the phone's chip + suggestions, and the web map's Projects button.
    fetch(apiUrl('/api/vehicles/places/projects'), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setProjects(Array.isArray(rows) ? rows : []))
      .catch(() => setProjects([]));
    if (wideWeb) return;
    fetch(apiUrl('/api/vehicles/places/saved'), { headers: authHeaders() })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setSaved(Array.isArray(rows) ? rows : []))
      .catch(() => setSaved([]));
  }, [wideWeb]);

  useEffect(() => {
    if (!initial?.pickup_location) locate();
    fetch(apiUrl('/api/vehicles/places/recent'), { headers: authHeaders() })
      .then((r) => r.json())
      .then((rows) => setRecent(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Debounced place search while typing.
  useEffect(() => {
    if (skipSearchRef.current) {
      skipSearchRef.current = false;
      return;
    }
    const q = query.trim();
    if (q.length < 3) {
      setSuggestions([]);
      setSearchError(null);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      setSearching(true);
      try {
        const res = await fetch(apiUrl(`/api/vehicles/places/search?q=${encodeURIComponent(q)}`), {
          headers: authHeaders(),
          signal: controller.signal
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Place search failed.');
        setSuggestions(Array.isArray(data) ? data : []);
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

  const choose = (place: Place) => {
    if (wideWeb) {
      setDestPlace(place);
      setDestinationBox(place.label);
      setMessage(null);
      return;
    }
    if (!pickup.trim()) {
      setPendingDestination(place);
      setMessage('Set your pickup location on the map first.');
      setMapFor('pickup');
      return;
    }
    onDone({ pickup_location: pickup.trim(), destination: place.label, destination_lat: place.lat, destination_lng: place.lng });
  };

  const typing = query.trim().length >= 3 && !(wideWeb && destPlace && destPlace.label === query);

  // Web: confirm the pickup + destination picked in the panel or on the map.
  const continueWeb = () => {
    const dest = destPlace && destPlace.label === query ? destPlace : query.trim() ? { label: query.trim(), lat: null, lng: null } : null;
    if (!pickup.trim()) {
      setActivePoint('pickup');
      setMessage('Set your pickup location — type it or click the map.');
      return;
    }
    if (!dest) {
      setActivePoint('destination');
      destinationRef.current?.focus();
      setMessage('Choose where you are going — search, or click the map.');
      return;
    }
    onDone({
      pickup_location: pickup.trim(),
      destination: dest.label,
      destination_lat: dest.lat,
      destination_lng: dest.lng,
      pickup_lat: pickupCoords?.lat ?? null,
      pickup_lng: pickupCoords?.lng ?? null
    });
  };

  const mapPicker = mapFor && (
    <RideMapPicker
      key={mapFor}
      title={mapFor === 'pickup' ? 'Choose pickup location' : 'Choose destination'}
      point={mapFor}
      start={pickupCoords}
      openWith={mapOpenWith}
      onLocateMe={locateCoords}
      onCancel={() => {
        setMapFor(null);
        setMapOpenWith(undefined);
        setPendingDestination(null);
      }}
      onConfirm={(place) => {
        setMapFor(null);
        setMapOpenWith(undefined);
        if (mapFor === 'pickup') {
          setPickup(place.label);
          setPickupCoords({ lat: place.lat, lng: place.lng });
          setMessage(null);
          if (pendingDestination) {
            const dest = pendingDestination;
            setPendingDestination(null);
            onDone({ pickup_location: place.label, destination: dest.label, destination_lat: dest.lat, destination_lng: dest.lng });
          }
          return;
        }
        choose(place);
      }}
    />
  );

  if (!wideWeb) {
    const home = saved.find((p) => p.kind === 'home');
    const work = saved.find((p) => p.kind === 'work');
    const q = query.trim();
    const ql = q.toLowerCase();
    const showSuggestions = destFocused && q.length > 0;
    const projectHits = q.length >= 2 ? projects.filter((p) => p.label.toLowerCase().includes(ql) || String(p.detail || '').toLowerCase().includes(ql)).slice(0, 3) : [];
    const splitLabel = (label: string) => {
      const i = label.indexOf(',');
      return i > 0 ? [label.slice(0, i), label.slice(i + 1).trim()] : [label, ''];
    };
    const row = (key: string, icon: React.ReactNode, title: string, sub: string, onClick: () => void) => (
      <button key={key} type="button" onMouseDown={(e) => e.preventDefault()} onClick={onClick} className="w-full flex items-center gap-3 px-1.5 py-2.5 text-left rounded-xl hover:bg-[var(--g-accent-soft)]/60 transition-colors">
        <span className="w-9 h-9 rounded-xl bg-[var(--g-accent-soft)] flex items-center justify-center shrink-0">{icon}</span>
        <span className="min-w-0 flex-1">
          <span className="block text-[14.5px] font-semibold text-slate-900 truncate">{title}</span>
          {sub && <span className="block text-[11.5px] text-slate-500 truncate">{sub}</span>}
        </span>
      </button>
    );
    const chip = (key: string, icon: React.ReactNode, text: string, onClick: () => void) => (
      <button key={key} type="button" onClick={onClick} className="shrink-0 inline-flex items-center gap-1.5 rounded-full bg-white px-3 py-2 text-[12.5px] font-bold text-[color:var(--g-accent-700)] shadow-[0_2px_8px_rgba(91,33,182,0.08)]">
        {icon} {text}
      </button>
    );
    const pickSaved = (p: SavedPlace) => choose({ label: savedLabel(p), lat: p.lat, lng: p.lng });
    const iconCls = 'w-4 h-4 text-[color:var(--g-accent)]';
    return (
      <div className="max-w-xl">
        {/* Route card: pickup (green dot) → destination (violet square). */}
        <div className="relative rounded-[22px] bg-white px-3.5 py-1 shadow-[0_6px_20px_rgba(91,33,182,0.10)]">
          <span className="absolute left-[19px] top-[34px] h-[34px] border-l-2 border-dotted border-violet-300" aria-hidden="true" />
          <div className="flex items-center gap-3 py-2.5">
            <span className="w-3 h-3 rounded-full bg-emerald-500 ring-4 ring-emerald-100 shrink-0" />
            <button type="button" onClick={() => setMapFor('pickup')} className="min-w-0 flex-1 text-left" aria-label="Change pickup">
              <span className="block text-[10.5px] font-bold tracking-wide text-slate-400">{pickupCoords && here && pickupCoords.lat === here.lat && pickupCoords.lng === here.lng ? 'PICKUP · YOUR LOCATION' : 'PICKUP'}</span>
              <span className={`block truncate text-[15px] font-semibold ${pickup ? 'text-slate-900' : 'text-slate-400 font-normal'}`}>{pickup || (locating ? 'Finding your location…' : 'Set pickup')}</span>
            </button>
            <button type="button" onClick={locate} title="Use my current location" aria-label="Use my current location" className="p-1.5 rounded-full text-[color:var(--g-accent)] hover:bg-[var(--g-accent-soft)]">
              {locating ? <Spinner size={16} /> : <LocateFixed className="w-[18px] h-[18px]" />}
            </button>
          </div>
          <div className="ml-6 h-px bg-slate-100" />
          <div className={`flex items-center gap-3 my-1.5 -mx-1.5 px-1.5 py-2 rounded-[14px] border-[1.5px] ${destFocused ? 'border-[var(--g-accent)]' : 'border-transparent'}`} onClick={() => destinationRef.current?.focus()}>
            <span className="w-3 h-3 rounded-[3px] bg-[var(--g-accent)] ring-4 ring-violet-100 shrink-0" />
            <div className="min-w-0 flex-1">
              <span className={`block text-[10.5px] font-bold tracking-wide ${destFocused ? 'text-[color:var(--g-accent)]' : 'text-slate-400'}`}>DESTINATION</span>
              <input
                ref={destinationRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setMessage(null);
                }}
                onFocus={() => setDestFocused(true)}
                onBlur={() => setDestFocused(false)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && q) {
                    e.preventDefault();
                    choose(suggestions[0] || { label: q, lat: null, lng: null });
                  }
                }}
                placeholder="Where are you going?"
                aria-label="Destination"
                className="w-full bg-transparent text-[15px] font-semibold text-slate-900 placeholder:font-normal placeholder:text-slate-400 focus:outline-none"
              />
            </div>
            {query && (
              <button type="button" onMouseDown={(e) => e.preventDefault()} onClick={() => setQuery('')} className="p-1 text-slate-400 hover:text-slate-600" aria-label="Clear destination">
                <X className="w-4 h-4" />
              </button>
            )}
          </div>
        </div>

        {message && <div className="mt-2 px-1 text-xs text-red-600">{message}</div>}
        {!message && locateFailed && !pickup.trim() && (
          <div className="mt-2 px-1 text-xs text-amber-600">
            Couldn't get your current location.{' '}
            <button type="button" onClick={() => setMapFor('pickup')} className="font-semibold underline">
              Set the pickup on the map
            </button>
            .
          </div>
        )}

        {showSuggestions ? (
          <div className="mt-4">
            <div className="text-[12px] font-bold tracking-wide text-slate-500 px-1.5 mb-1">{searching ? 'SEARCHING…' : 'SUGGESTIONS'}</div>
            {suggestions.map((p, i) => row(`s${i}`, <MapPin className={iconCls} />, p.label, p.detail || '', () => choose(p)))}
            {projectHits.map((p) =>
              row(`p${p.id}`, <Building2 className={iconCls} />, p.label, ['Project', p.detail].filter(Boolean).join(' · '), () => choose({ label: p.label, lat: p.lat, lng: p.lng }))
            )}
            {q.length >= 3 && !searching && suggestions.length === 0 && projectHits.length === 0 && (
              <div className="px-1.5 py-2 text-sm text-slate-400">{searchError || 'No matching place in the list.'}</div>
            )}
            {row('typed', <PencilLine className={iconCls} />, `Use “${q}” as typed`, "If it isn't in the list", () => choose({ label: q, lat: null, lng: null }))}
            {row('map', <MapIcon className={iconCls} />, 'Choose on map', 'Drop the pin yourself', () => setMapFor('destination'))}
          </div>
        ) : (
          <>
            <div className="mt-3.5 flex gap-2 overflow-x-auto pb-1 [scrollbar-width:none]">
              {home && chip('home', <Home className={iconCls} />, 'Home', () => pickSaved(home))}
              {work && chip('work', <Briefcase className={iconCls} />, 'Work', () => pickSaved(work))}
              {chip('projects', <Building2 className={iconCls} />, 'Projects', () => {
                setMapOpenWith('projects');
                setMapFor('destination');
              })}
              {chip('map', <MapIcon className={iconCls} />, 'Map', () => setMapFor('destination'))}
            </div>
            <div className="mt-3">
              <div className="text-[12px] font-bold tracking-wide text-slate-500 px-1.5 mb-1">RECENT</div>
              {(allRecent ? recent : recent.slice(0, 3)).map((p, i) => {
                const [title, sub] = splitLabel(p.label);
                return row(`r${i}`, <History className={iconCls} />, title, sub, () => choose(p));
              })}
              {recent.length === 0 && <div className="px-1.5 py-2 text-sm text-slate-400">No recent destinations yet.</div>}
              {recent.length > 3 && (
                <button type="button" onClick={() => setAllRecent((v) => !v)} className="px-1.5 py-2 text-[13px] font-bold text-[color:var(--g-accent)]">
                  {allRecent ? 'Show less' : 'See all recent'}
                </button>
              )}
            </div>
          </>
        )}
        {mapPicker}
      </div>
    );
  }

  return (
    <div className={wideWeb ? 'grid grid-cols-[minmax(0,1fr)_400px] gap-5 items-start' : 'max-w-xl'}>
      {wideWeb && (
        <RideBookingMap
          className="h-[calc(100vh-230px)] min-h-[480px] !rounded-[28px] !border-white/80 shadow-[0_18px_40px_-24px_rgba(85,0,170,0.45)]"
          here={here}
          pickup={pickupCoords}
          destination={destPlace && destPlace.lat != null && destPlace.lng != null ? { lat: destPlace.lat, lng: destPlace.lng } : null}
          active={activePoint}
          onPick={pickOnMap}
          onLocateMe={locate}
          projects={projects}
          onPickProject={pickProject}
        />
      )}
      <div className={wideWeb ? `${RIDE_CARD} p-5 lg:max-h-[calc(100vh-230px)] lg:overflow-y-auto` : `p-3 ${GLASS_CARD}`}>
      {wideWeb && (
        <div className="flex items-center gap-2.5 mb-4">
          <span className="w-9 h-9 rounded-xl bg-[var(--g-accent-soft)] flex items-center justify-center">
            <MapPin className="w-5 h-5 text-[color:var(--g-accent)]" />
          </span>
          <div>
            <div className="text-base font-bold text-slate-900 leading-tight">Where are you going?</div>
            <div className="text-xs text-slate-500">Search a place, or click the map</div>
          </div>
        </div>
      )}
      <div className={`rounded-2xl border p-2 space-y-2 ${wideWeb ? 'bg-[var(--g-accent-soft)]/60 border-[var(--g-accent-100)]' : 'bg-white/50 border-white/70'}`}>
        <div className="flex items-center gap-3 px-3 py-2.5">
          <Armchair className="w-5 h-5 text-[color:var(--g-accent)] shrink-0" />
          <input
            value={pickup}
            onChange={(e) => {
              setPickup(e.target.value);
              setPickupCoords(null);
            }}
            onFocus={() => setActivePoint('pickup')}
            placeholder={locating ? 'Finding your location…' : 'Pickup location'}
            className="flex-1 min-w-0 bg-transparent text-sm font-medium text-slate-800 placeholder:text-slate-400 focus:outline-none"
          />
          <button type="button" onClick={() => (wideWeb ? setActivePoint('pickup') : setMapFor('pickup'))} title="Set pickup on map" className="p-1.5 rounded-full text-slate-500 hover:text-[color:var(--g-accent)] hover:bg-white">
            <MapPinned className="w-4 h-4" />
          </button>
          <button type="button" onClick={locate} title="Use my current location" className="p-1.5 rounded-full text-slate-500 hover:text-[color:var(--g-accent)] hover:bg-white">
            {locating ? <Spinner size={16} /> : <LocateFixed className="w-4 h-4" />}
          </button>
        </div>
        <div className="flex items-center gap-3 px-3 py-3 bg-white border border-slate-200 rounded-xl shadow-sm focus-within:border-[var(--g-accent-400)] focus-within:ring-2 focus-within:ring-[var(--g-accent-200)]">
          <MapPin className="w-5 h-5 text-rose-500 shrink-0" />
          <input
            ref={destinationRef}
            autoFocus
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setDestPlace(null);
              setMessage(null);
            }}
            onFocus={() => setActivePoint('destination')}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && query.trim()) {
                e.preventDefault();
                choose(suggestions[0] || { label: query.trim(), lat: null, lng: null });
              }
            }}
            placeholder="Where are you going?"
            className="flex-1 min-w-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none"
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setDestPlace(null);
              }}
              className="p-1 text-slate-400 hover:text-slate-600">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
      </div>

      {message && <div className="mt-2 text-xs text-red-600">{message}</div>}
      {!message && locateFailed && !pickup.trim() && (
        <div className="mt-2 text-xs text-amber-600">
          Couldn't get your current location. Type the pickup or{' '}
          <button type="button" onClick={() => (wideWeb ? setActivePoint('pickup') : setMapFor('pickup'))} className="font-semibold underline">
            set it on the map
          </button>
          .
        </div>
      )}

      <div className="mt-4">
        <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 px-1 mb-1">
          {typing ? (searching ? 'Searching…' : 'Suggestions') : 'Recent'}
        </div>
        <div className="divide-y divide-slate-100">
          {(typing ? suggestions : recent).map((place, i) => (
            <button
              key={`${place.label}-${i}`}
              type="button"
              onClick={() => choose(place)}
              className="w-full flex items-center gap-3 px-1.5 py-2.5 text-left hover:bg-[var(--g-accent-soft)]/60 rounded-xl transition-colors"
            >
              <span className="w-9 h-9 rounded-full bg-[var(--g-accent-soft)] flex items-center justify-center shrink-0">
                {typing ? <Search className="w-4 h-4 text-[color:var(--g-accent)]" /> : <History className="w-4 h-4 text-[color:var(--g-accent)]" />}
              </span>
              <span className="min-w-0">
                <span className="block text-sm text-slate-800 truncate">{place.label}</span>
                {place.detail && <span className="block text-[11px] text-slate-400 truncate">{place.detail}</span>}
              </span>
            </button>
          ))}
          {!typing && recent.length === 0 && <div className="px-1 py-3 text-sm text-slate-400">No recent destinations yet.</div>}
          {typing && !searching && suggestions.length === 0 && (
            <div className="px-1 py-3 text-sm text-slate-400">{searchError || 'No matching places found.'}</div>
          )}
        </div>
      </div>

      {wideWeb ? (
        <button
          type="button"
          onClick={continueWeb}
          className="liquid-glass-button rounded-full mt-4 w-full flex items-center justify-center gap-2 py-3 text-sm font-semibold"
        >
          Continue <ArrowRight className="w-4 h-4" />
        </button>
      ) : (
      <div className={`mt-4 grid grid-cols-2 rounded-xl border divide-x overflow-hidden ${wideWeb ? 'border-slate-200 divide-slate-200' : 'border-white/70 divide-white/70 bg-white/60'}`}>
        <button
          type="button"
          onClick={() => {
            if (!query.trim()) {
              destinationRef.current?.focus();
              setMessage('Type the destination address first.');
              return;
            }
            choose({ label: query.trim(), lat: null, lng: null });
          }}
          className="flex items-center justify-center gap-2 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <PencilLine className="w-4 h-4" /> Use as typed
        </button>
        <button
          type="button"
          onClick={() => setMapFor('destination')}
          className="flex items-center justify-center gap-2 py-3 text-sm font-medium text-slate-700 hover:bg-slate-50"
        >
          <MapPinned className="w-4 h-4 text-rose-500" /> Set On Map
        </button>
      </div>
      )}
      </div>

      {mapPicker}
    </div>
  );
}
