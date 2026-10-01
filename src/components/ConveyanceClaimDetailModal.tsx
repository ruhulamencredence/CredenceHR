/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { X, Paperclip, Download, CalendarRange, MessageSquare, AlertTriangle, Route, Clock } from 'lucide-react';
import { UserClaim } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { UserClaimStatusBadge } from './UserClaimStatusBadge';

interface ConveyanceClaimDetailModalProps {
  claim: UserClaim;
  onClose: () => void;
}

// Opened by tapping a row in "My Conveyance Claims" — shows everything the
// compact history row doesn't have room for: Description, Date Range, a File
// Preview/Download link (if an attachment was uploaded), and Admin Remarks
// whenever the claim has been reviewed (always shown on Rejected, optionally
// present on Approved).
export const ConveyanceClaimDetailModal: React.FC<ConveyanceClaimDetailModalProps> = ({ claim, onClose }) => {
  const isImage = (claim.file_mimetype || '').startsWith('image/');
  const fileUrl = apiUrl(`/api/user-claims/${claim.id}/file`);

  // Rendered via a portal straight onto document.body instead of in place —
  // this row is opened from ConveyanceClaimCard, which sits inside
  // UserPanel's dashboard tree, which has an `overflow-hidden` ancestor. On
  // a number of Android WebViews a `position: fixed` element nested inside
  // `overflow: hidden` doesn't truly pin to the full device screen — it gets
  // clipped to that ancestor's box instead, which is what was pushing this
  // modal under BottomNav. Escaping to document.body via a portal sidesteps
  // that ancestor entirely (same fix as NewConveyanceClaimModal/
  // AttendanceMapConfirm/ClaimMapConfirm).
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <div>
            <h3 className="text-sm font-bold text-slate-900">{claim.category} Claim</h3>
            <p className="text-xs text-slate-400">Submitted {formatDate(claim.created_at)}</p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between">
            <span className="text-xl font-bold text-slate-900">
              ৳{Number(claim.amount).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <UserClaimStatusBadge status={claim.status} />
          </div>

          {claim.status === 'pending' && claim.approval?.current_approver_name && (
            <div className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl bg-amber-50 text-amber-700">
              <Clock className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">
                  Waiting on {claim.approval.current_approver_name}
                </div>
                {claim.approval.total_steps > 1 && (
                  <p className="mt-0.5">
                    Layer {claim.approval.current_step} of {claim.approval.total_steps}
                  </p>
                )}
              </div>
            </div>
          )}

          <div className="flex items-start gap-2 text-sm text-slate-600">
            <CalendarRange className="w-4 h-4 text-slate-400 mt-0.5 shrink-0" />
            <div>
              <div className="text-[11px] font-semibold text-slate-400">Claim Date</div>
              <div>{formatDate(claim.claim_date)}</div>
              {String(claim.from_date) !== String(claim.to_date) && (
                <div className="text-xs text-slate-500 mt-1">
                  Covers {formatDate(claim.from_date)} \u2192 {formatDate(claim.to_date)}
                </div>
              )}
            </div>
          </div>

          {claim.claim_refs && claim.claim_refs.length > 0 && (
            <div>
              <div className="text-[11px] font-semibold text-slate-400 mb-1.5">
                Referenced Check In/Out ({claim.claim_refs.length})
              </div>
              <div className="space-y-1.5">
                {claim.claim_refs.map((r) => (
                  <div key={r.claim_id} className="flex items-start justify-between gap-3 text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg">
                    <div className="flex items-start gap-1.5 min-w-0">
                      <Route className="w-3.5 h-3.5 text-slate-400 mt-0.5 shrink-0" />
                      <div className="min-w-0">
                        <div className="text-slate-700 font-medium truncate">{r.purpose}</div>
                        <div className="text-[11px] text-slate-500">
                          {formatDate(r.check_in_at)}
                          {r.check_out_at
                            ? ` \u00b7 ${new Date(r.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} \u2192 ${new Date(
                                r.check_out_at
                              ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                            : ''}
                          {r.distance_km != null ? ` \u00b7 ${r.distance_km} km` : ''}
                        </div>
                      </div>
                    </div>
                    <span className="shrink-0 font-semibold text-slate-900">
                      ৳{Number(r.amount).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}

          {claim.description && (
            <div>
              <div className="text-[11px] font-semibold text-slate-400 mb-1">Description</div>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{claim.description}</p>
            </div>
          )}

          {claim.has_file && (
            <div>
              <div className="text-[11px] font-semibold text-slate-400 mb-1.5">Attachment</div>
              {isImage ? (
                <a href={fileUrl} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={fileUrl}
                    alt={claim.file_name || 'Attachment'}
                    className="w-full max-h-56 object-contain rounded-xl border border-slate-200 bg-slate-50"
                  />
                </a>
              ) : (
                <a
                  href={fileUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="flex items-center gap-2 text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl hover:bg-slate-100 transition-colors"
                >
                  <Paperclip className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="truncate text-slate-700">{claim.file_name || 'View attachment'}</span>
                  <Download className="w-3.5 h-3.5 text-blue-600 ml-auto shrink-0" />
                </a>
              )}
            </div>
          )}

          {claim.status === 'rejected' && claim.admin_remarks && (
            <div className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">Admin Remarks</div>
                <p className="mt-0.5">{claim.admin_remarks}</p>
              </div>
            </div>
          )}

          {claim.status === 'approved' && claim.admin_remarks && (
            <div className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-700">
              <MessageSquare className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">Admin Remarks</div>
                <p className="mt-0.5">{claim.admin_remarks}</p>
              </div>
            </div>
          )}

          {claim.status === 'approved' && (
            <p className="text-[11px] text-slate-400">
              Attached to Conveyance Bill #{claim.bill_id} for reimbursement processing.
            </p>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};