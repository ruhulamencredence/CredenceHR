/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLiveRefresh } from '../lib/liveRefresh';
import React, { useEffect, useState } from 'react';
import { readDraft, saveDraft, clearDraft } from '../lib/formDraft';
import { Route, LogIn, LogOut, CheckCircle2, AlertTriangle, MapPin } from 'lucide-react';
import { ClaimRecord } from '../types';
import { apiUrl } from '../lib/api';
import { retryImport } from '../lib/chunkReload';
// The full-screen Check In/Out map (Leaflet) is fetched when it opens, not with the card.
const CheckInOutMap = React.lazy(retryImport(() => import('./CheckInOutMap')));

interface ClaimCardProps {
  token: string;
  // Fires after a successful Check In OR Check Out (not on error) — lets a
  // parent showing this form inside a sheet/modal (e.g. the Check In/Out
  // page's "Add Check In/Out" button) know to refresh its own list of past
  // claims. Receives which action just completed: on 'in' the sheet is left
  // open (the user may still want to Check Out right after Checking In, in
  // the same sheet); on 'out' the claim is finished — the caller is expected
  // to close its own sheet then, since there's nothing left to do here.
  onSuccess?: (kind: 'in' | 'out') => void;
}

// The GPS fix (src/lib/currentCoords.ts) — also used by AiAssistant.tsx.
import { getCurrentCoords } from '../lib/currentCoords';
export { getCurrentCoords };

// "Check In/Out" — free-form point A -> point B travel record for office work
// (client visits, bank runs, site trips, etc.), separate from the fixed-site
// Remote Attendance above it. A User types WHY/WHERE they're going, Checks In
// from their current spot, and later Checks Out once they reach/finish — the
// straight-line distance travelled is then available to the Admin for TA/DA-style
// reimbursement review. Shown near the top of the User Panel, same as Attendance.
export const ClaimCard: React.FC<ClaimCardProps> = ({ token, onSuccess }) => {
  // The Purpose being typed survives a reload / app restart (lib/formDraft.ts).
  const [purpose, setPurposeState] = useState(() => readDraft<string>('checkinout-purpose') || '');
  const setPurpose = (v: string) => {
    setPurposeState(v);
    if (v.trim()) saveDraft('checkinout-purpose', v);
    else clearDraft('checkinout-purpose');
  };
  const [openClaim, setOpenClaim] = useState<ClaimRecord | null>(null);
  // The most recently completed claim (if any), kept around purely so its
  // check-out Approval Workflow badge stays visible after checking out —
  // otherwise openClaim goes straight to null and the badge never renders.
  const [lastCompletedClaim, setLastCompletedClaim] = useState<ClaimRecord | null>(null);
  const [loadingStatus, setLoadingStatus] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

// Live refresh: reload when a request changes (src/lib/liveRefresh.ts).
useLiveRefresh(() => fetchStatus(true));
  const fetchStatus = async (silent?: unknown) => {
    if (silent !== true) setLoadingStatus(true);
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

  // Check In / Check Out open the full-screen map (CheckInOutMap.tsx): it
  // gets the GPS fix, shows where you are and sends the Check In/Out itself
  // (the Purpose typed here is the same draft, so it is already filled in).
  const [mapOpen, setMapOpen] = useState(false);
  const handleMark = (kind: 'in' | 'out') => {
    if (kind === 'in' && !purpose.trim()) {
      setMessage({ type: 'error', text: 'Please describe where/why you\u2019re going first.' });
      return;
    }
    setMessage(null);
    setMapOpen(true);
  };
  const handleDone = async (kind: 'in' | 'out', text: string) => {
    setMapOpen(false);
    setMessage({ type: 'success', text });
    if (kind === 'in') setLastCompletedClaim(null);
    if (kind === 'out') {
      setPurposeState('');
      try {
        const mineRes = await fetch(apiUrl('/api/claims/mine'), { headers: { Authorization: `Bearer ${token}` } });
        if (mineRes.ok) {
          const mine = await mineRes.json();
          setLastCompletedClaim(mine[0] || null);
        }
      } catch {
        // Non-critical — the message above already confirms the check-out.
      }
    }
    await fetchStatus();
    onSuccess?.(kind);
  };

  const hasOpenClaim = !!openClaim;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl p-3.5 shadow-sm">
      <div className="flex items-start justify-between gap-3 mb-0.5">
        <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2">
          <Route className="w-4 h-4 text-indigo-600" /> Check In/Out
        </h3>
      </div>
      <p className="text-xs text-slate-500 mb-2.5">
        Going out for office work? Check in from where you start and check out once you reach or finish — your
        travel distance is recorded for review. See your past check in/outs and their locations in the
        <span className="font-semibold text-slate-600"> Check In/Out</span> list below.
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
            autoComplete="off"
            placeholder="e.g. Bank visit — City Branch"
            className="w-full text-sm px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-indigo-600 focus:outline-none disabled:opacity-70"
          />
        </div>

        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => handleMark('in')}
            disabled={!purpose.trim() || mapOpen || hasOpenClaim || loadingStatus}
            className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            <LogIn className="w-4 h-4" />
            Check In
          </button>
          <button
            type="button"
            onClick={() => handleMark('out')}
            disabled={mapOpen || !hasOpenClaim || loadingStatus}
            className="flex items-center gap-1.5 text-sm px-3.5 py-2 rounded-xl bg-indigo-600 hover:bg-indigo-700 text-white font-semibold disabled:opacity-50 disabled:cursor-not-allowed transition-colors whitespace-nowrap"
          >
            <LogOut className="w-4 h-4" />
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
              <span>Nothing checked in right now — check in above when you head out.</span>
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

      {mapOpen && (
        <React.Suspense fallback={null}>
          <CheckInOutMap token={token} onClose={() => setMapOpen(false)} onDone={(kind, text) => void handleDone(kind, text)} />
        </React.Suspense>
      )}
    </div>
  );
};