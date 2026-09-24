import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Contact, Plus, Trash2, Edit2, X, Search, Eye, EyeOff, Mail, Phone, Briefcase, Building2, KeyRound, ShieldCheck,
  FolderKanban, LayoutGrid, UserCircle2, ClipboardList, MapPin, Users2, Star, Link2, ArrowLeftRight, History, ArrowRight,
  Landmark
} from 'lucide-react';
import { Employee, EmployeeSupervisor, EmployeePaymentAccount, EmployeeTransfer, User, Project, Department, Branch, AdminModuleKey, ADMIN_MODULES } from '../types';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

// Add/Edit Employee modal tabs — Basic + Employee Info fields live under
// "info", the rest mirror the reference HR system's own tab split (Status /
// Contact / Supervisor), just restyled to this app's own design. "payment"
// (Bank/MFS payroll disbursement split) is this app's own addition, not part
// of that reference split.
type EmployeeFormTab = 'info' | 'status' | 'contact' | 'supervisor' | 'payment';

const FORM_TABS: { key: EmployeeFormTab; label: string; icon: React.ReactNode }[] = [
  { key: 'info', label: 'Employee Info', icon: <UserCircle2 className="w-3.5 h-3.5" /> },
  { key: 'status', label: 'Status', icon: <ClipboardList className="w-3.5 h-3.5" /> },
  { key: 'contact', label: 'Contact', icon: <MapPin className="w-3.5 h-3.5" /> },
  { key: 'supervisor', label: 'Supervisor', icon: <Users2 className="w-3.5 h-3.5" /> },
  { key: 'payment', label: 'Payment', icon: <Landmark className="w-3.5 h-3.5" /> }
];

interface EmployeesPanelProps {
  token: string;
  user: User;
}

interface EmployeeFormState {
  employee_id: string;
  name: string;
  designation: string;
  department: string;
  // The structured Department (Admin Panel -> Departments) this Employee is
  // linked to — the Department dropdown writes here; department (above)
  // stays only as the legacy free-text mirror the backend fills in from it.
  department_id: number | null;
  // The structured Branch (Admin Panel -> Branches) this Employee is linked
  // to — the Branch dropdown writes here; branch (below) stays only as the
  // legacy free-text mirror kept in sync when a real Branch is picked.
  branch_id: number | null;
  email: string;
  phone: string;
  is_active: boolean;
  // "Also create a login account" — only offered on the New Employee form (an
  // existing row that still has none gets the same option later via the
  // per-row "Create Login" action further down instead, since editing goes
  // through PUT /api/employees/:id, which never touches users).
  create_login: boolean;
  login_username: string;
  login_password: string;
  // Project Access / Module Access to grant the new login the moment it's
  // created — sent alongside create_login (see login_project_ids/
  // login_module_keys on POST /api/employees). Module Access is Superadmin-
  // only, same gate PUT /api/users/:id/module-permissions enforces.
  login_project_ids: number[];
  login_module_keys: AdminModuleKey[];

  // --- Employee Info tab ---
  middle_name: string;
  gender: string;
  date_of_birth: string;
  nid_ssn: string;
  nationality: string;
  marital_status: string;
  blood_group: string;
  religion: string;
  is_foreigner: boolean;

  // --- Status tab ---
  division: string;
  branch: string;
  unit: string;
  status_effective_date: string;
  job_status: string;
  job_status_effective_date: string;
  job_base: string;
  job_base_effective_date: string;
  review_month: string;
  employment_category: string;
  employment_category_effective_date: string;
  designation_effective_date: string;

  // --- Contact tab ---
  mobile: string;
  telephone: string;
  personal_email: string;
  present_address: string;
  present_country: string;
  present_state: string;
  present_city: string;
  present_zip: string;
  permanent_address: string;
  permanent_country: string;
  permanent_state: string;
  permanent_city: string;
  permanent_zip: string;
}

const emptyForm: EmployeeFormState = {
  employee_id: '',
  name: '',
  designation: '',
  department: '',
  department_id: null,
  branch_id: null,
  email: '',
  phone: '',
  is_active: true,
  create_login: false,
  login_username: '',
  login_password: '',
  login_project_ids: [],
  login_module_keys: [],

  middle_name: '',
  gender: '',
  date_of_birth: '',
  nid_ssn: '',
  nationality: '',
  marital_status: '',
  blood_group: '',
  religion: '',
  is_foreigner: false,

  division: '',
  branch: '',
  unit: '',
  status_effective_date: '',
  job_status: '',
  job_status_effective_date: '',
  job_base: '',
  job_base_effective_date: '',
  review_month: '',
  employment_category: '',
  employment_category_effective_date: '',
  designation_effective_date: '',

  mobile: '',
  telephone: '',
  personal_email: '',
  present_address: '',
  present_country: '',
  present_state: '',
  present_city: '',
  present_zip: '',
  permanent_address: '',
  permanent_country: '',
  permanent_state: '',
  permanent_city: '',
  permanent_zip: ''
};

const GENDER_OPTIONS = ['Male', 'Female', 'Other'];
const MARITAL_STATUS_OPTIONS = ['Single', 'Married', 'Divorced', 'Widowed'];
const BLOOD_GROUP_OPTIONS = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];
const JOB_STATUS_OPTIONS = ['Active', 'Inactive', 'On Leave', 'Resigned', 'Terminated'];
const JOB_BASE_OPTIONS = ['Permanent', 'Probation', 'Contractual', 'Intern'];
const EMPLOYMENT_CATEGORY_OPTIONS = ['Management', 'Non-Management'];
const REVIEW_MONTH_OPTIONS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December'
];

// "Create Login" modal state — opened from an existing Employee row that has
// no linked user_id yet (see POST /api/employees/:id/create-login).
interface LoginFormState {
  login_username: string;
  login_password: string;
  login_project_ids: number[];
  login_module_keys: AdminModuleKey[];
}

const emptyLoginForm: LoginFormState = { login_username: '', login_password: '', login_project_ids: [], login_module_keys: [] };

// Supervisor tab's own small "add/edit one row" form — always picks the
// Supervisor from the same Employee list via a dropdown (supervisor_id),
// never a typed name. See /api/employees/:id/supervisors.
interface SupervisorFormState {
  supervisor_id: string;
  effective_date: string;
  is_direct: boolean;
}

const emptySupervisorForm: SupervisorFormState = { supervisor_id: '', effective_date: '', is_direct: false };

// Payment tab's own small "add/edit one row" form — see
// /api/employees/:id/payment-accounts. bank_name/branch_name apply to
// account_type 'bank'; provider applies to 'mfs' (bKash/Nagad/Rocket/…).
interface PaymentAccountFormState {
  account_type: 'bank' | 'mfs';
  account_label: string;
  bank_name: string;
  branch_name: string;
  provider: string;
  account_number: string;
  percentage: string;
}

const emptyPaymentAccountForm: PaymentAccountFormState = {
  account_type: 'bank',
  account_label: '',
  bank_name: '',
  branch_name: '',
  provider: '',
  account_number: '',
  percentage: ''
};

const MFS_PROVIDERS = ['bKash', 'Nagad', 'Rocket', 'Upay', 'SureCash'];

// "Transfer / Change Role" modal form (Admin Panel -> Employees -> row
// action) — POST /api/employees/:id/transfer. New Department/New Supervisor
// left blank means "keep as-is"; only New Designation and Effective Date are
// required, matching the reference HR workflow's own Modal (New Department /
// New Designation / New Supervisor / Effective Date / Remarks).
interface TransferFormState {
  to_department_id: string;
  to_designation: string;
  to_supervisor_id: string;
  effective_date: string;
  reason: string;
}

const emptyTransferForm: TransferFormState = {
  to_department_id: '',
  to_designation: '',
  to_supervisor_id: '',
  effective_date: '',
  reason: ''
};

export const EmployeesPanel: React.FC<EmployeesPanelProps> = ({ token, user }) => {
  const [employees, setEmployees] = useState<Employee[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [search, setSearch] = useState('');

  // Project list for the Project Access checklist offered alongside "create a
  // login" — same source Admin Panel -> Users' own Project Access modal uses.
  const [projects, setProjects] = useState<Project[]>([]);
  // Department dropdown (Admin Panel -> Departments) — GET /api/departments is
  // open to any signed-in account, so this loads regardless of whether this
  // account has the separate "departments" module itself.
  const [departments, setDepartments] = useState<Department[]>([]);
  // Branch dropdown (Admin Panel -> Branches) — GET /api/branches is open to
  // any signed-in account, same reasoning as departments above.
  const [branches, setBranches] = useState<Branch[]>([]);
  const isSuperAdmin = user?.role === 'superadmin';

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<EmployeeFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [formTab, setFormTab] = useState<EmployeeFormTab>('info');

  // Supervisor tab — loaded on demand for the employee currently being
  // edited (a brand-new, not-yet-saved employee has no id yet, so the tab
  // asks the admin to save the employee first).
  const [supervisors, setSupervisors] = useState<EmployeeSupervisor[]>([]);
  const [loadingSupervisors, setLoadingSupervisors] = useState(false);
  const [supervisorForm, setSupervisorForm] = useState<SupervisorFormState>(emptySupervisorForm);
  const [editingSupervisorRowId, setEditingSupervisorRowId] = useState<number | null>(null);
  const [savingSupervisor, setSavingSupervisor] = useState(false);

  // Payment tab — same "loaded on demand for the employee currently being
  // edited" shape as Supervisor above.
  const [paymentAccounts, setPaymentAccounts] = useState<EmployeePaymentAccount[]>([]);
  const [loadingPaymentAccounts, setLoadingPaymentAccounts] = useState(false);
  const [paymentAccountForm, setPaymentAccountForm] = useState<PaymentAccountFormState>(emptyPaymentAccountForm);
  const [editingPaymentAccountRowId, setEditingPaymentAccountRowId] = useState<number | null>(null);
  const [savingPaymentAccount, setSavingPaymentAccount] = useState(false);
  const [paymentAccountError, setPaymentAccountError] = useState<string | null>(null);

  // "Create Login" modal — for an existing Employee row that has no linked
  // user_id yet. Separate from the New Employee form's own create_login
  // checkbox above; this covers every employee added before that checkbox
  // existed, or added without ticking it at the time.
  const [creatingLoginFor, setCreatingLoginFor] = useState<Employee | null>(null);
  const [loginForm, setLoginForm] = useState<LoginFormState>(emptyLoginForm);
  const [creatingLogin, setCreatingLogin] = useState(false);

  // "Link Existing User" modal — the reverse case: a login account already
  // exists (created before this Employee row, or on its own) and just needs
  // pointing at this Employee instead of a brand-new account being made for
  // them (see PUT /api/employees/:id/link-user).
  const [linkingUserFor, setLinkingUserFor] = useState<Employee | null>(null);
  const [unlinkedUsers, setUnlinkedUsers] = useState<{ id: number; name: string; email: string | null; username: string | null; role: string }[]>([]);
  const [loadingUnlinkedUsers, setLoadingUnlinkedUsers] = useState(false);
  const [linkUserSearch, setLinkUserSearch] = useState('');
  const [selectedLinkUserId, setSelectedLinkUserId] = useState<number | null>(null);
  const [linkingUser, setLinkingUser] = useState(false);
  const [unlinkingId, setUnlinkingId] = useState<number | null>(null);

  // "Transfer / Change Role" modal — Department/Designation/Supervisor
  // change with history, kept as its own row-action modal (not a tab on the
  // Add/Edit form) since it's an action taken on an already-saved Employee,
  // not a field edit — see EmployeeTransferRoutes.ts.
  const [transferringFor, setTransferringFor] = useState<Employee | null>(null);
  const [transferForm, setTransferForm] = useState<TransferFormState>(emptyTransferForm);
  const [savingTransfer, setSavingTransfer] = useState(false);
  const [transferHistory, setTransferHistory] = useState<EmployeeTransfer[]>([]);
  const [loadingTransferHistory, setLoadingTransferHistory] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const toggleFormProject = (projectId: number) => {
    setForm((f) => ({
      ...f,
      login_project_ids: f.login_project_ids.includes(projectId)
        ? f.login_project_ids.filter((id) => id !== projectId)
        : [...f.login_project_ids, projectId]
    }));
  };

  const toggleFormModule = (moduleKey: AdminModuleKey) => {
    setForm((f) => ({
      ...f,
      login_module_keys: f.login_module_keys.includes(moduleKey)
        ? f.login_module_keys.filter((k) => k !== moduleKey)
        : [...f.login_module_keys, moduleKey]
    }));
  };

  const toggleLoginFormProject = (projectId: number) => {
    setLoginForm((f) => ({
      ...f,
      login_project_ids: f.login_project_ids.includes(projectId)
        ? f.login_project_ids.filter((id) => id !== projectId)
        : [...f.login_project_ids, projectId]
    }));
  };

  const toggleLoginFormModule = (moduleKey: AdminModuleKey) => {
    setLoginForm((f) => ({
      ...f,
      login_module_keys: f.login_module_keys.includes(moduleKey)
        ? f.login_module_keys.filter((k) => k !== moduleKey)
        : [...f.login_module_keys, moduleKey]
    }));
  };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [empRes, projRes, deptRes, branchRes] = await Promise.all([
        fetch(apiUrl('/api/employees'), { headers: authHeaders }),
        fetch(apiUrl('/api/projects'), { headers: authHeaders }),
        fetch(apiUrl('/api/departments'), { headers: authHeaders }),
        fetch(apiUrl('/api/branches'), { headers: authHeaders })
      ]);
      if (empRes.ok) setEmployees(await empRes.json());
      if (projRes.ok) setProjects(await projRes.json());
      if (deptRes.ok) setDepartments(await deptRes.json());
      if (branchRes.ok) setBranches(await branchRes.json());
    } catch {
      setMessage({ type: 'error', text: "Couldn't reach the server. Please try again." });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  // A DATE column can come back as a full ISO timestamp depending on the
  // driver — trim to the plain 'YYYY-MM-DD' an <input type="date"> expects.
  const toDateInput = (v: string | null | undefined) => (v ? String(v).slice(0, 10) : '');

  const openCreateForm = () => {
    setEditingId(null);
    setForm(emptyForm);
    setFormTab('info');
    setSupervisors([]);
    setSupervisorForm(emptySupervisorForm);
    setEditingSupervisorRowId(null);
    setPaymentAccounts([]);
    setPaymentAccountForm(emptyPaymentAccountForm);
    setEditingPaymentAccountRowId(null);
    setPaymentAccountError(null);
    setShowForm(true);
  };

  const openEditForm = (e: Employee) => {
    setEditingId(e.id);
    setForm({
      employee_id: e.employee_id || '',
      name: e.name || '',
      designation: e.designation || '',
      department: e.department || '',
      department_id: e.department_id ?? null,
      branch_id: e.branch_id ?? null,
      email: e.email || '',
      phone: e.phone || '',
      is_active: e.is_active,
      create_login: false,
      login_username: '',
      login_password: '',
      login_project_ids: [],
      login_module_keys: [],

      middle_name: e.middle_name || '',
      gender: e.gender || '',
      date_of_birth: toDateInput(e.date_of_birth),
      nid_ssn: e.nid_ssn || '',
      nationality: e.nationality || '',
      marital_status: e.marital_status || '',
      blood_group: e.blood_group || '',
      religion: e.religion || '',
      is_foreigner: !!e.is_foreigner,

      division: e.division || '',
      branch: e.branch || '',
      unit: e.unit || '',
      status_effective_date: toDateInput(e.status_effective_date),
      job_status: e.job_status || '',
      job_status_effective_date: toDateInput(e.job_status_effective_date),
      job_base: e.job_base || '',
      job_base_effective_date: toDateInput(e.job_base_effective_date),
      review_month: e.review_month || '',
      employment_category: e.employment_category || '',
      employment_category_effective_date: toDateInput(e.employment_category_effective_date),
      designation_effective_date: toDateInput(e.designation_effective_date),

      mobile: e.mobile || '',
      telephone: e.telephone || '',
      personal_email: e.personal_email || '',
      present_address: e.present_address || '',
      present_country: e.present_country || '',
      present_state: e.present_state || '',
      present_city: e.present_city || '',
      present_zip: e.present_zip || '',
      permanent_address: e.permanent_address || '',
      permanent_country: e.permanent_country || '',
      permanent_state: e.permanent_state || '',
      permanent_city: e.permanent_city || '',
      permanent_zip: e.permanent_zip || ''
    });
    setFormTab('info');
    setSupervisorForm(emptySupervisorForm);
    setEditingSupervisorRowId(null);
    setPaymentAccountForm(emptyPaymentAccountForm);
    setEditingPaymentAccountRowId(null);
    setPaymentAccountError(null);
    setShowForm(true);
    fetchSupervisors(e.id);
    fetchPaymentAccounts(e.id);
  };

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
    setSupervisors([]);
    setSupervisorForm(emptySupervisorForm);
    setEditingSupervisorRowId(null);
    setPaymentAccounts([]);
    setPaymentAccountForm(emptyPaymentAccountForm);
    setEditingPaymentAccountRowId(null);
    setPaymentAccountError(null);
  };

  // --- Supervisor tab ---

  const fetchSupervisors = useCallback(async (employeeId: number) => {
    setLoadingSupervisors(true);
    try {
      const res = await fetch(apiUrl(`/api/employees/${employeeId}/supervisors`), { headers: authHeaders });
      if (res.ok) setSupervisors(await res.json());
    } catch {
      // Leave the previous list up rather than blanking it on a blip.
    } finally {
      setLoadingSupervisors(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const openAddSupervisor = () => {
    setEditingSupervisorRowId(null);
    setSupervisorForm(emptySupervisorForm);
  };

  const openEditSupervisor = (row: EmployeeSupervisor) => {
    setEditingSupervisorRowId(row.id);
    setSupervisorForm({
      supervisor_id: String(row.supervisor_id),
      effective_date: toDateInput(row.effective_date),
      is_direct: row.is_direct
    });
  };

  // Deliberately a plain click handler, not a nested <form onSubmit> — this
  // whole tab already lives inside the Employee modal's own <form>, and HTML
  // doesn't support nested forms.
  const handleSaveSupervisor = async () => {
    if (!editingId) return;
    if (!supervisorForm.supervisor_id) {
      return setMessage({ type: 'error', text: 'Select an employee as the Supervisor.' });
    }
    setSavingSupervisor(true);
    try {
      const url = editingSupervisorRowId
        ? apiUrl(`/api/employees/${editingId}/supervisors/${editingSupervisorRowId}`)
        : apiUrl(`/api/employees/${editingId}/supervisors`);
      const res = await fetch(url, {
        method: editingSupervisorRowId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          supervisor_id: Number(supervisorForm.supervisor_id),
          effective_date: supervisorForm.effective_date || null,
          is_direct: supervisorForm.is_direct
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save supervisor');
      setSupervisorForm(emptySupervisorForm);
      setEditingSupervisorRowId(null);
      fetchSupervisors(editingId);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setSavingSupervisor(false);
    }
  };

  const handleDeleteSupervisor = async (rowId: number) => {
    if (!editingId) return;
    if (!confirm('Remove this supervisor assignment?')) return;
    try {
      const res = await fetch(apiUrl(`/api/employees/${editingId}/supervisors/${rowId}`), { method: 'DELETE', headers: authHeaders });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to remove');
      fetchSupervisors(editingId);
      if (editingSupervisorRowId === rowId) {
        setEditingSupervisorRowId(null);
        setSupervisorForm(emptySupervisorForm);
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    }
  };

  // --- Payment tab (Bank/MFS payroll disbursement split) ---

  const fetchPaymentAccounts = useCallback(async (employeeId: number) => {
    setLoadingPaymentAccounts(true);
    try {
      const res = await fetch(apiUrl(`/api/employees/${employeeId}/payment-accounts`), { headers: authHeaders });
      if (res.ok) setPaymentAccounts(await res.json());
    } catch {
      // Leave the previous list up rather than blanking it on a blip.
    } finally {
      setLoadingPaymentAccounts(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const openAddPaymentAccount = () => {
    setEditingPaymentAccountRowId(null);
    setPaymentAccountForm(emptyPaymentAccountForm);
    setPaymentAccountError(null);
  };

  const openEditPaymentAccount = (row: EmployeePaymentAccount) => {
    setEditingPaymentAccountRowId(row.id);
    setPaymentAccountForm({
      account_type: row.account_type,
      account_label: row.account_label,
      bank_name: row.bank_name || '',
      branch_name: row.branch_name || '',
      provider: row.provider || '',
      account_number: row.account_number,
      percentage: String(row.percentage)
    });
    setPaymentAccountError(null);
  };

  const activePaymentAccountsTotal = paymentAccounts
    .filter((a) => a.is_active && a.id !== editingPaymentAccountRowId)
    .reduce((sum, a) => sum + a.percentage, 0);

  // Same "plain click handler inside the Employee modal's own <form>" reason
  // as handleSaveSupervisor above — no nested <form>.
  const handleSavePaymentAccount = async () => {
    if (!editingId) return;
    setPaymentAccountError(null);
    if (!paymentAccountForm.account_label.trim()) {
      return setPaymentAccountError(paymentAccountForm.account_type === 'mfs' ? 'Give this MFS account a label (e.g. bKash 1).' : 'Give this Bank account a label (e.g. Bank 1).');
    }
    if (!paymentAccountForm.account_number.trim()) {
      return setPaymentAccountError(paymentAccountForm.account_type === 'mfs' ? 'Mobile/Wallet number is required.' : 'Account number is required.');
    }
    const pct = Number(paymentAccountForm.percentage);
    if (!Number.isFinite(pct) || pct <= 0 || pct > 100) {
      return setPaymentAccountError('Percentage must be greater than 0 and at most 100.');
    }
    setSavingPaymentAccount(true);
    try {
      const url = editingPaymentAccountRowId
        ? apiUrl(`/api/employees/${editingId}/payment-accounts/${editingPaymentAccountRowId}`)
        : apiUrl(`/api/employees/${editingId}/payment-accounts`);
      const res = await fetch(url, {
        method: editingPaymentAccountRowId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          account_type: paymentAccountForm.account_type,
          account_label: paymentAccountForm.account_label.trim(),
          bank_name: paymentAccountForm.bank_name.trim() || null,
          branch_name: paymentAccountForm.branch_name.trim() || null,
          provider: paymentAccountForm.provider.trim() || null,
          account_number: paymentAccountForm.account_number.trim(),
          percentage: pct
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save this payment account');
      setPaymentAccountForm(emptyPaymentAccountForm);
      setEditingPaymentAccountRowId(null);
      fetchPaymentAccounts(editingId);
    } catch (err: any) {
      setPaymentAccountError(err.message || 'Something went wrong');
    } finally {
      setSavingPaymentAccount(false);
    }
  };

  const handleDeletePaymentAccount = async (rowId: number) => {
    if (!editingId) return;
    if (!confirm('Remove this payment account?')) return;
    try {
      const res = await fetch(apiUrl(`/api/employees/${editingId}/payment-accounts/${rowId}`), { method: 'DELETE', headers: authHeaders });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to remove');
      fetchPaymentAccounts(editingId);
      if (editingPaymentAccountRowId === rowId) {
        setEditingPaymentAccountRowId(null);
        setPaymentAccountForm(emptyPaymentAccountForm);
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.name.trim()) return setMessage({ type: 'error', text: 'Please enter the employee name.' });
    if (!editingId && form.create_login) {
      if (!form.login_username.trim() && !form.email.trim()) {
        return setMessage({ type: 'error', text: 'Enter a login username, or an Email above, to create this employee\u2019s login.' });
      }
      if (form.login_password.length < 6) {
        return setMessage({ type: 'error', text: 'Login password must be at least 6 characters.' });
      }
    }

    setSaving(true);
    try {
      const payload: Record<string, unknown> = {
        employee_id: form.employee_id.trim() || null,
        name: form.name.trim(),
        designation: form.designation.trim() || null,
        department_id: form.department_id || null,
        branch_id: form.branch_id || null,
        email: form.email.trim() || null,
        phone: form.phone.trim() || null,
        is_active: form.is_active,

        middle_name: form.middle_name.trim() || null,
        gender: form.gender || null,
        date_of_birth: form.date_of_birth || null,
        nid_ssn: form.nid_ssn.trim() || null,
        nationality: form.nationality.trim() || null,
        marital_status: form.marital_status || null,
        blood_group: form.blood_group || null,
        religion: form.religion.trim() || null,
        is_foreigner: form.is_foreigner,

        division: form.division.trim() || null,
        unit: form.unit.trim() || null,
        status_effective_date: form.status_effective_date || null,
        job_status: form.job_status || null,
        job_status_effective_date: form.job_status_effective_date || null,
        job_base: form.job_base || null,
        job_base_effective_date: form.job_base_effective_date || null,
        review_month: form.review_month || null,
        employment_category: form.employment_category || null,
        employment_category_effective_date: form.employment_category_effective_date || null,
        designation_effective_date: form.designation_effective_date || null,

        mobile: form.mobile.trim() || null,
        telephone: form.telephone.trim() || null,
        personal_email: form.personal_email.trim() || null,
        present_address: form.present_address.trim() || null,
        present_country: form.present_country.trim() || null,
        present_state: form.present_state.trim() || null,
        present_city: form.present_city.trim() || null,
        present_zip: form.present_zip.trim() || null,
        permanent_address: form.permanent_address.trim() || null,
        permanent_country: form.permanent_country.trim() || null,
        permanent_state: form.permanent_state.trim() || null,
        permanent_city: form.permanent_city.trim() || null,
        permanent_zip: form.permanent_zip.trim() || null
      };
      // create_login only ever applies on the New Employee form — editing an
      // existing row goes through PUT, which has nothing to do with users.
      if (!editingId && form.create_login) {
        payload.create_login = true;
        payload.login_username = form.login_username.trim() || null;
        payload.login_password = form.login_password;
        payload.login_project_ids = form.login_project_ids;
        // Module Access is Superadmin-only — don't even send it as a plain
        // Admin, matching what the server would silently ignore anyway.
        if (isSuperAdmin) payload.login_module_keys = form.login_module_keys;
      }
      const url = editingId ? apiUrl(`/api/employees/${editingId}`) : apiUrl('/api/employees');
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save employee');

      setMessage({
        type: 'success',
        text: editingId ? 'Employee updated.' : form.create_login ? 'Employee added with a login account.' : 'Employee added.'
      });
      closeForm();
      fetchAll();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this employee record? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      const res = await fetch(apiUrl(`/api/employees/${id}`), { method: 'DELETE', headers: authHeaders });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete');
      setEmployees((prev) => prev.filter((e) => e.id !== id));
      setMessage({ type: 'success', text: 'Employee deleted.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setDeletingId(null);
    }
  };

  // Loads the Transfer History list for whichever Employee the modal is
  // currently open for — called on open, and again after a successful
  // transfer so the newly-added row shows up immediately.
  const fetchTransferHistory = async (employeeId: number) => {
    setLoadingTransferHistory(true);
    try {
      const res = await fetch(apiUrl(`/api/employees/${employeeId}/transfers`), { headers: authHeaders });
      if (res.ok) setTransferHistory(await res.json());
    } catch {
      // History is supplementary — a failed load here shouldn't block the
      // Transfer form itself, so it's left to just show an empty list.
    } finally {
      setLoadingTransferHistory(false);
    }
  };

  const openTransferForm = (emp: Employee) => {
    setTransferringFor(emp);
    setTransferForm({
      to_department_id: emp.department_id ? String(emp.department_id) : '',
      to_designation: emp.designation || '',
      to_supervisor_id: '',
      effective_date: '',
      reason: ''
    });
    setTransferHistory([]);
    fetchTransferHistory(emp.id);
  };

  const closeTransferForm = () => {
    setTransferringFor(null);
    setTransferForm(emptyTransferForm);
    setTransferHistory([]);
  };

  const handleSaveTransfer = async () => {
    if (!transferringFor) return;
    if (!transferForm.effective_date) {
      return setMessage({ type: 'error', text: 'Effective Date is required.' });
    }
    if (transferForm.to_supervisor_id && Number(transferForm.to_supervisor_id) === transferringFor.id) {
      return setMessage({ type: 'error', text: 'An employee cannot be their own supervisor.' });
    }
    setSavingTransfer(true);
    try {
      const res = await fetch(apiUrl(`/api/employees/${transferringFor.id}/transfer`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          to_department_id: transferForm.to_department_id ? Number(transferForm.to_department_id) : null,
          to_designation: transferForm.to_designation.trim() || null,
          to_supervisor_id: transferForm.to_supervisor_id ? Number(transferForm.to_supervisor_id) : null,
          effective_date: transferForm.effective_date,
          reason: transferForm.reason.trim() || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to transfer employee');
      setMessage({ type: 'success', text: `${transferringFor.name} transferred successfully.` });
      await fetchAll();
      await fetchTransferHistory(transferringFor.id);
      setTransferForm((f) => ({ ...f, to_supervisor_id: '', effective_date: '', reason: '' }));
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setSavingTransfer(false);
    }
  };

  const openCreateLoginForm = (emp: Employee) => {
    setCreatingLoginFor(emp);
    setLoginForm(emptyLoginForm);
  };

  const closeCreateLoginForm = () => {
    setCreatingLoginFor(null);
    setLoginForm(emptyLoginForm);
  };

  // Gives an existing Employee row (no user_id yet) a login account —
  // POST /api/employees/:id/create-login. Falls back to the Employee's own
  // `email` for the login if no separate username is typed here, same
  // fallback the New Employee form's create_login checkbox uses server-side.
  const handleCreateLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!creatingLoginFor) return;
    if (!loginForm.login_username.trim() && !creatingLoginFor.email) {
      return setMessage({ type: 'error', text: 'Enter a login username — this employee has no Email on file to fall back to.' });
    }
    if (loginForm.login_password.length < 6) {
      return setMessage({ type: 'error', text: 'Login password must be at least 6 characters.' });
    }

    setCreatingLogin(true);
    try {
      const res = await fetch(apiUrl(`/api/employees/${creatingLoginFor.id}/create-login`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          login_username: loginForm.login_username.trim() || null,
          login_password: loginForm.login_password,
          login_project_ids: loginForm.login_project_ids,
          // Module Access is Superadmin-only — don't even send it as a plain
          // Admin, matching what the server would silently ignore anyway.
          ...(isSuperAdmin ? { login_module_keys: loginForm.login_module_keys } : {})
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create login');

      setMessage({ type: 'success', text: `Login account created for ${creatingLoginFor.name}.` });
      closeCreateLoginForm();
      fetchAll();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setCreatingLogin(false);
    }
  };

  const openLinkUserForm = async (emp: Employee) => {
    setLinkingUserFor(emp);
    setLinkUserSearch('');
    setSelectedLinkUserId(null);
    setLoadingUnlinkedUsers(true);
    try {
      const res = await fetch(apiUrl('/api/employees/unlinked-users'), { headers: authHeaders });
      if (res.ok) setUnlinkedUsers(await res.json());
    } catch {
      setMessage({ type: 'error', text: "Couldn't load existing user accounts. Please try again." });
    } finally {
      setLoadingUnlinkedUsers(false);
    }
  };

  const closeLinkUserForm = () => {
    setLinkingUserFor(null);
    setUnlinkedUsers([]);
    setLinkUserSearch('');
    setSelectedLinkUserId(null);
  };

  // Points this existing Employee row at an EXISTING login account —
  // PUT /api/employees/:id/link-user — instead of creating a new one.
  const handleLinkUser = async () => {
    if (!linkingUserFor || !selectedLinkUserId) return;
    setLinkingUser(true);
    try {
      const res = await fetch(apiUrl(`/api/employees/${linkingUserFor.id}/link-user`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ user_id: selectedLinkUserId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to link user account');

      setMessage({ type: 'success', text: `Linked ${linkingUserFor.name} to their existing login account.` });
      closeLinkUserForm();
      fetchAll();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setLinkingUser(false);
    }
  };

  const filteredUnlinkedUsers = unlinkedUsers.filter((u) => {
    const q = linkUserSearch.trim().toLowerCase();
    if (!q) return true;
    return u.name.toLowerCase().includes(q) || (u.email || '').toLowerCase().includes(q) || (u.username || '').toLowerCase().includes(q);
  });

  // Clears a stale/mistaken link — e.g. the linked user was deleted from
  // Admin Panel -> Users (all_employees.user_id has no FK, so it wouldn't
  // clear itself for anything deleted before that cleanup was added), or the
  // wrong account got linked. Employee goes back to showing "Create Login" /
  // "Link Existing" afterward.
  const handleUnlinkUser = async (emp: Employee) => {
    if (!window.confirm(`Unlink ${emp.name}'s login account? This only removes the link — the user account itself (if it still exists) is not deleted.`)) return;
    setUnlinkingId(emp.id);
    try {
      const res = await fetch(apiUrl(`/api/employees/${emp.id}/link-user`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to unlink');
      setMessage({ type: 'success', text: `Unlinked ${emp.name}'s login account.` });
      fetchAll();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setUnlinkingId(null);
    }
  };

  // Tooltip on the Department cell below — who that Department's Supervisor
  // is (if any), so the Admin doesn't have to jump to the Departments tab
  // just to see who'd auto-approve this Employee's requests first.
  const departmentSupervisorLabel = (departmentId: number | null | undefined) => {
    if (!departmentId) return '';
    const d = departments.find((x) => x.id === departmentId);
    return d?.supervisor_name ? `Supervisor: ${d.supervisor_name}` : '';
  };

  const filtered = employees.filter((e) => {
    const q = search.trim().toLowerCase();
    if (!q) return true;
    return (
      e.name.toLowerCase().includes(q) ||
      (e.employee_id || '').toLowerCase().includes(q) ||
      (e.designation || '').toLowerCase().includes(q) ||
      (e.department || '').toLowerCase().includes(q) ||
      (e.email || '').toLowerCase().includes(q) ||
      (e.phone || '').toLowerCase().includes(q)
    );
  });

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Contact className="w-5 h-5 text-blue-600" />
            Employees
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            The company-wide employee directory — Employee ID, Name, Designation, Department, Email, Phone.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateForm}
          className="flex items-center justify-center gap-1.5 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-sm transition-all text-sm whitespace-nowrap"
        >
          <Plus className="w-4 h-4" /> New Employee
        </button>
      </div>

      {message && (
        <div className={`p-3.5 rounded-xl border flex items-center justify-between text-sm ${
          message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
        }`}>
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} className="text-xs underline opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search by name, ID, designation, department, email, phone…"
          className="block w-full pl-9 pr-3 py-2.5 bg-white border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
        />
      </div>

      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 gap-2 text-sm">
          <Spinner size={16} /> Loading employees…
        </div>
      ) : filtered.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-10 text-center">
          <Contact className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">
            {employees.length === 0 ? 'No employees yet. Add the first one to get started.' : 'No employees match your search.'}
          </p>
        </div>
      ) : (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 border-b border-slate-200">
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Employee</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Designation</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Department</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Contact</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Status</th>
                  <th className="px-4 py-3 text-left text-[11px] font-semibold uppercase tracking-wider text-slate-500">Login</th>
                  <th className="px-4 py-3 text-right text-[11px] font-semibold uppercase tracking-wider text-slate-500">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {filtered.map((emp) => (
                  <tr key={emp.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap">
                      <div className="font-semibold text-slate-900 text-xs">{emp.name}</div>
                      {emp.employee_id && (
                        <div className="text-[11px] text-slate-400 font-mono">{emp.employee_id}</div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-700">
                      {emp.designation ? (
                        <span className="inline-flex items-center gap-1"><Briefcase className="w-3 h-3 text-slate-400" />{emp.designation}</span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-700">
                      {emp.department ? (
                        <span className="inline-flex items-center gap-1" title={departmentSupervisorLabel(emp.department_id)}>
                          <Building2 className="w-3 h-3 text-slate-400" />{emp.department}
                        </span>
                      ) : '—'}
                    </td>
                    <td className="px-4 py-3 text-xs text-slate-600">
                      {emp.email && (
                        <div className="flex items-center gap-1"><Mail className="w-3 h-3 text-slate-400" />{emp.email}</div>
                      )}
                      {emp.phone && (
                        <div className="flex items-center gap-1 mt-0.5"><Phone className="w-3 h-3 text-slate-400" />{emp.phone}</div>
                      )}
                      {!emp.email && !emp.phone && '—'}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${emp.is_active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
                        {emp.is_active ? 'Active' : 'Inactive'}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap">
                      {emp.user_id ? (
                        <div className="flex items-center gap-1">
                          <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">
                            <ShieldCheck className="w-3 h-3" /> Has Login
                          </span>
                          <button
                            type="button"
                            onClick={() => handleUnlinkUser(emp)}
                            disabled={unlinkingId === emp.id}
                            className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                            title="Unlink this login account (e.g. it was deleted, or linked by mistake)"
                          >
                            <X className="w-3 h-3" />
                          </button>
                        </div>
                      ) : (
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => openCreateLoginForm(emp)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors"
                            title="Create a login account for this employee"
                          >
                            <KeyRound className="w-3 h-3" /> Create Login
                          </button>
                          <button
                            type="button"
                            onClick={() => openLinkUserForm(emp)}
                            className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-100 text-slate-500 border border-slate-200 hover:bg-blue-50 hover:text-blue-700 hover:border-blue-200 transition-colors"
                            title="Link this employee to an already-existing login account"
                          >
                            <Link2 className="w-3 h-3" /> Link Existing
                          </button>
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-right">
                      <div className="flex items-center justify-end gap-1">
                        <button
                          type="button"
                          onClick={() => openTransferForm(emp)}
                          className="p-2 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg transition-colors"
                          title="Transfer / Change Role"
                        >
                          <ArrowLeftRight className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => openEditForm(emp)}
                          className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Edit"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          type="button"
                          onClick={() => handleDelete(emp.id)}
                          disabled={deletingId === emp.id}
                          className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                          title="Delete"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* --- Create / Edit Modal --- */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-2xl w-full max-h-[92vh] overflow-y-auto shadow-2xl">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10 rounded-t-2xl">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Contact className="w-4.5 h-4.5 text-blue-600" />
                {editingId ? 'Edit Employee' : 'New Employee'}
              </h3>
              <button onClick={closeForm} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            {/* Tab nav — Employee Info / Status / Contact / Supervisor, restyled
                to this app's own look (not the reference screenshots' purple
                sidebar). Supervisor is disabled until the employee has been
                saved once (it needs a real employee id to attach rows to). */}
            <div className="flex items-center gap-1 px-5 pt-3 border-b border-slate-200 overflow-x-auto sticky top-[65px] bg-white z-10">
              {FORM_TABS.map((t) => {
                const disabled = (t.key === 'supervisor' || t.key === 'payment') && !editingId;
                const active = formTab === t.key;
                return (
                  <button
                    key={t.key}
                    type="button"
                    disabled={disabled}
                    onClick={() => setFormTab(t.key)}
                    title={disabled ? `Save the employee first to manage ${t.label}` : undefined}
                    className={`flex items-center gap-1.5 px-3 py-2 text-xs font-semibold rounded-t-lg border-b-2 whitespace-nowrap transition-colors ${
                      active
                        ? 'border-blue-600 text-blue-700'
                        : disabled
                        ? 'border-transparent text-slate-300 cursor-not-allowed'
                        : 'border-transparent text-slate-500 hover:text-slate-800'
                    }`}
                  >
                    {t.icon} {t.label}
                  </button>
                );
              })}
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-4">
              {formTab === 'info' && (
              <>
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Employee ID</label>
                  <input
                    type="text"
                    value={form.employee_id}
                    onChange={(e) => setForm((f) => ({ ...f, employee_id: e.target.value }))}
                    placeholder="e.g. 220810019"
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Name *</label>
                  <input
                    type="text"
                    required
                    value={form.name}
                    onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="Full name"
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Designation</label>
                  <input
                    type="text"
                    value={form.designation}
                    onChange={(e) => setForm((f) => ({ ...f, designation: e.target.value }))}
                    placeholder="e.g. Executive"
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Department</label>
                  <select
                    value={form.department_id ?? ''}
                    onChange={(e) => setForm((f) => ({ ...f, department_id: e.target.value ? Number(e.target.value) : null }))}
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  >
                    <option value="">— None —</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}{d.supervisor_name ? ` (Supervisor: ${d.supervisor_name})` : ''}</option>
                    ))}
                  </select>
                  {departments.length === 0 && (
                    <p className="mt-1 text-[11px] text-slate-400">
                      No Departments set up yet — add one from Admin Panel -&gt; Departments.
                    </p>
                  )}
                </div>
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Email</label>
                  <input
                    type="email"
                    value={form.email}
                    onChange={(e) => setForm((f) => ({ ...f, email: e.target.value }))}
                    placeholder="name@company.com"
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Phone</label>
                  <input
                    type="text"
                    value={form.phone}
                    onChange={(e) => setForm((f) => ({ ...f, phone: e.target.value }))}
                    placeholder="e.g. 01877772209"
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
              </div>

              <div className="pt-1">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Personal Details</p>
                <div className="grid sm:grid-cols-2 gap-4">
                  <TextField label="Middle Name" value={form.middle_name} onChange={(v) => setForm((f) => ({ ...f, middle_name: v }))} placeholder="Middle name" />
                  <SelectField label="Gender" value={form.gender} onChange={(v) => setForm((f) => ({ ...f, gender: v }))} options={GENDER_OPTIONS} />
                  <DateField label="Date of Birth" value={form.date_of_birth} onChange={(v) => setForm((f) => ({ ...f, date_of_birth: v }))} />
                  <TextField label="NID / SSN" value={form.nid_ssn} onChange={(v) => setForm((f) => ({ ...f, nid_ssn: v }))} placeholder="e.g. 5108703397" />
                  <TextField label="Nationality" value={form.nationality} onChange={(v) => setForm((f) => ({ ...f, nationality: v }))} placeholder="e.g. Bangladeshi" />
                  <SelectField label="Marital Status" value={form.marital_status} onChange={(v) => setForm((f) => ({ ...f, marital_status: v }))} options={MARITAL_STATUS_OPTIONS} />
                  <SelectField label="Blood Group" value={form.blood_group} onChange={(v) => setForm((f) => ({ ...f, blood_group: v }))} options={BLOOD_GROUP_OPTIONS} />
                  <TextField label="Religion" value={form.religion} onChange={(v) => setForm((f) => ({ ...f, religion: v }))} placeholder="e.g. Islam" />
                </div>
                <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer mt-3">
                  <input
                    type="checkbox"
                    checked={form.is_foreigner}
                    onChange={(e) => setForm((f) => ({ ...f, is_foreigner: e.target.checked }))}
                    className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                  />
                  Foreigner
                </label>
              </div>

              <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
                <button
                  type="button"
                  onClick={() => setForm((f) => ({ ...f, is_active: !f.is_active }))}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    form.is_active ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      form.is_active ? 'translate-x-[18px]' : 'translate-x-1'
                    }`}
                  />
                </button>
                <span className="flex items-center gap-1.5">
                  {form.is_active ? <Eye className="w-3.5 h-3.5 text-slate-400" /> : <EyeOff className="w-3.5 h-3.5 text-slate-400" />}
                  {form.is_active ? 'Active' : 'Inactive'}
                </span>
              </label>

              {/* Also create a login — only offered while adding a brand-new
                  Employee (editing goes through PUT, which never touches
                  users; an already-existing employee without a login gets
                  one later via the row's own "Create Login" action instead). */}
              {!editingId && (
                <div className="rounded-xl border border-slate-200 p-3.5 space-y-3">
                  <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
                    <button
                      type="button"
                      onClick={() => setForm((f) => ({ ...f, create_login: !f.create_login }))}
                      className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                        form.create_login ? 'bg-blue-600' : 'bg-slate-300'
                      }`}
                    >
                      <span
                        className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                          form.create_login ? 'translate-x-[18px]' : 'translate-x-1'
                        }`}
                      />
                    </button>
                    <span className="flex items-center gap-1.5 font-semibold">
                      <KeyRound className="w-3.5 h-3.5 text-slate-400" /> Also create a login account for this employee
                    </span>
                  </label>

                  {form.create_login && (
                    <div className="grid sm:grid-cols-2 gap-3 pl-11">
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Username (optional)</label>
                        <input
                          type="text"
                          value={form.login_username}
                          onChange={(e) => setForm((f) => ({ ...f, login_username: e.target.value }))}
                          placeholder="Falls back to Email above"
                          className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Login Password *</label>
                        <input
                          type="text"
                          value={form.login_password}
                          onChange={(e) => setForm((f) => ({ ...f, login_password: e.target.value }))}
                          placeholder="At least 6 characters"
                          className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                      </div>
                      <p className="sm:col-span-2 text-[11px] text-slate-400">
                        Signs in with the Email above (or this Username) + this password, as a regular User.
                      </p>

                      {/* Project Access — same user_project_permissions grant Admin Panel ->
                          Users -> Project Access sets, just applied the moment the login is
                          created instead of as a separate follow-up trip. */}
                      <div className="sm:col-span-2 rounded-xl border border-slate-200 p-3 space-y-2">
                        <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                          <FolderKanban className="w-3.5 h-3.5 text-slate-400" /> Project Access
                        </p>
                        {projects.length === 0 ? (
                          <p className="text-xs text-slate-400">No projects exist yet. Add one from the Projects tab first.</p>
                        ) : (
                          <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                            {projects.map((p) => (
                              <label key={p.id} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer py-1">
                                <input
                                  type="checkbox"
                                  checked={form.login_project_ids.includes(p.id)}
                                  onChange={() => toggleFormProject(p.id)}
                                  className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                                />
                                {p.project_name}
                              </label>
                            ))}
                          </div>
                        )}
                        <p className="text-[11px] text-slate-400">Which Projects this login can see/use. Leave unchecked to grant none for now.</p>
                      </div>

                      {/* Module Access — Superadmin-only, same admin_module_permissions grant
                          Admin Panel -> Users -> Module Access sets. Hidden entirely for a
                          plain Admin, same as that dedicated action already is. */}
                      {isSuperAdmin && (
                        <div className="sm:col-span-2 rounded-xl border border-slate-200 p-3 space-y-2">
                          <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                            <LayoutGrid className="w-3.5 h-3.5 text-slate-400" /> Module Access
                          </p>
                          <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                            {ADMIN_MODULES.map((m) => (
                              <label key={m.key} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer py-1">
                                <input
                                  type="checkbox"
                                  checked={form.login_module_keys.includes(m.key)}
                                  onChange={() => toggleFormModule(m.key)}
                                  className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                                />
                                {m.label}
                              </label>
                            ))}
                          </div>
                          <p className="text-[11px] text-slate-400">Which Admin Panel tabs this login can open. Leave unchecked to grant none for now.</p>
                        </div>
                      )}

                      <p className="sm:col-span-2 text-[11px] text-slate-400">
                        Role and any further access can still be adjusted afterward from Admin Panel → Users.
                      </p>
                    </div>
                  )}
                </div>
              )}
              </>
              )}

              {formTab === 'status' && (
                <div className="space-y-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Division, Department &amp; Branch</p>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <TextField label="Division" value={form.division} onChange={(v) => setForm((f) => ({ ...f, division: v }))} placeholder="e.g. Corporate Office" />
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Branch</label>
                        <select
                          value={form.branch_id ?? ''}
                          onChange={(e) => setForm((f) => ({ ...f, branch_id: e.target.value ? Number(e.target.value) : null }))}
                          className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        >
                          <option value="">— None —</option>
                          {branches.map((b) => (
                            <option key={b.id} value={b.id}>
                              {b.branch_name} ({b.branch_type === 'project_site' ? 'Project' : 'Head Office'})
                            </option>
                          ))}
                        </select>
                        {branches.length === 0 && (
                          <p className="mt-1 text-[11px] text-slate-400">
                            No Branches set up yet — add one from Admin Panel -&gt; Branches.
                          </p>
                        )}
                      </div>
                      <TextField label="Unit" value={form.unit} onChange={(v) => setForm((f) => ({ ...f, unit: v }))} placeholder="Unit" />
                      <DateField label="Effective Date" value={form.status_effective_date} onChange={(v) => setForm((f) => ({ ...f, status_effective_date: v }))} />
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Job Status &amp; Base</p>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <SelectField label="Job Status" value={form.job_status} onChange={(v) => setForm((f) => ({ ...f, job_status: v }))} options={JOB_STATUS_OPTIONS} />
                      <DateField label="Job Status Effective Date" value={form.job_status_effective_date} onChange={(v) => setForm((f) => ({ ...f, job_status_effective_date: v }))} />
                      <SelectField label="Job Base" value={form.job_base} onChange={(v) => setForm((f) => ({ ...f, job_base: v }))} options={JOB_BASE_OPTIONS} />
                      <DateField label="Job Base Effective Date" value={form.job_base_effective_date} onChange={(v) => setForm((f) => ({ ...f, job_base_effective_date: v }))} />
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Category, Review &amp; Designation</p>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <SelectField label="Employment Category" value={form.employment_category} onChange={(v) => setForm((f) => ({ ...f, employment_category: v }))} options={EMPLOYMENT_CATEGORY_OPTIONS} />
                      <DateField label="Employment Category Effective Date" value={form.employment_category_effective_date} onChange={(v) => setForm((f) => ({ ...f, employment_category_effective_date: v }))} />
                      <SelectField label="Review Month" value={form.review_month} onChange={(v) => setForm((f) => ({ ...f, review_month: v }))} options={REVIEW_MONTH_OPTIONS} />
                      <DateField label="Designation Effective Date" value={form.designation_effective_date} onChange={(v) => setForm((f) => ({ ...f, designation_effective_date: v }))} />
                    </div>
                  </div>
                </div>
              )}

              {formTab === 'contact' && (
                <div className="space-y-4">
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Contact</p>
                    <div className="grid sm:grid-cols-2 gap-4">
                      <TextField label="Mobile" value={form.mobile} onChange={(v) => setForm((f) => ({ ...f, mobile: v }))} placeholder="e.g. 01896055404" />
                      <TextField label="Telephone" value={form.telephone} onChange={(v) => setForm((f) => ({ ...f, telephone: v }))} placeholder="Landline" />
                      <TextField label="Personal Email" value={form.personal_email} onChange={(v) => setForm((f) => ({ ...f, personal_email: v }))} placeholder="name@gmail.com" type="email" />
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Present Address</p>
                    <div className="space-y-3">
                      <TextField label="Address" value={form.present_address} onChange={(v) => setForm((f) => ({ ...f, present_address: v }))} placeholder="House, Road, Area" />
                      <div className="grid sm:grid-cols-2 gap-4">
                        <TextField label="Country" value={form.present_country} onChange={(v) => setForm((f) => ({ ...f, present_country: v }))} />
                        <TextField label="State / Division" value={form.present_state} onChange={(v) => setForm((f) => ({ ...f, present_state: v }))} />
                        <TextField label="City" value={form.present_city} onChange={(v) => setForm((f) => ({ ...f, present_city: v }))} />
                        <TextField label="Zip Code" value={form.present_zip} onChange={(v) => setForm((f) => ({ ...f, present_zip: v }))} />
                      </div>
                    </div>
                  </div>
                  <div>
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-500 mb-2">Permanent Address</p>
                    <div className="space-y-3">
                      <TextField label="Address" value={form.permanent_address} onChange={(v) => setForm((f) => ({ ...f, permanent_address: v }))} placeholder="House, Road, Area" />
                      <div className="grid sm:grid-cols-2 gap-4">
                        <TextField label="Country" value={form.permanent_country} onChange={(v) => setForm((f) => ({ ...f, permanent_country: v }))} />
                        <TextField label="State / Division" value={form.permanent_state} onChange={(v) => setForm((f) => ({ ...f, permanent_state: v }))} />
                        <TextField label="City" value={form.permanent_city} onChange={(v) => setForm((f) => ({ ...f, permanent_city: v }))} />
                        <TextField label="Zip Code" value={form.permanent_zip} onChange={(v) => setForm((f) => ({ ...f, permanent_zip: v }))} />
                      </div>
                    </div>
                  </div>
                </div>
              )}

              {formTab === 'supervisor' && editingId && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-slate-200 p-3.5 space-y-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                      <Users2 className="w-3.5 h-3.5 text-slate-400" /> {editingSupervisorRowId ? 'Edit Supervisor' : 'Add Supervisor'}
                    </p>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Employee (Supervisor) *</label>
                        <EmployeeSearchSelect
                          employees={employees}
                          value={supervisorForm.supervisor_id}
                          onChange={(v) => setSupervisorForm((f) => ({ ...f, supervisor_id: v }))}
                          excludeId={editingId ?? undefined}
                        />
                      </div>
                      <DateField label="Effective Date" value={supervisorForm.effective_date} onChange={(v) => setSupervisorForm((f) => ({ ...f, effective_date: v }))} />
                    </div>
                    <label className="flex items-center gap-2 text-xs text-slate-600 cursor-pointer">
                      <input
                        type="checkbox"
                        checked={supervisorForm.is_direct}
                        onChange={(e) => setSupervisorForm((f) => ({ ...f, is_direct: e.target.checked }))}
                        className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                      />
                      Direct Supervisor
                    </label>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSaveSupervisor}
                        disabled={savingSupervisor}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50"
                      >
                        {savingSupervisor ? 'Saving…' : editingSupervisorRowId ? 'Save Changes' : 'Add'}
                      </button>
                      {editingSupervisorRowId && (
                        <button type="button" onClick={openAddSupervisor} className="px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 rounded-xl transition-colors">
                          Cancel Edit
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    {loadingSupervisors ? (
                      <div className="flex items-center justify-center py-8 text-slate-400 gap-2 text-xs">
                        <Spinner size={14} /> Loading supervisors…
                      </div>
                    ) : supervisors.length === 0 ? (
                      <p className="text-xs text-slate-400 text-center py-8">No supervisor assigned yet.</p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-slate-500">Name</th>
                            <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-slate-500">Employee Code</th>
                            <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-slate-500">Direct</th>
                            <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-slate-500">Effective Date</th>
                            <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider text-slate-500">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {supervisors.map((s) => (
                            <tr key={s.id} className="hover:bg-slate-50/80 transition-colors">
                              <td className="px-3 py-2.5 font-semibold text-slate-900">{s.supervisor_name}</td>
                              <td className="px-3 py-2.5 text-slate-500 font-mono">{s.supervisor_employee_code || '—'}</td>
                              <td className="px-3 py-2.5">
                                {s.is_direct ? (
                                  <span className="inline-flex items-center gap-1 text-emerald-700"><Star className="w-3 h-3" /> Yes</span>
                                ) : 'No'}
                              </td>
                              <td className="px-3 py-2.5 text-slate-600">{s.effective_date ? String(s.effective_date).slice(0, 10) : '—'}</td>
                              <td className="px-3 py-2.5 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <button type="button" onClick={() => openEditSupervisor(s)} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Edit">
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                  <button type="button" onClick={() => handleDeleteSupervisor(s.id)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="Remove">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    The Supervisor is always picked from the Employee list above, and can be changed at any time.
                  </p>
                </div>
              )}

              {formTab === 'payment' && editingId && (
                <div className="space-y-4">
                  <div className="rounded-xl border border-slate-200 p-3.5 space-y-3">
                    <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                      <Landmark className="w-3.5 h-3.5 text-slate-400" /> {editingPaymentAccountRowId ? 'Edit Account' : 'Add Bank / MFS Account'}
                    </p>
                    <div className="flex items-center gap-4">
                      {(['bank', 'mfs'] as const).map((t) => (
                        <label key={t} className="flex items-center gap-1.5 text-xs text-slate-600 cursor-pointer">
                          <input
                            type="radio"
                            checked={paymentAccountForm.account_type === t}
                            onChange={() => setPaymentAccountForm((f) => ({ ...f, account_type: t, provider: t === 'mfs' ? f.provider : '', bank_name: t === 'bank' ? f.bank_name : '' }))}
                            className="w-3.5 h-3.5 text-blue-600 focus:ring-blue-600 cursor-pointer"
                          />
                          {t === 'bank' ? 'Bank' : 'MFS (bKash/Nagad/Rocket)'}
                        </label>
                      ))}
                    </div>
                    <div className="grid sm:grid-cols-2 gap-3">
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Label *</label>
                        <input
                          type="text"
                          value={paymentAccountForm.account_label}
                          onChange={(e) => setPaymentAccountForm((f) => ({ ...f, account_label: e.target.value }))}
                          placeholder={paymentAccountForm.account_type === 'mfs' ? 'e.g. bKash 1' : 'e.g. Bank 1'}
                          className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                      </div>
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Percentage of Net Salary *</label>
                        <input
                          type="number"
                          min={0}
                          max={100}
                          step="0.01"
                          value={paymentAccountForm.percentage}
                          onChange={(e) => setPaymentAccountForm((f) => ({ ...f, percentage: e.target.value }))}
                          placeholder="e.g. 70"
                          className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        />
                      </div>
                    </div>
                    {paymentAccountForm.account_type === 'bank' ? (
                      <div className="grid sm:grid-cols-2 gap-3">
                        <div>
                          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Bank Name</label>
                          <input
                            type="text"
                            value={paymentAccountForm.bank_name}
                            onChange={(e) => setPaymentAccountForm((f) => ({ ...f, bank_name: e.target.value }))}
                            placeholder="e.g. Dutch-Bangla Bank"
                            className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Branch</label>
                          <input
                            type="text"
                            value={paymentAccountForm.branch_name}
                            onChange={(e) => setPaymentAccountForm((f) => ({ ...f, branch_name: e.target.value }))}
                            placeholder="e.g. Gulshan Branch"
                            className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                        </div>
                      </div>
                    ) : (
                      <div>
                        <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Provider</label>
                        <select
                          value={paymentAccountForm.provider}
                          onChange={(e) => setPaymentAccountForm((f) => ({ ...f, provider: e.target.value }))}
                          className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        >
                          <option value="">Select provider…</option>
                          {MFS_PROVIDERS.map((p) => (
                            <option key={p} value={p}>{p}</option>
                          ))}
                        </select>
                      </div>
                    )}
                    <div>
                      <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                        {paymentAccountForm.account_type === 'mfs' ? 'Mobile / Wallet Number *' : 'Account Number *'}
                      </label>
                      <input
                        type="text"
                        value={paymentAccountForm.account_number}
                        onChange={(e) => setPaymentAccountForm((f) => ({ ...f, account_number: e.target.value }))}
                        placeholder={paymentAccountForm.account_type === 'mfs' ? 'e.g. 01XXXXXXXXX' : 'e.g. 1234567890123'}
                        className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                      />
                    </div>
                    {paymentAccountError && <p className="text-xs text-rose-600">{paymentAccountError}</p>}
                    <p className="text-[11px] text-slate-500">
                      Active accounts so far total <span className="font-semibold">{activePaymentAccountsTotal}%</span>
                      {paymentAccountForm.percentage && Number.isFinite(Number(paymentAccountForm.percentage))
                        ? ` — adding this one makes ${(Math.round((activePaymentAccountsTotal + Number(paymentAccountForm.percentage)) * 100) / 100)}%.`
                        : ' of Net Salary.'}
                    </p>
                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={handleSavePaymentAccount}
                        disabled={savingPaymentAccount}
                        className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50"
                      >
                        {savingPaymentAccount ? 'Saving…' : editingPaymentAccountRowId ? 'Save Changes' : 'Add Account'}
                      </button>
                      {editingPaymentAccountRowId && (
                        <button type="button" onClick={openAddPaymentAccount} className="px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 rounded-xl transition-colors">
                          Cancel Edit
                        </button>
                      )}
                    </div>
                  </div>

                  <div className="rounded-xl border border-slate-200 overflow-hidden">
                    {loadingPaymentAccounts ? (
                      <div className="flex items-center justify-center py-8 text-slate-400 gap-2 text-xs">
                        <Spinner size={14} /> Loading payment accounts…
                      </div>
                    ) : paymentAccounts.length === 0 ? (
                      <p className="text-xs text-slate-400 text-center py-8">
                        No Bank/MFS account set up yet — Payroll will use the Run Payroll wizard's single Payment Method for this employee.
                      </p>
                    ) : (
                      <table className="w-full text-xs">
                        <thead>
                          <tr className="bg-slate-50 border-b border-slate-200">
                            <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-slate-500">Account</th>
                            <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-slate-500">Details</th>
                            <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider text-slate-500">%</th>
                            <th className="px-3 py-2 text-left font-semibold uppercase tracking-wider text-slate-500">Status</th>
                            <th className="px-3 py-2 text-right font-semibold uppercase tracking-wider text-slate-500">Action</th>
                          </tr>
                        </thead>
                        <tbody className="divide-y divide-slate-100">
                          {paymentAccounts.map((a) => (
                            <tr key={a.id} className="hover:bg-slate-50/80 transition-colors">
                              <td className="px-3 py-2.5 font-semibold text-slate-900">
                                {a.account_label}
                                <span className="ml-1.5 inline-flex items-center text-[10px] font-medium px-1.5 py-0.5 rounded-full bg-slate-100 text-slate-500">
                                  {a.account_type === 'mfs' ? (a.provider || 'MFS') : 'Bank'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-slate-500">
                                {a.account_type === 'bank' ? [a.bank_name, a.branch_name].filter(Boolean).join(' — ') || '—' : a.provider || '—'}
                                <span className="ml-1.5 font-mono text-slate-400">{a.account_number}</span>
                              </td>
                              <td className="px-3 py-2.5 text-right font-semibold text-slate-700">{a.percentage}%</td>
                              <td className="px-3 py-2.5">
                                <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${a.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                                  {a.is_active ? 'Active' : 'Inactive'}
                                </span>
                              </td>
                              <td className="px-3 py-2.5 text-right">
                                <div className="flex items-center justify-end gap-1">
                                  <button type="button" onClick={() => openEditPaymentAccount(a)} className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors" title="Edit">
                                    <Edit2 className="w-3.5 h-3.5" />
                                  </button>
                                  <button type="button" onClick={() => handleDeletePaymentAccount(a.id)} className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors" title="Remove">
                                    <Trash2 className="w-3.5 h-3.5" />
                                  </button>
                                </div>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}
                  </div>
                  <p className="text-[11px] text-slate-400">
                    Net Salary is split across these active accounts by percentage each payroll run. Leave this empty to keep paying this
                    employee via Run Payroll's single Payment Method instead.
                  </p>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={closeForm}
                  className="px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
                >
                  {formTab === 'supervisor' || formTab === 'payment' ? 'Close' : 'Cancel'}
                </button>
                {formTab !== 'supervisor' && formTab !== 'payment' && (
                  <button
                    type="submit"
                    disabled={saving}
                    className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50"
                  >
                    {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add Employee'}
                  </button>
                )}
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- Transfer / Change Role Modal --- */}
      {transferringFor && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-lg w-full shadow-2xl max-h-[90vh] overflow-y-auto">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <ArrowLeftRight className="w-4.5 h-4.5 text-violet-600" /> Transfer / Change Role
              </h3>
              <button onClick={closeTransferForm} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-500">
                Moving <span className="font-semibold text-slate-700">{transferringFor.name}</span> to a new Department, Designation, and/or Supervisor. Leave a field as-is to keep it unchanged — every change is kept on record below.
              </p>

              <div className="grid sm:grid-cols-2 gap-3">
                <div>
                  <label className={fieldLabelClass}>New Department</label>
                  <select
                    value={transferForm.to_department_id}
                    onChange={(e) => setTransferForm((f) => ({ ...f, to_department_id: e.target.value }))}
                    className={fieldInputClass}
                  >
                    <option value="">
                      {transferringFor.department ? `Keep — ${transferringFor.department}` : 'No Department set'}
                    </option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </div>
                <TextField
                  label="New Designation"
                  value={transferForm.to_designation}
                  onChange={(v) => setTransferForm((f) => ({ ...f, to_designation: v }))}
                  placeholder={transferringFor.designation || 'e.g. Senior Engineer'}
                />
              </div>

              <div>
                <label className={fieldLabelClass}>New Supervisor</label>
                <EmployeeSearchSelect
                  employees={employees}
                  value={transferForm.to_supervisor_id}
                  onChange={(v) => setTransferForm((f) => ({ ...f, to_supervisor_id: v }))}
                  excludeId={transferringFor.id}
                  placeholder="Keep current supervisor…"
                />
              </div>

              <div className="grid sm:grid-cols-2 gap-3">
                <DateField
                  label="Effective Date *"
                  value={transferForm.effective_date}
                  onChange={(v) => setTransferForm((f) => ({ ...f, effective_date: v }))}
                />
                <TextField
                  label="Remarks / Reason"
                  value={transferForm.reason}
                  onChange={(v) => setTransferForm((f) => ({ ...f, reason: v }))}
                  placeholder="e.g. Promotion, Departmental Shift"
                />
              </div>

              <div className="flex items-center gap-2">
                <button
                  type="button"
                  onClick={handleSaveTransfer}
                  disabled={savingTransfer}
                  className="px-4 py-2 bg-violet-600 hover:bg-violet-700 text-white text-xs font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50"
                >
                  {savingTransfer ? 'Transferring…' : 'Confirm Transfer'}
                </button>
                <button type="button" onClick={closeTransferForm} className="px-3 py-2 text-xs font-semibold text-slate-500 hover:bg-slate-100 rounded-xl transition-colors">
                  Close
                </button>
              </div>

              <div className="pt-2 border-t border-slate-100">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5 mb-2">
                  <History className="w-3.5 h-3.5 text-slate-400" /> Transfer History
                </p>
                {loadingTransferHistory ? (
                  <p className="text-xs text-slate-400">Loading…</p>
                ) : transferHistory.length === 0 ? (
                  <p className="text-xs text-slate-400">No transfers recorded yet for this employee.</p>
                ) : (
                  <div className="space-y-2 max-h-52 overflow-y-auto pr-1">
                    {transferHistory.map((t) => (
                      <div key={t.id} className="rounded-xl border border-slate-200 p-3 text-xs text-slate-600 space-y-1">
                        <div className="flex items-center justify-between">
                          <span className="font-semibold text-slate-700">{toDateInput(t.effective_date) || '—'}</span>
                          {t.action_by_name && <span className="text-slate-400">by {t.action_by_name}</span>}
                        </div>
                        {(t.from_department_name || t.to_department_name) && (
                          <div className="flex items-center gap-1.5">
                            <Building2 className="w-3 h-3 text-slate-400" />
                            <span>{t.from_department_name || '—'}</span>
                            <ArrowRight className="w-3 h-3 text-slate-300" />
                            <span className="font-medium text-slate-800">{t.to_department_name || '—'}</span>
                          </div>
                        )}
                        {(t.from_designation || t.to_designation) && (
                          <div className="flex items-center gap-1.5">
                            <Briefcase className="w-3 h-3 text-slate-400" />
                            <span>{t.from_designation || '—'}</span>
                            <ArrowRight className="w-3 h-3 text-slate-300" />
                            <span className="font-medium text-slate-800">{t.to_designation || '—'}</span>
                          </div>
                        )}
                        {(t.from_supervisor_name || t.to_supervisor_name) && (
                          <div className="flex items-center gap-1.5">
                            <Users2 className="w-3 h-3 text-slate-400" />
                            <span>{t.from_supervisor_name || '—'}</span>
                            <ArrowRight className="w-3 h-3 text-slate-300" />
                            <span className="font-medium text-slate-800">{t.to_supervisor_name || '—'}</span>
                          </div>
                        )}
                        {t.reason && <p className="text-slate-500 italic">"{t.reason}"</p>}
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </div>
        </div>
      )}

      {/* --- Create Login Modal (for an existing employee with no user_id) --- */}
      {creatingLoginFor && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <KeyRound className="w-4.5 h-4.5 text-blue-600" /> Create Login
              </h3>
              <button onClick={closeCreateLoginForm} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
            <form onSubmit={handleCreateLogin} className="p-5 space-y-4">
              <p className="text-xs text-slate-500">
                Creates a User account for <span className="font-semibold text-slate-700">{creatingLoginFor.name}</span>.
              </p>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Username (optional)</label>
                <input
                  type="text"
                  value={loginForm.login_username}
                  onChange={(e) => setLoginForm((f) => ({ ...f, login_username: e.target.value }))}
                  placeholder={creatingLoginFor.email ? `Falls back to ${creatingLoginFor.email}` : 'Required — no Email on file'}
                  className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Login Password *</label>
                <input
                  type="text"
                  value={loginForm.login_password}
                  onChange={(e) => setLoginForm((f) => ({ ...f, login_password: e.target.value }))}
                  placeholder="At least 6 characters"
                  className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                />
              </div>

              {/* Project Access — same optional grant the New Employee form's
                  create_login checkbox offers; see the comment there. */}
              <div className="rounded-xl border border-slate-200 p-3 space-y-2">
                <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                  <FolderKanban className="w-3.5 h-3.5 text-slate-400" /> Project Access
                </p>
                {projects.length === 0 ? (
                  <p className="text-xs text-slate-400">No projects exist yet. Add one from the Projects tab first.</p>
                ) : (
                  <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                    {projects.map((p) => (
                      <label key={p.id} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer py-1">
                        <input
                          type="checkbox"
                          checked={loginForm.login_project_ids.includes(p.id)}
                          onChange={() => toggleLoginFormProject(p.id)}
                          className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                        />
                        {p.project_name}
                      </label>
                    ))}
                  </div>
                )}
              </div>

              {/* Module Access — Superadmin-only, hidden for a plain Admin. */}
              {isSuperAdmin && (
                <div className="rounded-xl border border-slate-200 p-3 space-y-2">
                  <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-600 flex items-center gap-1.5">
                    <LayoutGrid className="w-3.5 h-3.5 text-slate-400" /> Module Access
                  </p>
                  <div className="max-h-36 overflow-y-auto space-y-1 pr-1">
                    {ADMIN_MODULES.map((m) => (
                      <label key={m.key} className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer py-1">
                        <input
                          type="checkbox"
                          checked={loginForm.login_module_keys.includes(m.key)}
                          onChange={() => toggleLoginFormModule(m.key)}
                          className="w-3.5 h-3.5 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                        />
                        {m.label}
                      </label>
                    ))}
                  </div>
                </div>
              )}

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={closeCreateLoginForm}
                  className="px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={creatingLogin}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50"
                >
                  {creatingLogin ? 'Creating…' : 'Create Login'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* --- Link Existing User modal (for an existing employee with no
          user_id, whose login account already exists separately) --- */}
      {linkingUserFor && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-sm w-full shadow-2xl">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Link2 className="w-4.5 h-4.5 text-blue-600" /> Link Existing User
              </h3>
              <button onClick={closeLinkUserForm} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                <X className="w-4.5 h-4.5" />
              </button>
            </div>
            <div className="p-5 space-y-4">
              <p className="text-xs text-slate-500">
                Links <span className="font-semibold text-slate-700">{linkingUserFor.name}</span> to an already-existing
                login account, instead of creating a new one.
              </p>
              <div>
                <label className={fieldLabelClass}>Search users</label>
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={linkUserSearch}
                    onChange={(e) => setLinkUserSearch(e.target.value)}
                    placeholder="Name, email or username"
                    className="block w-full pl-8 pr-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
              </div>
              <div className="max-h-56 overflow-y-auto rounded-xl border border-slate-200 divide-y divide-slate-100">
                {loadingUnlinkedUsers ? (
                  <div className="p-4 text-center"><Spinner /></div>
                ) : filteredUnlinkedUsers.length === 0 ? (
                  <p className="p-4 text-xs text-slate-400 text-center">
                    {unlinkedUsers.length === 0 ? 'No unlinked user accounts found.' : 'No match for that search.'}
                  </p>
                ) : (
                  filteredUnlinkedUsers.map((u) => (
                    <label
                      key={u.id}
                      className={`flex items-center gap-2 px-3 py-2 text-xs cursor-pointer transition-colors ${
                        selectedLinkUserId === u.id ? 'bg-blue-50' : 'hover:bg-slate-50'
                      }`}
                    >
                      <input
                        type="radio"
                        name="link-user"
                        checked={selectedLinkUserId === u.id}
                        onChange={() => setSelectedLinkUserId(u.id)}
                        className="w-3.5 h-3.5 text-blue-600 focus:ring-blue-600 cursor-pointer"
                      />
                      <div className="min-w-0">
                        <div className="font-semibold text-slate-800 truncate">{u.name}</div>
                        <div className="text-[11px] text-slate-400 truncate">{u.email || u.username || '—'}</div>
                      </div>
                    </label>
                  ))
                )}
              </div>
              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={closeLinkUserForm}
                  className="px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={handleLinkUser}
                  disabled={linkingUser || !selectedLinkUserId}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50"
                >
                  {linkingUser ? 'Linking…' : 'Link Account'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

// Small shared input wrappers for the Employee Info / Status / Contact tabs
// above — same visual language (label style, bg-slate-50 rounded-xl input,
// blue-600 focus ring) as every other field already in this form.
const fieldInputClass = "block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none";
const fieldLabelClass = "block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1";

const TextField: React.FC<{ label: string; value: string; onChange: (v: string) => void; placeholder?: string; type?: string }> = ({
  label, value, onChange, placeholder, type = 'text'
}) => (
  <div>
    <label className={fieldLabelClass}>{label}</label>
    <input type={type} value={value} onChange={(e) => onChange(e.target.value)} placeholder={placeholder} className={fieldInputClass} />
  </div>
);

const DateField: React.FC<{ label: string; value: string; onChange: (v: string) => void }> = ({ label, value, onChange }) => (
  <div>
    <label className={fieldLabelClass}>{label}</label>
    <input type="date" value={value} onChange={(e) => onChange(e.target.value)} className={fieldInputClass} />
  </div>
);

const SelectField: React.FC<{ label: string; value: string; onChange: (v: string) => void; options: string[] }> = ({
  label, value, onChange, options
}) => (
  <div>
    <label className={fieldLabelClass}>{label}</label>
    <select value={value} onChange={(e) => onChange(e.target.value)} className={fieldInputClass}>
      <option value="">Select</option>
      {options.map((o) => (
        <option key={o} value={o}>{o}</option>
      ))}
    </select>
  </div>
);

// Searchable Employee picker (used by the Supervisor tab's "Employee
// (Supervisor)" field) — types like a normal input but filters the Employee
// list live by Name OR Employee ID as you type, instead of scrolling a long
// plain <select>. Click a result (or click elsewhere / Escape) to close.
const EmployeeSearchSelect: React.FC<{
  employees: Employee[];
  value: string;
  onChange: (v: string) => void;
  excludeId?: number;
  placeholder?: string;
}> = ({ employees, value, onChange, excludeId, placeholder = 'Search by name or ID…' }) => {
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const selected = employees.find((emp) => String(emp.id) === value) || null;

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (wrapRef.current && !wrapRef.current.contains(e.target as Node)) {
        setOpen(false);
        setQuery('');
      }
    };
    document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, []);

  const q = query.trim().toLowerCase();
  const filtered = employees
    .filter((emp) => emp.id !== excludeId)
    .filter((emp) => !q || emp.name.toLowerCase().includes(q) || (emp.employee_id || '').toLowerCase().includes(q));

  return (
    <div className="relative" ref={wrapRef}>
      <div
        onClick={() => setOpen((o) => !o)}
        className={`${fieldInputClass} cursor-pointer flex items-center justify-between gap-2`}
      >
        <span className={selected ? 'text-slate-900' : 'text-slate-400'}>
          {selected ? `${selected.name}${selected.employee_id ? ' (' + selected.employee_id + ')' : ''}` : 'Select Employee'}
        </span>
        <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
      </div>
      {open && (
        <div className="absolute z-20 mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg overflow-hidden">
          <input
            autoFocus
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Escape') {
                setOpen(false);
                setQuery('');
              }
            }}
            placeholder={placeholder}
            className="block w-full px-3 py-2 text-sm border-b border-slate-100 focus:outline-none"
          />
          <div className="max-h-52 overflow-y-auto">
            {value && (
              <button
                type="button"
                onClick={() => { onChange(''); setQuery(''); setOpen(false); }}
                className="w-full text-left px-3 py-2 text-xs text-slate-400 hover:bg-slate-50 border-b border-slate-100"
              >
                Clear selection
              </button>
            )}
            {filtered.length === 0 ? (
              <p className="px-3 py-3 text-xs text-slate-400 text-center">No employee matches "{query}".</p>
            ) : (
              filtered.slice(0, 50).map((emp) => (
                <button
                  key={emp.id}
                  type="button"
                  onClick={() => { onChange(String(emp.id)); setQuery(''); setOpen(false); }}
                  className={`w-full text-left px-3 py-2 text-sm hover:bg-blue-50 transition-colors ${
                    String(emp.id) === value ? 'bg-blue-50 font-semibold text-blue-700' : 'text-slate-700'
                  }`}
                >
                  {emp.name}
                  {emp.employee_id ? <span className="text-slate-400 font-normal"> ({emp.employee_id})</span> : null}
                </button>
              ))
            )}
          </div>
        </div>
      )}
    </div>
  );
};