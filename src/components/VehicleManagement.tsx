/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> "Book a Ride" — self-service tab for the logged-in
// account: request a vehicle (Book a Ride) and track where each request
// stands (Ride Status), including reporting the ride complete and asking
// for a time extension if running late. Talks to VehicleManagementRoutes.ts
// (server.ts registers it via registerVehicleManagementRoutes). Mirrors the
// read/write split and fetch-with-Bearer-token pattern AssetManagement.tsx
// already uses.

import React, { useEffect, useRef, useState } from 'react';
import { apiUrl } from '../lib/api';
import { LiveRideMap } from './LiveRideMap';
import { RideDetails } from './RideDetails';
import { RideBookingMap } from './RideBookingMap';
import { useWideWeb } from '../lib/useWideWeb';
import { takeQuickAccessTab } from '../lib/quickAccess';
import { RideDestinationPicker, RidePlaces, GLASS_CARD } from './RideDestinationPicker';
import { ArrowRight, CalendarDays, Car, ClipboardCheck, ListChecks, Map as MapIcon, Navigation, Phone, Timer, UserRound, Zap } from 'lucide-react';
import {
  RIDE_CARD,
  RIDE_WELL,
  RIDE_LABEL,
  RIDE_INPUT,
  RIDE_INPUT_SM,
  BTN_PRIMARY,
  BTN_PRIMARY_SM,
  BTN_SOFT_SM,
  BTN_GHOST_SM,
  BTN_WARN_SM,
  RideStatusChip,
  RideRoute,
  RideBanner
} from './rideTheme';

interface Requisition {
  id: number;
  purpose: string;
  pickup_location: string;
  destination: string;
  ride_date: string;
  start_time: string;
  estimated_duration_hours: number;
  expected_return_at: string | null;
  status: 'pending' | 'approved' | 'ongoing' | 'rejected' | 'cancelled' | 'completed' | 'expired';
  // Who the Approval Workflow is currently waiting on (comma-joined — ANY
  // ONE of them clears the step) — null once past 'pending'.
  pending_with: string | null;
  decided_by_name: string | null;
  rejection_reason: string | null;
  vehicle_no: string | null;
  vehicle_model: string | null;
  driver_name: string | null;
  driver_mobile: string | null;
  // Set only when the driver is a real employee account (see
  // VehicleManagementRoutes.ts's validateVehicleAssignment) — that's what
  // unlocks "View Live Map" (LiveRideMap needs Employee Tracking pings from
  // both this and employee_user_id).
  driver_user_id: number | null;
  actual_return_at: string | null;
  returned_late: boolean | null;
  time_extension_status: 'none' | 'requested' | 'approved' | 'rejected';
  time_extension_note: string | null;
  created_at: string;
}

// Web Ride Status list: Route | Schedule | Vehicle & Driver | Status | Actions.
const RIDE_LIST_COLS = 'grid-cols-[minmax(0,2.2fr)_minmax(0,1fr)_minmax(0,1.5fr)_minmax(0,1.5fr)_260px]';

const STATUS_LABEL: Record<Requisition['status'], string> = {
  // Could be with the Supervisor or HR/Admin — "Waiting on" names who.
  pending: 'Pending Approval',
  approved: 'Approved — Awaiting Vehicle Assignment',
  ongoing: 'Vehicle Assigned — Ride Ongoing',
  rejected: 'Rejected',
  cancelled: 'Cancelled',
  completed: 'Completed',
  // Start time (+ grace) passed before it was approved / given a vehicle.
  expired: 'Expired — Not Confirmed in Time'
};


interface AvailableVehicle {
  id: number;
  vehicle_no: string;
  model: string;
  vehicle_type: string | null;
}

// A directory row this component actually needs for the Vehicle Maintainer's
// employee picker — only ones with a login account (user_id) can be booked
// for, since vehicle_requisitions.employee_user_id is a users.id FK. See
// GET /api/employee-directory (EmployeeDirectoryRoutes.ts) for the full shape.
interface DirectoryEmployee {
  id: number;
  name: string;
  designation: string | null;
  user_id: number | null;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

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

const emptyDirectBookForm = () => ({
  employee_user_id: '',
  purpose: '',
  pickup_location: '',
  destination: '',
  ride_date: '',
  start_time: '',
  estimated_duration_hours: 1,
  vehicle_id: '',
  driver_user_id: ''
});

interface VehicleManagementProps {
  // The logged-in account — only used here to decide whether the "Direct
  // Book" tab (the Vehicle Maintainer bypass) shows at all. A Superadmin
  // implicitly has every module, same convention as requireModule server-side.
  user?: { role?: string; module_permissions?: string[] } | null;
}

export function VehicleManagement({ user }: VehicleManagementProps) {
  const isVehicleMaintainer = user?.role === 'superadmin' || !!(user?.module_permissions || []).includes('vehicle_maintainer');
  // Opened from a "ride needs a vehicle" alert: start on Approved by Me; if
  // nothing there is this account's to assign, go to Direct Book (Vehicle
  // Maintainer) or Admin Panel -> Vehicle Management instead.
  const wantAssignRef = useRef(false);
  const [tab, setTab] = useState<'book' | 'status' | 'assign' | 'maintainer'>(() => {
    // One-shot tab request from the Dashboard's Book a Ride quick access.
    const requested = takeQuickAccessTab('bookRide');
    if (requested === 'assign') wantAssignRef.current = true;
    return requested === 'status' ? 'status' : requested === 'assign' ? 'assign' : 'book';
  });
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [form, setForm] = useState(emptyForm());
  // Book a Ride is two steps: pick where from/to (RideDestinationPicker),
  // then the rest of the form. null = still on step 1.
  const [places, setPlaces] = useState<RidePlaces | null>(null);
  // Kept when "Change" goes back to step 1, so the picks aren't lost.
  const [lastPlaces, setLastPlaces] = useState<RidePlaces | null>(null);
  // Desktop web browser only: map beside the booking panel, Ride Status in two columns.
  const wideWeb = useWideWeb();
  const [submitting, setSubmitting] = useState(false);
  const [submitMessage, setSubmitMessage] = useState<string | null>(null);
  // Shown on Ride Status right after a request is submitted (the screen
  // moves there so the requester sees the new request and its status).
  const [submittedNotice, setSubmittedNotice] = useState<string | null>(null);

  // Ride Status summary tiles double as a filter.
  const [statusFilter, setStatusFilter] = useState<'all' | Requisition['status']>('all');

  const [extendingFor, setExtendingFor] = useState<number | null>(null);
  const [extendNote, setExtendNote] = useState('');

  // "Approved by Me — Assign Vehicle" — flowchart's "গাড়ি ও ড্রাইভার
  // অ্যাসাইনমেন্ট" step, reachable here (no Admin Panel/Module Access
  // needed) by whoever's own approval action was the one that cleared a
  // requisition's Approval Workflow. See GET
  // /api/vehicles/requisitions/awaiting-my-assignment.
  const [awaitingAssignment, setAwaitingAssignment] = useState<Requisition[]>([]);
  const [availableVehicles, setAvailableVehicles] = useState<AvailableVehicle[]>([]);
  const [assigningFor, setAssigningFor] = useState<number | null>(null);
  const [assignForm, setAssignForm] = useState({ vehicle_id: '', driver_user_id: '' });

  // Fetched once on mount (not gated behind any tab) — the "who is this ride
  // for" employee picker on the Vehicle Maintainer's Direct Book form (needs
  // a name/designation, so it stays sourced from the Employee Directory).
  const [directoryEmployees, setDirectoryEmployees] = useState<DirectoryEmployee[]>([]);
  useEffect(() => {
    fetch(apiUrl('/api/employee-directory'), { headers: authHeaders() })
      .then((r) => r.json())
      .then((rows) => setDirectoryEmployees((Array.isArray(rows) ? rows : []).filter((e: DirectoryEmployee) => e.user_id)))
      .catch(() => {});
  }, []);

  // Driver picker — every login account (see GET /api/vehicles/driver-
  // candidates), NOT the Employee Directory: a driver only ever needs to be
  // a real users.id (validateVehicleAssignment in VehicleManagementRoutes.ts),
  // and an account created straight as a login (e.g. bulk-created via POST
  // /api/users/bulk) is never linked to an all_employees row, so it would be
  // invisible in the Directory despite being a perfectly real driver account.
  const [driverCandidates, setDriverCandidates] = useState<{ id: number; name: string }[]>([]);
  useEffect(() => {
    fetch(apiUrl('/api/vehicles/driver-candidates'), { headers: authHeaders() })
      .then((r) => r.json())
      .then((rows) => setDriverCandidates(Array.isArray(rows) ? rows : []))
      .catch(() => {});
  }, []);

  // Live Ride Map (see LiveRideMap.tsx) — the requisition id currently shown
  // in the modal, or null when closed. Available from "Ride Status" (the
  // requester's own ongoing ride) and the Maintainer tab's "Live Rides" list.
  const [viewingMapFor, setViewingMapFor] = useState<number | null>(null);
  const [viewingDetailsFor, setViewingDetailsFor] = useState<number | null>(null);

  // Vehicle Maintainer bypass (see VehicleManagementRoutes.ts's
  // POST .../direct-book and PUT .../:id/direct-assign) — books+confirms a
  // ride for any employee, or pushes an already-submitted one straight to
  // Assigned, skipping the Approval Workflow entirely.
  const [bypassCandidates, setBypassCandidates] = useState<Requisition[]>([]);
  const [ongoingRides, setOngoingRides] = useState<Requisition[]>([]);
  const [directBookMode, setDirectBookMode] = useState<'new' | 'existing' | 'live'>('new');
  const [directBookForm, setDirectBookForm] = useState(emptyDirectBookForm());
  const [directBookSubmitting, setDirectBookSubmitting] = useState(false);
  const [directBookMessage, setDirectBookMessage] = useState<string | null>(null);
  const [bypassingFor, setBypassingFor] = useState<number | null>(null);
  const [bypassForm, setBypassForm] = useState({ vehicle_id: '', driver_user_id: '' });

  async function loadMaintainerData() {
    setLoading(true);
    setError(null);
    try {
      const [candRes, ongoingRes, vehRes] = await Promise.all([
        fetch(apiUrl('/api/vehicles/requisitions/bypass-candidates'), { headers: authHeaders() }),
        fetch(apiUrl('/api/vehicles/requisitions/ongoing'), { headers: authHeaders() }),
        fetch(apiUrl('/api/vehicles/available'), { headers: authHeaders() })
      ]);
      const candData = await candRes.json();
      const ongoingData = await ongoingRes.json();
      const vehData = await vehRes.json();
      if (!candRes.ok) throw new Error(candData.error || 'Failed to load pending ride requests.');
      if (!ongoingRes.ok) throw new Error(ongoingData.error || 'Failed to load ongoing rides.');
      if (!vehRes.ok) throw new Error(vehData.error || 'Failed to load available vehicles.');
      setBypassCandidates(candData);
      setOngoingRides(ongoingData);
      setAvailableVehicles(vehData);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  async function submitDirectBook(e: React.FormEvent) {
    e.preventDefault();
    setDirectBookSubmitting(true);
    setDirectBookMessage(null);
    try {
      const res = await fetch(apiUrl('/api/vehicles/requisitions/direct-book'), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({
          ...directBookForm,
          employee_user_id: Number(directBookForm.employee_user_id),
          vehicle_id: Number(directBookForm.vehicle_id),
          driver_user_id: Number(directBookForm.driver_user_id)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not book this ride.');
      setDirectBookMessage('Ride booked and confirmed directly.');
      setDirectBookForm(emptyDirectBookForm());
      loadMaintainerData();
    } catch (err: any) {
      setDirectBookMessage(err.message);
    } finally {
      setDirectBookSubmitting(false);
    }
  }

  async function bypassAssign(id: number) {
    if (!bypassForm.vehicle_id || !bypassForm.driver_user_id) {
      setError('Pick a vehicle and a driver.');
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/direct-assign`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ vehicle_id: Number(bypassForm.vehicle_id), driver_user_id: Number(bypassForm.driver_user_id) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not confirm this ride.');
      setBypassingFor(null);
      setBypassForm({ vehicle_id: '', driver_user_id: '' });
      loadMaintainerData();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadRequisitions() {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/vehicles/requisitions'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load your ride requests.');
      setRequisitions(data);
    } catch (err: any) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  // silent = true skips the page-wide loading/error state — used for the
  // on-mount call below so the "Approved by Me" tab's count badge is
  // accurate the moment this screen opens (Book a Ride is the default tab),
  // instead of only refreshing once the person happens to click that tab —
  // without flashing a loading spinner over whichever tab they're actually
  // looking at.
  async function loadAwaitingAssignment(silent = false) {
    if (!silent) {
      setLoading(true);
      setError(null);
    }
    try {
      const [reqRes, vehRes] = await Promise.all([
        fetch(apiUrl('/api/vehicles/requisitions/awaiting-my-assignment'), { headers: authHeaders() }),
        fetch(apiUrl('/api/vehicles/available'), { headers: authHeaders() })
      ]);
      const reqData = await reqRes.json();
      const vehData = await vehRes.json();
      if (!reqRes.ok) throw new Error(reqData.error || 'Failed to load requests awaiting assignment.');
      if (!vehRes.ok) throw new Error(vehData.error || 'Failed to load available vehicles.');
      setAwaitingAssignment(reqData);
      setAvailableVehicles(vehData);
      if (wantAssignRef.current) {
        wantAssignRef.current = false;
        if (Array.isArray(reqData) && reqData.length === 0) {
          const canAdmin = user?.role === 'superadmin' || (user?.module_permissions || []).includes('vehicle_management');
          if (isVehicleMaintainer) setTab('maintainer');
          else if (canAdmin) window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'vehicle_management' }));
        }
      }
    } catch (err: any) {
      if (!silent) setError(err.message);
    } finally {
      if (!silent) setLoading(false);
    }
  }

  useEffect(() => {
    if (tab === 'status') loadRequisitions();
    if (tab === 'assign') loadAwaitingAssignment();
    if (tab === 'maintainer') loadMaintainerData();
  }, [tab]);

  // Runs once on mount, regardless of which tab is active, purely so the
  // "Approved by Me" tab shows its real count right away.
  useEffect(() => {
    loadAwaitingAssignment(true);
  }, []);

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
      setSubmittedNotice('Ride request submitted successfully. You can follow its status here.');
      setStatusFilter('all');
      if (tab === 'status') loadRequisitions();
      else setTab('status');
    } catch (err: any) {
      setSubmitMessage(err.message);
    } finally {
      setSubmitting(false);
    }
  }

  async function cancelRequisition(id: number) {
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/cancel`), { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not cancel.');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function completeRide(id: number) {
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/complete`), { method: 'POST', headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not mark the ride completed.');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function requestExtension(id: number) {
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/request-extension`), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ note: extendNote })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not request an extension.');
      setExtendingFor(null);
      setExtendNote('');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function assignVehicle(id: number) {
    if (!assignForm.vehicle_id || !assignForm.driver_user_id) {
      setError('Pick a vehicle and a driver.');
      return;
    }
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${id}/assign`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ vehicle_id: Number(assignForm.vehicle_id), driver_user_id: Number(assignForm.driver_user_id) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not assign a vehicle to this request.');
      setAssigningFor(null);
      setAssignForm({ vehicle_id: '', driver_user_id: '' });
      loadAwaitingAssignment();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const renderExtensionForm = (r: Requisition) =>
    extendingFor === r.id && (
      <div className={`mt-3 p-3 space-y-2 ${RIDE_WELL}`}>
        <textarea
          value={extendNote}
          onChange={(e) => setExtendNote(e.target.value)}
          rows={2}
          placeholder="Why will you be late / how much more time do you need?"
          className={RIDE_INPUT}
        />
        <div className="flex gap-2">
          <button onClick={() => requestExtension(r.id)} className={BTN_PRIMARY_SM}>
            Submit
          </button>
          <button onClick={() => setExtendingFor(null)} className={BTN_GHOST_SM}>
            Cancel
          </button>
        </div>
      </div>
    );

  // Desktop rows/cards sit on the frosted white card; mobile keeps the glass one.
  const card = wideWeb ? RIDE_CARD : GLASS_CARD;
  const hours = (n: number) => `${n} hr${Number(n) === 1 ? '' : 's'}`;
  const when = (r: Requisition) => `${String(r.ride_date).slice(0, 10)} · ${r.start_time}`;
  const counts = requisitions.reduce<Record<string, number>>((acc, r) => ({ ...acc, [r.status]: (acc[r.status] || 0) + 1 }), {});
  const shownRides = statusFilter === 'all' ? requisitions : requisitions.filter((r) => r.status === statusFilter);
  const emptyState = (text: string) => (
    <div className={`${card} px-6 py-10 flex flex-col items-center text-center`}>
      <span className="w-12 h-12 rounded-2xl bg-[var(--g-accent-soft)] flex items-center justify-center mb-3">
        <Car className="w-6 h-6 text-[color:var(--g-accent)]" />
      </span>
      <p className="text-sm text-slate-500">{text}</p>
    </div>
  );
  const vehicleDriverPicker = (
    value: { vehicle_id: string; driver_user_id: string },
    set: (v: { vehicle_id: string; driver_user_id: string }) => void
  ) => (
    <>
      <select value={value.vehicle_id} onChange={(e) => set({ ...value, vehicle_id: e.target.value })} className={RIDE_INPUT_SM}>
        <option value="">Pick a vehicle…</option>
        {availableVehicles.map((v) => (
          <option key={v.id} value={v.id}>
            {v.model} ({v.vehicle_no})
          </option>
        ))}
      </select>
      <select value={value.driver_user_id} onChange={(e) => set({ ...value, driver_user_id: e.target.value })} className={RIDE_INPUT_SM}>
        <option value="">Pick a driver…</option>
        {driverCandidates.map((d) => (
          <option key={d.id} value={d.id}>
            {d.name}
          </option>
        ))}
      </select>
    </>
  );
  // A request card for the Approved by Me / Direct Book lists.
  const requestCard = (r: Requisition, footer: React.ReactNode, showStatus = true) => (
    <div key={r.id} className={`${card} p-4`}>
      <div className="flex items-start justify-between gap-3">
        <RideRoute from={r.pickup_location} to={r.destination} compact />
        {showStatus && (
          <div className="shrink-0">
            <RideStatusChip status={r.status} label={STATUS_LABEL[r.status]} />
          </div>
        )}
      </div>
      <div className="mt-2.5 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
        <span className="inline-flex items-center gap-1">
          <CalendarDays className="w-3.5 h-3.5" /> {when(r)}
        </span>
        <span className="inline-flex items-center gap-1">
          <Timer className="w-3.5 h-3.5" /> Est. {hours(r.estimated_duration_hours)}
        </span>
      </div>
      {r.purpose && <p className="mt-2 text-sm text-slate-600">{r.purpose}</p>}
      <div className="mt-3">{footer}</div>
    </div>
  );

  const TABS = [
    { key: 'book' as const, label: 'Book a Ride', icon: Car, count: 0 },
    { key: 'status' as const, label: 'Ride Status', icon: ListChecks, count: 0 },
    { key: 'assign' as const, label: wideWeb ? 'Approved by Me' : 'Approved', icon: ClipboardCheck, count: awaitingAssignment.length },
    ...(isVehicleMaintainer ? [{ key: 'maintainer' as const, label: 'Direct Book', icon: Zap, count: 0 }] : [])
  ];

  return (
    <div className="w-full">
      <div
        className={`${wideWeb ? 'inline-flex' : 'flex'} gap-1 p-1 mb-4 rounded-full bg-white/70 border border-white/80 backdrop-blur-sm shadow-[0_6px_18px_-10px_rgba(85,0,170,0.4)]`}
      >
        {TABS.map(({ key, label, icon: Icon, count }) => {
          const on = tab === key;
          return (
            <button
              key={key}
              onClick={() => { setTab(key); setSubmittedNotice(null); }}
              className={`${wideWeb ? 'px-4' : 'flex-1 min-w-0 px-2'} py-2 rounded-full inline-flex items-center justify-center gap-1.5 text-xs sm:text-[13px] font-semibold leading-tight transition-all ${
                on ? 'liquid-glass-button' : 'text-slate-600 hover:text-[color:var(--g-accent-700)] hover:bg-white/70'
              }`}
            >
              <Icon className={`w-4 h-4 shrink-0 ${wideWeb ? '' : 'hidden min-[400px]:block'}`} />
              <span className="truncate">{label}</span>
              {count > 0 && (
                <span
                  className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] font-bold inline-flex items-center justify-center ${
                    on ? 'bg-white text-[color:var(--g-accent-700)]' : 'bg-[var(--g-accent)] text-white'
                  }`}
                >
                  {count}
                </span>
              )}
            </button>
          );
        })}
      </div>

      {error && (
        <div className="mb-3">
          <RideBanner tone="error">{error}</RideBanner>
        </div>
      )}

      {tab === 'book' && (
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

      {tab === 'book' && !places && (
        <>
          {submitMessage && (
            <div className="mb-3 max-w-xl">
              <RideBanner tone="success">{submitMessage}</RideBanner>
            </div>
          )}
          <RideDestinationPicker
            initial={lastPlaces}
            onDone={(picked) => {
              setPlaces(picked);
              setSubmitMessage(null);
            }}
          />
        </>
      )}

      {tab === 'book' && places && (
        <div className={wideWeb ? 'grid grid-cols-[minmax(0,1fr)_400px] gap-5 items-start' : ''}>
          {wideWeb && (
            <RideBookingMap
              here={null}
              pickup={places.pickup_lat != null && places.pickup_lng != null ? { lat: places.pickup_lat, lng: places.pickup_lng } : null}
              destination={places.destination_lat != null && places.destination_lng != null ? { lat: places.destination_lat, lng: places.destination_lng } : null}
              className="h-[calc(100vh-230px)] min-h-[480px] !rounded-[28px] !border-white/80 shadow-[0_18px_40px_-24px_rgba(85,0,170,0.45)]"
            />
          )}
          <form onSubmit={submitRequisition} className={`space-y-4 p-5 ${wideWeb ? RIDE_CARD : `max-w-xl ${GLASS_CARD}`}`}>
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
            <div className={`grid gap-3 ${wideWeb ? 'grid-cols-2' : 'grid-cols-2 sm:grid-cols-3'}`}>
              <div>
                <label className={RIDE_LABEL}>Ride Date</label>
                <input required type="date" min={todayLocal()} value={form.ride_date} onChange={(e) => setForm({ ...form, ride_date: e.target.value })} className={RIDE_INPUT} />
              </div>
              <div>
                <label className={RIDE_LABEL}>Start Time</label>
                <input required type="time" value={form.start_time} onChange={(e) => setForm({ ...form, start_time: e.target.value })} className={RIDE_INPUT} />
              </div>
              <div className={wideWeb ? 'col-span-2' : ''}>
                <label className={RIDE_LABEL}>Est. Duration (hrs)</label>
                <input
                  required
                  type="number"
                  min={0.5}
                  step="0.5"
                  value={form.estimated_duration_hours}
                  onChange={(e) => setForm({ ...form, estimated_duration_hours: Number(e.target.value) })}
                  className={RIDE_INPUT}
                />
              </div>
            </div>
            {submitMessage && <RideBanner tone="error">{submitMessage}</RideBanner>}
            <button type="submit" disabled={submitting} className={`${BTN_PRIMARY} w-full py-3`}>
              {submitting ? 'Submitting…' : 'Submit Request'} {!submitting && <ArrowRight className="w-4 h-4" />}
            </button>
          </form>
        </div>
      )}

      {tab === 'status' && submittedNotice && (
        <div className="mb-3">
          <RideBanner tone="success">{submittedNotice}</RideBanner>
        </div>
      )}

      {tab === 'status' && (
        <div className={`grid gap-2 mb-4 ${wideWeb ? 'grid-cols-5' : 'grid-cols-4'}`}>
          {(
            [
              ['all', 'All', requisitions.length],
              ['pending', 'Pending', counts.pending || 0],
              ['ongoing', 'Ongoing', counts.ongoing || 0],
              ['completed', 'Completed', counts.completed || 0],
              ...(wideWeb ? [['approved', 'Awaiting car', counts.approved || 0]] : [])
            ] as [typeof statusFilter, string, number][]
          ).map(([key, label, n]) => {
            const on = statusFilter === key;
            return (
              <button
                key={key}
                onClick={() => setStatusFilter(key)}
                className={`text-left rounded-2xl ${wideWeb ? 'px-3.5' : 'px-2.5'} py-2.5 border transition-all ${
                  on
                    ? 'border-[var(--g-accent-300)] bg-[var(--g-accent-soft)] shadow-[0_8px_20px_-14px_rgba(85,0,170,0.6)]'
                    : 'border-white/80 bg-white/70 hover:bg-white'
                }`}
              >
                <div className={`text-xl font-bold leading-none ${on ? 'text-[color:var(--g-accent-700)]' : 'text-slate-800'}`}>{n}</div>
                <div className="text-[11px] font-semibold text-slate-500 mt-1">{label}</div>
              </button>
            );
          })}
        </div>
      )}

      {tab === 'status' && wideWeb && (
        // Web: one row per ride, table-style, full content width.
        <div className={`${RIDE_CARD} overflow-hidden`}>
          <div
            className={`grid ${RIDE_LIST_COLS} gap-4 px-5 py-3 bg-[var(--g-accent-soft)]/70 border-b border-[var(--g-accent-100)] text-[11px] font-semibold uppercase tracking-wide text-[color:var(--g-accent-800)]`}
          >
            <div>Route</div>
            <div>Schedule</div>
            <div>Vehicle & Driver</div>
            <div>Status</div>
            <div className="text-right">Actions</div>
          </div>
          {loading && <div className="px-5 py-6 text-sm text-slate-500">Loading…</div>}
          {!loading && shownRides.length === 0 && <div className="px-5 py-8 text-sm text-slate-500 text-center">No ride requests here yet.</div>}
          {shownRides.map((r) => (
            <div key={r.id} className="px-5 py-4 border-b border-slate-100 last:border-b-0 hover:bg-[var(--g-accent-soft)]/30 transition-colors">
              <div className={`grid ${RIDE_LIST_COLS} gap-4 items-start`}>
                <div className="min-w-0">
                  <RideRoute from={r.pickup_location} to={r.destination} compact />
                  {r.purpose && (
                    <div className="text-xs text-slate-500 truncate mt-1.5 pl-5" title={r.purpose}>
                      {r.purpose}
                    </div>
                  )}
                </div>
                <div className="text-sm text-slate-700">
                  <div className="inline-flex items-center gap-1.5 font-medium">
                    <CalendarDays className="w-3.5 h-3.5 text-[color:var(--g-accent-400)]" />
                    {String(r.ride_date).slice(0, 10)}
                  </div>
                  <div className="text-xs text-slate-500 mt-0.5 pl-5">
                    {r.start_time} · Est. {hours(r.estimated_duration_hours)}
                  </div>
                </div>
                <div className="min-w-0 text-sm text-slate-700">
                  {r.vehicle_no ? (
                    <>
                      <div className="truncate font-medium inline-flex items-center gap-1.5 max-w-full">
                        <Car className="w-3.5 h-3.5 text-[color:var(--g-accent-400)] shrink-0" />
                        <span className="truncate">
                          {r.vehicle_model} ({r.vehicle_no})
                        </span>
                      </div>
                      <div className="text-xs text-slate-500 truncate pl-5">
                        {r.driver_name}
                        {r.driver_mobile ? ` — ${r.driver_mobile}` : ''}
                      </div>
                    </>
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </div>
                <div className="min-w-0 space-y-1">
                  <RideStatusChip status={r.status} label={STATUS_LABEL[r.status]} />
                  {r.status === 'pending' && r.pending_with && (
                    <div className="text-xs text-amber-700 truncate" title={r.pending_with}>
                      Waiting on: <span className="font-medium">{r.pending_with}</span>
                    </div>
                  )}
                  {r.status === 'rejected' && r.rejection_reason && <div className="text-xs text-rose-600">Reason: {r.rejection_reason}</div>}
                  {r.status === 'ongoing' && r.expected_return_at && (
                    <div className="text-xs text-slate-500">Back by {new Date(r.expected_return_at).toLocaleString()}</div>
                  )}
                  {r.status === 'ongoing' && r.time_extension_status !== 'none' && (
                    <div className="text-xs text-amber-700">
                      Extension {r.time_extension_status}
                      {r.time_extension_note ? `: ${r.time_extension_note}` : ''}
                    </div>
                  )}
                  {r.status === 'completed' && (
                    <div className={`text-xs ${r.returned_late ? 'text-amber-700' : 'text-slate-500'}`}>
                      {r.returned_late ? 'Returned late' : 'Returned on time'}
                      {r.actual_return_at ? ` — ${new Date(r.actual_return_at).toLocaleString()}` : ''}
                    </div>
                  )}
                </div>
                <div className="flex flex-wrap justify-end gap-1.5">
                  {r.status === 'pending' && (
                    <button onClick={() => cancelRequisition(r.id)} className={BTN_GHOST_SM}>
                      Cancel
                    </button>
                  )}
                  {r.status === 'completed' && (
                    <button onClick={() => setViewingDetailsFor(r.id)} className={BTN_SOFT_SM}>
                      <MapIcon className="w-3.5 h-3.5" /> Details & Map
                    </button>
                  )}
                  {r.status === 'ongoing' && (
                    <>
                      {r.driver_user_id && (
                        <button onClick={() => setViewingMapFor(r.id)} className={BTN_SOFT_SM}>
                          <Navigation className="w-3.5 h-3.5" /> Live Map
                        </button>
                      )}
                      <button onClick={() => completeRide(r.id)} className={BTN_PRIMARY_SM}>
                        Mark Returned
                      </button>
                      {r.time_extension_status === 'none' && (
                        <button
                          onClick={() => {
                            setExtendingFor(extendingFor === r.id ? null : r.id);
                            setExtendNote('');
                          }}
                          className={BTN_WARN_SM}
                        >
                          Running Late
                        </button>
                      )}
                    </>
                  )}
                </div>
              </div>
              {renderExtensionForm(r)}
            </div>
          ))}
        </div>
      )}

      {tab === 'status' && !wideWeb && (
        <div className="space-y-3">
          {loading && <div className="text-sm text-slate-500">Loading…</div>}
          {!loading && shownRides.length === 0 && emptyState('No ride requests here yet.')}
          {shownRides.map((r) => (
            <div key={r.id} className={`p-4 ${GLASS_CARD}`}>
              <div className="flex items-start justify-between gap-3">
                <RideRoute from={r.pickup_location} to={r.destination} compact />
              </div>
              <div className="mt-2.5 flex flex-wrap items-center gap-2">
                <RideStatusChip status={r.status} label={STATUS_LABEL[r.status]} />
              </div>
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-slate-500">
                <span className="inline-flex items-center gap-1">
                  <CalendarDays className="w-3.5 h-3.5" /> {when(r)}
                </span>
                <span className="inline-flex items-center gap-1">
                  <Timer className="w-3.5 h-3.5" /> Est. {hours(r.estimated_duration_hours)}
                </span>
              </div>
              {r.purpose && <div className="text-sm text-slate-600 mt-2">{r.purpose}</div>}

              {r.status === 'pending' && r.pending_with && (
                <div className="text-xs text-amber-700 mt-1.5">
                  Waiting on: <span className="font-medium">{r.pending_with}</span>
                </div>
              )}

              {r.status === 'rejected' && r.rejection_reason && <div className="text-xs text-rose-600 mt-2">Reason: {r.rejection_reason}</div>}

              {(r.status === 'ongoing' || r.status === 'completed') && r.vehicle_no && (
                <div className={`mt-3 px-3 py-2.5 text-xs text-slate-700 space-y-1 ${RIDE_WELL}`}>
                  <div className="flex items-center gap-1.5">
                    <Car className="w-3.5 h-3.5 text-[color:var(--g-accent)]" /> {r.vehicle_model} ({r.vehicle_no})
                  </div>
                  <div className="flex items-center gap-1.5">
                    <UserRound className="w-3.5 h-3.5 text-[color:var(--g-accent)]" /> {r.driver_name}
                    {r.driver_mobile && (
                      <a href={`tel:${r.driver_mobile}`} className="inline-flex items-center gap-1 font-semibold text-[color:var(--g-accent-700)]">
                        <Phone className="w-3 h-3" /> {r.driver_mobile}
                      </a>
                    )}
                  </div>
                  {r.expected_return_at && <div className="text-slate-500">Expected back by {new Date(r.expected_return_at).toLocaleString()}</div>}
                </div>
              )}

              {r.status === 'ongoing' && r.time_extension_status !== 'none' && (
                <div className="text-xs text-amber-700 mt-1.5">
                  Time extension {r.time_extension_status}
                  {r.time_extension_note ? `: ${r.time_extension_note}` : ''}
                </div>
              )}

              {r.status === 'completed' && (
                <div className={`text-xs mt-2 ${r.returned_late ? 'text-amber-700' : 'text-slate-500'}`}>
                  {r.returned_late ? 'Returned late' : 'Returned on time'}
                  {r.actual_return_at ? ` — ${new Date(r.actual_return_at).toLocaleString()}` : ''}
                </div>
              )}

              <div className="mt-3 flex flex-wrap gap-2 empty:hidden">
                {r.status === 'completed' && (
                  <button onClick={() => setViewingDetailsFor(r.id)} className={BTN_SOFT_SM}>
                    <MapIcon className="w-3.5 h-3.5" /> Ride Details & Map
                  </button>
                )}
                {r.status === 'pending' && (
                  <button onClick={() => cancelRequisition(r.id)} className={BTN_GHOST_SM}>
                    Cancel Request
                  </button>
                )}
                {r.status === 'ongoing' && (
                  <>
                    {r.driver_user_id && (
                      <button onClick={() => setViewingMapFor(r.id)} className={BTN_SOFT_SM}>
                        <Navigation className="w-3.5 h-3.5" /> Live Map
                      </button>
                    )}
                    <button onClick={() => completeRide(r.id)} className={BTN_PRIMARY_SM}>
                      Ride Completed
                    </button>
                    {r.time_extension_status === 'none' && (
                      <button
                        onClick={() => {
                          setExtendingFor(extendingFor === r.id ? null : r.id);
                          setExtendNote('');
                        }}
                        className={BTN_WARN_SM}
                      >
                        Running Late
                      </button>
                    )}
                  </>
                )}
              </div>

              {renderExtensionForm(r)}
            </div>
          ))}
        </div>
      )}

      {tab === 'assign' && (
        <div className="space-y-3">
          <RideBanner tone="info">
            Ride requests you approved that are still waiting for a vehicle + driver — the flowchart's own "গাড়ি ও ড্রাইভার
            অ্যাসাইনমেন্ট" step, no Vehicle Management Module Access needed.
          </RideBanner>
          {loading && <div className="text-sm text-slate-500">Loading…</div>}
          {!loading && awaitingAssignment.length === 0 && emptyState('Nothing waiting on you right now.')}
          <div className={wideWeb ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
            {awaitingAssignment.map((r) =>
              requestCard(
                r,
                assigningFor === r.id ? (
                  <div className="flex flex-wrap items-center gap-2">
                    {vehicleDriverPicker(assignForm, setAssignForm)}
                    <button onClick={() => assignVehicle(r.id)} className={BTN_PRIMARY_SM}>
                      Confirm Assignment
                    </button>
                    <button onClick={() => setAssigningFor(null)} className={BTN_GHOST_SM}>
                      Cancel
                    </button>
                  </div>
                ) : (
                  <button
                    onClick={() => {
                      setAssigningFor(r.id);
                      setAssignForm({ vehicle_id: '', driver_user_id: '' });
                    }}
                    className={BTN_PRIMARY_SM}
                  >
                    <Car className="w-3.5 h-3.5" /> Assign Vehicle &amp; Driver
                  </button>
                ),
                false
              )
            )}
          </div>
        </div>
      )}

      {tab === 'maintainer' && isVehicleMaintainer && (
        <div className="space-y-4">
          <RideBanner tone="info">
            Vehicle Maintainer bypass — books/confirms a ride without going through the Supervisor / HR-Admin Approval Workflow. Use
            "Book New" for a ride nobody has submitted yet, or "Bypass Existing" to push an already-submitted request straight to
            Assigned.
          </RideBanner>

          <div className="flex flex-wrap gap-1.5">
            {([
              ['new', 'Book New', 0],
              ['existing', 'Bypass Existing', bypassCandidates.length],
              ['live', 'Live Rides', ongoingRides.length]
            ] as const).map(([key, label, n]) => (
              <button
                key={key}
                onClick={() => setDirectBookMode(key)}
                className={
                  directBookMode === key
                    ? BTN_PRIMARY_SM
                    : 'rounded-full px-3.5 py-1.5 text-xs font-semibold bg-white/70 border border-white/80 text-slate-600 hover:text-[color:var(--g-accent-700)]'
                }
              >
                {label}
                {n > 0 ? ` (${n})` : ''}
              </button>
            ))}
          </div>

          {loading && <div className="text-sm text-slate-500">Loading…</div>}

          {directBookMode === 'new' && (
            <form onSubmit={submitDirectBook} className={`space-y-3 max-w-2xl p-5 ${card}`}>
              <div>
                <label className={RIDE_LABEL}>Employee</label>
                <select
                  required
                  value={directBookForm.employee_user_id}
                  onChange={(e) => setDirectBookForm({ ...directBookForm, employee_user_id: e.target.value })}
                  className={RIDE_INPUT}
                >
                  <option value="">Select an employee…</option>
                  {directoryEmployees.map((e) => (
                    <option key={e.user_id} value={e.user_id as number}>
                      {e.name}
                      {e.designation ? ` — ${e.designation}` : ''}
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className={RIDE_LABEL}>Purpose</label>
                <textarea
                  required
                  value={directBookForm.purpose}
                  onChange={(e) => setDirectBookForm({ ...directBookForm, purpose: e.target.value })}
                  rows={2}
                  className={RIDE_INPUT}
                />
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={RIDE_LABEL}>Pickup Location</label>
                  <input
                    required
                    value={directBookForm.pickup_location}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, pickup_location: e.target.value })}
                    className={RIDE_INPUT}
                  />
                </div>
                <div>
                  <label className={RIDE_LABEL}>Destination</label>
                  <input
                    required
                    value={directBookForm.destination}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, destination: e.target.value })}
                    className={RIDE_INPUT}
                  />
                </div>
              </div>
              <div className="grid grid-cols-3 gap-3">
                <div>
                  <label className={RIDE_LABEL}>Ride Date</label>
                  <input
                    required
                    type="date"
                    min={todayLocal()}
                    value={directBookForm.ride_date}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, ride_date: e.target.value })}
                    className={RIDE_INPUT}
                  />
                </div>
                <div>
                  <label className={RIDE_LABEL}>Start Time</label>
                  <input
                    required
                    type="time"
                    value={directBookForm.start_time}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, start_time: e.target.value })}
                    className={RIDE_INPUT}
                  />
                </div>
                <div>
                  <label className={RIDE_LABEL}>Est. Duration (hrs)</label>
                  <input
                    required
                    type="number"
                    min={0.5}
                    step="0.5"
                    value={directBookForm.estimated_duration_hours}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, estimated_duration_hours: Number(e.target.value) })}
                    className={RIDE_INPUT}
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className={RIDE_LABEL}>Vehicle</label>
                  <select
                    required
                    value={directBookForm.vehicle_id}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, vehicle_id: e.target.value })}
                    className={RIDE_INPUT}
                  >
                    <option value="">Pick a vehicle…</option>
                    {availableVehicles.map((v) => (
                      <option key={v.id} value={v.id}>
                        {v.model} ({v.vehicle_no})
                      </option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={RIDE_LABEL}>Driver</label>
                  <select
                    required
                    value={directBookForm.driver_user_id}
                    onChange={(e) => setDirectBookForm({ ...directBookForm, driver_user_id: e.target.value })}
                    className={RIDE_INPUT}
                  >
                    <option value="">Pick a driver…</option>
                    {driverCandidates.map((d) => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <p className="text-[11px] text-slate-400 mt-1">Must be a login account — needed for the Live Ride Map's location tracking.</p>
                </div>
              </div>
              {directBookMessage && <div className="text-sm text-slate-700">{directBookMessage}</div>}
              <button type="submit" disabled={directBookSubmitting} className={BTN_PRIMARY}>
                <Zap className="w-4 h-4" /> {directBookSubmitting ? 'Booking…' : 'Book & Confirm Directly'}
              </button>
            </form>
          )}

          {directBookMode === 'existing' && (
            <div className={wideWeb ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
              {!loading && bypassCandidates.length === 0 && emptyState('Nothing pending or approved right now.')}
              {bypassCandidates.map((r) =>
                requestCard(
                  r,
                  bypassingFor === r.id ? (
                    <div className="flex flex-wrap items-center gap-2">
                      {vehicleDriverPicker(bypassForm, setBypassForm)}
                      <button onClick={() => bypassAssign(r.id)} className={BTN_PRIMARY_SM}>
                        Confirm Directly
                      </button>
                      <button onClick={() => setBypassingFor(null)} className={BTN_GHOST_SM}>
                        Cancel
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => {
                        setBypassingFor(r.id);
                        setBypassForm({ vehicle_id: '', driver_user_id: '' });
                      }}
                      className={BTN_PRIMARY_SM}
                    >
                      <Zap className="w-3.5 h-3.5" /> Bypass & Assign Vehicle
                    </button>
                  )
                )
              )}
            </div>
          )}

          {directBookMode === 'live' && (
            <div className={wideWeb ? 'grid grid-cols-2 gap-3' : 'space-y-3'}>
              {!loading && ongoingRides.length === 0 && emptyState('No rides ongoing right now.')}
              {ongoingRides.map((r) =>
                requestCard(
                  r,
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <span className="text-xs text-slate-500">
                      {r.vehicle_model} ({r.vehicle_no}) · {r.driver_name}
                      {!r.driver_user_id && ' (no tracked account — live map unavailable)'}
                    </span>
                    <button onClick={() => setViewingMapFor(r.id)} disabled={!r.driver_user_id} className={BTN_SOFT_SM}>
                      <Navigation className="w-3.5 h-3.5" /> View Live Map
                    </button>
                  </div>
                )
              )}
            </div>
          )}
        </div>
      )}

      {viewingMapFor != null && <LiveRideMap requisitionId={viewingMapFor} onClose={() => setViewingMapFor(null)} />}
      {viewingDetailsFor != null && <RideDetails requisitionId={viewingDetailsFor} onClose={() => setViewingDetailsFor(null)} />}
    </div>
  );
}
