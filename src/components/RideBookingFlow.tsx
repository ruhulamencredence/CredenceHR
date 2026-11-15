/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Book a Ride, the two steps — where from / to (RideDestinationPicker), then
// when and why — and the request it sends (POST /api/vehicles/requisitions).
// One piece, used in two places: Self Service -> Book a Ride
// (VehicleManagement.tsx) and the Dashboard's Book a Ride card, which opens
// it in a popup (BookRideCard.tsx). The server checks who may book, as
// before; this only holds the form.

import React, { useState } from 'react';
import { ArrowRight, Car } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { DurationPicker } from './DurationPicker';
import { RideBookingMap } from './RideBookingMap';
import { RideDestinationPicker, RidePlaces, GLASS_CARD } from './RideDestinationPicker';
import { RIDE_CARD, RIDE_WELL, RIDE_LABEL, RIDE_INPUT, BTN_PRIMARY, BTN_SOFT_SM, RideRoute, RideBanner } from './rideTheme';

const todayLocal = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

const emptyForm = () => ({
  purpose: '',
  pickup_location: '',
  destination: '',
  ride_date: todayLocal(),
  start_time: '',
  estimated_duration_hours: 1
});

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

interface RideBookingFlowProps {
  // Desktop web: the map beside the form (useWideWeb on the page).
  wide: boolean;
  // The "1 Route — 2 Ride details" steps above the form.
  showSteps: boolean;
  // After the request is saved (the form is already cleared).
  onSubmitted: () => void;
  // In a popup the map is shorter than on the page.
  inPopup?: boolean;
}

export function RideBookingFlow({ wide, showSteps, onSubmitted, inPopup = false }: RideBookingFlowProps) {
  const [form, setForm] = useState(emptyForm());
  // null = still on step 1 (where from / to).
  const [places, setPlaces] = useState<RidePlaces | null>(null);
  // Kept when "Change" goes back to step 1, so the picks aren't lost.
  const [lastPlaces, setLastPlaces] = useState<RidePlaces | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);

  async function submitRequisition(e: React.FormEvent) {
    e.preventDefault();
    setSubmitMessage(null);
    // Same rule the API applies: no booking for a time already gone.
    if (form.ride_date && form.start_time && new Date(`${form.ride_date}T${form.start_time}`).getTime() < Date.now() - 60 * 1000) {
      setSubmitMessage('The ride date and start time have already passed — pick a time from now on.');
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch(apiUrl('/api/vehicles/requisitions'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ ...form, ...places })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not submit request.');
      setSubmitMessage(null);
      setForm(emptyForm());
      setPlaces(null);
      setLastPlaces(null);
      onSubmitted();
    } catch (err: any) {
      setSubmitMessage(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  const mapClass = inPopup
    ? 'h-[min(62vh,560px)] min-h-[380px] !rounded-[28px] !border-white/80 shadow-[0_18px_40px_-24px_rgba(85,0,170,0.45)]'
    : 'h-[calc(100vh-230px)] min-h-[480px] !rounded-[28px] !border-white/80 shadow-[0_18px_40px_-24px_rgba(85,0,170,0.45)]';

  return (
    <>
      {showSteps && (
        <div className="flex items-center gap-2 mb-3 text-xs font-semibold">
          {[
            ['1', 'Route', true],
            ['2', 'Ride details', !!places]
          ].map(([n, label, on], i) => (
            <React.Fragment key={String(n)}>
              {i > 0 && <span className={`h-px w-8 ${on ? 'bg-[var(--g-accent-300)]' : 'bg-slate-300'}`} />}
              <span className={`inline-flex items-center gap-1.5 ${on ? 'text-[color:var(--g-accent-700)]' : 'text-slate-400'}`}>
                <span
                  className={`w-5 h-5 rounded-full inline-flex items-center justify-center text-[10px] ${
                    on ? 'bg-[var(--g-accent)] text-white' : 'bg-slate-200 text-slate-500'
                  }`}
                >
                  {n}
                </span>
                {label}
              </span>
            </React.Fragment>
          ))}
        </div>
      )}

      {!places && (
        <>
          {submitMessage && (
            <div className="mb-3 max-w-xl">
              <RideBanner tone="success">{submitMessage}</RideBanner>
            </div>
          )}
          <RideDestinationPicker
            initial={lastPlaces}
            compact={inPopup}
            onDone={(picked) => {
              setPlaces(picked);
              setSubmitMessage(null);
            }}
          />
        </>
      )}

      {places && (
        <div className={wide ? 'grid grid-cols-[minmax(0,1fr)_400px] gap-5 items-start' : ''}>
          {wide && (
            <RideBookingMap
              here={null}
              pickup={places.pickup_lat != null && places.pickup_lng != null ? { lat: places.pickup_lat, lng: places.pickup_lng } : null}
              destination={places.destination_lat != null && places.destination_lng != null ? { lat: places.destination_lat, lng: places.destination_lng } : null}
              className={mapClass}
            />
          )}
          <form onSubmit={submitRequisition} className={`space-y-4 p-5 ${wide ? RIDE_CARD : `max-w-xl ${GLASS_CARD}`}`}>
            <div className="flex items-center gap-2.5">
              <span className="w-9 h-9 rounded-xl bg-[var(--g-accent-soft)] flex items-center justify-center">
                <Car className="w-5 h-5 text-[color:var(--g-accent)]" />
              </span>
              <div>
                <div className="text-base font-bold text-slate-900 leading-tight">Ride details</div>
                <div className="text-xs text-slate-500">When you need it and why</div>
              </div>
            </div>
            <div className={`p-3 flex items-start justify-between gap-3 ${RIDE_WELL}`}>
              <RideRoute from={places.pickup_location} to={places.destination} />
              <button
                type="button"
                onClick={() => {
                  setLastPlaces(places);
                  setPlaces(null);
                }}
                className={`${BTN_SOFT_SM} shrink-0`}
              >
                Change
              </button>
            </div>
            <div>
              <label className={RIDE_LABEL}>Purpose</label>
              <textarea
                required
                value={form.purpose}
                onChange={(e) => setForm({ ...form, purpose: e.target.value })}
                rows={2}
                placeholder="Why do you need the ride?"
                className={RIDE_INPUT}
              />
            </div>
            <div className={`grid gap-3 ${wide ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'}`}>
              <div>
                <label className={RIDE_LABEL}>Ride Date</label>
                <input required type="date" min={todayLocal()} value={form.ride_date} onChange={(e) => setForm({ ...form, ride_date: e.target.value })} className={RIDE_INPUT} />
              </div>
              <div>
                <label className={RIDE_LABEL}>Start Time</label>
                <input required type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} className={RIDE_INPUT} />
              </div>
              <div className={wide ? 'col-span-2' : 'col-span-2 sm:col-span-3'}>
                <label className={RIDE_LABEL}>Est. Duration</label>
                <DurationPicker value={form.estimated_duration_hours} onChange={(h) => setForm({ ...form, estimated_duration_hours: h })} className={RIDE_INPUT} />
              </div>
            </div>
            {submitMessage && <RideBanner tone="error">{submitMessage}</RideBanner>}
            <button type="submit" disabled={submitting} className={`${BTN_PRIMARY} w-full py-3`}>
              {submitting ? 'Submitting…' : 'Submit Request'} {!submitting && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>
        </div>
      )}
    </>
  );
}
