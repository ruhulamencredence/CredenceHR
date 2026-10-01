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
// On a desktop web browser (useWideWeb) the panel sits beside a live map
// (RideBookingMap): clicking the map sets the pickup or the destination, and
// the user confirms with Continue instead of a pick jumping straight ahead.

import React, { useEffect, useRef, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Armchair, MapPin, MapPinned, History, Search, PencilLine, LocateFixed, X, ArrowRight } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { RideMapPicker } from './RideMapPicker';
import { RideBookingMap, RidePoint, RidePointKind } from './RideBookingMap';
import { useWideWeb } from '../lib/useWideWeb';

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

  return (
    <div className={wideWeb ? 'grid grid-cols-[minmax(0,1fr)_400px] gap-5 items-start' : 'max-w-xl'}>
      {wideWeb && (
        <RideBookingMap
          here={here}
          pickup={pickupCoords}
          destination={destPlace && destPlace.lat != null && destPlace.lng != null ? { lat: destPlace.lat, lng: destPlace.lng } : null}
          active={activePoint}
          onPick={pickOnMap}
          onLocateMe={locate}
          className="h-[calc(100vh-200px)] min-h-[480px]"
        />
      )}
      <div className={wideWeb ? 'bg-white rounded-2xl border border-slate-200 shadow-sm p-4 lg:max-h-[calc(100vh-200px)] lg:overflow-y-auto' : `p-3 ${GLASS_CARD}`}>
      {wideWeb && <div className="text-base font-bold text-slate-900 mb-3">Where are you going?</div>}
      <div className={`rounded-2xl border p-2 space-y-2 ${wideWeb ? 'bg-slate-50 border-slate-200' : 'bg-white/50 border-white/70'}`}>
        <div className="flex items-center gap-3 px-3 py-2.5">
          <Armchair className="w-5 h-5 text-slate-600 shrink-0" />
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
          <button type="button" onClick={() => (wideWeb ? setActivePoint('pickup') : setMapFor('pickup'))} title="Set pickup on map" className="p-1 text-slate-500 hover:text-blue-600">
            <MapPinned className="w-4 h-4" />
          </button>
          <button type="button" onClick={locate} title="Use my current location" className="p-1 text-slate-500 hover:text-blue-600">
            {locating ? <Spinner size={16} /> : <LocateFixed className="w-4 h-4" />}
          </button>
        </div>
        <div className="flex items-center gap-3 px-3 py-3 bg-white border border-slate-200 rounded-xl shadow-sm">
          <MapPin className="w-5 h-5 text-red-500 shrink-0" />
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
        <div className="text-xs font-semibold text-slate-500 px-1 mb-1">
          {typing ? (searching ? 'Searching…' : 'Suggestions') : 'Recent'}
        </div>
        <div className="divide-y divide-slate-100">
          {(typing ? suggestions : recent).map((place, i) => (
            <button
              key={`${place.label}-${i}`}
              type="button"
              onClick={() => choose(place)}
              className="w-full flex items-center gap-3 px-1 py-3 text-left hover:bg-slate-50 rounded-lg"
            >
              <span className="w-9 h-9 rounded-full bg-slate-100 flex items-center justify-center shrink-0">
                {typing ? <Search className="w-4 h-4 text-slate-500" /> : <History className="w-4 h-4 text-slate-500" />}
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
          className="mt-4 w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-blue-600 text-white text-sm font-semibold hover:bg-blue-700"
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
          <MapPinned className="w-4 h-4 text-red-500" /> Set On Map
        </button>
      </div>
      )}
      </div>

      {mapFor && (
        <RideMapPicker
          key={mapFor}
          title={mapFor === 'pickup' ? 'Choose pickup location' : 'Choose destination'}
          start={pickupCoords}
          onLocateMe={locateCoords}
          onCancel={() => {
            setMapFor(null);
            setPendingDestination(null);
          }}
          onConfirm={(place) => {
            setMapFor(null);
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
      )}
    </div>
  );
}
