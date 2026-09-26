/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { UserCheck, Play, CheckCircle2, AlertTriangle, MapPin } from 'lucide-react';
import { Project, AttendanceRecord } from '../types';
import { apiUrl, dedupedFetchJson } from '../lib/api';
import AttendanceMapConfirm from './AttendanceMapConfirm';
import { ApprovalBadge } from './ApprovalBadge';
import { Spinner } from './Spinner';

interface AttendanceCardProps {
  token: string;
  projects: Project[];
  // True while the parent's own Project list fetch is still in flight — lets
  // this card render a skeleton in its usual spot immediately instead of
  // rendering nothing at all until that fetch resolves (which used to make
  // the whole card visibly pop in a moment after the rest of the Dashboard,
  // unlike every other card that's already in place on first paint).
  loading?: boolean;
}

// Splits a timestamp into its clock face ("08:58") and meridiem ("AM") so they
// can be styled at different sizes/weights, matching the In Time/Out Time tiles.
function formatTimeParts(iso: string): { time: string; meridiem: string } {
  const full = new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: true });
  const [time, meridiem] = full.split(' ');
  return { time, meridiem: meridiem || '' };
}

// Reuses the exact same geolocation flow AuthScreen.tsx / LocationMapPicker.tsx
// already use: Capacitor's plugin on the native Android app build (so it works
// without a browser permission prompt inside the WebView), plain
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
        throw new Error('Location permission is required to mark attendance. Please allow location access and try again.');
      }
    }
    if (status !== 'granted') {
      throw new Error('Location permission is required to mark attendance. Please allow location access and try again.');
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

// A User checks in/out for one of their assigned Projects — the server only
// accepts it if the device's reported coordinates fall inside that Project's
// location_radius circle. Shown near the top of the User Panel, always
// visible (not tied to the mobile Budget/Jobs/Entries tile menu) since
// marking attendance is a quick, separate daily action.
export const AttendanceCard: React.FC<AttendanceCardProps> = ({ token, projects, loading }) => {
  // backdrop-filter is real bug material on the Android system WebView, not
  // just an expensive nice-to-have: its GPU raster budget is much smaller
  // than desktop Chrome's, and every backdrop-blur layer on screen fights
  // for that same budget. That's why this could render blurred on one
  // reload and flat on the next — it's a hardware-dependent failure, not
  // something a JS-side repaint nudge can reliably force (confirmed: it
  // didn't). Cutting backdrop-blur for the native app build removes the
  // failure mode entirely instead of papering over it, and costs nothing
  // visually here — the inset highlight + gradient + border already do
  // the actual "glass" work (see the comment further down).
  const isNativeApp = Capacitor.isNativePlatform();
  const [projectId, setProjectId] = useState<string>('');
  const [status, setStatus] = useState<AttendanceRecord | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  // 'in'/'out' while getting the GPS fix (before the map even opens); the map
  // confirm modal has its own separate 'submitting' flag for the actual POST.
  const [working, setWorking] = useState<'in' | 'out' | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Set once a GPS fix comes back for a Check In/Out tap — this is what opens
  // the map confirm modal. Cleared (without ever hitting the API) if the user
  // cancels there instead of confirming.
  const [pending, setPending] = useState<{ kind: 'in' | 'out'; coords: { latitude: number; longitude: number } } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Default to the only project when there's just one, so most users never
  // have to touch the dropdown at all.
  useEffect(() => {
    if (!projectId && projects.length === 1) {
      setProjectId(String(projects[0].id));
    }
  }, [projects, projectId]);

  useEffect(() => {
    if (!projectId) {
      setStatus(null);
      return;
    }
    let cancelled = false;
    setLoadingStatus(true);
    setMessage(null);
    (async () => {
      try {
        // This card mounts twice on every Dashboard load (mobile + desktop
        // copies, see UserPanel.tsx) — dedupedFetchJson means only one of
        // the two actually hits the network.
        const row = await dedupedFetchJson(apiUrl(`/api/attendance/status?project_id=${projectId}`), token);
        if (!cancelled && row) setStatus(row);
      } catch {
        // Offline or server unreachable — leave status as-is, the buttons still work.
      } finally {
        if (!cancelled) setLoadingStatus(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projectId, token]);

  const selectedProject = projects.find((p) => String(p.id) === projectId) || null;
  const hasCheckedIn = !!status?.check_in_at;
  const hasCheckedOut = !!status?.check_out_at;

  // Step 1: get a GPS fix and open the map confirm modal — nothing is sent to
  // the server yet.
  const handleMark = async (kind: 'in' | 'out') => {
    if (!projectId) {
      setMessage({ type: 'error', text: 'Pick a project first.' });
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
      const res = await fetch(apiUrl(`/api/attendance/check-${kind}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          project_id: Number(projectId),
          latitude: coords.latitude,
          longitude: coords.longitude,
          remarks: remarks || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to check ${kind}`);
      setMessage({
        type: 'success',
        text: kind === 'in'
          ? `Checked in — ${data.distance_m}m from ${data.project_name}.`
          : `Checked out — ${data.distance_m}m from ${data.project_name}.`
      });
      setPending(null);
      // Refresh today's status.
      const statusRes = await fetch(apiUrl(`/api/attendance/status?project_id=${projectId}`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (statusRes.ok) setStatus(await statusRes.json());
    } catch (err: any) {
      // Leave the map open so the user can see why (e.g. outside the radius)
      // and back out instead of losing their place.
      setMessage({ type: 'error', text: err.message || `Failed to check ${kind}` });
    } finally {
      setSubmitting(false);
    }
  };

  // Still waiting on the parent's Project list fetch — show a skeleton in the
  // exact same spot/shape the real card renders in, instead of nothing, so
  // this card is already in place on first paint like every other Dashboard
  // card and only its data (not the card itself) shows up a beat later.
  if (loading && projects.length === 0) {
    return (
      <div className="relative rounded-[24px] overflow-hidden border border-white/70 p-3.5 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-blue-100/70 via-white/50 to-indigo-50/40 animate-pulse">
        <div className="h-4 w-32 bg-white/60 rounded-md mb-3" />
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl px-3 py-2 bg-white/70 border border-white/50 h-14" />
          <div className="rounded-xl px-3 py-2 bg-white/70 border border-white/50 h-14" />
        </div>
      </div>
    );
  }

  if (projects.length === 0) return null;

  const inParts = status?.check_in_at ? formatTimeParts(status.check_in_at as string) : null;
  const outParts = status?.check_out_at ? formatTimeParts(status.check_out_at as string) : null;
  const busy = working !== null || !!pending || loadingStatus;

  return (
    // Liquid glass on mobile, matching the rest of the mobile Dashboard's
    // cards; plain white from md up, because on the desktop Dashboard this
    // card sits in a grid beside plain-white ones (Today, This Month, My
    // Requests) and the tinted-glass treatment made that row read as three
    // unrelated designs pushed together.
    //
    // backdrop-blur-xl is close to invisible here anyway, since the page
    // background behind this card is a smooth, textureless gradient — the
    // inset highlight in the shadow below (a bright top edge, same trick the
    // floating action buttons use) is what mainly sells the frosted look on
    // this screen. Which is exactly why it's dropped outright on the native
    // app build below: it wasn't buying much visually, but it WAS a real bug
    // there — Android's WebView compositor could render it on one reload and
    // silently drop it on the next (a GPU-budget/driver issue, not something
    // fixable from JS — a repaint-nudge hack was tried and didn't hold up).
    //
    // Separately (see glass-mask-fix in index.css for the full story): this
    // card's own rounded gradient background was ALSO capable of losing
    // itself the same way on reload, blur or no blur — a much broader
    // Android/WebKit rounded-corner + translucent-background compositor bug,
    // not specific to backdrop-filter at all. glass-mask-fix below is the
    // actual fix for that.
    <div
      style={{ transform: 'translateZ(0)', WebkitTransform: 'translateZ(0)' }}
      className={`glass-mask-fix relative rounded-[24px] overflow-hidden border border-white/70 p-4 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15),inset_0_1px_0_rgba(255,255,255,0.7)] bg-gradient-to-br from-blue-200/80 via-white/40 to-indigo-100/60 hover:shadow-lg hover:border-white transition-all md:bg-white md:from-transparent md:via-transparent md:to-transparent md:border-slate-200 md:rounded-2xl md:shadow-sm md:hover:shadow-sm md:hover:border-slate-200 ${isNativeApp ? '' : 'backdrop-blur-xl md:backdrop-blur-none'}`}
    >
      {/* The inner tiles below (In Time/Out Time) keep their own bg-white/70
          — that opacity alone already reads as a distinct panel with or
          without blur, so backdrop-blur-lg is dropped for the native app
          right alongside the outer shell's, for the same reason. */}
      <h3 className="text-sm font-bold text-slate-900 mb-2 flex items-center gap-2 min-w-0">
        <UserCheck className="w-4 h-4 text-blue-600 shrink-0" />
        <span className="truncate">My Attendance</span>
        {selectedProject && (
          <span className="text-xs font-medium text-slate-500 truncate">— {selectedProject.project_name}</span>
        )}
      </h3>

      {projects.length > 1 && (
        <div className="mb-2">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className={`w-full text-sm px-3 py-2 bg-white/85 border border-white/60 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none ${isNativeApp ? '' : 'backdrop-blur'}`}
          >
            <option value="">Select a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-2">
        {/* In Time — just the time itself, no "via Office/GPS" source line;
            extra padding so the text doesn't crowd its rounded corners.
            bg-white/70 (not the flatter /40 this used to be) reads as its
            own distinct tile even where backdrop-blur-lg doesn't render
            (Android WebView — see the note above), while staying low
            enough to keep some translucency instead of a flat opaque box. */}
        <div className={`rounded-xl px-4 py-3 border ${isNativeApp ? '' : 'backdrop-blur-lg'} ${hasCheckedIn ? 'bg-blue-100/70 border-white/60' : 'bg-white/70 border-white/50'}`}>
          <div className="text-xs font-medium text-slate-500">In Time</div>
          {hasCheckedIn && inParts ? (
            <div className="mt-0.5 font-bold text-blue-700">
              <span className="text-base">{inParts.time}</span>{' '}
              <span className="text-[11px] align-middle">{inParts.meridiem}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => handleMark('in')}
              disabled={!projectId || busy}
              className="mt-0.5 flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {working === 'in' ? <Spinner size={14} /> : <Play className="w-3.5 h-3.5 fill-current" />}
              Set Now
            </button>
          )}
        </div>

        {/* Out Time — same "time only" + extra padding/blur treatment as
            In Time above. */}
        <div className={`rounded-xl px-4 py-3 border ${isNativeApp ? '' : 'backdrop-blur-lg'} ${hasCheckedOut ? 'bg-blue-100/70 border-white/60' : 'bg-white/70 border-white/50'}`}>
          <div className="text-xs font-medium text-slate-500">Out Time</div>
          {hasCheckedOut && outParts ? (
            <div className="mt-0.5 font-bold text-blue-700">
              <span className="text-base">{outParts.time}</span>{' '}
              <span className="text-[11px] align-middle">{outParts.meridiem}</span>
            </div>
          ) : (
            <button
              type="button"
              onClick={() => handleMark('out')}
              disabled={!projectId || busy || !hasCheckedIn}
              className="mt-0.5 flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {working === 'out' ? <Spinner size={14} /> : <Play className="w-3.5 h-3.5 fill-current" />}
              Set Now
            </button>
          )}
        </div>
      </div>

      {selectedProject && !loadingStatus && (
        <div className="mt-2 pt-2 border-t border-white/50 space-y-1 text-[11px] text-slate-500">
          <div className="flex flex-wrap items-center gap-2">
            <MapPin className="w-3 h-3" />
            {hasCheckedIn ? (
              <span>
                {status?.check_in_distance_m != null ? `${status.check_in_distance_m}m from site` : 'Checked in'}
              </span>
            ) : (
              <span>Not checked in today yet.</span>
            )}
            {hasCheckedIn && <ApprovalBadge approval={status?.check_in_approval} />}
            {hasCheckedOut && <ApprovalBadge approval={status?.check_out_approval} />}
          </div>
          {status?.check_in_remarks && (
            <div className="pl-5 text-slate-500">
              <span className="font-medium text-slate-600">In remarks:</span> {status.check_in_remarks}
            </div>
          )}
          {status?.check_out_remarks && (
            <div className="pl-5 text-slate-500">
              <span className="font-medium text-slate-600">Out remarks:</span> {status.check_out_remarks}
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

      {pending && selectedProject && (
        <AttendanceMapConfirm
          kind={pending.kind}
          project={selectedProject}
          coords={pending.coords}
          submitting={submitting}
          token={token}
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