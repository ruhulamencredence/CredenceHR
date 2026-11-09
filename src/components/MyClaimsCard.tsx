/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useLiveTick } from '../lib/liveRefresh';
import React, { useEffect, useState } from 'react';
import { ArrowLeft, LogIn, LogOut, Inbox, MapPin, Map as MapIcon } from 'lucide-react';
import { CardButton, SelfCard } from './SelfCard';
import { ClaimRecord } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { reverseGeocode } from '../lib/reverseGeocode';
import ClaimLocationMap from './ClaimLocationMap';
import { LoadingBlock } from './LoadingBlock';

interface MyClaimsCardProps {
  token: string;
  // Present only on mobile, where this card is one of the tile-menu sections —
  // same "Back to Menu" pattern the Jobs / Entries cards already use. Omit (or
  // pass undefined) on desktop where the card is just always visible.
  onBack?: () => void;
  // Bump this (e.g. ++) to force a re-fetch — used by the Check In/Out page's
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
  // Web (desktop) Check In/Out page: shown under the Check In/Out form as a
  // normal card with its own title, instead of the full-screen mobile page.
  desktop?: boolean;
}

type ClaimFilter = 'all' | 'open' | 'completed';

// User Dashboard -> "My Claims" — a dedicated card of its own (same visual treatment
// as the Jobs summary card next to it), listing every Check In/Out this user has
// made. Tapping a claim's row opens ClaimLocationMap to show exactly where the Check
// In/Check Out happened, same as from the compact history list in MyClaimsModal; a
// still-open claim also gets its own "Check Out" button so the User can complete it
// without leaving this list.
export const MyClaimsCard: React.FC<MyClaimsCardProps> = ({ token, onBack, refreshKey, onCheckOut, desktop }) => {
  // All / Open / Completed — so finished claims are easy to find.
  const [filter, setFilter] = useState<ClaimFilter>('all');
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [viewingLocation, setViewingLocation] = useState<ClaimRecord | null>(null);
  // Reverse-geocoded place names for each completed claim's Check In/Out point,
  // keyed by `in-${claim.id}` / `out-${claim.id}` — filled in lazily below so the
  // ride-history-style route (dot -> dashed line -> dot) can show real place
  // names instead of raw coordinates. Missing key = still loading; null = the
  // lookup failed/found nothing (falls back to the plain coordinates).
  const [addresses, setAddresses] = useState<Record<string, string | null>>({});
  // In the phone app the server sends the last 3 months only (X-History-Limited).
  const [limited, setLimited] = useState(false);

  // Live refresh: claim statuses update without a page reload.
  const liveTick = useLiveTick();
  useEffect(() => {
    let cancelled = false;
    (async () => {
      // A live refresh updates quietly; only the first load shows the spinner.
      if (liveTick === 0) setLoading(true);
      try {
        const res = await fetch(apiUrl('/api/claims/mine'), { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) {
          setLimited(res.headers.get('X-History-Limited') === '3-months');
          setClaims(await res.json());
        }
      } catch {
        // Offline/unreachable — just show the empty state below.
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, refreshKey, liveTick]);

  useEffect(() => {
    let cancelled = false;
    claims
      .filter((c) => c.status === 'completed' && c.check_out_lat != null && c.check_out_lng != null)
      .forEach((c) => {
        // check_in_lat/lng etc. are DECIMAL columns server-side, which node-postgres
        // (and this API's plain res.json() typing) hands back as numeric *strings*
        // despite ClaimRecord's `number` type — same reason ClaimLocationMap.tsx
        // wraps every one of these fields in Number(...) before using them.
        // Skipping that here throws inside toFixed/reverseGeocode and crashes the
        // whole render tree (blank screen), so every read below goes through Number().
        reverseGeocode(Number(c.check_in_lat), Number(c.check_in_lng)).then((addr) => {
          if (!cancelled) setAddresses((prev) => ({ ...prev, [`in-${c.id}`]: addr }));
        });
        reverseGeocode(Number(c.check_out_lat), Number(c.check_out_lng)).then((addr) => {
          if (!cancelled) setAddresses((prev) => ({ ...prev, [`out-${c.id}`]: addr }));
        });
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claims]);

  const shown = filter === 'all' ? claims : claims.filter((c) => c.status === filter);

  return (
    // On mobile this card is rendered as a dedicated page (both call
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
    <div
      className={
        desktop
          ? 'mt-4 bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col'
          : // Phone: the cards sit straight on the page under the blended
            // header (Navbar.tsx), no panel around them; room at the bottom
            // for the floating "Add Check In/Out" button.
            'flex flex-col pb-24 min-h-[calc(100dvh-14rem)]'
      }
    >
      {/* Desktop only — on a phone the blended header has its own round Back. */}
      {onBack && desktop && (
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
      <div className={desktop ? 'flex items-center gap-3 px-5 py-4 border-b shrink-0 border-slate-100' : 'shrink-0 px-1 pt-2 pb-1'}>
        {desktop && <h3 className="text-sm font-bold text-slate-900">My Check In/Out</h3>}
        <div
          className={
            desktop
              ? 'flex-1 flex items-center gap-1 rounded-full bg-white/60 p-1 text-xs font-semibold max-w-sm ml-auto'
              : 'grid grid-cols-3 gap-1 rounded-full bg-white/75 border border-white/90 p-[5px] text-[13px] font-semibold shadow-[0_10px_30px_-14px_rgba(var(--g-accent-rgb,127,0,255),.3)]'
          }
        >
          {(
            [
              ['all', 'All', claims.length],
              ['open', 'Open', claims.filter((c) => c.status === 'open').length],
              ['completed', 'Completed', claims.filter((c) => c.status === 'completed').length]
            ] as [ClaimFilter, string, number][]
          ).map(([key, label, n]) => (
            <button
              key={key}
              type="button"
              onClick={() => setFilter(key)}
              aria-pressed={filter === key}
              className={
                desktop
                  ? `flex-1 inline-flex items-center justify-center gap-1 py-1.5 rounded-full transition-colors ${
                      filter === key ? 'bg-indigo-600 text-white shadow-sm' : 'text-slate-500 hover:text-slate-700'
                    }`
                  : `min-h-[40px] inline-flex items-center justify-center gap-1.5 rounded-full transition-colors ${filter === key ? 'text-white' : 'text-zinc-600'}`
              }
              style={!desktop && filter === key ? { background: 'var(--g-accent, #7f00ff)', boxShadow: '0 6px 14px -6px rgba(var(--g-accent-rgb,127,0,255),.6)' } : undefined}
            >
              {label}
              <span
                className={`min-w-[18px] h-[18px] px-1 rounded-full text-[10px] inline-flex items-center justify-center ${
                  filter === key ? 'bg-white/25' : desktop ? 'bg-slate-200' : 'bg-slate-900/[.06] font-bold'
                }`}
              >
                {n}
              </span>
            </button>
          ))}
        </div>
      </div>

      {limited && !loading && <p className="px-4 pb-1 text-[11px] text-slate-400">Showing the last 3 months here. Open CredenceHR on the website to see everything.</p>}
      {loading ? (
        <LoadingBlock />
      ) : shown.length === 0 ? (
        <div
          className={
            desktop
              ? 'flex-1 flex flex-col items-center gap-2 text-center py-10 px-5 text-slate-400'
              : 'mx-1 mt-3 rounded-[24px] bg-white/80 flex flex-col items-center gap-2 text-center py-10 px-5 text-slate-400'
          }
        >
          <Inbox className="w-5 h-5 text-slate-300" />
          <p className="text-sm">
            {claims.length === 0
              ? 'No check in/out yet — check in from the Check In/Out card when you head out.'
              : filter === 'open'
                ? 'Nothing checked in right now.'
                : 'No completed check in/out yet.'}
          </p>
        </div>
      ) : (
        <div className={desktop ? 'max-h-[32rem] overflow-y-auto p-3 grid gap-2.5 sm:grid-cols-2 xl:grid-cols-3 content-start' : 'flex-1 px-1 pt-3 space-y-2.5'}>
          {shown.map((c) => {
            // undefined = lookup not resolved yet, null = it resolved to nothing
            // (falls back to plain coordinates below), string = the place name.
            const checkInAddr = addresses[`in-${c.id}`];
            const checkOutAddr = addresses[`out-${c.id}`];
            const checkInLabel =
              checkInAddr !== undefined
                ? checkInAddr ?? `${Number(c.check_in_lat).toFixed(5)}, ${Number(c.check_in_lng).toFixed(5)}`
                : 'Locating…';
            const checkOutLabel =
              checkOutAddr !== undefined
                ? checkOutAddr ?? `${Number(c.check_out_lat).toFixed(5)}, ${Number(c.check_out_lng).toFixed(5)}`
                : 'Locating…';
            // Phone: the shared Directory-style card (SelfCard) — amber while
            // open, green once checked out; the route and Check Out under it.
            if (!desktop) {
              const time = new Date(c.check_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
              return (
                <SelfCard
                  key={c.id}
                  tone={c.status === 'open' ? 'amber' : 'green'}
                  lead={<MapPin className="w-[18px] h-[18px]" />}
                  dot={c.status === 'open' ? 'amber' : undefined}
                  title={c.purpose}
                  sub={`${formatDate(c.check_in_at)} · ${time}`}
                  chips={[
                    ...(c.distance_km != null ? [{ label: `${Number(c.distance_km).toFixed(1)} km`, mono: true }] : []),
                    { label: c.status === 'open' ? 'Open' : 'Completed', tone: c.status === 'open' ? ('amber' as const) : ('green' as const) }
                  ]}
                  actions={
                    <CardButton label="Movement on the map" onClick={() => setViewingLocation(c)}>
                      <MapIcon className="w-3.5 h-3.5" />
                    </CardButton>
                  }
                >
                  <div className="rounded-2xl bg-white/55 border border-white/60 px-3 py-2 flex items-start gap-2.5">
                    <div className="flex flex-col items-center pt-1">
                      <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" />
                      {c.check_out_at && (
                        <>
                          <span className="w-px flex-1 min-h-[8px] border-l border-dashed border-slate-300" />
                          <span className="w-2 h-2 rounded-full bg-violet-600 shrink-0" />
                        </>
                      )}
                    </div>
                    <div className="flex-1 min-w-0 space-y-1 text-[11px] text-slate-600">
                      <p className="truncate">{checkInLabel}</p>
                      <p className="truncate">{c.check_out_at ? checkOutLabel : <span className="text-slate-400">Not checked out yet.</span>}</p>
                    </div>
                  </div>
                  {c.status === 'open' && onCheckOut && (
                    <button
                      type="button"
                      onClick={onCheckOut}
                      className="w-full min-h-[40px] flex items-center justify-center gap-1.5 text-[13px] font-bold text-white rounded-full active:scale-[0.99] transition-transform"
                      style={{ background: 'var(--g-accent, #7f00ff)' }}
                    >
                      <LogOut className="w-3.5 h-3.5" /> Check Out
                    </button>
                  )}
                </SelfCard>
              );
            }
            return (
            // Was a single <button> covering the whole row (tap -> location map).
            // Now a plain <div> instead, since an open claim needs its own nested
            // "Check Out" button below and a <button> can't contain a <button>.
            // Each claim gets its own rounded, bordered card with a gap below it
            // (space-y-2.5 on the list above) instead of a flush divided list —
            // makes it visually obvious these are separate, individual claims.
            <div
              key={c.id}
              className={
                desktop
                  ? 'rounded-2xl border border-white/60 bg-white/60 hover:bg-white/80 transition-colors px-4 py-3 space-y-1.5 shadow-[0_2px_10px_-4px_rgba(15,23,42,0.08)]'
                  : 'rounded-[24px] bg-white px-4 py-3.5 space-y-3 shadow-[0_10px_30px_-14px_rgba(var(--g-accent-rgb,127,0,255),.28),0_2px_6px_-2px_rgba(15,23,42,.06)]'
              }
            >
              {/* Purpose + Check In date/time, e.g. "Kakoli, 19-Sep-2026
                  4:24 PM" (on a phone: the purpose, the date and time under
                  it) — the status badge sits at the end of the same row. */}
              <div className="flex items-start justify-between gap-3">
                {desktop ? (
                  <span className="text-sm font-medium text-slate-900 truncate">
                    {c.purpose}, {formatDate(c.check_in_at)}{' '}
                    {new Date(c.check_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                  </span>
                ) : (
                  <span className="min-w-0">
                    <span className="block text-sm font-bold text-slate-900 truncate">{c.purpose}</span>
                    <span className="block text-[11.5px] font-medium text-zinc-500 mt-0.5">
                      {formatDate(c.check_in_at)} · {new Date(c.check_in_at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}
                    </span>
                  </span>
                )}
                <span
                  className={`shrink-0 font-semibold rounded-full border ${desktop ? 'text-[10px] px-2 py-0.5' : 'text-[11px] font-bold px-2.5 py-1 border-transparent'} ${
                    c.status === 'open'
                      ? 'bg-amber-50 text-amber-700 border-amber-200'
                      : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                  }`}
                >
                  {c.status === 'open' ? 'Open' : 'Completed'}
                </span>
              </div>

              {/* In/Out location names are the tappable bit now (styled as
                  hyperlinks) — tapping either opens the same movement-location
                  map, instead of a separate "View movement location" button. */}
              {c.check_out_at ? (
                // Completed claim — ride-history-style route: a filled dot for
                // the Check In point, a dashed connector, then a filled dot for
                // the Check Out point, each a clickable place-name link, same
                // visual language as the pickup/drop-off list on a ride-hailing
                // app's trip history.
                <div className={`flex items-start gap-2.5 ${desktop ? 'pt-0.5' : 'rounded-2xl bg-slate-50/80 px-3 py-2.5'}`}>
                  <div className="flex flex-col items-center pt-1">
                    <span className="w-2 h-2 rounded-full bg-emerald-600 shrink-0" />
                    <span className="w-px flex-1 min-h-[8px] border-l border-dashed border-slate-300" />
                    <span className="w-2 h-2 rounded-full bg-violet-600 shrink-0" />
                  </div>
                  <div className="flex-1 min-w-0 space-y-1.5">
                    <button
                      type="button"
                      onClick={() => setViewingLocation(c)}
                      className="block w-full text-left text-[11px] text-blue-600 hover:text-blue-700 underline underline-offset-2 decoration-blue-300 leading-snug truncate"
                    >
                      {checkInLabel}
                    </button>
                    <button
                      type="button"
                      onClick={() => setViewingLocation(c)}
                      className="block w-full text-left text-[11px] text-blue-600 hover:text-blue-700 underline underline-offset-2 decoration-blue-300 leading-snug truncate"
                    >
                      {checkOutLabel}
                    </button>
                  </div>
                </div>
              ) : (
                <div className={`flex items-start gap-2.5 ${desktop ? 'pt-0.5' : 'rounded-2xl bg-slate-50/80 px-3 py-2.5'}`}>
                  <LogIn className="w-3 h-3 text-emerald-700 shrink-0 mt-1" />
                  <div className="flex-1 min-w-0 space-y-1">
                    <button
                      type="button"
                      onClick={() => setViewingLocation(c)}
                      className="block w-full text-left text-[11px] text-blue-600 hover:text-blue-700 underline underline-offset-2 decoration-blue-300 leading-snug truncate"
                    >
                      {checkInLabel}
                    </button>
                    <p className="text-[11px] text-slate-400">Not checked out yet.</p>
                  </div>
                </div>
              )}

              {/* Only the still-open claim gets this — lets the User complete it
                  right here instead of going back to the Check In/Out page's
                  floating button. Opens the same "Add Check In/Out" sheet/form
                  the parent already uses (see onCheckOut on the props above). */}
              {c.status === 'open' && onCheckOut && (
                <button
                  type="button"
                  onClick={onCheckOut}
                  className={
                    desktop
                      ? 'w-full flex items-center justify-center gap-1.5 text-xs font-semibold text-white bg-indigo-600 hover:bg-indigo-700 active:bg-indigo-800 rounded-lg py-2 transition-colors'
                      : 'w-full min-h-[42px] flex items-center justify-center gap-1.5 text-[13px] font-bold text-white rounded-full active:scale-[0.99] transition-transform'
                  }
                  style={desktop ? undefined : { background: 'var(--g-accent, #7f00ff)' }}
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