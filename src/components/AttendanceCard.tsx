/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { UserCheck, Play, CheckCircle2, AlertTriangle, MapPin } from 'lucide-react';
import { Project, AttendanceRecord } from '../types';
import { apiUrl } from '../lib/api';
import AttendanceMapConfirm from './AttendanceMapConfirm';
import { ApprovalBadge } from './ApprovalBadge';
import { Spinner } from './Spinner';

interface AttendanceCardProps {
  token: string;
  projects: Project[];
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
export const AttendanceCard: React.FC<AttendanceCardProps> = ({ token, projects }) => {
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
        const res = await fetch(apiUrl(`/api/attendance/status?project_id=${projectId}`), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!cancelled && res.ok) setStatus(await res.json());
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

  if (projects.length === 0) return null;

  const inParts = status?.check_in_at ? formatTimeParts(status.check_in_at as string) : null;
  const outParts = status?.check_out_at ? formatTimeParts(status.check_out_at as string) : null;
  const busy = working !== null || !!pending || loadingStatus;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
      <h3 className="text-sm font-bold text-slate-900 mb-3 flex items-center gap-2">
        <UserCheck className="w-4 h-4 text-blue-600" /> My Attendance
      </h3>

      {projects.length > 1 && (
        <div className="mb-3">
          <select
            value={projectId}
            onChange={(e) => setProjectId(e.target.value)}
            className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
          >
            <option value="">Select a project…</option>
            {projects.map((p) => (
              <option key={p.id} value={p.id}>{p.project_name}</option>
            ))}
          </select>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3">
        {/* In Time */}
        <div className={`rounded-xl px-4 py-3 ${hasCheckedIn ? 'bg-blue-50' : 'bg-slate-50'}`}>
          <div className="text-xs font-medium text-slate-500">In Time</div>
          {hasCheckedIn && inParts ? (
            <>
              <div className="mt-0.5 font-bold text-blue-700">
                <span className="text-lg">{inParts.time}</span>{' '}
                <span className="text-xs align-middle">{inParts.meridiem}</span>
              </div>
              {status?.check_in_source === 'office' && (
                <div className="mt-0.5 text-[10px] font-semibold text-sky-700">via Office Attendance</div>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => handleMark('in')}
              disabled={!projectId || busy}
              className="mt-1 flex items-center gap-1 text-sm font-bold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {working === 'in' ? <Spinner size={14} /> : <Play className="w-3.5 h-3.5 fill-current" />}
              Set Now
            </button>
          )}
        </div>

        {/* Out Time */}
        <div className={`rounded-xl px-4 py-3 ${hasCheckedOut ? 'bg-blue-50' : 'bg-slate-50'}`}>
          <div className="text-xs font-medium text-slate-500">Out Time</div>
          {hasCheckedOut && outParts ? (
            <>
              <div className="mt-0.5 font-bold text-blue-700">
                <span className="text-lg">{outParts.time}</span>{' '}
                <span className="text-xs align-middle">{outParts.meridiem}</span>
              </div>
              {status?.check_out_source === 'office' && (
                <div className="mt-0.5 text-[10px] font-semibold text-sky-700">via Office Attendance</div>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => handleMark('out')}
              disabled={!projectId || busy || !hasCheckedIn}
              className="mt-1 flex items-center gap-1 text-sm font-bold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {working === 'out' ? <Spinner size={14} /> : <Play className="w-3.5 h-3.5 fill-current" />}
              Set Now
            </button>
          )}
        </div>
      </div>

      {selectedProject && !loadingStatus && (
        <div className="mt-3 pt-3 border-t border-slate-100 space-y-1 text-[11px] text-slate-500">
          <div className="flex flex-wrap items-center gap-2">
            <MapPin className="w-3 h-3" />
            {hasCheckedIn ? (
              <span>
                {selectedProject.project_name}
                {status?.check_in_distance_m != null ? ` — ${status.check_in_distance_m}m from site` : ''}
              </span>
            ) : (
              <span>Not checked in for {selectedProject.project_name} today yet.</span>
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
          className={`mt-3 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl ${
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