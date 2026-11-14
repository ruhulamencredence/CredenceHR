/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useEffect, useState } from 'react';
import { useCachedState } from '../lib/screenCache';
import { Capacitor } from '@capacitor/core';
import { Geolocation } from '@capacitor/geolocation';
import { nativeAttendanceFix, MOCK_LOCATION_MESSAGE, type AttendanceFix } from '../lib/attendanceFix';
import { UserCheck, Play, CheckCircle2, AlertTriangle, MapPin } from 'lucide-react';
import { Project } from '../types';
import { apiUrl, dedupedFetchJson } from '../lib/api';
import { retryImport } from '../lib/chunkReload';
// The map (Leaflet) is fetched when Set Now opens it, not with the Home page.
const AttendanceMapConfirm = lazy(retryImport(() => import('./AttendanceMapConfirm')));
import { ApprovalBadge } from './ApprovalBadge';
import { Spinner } from './Spinner';
import { confirmDialog } from '../lib/confirmDialog';

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
async function getCurrentCoords(): Promise<AttendanceFix> {
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
    // The APK's own fix says whether it is fake GPS (mock location).
    const fix = await nativeAttendanceFix();
    if (fix) return fix;
    const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
    return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
  }

  if (!navigator.geolocation) {
    throw new Error("This browser can't access your location.");
  }
  // Browsers only give location to a secure page (https:// or localhost).
  if (typeof window !== 'undefined' && window.isSecureContext === false) {
    throw new Error('This page is not secure (http://), so the browser blocks location. Open the site with https:// and try again.');
  }
  const ask = (highAccuracy: boolean, timeout: number) =>
    new Promise<{ latitude: number; longitude: number }>((resolve, reject) => {
      navigator.geolocation.getCurrentPosition(
        (pos) => resolve({ latitude: pos.coords.latitude, longitude: pos.coords.longitude }),
        (err) => reject(err),
        { enableHighAccuracy: highAccuracy, timeout, maximumAge: 30000 }
      );
    });
  try {
    return await ask(true, 12000);
  } catch (first: any) {
    // A desktop often has no GPS: when the precise fix is slow or unavailable, take the Wi-Fi/network one.
    if (first?.code === 2 || first?.code === 3) {
      try {
        return await ask(false, 15000);
      } catch (second: any) {
        first = second;
      }
    }
    if (first?.code === 1) {
      throw new Error(
        "Location is blocked for this site in Chrome. Click the lock icon next to the web address, set Location to Allow, reload the page and try again. (Windows' own Location switch being on is not enough.)"
      );
    }
    if (first?.code === 2) {
      throw new Error("Chrome couldn't find your position. Turn on Windows Settings → Privacy & security → Location (and let Chrome use it), then try again.");
    }
    throw new Error('Getting your location took too long. Please try again.');
  }
}

// Straight-line distance in metres (same formula as the server's check).
function distanceMeters(lat1: number, lng1: number, lat2: number, lng2: number): number {
  const R = 6371000;
  const toRad = (v: number) => (v * Math.PI) / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// Today's In / Out as GET /api/attendance/day-status gives it: In is the
// day's first, Out the last punch after it (Remote at any Project, or the
// office device), each with where it was given.
interface DayStatus {
  check_in_at: string | null;
  // 'offsite': an approved off-site punch — the place is where it was really given.
  check_in_source: 'remote' | 'office' | 'offsite' | null;
  check_in_place: string | null;
  check_in_distance_m: number | null;
  check_in_remarks: string | null;
  check_in_approval: any;
  check_out_at: string | null;
  check_out_source: 'remote' | 'office' | 'offsite' | null;
  check_out_place: string | null;
  check_out_distance_m: number | null;
  check_out_remarks: string | null;
  check_out_approval: any;
  check_out_first_at: string | null;
  check_out_update_count: number;
  can_update_check_out: boolean;
  // Off-site In / Out given today, waiting for approval (counts once approved).
  pending_offsite?: { in_at: string | null; in_place: string | null; out_at: string | null; out_place: string | null } | null;
}

// "at Project X" / "Office device · Head Office" under a time.
// Web Dashboard: a faint clock face in the card's bottom-right corner,
// fading out to the left so the text stays clear. Its hands show the time
// now (moved once a minute). Colours from .att-clock in index.css (light and
// dark). Decorative only; hidden on phones, whose card has its own glass look.
const AttendanceClockBg: React.FC = () => {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const t = window.setInterval(() => setNow(new Date()), 60_000);
    return () => window.clearInterval(t);
  }, []);
  const min = now.getMinutes();
  const hourDeg = ((now.getHours() % 12) + min / 60) * 30;
  const minDeg = min * 6;
  return (
    <svg
      className="att-clock hidden md:block absolute inset-0 w-full h-full pointer-events-none -z-10"
      viewBox="0 0 342 231"
      preserveAspectRatio="xMaxYMax slice"
      aria-hidden="true"
      style={{ WebkitMaskImage: 'linear-gradient(90deg, transparent 25%, #000 75%)', maskImage: 'linear-gradient(90deg, transparent 25%, #000 75%)' }}
    >
      <g transform="translate(300,205) scale(.8)">
        <circle r="112" fill="var(--ac-face)" stroke="var(--ac-rim)" strokeWidth="2" />
        {Array.from({ length: 60 }, (_, i) => (
          <line key={i} x1="0" y1={i % 5 ? -96 : -90} x2="0" y2="-104" stroke="var(--ac-tick)" strokeWidth={i % 5 ? 1.5 : 3} transform={`rotate(${i * 6})`} />
        ))}
        <path d="M0 -104 A104 104 0 0 1 90 -52" stroke="var(--ac-accent)" strokeWidth="5" fill="none" strokeLinecap="round" opacity=".55" />
        <path d="M0 0 L0 -62" stroke="var(--ac-tick)" strokeWidth="6" strokeLinecap="round" transform={`rotate(${hourDeg})`} />
        <path d="M0 0 L0 -86" stroke="var(--ac-accent)" strokeWidth="3.5" strokeLinecap="round" transform={`rotate(${minDeg})`} />
        <circle r="7" fill="var(--ac-accent)" />
      </g>
    </svg>
  );
};

const placeLine = (source: string | null | undefined, place: string | null | undefined) => {
  const text =
    source === 'office' ? `Office device${place ? ` · ${place}` : ''}` : source === 'offsite' ? `Off-site · ${place || 'outside the project area'}` : place ? `at ${place}` : '';
  return text ? (
    <div className="mt-0.5 text-[10.5px] leading-tight text-slate-500 truncate" title={text}>
      {text}
    </div>
  ) : null;
};

// A User checks in/out for one of their assigned Projects — the server only
// accepts it if the device's reported coordinates fall inside that Project's
// location_radius circle. Shown near the top of the User Panel, always
// visible (not tied to the mobile Budget/Jobs/Entries tile menu) since
// marking attendance is a quick, separate daily action.
export const AttendanceCard: React.FC<AttendanceCardProps> = ({ token, projects, loading }) => {
  // Blur is on in the Android/iPhone app too (it used to be left out there
  // because some Android WebViews dropped it on reload); glass-mask-fix +
  // translateZ(0) on the shell keep the card itself from disappearing. The
  // blur is half the old strength (20px shell, 8px tiles), which is also
  // lighter on the WebView's GPU budget.
  // The Project of the tap being confirmed — picked from where you stand
  // (several check-in Projects) or the only one. Nothing to pick by hand.
  const [projectId, setProjectId] = useState<string>('');
  // Today's In / Out shown at once from this device's last copy (screenCache.ts,
  // keyed by the day so yesterday's never shows), then refreshed.
  const dayKey = `att-day:${new Date().toLocaleDateString('en-CA')}`;
  const [status, setStatus, statusFromCache] = useCachedState<DayStatus | null>(dayKey, null);
  const [loadingStatus, setLoadingStatus] = useState(false);
  // 'in'/'out' while getting the GPS fix (before the map even opens); the map
  // confirm modal has its own separate 'submitting' flag for the actual POST.
  const [working, setWorking] = useState<'in' | 'out' | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Set once a GPS fix comes back for a Check In/Out tap — this is what opens
  // the map confirm modal. Cleared (without ever hitting the API) if the user
  // cancels there instead of confirming.
  // `offsite`: outside every one of the account's own Projects — it goes for
  // approval and counts once approved (AttendanceRoutes.ts offsitePunch).
  const [pending, setPending] = useState<{ kind: 'in' | 'out'; coords: AttendanceFix; offsite?: boolean } | null>(null);
  const [submitting, setSubmitting] = useState(false);

  // Today's In / Out from every Project and the office device, each with the
  // place it was given (GET /api/attendance/day-status).
  const loadDay = async () => {
    const res = await fetch(apiUrl('/api/attendance/day-status'), { headers: { Authorization: `Bearer ${token}` } });
    if (res.ok) setStatus(await res.json());
  };
  useEffect(() => {
    if (!projects.length) return;
    let cancelled = false;
    if (!statusFromCache) setLoadingStatus(true);
    setMessage(null);
    (async () => {
      try {
        // This card mounts twice on every Dashboard load (mobile + desktop
        // copies, see UserPanel.tsx) — dedupedFetchJson means only one of
        // the two actually hits the network.
        const row = await dedupedFetchJson(apiUrl('/api/attendance/day-status'), token);
        if (!cancelled && row !== undefined) setStatus(row || null);
      } catch {
        // Offline or server unreachable — leave status as-is, the buttons still work.
      } finally {
        if (!cancelled) setLoadingStatus(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [projects.length, token]);

  const selectedProject = projects.find((p) => String(p.id) === projectId) || null;
  const waiting = status?.pending_offsite || null;
  const hasCheckedIn = !!status?.check_in_at || !!waiting?.in_at;

  // Late warning: this month's own Delay / Extreme Delay counts against the
  // Late Attendance Policy (same /api/my-attendance-summary figures the
  // This Month card and payroll use). When one more late would cost a day's
  // salary — e.g. 2 lates under "3 lates = 1 day" — a small rose badge in
  // the In Time tile's corner says so ("2/3 late"; the full sentence is its
  // tooltip).
  // Read again after each check-in, since that's what can add a late.
  const [lateSummary, setLateSummary] = useCachedState<{
    linked: boolean;
    late_count: number;
    extreme_late_count: number;
    policy: { lates_per_deduction_day: number; extreme_lates_per_deduction_day: number } | null;
  } | null>('att-late', null);
  useEffect(() => {
    let cancelled = false;
    dedupedFetchJson(apiUrl('/api/my-attendance-summary'), token).then((d) => {
      if (!cancelled) setLateSummary(d && d.linked ? d : null);
    });
    return () => {
      cancelled = true;
    };
  }, [token, status?.check_in_at]);

  const hasCheckedOut = !!status?.check_out_at;

  // Step 1: get a GPS fix and open the map confirm modal — nothing is sent to
  // the server yet.
  const handleMark = async (kind: 'in' | 'out') => {
    // The Project is the one whose area you're standing in — for the In and
    // for the Out alike (they may be different Projects). With one Project
    // it's simply that one (the server still checks the distance).
    setWorking(kind);
    setMessage(null);
    try {
      const coords = await getCurrentCoords();
      if (coords.mock) throw new Error(MOCK_LOCATION_MESSAGE);
      const placed = projects
        .filter((p) => p.location_lat != null && p.location_lng != null && p.location_radius)
        .map((p) => ({ p, d: distanceMeters(coords.latitude, coords.longitude, Number(p.location_lat), Number(p.location_lng)) }))
        .sort((a, b) => a.d - b.d);
      const inside = placed.filter((x) => x.d <= Number(x.p.location_radius));
      if (inside.length) {
        setProjectId(String(inside[0].p.id));
        setPending({ kind, coords });
      } else if (!placed.length) {
        // No Project with a location to measure against: as before, the
        // server says what's missing.
        setProjectId(String(projects[0].id));
        setPending({ kind, coords });
      } else {
        // Outside every own Project: it can still be given, for approval
        // (the map shows the nearest one).
        setProjectId(String(placed[0].p.id));
        setPending({ kind, coords, offsite: true });
      }
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
          remarks: remarks || undefined,
          // From the APK's own fix (lib/attendanceFix.ts); the server refuses a mock one.
          ...(coords.mock !== undefined ? { mock: coords.mock, accuracy_m: coords.accuracy ?? null } : {}),
          ...(pending.offsite ? { offsite: true } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to check ${kind}`);
      if (data.pending !== undefined) {
        setMessage({
          type: 'success',
          text: data.pending
            ? `Sent for approval — your ${kind === 'in' ? 'In' : 'Out'} Time counts once it's approved. ${data.place || ''}`
            : `Recorded — ${data.place || 'off-site'}.`
        });
        setPending(null);
        await loadDay();
        return;
      }
      setMessage({
        type: 'success',
        text: kind === 'in'
          ? `Checked in — ${data.distance_m}m from ${data.project_name}.`
          : data.updated
            ? `Out Time updated — ${data.distance_m}m from ${data.project_name}. It goes for approval again.`
            : `Checked out — ${data.distance_m}m from ${data.project_name}.`
      });
      setPending(null);
      // Refresh today's status.
      await loadDay();
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
      // Same shell as the real card below: tinted glass on mobile, plain
      // white card from md up (where it sits beside the other white cards).
      <div className="relative rounded-[24px] overflow-hidden border border-white/70 p-4 shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-blue-200/80 via-white/40 to-indigo-100/60 md:bg-white md:from-transparent md:via-transparent md:to-transparent md:border-slate-200 md:rounded-2xl md:shadow-sm animate-pulse">
        <div className="flex items-center gap-2 mb-3">
          <div className="w-4 h-4 rounded bg-white/70 md:bg-slate-200" />
          <div className="h-4 w-28 bg-white/70 md:bg-slate-200 rounded-md" />
        </div>
        <div className="h-9 rounded-xl bg-white/70 md:bg-slate-100 mb-2" />
        <div className="grid grid-cols-2 gap-2">
          <div className="rounded-xl bg-white/70 border border-white/50 md:bg-slate-50 md:border-slate-100 h-14" />
          <div className="rounded-xl bg-white/70 border border-white/50 md:bg-slate-50 md:border-slate-100 h-14" />
        </div>
      </div>
    );
  }

  if (projects.length === 0) return null;

  const inParts = status?.check_in_at ? formatTimeParts(status.check_in_at as string) : null;
  const outParts = status?.check_out_at ? formatTimeParts(status.check_out_at as string) : null;
  const busy = working !== null || !!pending || loadingStatus;

  const lateWarnings: { badge: string; text: string }[] = [];
  if (lateSummary?.policy) {
    const oneShort = (count: number, per: number) => per > 1 && count % per === per - 1;
    const per = Number(lateSummary.policy.lates_per_deduction_day) || 0;
    const xPer = Number(lateSummary.policy.extreme_lates_per_deduction_day) || 0;
    if (oneShort(Number(lateSummary.late_count) || 0, per)) {
      lateWarnings.push({
        badge: `${lateSummary.late_count}/${per} late`,
        text: `${lateSummary.late_count} Delay this month — 1 more and a day's salary will be deducted (${per} Delay = 1 day).`
      });
    }
    if (oneShort(Number(lateSummary.extreme_late_count) || 0, xPer)) {
      lateWarnings.push({
        badge: `${lateSummary.extreme_late_count}/${xPer} extreme`,
        text: `${lateSummary.extreme_late_count} Extreme Delay this month — 1 more and a day's salary will be deducted (${xPer} Extreme Delay = 1 day).`
      });
    }
  }

  return (
    // Liquid glass on mobile, matching the rest of the mobile Dashboard's
    // cards; plain white from md up, because on the desktop Dashboard this
    // card sits in a grid beside plain-white ones (Today, This Month, My
    // Requests) and the tinted-glass treatment made that row read as three
    // unrelated designs pushed together.
    //
    // Blur (20px) is on for the web and the app alike; the inset highlight in
    // the shadow below (a bright top edge, same trick the floating action
    // buttons use) does most of the frosted look on this smooth background.
    //
    // Separately (see glass-mask-fix in index.css for the full story): this
    // card's own rounded gradient background was ALSO capable of losing
    // itself the same way on reload, blur or no blur — a much broader
    // Android/WebKit rounded-corner + translucent-background compositor bug,
    // not specific to backdrop-filter at all. glass-mask-fix below is the
    // actual fix for that.
    <div
      style={{ transform: 'translateZ(0)', WebkitTransform: 'translateZ(0)' }}
      className={`glass-mask-fix att-card relative rounded-[28px] overflow-hidden border border-white/70 p-4 bg-[radial-gradient(90%_70%_at_100%_100%,rgba(var(--g-accent-rgb,127,0,255),0.12)_0%,rgba(var(--g-accent-rgb,127,0,255),0)_70%),radial-gradient(70%_60%_at_0%_100%,rgba(167,90,255,0.09)_0%,rgba(167,90,255,0)_70%),linear-gradient(to_bottom,rgba(255,255,255,1)_0%,rgba(255,255,255,1)_25%,rgba(255,255,255,0.1)_100%)] shadow-[0_16px_40px_-10px_rgba(var(--g-accent-rgb,127,0,255),0.45),inset_0_1px_0_rgba(255,255,255,0.8),inset_0_-18px_36px_-18px_rgba(var(--g-accent-rgb,127,0,255),0.2)] transition-all md:bg-none md:bg-white md:border-slate-200 md:rounded-2xl md:shadow-sm backdrop-blur-[20px] backdrop-saturate-150 md:backdrop-blur-none md:backdrop-saturate-100`}
    >
      <AttendanceClockBg />
      {/* The inner tiles below (In Time/Out Time) keep their own bg-white/70
          — that opacity alone reads as a distinct panel even where a
          WebView skips the blur — with a light 8px blur on top. */}
      <h3 className="text-sm font-bold text-slate-900 mb-2 flex items-center gap-2 min-w-0">
        <UserCheck className="w-4 h-4 text-blue-600 shrink-0" />
        <span className="truncate">My Attendance</span>
        {projects.length === 1 && <span className="text-xs font-medium text-slate-500 truncate">— {projects[0].project_name}</span>}
      </h3>

      <div className="grid grid-cols-2 gap-2">
        {/* In Time — just the time itself, no "via Office/GPS" source line;
            extra padding so the text doesn't crowd its rounded corners.
            bg-white/70 (not the flatter /40 this used to be) reads as its
            own distinct tile even where backdrop-blur-lg doesn't render
            (Android WebView — see the note above), while staying low
            enough to keep some translucency instead of a flat opaque box. */}
        <div className={`relative rounded-xl px-4 py-3 border backdrop-blur-[8px] ${hasCheckedIn ? 'bg-blue-100/70 border-white/60' : 'bg-white/70 border-white/50'}`}>
          {lateWarnings.length > 0 && (
            <div className="absolute top-2 right-2 flex flex-col items-end gap-1">
              {lateWarnings.map((w) => (
                <span key={w.badge} role="status" title={w.text} aria-label={w.text} className="px-1.5 py-px rounded-full bg-rose-500 text-white text-[10px] font-bold leading-4 whitespace-nowrap">
                  {w.badge}
                </span>
              ))}
            </div>
          )}
          <div className="text-xs font-medium text-slate-500">In Time</div>
          {hasCheckedIn && inParts ? (
            <>
              <div className="mt-0.5 font-bold text-blue-700">
                <span className="text-base">{inParts.time}</span>{' '}
                <span className="text-[11px] align-middle">{inParts.meridiem}</span>
              </div>
              {placeLine(status?.check_in_source, status?.check_in_place)}
            </>
          ) : waiting?.in_at ? (
            <>
              <div className="mt-0.5 font-bold text-amber-700">
                <span className="text-base">{formatTimeParts(waiting.in_at).time}</span>{' '}
                <span className="text-[11px] align-middle">{formatTimeParts(waiting.in_at).meridiem}</span>
              </div>
              <div className="mt-0.5 text-[10.5px] leading-tight text-amber-700 font-semibold">Waiting for approval</div>
            </>
          ) : (
            <button
              type="button"
              onClick={() => handleMark('in')}
              disabled={busy}
              className="mt-0.5 flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {working === 'in' ? <Spinner size={14} /> : <Play className="w-3.5 h-3.5 fill-current" />}
              Set Now
            </button>
          )}
        </div>

        {/* Out Time — same "time only" + extra padding/blur treatment as
            In Time above. */}
        <div className={`rounded-xl px-4 py-3 border backdrop-blur-[8px] ${hasCheckedOut ? 'bg-blue-100/70 border-white/60' : 'bg-white/70 border-white/50'}`}>
          <div className="text-xs font-medium text-slate-500">Out Time</div>
          {!hasCheckedOut && waiting?.out_at ? (
            <>
              <div className="mt-0.5 font-bold text-amber-700">
                <span className="text-base">{formatTimeParts(waiting.out_at).time}</span>{' '}
                <span className="text-[11px] align-middle">{formatTimeParts(waiting.out_at).meridiem}</span>
              </div>
              <div className="mt-0.5 text-[10.5px] leading-tight text-amber-700 font-semibold">Waiting for approval</div>
            </>
          ) : hasCheckedOut && outParts ? (
            <>
              <div className="mt-0.5 font-bold text-blue-700">
                <span className="text-base">{outParts.time}</span>{' '}
                <span className="text-[11px] align-middle">{outParts.meridiem}</span>
              </div>
              {placeLine(status?.check_out_source, status?.check_out_place)}
              {/* Gave it too early, or the office machine took a stray punch as
                  the Out? The same day it can be given again
                  (users.can_update_check_out — off unless ticked). */}
              {status?.can_update_check_out && (
                <button
                  type="button"
                  onClick={async () => {
                    const msg =
                      status?.check_out_source === 'office'
                        ? `Give your Out Time now? The office machine took ${outParts.time} ${outParts.meridiem} as your Out. That punch stays on record; the time you set now becomes your Out Time and goes for approval.`
                        : `Give your Out Time again? ${outParts.time} ${outParts.meridiem} is replaced by the time you set now, and it goes for approval again.`;
                    if (!(await confirmDialog(msg))) return;
                    void handleMark('out');
                  }}
                  disabled={busy}
                  className="mt-0.5 flex items-center gap-1 text-[11px] font-bold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {working === 'out' ? <Spinner size={12} /> : <Play className="w-3 h-3 fill-current" />}
                  Set again
                </button>
              )}
            </>
          ) : (
            <button
              type="button"
              onClick={() => handleMark('out')}
              disabled={busy || !hasCheckedIn}
              className="mt-0.5 flex items-center gap-1 text-xs font-bold text-blue-600 hover:text-blue-700 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
            >
              {working === 'out' ? <Spinner size={14} /> : <Play className="w-3.5 h-3.5 fill-current" />}
              Set Now
            </button>
          )}
        </div>
      </div>

      {!loadingStatus && (
        <div className="mt-2 pt-2 border-t border-white/50 space-y-1 text-[11px] text-slate-500">
          <div className="flex flex-wrap items-center gap-2">
            <MapPin className="w-3 h-3" />
            {status?.check_in_at ? (
              <span>
                {status?.check_in_source === 'offsite'
                  ? 'In: off-site (approved)'
                  : status?.check_in_distance_m != null
                  ? `In ${status.check_in_distance_m}m from site`
                  : 'Checked in'}
                {status?.check_out_distance_m != null && status?.check_out_source === 'remote' ? ` · Out ${status.check_out_distance_m}m` : ''}
              </span>
            ) : waiting ? null : (
              <span>Not checked in today yet.</span>
            )}
            {waiting && (
              <span className="text-amber-700">
                Off-site · {waiting.in_place || waiting.out_place} — counts once approved
              </span>
            )}
            {!!status?.check_in_at && <ApprovalBadge approval={status?.check_in_approval} />}
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
          {!!status?.check_out_update_count && status.check_out_first_at && (
            <div className="pl-5 text-slate-500">
              Out Time given again{status.check_out_update_count > 1 ? ` (${status.check_out_update_count} times)` : ''} — first was{' '}
              {formatTimeParts(status.check_out_first_at as string).time} {formatTimeParts(status.check_out_first_at as string).meridiem}
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
        <Suspense fallback={null}>
        <AttendanceMapConfirm
          kind={pending.kind}
          offsite={!!pending.offsite}
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
        </Suspense>
      )}
    </div>
  );
};