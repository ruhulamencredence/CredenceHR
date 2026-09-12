/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Wallet, ChevronDown, ChevronUp, Paperclip, Inbox, Banknote, MapPin } from 'lucide-react';
import { ConveyanceBill, UserClaim, UserClaimReference, ClaimRecord, User } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { UserClaimStatusBadge } from './UserClaimStatusBadge';
import ClaimLocationMap from './ClaimLocationMap';
import { Spinner } from './Spinner';

interface MyConveyanceBillClaimPanelProps {
  token: string;
  user: User;
}

// Admin Panel -> Claims -> "My Conveyance Bill Claim" — for an Admin who has
// been granted the "conveyance" module (so they review/build every OTHER
// employee's bills on the Conveyance Bill Claim tab) but has NOT separately
// been granted can_view_conveyance_claims/can_access_user_panel (the User
// Panel's own "Conveyance Bill Claim" self-service section). Without this
// page such an Admin had literally nowhere to see the Bills/Claims that
// belong to THEM — the admin tab shows everyone, the self-service tab isn't
// reachable at all. Read-only by design: this is that Admin looking at their
// own record, not reviewing someone else's, so no Approve/Reject/Edit/Delete
// here regardless of what the "conveyance" module would otherwise allow them
// to do on someone else's claim. Reuses the exact same two endpoints the
// Conveyance Bill Claim admin tab already calls (GET /api/conveyance-bills and
// GET /api/user-claims), just scoped with ?user_id=<self> — both routes only
// require the "conveyance"/"disbursement" module already granted to get here,
// so no new permission or backend route was needed for this view.
export const MyConveyanceBillClaimPanel: React.FC<MyConveyanceBillClaimPanelProps> = ({ token, user }) => {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const [bills, setBills] = useState<ConveyanceBill[]>([]);
  const [claims, setClaims] = useState<UserClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedBillId, setExpandedBillId] = useState<number | null>(null);
  const [viewingRef, setViewingRef] = useState<UserClaimReference | null>(null);

  const refToClaimRecord = (ref: UserClaimReference): ClaimRecord => ({
    id: ref.claim_id,
    user_id: user.id,
    user_name: user.name,
    purpose: ref.purpose,
    status: ref.check_out_at ? 'completed' : 'open',
    check_in_at: ref.check_in_at,
    check_in_lat: Number(ref.check_in_lat),
    check_in_lng: Number(ref.check_in_lng),
    check_out_at: ref.check_out_at,
    check_out_lat: ref.check_out_lat != null ? Number(ref.check_out_lat) : null,
    check_out_lng: ref.check_out_lng != null ? Number(ref.check_out_lng) : null,
    distance_km: ref.distance_km,
    check_in_approval: ref.check_in_approval,
    check_out_approval: ref.check_out_approval
  });

  const fetchAll = async () => {
    setLoading(true);
    try {
      const [billsRes, claimsRes] = await Promise.all([
        fetch(apiUrl(`/api/conveyance-bills?user_id=${user.id}`), { headers: authHeaders }),
        fetch(apiUrl(`/api/user-claims?user_id=${user.id}`), { headers: authHeaders })
      ]);

      let billsList: ConveyanceBill[] = [];
      if (billsRes.ok) billsList = await billsRes.json();
      if (claimsRes.ok) setClaims(await claimsRes.json());

      // The list endpoint only returns item_count/total_amount — pull each
      // bill's own items (same detail endpoint the Admin tab's own table
      // uses) so this page can show what's actually inside each one.
      const withItems = await Promise.all(
        billsList.map(async (b) => {
          try {
            const res = await fetch(apiUrl(`/api/conveyance-bills/${b.id}`), { headers: authHeaders });
            if (!res.ok) return b;
            const detail: ConveyanceBill = await res.json();
            return { ...b, items: detail.items || [] };
          } catch {
            return b;
          }
        })
      );
      setBills(withItems);
    } catch (err) {
      console.error('Failed to load my conveyance bills/claims', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user.id]);

  const totalOf = (b: ConveyanceBill) =>
    b.total_amount != null ? Number(b.total_amount) : (b.items || []).reduce((sum, i) => sum + Number(i.amount || 0), 0);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2.5">
        <div className="p-2 bg-indigo-50 rounded-lg">
          <Wallet className="w-5 h-5 text-indigo-600" />
        </div>
        <div>
          <h2 className="text-lg font-semibold text-slate-900">My Conveyance Bill Claim</h2>
          <p className="text-xs text-slate-500">
            Your own Conveyance Bills and Claims — view only. Reviewing everyone else's is on the Conveyance Bill Claim tab.
          </p>
        </div>
      </div>

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner size={24} className="text-slate-400" />
        </div>
      ) : (
        <>
          {/* Bills — built for you by an Admin (manual entries and/or pulled in
              from your own completed Movement Claims). */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-800">My Bills</h3>
              <p className="text-xs text-slate-400">Conveyance Bills built for you</p>
            </div>
            {bills.length === 0 ? (
              <div className="flex flex-col items-center gap-2 text-center py-8 px-4 text-slate-400">
                <Inbox className="w-5 h-5 text-slate-300" />
                <p className="text-sm">No Conveyance Bills yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {bills.map((b) => {
                  const expanded = expandedBillId === b.id;
                  return (
                    <div key={b.id}>
                      <button
                        type="button"
                        onClick={() => setExpandedBillId(expanded ? null : b.id)}
                        className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                      >
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900">
                            Bill #{b.id} &middot; {formatDate(b.bill_date)}
                          </div>
                          <div className="text-xs text-slate-500 mt-0.5">
                            {b.item_count ?? (b.items || []).length} item(s)
                            {b.remarks ? ` · ${b.remarks}` : ''}
                          </div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <span className="text-sm font-semibold text-slate-800">
                            ৳{totalOf(b).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                          </span>
                          {b.is_disbursed ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700 border border-emerald-200">
                              <Banknote className="w-2.5 h-2.5" /> Disbursed{b.voucher_no ? ` (${b.voucher_no})` : ''}
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-500 border border-slate-200">
                              Not disbursed
                            </span>
                          )}
                          {expanded ? (
                            <ChevronUp className="w-3.5 h-3.5 text-slate-400" />
                          ) : (
                            <ChevronDown className="w-3.5 h-3.5 text-slate-400" />
                          )}
                        </div>
                      </button>

                      {expanded && (
                        <div className="px-4 pb-3">
                          <div className="border border-slate-200 rounded-lg overflow-x-auto">
                            <table className="min-w-full text-xs">
                              <thead>
                                <tr className="bg-slate-50 text-slate-500">
                                  <th className="px-3 py-2 text-left font-semibold">Date</th>
                                  <th className="px-3 py-2 text-left font-semibold">Particulars</th>
                                  <th className="px-3 py-2 text-left font-semibold">Route</th>
                                  <th className="px-3 py-2 text-right font-semibold">Distance</th>
                                  <th className="px-3 py-2 text-right font-semibold">Amount</th>
                                </tr>
                              </thead>
                              <tbody className="divide-y divide-slate-100">
                                {(b.items || []).map((item) => (
                                  <tr key={item.id}>
                                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">{formatDate(item.entry_date)}</td>
                                    <td className="px-3 py-2 text-slate-800">{item.particulars}</td>
                                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">
                                      {item.from_location || item.to_location
                                        ? `${item.from_location || '—'} → ${item.to_location || '—'}`
                                        : <span className="text-slate-300">—</span>}
                                    </td>
                                    <td className="px-3 py-2 whitespace-nowrap text-right text-slate-600">
                                      {item.distance_km != null ? `${item.distance_km} km` : <span className="text-slate-300">—</span>}
                                    </td>
                                    <td className="px-3 py-2 whitespace-nowrap text-right font-semibold text-slate-800">
                                      ৳{Number(item.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                                    </td>
                                  </tr>
                                ))}
                              </tbody>
                            </table>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          {/* Direct Claims — anything you submitted yourself through the User
              Panel's own "Conveyance Bill Claim" section, if you've ever had
              access to it. */}
          <div className="bg-white border border-slate-200 rounded-lg overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-100">
              <h3 className="text-sm font-semibold text-slate-800">My Claim Submissions</h3>
              <p className="text-xs text-slate-400">Direct expense claims you submitted</p>
            </div>
            {claims.length === 0 ? (
              <div className="flex flex-col items-center gap-2 text-center py-8 px-4 text-slate-400">
                <Inbox className="w-5 h-5 text-slate-300" />
                <p className="text-sm">No claim submissions yet.</p>
              </div>
            ) : (
              <div className="divide-y divide-slate-100">
                {claims.map((c) => {
                  const hasRefs = !!c.claim_refs && c.claim_refs.length > 0;
                  return (
                    <div key={c.id} className="px-4 py-3 space-y-1.5">
                      <div className="flex items-start justify-between gap-3">
                        <div className="min-w-0">
                          <div className="text-sm font-medium text-slate-900">
                            {formatDate(c.claim_date)}
                            {String(c.from_date) !== String(c.to_date) && (
                              <span className="text-xs text-slate-400"> (covers {formatDate(c.from_date)} → {formatDate(c.to_date)})</span>
                            )}
                          </div>
                          <div className="text-xs text-slate-500">
                            {c.category} &middot; ৳{Number(c.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                          </div>
                        </div>
                        <UserClaimStatusBadge status={c.status} />
                      </div>

                      {c.description && <p className="text-xs text-slate-600">{c.description}</p>}

                      {hasRefs && (
                        <div className="space-y-1">
                          {c.claim_refs!.map((r) => (
                            <button
                              key={r.claim_id}
                              type="button"
                              onClick={() => setViewingRef(r)}
                              title="View check-in/out location"
                              className="w-full flex items-center justify-between gap-2 text-[11px] px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 rounded-lg transition-colors text-left"
                            >
                              <span className="flex items-center gap-1 text-slate-600 min-w-0 truncate">
                                <MapPin className="w-3 h-3 text-blue-500 shrink-0" />
                                {formatDate(r.check_in_at)} &middot; {r.purpose}
                              </span>
                              <span className="shrink-0 font-semibold text-slate-800">
                                ৳{Number(r.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}

                      {c.has_file && (
                        <a
                          href={apiUrl(`/api/user-claims/${c.id}/file`)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-blue-600 font-semibold hover:underline"
                        >
                          <Paperclip className="w-3 h-3" /> View attachment
                        </a>
                      )}

                      {c.status !== 'pending' && c.admin_remarks && (
                        <p className="text-xs text-slate-500">
                          <span className="font-semibold text-slate-600">Remarks:</span> {c.admin_remarks}
                        </p>
                      )}
                      {c.status === 'approved' && c.bill_id && (
                        <p className="text-[11px] text-slate-400">Attached to Bill #{c.bill_id}.</p>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        </>
      )}

      {viewingRef && <ClaimLocationMap claim={refToClaimRecord(viewingRef)} onClose={() => setViewingRef(null)} />}
    </div>
  );
};
