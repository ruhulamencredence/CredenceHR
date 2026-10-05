/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Paperclip, AlertTriangle, CheckCircle2, Route, Plus, Trash2, Lock, ShieldCheck } from 'lucide-react';
import { ClaimRecord, MyBillClaimPolicy } from '../types';
import { apiUrl } from '../lib/api';
import { todayDateOnlyString, formatDate } from '../lib/formatDate';
import { useKeyboardInset, scrollFocusedFieldIntoView } from '../lib/useKeyboardInset';
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
// One bill line in the form (strings while being typed).
interface BillDraft {
  key: number;
  category_id: string;
  bill_date: string;
  amount: string;
  description: string;
}

let nextBillKey = 1;
const newBill = (date: string): BillDraft => ({ key: nextBillKey++, category_id: '', bill_date: date, amount: '', description: '' });
const money = (n: number) => `৳${n.toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// Several bills per claim, each with its own Category, Date (inside the
// claim's From–To range) and Amount. The rules come from Bill Claim Policy
// (GET /api/bill-claim-policy/mine): how far back a date may go, dates already
// closed for this user, categories and their limits. The server checks them
// again on submit.
//
// Check In/Out references belong to a Transport bill: they can only be picked
// once a bill's category is Transport, only from check-ins inside the claim's
// From–To range, and their amounts ARE that bill's amount (the bill's own
// Amount field is filled from them and locked) — so the claim total never
// counts the same fare twice.
const isTransportName = (name: string | undefined) => /transport/i.test(name || '');
// A check-in's own date ('YYYY-MM-DD HH:MM:SS' from the server, Dhaka time).
const checkInDate = (v: string | null | undefined) => {
  if (!v) return '';
  if (/^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/.test(v)) return v.slice(0, 10);
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v).slice(0, 10);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};
export const NewConveyanceClaimModal: React.FC<NewConveyanceClaimModalProps> = ({ token, onClose, onSubmitted }) => {
  const [policy, setPolicy] = useState<MyBillClaimPolicy | null>(null);
  const [policyError, setPolicyError] = useState('');
  const today = policy?.today || todayDateOnlyString();
  const claimDate = today;
  const [fromDate, setFromDate] = useState(todayDateOnlyString());
  const [toDate, setToDate] = useState(todayDateOnlyString());
  const [bills, setBills] = useState<BillDraft[]>(() => [newBill(todayDateOnlyString())]);
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
  const keyboardInset = useKeyboardInset();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/bill-claim-policy/mine'), { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load the Bill Claim Policy.');
        if (cancelled) return;
        setPolicy(data);
        setFromDate(data.today);
        setToDate(data.today);
        setBills([newBill(data.today)]);
      } catch (err: any) {
        if (!cancelled) setPolicyError(err.message || 'Could not load the Bill Claim Policy.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  const locked = new Set(policy?.locked_dates || []);
  const minDate = policy?.min_date || today;
  const maxDate = policy?.max_date || today;
  const categories = policy?.categories || [];
  const maxBills = Number(policy?.values.max_bills_per_claim) || 20;
  const isTransportBill = (b: BillDraft) => isTransportName(categories.find((c) => String(c.id) === b.category_id)?.name);
  // The bill the check-in/out references belong to (the first Transport one).
  const transportBill = bills.find(isTransportBill) || null;

  const updateBill = (key: number, patch: Partial<BillDraft>) => setBills((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  const removeBill = (key: number) => setBills((prev) => prev.filter((b) => b.key !== key));
  const addBill = () =>
    setBills((prev) => (prev.length >= maxBills ? prev : [...prev, newBill(prev[prev.length - 1]?.bill_date || fromDate)]));

  // Changing the range pulls any bill date that falls outside it back inside,
  // and drops picked check-in/outs that are now outside it.
  const setRange = (from: string, to: string) => {
    setFromDate(from);
    setToDate(to);
    setBills((prev) => prev.map((b) => ({ ...b, bill_date: b.bill_date < from ? from : b.bill_date > to ? to : b.bill_date })));
    setSelectedRefs((prev) => {
      const next: Record<number, string> = {};
      for (const [id, v] of Object.entries(prev)) {
        const c = availableClaims.find((x) => x.id === Number(id));
        const d = checkInDate(c?.check_in_at);
        if (c && d >= from && d <= to) next[Number(id)] = v;
      }
      return next;
    });
  };
  // Only check-ins inside the claim's From–To range can be referenced.
  const claimsInRange = availableClaims.filter((c) => {
    const d = checkInDate(c.check_in_at);
    return d >= fromDate && d <= toDate;
  });

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

  // No Transport bill any more -> the references go too.
  useEffect(() => {
    if (!transportBill && Object.keys(selectedRefs).length > 0) setSelectedRefs({});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [transportBill?.key]);

  const hasRefs = Object.keys(selectedRefs).length > 0;
  const refsTotal = Math.round(Object.values(selectedRefs).reduce((sum, v) => sum + (Number(v) || 0), 0) * 100) / 100;
  // The Transport bill's amount comes from its check-in/outs when any are picked.
  const refsDriveBill = (b: BillDraft) => hasRefs && transportBill?.key === b.key;
  const billAmount = (b: BillDraft) => (refsDriveBill(b) ? refsTotal : Number(b.amount) || 0);
  const billsTotal = bills.reduce((sum, b) => sum + billAmount(b), 0);
  const claimTotal = billsTotal;
  const receiptAbove = Number(policy?.values.attachment_required_above) || 0;
  const needsReceipt =
    (receiptAbove > 0 && claimTotal > receiptAbove) ||
    (!!policy?.values.enforce_category_limits && bills.some((b) => categories.find((c) => String(c.id) === b.category_id)?.receipt_required));

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
    if (!policy) return policyError || 'Loading the Bill Claim Policy\u2026';
    if (!fromDate || !toDate) return 'From Date and To Date are required.';
    if (toDate < fromDate) return 'To Date can\u2019t be before From Date.';
    if (fromDate < minDate || toDate > maxDate) return `Bills can only be claimed for dates from ${formatDate(minDate)} to ${formatDate(maxDate)}.`;
    if (bills.length === 0 && !hasRefs) return 'Add at least one bill.';
    for (let i = 0; i < bills.length; i++) {
      const b = bills[i];
      const n = i + 1;
      if (!b.category_id) return `Bill ${n}: select a category.`;
      if (!b.bill_date) return `Bill ${n}: select the bill's date.`;
      if (b.bill_date < fromDate || b.bill_date > toDate) return `Bill ${n}: the date must be between ${formatDate(fromDate)} and ${formatDate(toDate)}.`;
      if (locked.has(b.bill_date)) return `Bill ${n}: ${formatDate(b.bill_date)} was already claimed on an earlier day.`;
      const amt = billAmount(b);
      if (refsDriveBill(b)) {
        if (!(amt > 0)) return `Bill ${n}: enter the amount of each referenced check-in/out.`;
      } else if (!b.amount || !Number.isFinite(amt) || amt <= 0) return `Bill ${n}: enter an amount greater than 0.`;
      const cat = categories.find((c) => String(c.id) === b.category_id);
      if (policy.values.enforce_category_limits && cat?.max_per_bill != null && amt > cat.max_per_bill) {
        return `Bill ${n}: ${cat.name} bills can be at most ${money(cat.max_per_bill)} each.`;
      }
    }
    for (const v of Object.values(selectedRefs)) {
      const amt = Number(v);
      if (!v || !Number.isFinite(amt) || amt <= 0) return 'Enter an Amount greater than 0 for every referenced check-in/out.';
    }
    const maxTotal = Number(policy.values.max_claim_total) || 0;
    if (maxTotal > 0 && claimTotal > maxTotal) return `A claim can add up to at most ${money(maxTotal)}.`;
    if (needsReceipt && !file) return 'Attach the receipt \u2014 this claim needs one.';
    if (description.length > 500) return 'Description is too long.';
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
          items: bills.map((b) => ({
            category_id: Number(b.category_id),
            bill_date: b.bill_date,
            amount: billAmount(b),
            description: b.description.trim() || undefined
          })),
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
        paddingBottom: keyboardInset
          ? `${keyboardInset + 8}px`
          : 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 0.5rem)'
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

        <div className="p-5 space-y-4 overflow-y-auto min-h-0" onFocusCapture={scrollFocusedFieldIntoView}>
          {policyError && (
            <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{policyError}</span>
            </div>
          )}
          {!policy && !policyError && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Spinner size={14} /> Loading the Bill Claim Policy…
            </div>
          )}

          <div className="flex items-center justify-between text-xs">
            <span className="text-slate-500">
              Claim Date: <span className="font-semibold text-slate-800">{formatDate(claimDate)}</span>
            </span>
            {policy && (
              <span className="inline-flex items-center gap-1 text-slate-400" title="Set by Bill Claim Policy">
                <ShieldCheck className="w-3.5 h-3.5" /> Dates allowed: {formatDate(minDate)} – {formatDate(maxDate)}
              </span>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">From Date *</label>
              <input
                type="date"
                value={fromDate}
                min={minDate}
                max={maxDate}
                onChange={(e) => e.target.value && setRange(e.target.value, toDate < e.target.value ? e.target.value : toDate)}
                className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            </div>
            <div>
              <label className="block text-[11px] font-semibold text-slate-500 mb-1">To Date *</label>
              <input
                type="date"
                value={toDate}
                min={fromDate}
                max={maxDate}
                onChange={(e) => e.target.value && setRange(fromDate, e.target.value)}
                className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            </div>
          </div>
          {locked.size > 0 && (
            <p className="text-[11px] text-amber-700 -mt-2 flex items-start gap-1">
              <Lock className="w-3 h-3 mt-0.5 shrink-0" />
              <span>
                Already claimed on an earlier day (no more bills): {[...locked].map((d) => formatDate(d)).join(', ')}
              </span>
            </p>
          )}

          <div>
            <div className="flex items-center justify-between mb-1">
              <label className="text-[11px] font-semibold text-slate-500">Bills *</label>
              <span className="text-[11px] text-slate-400">
                {bills.length} / {maxBills}
              </span>
            </div>
            <div className="space-y-2">
              {bills.map((b, i) => {
                const dateClosed = locked.has(b.bill_date);
                const cat = categories.find((c) => String(c.id) === b.category_id);
                return (
                  <div key={b.key} className="border border-slate-200 rounded-xl p-2.5 bg-slate-50/60 space-y-2" aria-label={`Bill ${i + 1}`}>
                    <div className="flex items-center justify-between">
                      <span className="text-[11px] font-semibold text-slate-600">Bill {i + 1}</span>
                      <button
                        type="button"
                        onClick={() => removeBill(b.key)}
                        disabled={bills.length === 1}
                        className="p-1 text-slate-400 hover:text-rose-600 disabled:opacity-30"
                        aria-label={`Remove bill ${i + 1}`}
                      >
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <select
                        value={b.category_id}
                        onChange={(e) => updateBill(b.key, { category_id: e.target.value })}
                        aria-label={`Bill ${i + 1} category`}
                        className="w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                      >
                        <option value="">Category…</option>
                        {categories.map((c) => (
                          <option key={c.id} value={c.id}>
                            {c.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="date"
                        value={b.bill_date}
                        min={fromDate}
                        max={toDate}
                        onChange={(e) => updateBill(b.key, { bill_date: e.target.value })}
                        aria-label={`Bill ${i + 1} date`}
                        className={`w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none ${dateClosed ? 'border-rose-400 ring-1 ring-rose-400' : ''}`}
                      />
                    </div>
                    <div className="grid grid-cols-2 gap-2">
                      <div className="relative">
                        <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">৳</span>
                        <input
                          type="number"
                          min="0.01"
                          step="0.01"
                          value={refsDriveBill(b) ? String(refsTotal || '') : b.amount}
                          readOnly={refsDriveBill(b)}
                          onChange={(e) => !refsDriveBill(b) && updateBill(b.key, { amount: e.target.value })}
                          placeholder={refsDriveBill(b) ? 'From check-in/out' : 'Amount'}
                          title={refsDriveBill(b) ? 'The total of the referenced check-in/outs below' : undefined}
                          aria-label={`Bill ${i + 1} amount`}
                          className={`w-full text-xs px-2.5 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none pl-6 ${
                            refsDriveBill(b) ? 'bg-slate-100 text-slate-600 cursor-not-allowed' : 'bg-white'
                          }`}
                        />
                      </div>
                      <input
                        value={b.description}
                        onChange={(e) => updateBill(b.key, { description: e.target.value })}
                        maxLength={200}
                        placeholder="Note (optional)"
                        aria-label={`Bill ${i + 1} note`}
                        className="w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                      />
                    </div>
                    {dateClosed && <p className="text-[10px] text-rose-600">This date was already claimed on an earlier day.</p>}
                    {refsDriveBill(b) && <p className="text-[10px] text-blue-600">Amount = the referenced check-in/outs below ({money(refsTotal)}).</p>}
                    {cat && policy?.values.enforce_category_limits && (cat.max_per_bill != null || cat.monthly_limit != null || cat.receipt_required) && (
                      <p className="text-[10px] text-slate-400">
                        {[
                          cat.max_per_bill != null ? `Up to ${money(cat.max_per_bill)} per bill` : '',
                          cat.monthly_limit != null ? `${money(cat.monthly_limit)} a month` : '',
                          cat.receipt_required ? 'receipt needed' : ''
                        ]
                          .filter(Boolean)
                          .join(' · ')}
                      </p>
                    )}
                  </div>
                );
              })}
            </div>
            <button
              type="button"
              onClick={addBill}
              disabled={bills.length >= maxBills}
              className="mt-2 inline-flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800 disabled:opacity-40"
            >
              <Plus className="w-3.5 h-3.5" /> Add another bill
            </button>
          </div>

          <div>
            <label className="text-[11px] font-semibold text-slate-500 mb-1 flex items-center gap-1.5">
              <Route className="w-3.5 h-3.5 text-slate-400" /> Reference Check In/Out (optional, Transport only)
            </label>
            {!transportBill ? (
              <p className="text-xs text-slate-400 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl">
                Choose <span className="font-semibold">Transport</span> as a bill's category to reference your check-in/outs.
              </p>
            ) : loadingClaims ? (
              <div className="flex items-center gap-2 text-xs text-slate-400 px-3 py-2.5">
                <Spinner size={14} /> {'Loading your check-in/out history\u2026'}
              </div>
            ) : claimsInRange.length === 0 ? (
              <p className="text-xs text-slate-400 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl">
                No completed check-in/out between {formatDate(fromDate)} and {formatDate(toDate)} to reference.
              </p>
            ) : (
              <div className="border border-slate-200 rounded-xl divide-y divide-slate-100 max-h-52 overflow-y-auto">
                {claimsInRange.map((c) => {
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

          <div className="flex items-center justify-between px-3 py-2.5 rounded-xl bg-blue-50 text-sm">
            <span className="text-slate-600">
              Claim total
              {hasRefs && <span className="text-[11px] text-slate-400"> (Transport {money(refsTotal)} from check-in/out)</span>}
            </span>
            <span className="font-bold text-slate-900">{money(claimTotal)}</span>
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
            <label className="block text-[11px] font-semibold text-slate-500 mb-1">
              {needsReceipt ? 'Receipt * (this claim needs one — image/PDF, up to 5MB)' : 'Attachment (optional, image/PDF, up to 5MB)'}
            </label>
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
            disabled={submitting || !policy}
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