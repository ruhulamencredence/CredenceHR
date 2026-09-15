/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Plus, Trash2, Save, X, Briefcase, Lock, ChevronDown, ChevronRight, Pencil, Calendar, Hash, Scissors } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { formatDate, todayDateOnlyString, dateRangeOptions, formatDateLabel } from '../lib/formatDate';
import { Entry, BudgetItem, MprNumber, PendingJobEdit } from '../types';
import { Spinner } from './Spinner';

// Pulls just the leading numeric portion out of a free-text Qty string imported from
// Excel (e.g. "120.50 pcs" -> 120.5) — mirrors the server's parseQtyNumber (and the
// identical helper in UserPanel.tsx's "New Job Entry" form) so the client's
// remaining-Qty math always agrees with what the server will enforce.
function parseQtyNumber(value: any): number | null {
  if (value === null || value === undefined) return null;
  const match = String(value).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
}

// Unique id for one Item entry within the "Add MPR" form's item list — see AddItemOption.
const makeItemUid = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// One imported Budget Excel row (budget_items.id + its Description of Materials) that
// the "Add MPR" form's selected MPR No carries. Mirrors MprItemOption in
// UserPanel.tsx's "New Job Entry" form exactly, so adding an MPR to an existing
// (Final Submitted) Job behaves identically to adding one on a brand-new Job: every
// Item under the MPR No auto-fills, each gets its own Qty (capped to what's left) and
// can be split into a further Item with its own Delivery Date.
interface AddItemOption {
  uid: string;
  budgetItemId: number;
  name: string;
  reqQty: number | null;
  remainingQty: number | null;
  qty: string;
  // Per-item Delivery Date override — empty string means "follow the shared Delivery
  // Date field below"; only relevant once there's more than one Item.
  deliveryDate: string;
}

// The Delivery Date that actually applies to one Item — its own override if one was
// set, otherwise the shared "Delivery Date" field.
const getAddItemDeliveryDate = (opt: AddItemOption, sharedDate: string): string => opt.deliveryDate || sharedDate;

// One row in the "Add New Job" form's item list — same shape as AddItemOption (see
// above) plus its own MPR No, since unlike the "Add MPR to this Job" form (which is
// always scoped to ONE MPR No at a time), a brand-new Job can carry several
// different MPR Nos at once, each contributing its own Item rows.
interface NewJobItemRow extends AddItemOption {
  mprNo: string;
}

// Latest ("max") of any given date strings, ignoring null/undefined/empty ones —
// used to combine several floors (today, the Budget's delivery_date_from, an
// entry's own entry_date) into a single min= for a date picker. Plain
// "YYYY-MM-DD" strings compare correctly with normal string comparison.
function latestDateStr(...dates: (string | null | undefined)[]): string | undefined {
  const valid = dates.map((d) => (d ? String(d).slice(0, 10) : '')).filter(Boolean);
  if (valid.length === 0) return undefined;
  return valid.reduce((a, b) => (b > a ? b : a));
}

interface JobEditPanelProps {
  token: string;
}

interface JobGroup {
  job_id: number;
  job_no: string;
  job_name: string;
  job_duration: string;
  budget_id: number;
  budget_name: string | null;
  // Admin-set allowed Delivery Date window for the Budget this Job belongs to
  // (both null = no restriction) — used to set min/max on the Delivery Date
  // pickers below, same rule the main Job Entry form already enforces.
  delivery_date_from: string | null;
  delivery_date_to: string | null;
  project_id: number;
  project_name: string;
  entries: Entry[];
}

// "Job Edit" — only reachable at all when the Admin has switched can_job_edit ON for
// this user (Admin Panel -> Users). Lets the user add a new MPR into a Job whose
// Budget has already been Final Submitted (normally impossible — POST /api/entries
// only ever creates a brand-new Job), and edit/delete the MPR rows already in it.
// Jobs whose Budget ISN'T Final Submitted yet are left out here on purpose — those
// are still edited the normal way from the "Job Entry Details" section above.
export const JobEditPanel: React.FC<JobEditPanelProps> = ({ token }) => {
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState('');
  const [jobs, setJobs] = useState<JobGroup[]>([]);
  const [openJobId, setOpenJobId] = useState<number | null>(null);
  const [mprNumbers, setMprNumbers] = useState<MprNumber[]>([]);
  // This user's own queued Job Edit changes (Delivery Date edit / add MPR / delete
  // MPR / add new Job) that are pending Admin approval, or were reviewed within the
  // last couple of days — see GET /api/job-edits/mine. Drives the "Edit Pending for
  // Admin Approval" badges below.
  const [pendingEdits, setPendingEdits] = useState<PendingJobEdit[]>([]);
  // Whether the "Add New Job" form (below the header, above the Job list) is open.
  const [showNewJobForm, setShowNewJobForm] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const loadJobs = async () => {
    setLoading(true);
    setLoadError('');
    try {
      const [entriesRes, mprRes] = await Promise.all([
        fetch(apiUrl('/api/entries'), { headers: authHeaders }),
        fetch(apiUrl('/api/mpr-numbers'), { headers: authHeaders })
      ]);
      const entriesData = await entriesRes.json();
      const mprData = await mprRes.json();
      if (!entriesRes.ok) throw new Error(entriesData.error || 'Failed to load Jobs');
      setMprNumbers(Array.isArray(mprData) ? mprData : []);

      const locked: Entry[] = (Array.isArray(entriesData) ? entriesData : []).filter(
        (e: Entry) => e.budget_locked
      );
      const byJob = new Map<number, JobGroup>();
      for (const e of locked) {
        if (!byJob.has(e.job_id)) {
          // Read the Delivery Date window straight off this entry (joined from budgets
          // by the server) — NOT from GET /api/budgets, which only returns Budgets an
          // admin has marked is_published for a non-admin caller. A locked Job's Budget
          // can be unpublished (or was never published to this user at all) and would
          // then silently vanish from that list, leaving the date picker unrestricted.
          const range = { from: e.delivery_date_from ?? null, to: e.delivery_date_to ?? null };
          byJob.set(e.job_id, {
            job_id: e.job_id,
            job_no: e.job_no,
            job_name: e.job_name,
            job_duration: e.job_duration,
            budget_id: e.budget_id as number,
            budget_name: e.budget_name ?? null,
            delivery_date_from: range.from,
            delivery_date_to: range.to,
            project_id: e.project_id,
            project_name: e.project_name,
            entries: []
          });
        }
        byJob.get(e.job_id)!.entries.push(e);
      }
      setJobs([...byJob.values()].sort((a, b) => b.job_id - a.job_id));
    } catch (err: any) {
      setLoadError(err.message || 'Something went wrong');
    } finally {
      setLoading(false);
    }
  };

  const loadPending = async () => {
    try {
      const res = await fetch(apiUrl('/api/job-edits/mine'), { headers: authHeaders });
      const data = await res.json();
      if (res.ok) setPendingEdits(Array.isArray(data) ? data : []);
    } catch {
      // Non-fatal — the panel still works, it just won't show pending badges.
    }
  };

  // Reloads both Jobs and this user's pending Job Edit requests together, so an
  // action that got queued for approval (instead of applied) shows up as pending
  // right away instead of just silently doing nothing to the Job list.
  const refresh = async () => {
    await Promise.all([loadJobs(), loadPending()]);
  };

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Card chrome (rounded-2xl/border/shadow) + a "grow to fit content, page
  // scrolls" min-h is what every OTHER section on the Dashboard uses, since
  // they all sit side-by-side inside the padded/spaced grid. Job Edit is
  // different — the moment it's the active desktop section it's the ONLY
  // thing showing there (see UserPanel.tsx's wrapping div, which cancels that
  // grid's padding/spacing on desktop with negative margins so this really
  // does start flush under the header and reach the true edges), so on
  // desktop it drops the card look entirely and instead becomes a fixed
  // h-[calc(100vh-4rem)] pane (4rem = Navbar's h-16) that owns its own
  // internal scroll — a proper full-screen page instead of a card floating
  // inside one. Mobile is untouched: it still grows with its content and lets
  // the whole page scroll, exactly as before.
  if (loading) {
    return (
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm flex items-center justify-center gap-2 text-slate-500 text-sm min-h-[calc(100dvh-14rem)] md:min-h-0 md:h-[calc(100vh-4rem)] md:rounded-none md:border-0 md:border-t md:shadow-none">
        <Spinner size={16} /> Loading Jobs…
      </div>
    );
  }

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden flex flex-col min-h-[calc(100dvh-14rem)] md:min-h-0 md:h-[calc(100vh-4rem)] md:rounded-none md:border-0 md:border-t md:shadow-none">
      <div className="px-6 py-4 border-b border-slate-200 flex items-center justify-between gap-2.5 shrink-0">
        <div className="flex items-center gap-2.5">
          <div className="p-2 bg-blue-50 rounded-lg">
            <Briefcase className="w-4 h-4 text-blue-600" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Job Edit</h2>
            <p className="text-[11px] text-slate-400">
              Add, edit or delete an MPR inside a Job you've already Final Submitted — or add a brand-new Job.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowNewJobForm((v) => !v)}
          className="shrink-0 inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
        >
          {showNewJobForm ? <X className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
          {showNewJobForm ? 'Cancel' : 'Add New Job'}
        </button>
      </div>

      {/* Everything below the header bar above scrolls WITHIN this pane on
          desktop (md:overflow-y-auto) instead of growing the pane itself and
          leaving the browser to scroll the whole Dashboard — the header bar
          stays pinned (shrink-0 above) while a long Job list scrolls under
          it. Mobile keeps the old plain-flow behavior (no separate scroll
          region) since the whole page already scrolls there. */}
      <div className="flex-1 md:overflow-y-auto">
        {showNewJobForm && (
          <div className="p-6 border-b border-slate-200 bg-slate-50/60">
            <NewJobRequestForm
              token={token}
              jobs={jobs}
              mprNumbers={mprNumbers}
              onSubmitted={() => {
                setShowNewJobForm(false);
                refresh();
              }}
            />
          </div>
        )}

        <PendingNewJobRequests requests={pendingEdits.filter((p) => p.action === 'add_job')} />

        {loadError && (
          <div className="mx-6 mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs">
            {loadError}
          </div>
        )}

        {!loadError && jobs.length === 0 && (
          <div className="flex items-center justify-center px-6 py-10 text-center text-sm text-slate-400">
            No Final Submitted Jobs yet. Once you Submit a Budget, its Jobs will show up here.
          </div>
        )}

        <div className="divide-y divide-slate-100">
          {jobs.map((job) => (
            <JobEditRow
              key={job.job_id}
              job={job}
              token={token}
              mprNumbers={mprNumbers}
              isOpen={openJobId === job.job_id}
              onToggle={() => setOpenJobId(openJobId === job.job_id ? null : job.job_id)}
              onChanged={refresh}
              pendingForJob={pendingEdits.filter((p) => p.job_id === job.job_id)}
            />
          ))}
        </div>
      </div>
    </div>
  );
};

// ---- One Job's accordion row: its MPR list (edit/delete) + the "Add MPR" form ----

interface JobEditRowProps {
  job: JobGroup;
  token: string;
  mprNumbers: MprNumber[];
  isOpen: boolean;
  onToggle: () => void;
  onChanged: () => void;
  // This user's own pending/recently-reviewed Job Edit requests scoped to this Job.
  pendingForJob: PendingJobEdit[];
}

// One line of "Current: X  →  Proposed: Y" (or just "Proposed: Y" when there's no
// meaningful current value, e.g. a brand-new MPR row) — the side-by-side view the
// user asked for while a Job Edit sits pending Admin approval.
const CurrentVsProposed: React.FC<{ current?: string | null; proposed: string }> = ({ current, proposed }) => (
  <span className="inline-flex flex-wrap items-center gap-1">
    {current !== undefined && current !== null && (
      <>
        <span className="line-through text-slate-400">{current}</span>
        <span className="text-slate-400">→</span>
      </>
    )}
    <span className="font-semibold text-amber-700">{proposed}</span>
  </span>
);

const PendingBadge: React.FC<{ label: string }> = ({ label }) => (
  <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200 text-[10px] font-semibold whitespace-nowrap">
    <Spinner size={16} /> {label}
  </span>
);

const JobEditRow: React.FC<JobEditRowProps> = ({ job, token, mprNumbers, isOpen, onToggle, onChanged, pendingForJob }) => {
  const authHeaders = { Authorization: `Bearer ${token}` };

  // This Job's existing MPR rows that currently have a pending (unreviewed) request
  // against them (Delivery Date edit or delete) — at most one per entry, enforced
  // server-side. Rejected-within-the-last-2-days ones are kept separately so a brief
  // "Rejected by Admin" note can show once, instead of a stale pending badge.
  const pendingByEntryId = new Map<number, PendingJobEdit>();
  const rejectedByEntryId = new Map<number, PendingJobEdit>();
  for (const p of pendingForJob) {
    if (p.action === 'add_item' || !p.entry_id) continue;
    if (p.status === 'pending') pendingByEntryId.set(p.entry_id, p);
    else if (p.status === 'rejected') rejectedByEntryId.set(p.entry_id, p);
  }
  // Proposed brand-new MPR rows ("Add MPR to this Job") still waiting on Admin
  // approval — these aren't real entries yet, so they're rendered as extra
  // "ghost" rows below the real ones instead of being merged into job.entries.
  const pendingAddRows = pendingForJob.filter((p) => p.action === 'add_item' && p.status === 'pending');

  const [rowError, setRowError] = useState('');
  // Brief "submitted — pending Admin approval" confirmation shown right after an
  // action gets queued instead of applied (distinct from rowError, which is red).
  const [rowNotice, setRowNotice] = useState('');
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDate, setEditDate] = useState('');
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  // Which existing MPR row is currently showing its "why are you deleting this"
  // confirmation, and the reason typed into it so far — Delete no longer fires
  // straight off window.confirm; it opens this inline prompt first (same row-level
  // pattern as editingId/editDate above) so an Edit Reason can be required and sent
  // up to the server alongside the delete request.
  const [confirmDeleteId, setConfirmDeleteId] = useState<number | null>(null);
  const [deleteReason, setDeleteReason] = useState('');

  const [showAddForm, setShowAddForm] = useState(false);
  const [budgetItems, setBudgetItems] = useState<BudgetItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [addMprNo, setAddMprNo] = useState('');
  // Whether the MPR No dropdown below is open — a native <datalist> doesn't show a
  // dropdown on the Capacitor Android WebView (see UserPanel.tsx's identical note),
  // so this field uses the same custom type-to-search dropdown pattern used
  // everywhere else in the app instead.
  const [showAddMprDropdown, setShowAddMprDropdown] = useState(false);
  // Every Item under the selected MPR No, auto-filled the moment it's picked — same
  // "New Job Entry" behavior as UserPanel.tsx's MPR row, instead of making the user
  // pick one Item at a time.
  const [addItems, setAddItems] = useState<AddItemOption[]>([]);
  // Shared Delivery Date — applies to any Item above that doesn't have its own
  // per-item override (see AddItemOption.deliveryDate).
  const [addDeliveryDate, setAddDeliveryDate] = useState('');
  // Which Item's per-item Delivery Date popup is open, if any.
  const [addEditingItemUid, setAddEditingItemUid] = useState<string | null>(null);
  const [addItemDeliveryDraft, setAddItemDeliveryDraft] = useState('');
  const [addSaving, setAddSaving] = useState(false);
  const [addError, setAddError] = useState('');
  // Required justification for adding this MPR into an already Final-Submitted
  // Job — sent up alongside the items so the Admin reviewing it (Edit Log ->
  // Job Edit Approvals) sees WHY, not just what.
  const [addReason, setAddReason] = useState('');

  // Job Edit only ever lets an EXISTING MPR row's Delivery Date change — Qty (and
  // everything else) is locked once a row exists, same rule as everywhere else in
  // the app; the server rejects a Qty change here too, this just keeps the UI from
  // offering an input that would only fail. Qty is only ever set once, when the
  // row is first added via "Add MPR to this Job" below.
  // Renders the Delivery Date field used when editing an EXISTING MPR row — a
  // SELECT-only dropdown (no typing) once floor/to fully bound the window, exactly
  // like the "New Job Entry" form's Delivery Date picker, falling back to a normal
  // date input otherwise. Shared between the table (web) and card (Android) layouts.
  const renderExistingDeliveryPicker = (e: Entry, className: string) => {
    const floor = latestDateStr(todayDateOnlyString(), job.delivery_date_from, e.entry_date);
    const to = job.delivery_date_to || undefined;
    if (floor && to) {
      return (
        <select value={editDate} onChange={(ev) => setEditDate(ev.target.value)} className={className}>
          <option value="">Select a Delivery Date...</option>
          {dateRangeOptions(floor, to).map((d) => (
            <option key={d} value={d}>{formatDateLabel(d)}</option>
          ))}
        </select>
      );
    }
    return (
      <input
        type="date"
        value={editDate}
        min={floor}
        max={to}
        onChange={(ev) => setEditDate(ev.target.value)}
        className={className}
      />
    );
  };

  const startEdit = (e: Entry) => {
    if (pendingByEntryId.has(e.id)) return; // Edit disabled while a request is pending — see the button below.
    setRowError('');
    setRowNotice('');
    setEditingId(e.id);
    setEditDate(String(e.delivery_date).slice(0, 10));
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDate('');
  };

  const saveEdit = async (e: Entry) => {
    setSavingEdit(true);
    setRowError('');
    setRowNotice('');
    try {
      const res = await fetch(apiUrl(`/api/entries/${e.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          item_name: e.item_name,
          delivery_date: editDate,
          mpr_id: e.mpr_id,
          budget_item_id: e.budget_item_id
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save');
      cancelEdit();
      if (data.pending) setRowNotice(data.message || 'Submitted — pending Admin approval.');
      onChanged();
    } catch (err: any) {
      setRowError(err.message || 'Something went wrong');
    } finally {
      setSavingEdit(false);
    }
  };

  // Opens the inline "Delete MPR" confirmation for one row — the Edit Reason has to
  // be typed here before the actual delete fires, see confirmDelete below.
  const startDelete = (e: Entry) => {
    if (pendingByEntryId.has(e.id)) return; // Delete disabled while a request is pending — see the button below.
    setRowError('');
    setRowNotice('');
    setConfirmDeleteId(e.id);
    setDeleteReason('');
  };

  const cancelDelete = () => {
    setConfirmDeleteId(null);
    setDeleteReason('');
  };

  const confirmDelete = async (e: Entry) => {
    if (!deleteReason.trim()) {
      setRowError('Edit Reason is required to delete this MPR.');
      return;
    }
    setDeletingId(e.id);
    setRowError('');
    setRowNotice('');
    try {
      const res = await fetch(apiUrl(`/api/entries/${e.id}`), {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ reason: deleteReason.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete');
      cancelDelete();
      if (data.pending) setRowNotice(data.message || 'Submitted — pending Admin approval.');
      onChanged();
    } catch (err: any) {
      setRowError(err.message || 'Something went wrong');
    } finally {
      setDeletingId(null);
    }
  };

  // Always re-fetches Budget Items from the server, even if we already have a
  // copy in state — GET /api/budgets/:id/items returns requisitioned_by_me,
  // which drives every remainingQty below, and that number changes the moment
  // ANY Job under this same Budget gets a new/edited entry (this user's own
  // "New Job Entry" in UserPanel, another Job's "Add MPR" here, etc.). Caching
  // it past the first open meant reopening "Add MPR" on the same Job could
  // still show pre-update remaining Qtys — a gap between what Job Edit offered
  // and what UserPanel/the server actually had left, even right after a fresh
  // UserPanel update. Re-fetching every open keeps the two in sync.
  const openAddForm = async () => {
    setShowAddForm(true);
    setAddError('');
    setLoadingItems(true);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${job.budget_id}/items`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Budget Items');
      const scoped = (Array.isArray(data) ? data : []).filter(
        (it: BudgetItem) =>
          String(it.project_name || '').trim().toLowerCase() === job.project_name.trim().toLowerCase() &&
          it.mrf_no &&
          String(it.mrf_no).trim() !== ''
      );
      setBudgetItems(scoped);
    } catch (err: any) {
      setAddError(err.message || 'Could not load this Budget\'s Items');
    } finally {
      setLoadingItems(false);
    }
  };

  const mprNoOptions = [...new Set(budgetItems.map((it) => String(it.mrf_no).trim()))].sort();
  // MPR No options narrowed to whatever's currently typed into the "Add MPR" field —
  // feeds the custom dropdown below (see showAddMprDropdown).
  const filteredAddMprNoOptions = mprNoOptions.filter((mo) => mo.toLowerCase().includes(addMprNo.trim().toLowerCase()));

  // Every Item under a given MPR No, scoped to this Job's Budget/Project — exact same
  // rule as UserPanel.tsx's "New Job Entry" form's itemsForMprInBudget: an Item this
  // user has already fully requisitioned (remainingQty === 0) is left out, and every
  // OTHER imported Excel row under that MPR No (even ones sharing the same Description
  // text) gets its own entry instead of collapsing into one.
  const itemsForAddMpr = (mprNo: string): AddItemOption[] => {
    const out: AddItemOption[] = [];
    for (const bi of budgetItems) {
      if (String(bi.mrf_no || '').trim().toLowerCase() !== mprNo.trim().toLowerCase()) continue;
      const desc = String(bi.description || '').trim();
      if (!desc) continue;
      const reqQty = parseQtyNumber(bi.req_qty);
      const consumed = Number(bi.requisitioned_by_me || 0);
      const remainingQty = reqQty === null ? null : Math.max(0, reqQty - consumed);
      if (remainingQty !== null && remainingQty <= 0) continue;
      out.push({
        uid: makeItemUid(),
        budgetItemId: bi.id,
        name: desc,
        reqQty,
        remainingQty,
        qty: remainingQty !== null ? String(remainingQty) : '',
        deliveryDate: ''
      });
    }
    return out;
  };

  // Picking an MPR No auto-fills every Item under it, exactly like selecting an MPR No
  // on a brand-new Job — the user no longer picks one Item at a time.
  const selectAddMprNo = (mprNo: string) => {
    setAddMprNo(mprNo);
    setAddItems(itemsForAddMpr(mprNo));
    setAddDeliveryDate('');
    setAddError('');
  };

  const updateAddItemQty = (uid: string, qty: string) => {
    setAddItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, qty } : it)));
  };

  // Opens the per-item Delivery Date popup, seeding its draft with whatever's already
  // in effect (its own override, or the shared date) so it never opens empty.
  const openAddItemDeliveryEditor = (opt: AddItemOption) => {
    setAddEditingItemUid(opt.uid);
    setAddItemDeliveryDraft(getAddItemDeliveryDate(opt, addDeliveryDate));
  };

  const saveAddItemDeliveryDraft = () => {
    if (!addEditingItemUid) return;
    const uid = addEditingItemUid;
    setAddItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, deliveryDate: addItemDeliveryDraft } : it)));
    setAddEditingItemUid(null);
  };

  const clearAddItemDeliveryOverride = () => {
    if (!addEditingItemUid) return;
    const uid = addEditingItemUid;
    setAddItems((prev) => prev.map((it) => (it.uid === uid ? { ...it, deliveryDate: '' } : it)));
    setAddEditingItemUid(null);
  };

  // Splits an Item's leftover Qty into a NEW Item entry — for when only part of an
  // Item's available Qty should go out against the current Delivery Date and the rest
  // needs a different one. Mirrors splitLeftoverInSameRow in UserPanel.tsx exactly.
  const splitLeftoverInAdd = (uid: string) => {
    const opt = addItems.find((it) => it.uid === uid);
    if (!opt) return;
    const entered = Number(opt.qty);
    if (opt.remainingQty === null || !Number.isFinite(entered) || entered <= 0 || entered >= opt.remainingQty) return;
    const leftover = opt.remainingQty - entered;
    const newItem: AddItemOption = {
      uid: makeItemUid(),
      budgetItemId: opt.budgetItemId,
      name: opt.name,
      reqQty: opt.reqQty,
      remainingQty: leftover,
      qty: String(leftover),
      deliveryDate: ''
    };
    setAddItems((prev) => {
      const idx = prev.findIndex((it) => it.uid === uid);
      if (idx === -1) return prev;
      const updated = prev.map((it) => (it.uid === uid ? { ...it, remainingQty: entered } : it));
      const next = [...updated];
      next.splice(idx + 1, 0, newItem);
      return next;
    });
  };

  // Drops a single Item out of the list (only meaningful with more than one Item —
  // removing the last one would leave nothing to add, so this is a no-op then).
  const removeItemFromAdd = (uid: string) => {
    setAddItems((prev) => (prev.length <= 1 ? prev : prev.filter((it) => it.uid !== uid)));
  };

  // Items still available to bring (back) into the list — every imported Excel row
  // under the selected MPR No that isn't currently present, whether dropped via the X
  // button or never auto-filled to begin with.
  const addableItemsForAdd = (): AddItemOption[] => {
    if (!addMprNo) return [];
    const present = new Set(addItems.map((it) => it.budgetItemId));
    return itemsForAddMpr(addMprNo).filter((it) => !present.has(it.budgetItemId));
  };

  const addItemToAdd = (budgetItemId: number) => {
    const toAdd = itemsForAddMpr(addMprNo).find((it) => it.budgetItemId === budgetItemId);
    if (!toAdd) return;
    setAddItems((prev) => [...prev, toAdd]);
  };

  const resetAddForm = () => {
    setShowAddForm(false);
    setAddMprNo('');
    setAddItems([]);
    setAddDeliveryDate('');
    setAddEditingItemUid(null);
    setAddItemDeliveryDraft('');
    setAddError('');
    setAddReason('');
  };

  // Floor/ceiling for every Delivery Date in this form — every new row added here is
  // dated today (entry_date, set server-side), so the floor is whichever is LATER of
  // today and the Budget's delivery_date_from; the ceiling is the Budget's
  // delivery_date_to, if any. Same rule the server enforces in
  // POST /api/entries/job/:jobId/items.
  const addDeliveryFloor = latestDateStr(todayDateOnlyString(), job.delivery_date_from);
  const addDeliveryTo = job.delivery_date_to || undefined;

  const submitAdd = async () => {
    setAddError('');
    if (!addMprNo || addItems.length === 0) {
      setAddError('Select an MPR No.');
      return;
    }
    if (!addReason.trim()) {
      setAddError('Edit Reason is required.');
      return;
    }
    for (const opt of addItems) {
      const q = Number(opt.qty);
      if (!opt.qty || !Number.isFinite(q) || q <= 0) {
        setAddError(`Enter a valid Requisitioned Qty for "${opt.name}".`);
        return;
      }
      if (opt.remainingQty !== null && q > opt.remainingQty) {
        setAddError(`Requisitioned Qty for "${opt.name}" can't exceed the remaining available Qty (${opt.remainingQty}).`);
        return;
      }
      if (!getAddItemDeliveryDate(opt, addDeliveryDate)) {
        setAddError(`Select a Delivery Date for "${opt.name}".`);
        return;
      }
    }
    const mprMatch = mprNumbers.find(
      (m) => m.mpr_no.trim().toLowerCase() === addMprNo.trim().toLowerCase()
    );
    if (!mprMatch) {
      setAddError('That MPR No isn\'t in the system MPR list. Ask your Admin to add it first.');
      return;
    }
    setAddSaving(true);
    try {
      const res = await fetch(apiUrl(`/api/entries/job/${job.job_id}/items`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          // Every Item currently in the list becomes its own entry, sharing this MPR
          // No — same "New Job Entry" shape as UserPanel.tsx's handleSubmitEntry.
          items: addItems.map((opt) => ({
            mpr_id: mprMatch.id,
            budget_item_id: opt.budgetItemId,
            requisitioned_qty: Number(opt.qty),
            delivery_date: getAddItemDeliveryDate(opt, addDeliveryDate)
          })),
          reason: addReason.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add MPR');
      resetAddForm();
      if (data.pending) setRowNotice(data.message || 'Submitted — pending Admin approval.');
      onChanged();
    } catch (err: any) {
      setAddError(err.message || 'Something went wrong');
    } finally {
      setAddSaving(false);
    }
  };

  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        className="w-full flex items-center justify-between gap-3 px-6 py-3.5 hover:bg-slate-50 transition-colors text-left"
      >
        <div className="flex items-center gap-2 min-w-0">
          {isOpen ? (
            <ChevronDown className="w-4 h-4 text-slate-400 shrink-0" />
          ) : (
            <ChevronRight className="w-4 h-4 text-slate-400 shrink-0" />
          )}
          <div className="min-w-0">
            <p className="text-sm font-semibold text-slate-800 truncate">
              {job.job_no} · {job.job_name}
            </p>
            <p className="text-[11px] text-slate-400 truncate">
              {job.project_name} {job.budget_name ? `· ${job.budget_name}` : ''} · {job.entries.length} MPR
              {job.entries.length !== 1 ? 's' : ''}
            </p>
          </div>
        </div>
        <span className="shrink-0 inline-flex items-center gap-1 text-[10px] font-medium text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-2 py-0.5">
          <Lock className="w-2.5 h-2.5" /> Final Submitted
        </span>
      </button>

      {isOpen && (
        <div className="px-6 pb-5">
          {rowError && (
            <div className="mb-3 p-2.5 rounded-lg bg-rose-50 border border-rose-200 text-rose-700 text-xs">
              {rowError}
            </div>
          )}
          {rowNotice && (
            <div className="mb-3 p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs">
              {rowNotice}
            </div>
          )}
          {/* Card layout below sm: (mobile web AND the native app — Capacitor
              WebViews are always under the sm: breakpoint anyway), the
              original table at sm: and up. Used to be native-app-only (a
              plain isNativeApp check), which left mobile web stuck with the
              desktop table squeezed into a narrow viewport — same fix as the
              "Add MPR"/"Add New Job" forms elsewhere in this file. */}
          <div className="sm:hidden space-y-2.5">
            {job.entries.map((e) => {
              const pending = pendingByEntryId.get(e.id);
              const rejected = rejectedByEntryId.get(e.id);
              return (
              <div
                key={e.id}
                className={`rounded-xl border overflow-hidden ${pending ? 'border-amber-300 bg-amber-50/30' : 'border-slate-200 bg-white'}`}
              >
                <div className="p-3.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-xs font-semibold">
                      <Hash className="w-3 h-3" /> {e.mpr_no}
                    </span>
                    {pending && (
                      <PendingBadge
                        label={pending.action === 'delete_entry' ? 'Delete Pending Admin Approval' : 'Edit Pending Admin Approval'}
                      />
                    )}
                  </div>
                  <p className="text-sm text-slate-800 font-medium leading-snug break-words mt-1.5" title={e.item_name}>
                    {e.item_name}
                  </p>

                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Qty</p>
                      <p className="text-sm text-slate-700 font-medium mt-0.5">{e.requisitioned_qty ?? '—'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1">
                        <Calendar className="w-2.5 h-2.5" /> Delivery Date
                      </p>
                      {editingId === e.id ? (
                        renderExistingDeliveryPicker(e, 'w-full mt-1 px-2.5 py-2 rounded-lg border border-slate-300 text-sm bg-white')
                      ) : pending && pending.action === 'update_delivery_date' ? (
                        <p className="text-sm mt-0.5">
                          <CurrentVsProposed current={formatDate(e.delivery_date)} proposed={formatDate(pending.payload.new_delivery_date || '')} />
                        </p>
                      ) : (
                        <p className="text-sm text-slate-700 font-medium mt-0.5">{formatDate(e.delivery_date)}</p>
                      )}
                    </div>
                  </div>
                  {pending && pending.action === 'delete_entry' && pending.payload?.reason && (
                    <p className="mt-2 text-[11px] text-slate-500 italic">Reason: {pending.payload.reason}</p>
                  )}
                  {rejected && (
                    <p className="mt-2 text-[11px] text-rose-600">Your last request for this MPR was rejected by Admin.</p>
                  )}
                  {confirmDeleteId === e.id && (
                    <div className="mt-3 pt-3 border-t border-slate-100">
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Edit Reason (required)</label>
                      <textarea
                        value={deleteReason}
                        onChange={(ev) => setDeleteReason(ev.target.value)}
                        rows={2}
                        placeholder={`Why are you deleting MPR "${e.mpr_no}"?`}
                        className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                      />
                    </div>
                  )}
                </div>

                <div className="grid grid-cols-2 border-t border-slate-100">
                  {editingId === e.id ? (
                    <>
                      <button
                        type="button"
                        disabled={savingEdit}
                        onClick={() => saveEdit(e)}
                        className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-white bg-blue-600 hover:bg-blue-700 disabled:opacity-50 transition-colors"
                      >
                        <Save className="w-3.5 h-3.5" /> {savingEdit ? 'Saving…' : 'Save'}
                      </button>
                      <button
                        type="button"
                        onClick={cancelEdit}
                        className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-slate-600 bg-slate-50 hover:bg-slate-100 border-l border-slate-100 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" /> Cancel
                      </button>
                    </>
                  ) : confirmDeleteId === e.id ? (
                    <>
                      <button
                        type="button"
                        disabled={deletingId === e.id}
                        onClick={() => confirmDelete(e)}
                        className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-50 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> {deletingId === e.id ? 'Deleting…' : 'Confirm Delete'}
                      </button>
                      <button
                        type="button"
                        onClick={cancelDelete}
                        className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-slate-600 bg-slate-50 hover:bg-slate-100 border-l border-slate-100 transition-colors"
                      >
                        <X className="w-3.5 h-3.5" /> Cancel
                      </button>
                    </>
                  ) : pending ? (
                    <div className="col-span-2 flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-amber-700 bg-amber-50/70">
                      Awaiting Admin review — editing disabled
                    </div>
                  ) : (
                    <>
                      <button
                        type="button"
                        onClick={() => startEdit(e)}
                        className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-slate-700 bg-slate-50 hover:bg-slate-100 transition-colors"
                      >
                        <Pencil className="w-3.5 h-3.5" /> Edit
                      </button>
                      <button
                        type="button"
                        disabled={deletingId === e.id}
                        onClick={() => startDelete(e)}
                        className="flex items-center justify-center gap-1.5 py-2.5 text-xs font-semibold text-rose-600 bg-rose-50 hover:bg-rose-100 border-l border-slate-100 disabled:opacity-50 transition-colors"
                      >
                        <Trash2 className="w-3.5 h-3.5" /> {deletingId === e.id ? 'Deleting…' : 'Delete'}
                      </button>
                    </>
                  )}
                </div>
              </div>
              );
            })}
            {pendingAddRows.map((p) => (
              <div key={`pending-add-${p.id}`} className="rounded-xl border border-dashed border-amber-300 bg-amber-50/30 overflow-hidden">
                <div className="p-3.5">
                  <div className="flex items-center justify-between gap-2 flex-wrap">
                    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-xs font-semibold">
                      <Hash className="w-3 h-3" /> {p.payload.mpr_no}
                    </span>
                    <PendingBadge label="New MPR Pending Admin Approval" />
                  </div>
                  <p className="text-sm text-slate-800 font-medium leading-snug break-words mt-1.5" title={p.payload.item_name}>
                    {p.payload.item_name}
                  </p>
                  <div className="grid grid-cols-2 gap-3 mt-3">
                    <div>
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide">Qty</p>
                      <p className="text-sm text-slate-700 font-medium mt-0.5">{p.payload.requisitioned_qty ?? '—'}</p>
                    </div>
                    <div>
                      <p className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide flex items-center gap-1">
                        <Calendar className="w-2.5 h-2.5" /> Delivery Date
                      </p>
                      <p className="text-sm text-slate-700 font-medium mt-0.5">{formatDate(p.payload.delivery_date || '')}</p>
                    </div>
                  </div>
                  {p.payload.reason && (
                    <p className="text-[11px] text-slate-500 mt-2 italic">Reason: {p.payload.reason}</p>
                  )}
                </div>
              </div>
            ))}
          </div>

          <div className="hidden sm:block border border-slate-200 rounded-xl overflow-hidden">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="px-3 py-2 text-left">MPR No</th>
                  <th className="px-3 py-2 text-left">Item</th>
                  <th className="px-3 py-2 text-left">Qty</th>
                  <th className="px-3 py-2 text-left">Delivery Date</th>
                  <th className="px-3 py-2 text-left">Status</th>
                  <th className="px-3 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {job.entries.map((e) => {
                  const pending = pendingByEntryId.get(e.id);
                  const rejected = rejectedByEntryId.get(e.id);
                  return (
                  <React.Fragment key={e.id}>
                  <tr className={pending ? 'bg-amber-50/40' : undefined}>
                    <td className="px-3 py-2 font-medium text-slate-800">{e.mpr_no}</td>
                    <td className="px-3 py-2 text-slate-600 max-w-[220px] truncate" title={e.item_name}>
                      {e.item_name}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{e.requisitioned_qty ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-600">
                      {editingId === e.id ? (
                        renderExistingDeliveryPicker(e, 'px-2 py-1 rounded-md border border-slate-300 text-xs bg-white')
                      ) : pending && pending.action === 'update_delivery_date' ? (
                        <CurrentVsProposed current={formatDate(e.delivery_date)} proposed={formatDate(pending.payload.new_delivery_date || '')} />
                      ) : (
                        formatDate(e.delivery_date)
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {pending ? (
                        <PendingBadge label={pending.action === 'delete_entry' ? 'Delete Pending' : 'Edit Pending'} />
                      ) : rejected ? (
                        <span className="text-[10px] text-rose-600">Last request rejected</span>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap">
                      {editingId === e.id ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={savingEdit}
                            onClick={() => saveEdit(e)}
                            className="p-1.5 rounded-md bg-blue-600 text-white disabled:opacity-50"
                          >
                            <Save className="w-3 h-3" />
                          </button>
                          <button type="button" onClick={cancelEdit} className="p-1.5 rounded-md bg-slate-100 text-slate-600">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : confirmDeleteId === e.id ? (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={deletingId === e.id}
                            onClick={() => confirmDelete(e)}
                            className="p-1.5 rounded-md bg-rose-600 text-white disabled:opacity-50"
                            title="Confirm Delete"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                          <button type="button" onClick={cancelDelete} className="p-1.5 rounded-md bg-slate-100 text-slate-600">
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : pending ? (
                        <span className="text-[10px] text-amber-700">Awaiting review</span>
                      ) : (
                        <div className="inline-flex items-center gap-1.5">
                          <button
                            type="button"
                            onClick={() => startEdit(e)}
                            className="p-1.5 rounded-md bg-slate-100 text-slate-600 hover:bg-slate-200"
                          >
                            Edit
                          </button>
                          <button
                            type="button"
                            disabled={deletingId === e.id}
                            onClick={() => startDelete(e)}
                            className="p-1.5 rounded-md bg-rose-50 text-rose-600 hover:bg-rose-100 disabled:opacity-50"
                          >
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                  {confirmDeleteId === e.id && (
                    <tr className="bg-rose-50/40">
                      <td colSpan={6} className="px-3 py-2.5">
                        <label className="block text-[11px] font-medium text-slate-500 mb-1">
                          Edit Reason (required) — why are you deleting MPR "{e.mpr_no}"?
                        </label>
                        <textarea
                          value={deleteReason}
                          onChange={(ev) => setDeleteReason(ev.target.value)}
                          rows={2}
                          placeholder="Reason for deleting this MPR"
                          className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                        />
                      </td>
                    </tr>
                  )}
                  </React.Fragment>
                  );
                })}
                {pendingAddRows.map((p) => (
                  <React.Fragment key={`pending-add-${p.id}`}>
                  <tr className="bg-amber-50/40 border-dashed">
                    <td className="px-3 py-2 font-medium text-slate-800">{p.payload.mpr_no}</td>
                    <td className="px-3 py-2 text-slate-600 max-w-[220px] truncate" title={p.payload.item_name}>
                      {p.payload.item_name}
                    </td>
                    <td className="px-3 py-2 text-slate-600">{p.payload.requisitioned_qty ?? '—'}</td>
                    <td className="px-3 py-2 text-slate-600">{formatDate(p.payload.delivery_date || '')}</td>
                    <td className="px-3 py-2">
                      <PendingBadge label="New MPR Pending" />
                    </td>
                    <td className="px-3 py-2 text-right whitespace-nowrap text-[10px] text-amber-700">Awaiting review</td>
                  </tr>
                  {p.payload.reason && (
                    <tr className="bg-amber-50/40 border-dashed">
                      <td colSpan={6} className="px-3 pb-2 text-[11px] text-slate-500 italic">Reason: {p.payload.reason}</td>
                    </tr>
                  )}
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          </div>

          {!showAddForm ? (
            <button
              type="button"
              onClick={openAddForm}
              className="mt-3 inline-flex items-center gap-1.5 text-xs font-medium text-blue-600 hover:text-blue-700"
            >
              <Plus className="w-3.5 h-3.5" /> Add MPR to this Job
            </button>
          ) : (
            <div className="mt-3 p-4 rounded-xl border border-slate-200 bg-slate-50">
              {loadingItems ? (
                <div className="flex items-center gap-2 text-xs text-slate-500">
                  <Spinner size={14} /> Loading this Budget's Items…
                </div>
              ) : (
                <div className="space-y-3">
                  {addError && <p className="text-xs text-rose-600">{addError}</p>}

                  {/* MPR No — picking one auto-fills EVERY Item under it below, same as
                      the "New Job Entry" form's MPR row (see itemsForAddMpr). */}
                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">MPR No</label>
                    {/* Type-to-search custom dropdown (not a native <datalist> — see
                        showAddMprDropdown above for why) — type to filter, tap a row
                        to pick it, same pattern as UserPanel.tsx's MPR No fields. */}
                    <div className="relative">
                      <input
                        type="text"
                        value={addMprNo}
                        onChange={(ev) => selectAddMprNo(ev.target.value)}
                        onFocus={() => setShowAddMprDropdown(true)}
                        onBlur={() => setTimeout(() => setShowAddMprDropdown(false), 150)}
                        placeholder="Type to search MPR No..."
                        autoComplete="off"
                        className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                      />
                      {showAddMprDropdown && (
                        <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-md max-h-48 overflow-y-auto">
                          {filteredAddMprNoOptions.length > 0 ? (
                            filteredAddMprNoOptions.map((mo) => (
                              <button
                                type="button"
                                key={mo}
                                onMouseDown={(ev) => ev.preventDefault()}
                                onClick={() => {
                                  selectAddMprNo(mo);
                                  setShowAddMprDropdown(false);
                                }}
                                className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                                  addMprNo.trim().toLowerCase() === mo.toLowerCase()
                                    ? 'bg-blue-50 text-blue-700 font-medium'
                                    : 'text-slate-700 hover:bg-slate-50'
                                }`}
                              >
                                {mo}
                              </button>
                            ))
                          ) : (
                            <div className="px-3 py-1.5 text-xs text-slate-400">No matching MPR No found</div>
                          )}
                        </div>
                      )}
                    </div>
                  </div>

                  {/* Item Name — every imported Excel row under the selected MPR No,
                      each with its own Requisitioned Qty (capped to what's left) and
                      an optional per-item Delivery Date override once there's more
                      than one — mirrors the "New Job Entry" form's Item list exactly,
                      including "Split remaining Qty into a new Item here". */}
                  {addMprNo && (
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">
                        Item{addItems.length > 1 ? 's' : ''}
                      </label>
                      {addItems.length === 0 ? (
                        <p className="text-xs text-amber-600">
                          {budgetItems.some((bi) => String(bi.mrf_no || '').trim().toLowerCase() === addMprNo.trim().toLowerCase())
                            ? 'Every Item under this MPR No has already been fully requisitioned by you.'
                            : 'No Description of Materials found in the imported Budget Excel for this MPR No.'}
                        </p>
                      ) : addItems.length === 1 ? (
                        <div className="border border-slate-200 rounded-lg bg-white p-2.5 space-y-2">
                          <p className="text-xs text-slate-700 truncate" title={addItems[0].name}>{addItems[0].name}</p>
                          <div className="flex items-center gap-2">
                            <label className="text-[11px] text-slate-500 whitespace-nowrap">Qty *</label>
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="any"
                              max={addItems[0].remainingQty ?? undefined}
                              value={addItems[0].qty}
                              onChange={(ev) => updateAddItemQty(addItems[0].uid, ev.target.value)}
                              className={`flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border text-xs bg-white focus:outline-none ${
                                addItems[0].remainingQty !== null && addItems[0].qty !== '' && Number(addItems[0].qty) > addItems[0].remainingQty
                                  ? 'border-rose-500 ring-1 ring-rose-500'
                                  : 'border-slate-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                              }`}
                            />
                            {addItems[0].remainingQty !== null && (
                              <span className="text-[11px] text-slate-400 whitespace-nowrap">/ {addItems[0].remainingQty} left</span>
                            )}
                          </div>
                          {addItems[0].remainingQty !== null &&
                            addItems[0].qty !== '' &&
                            Number(addItems[0].qty) > 0 &&
                            Number(addItems[0].qty) < addItems[0].remainingQty && (
                              <button
                                type="button"
                                onClick={() => splitLeftoverInAdd(addItems[0].uid)}
                                className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 rounded-lg text-[11px] font-medium transition-colors"
                              >
                                <Scissors className="w-3 h-3 flex-shrink-0" />
                                Split remaining {addItems[0].remainingQty - Number(addItems[0].qty)} into a new item here
                              </button>
                            )}
                        </div>
                      ) : (
                        <ul className="border border-slate-200 rounded-lg divide-y divide-slate-200 overflow-hidden bg-white">
                          {addItems.map((opt) => (
                            <li key={opt.uid} className="p-2.5 space-y-2">
                              <div className="flex items-center gap-1.5">
                                <span className="flex-1 min-w-0 text-xs text-slate-700 truncate" title={opt.name}>
                                  {opt.name}
                                </span>
                                <button
                                  type="button"
                                  onClick={() => removeItemFromAdd(opt.uid)}
                                  className="flex-shrink-0 text-slate-400 hover:text-rose-600 transition-colors p-1 rounded-lg"
                                  aria-label={`Remove ${opt.name}`}
                                >
                                  <X className="w-3.5 h-3.5" />
                                </button>
                              </div>
                              <div className="flex items-center gap-2">
                                <label className="text-[11px] text-slate-500 whitespace-nowrap">Qty *</label>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min="0"
                                  step="any"
                                  max={opt.remainingQty ?? undefined}
                                  value={opt.qty}
                                  onChange={(ev) => updateAddItemQty(opt.uid, ev.target.value)}
                                  className={`flex-1 min-w-0 px-2.5 py-1.5 rounded-lg border text-xs bg-white focus:outline-none ${
                                    opt.remainingQty !== null && opt.qty !== '' && Number(opt.qty) > opt.remainingQty
                                      ? 'border-rose-500 ring-1 ring-rose-500'
                                      : 'border-slate-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                                  }`}
                                />
                                {opt.remainingQty !== null && (
                                  <span className="text-[11px] text-slate-400 whitespace-nowrap">/ {opt.remainingQty} left</span>
                                )}
                              </div>
                              {opt.remainingQty !== null && opt.qty !== '' && Number(opt.qty) > 0 && Number(opt.qty) < opt.remainingQty && (
                                <button
                                  type="button"
                                  onClick={() => splitLeftoverInAdd(opt.uid)}
                                  className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 rounded-lg text-[11px] font-medium transition-colors"
                                >
                                  <Scissors className="w-3 h-3 flex-shrink-0" />
                                  Split remaining {opt.remainingQty - Number(opt.qty)} into a new item here
                                </button>
                              )}
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] text-slate-500">
                                  Delivery:{' '}
                                  <span className={opt.deliveryDate ? 'font-medium text-slate-800' : 'text-slate-400 italic'}>
                                    {opt.deliveryDate ? formatDateLabel(opt.deliveryDate) : 'Same as below'}
                                  </span>
                                </span>
                                <button
                                  type="button"
                                  onClick={() => openAddItemDeliveryEditor(opt)}
                                  className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 rounded-lg text-[11px] font-medium transition-colors flex-shrink-0"
                                >
                                  <Calendar className="w-3 h-3 flex-shrink-0" />
                                  Edit
                                </button>
                              </div>
                            </li>
                          ))}
                        </ul>
                      )}
                      {/* Items dropped via the X button (or never auto-filled) can be
                          brought back without re-picking the MPR No. */}
                      {addableItemsForAdd().length > 0 && (
                        <div className="mt-1.5">
                          <p className="text-[11px] text-slate-400 mb-1">Add another Item under this MPR No:</p>
                          <div className="flex flex-wrap gap-1.5">
                            {addableItemsForAdd().map((it) => (
                              <button
                                key={it.budgetItemId}
                                type="button"
                                onClick={() => addItemToAdd(it.budgetItemId)}
                                className="inline-flex items-center gap-1 px-2 py-1 bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 rounded-lg text-[11px] font-medium transition-colors"
                              >
                                <Plus className="w-3 h-3 flex-shrink-0" />
                                <span className="truncate max-w-[160px]">{it.name}</span>
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>
                  )}

                  {/* Delivery Date — a SELECT-only picker (no typing) once this Job's
                      Budget has a bounded window, exactly like the "New Job Entry"
                      form's Delivery Date dropdown, so an out-of-range date can't be
                      typed in at all. Falls back to a normal date input otherwise. */}
                  {addItems.length > 0 && (
                    <div>
                      <label className="block text-[11px] font-medium text-slate-500 mb-1">Delivery Date</label>
                      {addItems.length > 1 && (
                        <p className="text-[10px] text-slate-400 mb-1">Applies to any Item above without its own Delivery Date.</p>
                      )}
                      {addDeliveryFloor && addDeliveryTo ? (
                        <select
                          value={addDeliveryDate}
                          onChange={(ev) => setAddDeliveryDate(ev.target.value)}
                          className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                        >
                          <option value="">Select a Delivery Date...</option>
                          {dateRangeOptions(addDeliveryFloor, addDeliveryTo).map((d) => (
                            <option key={d} value={d}>{formatDateLabel(d)}</option>
                          ))}
                        </select>
                      ) : (
                        <input
                          type="date"
                          value={addDeliveryDate}
                          min={addDeliveryFloor}
                          max={addDeliveryTo}
                          onChange={(ev) => setAddDeliveryDate(ev.target.value)}
                          className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                        />
                      )}
                      {(job.delivery_date_from || job.delivery_date_to) && (
                        <p className="mt-1 text-[10px] text-slate-400">
                          Allowed range: {formatDate(job.delivery_date_from) || '—'} to {formatDate(job.delivery_date_to) || '—'}
                        </p>
                      )}
                    </div>
                  )}

                  <div>
                    <label className="block text-[11px] font-medium text-slate-500 mb-1">Edit Reason (required)</label>
                    <textarea
                      value={addReason}
                      onChange={(ev) => setAddReason(ev.target.value)}
                      rows={2}
                      placeholder="Why is this MPR being added to an already Final Submitted Job?"
                      className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                    />
                  </div>

                  <div className="flex items-center gap-2">
                    <button
                      type="button"
                      disabled={addSaving}
                      onClick={submitAdd}
                      className="px-3 py-1.5 rounded-lg bg-blue-600 text-white text-xs font-medium disabled:opacity-50"
                    >
                      {addSaving ? 'Adding…' : 'Add MPR'}
                    </button>
                    <button
                      type="button"
                      onClick={resetAddForm}
                      className="px-3 py-1.5 rounded-lg bg-white border border-slate-300 text-slate-600 text-xs"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          )}

          {/* Per-item Delivery Date popup — only reachable once an MPR No auto-fills
              more than one Item, exactly like the "New Job Entry" form's version. */}
          {addEditingItemUid && (() => {
            const editOpt = addItems.find((it) => it.uid === addEditingItemUid);
            if (!editOpt) return null;
            return (
              <div className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center" role="dialog" aria-modal="true">
                <div className="absolute inset-0 bg-black/40" onClick={() => setAddEditingItemUid(null)} />
                <div className="relative w-full sm:max-w-md max-h-[85vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl p-5 pb-6 shadow-xl">
                  <div className="flex items-center justify-between mb-4">
                    <h3 className="text-sm font-bold text-slate-900">Delivery Date</h3>
                    <button
                      type="button"
                      onClick={() => setAddEditingItemUid(null)}
                      className="p-1 text-slate-400 hover:text-slate-600"
                      aria-label="Close Delivery Date editor"
                    >
                      <X className="w-4.5 h-4.5" />
                    </button>
                  </div>
                  <p className="text-xs text-slate-500 mb-3 truncate">{editOpt.name}</p>
                  {addDeliveryFloor && addDeliveryTo ? (
                    <select
                      value={addItemDeliveryDraft}
                      onChange={(ev) => setAddItemDeliveryDraft(ev.target.value)}
                      className="block w-full px-4 py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    >
                      <option value="">Select a Delivery Date...</option>
                      {dateRangeOptions(addDeliveryFloor, addDeliveryTo).map((d) => (
                        <option key={d} value={d}>{formatDateLabel(d)}</option>
                      ))}
                    </select>
                  ) : (
                    <input
                      type="date"
                      value={addItemDeliveryDraft}
                      min={addDeliveryFloor}
                      max={addDeliveryTo}
                      onChange={(ev) => setAddItemDeliveryDraft(ev.target.value)}
                      className="block w-full px-4 py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                    />
                  )}
                  {(job.delivery_date_from || job.delivery_date_to) && (
                    <p className="text-xs text-slate-400 mt-1.5">
                      Allowed range: {formatDate(job.delivery_date_from) || '—'} to {formatDate(job.delivery_date_to) || '—'}
                    </p>
                  )}
                  <div className="flex items-center gap-2 mt-5">
                    {editOpt.deliveryDate && (
                      <button
                        type="button"
                        onClick={clearAddItemDeliveryOverride}
                        className="flex-1 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 rounded-xl text-sm font-medium transition-colors"
                      >
                        Use Shared Date
                      </button>
                    )}
                    <button
                      type="button"
                      disabled={!addItemDeliveryDraft}
                      onClick={saveAddItemDeliveryDraft}
                      className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-xl text-sm font-medium transition-colors"
                    >
                      Save
                    </button>
                  </div>
                </div>
              </div>
            );
          })()}
        </div>
      )}
    </div>
  );
};

// ---- "Pending New Job Requests" — this user's own queued "Add New Job" requests
// (action === 'add_job'), shown between the header and the Job list since (unlike
// a pending Add MPR / Delete MPR) they don't belong to any existing Job's accordion
// row — there's no real Job for them to nest under until an Admin approves one. ----

interface PendingNewJobRequestsProps {
  requests: PendingJobEdit[];
}

const PendingNewJobRequests: React.FC<PendingNewJobRequestsProps> = ({ requests }) => {
  if (requests.length === 0) return null;
  return (
    <div className="px-6 pt-4 space-y-2.5">
      {requests.map((r) => {
        const p = r.payload || {};
        const items: any[] = Array.isArray(p.items) ? p.items : [];
        return (
          <div
            key={`pending-new-job-${r.id}`}
            className={`rounded-xl border p-3.5 ${
              r.status === 'rejected' ? 'border-rose-200 bg-rose-50/40' : 'border-dashed border-amber-300 bg-amber-50/30'
            }`}
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <p className="text-sm font-semibold text-slate-800 truncate">
                {p.job_name || 'New Job'} · {p.project_name || '—'}
              </p>
              {r.status === 'pending' ? (
                <PendingBadge label="New Job Pending Admin Approval" />
              ) : r.status === 'rejected' ? (
                <span className="text-[10px] font-semibold text-rose-700">Rejected by Admin</span>
              ) : (
                <span className="text-[10px] font-semibold text-emerald-700">Approved — see Job list below</span>
              )}
            </div>
            <p className="text-[11px] text-slate-400 mt-1">
              {p.budget_name ? `${p.budget_name} · ` : ''}
              Duration {p.job_duration || '—'} · {items.length} MPR row{items.length === 1 ? '' : 's'}
            </p>
            {p.reason && (
              <p className="text-[11px] text-slate-500 mt-1 italic">Reason: {p.reason}</p>
            )}
          </div>
        );
      })}
    </div>
  );
};

// ---- "Add New Job" form — unlike "Add MPR to this Job" (JobEditRow above, always
// scoped to ONE already-existing Job), this creates a brand-new Job from scratch —
// Budget, Project, Job Name, Job Duration and one or more MPR Nos, each contributing
// one or more Item rows. It never applies directly: submitting always queues a single
// job_edit_requests row (action = 'add_job') for Admin approval, since it's reachable
// at all only because this user already has can_job_edit — see
// POST /api/job-edits/new-job. ----

interface NewJobRequestFormProps {
  token: string;
  jobs: JobGroup[];
  mprNumbers: MprNumber[];
  onSubmitted: () => void;
}

// One Budget+Project combination this user can add a new Job under — derived from
// their own already-Final-Submitted Jobs (the `jobs` list JobEditPanel already
// loaded), since that's exactly the set of Budgets can_job_edit is meant to reach:
// ones this user has personally Final Submitted. A Budget+Project pair with zero
// active Jobs left (all deleted) simply won't appear here — a narrow edge case, not
// worth a separate lookup endpoint just to cover it.
interface BudgetProjectOption {
  key: string;
  budget_id: number;
  budget_name: string | null;
  project_id: number;
  project_name: string;
  delivery_date_from: string | null;
  delivery_date_to: string | null;
}

const NewJobRequestForm: React.FC<NewJobRequestFormProps> = ({ token, jobs, mprNumbers, onSubmitted }) => {
  const authHeaders = { Authorization: `Bearer ${token}` };

  const budgetProjectOptions: BudgetProjectOption[] = [];
  {
    const seen = new Set<string>();
    for (const j of jobs) {
      const key = `${j.budget_id}::${j.project_id}`;
      if (seen.has(key)) continue;
      seen.add(key);
      budgetProjectOptions.push({
        key,
        budget_id: j.budget_id,
        budget_name: j.budget_name,
        project_id: j.project_id,
        project_name: j.project_name,
        delivery_date_from: j.delivery_date_from,
        delivery_date_to: j.delivery_date_to
      });
    }
  }

  const [selectedKey, setSelectedKey] = useState('');
  const selected = budgetProjectOptions.find((o) => o.key === selectedKey) || null;

  const [jobName, setJobName] = useState('');
  const [jobDuration, setJobDuration] = useState('');
  const [budgetItems, setBudgetItems] = useState<BudgetItem[]>([]);
  const [loadingItems, setLoadingItems] = useState(false);
  const [rows, setRows] = useState<NewJobItemRow[]>([]);
  const [mprNoInput, setMprNoInput] = useState('');
  // Whether the MPR No dropdown below is open — see showAddMprDropdown in
  // JobEditRow above for why this can't just be a native <datalist>.
  const [showMprNoDropdown, setShowMprNoDropdown] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  // Required justification for this brand-new Job — same purpose as addReason in
  // JobEditRow's "Add MPR to this Job" form, just scoped to the whole new Job here.
  const [reason, setReason] = useState('');

  const selectBudgetProject = async (key: string) => {
    setSelectedKey(key);
    setRows([]);
    setMprNoInput('');
    setError('');
    setBudgetItems([]);
    const opt = budgetProjectOptions.find((o) => o.key === key);
    if (!opt) return;
    setLoadingItems(true);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${opt.budget_id}/items`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Budget Items');
      const scoped = (Array.isArray(data) ? data : []).filter(
        (it: BudgetItem) =>
          String(it.project_name || '').trim().toLowerCase() === opt.project_name.trim().toLowerCase() &&
          it.mrf_no &&
          String(it.mrf_no).trim() !== ''
      );
      setBudgetItems(scoped);
    } catch (err: any) {
      setError(err.message || "Could not load this Budget's Items");
    } finally {
      setLoadingItems(false);
    }
  };

  const mprNoOptions = [...new Set(budgetItems.map((it) => String(it.mrf_no).trim()))].sort();
  // MPR No options narrowed to whatever's currently typed into the field — feeds the
  // custom dropdown below (see showMprNoDropdown).
  const filteredMprNoOptions = mprNoOptions.filter((mo) => mo.toLowerCase().includes(mprNoInput.trim().toLowerCase()));

  // Every Item under a given MPR No not already present in `rows` — same rule as
  // JobEditRow's itemsForAddMpr (an Item this user has already fully requisitioned
  // is left out; every OTHER imported Excel row under the MPR No gets its own row).
  const itemsForMpr = (mprNo: string): NewJobItemRow[] => {
    const present = new Set(rows.map((r) => r.budgetItemId));
    const out: NewJobItemRow[] = [];
    for (const bi of budgetItems) {
      if (String(bi.mrf_no || '').trim().toLowerCase() !== mprNo.trim().toLowerCase()) continue;
      if (present.has(bi.id)) continue;
      const desc = String(bi.description || '').trim();
      if (!desc) continue;
      const reqQty = parseQtyNumber(bi.req_qty);
      const consumed = Number(bi.requisitioned_by_me || 0);
      const remainingQty = reqQty === null ? null : Math.max(0, reqQty - consumed);
      if (remainingQty !== null && remainingQty <= 0) continue;
      out.push({
        uid: makeItemUid(),
        mprNo: String(bi.mrf_no).trim(),
        budgetItemId: bi.id,
        name: desc,
        reqQty,
        remainingQty,
        qty: remainingQty !== null ? String(remainingQty) : '',
        deliveryDate: ''
      });
    }
    return out;
  };

  const addMprRows = () => {
    setError('');
    if (!mprNoInput.trim()) return;
    const toAdd = itemsForMpr(mprNoInput);
    if (toAdd.length === 0) {
      setError(
        budgetItems.some((bi) => String(bi.mrf_no || '').trim().toLowerCase() === mprNoInput.trim().toLowerCase())
          ? 'Every Item under this MPR No is already in the list, or already fully requisitioned by you.'
          : 'No Description of Materials found in the imported Budget Excel for this MPR No.'
      );
      return;
    }
    setRows((prev) => [...prev, ...toAdd]);
    setMprNoInput('');
    setShowMprNoDropdown(false);
  };

  const removeRow = (uid: string) => {
    setRows((prev) => prev.filter((r) => r.uid !== uid));
  };

  const updateRowQty = (uid: string, qty: string) => {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, qty } : r)));
  };

  // Splits a row's leftover Qty into a NEW row right below it, under the same MPR No —
  // for when only part of an Item's available Qty should go out against one Delivery
  // Date and the rest needs a different one. Mirrors splitLeftoverInAdd in JobEditRow
  // above (and splitLeftoverInSameRow in UserPanel.tsx) exactly, just operating on this
  // form's flat `rows` list instead of a per-MPR item list.
  const splitRowLeftover = (uid: string) => {
    const row = rows.find((r) => r.uid === uid);
    if (!row) return;
    const entered = Number(row.qty);
    if (row.remainingQty === null || !Number.isFinite(entered) || entered <= 0 || entered >= row.remainingQty) return;
    const leftover = row.remainingQty - entered;
    const newRow: NewJobItemRow = {
      uid: makeItemUid(),
      mprNo: row.mprNo,
      budgetItemId: row.budgetItemId,
      name: row.name,
      reqQty: row.reqQty,
      remainingQty: leftover,
      qty: String(leftover),
      deliveryDate: ''
    };
    setRows((prev) => {
      const idx = prev.findIndex((r) => r.uid === uid);
      if (idx === -1) return prev;
      const updated = prev.map((r) => (r.uid === uid ? { ...r, remainingQty: entered } : r));
      const next = [...updated];
      next.splice(idx + 1, 0, newRow);
      return next;
    });
  };

  const updateRowDelivery = (uid: string, date: string) => {
    setRows((prev) => prev.map((r) => (r.uid === uid ? { ...r, deliveryDate: date } : r)));
  };

  const deliveryFloor = latestDateStr(todayDateOnlyString(), selected?.delivery_date_from);
  const deliveryTo = selected?.delivery_date_to || undefined;

  const renderDeliveryPicker = (row: NewJobItemRow, className: string = 'w-full px-2.5 py-1.5 rounded-lg border border-slate-300 text-xs bg-white') => {
    if (deliveryFloor && deliveryTo) {
      return (
        <select value={row.deliveryDate} onChange={(ev) => updateRowDelivery(row.uid, ev.target.value)} className={className}>
          <option value="">Select...</option>
          {dateRangeOptions(deliveryFloor, deliveryTo).map((d) => (
            <option key={d} value={d}>{formatDateLabel(d)}</option>
          ))}
        </select>
      );
    }
    return (
      <input
        type="date"
        value={row.deliveryDate}
        min={deliveryFloor}
        max={deliveryTo}
        onChange={(ev) => updateRowDelivery(row.uid, ev.target.value)}
        className={className}
      />
    );
  };

  const resetForm = () => {
    setSelectedKey('');
    setJobName('');
    setJobDuration('');
    setBudgetItems([]);
    setRows([]);
    setMprNoInput('');
    setError('');
    setReason('');
  };

  const submit = async () => {
    setError('');
    if (!selected) {
      setError('Select a Budget / Project.');
      return;
    }
    if (!jobName.trim() || !jobDuration.trim()) {
      setError('Job Name and Job Duration are required.');
      return;
    }
    if (rows.length === 0) {
      setError('Add at least one MPR row.');
      return;
    }
    if (!reason.trim()) {
      setError('Edit Reason is required.');
      return;
    }
    for (const row of rows) {
      const q = Number(row.qty);
      if (!row.qty || !Number.isFinite(q) || q <= 0) {
        setError(`Enter a valid Requisitioned Qty for "${row.name}".`);
        return;
      }
      if (row.remainingQty !== null && q > row.remainingQty) {
        setError(`Requisitioned Qty for "${row.name}" can't exceed the remaining available Qty (${row.remainingQty}).`);
        return;
      }
      if (!row.deliveryDate) {
        setError(`Select a Delivery Date for "${row.name}".`);
        return;
      }
    }
    const itemsPayload: { mpr_id: number; budget_item_id: number; requisitioned_qty: number; delivery_date: string }[] = [];
    for (const row of rows) {
      const mprMatch = mprNumbers.find((m) => m.mpr_no.trim().toLowerCase() === row.mprNo.trim().toLowerCase());
      if (!mprMatch) {
        setError(`MPR No "${row.mprNo}" isn't in the system MPR list. Ask your Admin to add it first.`);
        return;
      }
      itemsPayload.push({
        mpr_id: mprMatch.id,
        budget_item_id: row.budgetItemId,
        requisitioned_qty: Number(row.qty),
        delivery_date: row.deliveryDate
      });
    }
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/job-edits/new-job'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          budget_id: selected.budget_id,
          project_id: selected.project_id,
          job_name: jobName.trim(),
          job_duration: jobDuration.trim(),
          items: itemsPayload,
          reason: reason.trim()
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit new Job');
      resetForm();
      onSubmitted();
    } catch (err: any) {
      setError(err.message || 'Something went wrong');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-3">
      <h3 className="text-sm font-semibold text-slate-800">Add New Job</h3>
      <p className="text-[11px] text-slate-400 -mt-2">
        Creates a brand-new Job under a Budget you've already Final Submitted — submitted here for Admin
        approval, just like Add MPR / Delete MPR.
      </p>
      {error && <p className="text-xs text-rose-600">{error}</p>}

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <div>
          <label className="block text-[11px] font-medium text-slate-500 mb-1">Budget / Project</label>
          <select
            value={selectedKey}
            onChange={(ev) => selectBudgetProject(ev.target.value)}
            className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
          >
            <option value="">Select...</option>
            {budgetProjectOptions.map((o) => (
              <option key={o.key} value={o.key}>
                {o.project_name} {o.budget_name ? `· ${o.budget_name}` : ''}
              </option>
            ))}
          </select>
        </div>
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Job Name</label>
            <input
              type="text"
              value={jobName}
              onChange={(ev) => setJobName(ev.target.value)}
              placeholder="Job Name"
              className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
            />
          </div>
          <div>
            <label className="block text-[11px] font-medium text-slate-500 mb-1">Job Duration</label>
            {/* Number-only, same as the "New Entry" form's Job Duration field
                (UserPanel.tsx) — a plain digits-only text input (not type="number")
                so a leading "0" etc. isn't silently stripped mid-typing. */}
            <input
              type="text"
              inputMode="numeric"
              pattern="[0-9]*"
              value={jobDuration}
              onChange={(ev) => setJobDuration(ev.target.value.replace(/\D/g, ''))}
              placeholder="e.g. 15"
              className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
            />
          </div>
        </div>
      </div>

      {selected && (
        loadingItems ? (
          <div className="flex items-center gap-2 text-xs text-slate-500">
            <Spinner size={14} /> Loading this Budget's Items…
          </div>
        ) : (
          <div className="space-y-3">
            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">MPR No</label>
              <div className="flex items-center gap-2">
                {/* Type-to-search custom dropdown (not a native <datalist> — see
                    showMprNoDropdown above for why) — pick from the list or type a
                    full MPR No, then press Add to add its Items to the table below. */}
                <div className="relative flex-1 min-w-0">
                  <input
                    type="text"
                    value={mprNoInput}
                    onChange={(ev) => setMprNoInput(ev.target.value)}
                    onFocus={() => setShowMprNoDropdown(true)}
                    onBlur={() => setTimeout(() => setShowMprNoDropdown(false), 150)}
                    placeholder="Type to search MPR No..."
                    autoComplete="off"
                    className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
                  />
                  {showMprNoDropdown && (
                    <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-md max-h-48 overflow-y-auto">
                      {filteredMprNoOptions.length > 0 ? (
                        filteredMprNoOptions.map((mo) => (
                          <button
                            type="button"
                            key={mo}
                            onMouseDown={(ev) => ev.preventDefault()}
                            onClick={() => {
                              setMprNoInput(mo);
                              setShowMprNoDropdown(false);
                            }}
                            className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                              mprNoInput.trim().toLowerCase() === mo.toLowerCase()
                                ? 'bg-blue-50 text-blue-700 font-medium'
                                : 'text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            {mo}
                          </button>
                        ))
                      ) : (
                        <div className="px-3 py-1.5 text-xs text-slate-400">No matching MPR No found</div>
                      )}
                    </div>
                  )}
                </div>
                <button
                  type="button"
                  onClick={addMprRows}
                  className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold px-3 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add
                </button>
              </div>
            </div>

            {rows.length > 0 && (
              <>
                {/* Card list on narrow/mobile screens — a wide table (MPR No, Item,
                    Qty, Delivery Date, remove) always overflowed the mobile viewport
                    once Item Name got long, since a plain <table> can't wrap its
                    columns to fit. Stacked cards below sm: instead, same underlying
                    row data; the table below (sm:block) takes over on wider screens. */}
                <div className="sm:hidden space-y-2.5">
                  {rows.map((row) => (
                    <div key={row.uid} className="rounded-xl border border-slate-200 bg-white p-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 text-[11px] font-semibold">
                            {row.mprNo}
                          </span>
                          <p className="text-xs text-slate-700 font-medium leading-snug break-words mt-1.5">{row.name}</p>
                        </div>
                        <button
                          type="button"
                          onClick={() => removeRow(row.uid)}
                          className="shrink-0 p-1.5 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2.5 mt-2.5">
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Qty</label>
                          <div className="flex items-center gap-1">
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="any"
                              max={row.remainingQty ?? undefined}
                              value={row.qty}
                              onChange={(ev) => updateRowQty(row.uid, ev.target.value)}
                              className={`w-full px-2 py-1.5 rounded-md border text-xs bg-white focus:outline-none ${
                                row.remainingQty !== null && row.qty !== '' && Number(row.qty) > row.remainingQty
                                  ? 'border-rose-500 ring-1 ring-rose-500'
                                  : 'border-slate-300'
                              }`}
                            />
                            {row.remainingQty !== null && (
                              <span className="text-[10px] text-slate-400 whitespace-nowrap">/ {row.remainingQty}</span>
                            )}
                          </div>
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Delivery Date</label>
                          {renderDeliveryPicker(row, 'w-full px-2 py-1.5 rounded-md border border-slate-300 text-xs bg-white')}
                        </div>
                      </div>
                      {row.remainingQty !== null && row.qty !== '' && Number(row.qty) > 0 && Number(row.qty) < row.remainingQty && (
                        <button
                          type="button"
                          onClick={() => splitRowLeftover(row.uid)}
                          className="mt-2.5 inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 rounded-lg text-[11px] font-medium transition-colors"
                        >
                          <Scissors className="w-3 h-3 flex-shrink-0" />
                          Split remaining {row.remainingQty - Number(row.qty)} into a new item here
                        </button>
                      )}
                    </div>
                  ))}
                </div>

                {/* Same rows as a table, sm: and up. */}
                <div className="hidden sm:block border border-slate-200 rounded-xl overflow-hidden">
                  <div className="overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead className="bg-slate-50 text-slate-500">
                      <tr>
                        <th className="px-3 py-2 text-left">MPR No</th>
                        <th className="px-3 py-2 text-left">Item</th>
                        <th className="px-3 py-2 text-left">Qty</th>
                        <th className="px-3 py-2 text-left">Delivery Date</th>
                        <th className="px-3 py-2 text-right">—</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {rows.map((row) => (
                        <tr key={row.uid}>
                          <td className="px-3 py-2 font-medium text-slate-800 whitespace-nowrap">{row.mprNo}</td>
                          <td className="px-3 py-2 text-slate-600 max-w-[220px] truncate" title={row.name}>{row.name}</td>
                          <td className="px-3 py-2">
                            <input
                              type="number"
                              inputMode="decimal"
                              min="0"
                              step="any"
                              max={row.remainingQty ?? undefined}
                              value={row.qty}
                              onChange={(ev) => updateRowQty(row.uid, ev.target.value)}
                              className={`w-20 px-2 py-1 rounded-md border text-xs bg-white focus:outline-none ${
                                row.remainingQty !== null && row.qty !== '' && Number(row.qty) > row.remainingQty
                                  ? 'border-rose-500 ring-1 ring-rose-500'
                                  : 'border-slate-300'
                              }`}
                            />
                            {row.remainingQty !== null && (
                              <span className="text-[10px] text-slate-400 ml-1">/ {row.remainingQty}</span>
                            )}
                            {row.remainingQty !== null && row.qty !== '' && Number(row.qty) > 0 && Number(row.qty) < row.remainingQty && (
                              <div className="mt-1.5">
                                <button
                                  type="button"
                                  onClick={() => splitRowLeftover(row.uid)}
                                  className="inline-flex items-center gap-1 px-2 py-1 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 rounded-md text-[10px] font-medium transition-colors whitespace-nowrap"
                                >
                                  <Scissors className="w-3 h-3 flex-shrink-0" />
                                  Split remaining {row.remainingQty - Number(row.qty)}
                                </button>
                              </div>
                            )}
                          </td>
                          <td className="px-3 py-2">{renderDeliveryPicker(row)}</td>
                          <td className="px-3 py-2 text-right">
                            <button type="button" onClick={() => removeRow(row.uid)} className="p-1 rounded-md text-slate-400 hover:text-rose-600 hover:bg-rose-50">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                  </div>
                </div>
              </>
            )}

            <div>
              <label className="block text-[11px] font-medium text-slate-500 mb-1">Edit Reason (required)</label>
              <textarea
                value={reason}
                onChange={(ev) => setReason(ev.target.value)}
                rows={2}
                placeholder="Why is this new Job being added under an already Final Submitted Budget?"
                className="w-full px-2.5 py-2 rounded-lg border border-slate-300 text-xs bg-white"
              />
            </div>

            <button
              type="button"
              disabled={saving || rows.length === 0}
              onClick={submit}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white transition-colors"
            >
              <Save className="w-3.5 h-3.5" /> {saving ? 'Submitting…' : 'Submit for Approval'}
            </button>
          </div>
        )
      )}
    </div>
  );
};