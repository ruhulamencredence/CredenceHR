import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { Project, MprNumber, Entry, Budget, BudgetItem, User, MprUsage, ClaimsNavRequest, JobsNavRequest, DashboardNavRequest } from '../types';
import { Calendar, Building2, FileText, Package, Clock, Plus, AlertTriangle, CheckCircle2, ChevronRight, X, Trash2, Edit2, Lock, Wallet, ArrowLeft, FolderOpen, ListChecks, Search, Save, Briefcase, FileDown, Scissors, Route, Info, Contact, Bell } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { formatDate, todayDateOnlyString, dateRangeOptions, formatDateLabel, latestDateStr, isDateBlockedByLeadTime } from '../lib/formatDate';
import { useDeliveryLeadTime } from '../lib/useDeliveryLeadTime';
import { useStableCallback } from '../lib/useStableCallback';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import credenceLogo from '../assets/credence-logo.png';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { setHeaderPageTitle } from '../lib/headerPageTitle';
import { PdfPreviewModal } from './PdfPreviewModal';
import { JobEditPanel } from './JobEditPanel';
import { AttendanceCard } from './AttendanceCard';
import { LeaveSummaryCard } from './LeaveSummaryCard';
import { PendingApprovalsCard } from './PendingApprovalsCard';
import { HolidayCalendarWidget } from './HolidayCalendarWidget';
import { LeaveReviewPage } from './LeaveReviewPage';
import { EmployeeDirectory } from './EmployeeDirectory';
import { NoticeBoard } from './NoticeBoard';
import { Timesheet } from './Timesheet';
import { ClaimCard } from './ClaimCard';
import { MyClaimsCard } from './MyClaimsCard';
import { ConveyanceClaimCard } from './ConveyanceClaimCard';
import { BottomNav } from './BottomNav';
import { ModulePath } from './ModulePath';

interface UserPanelProps {
  token: string;
  user: User;
  // Navbar's web-only "Claims" header menu — scrolls this panel to the Movement
  // Claim or Conveyance Bill Claim section (both already sit visible on desktop;
  // this just brings them into view without changing any mobile tile state).
  claimsNavRequest?: ClaimsNavRequest | null;
  // Navbar's web-only "Jobs" header menu — switches this panel's desktop view
  // to the Entry / Jobs / Entry Details / Job Edits section it targets (see
  // desktopActiveSection below). No effect on mobile, which keeps using its
  // own tile menu / mobileActiveSection regardless.
  jobsNavRequest?: JobsNavRequest | null;
  // GlobalSidebar's "Dashboard" item (via App.tsx's onGoToDashboard) — clears
  // mobileActiveSection/desktopActiveSection below back to the dashboard/tile
  // menu default. Without this, App.tsx switching viewMode to 'user' isn't
  // enough on its own: this panel keeps showing whichever section (e.g. a
  // Claims page) was previously active/restored from localStorage.
  dashboardNavRequest?: DashboardNavRequest | null;
}

// Unique id for one Item entry within an MPR row's itemNames list — see the uid field
// on MprItemOption for why this is needed separately from budgetItemId.
const makeItemUid = (): string => `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// One row = one MPR No + its own Item Name + its own Delivery Date.
// Multiple rows can be added under the same Job Name / Job No submission.
// Once a row is no longer the active one being filled in (a later row was added),
// it collapses down to just MPR No + Delivery Date to keep the form compact.
// One imported Budget Excel row (budget_items.id + its Description of Materials)
// that a selected MPR No carries — kept as an id+name pair (not just the text) so two
// rows that happen to share the exact same Description are still treated as two
// separate items instead of collapsing into one.
interface MprItemOption {
  // Unique per ENTRY in a row's itemNames list — distinct from budgetItemId so the
  // same underlying Excel row (same budgetItemId) can appear more than once in the
  // same row's Item list (see splitLeftoverInSameRow) without the two entries being
  // impossible to tell apart when updating Qty, Delivery Date, or removing one.
  uid: string;
  budgetItemId: number;
  name: string;
  // This item's total imported Requisitioned Qty (budget_items.req_qty), parsed to a
  // number — null if the Excel value wasn't a usable number (nothing to cap against).
  reqQty: number | null;
  // How much of reqQty is still available to THIS user to requisition (reqQty minus
  // whatever they've already put into other active entries for this exact item) —
  // null when reqQty itself is null.
  remainingQty: number | null;
  // The Requisitioned Qty the user is entering for THIS entry — defaults to the full
  // remainingQty, editable down (never above remainingQty).
  qty: string;
  // Per-item Delivery Date override, set only via the "Edit Delivery Date" popup —
  // empty string means "not overridden", so this item just follows the row's shared
  // Delivery Date field below. Only relevant when an MPR No's row carries more than
  // one Item (each can then go out on its own date instead of all sharing one).
  deliveryDate: string;
}

// The Delivery Date that actually applies to one Item within a row — its own override
// if one was set via the popup, otherwise the row's shared Delivery Date field.
const getItemDeliveryDate = (row: MprRow, opt: MprItemOption): string => opt.deliveryDate || row.deliveryDate;

// Pulls just the leading numeric portion out of a free-text Qty string imported from
// Excel (e.g. "120.50 pcs" -> 120.5) — mirrors the server's parseQtyNumber so the
// client's remaining-Qty math always agrees with what the server will enforce.
const parseQtyNumber = (value: any): number | null => {
  if (value === null || value === undefined) return null;
  const match = String(value).replace(/,/g, '').match(/-?\d+(\.\d+)?/);
  if (!match) return null;
  const n = Number(match[0]);
  return Number.isFinite(n) ? n : null;
};

interface MprRow {
  rowId: string;
  mprId: string;
  mprSearchText: string;
  showDropdown: boolean;
  // A selected MPR No can carry more than one imported Excel row — EVERY one of them
  // is auto-filled in here (instead of making the user pick just one, and instead of
  // silently merging rows that share the same Description text), and each becomes its
  // own entry on submit.
  itemNames: MprItemOption[];
  deliveryDate: string;
  collapsed: boolean;
}

const makeEmptyRow = (): MprRow => ({
  rowId: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  mprId: '',
  mprSearchText: '',
  showDropdown: false,
  itemNames: [],
  deliveryDate: '',
  collapsed: false
});

interface EntryRowProps {
  it: Entry;
  // Needed only for this row's own GET /api/delivery-date-conditions/effective
  // lookup (see the useDeliveryLeadTime call below) — fired only while this
  // row isEditing, not for every row in a long list.
  token: string;
  idx: number;
  isEditing: boolean;
  canEdit: boolean;
  // True when this entry can ONLY have its Delivery Date changed — its Budget is
  // already Final Submitted (budget_locked) and the current user has the Job Edit
  // permission (can_job_edit), same permission/condition the separate Job Edit
  // panel already uses for its own direct Delivery-Date edit. Restores the older
  // policy where a Job Edit user could also make that same Delivery Date change
  // right here from Job Entry Details, not just from the Job Edit panel. Ignored
  // when canEdit is false (nothing is editable either way) and has no effect once
  // the Budget isn't locked (that case is already fully editable via canEdit alone).
  dateOnlyEdit: boolean;
  deletingEntryId: number | null;
  onStartEdit: (entry: Entry) => void;
  onCancelEdit: () => void;
  onSaveEdit: (entryId: number) => void;
  onDelete: (entryId: number) => void;
  onSelectEditMpr: (m: MprNumber) => void;
  // Edit-mode-only state — only actually read by the row currently being edited,
  // but always passed down (cheap primitives/arrays) since only ONE row is ever
  // editing at a time, and passing them doesn't affect memoization of the other rows.
  editJobName: string;
  setEditJobName: (v: string) => void;
  editMprSearchText: string;
  setEditMprSearchText: (v: string) => void;
  editShowMprDropdown: boolean;
  setEditShowMprDropdown: (v: boolean) => void;
  editMprId: string;
  setEditMprId: (v: string) => void;
  editMprOptions: MprNumber[];
  editItemName: string;
  editItemBudgetItemId: number | null;
  // Picking an option sets BOTH the display text and the specific source Excel row
  // (budgetItemId) at once, so two options with the same Description text still each
  // resolve to their own row.
  onEditItemChange: (opt: MprItemOption) => void;
  editItemOptions: MprItemOption[];
  editLoadingOptions: boolean;
  // Requisitioned Qty being edited, plus the ceiling to enforce for whichever item is
  // currently selected (null = no cap known yet).
  editQty: string;
  setEditQty: (v: string) => void;
  editMaxQtyFor: (opt: MprItemOption) => number | null;
  editJobDuration: string;
  setEditJobDuration: (v: string) => void;
  editDeliveryRange: { from: string | null; to: string | null };
  editDeliveryDate: string;
  setEditDeliveryDate: (v: string) => void;
  editSaving: boolean;
  // Whatever's left over once editQty has been typed in below the entry's original
  // saved Qty (same item, not switched to a different one) — null whenever there's
  // nothing to split off. Mirrors the "Split remaining Qty into a new item" feature
  // already available while first creating a Job (see splitLeftoverInSameRow above),
  // now available on an entry that's already been saved.
  editSplitRemaining: number | null;
  onSplitRemaining: () => void;
  splitSaving: boolean;
  splitError: string;
}

// Memoized so that typing anywhere ELSE in the panel (Add Entry form fields, column
// filters, etc.) does not force React to re-diff every row of a potentially long
// entries table — only the row(s) whose props actually changed re-render.
const EntryRow = React.memo(function EntryRow({
  it, token, idx, isEditing, canEdit, dateOnlyEdit, deletingEntryId,
  onStartEdit, onCancelEdit, onSaveEdit, onDelete, onSelectEditMpr,
  editJobName, setEditJobName,
  editMprSearchText, setEditMprSearchText,
  editShowMprDropdown, setEditShowMprDropdown,
  editMprId, setEditMprId, editMprOptions,
  editItemName, editItemBudgetItemId, onEditItemChange, editItemOptions, editLoadingOptions,
  editQty, setEditQty, editMaxQtyFor,
  editJobDuration, setEditJobDuration,
  editDeliveryRange, editDeliveryDate, setEditDeliveryDate,
  editSaving,
  editSplitRemaining, onSplitRemaining, splitSaving, splitError
}: EntryRowProps) {
  // Admin-set Delivery Date "minimum lead time" for changing THIS entry's
  // Delivery Date (Condition Set's "job_edit" type — see
  // deliveryDateConditions.ts). Only looked up while this row is actually
  // being edited, so a long entries list doesn't fire one request per row.
  const { earliestAllowedDate: editEarliestDate } = useDeliveryLeadTime(
    token,
    'job_edit',
    isEditing ? it.project_id : null,
    isEditing ? it.budget_id : null
  );
  return (
    <tr className="hover:bg-slate-50/80">
      <td className="px-3 py-2.5 whitespace-nowrap text-slate-500">{idx + 1}</td>
      <td className="px-3 py-2.5 whitespace-nowrap font-semibold text-blue-600">{it.job_no}</td>
      {/* Job Name, MPR No, Item Name, Qty and Job Duration stay freely editable
          right up until this entry's Budget is Final Submitted — canEdit is false
          (and the Edit button never even renders, see the "Locked" fallback below)
          once that happens, so isEditing here always implies canEdit === true.
          The one exception is dateOnlyEdit (Job Edit permission on an already-
          locked entry) — isEditing can be true there too, but every field below
          except Delivery Date renders as plain text instead of an input. */}
      <td className="px-3 py-2.5 min-w-[140px] text-slate-900 font-medium">
        {isEditing && !dateOnlyEdit ? (
          <input
            type="text"
            value={editJobName}
            onChange={(e) => setEditJobName(e.target.value)}
            className="w-full px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
          />
        ) : (
          it.job_name
        )}
      </td>
      <td className="px-3 py-2.5 min-w-[150px] text-slate-900">
        {isEditing && !dateOnlyEdit ? (
          <div className="relative">
            <input
              type="text"
              value={editMprSearchText}
              onChange={(e) => {
                setEditMprSearchText(e.target.value);
                setEditMprId('');
                setEditShowMprDropdown(true);
              }}
              onFocus={() => setEditShowMprDropdown(true)}
              onBlur={() => setTimeout(() => setEditShowMprDropdown(false), 150)}
              placeholder="Search MPR No..."
              autoComplete="off"
              className="w-full px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
            />
            {editShowMprDropdown && (
              <div className="absolute z-20 mt-1 w-44 bg-white border border-slate-200 rounded-lg shadow-md max-h-40 overflow-y-auto">
                {editMprOptions.length > 0 ? (
                  editMprOptions.map((m) => (
                    <button
                      type="button"
                      key={m.id}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => onSelectEditMpr(m)}
                      className={`w-full text-left px-3 py-1.5 text-xs transition-colors ${
                        editMprId === String(m.id) ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700 hover:bg-slate-50'
                      }`}
                    >
                      {m.mpr_no}
                    </button>
                  ))
                ) : (
                  <div className="px-3 py-1.5 text-xs text-slate-400">No matching MPR No found</div>
                )}
              </div>
            )}
          </div>
        ) : (
          it.mpr_no
        )}
      </td>
      <td className="px-3 py-2.5 min-w-[180px] text-slate-700">
        {isEditing && !dateOnlyEdit ? (
          editLoadingOptions ? (
            <span className="text-xs text-slate-400">Loading items...</span>
          ) : editItemOptions.length > 0 ? (
            <select
              value={editItemBudgetItemId ?? ''}
              onChange={(e) => {
                const opt = editItemOptions.find((o) => o.budgetItemId === Number(e.target.value));
                if (opt) onEditItemChange(opt);
              }}
              className="w-full px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none appearance-none"
            >
              <option value="" disabled>Select Item...</option>
              {editItemOptions.map((opt) => (
                <option key={opt.uid} value={opt.budgetItemId}>{opt.name}</option>
              ))}
            </select>
          ) : (
            <span className="text-xs text-slate-400">Select an MPR No first</span>
          )
        ) : (
          it.item_name
        )}
      </td>
      <td className="px-3 py-2.5 min-w-[150px] text-slate-600">{it.specification || '—'}</td>
      <td className="px-3 py-2.5 min-w-[110px] text-slate-600 align-top">
        {isEditing && !dateOnlyEdit ? (
          <div className="space-y-1">
            <input
              type="number"
              min="0"
              step="any"
              value={editQty}
              onChange={(e) => setEditQty(e.target.value)}
              className="w-20 px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
            />
            {editSplitRemaining !== null && (
              <button
                type="button"
                disabled={splitSaving}
                onClick={onSplitRemaining}
                className="inline-flex items-center gap-1 px-2 py-1 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 active:bg-amber-100 rounded-lg text-[11px] font-medium transition-colors disabled:opacity-50 whitespace-normal max-w-[160px]"
              >
                <Scissors className="w-3 h-3 flex-shrink-0" />
                {splitSaving ? 'Splitting...' : `Split remaining ${editSplitRemaining} into a new item here`}
              </button>
            )}
            {splitError && <p className="text-[11px] text-rose-600 max-w-[160px]">{splitError}</p>}
          </div>
        ) : it.requisitioned_qty !== null && it.requisitioned_qty !== undefined ? (
          <>
            {it.requisitioned_qty}
            {it.req_qty ? <span className="text-slate-400"> / {it.req_qty}</span> : null}
          </>
        ) : (
          it.req_qty || '—'
        )}
      </td>
      <td className="px-3 py-2.5 min-w-[110px] text-slate-600">
        {isEditing && !dateOnlyEdit ? (
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            value={editJobDuration}
            onChange={(e) => setEditJobDuration(e.target.value.replace(/\D/g, ''))}
            className="w-16 px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
          />
        ) : (
          it.job_duration
        )}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap text-slate-600">
        {isEditing ? (
          <>
            {editDeliveryRange.from && editDeliveryRange.to ? (
              <select
                value={editDeliveryDate}
                onChange={(e) => setEditDeliveryDate(e.target.value)}
                className="px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none appearance-none"
              >
                <option value="">Select...</option>
                {dateRangeOptions(editDeliveryRange.from, editDeliveryRange.to).map((d) => {
                  const blocked = isDateBlockedByLeadTime(d, editEarliestDate);
                  return (
                    <option key={d} value={d} disabled={blocked}>
                      {formatDateLabel(d)}{blocked ? ' — needs more notice' : ''}
                    </option>
                  );
                })}
              </select>
            ) : (
              <input
                type="date"
                value={editDeliveryDate}
                onChange={(e) => setEditDeliveryDate(e.target.value)}
                min={
                  editEarliestDate && (!editDeliveryRange.from || editEarliestDate > editDeliveryRange.from)
                    ? editEarliestDate
                    : editDeliveryRange.from || undefined
                }
                max={editDeliveryRange.to || undefined}
                className="px-2 py-1 bg-white border border-slate-300 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            )}
            {(editDeliveryRange.from || editDeliveryRange.to) && (
              <div className="text-[9px] text-slate-400 mt-1">
                {formatDate(editDeliveryRange.from) || '—'} to {formatDate(editDeliveryRange.to) || '—'}
              </div>
            )}
          </>
        ) : (
          formatDate(it.delivery_date)
        )}
      </td>
      <td className="px-3 py-2.5 min-w-[110px] text-slate-500">
        {it.budget_name || '—'}
      </td>
      <td className="px-3 py-2.5 whitespace-nowrap">
        {isEditing ? (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => onSaveEdit(it.id)}
              disabled={editSaving}
              className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-50"
              title="Save"
            >
              <Save className="w-3.5 h-3.5" />
            </button>
            <button
              type="button"
              onClick={onCancelEdit}
              disabled={editSaving}
              className="p-1.5 text-slate-400 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
              title="Cancel"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        ) : canEdit ? (
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={() => onStartEdit(it)}
              className="p-1.5 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
              title={dateOnlyEdit ? 'Edit Delivery Date' : 'Edit'}
            >
              <Edit2 className="w-3.5 h-3.5" />
            </button>
            {dateOnlyEdit ? (
              <span className="text-[9px] text-slate-400 flex items-center gap-0.5" title="Budget already Final Submitted — only Delivery Date can be changed">
                <Lock className="w-3 h-3" /> Date only
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onDelete(it.id)}
                disabled={deletingEntryId === it.id}
                className="p-1.5 text-rose-500 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                title="Delete this Job Entry"
              >
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-slate-300 flex items-center gap-1">
            <Lock className="w-3 h-3" /> Locked
          </span>
        )}
      </td>
    </tr>
  );
});

// Same data/behavior as EntryRow, laid out as a stacked card instead of table cells —
// used on narrow screens so the "Job Entry Details" list never needs horizontal
// scrolling on mobile (see the `md:hidden` / `hidden md:block` split further down).
const EntryCard = React.memo(function EntryCard({
  it, token, idx, isEditing, canEdit, dateOnlyEdit, deletingEntryId,
  onStartEdit, onCancelEdit, onSaveEdit, onDelete, onSelectEditMpr,
  editJobName, setEditJobName,
  editMprSearchText, setEditMprSearchText,
  editShowMprDropdown, setEditShowMprDropdown,
  editMprId, setEditMprId, editMprOptions,
  editItemName, editItemBudgetItemId, onEditItemChange, editItemOptions, editLoadingOptions,
  editQty, setEditQty, editMaxQtyFor,
  editJobDuration, setEditJobDuration,
  editDeliveryRange, editDeliveryDate, setEditDeliveryDate,
  editSaving,
  editSplitRemaining, onSplitRemaining, splitSaving, splitError
}: EntryRowProps) {
  // Same Condition Set lookup as EntryRow above (desktop table vs this mobile
  // card are two separate components rendering the same data).
  const { earliestAllowedDate: editEarliestDate } = useDeliveryLeadTime(
    token,
    'job_edit',
    isEditing ? it.project_id : null,
    isEditing ? it.budget_id : null
  );
  const fieldLabel = "text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1";
  const inputCls = "w-full px-2.5 py-2 bg-slate-50 border border-slate-300 rounded-lg text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none";
  // Compact "label ⋯ value" line used by the read-only (non-editing) layout — packs
  // far more fields into the same height than a label-above-value block per field.
  const statRow = (label: string, value: React.ReactNode) => (
    <div className="flex items-baseline justify-between gap-3 py-1 border-b border-dashed border-slate-100 last:border-b-0">
      <span className="text-[10px] uppercase tracking-wider text-slate-400 flex-shrink-0">{label}</span>
      <span className="text-xs font-medium text-slate-700 text-right truncate">{value}</span>
    </div>
  );

  return (
    // Mobile-only (see its md:hidden wrapper above) — liquid glass to match
    // the rest of the Dashboard's mobile cards (Select a Budget/Jobs), since
    // there's no desktop rendering of this component to keep unchanged.
    <div className="p-3.5 border border-white/60 rounded-2xl bg-white/50 backdrop-blur-xl shadow-[0_4px_14px_-4px_rgba(15,23,42,0.12)]">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="text-[10px] text-slate-400 flex-shrink-0">#{idx + 1}</span>
            <span className="font-semibold text-blue-600 text-sm truncate">{it.job_no}</span>
          </div>
        </div>
        {isEditing ? (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => onSaveEdit(it.id)}
              disabled={editSaving}
              className="p-2 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-50"
              title="Save"
            >
              <Save className="w-4 h-4" />
            </button>
            <button
              type="button"
              onClick={onCancelEdit}
              disabled={editSaving}
              className="p-2 text-slate-400 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
              title="Cancel"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        ) : canEdit ? (
          <div className="flex items-center gap-1 flex-shrink-0">
            <button
              type="button"
              onClick={() => onStartEdit(it)}
              className="p-2 text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
              title={dateOnlyEdit ? 'Edit Delivery Date' : 'Edit'}
            >
              <Edit2 className="w-4 h-4" />
            </button>
            {dateOnlyEdit ? (
              <span className="text-[9px] text-slate-400 flex items-center gap-0.5 px-1" title="Budget already Final Submitted — only Delivery Date can be changed">
                <Lock className="w-3 h-3" /> Date only
              </span>
            ) : (
              <button
                type="button"
                onClick={() => onDelete(it.id)}
                disabled={deletingEntryId === it.id}
                className="p-2 text-rose-500 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                title="Delete this Job Entry"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
        ) : (
          <span className="text-[10px] text-slate-300 flex items-center gap-1 flex-shrink-0">
            <Lock className="w-3 h-3" /> Locked
          </span>
        )}
      </div>

      {!isEditing ? (
        // --- Compact read-only layout ---
        <div className="mt-1.5">
          <div className="text-sm font-medium text-slate-900 truncate">{it.job_name}</div>
          <div className="text-xs text-slate-600 truncate">{it.item_name}</div>
          <div className="mt-1.5">
            {statRow('MPR No', it.mpr_no)}
            {statRow('Specification', it.specification || '—')}
            {statRow(
              'Qty',
              it.requisitioned_qty !== null && it.requisitioned_qty !== undefined
                ? `${it.requisitioned_qty}${it.req_qty ? ` / ${it.req_qty}` : ''}`
                : it.req_qty || '—'
            )}
            {statRow('Job Duration', it.job_duration)}
            {statRow('Delivery Date', formatDate(it.delivery_date))}
            {statRow('Budget', it.budget_name || '—')}
          </div>
        </div>
      ) : dateOnlyEdit ? (
        // --- Delivery-Date-only edit form: this entry's Budget is already Final
        //     Submitted, so every field below Delivery Date is read-only here —
        //     same values as the compact read-only layout above, just kept visible
        //     for context while the date itself is being changed. ---
        <div className="mt-2 space-y-3">
          <div>
            <div className={fieldLabel}>Job Name</div>
            <div className="text-sm text-slate-700">{it.job_name}</div>
          </div>
          <div>
            <div className={fieldLabel}>MPR No</div>
            <div className="text-sm text-slate-700">{it.mpr_no}</div>
          </div>
          <div>
            <div className={fieldLabel}>Item Name</div>
            <div className="text-sm text-slate-700">{it.item_name}</div>
          </div>
          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className={fieldLabel}>Specification</div>
              <div className="text-slate-600">{it.specification || '—'}</div>
            </div>
            <div>
              <div className={fieldLabel}>Requisitioned Qty</div>
              <div className="text-slate-600">
                {it.requisitioned_qty !== null && it.requisitioned_qty !== undefined
                  ? `${it.requisitioned_qty}${it.req_qty ? ` / ${it.req_qty}` : ''}`
                  : it.req_qty || '—'}
              </div>
            </div>
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={fieldLabel}>Job Duration</div>
              <div className="text-sm text-slate-700">{it.job_duration}</div>
            </div>
            <div>
              <div className={fieldLabel}>Delivery Date</div>
              {editDeliveryRange.from && editDeliveryRange.to ? (
                <select
                  value={editDeliveryDate}
                  onChange={(e) => setEditDeliveryDate(e.target.value)}
                  className={`${inputCls} appearance-none`}
                >
                  <option value="">Select...</option>
                  {dateRangeOptions(editDeliveryRange.from, editDeliveryRange.to).map((d) => {
                    const blocked = isDateBlockedByLeadTime(d, editEarliestDate);
                    return (
                      <option key={d} value={d} disabled={blocked}>
                        {formatDateLabel(d)}{blocked ? ' — needs more notice' : ''}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  type="date"
                  value={editDeliveryDate}
                  onChange={(e) => setEditDeliveryDate(e.target.value)}
                  min={
                    editEarliestDate && (!editDeliveryRange.from || editEarliestDate > editDeliveryRange.from)
                      ? editEarliestDate
                      : editDeliveryRange.from || undefined
                  }
                  max={editDeliveryRange.to || undefined}
                  className={inputCls}
                />
              )}
            </div>
          </div>
          <div>
            <div className={fieldLabel}>Budget</div>
            <div className="text-sm text-slate-500">{it.budget_name || '—'}</div>
          </div>
        </div>
      ) : (
        // --- Edit form: Job Name, MPR No, Item Name, Qty and Job Duration stay
        //     freely editable right up until this entry's Budget is Final
        //     Submitted — canEdit is false (Edit button never even renders, see
        //     the "Locked" fallback above) once that happens, so isEditing here
        //     always implies canEdit === true. ---
        <div className="mt-2 space-y-3">
          <div>
            <div className={fieldLabel}>Job Name</div>
            <input
              type="text"
              value={editJobName}
              onChange={(e) => setEditJobName(e.target.value)}
              className={inputCls}
            />
          </div>

          <div>
            <div className={fieldLabel}>MPR No</div>
            <div className="relative">
              <input
                type="text"
                value={editMprSearchText}
                onChange={(e) => {
                  setEditMprSearchText(e.target.value);
                  setEditMprId('');
                  setEditShowMprDropdown(true);
                }}
                onFocus={() => setEditShowMprDropdown(true)}
                onBlur={() => setTimeout(() => setEditShowMprDropdown(false), 150)}
                placeholder="Type to search MPR No..."
                autoComplete="off"
                className={inputCls}
              />
              {editShowMprDropdown && (
                <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-md max-h-40 overflow-y-auto">
                  {editMprOptions.length > 0 ? (
                    editMprOptions.map((m) => (
                      <button
                        type="button"
                        key={m.id}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => onSelectEditMpr(m)}
                        className={`w-full text-left px-3 py-2 text-sm transition-colors ${
                          editMprId === String(m.id) ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700 hover:bg-slate-50'
                        }`}
                      >
                        {m.mpr_no}
                      </button>
                    ))
                  ) : (
                    <div className="px-3 py-2 text-xs text-slate-400">No matching MPR No found</div>
                  )}
                </div>
              )}
            </div>
          </div>

          <div>
            <div className={fieldLabel}>Item Name</div>
            {editLoadingOptions ? (
              <div className="text-xs text-slate-400 py-2">Loading items...</div>
            ) : editItemOptions.length > 0 ? (
              <select
                value={editItemBudgetItemId ?? ''}
                onChange={(e) => {
                  const opt = editItemOptions.find((o) => o.budgetItemId === Number(e.target.value));
                  if (opt) onEditItemChange(opt);
                }}
                className={`${inputCls} appearance-none`}
              >
                <option value="" disabled>Select Item...</option>
                {editItemOptions.map((opt) => (
                  <option key={opt.uid} value={opt.budgetItemId}>{opt.name}</option>
                ))}
              </select>
            ) : (
              <div className="text-xs text-slate-400 py-2">Select an MPR No first</div>
            )}
          </div>

          <div className="grid grid-cols-2 gap-3 text-xs">
            <div>
              <div className={fieldLabel}>Specification</div>
              <div className="text-slate-600">{it.specification || '—'}</div>
            </div>
            <div>
              <div className={fieldLabel}>Requisitioned Qty</div>
              <input
                type="number"
                min="0"
                step="any"
                value={editQty}
                onChange={(e) => setEditQty(e.target.value)}
                className={inputCls}
              />
              {editSplitRemaining !== null && (
                <button
                  type="button"
                  disabled={splitSaving}
                  onClick={onSplitRemaining}
                  className="mt-1.5 inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 active:bg-amber-100 rounded-lg text-xs font-medium transition-colors disabled:opacity-50"
                >
                  <Scissors className="w-3.5 h-3.5 flex-shrink-0" />
                  {splitSaving ? 'Splitting...' : `Split remaining ${editSplitRemaining} into a new item here`}
                </button>
              )}
              {splitError && <p className="text-xs text-rose-600 mt-1.5">{splitError}</p>}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-3">
            <div>
              <div className={fieldLabel}>Job Duration</div>
              <input
                type="text"
                inputMode="numeric"
                pattern="[0-9]*"
                value={editJobDuration}
                onChange={(e) => setEditJobDuration(e.target.value.replace(/\D/g, ''))}
                className={inputCls}
              />
            </div>
            <div>
              <div className={fieldLabel}>Delivery Date</div>
              {editDeliveryRange.from && editDeliveryRange.to ? (
                <select
                  value={editDeliveryDate}
                  onChange={(e) => setEditDeliveryDate(e.target.value)}
                  className={`${inputCls} appearance-none`}
                >
                  <option value="">Select...</option>
                  {dateRangeOptions(editDeliveryRange.from, editDeliveryRange.to).map((d) => {
                    const blocked = isDateBlockedByLeadTime(d, editEarliestDate);
                    return (
                      <option key={d} value={d} disabled={blocked}>
                        {formatDateLabel(d)}{blocked ? ' — needs more notice' : ''}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  type="date"
                  value={editDeliveryDate}
                  onChange={(e) => setEditDeliveryDate(e.target.value)}
                  min={
                    editEarliestDate && (!editDeliveryRange.from || editEarliestDate > editDeliveryRange.from)
                      ? editEarliestDate
                      : editDeliveryRange.from || undefined
                  }
                  max={editDeliveryRange.to || undefined}
                  className={inputCls}
                />
              )}
            </div>
          </div>

          <div>
            <div className={fieldLabel}>Budget</div>
            <div className="text-sm text-slate-500">{it.budget_name || '—'}</div>
          </div>
        </div>
      )}
    </div>
  );
});

export const UserPanel: React.FC<UserPanelProps> = ({ token, user, claimsNavRequest, jobsNavRequest, dashboardNavRequest }) => {
  const [projects, setProjects] = useState<Project[]>([]);
  // True once the initial Project list fetch (fetchMasterData below) has
  // resolved (success or failure) — lets AttendanceCard tell "still loading"
  // apart from "genuinely no Projects assigned", so it can show a skeleton
  // in its usual spot on first paint instead of only appearing once this
  // fetch completes.
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [mprNumbers, setMprNumbers] = useState<MprNumber[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  // System-wide "which Job is this MPR No already used under" lookup — kept separate
  // from `entries` (which is now scoped to just this user's own entries) since MPR
  // No uniqueness is enforced across ALL users, not just this one.
  const [mprUsage, setMprUsage] = useState<MprUsage[]>([]);

  // Budget picker state — a User must pick a Budget the Admin has created & imported
  // BEFORE they're allowed to start a new MPR Entry. Everything in the Entry form
  // below (Project choices, MPR No choices, Item Name auto-fill) is scoped to
  // whichever Budget is currently selected.
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [selectedBudget, setSelectedBudget] = useState<Budget | null>(null);
  const [budgetItems, setBudgetItems] = useState<BudgetItem[]>([]);
  const [loadingBudgetItems, setLoadingBudgetItems] = useState(false);
  // Per-column filters for the "Job Entry Details" table below — one small search input
  // directly under each header, each filtering only its own column. This replaced the
  // old raw "Budget Sheet" import preview — the User now searches their own submitted
  // entries instead of the full imported sheet.
  const [entryColumnFilters, setEntryColumnFilters] = useState({
    job_no: '',
    job_name: '',
    mpr_no: '',
    item_name: '',
    specification: '',
    req_qty: '',
    job_duration: '',
    // Delivery Date is a range (From/To date inputs), not free text like the other
    // columns — either side left blank means "no lower/upper bound".
    delivery_date_from: '',
    delivery_date_to: '',
    budget_name: ''
  });
  // Column filters live in a collapsible panel on mobile (there's no room for 9 inline
  // filter boxes above a card list the way there is above a table's header row).
  const [showMobileFilters, setShowMobileFilters] = useState(false);
  // The Item Name filter's "type or select" suggestions used to rely on a native
  // <datalist>, which many mobile browsers/WebViews (including the Capacitor Android
  // APK this app ships as) simply never render a dropdown for — so on mobile the
  // filter still worked, but no suggestion list ever showed while typing. Replaced
  // with the same custom absolute-positioned dropdown pattern used elsewhere in this
  // file (e.g. Project Name above). Separate open/close state for the mobile filter
  // sheet's input vs the desktop table header's input since both can exist in the DOM
  // at once.
  const [showItemNameFilterDropdownMobile, setShowItemNameFilterDropdownMobile] = useState(false);
  const [showItemNameFilterDropdownDesktop, setShowItemNameFilterDropdownDesktop] = useState(false);

  // Tapping an auto-filled Item Name in the MPR Entry form opens this popup with the
  // rest of that imported Budget Excel row's detail — Description, Unit, Specification,
  // Requisitioned Qty — so the user can double-check what they're entering against
  // without leaving the form.
  const [viewingBudgetItem, setViewingBudgetItem] = useState<BudgetItem | null>(null);
  // Per-item Delivery Date override popup — open only for one (rowId, budgetItemId)
  // Item at a time, with its own draft value so Cancel doesn't touch the real state
  // until Save is pressed.
  const [editingItemDelivery, setEditingItemDelivery] = useState<{ rowId: string; uid: string } | null>(null);
  const [itemDeliveryDraft, setItemDeliveryDraft] = useState<string>('');

  // Mobile: "Select a Budget", "Jobs", and "Job Entry Details" are three separate
  // full-height sections that used to all sit stacked on top of each other, forcing a
  // lot of scrolling to get from one to the next. Below md they now start out as three
  // small icon tiles instead — tapping one opens just that section (with a way back to
  // the tile menu); desktop is unaffected and keeps showing all three side by side.
  //
  // Which section is open is mirrored to localStorage (restored below via the lazy
  // initializer) so "pull down to reload" — see App.tsx — lands back on the exact
  // same section instead of resetting to the tile menu.
  const userSectionStorageKey = `mpr_user_section_${user.id}`;
  const [mobileActiveSection, setMobileActiveSection] = useState<'budget' | 'jobs' | 'entries' | 'jobEdit' | 'claim' | 'claims' | 'conveyanceClaim' | 'leave' | 'timesheet' | 'employeeDirectory' | 'noticeBoard' | null>(
    () => {
      try {
        const saved = localStorage.getItem(userSectionStorageKey);
        return (saved as any) || null;
      } catch {
        return null;
      }
    }
  );
  useEffect(() => {
    try {
      if (mobileActiveSection) localStorage.setItem(userSectionStorageKey, mobileActiveSection);
      else localStorage.removeItem(userSectionStorageKey);
    } catch {
      // localStorage can be unavailable in some embedded WebViews — safe to
      // ignore, it just means a reload won't be able to restore this section.
    }
  }, [mobileActiveSection]);
  // While the "Select a Budget" tile is the active mobile section, dock this
  // page's own title into the mobile header (Navbar.tsx) in place of the
  // company logo — see headerPageTitle.ts, same swap EmployeeDirectory does
  // for its search icon. Matches the tile's own label (line ~2907) so the
  // text doesn't change mid-navigation. Cleared on unmount (logout/panel
  // switch) by the separate effect below, not here, so switching between
  // this section and another doesn't flash the logo back on for a tick.
  useEffect(() => {
    setHeaderPageTitle(
      mobileActiveSection === 'budget'
        ? (selectedBudget ? 'MPR Entry' : 'Select a Budget')
        : mobileActiveSection === 'jobs'
        ? 'Jobs'
        : mobileActiveSection === 'entries'
        ? 'Job Entry Details'
        : mobileActiveSection === 'jobEdit'
        ? 'Job Edit'
        : null
    );
  }, [mobileActiveSection, selectedBudget]);
  useEffect(() => {
    return () => setHeaderPageTitle(null);
  }, []);
  // Switching mobile "pages" (tile taps, the bottom nav bar, etc.) only ever
  // toggles which section is display:block vs hidden — it never remounts or
  // scrolls anything on its own. Without this, jumping to a shorter page (e.g.
  // Job Edit) while scrolled down on a longer one (e.g. Entries) left the
  // viewport sitting at that old scroll offset, showing a big blank gap under
  // the header before the new page's actual content came into view. Every
  // plain "go to this section" call below uses this instead of calling
  // setMobileActiveSection directly, so the page always starts at the top.
  const goToMobileSection = (section: typeof mobileActiveSection) => {
    setMobileActiveSection(section);
    window.scrollTo({ top: 0 });
  };
  // Whether one of the Claims sections (Movement Claim, My Claims, Conveyance
  // Bill Claim) is the active section — on desktop this now means "show that
  // section as its own page", same as mobile, instead of these three always
  // sitting inline on the regular Dashboard (see the sections below and the
  // "Entry Form Grid"/Job Edit/Check In-Out visibility, which all hide on
  // desktop while this is true).
  const showingClaimsPage =
    mobileActiveSection === 'claim' ||
    mobileActiveSection === 'claims' ||
    mobileActiveSection === 'conveyanceClaim' ||
    mobileActiveSection === 'leave' ||
    mobileActiveSection === 'timesheet' ||
    mobileActiveSection === 'employeeDirectory' ||
    mobileActiveSection === 'noticeBoard';
  // Superadmin-gated, same as every other module in this app: an Admin/User only
  // sees Movement Claim / Conveyance Bill Claim once the Superadmin has granted
  // can_view_movement_claims / can_view_conveyance_claims (Admin Panel -> Users
  // -> Module Access). A Superadmin always sees both. Used to hide the mobile
  // tiles, the Navbar's desktop "Claims" menu targets, and to keep either page
  // from opening at all (e.g. a stale nav request) without the grant.
  const canSeeMovementClaim = user.role === 'superadmin' || !!user.can_view_movement_claims;
  const canSeeConveyanceClaim = user.role === 'superadmin' || !!user.can_view_conveyance_claims;
  // Same Superadmin-gated pattern as the two above, but ON by default (see
  // types.ts) — covers the "Select a Budget", "Jobs" and "Job Entry Details"
  // mobile tiles, the matching BottomNav tabs, and the desktop Navbar/
  // GlobalSidebar "Jobs" menu's Entry/Jobs/Entry Details items. Job Edit stays
  // on its own separate can_job_edit gate.
  const canSeeBudgetModule = user.role === 'superadmin' || user.can_view_budget_module !== false;
  // Superadmin-gated, same as can_view_movement_claims/can_view_conveyance_claims
  // above — OFF by default, granted per account via Admin Panel -> Users ->
  // Module Access (PUT /api/users/:id/timesheet-access). Also mirrored in
  // GlobalSidebar's selfServiceItems.
  const canSeeTimesheet = user.role === 'superadmin' || !!user.can_view_timesheet;
  // Gates the BottomNav "Leave" tab (and the LeaveReviewPage it opens) — same
  // grant as the Leave Summary card above (can_view_leave_summary), since
  // that card's "tap to open" target IS this same page. Previously ungated
  // (every account saw "Leave" in the bottom bar regardless of permission);
  // now an account without it falls back to "Directory" instead — see
  // BottomNav.tsx.
  const canSeeLeave = user.role === 'superadmin' || !!user.can_view_leave_summary;
  // Guards a section restored from localStorage (see the lazy initializer above,
  // which runs before these grants are known) or a permission the Superadmin
  // revokes mid-session — bounces back to the tile menu instead of leaving a
  // now-unauthorized page on screen.
  useEffect(() => {
    if ((mobileActiveSection === 'claim' || mobileActiveSection === 'claims') && !canSeeMovementClaim) {
      setMobileActiveSection(null);
    } else if (mobileActiveSection === 'conveyanceClaim' && !canSeeConveyanceClaim) {
      setMobileActiveSection(null);
    } else if (
      (mobileActiveSection === 'budget' || mobileActiveSection === 'jobs' || mobileActiveSection === 'entries') &&
      !canSeeBudgetModule
    ) {
      // Guards a section restored from localStorage (see the lazy initializer
      // above, which runs before this grant is known) or a permission the
      // Superadmin revokes mid-session — bounces back to the tile menu
      // instead of leaving a now-unauthorized page on screen.
      setMobileActiveSection(null);
    } else if (mobileActiveSection === 'timesheet' && !canSeeTimesheet) {
      setMobileActiveSection(null);
    } else if (mobileActiveSection === 'leave' && !canSeeLeave) {
      setMobileActiveSection(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSeeMovementClaim, canSeeConveyanceClaim, canSeeBudgetModule, canSeeTimesheet, canSeeLeave]);
  // Movement Claim page: the "Add Check In/Out" floating button opens the actual
  // Check In/Out form in a sheet (see below); claimListRefreshKey bumps every
  // time that form reports a successful Check In/Out, so MyClaimsCard's list
  // refetches without needing a full page reload.
  const [showClaimFormSheet, setShowClaimFormSheet] = useState(false);
  const [claimListRefreshKey, setClaimListRefreshKey] = useState(0);
  // Scroll target for the "Job Entry Details" section — used when a Job in the Jobs
  // list is tapped, so the (now-filtered) table is brought into view automatically.
  const entriesSectionRef = useRef<HTMLDivElement>(null);

  // Navbar's web-only "Claims" header menu — Movement Claims and Conveyance Bill
  // Claim are no longer part of the regular Dashboard on desktop (same as every
  // other section, they only show while they're the active mobileActiveSection);
  // this menu is what puts either one on screen there, exactly like tapping its
  // tile does on mobile — a dedicated page, not a spot to scroll to.
  useEffect(() => {
    if (!claimsNavRequest) return;
    const wantsMovement = claimsNavRequest.target === 'movementClaims';
    if (wantsMovement ? !canSeeMovementClaim : !canSeeConveyanceClaim) return;
    setMobileActiveSection(wantsMovement ? 'claim' : 'conveyanceClaim');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimsNavRequest]);

  // Which of Entry/Jobs/Entry Details/Job Edits is the active "page" on
  // desktop — mirrors mobileActiveSection's job-related values, but tracked
  // separately since desktop has no tile menu / "Dashboard" concept to fall
  // back to: it always shows exactly one of these four (default 'budget' i.e.
  // Entry, the everyday landing task) instead of the old behavior of showing
  // all of them stacked together. Mobile is unaffected and keeps using
  // mobileActiveSection + the tile menu exactly as before. Mirrored to
  // localStorage same as mobileActiveSection, so "pull down to reload" lands
  // back on the same desktop section too.
  // 'dashboard' — a genuine blank-landing state (welcome banner + Check
  // In/Out + Leave Summary + Pending Approvals, nothing from the Entry/Jobs/
  // Entry Details/Job Edit grid below) — is its own value here now, separate
  // from 'budget' (Entry). Previously 'budget' doubled as both "the Dashboard
  // landing" AND "the Entry page", so Entry/Jobs/Entry Details/Job Edit
  // always rendered mixed in alongside the Dashboard's own widgets on
  // desktop; each is now a standalone page the same way a Claims page
  // already is (see showingMainGroupPage below), and 'dashboard' is the
  // actual default landing a fresh session (or "Dashboard" in the sidebar)
  // returns to.
  const userDesktopSectionStorageKey = `mpr_user_desktop_section_${user.id}`;
  const [desktopActiveSection, setDesktopActiveSection] = useState<'dashboard' | 'budget' | 'jobs' | 'entries' | 'jobEdit'>(() => {
    try {
      const saved = localStorage.getItem(userDesktopSectionStorageKey);
      if (saved === 'dashboard' || saved === 'budget' || saved === 'jobs' || saved === 'entries' || saved === 'jobEdit') return saved;
    } catch {
      // ignore — falls through to the 'dashboard' default below
    }
    return 'dashboard';
  });
  // Whether one of Entry/Jobs/Entry Details/Job Edit is the active desktop
  // section — desktop-only equivalent of showingClaimsPage above (mobile
  // already treats these as their own tile-menu pages and is unaffected).
  // 'dashboard' is the one desktopActiveSection value this is false for —
  // the actual blank Dashboard landing (welcome banner/Check In-Out/Leave
  // Summary/Pending Approvals), everything else here hides right alongside
  // showingClaimsPage while any of these four standalone pages is open.
  const showingMainGroupPage = desktopActiveSection !== 'dashboard';
  // Same isNativeApp split every other ModulePath breadcrumb uses (Timesheet,
  // Leave Application, ConveyanceClaimCard, etc.) — the "Main / X" trail below
  // is a web-only affordance, desktop only (mobile already has its own "Back
  // to Menu" header for these same sections).
  const isNativeApp = Capacitor.isNativePlatform();
  useEffect(() => {
    try {
      localStorage.setItem(userDesktopSectionStorageKey, desktopActiveSection);
    } catch {
      // localStorage can be unavailable in some embedded WebViews — safe to
      // ignore, it just means a reload won't be able to restore this section.
    }
  }, [desktopActiveSection]);

  // Guards a desktop section restored from localStorage above (which runs
  // before canSeeBudgetModule is known) or a permission the Superadmin
  // revokes mid-session — same idea as the mobile bounce-back effect further
  // up. Falls back to Job Edit if this account still has that separate
  // grant, otherwise the (now genuinely blank) Dashboard.
  useEffect(() => {
    if (
      (desktopActiveSection === 'budget' || desktopActiveSection === 'jobs' || desktopActiveSection === 'entries') &&
      !canSeeBudgetModule
    ) {
      setDesktopActiveSection(user.can_job_edit ? 'jobEdit' : 'dashboard');
    } else if (desktopActiveSection === 'jobEdit' && !user.can_job_edit) {
      setDesktopActiveSection('dashboard');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canSeeBudgetModule]);

  // Navbar's web-only "Jobs" header menu — see desktopActiveSection above.
  // Also puts the same section on screen on mobile (mirrors claimsNavRequest
  // above) — previously this bounced mobileActiveSection back to null (the
  // dashboard tile menu) instead of opening the requested section, so tapping
  // Entry/Jobs/Entry Details/Job Edits from the sidebar looked like it did
  // nothing on mobile even though desktop opened correctly.
  useEffect(() => {
    if (!jobsNavRequest) return;
    const map: Record<JobsNavRequest['target'], 'budget' | 'jobs' | 'entries' | 'jobEdit'> = {
      entry: 'budget',
      jobs: 'jobs',
      entryDetails: 'entries',
      jobEdit: 'jobEdit'
    };
    const wantsJobEdit = jobsNavRequest.target === 'jobEdit';
    if (wantsJobEdit ? !user.can_job_edit : !canSeeBudgetModule) return;
    setDesktopActiveSection(map[jobsNavRequest.target]);
    setMobileActiveSection(map[jobsNavRequest.target]);
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [jobsNavRequest]);

  // GlobalSidebar's "Dashboard" item — see dashboardNavRequest above. Resets
  // both the mobile tile menu (mobileActiveSection back to null) and the
  // desktop section (desktopActiveSection back to 'dashboard', the actual
  // blank landing now that Entry/Jobs/Entry Details/Job Edit are each their
  // own standalone page) so the dashboard actually comes back on screen,
  // instead of leaving whichever section was active/restored beforehand.
  useEffect(() => {
    if (!dashboardNavRequest) return;
    setMobileActiveSection(null);
    setDesktopActiveSection('dashboard');
    window.scrollTo({ top: 0, behavior: 'smooth' });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dashboardNavRequest]);

  // Form state
  const [entryDate, setEntryDate] = useState<string>(todayDateOnlyString());
  const [projectId, setProjectId] = useState<string>('');
  // Admin-set Delivery Date "minimum lead time" for the New Job Entry form's
  // own rows below (Condition Set's "entry" type — see
  // deliveryDateConditions.ts). Re-resolves whenever the Project/Budget
  // picked above changes; null (unrestricted) until both are chosen.
  const { earliestAllowedDate: newEntryEarliestDate } = useDeliveryLeadTime(
    token,
    'entry',
    projectId ? Number(projectId) : null,
    selectedBudget?.id
  );
  // Project Name is now a type-to-search dropdown (same pattern as MPR No) instead of
  // a plain <select> — projectSearchText holds what's typed/shown, showProjectDropdown
  // toggles the suggestion list.
  const [projectSearchText, setProjectSearchText] = useState<string>('');
  const [showProjectDropdown, setShowProjectDropdown] = useState(false);
  const [jobName, setJobName] = useState<string>('');
  const [jobDuration, setJobDuration] = useState<string>('');
  // Two-step "New MPR Entry" form: Job No/Entry Date/Project Name/Job Name/Job
  // Duration are filled first, then "Next" collapses them into a summary card so
  // the (usually much longer) MPR No Entries section below has the full form to
  // itself instead of always sitting beneath a wall of already-filled fields.
  const [jobDetailsConfirmed, setJobDetailsConfirmed] = useState(false);
  const [mprRows, setMprRows] = useState<MprRow[]>([makeEmptyRow()]);
  // Set when the user tapped a Job in the Jobs list to add ONE MORE MPR into that
  // EXISTING Job (instead of the default "always creates a brand-new Job" flow) —
  // see startEditJob below. null means the form is in its normal "New MPR Entry"
  // mode.
  const [editingJob, setEditingJob] = useState<{ jobId: number; jobNo: string } | null>(null);

  const [loading, setLoading] = useState(false);
  // Tracks which Budget is currently being Submitted (Finished) — the button now
  // lives per-Job in the Jobs list (any Job under that Budget can trigger it), so
  // this holds a Budget id instead of a single flag to disable only the row whose
  // Submit was actually clicked.
  const [submittingBudgetId, setSubmittingBudgetId] = useState<number | null>(null);
  const [message, setMessage] = useState<{ type: 'success' | 'error' | 'warning'; text: string } | null>(null);
  // Popup shown right after a Job is successfully saved — separate from the
  // inline Message Banner above (which can be scrolled out of view), so the
  // user always sees a clear confirmation of what was just saved.
  const [savedJobPopup, setSavedJobPopup] = useState<{ jobNo: string; count: number } | null>(null);


  // Editing a single MPR row inside the Job Entry Details popup — only allowed for the
  // User's own entries, and only while the entry's Budget hasn't been submitted yet.
  const [editingEntryId, setEditingEntryId] = useState<number | null>(null);
  const [editItemName, setEditItemName] = useState('');
  // Which specific imported Excel row (budget_items.id) editItemName currently refers
  // to — kept alongside the text so that picking a row whose Description text happens
  // to match another row still resolves to the exact right Specification/Qty.
  const [editItemBudgetItemId, setEditItemBudgetItemId] = useState<number | null>(null);
  // Requisitioned Qty for the entry being edited, plus the entry's ORIGINAL item +
  // qty (captured once when the popup opens) — needed because the item's "remaining"
  // Qty coming back from the server already counts this same entry's own current Qty
  // as "consumed", so it has to be added back when computing the max the user can
  // type here for that same item (a switch to a DIFFERENT item uses the plain
  // server-reported remaining instead).
  const [editQty, setEditQty] = useState('');
  const [editOriginalBudgetItemId, setEditOriginalBudgetItemId] = useState<number | null>(null);
  const [editOriginalQty, setEditOriginalQty] = useState<number | null>(null);
  const [editDeliveryDate, setEditDeliveryDate] = useState('');
  const [editItemOptions, setEditItemOptions] = useState<MprItemOption[]>([]);
  const [editLoadingOptions, setEditLoadingOptions] = useState(false);
  const [editSaving, setEditSaving] = useState(false);
  const [editError, setEditError] = useState('');
  // Deleting a single MPR row inside the Job Entry Details popup — only allowed for
  // the User's own (unlocked) entries. A delete moves the entry into the Admin's Job
  // Recycle bin, it isn't erased outright.
  const [deletingEntryId, setDeletingEntryId] = useState<number | null>(null);
  const [deleteError, setDeleteError] = useState('');
  // Splitting an existing entry's Requisitioned Qty into a new entry — same
  // eligibility as full editing above (entry.budget_locked must be false), and
  // triggered right from within the inline edit row/card's own Qty field (see
  // "Split remaining Qty into a new item" below) rather than a separate popup, to
  // match how splitting already looks and behaves while first creating a Job.
  const [splitSaving, setSplitSaving] = useState(false);
  const [splitError, setSplitError] = useState('');
  // Job Name / Job Duration / MPR No — also editable now (Item Name / Delivery Date
  // were already editable above). Job Name and Job Duration apply to the whole Job
  // (every MPR row under it), not just this one row.
  const [editJobName, setEditJobName] = useState('');
  const [editJobDuration, setEditJobDuration] = useState('');
  const [editMprId, setEditMprId] = useState('');
  const [editMprSearchText, setEditMprSearchText] = useState('');
  const [editShowMprDropdown, setEditShowMprDropdown] = useState(false);
  // The entry being edited's own Budget's imported items — used both for the Item Name
  // options (as before) and now for scoping which MPR Nos are pickable in the dropdown.
  const [editBudgetItems, setEditBudgetItems] = useState<BudgetItem[]>([]);

  // "Export PDF" preview — on the web build, the generated PDF opens in this
  // modal first so the user can look it over before choosing to download it
  // (on the Android APK, there's no reliable way to preview a PDF inline in
  // the WebView, so it skips straight to the native Share sheet instead —
  // see handleExportPdf below).
  const [pdfPreview, setPdfPreview] = useState<{ doc: any; bytes: Uint8Array; filename: string } | null>(null);
  const closePdfPreview = () => setPdfPreview(null);

  // Android hardware back button: each of these closes just that one
  // modal/drill-down instead of exiting the app (see useBackButtonClose.ts).
  // Order doesn't matter — only whichever is actually open registers itself.
  useBackButtonClose(mobileActiveSection !== null, () => goToMobileSection(null));
  useBackButtonClose(showClaimFormSheet, () => setShowClaimFormSheet(false));
  useBackButtonClose(showMobileFilters, () => setShowMobileFilters(false));
  useBackButtonClose(editingEntryId !== null, () => setEditingEntryId(null));
  useBackButtonClose(deletingEntryId !== null, () => setDeletingEntryId(null));
  useBackButtonClose(viewingBudgetItem !== null, () => setViewingBudgetItem(null));
  useBackButtonClose(savedJobPopup !== null, () => setSavedJobPopup(null));
  useBackButtonClose(editingItemDelivery !== null, () => setEditingItemDelivery(null));

  // Delivery Date window (if any) for the Budget the entry being edited belongs to —
  // looked up from the already-fetched budgets list so the edit date input can be
  // constrained with the same min/max as the main entry form.
  const [editDeliveryRange, setEditDeliveryRange] = useState<{ from: string | null; to: string | null }>({
    from: null,
    to: null
  });

  useEffect(() => {
    fetchMasterData();
    fetchEntries();
    fetchMprUsage();
  }, [token]);

  const fetchMasterData = async () => {
    try {
      const [projRes, mprRes, budgetRes] = await Promise.all([
        fetch(apiUrl('/api/projects'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/mpr-numbers'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/budgets'), { headers: { Authorization: `Bearer ${token}` } })
      ]);
      if (projRes.ok) setProjects(await projRes.json());
      if (mprRes.ok) setMprNumbers(await mprRes.json());
      if (budgetRes.ok) setBudgets(await budgetRes.json());
    } catch (err) {
      console.error('Failed to load master data', err);
    } finally {
      setProjectsLoaded(true);
    }
  };

  // Only Budgets the Admin has actually imported an Excel sheet into are usable for a
  // new MPR Entry — a Budget that's only been named but has nothing imported yet has
  // no Project/MPR No choices to offer.
  const usableBudgets = React.useMemo(
    () => budgets.filter((b) => (b.item_count || 0) > 0),
    [budgets]
  );

  const openBudget = async (budget: Budget) => {
    setSelectedBudget(budget);
    setBudgetItems([]);
    setMessage(null);
    // Reset the form whenever a (new) Budget is opened, so a stale row from a
    // previously opened Budget can never carry over into this one.
    setJobName('');
    setJobDuration('');
    setJobDetailsConfirmed(false);
    setProjectId('');
    setProjectSearchText('');
    setShowProjectDropdown(false);
    setMprRows([makeEmptyRow()]);
    setEditingJob(null);
    setLoadingBudgetItems(true);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${budget.id}/items`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setBudgetItems(await res.json());
    } catch (err) {
      console.error('Failed to load budget items', err);
    } finally {
      setLoadingBudgetItems(false);
    }
  };

  // Re-pulls just the currently-open Budget's items (with each item's fresh
  // requisitioned_by_me) WITHOUT resetting the form — used after an entry is
  // saved/edited/deleted so the New MPR Entry form's remainingQty for every item
  // immediately reflects what was just consumed. Without this, budgetItems stayed
  // stale for the rest of the session: e.g. an Item with Qty 200 would still show
  // the full 200 as remaining in the next row even after 100 was just entered,
  // letting the user over-requisition past what's actually left.
  const refreshBudgetItems = async (budgetId: number) => {
    try {
      const res = await fetch(apiUrl(`/api/budgets/${budgetId}/items`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setBudgetItems(await res.json());
    } catch (err) {
      console.error('Failed to refresh budget items', err);
    }
  };

  const closeBudget = () => {
    setSelectedBudget(null);
    setBudgetItems([]);
    setMessage(null);
    setEditingJob(null);
  };

  // --- Mobile "sitting idle reloads the app" fix -----------------------------
  // On many Android phones (especially aggressive-battery-saving OEM skins like
  // MIUI/ColorOS/FuntouchOS) the OS kills this app's background process to
  // free memory once it's been off-screen a while — the app icon/recent-apps
  // card still looks "open", but nothing in memory survives. Since this build
  // always loads its pages fresh from a live server (see capacitor.config.ts,
  // "server.url") rather than bundling them locally, the next time the app is
  // reopened Capacitor has to recreate the WebView from scratch: every bit of
  // in-memory React state — the half-filled "New MPR Entry" form, which
  // Budget/Job was open, typed MPR rows — is gone and the app silently resets
  // to the Dashboard. That's the "reload after sitting idle" the user is
  // reporting.
  //
  // localStorage DOES survive that kind of reload (it isn't in-memory state),
  // so the in-progress "New MPR Entry" draft is mirrored there as the user
  // types, and restored the next time this component mounts — a forced
  // background reload then costs a re-render, not the user's unsaved work.
  const draftStorageKey = `mpr_draft_v1_${user.id}`;
  const draftRestoredRef = useRef(false);

  // Restore once, as soon as the Budgets list (needed to re-link
  // selectedBudget back to a real Budget object) has loaded.
  useEffect(() => {
    if (draftRestoredRef.current) return;
    if (budgets.length === 0) return; // wait for fetchMasterData to populate it
    draftRestoredRef.current = true;
    try {
      const raw = localStorage.getItem(draftStorageKey);
      if (!raw) return;
      const draft = JSON.parse(raw);
      if (!draft || typeof draft !== 'object') return;
      const budget = budgets.find((b) => b.id === draft.selectedBudgetId);
      if (!budget) return; // stale draft (Budget no longer visible) — ignore it
      setSelectedBudget(budget);
      setLoadingBudgetItems(true);
      fetch(apiUrl(`/api/budgets/${budget.id}/items`), { headers: { Authorization: `Bearer ${token}` } })
        .then((res) => (res.ok ? res.json() : []))
        .then((items) => setBudgetItems(items))
        .catch(() => {})
        .finally(() => setLoadingBudgetItems(false));
      if (draft.editingJob) setEditingJob(draft.editingJob);
      setJobDetailsConfirmed(!!draft.jobDetailsConfirmed);
      if (draft.entryDate) setEntryDate(draft.entryDate);
      if (draft.projectId) setProjectId(draft.projectId);
      if (draft.projectSearchText) setProjectSearchText(draft.projectSearchText);
      if (draft.jobName) setJobName(draft.jobName);
      if (draft.jobDuration) setJobDuration(draft.jobDuration);
      if (Array.isArray(draft.mprRows) && draft.mprRows.length > 0) setMprRows(draft.mprRows);
    } catch (err) {
      console.error('Failed to restore saved MPR draft', err);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [budgets]);

  // Keep the draft saved as the user works. Gated on draftRestoredRef so the
  // empty initial render (before restore above runs) never stomps a real
  // saved draft — and cleared once no Budget is open, since there's nothing
  // in-progress to protect at that point.
  useEffect(() => {
    if (!draftRestoredRef.current) return;
    try {
      if (!selectedBudget) {
        localStorage.removeItem(draftStorageKey);
        return;
      }
      localStorage.setItem(
        draftStorageKey,
        JSON.stringify({
          selectedBudgetId: selectedBudget.id,
          editingJob,
          jobDetailsConfirmed,
          entryDate,
          projectId,
          projectSearchText,
          jobName,
          jobDuration,
          mprRows
        })
      );
    } catch (err) {
      // localStorage can be unavailable/full in some embedded WebViews — safe
      // to ignore, it just means this particular reload won't be recoverable.
    }
  }, [
    selectedBudget,
    editingJob,
    jobDetailsConfirmed,
    entryDate,
    projectId,
    projectSearchText,
    jobName,
    jobDuration,
    mprRows
  ]);
  // --- end mobile reload fix --------------------------------------------------

  // Adding an MPR to a Job you already own is just a normal part of entering data —
  // no special permission needed, same as creating the Job in the first place (the
  // server allows this too, see POST /api/entries/job/:jobId/items). can_job_edit is
  // only actually required once the Budget has been Final Submitted, which is exactly
  // when the "Job Edit" tile/tab (not this button) takes over.
  const canEditExistingJob = true;

  // Jumps back into the MPR Entry form to add ONE MORE MPR row into an EXISTING
  // Job — tapped from a Job's row in the Jobs list. Unlike the normal "New MPR
  // Entry" flow (which always creates a brand-new Job No on submit), this locks
  // onto the Job that was tapped: Project Name/Job Name/Job Duration are shown
  // read-only (the server ignores them here regardless, see
  // POST /api/entries/job/:jobId/items — it always keeps what the Job already
  // has), so only the MPR No Entries section below is actually editable.
  const startEditJob = (j: { job_no: string; job_name: string; job_id: number; project_id: number; job_duration: string }) => {
    setEditingJob({ jobId: j.job_id, jobNo: j.job_no });
    setProjectId(String(j.project_id));
    const proj = projects.find((p) => p.id === j.project_id);
    setProjectSearchText(proj ? proj.project_name : '');
    setJobName(j.job_name);
    setJobDuration(String(j.job_duration || ''));
    setJobDetailsConfirmed(true);
    setMprRows([makeEmptyRow()]);
    setMessage(null);
    goToMobileSection('budget');
    setDesktopActiveSection('budget');
  };

  // Leaves "add MPR to existing Job" mode and resets the form back to a normal
  // brand-new-Job entry.
  const cancelEditJob = () => {
    setEditingJob(null);
    setProjectId('');
    setProjectSearchText('');
    setJobName('');
    setJobDuration('');
    setJobDetailsConfirmed(false);
    setMprRows([makeEmptyRow()]);
    setMessage(null);
  };

  const clearEntryColumnFilters = () =>
    setEntryColumnFilters({
      job_no: '',
      job_name: '',
      mpr_no: '',
      item_name: '',
      specification: '',
      req_qty: '',
      job_duration: '',
      delivery_date_from: '',
      delivery_date_to: '',
      budget_name: ''
    });

  const hasActiveEntryColumnFilter = Object.values(entryColumnFilters).some((v) => v.trim());

  // Live preview of what this User's next Job No under the selected Budget WILL
  // become on submit — mirrors the server's own "JOB-000X, sequential per user per
  // budget" logic (COUNT of this user's distinct Jobs under this Budget, + 1) so the
  // Job No field shows something meaningful instead of sitting blank until submit.
  const nextJobNoPreview = React.useMemo(() => {
    if (!selectedBudget) return '';
    const myJobNosInBudget = new Set(
      entries
        .filter((e) => e.budget_id === selectedBudget.id && e.created_by === user.id)
        .map((e) => e.job_no)
    );
    return `JOB-${String(myJobNosInBudget.size + 1).padStart(4, '0')}`;
  }, [entries, selectedBudget, user.id]);

  // Only Projects that were actually imported into the selected Budget's Excel sheet
  // (and that this User already has access to) may be picked for a new entry.
  const scopedProjects = React.useMemo(() => {
    if (!selectedBudget) return [];
    const namesInBudget = new Set(
      budgetItems.filter((bi) => bi.project_name).map((bi) => bi.project_name!.trim().toLowerCase())
    );
    return projects.filter((p) => namesInBudget.has(p.project_name.trim().toLowerCase()));
  }, [selectedBudget, budgetItems, projects]);

  // Suggestions for the Project Name type-to-search dropdown — scoped to this
  // Budget's imported Projects, filtered by whatever's currently typed.
  const filteredScopedProjects = React.useMemo(() => {
    const q = projectSearchText.trim().toLowerCase();
    if (!q) return scopedProjects;
    return scopedProjects.filter((p) => p.project_name.toLowerCase().includes(q));
  }, [scopedProjects, projectSearchText]);

  // If this User only has ONE Project available for the selected Budget, there's
  // nothing to actually choose — auto-fill it instead of making them search/select
  // a list of one. Still re-runs if the Budget (and so scopedProjects) changes.
  useEffect(() => {
    if (scopedProjects.length === 1 && projectId !== String(scopedProjects[0].id)) {
      setProjectId(String(scopedProjects[0].id));
      setProjectSearchText(scopedProjects[0].project_name);
    }
  }, [scopedProjects]);

  const selectProject = (project: Project) => {
    setProjectId(String(project.id));
    setProjectSearchText(project.project_name);
    setShowProjectDropdown(false);
    setJobDetailsConfirmed(false);
    // A different Project can have a completely different set of valid MPR Nos, so
    // any rows already filled in against the old Project no longer make sense —
    // reset back to a single empty row.
    setMprRows([makeEmptyRow()]);
  };

  // One MPR No can carry more than one imported Excel row (several distinct line
  // items requisitioned under the same MRF No) — this returns EVERY row imported for
  // that MPR No in the selected Budget, so the Item Name field can offer all of them
  // instead of silently picking one. Rows are kept as individual budget_items — even
  // when two rows share the exact same "Description of Materials" text (different
  // Qty/Specification/Sl.No.), each is still its own entry, not merged into one.
  const itemsForMprInBudget = (mprNo: string): MprItemOption[] => {
    const out: MprItemOption[] = [];
    for (const bi of budgetItems) {
      if ((bi.mrf_no || '').trim().toLowerCase() !== mprNo.trim().toLowerCase()) continue;
      const desc = (bi.description || '').trim();
      if (!desc) continue;
      const reqQty = parseQtyNumber(bi.req_qty);
      const consumed = Number(bi.requisitioned_by_me || 0);
      const remainingQty = reqQty === null ? null : Math.max(0, reqQty - consumed);
      // An item this user has already fully requisitioned (remainingQty === 0) has
      // nothing left to enter — leave it out so it doesn't clutter the auto-fill;
      // it reappears here on its own once an edit elsewhere frees up some balance.
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

  // Updates just the Requisitioned Qty typed for one item within one MPR row (a row
  // can carry several items when its MPR No spans more than one imported Excel row,
  // or when an item's leftover Qty was split into its own entry — see
  // splitLeftoverInSameRow). Keyed by uid, not budgetItemId, since a split entry
  // shares its budgetItemId with the entry it was split from.
  const updateRowItemQty = (rowId: string, uid: string, qty: string) => {
    setMprRows((prev) =>
      prev.map((r) =>
        r.rowId !== rowId
          ? r
          : { ...r, itemNames: r.itemNames.map((it) => (it.uid === uid ? { ...it, qty } : it)) }
      )
    );
  };

  // Opens the per-item Delivery Date popup, seeding its draft with whatever's already
  // in effect for that item (its own override, or the row's shared date as a starting
  // point) so the picker never opens empty when there's already a sensible value.
  const openItemDeliveryEditor = (row: MprRow, opt: MprItemOption) => {
    setEditingItemDelivery({ rowId: row.rowId, uid: opt.uid });
    setItemDeliveryDraft(getItemDeliveryDate(row, opt));
  };

  const saveItemDeliveryDraft = () => {
    if (!editingItemDelivery) return;
    const { rowId, uid } = editingItemDelivery;
    setMprRows((prev) =>
      prev.map((r) =>
        r.rowId !== rowId
          ? r
          : {
              ...r,
              itemNames: r.itemNames.map((it) =>
                it.uid === uid ? { ...it, deliveryDate: itemDeliveryDraft } : it
              )
            }
      )
    );
    setEditingItemDelivery(null);
  };

  // Clears the override so this item goes back to just following the row's shared
  // Delivery Date field.
  const clearItemDeliveryOverride = () => {
    if (!editingItemDelivery) return;
    const { rowId, uid } = editingItemDelivery;
    setMprRows((prev) =>
      prev.map((r) =>
        r.rowId !== rowId
          ? r
          : { ...r, itemNames: r.itemNames.map((it) => (it.uid === uid ? { ...it, deliveryDate: '' } : it)) }
      )
    );
    setEditingItemDelivery(null);
  };

  // Splits an item's leftover Qty into a NEW Item entry within the SAME MPR row (NOT a
  // separate MPR Row) — for when only part of an item's available Qty should go out
  // against THIS entry's current Delivery Date and the rest needs a different one (a
  // partial requisition). The leftover becomes just another entry in this row's Item
  // list, exactly like when an MPR No auto-fills more than one imported Excel row, so
  // it gets its own Qty and can be given its own Delivery Date via "Edit". The
  // original entry's ceiling is locked down to exactly what's been entered here, and
  // the new entry's ceiling is set to exactly what's left over, so the two together
  // can never add up to more than what was really available — see the matching note
  // in the submit handler below, and the server's aggregated check.
  const splitLeftoverInSameRow = (rowId: string, uid: string) => {
    const row = mprRows.find((r) => r.rowId === rowId);
    const opt = row?.itemNames.find((it) => it.uid === uid);
    if (!row || !opt) return;
    const entered = Number(opt.qty);
    if (opt.remainingQty === null || !Number.isFinite(entered) || entered <= 0 || entered >= opt.remainingQty) return;
    const leftover = opt.remainingQty - entered;

    const newItem: MprItemOption = {
      uid: makeItemUid(),
      budgetItemId: opt.budgetItemId,
      name: opt.name,
      reqQty: opt.reqQty,
      remainingQty: leftover,
      qty: String(leftover),
      deliveryDate: ''
    };

    setMprRows((prev) =>
      prev.map((r) => {
        if (r.rowId !== rowId) return r;
        const idx = r.itemNames.findIndex((it) => it.uid === uid);
        if (idx === -1) return r;
        const updatedItems = r.itemNames.map((it) => (it.uid === uid ? { ...it, remainingQty: entered } : it));
        const nextItems = [...updatedItems];
        nextItems.splice(idx + 1, 0, newItem);
        return { ...r, itemNames: nextItems };
      })
    );
  };

  // Drops a single Item out of a row that carries multiple Items under the same
  // MPR No (e.g. the user only wants to requisition some of them, not all). Only
  // meaningful when the row currently has more than one Item — removing the last
  // one would leave an empty row, which the user should remove via removeRow
  // instead, so this is a no-op in that case. Keyed by uid so removing one half of a
  // split entry never also removes its sibling that shares the same budgetItemId.
  const removeItemFromRow = (rowId: string, uid: string) => {
    setMprRows((prev) =>
      prev.map((r) => {
        if (r.rowId !== rowId || r.itemNames.length <= 1) return r;
        return { ...r, itemNames: r.itemNames.filter((it) => it.uid !== uid) };
      })
    );
  };

  // Items still available to add (back) into a row's Item list — every imported Excel
  // row under this row's MPR No that isn't currently present there, whether it was
  // dropped via the X button earlier or simply never auto-filled. Lets the user
  // restore an Item they removed from the multiple-item list, without having to
  // re-pick the MPR No from scratch.
  const addableItemsForRow = (row: MprRow): MprItemOption[] => {
    if (!row.mprId) return [];
    const present = new Set(row.itemNames.map((it) => it.budgetItemId));
    return itemsForMprInBudget(row.mprSearchText).filter((it) => !present.has(it.budgetItemId));
  };

  // Adds one available Item (see addableItemsForRow) back into a row's Item list, as
  // its own new entry with a fresh uid.
  const addItemToRow = (rowId: string, budgetItemId: number) => {
    const row = mprRows.find((r) => r.rowId === rowId);
    if (!row) return;
    const toAdd = itemsForMprInBudget(row.mprSearchText).find((it) => it.budgetItemId === budgetItemId);
    if (!toAdd) return;
    setMprRows((prev) =>
      prev.map((r) => (r.rowId !== rowId ? r : { ...r, itemNames: [...r.itemNames, toAdd] }))
    );
  };

  const fetchEntries = async () => {
    try {
      const res = await fetch(apiUrl('/api/entries'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setEntries(await res.json());
    } catch (err) {
      console.error('Failed to load entries', err);
    }
  };

  const fetchMprUsage = async () => {
    try {
      const res = await fetch(apiUrl('/api/entries/mpr-usage'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setMprUsage(await res.json());
    } catch (err) {
      console.error('Failed to load MPR usage', err);
    }
  };

  // --- MPR row helpers (one row = one MPR No + Item Name + Delivery Date) ---
  const updateRow = (rowId: string, patch: Partial<MprRow>) => {
    setMprRows((prev) => prev.map((r) => (r.rowId === rowId ? { ...r, ...patch } : r)));
  };

  const selectMprForRow = (rowId: string, mprId: string, mprNo: string) => {
    // Auto-fill EVERY Excel row imported under this MPR No — when an MPR No carries
    // several items in the Budget Excel (including rows with a duplicate Description),
    // all of them are entered together for this row instead of making the user pick
    // just one or silently dropping duplicates.
    const items = itemsForMprInBudget(mprNo);
    updateRow(rowId, { mprId, mprSearchText: mprNo, showDropdown: false, itemNames: items });
  };

  // Adding a new MPR row leaves BOTH the MPR No and Delivery Date blank — each row
  // must have its Delivery Date picked manually. (Previously the Delivery Date carried
  // over from the last row; that's intentionally removed now so "Select a Delivery
  // Date..." always shows until the user picks one.) An MPR No must never be
  // pre-filled/duplicated into a new row, since the same MPR No cannot be reused within
  // one Job submission. The row being left behind collapses down to just MPR No +
  // Delivery Date to keep the form compact.
  // Blocked if the current last row's MPR No is still blank, or if any of its Items
  // still has no EFFECTIVE Delivery Date (its own per-item override, or the row's
  // shared field) — matching the same "every Item needs a date, however it gets one"
  // rule the submit validation and the "Done"/"Add MPR No" buttons already use. The
  // row's shared Delivery Date field itself is only required when at least one Item
  // is still relying on it (see the "required" toggle on that field below).
  const addRow = () => {
    const last = mprRows[mprRows.length - 1];
    if (last && !last.mprId) {
      setMessage({ type: 'error', text: 'Select an MPR No for the current row before adding another one.' });
      return;
    }
    const lastRowDeliveryComplete =
      last && last.itemNames.length > 0
        ? last.itemNames.every((opt) => getItemDeliveryDate(last, opt))
        : !!last?.deliveryDate;
    if (last && !lastRowDeliveryComplete) {
      setMessage({ type: 'error', text: 'Select a Delivery Date for every Item in the current row before adding another one.' });
      return;
    }
    const newRow = makeEmptyRow();
    setMprRows((prev) => [...prev.map((r) => ({ ...r, collapsed: true })), newRow]);
  };

  const removeRow = (rowId: string) => {
    setMprRows((prev) => (prev.length > 1 ? prev.filter((r) => r.rowId !== rowId) : prev));
  };

  // An MPR No is excluded from the dropdown once it's no longer available to pick:
  // - not imported under the currently selected Project (within this Budget's sheet)
  // - already selected in another row of THIS form (can't use the same MPR twice in one Job)
  // - already used in ANY past entry — this user's own (under this Job or any other
  //   Job) or a different user's. An MPR No can only ever be entered once, system-wide,
  //   full stop; it's never reusable again afterwards, even by the same user who used it.
  const filteredMprFor = (row: MprRow) => {
    const selectedProject = projects.find((p) => String(p.id) === projectId);
    const selectedProjectName = selectedProject ? selectedProject.project_name.trim().toLowerCase() : '';
    // Scoped to the imported rows for THIS Project only — an MPR No imported under a
    // different Project in the same Budget sheet must not show up here.
    const allowedInBudget = new Set(
      budgetItems
        .filter((bi) => bi.mrf_no && (bi.project_name || '').trim().toLowerCase() === selectedProjectName)
        .map((bi) => bi.mrf_no!.trim().toLowerCase())
    );
    const usedByOtherRows = new Set(
      mprRows.filter((r) => r.rowId !== row.rowId && r.mprId).map((r) => r.mprId)
    );
    const usedElsewhere = new Set(mprUsage.map((u) => String(u.mpr_id)));
    if (!selectedProjectName) return [];
    return mprNumbers.filter(
      (m) =>
        allowedInBudget.has(m.mpr_no.trim().toLowerCase()) &&
        m.mpr_no.toLowerCase().includes(row.mprSearchText.toLowerCase()) &&
        !usedByOtherRows.has(String(m.id)) &&
        !usedElsewhere.has(String(m.id))
    );
  };

  // Looks up whether the MPR No currently typed into a row exactly matches one
  // that's already been entered ANYWHERE — by this same user (an earlier Job) or by
  // a different user — so the row shows exactly which Job it's already sitting
  // under, no matter who put it there. An MPR No entered once is never reusable
  // again by anyone (see filteredMprFor), so this always blocks selection too.
  const mprUsageForSearchText = (searchText: string): MprUsage | null => {
    const q = searchText.trim().toLowerCase();
    if (!q) return null;
    return mprUsage.find((u) => u.mpr_no.trim().toLowerCase() === q) || null;
  };

  // Looks up whether the MPR No currently typed into a row matches one already
  // picked in ANOTHER row of THIS SAME in-progress Job form (not yet saved, so it
  // can't come from mprUsage above) — e.g. Row 1 already has "MRF-001" selected and
  // the user starts typing "MRF-001" again into Row 2. Returns the other row's
  // 1-based position so the message can point straight at it ("already in Row 1").
  const duplicateRowMatchFor = (row: MprRow): number | null => {
    const q = row.mprSearchText.trim().toLowerCase();
    if (!q) return null;
    const idx = mprRows.findIndex(
      (r) => r.rowId !== row.rowId && r.mprId && r.mprSearchText.trim().toLowerCase() === q
    );
    return idx === -1 ? null : idx + 1;
  };

  // "Recent Entries" now shows every one of the User's own submitted MPR rows directly
  // as a flat "Job Entry Details" table (no more grouped Job list you had to click into
  // to open a popup) — newest first.
  const sortedEntries: Entry[] = React.useMemo(
    () => [...entries].sort((a, b) => b.id - a.id),
    [entries]
  );

  // A locked entry (its Budget already Final Submitted) still gets an Edit button —
  // Delivery-Date-only — when the current user has the can_job_edit permission,
  // mirroring the direct Delivery Date edit the separate Job Edit panel already
  // offers (see JobEditPanel.tsx's own saveEdit, which PUTs just the date). This
  // restores the older policy where Job Edit permission also unlocked that same
  // change right here from Job Entry Details, not only from the Job Edit panel.
  const isDateOnlyEditableEntry = (entry: Entry): boolean =>
    entry.created_by === user.id && !!entry.budget_locked && !!user.can_job_edit;
  // Whether the Edit button should show at all for this entry — fully unlocked
  // (own entry, Budget not yet Final Submitted) OR the Delivery-Date-only case above.
  const isEntryEditable = (entry: Entry): boolean =>
    (entry.created_by === user.id && !entry.budget_locked) || isDateOnlyEditableEntry(entry);

  // Every distinct Item Name already present across this user's own "Job Entry
  // Details" rows — offered as a type-or-select dropdown on the Item Name filter
  // (both the desktop table header input and the mobile filter panel input) below,
  // so typing narrows to a matching dropdown the same way MPR No pickers elsewhere
  // in the app already do, instead of a plain free-text box.
  const itemNameFilterOptions = React.useMemo(
    () => [...new Set(entries.map((e) => String(e.item_name || '').trim()).filter(Boolean))].sort(),
    [entries]
  );

  // Item Name filter options narrowed to whatever's currently typed — case-insensitive
  // substring match, same convention as filteredScopedProjects/filteredMprFor above.
  // Blank input shows every known Item Name (so tapping into an empty filter still
  // offers the full list to pick from, not nothing).
  const filteredItemNameFilterOptions = React.useMemo(() => {
    const q = entryColumnFilters.item_name.trim().toLowerCase();
    if (!q) return itemNameFilterOptions;
    return itemNameFilterOptions.filter((name) => name.toLowerCase().includes(q));
  }, [itemNameFilterOptions, entryColumnFilters.item_name]);

  // Each column filter narrows "Job Entry Details" independently (AND across columns) —
  // case-insensitive substring match, blank filter = no restriction on that column.
  const filteredEntries: Entry[] = React.useMemo(() => {
    const f = {
      job_no: entryColumnFilters.job_no.trim().toLowerCase(),
      job_name: entryColumnFilters.job_name.trim().toLowerCase(),
      mpr_no: entryColumnFilters.mpr_no.trim().toLowerCase(),
      item_name: entryColumnFilters.item_name.trim().toLowerCase(),
      specification: entryColumnFilters.specification.trim().toLowerCase(),
      req_qty: entryColumnFilters.req_qty.trim().toLowerCase(),
      job_duration: entryColumnFilters.job_duration.trim().toLowerCase(),
      delivery_date_from: entryColumnFilters.delivery_date_from.trim(),
      delivery_date_to: entryColumnFilters.delivery_date_to.trim(),
      budget_name: entryColumnFilters.budget_name.trim().toLowerCase()
    };
    const anyFilterActive = Object.values(f).some((v) => v);
    if (!anyFilterActive) return sortedEntries;
    return sortedEntries.filter((ent) =>
      (!f.job_no || ent.job_no.toLowerCase().includes(f.job_no)) &&
      (!f.job_name || ent.job_name.toLowerCase().includes(f.job_name)) &&
      (!f.mpr_no || (ent.mpr_no || '').toLowerCase().includes(f.mpr_no)) &&
      (!f.item_name || (ent.item_name || '').toLowerCase().includes(f.item_name)) &&
      (!f.specification || (ent.specification || '').toLowerCase().includes(f.specification)) &&
      (!f.req_qty || (ent.req_qty || '').toLowerCase().includes(f.req_qty)) &&
      (!f.job_duration || (ent.job_duration || '').toLowerCase().includes(f.job_duration)) &&
      // Delivery Date strings are already "YYYY-MM-DD", so plain string comparison
      // sorts correctly as a date range — no Date object / timezone conversion needed.
      (!f.delivery_date_from || !ent.delivery_date || ent.delivery_date >= f.delivery_date_from) &&
      (!f.delivery_date_to || !ent.delivery_date || ent.delivery_date <= f.delivery_date_to) &&
      (!f.budget_name || (ent.budget_name || '').toLowerCase().includes(f.budget_name))
    );
  }, [sortedEntries, entryColumnFilters]);

  // Sum of Qty across whatever "Job Entry Details" currently shows — every entry
  // when no column filter is active, or just the narrowed-down set once one is,
  // since filteredEntries already reflects that. Shown as a subtotal bar right
  // above the table header. Non-numeric/blank Qty values (parseQtyNumber -> null)
  // are skipped rather than treated as 0, so a stray "N/A" can't silently ADD
  // 0 while still hiding that it was skipped — reported separately below.
  const qtySubtotal = React.useMemo(() => {
    let sum = 0;
    let countedRows = 0;
    for (const ent of filteredEntries) {
      const n = parseQtyNumber(ent.req_qty);
      if (n !== null) {
        sum += n;
        countedRows++;
      }
    }
    return { sum, countedRows, totalRows: filteredEntries.length };
  }, [filteredEntries]);

  // Every distinct Job this user has ever submitted, as a Job No + Job Name pair —
  // most recent first (unaffected by the column filters below, a running list, not a
  // filtered one). One row per Job No, keeping whichever entry's Job Name is newest
  // if it was ever edited.
  const uniqueJobsList = React.useMemo(() => {
    const seen = new Map<
      string,
      {
        job_no: string;
        job_name: string;
        job_id: number;
        project_id: number;
        job_duration: string;
        budget_id: number | null;
        budget_name: string | null;
      }
    >();
    for (const e of sortedEntries) {
      if (!seen.has(e.job_no)) {
        seen.set(e.job_no, {
          job_no: e.job_no,
          job_name: e.job_name,
          job_id: e.job_id,
          project_id: e.project_id,
          job_duration: e.job_duration,
          budget_id: e.budget_id ?? null,
          budget_name: e.budget_name ?? null
        });
      }
    }
    return Array.from(seen.values());
  }, [sortedEntries]);
  const totalJobsCount = uniqueJobsList.length;

  // Same Jobs as above, grouped under the Budget each one was submitted against —
  // groups appear in the order their first (most recent) Job was encountered, and
  // Jobs stay most-recent-first within each group, matching the flat list's own
  // ordering. A Job somehow left without a Budget (older data) falls into its own
  // "No Budget" group instead of being dropped.
  const jobsByBudget = React.useMemo(() => {
    const groups = new Map<
      string,
      { budget_id: number | null; budget_name: string | null; jobs: typeof uniqueJobsList }
    >();
    for (const j of uniqueJobsList) {
      const key = j.budget_id !== null ? `id:${j.budget_id}` : `none:${j.budget_name || ''}`;
      if (!groups.has(key)) {
        groups.set(key, { budget_id: j.budget_id, budget_name: j.budget_name, jobs: [] });
      }
      groups.get(key)!.jobs.push(j);
    }
    return Array.from(groups.values());
  }, [uniqueJobsList]);

  // The MPR entries THIS Job already has, shown read-only above the "MPR No
  // Entries" rows while adding another MPR to it (editingJob) — so it's clear
  // what's already in the Job instead of it looking empty. Most recent first.
  const editingJobExistingEntries = React.useMemo(() => {
    if (!editingJob) return [];
    return entries
      .filter((e) => e.job_id === editingJob.jobId && !e.deleted_at)
      .sort((a, b) => b.id - a.id);
  }, [entries, editingJob]);

  // "Export PDF" for Job Entry Details — a letterhead-style PDF (Credence logo +
  // company block, report title, a "Filtered By" box for any active column
  // filters, the data table, and a "Printed on / Page X of Y" footer on every
  // page), A4 portrait. Exports whatever is currently showing (respects the
  // active column filters, same rows as filteredEntries).
  //
  // On web: opens a preview modal first (iframe) — the user looks it over,
  // then taps Download if they want it. On the Android APK there's no
  // reliable way to preview a PDF inline inside the WebView, so it skips
  // straight to the native Share sheet instead (which itself offers "Open
  // with [PDF viewer]" as well as "Save to..." — effectively the native
  // equivalent of preview-then-download).
  const handleExportPdf = async () => {
    const logoImg = await loadImageElement(credenceLogo);
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const activeFilters: [string, string][] = [];
    if (entryColumnFilters.job_no) activeFilters.push(['Job No', entryColumnFilters.job_no]);
    if (entryColumnFilters.job_name) activeFilters.push(['Job Name', entryColumnFilters.job_name]);
    if (entryColumnFilters.mpr_no) activeFilters.push(['MPR No', entryColumnFilters.mpr_no]);
    if (entryColumnFilters.item_name) activeFilters.push(['Item Name', entryColumnFilters.item_name]);
    if (entryColumnFilters.specification) activeFilters.push(['Specification', entryColumnFilters.specification]);
    if (entryColumnFilters.req_qty) activeFilters.push(['Qty', entryColumnFilters.req_qty]);
    if (entryColumnFilters.job_duration) activeFilters.push(['Job Duration', entryColumnFilters.job_duration]);
    if (entryColumnFilters.delivery_date_from) activeFilters.push(['Delivery From', formatDate(entryColumnFilters.delivery_date_from)]);
    if (entryColumnFilters.delivery_date_to) activeFilters.push(['Delivery To', formatDate(entryColumnFilters.delivery_date_to)]);
    if (entryColumnFilters.budget_name) activeFilters.push(['Budget', entryColumnFilters.budget_name]);

    const letterheadOptions = { reportTitle: 'Job Entry Details Report', filters: activeFilters };
    const contentStartY = drawPdfLetterhead(doc, logoImg, letterheadOptions);

    autoTable(doc, {
      startY: contentStartY,
      margin: { top: contentStartY, left: 8, right: 8 },
      head: [['SL', 'Job No', 'Job Name', 'MPR No', 'Item Name', 'Specification', 'Qty', 'Job Duration', 'Delivery Date', 'Budget']],
      body: filteredEntries.map((it, idx) => [
        String(idx + 1),
        it.job_no || '',
        it.job_name || '',
        it.mpr_no || '',
        it.item_name || '',
        it.specification || '',
        it.req_qty || '',
        it.job_duration || '',
        formatDate(it.delivery_date) || '',
        it.budget_name || ''
      ]),
      // A4 portrait is much narrower than the old landscape layout (~194mm of
      // usable width here vs ~270mm before), so every column gets an explicit,
      // tight width — long text wraps onto a second line within its cell
      // (autoTable's default) rather than overflowing or getting truncated.
      styles: { fontSize: 6.5, cellPadding: 1.3, overflow: 'linebreak' },
      columnStyles: {
        0: { cellWidth: 7 }, // SL
        1: { cellWidth: 15 }, // Job No
        2: { cellWidth: 26 }, // Job Name
        3: { cellWidth: 17 }, // MPR No
        4: { cellWidth: 28 }, // Item Name
        5: { cellWidth: 24 }, // Specification
        6: { cellWidth: 9 }, // Qty
        7: { cellWidth: 16 }, // Job Duration
        8: { cellWidth: 16 }, // Delivery Date
        9: { cellWidth: 18 } // Budget
      },
      headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 6.5 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      // Repeats the full letterhead (logo, title, filters box) on every page of
      // a multi-page table, not just the first.
      didDrawPage: () => drawPdfLetterhead(doc, logoImg, letterheadOptions)
    });

    const finalY = (doc as any).lastAutoTable.finalY;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(`Total Number of Entries: ${filteredEntries.length}`, 8, finalY + 8);

    finalizePdfPageNumbers(doc);

    const filename = `Job_Entry_Details_${todayDateOnlyString()}.pdf`;
    // Always preview first — on every platform, including the Android APK —
    // rather than jumping straight to a save/share action. Nothing is written
    // to disk or shared until the user explicitly taps Download inside the
    // preview (see PdfPreviewModal.tsx for how the preview itself renders
    // without needing any of that).
    const bytes = new Uint8Array(doc.output('arraybuffer'));
    setPdfPreview({ doc, bytes, filename });
  };

  const handleSubmitEntry = async (e: React.FormEvent) => {
    e.preventDefault();
    setMessage(null);

    if (!selectedBudget) {
      setMessage({ type: 'error', text: 'Please select a Budget first.' });
      return;
    }

    if (!projectId || !jobName.trim() || !jobDuration.trim()) {
      setMessage({ type: 'error', text: 'Project, Job Name and Job Duration are required.' });
      return;
    }

    const incompleteRow = mprRows.find(
      (r) => !r.mprId || r.itemNames.length === 0 || r.itemNames.some((opt) => !getItemDeliveryDate(r, opt))
    );
    if (incompleteRow) {
      setMessage({ type: 'error', text: 'Every MPR No row needs an MPR No (with at least one Item Name) and a Delivery Date for every Item.' });
      return;
    }

    // Every item's Requisitioned Qty must be filled in, a positive number, and never
    // above what's still available to this user for that item (remainingQty) — the
    // server re-checks this too, but catching it here avoids a round trip.
    for (const r of mprRows) {
      for (const opt of r.itemNames) {
        const q = Number(opt.qty);
        if (!opt.qty || !Number.isFinite(q) || q <= 0) {
          setMessage({ type: 'error', text: `Enter a valid Requisitioned Qty for "${opt.name}".` });
          return;
        }
        if (opt.remainingQty !== null && q > opt.remainingQty) {
          setMessage({
            type: 'error',
            text: `Requisitioned Qty for "${opt.name}" can't exceed the remaining available Qty (${opt.remainingQty}).`
          });
          return;
        }
      }
    }

    // If the Admin has set an allowed Delivery Date window for this Budget, every
    // Item's EFFECTIVE Delivery Date (its own override, or the row's shared date) must
    // fall inside it — checked per Item now, since a multi-Item row's Items can each
    // carry their own override date.
    const deliveryFrom = selectedBudget.delivery_date_from || '';
    const deliveryTo = selectedBudget.delivery_date_to || '';
    if (deliveryFrom || deliveryTo) {
      const outOfRangeItem = mprRows
        .flatMap((r) => r.itemNames.map((opt) => ({ r, opt })))
        .find(
          ({ r, opt }) =>
            (deliveryFrom && getItemDeliveryDate(r, opt) < deliveryFrom) ||
            (deliveryTo && getItemDeliveryDate(r, opt) > deliveryTo)
        );
      if (outOfRangeItem) {
        setMessage({
          type: 'error',
          text: `Delivery Date must be between ${deliveryFrom || '—'} and ${deliveryTo || '—'} for this Budget.`
        });
        return;
      }
    }

    // The SAME Item (same budget_item_id) can appear multiple times under the SAME
    // MPR No — that's the "Split remaining Qty to a new row" feature, used as many
    // times as needed to spread one Item's Qty across several Delivery Dates. This
    // is safe with no cap on the row count: every row's own Qty ceiling is locked
    // down to what's actually entered there (see splitLeftoverInSameRow), and the
    // per-Item remainingQty check above already guarantees the rows' Qtys can never
    // add up to more than what was actually available. So there's nothing left to
    // gate here beyond that combined-Qty check.

    // Each MPR row can expand into several entries — one per Excel row imported
    // under that MPR No (even ones sharing the same Description text) — all
    // sharing the same MPR No, each using its own effective Delivery Date (its
    // per-item override if one was set, otherwise the row's shared date).
    const itemsPayload = mprRows.flatMap((r) =>
      r.itemNames.map((opt) => ({
        mpr_id: Number(r.mprId),
        budget_item_id: opt.budgetItemId,
        item_name: opt.name.trim(),
        requisitioned_qty: Number(opt.qty),
        delivery_date: getItemDeliveryDate(r, opt)
      }))
    );

    setLoading(true);
    try {
      // editingJob set = adding this MPR into an EXISTING Job (tapped from the Jobs
      // list) instead of the normal flow, which always creates a brand-new Job.
      const res = editingJob
        ? await fetch(apiUrl(`/api/entries/job/${editingJob.jobId}/items`), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({ items: itemsPayload })
          })
        : await fetch(apiUrl('/api/entries'), {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              Authorization: `Bearer ${token}`
            },
            body: JSON.stringify({
              budget_id: selectedBudget.id,
              project_id: Number(projectId),
              job_name: jobName.trim(),
              job_duration: jobDuration.trim(),
              items: itemsPayload
            })
          });

      const data = await res.json();
      if (!res.ok) {
        if (data.warning) {
          setMessage({ type: 'warning', text: data.error || 'Duplicate entry warning!' });
        } else {
          throw new Error(data.error || (editingJob ? 'Failed to add MPR to Job' : 'Failed to create entry'));
        }
        return;
      }

      setSavedJobPopup({ jobNo: editingJob ? editingJob.jobNo : data.job_no || '', count: data.count || mprRows.length });
      // Reset the MPR rows either way. When adding to an existing Job, stay in that
      // mode (Project/Job Name/Duration stay locked in) so more MPRs can be added to
      // the SAME Job right away without re-tapping it from the Jobs list; otherwise
      // reset the rest of the form fields too, ready for a brand-new Job.
      setMprRows([makeEmptyRow()]);
      if (!editingJob) {
        setJobName('');
        setJobDuration('');
        setJobDetailsConfirmed(false);
      }
      fetchEntries();
      fetchMprUsage();
      refreshBudgetItems(selectedBudget.id);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setLoading(false);
    }
  };

  // Marks a Budget as finished for THIS user. After this, the server rejects any
  // new entries from this user under this Budget — irreversible from the User side,
  // so confirm before firing. Now triggered per-Job from the Jobs list (any Job's
  // row can submit the Budget it belongs to), so it takes the target Budget
  // explicitly instead of always assuming the currently selected one.
  const handleSubmitBudget = async (target: { id: number; budget_name: string; submitted?: boolean }) => {
    if (!target || target.submitted) return;

    const confirmed = window.confirm(
      `Submit "${target.budget_name}"? Once submitted, you won't be able to add any more entries to this Budget.`
    );
    if (!confirmed) return;

    setSubmittingBudgetId(target.id);
    setMessage(null);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${target.id}/submit`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to submit budget');

      // Submitting a Budget changes what a bunch of other pages/screens would show
      // (that Budget's entries lock, its Jobs move out of the "still open" list,
      // etc.) — instead of trying to patch every one of those places by hand, just
      // reload the whole app so everything comes back fresh from the server, same
      // as a manual page refresh. Message flashes briefly first so the confirmation
      // is actually seen before the reload wipes it. submittingBudgetId is left set
      // (not cleared in this path) so the button stays disabled through the wait
      // instead of becoming clickable again right before the reload happens.
      setMessage({ type: 'success', text: `Budget "${target.budget_name}" submitted. Reloading...` });
      setTimeout(() => window.location.reload(), 900);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
      setSubmittingBudgetId(null);
    }
  };

  // (Re)loads Item options for a given Budget + MPR No — used on first opening the
  // edit row, and again whenever the MPR No is changed mid-edit. Every imported Excel
  // row is offered individually (not deduped by Description text), so a row whose
  // Description matches another row is still its own selectable option.
  const loadEditItemOptions = async (budgetId: number | null | undefined, mprNo: string): Promise<MprItemOption[]> => {
    setEditItemOptions([]);
    if (!budgetId) return [];
    setEditLoadingOptions(true);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${budgetId}/items`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const items: BudgetItem[] = await res.json();
        setEditBudgetItems(items);
        const out: MprItemOption[] = [];
        for (const bi of items) {
          if ((bi.mrf_no || '').trim().toLowerCase() !== mprNo.trim().toLowerCase()) continue;
          const desc = (bi.description || '').trim();
          if (!desc) continue;
          const reqQty = parseQtyNumber(bi.req_qty);
          const consumed = Number(bi.requisitioned_by_me || 0);
          const remainingQty = reqQty === null ? null : Math.max(0, reqQty - consumed);
          out.push({ uid: makeItemUid(), budgetItemId: bi.id, name: desc, reqQty, remainingQty, qty: '', deliveryDate: '' });
        }
        setEditItemOptions(out);
        return out;
      }
    } catch (err) {
      console.error('Failed to load item options for edit', err);
    } finally {
      setEditLoadingOptions(false);
    }
    return [];
  };

  // Start editing one MPR row from the Job Entry Details popup. Loads that entry's own
  // Budget items (not necessarily the currently-opened Budget) so the Item Name / MPR
  // No options shown are correct even if the User navigated away from that Budget already.
  const startEditEntry = async (entry: Entry) => {
    setEditingEntryId(entry.id);
    setEditItemName(entry.item_name);
    setEditItemBudgetItemId(entry.budget_item_id ?? null);
    const currentQty = entry.requisitioned_qty === null || entry.requisitioned_qty === undefined ? null : Number(entry.requisitioned_qty);
    setEditQty(currentQty !== null ? String(currentQty) : '');
    setEditOriginalBudgetItemId(entry.budget_item_id ?? null);
    setEditOriginalQty(currentQty);
    setEditDeliveryDate(entry.delivery_date);
    setEditJobName(entry.job_name);
    setEditJobDuration(entry.job_duration);
    setEditMprId(String(entry.mpr_id));
    setEditMprSearchText(entry.mpr_no);
    setEditShowMprDropdown(false);
    setEditError('');
    setEditItemOptions([]);
    setEditBudgetItems([]);
    const owningBudget = entry.budget_id ? budgets.find((b) => b.id === entry.budget_id) : null;
    // Floor is whichever is LATER of today and the Budget's delivery_date_from —
    // a date before today can never actually be saved (the server always rejects
    // it), so it's excluded here rather than shown as a pickable option that would
    // just bounce back with a validation error. Same rule JobEditPanel.tsx's own
    // delivery-date edit already applies.
    setEditDeliveryRange({
      from: latestDateStr(todayDateOnlyString(), owningBudget?.delivery_date_from, entry.entry_date) || null,
      to: owningBudget?.delivery_date_to || null
    });
    // Delivery-Date-only edit (see isDateOnlyEditableEntry) never touches Item
    // Name/MPR No/Qty/Job Name/Job Duration, so there's nothing to pick an Item
    // option for — skip the Budget Items fetch entirely for that case.
    if (isDateOnlyEditableEntry(entry)) return;
    await loadEditItemOptions(entry.budget_id, entry.mpr_no);
  };

  const cancelEditEntry = () => {
    setEditingEntryId(null);
    setEditItemName('');
    setEditItemBudgetItemId(null);
    setEditQty('');
    setEditOriginalBudgetItemId(null);
    setEditOriginalQty(null);
    setEditDeliveryDate('');
    setEditItemOptions([]);
    setEditError('');
    setDeleteError('');
    setEditDeliveryRange({ from: null, to: null });
    setEditJobName('');
    setEditJobDuration('');
    setEditMprId('');
    setEditMprSearchText('');
    setEditShowMprDropdown(false);
    setEditBudgetItems([]);
  };

  // MPR Nos pickable for the row currently being edited — scoped to that entry's own
  // Project within its own Budget (same rule as the create form), excluding any MPR No
  // already used by a DIFFERENT entry. Only offered when the entry came from a Budget;
  // older entries without one keep MPR No as read-only text (nothing to scope against).
  const filteredEditMprOptions = () => {
    const currentEntry = entries.find((it) => it.id === editingEntryId);
    if (!currentEntry || !currentEntry.budget_id) return [];
    const projectNameLower = currentEntry.project_name.trim().toLowerCase();
    const allowedInBudget = new Set(
      editBudgetItems
        .filter((bi) => bi.mrf_no && (bi.project_name || '').trim().toLowerCase() === projectNameLower)
        .map((bi) => bi.mrf_no!.trim().toLowerCase())
    );
  // Excludes any MPR No used in ANY other entry — this user's own (any Job) or a
  // different user's, matching the create form's rule. This same entry's own current
  // MPR No is always left pickable (re-selecting it must stay allowed).
  const usedElsewhereEntries = new Set(
      mprUsage
        .filter((u) => String(u.mpr_id) !== String(currentEntry.mpr_id))
        .map((u) => String(u.mpr_id))
    );
    return mprNumbers.filter(
      (m) =>
        allowedInBudget.has(m.mpr_no.trim().toLowerCase()) &&
        m.mpr_no.toLowerCase().includes(editMprSearchText.toLowerCase()) &&
        !usedElsewhereEntries.has(String(m.id))
    );
  };

  const selectEditMpr = async (m: MprNumber) => {
    const currentEntry = entries.find((it) => it.id === editingEntryId);
    setEditMprId(String(m.id));
    setEditMprSearchText(m.mpr_no);
    setEditShowMprDropdown(false);
    // A different MPR No can carry a completely different set of Item options —
    // reload them and clear the current pick so the User re-selects explicitly.
    setEditItemName('');
    setEditItemBudgetItemId(null);
    const opts = await loadEditItemOptions(currentEntry?.budget_id, m.mpr_no);
    // If there's only one possible Item under the newly-picked MPR No, auto-select it
    // (matches how the create form auto-fills a single option) instead of leaving the
    // "only option" display blank until the user does something.
    if (opts.length === 1) handleEditItemChange(opts[0]);
  };

  // Picking an Item option from the dropdown sets BOTH the display text and the
  // specific source Excel row (budgetItemId) together, so two options that happen to
  // share the same Description text still each resolve to their own row.
  const handleEditItemChange = (opt: MprItemOption) => {
    setEditItemName(opt.name);
    setEditItemBudgetItemId(opt.budgetItemId);
    setEditQty(String(editMaxQtyFor(opt) ?? ''));
  };

  // The Requisitioned Qty ceiling to show/enforce in the edit form for a given item
  // option — the server-reported remainingQty already counts the entry being edited's
  // OWN current Qty as "consumed" (since it's still an active entry), so that gets
  // added back on ONLY when the option is the same item this entry already had.
  const editMaxQtyFor = (opt: MprItemOption): number | null => {
    if (opt.remainingQty === null) return null;
    if (opt.budgetItemId === editOriginalBudgetItemId && editOriginalQty !== null) {
      return opt.remainingQty + editOriginalQty;
    }
    return opt.remainingQty;
  };

  const saveEditEntry = async (entryId: number) => {
    const currentEntry = entries.find((e) => e.id === entryId);
    // Delivery-Date-only path (see isDateOnlyEditableEntry) — this entry's Budget is
    // already Final Submitted, so only Delivery Date is validated/sent here; Item
    // Name/MPR No/Budget Item stay exactly what they already were (same minimal
    // payload shape the Job Edit panel's own direct date edit already sends).
    if (currentEntry && isDateOnlyEditableEntry(currentEntry)) {
      if (!editDeliveryDate) {
        setEditError('Delivery Date is required.');
        return;
      }
      if (
        (editDeliveryRange.from && editDeliveryDate < editDeliveryRange.from) ||
        (editDeliveryRange.to && editDeliveryDate > editDeliveryRange.to)
      ) {
        setEditError(
          `Delivery Date must be between ${editDeliveryRange.from || '—'} and ${editDeliveryRange.to || '—'} for this Budget.`
        );
        return;
      }
      setEditSaving(true);
      setEditError('');
      try {
        const res = await fetch(apiUrl(`/api/entries/${entryId}`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({
            item_name: currentEntry.item_name,
            delivery_date: editDeliveryDate,
            mpr_id: currentEntry.mpr_id,
            budget_item_id: currentEntry.budget_item_id
          })
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to update entry');
        setEntries((prev) => prev.map((e) => (e.id === entryId ? { ...e, delivery_date: editDeliveryDate } : e)));
        cancelEditEntry();
        fetchEntries();
      } catch (err: any) {
        setEditError(err.message);
      } finally {
        setEditSaving(false);
      }
      return;
    }

    if (!editItemName.trim() || !editDeliveryDate || !editJobName.trim() || !editJobDuration.trim() || !editMprId) {
      setEditError('Job Name, Job Duration, MPR No, Item Name and Delivery Date are all required.');
      return;
    }
    const editQtyNum = Number(editQty);
    if (!editQty || !Number.isFinite(editQtyNum) || editQtyNum <= 0) {
      setEditError('Enter a valid Requisitioned Qty.');
      return;
    }
    const currentOpt = editItemOptions.find((o) => o.budgetItemId === editItemBudgetItemId);
    if (currentOpt) {
      const max = editMaxQtyFor(currentOpt);
      if (max !== null && editQtyNum > max) {
        setEditError(`Requisitioned Qty can't exceed the remaining available Qty (${max}).`);
        return;
      }
    }
    if (
      (editDeliveryRange.from && editDeliveryDate < editDeliveryRange.from) ||
      (editDeliveryRange.to && editDeliveryDate > editDeliveryRange.to)
    ) {
      setEditError(
        `Delivery Date must be between ${editDeliveryRange.from || '—'} and ${editDeliveryRange.to || '—'} for this Budget.`
      );
      return;
    }
    setEditSaving(true);
    setEditError('');
    try {
      const res = await fetch(apiUrl(`/api/entries/${entryId}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          item_name: editItemName.trim(),
          budget_item_id: editItemBudgetItemId,
          requisitioned_qty: editQtyNum,
          delivery_date: editDeliveryDate,
          job_name: editJobName.trim(),
          job_duration: editJobDuration.trim(),
          mpr_id: Number(editMprId)
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update entry');

      // Reflect the change immediately in the Recent Entries table, then re-sync with
      // the server in the background. Item Name / Delivery Date / MPR No only change
      // this row; Job Name / Job Duration are shared, so every row under the same Job
      // picks up the change too.
      const newJobName = editJobName.trim();
      const newJobDuration = editJobDuration.trim();
      const newMprId = Number(editMprId);
      const newMprNo = editMprSearchText;
      const jobNo = entries.find((e) => e.id === entryId)?.job_no;

      setEntries((prev) =>
        prev.map((e) => {
          if (e.id === entryId) {
            return {
              ...e,
              item_name: editItemName.trim(),
              budget_item_id: editItemBudgetItemId,
              requisitioned_qty: editQtyNum,
              delivery_date: editDeliveryDate,
              mpr_id: newMprId,
              mpr_no: newMprNo,
              job_name: newJobName,
              job_duration: newJobDuration
            };
          }
          if (jobNo && e.job_no === jobNo) {
            return { ...e, job_name: newJobName, job_duration: newJobDuration };
          }
          return e;
        })
      );
      cancelEditEntry();
      fetchEntries();
      fetchMprUsage();
      if (selectedBudget) refreshBudgetItems(selectedBudget.id);
    } catch (err: any) {
      setEditError(err.message);
    } finally {
      setEditSaving(false);
    }
  };

  // Deleting your own Job Entry moves it into the Admin's Job Recycle bin (a soft
  // delete) — it isn't gone forever, but it disappears from your own list right away
  // and its MPR No becomes usable again.
  const handleDeleteEntry = async (entryId: number) => {
    if (!confirm('Delete this Job Entry? An Admin will be able to restore it from the Job Recycle bin if needed.')) return;
    setDeletingEntryId(entryId);
    setDeleteError('');
    try {
      const res = await fetch(apiUrl(`/api/entries/${entryId}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to delete entry');

      // Drop it from the Recent Entries table right away, then re-sync with the server
      // in the background.
      setEntries((prev) => prev.filter((e) => e.id !== entryId));
      if (editingEntryId === entryId) cancelEditEntry();
      fetchEntries();
      fetchMprUsage();
      if (selectedBudget) refreshBudgetItems(selectedBudget.id);
    } catch (err: any) {
      setDeleteError(err.message);
    } finally {
      setDeletingEntryId(null);
    }
  };

  // Whatever's left over once editQty has been typed in below the entry's original
  // saved Qty (and the Item hasn't been switched to a different one) — this is what
  // "Split remaining Qty into a new item" (in EntryRow/EntryCard) carves off into a
  // brand-new entry, mirroring splitLeftoverInSameRow's math above.
  const editSplitRemaining = (() => {
    if (editOriginalQty === null || editOriginalBudgetItemId === null) return null;
    if (editItemBudgetItemId !== editOriginalBudgetItemId) return null;
    const q = Number(editQty);
    if (!Number.isFinite(q) || q <= 0 || q >= editOriginalQty) return null;
    return editOriginalQty - q;
  })();

  // Splits the entry currently being edited: whatever's typed into Requisitioned Qty
  // stays on THIS entry, and the leftover from its original Qty becomes a brand-new
  // entry — same Job, MPR No and Item, defaulting to the same Delivery Date (editable
  // afterward just like any other entry, since it's now a normal saved row itself).
  const splitRemainingDuringEdit = async () => {
    if (editingEntryId === null || editSplitRemaining === null) return;
    setSplitSaving(true);
    setSplitError('');
    try {
      const res = await fetch(apiUrl(`/api/entries/${editingEntryId}/split`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ split_qty: editSplitRemaining, split_delivery_date: editDeliveryDate })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to split entry');

      // Fetch the fresh list synchronously (rather than the fire-and-forget
      // fetchEntries()) so the newly split-off entry is actually in hand to jump
      // straight into editing it below.
      const entriesRes = await fetch(apiUrl('/api/entries'), { headers: { Authorization: `Bearer ${token}` } });
      const freshEntries: Entry[] | null = entriesRes.ok ? await entriesRes.json() : null;
      if (freshEntries) setEntries(freshEntries);
      fetchMprUsage();
      if (selectedBudget) refreshBudgetItems(selectedBudget.id);

      // Drop straight into editing the split-off entry — its Qty box opens right
      // away, already filled with the leftover amount, exactly like every item's Qty
      // box is already open while first creating a Job — so if the user wants to
      // split it again, they can just type a smaller number and hit Split again,
      // with no extra tap on Edit in between.
      const newEntry = freshEntries?.find((e) => e.id === data.new_entry_id);
      if (newEntry) {
        await startEditEntry(newEntry);
      } else {
        cancelEditEntry();
      }
    } catch (err: any) {
      setSplitError(err.message);
    } finally {
      setSplitSaving(false);
    }
  };

  // Stable-identity wrappers (see useStableCallback above) — passed to EntryRow so
  // React.memo can actually skip re-rendering rows unaffected by the current keystroke.
  const stableStartEditEntry = useStableCallback(startEditEntry);
  const stableCancelEditEntry = useStableCallback(cancelEditEntry);
  const stableSaveEditEntry = useStableCallback(saveEditEntry);
  const stableHandleDeleteEntry = useStableCallback(handleDeleteEntry);
  const stableSelectEditMpr = useStableCallback(selectEditMpr);
  const stableSplitRemainingDuringEdit = useStableCallback(splitRemainingDuringEdit);
  // Computed once per render (only actually consulted by the single row being
  // edited, if any) instead of being re-derived twice per render as before.
  const editMprOptions = filteredEditMprOptions();

  // Attendance-only Project restriction: when an Admin/Superadmin has pinned
  // this account to one Project (Admin Panel -> Users -> "Attend. Project"),
  // the Attendance card below only ever offers that single Project — not the
  // full `projects` list Budget/Jobs/MPR uses everywhere else on this page,
  // which stays completely untouched by this. Falls back to the full list
  // when nothing's pinned (today's behavior).
  const attendanceProjects = user.attendance_project_id
    ? projects.filter((p) => p.id === user.attendance_project_id)
    : projects;

  return (
    <div className="relative w-full min-h-[calc(100vh-4rem)] min-h-[calc(100dvh-4rem)] text-slate-900 overflow-hidden" style={{ background: 'var(--g-bg-gradient)' }}>
      {/* Violet gradient welcome banner — now sits flush directly under the
          header (no gap/margin above it, unlike before) so it reads as part
          of the header instead of a separate card further down the page.
          Avatar/bell removed; the old shortcut-icon notch (Budget/Jobs/
          Claim/Entries/History) is replaced by the Remote Attendance card
          overlapping the bottom edge, same can_use_attendance gating as
          before. Shown only on the Dashboard (mobileActiveSection === null). */}
      <div className={`${mobileActiveSection === null ? 'block' : 'hidden'} md:hidden relative`}>
        <div className="relative rounded-b-[28px] shadow-sm" style={{ background: 'var(--g-gradient)' }}>
          <div className="px-6 pt-6 pb-10 sm:px-8 sm:pb-10 text-center">
            <p className="text-xs font-medium tracking-wide text-white/70">Welcome back</p>
            <p className="mt-1 text-2xl sm:text-3xl font-extrabold text-white truncate">{user.name}!</p>
          </div>
        </div>

        {!!user.can_use_attendance && (
          <div className="relative z-10 px-2 -mt-6 pb-7">
            <AttendanceCard token={token} projects={attendanceProjects} loading={!projectsLoaded} />
          </div>
        )}

        {/* Leave Summary — Admin/Superadmin-granted per account (Admin Panel ->
            Users -> can_view_leave_summary), OFF by default, same toggle
            pattern as Remote Attendance's can_use_attendance. Sits right
            after Remote Attendance so both quick-action cards stay together
            at the top of the Dashboard when both are on. Same px-2 side
            padding as the main content container below (tiles/calendar) —
            was px-4, which sat these cards noticeably further in from the
            edges than everything below it. */}
        {!!user.can_view_leave_summary && (
          <div className={`relative z-10 px-2 pb-3 ${user.can_use_attendance ? '-mt-1' : '-mt-6'}`}>
            <LeaveSummaryCard token={token} onOpen={() => goToMobileSection('leave')} />
          </div>
        )}

        {/* Pending Approvals (Part 4 — Role Permissiveness) — every account,
            not just Admins, can be named an approver on a Template step now
            (see Admin Panel -> Approvals -> Templates). Renders nothing at
            all when nothing's waiting on this account, so it stays invisible
            for the vast majority of accounts that are never an approver. */}
        <div className="relative z-10 px-2">
          <PendingApprovalsCard token={token} />
        </div>
      </div>

      <div className={`relative z-10 w-full px-2 sm:px-6 lg:px-8 ${mobileActiveSection === null ? 'pt-3' : 'pt-0 md:pt-8'} pb-[calc(9rem+env(safe-area-inset-bottom,0px))] md:pb-8 space-y-8 max-md:space-y-3`}>
      {/* Desktop-only plain welcome banner (no avatar/bell/drop-notch — those
          are the mobile-specific drop-banner design above). Same gating the
          single banner used before this change. */}
      <div className={`hidden ${showingClaimsPage || showingMainGroupPage ? 'md:hidden' : 'md:block'}`}>
        <div
          className="rounded-2xl px-6 py-5 sm:px-8 sm:py-6 text-white shadow-sm"
          style={{ background: 'var(--g-gradient)' }}
        >
          <h3 className="text-xl sm:text-2xl font-bold">Welcome back, {user.name.split(' ')[0]}!</h3>
          <p className="mt-1 text-sm text-white/85">Check in your attendance, submit a New MPR Entry, and keep an eye on Notices — all from here.</p>
        </div>
      </div>

      {/* Check In / Check Out (desktop) — mobile now shows this directly
          under the banner above, in place of the old shortcut-icon notch.
          Hides on desktop too while a Claims page (below) is the active
          section, same as the Budget/Jobs/Entries grid and Job Edit further
          down. Also requires can_use_attendance (Admin Panel -> Users ->
          Remote Attendance), OFF by default — an Admin or Superadmin must
          grant it per account before it shows at all. */}
      {!!user.can_use_attendance && (
        <div className={`hidden ${showingClaimsPage || showingMainGroupPage ? 'md:hidden' : 'md:block'}`}>
          <AttendanceCard token={token} projects={attendanceProjects} loading={!projectsLoaded} />
        </div>
      )}

      {/* Leave Summary (desktop) — same card and same can_view_leave_summary
          gate as the mobile Dashboard above. */}
      {!!user.can_view_leave_summary && (
        <div className={`hidden ${showingClaimsPage || showingMainGroupPage ? 'md:hidden' : 'md:block'}`}>
          <LeaveSummaryCard token={token} onOpen={() => goToMobileSection('leave')} />
        </div>
      )}

      {/* Pending Approvals (desktop) — same card/reasoning as the mobile
          Dashboard above (Part 4 — Role Permissiveness). */}
      <div className={`hidden ${showingClaimsPage || showingMainGroupPage ? 'md:hidden' : 'md:block'}`}>
        <PendingApprovalsCard token={token} />
      </div>

      {/* Movement Claim — reachable via its own tile on mobile and the Navbar's
          "Claims" header menu on desktop (see claimsNavRequest above); either way
          it now opens as its own dedicated page, taking over the whole screen
          instead of always sitting inline on the Dashboard. The page itself shows
          the complete Check In/Check Out history on mobile (with a floating "Add
          Check In/Out" button opening the form in a sheet) and the plain Check
          In/Out form directly on desktop, where there's room for it inline. */}
      <div className={mobileActiveSection === 'claim' && canSeeMovementClaim ? 'block max-md:!mt-0' : 'hidden'}>
        <div className="hidden md:block">
          <ClaimCard token={token} />
        </div>
        <div className="md:hidden">
          <MyClaimsCard
            token={token}
            refreshKey={claimListRefreshKey}
            onCheckOut={() => setShowClaimFormSheet(true)}
          />
        </div>
      </div>

      {/* My Claims — reachable via its own mobile tile / bottom-nav item, same as
          Movement Claim above; no separate desktop entry point (Movement Claim's
          own ClaimCard/history already cover desktop), so this one stays
          mobile-only. onCheckOut/refreshKey wired the same as the 'claim'
          section's copy above, so a still-open claim can be completed straight
          from this list too, without bouncing back to the Movement Claim page. */}
      <div className={mobileActiveSection === 'claims' && canSeeMovementClaim ? 'block md:hidden max-md:!mt-0' : 'hidden'}>
        <MyClaimsCard
          token={token}
          onBack={() => goToMobileSection(null)}
          refreshKey={claimListRefreshKey}
          onCheckOut={() => setShowClaimFormSheet(true)}
        />
      </div>

      {/* Conveyance Bill Claim — direct user-submitted expense claims (separate
          from the GPS-based Movement Claims above). Reachable via its own mobile
          tile / bottom-nav item and the Navbar's "Claims" header menu on desktop
          (see claimsNavRequest above) — either way now its own dedicated page. */}
      <div className={mobileActiveSection === 'conveyanceClaim' && canSeeConveyanceClaim ? 'block max-md:!mt-0' : 'hidden'}>
        <ConveyanceClaimCard token={token} onBack={() => goToMobileSection(null)} />
      </div>

      {/* Leave Applications (Review/Approved/Rejected) — reachable by tapping
          the Leave Summary card above, on both mobile and desktop (same
          dedicated-page pattern as Conveyance Bill Claim). Gated by
          can_view_leave_summary — see canSeeLeave above — same as the Leave
          Summary card itself and the BottomNav "Leave" tab that opens this. */}
      <div className={mobileActiveSection === 'leave' && canSeeLeave ? 'block max-md:!mt-0' : 'hidden'}>
        <LeaveReviewPage token={token} onBack={() => goToMobileSection(null)} />
      </div>

      {/* Employee Directory — company-wide roster, ungated for every account
          (see EmployeeDirectory.tsx / GlobalSidebar.tsx). Reachable here as
          the BottomNav's fallback last tab for any account without Leave
          access (canSeeLeave above), so the bar never collapses to just
          Home. */}
      <div className={mobileActiveSection === 'employeeDirectory' ? 'block max-md:!mt-0' : 'hidden'}>
        <EmployeeDirectory token={token} user={user} onBack={() => goToMobileSection(null)} />
      </div>

      {/* Notice Board — a persistent, browsable version of the same active
          notices NoticePopup.tsx shows once as a modal right after login;
          ungated for every account, same as Employee Directory above. */}
      <div className={mobileActiveSection === 'noticeBoard' ? 'block max-md:!mt-0' : 'hidden'}>
        <NoticeBoard token={token} onBack={() => goToMobileSection(null)} />
      </div>

      {/* Timesheet — same Self Service page GlobalSidebar's "Timesheet" item
          opens, reachable here too via the BottomNav "Timesheet" tab below. */}
      <div className={mobileActiveSection === 'timesheet' ? 'block max-md:!mt-0' : 'hidden'}>
        <Timesheet token={token} onBack={() => goToMobileSection(null)} attendanceProjectId={user.attendance_project_id} />
      </div>

      {/* Floating "Add Check In/Out" — mobile only, shown only while the
          Movement Claim page itself is open, sitting above BottomNav's fixed
          bar at the bottom-right corner. z-50 (BottomNav is z-40, and JSX
          order alone doesn't decide stacking at equal z-index reliably across
          browsers) so this always paints ON TOP of the nav bar instead of
          underneath/behind it. */}
      {mobileActiveSection === 'claim' && (
        <button
          type="button"
          onClick={() => setShowClaimFormSheet(true)}
          className="md:hidden fixed right-4 z-50 flex items-center gap-2 pl-4 pr-5 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-full shadow-lg shadow-blue-600/30 active:scale-95 transition-transform"
          style={{ bottom: 'calc(6.5rem + env(safe-area-inset-bottom, 0px))' }}
        >
          <Plus className="w-4 h-4" /> Add Check In/Out
        </button>
      )}

      {/* Check In/Out popup — opened by the floating button above. Same
          ClaimCard form used inline on desktop, presented as a popup on
          mobile instead. Bumps claimListRefreshKey on every successful Check
          In/Out so the list underneath is current the moment this is closed.
          Portal'd straight onto document.body and built with the same
          header/scroll-body shell as AttendanceMapConfirm/ClaimMapConfirm —
          this sheet used to sit plain-`fixed` inside the dashboard tree's
          `overflow-hidden` ancestor, which on a lot of Android WebViews
          clipped it to that ancestor's box instead of the true screen,
          pushing the bottom of the form under BottomNav. */}
      {showClaimFormSheet &&
        createPortal(
          <div
            className="md:hidden fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-2"
            style={{
              paddingTop: 'calc(env(safe-area-inset-top, 0px) + 0.5rem)',
              paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 0.5rem)'
            }}
            role="dialog"
            aria-modal="true"
          >
            <div
              className="bg-white border border-slate-200 rounded-2xl max-w-lg w-full overflow-hidden shadow-2xl flex flex-col"
              style={{ maxHeight: '100%' }}
            >
              <div className="p-5 border-b border-slate-200 flex items-center justify-between shrink-0">
                <div className="flex items-center gap-3">
                  <div className="bg-blue-50 text-blue-600 p-2 rounded-xl border border-blue-100">
                    <Route className="w-5 h-5" />
                  </div>
                  <h3 className="text-base font-bold text-slate-900">Add Check In/Out</h3>
                </div>
                <button
                  type="button"
                  onClick={() => setShowClaimFormSheet(false)}
                  className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
                  aria-label="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              <div className="p-5 overflow-y-auto min-h-0">
                <ClaimCard
                  token={token}
                  onSuccess={(kind) => {
                    setClaimListRefreshKey((k) => k + 1);
                    // Check In: leave the sheet open — the user will likely
                    // Check Out from right here later. Check Out: the claim
                    // is finished, so close it back to the list instead of
                    // leaving an empty/idle form sitting on screen.
                    if (kind === 'out') setShowClaimFormSheet(false);
                  }}
                />
              </div>
            </div>
          </div>,
          document.body
        )}

      {/* Mobile-only tile menu — "Select a Budget", "Jobs", and "Job Entry Details" open
          one at a time below md instead of always sitting stacked on top of each other.
          Styled as "liquid glass" cards (soft pastel gradient + backdrop-blur + big
          rounded corners) to match Employee Directory's mobile card look
          (EmployeeDirectory.tsx's cardTintClass grid cards), instead of the old flat
          white tiles — each tile gets its own pastel tint so the row doesn't read as
          one flat block. The icon badge inside each card is a vivid color-matched
          gradient square with a soft colored glow (white icon on top), rather than a
          flat white icon box, so it reads at a glance like a home-screen app icon. */}
      {mobileActiveSection === null && (
        <div className="md:hidden grid grid-cols-3 gap-2.5">
          {canSeeBudgetModule && (
          <button
            type="button"
            onClick={() => goToMobileSection('budget')}
            className="relative flex flex-col items-center justify-center gap-1.5 rounded-[24px] overflow-hidden border border-white/70 p-3 h-[104px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-blue-100/70 via-white/50 to-indigo-50/40 backdrop-blur-xl hover:shadow-lg hover:border-white active:scale-95 transition-all"
          >
            <div className="p-2.5 rounded-2xl bg-gradient-to-br from-blue-300 to-blue-500 shadow-[0_6px_16px_-2px_rgba(37,99,235,0.35)] border border-white/30">
              <Wallet className="w-6 h-6 text-white" />
            </div>
            <span className="text-xs font-semibold text-slate-700 text-center leading-tight line-clamp-2 flex items-center">
              {selectedBudget ? 'MPR Entry' : 'Select a Budget'}
            </span>
          </button>
          )}
          {canSeeBudgetModule && (
          <button
            type="button"
            onClick={() => goToMobileSection('jobs')}
            className="relative flex flex-col items-center justify-center gap-1.5 rounded-[24px] overflow-hidden border border-white/70 p-3 h-[104px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-violet-100/70 via-white/50 to-fuchsia-50/40 backdrop-blur-xl hover:shadow-lg hover:border-white active:scale-95 transition-all"
          >
            <div className="p-2.5 rounded-2xl bg-gradient-to-br from-violet-300 to-violet-500 shadow-[0_6px_16px_-2px_rgba(124,58,237,0.35)] border border-white/30 relative">
              <Briefcase className="w-6 h-6 text-white" />
              {totalJobsCount > 0 && (
                <span className="absolute -top-1.5 -right-1.5 text-[10px] font-semibold bg-violet-600 text-white rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 border border-white/70">
                  {totalJobsCount}
                </span>
              )}
            </div>
            <span className="text-xs font-semibold text-slate-700 text-center leading-tight line-clamp-2 flex items-center">Jobs</span>
          </button>
          )}
          {canSeeBudgetModule && (
          <button
            type="button"
            onClick={() => goToMobileSection('entries')}
            className="relative flex flex-col items-center justify-center gap-1.5 rounded-[24px] overflow-hidden border border-white/70 p-3 h-[104px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-rose-100/70 via-white/50 to-pink-50/40 backdrop-blur-xl hover:shadow-lg hover:border-white active:scale-95 transition-all"
          >
            <div className="p-2.5 rounded-2xl bg-gradient-to-br from-rose-300 to-rose-500 shadow-[0_6px_16px_-2px_rgba(225,29,72,0.35)] border border-white/30 relative">
              <FileText className="w-6 h-6 text-white" />
              {filteredEntries.length > 0 && (
                <span className="absolute -top-1.5 -right-1.5 text-[10px] font-semibold bg-rose-600 text-white rounded-full min-w-[18px] h-[18px] flex items-center justify-center px-1 border border-white/70">
                  {filteredEntries.length}
                </span>
              )}
            </div>
            <span className="text-xs font-semibold text-slate-700 text-center leading-tight line-clamp-2 flex items-center">Job Entry Details</span>
          </button>
          )}
          {user.can_job_edit && (
            <button
              type="button"
              onClick={() => goToMobileSection('jobEdit')}
              className="relative flex flex-col items-center justify-center gap-1.5 rounded-[24px] overflow-hidden border border-white/70 p-3 h-[104px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-cyan-100/70 via-white/50 to-sky-50/40 backdrop-blur-xl hover:shadow-lg hover:border-white active:scale-95 transition-all"
            >
              <div className="p-2.5 rounded-2xl bg-gradient-to-br from-cyan-300 to-cyan-500 shadow-[0_6px_16px_-2px_rgba(8,145,178,0.35)] border border-white/30">
                <Edit2 className="w-6 h-6 text-white" />
              </div>
              <span className="text-xs font-semibold text-slate-700 text-center leading-tight line-clamp-2 flex items-center">Job Edit</span>
            </button>
          )}
          {canSeeMovementClaim && (
            <button
              type="button"
              onClick={() => goToMobileSection('claim')}
              className="relative flex flex-col items-center justify-center gap-1.5 rounded-[24px] overflow-hidden border border-white/70 p-3 h-[104px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-emerald-100/70 via-white/50 to-teal-50/40 backdrop-blur-xl hover:shadow-lg hover:border-white active:scale-95 transition-all"
            >
              <div className="p-2.5 rounded-2xl bg-gradient-to-br from-emerald-300 to-emerald-500 shadow-[0_6px_16px_-2px_rgba(5,150,105,0.35)] border border-white/30">
                <Route className="w-6 h-6 text-white" />
              </div>
              <span className="text-xs font-semibold text-slate-700 text-center leading-tight line-clamp-2 flex items-center">Movement Claim</span>
            </button>
          )}
          {canSeeConveyanceClaim && (
            <button
              type="button"
              onClick={() => goToMobileSection('conveyanceClaim')}
              className="relative flex flex-col items-center justify-center gap-1.5 rounded-[24px] overflow-hidden border border-white/70 p-3 h-[104px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-amber-100/70 via-white/50 to-orange-50/40 backdrop-blur-xl hover:shadow-lg hover:border-white active:scale-95 transition-all"
            >
              <div className="p-2.5 rounded-2xl bg-gradient-to-br from-amber-300 to-orange-400 shadow-[0_6px_16px_-2px_rgba(217,119,6,0.35)] border border-white/30">
                <Wallet className="w-6 h-6 text-white" />
              </div>
              <span className="text-xs font-semibold text-slate-700 text-center leading-tight line-clamp-2 flex items-center">Conveyance Bill Claim</span>
            </button>
          )}
          <button
            type="button"
            onClick={() => goToMobileSection('employeeDirectory')}
            className="relative flex flex-col items-center justify-center gap-1.5 rounded-[24px] overflow-hidden border border-white/70 p-3 h-[104px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-indigo-100/70 via-white/50 to-blue-50/40 backdrop-blur-xl hover:shadow-lg hover:border-white active:scale-95 transition-all"
          >
            <div className="p-2.5 rounded-2xl bg-gradient-to-br from-indigo-300 to-indigo-500 shadow-[0_6px_16px_-2px_rgba(79,70,229,0.35)] border border-white/30">
              <Contact className="w-6 h-6 text-white" />
            </div>
            <span className="text-xs font-semibold text-slate-700 text-center leading-tight line-clamp-2 flex items-center">Employee Directory</span>
          </button>
          <button
            type="button"
            onClick={() => goToMobileSection('noticeBoard')}
            className="relative flex flex-col items-center justify-center gap-1.5 rounded-[24px] overflow-hidden border border-white/70 p-3 h-[104px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] bg-gradient-to-br from-yellow-100/70 via-white/50 to-amber-50/40 backdrop-blur-xl hover:shadow-lg hover:border-white active:scale-95 transition-all"
          >
            <div className="p-2.5 rounded-2xl bg-gradient-to-br from-yellow-300 to-amber-400 shadow-[0_6px_16px_-2px_rgba(217,119,6,0.35)] border border-white/30">
              <Bell className="w-6 h-6 text-white" />
            </div>
            <span className="text-xs font-semibold text-slate-700 text-center leading-tight line-clamp-2 flex items-center">Notice Board</span>
          </button>
        </div>
      )}


      {/* Global Calendar (Admin Panel -> Holidays) — read-only "pocket
          calendar" of every set Weekend/Holiday date, same widget every role
          sees. Sits right under the Conveyance Bill Claim/Job Entry/Job Edit
          tile menu above, Dashboard-only (mobileActiveSection === null) same
          as that tile menu. */}
      {mobileActiveSection === null && (
        <div className="md:hidden">
          <HolidayCalendarWidget token={token} />
        </div>
      )}

      {/* Entry Form Grid — hides entirely on desktop while a Claims page (Movement
          Claim/My Claims/Conveyance Bill Claim) is the active section, same as
          Check In/Check Out and Job Edit above/below it. On mobile this already
          shows nothing in that state since none of Budget/Jobs/Entries match
          mobileActiveSection either, so no extra class is needed there. */}
      <div
        className={`grid grid-cols-1 lg:grid-cols-3 gap-8 ${showingClaimsPage ? 'md:hidden' : ''} ${
          mobileActiveSection === 'budget' || mobileActiveSection === 'jobs' || mobileActiveSection === 'entries'
            ? 'max-md:!mt-0'
            /* On mobile, none of Budget/Jobs/Entries (this grid's own three
               sections) are the active section (e.g. Claim/Job Edit/Self
               Service instead), so every child inside is individually hidden
               and this grid renders empty — display:grid with zero content,
               NOT display:none, since only `showingClaimsPage` ever hides the
               grid itself. Being a genuinely rendered (if empty) box, it still
               gets space-y-8's own margin-top (the elements before it are all
               display:none and so don't collapse it away) — a real, visible
               gap between the header and whatever mobile section IS showing
               below it (this is the "gap under the header" bug). !mt-0 here,
               alongside the pre-existing !mb-0, zeroes both. */
            : 'max-md:!mt-0 max-md:!mb-0'
        }`}
      >
        <div
          className={`${mobileActiveSection === 'budget' && canSeeBudgetModule ? 'block' : 'hidden'} ${
            !showingClaimsPage && desktopActiveSection === 'budget' && canSeeBudgetModule ? 'md:block lg:col-span-3' : 'md:hidden lg:col-span-1'
          }`}
        >
          {!isNativeApp && (
            <div className="hidden md:block">
              <ModulePath path={['Main', 'Entry']} />
            </div>
          )}
          {!selectedBudget ? (
            /* Budget Picker — a User must choose a Budget the Admin has created &
               imported before a new MPR Entry can be started. Mobile-only "Back to
               Menu" lives here (not also duplicated once a Budget is selected —
               "Back to Budgets" below already gets you back to this screen, so
               showing both at once was redundant chrome on a small screen). */
            /* Liquid glass on mobile (soft violet-tint gradient + backdrop-blur +
               big rounded corners), matching the Dashboard tile menu and
               LeaveSummaryCard's mobile look — desktop (md+) keeps the original
               plain white card untouched via the md: overrides below. */
            <div className="bg-gradient-to-br from-violet-100/70 via-white/50 to-indigo-50/40 backdrop-blur-xl border border-white/70 rounded-[28px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] p-6 lg:sticky lg:top-24 md:bg-white md:from-transparent md:via-transparent md:to-transparent md:backdrop-blur-none md:border-slate-200 md:rounded-2xl md:shadow-sm">
              {/* Hidden on mobile — the mobile header now shows this page's own
                  title in the logo's place (see headerPageTitle.ts above), so
                  repeating it here would be a redundant duplicate. Desktop has
                  no such header takeover, so it keeps this heading. */}
              <h3 className="hidden md:flex text-lg font-bold text-slate-900 mb-1 items-center gap-2">
                <Wallet className="w-5 h-5 text-blue-600" /> Select a Budget
              </h3>
              <p className="hidden md:block text-xs text-slate-500 mb-4">
                Pick a Budget imported by the Admin to start a new MPR entry under it.
              </p>

              {usableBudgets.length === 0 ? (
                <div className="text-center text-xs text-slate-400 bg-white/40 md:bg-slate-50 backdrop-blur md:backdrop-blur-none border border-dashed border-white/60 md:border-slate-200 rounded-xl py-8 px-4 flex flex-col items-center gap-2">
                  <FolderOpen className="w-6 h-6 text-slate-300" />
                  No Budget has been imported by the Admin yet. Please check back later.
                </div>
              ) : (
                <div className="space-y-2.5 max-h-[65vh] overflow-y-auto pr-1">
                  {usableBudgets.map((b) => (
                    <button
                      key={b.id}
                      type="button"
                      onClick={() => openBudget(b)}
                      className="w-full flex items-center justify-between gap-3 text-left p-3.5 bg-white/50 hover:bg-white/70 backdrop-blur-xl border border-white/60 hover:border-white rounded-2xl shadow-[0_4px_14px_-4px_rgba(15,23,42,0.12)] transition-colors group md:bg-slate-50 md:hover:bg-blue-50 md:backdrop-blur-none md:border-slate-200 md:hover:border-blue-300 md:rounded-xl md:shadow-none"
                    >
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-900 text-sm truncate group-hover:text-blue-700 flex items-center gap-1.5">
                          <span className="truncate">{b.budget_name}</span>
                          {b.submitted && (
                            <span className="inline-flex items-center gap-1 text-[9px] px-1.5 py-0.5 rounded-full bg-emerald-100 text-emerald-700 font-semibold flex-shrink-0">
                              <Lock className="w-2.5 h-2.5" /> Submitted
                            </span>
                          )}
                        </div>
                        <div className="text-[10px] text-slate-400 flex items-center gap-1 mt-0.5">
                          <ListChecks className="w-3 h-3" /> {b.item_count || 0} imported item{(b.item_count || 0) === 1 ? '' : 's'}
                        </div>
                      </div>
                      <ChevronRight className="w-4 h-4 text-slate-300 group-hover:text-blue-500 flex-shrink-0" />
                    </button>
                  ))}
                </div>
              )}
            </div>
          ) : (
          <div className="bg-white border border-slate-200 rounded-lg p-4 sm:p-6 lg:sticky lg:top-24">
            <button
              type="button"
              onClick={closeBudget}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-4 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back to Budgets
            </button>
            <h3 className="text-xl font-semibold text-slate-900 mb-5 truncate">
              {selectedBudget.submitted
                ? 'Budget Submitted'
                : editingJob
                ? `Add MPR — ${editingJob.jobNo}`
                : 'New MPR Entry'}
              <span className="text-slate-400 font-normal"> · {selectedBudget.budget_name}</span>
            </h3>

            {selectedBudget.submitted ? (
              <div className="text-xs text-emerald-800 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-4 flex items-start gap-2.5">
                <Lock className="w-4 h-4 flex-shrink-0 mt-0.5 text-emerald-600" />
                <span>
                  You already submitted this Budget as finished. No new MPR entries can be added to it anymore.
                  Use <span className="font-semibold">Back to Budgets</span> to pick a different Budget.
                </span>
              </div>
            ) : (
            <>
            {loadingBudgetItems && (
              <p className="text-xs text-slate-400 mb-3">Loading this Budget's imported items…</p>
            )}

            <form onSubmit={handleSubmitEntry} className="space-y-5 sm:space-y-4">
              {!jobDetailsConfirmed ? (
              <>
              {/* Job No + Entry Date — server-assigned/read-only, shown first since
                  these are NOT entered by the user: Job No shows a live preview of
                  what it WILL become on submit (JOB-000X, based on how many Jobs this
                  User has already submitted under this Budget) instead of sitting
                  blank, and Entry Date is always today. */}
              <div className="grid grid-cols-2 gap-4 sm:gap-3">
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Job No <span className="text-xs text-slate-400 font-normal">(auto)</span>
                  </label>
                  <input
                    type="text"
                    disabled
                    value={nextJobNoPreview}
                    placeholder="Assigned on submit"
                    className="block w-full px-4 py-3.5 sm:py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-500 font-medium text-base sm:text-sm cursor-not-allowed placeholder:text-slate-400 placeholder:font-normal"
                  />
                </div>
                <div>
                  <label className="block text-sm font-medium text-slate-700 mb-1.5">
                    Entry Date <span className="text-xs text-slate-400 font-normal">(today)</span>
                  </label>
                  <input
                    type="date"
                    disabled
                    value={entryDate}
                    className="block w-full px-4 py-3.5 sm:py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-400 text-base sm:text-sm cursor-not-allowed"
                  />
                </div>
              </div>

              {/* Project Name — a type-to-search dropdown (auto-filled/read-only when
                  this User only has ONE Project available for this Budget). This and
                  everything below IS entered by the user. */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Project Name <span className="text-slate-400">*</span>
                </label>
                {scopedProjects.length === 1 ? (
                  <input
                    type="text"
                    readOnly
                    value={scopedProjects[0].project_name}
                    className="block w-full px-4 py-3.5 sm:py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-600 text-base sm:text-sm cursor-not-allowed"
                  />
                ) : (
                <div className="relative">
                  <input
                    type="text"
                    required
                    value={projectSearchText}
                    onChange={(e) => {
                      setProjectSearchText(e.target.value);
                      setShowProjectDropdown(true);
                      if (projectId) {
                        // Typing again after a Project was already picked invalidates that
                        // pick — clear it (and any rows filled in under it) until a fresh
                        // suggestion is chosen.
                        setProjectId('');
                        setJobDetailsConfirmed(false);
                        setMprRows([makeEmptyRow()]);
                      }
                    }}
                    onFocus={() => setShowProjectDropdown(true)}
                    onBlur={() => setTimeout(() => setShowProjectDropdown(false), 150)}
                    placeholder="Type to search Project Name..."
                    autoComplete="off"
                    className="block w-full px-4 py-3.5 sm:py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-base sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none placeholder-slate-400"
                  />

                  {showProjectDropdown && (
                    <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-md max-h-48 overflow-y-auto">
                      {filteredScopedProjects.length > 0 ? (
                        filteredScopedProjects.map((p) => (
                          <button
                            type="button"
                            key={p.id}
                            onMouseDown={(e) => e.preventDefault()}
                            onClick={() => selectProject(p)}
                            className={`w-full text-left px-3.5 py-2 text-sm transition-colors ${
                              projectId === String(p.id) ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700 hover:bg-slate-50'
                            }`}
                          >
                            {p.project_name}
                          </button>
                        ))
                      ) : (
                        <div className="px-3.5 py-2 text-xs text-slate-400">No matching Project found</div>
                      )}
                    </div>
                  )}
                </div>
                )}
                {scopedProjects.length !== 1 && !projectId && projectSearchText && (
                  <p className="text-xs text-amber-600 mt-1.5">Please select a Project from the list.</p>
                )}
                {scopedProjects.length === 0 && !loadingBudgetItems && (
                  <p className="text-xs text-amber-600 mt-1.5">
                    No Project from this Budget is available to you yet. Contact your Administrator.
                  </p>
                )}
              </div>

              {/* Job Name (Manually entered by the user) */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Job Name <span className="text-slate-400">*</span>
                </label>
                <input
                  type="text"
                  required
                  value={jobName}
                  onChange={(e) => setJobName(e.target.value)}
                  placeholder="e.g. Site Foundation Work"
                  className="block w-full px-4 py-3.5 sm:py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-base sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none placeholder-slate-400"
                />
              </div>

              {/* Job Duration — number only */}
              <div>
                <label className="block text-sm font-medium text-slate-700 mb-1.5">
                  Job Duration <span className="text-slate-400">*</span>
                </label>
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  required
                  value={jobDuration}
                  onChange={(e) => setJobDuration(e.target.value.replace(/\D/g, ''))}
                  placeholder="e.g. 3"
                  className="block w-full px-4 py-3.5 sm:py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-base sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none placeholder-slate-400"
                />
              </div>

              {/* Next — confirms Job No/Entry Date/Project Name/Job Name/Job Duration
                  and collapses them into the summary card below, so the MPR No Entries
                  section (usually the longest part of this form) gets the rest of the
                  form's space instead of always sitting underneath these fields. */}
              <button
                type="button"
                onClick={() => {
                  if (!projectId) {
                    setMessage({ type: 'error', text: 'Please select a Project Name.' });
                    return;
                  }
                  if (!jobName.trim() || !jobDuration.trim()) {
                    setMessage({ type: 'error', text: 'Job Name and Job Duration are required.' });
                    return;
                  }
                  setMessage(null);
                  setJobDetailsConfirmed(true);
                }}
                className="w-full flex items-center justify-center gap-1.5 py-3.5 sm:py-3 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-sm font-medium transition-colors"
              >
                Next <ChevronRight className="w-4 h-4" />
              </button>
              </>
              ) : (
              // --- Summary card: Job No/Entry Date/Project Name/Job Name/Job Duration,
              //     minimized once confirmed — "Edit" re-opens the fields above without
              //     losing anything already filled in (or any MPR No rows below). Laid
              //     out as a minimal 2-column list of label/value lines (no boxes, no
              //     fill color) instead of colored chips, so all 6 fields read at a
              //     glance without visual weight. ---
              <div className="py-3">
                {editingJob && (
                  <div className="flex items-start gap-1.5 text-xs font-medium text-blue-700 mb-3">
                    <Edit2 className="w-3.5 h-3.5 flex-shrink-0 mt-0.5" />
                    <span>Adding a new MPR to an existing Job — Project, Job Name and Job Duration stay locked to this Job.</span>
                  </div>
                )}
                <div className="flex items-center justify-between gap-3 mb-3 border-b border-slate-200 pb-2">
                  <div className="flex items-center gap-1.5 text-xs font-bold text-slate-700">
                    <Briefcase className="w-3.5 h-3.5" />
                    Job Details
                  </div>
                  {editingJob ? (
                    <button
                      type="button"
                      onClick={cancelEditJob}
                      className="flex items-center gap-1 text-xs text-slate-500 hover:text-slate-700 flex-shrink-0 transition-colors"
                    >
                      <X className="w-3 h-3" /> Cancel
                    </button>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setJobDetailsConfirmed(false)}
                      className="flex items-center gap-1 text-xs text-blue-600 hover:text-blue-700 flex-shrink-0 transition-colors"
                    >
                      <Edit2 className="w-3 h-3" /> Edit
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 gap-x-4 gap-y-2.5">
                  {[
                    ['Budget', selectedBudget.budget_name],
                    ['Job No', editingJob ? editingJob.jobNo : nextJobNoPreview],
                    ['Entry Date', entryDate],
                    ['Project Name', projectSearchText],
                    ['Job Name', jobName],
                    ['Job Duration', jobDuration]
                  ].map(([label, value]) => (
                    <div key={label} className="min-w-0 border-b border-slate-100 pb-1.5">
                      <div className="text-[9px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
                      <div className="text-xs font-semibold text-slate-800 truncate mt-0.5">{value}</div>
                    </div>
                  ))}
                </div>
              </div>
              )}

              {/* Already in this Job — shown only while adding another MPR into an
                  EXISTING Job (editingJob), so it's clear what's already there instead
                  of the form looking empty right after returning from the Jobs list.
                  Reuses the exact same EntryCard used in "Job Entry Details" below, so
                  Delivery Date can be edited (and the row deleted) right here too —
                  Job Name/MPR No/Item Name/Qty stay locked once submitted, same rule
                  as everywhere else in the app. */}
              {editingJob && (
                <div className="pt-1">
                  <label className="block text-sm font-medium text-slate-700 mb-2 flex items-center gap-2">
                    Already in {editingJob.jobNo}
                    <span className="text-xs font-semibold text-slate-500 bg-slate-100 border border-slate-200 rounded-full px-2 py-0.5">
                      {editingJobExistingEntries.length}
                    </span>
                  </label>
                  {editingJobExistingEntries.length === 0 ? (
                    <p className="text-xs text-slate-400 mb-1">No MPR entries in this Job yet.</p>
                  ) : (
                    <div className="max-h-72 overflow-y-auto space-y-2 pr-0.5">
                      {editingJobExistingEntries.map((it, idx) => {
                        const isEditingThis = editingEntryId === it.id;
                        const canEditThis = isEntryEditable(it);
                        const dateOnlyEditThis = isDateOnlyEditableEntry(it);
                        return (
                          <EntryCard
                            key={it.id}
                            it={it}
                            token={token}
                            idx={idx}
                            isEditing={isEditingThis}
                            canEdit={canEditThis}
                            dateOnlyEdit={dateOnlyEditThis}
                            deletingEntryId={deletingEntryId}
                            onStartEdit={stableStartEditEntry}
                            onCancelEdit={stableCancelEditEntry}
                            onSaveEdit={stableSaveEditEntry}
                            onDelete={stableHandleDeleteEntry}
                            onSelectEditMpr={stableSelectEditMpr}
                            editSplitRemaining={editSplitRemaining}
                            onSplitRemaining={stableSplitRemainingDuringEdit}
                            splitSaving={splitSaving}
                            splitError={splitError}
                            editJobName={editJobName}
                            setEditJobName={setEditJobName}
                            editMprSearchText={editMprSearchText}
                            setEditMprSearchText={setEditMprSearchText}
                            editShowMprDropdown={editShowMprDropdown}
                            setEditShowMprDropdown={setEditShowMprDropdown}
                            editMprId={editMprId}
                            setEditMprId={setEditMprId}
                            editMprOptions={editMprOptions}
                            editItemName={editItemName}
                            editItemBudgetItemId={editItemBudgetItemId}
                            onEditItemChange={handleEditItemChange}
                            editItemOptions={editItemOptions}
                            editLoadingOptions={editLoadingOptions}
                            editQty={editQty}
                            setEditQty={setEditQty}
                            editMaxQtyFor={editMaxQtyFor}
                            editJobDuration={editJobDuration}
                            setEditJobDuration={setEditJobDuration}
                            editDeliveryRange={editDeliveryRange}
                            editDeliveryDate={editDeliveryDate}
                            setEditDeliveryDate={setEditDeliveryDate}
                            editSaving={editSaving}
                          />
                        );
                      })}
                    </div>
                  )}
                  {editError && <p className="text-[11px] text-rose-600 mt-2">{editError}</p>}
                  {deleteError && <p className="text-[11px] text-rose-600 mt-2">{deleteError}</p>}
                </div>
              )}

              {/* MPR No rows — one Job Name/Job No can hold multiple MPR Nos,
                  each with its own Item Name and Delivery Date.
                  Hidden until Job No/Entry Date/Project Name/Job Name/Job Duration are
                  confirmed via "Next" above — which MPR Nos are valid depends on the
                  Project, so there's nothing meaningful to pick before then. */}
              {!jobDetailsConfirmed ? null : (
              <div className="pt-5 border-t border-slate-200">
                <label className="block text-sm font-medium text-slate-700 mb-3 flex items-center gap-2">
                  MPR No Entries <span className="text-slate-400">*</span>
                  <span className="text-xs font-semibold text-blue-600 bg-blue-50 border border-blue-100 rounded-full px-2 py-0.5">
                    {mprRows.filter((r) => r.mprId).length} added
                  </span>
                </label>

                <div className="space-y-4">
                  {mprRows.map((row, idx) => {
                    const filteredMprNumbers = filteredMprFor(row);
                    const mprUsageMatch = mprUsageForSearchText(row.mprSearchText);
                    const duplicateRowNo = duplicateRowMatchFor(row);
                    // The row's shared Delivery Date field is only required while at
                    // least one Item is still relying on it ("Same as row" — i.e. has no
                    // per-item override of its own). Once every Item under this MPR No
                    // has been given its own Delivery Date (via Split/Edit), this field
                    // becomes optional — its "*" fades and it no longer blocks "Add MPR No".
                    const rowDeliveryFieldRequired =
                      row.itemNames.length === 0 || row.itemNames.some((opt) => !opt.deliveryDate);

                    // Collapsed view: an earlier row that's no longer being actively
                    // filled in — shows only MPR No + Delivery Date, plus Edit/Remove.
                    if (row.collapsed) {
                      return (
                        <div key={row.rowId} className="border border-slate-200 rounded-xl p-4 sm:p-3.5">
                          {/* Row label + actions get their own line so the MPR No /
                              Delivery Date pair below has full width to breathe on
                              narrow phone screens, instead of everything being squeezed
                              into one horizontal row. */}
                          <div className="flex items-center justify-between gap-2 mb-2">
                            <span className="text-xs text-slate-400">
                              MPR Row {idx + 1}
                            </span>
                            <div className="flex items-center gap-1 flex-shrink-0">
                              <button
                                type="button"
                                onClick={() => updateRow(row.rowId, { collapsed: false })}
                                className="text-slate-400 hover:text-blue-600 transition-colors p-2 -m-1 rounded-lg"
                                aria-label="Edit MPR row"
                                title="Edit this row"
                              >
                                <Edit2 className="w-4 h-4" />
                              </button>
                              {mprRows.length > 1 && (
                                <button
                                  type="button"
                                  onClick={() => removeRow(row.rowId)}
                                  className="text-slate-400 hover:text-rose-600 transition-colors p-2 -m-1 rounded-lg"
                                  aria-label="Remove MPR row"
                                >
                                  <Trash2 className="w-4 h-4" />
                                </button>
                              )}
                            </div>
                          </div>
                          <div className="min-w-0 mb-2.5">
                            <div className="text-xs text-slate-400">MPR No</div>
                            <div className="text-slate-800 text-sm font-medium truncate">{row.mprSearchText || '—'}</div>
                          </div>
                          {/* One card per Item under this MPR No — each shows its own
                              Item Name, Qty and Delivery Date together, instead of a
                              single shared summary that hides which Items (and how
                              much of each) were actually entered when an MPR No
                              carries more than one Item. */}
                          {row.itemNames.length > 0 ? (
                            <div className="space-y-1.5">
                              {row.itemNames.map((opt) => (
                                <div
                                  key={opt.uid}
                                  className="bg-slate-50 border border-slate-200 rounded-lg px-3 py-2 flex items-center justify-between gap-2"
                                >
                                  <span className="text-slate-700 text-sm truncate">{opt.name}</span>
                                  <div className="flex items-center gap-3 flex-shrink-0">
                                    <span className="text-xs text-slate-500 whitespace-nowrap">
                                      Qty: <span className="font-medium text-slate-800">{opt.qty || '—'}</span>
                                    </span>
                                    <span className="text-xs text-slate-500 whitespace-nowrap">
                                      {formatDateLabel(getItemDeliveryDate(row, opt)) || '—'}
                                    </span>
                                  </div>
                                </div>
                              ))}
                            </div>
                          ) : (
                            <div className="grid grid-cols-2 gap-3">
                              <div className="min-w-0">
                                <div className="text-xs text-slate-400">Delivery Date</div>
                                <div className="text-slate-800 text-sm font-medium truncate">{formatDateLabel(row.deliveryDate) || '—'}</div>
                              </div>
                            </div>
                          )}
                        </div>
                      );
                    }

                    return (
                      <div key={row.rowId} className="border border-slate-200 rounded-xl p-4 sm:p-3.5 space-y-4 sm:space-y-3">
                        <div className="flex items-center justify-between">
                          <span className="text-xs text-slate-400">
                            MPR Row {idx + 1}
                          </span>
                          <div className="flex items-center gap-1 flex-shrink-0">
                            {mprRows.length > 1 && (
                              <button
                                type="button"
                                onClick={() => removeRow(row.rowId)}
                                className="text-slate-400 hover:text-rose-600 transition-colors p-2 -m-1 rounded-lg"
                                aria-label="Remove MPR row"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            )}
                          </div>
                        </div>

                        {/* MPR No Typeahead (type to search, select from Admin list) */}
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1.5">
                            MPR No <span className="text-slate-400">*</span>
                          </label>
                          <div className="relative">
                            <input
                              type="text"
                              value={row.mprSearchText}
                              onChange={(e) =>
                                updateRow(row.rowId, { mprSearchText: e.target.value, mprId: '', showDropdown: true, itemNames: [] })
                              }
                              onFocus={() => updateRow(row.rowId, { showDropdown: true })}
                              onBlur={() => setTimeout(() => updateRow(row.rowId, { showDropdown: false }), 150)}
                              placeholder="Type to search MPR No..."
                              autoComplete="off"
                              className="block w-full px-4 py-3.5 sm:py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-base sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none placeholder-slate-400"
                            />

                            {row.showDropdown && (
                              <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-md max-h-48 overflow-y-auto">
                                {filteredMprNumbers.length > 0 ? (
                                  filteredMprNumbers.map((m) => (
                                    <button
                                      type="button"
                                      key={m.id}
                                      onMouseDown={(e) => e.preventDefault()}
                                      onClick={() => selectMprForRow(row.rowId, String(m.id), m.mpr_no)}
                                      className={`w-full text-left px-3.5 py-2 text-sm transition-colors ${
                                        row.mprId === String(m.id) ? 'bg-blue-50 text-blue-700 font-medium' : 'text-slate-700 hover:bg-slate-50'
                                      }`}
                                    >
                                      {m.mpr_no}
                                    </button>
                                  ))
                                ) : duplicateRowNo ? (
                                  <div className="px-3.5 py-2 text-xs text-rose-600">
                                    Already added in <span className="font-semibold">Row {duplicateRowNo}</span> above — pick a different MPR No.
                                  </div>
                                ) : mprUsageMatch ? (
                                  <div className="px-3.5 py-2 text-xs text-rose-600">
                                    <span className="font-semibold">{mprUsageMatch.mpr_no}</span> is already entered — under Job{' '}
                                    <span className="font-semibold">{mprUsageMatch.job_no}</span> ({mprUsageMatch.job_name}).
                                  </div>
                                ) : (
                                  <div className="px-3.5 py-2 text-xs text-slate-400">No matching MPR No found</div>
                                )}
                              </div>
                            )}
                          </div>
                          {duplicateRowNo ? (
                            <p className="text-xs text-rose-600 mt-1.5">
                              Already added in <span className="font-semibold">Row {duplicateRowNo}</span> above. Pick a different MPR No.
                            </p>
                          ) : mprUsageMatch ? (
                            <p className="text-xs text-rose-600 mt-1.5">
                              Already entered under Job <span className="font-semibold">{mprUsageMatch.job_no}</span> ({mprUsageMatch.job_name}). Pick a different MPR No.
                            </p>
                          ) : (
                            !row.mprId && row.mprSearchText && (
                              <p className="text-xs text-amber-600 mt-1.5">Please select an MPR No from the list.</p>
                            )
                          )}
                        </div>

                        {/* Item Name — comes from the Budget Excel's "Description of
                            Materials" column for the selected MPR No. A single MRF No can
                            carry several unique Descriptions in the imported sheet: when it
                            does, EVERY one of them is auto-filled here and each becomes its
                            own entry on submit (instead of making the user pick just one).
                            Tapping any Item Name opens a popup with that row's Unit,
                            Specification and Requisitioned Qty from the Budget Excel. */}
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1.5">
                            Item Name <span className="text-slate-400">*</span>
                          </label>
                          <p className="text-xs text-slate-400 mb-1.5">
                            {row.itemNames.length > 1
                              ? `${row.itemNames.length} items under this MPR — all will be entered unless removed. Tap an item for details, or the X to drop it.`
                              : row.itemNames.length === 1
                              ? 'Auto-filled from Budget Excel — tap for details'
                              : 'Auto-filled from Budget Excel'}
                          </p>
                          {row.itemNames.length > 1 ? (
                            <ul className="border border-slate-200 rounded-lg divide-y divide-slate-200 overflow-hidden">
                              {row.itemNames.map((opt) => (
                                <li key={opt.uid} className="bg-slate-50">
                                  <div className="flex items-center gap-1">
                                    {/* Blue "Info" badge + "Details" label (not just a faint
                                        chevron) so this reads as a tappable control on first
                                        glance, not plain static text — matches the single-item
                                        card's design below. */}
                                    <button
                                      type="button"
                                      onClick={() => {
                                        const bi = budgetItems.find((b) => b.id === opt.budgetItemId);
                                        if (bi) setViewingBudgetItem(bi);
                                      }}
                                      className="flex-1 min-w-0 flex items-center gap-2 px-3.5 py-2 text-left text-sm text-slate-700 hover:bg-slate-100 active:bg-slate-200 transition-colors"
                                    >
                                      <span className="flex-shrink-0 w-5 h-5 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
                                        <Info className="w-3 h-3" />
                                      </span>
                                      <span className="flex-1 min-w-0 truncate">{opt.name}</span>
                                      <span className="flex-shrink-0 inline-flex items-center gap-0.5 text-[11px] font-medium text-blue-600">
                                        Details
                                        <ChevronRight className="w-3.5 h-3.5" />
                                      </span>
                                    </button>
                                    {/* Lets the user drop just this Item out of an MPR No
                                        that auto-filled several — not every Item under an
                                        MPR No always needs to be requisitioned together.
                                        It can always be added back — see "+ Add" below. */}
                                    <button
                                      type="button"
                                      onClick={() => removeItemFromRow(row.rowId, opt.uid)}
                                      className="flex-shrink-0 text-slate-400 hover:text-rose-600 transition-colors p-2 mr-1 rounded-lg"
                                      aria-label={`Remove ${opt.name} from this MPR row`}
                                    >
                                      <X className="w-4 h-4" />
                                    </button>
                                  </div>
                                  <div className="flex items-center gap-2 px-3.5 pb-2">
                                    <label className="text-xs text-slate-500 whitespace-nowrap">Requisitioned Qty *</label>
                                    <input
                                      type="number"
                                      inputMode="decimal"
                                      min="0"
                                      step="any"
                                      required
                                      max={opt.remainingQty ?? undefined}
                                      value={opt.qty}
                                      onChange={(e) => updateRowItemQty(row.rowId, opt.uid, e.target.value)}
                                      className={`flex-1 min-w-0 px-2.5 py-1.5 bg-white border rounded-lg text-slate-900 text-sm focus:outline-none ${
                                        opt.remainingQty !== null && opt.qty !== '' && Number(opt.qty) > opt.remainingQty
                                          ? 'border-red-500 ring-1 ring-red-500 focus:border-red-500 focus:ring-red-500'
                                          : 'border-slate-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                                      }`}
                                    />
                                    {opt.remainingQty !== null && (
                                      <span className="text-xs text-slate-400 whitespace-nowrap">/ {opt.remainingQty} left</span>
                                    )}
                                  </div>
                                  {/* Split and Edit Delivery Date used to be two near-identical
                                      "underline dotted" blue text links stacked right on top of
                                      each other — easy to mix up and easy to mis-tap on a small
                                      screen. Now they're color- and icon-differentiated chip
                                      buttons (amber+scissors vs blue+calendar) with real padding
                                      as a bigger, more separated tap target. */}
                                  {opt.remainingQty !== null && opt.qty !== '' && Number(opt.qty) > 0 && Number(opt.qty) < opt.remainingQty && (
                                    <div className="px-3.5 pb-2 -mt-1">
                                      <button
                                        type="button"
                                        onClick={() => splitLeftoverInSameRow(row.rowId, opt.uid)}
                                        className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 active:bg-amber-100 rounded-lg text-xs font-medium transition-colors"
                                      >
                                        <Scissors className="w-3.5 h-3.5 flex-shrink-0" />
                                        Split remaining {opt.remainingQty - Number(opt.qty)} into a new item here
                                      </button>
                                    </div>
                                  )}
                                  {/* Per-item Delivery Date — only meaningful when this
                                      MPR No carries more than one Item; each can go out
                                      on its own date instead of all sharing the row's
                                      single Delivery Date field below. */}
                                  <div className="flex items-center justify-between gap-2 px-3.5 pb-2.5 pt-1">
                                    <span className="text-xs text-slate-500">
                                      Delivery:{' '}
                                      <span className={opt.deliveryDate ? 'font-medium text-slate-800' : 'text-slate-400 italic'}>
                                        {opt.deliveryDate ? formatDateLabel(opt.deliveryDate) : 'Same as row'}
                                      </span>
                                    </span>
                                    <button
                                      type="button"
                                      onClick={() => openItemDeliveryEditor(row, opt)}
                                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 active:bg-blue-100 rounded-lg text-xs font-medium transition-colors flex-shrink-0"
                                    >
                                      <Calendar className="w-3.5 h-3.5 flex-shrink-0" />
                                      Edit
                                    </button>
                                  </div>
                                </li>
                              ))}
                            </ul>
                          ) : row.itemNames.length === 1 ? (
                            <div className="border border-slate-200 rounded-xl overflow-hidden bg-slate-50">
                              {/* Same "Info" badge + "Details" chip treatment as the
                                  multi-item list above — a plain grey row with a faint
                                  chevron read as static/disabled (too close to the
                                  read-only placeholder input below it); this makes the
                                  tap target visually obvious. */}
                              <button
                                type="button"
                                onClick={() => {
                                  const bi = budgetItems.find((b) => b.id === row.itemNames[0].budgetItemId);
                                  if (bi) setViewingBudgetItem(bi);
                                }}
                                className="w-full flex items-center gap-2.5 px-4 py-3.5 sm:py-3 text-slate-700 text-base sm:text-sm text-left hover:bg-slate-100 active:bg-slate-200 transition-colors"
                              >
                                <span className="flex-shrink-0 w-6 h-6 rounded-full bg-blue-50 text-blue-600 flex items-center justify-center">
                                  <Info className="w-3.5 h-3.5" />
                                </span>
                                <span className="flex-1 min-w-0 truncate">{row.itemNames[0].name}</span>
                                <span className="flex-shrink-0 inline-flex items-center gap-0.5 text-xs font-medium text-blue-600">
                                  Details
                                  <ChevronRight className="w-4 h-4" />
                                </span>
                              </button>
                              <div className="flex items-center gap-2 px-4 pb-3">
                                <label className="text-xs text-slate-500 whitespace-nowrap">Requisitioned Qty *</label>
                                <input
                                  type="number"
                                  inputMode="decimal"
                                  min="0"
                                  step="any"
                                  required
                                  max={row.itemNames[0].remainingQty ?? undefined}
                                  value={row.itemNames[0].qty}
                                  onChange={(e) => updateRowItemQty(row.rowId, row.itemNames[0].uid, e.target.value)}
                                  className={`flex-1 min-w-0 px-2.5 py-1.5 bg-white border rounded-lg text-slate-900 text-sm focus:outline-none ${
                                    row.itemNames[0].remainingQty !== null && row.itemNames[0].qty !== '' && Number(row.itemNames[0].qty) > row.itemNames[0].remainingQty
                                      ? 'border-red-500 ring-1 ring-red-500 focus:border-red-500 focus:ring-red-500'
                                      : 'border-slate-300 focus:border-blue-500 focus:ring-1 focus:ring-blue-500'
                                  }`}
                                />
                                {row.itemNames[0].remainingQty !== null && (
                                  <span className="text-xs text-slate-400 whitespace-nowrap">/ {row.itemNames[0].remainingQty} left</span>
                                )}
                              </div>
                              {row.itemNames[0].remainingQty !== null &&
                                row.itemNames[0].qty !== '' &&
                                Number(row.itemNames[0].qty) > 0 &&
                                Number(row.itemNames[0].qty) < row.itemNames[0].remainingQty && (
                                  <div className="px-4 pb-3 -mt-1">
                                    <button
                                      type="button"
                                      onClick={() => splitLeftoverInSameRow(row.rowId, row.itemNames[0].uid)}
                                      className="inline-flex items-center gap-1.5 px-2.5 py-1.5 bg-amber-50 border border-amber-200 text-amber-700 hover:bg-amber-100 active:bg-amber-100 rounded-lg text-xs font-medium transition-colors"
                                    >
                                      <Scissors className="w-3.5 h-3.5 flex-shrink-0" />
                                      Split remaining {row.itemNames[0].remainingQty - Number(row.itemNames[0].qty)} into a new item here
                                    </button>
                                  </div>
                                )}
                            </div>
                          ) : (
                            <input
                              type="text"
                              required
                              readOnly
                              value=""
                              placeholder="Select an MPR No above to auto-fill this"
                              className="block w-full px-4 py-3.5 sm:py-3 bg-slate-50 border border-slate-200 rounded-xl text-slate-600 text-base sm:text-sm cursor-not-allowed placeholder-slate-400"
                            />
                          )}
                          {/* Items dropped via the X button above (or simply not yet
                              added) can be brought back into this row's Item list
                              without re-picking the MPR No. */}
                          {addableItemsForRow(row).length > 0 && (
                            <div className="mt-2">
                              <p className="text-xs text-slate-400 mb-1.5">Add another Item under this MPR No:</p>
                              <div className="flex flex-wrap gap-1.5">
                                {addableItemsForRow(row).map((it) => (
                                  <button
                                    key={it.budgetItemId}
                                    type="button"
                                    onClick={() => addItemToRow(row.rowId, it.budgetItemId)}
                                    className="inline-flex items-center gap-1 px-2.5 py-1.5 bg-blue-50 border border-blue-200 text-blue-700 hover:bg-blue-100 active:bg-blue-100 rounded-lg text-xs font-medium transition-colors"
                                  >
                                    <Plus className="w-3.5 h-3.5 flex-shrink-0" />
                                    <span className="truncate max-w-[180px]">{it.name}</span>
                                  </button>
                                ))}
                              </div>
                            </div>
                          )}
                          {row.mprId && row.itemNames.length === 0 && (
                            <p className="text-xs text-amber-600 mt-1.5">
                              {budgetItems.some((bi) => (bi.mrf_no || '').trim().toLowerCase() === row.mprSearchText.trim().toLowerCase())
                                ? 'Every Item under this MPR No has already been fully requisitioned by you.'
                                : 'No Description of Materials found in the imported Budget Excel for this MPR No.'}
                            </p>
                          )}
                        </div>

                        {/* Delivery Date (separate per MPR No) — a SELECT-only picker
                            (no typing) once the Admin has set a bounded window on this
                            Budget, so an out-of-range date can't be typed in at all;
                            falls back to the normal date picker when no window (or only
                            one side of it) is set. Only truly REQUIRED while at least one
                            Item above is still relying on it ("Same as row") — once every
                            Item has its own per-item Delivery Date (via Split/Edit), this
                            field becomes optional and its "*" fades out, since nothing
                            downstream reads it anymore for this row. */}
                        <div>
                          <label className="block text-sm font-medium text-slate-700 mb-1.5">
                            Delivery Date{' '}
                            <span className={rowDeliveryFieldRequired ? 'text-slate-400' : 'text-slate-300'}>*</span>
                            {!rowDeliveryFieldRequired && (
                              <span className="ml-1.5 text-xs font-normal text-slate-400">
                                (optional — every Item above already has its own date)
                              </span>
                            )}
                          </label>
                          {row.itemNames.length > 1 && (
                            <p className="text-xs text-slate-400 mb-1.5">
                              Applies to any Item above that doesn't have its own Delivery Date set.
                            </p>
                          )}
                          {selectedBudget?.delivery_date_from && selectedBudget?.delivery_date_to ? (
                            <select
                              required={rowDeliveryFieldRequired}
                              value={row.deliveryDate}
                              onChange={(e) => updateRow(row.rowId, { deliveryDate: e.target.value })}
                              className="block w-full px-4 py-3.5 sm:py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-base sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                            >
                              <option value="">Select a Delivery Date...</option>
                              {dateRangeOptions(selectedBudget.delivery_date_from, selectedBudget.delivery_date_to).map((d) => {
                                const blocked = isDateBlockedByLeadTime(d, newEntryEarliestDate);
                                return (
                                  <option key={d} value={d} disabled={blocked}>
                                    {formatDateLabel(d)}{blocked ? ' — needs more notice' : ''}
                                  </option>
                                );
                              })}
                            </select>
                          ) : (
                            <input
                              type="date"
                              required={rowDeliveryFieldRequired}
                              value={row.deliveryDate}
                              onChange={(e) => updateRow(row.rowId, { deliveryDate: e.target.value })}
                              min={
                                newEntryEarliestDate &&
                                (!selectedBudget?.delivery_date_from || newEntryEarliestDate > selectedBudget.delivery_date_from)
                                  ? newEntryEarliestDate
                                  : selectedBudget?.delivery_date_from || undefined
                              }
                              max={selectedBudget?.delivery_date_to || undefined}
                              className="block w-full px-4 py-3.5 sm:py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-base sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                            />
                          )}
                          {(selectedBudget?.delivery_date_from || selectedBudget?.delivery_date_to) && (
                            <p className="text-xs text-slate-400 mt-1.5">
                              Allowed range: {formatDate(selectedBudget?.delivery_date_from) || '—'} to {formatDate(selectedBudget?.delivery_date_to) || '—'}
                            </p>
                          )}
                        </div>

                        {/* Done — moved here below Delivery Date (out of the row's
                            top-right corner) since this is the last field filled in
                            per MPR row; only shows once the row is actually complete.
                            "Add MPR No" sits right next to it in the same row, since
                            finishing this row is exactly when starting the next one
                            makes sense. */}
                        {row.mprId && row.itemNames.length > 0 && row.itemNames.every((opt) => getItemDeliveryDate(row, opt)) && (
                          <div className="flex items-center gap-2">
                            <button
                              type="button"
                              onClick={() => updateRow(row.rowId, { collapsed: true })}
                              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 border border-emerald-200 text-emerald-600 hover:bg-emerald-50 rounded-xl text-xs font-medium transition-colors"
                            >
                              <CheckCircle2 className="w-3.5 h-3.5" /> Done - Minimize
                            </button>
                            <button
                              type="button"
                              onClick={addRow}
                              className="flex-1 flex items-center justify-center gap-1.5 py-2.5 border border-slate-300 text-slate-600 hover:bg-slate-50 rounded-xl text-xs font-medium transition-colors"
                            >
                              <Plus className="w-3.5 h-3.5" /> Add MPR No
                            </button>
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>

                {/* Same "Add MPR No" action repeated here at the bottom of the row list —
                    with several rows already added, this saves scrolling back up to the
                    header button just to add one more. Hidden when the currently active
                    row is already complete, since that row already shows its own
                    "Add MPR No" right next to "Done" above — showing both at once would
                    just be two identical buttons stacked on the page. */}
                {!(
                  mprRows.length > 0 &&
                  !mprRows[mprRows.length - 1].collapsed &&
                  mprRows[mprRows.length - 1].mprId &&
                  mprRows[mprRows.length - 1].itemNames.length > 0 &&
                  mprRows[mprRows.length - 1].itemNames.every((opt) => getItemDeliveryDate(mprRows[mprRows.length - 1], opt))
                ) && (
                <button
                  type="button"
                  onClick={addRow}
                  className="mt-3 w-full flex items-center justify-center gap-1.5 py-3 sm:py-2.5 border border-slate-300 text-slate-600 hover:bg-slate-50 rounded-xl text-base sm:text-sm font-medium transition-colors"
                >
                  <Plus className="w-4 h-4" /> Add MPR No
                </button>
                )}
              </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="w-full py-3.5 sm:py-3 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition-colors text-base sm:text-sm disabled:opacity-50 mt-5"
              >
                {loading ? 'Saving Entry...' : editingJob ? 'Add MPR to Job' : 'Submit MPR Entry'}
              </button>
            </form>
            </>
            )}
          </div>
          )}
        </div>

        {/* Entries Table / List — grouped by Job, one line per Job (not per MPR) */}
        <div className={`space-y-8 ${!showingClaimsPage && desktopActiveSection !== 'budget' ? 'lg:col-span-3' : 'lg:col-span-2'}`}>
          {!isNativeApp && !showingClaimsPage && desktopActiveSection === 'jobs' && canSeeBudgetModule && (
            <div className="hidden md:block">
              <ModulePath path={['Main', 'Jobs']} />
            </div>
          )}
          {/* Jobs summary card — every distinct Job this user has submitted, as a
              scrollable Job No + Job Name list (not just a bare count). */}
          <div
            className={`bg-gradient-to-br from-violet-100/70 via-white/50 to-indigo-50/40 backdrop-blur-xl border border-white/70 rounded-[28px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] overflow-hidden md:bg-white md:from-transparent md:via-transparent md:to-transparent md:backdrop-blur-none md:border-slate-200 md:rounded-lg md:shadow-none ${mobileActiveSection === 'jobs' && canSeeBudgetModule ? 'block' : 'hidden'} ${
              !showingClaimsPage && desktopActiveSection === 'jobs' && canSeeBudgetModule ? 'md:block' : 'md:hidden'
            }`}
          >
            {/* Jump straight back into the MPR Entry form for this Budget —
                same "Select a Budget" tile screen, still on the same Budget,
                so more MPRs can be added/edited exactly like a new Entry.
                Only offered while the Budget hasn't been Submitted (Finished)
                yet — once locked, entries here only change through Job Edit
                instead. Now also switches the desktop page to Entry (see
                desktopActiveSection), since Jobs and Entry are separate
                pages there too, not just on mobile. */}
            {selectedBudget && !selectedBudget.submitted && (
              <button
                type="button"
                onClick={() => {
                  goToMobileSection('budget');
                  setDesktopActiveSection('budget');
                }}
                className="flex items-center gap-1.5 text-xs font-semibold text-blue-600 hover:text-blue-800 px-5 pt-2 transition-colors"
              >
                <ArrowLeft className="w-3.5 h-3.5" /> Return to Entry
              </button>
            )}
            {/* The icon/title/description here is hidden on mobile — the mobile
                header now shows this page's own "Jobs" title in the logo's
                place (see headerPageTitle.ts), so repeating it would be a
                redundant duplicate. The count badge stays (it's live data,
                not a duplicate label). Desktop has no such header takeover,
                so it keeps the full row. */}
            <div className="flex items-center justify-end md:justify-between px-5 py-4 border-b border-white/40 md:border-slate-100">
              <div className="hidden md:flex items-center gap-2.5">
                <div className="p-2 bg-blue-50 rounded-lg">
                  <Briefcase className="w-4 h-4 text-blue-600" />
                </div>
                <div>
                  <div className="text-sm font-medium text-slate-900">Jobs</div>
                  <div className="text-xs text-slate-400">Total Job entries submitted</div>
                </div>
              </div>
              <span className="text-sm font-semibold text-slate-900 bg-white/50 md:bg-slate-100 backdrop-blur md:backdrop-blur-none px-2.5 py-1 rounded-full">
                {totalJobsCount}
              </span>
            </div>
            {uniqueJobsList.length === 0 ? (
              <p className="text-sm text-slate-400 px-5 py-4">No Job entries submitted yet.</p>
            ) : (
              <div className="max-h-64 overflow-y-auto divide-y divide-white/40 md:divide-slate-100">
                {jobsByBudget.map((group) => (
                  <div key={group.budget_id !== null ? `id:${group.budget_id}` : `none:${group.budget_name || ''}`}>
                    {/* Budget-wise grouping — a sticky header per Budget so it's clear
                        which Jobs belong to which, even while scrolling a long list. */}
                    <div className="sticky top-0 z-10 px-5 py-1.5 bg-white/60 md:bg-slate-100 backdrop-blur md:backdrop-blur-none text-[11px] font-semibold uppercase tracking-wide text-slate-500">
                      {group.budget_name || 'No Budget'}
                      <span className="ml-1.5 font-normal normal-case text-slate-400">({group.jobs.length})</span>
                    </div>
                    <div className="divide-y divide-white/40 md:divide-slate-100">
                      {group.jobs.map((j) => (
                        <div key={j.job_no} className="flex items-center gap-1 hover:bg-white/50 md:hover:bg-slate-50 transition-colors">
                          <button
                            type="button"
                            // Filters "Job Entry Details" down to just this Job (same table,
                            // same layout — not a separate popup) and jumps straight to it, so
                            // tapping a Job here shows only that Job's entries below.
                            onClick={() => {
                              setEntryColumnFilters((prev) => ({ ...prev, job_no: j.job_no }));
                              setMobileActiveSection('entries');
                              setDesktopActiveSection('entries');
                              entriesSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
                            }}
                            className="flex-1 min-w-0 flex items-center justify-between gap-3 px-5 py-2.5 active:bg-slate-100 transition-colors text-left"
                          >
                            <span className="text-sm font-medium text-blue-600 flex-shrink-0">{j.job_no}</span>
                            <span className="text-sm text-slate-600 truncate text-right">{j.job_name}</span>
                          </button>
                          {/* Return this Job straight into the New MPR Entry form (locked onto
                              this Job — Project/Job Name/Duration read-only) so one more MPR
                              can be added to it, instead of the default flow which always
                              creates a brand-new Job. Only offered before the Budget is
                              Submitted (Finished), and only for users allowed to edit Jobs. */}
                          {canEditExistingJob && selectedBudget && !selectedBudget.submitted && (
                            <button
                              type="button"
                              onClick={() => startEditJob(j)}
                              title={`Add MPR to ${j.job_no}`}
                              className="flex-shrink-0 p-2 mr-2 rounded-lg text-slate-400 hover:text-blue-600 hover:bg-blue-50 transition-colors"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                          )}
                          {/* Submit This Budget (Finish) — moved here from the New MPR Entry
                              form so it sits right on the Job it's tied to instead of as one
                              shared button below the form. Every Job under the same Budget
                              triggers the same underlying "submit this Budget" action (there's
                              no per-Job submit on the server, only per-Budget) — whichever
                              Job's button is tapped submits the whole Budget group it's
                              listed under. Hidden once that Budget is already submitted, and
                              only shown for Jobs that actually belong to a Budget. */}
                          {group.budget_id !== null &&
                            !(budgets.find((b) => b.id === group.budget_id)?.submitted) && (
                              <button
                                type="button"
                                onClick={() =>
                                  handleSubmitBudget({
                                    id: group.budget_id as number,
                                    budget_name: group.budget_name || 'this Budget',
                                    submitted: budgets.find((b) => b.id === group.budget_id)?.submitted
                                  })
                                }
                                disabled={submittingBudgetId === group.budget_id}
                                title={`Submit "${group.budget_name || 'this Budget'}" (Finish)`}
                                className="flex-shrink-0 flex items-center gap-1 px-2 py-1.5 mr-2 rounded-lg text-[11px] font-semibold text-rose-700 bg-white border border-rose-200 hover:bg-rose-50 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                              >
                                <Lock className="w-3 h-3" />
                                {submittingBudgetId === group.budget_id ? 'Submitting...' : 'Submit'}
                              </button>
                            )}
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          {!isNativeApp && !showingClaimsPage && desktopActiveSection === 'entries' && canSeeBudgetModule && (
            <div className="hidden md:block">
              <ModulePath path={['Main', 'Entry Details']} />
            </div>
          )}
          <div
            ref={entriesSectionRef}
            className={`bg-gradient-to-br from-violet-100/70 via-white/50 to-indigo-50/40 backdrop-blur-xl border border-white/70 rounded-[28px] shadow-[0_8px_24px_-6px_rgba(15,23,42,0.15)] overflow-hidden md:bg-white md:from-transparent md:via-transparent md:to-transparent md:backdrop-blur-none md:border-slate-200 md:rounded-2xl md:shadow-sm ${mobileActiveSection === 'entries' && canSeeBudgetModule ? 'block max-md:!mt-0' : 'hidden'} ${
              !showingClaimsPage && desktopActiveSection === 'entries' && canSeeBudgetModule ? 'md:block' : 'md:hidden'
            }`}
          >
            <div className="p-6 border-b border-white/40 md:border-slate-200">
              <div className="flex justify-end md:justify-between items-center gap-3 flex-wrap">
                {/* Hidden on mobile — the mobile header now shows this page's
                    own "Job Entry Details" title in the logo's place (see
                    headerPageTitle.ts), so repeating it would be a redundant
                    duplicate. Desktop has no such header takeover, so it
                    keeps the full heading. */}
                <div className="hidden md:block">
                  <h3 className="text-lg font-bold text-slate-900">Job Entry Details</h3>
                  <p className="text-xs text-slate-500">Every one of your own submitted MPR entries — search or filter any column below</p>
                </div>
                <div className="flex items-center gap-2 flex-shrink-0">
                  <span className="text-xs px-2.5 py-1 rounded-full bg-white/50 md:bg-slate-100 backdrop-blur md:backdrop-blur-none text-slate-700 font-medium border border-white/60 md:border-slate-200 whitespace-nowrap">
                    {new Set(filteredEntries.map((e) => e.job_no)).size} Job{new Set(filteredEntries.map((e) => e.job_no)).size === 1 ? '' : 's'} • {filteredEntries.length} MPR Entr{filteredEntries.length === 1 ? 'y' : 'ies'}
                  </span>
                  <button
                    type="button"
                    onClick={handleExportPdf}
                    disabled={filteredEntries.length === 0}
                    title="Download this table as a PDF"
                    className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
                  >
                    <FileDown className="w-3.5 h-3.5" /> Export PDF
                  </button>
                </div>
              </div>

              {/* Desktop: per-column filters live inline in the table header instead.
                  Mobile: a popup (bottom sheet) instead of an inline collapsible — an inline
                  panel pushed the whole card list down every time it opened, and once a
                  filter was filled in and the panel closed there was no clue anything was
                  still applied besides the small dot on this button. */}
              <div className="md:hidden mt-3">
                <button
                  type="button"
                  onClick={() => setShowMobileFilters(true)}
                  className="w-full flex items-center justify-between px-3 py-2 bg-white/50 backdrop-blur-xl border border-white/60 rounded-xl text-xs font-semibold text-slate-600"
                >
                  <span className="flex items-center gap-1.5">
                    <Search className="w-3.5 h-3.5" /> Filters
                    {hasActiveEntryColumnFilter && (
                      <span className="w-1.5 h-1.5 rounded-full bg-blue-600" />
                    )}
                  </span>
                  <span>▼</span>
                </button>
                {showMobileFilters && (
                  <div
                    className="fixed inset-0 z-50 flex items-start"
                    style={{ paddingTop: 'calc(env(safe-area-inset-top, 0px) + 4rem)' }}
                    role="dialog"
                    aria-modal="true"
                  >
                    <div
                      className="absolute inset-0 bg-black/40"
                      onClick={() => setShowMobileFilters(false)}
                    />
                    <div className="relative w-full max-h-[calc(100vh-4rem)] overflow-y-auto bg-white rounded-b-2xl p-4 pb-6 shadow-xl">
                      <div className="flex items-center justify-between mb-3">
                        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-1.5">
                          <Search className="w-3.5 h-3.5" /> Filters
                        </h3>
                        <button
                          type="button"
                          onClick={() => setShowMobileFilters(false)}
                          className="p-1 text-slate-400 hover:text-slate-600"
                          aria-label="Close filters"
                        >
                          <X className="w-4.5 h-4.5" />
                        </button>
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <input
                          type="text"
                          value={entryColumnFilters.job_no}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, job_no: e.target.value }))}
                          placeholder="Job No"
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                        <input
                          type="text"
                          value={entryColumnFilters.job_name}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, job_name: e.target.value }))}
                          placeholder="Job Name"
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                        <input
                          type="text"
                          value={entryColumnFilters.mpr_no}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, mpr_no: e.target.value }))}
                          placeholder="MPR No"
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                        <div className="relative">
                          <input
                            type="text"
                            value={entryColumnFilters.item_name}
                            onChange={(e) => {
                              setEntryColumnFilters((prev) => ({ ...prev, item_name: e.target.value }));
                              setShowItemNameFilterDropdownMobile(true);
                            }}
                            onFocus={() => setShowItemNameFilterDropdownMobile(true)}
                            onBlur={() => setTimeout(() => setShowItemNameFilterDropdownMobile(false), 150)}
                            placeholder="Item Name"
                            autoComplete="off"
                            className="w-full px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                          {showItemNameFilterDropdownMobile && filteredItemNameFilterOptions.length > 0 && (
                            <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-lg shadow-md max-h-40 overflow-y-auto">
                              {filteredItemNameFilterOptions.map((name) => (
                                <button
                                  type="button"
                                  key={name}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => {
                                    setEntryColumnFilters((prev) => ({ ...prev, item_name: name }));
                                    setShowItemNameFilterDropdownMobile(false);
                                  }}
                                  className="w-full text-left px-2.5 py-1.5 text-xs text-slate-700 hover:bg-slate-50 transition-colors truncate"
                                >
                                  {name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                        <input
                          type="text"
                          value={entryColumnFilters.specification}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, specification: e.target.value }))}
                          placeholder="Specification"
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                        <input
                          type="text"
                          value={entryColumnFilters.req_qty}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, req_qty: e.target.value }))}
                          placeholder="Qty"
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                        <input
                          type="text"
                          value={entryColumnFilters.job_duration}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, job_duration: e.target.value }))}
                          placeholder="Job Duration"
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                        <div className="col-span-2">
                          <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wider mb-1">
                            Delivery Date Range
                          </div>
                          <div className="grid grid-cols-2 gap-2">
                            <input
                              type="date"
                              value={entryColumnFilters.delivery_date_from}
                              onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, delivery_date_from: e.target.value }))}
                              className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                              title="Delivery Date from"
                            />
                            <input
                              type="date"
                              value={entryColumnFilters.delivery_date_to}
                              onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, delivery_date_to: e.target.value }))}
                              className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                              title="Delivery Date to"
                            />
                          </div>
                        </div>
                        <input
                          type="text"
                          value={entryColumnFilters.budget_name}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, budget_name: e.target.value }))}
                          placeholder="Budget"
                          className="px-2.5 py-2 bg-white border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none col-span-2"
                        />
                        {hasActiveEntryColumnFilter && (
                          <button
                            type="button"
                            onClick={clearEntryColumnFilters}
                            className="col-span-2 text-[11px] font-semibold text-blue-600 hover:text-blue-800 text-center py-1"
                          >
                            Clear Filters
                          </button>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => setShowMobileFilters(false)}
                        className="mt-3 w-full py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold"
                      >
                        Done
                      </button>
                    </div>
                  </div>
                )}
              </div>

              {hasActiveEntryColumnFilter && (
                <div className="hidden md:flex justify-end mt-2">
                  <button
                    type="button"
                    onClick={clearEntryColumnFilters}
                    className="text-[11px] font-semibold text-blue-600 hover:text-blue-800 whitespace-nowrap"
                  >
                    Clear Filters
                  </button>
                </div>
              )}
            </div>

            {/* Qty subtotal bar — sits right above the table header. Always reflects
                whatever "Job Entry Details" currently shows: every entry when no
                column filter is active, or just the filtered-down rows once one is
                (filteredEntries already narrows for us either way). */}
            {filteredEntries.length > 0 && (
              <div className="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 md:px-6 py-2 bg-blue-50/60 border-y border-blue-100 text-xs">
                <span className="font-semibold text-blue-800">
                  Qty Subtotal{hasActiveEntryColumnFilter ? ' (filtered)' : ''}:{' '}
                  {qtySubtotal.sum.toLocaleString('en-US', { maximumFractionDigits: 2 })}
                </span>
                <span className="text-blue-700">
                  {qtySubtotal.totalRows} Row{qtySubtotal.totalRows === 1 ? '' : 's'}
                </span>
                {qtySubtotal.countedRows < qtySubtotal.totalRows && (
                  <span className="text-blue-400">
                    ({qtySubtotal.totalRows - qtySubtotal.countedRows} row{qtySubtotal.totalRows - qtySubtotal.countedRows === 1 ? '' : 's'} skipped — no numeric Qty)
                  </span>
                )}
              </div>
            )}

            {filteredEntries.length === 0 && !hasActiveEntryColumnFilter ? (
              <div className="px-6 py-12 text-center text-slate-400 text-sm">
                No entries found. Create your first MPR entry using the form.
              </div>
            ) : (
              <>
              {/* Mobile: stacked cards — no horizontal scrolling needed. */}
              <div className="md:hidden max-h-[36rem] overflow-y-auto p-4 space-y-3">
                {filteredEntries.length === 0 ? (
                  <p className="text-center text-slate-400 text-sm py-6">No entries match your filters.</p>
                ) : (
                  filteredEntries.map((it, idx) => {
                    const isEditing = editingEntryId === it.id;
                    const canEdit = isEntryEditable(it);
                    const dateOnlyEdit = isDateOnlyEditableEntry(it);
                    return (
                      <EntryCard
                        key={it.id}
                        it={it}
                        token={token}
                        idx={idx}
                        isEditing={isEditing}
                        canEdit={canEdit}
                        dateOnlyEdit={dateOnlyEdit}
                        deletingEntryId={deletingEntryId}
                        onStartEdit={stableStartEditEntry}
                        onCancelEdit={stableCancelEditEntry}
                        onSaveEdit={stableSaveEditEntry}
                        onDelete={stableHandleDeleteEntry}
                        onSelectEditMpr={stableSelectEditMpr}
                        editSplitRemaining={editSplitRemaining}
                        onSplitRemaining={stableSplitRemainingDuringEdit}
                        splitSaving={splitSaving}
                        splitError={splitError}
                        editJobName={editJobName}
                        setEditJobName={setEditJobName}
                        editMprSearchText={editMprSearchText}
                        setEditMprSearchText={setEditMprSearchText}
                        editShowMprDropdown={editShowMprDropdown}
                        setEditShowMprDropdown={setEditShowMprDropdown}
                        editMprId={editMprId}
                        setEditMprId={setEditMprId}
                        editMprOptions={editMprOptions}
                        editItemName={editItemName}
                        editItemBudgetItemId={editItemBudgetItemId}
                        onEditItemChange={handleEditItemChange}
                        editItemOptions={editItemOptions}
                        editLoadingOptions={editLoadingOptions}
                        editQty={editQty}
                        setEditQty={setEditQty}
                        editMaxQtyFor={editMaxQtyFor}
                        editJobDuration={editJobDuration}
                        setEditJobDuration={setEditJobDuration}
                        editDeliveryRange={editDeliveryRange}
                        editDeliveryDate={editDeliveryDate}
                        setEditDeliveryDate={setEditDeliveryDate}
                        editSaving={editSaving}
                      />
                    );
                  })
                )}
                {editError && <p className="text-[11px] text-rose-600">{editError}</p>}
                {deleteError && <p className="text-[11px] text-rose-600">{deleteError}</p>}
              </div>

              {/* Desktop / tablet: full table. */}
              <div className="hidden md:block overflow-auto max-h-[32rem]">
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  {/*
                    Sticky header fix: previously `sticky top-0` was applied to the whole
                    <thead>, which held BOTH the label row and the filter-input row. Any
                    positioned descendant in the scrolling <tbody> (e.g. the MPR No edit
                    cell below, which is `relative` with a `z-20` dropdown) could then
                    paint above an unstacked <thead>, making it look like the MPR No
                    header/filter box gets overlapped by body rows while scrolling.
                    Fix: stick EACH header row individually with an explicit stacking
                    context (`z-30`, higher than the in-body dropdowns' `z-20`) and an
                    explicit background so nothing shows through while scrolling.
                  */}
                  <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider">
                    <tr className="sticky top-0 z-30 bg-slate-50">
                      <th className="px-3 py-2.5 text-left">SL</th>
                      <th className="px-3 py-2.5 text-left">Job No</th>
                      <th className="px-3 py-2.5 text-left">Job Name</th>
                      <th className="px-3 py-2.5 text-left">MPR No</th>
                      <th className="px-3 py-2.5 text-left">Item Name</th>
                      <th className="px-3 py-2.5 text-left">Specification</th>
                      <th className="px-3 py-2.5 text-left">Qty</th>
                      <th className="px-3 py-2.5 text-left">Job Duration</th>
                      <th className="px-3 py-2.5 text-left">Delivery Date</th>
                      <th className="px-3 py-2.5 text-left">Budget</th>
                      <th className="px-3 py-2.5 text-left">Action</th>
                    </tr>
                    {/*
                      top-[2.375rem] ≈ the rendered height of the label row above
                      (px-3 py-2.5 + text-xs line height). If your header still looks
                      off by a couple of px after this fix, measure the label row's
                      actual height in devtools and adjust this value to match exactly.
                    */}
                    <tr className="sticky top-[2.375rem] z-30 bg-white normal-case">
                      <th className="px-3 pb-2.5"></th>
                      <th className="px-3 pb-2.5">
                        <input
                          type="text"
                          value={entryColumnFilters.job_no}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, job_no: e.target.value }))}
                          placeholder="Filter..."
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                        />
                      </th>
                      <th className="px-3 pb-2.5">
                        <input
                          type="text"
                          value={entryColumnFilters.job_name}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, job_name: e.target.value }))}
                          placeholder="Filter..."
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                        />
                      </th>
                      <th className="px-3 pb-2.5">
                        <input
                          type="text"
                          value={entryColumnFilters.mpr_no}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, mpr_no: e.target.value }))}
                          placeholder="Filter..."
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                        />
                      </th>
                      <th className="px-3 pb-2.5">
                        <div className="relative">
                          <input
                            type="text"
                            value={entryColumnFilters.item_name}
                            onChange={(e) => {
                              setEntryColumnFilters((prev) => ({ ...prev, item_name: e.target.value }));
                              setShowItemNameFilterDropdownDesktop(true);
                            }}
                            onFocus={() => setShowItemNameFilterDropdownDesktop(true)}
                            onBlur={() => setTimeout(() => setShowItemNameFilterDropdownDesktop(false), 150)}
                            placeholder="Filter..."
                            autoComplete="off"
                            className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                          />
                          {showItemNameFilterDropdownDesktop && filteredItemNameFilterOptions.length > 0 && (
                            <div className="absolute z-20 mt-1 w-48 bg-white border border-slate-200 rounded-lg shadow-md max-h-40 overflow-y-auto normal-case">
                              {filteredItemNameFilterOptions.map((name) => (
                                <button
                                  type="button"
                                  key={name}
                                  onMouseDown={(e) => e.preventDefault()}
                                  onClick={() => {
                                    setEntryColumnFilters((prev) => ({ ...prev, item_name: name }));
                                    setShowItemNameFilterDropdownDesktop(false);
                                  }}
                                  className="w-full text-left px-2.5 py-1.5 text-[11px] text-slate-700 hover:bg-slate-50 transition-colors truncate"
                                >
                                  {name}
                                </button>
                              ))}
                            </div>
                          )}
                        </div>
                      </th>
                      <th className="px-3 pb-2.5">
                        <input
                          type="text"
                          value={entryColumnFilters.specification}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, specification: e.target.value }))}
                          placeholder="Filter..."
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                        />
                      </th>
                      <th className="px-3 pb-2.5">
                        <input
                          type="text"
                          value={entryColumnFilters.req_qty}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, req_qty: e.target.value }))}
                          placeholder="Filter..."
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                        />
                      </th>
                      <th className="px-3 pb-2.5">
                        <input
                          type="text"
                          value={entryColumnFilters.job_duration}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, job_duration: e.target.value }))}
                          placeholder="Filter..."
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                        />
                      </th>
                      <th className="px-3 pb-2.5">
                        <div className="flex items-center gap-1">
                          <input
                            type="date"
                            value={entryColumnFilters.delivery_date_from}
                            onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, delivery_date_from: e.target.value }))}
                            title="Delivery Date from"
                            className="w-full px-1.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                          <input
                            type="date"
                            value={entryColumnFilters.delivery_date_to}
                            onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, delivery_date_to: e.target.value }))}
                            title="Delivery Date to"
                            className="w-full px-1.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                        </div>
                      </th>
                      <th className="px-3 pb-2.5">
                        <input
                          type="text"
                          value={entryColumnFilters.budget_name}
                          onChange={(e) => setEntryColumnFilters((prev) => ({ ...prev, budget_name: e.target.value }))}
                          placeholder="Filter..."
                          className="w-full px-2 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-700 text-[11px] font-normal focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                        />
                      </th>
                      <th className="px-3 pb-2.5"></th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {filteredEntries.length === 0 ? (
                      <tr>
                        <td colSpan={11} className="px-3 py-6 text-center text-slate-400">No entries match your filters.</td>
                      </tr>
                    ) : (
                    filteredEntries.map((it, idx) => {
                      const isEditing = editingEntryId === it.id;
                      const canEdit = isEntryEditable(it);
                      const dateOnlyEdit = isDateOnlyEditableEntry(it);
                      return (
                        <EntryRow
                          key={it.id}
                          it={it}
                          token={token}
                          idx={idx}
                          isEditing={isEditing}
                          canEdit={canEdit}
                          dateOnlyEdit={dateOnlyEdit}
                          deletingEntryId={deletingEntryId}
                          onStartEdit={stableStartEditEntry}
                          onCancelEdit={stableCancelEditEntry}
                          onSaveEdit={stableSaveEditEntry}
                          onDelete={stableHandleDeleteEntry}
                          onSelectEditMpr={stableSelectEditMpr}
                          editSplitRemaining={editSplitRemaining}
                          onSplitRemaining={stableSplitRemainingDuringEdit}
                          splitSaving={splitSaving}
                          splitError={splitError}
                          editJobName={editJobName}
                          setEditJobName={setEditJobName}
                          editMprSearchText={editMprSearchText}
                          setEditMprSearchText={setEditMprSearchText}
                          editShowMprDropdown={editShowMprDropdown}
                          setEditShowMprDropdown={setEditShowMprDropdown}
                          editMprId={editMprId}
                          setEditMprId={setEditMprId}
                          editMprOptions={editMprOptions}
                          editItemName={editItemName}
                          editItemBudgetItemId={editItemBudgetItemId}
                          onEditItemChange={handleEditItemChange}
                          editItemOptions={editItemOptions}
                          editLoadingOptions={editLoadingOptions}
                          editQty={editQty}
                          setEditQty={setEditQty}
                          editMaxQtyFor={editMaxQtyFor}
                          editJobDuration={editJobDuration}
                          setEditJobDuration={setEditJobDuration}
                          editDeliveryRange={editDeliveryRange}
                          editDeliveryDate={editDeliveryDate}
                          setEditDeliveryDate={setEditDeliveryDate}
                          editSaving={editSaving}
                        />
                      );
                    })
                    )}
                  </tbody>
                </table>
                {editError && (
                  <p className="px-3 py-3 text-[11px] text-rose-600">{editError}</p>
                )}
                {deleteError && (
                  <p className="px-3 py-3 text-[11px] text-rose-600">{deleteError}</p>
                )}
              </div>
              </>
            )}
            <div className="px-6 py-3 border-t border-slate-200">
              <p className="text-[10px] text-slate-400">
                You can edit or delete your own entries until you submit that entry's Budget as finished. All edits are recorded server-side; a deleted entry moves into the Admin's Job Recycle bin.
              </p>
            </div>
          </div>
        </div>
      </div>

      {/* Job Edit — only reachable when the Admin has switched can_job_edit ON for this
          user (Admin Panel -> Users). A completely separate section from the 3-column
          grid above (it operates on already Final-Submitted Jobs, which that grid's
          "Job Entry Details" list intentionally locks down). Hides on desktop while a
          Claims page is the active section, same as the grid.
          On desktop, once it's the active section it's the ONLY thing showing in this
          column (every other section above is `md:hidden`), so instead of sitting as
          just another card inside this container's padding (px-2 sm:px-6 lg:px-8) and
          top/bottom spacing (pt-8/md:pb-8, plus the space-y-8 gap from the section
          before it), it breaks out of all of that with matching negative margins —
          !mt-0 cancels the space-y-8 gap, md:-mt-8/md:-mb-8 cancel this container's own
          top/bottom padding, and -mx-2 sm:-mx-6 lg:-mx-8 cancel its side padding — so
          JobEditPanel (which fills md:h-[calc(100vh-4rem)] itself) actually reaches
          every edge: flush under the header, full width, all the way to the bottom.
          Mobile is untouched (max-md:!mt-0 only ever canceled the mobile gap; the
          extra rules above only take effect at md+). */}
      {user.can_job_edit && !isNativeApp && !showingClaimsPage && desktopActiveSection === 'jobEdit' && (
        <div className="hidden md:block">
          <ModulePath path={['Main', 'Job Edits']} />
        </div>
      )}
      {user.can_job_edit && (
        <div className={`${mobileActiveSection === 'jobEdit' ? 'block' : 'hidden'} ${
          !showingClaimsPage && desktopActiveSection === 'jobEdit' ? 'md:block' : 'md:hidden'
        } !mt-0 -mx-2 sm:-mx-6 lg:-mx-8 md:-mt-8 md:-mb-8`}>
          <JobEditPanel token={token} />
        </div>
      )}

      {/* Global Calendar (Admin Panel -> Holidays) — same read-only "pocket
          calendar" widget as mobile's own Dashboard above, and same
          Dashboard-only gating: hides whenever a Claims/Leave page OR one of
          Entry/Jobs/Entry Details/Job Edit (showingMainGroupPage) is the
          active section, leaving it visible only on the actual blank
          Dashboard landing — it used to stay visible on every desktop
          section regardless, back when desktopActiveSection had no real
          "just the Dashboard" state of its own. */}
      {!showingClaimsPage && !showingMainGroupPage && (
        <div className="hidden md:block">
          <HolidayCalendarWidget token={token} size="large" />
        </div>
      )}
      </div>

      {/* Message Banner — fixed to the viewport (not the page) so an error/warning
          fired by handleSubmit (e.g. a missing field or invalid Qty) is impossible
          to miss even when the user is scrolled well down a long MPR row list and
          the Submit button they just tapped is nowhere near the top of the page.
          Previously this rendered inline at the top of the page content and could
          scroll out of view — this mirrors the "impossible to miss" treatment the
          Job Saved popup below already gets for the success case. */}
      {message && (
        <div
          className="fixed inset-x-3 z-50 flex justify-center"
          style={{ top: 'calc(env(safe-area-inset-top, 0px) + 0.75rem)' }}
          role="alert"
          aria-live="assertive"
        >
          <div className={`w-full sm:max-w-md p-4 rounded-xl border shadow-lg flex items-start space-x-3 text-sm ${
            message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' :
            message.type === 'warning' ? 'bg-amber-50 border-amber-200 text-amber-800' :
            'bg-rose-50 border-rose-200 text-rose-800'
          }`}>
            {message.type === 'success' && <CheckCircle2 className="w-5 h-5 flex-shrink-0 text-emerald-600" />}
            {message.type === 'warning' && <AlertTriangle className="w-5 h-5 flex-shrink-0 text-amber-600" />}
            {message.type === 'error' && <AlertTriangle className="w-5 h-5 flex-shrink-0 text-rose-600" />}
            <div className="font-medium flex-1">{message.text}</div>
            <button
              type="button"
              onClick={() => setMessage(null)}
              className="flex-shrink-0 p-0.5 -m-0.5 opacity-60 hover:opacity-100"
              aria-label="Dismiss message"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
      )}

      {/* Job Saved popup — shown right after a Job is successfully submitted, so the
          confirmation is impossible to miss even if the inline Message Banner up top
          is scrolled out of view (the form sits further down the page). */}
      {savedJobPopup && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
          role="dialog"
          aria-modal="true"
        >
          <div className="absolute inset-0 bg-black/40" onClick={() => setSavedJobPopup(null)} />
          <div className="relative w-full sm:max-w-sm bg-white rounded-t-2xl sm:rounded-2xl p-6 shadow-xl text-center">
            <div className="mx-auto mb-3 w-12 h-12 rounded-full bg-emerald-50 flex items-center justify-center">
              <CheckCircle2 className="w-7 h-7 text-emerald-600" />
            </div>
            <h3 className="text-base font-bold text-slate-900 mb-1">Job Saved!</h3>
            <p className="text-sm text-slate-600 mb-5">
              Job <span className="font-semibold text-slate-900">{savedJobPopup.jobNo}</span> saved with{' '}
              <span className="font-semibold text-slate-900">{savedJobPopup.count}</span> MPR No entr{savedJobPopup.count === 1 ? 'y' : 'ies'}!
            </p>
            <button
              type="button"
              onClick={() => setSavedJobPopup(null)}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl transition-colors text-sm"
            >
              OK
            </button>
          </div>
        </div>
      )}

      {/* Item Name detail popup — Description of Materials, Unit, Specification and
          Requisitioned Qty for whichever auto-filled Item Name the user tapped in the
          MPR Entry form above. Rendered outside the z-10 content wrapper (same reason
          as PdfPreviewModal below) so its z-50 isn't trapped under the app header. */}
      {viewingBudgetItem && (
        <div
          className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
          role="dialog"
          aria-modal="true"
        >
          <div className="absolute inset-0 bg-black/40" onClick={() => setViewingBudgetItem(null)} />
          <div className="relative w-full sm:max-w-md max-h-[85vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl p-5 pb-6 shadow-xl">
            <div className="flex items-center justify-between mb-4">
              <h3 className="text-sm font-bold text-slate-900">Item Details</h3>
              <button
                type="button"
                onClick={() => setViewingBudgetItem(null)}
                className="p-1 text-slate-400 hover:text-slate-600"
                aria-label="Close item details"
              >
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
            <div className="space-y-3">
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Description of Materials
                </p>
                <p className="text-sm text-slate-800 mt-0.5">{viewingBudgetItem.description || '—'}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">Unit</p>
                <p className="text-sm text-slate-800 mt-0.5">{viewingBudgetItem.unit || '—'}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Specification
                </p>
                <p className="text-sm text-slate-800 mt-0.5">{viewingBudgetItem.specification || '—'}</p>
              </div>
              <div>
                <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-400">
                  Requisitioned Qty
                </p>
                <p className="text-sm text-slate-800 mt-0.5">{viewingBudgetItem.req_qty || '—'}</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Per-item Delivery Date popup — opened by "Edit Delivery Date" next to an Item
          under an MPR No that carries more than one Item, so each can go out on its own
          date instead of all sharing the row's single Delivery Date field. */}
      {editingItemDelivery && (() => {
        const editRow = mprRows.find((r) => r.rowId === editingItemDelivery.rowId);
        const editOpt = editRow?.itemNames.find((it) => it.uid === editingItemDelivery.uid);
        if (!editRow || !editOpt) return null;
        return (
          <div
            className="fixed inset-0 z-50 flex items-end sm:items-center sm:justify-center"
            role="dialog"
            aria-modal="true"
          >
            <div className="absolute inset-0 bg-black/40" onClick={() => setEditingItemDelivery(null)} />
            <div className="relative w-full sm:max-w-md max-h-[85vh] overflow-y-auto bg-white rounded-t-2xl sm:rounded-2xl p-5 pb-6 shadow-xl">
              <div className="flex items-center justify-between mb-4">
                <h3 className="text-sm font-bold text-slate-900">Delivery Date</h3>
                <button
                  type="button"
                  onClick={() => setEditingItemDelivery(null)}
                  className="p-1 text-slate-400 hover:text-slate-600"
                  aria-label="Close Delivery Date editor"
                >
                  <X className="w-4.5 h-4.5" />
                </button>
              </div>
              <p className="text-xs text-slate-500 mb-3 truncate">{editOpt.name}</p>
              {selectedBudget?.delivery_date_from && selectedBudget?.delivery_date_to ? (
                <select
                  value={itemDeliveryDraft}
                  onChange={(e) => setItemDeliveryDraft(e.target.value)}
                  className="block w-full px-4 py-3.5 sm:py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-base sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                >
                  <option value="">Select a Delivery Date...</option>
                  {dateRangeOptions(selectedBudget.delivery_date_from, selectedBudget.delivery_date_to).map((d) => {
                    const blocked = isDateBlockedByLeadTime(d, newEntryEarliestDate);
                    return (
                      <option key={d} value={d} disabled={blocked}>
                        {formatDateLabel(d)}{blocked ? ' — needs more notice' : ''}
                      </option>
                    );
                  })}
                </select>
              ) : (
                <input
                  type="date"
                  value={itemDeliveryDraft}
                  onChange={(e) => setItemDeliveryDraft(e.target.value)}
                  min={
                    newEntryEarliestDate &&
                    (!selectedBudget?.delivery_date_from || newEntryEarliestDate > selectedBudget.delivery_date_from)
                      ? newEntryEarliestDate
                      : selectedBudget?.delivery_date_from || undefined
                  }
                  max={selectedBudget?.delivery_date_to || undefined}
                  className="block w-full px-4 py-3.5 sm:py-3 bg-white border border-slate-300 rounded-xl text-slate-900 text-base sm:text-sm focus:border-blue-500 focus:ring-1 focus:ring-blue-500 focus:outline-none"
                />
              )}
              {(selectedBudget?.delivery_date_from || selectedBudget?.delivery_date_to) && (
                <p className="text-xs text-slate-400 mt-1.5">
                  Allowed range: {formatDate(selectedBudget?.delivery_date_from) || '—'} to {formatDate(selectedBudget?.delivery_date_to) || '—'}
                </p>
              )}
              <div className="flex items-center gap-2 mt-5">
                {editOpt.deliveryDate && (
                  <button
                    type="button"
                    onClick={clearItemDeliveryOverride}
                    className="flex-1 py-2.5 border border-slate-200 text-slate-600 hover:bg-slate-50 rounded-xl text-sm font-medium transition-colors"
                  >
                    Use Row's Date
                  </button>
                )}
                <button
                  type="button"
                  disabled={!itemDeliveryDraft}
                  onClick={saveItemDeliveryDraft}
                  className="flex-1 py-2.5 bg-blue-600 hover:bg-blue-700 disabled:bg-slate-300 disabled:cursor-not-allowed text-white rounded-xl text-sm font-medium transition-colors"
                >
                  Save
                </button>
              </div>
            </div>
          </div>
        );
      })()}

      <PdfPreviewModal
        isOpen={pdfPreview !== null}
        pdfBytes={pdfPreview?.bytes || null}
        filename={pdfPreview?.filename || ''}
        onClose={closePdfPreview}
        entries={filteredEntries}
        renderEntry={(entry) => {
          const isEditingThis = editingEntryId === entry.id;
          if (!isEditingThis) {
            // Plain tappable summary row — tapping it edits THIS entry right here
            // in the preview (no closing/navigating away to the Job Entry Details
            // table underneath).
            const canEditThis = isEntryEditable(entry);
            return (
              <button
                type="button"
                onClick={() => canEditThis && startEditEntry(entry)}
                disabled={!canEditThis}
                className="w-full flex items-center justify-between gap-3 px-3 py-3 text-left border border-slate-200 rounded-xl hover:bg-slate-50 transition-colors disabled:opacity-60 disabled:cursor-not-allowed"
              >
                <div className="min-w-0">
                  <p className="text-sm font-semibold text-slate-900 truncate">
                    {entry.job_no} — {entry.item_name || 'Untitled item'}
                  </p>
                  <p className="text-xs text-slate-500 truncate">
                    MPR {entry.mpr_no || '—'} • {entry.job_name}
                  </p>
                </div>
                {canEditThis ? (
                  <Edit2 className="w-4 h-4 text-slate-400 flex-shrink-0" />
                ) : (
                  <Lock className="w-4 h-4 text-slate-300 flex-shrink-0" />
                )}
              </button>
            );
          }
          // The entry currently being edited — same edit form/state/validation
          // used by the Job Entry Details table itself, just rendered here.
          return (
            <EntryCard
              it={entry}
              token={token}
              idx={entries.findIndex((e) => e.id === entry.id)}
              isEditing
              canEdit={isEntryEditable(entry)}
              dateOnlyEdit={isDateOnlyEditableEntry(entry)}
              deletingEntryId={deletingEntryId}
              onStartEdit={stableStartEditEntry}
              onCancelEdit={stableCancelEditEntry}
              onSaveEdit={stableSaveEditEntry}
              onDelete={stableHandleDeleteEntry}
              onSelectEditMpr={stableSelectEditMpr}
              editSplitRemaining={editSplitRemaining}
              onSplitRemaining={stableSplitRemainingDuringEdit}
              splitSaving={splitSaving}
              splitError={splitError}
              editJobName={editJobName}
              setEditJobName={setEditJobName}
              editMprSearchText={editMprSearchText}
              setEditMprSearchText={setEditMprSearchText}
              editShowMprDropdown={editShowMprDropdown}
              setEditShowMprDropdown={setEditShowMprDropdown}
              editMprId={editMprId}
              setEditMprId={setEditMprId}
              editMprOptions={editMprOptions}
              editItemName={editItemName}
              editItemBudgetItemId={editItemBudgetItemId}
              onEditItemChange={handleEditItemChange}
              editItemOptions={editItemOptions}
              editLoadingOptions={editLoadingOptions}
              editQty={editQty}
              setEditQty={setEditQty}
              editMaxQtyFor={editMaxQtyFor}
              editJobDuration={editJobDuration}
              setEditJobDuration={setEditJobDuration}
              editDeliveryRange={editDeliveryRange}
              editDeliveryDate={editDeliveryDate}
              setEditDeliveryDate={setEditDeliveryDate}
              editSaving={editSaving}
            />
          );
        }}
        onDownload={async () => {
          if (!pdfPreview) return;
          // doc.save() alone doesn't work inside the Capacitor Android
          // WebView — see src/lib/saveFile.ts for why and how the APK path
          // (native Share sheet) differs from the plain browser download.
          await savePdfCrossPlatform(pdfPreview.doc, pdfPreview.filename);
        }}
      />

      {/* Mobile (APK) bottom bar — trimmed to four everyday sections (Home,
          Claim, Timesheet, Leave). My Bill (Conveyance Bill Claim) is
          reachable from the dashboard tile / GlobalSidebar instead, and
          Budget/Jobs/Entries/Job Edit stay GlobalSidebar-only too. Hidden
          on md+. */}
      <BottomNav
        active={mobileActiveSection}
        onChange={goToMobileSection}
        canViewMovementClaim={canSeeMovementClaim}
        canViewTimesheet={canSeeTimesheet}
        canViewLeave={canSeeLeave}
      />
    </div>
  );
};