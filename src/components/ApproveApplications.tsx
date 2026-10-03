/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, ShieldCheck, Inbox, CheckCircle2, XCircle, RefreshCw, MapPin, X, Package, Paperclip, Car } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { AssetFulfillModal } from './AssetFulfillModal';
import { AssetRequisitionEditItemsModal } from './AssetRequisitionEditItemsModal';
import { ModulePath } from './ModulePath';
import { UserClaimReference, UserClaimItem, ClaimRecord } from '../types';
import ClaimLocationMap from './ClaimLocationMap';
import { ClaimBillLines } from './ClaimBillLines';

interface ApproveApplicationsProps {
  token: string;
  onBack: () => void;
}

// One row from GET /api/my-approvals — see PendingApprovalsCard.tsx for the
// original, narrower version of this same shape.
interface MyApprovalItem {
  id: number;
  source_type: 'attendance' | 'claim' | 'user_claim' | 'attendance_correction' | 'leave_application' | 'leave_reliever' | 'leave_direct' | 'exit_clearance' | 'asset_requisition' | 'vehicle_requisition' | 'hr_action';
  source_id: number;
  source_label: string;
  source_amount: number | null;
  requested_by: number;
  requested_by_name: string | null;
  current_step: number | null;
  total_steps: number | null;
  created_at: string;
  // Only present on a 'user_claim' item — every Movement Claim (check-in/out)
  // this Conveyance Bill Claim's Amount was built from, each with its own
  // location, so the approver can see exactly where it happened before
  // deciding. Empty/absent when the claim has no Movement Claim attached
  // (a plain hand-entered Amount).
  claim_refs?: UserClaimReference[];
  // Only on a 'user_claim' item — the claim's bills (category / date / amount).
  claim_items?: UserClaimItem[];
  // Running Approved Amount — set once an EARLIER Layer (e.g. the
  // Department/Direct Supervisor auto-layer at step 1) has already edited
  // it on a still-pending 'user_claim'. Used as this Layer's pre-fill
  // instead of the full Claim Amount, so a partial-approval edit carries
  // forward through the rest of the chain. Null until someone has edited it.
  source_approved_amount?: number | null;
  // Only present on an 'asset_requisition' item — the full requisition
  // (itemized line items, reason, urgency, target date, attachment) behind
  // this item's one-line source_label, shown when the card is clicked. See
  // GET /api/my-approvals's assetRequisitionDetails.
  asset_requisition_details?: {
    asset_category: string;
    reason: string;
    urgency: 'low' | 'medium' | 'high';
    target_date: string | null;
    has_attachment: boolean;
    attachment_filename: string | null;
    items: { id?: number; item_name: string; purpose: string; unit: string; quantity: number; source?: string; original_quantity?: number | null }[];
  } | null;
  // True only for a 'vehicle_requisition' item sitting on its Template's
  // FINAL Layer, when that Layer's Approver Type is 'vehicle_maintainer'
  // (see server.ts's approval_template_steps.approver_type migration
  // comment). Such a Layer skips Approve/Reject entirely — the card below
  // shows "Assign Vehicle & Driver" instead, and submitting it both closes
  // this approval and confirms the ride (PUT .../approve-and-assign in
  // VehicleManagementRoutes.ts).
  vehicle_maintainer_bypass?: boolean;
  // Asset Requisition on its Template's 'asset_fulfiller' Layer — this
  // approver gets Fulfill & Hand Over instead of Approve/Reject.
  asset_fulfiller_bypass?: boolean;
  // Requester's Supervisor Layer — may edit the items before approving.
  can_edit_asset_items?: boolean;
  // Only on an 'hr_action' item (HR Operations — Promotion, Increment,
  // Transfer…): the Employee and every FROM -> TO change being approved.
  hr_action_details?: {
    action_label: string;
    employee_name: string | null;
    employee_code: string | null;
    effective_date: string | null;
    reason: string | null;
    from: Record<string, any>;
    to: Record<string, any>;
    history: { action: string; by_name: string; step_label?: string | null; remarks?: string | null; at: string }[];
  } | null;
}

// FROM -> TO rows for an HR action card.
const HR_CHANGE_FIELDS: [string, string, boolean?][] = [
  ['designation', 'Designation'],
  ['department', 'Department'],
  ['branch', 'Branch'],
  ['supervisor', 'Supervisor'],
  ['grade', 'Grade'],
  ['gross_salary', 'Gross Salary', true],
  ['probation_end_date', 'Probation Until'],
  ['contract_end_date', 'Contract Until']
];
const hrChangeRows = (d: NonNullable<MyApprovalItem['hr_action_details']>) =>
  HR_CHANGE_FIELDS.filter(([k]) => d.to[k] !== undefined && d.to[k] !== null && d.to[k] !== '').map(([k, label, isMoney]) => {
    const f = (v: any) => (v === undefined || v === null || v === '' ? '—' : isMoney ? `৳${Number(v).toLocaleString('en-BD')}` : String(v));
    return { label, from: f(d.from[k]), to: f(d.to[k]) };
  });

interface AvailableVehicle {
  id: number;
  vehicle_no: string;
  model: string;
}

interface DriverCandidate {
  id: number;
  name: string;
}

const sourceTitle = (t: MyApprovalItem['source_type']) =>
  t === 'user_claim'
    ? 'Conveyance Bill Claim'
    : t === 'attendance_correction'
    ? 'Timesheet Correction'
    : t === 'leave_application'
    ? 'Leave Application'
    : t === 'leave_reliever'
    ? 'Leave Application \u2014 Reliever Review'
    : t === 'leave_direct'
    ? 'Leave Application'
    : t === 'attendance'
    ? 'Remote Attendance'
    : t === 'exit_clearance'
    ? 'Exit Clearance'
    : t === 'asset_requisition'
    ? 'Asset Requisition'
    : t === 'vehicle_requisition'
    ? 'Vehicle Requisition'
    : t === 'hr_action'
    ? 'HR Action'
    : 'Movement Claim';

// "Self Service" -> "Approve Application" — reachable from the Navbar/Sidebar
// like Leave Application/Timesheet, but NOT gated to Admin Panel access or any
// role: shown to every logged-in account, the same "Role Permissiveness"
// philosophy as the Dashboard's Pending Approvals card (PendingApprovalsCard,
// still shown there too — this is the same data as a dedicated full page
// instead of a small card), because a Template Layer or a Leave Application's
// Reliever can be ANY account, role='user' included. Pulls every request
// currently waiting on this account across every workflow (Remote Attendance,
// Conveyance Bill Claim, Timesheet Correction, Leave Application, and Leave
// Application Reliever review, and Exit/Offboarding Clearance) from GET
// /api/my-approvals and lets them Approve/Reject right here. A
// 'leave_reliever' item is routed to its own POST
// /api/leave-applications/:id/reliever-decision, and an 'exit_clearance' item
// to its own POST /api/exit-clearance-items/:id/decision, instead of the
// generic POST /api/my-approvals/:id/act every other source_type uses, since
// neither is an approval_requests row — see the design note on GET
// /api/my-approvals server-side.
export const ApproveApplications: React.FC<ApproveApplicationsProps> = ({ token, onBack }) => {
  // Same isNativeApp split as LeaveManage.tsx / Timesheet.tsx: the
  // web build keeps the module-path breadcrumb + Back button, the Android
  // APK build hides both — the bottom nav is the only way to leave this
  // section there.
  const isNativeApp = Capacitor.isNativePlatform();
  const authHeaders = { Authorization: `Bearer ${token}` };
  const [items, setItems] = useState<MyApprovalItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [actingKey, setActingKey] = useState<string | null>(null);
  const [remarksDraft, setRemarksDraft] = useState<Record<string, string>>({});
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Approved Amount draft for a 'user_claim' item — editable on EVERY Layer,
  // not just the last one (so the Supervisor auto-layer, or any earlier
  // Template Layer, can partially-approve just like the final approver
  // always could). Pre-filled with source_approved_amount when an earlier
  // Layer already set one, otherwise the full Claim Amount (approve as
  // claimed by default). Remaining Amount is derived from this, never its
  // own state. Edits made on a non-final Layer are recorded as a running
  // draft server-side (see updateUserClaimApprovedAmountDraft) and carry
  // forward as the next Layer's pre-fill.
  const [approvedAmountDraft, setApprovedAmountDraft] = useState<Record<string, string>>({});
  // The referenced Movement Claim currently shown on the read-only location
  // map (opened by tapping a claim_refs row below) — same ClaimLocationMap
  // every other Conveyance Bill Claim view (ConveyanceClaimCard, the Admin
  // Panel's Conveyance Bill Claim tab) already reuses for this.
  const [viewingRef, setViewingRef] = useState<{ ref: UserClaimReference; item: MyApprovalItem } | null>(null);
  // The Asset Requisition currently opened for full-details view — tapping
  // anywhere on that item's card (source_type === 'asset_requisition') opens
  // this, so the Supervisor/HR/Inventory approver can see every requested
  // item (not just the asset_category summary in source_label) before
  // deciding. Closed by the modal's own X/backdrop, not by acting on it —
  // acting still happens from the card underneath.
  const [viewingAssetRequisition, setViewingAssetRequisition] = useState<MyApprovalItem | null>(null);
  // asset_fulfiller_bypass item whose Fulfill & Hand Over form is open.
  const [fulfilling, setFulfilling] = useState<MyApprovalItem | null>(null);
  // Supervisor editing a requisition's items (AssetRequisitionEditItemsModal).
  const [editingItems, setEditingItems] = useState<MyApprovalItem | null>(null);

  // Vehicle + driver picker data for a vehicle_maintainer_bypass item's
  // "Assign Vehicle & Driver" form below — same source VehicleManagement.tsx's
  // own Assign form uses. Driver candidates come from GET
  // /api/vehicles/driver-candidates (every login account), NOT the Employee
  // Directory — a driver only needs a real users.id, and an account created
  // straight as a login is never linked to an all_employees row. Fetched
  // unconditionally on mount (cheap, and most accounts here have no admin
  // gate to check first) rather than only once such an item is actually seen.
  const [availableVehicles, setAvailableVehicles] = useState<AvailableVehicle[]>([]);
  const [driverCandidates, setDriverCandidates] = useState<DriverCandidate[]>([]);
  const [assignForm, setAssignForm] = useState<Record<string, { vehicle_id: string; driver_user_id: string }>>({});

  useEffect(() => {
    fetch(apiUrl('/api/vehicles/available'), { headers: authHeaders })
      .then((r) => r.json())
      .then((rows) => setAvailableVehicles(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    fetch(apiUrl('/api/vehicles/driver-candidates'), { headers: authHeaders })
      .then((r) => r.json())
      .then((rows) => setDriverCandidates(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const refToClaimRecord = (ref: UserClaimReference, item: MyApprovalItem): ClaimRecord => ({
    id: ref.claim_id,
    user_id: item.requested_by,
    user_name: item.requested_by_name,
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

  const load = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/my-approvals'), { headers: authHeaders });
      if (res.ok) setItems(await res.json());
    } catch {
      // Offline/unreachable — list just stays with whatever it already had.
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const keyFor = (item: MyApprovalItem) => `${item.source_type}-${item.id}`;

  const handleAct = async (item: MyApprovalItem, action: 'approved' | 'rejected', approvedAmount?: number) => {
    const key = keyFor(item);
    setActingKey(key);
    setMessage(null);
    try {
      const url =
        item.source_type === 'leave_reliever'
          ? apiUrl(`/api/leave-applications/${item.id}/reliever-decision`)
          : item.source_type === 'leave_direct'
          ? apiUrl(`/api/leave-applications/${item.id}/decision`)
          : item.source_type === 'exit_clearance'
          ? apiUrl(`/api/exit-clearance-items/${item.id}/decision`)
          : item.source_type === 'hr_action'
          ? apiUrl(`/api/hr-ops/actions/${item.id}/decision`)
          : apiUrl(`/api/my-approvals/${item.id}/act`);
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          action,
          remarks: remarksDraft[key] || undefined,
          approved_amount: action === 'approved' && approvedAmount != null ? approvedAmount : undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || `Failed to ${action === 'approved' ? 'approve' : 'reject'} this request`);
      setMessage({ type: 'success', text: action === 'approved' ? 'Approved.' : 'Rejected.' });
      setRemarksDraft((prev) => ({ ...prev, [key]: '' }));
      setApprovedAmountDraft((prev) => ({ ...prev, [key]: '' }));
      setItems((prev) => prev.filter((i) => keyFor(i) !== key));
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong.' });
    } finally {
      setActingKey(null);
    }
  };

  // For a vehicle_maintainer_bypass item — the vehicle+driver form's own
  // "submit" doubles as this Layer's Approve, so it goes through PUT
  // .../approve-and-assign instead of POST /api/my-approvals/:id/act (see
  // that route in VehicleManagementRoutes.ts). Removes the item from the
  // list on success, same as handleAct.
  const handleAssignAndApprove = async (item: MyApprovalItem) => {
    const key = keyFor(item);
    const form = assignForm[key];
    if (!form?.vehicle_id || !form?.driver_user_id) {
      setMessage({ type: 'error', text: 'Pick a vehicle and a driver.' });
      return;
    }
    setActingKey(key);
    setMessage(null);
    try {
      const res = await fetch(apiUrl(`/api/vehicles/requisitions/${item.source_id}/approve-and-assign`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          vehicle_id: Number(form.vehicle_id),
          driver_user_id: Number(form.driver_user_id),
          remarks: remarksDraft[key] || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not assign a vehicle to this ride.');
      setMessage({ type: 'success', text: 'Assigned — ride confirmed.' });
      setRemarksDraft((prev) => ({ ...prev, [key]: '' }));
      setAssignForm((prev) => ({ ...prev, [key]: { vehicle_id: '', driver_user_id: '' } }));
      setItems((prev) => prev.filter((i) => keyFor(i) !== key));
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong.' });
    } finally {
      setActingKey(null);
    }
  };

  // Wraps handleAct('approved', ...) with the same Approved Amount validation
  // the Admin Panel's Approvals tab uses — relevant for a 'user_claim' item
  // on ANY Layer (Supervisor auto-layer included), not just the last one;
  // every other item just approves as-is.
  const handleApprove = (item: MyApprovalItem) => {
    const key = keyFor(item);
    if (item.source_type === 'user_claim') {
      const claimAmount = item.source_amount != null ? Number(item.source_amount) : null;
      const draft = approvedAmountDraft[key];
      const fallback = item.source_approved_amount != null ? item.source_approved_amount : claimAmount;
      const approvedAmount = Number(draft != null && draft !== '' ? draft : fallback);
      if (!Number.isFinite(approvedAmount) || approvedAmount <= 0) {
        setMessage({ type: 'error', text: 'Approved Amount must be a positive number.' });
        return;
      }
      if (claimAmount != null && approvedAmount > claimAmount) {
        setMessage({ type: 'error', text: "Approved Amount can't be more than the Claim Amount." });
        return;
      }
      handleAct(item, 'approved', approvedAmount);
    } else {
      handleAct(item, 'approved');
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'Approve Application']} />
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-3 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          </>
        )}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="flex items-center justify-between gap-3 px-6 py-5 border-b border-slate-100 flex-wrap">
            <div className="flex items-center gap-3">
              <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                <ShieldCheck className="w-5 h-5 text-blue-600" />
              </div>
              <div>
                <h1 className="text-base font-bold text-slate-900">
                  Approve Application
                  {items.length > 0 && (
                    <span className="ml-2 inline-flex items-center justify-center min-w-[1.25rem] h-5 px-1.5 rounded-full bg-blue-600 text-white text-[11px] font-bold align-middle">
                      {items.length}
                    </span>
                  )}
                </h1>
                <p className="text-xs text-slate-500">Requests waiting on your approval, across every workflow you're a part of.</p>
              </div>
            </div>
            <button
              type="button"
              onClick={load}
              disabled={loading}
              className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${loading ? 'animate-spin' : ''}`} /> Refresh
            </button>
          </div>

          {message && (
            <div
              className={`mx-6 mt-4 flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl ${
                message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
              }`}
            >
              {message.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <XCircle className="w-3.5 h-3.5 shrink-0" />}
              <span>{message.text}</span>
            </div>
          )}

          {loading ? (
            <div className="flex justify-center py-14">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : items.length === 0 ? (
            <div className="flex flex-col items-center gap-2 text-center py-14 px-5 text-slate-400">
              <Inbox className="w-6 h-6 text-slate-300" />
              <p className="text-sm">Nothing waiting on you right now.</p>
            </div>
          ) : (
            <div className="divide-y divide-slate-100">
              {items.map((item) => {
                const key = keyFor(item);
                // Editable on EVERY Layer now (Supervisor auto-layer included),
                // not just the last one — see the state comment above.
                const editable = item.source_type === 'user_claim';
                const claimAmount = item.source_amount != null ? Number(item.source_amount) : null;
                // Pre-fill: an earlier Layer's running draft if one exists,
                // otherwise the full Claim Amount.
                const runningAmount = item.source_approved_amount != null ? Number(item.source_approved_amount) : claimAmount;
                const fmt = (n: number) => `৳${n.toLocaleString('en-BD', { minimumFractionDigits: 2 })}`;
                const draft = approvedAmountDraft[key];
                const approvedAmount =
                  editable && runningAmount != null
                    ? (() => {
                        const parsed = Number(draft != null && draft !== '' ? draft : runningAmount);
                        return Number.isFinite(parsed) ? parsed : null;
                      })()
                    : null;
                const remainingAmount = claimAmount != null && approvedAmount != null ? claimAmount - approvedAmount : null;
                const isAssetRequisition = item.source_type === 'asset_requisition' && !!item.asset_requisition_details;
                return (
                  <div
                    key={key}
                    className={`px-6 py-4 ${isAssetRequisition ? 'cursor-pointer hover:bg-slate-50/70 transition-colors' : ''}`}
                    onClick={isAssetRequisition ? () => setViewingAssetRequisition(item) : undefined}
                  >
                    <div className="flex items-start justify-between gap-3 flex-wrap">
                      <div className="min-w-0 max-w-full">
                        <div className="flex items-center gap-2 flex-wrap">
                          <span className="text-sm font-semibold text-slate-800">
                            {item.vehicle_maintainer_bypass
                              ? 'Ride Request — Assign Vehicle'
                              : item.asset_fulfiller_bypass
                                ? 'Asset Requisition — Fulfill'
                                : item.hr_action_details
                                  ? `${item.hr_action_details.action_label} — ${item.hr_action_details.employee_name || ''}`
                                  : sourceTitle(item.source_type)}
                          </span>
                        </div>
                        <p className="text-xs text-slate-500 mt-0.5">
                          {item.hr_action_details
                            ? `${item.hr_action_details.employee_code ? item.hr_action_details.employee_code + ' · ' : ''}Effective ${item.hr_action_details.effective_date || '—'}`
                            : item.source_label}
                          {!editable && item.source_amount != null && <> &middot; ৳{item.source_amount.toLocaleString('en-BD', { minimumFractionDigits: 2 })}</>}
                        </p>
                        <p className="text-[11px] text-slate-400 mt-1">
                          From {item.requested_by_name || `User #${item.requested_by}`}
                          {item.total_steps ? <> &middot; Layer {item.current_step} of {item.total_steps}</> : null}
                          {isAssetRequisition && <span className="text-blue-500 font-medium"> &middot; Tap to view details</span>}
                        </p>

                        {item.hr_action_details && (
                          <div className="mt-2 max-w-md">
                            <div className="rounded-lg border border-slate-200 overflow-hidden text-[11px]">
                              {hrChangeRows(item.hr_action_details).map((r) => (
                                <div key={r.label} className="grid grid-cols-[90px_1fr] gap-2 px-2.5 py-1.5 border-b last:border-b-0 border-slate-100">
                                  <span className="text-slate-400 font-semibold">{r.label}</span>
                                  <span className="text-slate-700">
                                    <span className="text-slate-400 line-through decoration-slate-300">{r.from}</span> → <span className="font-semibold text-slate-900">{r.to}</span>
                                  </span>
                                </div>
                              ))}
                            </div>
                            {item.hr_action_details.reason && <p className="text-[11px] text-slate-500 mt-1.5">Reason: {item.hr_action_details.reason}</p>}
                            {item.hr_action_details.history.filter((h) => h.action === 'approved').map((h, i) => (
                              <p key={i} className="text-[11px] text-emerald-700 mt-1">
                                ✓ {h.step_label ? `${h.step_label}: ` : ''}{h.by_name}{h.remarks ? ` — ${h.remarks}` : ''}
                              </p>
                            ))}
                          </div>
                        )}

                        {item.source_type === 'user_claim' && <ClaimBillLines items={item.claim_items} compact />}
                        {item.source_type === 'user_claim' && item.claim_refs && item.claim_refs.length > 0 && (
                          <div className="mt-2 space-y-1 max-w-md">
                            {item.claim_refs.map((r) => (
                              <button
                                key={r.claim_id}
                                type="button"
                                onClick={() => setViewingRef({ ref: r, item })}
                                title="View check-in/out location"
                                className="w-full flex items-center justify-between gap-2 text-[11px] px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 rounded-lg transition-colors text-left"
                              >
                                <span className="flex items-center gap-1 text-slate-600 min-w-0">
                                  <MapPin className="w-3 h-3 text-blue-500 shrink-0" />
                                  <span className="truncate">Movement Claim &middot; {r.purpose}</span>
                                </span>
                                <span className="shrink-0 font-semibold text-slate-800">
                                  ৳{Number(r.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                                </span>
                              </button>
                            ))}
                          </div>
                        )}
                      </div>
                    </div>

                    {editable && (
                      <div className="mt-3 grid grid-cols-3 gap-2 text-xs bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                        <div>
                          <div className="text-[10px] font-semibold text-slate-400 mb-0.5">Claim Amount</div>
                          <div className="font-semibold text-slate-800">{claimAmount != null ? fmt(claimAmount) : '—'}</div>
                        </div>
                        <div>
                          <div className="text-[10px] font-semibold text-slate-400 mb-0.5">Approved Amount</div>
                          <input
                            type="number"
                            step="0.01"
                            min={0}
                            max={claimAmount ?? undefined}
                            value={draft ?? (runningAmount != null ? String(runningAmount) : '')}
                            onChange={(e) => setApprovedAmountDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                            className="w-full text-xs px-2 py-1 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                        </div>
                        <div>
                          <div className="text-[10px] font-semibold text-slate-400 mb-0.5">Remaining Amount</div>
                          <div className="font-semibold text-slate-800">{remainingAmount != null ? fmt(remainingAmount) : '—'}</div>
                        </div>
                      </div>
                    )}

                    {item.asset_fulfiller_bypass ? (
                      <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                        <p className="text-[11px] text-slate-500 flex items-center gap-1">
                          <Package className="w-3 h-3 shrink-0 text-emerald-600" /> This Layer is yours to hand over the items — type what you're giving; the employee then confirms it in My Asset.
                        </p>
                        <button
                          type="button"
                          onClick={() => setFulfilling(item)}
                          className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold transition-colors"
                        >
                          <Package className="w-3.5 h-3.5" /> Fulfill & Hand Over
                        </button>
                      </div>
                    ) : item.vehicle_maintainer_bypass ? (
                      <div className="mt-3 space-y-2" onClick={(e) => e.stopPropagation()}>
                        <p className="text-[11px] text-slate-500 flex items-center gap-1">
                          <Car className="w-3 h-3 shrink-0 text-blue-500" /> This Layer is yours to hand over a vehicle — pick one below to approve and confirm the ride in one step.
                        </p>
                        <div className="flex flex-wrap items-center gap-2">
                          <select
                            value={assignForm[key]?.vehicle_id || ''}
                            onChange={(e) => setAssignForm((prev) => ({ ...prev, [key]: { vehicle_id: e.target.value, driver_user_id: prev[key]?.driver_user_id || '' } }))}
                            className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          >
                            <option value="">Pick a vehicle…</option>
                            {availableVehicles.map((v) => (
                              <option key={v.id} value={v.id}>
                                {v.model} ({v.vehicle_no})
                              </option>
                            ))}
                          </select>
                          <select
                            value={assignForm[key]?.driver_user_id || ''}
                            onChange={(e) => setAssignForm((prev) => ({ ...prev, [key]: { vehicle_id: prev[key]?.vehicle_id || '', driver_user_id: e.target.value } }))}
                            className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          >
                            <option value="">Pick a driver…</option>
                            {driverCandidates.map((d) => (
                              <option key={d.id} value={d.id}>
                                {d.name}
                              </option>
                            ))}
                          </select>
                          <button
                            type="button"
                            disabled={actingKey === key}
                            onClick={() => handleAssignAndApprove(item)}
                            className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 transition-colors"
                          >
                            {actingKey === key ? <Spinner size={14} /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                            Assign & Confirm
                          </button>
                        </div>
                      </div>
                    ) : (
                      <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2" onClick={(e) => e.stopPropagation()}>
                        {item.can_edit_asset_items && item.asset_requisition_details && (
                          <button
                            type="button"
                            onClick={() => setEditingItems(item)}
                            className="flex items-center justify-center gap-1 text-xs px-3 py-2 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 font-semibold transition-colors"
                          >
                            <Package className="w-3.5 h-3.5" /> Edit items
                          </button>
                        )}
                        <input
                          type="text"
                          placeholder="Remarks (optional)"
                          value={remarksDraft[key] || ''}
                          onChange={(e) => setRemarksDraft((prev) => ({ ...prev, [key]: e.target.value }))}
                          className="flex-1 min-w-[160px] text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                        <div className="flex gap-2">
                          <button
                            type="button"
                            disabled={actingKey === key}
                            onClick={() => handleAct(item, 'rejected')}
                            className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-rose-50 text-rose-700 hover:bg-rose-100 font-semibold disabled:opacity-50 transition-colors"
                          >
                            <XCircle className="w-3.5 h-3.5" /> Reject
                          </button>
                          <button
                            type="button"
                            disabled={actingKey === key}
                            onClick={() => handleApprove(item)}
                            className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 transition-colors"
                          >
                            {actingKey === key ? <Spinner size={14} /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                            Approve
                          </button>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>
      </div>

      {editingItems && (
        <AssetRequisitionEditItemsModal
          token={token}
          requisitionId={Number(editingItems.source_id)}
          requesterName={editingItems.requested_by_name}
          items={editingItems.asset_requisition_details?.items || []}
          onClose={() => setEditingItems(null)}
          onSaved={() => {
            setEditingItems(null);
            setViewingAssetRequisition(null);
            load();
          }}
        />
      )}

      {fulfilling && (
        <AssetFulfillModal
          token={token}
          requisitionId={Number(fulfilling.source_id)}
          mode="approve"
          requesterName={fulfilling.requested_by_name}
          items={fulfilling.asset_requisition_details?.items || []}
          onClose={() => setFulfilling(null)}
          onDone={() => {
            const f = fulfilling;
            setFulfilling(null);
            setMessage({ type: 'success', text: 'Handed over — the employee has been notified to confirm it.' });
            setItems((prev) => prev.filter((i) => keyFor(i) !== keyFor(f)));
          }}
        />
      )}

      {viewingRef && (
        <ClaimLocationMap claim={refToClaimRecord(viewingRef.ref, viewingRef.item)} onClose={() => setViewingRef(null)} />
      )}

      {viewingAssetRequisition && viewingAssetRequisition.asset_requisition_details && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setViewingAssetRequisition(null); }}
        >
          <div className="bg-white rounded-2xl shadow-2xl max-w-lg w-full max-h-[85vh] overflow-y-auto">
            <div className="flex items-center justify-between gap-3 px-5 py-4 border-b border-slate-100 sticky top-0 bg-white">
              <div className="flex items-center gap-2.5">
                <div className="w-9 h-9 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
                  <Package className="w-4.5 h-4.5 text-blue-600" />
                </div>
                <div>
                  <h2 className="text-sm font-bold text-slate-900">Asset Requisition Details</h2>
                  <p className="text-xs text-slate-500">
                    From {viewingAssetRequisition.requested_by_name || `User #${viewingAssetRequisition.requested_by}`}
                  </p>
                </div>
              </div>
              {viewingAssetRequisition.can_edit_asset_items && (
                <button
                  type="button"
                  onClick={() => setEditingItems(viewingAssetRequisition)}
                  className="ml-auto text-xs font-semibold px-3 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 hover:bg-blue-100 shrink-0"
                >
                  Edit items
                </button>
              )}
              <button
                type="button"
                onClick={() => setViewingAssetRequisition(null)}
                aria-label="Close"
                className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:text-slate-700 hover:bg-slate-100 transition-colors shrink-0"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="px-5 py-4 space-y-4">
              <div className="grid grid-cols-2 gap-3 text-xs">
                <div>
                  <div className="font-semibold text-slate-400 mb-0.5">Category</div>
                  <div className="text-slate-800">{viewingAssetRequisition.asset_requisition_details.asset_category}</div>
                </div>
                <div>
                  <div className="font-semibold text-slate-400 mb-0.5">Urgency</div>
                  <div
                    className={`inline-flex px-2 py-0.5 rounded-full font-semibold capitalize ${
                      viewingAssetRequisition.asset_requisition_details.urgency === 'high'
                        ? 'bg-rose-50 text-rose-700'
                        : viewingAssetRequisition.asset_requisition_details.urgency === 'medium'
                        ? 'bg-amber-50 text-amber-700'
                        : 'bg-slate-100 text-slate-600'
                    }`}
                  >
                    {viewingAssetRequisition.asset_requisition_details.urgency}
                  </div>
                </div>
                {viewingAssetRequisition.asset_requisition_details.target_date && (
                  <div>
                    <div className="font-semibold text-slate-400 mb-0.5">Needed By</div>
                    <div className="text-slate-800">{viewingAssetRequisition.asset_requisition_details.target_date}</div>
                  </div>
                )}
                <div>
                  <div className="font-semibold text-slate-400 mb-0.5">Layer</div>
                  <div className="text-slate-800">
                    {viewingAssetRequisition.current_step} of {viewingAssetRequisition.total_steps}
                  </div>
                </div>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-400 mb-1">Reason</div>
                <p className="text-sm text-slate-700 whitespace-pre-wrap">{viewingAssetRequisition.asset_requisition_details.reason}</p>
              </div>

              <div>
                <div className="text-xs font-semibold text-slate-400 mb-1.5">
                  Requested Items ({viewingAssetRequisition.asset_requisition_details.items.length})
                </div>
                <div className="space-y-1.5">
                  {viewingAssetRequisition.asset_requisition_details.items.map((it, idx) => (
                    <div key={idx} className="flex items-baseline justify-between gap-2 text-sm bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                      <div>
                        <span className="font-medium text-slate-800">{it.item_name}</span>
                        <span className="text-slate-500"> — {it.purpose}</span>
                      </div>
                      <span className="shrink-0 font-semibold text-slate-700">{Number(it.quantity)} {it.unit}</span>
                    </div>
                  ))}
                </div>
              </div>

              {viewingAssetRequisition.asset_requisition_details.has_attachment && (
                <div className="flex items-center gap-2 text-xs text-slate-500 bg-slate-50 border border-slate-200 rounded-lg px-3 py-2">
                  <Paperclip className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">{viewingAssetRequisition.asset_requisition_details.attachment_filename}</span>
                </div>
              )}
            </div>
          </div>
        </div>
      )}
    </div>
  );
};