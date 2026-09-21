/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Paperclip, AlertTriangle, CheckCircle2, Route } from 'lucide-react';
import { UserClaimCategory, USER_CLAIM_CATEGORIES, ClaimRecord } from '../types';
import { apiUrl } from '../lib/api';
import { todayDateOnlyString, formatDate } from '../lib/formatDate';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

interface NewConveyanceClaimModalProps {
  token: string;
  onClose: () => void;
  onSubmitted: () => void;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];

// "+ New Claim" submission form — opened from ConveyanceClaimCard as an inline
// modal (same pop-in treatment as the rest of the User Panel's forms). Every
// field/validation rule here matches the spec: Claim Date required, From/To Date
// range required with To >= From (covers multi-day tours), Category required,
// Amount required and > 0 (৳-formatted), Description optional (kept short),
// and an optional Image/PDF attachment up to 5MB — sent as file_base64/file_name/
// file_mimetype in the JSON body (same FileReader/Base64 pattern as the Budget
// Excel import), never multipart/multer.
export const NewConveyanceClaimModal: React.FC<NewConveyanceClaimModalProps> = ({ token, onClose, onSubmitted }) => {
  const today = todayDateOnlyString();
  const [claimDate, setClaimDate] = useState(today);
  const [fromDate, setFromDate] = useState(today);
  const [toDate, setToDate] = useState(today);
  const [category, setCategory] = useState<UserClaimCategory | ''>('');
  const [amount, setAmount] = useState('');
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Completed Movement Claims (check-in/out) the User can attach to this claim,
  // each with its own Amount — a check-in/out can only ever be referenced once,
  // so this list (GET /api/claims/available) already excludes anything already
  // referenced or billed. claimId -> amount-string map; a key's mere presence
  // means it's selected.
  const [availableClaims, setAvailableClaims] = useState<ClaimRecord[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(true);
  const [selectedRefs, setSelectedRefs] = useState<Record<number, string>>({});

  useBackButtonClose(true, submitting ? () => {} : onClose);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setLoadingClaims(true);
      try {
        const res = await fetch(apiUrl('/api/claims/available'), { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) setAvailableClaims(await res.json());
      } catch {
        // Offline/unreachable — picker just stays empty; manual Amount still works.
      } finally {
        if (!cancelled) setLoadingClaims(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const toggleRef = (claimId: number) => {
    setSelectedRefs((prev) => {
      const next = { ...prev };
      if (claimId in next) delete next[claimId];
      else next[claimId] = '';
      return next;
    });
  };

  const setRefAmount = (claimId: number, value: string) => {
    setSelectedRefs((prev) => ({ ...prev, [claimId]: value }));
  };

  const hasRefs = Object.keys(selectedRefs).length > 0;
  const refsTotal = Object.values(selectedRefs).reduce((sum, v) => sum + (Number(v) || 0), 0);

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
    if (!claimDate) return 'Claim Date is required.';
    if (!fromDate || !toDate) return 'From Date and To Date are required.';
    if (toDate < fromDate) return 'To Date can\u2019t be before From Date.';
    if (!category) return 'Select a Category.';
    if (hasRefs) {
      for (const v of Object.values(selectedRefs)) {
        const amt = Number(v);
        if (!v || !Number.isFinite(amt) || amt <= 0) return 'Enter an Amount greater than 0 for every referenced check-in/out.';
      }
      if (refsTotal <= 0) return 'Claim Amount must be greater than 0.';
    } else {
      const amt = Number(amount);
      if (!amount || !Number.isFinite(amt) || amt <= 0) return 'Claim Amount must be greater than 0.';
    }
    if (description.length > 0 && description.length > 500) return 'Description is too long.';
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

      const res = await fetch(apiUrl('/api/user-claims'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          claim_date: claimDate,
          from_date: fromDate,
          to_date: toDate,
          category,
          amount: hasRefs ? refsTotal : Number(amount),
          description: description.trim() || undefined,
          ...(hasRefs
            ? { claim_refs: Object.entries(selectedRefs).map(([claim_id, amt]) => ({ claim_id: Number(claim_id), amount: Number(amt) })) }
            : {}),
          ...(file_base64 ? { file_base64, file_name: file!.name, file_mimetype: file!.type } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit claim');
      onSubmitted();
    } catch (err: any) {
      setError(err.message || 'Failed to submit claim');
    } finally {
      setSubmitting(false);
    }
  };

  // Rendered via a portal straight onto document.body instead of in place —
  // same reasoning as AttendanceMapConfirm: this modal gets mounted deep
  // inside UserPanel's dashboard tree, which has an `overflow-hidden`
  // ancestor. On a number of Android WebViews a `position: fixed` element
  // nested inside `overflow: hidden` doesn't truly pin to the full device
  // screen — it gets clipped to that ancestor's box instead, which is what
  // was pushing everything below the Attachment field under BottomNav.
  // Escaping to document.body via a portal sidesteps that ancestor entirely.
  return createPortal(
    <div
      className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
      style={{
        paddingTop: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 0.5rem)',
        paddingBottom: 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 0.5rem)'
      }}
    >
      <div
        className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col"
        style={{ maxHeight: '100%' }}
      >
        <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
          <h3 className="text-base font-bold text-slate-900">New Conveyance Claim</h3>
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
          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Claim Date *</label>
            <input
              type="date"
              value={claimDate}
              onChange={(e) => setClaimDate(e.target.value)}
              className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
            />
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">From Date *</label>
              <input
                type="date"
                value={fromDate}
                onChange={(e) => {
                  setFromDate(e.target.value);
                  if (toDate < e.target.value) setToDate(e.target.value);
                }}
                className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">To Date *</label>
              <input
                type="date"
                value={toDate}
                min={fromDate}
                onChange={(e) => setToDate(e.target.value)}
                className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            </div>
          </div>
          <p className="text-[11px] text-slate-400 -mt-2">Useful for multi-day tours — leave both the same for a single-day claim.</p>

          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Category *</label>
            <select
              value={category}
              onChange={(e) => setCategory(e.target.value as UserClaimCategory)}
              className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
            >
              <option value="">Select a category</option>
              {USER_CLAIM_CATEGORIES.map((c) => (
                <option key={c} value={c}>
                  {c}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-500 mb-1 flex items-center gap-1.5">
              <Route className="w-3.5 h-3.5 text-slate-400" /> Reference Check In/Out (optional)
            </label>
            {loadingClaims ? (
              <div className="flex items-center gap-2 text-xs text-slate-400 px-3 py-2.5">
                <Spinner size={14} /> {'Loading your check-in/out history\u2026'}
              </div>
            ) : availableClaims.length === 0 ? (
              <p className="text-xs text-slate-400 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl">
                No completed check-in/out available to reference yet.
              </p>
            ) : (
              <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-52 overflow-y-auto">
                {availableClaims.map((c) => {
                  const checked = c.id in selectedRefs;
                  return (
                    <div key={c.id} className="px-3 py-2.5">
                      <label className="flex items-start gap-2 cursor-pointer">
                        <input
                          type="checkbox"
                          checked={checked}
                          onChange={() => toggleRef(c.id)}
                          className="mt-0.5 w-3.5 h-3.5 accent-blue-600 shrink-0"
                        />
                        <div className="min-w-0 flex-1">
                          <div className="text-xs font-medium text-slate-800 truncate">{c.purpose}</div>
                          <div className="text-[11px] text-slate-500 mt-0.5">
                            {formatDate(c.check_in_at)}
                            {c.check_out_at
                              ? ` \u00b7 ${new Date(c.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} \u2192 ${new Date(
                                  c.check_out_at
                                ).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                              : ''}
                            {c.distance_km != null ? ` \u00b7 ${c.distance_km} km` : ''}
                          </div>
                        </div>
                      </label>
                      {checked && (
                        <div className="mt-2 pl-5 relative">
                          <span className="absolute left-8 top-1/2 -translate-y-1/2 text-xs text-slate-400">৳</span>
                          <input
                            type="number"
                            min="0.01"
                            step="0.01"
                            value={selectedRefs[c.id]}
                            onChange={(e) => setRefAmount(c.id, e.target.value)}
                            placeholder="Amount for this check-in/out"
                            className="w-full text-xs pl-10 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            )}
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Claim Amount *</label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-sm text-slate-400">৳</span>
              <input
                type="number"
                min="0.01"
                step="0.01"
                value={hasRefs ? refsTotal.toFixed(2) : amount}
                onChange={(e) => setAmount(e.target.value)}
                readOnly={hasRefs}
                disabled={hasRefs}
                placeholder="0.00"
                className={`w-full text-sm pl-7 pr-3 py-2.5 border rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none ${
                  hasRefs ? 'bg-slate-100 border-slate-200 text-slate-500 cursor-not-allowed' : 'bg-slate-50 border-slate-200'
                }`}
              />
            </div>
            {hasRefs && (
              <p className="text-[11px] text-slate-400 mt-1">
                Auto-calculated from {Object.keys(selectedRefs).length} referenced check-in/out(s) above.
              </p>
            )}
          </div>

          <div>
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">Description (optional)</label>
            <textarea
              value={description}
              onChange={(e) => setDescription(e.target.value)}
              rows={3}
              maxLength={500}
              placeholder="e.g. CNG fare — site visit to Purbachal project"
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
            disabled={submitting}
            className="inline-flex items-center gap-1.5 px-4 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white font-semibold rounded-xl text-sm transition-all shadow-sm"
          >
            {submitting ? <Spinner size={16} /> : <CheckCircle2 className="w-4 h-4" />}
            Submit Claim
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};