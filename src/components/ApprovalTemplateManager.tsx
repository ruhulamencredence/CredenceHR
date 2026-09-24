import React, { useEffect, useState } from 'react';
import {
  LayoutTemplate, Users2, Plus, Trash2, X, GripVertical, Star, StarOff, Power, AlertCircle, CheckCircle2, Pencil
} from 'lucide-react';
import { ApprovalTemplate, ApprovalTemplateStep, ApprovalRequestType, User } from '../types';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface ApprovalTemplateManagerProps {
  token: string;
  user: User;
  users: User[];
}

const REQUEST_TYPES: { key: ApprovalRequestType; label: string }[] = [
  { key: 'conveyance', label: 'Conveyance Bill Claim' },
  { key: 'leave', label: 'Leave Application' },
  { key: 'timesheet', label: 'Timesheet (Attendance Correction)' },
  { key: 'asset', label: 'Asset Requisition' },
  { key: 'vehicle', label: 'Vehicle Requisition' }
];

// Per-Request-Type Layer names — shown instead of the generic "Layer N" so
// the editor reads like the workflow it was actually speced against (e.g.
// Asset Requisition's flowchart: Layer 1 = Supervisor Approval, Layer 2 =
// HR/IT Department Review). A Request Type/index not listed here just falls
// back to "Layer N", so this is purely additive — every existing template
// (conveyance/leave/timesheet) keeps its current generic labels.
const LAYER_NAMES: Partial<Record<ApprovalRequestType, Record<number, string>>> = {
  // Layer 1 = requester's own Supervisor (auto-gate, skipped entirely when
  // the requester IS their own Supervisor). Layer 2 = HR/Admin's own picked
  // approvers, who review + decide. Layer 3 = the Store/Inventory
  // Department's own picked approvers — approving THIS layer is what makes
  // the requisition 'approved' and hands that same account the actual
  // hand-over step (Employee Profile -> Asset Management -> "Approved by
  // Me" — no separate Admin Panel access needed, see wasFinalApprover in
  // AssetManagementRoutes.ts). A Template only needs Layer 3 configured if
  // Inventory should also formally sign off before dispatch; a 2-layer
  // Template still works exactly as before (HR/Admin fulfills directly).
  asset: { 1: 'Supervisor Approval', 2: 'HR/Admin Review', 3: 'Inventory/Store Disbursement' },
  // Vehicle Requisition Flowchart v2.0 — "সুপারভাইজার অনুমোদন করেছেন?" then
  // "HR/Admin রিভিউ (গাড়ির অ্যাভেইলেবিলিটি চেক)": Layer 1 defaults to the
  // requester's own Supervisor (same auto-gate as Asset), Layer 2 is HR/
  // Admin's own picked approvers.
  vehicle: { 1: 'Supervisor Approval', 2: 'HR/Admin Review' }
};
function layerLabel(requestType: ApprovalRequestType, idx: number): string {
  const named = LAYER_NAMES[requestType]?.[idx + 1];
  return named || `Layer ${idx + 1}`;
}

// A step still being edited in the Template modal — approvers kept as plain
// user_ids here; resolved to names via the `users` prop at render time.
// approver_type is the "Approver Type" dropdown per Layer: index 0 (Layer 1)
// may be 'supervisor' — the default, purely virtual position (no approvers
// picked here at all; the request's real Supervisor, resolved the same way
// it always has been, fills this slot automatically) — or, like every other
// Layer, 'employee'/'admin' when explicitly overridden with a picked
// approver. Only index 0 can ever be 'supervisor'.
interface StepDraft {
  approver_user_ids: number[];
  approver_type: 'supervisor' | 'employee' | 'admin';
}

const isAdminRole = (role: string) => role === 'admin' || role === 'superadmin';

// Admin Panel -> Approvals -> "Templates" / "Assign to Employees" — Part 2 of
// the Dynamic Approval Engine. Templates are built here (Superadmin-only to
// create/edit/delete); which Template applies to which Employee for which
// Request Type is set on the "Assign to Employees" tab (any Admin with the
// "approvals" module, same gate as the rest of this screen). Part 3 is what
// actually reads these when a Conveyance/Leave/Timesheet request is submitted.
export const ApprovalTemplateManager: React.FC<ApprovalTemplateManagerProps> = ({ token, user, users }) => {
  const isSuperAdmin = user.role === 'superadmin';
  const [subView, setSubView] = useState<'templates' | 'assign'>('templates');
  const [requestType, setRequestType] = useState<ApprovalRequestType>('conveyance');

  const [templates, setTemplates] = useState<ApprovalTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // --- Template editor modal ---
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [typeDraft, setTypeDraft] = useState<ApprovalRequestType>('conveyance');
  const [isDefaultDraft, setIsDefaultDraft] = useState(false);
  const [isActiveDraft, setIsActiveDraft] = useState(true);
  const [stepsDraft, setStepsDraft] = useState<StepDraft[]>([{ approver_user_ids: [], approver_type: 'supervisor' }]);
  const [approverSearch, setApproverSearch] = useState<Record<number, string>>({});
  const [openApproverDropdown, setOpenApproverDropdown] = useState<number | null>(null);
  const [dragStepIndex, setDragStepIndex] = useState<number | null>(null);
  const [saving, setSaving] = useState(false);
  const [editorError, setEditorError] = useState<string | null>(null);

  // --- Assignment tab ---
  const [assignRows, setAssignRows] = useState<any[]>([]);
  const [defaultTemplate, setDefaultTemplate] = useState<{ id: number; name: string } | null>(null);
  const [assignLoading, setAssignLoading] = useState(false);
  const [savingAssignFor, setSavingAssignFor] = useState<number | null>(null);

  const userMap = new Map<number, User>(users.map((u) => [u.id, u]));

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/approval-templates?request_type=${requestType}`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) setTemplates(await res.json());
    } catch (err) {
      console.error('Failed to load approval templates', err);
    } finally {
      setLoading(false);
    }
  };

  const fetchAssignments = async () => {
    setAssignLoading(true);
    try {
      const res = await fetch(apiUrl(`/api/template-assignments?request_type=${requestType}`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        const data = await res.json();
        setAssignRows(data.employees || []);
        setDefaultTemplate(data.default_template || null);
      }
    } catch (err) {
      console.error('Failed to load template assignments', err);
    } finally {
      setAssignLoading(false);
    }
  };

  useEffect(() => {
    if (subView === 'templates') fetchTemplates();
    else fetchAssignments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subView, requestType]);

  const openCreateModal = () => {
    setEditingId(null);
    setNameDraft('');
    setTypeDraft(requestType);
    setIsDefaultDraft(false);
    setIsActiveDraft(true);
    setStepsDraft([{ approver_user_ids: [], approver_type: 'supervisor' }]);
    setApproverSearch({});
    setOpenApproverDropdown(null);
    setEditorError(null);
    setShowEditor(true);
  };

  const openEditModal = async (id: number) => {
    setEditorError(null);
    try {
      const res = await fetch(apiUrl(`/api/approval-templates/${id}`), { headers: { Authorization: `Bearer ${token}` } });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load this template');
      setEditingId(id);
      setNameDraft(data.name);
      setTypeDraft(data.request_type);
      setIsDefaultDraft(!!data.is_default);
      setIsActiveDraft(!!data.is_active);
      // Every persisted step is a Layer 2+ (skip_auto_supervisor false) or, once
      // the Layer 1 override is on (skip_auto_supervisor true), the persisted
      // steps ARE Layer 1 onward — either way they map straight to StepDrafts.
      // When the override is off, a virtual "Supervisor" card is prepended so
      // index 0 always represents Layer 1 in the editor, exactly like create.
      const persistedSteps: StepDraft[] = (data.steps || []).map((s: ApprovalTemplateStep) => ({
        approver_user_ids: s.approvers.map((a) => a.user_id),
        approver_type: (s as any).approver_type === 'admin' ? 'admin' : 'employee'
      }));
      setStepsDraft(
        data.skip_auto_supervisor
          ? persistedSteps.length
            ? persistedSteps
            : [{ approver_user_ids: [], approver_type: 'employee' }]
          : [{ approver_user_ids: [], approver_type: 'supervisor' }, ...persistedSteps]
      );
      setApproverSearch({});
      setOpenApproverDropdown(null);
      setShowEditor(true);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to load this template' });
    }
  };

  const addStep = () => setStepsDraft((prev) => [...prev, { approver_user_ids: [], approver_type: 'employee' }]);
  const removeStep = (idx: number) => setStepsDraft((prev) => prev.filter((_, i) => i !== idx));
  const moveStep = (from: number, to: number) => {
    if (from === 0 || to === 0 || to < 0 || to >= stepsDraft.length) return;
    setStepsDraft((prev) => {
      const next = [...prev];
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return next;
    });
  };
  // Layer 1's Approver Type: 'supervisor' (default — this Layer stays virtual,
  // no approvers picked, the employee's real Supervisor fills it automatically
  // and the external auto-Supervisor gate stays exactly as it is today) or
  // 'employee'/'admin' (override — Layer 1 becomes a real Layer with its own
  // picked approver(s), and the auto-Supervisor gate is skipped for requests
  // on this template). Layers below Layer 1 are never 'supervisor'.
  const setStepApproverType = (stepIdx: number, type: 'supervisor' | 'employee' | 'admin') =>
    setStepsDraft((prev) => prev.map((s, i) => (i === stepIdx ? { ...s, approver_type: type, approver_user_ids: type === 'supervisor' ? [] : s.approver_user_ids } : s)));
  const addApproverToStep = (stepIdx: number, uid: number) => {
    if (!uid) return;
    setStepsDraft((prev) =>
      prev.map((s, i) => (i === stepIdx && !s.approver_user_ids.includes(uid) ? { ...s, approver_user_ids: [...s.approver_user_ids, uid] } : s))
    );
    setApproverSearch((prev) => ({ ...prev, [stepIdx]: '' }));
    setOpenApproverDropdown(null);
  };
  const removeApproverFromStep = (stepIdx: number, uid: number) => {
    setStepsDraft((prev) => prev.map((s, i) => (i === stepIdx ? { ...s, approver_user_ids: s.approver_user_ids.filter((x) => x !== uid) } : s)));
  };

  const handleSaveTemplate = async () => {
    setSaving(true);
    setEditorError(null);
    try {
      // Layer 1 left as the default 'supervisor' stays virtual — it isn't sent
      // as a step at all, the external auto-Supervisor gate fills it exactly as
      // it always has. Overridden to 'employee'/'admin', it IS sent as a real
      // first step and skip_auto_supervisor tells the backend to skip that gate.
      const skipAutoSupervisor = stepsDraft[0]?.approver_type !== 'supervisor';
      const realSteps = skipAutoSupervisor ? stepsDraft : stepsDraft.slice(1);
      if (realSteps.length === 0) {
        setEditorError('Layer 1 এ Supervisor রেখে দিলে অন্তত একটি Layer (Layer 2+) যোগ করতে হবে।');
        setSaving(false);
        return;
      }
      const payload = {
        name: nameDraft.trim(),
        request_type: typeDraft,
        is_default: isDefaultDraft,
        is_active: isActiveDraft,
        skip_auto_supervisor: skipAutoSupervisor,
        steps: realSteps.map((s) => ({ approver_user_ids: s.approver_user_ids, approver_type: s.approver_type === 'admin' ? 'admin' : 'employee' }))
      };
      const url = editingId ? apiUrl(`/api/approval-templates/${editingId}`) : apiUrl('/api/approval-templates');
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save this template');
      setShowEditor(false);
      setMessage({ type: 'success', text: editingId ? 'Template updated.' : 'Template created.' });
      if (typeDraft === requestType) fetchTemplates();
      else setRequestType(typeDraft); // switches tab filter, which triggers its own fetch
    } catch (err: any) {
      setEditorError(err.message || 'Failed to save this template');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Delete this template? This cannot be undone.')) return;
    try {
      const res = await fetch(apiUrl(`/api/approval-templates/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete this template');
      setMessage({ type: 'success', text: 'Template deleted.' });
      fetchTemplates();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to delete this template' });
    }
  };

  const handleToggleDefault = async (t: ApprovalTemplate) => {
    try {
      const res = await fetch(apiUrl(`/api/approval-templates/${t.id}/default`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_default: !t.is_default })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update default');
      fetchTemplates();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to update default' });
    }
  };

  const handleToggleActive = async (t: ApprovalTemplate) => {
    try {
      const res = await fetch(apiUrl(`/api/approval-templates/${t.id}/active`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ is_active: !t.is_active })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update this template');
      fetchTemplates();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to update this template' });
    }
  };

  const handleAssignChange = async (employeeUserId: number, templateId: string) => {
    setSavingAssignFor(employeeUserId);
    try {
      const res = await fetch(apiUrl('/api/template-assignments'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          employee_user_id: employeeUserId,
          request_type: requestType,
          template_id: templateId ? Number(templateId) : null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save this assignment');
      fetchAssignments();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to save this assignment' });
    } finally {
      setSavingAssignFor(null);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <LayoutTemplate className="w-4 h-4 text-blue-600" /> Approval Templates
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Build named, ordered multi-step approval chains per Request Type, then assign one to each
              Employee (or leave a company-wide default in place).
            </p>
          </div>
          {subView === 'templates' && isSuperAdmin && (
            <button
              type="button"
              onClick={openCreateModal}
              className="flex items-center gap-1.5 text-xs font-semibold px-4 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white transition-colors whitespace-nowrap"
            >
              <Plus className="w-3.5 h-3.5" /> New Template
            </button>
          )}
        </div>

        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex bg-slate-100 rounded-xl p-1">
            <button
              type="button"
              onClick={() => setSubView('templates')}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                subView === 'templates' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
              }`}
            >
              <LayoutTemplate className="w-3.5 h-3.5" /> Templates
            </button>
            <button
              type="button"
              onClick={() => setSubView('assign')}
              className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg transition-colors ${
                subView === 'assign' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
              }`}
            >
              <Users2 className="w-3.5 h-3.5" /> Assign to Employees
            </button>
          </div>

          <select
            value={requestType}
            onChange={(e) => setRequestType(e.target.value as ApprovalRequestType)}
            className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
          >
            {REQUEST_TYPES.map((rt) => (
              <option key={rt.key} value={rt.key}>
                {rt.label}
              </option>
            ))}
          </select>
        </div>

        {message && (
          <div
            className={`flex items-center gap-2 text-xs px-3 py-2.5 rounded-xl ${
              message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
            }`}
          >
            {message.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertCircle className="w-3.5 h-3.5 shrink-0" />}
            <span>{message.text}</span>
          </div>
        )}
      </div>

      {/* --- TEMPLATES LIST --- */}
      {subView === 'templates' && (
        <div className="overflow-x-auto">
          {loading ? (
            <div className="p-10 flex justify-center">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : templates.length === 0 ? (
            <div className="p-10 text-center text-sm text-slate-400">
              No templates yet for {REQUEST_TYPES.find((r) => r.key === requestType)?.label}.
              {isSuperAdmin ? ' Tap "New Template" to build one.' : ' Ask your Superadmin to build one.'}
            </div>
          ) : (
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">Name</th>
                  <th className="text-left px-4 py-3 font-semibold">Layers</th>
                  <th className="text-left px-4 py-3 font-semibold">Default</th>
                  <th className="text-left px-4 py-3 font-semibold">Status</th>
                  <th className="text-right px-4 py-3 font-semibold">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {templates.map((t) => (
                  <tr key={t.id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3 font-semibold text-slate-900">{t.name}</td>
                    <td className="px-4 py-3 text-slate-600">{t.step_count ?? '—'}</td>
                    <td className="px-4 py-3">
                      {isSuperAdmin ? (
                        <button
                          type="button"
                          onClick={() => handleToggleDefault(t)}
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full transition-colors ${
                            t.is_default ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-400 hover:text-slate-600'
                          }`}
                        >
                          {t.is_default ? <Star className="w-3 h-3" /> : <StarOff className="w-3 h-3" />}
                          {t.is_default ? 'Default' : 'Make default'}
                        </button>
                      ) : t.is_default ? (
                        <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full bg-amber-50 text-amber-700">
                          <Star className="w-3 h-3" /> Default
                        </span>
                      ) : (
                        <span className="text-xs text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isSuperAdmin ? (
                        <button
                          type="button"
                          onClick={() => handleToggleActive(t)}
                          className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-1 rounded-full transition-colors ${
                            t.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          <Power className="w-3 h-3" /> {t.is_active ? 'Active' : 'Inactive'}
                        </button>
                      ) : (
                        <span className={`text-[11px] font-semibold px-2 py-1 rounded-full ${t.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                          {t.is_active ? 'Active' : 'Inactive'}
                        </span>
                      )}
                    </td>
                    <td className="px-4 py-3">
                      {isSuperAdmin && (
                        <div className="flex justify-end gap-1.5">
                          <button
                            type="button"
                            onClick={() => openEditModal(t.id)}
                            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(t.id)}
                            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* --- ASSIGN TO EMPLOYEES --- */}
      {subView === 'assign' && (
        <div className="overflow-x-auto">
          <div className="px-4 pt-4 text-xs text-slate-500">
            {defaultTemplate ? (
              <>
                Anyone without an explicit pick below falls back to the default template:{' '}
                <span className="font-semibold text-slate-700">{defaultTemplate.name}</span>.
              </>
            ) : (
              <span className="text-amber-700">
                No default template set for {REQUEST_TYPES.find((r) => r.key === requestType)?.label} — an Employee with no explicit
                pick below will have their request auto-approved.
              </span>
            )}
          </div>
          {assignLoading ? (
            <div className="p-10 flex justify-center">
              <Spinner size={20} className="text-slate-400" />
            </div>
          ) : (
            <table className="w-full text-sm mt-2">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">Employee</th>
                  <th className="text-left px-4 py-3 font-semibold">Assigned Template</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {assignRows.map((row) => (
                  <tr key={row.employee_user_id} className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{row.employee_name}</div>
                      <div className="text-[11px] text-slate-500">{row.employee_role}</div>
                    </td>
                    <td className="px-4 py-3">
                      <select
                        value={row.assigned_template_id || ''}
                        disabled={savingAssignFor === row.employee_user_id}
                        onChange={(e) => handleAssignChange(row.employee_user_id, e.target.value)}
                        className="w-64 text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:opacity-50"
                      >
                        <option value="">
                          {defaultTemplate ? `Use default (${defaultTemplate.name})` : 'Use default (none — auto-approve)'}
                        </option>
                        {templates
                          .filter((t) => t.is_active)
                          .map((t) => (
                            <option key={t.id} value={t.id}>
                              {t.name}
                            </option>
                          ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* --- Template editor modal --- */}
      {showEditor && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-2xl max-h-[85vh] flex flex-col">
            <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-200">
              <div>
                <h3 className="text-base font-bold text-slate-900">{editingId ? 'Edit Template' : 'New Template'}</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Layer 1 is checked first; once ANY ONE of a Layer's approvers approves, the request moves to
                  the next Layer. Layer 1's Approver Type defaults to Supervisor — the employee's own
                  Supervisor, resolved automatically as always — unless overridden below.
                </p>
              </div>
              <button
                onClick={() => setShowEditor(false)}
                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="p-5 overflow-y-auto flex-1 space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label className="text-xs font-semibold text-slate-600 mb-1 block">Template Name</label>
                  <input
                    type="text"
                    value={nameDraft}
                    onChange={(e) => setNameDraft(e.target.value)}
                    placeholder="e.g. Conveyance — Standard"
                    className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="text-xs font-semibold text-slate-600 mb-1 block">Request Type</label>
                  <select
                    value={typeDraft}
                    disabled={!!editingId}
                    onChange={(e) => setTypeDraft(e.target.value as ApprovalRequestType)}
                    className="w-full text-sm px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:opacity-60"
                  >
                    {REQUEST_TYPES.map((rt) => (
                      <option key={rt.key} value={rt.key}>
                        {rt.label}
                      </option>
                    ))}
                  </select>
                  {editingId && <p className="text-[11px] text-slate-400 mt-1">Can't change once created — make a new template instead.</p>}
                </div>
              </div>

              <div className="flex items-center gap-4">
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input type="checkbox" checked={isDefaultDraft} onChange={(e) => setIsDefaultDraft(e.target.checked)} className="rounded" />
                  Make this the default for this Request Type
                </label>
                <label className="flex items-center gap-2 text-xs font-semibold text-slate-600">
                  <input type="checkbox" checked={isActiveDraft} onChange={(e) => setIsActiveDraft(e.target.checked)} className="rounded" />
                  Active
                </label>
              </div>

              <div className="space-y-2">
                <label className="text-xs font-semibold text-slate-600 block">Layers</label>
                {stepsDraft.map((step, idx) => {
                  const isVirtualSupervisor = idx === 0 && step.approver_type === 'supervisor';
                  const pickerUsers = step.approver_type === 'admin' ? users.filter((u) => isAdminRole(u.role)) : users;
                  return (
                    <div
                      key={idx}
                      draggable={idx > 0}
                      onDragStart={() => idx > 0 && setDragStepIndex(idx)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => {
                        if (idx > 0 && dragStepIndex !== null && dragStepIndex !== idx) moveStep(dragStepIndex, idx);
                        setDragStepIndex(null);
                      }}
                      className="p-3 bg-slate-50 border border-slate-200 rounded-xl space-y-2"
                    >
                      <div className="flex items-center gap-2">
                        <GripVertical className={`w-4 h-4 shrink-0 ${idx > 0 ? 'text-slate-300 cursor-move' : 'text-slate-200'}`} />
                        <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                          {idx + 1}
                        </span>
                        <span className="text-xs font-semibold text-slate-700">{layerLabel(typeDraft, idx)}</span>
                        <select
                          value={step.approver_type}
                          onChange={(e) => setStepApproverType(idx, e.target.value as any)}
                          className="text-[11px] px-2 py-1 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        >
                          {idx === 0 && <option value="supervisor">Supervisor</option>}
                          <option value="employee">Employee</option>
                          <option value="admin">Admin</option>
                        </select>
                        {idx > 0 && (
                          <button
                            type="button"
                            onClick={() => removeStep(idx)}
                            className="ml-auto p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        )}
                      </div>

                      {isVirtualSupervisor ? (
                        <p className="text-[11px] text-slate-500 pl-7">
                          Automatically routes to this employee's own Supervisor — no manual pick needed. Switch
                          Approver Type above to Employee or Admin to set someone specific instead (this will
                          skip the automatic Supervisor for requests on this template).
                        </p>
                      ) : (
                        <>
                          <div className="flex flex-wrap gap-1.5 pl-7">
                            {step.approver_user_ids.length === 0 && <span className="text-[11px] text-slate-400">No approvers yet — add at least one.</span>}
                            {step.approver_user_ids.map((uid) => (
                              <span
                                key={uid}
                                className="inline-flex items-center gap-1 text-[11px] font-medium pl-2.5 pr-1 py-1 rounded-full bg-white border border-slate-200 text-slate-700"
                              >
                                {userMap.get(uid)?.name || `User #${uid}`}
                                <button type="button" onClick={() => removeApproverFromStep(idx, uid)} className="p-0.5 hover:text-rose-600">
                                  <X className="w-3 h-3" />
                                </button>
                              </span>
                            ))}
                          </div>

                          <div className="relative pl-7">
                            <input
                              type="text"
                              value={approverSearch[idx] || ''}
                              onChange={(e) => {
                                setApproverSearch((prev) => ({ ...prev, [idx]: e.target.value }));
                                setOpenApproverDropdown(idx);
                              }}
                              onFocus={() => setOpenApproverDropdown(idx)}
                              onBlur={() => setTimeout(() => setOpenApproverDropdown((cur) => (cur === idx ? null : cur)), 150)}
                              placeholder={
                                step.approver_type === 'admin'
                                  ? 'Search an Admin/Superadmin by name to add as approver…'
                                  : 'Search an employee by name to add as approver — one member per row, add the whole team to represent a Department…'
                              }
                              className="w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                            />
                            {openApproverDropdown === idx && (() => {
                              const q = (approverSearch[idx] || '').trim().toLowerCase();
                              const matches = pickerUsers
                                .filter((u) => !step.approver_user_ids.includes(u.id))
                                .filter((u) => !q || u.name.toLowerCase().includes(q))
                                .slice(0, 30);
                              return (
                                <div className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
                                  {matches.length === 0 ? (
                                    <div className="px-3 py-2 text-xs text-slate-400">No matching {step.approver_type === 'admin' ? 'Admin' : 'employee'} found.</div>
                                  ) : (
                                    matches.map((u) => (
                                      <button
                                        key={u.id}
                                        type="button"
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => addApproverToStep(idx, u.id)}
                                        className="w-full flex items-center justify-between gap-2 text-left text-xs px-3 py-2 hover:bg-blue-50 text-slate-700"
                                      >
                                        <span className="font-medium">{u.name}</span>
                                        <span className="text-slate-400">{u.role}</span>
                                      </button>
                                    ))
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                        </>
                      )}
                    </div>
                  );
                })}

                <button
                  type="button"
                  onClick={addStep}
                  className="flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-xl bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors"
                >
                  <Plus className="w-3.5 h-3.5" /> Add Layer
                </button>
              </div>

              {editorError && <p className="text-xs text-rose-600">{editorError}</p>}
            </div>

            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setShowEditor(false)}
                className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveTemplate}
                disabled={saving || !nameDraft.trim()}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
              >
                {saving ? 'Saving...' : editingId ? 'Save Changes' : 'Create Template'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
