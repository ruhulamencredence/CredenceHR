import { activePeople } from '../lib/activePeople';
import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  LayoutTemplate, Users2, Plus, Trash2, X, GripVertical, Star, StarOff, Power, AlertCircle, CheckCircle2, Pencil, ChevronUp, ChevronDown, Search, ArrowRight
} from 'lucide-react';
import { ApprovalTemplate, ApprovalTemplateStep, ApprovalRequestType, User, EXPLICIT_ONLY_LAYERS } from '../types';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { LoadingBlock } from './LoadingBlock';

import { SearchSelect } from './Combobox';
import { MultiSelectFilter } from './MultiSelectFilter';
import { personLabel, personDetails } from '../lib/personLabel';
interface ApprovalTemplateManagerProps {
  token: string;
  user: User;
  users: User[];
}

const REQUEST_TYPES: { key: ApprovalRequestType; label: string }[] = [
  { key: 'bill_claim', label: 'Bill Claim' },
  { key: 'leave', label: 'Leave Application' },
  { key: 'timesheet', label: 'Timesheet (Attendance Correction)' },
  { key: 'asset', label: 'Asset Requisition' },
  { key: 'vehicle', label: 'Vehicle Requisition' },
  { key: 'mobile', label: 'Mobile Limit Request' },
  { key: 'loan', label: 'Loan / Advance Request' }
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
  vehicle: { 1: 'Supervisor Approval', 2: 'HR/Admin Review' },
  // Mobile Bill limit raise: the requester's Supervisor, then HR.
  mobile: { 1: 'Supervisor Approval', 2: 'HR Approval' }
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
  // 'vehicle_maintainer' is only valid on a Vehicle Requisition template's
  // LAST Layer — reaching it skips the separate Approve step entirely: the
  // Vehicle Maintainer's own vehicle+driver Assign action both closes the
  // approval chain and confirms the ride in one step (see PUT
  // .../approve-and-assign in VehicleManagementRoutes.ts). Enforced
  // server-side too (validateTemplateSteps in ApprovalRoutes.ts).
  // 'asset_fulfiller' is the Asset Requisition equivalent: the LAST Layer's
  // approver fulfills/hands over the items instead of approving (PUT
  // .../approve-and-fulfill in AssetManagementRoutes.ts).
  // 'conveyance_disburser': a Conveyance template's LAST Layer pays the claim
  // out (own Bill + voucher) as it approves (performApprovalAction).
  approver_type: 'supervisor' | 'employee' | 'admin' | 'vehicle_maintainer' | 'asset_fulfiller' | 'conveyance_disburser';
  // Custom Layer name — empty means "fall back to the generic/position-based
  // name" (layerLabel() below). Travels WITH this step's own approvers when
  // dragged/moved, unlike the position-based fallback, so e.g. an Asset
  // Requisition's "Inventory/Store Disbursement" Layer keeps reading as
  // Inventory even after being moved earlier in the order.
  label: string;
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
  const [requestType, setRequestType] = useState<ApprovalRequestType>('bill_claim');

  // Every request type's templates, with their chains (?with=chain); the
  // Assign view and the editor still work on the chosen type's.
  const [allTemplates, setAllTemplates] = useState<ApprovalTemplate[]>([]);
  const templates = allTemplates.filter((t) => t.request_type === requestType);
  // Templates list: search, type chips, Group by and Sort (kept on this computer).
  const prefs = (() => {
    try {
      return JSON.parse(localStorage.getItem('chr_approval_templates_view') || '{}') || {};
    } catch {
      return {};
    }
  })();
  const [tSearch, setTSearch] = useState('');
  const [tTypes, setTTypes] = useState<string[]>([]);
  const [tGroup, setTGroup] = useState<'type' | 'approver' | 'status' | 'none'>(prefs.group || 'type');
  const [tSort, setTSort] = useState<'def' | 'name' | 'users' | 'layers' | 'recent'>(prefs.sort || 'def');
  const [hideInactive, setHideInactive] = useState<boolean>(!!prefs.hideInactive);
  const [tCollapsed, setTCollapsed] = useState<Set<string>>(new Set());
  useEffect(() => {
    try {
      localStorage.setItem('chr_approval_templates_view', JSON.stringify({ group: tGroup, sort: tSort, hideInactive }));
    } catch {
      /* not kept in a private window */
    }
  }, [tGroup, tSort, hideInactive]);
  const [loading, setLoading] = useState(false);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // --- Template editor modal ---
  const [showEditor, setShowEditor] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [nameDraft, setNameDraft] = useState('');
  const [typeDraft, setTypeDraft] = useState<ApprovalRequestType>('bill_claim');
  const [isDefaultDraft, setIsDefaultDraft] = useState(false);
  const [isActiveDraft, setIsActiveDraft] = useState(true);
  const [stepsDraft, setStepsDraft] = useState<StepDraft[]>([{ approver_user_ids: [], approver_type: 'supervisor', label: '' }]);
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
  // Assign screen filters (empty = no filter) + the template to give everyone shown
  const [fDept, setFDept] = useState<string[]>([]);
  const [fDesig, setFDesig] = useState<string[]>([]);
  const [fUser, setFUser] = useState<string[]>([]);
  const [fTemplate, setFTemplate] = useState<string[]>([]);
  const [bulkTemplate, setBulkTemplate] = useState('');
  const [bulkBusy, setBulkBusy] = useState(false);
  // Edit/Add layer of Module Access -> Approvals (the server enforces it too)
  const canAssign = isSuperAdmin || (() => {
    const saved = user.module_permission_layers?.approvals;
    return saved && saved.length > 0 ? saved.includes('edit_add') : !EXPLICIT_ONLY_LAYERS.includes('edit_add');
  })();

  const userMap = new Map<number, User>(users.map((u) => [u.id, u]));

  const fetchTemplates = async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/approval-templates?with=chain'), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) setAllTemplates(await res.json());
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
    // The Assign view's pickers need the templates too.
    fetchTemplates();
    if (subView !== 'templates') fetchAssignments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [subView, requestType]);

  const openCreateModal = () => {
    setEditingId(null);
    setNameDraft('');
    setTypeDraft(requestType);
    setIsDefaultDraft(false);
    setIsActiveDraft(true);
    setStepsDraft([{ approver_user_ids: [], approver_type: 'supervisor', label: '' }]);
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
        approver_type:
          ['admin', 'vehicle_maintainer', 'asset_fulfiller', 'conveyance_disburser'].includes((s as any).approver_type) ? (s as any).approver_type : 'employee',
        label: (s as any).label || ''
      }));
      setStepsDraft(
        data.skip_auto_supervisor
          ? persistedSteps.length
            ? persistedSteps
            : [{ approver_user_ids: [], approver_type: 'employee', label: '' }]
          : [{ approver_user_ids: [], approver_type: 'supervisor', label: '' }, ...persistedSteps]
      );
      setApproverSearch({});
      setOpenApproverDropdown(null);
      setShowEditor(true);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to load this template' });
    }
  };

  const addStep = () => setStepsDraft((prev) => [...prev, { approver_user_ids: [], approver_type: 'employee', label: '' }]);
  const setStepLabel = (stepIdx: number, label: string) =>
    setStepsDraft((prev) => prev.map((s, i) => (i === stepIdx ? { ...s, label } : s)));
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
  const setStepApproverType = (stepIdx: number, type: StepDraft['approver_type']) =>
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
        // 'vehicle_maintainer' is only valid on the LAST Layer (see
        // validateTemplateSteps in ApprovalRoutes.ts) — a Layer added or
        // moved after it since it was set no longer qualifies, so it's
        // downgraded here rather than left to fail the save.
        steps: realSteps.map((s, i) => ({
          approver_user_ids: s.approver_user_ids,
          approver_type:
            (s.approver_type === 'vehicle_maintainer' || s.approver_type === 'asset_fulfiller' || s.approver_type === 'conveyance_disburser') && i !== realSteps.length - 1
              ? 'employee'
              : s.approver_type === 'admin' || s.approver_type === 'vehicle_maintainer' || s.approver_type === 'asset_fulfiller' || s.approver_type === 'conveyance_disburser'
                ? s.approver_type
                : 'employee',
          label: s.label.trim() || undefined
        }))
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
      fetchTemplates();
      if (typeDraft !== requestType) setRequestType(typeDraft);
    } catch (err: any) {
      setEditorError(err.message || 'Failed to save this template');
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!(await confirmDialog('Delete this template? This cannot be undone.'))) return;
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

  const DEFAULT_KEY = '__default';
  // Each filter only offers what the OTHER filters still leave on screen
  // (with how many), so a combination can't end in an empty list by accident;
  // anything already ticked stays in its list so it can be unticked.
  type FKey = 'dept' | 'desig' | 'user' | 'tpl';
  const tplKey = (r: any) => (r.assigned_template_id ? String(r.assigned_template_id) : DEFAULT_KEY);
  const passes = (r: any, skip?: FKey) =>
    (skip === 'dept' || !fDept.length || fDept.includes((r.department || '').trim())) &&
    (skip === 'desig' || !fDesig.length || fDesig.includes((r.designation || '').trim())) &&
    (skip === 'user' || !fUser.length || fUser.includes(String(r.employee_user_id))) &&
    (skip === 'tpl' || !fTemplate.length || fTemplate.includes(tplKey(r)));
  const facet = (skip: FKey, keyOf: (r: any) => string, labelOf: (k: string, r: any) => string, keep: string[]) => {
    const seen = new Map<string, { label: string; count: number }>();
    for (const r of assignRows) {
      if (!passes(r, skip)) continue;
      const k = keyOf(r);
      if (!k) continue;
      const cur = seen.get(k);
      if (cur) cur.count++;
      else seen.set(k, { label: labelOf(k, r), count: 1 });
    }
    for (const k of keep) if (!seen.has(k)) {
      const r = assignRows.find((x) => keyOf(x) === k);
      seen.set(k, { label: r ? labelOf(k, r) : k, count: 0 });
    }
    return [...seen.entries()].map(([value, v]) => ({ value, label: v.label, count: v.count })).sort((x, y) => x.label.localeCompare(y.label));
  };
  const deptOptions = facet('dept', (r) => (r.department || '').trim(), (k) => k, fDept);
  const desigOptions = facet('desig', (r) => (r.designation || '').trim(), (k) => k, []);
  const userOptions = facet('user', (r) => String(r.employee_user_id), (_k, r) => [r.employee_name, r.employee_code, r.designation, r.department].filter(Boolean).join(' · '), []);
  const templateFilterOptions = facet(
    'tpl',
    tplKey,
    (k) => (k === DEFAULT_KEY ? 'Using the default' : templates.find((t) => String(t.id) === k)?.name || `Template #${k}`),
    fTemplate
  );
  // Assign view: Group by (Template / Department / Designation) and Sort.
  const [aGroup, setAGroup] = useState<'none' | 'template' | 'dept' | 'desig'>(() => {
    try {
      return (JSON.parse(localStorage.getItem('chr_approval_assign_view') || '{}') || {}).group || 'none';
    } catch {
      return 'none';
    }
  });
  const [aSort, setASort] = useState<'name' | 'id' | 'dept'>(() => {
    try {
      return (JSON.parse(localStorage.getItem('chr_approval_assign_view') || '{}') || {}).sort || 'name';
    } catch {
      return 'name';
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem('chr_approval_assign_view', JSON.stringify({ group: aGroup, sort: aSort }));
    } catch {
      /* not kept */
    }
  }, [aGroup, aSort]);
  const assignGroupOf = (r: any): string =>
    aGroup === 'template'
      ? r.assigned_template_id
        ? templates.find((t) => String(t.id) === String(r.assigned_template_id))?.name || r.effective_template_name || 'Own pick'
        : `Default${defaultTemplate ? ` — ${defaultTemplate.name}` : ' (none — auto-approve)'}`
      : aGroup === 'dept'
        ? (r.department || '').trim() || 'No department'
        : aGroup === 'desig'
          ? (r.designation || '').trim() || 'No designation'
          : '';
  const shownRows = assignRows
    .filter((r) => passes(r))
    .sort((x, y) => {
      const g = assignGroupOf(x).localeCompare(assignGroupOf(y));
      if (g) return g;
      if (aSort === 'id') return String(x.employee_code || '').localeCompare(String(y.employee_code || ''), undefined, { numeric: true });
      if (aSort === 'dept') return String(x.department || '').localeCompare(String(y.department || '')) || String(x.employee_name).localeCompare(String(y.employee_name));
      return String(x.employee_name).localeCompare(String(y.employee_name));
    });
  const assignGroupCount = new Map<string, number>();
  shownRows.forEach((r) => assignGroupCount.set(assignGroupOf(r), (assignGroupCount.get(assignGroupOf(r)) || 0) + 1));
  // Department -> Designation -> User narrow each other: picking a Department
  // drops ticked Designations / Users outside it, so the User list (and the
  // table) only ever holds people of the chosen Departments.
  const inDept = (r: any) => !fDept.length || fDept.includes((r.department || '').trim());
  const inDesig = (r: any) => !fDesig.length || fDesig.includes((r.designation || '').trim());
  useEffect(() => {
    setFDesig((cur) => {
      const next = cur.filter((v) => assignRows.some((r) => inDept(r) && (r.designation || '').trim() === v));
      return next.length === cur.length ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fDept, assignRows]);
  useEffect(() => {
    setFUser((cur) => {
      const next = cur.filter((id) => assignRows.some((r) => String(r.employee_user_id) === id && inDept(r) && inDesig(r)));
      return next.length === cur.length ? cur : next;
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fDept, fDesig, assignRows]);
  const anyFilter = fDept.length + fDesig.length + fUser.length + fTemplate.length > 0;
  const clearFilters = () => { setFDept([]); setFDesig([]); setFUser([]); setFTemplate([]); };

  const handleBulkAssign = async () => {
    if (!shownRows.length) return;
    const tpl = templates.find((t) => String(t.id) === bulkTemplate);
    const what = tpl ? `the template “${tpl.name}”` : 'the default template';
    if (!(await confirmDialog(`Assign ${what} to ${shownRows.length} employee${shownRows.length === 1 ? '' : 's'} for ${REQUEST_TYPES.find((r) => r.key === requestType)?.label}?`))) return;
    setBulkBusy(true);
    try {
      const res = await fetch(apiUrl('/api/template-assignments/bulk'), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ employee_user_ids: shownRows.map((r) => r.employee_user_id), request_type: requestType, template_id: bulkTemplate ? Number(bulkTemplate) : null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to assign');
      setMessage({ type: 'success', text: `${data.updated} employee${data.updated === 1 ? '' : 's'} assigned.` });
      fetchAssignments();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to assign' });
    } finally {
      setBulkBusy(false);
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

          {subView === 'assign' && (
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
          )}
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

      {/* --- TEMPLATES LIST --- every request type at once, each with its whole chain */}
      {subView === 'templates' && (() => {
        const typeLabel = (k: string) => REQUEST_TYPES.find((r) => r.key === k)?.label || k;
        const layersOf = (t: ApprovalTemplate) => {
          const out: { label: string; who: string }[] = [];
          if (t.uses_supervisor) out.push({ label: LAYER_NAMES[t.request_type]?.[1] || 'Supervisor', who: "Employee's own supervisor" });
          (t.chain || []).forEach((c) =>
            out.push({
              label: c.label || layerLabel(t.request_type, out.length),
              who:
                c.approver_type === 'vehicle_maintainer'
                  ? 'Vehicle maintainer'
                  : c.approver_type === 'asset_fulfiller'
                    ? 'Asset fulfiller'
                    : c.approver_type === 'conveyance_disburser'
                      ? 'Conveyance disburser'
                      : c.approvers.join(' or ') || '—'
            })
          );
          return out;
        };
        const needle = tSearch.trim().toLowerCase();
        const list = allTemplates
          .filter((t) => !tTypes.length || tTypes.includes(t.request_type))
          .filter((t) => !hideInactive || t.is_active)
          .filter((t) => !needle || [t.name, ...layersOf(t).map((l) => `${l.label} ${l.who}`)].join(' ').toLowerCase().includes(needle))
          .sort((x, y) =>
            tSort === 'name'
              ? x.name.localeCompare(y.name)
              : tSort === 'users'
                ? (y.employee_count || 0) - (x.employee_count || 0)
                : tSort === 'layers'
                  ? layersOf(y).length - layersOf(x).length
                  : tSort === 'recent'
                    ? new Date(y.updated_at || 0).getTime() - new Date(x.updated_at || 0).getTime()
                    : Number(!!y.is_default) - Number(!!x.is_default) || x.name.localeCompare(y.name)
          );
        const shownTypes = REQUEST_TYPES.filter((r) => !tTypes.length || tTypes.includes(r.key));
        const noDefault = shownTypes.filter((r) => !allTemplates.some((t) => t.request_type === r.key && t.is_default && t.is_active));
        const groupMap = new Map<string, ApprovalTemplate[]>();
        const add = (k: string, t: ApprovalTemplate) => groupMap.set(k, [...(groupMap.get(k) || []), t]);
        list.forEach((t) => {
          if (tGroup === 'type') add(typeLabel(t.request_type), t);
          else if (tGroup === 'status') add(!t.is_active ? 'Inactive' : t.is_default ? 'Default' : 'Active (not default)', t);
          else if (tGroup === 'approver') [...new Set(layersOf(t).map((l) => l.who))].forEach((w) => add(w, t));
        });
        const groups = [...groupMap.entries()].sort((x, y) =>
          tGroup === 'type'
            ? REQUEST_TYPES.findIndex((r) => r.label === x[0]) - REQUEST_TYPES.findIndex((r) => r.label === y[0])
            : y[1].length - x[1].length || x[0].localeCompare(y[0])
        );
        const ago = (iso?: string) => {
          if (!iso) return '';
          const d = Math.floor((Date.now() - new Date(iso).getTime()) / 86400000);
          return d <= 0 ? 'changed today' : d === 1 ? 'changed yesterday' : `changed ${d} days ago`;
        };
        const row = (t: ApprovalTemplate) => (
          <div key={t.id} className="grid grid-cols-1 lg:grid-cols-[minmax(170px,1fr)_minmax(0,3fr)_100px_130px_70px] gap-3 items-center px-4 sm:px-6 py-3 border-t border-slate-100 hover:bg-slate-50/60">
            <div className="min-w-0">
              <div className="font-semibold text-slate-900 text-sm">{t.name}</div>
              <div className="text-[11px] text-slate-500">{typeLabel(t.request_type)}{t.updated_at ? ` · ${ago(t.updated_at)}` : ''}</div>
            </div>
            <div className="flex flex-wrap items-center gap-1 min-w-0">
              {layersOf(t).map((l, i) => (
                <React.Fragment key={i}>
                  {i > 0 && <ArrowRight className="w-3 h-3 text-slate-300 shrink-0" />}
                  <span className="inline-flex items-center gap-1.5 max-w-full rounded-lg border border-slate-200 bg-slate-50 pl-1 pr-2 py-1 text-[11px]">
                    <span className="w-4 h-4 rounded-full bg-sky-600 text-white text-[9px] font-bold flex items-center justify-center shrink-0">{i + 1}</span>
                    <span className="min-w-0">
                      <span className="block font-semibold text-slate-700 truncate">{l.label}</span>
                      <span className="block text-[10px] text-slate-500 truncate">{l.who}</span>
                    </span>
                  </span>
                </React.Fragment>
              ))}
            </div>
            <div className="text-xs tabular-nums">
              {t.employee_count ? (
                <>
                  <span className="text-base font-bold text-slate-900">{t.employee_count}</span> <span className="text-slate-500">employees</span>
                </>
              ) : (
                <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">Not used by anyone</span>
              )}
            </div>
            <div className="flex flex-wrap gap-1">
              {isSuperAdmin ? (
                <button
                  type="button"
                  onClick={() => handleToggleDefault(t)}
                  className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${t.is_default ? 'bg-amber-50 text-amber-700' : 'bg-slate-100 text-slate-400 hover:text-slate-600'}`}
                >
                  {t.is_default ? <Star className="w-3 h-3" /> : <StarOff className="w-3 h-3" />} {t.is_default ? 'Default' : 'Make default'}
                </button>
              ) : (
                t.is_default && <span className="inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700"><Star className="w-3 h-3" /> Default</span>
              )}
              {isSuperAdmin ? (
                <button
                  type="button"
                  onClick={() => handleToggleActive(t)}
                  className={`inline-flex items-center gap-1 text-[11px] font-semibold px-2 py-0.5 rounded-full ${t.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}
                >
                  <Power className="w-3 h-3" /> {t.is_active ? 'Active' : 'Inactive'}
                </button>
              ) : (
                <span className={`text-[11px] font-semibold px-2 py-0.5 rounded-full ${t.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>{t.is_active ? 'Active' : 'Inactive'}</span>
              )}
            </div>
            <div className="flex lg:justify-end gap-1">
              {isSuperAdmin && (
                <>
                  <button type="button" onClick={() => openEditModal(t.id)} aria-label={`Edit ${t.name}`} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg">
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button type="button" onClick={() => handleDelete(t.id)} aria-label={`Delete ${t.name}`} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </>
              )}
            </div>
          </div>
        );
        return (
          <div>
            <div className="px-4 sm:px-6 pt-4 flex flex-col gap-2.5">
              <div className="flex flex-wrap items-center gap-2">
                <label className="flex items-center gap-2 flex-1 min-w-[220px] bg-slate-50 border border-slate-200 rounded-xl px-3 py-2">
                  <Search className="w-3.5 h-3.5 text-slate-400" />
                  <input value={tSearch} onChange={(e) => setTSearch(e.target.value)} placeholder="Search a template name or an approver's name" aria-label="Search templates" className="bg-transparent text-xs outline-none flex-1 min-w-0" />
                </label>
                <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                  Group by
                  <select value={tGroup} onChange={(e) => setTGroup(e.target.value as any)} className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl">
                    <option value="type">Request type</option>
                    <option value="approver">Approver (who is in the chain)</option>
                    <option value="status">Default / Active / Inactive</option>
                    <option value="none">No grouping</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                  Sort
                  <select value={tSort} onChange={(e) => setTSort(e.target.value as any)} className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl">
                    <option value="def">Default first, then name</option>
                    <option value="name">Name A–Z</option>
                    <option value="users">Most employees</option>
                    <option value="layers">Most layers</option>
                    <option value="recent">Recently changed</option>
                  </select>
                </label>
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" checked={hideInactive} onChange={(e) => setHideInactive(e.target.checked)} className="rounded" /> Hide inactive
                </label>
              </div>
              <div className="flex flex-wrap gap-1.5" role="group" aria-label="Request type">
                {[{ key: '', label: 'All types' }, ...REQUEST_TYPES].map((r) => {
                  const n = r.key ? allTemplates.filter((t) => t.request_type === r.key).length : allTemplates.length;
                  const on = r.key ? tTypes.includes(r.key) : tTypes.length === 0;
                  return (
                    <button
                      key={r.key || 'all'}
                      type="button"
                      aria-pressed={on}
                      onClick={() => setTTypes((prev) => (!r.key ? [] : prev.includes(r.key) ? prev.filter((x) => x !== r.key) : [...prev, r.key]))}
                      className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border ${on ? 'bg-[color:var(--g-accent,#ea580c)] border-[color:var(--g-accent,#ea580c)] text-white' : 'bg-white border-slate-200 text-slate-700 hover:bg-slate-50'}`}
                    >
                      {r.label}
                      <span className={`text-[10px] px-1.5 rounded-full ${on ? 'bg-white/25' : 'bg-slate-100 text-slate-500'}`}>{n}</span>
                    </button>
                  );
                })}
              </div>
            </div>
            <div className="mt-3 flex flex-wrap gap-x-5 gap-y-1 px-4 sm:px-6 py-2 bg-slate-50 border-y border-slate-200 text-xs text-slate-500">
              <span><b className="text-slate-900">{list.length}</b> templates</span>
              <span>Not used by anyone <b className="text-rose-600">{list.filter((t) => !t.employee_count).length}</b></span>
              <span>Inactive <b className="text-slate-900">{list.filter((t) => !t.is_active).length}</b></span>
            </div>
            {noDefault.length > 0 && !loading && (
              <div className="mx-4 sm:mx-6 mt-3 flex items-start gap-2 rounded-xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-800">
                <AlertCircle className="w-3.5 h-3.5 mt-0.5 shrink-0" />
                <span>{noDefault.map((r) => r.label).join(', ')} {noDefault.length === 1 ? 'has' : 'have'} no active default template — anyone without a pick is auto-approved.</span>
              </div>
            )}
            {loading ? (
              <LoadingBlock />
            ) : list.length === 0 ? (
              <div className="p-10 text-center text-sm text-slate-400">
                {allTemplates.length === 0 ? (isSuperAdmin ? 'No templates yet. Tap "New Template" to build one.' : 'No templates yet. Ask your Superadmin to build one.') : 'No template matches.'}
              </div>
            ) : tGroup === 'none' ? (
              <div className="mt-2">{list.map(row)}</div>
            ) : (
              <div className="mt-2">
                {groups.map(([k, l]) => {
                  const open = !tCollapsed.has(k);
                  const users = l.reduce((n, t) => n + (t.employee_count || 0), 0);
                  const def = tGroup === 'type' ? l.find((t) => t.is_default && t.is_active) : undefined;
                  return (
                    <div key={k} className="border-t border-slate-200">
                      <button
                        type="button"
                        aria-expanded={open}
                        onClick={() =>
                          setTCollapsed((prev) => {
                            const next = new Set(prev);
                            if (next.has(k)) next.delete(k);
                            else next.add(k);
                            return next;
                          })
                        }
                        className="w-full flex flex-wrap items-center gap-2 px-4 sm:px-6 py-2.5 text-left hover:bg-slate-50"
                      >
                        <ChevronDown className={`w-4 h-4 text-slate-400 transition-transform ${open ? '' : '-rotate-90'}`} />
                        <span className="text-sm font-bold text-slate-900">{k}</span>
                        <span className="text-xs text-slate-500">{l.length} template{l.length === 1 ? '' : 's'}</span>
                        <span className="ml-auto flex flex-wrap gap-1.5">
                          {tGroup === 'type' &&
                            (def ? (
                              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">★ {def.name}</span>
                            ) : (
                              <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-rose-50 text-rose-700">No default</span>
                            ))}
                          {tGroup !== 'approver' && <span className="text-[11px] font-semibold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700">{users} employees</span>}
                        </span>
                      </button>
                      {open && l.map(row)}
                    </div>
                  );
                })}
              </div>
            )}
          </div>
        );
      })()}

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
          {!assignLoading && (
            <div className="px-4 pt-3 flex flex-wrap items-center gap-2">
              <MultiSelectFilter label="Department" options={deptOptions} selected={fDept} onChange={setFDept} />
              <MultiSelectFilter label="Designation" options={desigOptions} selected={fDesig} onChange={setFDesig} />
              <MultiSelectFilter label="User" options={userOptions} selected={fUser} onChange={setFUser} width={360} />
              <MultiSelectFilter label="Template" options={templateFilterOptions} selected={fTemplate} onChange={setFTemplate} />
              {anyFilter && (
                <button type="button" onClick={clearFilters} className="text-xs font-semibold text-slate-500 hover:underline">Clear filters</button>
              )}
              <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                Group by
                <select value={aGroup} onChange={(e) => setAGroup(e.target.value as any)} className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl">
                  <option value="none">No grouping</option>
                  <option value="template">Template</option>
                  <option value="dept">Department</option>
                  <option value="desig">Designation</option>
                </select>
              </label>
              <label className="flex items-center gap-1.5 text-[11px] font-semibold text-slate-500">
                Sort
                <select value={aSort} onChange={(e) => setASort(e.target.value as any)} className="text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl">
                  <option value="name">Name A–Z</option>
                  <option value="id">Employee ID</option>
                  <option value="dept">Department</option>
                </select>
              </label>
              <span className="text-[11px] text-slate-500 ml-auto">Showing {shownRows.length} of {assignRows.length}</span>
            </div>
          )}
          {!assignLoading && canAssign && (
            <div className="px-4 pt-3 flex flex-wrap items-center gap-2">
              <span className="text-xs font-semibold text-slate-600">Give everyone shown:</span>
              <SearchSelect
                value={bulkTemplate}
                onChange={(e) => setBulkTemplate(e.target.value)}
                className="w-64 text-xs px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
              >
                <option value="">{defaultTemplate ? `Use default (${defaultTemplate.name})` : 'Use default (none — auto-approve)'}</option>
                {templates.filter((t) => t.is_active).map((t) => (
                  <option key={t.id} value={t.id}>{t.name}</option>
                ))}
              </SearchSelect>
              <button
                type="button"
                onClick={handleBulkAssign}
                disabled={bulkBusy || shownRows.length === 0}
                className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-50"
              >
                <CheckCircle2 className="w-3.5 h-3.5" /> {bulkBusy ? 'Assigning…' : `Assign (${shownRows.length})`}
              </button>
            </div>
          )}
          {assignLoading ? (
            <LoadingBlock />
          ) : (
            <table className="w-full text-sm mt-2">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wider text-slate-500">
                <tr>
                  <th className="text-left px-4 py-3 font-semibold">Employee</th>
                  <th className="text-left px-4 py-3 font-semibold">Assigned Template</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shownRows.length === 0 && (
                  <tr>
                    <td colSpan={2} className="px-4 py-14 text-center">
                      <Users2 className="w-8 h-8 mx-auto text-slate-300" />
                      <div className="mt-2 text-sm font-semibold text-slate-700">
                        {assignRows.length === 0 ? 'No employee accounts yet' : 'No employee matches these filters'}
                      </div>
                      {anyFilter && (
                        <>
                          <div className="mt-1 text-xs text-slate-500">Change a filter above, or show everyone again.</div>
                          <button type="button" onClick={clearFilters} className="mt-3 px-4 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
                            Clear filters
                          </button>
                        </>
                      )}
                    </td>
                  </tr>
                )}
                {shownRows.map((row, i) => (
                  <React.Fragment key={row.employee_user_id}>
                  {aGroup !== 'none' && (i === 0 || assignGroupOf(shownRows[i - 1]) !== assignGroupOf(row)) && (
                    <tr className="bg-slate-50">
                      <td colSpan={2} className="px-4 py-2 text-xs font-bold text-slate-800">
                        {assignGroupOf(row)} <span className="font-normal text-slate-500">· {assignGroupCount.get(assignGroupOf(row))} employee{assignGroupCount.get(assignGroupOf(row)) === 1 ? '' : 's'}</span>
                      </td>
                    </tr>
                  )}
                  <tr className="hover:bg-slate-50/60">
                    <td className="px-4 py-3">
                      <div className="font-medium text-slate-900">{row.employee_name}</div>
                      <div className="text-[11px] text-slate-500">
                        {[row.employee_role, row.employee_code, row.designation, row.department].filter(Boolean).join(' · ')}
                      </div>
                    </td>
                    <td className="px-4 py-3">
                      <SearchSelect
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
                      </SearchSelect>
                    </td>
                  </tr>
                  </React.Fragment>
                ))}
              </tbody>
            </table>
          )}
        </div>
      )}

      {/* --- Template editor modal --- */}
      {showEditor && (
        createPortal(
        <div className="liquid-glass-backdrop fixed inset-0 z-[1300] flex items-center justify-center p-4">
          <div className="liquid-glass liquid-glass-in rounded-[32px] w-full max-w-2xl max-h-[88vh] flex flex-col overflow-hidden">
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
                  const pickerUsers = activePeople(
                    step.approver_type === 'admin' ? users.filter((u) => isAdminRole(u.role)) : users,
                    ...step.approver_user_ids
                  );
                  const isLastLayer = idx === stepsDraft.length - 1;
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
                        <GripVertical className={`w-4 h-4 shrink-0 hidden sm:block ${idx > 0 ? 'text-slate-300 cursor-move' : 'text-slate-200'}`} />
                        {/* Up/Down move buttons — the drag handle above only
                            works with a mouse (native HTML5 drag-and-drop
                            doesn't fire on touch), so this is the reliable way
                            to reorder Layers on mobile; kept visible on
                            desktop too as a precise alternative to dragging. */}
                        {idx > 0 && (
                          <div className="flex flex-col shrink-0">
                            <button
                              type="button"
                              onClick={() => moveStep(idx, idx - 1)}
                              disabled={idx === 1}
                              title="Move up"
                              aria-label="Move layer up"
                              className="p-0.5 text-slate-400 hover:text-blue-600 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                            >
                              <ChevronUp className="w-3.5 h-3.5" />
                            </button>
                            <button
                              type="button"
                              onClick={() => moveStep(idx, idx + 1)}
                              disabled={idx === stepsDraft.length - 1}
                              title="Move down"
                              aria-label="Move layer down"
                              className="p-0.5 text-slate-400 hover:text-blue-600 disabled:opacity-30 disabled:hover:text-slate-400 transition-colors"
                            >
                              <ChevronDown className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        )}
                        <span className="w-5 h-5 rounded-full bg-blue-600 text-white text-[10px] font-bold flex items-center justify-center shrink-0">
                          {idx + 1}
                        </span>
                        {isVirtualSupervisor ? (
                          <span className="text-xs font-semibold text-slate-700">{layerLabel(typeDraft, idx)}</span>
                        ) : (
                          <input
                            type="text"
                            value={step.label}
                            onChange={(e) => setStepLabel(idx, e.target.value)}
                            placeholder={layerLabel(typeDraft, idx)}
                            title="Custom Layer name — stays with this Layer's approvers even after it's moved/reordered"
                            className="text-xs font-semibold text-slate-700 bg-transparent border-b border-dashed border-slate-300 focus:border-blue-500 focus:outline-none px-0.5 w-40"
                          />
                        )}
                        {step.approver_type !== 'vehicle_maintainer' && step.approver_type !== 'asset_fulfiller' && step.approver_type !== 'conveyance_disburser' && (
                          <select
                            value={step.approver_type}
                            onChange={(e) => setStepApproverType(idx, e.target.value as any)}
                            className="text-[11px] px-2 py-1 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          >
                            {idx === 0 && <option value="supervisor">Supervisor</option>}
                            <option value="employee">Employee</option>
                            <option value="admin">Admin</option>
                          </select>
                        )}
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
                          {typeDraft === 'vehicle' && isLastLayer && (
                            <label className="flex items-start gap-2 pl-7 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={step.approver_type === 'vehicle_maintainer'}
                                onChange={(e) => setStepApproverType(idx, e.target.checked ? 'vehicle_maintainer' : 'employee')}
                                className="mt-0.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600"
                              />
                              <span className="text-[11px] text-slate-600">
                                <span className="font-semibold text-slate-700">Vehicle Maintainer (Ride Bypass)</span> — the
                                employees picked here get Vehicle Maintainer access automatically, and instead of
                                Approve/Reject they assign the vehicle &amp; driver, which approves and confirms the ride
                                in one step.
                              </span>
                            </label>
                          )}
                          {typeDraft === 'asset' && isLastLayer && (
                            <label className="flex items-start gap-2 pl-7 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={step.approver_type === 'asset_fulfiller'}
                                onChange={(e) => setStepApproverType(idx, e.target.checked ? 'asset_fulfiller' : 'employee')}
                                className="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-600"
                              />
                              <span className="text-[11px] text-slate-600">
                                <span className="font-semibold text-slate-700">Asset Fulfiller (Hand Over)</span> — the
                                people picked here get an alert when a requisition reaches this Layer, and on Pending
                                Approvals they get <span className="font-semibold">Fulfill &amp; Hand Over</span> instead of
                                Approve/Reject: they type what they're handing over, the employee is notified to confirm
                                it in My Asset, or report an issue if something is wrong.
                              </span>
                            </label>
                          )}
                          {typeDraft === 'bill_claim' && isLastLayer && (
                            <label className="flex items-start gap-2 pl-7 cursor-pointer">
                              <input
                                type="checkbox"
                                checked={step.approver_type === 'conveyance_disburser'}
                                onChange={(e) => setStepApproverType(idx, e.target.checked ? 'conveyance_disburser' : 'employee')}
                                className="mt-0.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-600"
                              />
                              <span className="text-[11px] text-slate-600">
                                <span className="font-semibold text-slate-700">Conveyance Disburser (Pay Out)</span> — the
                                people picked here get an alert when a claim reaches this Layer, and on Pending Approvals
                                they get <span className="font-semibold">Disburse</span> instead of Approve: the claim is
                                approved, put on its own Bill and marked paid with a voucher number in one step, and the
                                employee is told it has been disbursed.
                              </span>
                            </label>
                          )}
                          <div className="flex flex-wrap gap-1.5 pl-7">
                            {step.approver_user_ids.length === 0 && <span className="text-[11px] text-slate-400">No approvers yet — add at least one.</span>}
                            {step.approver_user_ids.map((uid) => (
                              <span
                                key={uid}
                                className="inline-flex items-center gap-1 text-[11px] font-medium pl-2.5 pr-1 py-1 rounded-full bg-white border border-slate-200 text-slate-700"
                              >
                                {userMap.get(uid)?.name || `User #${uid}`}
                                {userMap.get(uid)?.employee_code ? <span className="text-slate-400">· {userMap.get(uid)?.employee_code}</span> : null}
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
                                  ? 'Search an Admin/Superadmin by name or ID to add as approver…'
                                  : step.approver_type === 'vehicle_maintainer'
                                    ? 'Search a Vehicle Maintainer by name or ID to add as approver…'
                                    : step.approver_type === 'asset_fulfiller'
                                      ? 'Search who hands over the assets (store/inventory) by name or ID…'
                                    : step.approver_type === 'conveyance_disburser'
                                      ? 'Search who pays out conveyance (accounts/cash) by name or ID…'
                                    : 'Search an employee by name or ID to add as approver — one member per row, add the whole team to represent a Department…'
                              }
                              className="w-full text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                            />
                            {openApproverDropdown === idx && (() => {
                              const q = (approverSearch[idx] || '').trim().toLowerCase();
                              const matches = pickerUsers
                                .filter((u) => !step.approver_user_ids.includes(u.id))
                                .filter((u) => !q || personLabel(u).toLowerCase().includes(q) || String(u.email || '').toLowerCase().includes(q))
                                .slice(0, 30);
                              return (
                                <div className="absolute z-20 left-0 right-0 mt-1 max-h-56 overflow-y-auto bg-white border border-slate-200 rounded-lg shadow-lg">
                                  {matches.length === 0 ? (
                                    <div className="px-3 py-2 text-xs text-slate-400">
                                      No matching {step.approver_type === 'admin' ? 'Admin' : step.approver_type === 'vehicle_maintainer' ? 'Vehicle Maintainer' : 'employee'} found.
                                    </div>
                                  ) : (
                                    matches.map((u) => (
                                      <button
                                        key={u.id}
                                        type="button"
                                        onMouseDown={(e) => e.preventDefault()}
                                        onClick={() => addApproverToStep(idx, u.id)}
                                        className="w-full flex items-center justify-between gap-2 text-left text-xs px-3 py-2 hover:bg-blue-50 text-slate-700"
                                      >
                                        <span className="min-w-0">
                                          <span className="font-medium">{u.name}</span>
                                          {personDetails(u) && <span className="block text-[10px] text-slate-500 truncate">{personDetails(u)}</span>}
                                        </span>
                                        <span className="text-slate-400 shrink-0">{u.role}</span>
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
        </div>,
        document.body
      )
      )}
    </div>
  );
};
