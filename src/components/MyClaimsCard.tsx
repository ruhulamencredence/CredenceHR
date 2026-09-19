/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { ArrowLeft, MapPin, LogIn, LogOut, ChevronRight, Inbox } from 'lucide-react';
import { ClaimRecord } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { reverseGeocode } from '../lib/reverseGeocode';
import ClaimLocationMap from './ClaimLocationMap';
import { Spinner } from './Spinner';

interface MyClaimsCardProps {
  token: string;
  // Present only on mobile, where this card is one of the tile-menu sections —
  // same "Back to Menu" pattern the Jobs / Entries cards already use. Omit (or
  // pass undefined) on desktop where the card is just always visible.
  onBack?: () => void;
  // Bump this (e.g. ++) to force a re-fetch — used by the Movement Claim page's
  // "Add Check In/Out" sheet so a fresh Check In/Out shows up here right after
  // the sheet reports success, without needing a full page reload.
  refreshKey?: number;
  // Opens the parent's existing "Add Check In/Out" sheet (the same ClaimCard
  // form the floating button uses) so a User can complete their still-open
  // claim right from this list, instead of having to hunt for the Movement
  // Claim page's floating button. Only the still-`open` row shows the Check
  // Out button below — there's ever only one open claim per User (ClaimCard
  // disables a new Check In while one is open), so this doesn't need to tell
  // the parent which claim, just that the sheet should open.
  onCheckOut?: () => void;
}

// User Dashboard -> "My Claims" — a dedicated card of its own (same visual treatment
// as the Jobs summary card next to it), listing every Movement Claim this user has
// made. Tapping a claim's row opens ClaimLocationMap to show exactly where the Check
// In/Check Out happened, same as from the compact history list in MyClaimsModal; a
// still-open claim also gets its own "Check Out" button so the User can complete it
// without leaving this list.
export const MyClaimsCard: React.FC<MyClaimsCardProps> = ({ token, onBack, refreshKey, onCheckOut }) => {
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingLocation, setViewingLocation] = useState<ClaimRecord | null>(null);
  // Reverse-geocoded place names for each completed claim's Check In/Out point,
  // keyed by `in-${claim.id}` / `out-${claim.id}` — filled in lazily below so the
  // ride-history-style route (dot -> dashed line -> dot) can show real place
  // names instead of raw coordinates. Missing key = still loading; null = the
  // lookup failed/found nothing (falls back to the plain coordinates).
  const [addresses, setAddresses] = useState<Record<string, string | null>>({});

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
  }, [token, refreshKey]);

  useEffect(() => {
    let cancelled = false;
    claims
      .filter((c) => c.status === 'completed' && c.check_out_lat != null && c.check_out_lng != null)
      .forEach((c) => {
        reverseGeocode(c.check_in_lat, c.check_in_lng).then((addr) => {
          if (!cancelled) setAddresses((prev) => ({ ...prev, [`in-${c.id}`]: addr }));
        });
        reverseGeocode(c.check_out_lat as number, c.check_out_lng as number).then((addr) => {
          if (!cancelled) setAddresses((prev) => ({ ...prev, [`out-${c.id}`]: addr }));
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims]);

  return (
    // This card is only ever rendered as a dedicated mobile page (both call
    // sites in UserPanel are md:hidden — the bottom-nav "Claim" tab and the
    // "Claims" tile), never as a small inline dashboard tile, so it should
    // fill the screen instead of sizing to its own content. min-h matches
    // JobEditPanel's mobile full-page pane (roughly viewport height minus the
    // top header + bottom nav bar); flex flex-col + the list's flex-1 below
    // then let the claims list itself take up all the remaining space
    // instead of stopping at a fixed height and leaving empty page below it.
    // Liquid glass — same Dashboard mobile look as Select a Budget/Jobs/Job
    // Entry Details/Job Edit. This card is mobile-only (see the comment
    // above), so no desktop md: split is needed.
    <div className="bg-gradient-to-br from-violet-100/70 via-white/50 to-indigo-50/40 backdrop-blur-xl border border-white/70 rounded-[28px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] overflow-hidden flex flex-col min-h-[calc(100dvh-14rem)]">
      {onBack && (
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 px-5 pt-4 transition-colors shrink-0"
        >
          <ArrowLeft className="w-3.5 h-3.5" /> Back to Menu
        </button>
      )}

      {/* Icon/title/description hidden — the mobile header now shows this
          page's own "My Claims" title in the logo's place (see
          headerPageTitle.ts in UserPanel.tsx), so repeating it here would be
          a redundant duplicate. The count badge stays (it's live data). */}
      <div className="flex items-center justify-end px-5 py-4 border-b border-white/40 shrink-0">
        <span className="text-sm font-semibold text-slate-900 bg-white/50 backdrop-blur px-2.5 py-1 rounded-full">{claims.length}</span>
      </div>

      {loading ? (
        <div className="flex-1 flex justify-center py-10">
          <Spinner size={20} className="text-slate-400" />
        </div>
      ) : claims.length === 0 ? (
        <div className="flex-1 flex flex-col items-center gap-2 text-center py-10 px-5 text-slate-400">
          <Inbox className="w-5 h-5 text-slate-300" />
          <p className="text-sm">No claims yet — check in from the Movement Claim card when you head out.</p>
        </div>
      ) : (
        <div className="flex-1 overflow-y-auto divide-y divide-white/40">
          {claims.map((c) => {
            // undefined = lookup not resolved yet, null = it resolved to nothing
            // (falls back to plain coordinates below), string = the place name.
            const checkInAddr = addresses[`in-${c.id}`];
            const checkOutAddr = addresses[`out-${c.id}`];
            const checkInLabel =
              checkInAddr !== undefined
                ? checkInAddr ?? `${c.check_in_lat.toFixed(5)}, ${c.check_in_lng.toFixed(5)}`
                : 'Locating…';
            const checkOutLabel =
              checkOutAddr !== undefined
                ? checkOutAddr ?? `${(c.check_out_lat as number).toFixed(5)}, ${(c.check_out_lng as number).toFixed(5)}`
                : 'Locating…';
            return (
            // Was a single <button> covering the whole row (tap -> location map).
            // Now a plain <div> instead, since an open claim needs its own nested
            // "Check Out" button below and a <button> can't contain a <button>.
            <div key={c.id} className="px-5 py-3 hover:bg-white/40 transition-colors space-y-1.5">
              <button
                type="button"
                onClick={() => setViewingLocation(c)}
                className="w-full text-left active:bg-white/50 -mx-5 px-5 space-y-1.5"
              >
                <div className="flex items-start justify-between gap-3">
                  <span className="text-sm font-medium text-slate-900 truncate">{c.purpose}</span>
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

                {c.check_out_at ? (
                  // Completed claim — ride-history-style route: a filled dot for
                  // the Check In point, a dashed connector, then a filled dot for
                  // the Check Out point, each next to its (reverse-geocoded) place
                  // name and timestamp — same visual language as the pickup/drop-off
                  // list on a ride-hailing app's trip history.
                  <div className="flex items-start gap-2.5 pt-0.5">
                    <div className="flex flex-col items-center pt-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" />
                      <span className="w-px flex-1 min-h-[22px] border-l border-dashed border-slate-300" />
                      <span className="w-2 h-2 rounded-full bg-violet-600 shrink-0" />
                    </div>
                    <div className="flex-1 min-w-0 space-y-2.5">
                      <div>
                        <p className="text-[11px] text-slate-700 leading-snug truncate">{checkInLabel}</p>
                        <p className="text-[10px] text-emerald-700">
                          {formatDate(c.check_in_at)} {new Date(c.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </p>
                      </div>
                      <div>
                        <p className="text-[11px] text-slate-700 leading-snug truncate">{checkOutLabel}</p>
                        <p className="text-[10px] text-blue-700">
                          {formatDate(c.check_out_at)} {new Date(c.check_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          {c.distance_km != null ? ` · ${c.distance_km} km` : ''}
                        </p>
                      </div>
                    </div>
                  </div>
                ) : (
                  <>
                    <div className="flex flex-wrap items-center gap-2 text-[11px] text-slate-500">
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <LogIn className="w-3 h-3" />
                        {formatDate(c.check_in_at)} {new Date(c.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                    </div>
                    <p className="text-[11px] text-slate-400">Not checked out yet.</p>
                  </>
                )}

                <div className="flex items-center gap-1 text-[11px] font-semibold text-blue-600">
                  <MapPin className="w-3 h-3" /> View movement location <ChevronRight className="w-3 h-3" />
                </div>
              </button>

              {/* Only the still-open claim gets this — lets the User complete it
                  right here instead of going back to the Movement Claim page's
                  floating button. Opens the same "Add Check In/Out" sheet/form
                  the parent already uses (see onCheckOut on the props above). */}
              {c.status === 'open' && onCheckOut && (
                <button
                  type="button"
                  onClick={onCheckOut}
                  className="w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-lg py-2 transition-colors"
                >
                  <LogOut className="w-3.5 h-3.5" /> Check Out
                </button>
              )}
            </div>
            );
          })}
        </div>
      )}

      {viewingLocation && <ClaimLocationMap claim={viewingLocation} onClose={() => setViewingLocation(null)} />}
    </div>
  );
};