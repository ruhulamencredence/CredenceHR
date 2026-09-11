/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { createPortal } from 'react-dom';
import { X, Clock, CheckCircle2, XCircle, AlertTriangle, Paperclip, Download, MessageSquare } from 'lucide-react';
import { AttendanceCorrection } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';

interface AttendanceCorrectionStatusModalProps {
  correction: AttendanceCorrection;
  projectName: string;
  onClose: () => void;
  // Only offered on a Rejected request — closes this modal and reopens the
  // Correct Attendance form (pre-filled fresh) so the User can submit a new
  // request for the same date.
  onEditAgain: () => void;
}

// "HH:MM:SS"/ISO -> "8:05 AM", same clock-face convention Timesheet's own
// formatTime uses, but reading straight off requested_check_in/out_at's plain
// "HH:MM" (these were never stored with a date/timezone, only what the User
// typed into the <input type="time">).
function formatRequestedTime(value?: string | null): string {
  if (!value) return '—';
  const match = String(value).match(/(\d{2}):(\d{2})/);
  if (!match) return '—';
  const h = Number(match[1]);
  const displayHour = h % 12 === 0 ? 12 : h % 12;
  const ampm = h < 12 ? 'AM' : 'PM';
  return `${displayHour}:${match[2]} ${ampm}`;
}

// Opened by tapping a Timesheet date row that already has a correction request
// sitting Pending or Rejected — shows exactly where that request stands: which
// link of the global Approval Chain it's currently waiting on (Pending), or
// who rejected it and why (Rejected), same as the Admin Panel's own Approvals
// queue but from the requester's side. Mirrors ConveyanceClaimDetailModal's
// look for the requested time/reason/attachment section.
export const AttendanceCorrectionStatusModal: React.FC<AttendanceCorrectionStatusModalProps> = ({
  correction,
  projectName,
  onClose,
  onEditAgain
}) => {
  const approval = correction.approval;
  const chainConfigured = !!approval;
  const isImage = (correction.file_mimetype || '').startsWith('image/');
  const fileUrl = apiUrl(`/api/attendance/corrections/${correction.id}/file`);
  const rejectAction = approval?.actions?.find((a) => a.action === 'rejected');
  const approveActions = (approval?.actions || []).filter((a) => a.action === 'approved');

  // Rendered via a portal straight onto document.body — same reasoning as
  // ConveyanceClaimDetailModal/AttendanceCorrectionModal: opened from deep
  // inside Timesheet's tree, and a `position: fixed` element nested inside an
  // `overflow-hidden` ancestor doesn't reliably pin to the full screen on
  // Android WebViews otherwise.
  return createPortal(
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center bg-black/40 backdrop-blur-sm p-0 sm:p-4">
      <div className="w-full sm:max-w-md bg-white rounded-t-2xl sm:rounded-2xl shadow-xl max-h-[92vh] overflow-y-auto">
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100 sticky top-0 bg-white z-10">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Attendance Correction</h3>
            <p className="text-xs text-slate-400">
              {formatDate(correction.attendance_date)} · Submitted {formatDate(correction.created_at)}
            </p>
          </div>
          <button type="button" onClick={onClose} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="p-5 space-y-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-sm font-semibold text-slate-700 truncate">{projectName}</span>
            {correction.status === 'pending' && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-amber-50 text-amber-700 shrink-0">
                <Clock className="w-3.5 h-3.5" /> Pending
              </span>
            )}
            {correction.status === 'rejected' && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 shrink-0">
                <XCircle className="w-3.5 h-3.5" /> Rejected
              </span>
            )}
            {correction.status === 'approved' && (
              <span className="inline-flex items-center gap-1 text-xs font-semibold px-2.5 py-1 rounded-full bg-emerald-50 text-emerald-700 shrink-0">
                <CheckCircle2 className="w-3.5 h-3.5" /> Approved
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Requested In Time</p>
              <p className="font-semibold text-slate-700 mt-0.5">{formatRequestedTime(correction.requested_check_in_at)}</p>
            </div>
            <div>
              <p className="text-[10px] uppercase tracking-wide text-slate-400">Requested Out Time</p>
              <p className="font-semibold text-slate-700 mt-0.5">{formatRequestedTime(correction.requested_check_out_at)}</p>
            </div>
          </div>

          {correction.remarks && (
            <div>
              <div className="text-[11px] font-semibold text-slate-400 mb-1">Your Reason</div>
              <p className="text-sm text-slate-700 whitespace-pre-wrap">{correction.remarks}</p>
            </div>
          )}

          {correction.has_file && (
            <div>
              <div className="text-[11px] font-semibold text-slate-400 mb-1.5">Attachment</div>
              {isImage ? (
                <a href={fileUrl} target="_blank" rel="noreferrer" className="block">
                  <img
                    src={fileUrl}
                    alt={correction.file_name || 'Attachment'}
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
                  <span className="truncate text-slate-700">{correction.file_name || 'View attachment'}</span>
                  <Download className="w-3.5 h-3.5 text-blue-600 ml-auto shrink-0" />
                </a>
              )}
            </div>
          )}

          {/* Approval Chain progress — one row per configured step: a filled
              checkmark for a step already acted on (with that approver's
              name), an amber clock on whichever step it's sitting on right
              now, and a hollow dot for every step still ahead. */}
          {chainConfigured && correction.status === 'pending' && approval!.total_steps > 0 && (
            <div>
              <div className="text-[11px] font-semibold text-slate-400 mb-2">Approval Progress</div>
              <div className="space-y-2">
                {Array.from({ length: approval!.total_steps }, (_, i) => i + 1).map((step) => {
                  const action = (approval!.actions || []).find((a) => a.step_order === step);
                  const isCurrent = !action && step === approval!.current_step;
                  return (
                    <div
                      key={step}
                      className={`flex items-center gap-2.5 text-xs px-3 py-2 rounded-xl border ${
                        action
                          ? 'bg-emerald-50 border-emerald-100'
                          : isCurrent
                          ? 'bg-amber-50 border-amber-200'
                          : 'bg-slate-50 border-slate-100'
                      }`}
                    >
                      {action ? (
                        <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600 shrink-0" />
                      ) : isCurrent ? (
                        <Clock className="w-3.5 h-3.5 text-amber-600 shrink-0" />
                      ) : (
                        <span className="w-3.5 h-3.5 rounded-full border-2 border-slate-300 shrink-0" />
                      )}
                      <div className="min-w-0">
                        <p
                          className={`font-semibold truncate ${
                            action ? 'text-emerald-700' : isCurrent ? 'text-amber-700' : 'text-slate-400'
                          }`}
                        >
                          {action ? action.approver_name : isCurrent ? approval!.current_approver_name || `Step ${step}` : `Step ${step}`}
                        </p>
                        {isCurrent && <p className="text-[10px] text-amber-600">Waiting for review</p>}
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {correction.status === 'rejected' && (
            <div className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">{rejectAction ? `Rejected by ${rejectAction.approver_name}` : 'Rejected'}</div>
                <p className="mt-0.5">{correction.admin_remarks || 'No reason was given.'}</p>
              </div>
            </div>
          )}

          {correction.status === 'approved' && (
            <div className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-700">
              <MessageSquare className="w-3.5 h-3.5 shrink-0 mt-0.5" />
              <div>
                <div className="font-semibold">
                  {approveActions.length > 0 ? `Approved by ${approveActions[approveActions.length - 1].approver_name}` : 'Approved'}
                </div>
                <p className="mt-0.5">{correction.admin_remarks || "This day's In/Out Time has been updated."}</p>
              </div>
            </div>
          )}

          {correction.status === 'rejected' && (
            <button
              type="button"
              onClick={onEditAgain}
              className="w-full mt-1 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-colors"
            >
              Submit a New Correction
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
