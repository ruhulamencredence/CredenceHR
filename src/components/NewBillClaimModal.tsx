/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Paperclip, AlertTriangle, CheckCircle2, Route, Trash2, Lock, ShieldCheck, ArrowRight, ArrowLeft } from 'lucide-react';
import { ClaimRecord, MyBillClaimPolicy, BillClaim } from '../types';
import { apiUrl } from '../lib/api';
import { todayDateOnlyString, formatDate } from '../lib/formatDate';
import { useKeyboardGap, scrollFocusedFieldIntoView } from '../lib/useKeyboardInset';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { readDraft, saveDraft, clearDraft } from '../lib/formDraft';

// The unsent New Claim, kept on the phone (lib/formDraft.ts) so a reload or
// the app being restarted (e.g. by Android while the camera is open) never
// loses it. `open`: the form was open — BillClaimCard reopens it.
export const BILL_CLAIM_DRAFT = 'bill-claim';
export interface BillClaimDraft {
  open: boolean;
  fromDate: string;
  toDate: string;
  bills: { key: number; category_id: string; bill_date: string; amount: string; description: string }[];
  description: string;
  selectedRefs: Record<number, string>;
  fileName: string | null;
  // Names of the receipts picked on each bill (by bill key) — the files
  // themselves can't be kept on the phone, so they're asked for again.
  receiptNames?: Record<number, string[]>;
}
import { Spinner } from './Spinner';

import { SearchSelect } from './Combobox';
import { AttachmentViewer } from './AttachmentViewer';
import { Camera, FileText } from 'lucide-react';
interface NewBillClaimModalProps {
  token: string;
  onClose: () => void;
  onSubmitted: () => void;
  // Admin Panel -> Conveyance -> Claim on Behalf: the same form, filed for this
  // employee (their policy, their check-in/outs, their approval chain).
  onBehalfOf?: { id: number; name: string } | null;
  // Edit (or correct & resubmit) this claim instead of filing a new one —
  // its bills, dates, check-in/outs and attachment are filled in.
  editClaim?: BillClaim | null;
  // "One new claim per day": a claim was already filed today — open that one
  // for editing instead.
  onEditExisting?: (claimId: number) => void;
}

const MAX_FILE_BYTES = 5 * 1024 * 1024; // 5MB
const ACCEPTED_TYPES = ['image/png', 'image/jpeg', 'image/jpg', 'image/webp', 'application/pdf'];

// "+ New Claim" submission form — opened from BillClaimCard as an inline
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
// A bill's receipt: one already on the claim being edited (id), or a new file.
interface Receipt {
  key: number;
  id?: number;
  name: string;
  type: string;
  file?: File;
  url?: string; // preview of a new photo
}
let nextReceiptKey = 1;
const MAX_RECEIPTS = 3;
const isPdf = (r: { type: string; name: string }) => /pdf/i.test(r.type) || /\.pdf$/i.test(r.name);
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
export const NewBillClaimModal: React.FC<NewBillClaimModalProps> = ({ token, onClose, onSubmitted, onBehalfOf, editClaim, onEditExisting }) => {
  const behalfBase = onBehalfOf ? `/api/bill-claims/on-behalf/${onBehalfOf.id}` : null;
  const editId = editClaim?.id ?? null;
  // Editing: the attachment already on the claim (kept unless replaced/removed).
  const hadFile = !!editClaim?.has_file;
  const [removeOldFile, setRemoveOldFile] = useState(false);
  const keepsOldFile = hadFile && !removeOldFile;
  const [policy, setPolicy] = useState<MyBillClaimPolicy | null>(null);
  const [policyError, setPolicyError] = useState('');
  const today = policy?.today || todayDateOnlyString();
  const claimDate = today;
  const [fromDate, setFromDate] = useState(todayDateOnlyString());
  const [toDate, setToDate] = useState(todayDateOnlyString());
  const [bills, setBills] = useState<BillDraft[]>([]);
  // The form is two steps: the bills, day by day, then a Review with the
  // description, the attachment and Submit.
  const [step, setStep] = useState<'bills' | 'review'>('bills');
  // The bill being added / changed (its key), and how it was before — Cancel
  // puts it back (or drops it, when it was just added).
  const [editing, setEditing] = useState<number | null>(null);
  const [snapshot, setSnapshot] = useState<{ bill: BillDraft; refs: Record<number, string> } | null>(null);
  const [editError, setEditError] = useState('');
  // Each bill's receipts, by bill key (the bills themselves stay plain text so
  // they can be kept as a draft on the phone).
  const [receipts, setReceipts] = useState<Record<number, Receipt[]>>({});
  const [receiptSnapshot, setReceiptSnapshot] = useState<Receipt[] | null>(null);
  const receiptInput = useRef<HTMLInputElement>(null);
  const [viewing, setViewing] = useState<{ list: Receipt[]; index: number } | null>(null);
  function receiptNamesOf(): Record<number, string[]> {
    const out: Record<number, string[]> = {};
    for (const [k, list] of Object.entries(receipts)) {
      const names = list.filter((r) => r.file).map((r) => r.name);
      if (names.length) out[Number(k)] = names;
    }
    return out;
  }
  const [description, setDescription] = useState('');
  const [file, setFile] = useState<File | null>(null);
  const [fileError, setFileError] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const closeRef = useRef<() => void>(() => onClose());
  // Only a brand-new claim of one's own keeps a draft (an edit starts from
  // the saved claim; Claim on Behalf is someone else's).
  const useDraft = !editClaim && !onBehalfOf;
  const [draftReady, setDraftReady] = useState(false);
  const [restored, setRestored] = useState<{ fileName: string | null; receipts?: number } | null>(null);

  // Completed Check In/Out (check-in/out) the User can attach to this claim,
  // each with its own Amount — a check-in/out can only ever be referenced once,
  // so this list (GET /api/claims/available) already excludes anything already
  // referenced or billed. claimId -> amount-string map; a key's mere presence
  // means it's selected.
  const [availableClaims, setAvailableClaims] = useState<ClaimRecord[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(true);
  const [selectedRefs, setSelectedRefs] = useState<Record<number, string>>({});

  useBackButtonClose(true, submitting ? () => {} : () => closeRef.current());
  // What the on-screen keyboard covers that the page itself doesn't already
  // avoid (the app's WebView shrinks on some phones and not on others; a
  // phone browser shrinks its visual viewport) — the popup sits just above it.
  const keyboard = useKeyboardGap();

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch(apiUrl(`${behalfBase ? `${behalfBase}/policy` : '/api/bill-claim-policy/mine'}${editId ? `?claim_id=${editId}` : ''}`), { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Could not load the Bill Claim Policy.');
        if (cancelled) return;
        setPolicy(data);
        if (editClaim) {
          // Fill the form from the claim being edited.
          const day = (v: string) => String(v || '').slice(0, 10);
          setFromDate(day(editClaim.from_date));
          setToDate(day(editClaim.to_date));
          const cats: { id: number; name: string }[] = data.categories || [];
          const kept: Record<number, Receipt[]> = {};
          const lines = (editClaim.items || []).map((it) => {
            const key = nextBillKey++;
            if (it.files?.length) kept[key] = it.files.map((f) => ({ key: nextReceiptKey++, id: f.id, name: f.file_name, type: f.file_mimetype }));
            return {
              key,
              category_id: String(cats.find((c) => c.id === it.category_id)?.id ?? cats.find((c) => c.name === it.category_name)?.id ?? ''),
              bill_date: day(it.bill_date),
              amount: String(it.amount),
              description: it.description || ''
            };
          });
          setBills(lines);
          setReceipts(kept);
          setDescription(editClaim.description || '');
          const refs: Record<number, string> = {};
          for (const r of editClaim.claim_refs || []) refs[r.claim_id] = String(r.amount);
          setSelectedRefs(refs);
        } else {
          const d = useDraft ? readDraft<BillClaimDraft>(BILL_CLAIM_DRAFT) : null;
          const hasContent = !!d && (d.description?.trim() || Object.keys(d.selectedRefs || {}).length || (d.bills || []).some((b) => b.amount || b.category_id || b.description));
          if (d && hasContent && Array.isArray(d.bills) && d.bills.length) {
            // Pick up where it was left.
            nextBillKey = Math.max(nextBillKey, ...d.bills.map((b) => Number(b.key) + 1));
            setFromDate(d.fromDate || data.today);
            setToDate(d.toDate || data.today);
            setBills(d.bills);
            setDescription(d.description || '');
            setSelectedRefs(d.selectedRefs || {});
            setRestored({ fileName: d.fileName || null, receipts: Object.values(d.receiptNames || {}).reduce((n, l) => n + l.length, 0) });
          } else {
            setFromDate(data.today);
            setToDate(data.today);
            setBills([]);
          }
        }
        setDraftReady(true);
      } catch (err: any) {
        if (!cancelled) setPolicyError(err.message || 'Could not load the Bill Claim Policy.');
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, behalfBase]);

  // Keep the draft up to date while the form is open.
  useEffect(() => {
    if (!useDraft || !draftReady) return;
    const t = setTimeout(() => {
      const draft: BillClaimDraft = { open: true, fromDate, toDate, bills, description, selectedRefs, fileName: file?.name || restored?.fileName || null, receiptNames: receiptNamesOf() };
      saveDraft(BILL_CLAIM_DRAFT, draft);
    }, 300);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [useDraft, draftReady, fromDate, toDate, bills, description, selectedRefs, file, restored, receipts]);
  // Closing on purpose: an empty form leaves nothing behind; a started one
  // stays as a draft for next time (not reopened by itself).
  const close = () => {
    if (useDraft && draftReady) {
      const started = description.trim() || Object.keys(selectedRefs).length || bills.some((b) => b.amount || b.category_id || b.description);
      if (started) saveDraft(BILL_CLAIM_DRAFT, { open: false, fromDate, toDate, bills, description, selectedRefs, fileName: file?.name || restored?.fileName || null, receiptNames: receiptNamesOf() });
      else clearDraft(BILL_CLAIM_DRAFT);
    }
    onClose();
  };
  closeRef.current = close;
  const startOver = () => {
    clearDraft(BILL_CLAIM_DRAFT);
    const day = policy?.today || todayDateOnlyString();
    setFromDate(day);
    setToDate(day);
    setBills([]);
    setReceipts({});
    setEditing(null);
    setStep('bills');
    setDescription('');
    setSelectedRefs({});
    setFile(null);
    setRestored(null);
  };

  const locked = new Set(policy?.locked_dates || []);
  const minDate = policy?.min_date || today;
  const maxDate = policy?.max_date || today;
  const categories = policy?.categories || [];
  const maxBills = Number(policy?.values.max_bills_per_claim) || 20;
  const isTransportBill = (b: BillDraft) => isTransportName(categories.find((c) => String(c.id) === b.category_id)?.name);
  // The bill the check-in/out references belong to (the first Transport one).
  const transportBill = bills.find(isTransportBill) || null;

  const updateBill = (key: number, patch: Partial<BillDraft>) => setBills((prev) => prev.map((b) => (b.key === key ? { ...b, ...patch } : b)));
  const removeBill = (key: number) => {
    setBills((prev) => prev.filter((b) => b.key !== key));
    setReceipts((prev) => {
      if (!(key in prev)) return prev;
      const next = { ...prev };
      delete next[key];
      return next;
    });
  };
  // A bill's receipts; whether its category needs one (Bill Claim Policy →
  // Bill categories → Receipt, while category limits are enforced — the
  // server checks the same).
  const receiptsOf = (b: BillDraft) => receipts[b.key] || [];
  const needsBillReceipt = (b: BillDraft) =>
    !!policy?.values.enforce_category_limits && !!categories.find((c) => String(c.id) === b.category_id)?.receipt_required;
  const addReceipts = (key: number, picked: FileList | null) => {
    if (!picked?.length) return;
    const list = receipts[key] || [];
    const room = MAX_RECEIPTS - list.length;
    const add: Receipt[] = [];
    let problem = '';
    for (const f of Array.from(picked)) {
      if (add.length >= room) {
        problem = `At most ${MAX_RECEIPTS} receipts per bill.`;
        break;
      }
      if (f.size > MAX_FILE_BYTES) {
        problem = `${f.name}: a receipt must be 5MB or smaller.`;
        continue;
      }
      if (!/^image\//.test(f.type) && f.type !== 'application/pdf') {
        problem = `${f.name}: a receipt must be a photo or a PDF.`;
        continue;
      }
      add.push({ key: nextReceiptKey++, name: f.name, type: f.type, file: f, url: /^image\//.test(f.type) ? URL.createObjectURL(f) : undefined });
    }
    setEditError(problem);
    if (add.length) setReceipts((prev) => ({ ...prev, [key]: [...(prev[key] || []), ...add] }));
    if (receiptInput.current) receiptInput.current.value = '';
  };
  const removeReceipt = (key: number, rkey: number) =>
    setReceipts((prev) => ({ ...prev, [key]: (prev[key] || []).filter((r) => r.key !== rkey) }));
  const missingReceipts = bills.filter((b) => needsBillReceipt(b) && receiptsOf(b).length === 0);
  const allReceipts: { bill: BillDraft; r: Receipt }[] = bills.flatMap((b) => receiptsOf(b).map((r) => ({ bill: b, r })));

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
        const res = await fetch(apiUrl(behalfBase ? `${behalfBase}/available-claims` : '/api/claims/available'), { headers: { Authorization: `Bearer ${token}` } });
        if (res.ok && !cancelled) {
          const list: ClaimRecord[] = await res.json();
          // The check-in/outs already on the claim being edited aren't
          // "available" any more, but they belong in its picker.
          const own = (editClaim?.claim_refs || [])
            .filter((r) => !list.some((c) => c.id === r.claim_id))
            .map((r) => ({ ...(r as any), id: r.claim_id, status: 'completed' }) as ClaimRecord);
          setAvailableClaims([...own, ...list]);
        }
      } catch {
        // Offline/unreachable — picker just stays empty; manual Amount still works.
      } finally {
        if (!cancelled) setLoadingClaims(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, behalfBase]);

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
  // Bill Claim Policy "Transport bills come only from Check In/Out": the
  // Transport bill's amount is always its check-in/outs (never typed in), and a
  // claim has one Transport bill. Off: only when some are picked.
  const transportFromRefs = !!policy?.values.transport_from_check_in_out;
  const refsDriveBill = (b: BillDraft) => (hasRefs || transportFromRefs) && transportBill?.key === b.key;
  const billAmount = (b: BillDraft) => (refsDriveBill(b) ? refsTotal : Number(b.amount) || 0);
  const billsTotal = bills.reduce((sum, b) => sum + billAmount(b), 0);
  const claimTotal = billsTotal;
  const receiptAbove = Number(policy?.values.attachment_required_above) || 0;
  // A category's receipt goes on each of its bills (receiptsOf); the claim
  // itself needs one only over the "receipt above" amount, and a bill's
  // receipt counts for that too.
  const needsReceipt = receiptAbove > 0 && claimTotal > receiptAbove && !Object.values(receipts).some((l) => l.length > 0);

  // ---- Day-by-day form ----------------------------------------------------
  // Every date of the From–To range (a range is a few days; capped anyway).
  const days: string[] = [];
  if (fromDate && toDate && fromDate <= toDate) {
    const d = new Date(`${fromDate}T00:00:00Z`);
    while (days.length < 93) {
      const iso = d.toISOString().slice(0, 10);
      if (iso > toDate) break;
      days.push(iso);
      d.setUTCDate(d.getUTCDate() + 1);
    }
  }
  const dayLabel = (iso: string) => `${new Date(`${iso}T00:00:00Z`).toLocaleDateString('en-GB', { weekday: 'short', timeZone: 'UTC' })}, ${formatDate(iso)}`;
  // A chip per category; no second Transport when the policy allows one.
  const chipCategories = categories.filter((c) => !(transportFromRefs && isTransportName(c.name) && transportBill));
  const addBillOn = (day: string, categoryId: string) => {
    if (bills.length >= maxBills) return;
    const b = { ...newBill(day), category_id: categoryId };
    setBills((prev) => [...prev, b]);
    setSnapshot(null);
    setEditError('');
    setError('');
    setEditing(b.key);
  };
  // "Same as <the day before>": its bills (not Transport — that one comes from
  // Check In/Out) on this day too, as far as the bill limit allows.
  const copyDay = (from: string, to: string) => {
    const src = bills.filter((b) => b.bill_date === from && b.category_id && !isTransportBill(b));
    const room = maxBills - bills.length;
    setBills((prev) => [...prev, ...src.slice(0, room).map((b) => ({ ...b, key: nextBillKey++, bill_date: to }))]);
  };
  const startEdit = (key: number) => {
    const b = bills.find((x) => x.key === key);
    if (!b) return;
    setSnapshot({ bill: { ...b }, refs: { ...selectedRefs } });
    setReceiptSnapshot(receipts[key] ? [...receipts[key]] : null);
    setEditError('');
    setError('');
    setEditing(key);
  };
  const editingBill = editing !== null ? bills.find((b) => b.key === editing) || null : null;
  const editingIsNew = editing !== null && snapshot === null;
  const cancelEdit = () => {
    if (editing === null) return;
    if (snapshot) {
      const before = snapshot.bill;
      setBills((prev) => prev.map((b) => (b.key === before.key ? before : b)));
      setSelectedRefs(snapshot.refs);
      setReceipts((prev) => {
        const next = { ...prev };
        if (receiptSnapshot) next[before.key] = receiptSnapshot;
        else delete next[before.key];
        return next;
      });
    } else removeBill(editing);
    setEditing(null);
    setSnapshot(null);
    setEditError('');
  };
  const finishEdit = () => {
    const b = editingBill;
    if (!b) return setEditing(null);
    const cat = categories.find((c) => String(c.id) === b.category_id);
    const amt = billAmount(b);
    let msg = '';
    if (!cat) msg = 'Choose a category.';
    else if (refsDriveBill(b)) {
      if (transportFromRefs && !hasRefs) msg = 'Tick the check-in/out(s) this travel was for.';
      else if (Object.values(selectedRefs).some((v) => !(Number(v) > 0))) msg = 'Enter the amount of each ticked check-in/out.';
    } else if (!(amt > 0)) msg = 'Enter an amount greater than 0.';
    if (!msg && policy?.values.enforce_category_limits && cat?.max_per_bill != null && amt > cat.max_per_bill) msg = `${cat.name} bills can be at most ${money(cat.max_per_bill)} each.`;
    if (msg) return setEditError(msg);
    setEditing(null);
    setSnapshot(null);
    setEditError('');
  };
  // What is left of the category's daily limit on that day (this bill counted).
  const leftToday = (b: BillDraft): number | null => {
    const cat = categories.find((c) => String(c.id) === b.category_id);
    if (!policy?.values.enforce_category_limits || cat?.daily_limit == null) return null;
    const used = bills.filter((x) => x.bill_date === b.bill_date && x.category_id === b.category_id).reduce((s, x) => s + billAmount(x), 0);
    return Math.round((cat.daily_limit - used) * 100) / 100;
  };
  const editingLeft = editingBill ? leftToday(editingBill) : null;
  const goReview = () => {
    if (editing !== null) return;
    const v = validate(true);
    if (v) return setError(v);
    setError('');
    setStep('review');
  };
  // Review: the total by category.
  const reviewRows: { name: string; count: number; total: number; trips: number }[] = [];
  for (const b of bills) {
    const name = categories.find((c) => String(c.id) === b.category_id)?.name || 'Other';
    let row = reviewRows.find((r) => r.name === name);
    if (!row) reviewRows.push((row = { name, count: 0, total: 0, trips: 0 }));
    row.count += 1;
    row.total += billAmount(b);
    if (refsDriveBill(b)) row.trips += Object.keys(selectedRefs).length;
  }

  // One bill being added / changed: its category, amount and note, its limits,
  // and — for the Transport bill — the check-in/outs it is made of.
  const renderEditor = (b: BillDraft, n: number) => {
    const cat = categories.find((c) => String(c.id) === b.category_id);
    const left = leftToday(b);
    return (
      <div className="rounded-xl border-2 border-blue-400 bg-white p-2.5 space-y-2" aria-label={`Bill ${n}`} data-testid="bill-editor">
        <div className="flex items-center gap-2">
          <SearchSelect
            value={b.category_id}
            onChange={(e) => updateBill(b.key, { category_id: e.target.value })}
            aria-label={`Bill ${n} category`}
            className="flex-1 text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
          >
            <option value="">Category…</option>
            {categories
              .filter((c) => !(transportFromRefs && isTransportName(c.name) && transportBill && transportBill.key !== b.key))
              .map((c) => (
                <option key={c.id} value={c.id}>
                  {c.name}
                </option>
              ))}
          </SearchSelect>
          <button
            type="button"
            onClick={() => {
              removeBill(b.key);
              setEditing(null);
              setSnapshot(null);
              setEditError('');
            }}
            className="p-1.5 text-slate-400 hover:text-rose-600"
            aria-label={`Remove bill ${n}`}
          >
            <Trash2 className="w-4 h-4" />
          </button>
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div className="relative">
            <span className="absolute left-2.5 top-1/2 -translate-y-1/2 text-xs text-slate-400">৳</span>
            <input
              type="number"
              inputMode="decimal"
              enterKeyHint="done"
              autoComplete="off"
              autoFocus={!refsDriveBill(b)}
              min="0.01"
              step="0.01"
              value={refsDriveBill(b) ? String(refsTotal || '') : b.amount}
              readOnly={refsDriveBill(b)}
              onChange={(e) => !refsDriveBill(b) && updateBill(b.key, { amount: e.target.value })}
              onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), finishEdit())}
              placeholder={refsDriveBill(b) ? 'From check-in/out' : 'Amount'}
              aria-label={`Bill ${n} amount`}
              className={`w-full text-sm font-semibold px-2.5 py-2 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none pl-6 ${
                refsDriveBill(b) ? 'bg-slate-100 text-slate-600 cursor-not-allowed' : 'bg-white'
              }`}
            />
          </div>
          <input
            value={b.description}
            onChange={(e) => updateBill(b.key, { description: e.target.value })}
            onKeyDown={(e) => e.key === 'Enter' && (e.preventDefault(), finishEdit())}
            enterKeyHint="done"
            maxLength={200}
            placeholder="Note (optional)"
            aria-label={`Bill ${n} note`}
            className="w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
          />
        </div>
        {cat && policy?.values.enforce_category_limits && (cat.max_per_bill != null || cat.daily_limit != null || cat.monthly_limit != null) && (
          <p className="text-[10px] text-slate-500">
            {cat.limits_for ? `For ${cat.limits_for}: ` : ''}
            {[
              cat.max_per_bill != null ? `up to ${money(cat.max_per_bill)} per bill` : '',
              cat.daily_limit != null ? `${money(cat.daily_limit)} a day` : '',
              cat.monthly_limit != null ? `${money(cat.monthly_limit)} a month` : ''
            ]
              .filter(Boolean)
              .join(' · ')}
            {left != null && <span className={left < 0 ? 'text-rose-600 font-semibold' : 'text-blue-600 font-semibold'}> · {left < 0 ? `${money(-left)} over` : `${money(left)} left`} today</span>}
          </p>
        )}
        {refsDriveBill(b) && <p className="text-[10px] text-blue-600">Amount = the ticked check-in/outs below ({money(refsTotal)}){transportFromRefs ? " — it can't be typed in." : '.'}</p>}
        {transportBill && transportBill.key !== b.key && isTransportBill(b) && (
          <p className="text-[10px] text-slate-500">Check In/Out go with the first Transport bill.</p>
        )}
        {transportBill?.key === b.key && (
          <div className="rounded-lg border border-blue-200 bg-white p-2">
            <div className="text-[11px] font-semibold text-blue-700 mb-1 flex items-center gap-1.5">
              <Route className="w-3.5 h-3.5" /> Check In/Out {formatDate(fromDate)}
              {toDate !== fromDate ? ` – ${formatDate(toDate)}` : ''} {transportFromRefs ? '(required)' : '(optional)'}
            </div>
            {loadingClaims ? (
              <div className="flex items-center gap-2 text-xs text-slate-400 px-3 py-2.5">
                <Spinner size={14} /> {'Loading your check-in/out history\u2026'}
              </div>
            ) : claimsInRange.length === 0 ? (
              <p className="text-xs text-slate-400 px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl">
                No completed check-in/out between {formatDate(fromDate)} and {formatDate(toDate)} to reference.
                {transportFromRefs && ' A Transport bill comes from your Check In/Out — check in and out for the trip first, or choose another category.'}
              </p>
            ) : (
              <div className="border border-slate-200 rounded-xl divide-y divide-slate-100">
                {claimsInRange.map((c) => {
                  const checked = c.id in selectedRefs;
                  return (
                    <div key={c.id} className="px-3 py-2">
                      <div className="flex items-center gap-2">
                        <label className="flex items-start gap-2 cursor-pointer min-w-0 flex-1">
                          <input type="checkbox" checked={checked} onChange={() => toggleRef(c.id)} className="mt-0.5 w-3.5 h-3.5 accent-blue-600 shrink-0" />
                          <div className="min-w-0 flex-1">
                            <div className="text-xs font-medium text-slate-800 truncate">{c.purpose}</div>
                            <div className="text-[11px] text-slate-500 mt-0.5">
                              {formatDate(c.check_in_at)}
                              {c.check_out_at
                                ? ` \u00b7 ${new Date(c.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })} \u2192 ${new Date(c.check_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
                                : ''}
                              {c.distance_km != null ? ` \u00b7 ${c.distance_km} km` : ''}
                            </div>
                          </div>
                        </label>
                        {checked && (
                          <div className="relative w-24 shrink-0">
                            <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-slate-400">৳</span>
                            <input
                              type="number"
                              inputMode="decimal"
                              enterKeyHint="done"
                              autoComplete="off"
                              min="0.01"
                              step="0.01"
                              value={selectedRefs[c.id]}
                              onChange={(e) => setRefAmount(c.id, e.target.value)}
                              placeholder="Fare"
                              aria-label={`Fare for ${c.purpose}`}
                              className="w-full text-xs font-semibold pl-5 pr-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                            />
                          </div>
                        )}
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        )}
        {/* This bill's receipts: photo or PDF, up to MAX_RECEIPTS. */}
        <div data-testid="bill-receipts">
          <div className="text-[11px] font-semibold text-slate-600">
            {needsBillReceipt(b) ? 'Receipt *' : 'Receipt (optional)'}
            <span className="font-normal text-slate-400"> · photo or PDF, up to {MAX_RECEIPTS}</span>
          </div>
          <div className="mt-1.5 flex flex-wrap gap-2">
            {receiptsOf(b).map((r, k) => (
              <div key={r.key} className="relative">
                <button
                  type="button"
                  onClick={() => setViewing({ list: receiptsOf(b), index: k })}
                  aria-label={`Open receipt ${r.name}`}
                  className="w-16 h-16 rounded-xl border border-slate-200 bg-slate-50 overflow-hidden flex flex-col items-center justify-center text-slate-500"
                >
                  {r.url ? (
                    <img src={r.url} alt="" className="w-full h-full object-cover object-top" />
                  ) : (
                    <>
                      <FileText className="w-5 h-5" />
                      <span className="mt-0.5 px-1 max-w-full truncate text-[9px] font-semibold">{isPdf(r) ? 'PDF' : r.name}</span>
                    </>
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => removeReceipt(b.key, r.key)}
                  aria-label={`Remove receipt ${r.name}`}
                  className="absolute -top-1.5 -right-1.5 w-5 h-5 rounded-full bg-slate-900/85 text-white flex items-center justify-center"
                >
                  <X className="w-3 h-3" />
                </button>
              </div>
            ))}
            {receiptsOf(b).length < MAX_RECEIPTS && (
              <label
                className={`w-16 h-16 rounded-xl border-[1.5px] border-dashed flex flex-col items-center justify-center gap-0.5 text-[10px] font-semibold cursor-pointer ${
                  needsBillReceipt(b) && receiptsOf(b).length === 0 ? 'border-rose-300 bg-rose-50 text-rose-600' : 'border-blue-300 bg-blue-50 text-blue-700'
                }`}
              >
                <Camera className="w-5 h-5" />
                Add
                <input
                  ref={receiptInput}
                  type="file"
                  accept="image/*,application/pdf"
                  multiple
                  className="hidden"
                  aria-label={`Bill ${n} receipt`}
                  onChange={(e) => addReceipts(b.key, e.target.files)}
                />
              </label>
            )}
          </div>
        </div>
        {editError && (
          <p className="text-[11px] font-semibold text-rose-600" role="alert">
            {editError}
          </p>
        )}
      </div>
    );
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

  // "One new claim per day" — the claim already filed today, if any.
  const todayClaimId = !editClaim ? policy?.today_claim_id ?? null : null;
  // "A claim holds every date from its From Date to its To Date": none of
  // this claim's range may already belong to another claim.
  const wholeRange = !!policy?.values.one_claim_per_date && !!policy?.values.lock_whole_range;
  const rangeClash: string[] = [];
  if (wholeRange && fromDate && toDate && fromDate <= toDate) {
    for (const d of Array.from(locked).sort()) if (d >= fromDate && d <= toDate) rangeClash.push(d);
  }

  const validate = (beforeReview = false): string | null => {
    if (!policy) return policyError || 'Loading the Bill Claim Policy\u2026';
    if (!fromDate || !toDate) return 'From Date and To Date are required.';
    if (toDate < fromDate) return 'To Date can\u2019t be before From Date.';
    if (todayClaimId) return `A claim was already filed today (#${todayClaimId}) — edit that claim to add bills.`;
    if (rangeClash.length) return `${rangeClash.map(formatDate).join(', ')} ${rangeClash.length === 1 ? 'is' : 'are'} already covered by another claim of yours — pick other dates.`;
    if (fromDate < minDate || toDate > maxDate) return `Bills can only be claimed for dates from ${formatDate(minDate)} to ${formatDate(maxDate)}.`;
    if (bills.length === 0 && !hasRefs) return 'Add at least one bill.';
    for (let i = 0; i < bills.length; i++) {
      const b = bills[i];
      const n = i + 1;
      if (!b.category_id) return `Bill ${n}: select a category.`;
      if (!b.bill_date) return `Bill ${n}: select the bill's date.`;
      if (b.bill_date < fromDate || b.bill_date > toDate) return `Bill ${n}: the date must be between ${formatDate(fromDate)} and ${formatDate(toDate)}.`;
      if (locked.has(b.bill_date))
        return policy.values.one_claim_per_date
          ? `Bill ${n}: ${formatDate(b.bill_date)} is already in another claim of yours — one date goes in one claim. Open that claim and edit it instead.`
          : `Bill ${n}: ${formatDate(b.bill_date)} was already claimed on an earlier day.`;
      const amt = billAmount(b);
      if (transportFromRefs && isTransportBill(b) && transportBill?.key !== b.key) {
        return `Bill ${n}: only one Transport bill per claim — tick all your check-in/outs on Bill ${bills.findIndex((x) => x.key === transportBill?.key) + 1}.`;
      }
      if (refsDriveBill(b)) {
        if (transportFromRefs && !hasRefs) return `Bill ${n}: a Transport bill needs its Check In/Out — tick the check-in/out(s) this travel was for.`;
        if (!(amt > 0)) return `Bill ${n}: enter the amount of each referenced check-in/out.`;
      } else if (!b.amount || !Number.isFinite(amt) || amt <= 0) return `Bill ${n}: enter an amount greater than 0.`;
      const cat = categories.find((c) => String(c.id) === b.category_id);
      if (policy.values.enforce_category_limits && cat?.max_per_bill != null && amt > cat.max_per_bill) {
        return `Bill ${n}: ${cat.name} bills can be at most ${money(cat.max_per_bill)} each.`;
      }
      if (needsBillReceipt(b) && receiptsOf(b).length === 0) return `${cat?.name || `Bill ${n}`} on ${formatDate(b.bill_date)} needs its receipt — tap the bill and add a photo or PDF.`;
    }
    for (const v of Object.values(selectedRefs)) {
      const amt = Number(v);
      if (!v || !Number.isFinite(amt) || amt <= 0) return 'Enter an Amount greater than 0 for every referenced check-in/out.';
    }
    const maxTotal = Number(policy.values.max_claim_total) || 0;
    if (maxTotal > 0 && claimTotal > maxTotal) return `A claim can add up to at most ${money(maxTotal)}.`;
    if (!beforeReview && needsReceipt && !file && !keepsOldFile) return 'Attach the receipt \u2014 this claim needs one.';
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

      const asBase64 = (f: File) =>
        new Promise<string>((resolve, reject) => {
          const reader = new FileReader();
          reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
          reader.onerror = () => reject(new Error(`Could not read ${f.name}.`));
          reader.readAsDataURL(f);
        });
      const billFiles = await Promise.all(
        bills.map(async (b) => {
          const list = receiptsOf(b);
          const files = [];
          for (const r of list) if (r.file) files.push({ file_base64: await asBase64(r.file), file_name: r.name, file_mimetype: r.file.type || 'application/octet-stream' });
          return { files, keep_file_ids: list.filter((r) => r.id).map((r) => r.id as number) };
        })
      );
      const res = await fetch(apiUrl(editId ? `/api/bill-claims/${editId}/edit` : behalfBase || '/api/bill-claims'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          claim_date: claimDate,
          from_date: fromDate,
          to_date: toDate,
          items: bills.map((b, i) => ({
            category_id: Number(b.category_id),
            bill_date: b.bill_date,
            amount: billAmount(b),
            description: b.description.trim() || undefined,
            // Each bill's receipts (new) and the ones already on the claim (kept).
            files: billFiles[i].files,
            keep_file_ids: billFiles[i].keep_file_ids
          })),
          description: description.trim() || undefined,
          ...(hasRefs
            ? { claim_refs: Object.entries(selectedRefs).map(([claim_id, amt]) => ({ claim_id: Number(claim_id), amount: Number(amt) })) }
            : {}),
          ...(file_base64 ? { file_base64, file_name: file!.name, file_mimetype: file!.type } : {}),
          ...(editClaim ? { version: editClaim.version, remove_file: hadFile && removeOldFile && !file ? true : undefined } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit claim');
      if (useDraft) clearDraft(BILL_CLAIM_DRAFT);
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
      data-kb-self=""
      className="liquid-glass-backdrop fixed inset-0 z-50 flex items-center justify-center p-2 sm:p-4"
      style={{
        paddingTop: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 0.5rem)',
        paddingBottom: keyboard.gap
          ? `${keyboard.gap + 8}px`
          : 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 0.5rem)'
      }}
    >
      <div className="max-w-lg w-full flex" style={{ maxHeight: '100%' }}>
      <div className="liquid-glass liquid-glass-in rounded-[32px] w-full overflow-hidden flex flex-col">
        <div className="px-5 pt-5 pb-3 flex items-center justify-between gap-3 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold text-slate-900">
              {step === 'review' ? 'Review claim' : editClaim ? (editClaim.edit_mode === 'pending' ? 'Edit Claim' : 'Correct & Resubmit') : onBehalfOf ? 'Claim on Behalf' : 'New Bill Claim'}
            </h3>
            {editClaim?.edit_mode === 'returned' && editClaim.return_reason && (
              <p className="text-xs text-amber-700 mt-0.5">Returned: {editClaim.return_reason}</p>
            )}
            {onBehalfOf && (
              <p className="text-xs text-slate-500 mt-0.5 truncate">
                For <span className="font-semibold text-slate-700">{onBehalfOf.name}</span> — goes through their approval chain.
              </p>
            )}
          </div>
          <button
            type="button"
            onClick={close}
            disabled={submitting}
            aria-label="Close"
            className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center text-slate-500 shrink-0 disabled:opacity-40"
          >
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="px-5 pb-5 pt-1 space-y-4 overflow-y-auto min-h-0" onFocusCapture={scrollFocusedFieldIntoView}>
          {policyError && (
            <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{policyError}</span>
            </div>
          )}
          {restored && (
            <div className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-800 border border-emerald-100">
              <span className="flex-1">
                Your unsent claim was brought back.
                {restored.fileName && !file ? ` Attach "${restored.fileName}" again before submitting.` : ''}
                {restored.receipts ? ` Add the bills' receipts again (${restored.receipts}) — photos can't be kept on the phone.` : ''}
              </span>
              <button type="button" onClick={startOver} className="shrink-0 font-semibold text-emerald-700 hover:underline">
                Start over
              </button>
            </div>
          )}
          {!policy && !policyError && (
            <div className="flex items-center gap-2 text-xs text-slate-400">
              <Spinner size={14} /> Loading the Bill Claim Policy…
            </div>
          )}

          {step === 'bills' && (
            <>
          <div className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 text-xs">
            <span className="text-slate-500">
              Claim Date: <span className="font-semibold text-slate-800 whitespace-nowrap">{formatDate(claimDate)}</span>
            </span>
            {policy && (
              <span className="inline-flex flex-wrap items-center gap-x-1 text-slate-400" title="Set by Bill Claim Policy">
                <ShieldCheck className="w-3.5 h-3.5" /> Dates allowed:{' '}
                <span className="whitespace-nowrap">
                  {formatDate(minDate)} – {formatDate(maxDate)}
                </span>
              </span>
            )}
          </div>

          {todayClaimId && (
            <div className="text-xs px-3 py-2.5 rounded-xl bg-amber-50 text-amber-800 border border-amber-200">
              <div className="font-semibold">You already filed a claim today (#{todayClaimId}).</div>
              <p className="mt-0.5">One claim a day — add or change today's bills in that claim.</p>
              {onEditExisting && (
                <button
                  type="button"
                  onClick={() => onEditExisting(todayClaimId)}
                  className="mt-2 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-amber-600 hover:bg-amber-700 text-white font-semibold"
                >
                  Open today's claim
                </button>
              )}
            </div>
          )}
          {locked.size > 0 && (
            <p className="text-[11px] text-slate-500">
              Already in your other claims (can't be picked): {Array.from(locked).sort().map(formatDate).join(', ')}
            </p>
          )}
          {rangeClash.length > 0 && (
            <p className="text-[11px] font-semibold text-rose-600">
              {rangeClash.map(formatDate).join(', ')} {rangeClash.length === 1 ? 'is' : 'are'} inside this From–To range but already covered by another claim.
            </p>
          )}

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

            </>
          )}

          {step === 'bills' ? (
            <div>
              <div className="flex items-center justify-between mb-1.5">
                <label className="text-[11px] font-semibold text-slate-500">Bills *</label>
                <span className="text-[11px] text-slate-400">
                  {bills.length} / {maxBills}
                </span>
              </div>
              {/* One card per day of the From–To range: its bills, the day's
                  total, and a chip per category — a tap adds a bill of that
                  category on that day, already dated. */}
              <div className="space-y-2.5">
                {days.map((day, di) => {
                  const dayBills = bills.filter((b) => b.bill_date === day);
                  const dayTotal = dayBills.reduce((s, b) => s + billAmount(b), 0);
                  const closed = locked.has(day);
                  const prevDay = di > 0 ? days[di - 1] : null;
                  const prevCopyable = prevDay ? bills.filter((b) => b.bill_date === prevDay && b.category_id && !isTransportBill(b)) : [];
                  return (
                    <div key={day} data-testid="bill-day" data-day={day} className={`border rounded-2xl overflow-hidden ${closed ? 'border-slate-200 bg-slate-50' : 'border-slate-200 bg-white/70'}`}>
                      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1.5">
                        <span className="text-xs font-semibold text-slate-700">{dayLabel(day)}</span>
                        <span className="text-[11px] text-slate-400">
                          {closed ? 'in another claim' : dayBills.length === 0 ? 'no bills' : `${dayBills.length} bill${dayBills.length === 1 ? '' : 's'}`}
                        </span>
                        <span className={`ml-auto text-xs font-bold tabular-nums ${dayTotal > 0 ? 'text-slate-900' : 'text-slate-300'}`}>{money(dayTotal)}</span>
                      </div>
                      {closed && (
                        <p className="px-3 pb-2.5 text-[11px] text-slate-500 flex items-center gap-1">
                          <Lock className="w-3 h-3" />
                          {policy?.values.one_claim_per_date ? 'This date is already in another claim — edit that claim.' : 'This date was already claimed on an earlier day.'}
                        </p>
                      )}
                      <div className="px-2.5 space-y-1.5">
                        {dayBills.map((b) => {
                          const n = bills.findIndex((x) => x.key === b.key) + 1;
                          const cat = categories.find((c) => String(c.id) === b.category_id);
                          if (editing === b.key) return <React.Fragment key={b.key}>{renderEditor(b, n)}</React.Fragment>;
                          const refCount = refsDriveBill(b) ? Object.keys(selectedRefs).length : 0;
                          const rc = receiptsOf(b).length;
                          const missing = needsBillReceipt(b) && rc === 0;
                          return (
                            <button
                              key={b.key}
                              type="button"
                              onClick={() => startEdit(b.key)}
                              aria-label={`Bill ${n}: ${cat?.name || 'no category'} ${money(billAmount(b))}${missing ? ', receipt needed' : rc ? `, ${rc} receipt${rc === 1 ? '' : 's'}` : ''} — edit`}
                              className={`w-full flex items-center gap-2 text-left px-3 py-2 rounded-xl bg-white border hover:border-slate-300 ${missing ? 'border-rose-300' : 'border-slate-200'}`}
                            >
                              <span className="min-w-0 flex-1 truncate text-xs">
                                <span className={`font-semibold ${cat ? 'text-slate-800' : 'text-rose-600'}`}>{cat?.name || 'Choose a category'}</span>
                                {rc > 0 && <span className="ml-1.5 inline-block align-middle text-[10px] font-semibold px-1.5 py-px rounded-full bg-emerald-100 text-emerald-800">📎 {rc}</span>}
                                {missing && <span className="ml-1.5 inline-block align-middle text-[10px] font-semibold px-1.5 py-px rounded-full bg-rose-100 text-rose-700">📎 receipt needed</span>}
                                {refCount > 0 ? (
                                  <span className="text-slate-400"> · {refCount} check-in/out{refCount === 1 ? '' : 's'}</span>
                                ) : b.description ? (
                                  <span className="text-slate-400"> · {b.description}</span>
                                ) : null}
                              </span>
                              <span className={`text-xs font-semibold tabular-nums ${billAmount(b) > 0 ? 'text-slate-900' : 'text-rose-600'}`}>
                                {billAmount(b) > 0 ? money(billAmount(b)) : 'add amount'}
                              </span>
                            </button>
                          );
                        })}
                      </div>
                      {!closed && editing === null && (
                        <div className="flex flex-wrap gap-1.5 px-3 pt-2 pb-2.5">
                          {chipCategories.map((c) => (
                            <button
                              key={c.id}
                              type="button"
                              onClick={() => addBillOn(day, String(c.id))}
                              disabled={bills.length >= maxBills}
                              className="text-[11px] font-semibold px-2.5 py-1 rounded-full border border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100 disabled:opacity-40"
                            >
                              + {c.name}
                            </button>
                          ))}
                          {dayBills.length === 0 && prevCopyable.length > 0 && (
                            <button
                              type="button"
                              onClick={() => copyDay(prevDay!, day)}
                              disabled={bills.length >= maxBills}
                              className="text-[11px] font-semibold px-2.5 py-1 rounded-full border border-dashed border-slate-300 text-slate-600 bg-white hover:bg-slate-50 disabled:opacity-40"
                            >
                              ⧉ Same as {formatDate(prevDay!).slice(0, 6)}
                            </button>
                          )}
                        </div>
                      )}
                      {(closed || editing !== null) && <div className="h-2" />}
                    </div>
                  );
                })}
              </div>
              {!transportBill && chipCategories.some((c) => isTransportName(c.name)) && (
                <p className="mt-1.5 text-[11px] text-slate-400">
                  Travel on office work? Tap <span className="font-semibold">+ Transport</span> to add your Check In/Out.
                </p>
              )}
              <div className="mt-3 flex items-center justify-between px-3 py-2.5 rounded-xl bg-blue-50 text-sm">
                <span className="text-slate-600">
                  Claim total
                  {hasRefs && <span className="text-[11px] text-slate-400"> (Transport {money(refsTotal)} from check-in/out)</span>}
                </span>
                <span className="font-bold text-slate-900" data-testid="bill-claim-total">{money(claimTotal)}</span>
              </div>
              {missingReceipts.length > 0 && editing === null && (
                <p className="mt-2 text-[11.5px] leading-snug text-rose-700 bg-rose-50 rounded-xl px-3 py-2" data-testid="receipts-missing">
                  {missingReceipts.length === 1 ? '1 bill still needs its receipt' : `${missingReceipts.length} bills still need their receipts`} —{' '}
                  {missingReceipts
                    .slice(0, 3)
                    .map((b) => `${categories.find((c) => String(c.id) === b.category_id)?.name || 'Bill'} on ${formatDate(b.bill_date).slice(0, 6)}`)
                    .join(', ')}
                  . Tap it to add.
                </p>
              )}
            </div>
          ) : (
            <div className="space-y-4" data-testid="bill-claim-review">
              <div>
                <div className="text-xs text-slate-500">
                  {formatDate(fromDate)}
                  {toDate !== fromDate ? ` – ${formatDate(toDate)}` : ''} · {bills.length} bill{bills.length === 1 ? '' : 's'}
                </div>
                <div className="text-3xl font-extrabold text-slate-900 mt-0.5 tabular-nums">{money(claimTotal)}</div>
                <table className="w-full mt-2 text-[13px]">
                  <tbody>
                    {reviewRows.map((r) => (
                      <tr key={r.name} className="border-b border-slate-100">
                        <td className="py-1.5 text-slate-700">
                          {r.name}
                          {r.trips ? ` (${r.trips} trip${r.trips === 1 ? '' : 's'})` : r.count > 1 ? ` × ${r.count}` : ''}
                        </td>
                        <td className="py-1.5 text-right font-semibold tabular-nums">{money(r.total)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {(allReceipts.length > 0 || bills.some(needsBillReceipt)) && (
                <div data-testid="review-receipts">
                  <div className="flex justify-between text-[11px] font-semibold text-slate-500 mb-0.5">
                    <span>Receipts</span>
                    <span>
                      {allReceipts.length} file{allReceipts.length === 1 ? '' : 's'}
                    </span>
                  </div>
                  {bills.map((b) => {
                    const list = receiptsOf(b);
                    const cat = categories.find((c) => String(c.id) === b.category_id);
                    const label = `${cat?.name || 'Bill'} · ${formatDate(b.bill_date).slice(0, 6)}`;
                    if (!list.length && !needsBillReceipt(b)) {
                      return (
                        <div key={b.key} className="flex items-center gap-2.5 py-1.5 border-b border-slate-100 text-[13px] text-slate-400">
                          <span className="w-7 h-7 rounded-lg border border-dashed border-slate-200 shrink-0" />
                          {label}
                          <span className="ml-auto">not needed</span>
                        </div>
                      );
                    }
                    return (
                      <button
                        key={b.key}
                        type="button"
                        onClick={() => list.length && setViewing({ list, index: 0 })}
                        className="w-full flex items-center gap-2.5 py-1.5 border-b border-slate-100 text-[13px] text-left text-slate-800"
                      >
                        <span className="w-7 h-7 rounded-lg border border-slate-200 bg-slate-50 overflow-hidden shrink-0 flex items-center justify-center">
                          {list[0]?.url ? <img src={list[0].url} alt="" className="w-full h-full object-cover object-top" /> : <FileText className="w-3.5 h-3.5 text-slate-400" />}
                        </span>
                        {label}
                        <span className={`ml-auto font-semibold ${list.length ? '' : 'text-rose-600'}`}>
                          {list.length ? `${list.length} file${list.length === 1 ? '' : 's'}` : 'needed'}
                        </span>
                      </button>
                    );
                  })}
                </div>
              )}

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
                  {needsReceipt
                    ? 'Receipt * (this claim needs one — image/PDF, up to 5MB)'
                    : allReceipts.length || bills.some(needsBillReceipt)
                      ? 'Other attachment (optional, image/PDF, up to 5MB)'
                      : 'Attachment (optional, image/PDF, up to 5MB)'}
                </label>
                <label className="flex items-center gap-2 text-sm px-3 py-2.5 bg-slate-50 border border-dashed border-slate-300 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors">
                  <Paperclip className="w-4 h-4 text-slate-400 shrink-0" />
                  <span className="text-slate-600 truncate">{file ? file.name : 'Choose a file…'}</span>
                  <input
                    ref={fileInputRef}
                    type="file"
                    accept="image/png,image/jpeg,image/webp,application/pdf"
                    onChange={(e) => handleFilePick(e.target.files?.[0] || null)}
                    className="hidden"
                  />
                </label>
                {fileError && <p className="mt-1 text-[11px] text-rose-600">{fileError}</p>}
                {hadFile && !file && (
                  <label className="mt-1.5 flex items-center gap-1.5 text-[11px] text-slate-600">
                    <input type="checkbox" checked={removeOldFile} onChange={(e) => setRemoveOldFile(e.target.checked)} />
                    Remove the current attachment ({editClaim?.file_name || 'file'})
                  </label>
                )}
              </div>

              {!error && (
                <div className="flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-800">
                  <CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                  <span>
                    All dates are inside {formatDate(minDate)} – {formatDate(maxDate)}
                    {locked.size ? ' and none is in another claim' : ''}
                    {bills.some(needsBillReceipt) ? ', and every bill that needs a receipt has one' : ''}.
                  </span>
                </div>
              )}
            </div>
          )}

          {error && (
            <div className="flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700" role="alert">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
        </div>

        {editing !== null && editingBill ? (
          // Adding / changing one bill: one bar just above the keyboard —
          // what it is, how much is left today, Cancel and Add. The popup's
          // own Cancel / Review wait until the bill is done.
          <div className="px-4 pb-4 pt-3 flex items-center gap-2 shrink-0 border-t border-slate-200/70" data-testid="bill-edit-bar">
            <span className="min-w-0 flex-1 truncate text-[11px] font-semibold text-slate-500">
              {categories.find((c) => String(c.id) === editingBill.category_id)?.name || 'Bill'} · {formatDate(editingBill.bill_date).slice(0, 6)}
              {editingLeft != null && <span className={editingLeft < 0 ? 'text-rose-600' : 'text-blue-600'}> · {editingLeft < 0 ? `${money(-editingLeft)} over today` : `${money(editingLeft)} left today`}</span>}
            </span>
            <button type="button" onClick={cancelEdit} className="liquid-glass-chip rounded-full px-4 py-2 text-slate-700 text-sm font-semibold">
              Cancel
            </button>
            <button type="button" onClick={finishEdit} className="liquid-glass-button rounded-full inline-flex items-center gap-1.5 px-4 py-2 font-semibold text-sm">
              <CheckCircle2 className="w-4 h-4" /> {editingIsNew ? 'Add' : 'Done'}
            </button>
          </div>
        ) : step === 'bills' ? (
          <div className="px-5 pb-5 pt-3 flex justify-end gap-3 shrink-0">
            <button
              type="button"
              onClick={close}
              disabled={submitting}
              className="liquid-glass-chip rounded-full px-4 py-2.5 disabled:opacity-50 text-slate-700 text-sm font-semibold"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={goReview}
              disabled={!policy || !!todayClaimId}
              className="liquid-glass-button rounded-full inline-flex items-center gap-1.5 px-5 py-2.5 disabled:opacity-50 font-semibold text-sm"
            >
              <ArrowRight className="w-4 h-4" /> Review
            </button>
          </div>
        ) : (
          <div className="px-5 pb-5 pt-3 flex justify-end gap-3 shrink-0">
            <button
              type="button"
              onClick={() => {
                setError('');
                setStep('bills');
              }}
              disabled={submitting}
              className="liquid-glass-chip rounded-full inline-flex items-center gap-1 px-4 py-2.5 disabled:opacity-50 text-slate-700 text-sm font-semibold"
            >
              <ArrowLeft className="w-4 h-4" /> Back
            </button>
            <button
              type="button"
              onClick={handleSubmit}
              disabled={submitting || !policy || !!todayClaimId}
              className="liquid-glass-button rounded-full inline-flex items-center gap-1.5 px-5 py-2.5 disabled:opacity-50 font-semibold text-sm"
            >
              {submitting ? <Spinner size={16} /> : <CheckCircle2 className="w-4 h-4" />}
              {editClaim ? (editClaim.edit_mode === 'pending' ? 'Save Changes' : 'Resubmit') : 'Submit Claim'}
            </button>
          </div>
        )}
      </div>
      </div>
      {viewing && viewing.list[viewing.index] && (
        <AttachmentViewer
          token={token}
          src={
            viewing.list[viewing.index].id && editId
              ? `/api/bill-claims/${editId}/item-files/${viewing.list[viewing.index].id}`
              : ''
          }
          load={viewing.list[viewing.index].file ? () => Promise.resolve(viewing.list[viewing.index].file as Blob) : undefined}
          type={viewing.list[viewing.index].type}
          name={viewing.list[viewing.index].name}
          nav={
            viewing.list.length > 1
              ? {
                  index: viewing.index,
                  count: viewing.list.length,
                  onPrev: () => setViewing((v) => (v ? { ...v, index: Math.max(0, v.index - 1) } : v)),
                  onNext: () => setViewing((v) => (v ? { ...v, index: Math.min(v.list.length - 1, v.index + 1) } : v))
                }
              : undefined
          }
          onClose={() => setViewing(null)}
        />
      )}
    </div>,
    document.body
  );
};