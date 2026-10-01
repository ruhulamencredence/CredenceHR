/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { X, Route, LogIn, LogOut, Inbox, MapPin, ChevronRight } from 'lucide-react';
import { ClaimRecord } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import ClaimLocationMap from './ClaimLocationMap';
import { Spinner } from './Spinner';

interface MyClaimsModalProps {
  token: string;
  onClose: () => void;
  // See the matching prop on MyClaimsCard — opens the parent's "Add Check
  // In/Out" sheet so a still-open claim can be completed right from this list.
  onCheckOut?: () => void;
}

// User Dashboard -> "My Claims": the logged-in User's own full Movement Claim
// history (not just today's/current one, unlike the compact status line on the
// Claim card itself), newest first, each with its Check In/Out Approval Workflow
// badge so a User can see exactly where their travel claim stands.
export default function MyClaimsModal({ token, onClose, onCheckOut }: MyClaimsModalProps) {
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [loading, setLoading] = useState(true);
  // Which claim's Check In/Out pins are currently shown on the location map —
  // set by tapping any claim row below.
  const [viewingLocation, setViewingLocation] = useState<ClaimRecord | null>(null);

  useBackButtonClose(true, onClose);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoading(true);
      try {
        const res = await fetch(apiUrl('/api/claims/mine'), { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) setClaims(await res.json());
      } catch {
        // Offline/unreachable — just show the empty state below.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center sm:p-4">
      {/* Mobile: full-screen height (h-full) so the claims list's flex-1
          scroll area fills the whole screen instead of the box shrinking to
          fit its content and leaving empty backdrop space below. Larger
          screens keep the original centered, capped-height card. */}
      <div className="bg-white border border-slate-200 sm:rounded-2xl max-w-lg w-full h-full sm:h-auto sm:max-h-[85vh] overflow-hidden shadow-2xl flex flex-col">
        <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div className="flex items-center gap-3">
            <div className="bg-blue-50 text-blue-600 p-2 rounded-xl border border-blue-100">
              <Route className="w-5 h-5" />
            </div>
            <div>
              <h3 className="text-base font-bold text-slate-900">My Claims</h3>
              <p className="text-xs text-slate-500">Your Movement Claim history</p>
            </div>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="overflow-y-auto flex-1">
          {loading ? (
            <div className="flex justify-center py-14">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : claims.length === 0 ? (
            <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
              <Inbox className="w-6 h-6 text-slate-300" />
              <p className="text-sm">No claims yet — check in from the Movement Claim card when you head out.</p>
            </div>
          ) : (
            <ul className="divide-y divide-slate-100">
              {claims.map((c) => (
                <li key={c.id} className="p-4 space-y-2 hover:bg-slate-50 transition-colors">
                <button
                  type="button"
                  onClick={() => setViewingLocation(c)}
                  className="w-full text-left active:bg-slate-100 -m-4 p-4 space-y-2"
                >
                  <div className="flex items-start justify-between gap-3">
                    <p className="text-sm font-semibold text-slate-900 leading-snug">{c.purpose}</p>
                    <span
                      className={`shrink-0 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                        c.status === 'open'
                          ? 'bg-amber-50 text-amber-700 border-amber-200'
                          : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                      }`}
                    >
                      {c.status === 'open' ? 'Open' : 'Completed'}
                    </span>
                  </div>

                  <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                    <span className="inline-flex items-center gap-1 text-emerald-700">
                      <LogIn className="w-3 h-3" />
                      {formatDate(c.check_in_at)} {new Date(c.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                    </span>
                  </div>

                  {c.check_out_at ? (
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1 text-blue-700">
                        <LogOut className="w-3 h-3" />
                        {formatDate(c.check_out_at)} {new Date(c.check_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        {c.distance_km != null ? ` · ${c.distance_km} km` : ''}
                      </span>
                    </div>
                  ) : (
                    <p className="text-[11px] text-slate-400">Not checked out yet.</p>
                  )}

                  {(c.check_in_remarks || c.check_out_remarks) && (
                    <div className="text-[11px] text-slate-500 space-y-0.5 pt-0.5">
                      {c.check_in_remarks && (
                        <p><span className="font-medium text-slate-600">Check In remarks:</span> {c.check_in_remarks}</p>
                      )}
                      {c.check_out_remarks && (
                        <p><span className="font-medium text-slate-600">Check Out remarks:</span> {c.check_out_remarks}</p>
                      )}
                    </div>
                  )}

                  <div className="flex items-center gap-1 text-[11px] font-semibold text-blue-600 pt-0.5">
                    <MapPin className="w-3 h-3" /> View movement location <ChevronRight className="w-3 h-3" />
                  </div>
                </button>

                {/* Only the still-open claim gets this — see MyClaimsCard's
                    matching button for the full reasoning. */}
                {c.status === 'open' && onCheckOut && (
                  <button
                    type="button"
                    onClick={onCheckOut}
                    className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-lg py-2 transition-colors"
                  >
                    <LogOut className="w-3.5 h-3.5" /> Check Out
                  </button>
                )}
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>

      {viewingLocation && <ClaimLocationMap claim={viewingLocation} onClose={() => setViewingLocation(null)} />}
    </div>
  );
}