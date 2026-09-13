/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Paperclip, AlertTriangle, CheckCircle2, Clock } from 'lucide-react';
import { AttendanceRecord, Project } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface AttendanceCorrectionModalProps {
  token: string;
  dateStr: string;
  // Every attendance row already recorded for this date (almost always 0 or 1,
  // but a User checked into more than one Project the same day gets more than
  // one) — used to pre-fill In/Out Time and to build the Project picker when
  // the day isn't fully Absent.
  dayRecords: AttendanceRecord[];
  // Every Project the User could pick from when the day IS fully Absent (no
  // dayRecords at all) — the full, unfiltered Project list (GET
  // /api/projects/all), not the check-in-permission-filtered list
  // AttendanceCard's own Check In/Out uses, since a correction always goes
  // through the Approval Workflow regardless of check-in access.
  projects: Project[];
  // Superadmin/Admin-pinned Project for Remote Attendance (Admin Panel ->
  // Users -> "Attend. Project", users.attendance_project_id). When set, the
  // Project picker below is dropped entirely — the correction always targets
  // this one Project, whether the day being corrected was originally a
  // Remote (GPS) row, an Office Attendance (ZKT) row (which otherwise carries
  // the placeholder project_id 0 — see /api/attendance/mine), or fully
  // Absent. Undefined/null when this account isn't pinned, which keeps every
  // existing behavior below unchanged.
  pinnedProjectId?: number | null;
  onClose: () => void;
  onSubmitted: () => void;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB, matches NewConveyanceClaimModal's cap
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];

// "YYYY-MM-DD HH:MM:SS"/ISO -> "HH:MM" for pre-filling an <input type="time">.
// Slices the string directly rather than going through `new Date(...)` so this
// never drifts a display-hour off from what formatTime() already shows
// elsewhere in Timesheet (both read the same naive, no-timezone-suffix string
// the server hands back with dateStrings:true).
function toTimeInputValue(value?: string | null): string {
  if (!value) return '';
  const str = String(value);
  const match = str.match(/(\d{2}):(\d{2})/);
  return match ? `${match[1]}:${match[2]}` : '';
}

// Self Service -> Timesheet -> click any date's row. Lets the User manually
// set that day's In Time/Out Time — most commonly because the day shows
// Absent (no attendance row exists at all yet), but any day can be corrected
// (e.g. only the Out Time was missed). Never applied immediately: this always
// submits a request (POST /api/attendance/corrections) that goes through the
// same global Approval Workflow chain as Attendance Check In/Out and
// Conveyance Bill Claims, so it shows up in the existing Admin Panel ->
// Approvals queue — no separate review page. An optional reason for the edit
// and an optional Image/PDF attachment (5MB cap, same FileReader/Base64
// pattern as the Conveyance Bill Claim form).
export const AttendanceCorrectionModal: React.FC<AttendanceCorrectionModalProps> = ({
  token,
  dateStr,
  dayRecords,
  projects,
  pinnedProjectId,
  onClose,
  onSubmitted
}) => {
  // One option per distinct Project already recorded that day, or — when the
  // day is fully Absent — one option per Project the User has access to at
  // all. Auto-selects (and hides the dropdown for) the single-option case,
  // same convention AttendanceCard's own Check In/Out uses.
  //
  // Pinned-Project override: once an account is locked to one Project for
  // Attendance, that's the only option here too, full stop — even a day
  // whose only existing row is the Office Attendance (ZKT) placeholder
  // (project_id 0, name "Office Attendance") or, for older data, some other
  // Project than the one now pinned. The In/Out Time still pre-fills from
  // whatever row that day actually has (there's realistically at most one),
  // just filed under the pinned Project instead.
  const options = pinnedProjectId
    ? [{
        id: pinnedProjectId,
        name: projects.find((p) => p.id === pinnedProjectId)?.project_name || `Project #${pinnedProjectId}`,
        record: (dayRecords[0] as AttendanceRecord | undefined) || null
      }]
    : dayRecords.length > 0
      ? dayRecords.map((r) => ({ id: r.project_id, name: r.project_name || `Project #${r.project_id}`, record: r as AttendanceRecord | null }))
      : projects.map((p) => ({ id: p.id, name: p.project_name, record: null as AttendanceRecord | null }));

  const [projectId, setProjectId] = useState<number | ''>(options.length > 0 ? options[0].id : '');
  const [checkInTime, setCheckInTime] = useState(options.length > 0 ? toTimeInputValue(options[0].record?.check_in_at) : '');
  const [checkOutTime, setCheckOutTime] = useState(options.length > 0 ? toTimeInputValue(options[0].record?.check_out_at) : '');
  const [remarks, setRemarks] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  useBackButtonClose(true, submitting ? () => {} : onClose);

  // Re-fill In/Out Time from whichever Project's own record the User switches
  // the dropdown to (blank if that Project has no record yet that day).
  const handleProjectChange = (id: number) => {
    setProjectId(id);
    const match = options.find((o) => o.id === id);
    setCheckInTime(toTimeInputValue(match?.record?.check_in_at));
    setCheckOutTime(toTimeInputValue(match?.record?.check_out_at));
  };

  const handleFilePick = (f: File | null) => {
    setFileError('');
    if (!f) {
      setFile(null);
      return;
    }
    if (f.size > MAX_FILE_BYTES) {
      setFileError('File must be 5MB or smaller.');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    if (f.type && !ACCEPTED_TYPES.includes(f.type)) {
      setFileError('Only images or PDF files are accepted.');
      setFile(null);
      if (fileInputRef.current) fileInputRef.current.value = '';
      return;
    }
    setFile(f);
  };

  const validate = (): string | null => {
    if (projectId === '' || projectId === null || projectId === undefined) return 'Select a Project.';
    if (!checkInTime && !checkOutTime) return 'Enter an In Time or Out Time to correct.';
    return null;
  };

  const handleSubmit = async () => {
    const validationError = validate();
    if (validationError) {
      setError(validationError);
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      let file_base64: string | undefined;
      if (file) {
        file_base64 = await new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
          reader.onerror = () => reject(new Error('Could not read the attached file.'));
          reader.readAsDataURL(file);
        });
      }

      const res = await fetch(apiUrl('/api/attendance/corrections'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          project_id: projectId,
          attendance_date: dateStr,
          check_in_at: checkInTime ? `${dateStr} ${checkInTime}:00` : undefined,
          check_out_at: checkOutTime ? `${dateStr} ${checkOutTime}:00` : undefined,
          remarks: remarks.trim() || undefined,
          ...(file_base64 ? { file_base64, file_name: file!.name, file_mimetype: file!.type } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit correction request');
      onSubmitted();
    } catch (err: any) {
      setError(err.message || 'Failed to submit correction request');
    } finally {
      setSubmitting(false);
    }
  };

  // Rendered via a portal straight onto document.body — same reasoning as
  // NewConveyanceClaimModal/AttendanceMapConfirm: this gets opened from deep
  // inside Timesheet's tree, and a `position: fixed` element nested inside an
  // `overflow-hidden` ancestor doesn't reliably pin to the full screen on
  // Android WebViews otherwise.
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
      style={{
        paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)',
        paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)'
      }}
    >
      <div className="bg-white border border-slate-200 rounded-2xl max-w-md w-full overflow-hidden shadow-2xl flex flex-col" style={{ maxHeight: '100%' }}>
        <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold text-slate-900">Correct Attendance</h3>
            <p className="text-xs text-slate-500 mt-0.5">{formatDate(dateStr)}</p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-40"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        <div className="p-5 space-y-4 overflow-y-auto min-h-0">
          {options.length === 0 ? (
            <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-amber-50 text-amber-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>You don&apos;t have any Project to correct attendance against.</span>
            </div>
          ) : (
            <>
              {options.length > 1 && (
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">Project *</label>
                  <select
                    value={projectId}
                    onChange={(e) => handleProjectChange(Number(e.target.value))}
                    className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  >
                    {options.map((o) => (
                      <option key={o.id} value={o.id}>
                        {o.name}
                      </option>
                    ))}
                  </select>
                </div>
              )}
              {options.length === 1 && (
                <div className="text-xs text-slate-500 flex items-center gap-1.5">
                  <Clock className="w-3.5 h-3.5 text-slate-400" /> {options[0].name}
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">In Time</label>
                  <input
                    type="time"
                    value={checkInTime}
                    onChange={(e) => setCheckInTime(e.target.value)}
                    className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold text-slate-500 mb-1">Out Time</label>
                  <input
                    type="time"
                    value={checkOutTime}
                    onChange={(e) => setCheckOutTime(e.target.value)}
                    className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">Reason for editing (optional)</label>
                <textarea
                  value={remarks}
                  onChange={(e) => setRemarks(e.target.value)}
                  rows={3}
                  maxLength={1000}
                  placeholder="e.g. Forgot to Check Out after the site visit"
                  className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none resize-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold text-slate-500 mb-1">Attachment (optional, image/PDF, up to 5MB)</label>
                <label className="flex items-center gap-2 text-sm px-3 py-2.5 bg-slate-50 border border-dashed border-slate-300 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                  <Paperclip className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="text-slate-600 truncate">{file ? file.name : 'Choose a file\u2026'}</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,application/pdf"
                    onChange={(e) => handleFilePick(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                </label>
                {fileError && <p className="mt-1 text-[11px] text-rose-600">{fileError}</p>}
              </div>
            </>
          )}

          {error && (
            <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        <div className="p-5 border-t border-slate-200 flex justify-end gap-3 shrink-0">
          <button
            type="button"
            onClick={onClose}
            disabled={submitting}
            className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 disabled:opacity-50 text-slate-700 text-sm font-semibold rounded-xl border border-slate-200"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={submitting || options.length === 0}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-all shadow-sm"
          >
            {submitting ? <Spinner size={16} /> : <CheckCircle2 className="w-4 h-4" />}
            Apply
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};