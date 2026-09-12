/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { Route, LogIn, LogOut, CheckCircle2, AlertTriangle, MapPin } from 'lucide-react';
import { ClaimRecord } from '../types';
import { apiUrl } from '../lib/api';
import ClaimMapConfirm from './ClaimMapConfirm';
import { Spinner } from './Spinner';

interface ClaimCardProps {
  token: string;
  // Fires after a successful Check In OR Check Out (not on error) — lets a
  // parent showing this form inside a sheet/modal (e.g. the Movement Claim
  // page's "Add Check In/Out" button) know to refresh its own list of past
  // claims. Receives which action just completed: on 'in' the sheet is left
  // open (the user may still want to Check Out right after Checking In, in
  // the same sheet); on 'out' the claim is finished — the caller is expected
  // to close its own sheet then, since there's nothing left to do here.
  onSuccess?: (kind: 'in' | 'out') => void;
}

// Same geolocation flow AttendanceCard.tsx / AuthScreen.tsx already use:
// Capacitor's plugin on the native Android app build, plain
// navigator.geolocation on the web build.
async function getCurrentCoords(): Promise<{ latitude: number; longitude: number }> {
  if (Capacitor.isNativePlatform()) {
    let status: string;
    try {
      status = (await Geolocation.checkPermissions()).location;
    } catch {
      status = 'prompt';
    }
    if (status !== 'granted') {
      try {
        status = (await Geolocation.requestPermissions()).location;
      } catch {
        throw new Error('Location permission is required for a Movement Claim. Please allow location access and try again.');
      }
    }
    if (status !== 'granted') {
      throw new Error('Location permission is required for a Movement Claim. Please allow location access and try again.');
    }
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  }

  return new Promise((resolve, reject) => {
    if (!navigator.geolocation) {
      reject(new Error("This browser can't access your location."));
      return;
    }
    navigator.geolocation.getCurrentPosition(
      (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
      () => reject(new Error("Couldn't get your location. Please allow location access and try again.")),
      { enableHighAccuracy: true, timeout: 15000 }
    );
  });
}

// "Movement Claim" — free-form point A -> point B travel record for office work
// (client visits, bank runs, site trips, etc.), separate from the fixed-site
// Remote Attendance above it. A User types WHY/WHERE they're going, Checks In
// from their current spot, and later Checks Out once they reach/finish — the
// straight-line distance travelled is then available to the Admin for TA/DA-style
// reimbursement review. Shown near the top of the User Panel, same as Attendance.
export const ClaimCard: React.FC<ClaimCardProps> = ({ token, onSuccess }) => {
  const [purpose, setPurpose] = useState('');
  const [openClaim, setOpenClaim] = useState<ClaimRecord | null>(null);
  // The most recently completed claim (if any), kept around purely so its
  // check-out Approval Workflow badge stays visible after checking out —
  // otherwise openClaim goes straight to null and the badge never renders.
  const [lastCompletedClaim, setLastCompletedClaim] = useState<ClaimRecord | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  // 'in'/'out' while getting the GPS fix (before the map even opens); the map
  // confirm modal has its own separate 'submitting' flag for the actual POST.
  const [working, setWorking] = useState<'in' | 'out' | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Set once a GPS fix comes back for a Check In/Out tap — this is what opens
  // the map confirm modal. Cleared (without ever hitting the API) if the user
  // cancels there instead of confirming.
  const [pending, setPending] = useState<{ kind: 'in' | 'out'; coords: { latitude: number; longitude: number } } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const fetchStatus = async () => {
    setLoadingStatus(true);
    try {
      const res = await fetch(apiUrl('/api/claims/status'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = await res.json();
        setOpenClaim(data || null);
        if (data?.purpose) setPurpose(data.purpose);
      }
    } catch {
      // Offline or server unreachable — leave status as-is, the buttons still work.
    } finally {
      setLoadingStatus(false);
    }
  };

  useEffect(() => {
    fetchStatus();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Step 1: get a GPS fix and open the map confirm modal — nothing is sent to
  // the server yet.
  const handleMark = async (kind: 'in' | 'out') => {
    if (kind === 'in' && !purpose.trim()) {
      setMessage({ type: 'error', text: 'Please describe where/why you\u2019re going first.' });
      return;
    }
    setWorking(kind);
    setMessage(null);
    try {
      const coords = await getCurrentCoords();
      setPending({ kind, coords });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || `Failed to check ${kind}` });
    } finally {
      setWorking(null);
    }
  };

  // Step 2: the user tapped Confirm on the map modal — this is the actual
  // check-in/check-out API call, still using the exact coords already shown
  // on the map (no second GPS read).
  const handleConfirmPending = async (remarks: string) => {
    if (!pending) return;
    const { kind, coords } = pending;
    setSubmitting(true);
    setMessage(null);
    try {
      const url = kind === 'in' ? '/api/claims/check-in' : `/api/claims/${openClaim?.id}/check-out`;
      const body =
        kind === 'in'
          ? { purpose: purpose.trim(), latitude: coords.latitude, longitude: coords.longitude, remarks: remarks || undefined }
          : { latitude: coords.latitude, longitude: coords.longitude, remarks: remarks || undefined };

      const res = await fetch(apiUrl(url), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to check ${kind}`);
      setMessage({
        type: 'success',
        text: kind === 'in' ? 'Checked in — have a safe trip!' : `Checked out — ${data.distance_km} km travelled.`
      });
      setPending(null);
      if (kind === 'in') setLastCompletedClaim(null);
      if (kind === 'out') {
        setPurpose('');
        try {
          const mineRes = await fetch(apiUrl('/api/claims/mine'), { headers: { Authorization: `Bearer ${token}` } });
          if (mineRes.ok) {
            const mine = await mineRes.json();
            setLastCompletedClaim(mine[0] || null);
          }
        } catch {
          // Non-critical — the success message above already confirms the check-out.
        }
      }
      await fetchStatus();
      onSuccess?.(kind);
    } catch (err: any) {
      // Leave the map open so the user can see the error and back out instead
      // of losing their place.
      setMessage({ type: 'error', text: err.message || `Failed to check ${kind}` });
    } finally {
      setSubmitting(false);
    }
  };

  const hasOpenClaim = !!openClaim;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-0.5">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
          <Route className="w-4 h-4 text-indigo-600" /> Movement Claim
        </h3>
      </div>
      <p className="text-xs text-slate-500 mb-2.5">
        Going out for office work? Check in from where you start and check out once you reach or finish — your
        travel distance is recorded for claim review. See your past claims and their locations on the
        <span className="font-semibold text-slate-600"> My Claims</span> card below.
      </p>

      <div className="flex flex-col sm:flex-row sm:items-end gap-2">
        <div className="flex-1">
          <label className="block text-[10px] font-semibold text-slate-500 mb-1">
            Purpose / Where are you going
          </label>
          <input
            type="text"
            value={purpose}
            onChange={(e) => setPurpose(e.target.value)}
            disabled={hasOpenClaim}
            maxLength={255}
            placeholder="e.g. Bank visit — City Branch"
            className="w-full text-sm px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:outline-none disabled:opacity-70"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleMark('in')}
            disabled={!purpose.trim() || working !== null || !!pending || hasOpenClaim || loadingStatus}
            className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {working === 'in' ? <Spinner size={16} /> : <LogIn className="w-4 h-4" />}
            Check In
          </button>
          <button
            type="button"
            onClick={() => handleMark('out')}
            disabled={working !== null || !!pending || !hasOpenClaim || loadingStatus}
            className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            {working === 'out' ? <Spinner size={16} /> : <LogOut className="w-4 h-4" />}
            Check Out
          </button>
        </div>
      </div>

      {!loadingStatus && (
        <div className="mt-2 space-y-1 text-[11px] text-slate-500">
          <div className="flex flex-wrap items-center gap-2">
            <MapPin className="w-3 h-3" />
            {hasOpenClaim ? (
              <span className="text-emerald-700 font-medium">
                Checked in at {new Date(openClaim!.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} for
                &ldquo;{openClaim!.purpose}&rdquo; — not checked out yet.
              </span>
            ) : lastCompletedClaim ? (
              <span className="text-indigo-700 font-medium">
                Checked out of &ldquo;{lastCompletedClaim.purpose}&rdquo;
                {lastCompletedClaim.distance_km != null ? ` — ${lastCompletedClaim.distance_km} km travelled.` : '.'}
              </span>
            ) : (
              <span>No open claim right now — start one above when you head out.</span>
            )}
          </div>
          {openClaim?.check_in_remarks && (
            <div className="pl-5 text-slate-500">
              <span className="font-medium text-slate-600">Remarks:</span> {openClaim.check_in_remarks}
            </div>
          )}
        </div>
      )}

      {message && (
        <div
          className={`mt-2 flex items-center gap-2 text-xs px-3 py-2 rounded-xl ${
            message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {message.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
          <span>{message.text}</span>
        </div>
      )}

      {pending && (
        <ClaimMapConfirm
          kind={pending.kind}
          purpose={purpose.trim()}
          checkInCoords={
            pending.kind === 'out' && openClaim
              ? { latitude: Number(openClaim.check_in_lat), longitude: Number(openClaim.check_in_lng) }
              : null
          }
          coords={pending.coords}
          submitting={submitting}
          onCancel={() => {
            if (submitting) return;
            setPending(null);
          }}
          onConfirm={handleConfirmPending}
          onCoordsChange={(coords) => setPending((p) => (p ? { ...p, coords } : p))}
        />
      )}
    </div>
  );
};