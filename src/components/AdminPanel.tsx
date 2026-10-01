import React, { useState, useEffect, useRef, useMemo } from 'react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import credenceLogo from '../assets/credence-logo.png';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { Project, Branch, MprNumber, Entry, User, Budget, BudgetItem, BudgetSubmission, UserProjectPermission, EntryEditHistory, EntryPermanentDeleteLog, BulkUserRow, BulkUserResultItem, AdminModuleKey, ADMIN_MODULES, PermissionLayerKey, PERMISSION_LAYERS, PERMISSION_LAYER_MODULES, LeaveManageLayerKey, LEAVE_MANAGE_LAYERS, AttendanceRecord, ClaimsNavRequest, AdminNavRequest, Department, LeaveApplication, PendingJobEdit } from '../types';
import { Building2, FileText, Users, Users2, BarChart3, Plus, Trash2, Edit2, Search, Filter, UserCheck, Calendar, CalendarClock, Download, Upload, FolderPlus, X, Eye, FileSpreadsheet, KeyRound, History, RotateCcw, Recycle, ListChecks, FileDown, MapPin, LayoutGrid, Navigation, LogIn, LogOut, Bell, Route, ShieldCheck, Wallet, Contact, Lock, Unlock, Mail, CheckCircle2, XCircle, Clock3, ShieldAlert, Copy } from 'lucide-react';
import LocationMapPicker from './LocationMapPicker';
import { NoticeManager } from './NoticeManager';
import { EmployeesPanel } from './EmployeesPanel';
import { ClaimsPanel } from './ClaimsPanel';
import { ConveyanceBillPanel } from './ConveyanceBillPanel';
import { MyConveyanceBillClaimPanel } from './MyConveyanceBillClaimPanel';
import { DisbursementPanel } from './DisbursementPanel';
import { ApprovalManager } from './ApprovalManager';
import { ApprovalTemplateManager } from './ApprovalTemplateManager';
import { ApprovalBadge } from './ApprovalBadge';
import { EmployeeTrackingPanel } from './EmployeeTrackingPanel';
import { OfficeAttendancePanel } from './OfficeAttendancePanel';
import { DeliveryDateConditionsPanel } from './DeliveryDateConditionsPanel';
import { HolidayCalendarPanel } from './HolidayCalendarPanel';
import { AssetManagementAdmin } from './AssetManagementAdmin';
import { ExitOffboardingPanel } from './ExitOffboardingPanel';
import { PerformanceManagementPanel } from './PerformanceManagementPanel';
import { RecruitmentPanel } from './RecruitmentPanel';
import { GrievanceDisciplinaryPanel } from './GrievanceDisciplinaryPanel';
import { HRAnalyticsDashboard } from './HRAnalyticsDashboard';
import { DocumentVaultPanel } from './DocumentVaultPanel';
import { ServerProfilesPanel } from './ServerProfilesPanel';
import { AdminDashboard } from './AdminDashboard';
import { Spinner } from './Spinner';
import { apiUrl } from '../lib/api';
import { formatDate, todayDateOnlyString } from '../lib/formatDate';
import { useStableCallback } from '../lib/useStableCallback';
import { reverseGeocode } from '../lib/reverseGeocode';
import { useBackButtonClose } from '../lib/useBackButtonClose';

// Module Access modal (Admin Panel -> Users -> per-Admin/User "Module
// Access") groups the same Admin Panel tabs into the same labeled clusters
// GlobalSidebar.tsx itself uses (PEPM Manage / HR + its own nested
// Attendance, Claims/Bill/Disbursement and Employee sub-groups / MIS /
// Payroll), so granting access reads the same way it's navigated in the
// sidebar. HR's sub-groups are flattened into their own "HR - ..." labels
// here since this list has no nested-group UI. Any ADMIN_MODULES key not
// listed under one of these falls into "Other" automatically.
const MODULE_ACCESS_GROUPS: { label: string; keys: AdminModuleKey[] }[] = [
  { label: 'PEPM Manage', keys: ['reports', 'mprs', 'imports', 'recycle', 'editlog'] },
  { label: 'HR', keys: ['approvals', 'notices', 'holidays', 'leave_applications', 'departments'] },
  { label: 'HR - Attendance', keys: ['attendance', 'attendance_reports', 'office_attendance'] },
  { label: 'HR - Claims/Bill/Disbursement', keys: ['claims', 'conveyance', 'disbursement'] },
  { label: 'HR - Employee', keys: ['employees', 'tracking', 'asset_management'] },
  { label: 'MIS', keys: ['users', 'projects', 'branches'] },
  { label: 'Payroll', keys: ['payroll'] },
  {
    label: 'Other',
    keys: ADMIN_MODULES.map((m) => m.key).filter(
      (key) => ![
        'reports', 'mprs', 'imports', 'recycle', 'editlog',
        'approvals', 'notices', 'holidays', 'leave_applications', 'departments',
        'attendance', 'attendance_reports', 'office_attendance',
        'claims', 'conveyance', 'disbursement',
        'employees', 'tracking', 'asset_management',
        'users', 'projects', 'branches',
        'payroll',
      ].includes(key)
    )
  }
];

interface AdminPanelProps {
  token: string;
  // The logged-in Admin/Superadmin viewing this panel — used to decide which tabs
  // are visible (a Superadmin always sees every tab; a plain Admin only sees the
  // ones granted via user.module_permissions) and whether Superadmin-only controls
  // (role promotion, Module Access) render in the Users tab.
  user: User;
  // Navbar's web-only "Claims" header menu — jumps this panel's activeTab to
  // 'claims' (Movement Claims) or 'conveyance' (Conveyance Bill Claim). Ignored
  // if this Admin hasn't been granted that module.
  claimsNavRequest?: ClaimsNavRequest | null;
  // Navbar's web-only "Budget" header menu — jumps this panel's activeTab to
  // one of 'reports' / 'mprs' / 'imports' / 'editlog' / 'recycle'. Ignored if
  // this Admin hasn't been granted that module.
  adminNavRequest?: AdminNavRequest | null;
  // Reports this panel's own activeTab back up to App.tsx on every change —
  // whether it moved because of adminNavRequest above, the "View Reports"
  // shortcut inside the Dashboard tab, or its own localStorage-restored
  // default on mount — so GlobalSidebar can highlight whichever item
  // actually matches what's on screen right now, not just the last thing it
  // was asked to navigate to.
  onActiveTabChange?: (tab: string) => void;
}

// Purely presentational, read-only row — memoized so that typing in the report
// filter inputs above (Job No, dates, etc.) only re-renders rows whose underlying
// entry object actually changed, instead of rebuilding every row in a potentially
// long "All MPR Entries" table on every keystroke.
const ReportRow = React.memo(function ReportRow({
  ent,
  onOpenHistory,
  onDelete,
  deletingEntryId
}: {
  ent: Entry;
  onOpenHistory: (entryId: number) => void;
  onDelete: (entryId: number) => void;
  deletingEntryId: number | null;
}) {
  return (
    <tr className="hover:bg-slate-50/80 transition-colors">
      <td className="px-4 py-3.5 whitespace-nowrap text-slate-600 text-xs">{formatDate(ent.entry_date)}</td>
      <td className="px-4 py-3.5 whitespace-nowrap font-semibold text-slate-900 text-xs">{ent.job_name}</td>
      <td className="px-4 py-3.5 whitespace-nowrap font-medium text-slate-900 text-xs">{ent.project_name}</td>
      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
        <div className="font-semibold text-blue-600">{ent.job_no}</div>
        <div className="text-[10px] text-slate-400">{ent.job_duration}</div>
      </td>
      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 font-mono">
          {ent.mpr_no}
        </span>
      </td>
      <td className="px-4 py-3.5 text-slate-800 text-xs">{ent.item_name}</td>
      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
        {ent.matched_rate != null ? (
          <div>
            <div className="font-semibold text-slate-900">
              ৳{Number(ent.computed_amount ?? 0).toLocaleString(undefined, { maximumFractionDigits: 2 })}
            </div>
            <div className="text-[10px] text-slate-400">@ ৳{Number(ent.matched_rate).toLocaleString(undefined, { maximumFractionDigits: 2 })}</div>
          </div>
        ) : ent.rate_calculated_at ? (
          <span className="text-rose-500 text-[10px] font-medium">No rate match</span>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td className="px-4 py-3.5 whitespace-nowrap text-slate-600 text-xs">{ent.category_head || <span className="text-slate-300">—</span>}</td>
      <td className="px-4 py-3.5 whitespace-nowrap text-slate-600 text-xs">{ent.category_sub1 || <span className="text-slate-300">—</span>}</td>
      <td className="px-4 py-3.5 whitespace-nowrap text-slate-600 text-xs">{ent.category_sub2 || <span className="text-slate-300">—</span>}</td>
      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
        {ent.category_sub3 ? (
          <span className="text-slate-600">{ent.category_sub3}</span>
        ) : ent.rate_calculated_at && !ent.category_head ? (
          <span className="text-amber-500 text-[10px] font-medium">No category match</span>
        ) : (
          <span className="text-slate-300">—</span>
        )}
      </td>
      <td className="px-4 py-3.5 whitespace-nowrap text-slate-600 text-xs">{ent.category_sector || <span className="text-slate-300">—</span>}</td>
      <td className="px-4 py-3.5 whitespace-nowrap text-slate-600 text-xs">{formatDate(ent.delivery_date)}</td>
      <td className="px-4 py-3.5 whitespace-nowrap text-slate-500 text-xs">{ent.user_name || 'User'}</td>
      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
        {ent.budget_name ? (
          <span className="px-2 py-0.5 rounded-md bg-blue-50 text-blue-700 border border-blue-100 font-medium">
            {ent.budget_name}
          </span>
        ) : (
          <span className="text-slate-400">—</span>
        )}
      </td>
      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => onOpenHistory(ent.id)}
            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
            title="View edit history"
          >
            <History className="w-3.5 h-3.5" />
          </button>
          <button
            type="button"
            onClick={() => onDelete(ent.id)}
            disabled={deletingEntryId === ent.id}
            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
            title="Delete this entry (moves to Job Recycle bin)"
          >
            <Trash2 className="w-3.5 h-3.5" />
          </button>
        </div>
      </td>
    </tr>
  );
});

// User Management's "Last Login" column — was showing the bare lat/lng pair
// (e.g. "23.7519, 90.3741"), meaningless to read at a glance. Reverse-geocodes
// it into a short place name via the same free Nominatim helper My Claims
// already uses for Check In/Out points, with the raw coordinates kept as a
// title tooltip and the Google Maps link unchanged. Self-contained per row
// (not a bulk lookup keyed by the whole Users list) so it only ever looks up
// what's actually rendered, and re-lookups are free — reverseGeocode's own
// cache (keyed by rounded coordinate) already dedupes accounts sharing a
// login spot, like an office Wi-Fi gate.
const LastLoginAddress: React.FC<{ lat: number; lng: number; asOf?: string }> = ({ lat, lng, asOf }) => {
  const [address, setAddress] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    setAddress(null);
    reverseGeocode(lat, lng).then((addr) => {
      if (!cancelled) setAddress(addr);
    });
    return () => {
      cancelled = true;
    };
  }, [lat, lng]);

  return (
    <a
      href={`https://maps.google.com/?q=${lat},${lng}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex items-start gap-1 text-blue-700 hover:text-blue-900 hover:underline"
      title={`${lat.toFixed(4)}, ${lng.toFixed(4)}${asOf ? ` — as of ${formatDate(asOf)}` : ''}`}
    >
      <MapPin className="w-3.5 h-3.5 shrink-0 mt-0.5" />
      <span className="line-clamp-2">{address ?? `${lat.toFixed(4)}, ${lng.toFixed(4)}`}</span>
    </a>
  );
};

export const AdminPanel: React.FC<AdminPanelProps> = ({ token, user, claimsNavRequest, adminNavRequest, onActiveTabChange }) => {
  const isSuperAdmin = user.role === 'superadmin';
  // Which Admin Panel tabs THIS logged-in Admin/Superadmin may see. A Superadmin
  // always gets every tab; a plain Admin only gets the ones the Superadmin granted
  // (user.module_permissions, refreshed on every login/app-open by App.tsx).
  const visibleModules: AdminModuleKey[] = isSuperAdmin
    ? ADMIN_MODULES.map((m) => m.key)
    : (user.module_permissions || []);
  const canSee = (key: AdminModuleKey) => visibleModules.includes(key);
  // The new Admin Dashboard tab isn't a grantable module (see GlobalSidebar's
  // adminDashboardItem) — it's this account's own home screen, so it's
  // visible whenever the real role is admin/superadmin, regardless of
  // module_permissions (and never for a plain 'user' role account, even one
  // holding module_permissions).
  const isAdminRole = user.role === 'admin' || user.role === 'superadmin';
  // Whether THIS logged-in Admin/Superadmin can see the "Last Login Location"
  // column. Always true for a Superadmin; a plain Admin needs the Superadmin to
  // have explicitly granted user.can_view_login_location.
  const canSeeLoginLocation = isSuperAdmin || !!user.can_view_login_location;
  // Whether THIS logged-in Admin/Superadmin can set another account's Module
  // Access (the "Modules" column below). Always true for a Superadmin; a plain
  // Admin needs the Superadmin to have explicitly granted
  // user.can_grant_module_access — and even then, only ever against a role='user'
  // target (enforced again per-row below, and server-side in
  // PUT /api/users/:id/module-permissions).
  const canGrantModuleAccess = isSuperAdmin || !!user.can_grant_module_access;

  const [activeTab, setActiveTab] = useState<'dashboard' | 'projects' | 'branches' | 'mprs' | 'imports' | 'reports' | 'users' | 'employees' | 'departments' | 'attendance' | 'attendance_reports' | 'leave_applications' | 'office_attendance' | 'tracking' | 'recycle' | 'editlog' | 'notices' | 'claims' | 'approvals' | 'conveyance' | 'my_conveyance' | 'disbursement' | 'holidays' | 'asset_management' | 'servers' | 'permanent_delete_log' | 'exit_offboarding' | 'performance_management' | 'recruitment' | 'grievance_disciplinary' | 'hr_analytics' | 'document_vault'>(
    () => {
      // Restores whichever tab this Admin was last looking at — see the
      // "pull down to reload" note in App.tsx: since a reload now has to be
      // able to land back on the same page, the active tab is mirrored to
      // localStorage (survives a reload) instead of living only in memory.
      try {
        const saved = localStorage.getItem(`mpr_admin_tab_${user.id}`);
        // 'my_conveyance' isn't its own module_permissions entry — it rides
        // along with 'conveyance' (see the tab-visibility effect below).
        // 'servers'/'permanent_delete_log' aren't either — both Superadmin-only,
        // never granted via module_permissions (see ServerProfileRoutes.ts and
        // GET /api/entries/permanent-delete-log respectively).
        const savedVisible =
          saved === 'dashboard' ? isAdminRole :
          saved === 'my_conveyance' ? isSuperAdmin || visibleModules.includes('conveyance') :
          saved === 'servers' || saved === 'permanent_delete_log' ? isSuperAdmin :
          isSuperAdmin || visibleModules.includes(saved as AdminModuleKey);
        if (saved && savedVisible) return saved as any;
      } catch {
        // ignore — falls through to the normal default below
      }
      return isAdminRole ? 'dashboard' : ((visibleModules[0] as any) || 'reports');
    }
  );

  // Keeps the saved tab in sync as the Admin navigates, so the restore above
  // always reflects wherever they actually are.
  useEffect(() => {
    try {
      localStorage.setItem(`mpr_admin_tab_${user.id}`, activeTab);
    } catch {
      // localStorage can be unavailable in some embedded WebViews — safe to
      // ignore, it just means a reload won't be able to restore this tab.
    }
  }, [activeTab, user.id]);

  // Reports the live activeTab up to App.tsx (see onActiveTabChange above) so
  // GlobalSidebar can highlight whichever item actually matches this tab.
  useEffect(() => {
    onActiveTabChange?.(activeTab);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Navbar's web-only "Claims" header menu — jump straight to the matching tab.
  // Silently ignored if this Admin hasn't been granted that module.
  useEffect(() => {
    if (!claimsNavRequest) return;
    const wanted = claimsNavRequest.target === 'movementClaims' ? 'claims' : 'conveyance';
    if (canSee(wanted as AdminModuleKey)) setActiveTab(wanted as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [claimsNavRequest]);

  // Navbar's web-only "Budget" header menu — same idea, for the five tabs it
  // groups (Reports / MPR Nos / Data Import / MPR Edit Log / Job Recycle).
  useEffect(() => {
    if (!adminNavRequest) return;
    if (adminNavRequest.target === 'dashboard') {
      if (isAdminRole) setActiveTab('dashboard');
      return;
    }
    // 'servers'/'permanent_delete_log' aren't AdminModuleKey/module_permissions
    // entries either — both Superadmin-only, same reasoning as 'my_conveyance'
    // below.
    if (adminNavRequest.target === 'servers' || adminNavRequest.target === 'permanent_delete_log') {
      if (isSuperAdmin) setActiveTab(adminNavRequest.target);
      return;
    }
    // 'my_conveyance' isn't its own module_permissions entry — it rides along
    // with 'conveyance' (see the "My Conveyance Bill Claim" item in GlobalSidebar).
    const visible = adminNavRequest.target === 'my_conveyance' ? canSee('conveyance') : canSee(adminNavRequest.target as AdminModuleKey);
    if (visible) setActiveTab(adminNavRequest.target as any);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [adminNavRequest]);

  // If an Admin's module grants change (or they land on a tab they no longer have),
  // fall back to the first tab they can actually see instead of showing a blank/
  // forbidden panel.
  useEffect(() => {
    const activeTabStillVisible =
      activeTab === 'dashboard' ? isAdminRole :
      activeTab === 'servers' || activeTab === 'permanent_delete_log' ? isSuperAdmin :
      activeTab === 'my_conveyance' ? canSee('conveyance') : canSee(activeTab);
    if (!activeTabStillVisible && visibleModules.length > 0) {
      setActiveTab(visibleModules[0] as any);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [visibleModules.join(',')]);

  // --- Superadmin: per-Admin Module Access modal ---
  const [managingModulesFor, setManagingModulesFor] = useState<User | null>(null);
  // Reset Password modal (Admin Panel -> Users) — an Admin/Superadmin sets a brand
  // new password for a user who's forgotten theirs; no old password needed, since
  // that's the whole point (see PUT /api/users/:id/reset-password).
  const [resettingPasswordFor, setResettingPasswordFor] = useState<User | null>(null);
  const [newPasswordInput, setNewPasswordInput] = useState('');
  const [resettingPassword, setResettingPassword] = useState(false);
  // Change Login ID modal (Admin Panel -> Users) — an Admin/Superadmin changes
  // the email address a user logs in with. Same idea as Reset Password above,
  // no old value needed (see PUT /api/users/:id/email).
  const [changingEmailFor, setChangingEmailFor] = useState<User | null>(null);
  const [newEmailInput, setNewEmailInput] = useState('');
  const [changingEmail, setChangingEmail] = useState(false);
  const [selectedModules, setSelectedModules] = useState<Set<AdminModuleKey>>(new Set());
  // Filters the "Admin Module" checkbox list below by label as the
  // Superadmin types — cleared whenever a fresh Module Access modal opens
  // (see setManagingModulesFor(...) call sites).
  const [moduleSearchQuery, setModuleSearchQuery] = useState('');
  // Transient confirmation shown under the "Copy access from" picker after a
  // copy — cleared whenever a fresh Module Access modal opens.
  const [copyAccessNotice, setCopyAccessNotice] = useState('');
  // Granular per-module action layers (Read Only/Edit-Add/Entry-Upload/
  // Delete-Trash/Permanent Delete) — only meaningful for modules listed in
  // PERMISSION_LAYER_MODULES (currently just 'departments'), shown as an
  // extra checkbox row once that module's own checkbox above is ticked. One
  // Set per module key, keyed by AdminModuleKey. Initialized in
  // openManageModules below.
  const [moduleLayers, setModuleLayers] = useState<Record<string, Set<PermissionLayerKey>>>({});
  // Leave Manage's own operation-specific layers (Edit Balance/Set Balance in
  // Bulk/Add Category/Leave Policy) — same idea as moduleLayers above but for
  // the "Also allow editing Leave balances" toggle below (can_manage_leave),
  // not an Admin Module checkbox, since Leave Manage isn't part of the
  // AdminModuleKey/module_permissions system at all. Initialized in
  // openManageModules below.
  const [leaveManageLayers, setLeaveManageLayers] = useState<Set<LeaveManageLayerKey>>(new Set());
  // Department-wise scope for the 'attendance_reports' module only — layered
  // on top of the checkbox above (see PUT /api/users/:id/attendance-report-
  // departments). Empty set = unrestricted (every Department visible), same
  // as before this existed; only meaningful while 'attendance_reports' is
  // checked in selectedModules, but kept even if unchecked mid-edit so
  // re-checking it doesn't lose what was picked in this same modal session.
  const [attendanceReportDepts, setAttendanceReportDepts] = useState<Set<string>>(new Set());
  const [loadingAttendanceReportDepts, setLoadingAttendanceReportDepts] = useState(false);
  // Department-wise scope for the 'leave_applications' module — same idea as
  // attendanceReportDepts above, backed by PUT /api/users/:id/leave-
  // application-departments instead. Empty set = unrestricted.
  const [leaveApplicationDepts, setLeaveApplicationDepts] = useState<Set<string>>(new Set());
  const [loadingLeaveApplicationDepts, setLoadingLeaveApplicationDepts] = useState(false);
  // Department-wise scope for the 'conveyance' module — same idea as
  // attendanceReportDepts/leaveApplicationDepts above, backed by PUT
  // /api/users/:id/conveyance-claim-departments instead. Empty set =
  // unrestricted.
  const [conveyanceClaimDepts, setConveyanceClaimDepts] = useState<Set<string>>(new Set());
  const [loadingConveyanceClaimDepts, setLoadingConveyanceClaimDepts] = useState(false);
  const [userPanelAccessEnabled, setUserPanelAccessEnabled] = useState(false);
  const [leaveManagementAccessEnabled, setLeaveManagementAccessEnabled] = useState(false);
  const [movementClaimAccessEnabled, setMovementClaimAccessEnabled] = useState(false);
  const [conveyanceClaimAccessEnabled, setConveyanceClaimAccessEnabled] = useState(false);
  // ON by default (mirrors can_view_budget_module defaulting to true server-side)
  // — Select a Budget / Jobs / Job Entry Details are on for every account until
  // a Superadmin explicitly turns this off for one.
  const [budgetModuleAccessEnabled, setBudgetModuleAccessEnabled] = useState(true);
  // OFF by default, same pattern as movement/conveyance claim access above —
  // gates Self Service -> Timesheet / Leave Application / My Leave. Employee
  // Directory has no such toggle; every account keeps seeing it.
  const [timesheetAccessEnabled, setTimesheetAccessEnabled] = useState(false);
  const [leaveApplicationAccessEnabled, setLeaveApplicationAccessEnabled] = useState(false);
  const [myLeaveAccessEnabled, setMyLeaveAccessEnabled] = useState(false);
  const [savingModules, setSavingModules] = useState(false);

  // Populates every Module Access form field (User Module toggles, Admin
  // Module checkboxes + their permission layers, Leave Manage layers, and
  // Department scopes) from a given account `u` — shared by openManageModules
  // below (u = the account actually being edited) AND copyAccessFrom further
  // down (u = a DIFFERENT account whose access is being copied onto whoever
  // is currently open in the modal). Deliberately does NOT touch
  // managingModulesFor or moduleSearchQuery — those identify/filter the
  // modal itself, not the access being edited, so copyAccessFrom must leave
  // them alone (the modal stays open on the account being edited; only the
  // form fields change, and nothing is saved until "Save Access" is clicked).
  const applyUserAccessToForm = (u: User) => {
    setSelectedModules(new Set(u.module_permissions || []));
    setUserPanelAccessEnabled(!!u.can_access_user_panel);
    setLeaveManagementAccessEnabled(!!u.can_manage_leave);
    setMovementClaimAccessEnabled(!!u.can_view_movement_claims);
    setConveyanceClaimAccessEnabled(!!u.can_view_conveyance_claims);
    setBudgetModuleAccessEnabled(u.can_view_budget_module !== false);
    setTimesheetAccessEnabled(!!u.can_view_timesheet);
    setLeaveApplicationAccessEnabled(!!u.can_view_leave_application);
    setMyLeaveAccessEnabled(!!u.can_view_my_leave);
    // Permission layers — one Set per module in PERMISSION_LAYER_MODULES.
    // Explicit saved rows win; a module this account already has granted
    // (u.module_permissions) but with NO saved layer rows yet falls back to
    // "every layer except Permanent Delete" (mirrors requireModuleLayer()'s
    // server-side default, so the checkboxes shown here always match what's
    // actually enforced) — a module not yet granted starts with nothing
    // checked.
    const initialLayers: Record<string, Set<PermissionLayerKey>> = {};
    for (const moduleKey of PERMISSION_LAYER_MODULES) {
      const saved = u.module_permission_layers?.[moduleKey];
      if (saved && saved.length > 0) {
        initialLayers[moduleKey] = new Set(saved as PermissionLayerKey[]);
      } else if ((u.module_permissions || []).includes(moduleKey)) {
        initialLayers[moduleKey] = new Set(PERMISSION_LAYERS.map((l) => l.key).filter((k) => k !== 'permanent_delete'));
      } else {
        initialLayers[moduleKey] = new Set();
      }
    }
    setModuleLayers(initialLayers);
    // Leave Manage layers — same "explicit rows win, else full access if
    // already granted, else nothing" default as above, keyed off
    // can_manage_leave (the toggle) instead of module_permissions.
    const savedLeaveLayers = u.module_permission_layers?.leave_manage;
    if (savedLeaveLayers && savedLeaveLayers.length > 0) {
      setLeaveManageLayers(new Set(savedLeaveLayers as LeaveManageLayerKey[]));
    } else if (u.can_manage_leave) {
      setLeaveManageLayers(new Set(LEAVE_MANAGE_LAYERS.map((l) => l.key)));
    } else {
      setLeaveManageLayers(new Set());
    }

    // Attendance Report Department scope — fetched fresh every time this
    // modal opens (never trust stale state from a previously-managed user).
    // Departments this account already supervises (departments.
    // supervisor_user_id) are pre-ticked ONLY the first time a Superadmin
    // ever sets this up (no saved scope rows yet) — a sensible starting
    // point, not a rule: an already-saved scope (even an empty/cleared one)
    // is trusted as-is and never has the Supervisor default re-applied over
    // it, and the pre-tick itself can simply be unticked before Save either way.
    setAttendanceReportDepts(new Set());
    setLoadingAttendanceReportDepts(true);
    fetch(apiUrl(`/api/users/${u.id}/attendance-report-departments`), {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((res) => (res.ok ? res.json() : { departments: [] }))
      .then((data) => {
        const saved: string[] = Array.isArray(data?.departments) ? data.departments : [];
        if (saved.length > 0) {
          setAttendanceReportDepts(new Set(saved));
        } else {
          const supervised = departments.filter((d) => d.supervisor_user_id === u.id).map((d) => d.name);
          setAttendanceReportDepts(new Set(supervised));
        }
      })
      .catch(() => {})
      .finally(() => setLoadingAttendanceReportDepts(false));

    // Leave Application Department scope — same fetch-fresh-on-open and
    // Supervisor-pre-tick-only-if-nothing-saved-yet rules as above, just
    // against the 'leave_applications' module's own endpoint.
    setLeaveApplicationDepts(new Set());
    setLoadingLeaveApplicationDepts(true);
    fetch(apiUrl(`/api/users/${u.id}/leave-application-departments`), {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((res) => (res.ok ? res.json() : { departments: [] }))
      .then((data) => {
        const saved: string[] = Array.isArray(data?.departments) ? data.departments : [];
        if (saved.length > 0) {
          setLeaveApplicationDepts(new Set(saved));
        } else {
          const supervised = departments.filter((d) => d.supervisor_user_id === u.id).map((d) => d.name);
          setLeaveApplicationDepts(new Set(supervised));
        }
      })
      .catch(() => {})
      .finally(() => setLoadingLeaveApplicationDepts(false));

    // Conveyance Claim Department scope — same fetch-fresh-on-open and
    // Supervisor-pre-tick-only-if-nothing-saved-yet rules as above, just
    // against the 'conveyance' module's own endpoint.
    setConveyanceClaimDepts(new Set());
    setLoadingConveyanceClaimDepts(true);
    fetch(apiUrl(`/api/users/${u.id}/conveyance-claim-departments`), {
      headers: { Authorization: `Bearer ${token}` }
    })
      .then((res) => (res.ok ? res.json() : { departments: [] }))
      .then((data) => {
        const saved: string[] = Array.isArray(data?.departments) ? data.departments : [];
        if (saved.length > 0) {
          setConveyanceClaimDepts(new Set(saved));
        } else {
          const supervised = departments.filter((d) => d.supervisor_user_id === u.id).map((d) => d.name);
          setConveyanceClaimDepts(new Set(supervised));
        }
      })
      .catch(() => {})
      .finally(() => setLoadingConveyanceClaimDepts(false));
  };

  const openManageModules = (u: User) => {
    applyUserAccessToForm(u);
    setModuleSearchQuery('');
    setCopyAccessNotice('');
    setManagingModulesFor(u);
  };

  // "Copy access from" (Module Access -> header dropdown) — copies every
  // field applyUserAccessToForm sets from `sourceUser` onto the form for
  // whoever is CURRENTLY open in the modal (managingModulesFor stays
  // unchanged). Nothing is persisted until the Superadmin reviews the
  // now-updated checkboxes/toggles and clicks "Save Access" — this only
  // pre-fills the form, exactly like opening the modal fresh would, just
  // sourced from a different account's saved access instead of the target's
  // own.
  const copyAccessFrom = (sourceUserId: number) => {
    const source = users.find((usr) => usr.id === sourceUserId);
    if (!source) return;
    applyUserAccessToForm(source);
    // "User Panel Access" is Admin-only server-side (PUT .../user-panel-
    // access 400s for a 'user' role target) and the toggle itself is only
    // ever rendered for an Admin target — copying from an Admin source onto
    // a 'user' role target would otherwise leave this checked-but-hidden,
    // which then fires (and 400s) the save call below since it no longer
    // matches the target's own (always-false) can_access_user_panel.
    if (managingModulesFor?.role !== 'admin') {
      setUserPanelAccessEnabled(false);
    }
    setCopyAccessNotice(`Copied access from ${source.name} — review below, then click "Save Access" to apply it.`);
  };

  const toggleAttendanceReportDept = (name: string) => {
    setAttendanceReportDepts((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleLeaveApplicationDept = (name: string) => {
    setLeaveApplicationDepts((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleConveyanceClaimDept = (name: string) => {
    setConveyanceClaimDepts((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const toggleSelectedModule = (key: AdminModuleKey) => {
    setSelectedModules((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleModuleLayer = (moduleKey: AdminModuleKey, layer: PermissionLayerKey) => {
    setModuleLayers((prev) => {
      const current = new Set(prev[moduleKey] || []);
      if (current.has(layer)) current.delete(layer);
      else current.add(layer);
      return { ...prev, [moduleKey]: current };
    });
  };

  const toggleLeaveManageLayer = (layer: LeaveManageLayerKey) => {
    setLeaveManageLayers((prev) => {
      const next = new Set(prev);
      if (next.has(layer)) next.delete(layer);
      else next.add(layer);
      return next;
    });
  };

  const handleSaveModulePermissions = async () => {
    if (!managingModulesFor) return;
    setSavingModules(true);
    try {
      const res = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/module-permissions`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ modules: Array.from(selectedModules) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update module access');

      // Permission layers (Read Only/Edit-Add/Entry-Upload/Delete-Trash/
      // Permanent Delete) for each module that supports them — same "only
      // meaningful/only saved while the module checkbox is ticked" rule as
      // the Department-scope blocks just below.
      for (const moduleKey of PERMISSION_LAYER_MODULES) {
        if (!selectedModules.has(moduleKey)) continue;
        const layerRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/module-permission-layers`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ module: moduleKey, layers: Array.from(moduleLayers[moduleKey] || []) })
        });
        const layerData = await layerRes.json();
        if (!layerRes.ok) throw new Error(layerData.error || `Failed to update permission layers for ${moduleKey}`);
      }

      // Department-wise scope for the 'attendance_reports' module — only
      // meaningful (and only saved) while that module is actually checked
      // above; leaving it unchecked here means the account loses
      // 'attendance_reports' access entirely regardless of any scope rows,
      // so there's nothing useful to persist.
      if (selectedModules.has('attendance_reports')) {
        const deptRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/attendance-report-departments`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ departments: Array.from(attendanceReportDepts) })
        });
        const deptData = await deptRes.json();
        if (!deptRes.ok) throw new Error(deptData.error || 'Failed to update Attendance Report Department access');
      }

      // Department-wise scope for the 'leave_applications' module — same
      // "only save while the module checkbox is actually ticked" rule as
      // attendance_reports above.
      if (selectedModules.has('leave_applications')) {
        const leaveDeptRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/leave-application-departments`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ departments: Array.from(leaveApplicationDepts) })
        });
        const leaveDeptData = await leaveDeptRes.json();
        if (!leaveDeptRes.ok) throw new Error(leaveDeptData.error || 'Failed to update Leave Application Department access');
      }

      // Department-wise scope for the 'conveyance' module — same
      // "only save while the module checkbox is actually ticked" rule as
      // attendance_reports/leave_applications above.
      if (selectedModules.has('conveyance')) {
        const conveyanceDeptRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/conveyance-claim-departments`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ departments: Array.from(conveyanceClaimDepts) })
        });
        const conveyanceDeptData = await conveyanceDeptRes.json();
        if (!conveyanceDeptRes.ok) throw new Error(conveyanceDeptData.error || 'Failed to update Conveyance Claim Department access');
      }

      // Also save the "User Panel Access" toggle, only if it actually changed —
      // this is a separate Superadmin-only switch from the tab checkboxes
      // above. Admin-only server-side (PUT .../user-panel-access 400s for a
      // 'user' role target) — also gated here, not just by the toggle being
      // hidden in the UI for non-Admin targets, since "Copy access from…"
      // can otherwise leave userPanelAccessEnabled mismatched against a
      // 'user' role target's own (always-false) can_access_user_panel after
      // copying from an Admin source, which would otherwise fire this PUT
      // and 400.
      if (managingModulesFor.role === 'admin' && userPanelAccessEnabled !== !!managingModulesFor.can_access_user_panel) {
        const upaRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/user-panel-access`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ can_access_user_panel: userPanelAccessEnabled })
        });
        const upaData = await upaRes.json();
        if (!upaRes.ok) throw new Error(upaData.error || 'Failed to update User Panel access');
      }

      // Also save the "Leave Management Access" toggle, only if it changed —
      // another separate Superadmin-only switch, applies to Admin AND User rows
      // (unlike User Panel Access above, which is Admin-only).
      if (leaveManagementAccessEnabled !== !!managingModulesFor.can_manage_leave) {
        const lmaRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/leave-management-access`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ can_manage_leave: leaveManagementAccessEnabled })
        });
        const lmaData = await lmaRes.json();
        if (!lmaRes.ok) throw new Error(lmaData.error || 'Failed to update Leave Management access');
      }

      // Leave Manage's own operation-specific layers — only meaningful (and
      // only saved) while the toggle above is actually on, same "only save
      // while the master switch is ticked" rule as the module layer saves
      // further up.
      if (leaveManagementAccessEnabled) {
        const leaveLayerRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/module-permission-layers`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ module: 'leave_manage', layers: Array.from(leaveManageLayers) })
        });
        const leaveLayerData = await leaveLayerRes.json();
        if (!leaveLayerRes.ok) throw new Error(leaveLayerData.error || 'Failed to update Leave Manage permission layers');
      }

      // Also save the "Movement Claim" and "Conveyance Bill Claim" access
      // toggles, only if each changed — two more separate Superadmin-only
      // switches, applying to Admin AND User rows same as Leave Management above.
      if (movementClaimAccessEnabled !== !!managingModulesFor.can_view_movement_claims) {
        const mcaRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/movement-claim-access`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ can_view_movement_claims: movementClaimAccessEnabled })
        });
        const mcaData = await mcaRes.json();
        if (!mcaRes.ok) throw new Error(mcaData.error || 'Failed to update Movement Claim access');
      }
      if (conveyanceClaimAccessEnabled !== !!managingModulesFor.can_view_conveyance_claims) {
        const ccaRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/conveyance-claim-access`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ can_view_conveyance_claims: conveyanceClaimAccessEnabled })
        });
        const ccaData = await ccaRes.json();
        if (!ccaRes.ok) throw new Error(ccaData.error || 'Failed to update Conveyance Bill Claim access');
      }

      // Also save the "Budget/Jobs/Job Entry Details" access toggle, only if it
      // changed — ON by default (see budgetModuleAccessEnabled's initial state),
      // so this most commonly fires when a Superadmin turns it OFF for someone.
      if (budgetModuleAccessEnabled !== (managingModulesFor.can_view_budget_module !== false)) {
        const bmaRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/budget-module-access`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ can_view_budget_module: budgetModuleAccessEnabled })
        });
        const bmaData = await bmaRes.json();
        if (!bmaRes.ok) throw new Error(bmaData.error || 'Failed to update Budget/Jobs access');
      }

      // Also save the Timesheet / Leave Application / My Leave access toggles,
      // only if each changed — same "Superadmin-only, off by default" pattern
      // as Movement Claim/Conveyance Bill Claim above.
      if (timesheetAccessEnabled !== !!managingModulesFor.can_view_timesheet) {
        const tsaRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/timesheet-access`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ can_view_timesheet: timesheetAccessEnabled })
        });
        const tsaData = await tsaRes.json();
        if (!tsaRes.ok) throw new Error(tsaData.error || 'Failed to update Timesheet access');
      }
      if (leaveApplicationAccessEnabled !== !!managingModulesFor.can_view_leave_application) {
        const laaRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/leave-application-access`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ can_view_leave_application: leaveApplicationAccessEnabled })
        });
        const laaData = await laaRes.json();
        if (!laaRes.ok) throw new Error(laaData.error || 'Failed to update Leave Application access');
      }
      if (myLeaveAccessEnabled !== !!managingModulesFor.can_view_my_leave) {
        const mlaRes = await fetch(apiUrl(`/api/users/${managingModulesFor.id}/my-leave-access`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ can_view_my_leave: myLeaveAccessEnabled })
        });
        const mlaData = await mlaRes.json();
        if (!mlaRes.ok) throw new Error(mlaData.error || 'Failed to update My Leave access');
      }

      setManagingModulesFor(null);
      fetchAllData();
      setMessage({ type: 'success', text: 'Module access updated.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSavingModules(false);
    }
  };

  const [projects, setProjects] = useState<Project[]>([]);
  const [branches, setBranches] = useState<Branch[]>([]);
  const [departments, setDepartments] = useState<Department[]>([]);
  const [editingDepartment, setEditingDepartment] = useState<Department | null>(null);
  const [deptForm, setDeptForm] = useState<{ name: string; supervisor_user_id: string; include_supervisor_approval: boolean; is_active: boolean }>({
    name: '',
    supervisor_user_id: '',
    include_supervisor_approval: true,
    is_active: true
  });
  const [savingDepartment, setSavingDepartment] = useState(false);
  const [mprNumbers, setMprNumbers] = useState<MprNumber[]>([]);
  const [entries, setEntries] = useState<Entry[]>([]);
  const [users, setUsers] = useState<User[]>([]);
  // User Management table search + role filter — narrows the (often long)
  // users list by name/Login ID and/or role without touching the underlying
  // `users` state, so every other tab (Add User, Departments' Supervisor
  // dropdown, etc.) still sees the full list.
  const [userSearchText, setUserSearchText] = useState('');
  const [userRoleFilter, setUserRoleFilter] = useState<'all' | 'superadmin' | 'admin' | 'user'>('all');
  const filteredUsers = useMemo(() => {
    const q = userSearchText.trim().toLowerCase();
    return users.filter((u) => {
      if (userRoleFilter !== 'all' && u.role !== userRoleFilter) return false;
      if (!q) return true;
      return (
        u.name.toLowerCase().includes(q) ||
        (u.email || '').toLowerCase().includes(q) ||
        (u.username || '').toLowerCase().includes(q)
      );
    });
  }, [users, userSearchText, userRoleFilter]);
  const [budgets, setBudgets] = useState<Budget[]>([]);
  const [permissions, setPermissions] = useState<UserProjectPermission[]>([]);

  // Job Recycle bin — every soft-deleted entry (own delete by a User, or an Admin
  // deleting someone else's entry). Loaded on demand only when that tab is opened.
  const [recycledEntries, setRecycledEntries] = useState<Entry[]>([]);
  const [loadingRecycle, setLoadingRecycle] = useState(false);
  const [restoringEntryId, setRestoringEntryId] = useState<number | null>(null);
  const [erasingEntryId, setErasingEntryId] = useState<number | null>(null);
  const [deletingEntryId, setDeletingEntryId] = useState<number | null>(null);

  // Permanent Delete Log (Superadmin-only tab) — every entry ever erased from
  // the Job Recycle bin above, including ones a Superadmin erased themselves.
  // See GET /api/entries/permanent-delete-log.
  const [permanentDeleteLog, setPermanentDeleteLog] = useState<EntryPermanentDeleteLog[]>([]);
  const [loadingPermanentDeleteLog, setLoadingPermanentDeleteLog] = useState(false);

  const fetchPermanentDeleteLog = async () => {
    setLoadingPermanentDeleteLog(true);
    try {
      const res = await fetch(apiUrl('/api/entries/permanent-delete-log'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setPermanentDeleteLog(await res.json());
    } catch (err) {
      console.error('Failed to load the Permanent Delete Log', err);
    } finally {
      setLoadingPermanentDeleteLog(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'permanent_delete_log') fetchPermanentDeleteLog();
  }, [activeTab]);

  // Entry edit history modal (Reports tab -> History icon per row)
  const [historyEntryId, setHistoryEntryId] = useState<number | null>(null);
  const [historyRecords, setHistoryRecords] = useState<EntryEditHistory[]>([]);
  const [loadingHistory, setLoadingHistory] = useState(false);

  const openEntryHistory = async (entryId: number) => {
    setHistoryEntryId(entryId);
    setHistoryRecords([]);
    setLoadingHistory(true);
    try {
      const res = await fetch(apiUrl(`/api/entries/${entryId}/history`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setHistoryRecords(await res.json());
    } catch (err) {
      console.error('Failed to load entry history', err);
    } finally {
      setLoadingHistory(false);
    }
  };

  const closeEntryHistory = () => {
    setHistoryEntryId(null);
    setHistoryRecords([]);
  };

  // System-wide MPR Edit Log (separate Admin tab) — every entry edit across every
  // User, Job No and MPR No, so an Admin can see at a glance which day which MPR
  // rows were edited without opening each entry's own history one at a time.
  const [mprEditLog, setMprEditLog] = useState<EntryEditHistory[]>([]);
  const [loadingMprEditLog, setLoadingMprEditLog] = useState(false);
  const [editLogSearch, setEditLogSearch] = useState('');

  const fetchMprEditLog = async () => {
    setLoadingMprEditLog(true);
    try {
      const res = await fetch(apiUrl('/api/entries/edit-history'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setMprEditLog(await res.json());
    } catch (err) {
      console.error('Failed to load MPR edit log', err);
    } finally {
      setLoadingMprEditLog(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'editlog') fetchMprEditLog();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Job Edit Approvals — Job Edit's Add MPR / Delete MPR requests queued for review
  // (see EntriesRoutes.ts's job_edit_requests), shown at the top of the same "Edit
  // Log" tab since it's the same "editlog" module access and the same subject
  // (Job Edit) as the log table below it.
  const [jobEditRequests, setJobEditRequests] = useState<PendingJobEdit[]>([]);
  const [loadingJobEditRequests, setLoadingJobEditRequests] = useState(false);
  // Which request id currently has an approve/reject call in flight, so its two
  // buttons (and only its two) disable instead of the whole list.
  const [actingJobEditId, setActingJobEditId] = useState<number | null>(null);
  const [jobEditActionError, setJobEditActionError] = useState('');

  const fetchJobEditRequests = async () => {
    setLoadingJobEditRequests(true);
    try {
      const res = await fetch(apiUrl('/api/job-edits'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setJobEditRequests(await res.json());
    } catch (err) {
      console.error('Failed to load Job Edit requests', err);
    } finally {
      setLoadingJobEditRequests(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'editlog') fetchJobEditRequests();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  const pendingJobEditRequests = jobEditRequests.filter((r) => r.status === 'pending');
  // Approved/Rejected within roughly the same window the server itself keeps
  // returning them for (see GET /api/job-edits/mine's 2-day window) — just for
  // context under "Recently Reviewed", not meant to be a full audit trail (the MPR
  // Edit Log table below already covers approved Add MPRs permanently).
  const recentlyReviewedJobEditRequests = jobEditRequests.filter((r) => r.status !== 'pending');

  const actOnJobEditRequest = async (id: number, action: 'approve' | 'reject') => {
    if (action === 'reject' && !window.confirm('Reject this Job Edit request?')) return;
    setActingJobEditId(id);
    setJobEditActionError('');
    try {
      const res = await fetch(apiUrl(`/api/job-edits/${id}/act`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to act on this request');
      // An approved Add MPR shows up in the MPR Edit Log table too — refresh both.
      await Promise.all([fetchJobEditRequests(), fetchMprEditLog()]);
    } catch (err: any) {
      setJobEditActionError(err.message || 'Something went wrong');
    } finally {
      setActingJobEditId(null);
    }
  };

  // One line describing what a Job Edit request is actually proposing — used by
  // both the pending list and the recently-reviewed list below.
  const describeJobEditRequest = (r: PendingJobEdit) => {
    if (r.action === 'add_item') {
      const p = r.payload || {};
      return `Add MPR ${p.mpr_no || '—'} · ${p.item_name || '—'} · Qty ${p.requisitioned_qty ?? '—'} · Delivery ${formatDate(p.delivery_date || '') || '—'}`;
    }
    if (r.action === 'add_job') {
      const p = r.payload || {};
      const items = Array.isArray(p.items) ? p.items : [];
      return `New Job "${p.job_name || '—'}" · ${p.project_name || '—'} · ${p.budget_name || '—'} · ${items.length} MPR row${items.length === 1 ? '' : 's'}`;
    }
    return `Delete MPR ${r.entry_mpr_no || '—'} · ${r.entry_item_name || '—'} · Qty ${r.entry_requisitioned_qty ?? '—'} · Delivery ${formatDate(r.entry_delivery_date || '') || '—'}`;
  };

  // The Edit Reason the requesting user gave — same payload.reason field across all
  // three actions (add_item, add_job, delete_entry) — used alongside
  // describeJobEditRequest above.
  const jobEditRequestReason = (r: PendingJobEdit): string => String((r.payload || {}).reason || '').trim();

  // Remote Attendance (separate Admin tab, Superadmin always sees it) — every
  // Check In / Check Out a User has recorded, system-wide, filterable by
  // Project/User/date. Loaded on demand only when that tab is opened.
  const [attendanceRecords, setAttendanceRecords] = useState<AttendanceRecord[]>([]);
  const [loadingAttendance, setLoadingAttendance] = useState(false);
  const [attendanceProjectFilter, setAttendanceProjectFilter] = useState('');
  const [attendanceUserFilter, setAttendanceUserFilter] = useState('');
  const [attendanceFromFilter, setAttendanceFromFilter] = useState('');
  const [attendanceToFilter, setAttendanceToFilter] = useState('');

  const fetchAttendance = async () => {
    setLoadingAttendance(true);
    try {
      const params = new URLSearchParams();
      if (attendanceProjectFilter) params.set('project_id', attendanceProjectFilter);
      if (attendanceUserFilter) params.set('user_id', attendanceUserFilter);
      if (attendanceFromFilter) params.set('from', attendanceFromFilter);
      if (attendanceToFilter) params.set('to', attendanceToFilter);
      const res = await fetch(apiUrl(`/api/attendance?${params.toString()}`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setAttendanceRecords(await res.json());
    } catch (err) {
      console.error('Failed to load attendance', err);
    } finally {
      setLoadingAttendance(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'attendance') fetchAttendance();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab]);

  // Monthly Attendance Report (separate Admin tab from the raw 'attendance'
  // log above, its own 'attendance_reports' module — can be granted to an
  // Admin OR a plain User independently) — two sub-views: Month Wise (every
  // User's day-by-day Present/Absent grid for one month) and Date Wise
  // (Present vs Absent split for one specific day).
  const now = new Date();
  const [attendanceReportView, setAttendanceReportView] = useState<'month' | 'date'>('month');
  // Admin Panel -> Approvals has two engines side by side: the OLD single
  // global chain (ApprovalManager — its own "Queue"/"Manage Chain" views) and
  // the NEW per-Employee/per-Request-Type Templates (ApprovalTemplateManager).
  // This just switches which one is visible; both hit their own APIs.
  const [approvalsSection, setApprovalsSection] = useState<'queue' | 'templates'>('queue');
  const [reportProjectFilter, setReportProjectFilter] = useState('');
  const [reportEmployeeFilter, setReportEmployeeFilter] = useState('');
  const [reportDepartmentFilter, setReportDepartmentFilter] = useState('');
  const [reportDepartments, setReportDepartments] = useState<string[]>([]);
  // Month Wise grid cell display — 'symbol' is the original compact P/A/H/W
  // per day (times only on hover); 'times' widens each day column and prints
  // the actual Check In/Out time stacked in the cell, for when the Admin
  // wants to read times off the grid directly instead of hovering every cell.
  const [monthlyCellDisplay, setMonthlyCellDisplay] = useState<'symbol' | 'times'>('symbol');

  // Admin Panel -> Monthly Leave Application (its own 'leave_applications'
  // module — separate from the 'attendance_reports' module above, and from
  // can_manage_leave / the old approver-based "Leave Approvals" page). A
  // read-only list of every submitted Leave Application, Department-scoped
  // server-side (GET /api/leave-applications/report) the same way the
  // Attendance Report is above.
  const [leaveApplicationsReport, setLeaveApplicationsReport] = useState<LeaveApplication[]>([]);
  const [leaveApplicationsReportLoading, setLeaveApplicationsReportLoading] = useState(false);
  const [leaveApplicationsReportError, setLeaveApplicationsReportError] = useState('');
  const [leaveApplicationsReportSearch, setLeaveApplicationsReportSearch] = useState('');
  const [leaveApplicationsReportDeptFilter, setLeaveApplicationsReportDeptFilter] = useState('');
  const [leaveApplicationsReportDepartments, setLeaveApplicationsReportDepartments] = useState<string[]>([]);

  const [reportYear, setReportYear] = useState(now.getFullYear());
  const [reportMonth, setReportMonth] = useState(now.getMonth() + 1);
  const [loadingMonthlyReport, setLoadingMonthlyReport] = useState(false);
  const [monthlyReport, setMonthlyReport] = useState<any>(null);

  const [reportDate, setReportDate] = useState(todayDateOnlyString());
  const [loadingDailyReport, setLoadingDailyReport] = useState(false);
  const [dailyReport, setDailyReport] = useState<any>(null);

  const fetchMonthlyReport = async () => {
    setLoadingMonthlyReport(true);
    try {
      const params = new URLSearchParams();
      params.set('year', String(reportYear));
      params.set('month', String(reportMonth));
      if (reportProjectFilter) params.set('project_id', reportProjectFilter);
      if (reportEmployeeFilter) params.set('user_id', reportEmployeeFilter);
      if (reportDepartmentFilter) params.set('department', reportDepartmentFilter);
      const res = await fetch(apiUrl(`/api/attendance/report/monthly?${params.toString()}`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setMonthlyReport(await res.json());
    } catch (err) {
      console.error('Failed to load monthly attendance report', err);
    } finally {
      setLoadingMonthlyReport(false);
    }
  };

  const fetchDailyReport = async () => {
    setLoadingDailyReport(true);
    try {
      const params = new URLSearchParams();
      params.set('date', reportDate);
      if (reportProjectFilter) params.set('project_id', reportProjectFilter);
      if (reportEmployeeFilter) params.set('user_id', reportEmployeeFilter);
      if (reportDepartmentFilter) params.set('department', reportDepartmentFilter);
      const res = await fetch(apiUrl(`/api/attendance/report/daily?${params.toString()}`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setDailyReport(await res.json());
    } catch (err) {
      console.error('Failed to load daily attendance report', err);
    } finally {
      setLoadingDailyReport(false);
    }
  };

  // "Filtered By" box on both exports below — whichever of Project/Employee/
  // Department is currently active, resolved to its display name (not the
  // raw id/value the API call itself used).
  const activeReportFilters = (): [string, string][] => {
    const filters: [string, string][] = [];
    if (reportProjectFilter) {
      const proj = projects.find((p) => String(p.id) === reportProjectFilter);
      filters.push(['Project', proj?.project_name || reportProjectFilter]);
    }
    if (reportEmployeeFilter) {
      const emp = users.find((u) => String(u.id) === reportEmployeeFilter);
      filters.push(['Employee', emp?.name || reportEmployeeFilter]);
    }
    if (reportDepartmentFilter) filters.push(['Department', reportDepartmentFilter]);
    return filters;
  };

  // Export PDF — Month Wise. Landscape (up to 31 day columns plus Present/
  // Holiday/Absent totals needs the extra width A4 portrait doesn't have),
  // one row per Employee with the same compact P/H/W/- symbol the on-screen
  // grid uses in "Symbols" mode — the actual per-day Check In/Out times don't
  // fit legibly across that many columns on paper, so the PDF always uses
  // symbols regardless of which mode the on-screen toggle is set to.
  const handleExportMonthlyReportPdf = async () => {
    if (!monthlyReport || monthlyReport.users.length === 0) return;
    const logoImg = await loadImageElement(credenceLogo);
    const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });

    const monthLabel = new Date(monthlyReport.year, monthlyReport.month - 1, 1).toLocaleString('en-US', { month: 'long' });
    const letterheadOptions = {
      reportTitle: `Monthly Attendance Report — ${monthLabel} ${monthlyReport.year}`,
      filters: activeReportFilters()
    };
    const contentStartY = drawPdfLetterhead(doc, logoImg, letterheadOptions);

    const dayHeaders = Array.from({ length: monthlyReport.days_in_month }, (_, i) => String(i + 1));

    autoTable(doc, {
      startY: contentStartY,
      margin: { top: contentStartY, left: 6, right: 6 },
      head: [['Employee', ...dayHeaders, 'P', 'H', 'A']],
      body: monthlyReport.users.map((u: any) => {
        const daySymbols = u.days.map((d: any) => {
          const isHoliday = !!d.day_type;
          return d.present ? 'P' : isHoliday ? (d.day_type === 'weekend' ? 'W' : 'H') : '-';
        });
        return [u.user_name, ...daySymbols, String(u.present_days), String(u.holiday_days ?? 0), String(u.absent_days)];
      }),
      styles: { fontSize: 5.5, cellPadding: 0.8, halign: 'center', overflow: 'visible' },
      columnStyles: { 0: { cellWidth: 26, halign: 'left', fontStyle: 'bold' } },
      headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 5.5 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      // Same color convention as the on-screen grid: green Present, amber
      // Holiday, sky Weekend, slate Absent.
      didParseCell: (data: any) => {
        if (data.section === 'body' && data.column.index > 0 && data.column.index <= monthlyReport.days_in_month) {
          const val = data.cell.raw;
          if (val === 'P') data.cell.styles.textColor = [5, 150, 105];
          else if (val === 'H') data.cell.styles.textColor = [217, 119, 6];
          else if (val === 'W') data.cell.styles.textColor = [2, 132, 199];
          else if (val === '-') data.cell.styles.textColor = [148, 163, 184];
        }
      },
      didDrawPage: () => drawPdfLetterhead(doc, logoImg, letterheadOptions)
    });

    const finalY = (doc as any).lastAutoTable.finalY;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(`Total Employees: ${monthlyReport.users.length}`, 6, finalY + 8);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(7.5);
    doc.setTextColor(100, 116, 139);
    doc.text('P = Present   H = Holiday   W = Weekend   - = Absent', 6, finalY + 13);

    finalizePdfPageNumbers(doc);
    const filename = `Monthly_Attendance_Report_${monthlyReport.year}_${String(monthlyReport.month).padStart(2, '0')}.pdf`;
    await savePdfCrossPlatform(doc, filename);
  };

  // Export PDF — Date Wise. Portrait, one row per Employee across all three
  // groups (Present / Absent / Holiday) with a colored Status column, same
  // convention as ConveyanceBillPanel/UserPanel's own PDF exports.
  const handleExportDailyReportPdf = async () => {
    if (!dailyReport) return;
    const logoImg = await loadImageElement(credenceLogo);
    const doc = new jsPDF({ orientation: 'portrait', unit: 'mm', format: 'a4' });

    const letterheadOptions = {
      reportTitle: 'Monthly Attendance Report — Date Wise',
      filters: [['Date', formatDate(dailyReport.date) || dailyReport.date], ...activeReportFilters()] as [string, string][]
    };
    const contentStartY = drawPdfLetterhead(doc, logoImg, letterheadOptions);

    const timeOnly = (v: string | null | undefined) =>
      v ? new Date(v).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '—';

    const rows: any[] = [
      ...dailyReport.present.map((p: any) => [
        'Present',
        p.user_name,
        p.department || '—',
        p.project_name || '—',
        timeOnly(p.check_in_at),
        timeOnly(p.check_out_at),
        p.source === 'office' ? 'ZKT' : 'GPS'
      ]),
      ...dailyReport.absent.map((a: any) => ['Absent', a.user_name, a.department || '—', '—', '—', '—', '—']),
      ...dailyReport.on_holiday.map((h: any) => ['Holiday', h.user_name, h.department || '—', '—', '—', '—', '—'])
    ];

    autoTable(doc, {
      startY: contentStartY,
      margin: { top: contentStartY, left: 10, right: 10 },
      head: [['Status', 'Employee', 'Department', 'Project', 'Check In', 'Check Out', 'Source']],
      body: rows,
      styles: { fontSize: 7.5, cellPadding: 1.5, overflow: 'linebreak' },
      headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 7.5 },
      alternateRowStyles: { fillColor: [248, 250, 252] },
      didParseCell: (data: any) => {
        if (data.section === 'body' && data.column.index === 0) {
          const val = data.cell.raw;
          if (val === 'Present') data.cell.styles.textColor = [5, 150, 105];
          else if (val === 'Absent') data.cell.styles.textColor = [225, 29, 72];
          else if (val === 'Holiday') data.cell.styles.textColor = [217, 119, 6];
        }
      },
      didDrawPage: () => drawPdfLetterhead(doc, logoImg, letterheadOptions)
    });

    const finalY = (doc as any).lastAutoTable.finalY;
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(9);
    doc.setTextColor(15, 23, 42);
    doc.text(
      `Present: ${dailyReport.present.length}   Absent: ${dailyReport.absent.length}   Holiday: ${dailyReport.on_holiday.length}   Total: ${dailyReport.total_users}`,
      10,
      finalY + 8
    );

    finalizePdfPageNumbers(doc);
    const filename = `Daily_Attendance_Report_${dailyReport.date}.pdf`;
    await savePdfCrossPlatform(doc, filename);
  };

  const fetchReportDepartments = async () => {
    try {
      const res = await fetch(apiUrl('/api/attendance/report/departments'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setReportDepartments(await res.json());
    } catch (err) {
      console.error('Failed to load department list', err);
    }
  };

  useEffect(() => {
    if (activeTab !== 'attendance_reports') return;
    if (attendanceReportView === 'month') fetchMonthlyReport();
    else fetchDailyReport();
    if (reportDepartments.length === 0) fetchReportDepartments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, attendanceReportView]);

  // Monthly Leave Application report — fetched fresh whenever the Department
  // filter changes (the filter is applied server-side, same as Attendance
  // Report's ?department= above) and whenever this tab is opened.
  const fetchLeaveApplicationsReport = async () => {
    setLeaveApplicationsReportLoading(true);
    setLeaveApplicationsReportError('');
    try {
      const qs = leaveApplicationsReportDeptFilter ? `?department=${encodeURIComponent(leaveApplicationsReportDeptFilter)}` : '';
      const res = await fetch(apiUrl(`/api/leave-applications/report${qs}`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load Leave Applications');
      setLeaveApplicationsReport(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setLeaveApplicationsReportError(err.message || 'Failed to load Leave Applications');
    } finally {
      setLeaveApplicationsReportLoading(false);
    }
  };

  const fetchLeaveApplicationsReportDepartments = async () => {
    try {
      const res = await fetch(apiUrl('/api/leave-applications/report/departments'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setLeaveApplicationsReportDepartments(await res.json());
    } catch (err) {
      console.error('Failed to load department list', err);
    }
  };

  useEffect(() => {
    if (activeTab !== 'leave_applications') return;
    fetchLeaveApplicationsReport();
    if (leaveApplicationsReportDepartments.length === 0) fetchLeaveApplicationsReportDepartments();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeTab, leaveApplicationsReportDeptFilter]);

  // Groups the flat edit-log rows by calendar day (in the local timezone), newest day
  // first, so the tab reads as "which MPR rows were edited on which day" instead of one
  // long undifferentiated list — matching how the Admin actually wants to scan it.
  const mprEditLogByDay = () => {
    const q = editLogSearch.trim().toLowerCase();
    const filtered = q
      ? mprEditLog.filter(
          (h) =>
            (h.job_no || '').toLowerCase().includes(q) ||
            (h.mpr_no || '').toLowerCase().includes(q) ||
            (h.entry_owner_name || '').toLowerCase().includes(q) ||
            (h.editor_name || '').toLowerCase().includes(q)
        )
      : mprEditLog;
    const groups = new Map<string, EntryEditHistory[]>();
    for (const h of filtered) {
      const day = formatDate(h.edited_at) || 'Unknown date';
      if (!groups.has(day)) groups.set(day, []);
      groups.get(day)!.push(h);
    }
    return Array.from(groups.entries());
  };

  const FIELD_LABELS: Record<string, string> = {
    item_name: 'Item Name',
    delivery_date: 'Delivery Date',
    mpr_no: 'MPR No',
    job_name: 'Job Name',
    job_duration: 'Job Duration',
    requisitioned_qty: 'Requisitioned Qty',
    // A brand-new MPR row added into an already Final-Submitted Job via the "Job
    // Edit" feature (Admin Panel -> Users -> Job Edit permission) — distinct from an
    // edit to an existing row, since there's no "old value" to show, just what was
    // newly added (see new_value on this row for its Qty/Delivery Date).
    job_edit_add: 'MPR Added (Job Edit)',
    // A brand-new Job created via Job Edit's "Add New Job" (same permission, same
    // Admin approval flow as job_edit_add above) — new_value carries the new Job No
    // plus this row's Qty/Delivery Date, since there's no "old value" either.
    job_edit_new_job: 'New Job Added (Job Edit)'
  };

  // --- Export the (currently searched/filtered) MPR Edit Log to Excel (.xlsx) ---
  // Same flat row shape as the on-screen table, minus the day-grouping (a plain sheet
  // is easier to re-filter/pivot in Excel than the day-header rows would be).
  const handleExportEditLogExcel = () => {
    const rows = mprEditLogByDay().flatMap(([day, records]) =>
      records.map((h) => ({
        Date: day,
        Time: new Date(h.edited_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        'Job No': h.job_no || '',
        'MPR No': h.mpr_no || '',
        'Item Name': h.item_name || '',
        'Job Owner': h.entry_owner_name || '',
        'Field Changed': FIELD_LABELS[h.field_name] || h.field_name,
        From: h.old_value || '',
        To: h.new_value || '',
        'Edited By': h.editor_name || ''
      }))
    );

    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = new Array(10).fill({ wch: 16 });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'MPR Edit Log');
    XLSX.writeFile(workbook, `MPR_Edit_Log_${todayDateOnlyString()}.xlsx`);
  };

  // Manage-Projects modal (Admin sets which Projects a User can access)
  const [managingUser, setManagingUser] = useState<User | null>(null);
  const [selectedProjectIds, setSelectedProjectIds] = useState<Set<number>>(new Set());
  // Search box inside the "Project Access" modal — filters the checklist so an Admin
  // doesn't have to scroll through every Project to find the one they want.
  const [managePermSearch, setManagePermSearch] = useState('');
  const [savingPermissions, setSavingPermissions] = useState(false);

  // Form states for adding/editing
  const [newProjectName, setNewProjectName] = useState('');
  const [editingProject, setEditingProject] = useState<Project | null>(null);
  const [projectListSearch, setProjectListSearch] = useState('');
  const [showAllProjects, setShowAllProjects] = useState(false);
  // Site location pin for the project being added/edited (free OpenStreetMap/
  // Leaflet picker — see LocationMapPicker). Null lat/lng = no pin set yet.
  const [projectLocation, setProjectLocation] = useState<{ lat: number | null; lng: number | null; label: string | null; radius: number | null }>({
    lat: null,
    lng: null,
    radius: null,
    label: null
  });
  const [showLocationPicker, setShowLocationPicker] = useState(false);

  // Same pattern as the Project form states just above, for Admin Panel ->
  // Branches. Kept as its own separate set of state (not reused from Projects)
  // since the two forms/pickers can't otherwise tell which one is open.
  const [newBranchName, setNewBranchName] = useState('');
  const [editingBranch, setEditingBranch] = useState<Branch | null>(null);
  const [branchListSearch, setBranchListSearch] = useState('');
  const [showAllBranches, setShowAllBranches] = useState(false);
  const [branchLocation, setBranchLocation] = useState<{ lat: number | null; lng: number | null; label: string | null; radius: number | null }>({
    lat: null,
    lng: null,
    radius: null,
    label: null
  });
  const [showBranchLocationPicker, setShowBranchLocationPicker] = useState(false);

  const [newMprNo, setNewMprNo] = useState('');
  const [editingMpr, setEditingMpr] = useState<MprNumber | null>(null);
  const [mprListSearch, setMprListSearch] = useState('');
  const [showAllMprs, setShowAllMprs] = useState(false);

  // Budget (Excel import) state
  const [showNewBudgetForm, setShowNewBudgetForm] = useState(false);
  const [newBudgetName, setNewBudgetName] = useState('');
  const [creatingBudget, setCreatingBudget] = useState(false);
  const [activeBudgetId, setActiveBudgetId] = useState<number | null>(null);
  const [activeBudgetName, setActiveBudgetName] = useState('');
  const [importingBudgetId, setImportingBudgetId] = useState<number | null>(null);
  const pendingImportBudgetId = useRef<number | null>(null);
  const budgetFileInputRef = useRef<HTMLInputElement | null>(null);
  const bulkUsersFileInputRef = useRef<HTMLInputElement | null>(null);
  // "Submit" (publish) a Budget so it becomes visible to Users — until this is clicked,
  // a Budget only exists here on the Admin's Data Import page.
  const [publishingBudgetId, setPublishingBudgetId] = useState<number | null>(null);

  // Rate File (Excel import, two sheets: "Rate" + "Materials Category") state
  const [importingRateFile, setImportingRateFile] = useState(false);
  const [rateFileSummary, setRateFileSummary] = useState<{
    rate_count: number;
    category_count: number;
    original_filename: string | null;
    imported_at: string | null;
  } | null>(null);
  const rateFileInputRef = useRef<HTMLInputElement | null>(null);

  // Rate File "View" modal
  const [showRateFileModal, setShowRateFileModal] = useState(false);
  const [rateFileModalTab, setRateFileModalTab] = useState<'rate' | 'category'>('rate');
  const [rateListData, setRateListData] = useState<any[]>([]);
  const [categoryListData, setCategoryListData] = useState<any[]>([]);
  const [loadingRateFileData, setLoadingRateFileData] = useState(false);
  const [rateFileSearch, setRateFileSearch] = useState('');

  // "Approve & Calculate" per Budget — matches Rate/Category onto every entry.
  const [approvingBudgetId, setApprovingBudgetId] = useState<number | null>(null);
  const [approveResult, setApproveResult] = useState<{
    budgetName: string;
    total_entries: number;
    matched_rate_count: number;
    missing_rate: { item_name: string; specification: string }[];
    missing_category: string[];
  } | null>(null);

  // Budget view modal (full imported Excel data for one budget)
  const [viewingBudget, setViewingBudget] = useState<Budget | null>(null);
  const [viewingBudgetItems, setViewingBudgetItems] = useState<BudgetItem[]>([]);
  const [loadingBudgetItems, setLoadingBudgetItems] = useState(false);

  // Delivery Date range modal — lets the Admin set the allowed Delivery Date window
  // for a Budget (after it's been imported). Users then can't pick a Delivery Date
  // outside this window when creating/editing an MPR Entry under that Budget.
  const [rangeBudget, setRangeBudget] = useState<Budget | null>(null);
  const [rangeFrom, setRangeFrom] = useState('');
  const [rangeTo, setRangeTo] = useState('');
  const [savingRange, setSavingRange] = useState(false);
  const [rangeError, setRangeError] = useState('');

  // Budget Submissions modal — who has Final Submitted this Budget, with a manual
  // "Unlock" per user (see /api/budgets/:id/submissions and the DELETE next to it;
  // the same lock also lifts itself automatically once a user's last active entry
  // under the Budget is deleted, this modal is the Admin's manual override for it).
  const [submissionsBudget, setSubmissionsBudget] = useState<Budget | null>(null);
  const [budgetSubmissions, setBudgetSubmissions] = useState<BudgetSubmission[]>([]);
  const [loadingSubmissions, setLoadingSubmissions] = useState(false);
  const [unlockingUserId, setUnlockingUserId] = useState<number | null>(null);

  // Add-user form state
  const [newUserName, setNewUserName] = useState('');
  const [newUserEmail, setNewUserEmail] = useState('');
  const [newUserPassword, setNewUserPassword] = useState('');
  const [newUserRole, setNewUserRole] = useState<'user' | 'admin'>('user');
  const [creatingUser, setCreatingUser] = useState(false);

  // Bulk Add Users state — a small editable table of { Project Name, Password }
  // rows (SL is just the row's position, shown for reference, not stored). Users
  // created this way log in with Project Name + Password instead of email.
  const [showBulkUsers, setShowBulkUsers] = useState(false);
  const [bulkRows, setBulkRows] = useState<{ project_name: string; password: string }[]>([
    { project_name: '', password: '' },
    { project_name: '', password: '' },
    { project_name: '', password: '' },
  ]);
  const [bulkPasteText, setBulkPasteText] = useState('');
  const [bulkImporting, setBulkImporting] = useState(false);
  const [bulkResult, setBulkResult] = useState<{ created: BulkUserResultItem[]; skipped: BulkUserResultItem[] } | null>(null);

  // Filters for reports
  const [filterJobNo, setFilterJobNo] = useState('');
  const [filterProjectId, setFilterProjectId] = useState('');
  const [filterStartDate, setFilterStartDate] = useState('');
  const [filterEndDate, setFilterEndDate] = useState('');
  const [filterBudgetId, setFilterBudgetId] = useState('');

  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  // Android hardware back button: closes whichever modal is currently open
  // instead of exiting the app (see useBackButtonClose.ts). Each line is a
  // no-op unless that particular modal's state is actually set.
  useBackButtonClose(deletingEntryId !== null, () => setDeletingEntryId(null));
  useBackButtonClose(historyEntryId !== null, closeEntryHistory);
  useBackButtonClose(managingUser !== null, () => setManagingUser(null));
  useBackButtonClose(editingProject !== null, () => setEditingProject(null));
  useBackButtonClose(editingBranch !== null, () => setEditingBranch(null));
  useBackButtonClose(editingMpr !== null, () => setEditingMpr(null));
  useBackButtonClose(showNewBudgetForm, () => setShowNewBudgetForm(false));
  useBackButtonClose(showRateFileModal, () => setShowRateFileModal(false));
  useBackButtonClose(viewingBudget !== null, () => setViewingBudget(null));
  useBackButtonClose(rangeBudget !== null, () => setRangeBudget(null));
  useBackButtonClose(submissionsBudget !== null, () => setSubmissionsBudget(null));
  useBackButtonClose(showBulkUsers, () => setShowBulkUsers(false));
  useBackButtonClose(approveResult !== null, () => setApproveResult(null));

  useEffect(() => {
    fetchAllData();
  }, [token]);

  const fetchAllData = async () => {
    try {
      const [projRes, branchRes, mprRes, entRes, userRes, budgetRes, permRes, deptRes] = await Promise.all([
        fetch(apiUrl('/api/projects'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/branches'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/mpr-numbers'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/entries'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/users'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/budgets'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/permissions'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/departments'), { headers: { Authorization: `Bearer ${token}` } })
      ]);

      if (projRes.ok) setProjects(await projRes.json());
      if (branchRes.ok) setBranches(await branchRes.json());
      if (mprRes.ok) setMprNumbers(await mprRes.json());
      if (entRes.ok) setEntries(await entRes.json());
      if (userRes.ok) setUsers(await userRes.json());
      if (budgetRes.ok) setBudgets(await budgetRes.json());
      if (permRes.ok) setPermissions(await permRes.json());
      if (deptRes.ok) setDepartments(await deptRes.json());
    } catch (err) {
      console.error('Failed to load admin data', err);
    }
  };

  const fetchRateFileSummary = async () => {
    try {
      const res = await fetch(apiUrl('/api/rate-file/summary'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setRateFileSummary(await res.json());
    } catch (err) {
      console.error('Failed to load Rate File summary', err);
    }
  };

  useEffect(() => {
    if (activeTab === 'imports') fetchRateFileSummary();
  }, [activeTab]);

  const openRateFileModal = async () => {
    setShowRateFileModal(true);
    setRateFileModalTab('rate');
    setRateFileSearch('');
    setLoadingRateFileData(true);
    try {
      const [rateRes, catRes] = await Promise.all([
        fetch(apiUrl('/api/rate-file/rate-list'), { headers: { Authorization: `Bearer ${token}` } }),
        fetch(apiUrl('/api/rate-file/categories'), { headers: { Authorization: `Bearer ${token}` } })
      ]);
      if (rateRes.ok) setRateListData(await rateRes.json());
      if (catRes.ok) setCategoryListData(await catRes.json());
    } catch (err) {
      console.error('Failed to load Rate File data', err);
    } finally {
      setLoadingRateFileData(false);
    }
  };

  const closeRateFileModal = () => {
    setShowRateFileModal(false);
    setRateListData([]);
    setCategoryListData([]);
    setRateFileSearch('');
  };

  // Downloads the current Missing Rate / Missing Category list from an Approve &
  // Calculate result as a .xlsx — same column shape shown on screen, so it can be
  // filled in and merged back into the Rate File for re-import.
  const downloadMissingListExcel = (
    kind: 'rate' | 'category',
    result: { budgetName: string; missing_rate: { item_name: string; specification: string }[]; missing_category: string[] }
  ) => {
    const wb = XLSX.utils.book_new();
    if (kind === 'rate') {
      const sheetRows = result.missing_rate.map((r) => ({
        'Materials Name': r.item_name,
        Specification: r.specification || '',
        Rate: ''
      }));
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      ws['!cols'] = [{ wch: 35 }, { wch: 25 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Missing Rate');
      XLSX.writeFile(wb, `Missing_Rate_${result.budgetName.replace(/[^a-z0-9]+/gi, '_')}.xlsx`);
    } else {
      const sheetRows = result.missing_category.map((name) => ({
        'Materials Name': name,
        Head: '',
        'Sub-1': '',
        'Sub-2': '',
        'Sub-3': '',
        Sector: ''
      }));
      const ws = XLSX.utils.json_to_sheet(sheetRows);
      ws['!cols'] = [{ wch: 35 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 15 }, { wch: 12 }];
      XLSX.utils.book_append_sheet(wb, ws, 'Missing Category');
      XLSX.writeFile(wb, `Missing_Category_${result.budgetName.replace(/[^a-z0-9]+/gi, '_')}.xlsx`);
    }
  };

  const handleApproveBudget = async (budget: Budget) => {
    setApprovingBudgetId(budget.id);
    setMessage(null);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${budget.id}/approve`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Approve & Calculate failed');

      setApproveResult({
        budgetName: budget.budget_name,
        total_entries: data.total_entries,
        matched_rate_count: data.matched_rate_count,
        missing_rate: data.missing_rate || [],
        missing_category: data.missing_category || []
      });
      fetchAllData(); // refresh budgets (rate_approved_at) + entries (matched_rate/amount/category)
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to approve & calculate this budget.' });
    } finally {
      setApprovingBudgetId(null);
    }
  };

  // --- Budget "Submit" (publish) Handler ---
  // Flips a Budget's visibility for Users. Until this is clicked, the Budget was only
  // ever visible here on the Admin's Data Import page — Users can't pick it, so they
  // can't see or enter anything against it.
  const handlePublishBudget = async (budget: Budget, publish: boolean) => {
    setPublishingBudgetId(budget.id);
    setMessage(null);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${budget.id}/publish`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ published: publish })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update submission status');
      setMessage({
        type: 'success',
        text: publish
          ? `Budget "${budget.budget_name}" submitted — Users can now see it.`
          : `Budget "${budget.budget_name}" withdrawn — Users can no longer see it.`
      });
      fetchAllData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to update this budget\'s submission status.' });
    } finally {
      setPublishingBudgetId(null);
    }
  };

  // --- Job Recycle Handlers ---

  const fetchRecycledEntries = async () => {
    setLoadingRecycle(true);
    try {
      const res = await fetch(apiUrl('/api/entries/recycle'), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setRecycledEntries(await res.json());
    } catch (err) {
      console.error('Failed to load Job Recycle bin', err);
    } finally {
      setLoadingRecycle(false);
    }
  };

  useEffect(() => {
    if (activeTab === 'recycle') fetchRecycledEntries();
  }, [activeTab]);

  const handleRestoreEntry = async (id: number) => {
    setRestoringEntryId(id);
    try {
      const res = await fetch(apiUrl(`/api/entries/${id}/restore`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to restore entry');

      setRecycledEntries((prev) => prev.filter((e) => e.id !== id));
      fetchAllData();
      setMessage({ type: 'success', text: 'Entry restored.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setRestoringEntryId(null);
    }
  };

  const handlePermanentDelete = async (id: number) => {
    if (!confirm('Permanently erase this entry? This cannot be undone.')) return;
    setErasingEntryId(id);
    try {
      const res = await fetch(apiUrl(`/api/entries/${id}/permanent`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to permanently delete entry');

      setRecycledEntries((prev) => prev.filter((e) => e.id !== id));
      setMessage({ type: 'success', text: 'Entry permanently erased.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setErasingEntryId(null);
    }
  };

  // Delete an entry from the "All MPR Entries" report (Admin-only action here, though
  // the same DELETE endpoint also lets a User delete their own). This is a SOFT
  // delete — the entry moves into the Job Recycle bin (Reports -> Job Recycle) so it
  // can still be restored, rather than being erased outright.
  const handleDeleteEntry = async (id: number) => {
    if (!confirm('Delete this entry? It will be moved to the Job Recycle bin.')) return;
    setDeletingEntryId(id);
    try {
      const res = await fetch(apiUrl(`/api/entries/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Failed to delete entry');

      setEntries((prev) => prev.filter((e) => e.id !== id));
      setMessage({ type: 'success', text: 'Entry moved to the Job Recycle bin.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setDeletingEntryId(null);
    }
  };

  // --- Projects Handlers ---

  const handleSaveProject = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newProjectName.trim()) return;

    try {
      const url = editingProject ? `/api/projects/${editingProject.id}` : '/api/projects';
      const method = editingProject ? 'PUT' : 'POST';

      const res = await fetch(apiUrl(url), {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          project_name: newProjectName.trim(),
          location_lat: projectLocation.lat,
          location_lng: projectLocation.lng,
          location_label: projectLocation.label,
          location_radius: projectLocation.radius
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save project');

      setNewProjectName('');
      setEditingProject(null);
      setProjectLocation({ lat: null, lng: null, label: null, radius: null });
      fetchAllData();
      setMessage({ type: 'success', text: 'Project saved successfully.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleDeleteProject = async (id: number) => {
    if (!confirm('Are you sure you want to delete this project?')) return;
    try {
      const res = await fetch(apiUrl(`/api/projects/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        fetchAllData();
        setMessage({ type: 'success', text: 'Project deleted.' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // --- Branches Handlers --- (same pattern as Projects above)

  const handleSaveBranch = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBranchName.trim()) return;

    try {
      const url = editingBranch ? `/api/branches/${editingBranch.id}` : '/api/branches';
      const method = editingBranch ? 'PUT' : 'POST';

      const res = await fetch(apiUrl(url), {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          branch_name: newBranchName.trim(),
          location_lat: branchLocation.lat,
          location_lng: branchLocation.lng,
          location_label: branchLocation.label,
          location_radius: branchLocation.radius
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save branch');

      setNewBranchName('');
      setEditingBranch(null);
      setBranchLocation({ lat: null, lng: null, label: null, radius: null });
      fetchAllData();
      setMessage({ type: 'success', text: 'Branch saved successfully.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleDeleteBranch = async (id: number) => {
    if (!confirm('Are you sure you want to delete this branch?')) return;
    try {
      const res = await fetch(apiUrl(`/api/branches/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        fetchAllData();
        setMessage({ type: 'success', text: 'Branch deleted.' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // --- Departments Handlers --- (same pattern as Branches above)

  const openCreateDepartment = () => {
    setEditingDepartment(null);
    setDeptForm({ name: '', supervisor_user_id: '', include_supervisor_approval: true, is_active: true });
  };

  const openEditDepartment = (d: Department) => {
    setEditingDepartment(d);
    setDeptForm({
      name: d.name,
      supervisor_user_id: d.supervisor_user_id ? String(d.supervisor_user_id) : '',
      include_supervisor_approval: d.include_supervisor_approval,
      is_active: d.is_active
    });
  };

  const handleSaveDepartment = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!deptForm.name.trim()) return;

    setSavingDepartment(true);
    try {
      const url = editingDepartment ? `/api/departments/${editingDepartment.id}` : '/api/departments';
      const method = editingDepartment ? 'PUT' : 'POST';
      const res = await fetch(apiUrl(url), {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: deptForm.name.trim(),
          supervisor_user_id: deptForm.supervisor_user_id ? Number(deptForm.supervisor_user_id) : null,
          include_supervisor_approval: deptForm.include_supervisor_approval,
          is_active: deptForm.is_active
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save department');

      setEditingDepartment(null);
      setDeptForm({ name: '', supervisor_user_id: '', include_supervisor_approval: true, is_active: true });
      fetchAllData();
      setMessage({ type: 'success', text: 'Department saved successfully.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSavingDepartment(false);
    }
  };

  const handleDeleteDepartment = async (id: number) => {
    if (!confirm('Delete this Department? Employees linked to it will just lose that link — nothing else about them changes.')) return;
    try {
      const res = await fetch(apiUrl(`/api/departments/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        fetchAllData();
        setMessage({ type: 'success', text: 'Department deleted.' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // --- MPR Numbers Handlers ---
  const handleSaveMpr = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newMprNo.trim()) return;

    try {
      const url = editingMpr ? `/api/mpr-numbers/${editingMpr.id}` : '/api/mpr-numbers';
      const method = editingMpr ? 'PUT' : 'POST';

      const res = await fetch(apiUrl(url), {
        method,
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ mpr_no: newMprNo.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save MPR number');

      setNewMprNo('');
      setEditingMpr(null);
      fetchAllData();
      setMessage({ type: 'success', text: 'MPR number saved successfully.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleDeleteMpr = async (id: number) => {
    if (!confirm('Are you sure you want to delete this MPR number?')) return;
    try {
      const res = await fetch(apiUrl(`/api/mpr-numbers/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        fetchAllData();
        setMessage({ type: 'success', text: 'MPR number deleted.' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // --- Budget (Excel Import) Handlers ---
  const handleCreateBudget = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newBudgetName.trim()) return;

    setCreatingBudget(true);
    setMessage(null);
    try {
      const res = await fetch(apiUrl('/api/budgets'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ budget_name: newBudgetName.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create budget');

      setActiveBudgetId(data.id);
      setActiveBudgetName(data.budget_name);
      setNewBudgetName('');
      setShowNewBudgetForm(false);
      fetchAllData();
      setMessage({ type: 'success', text: `Budget "${data.budget_name}" created. Now choose the Excel file to import.` });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setCreatingBudget(false);
    }
  };

  const handleDeleteBudget = async (id: number) => {
    if (!confirm('Delete this budget and all its imported rows? This cannot be undone.')) return;
    try {
      const res = await fetch(apiUrl(`/api/budgets/${id}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) {
        if (activeBudgetId === id) {
          setActiveBudgetId(null);
          setActiveBudgetName('');
        }
        fetchAllData();
        setMessage({ type: 'success', text: 'Budget deleted.' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Normalize an Excel header cell so header variants/typos still match
  // (e.g. "Sl.No.", "Req. No.", "Aproved Date" as given in the real template).
  const normalizeHeader = (h: string) =>
    h.toString().trim().toLowerCase().replace(/\./g, '').replace(/\s+/g, ' ').trim();

  const BUDGET_HEADER_MAP: Record<string, string> = {
    'slno': 'sl_no',
    'project name': 'project_name',
    'req no': 'req_no',
    'mrf no': 'mrf_no',
    'date': 'item_date',
    'description of materials': 'description',
    'unit': 'unit',
    'specification': 'specification',
    'req qty': 'req_qty',
    'reqqty': 'req_qty',
    'req quantity': 'req_qty',
    'reqd qty': 'req_qty',
    'required qty': 'req_qty',
    'requisition qty': 'req_qty',
    'purchase order qty': 'po_qty',
    'received qty': 'received_qty',
    'balance qty': 'balance_qty',
    'entry user': 'entry_user',
    'aproved date': 'approved_date',
    'approved date': 'approved_date',
    'app user': 'app_user',
    'site sup date': 'site_sup_date'
  };

  const DATE_FIELDS = new Set(['item_date', 'approved_date', 'site_sup_date']);

  // Last-resort fallback for the Req. Qty column: if the header text isn't one of the
  // exact variants above (e.g. the real sheet has extra wording like "Req. Qty (Nos)"),
  // still catch it as long as it clearly says "req" + "qty" and isn't one of the OTHER
  // Qty columns — this is the column that feeds the Qty shown in Job Entry Details, so
  // a missed match here is what makes that column look empty after import.
  const looksLikeReqQtyHeader = (normalized: string): boolean =>
    normalized.includes('req') &&
    normalized.includes('qty') &&
    !normalized.includes('order') &&
    !normalized.includes('received') &&
    !normalized.includes('balance');

  const excelCellToString = (val: any): string => {
    if (val == null) return '';
    if (val instanceof Date) return val.toISOString().split('T')[0];
    return String(val).trim();
  };

  const triggerBudgetImport = (budgetId: number) => {
    pendingImportBudgetId.current = budgetId;
    budgetFileInputRef.current?.click();
  };

  const handleBudgetFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    const budgetId = pendingImportBudgetId.current;
    e.target.value = ''; // allow re-selecting the same file later
    if (!file || !budgetId) return;

    setImportingBudgetId(budgetId);
    setMessage(null);
    try {
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: 'array', cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (rawRows.length === 0) {
        setMessage({ type: 'error', text: 'The Excel file has no data rows.' });
        return;
      }

      const rows = rawRows.map((row) => {
        const mapped: Record<string, string> = {};
        for (const key of Object.keys(row)) {
          const normalized = normalizeHeader(key);
          let field = BUDGET_HEADER_MAP[normalized];
          if (!field && looksLikeReqQtyHeader(normalized)) field = 'req_qty';
          if (!field) continue;
          mapped[field] = DATE_FIELDS.has(field) ? excelCellToString(row[key]) : String(row[key] ?? '').trim();
        }
        return mapped;
      });

      // Also send the original file itself (base64) so the server can save it as-is —
      // the Admin can re-download/view exactly what was imported later.
      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Could not read the Excel file'));
        reader.readAsDataURL(file);
      });

      const res = await fetch(apiUrl(`/api/budgets/${budgetId}/import`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          rows,
          file_base64: fileBase64,
          file_name: file.name,
          file_mimetype: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');

      setMessage({
        type: 'success',
        text: `Imported ${data.items_inserted} row(s). MPR No added: ${data.mpr_added} (already existed: ${data.mpr_already_existing}). Projects added: ${data.projects_added} (already existed: ${data.projects_already_existing}).`
      });
      fetchAllData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to import the Excel file.' });
    } finally {
      setImportingBudgetId(null);
      pendingImportBudgetId.current = null;
    }
  };

  const triggerRateFileImport = () => {
    rateFileInputRef.current?.click();
  };

  // "Rate" sheet header -> field name
  const RATE_HEADER_MAP: Record<string, string> = {
    'materials name': 'materials_name',
    'unit': 'unit',
    'rate': 'rate',
    'specification': 'specification',
    'assigned person': 'assigned_person',
    'remarks': 'remarks'
  };

  // "Materials Category" sheet header -> field name (source header has a typo,
  // "Detials", which normalizeHeader still matches exactly as given)
  const CATEGORY_HEADER_MAP: Record<string, string> = {
    'sl no': 'sl_no',
    'head': 'head',
    'sub-1': 'sub1',
    'sub1': 'sub1',
    'sub-2': 'sub2',
    'sub2': 'sub2',
    'sub-3': 'sub3',
    'sub3': 'sub3',
    'detials': 'details',
    'details': 'details',
    'sector': 'sector'
  };

  const mapSheetRows = (rawRows: any[], headerMap: Record<string, string>) =>
    rawRows.map((row) => {
      const mapped: Record<string, string> = {};
      for (const key of Object.keys(row)) {
        const field = headerMap[normalizeHeader(key)];
        if (!field) continue;
        mapped[field] = excelCellToString(row[key]);
      }
      return mapped;
    });

  const handleRateFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    setImportingRateFile(true);
    setMessage(null);
    try {
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: 'array', cellDates: true });

      const rateSheet = workbook.Sheets['Rate'];
      const categorySheet = workbook.Sheets['Materials Category'];
      if (!rateSheet && !categorySheet) {
        setMessage({
          type: 'error',
          text: 'Could not find a "Rate" or "Materials Category" sheet in this Excel file. Check the sheet tab names.'
        });
        return;
      }

      const rateRawRows: any[] = rateSheet ? XLSX.utils.sheet_to_json(rateSheet, { defval: '' }) : [];
      const categoryRawRows: any[] = categorySheet ? XLSX.utils.sheet_to_json(categorySheet, { defval: '' }) : [];

      const rate_rows = mapSheetRows(rateRawRows, RATE_HEADER_MAP);
      const category_rows = mapSheetRows(categoryRawRows, CATEGORY_HEADER_MAP);

      const fileBase64 = await new Promise<string>((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve((reader.result as string).split(',')[1] || '');
        reader.onerror = () => reject(new Error('Could not read the Excel file'));
        reader.readAsDataURL(file);
      });

      const res = await fetch(apiUrl('/api/rate-file/import'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          rate_rows,
          category_rows,
          file_base64: fileBase64,
          file_name: file.name,
          file_mimetype: file.type || 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Import failed');

      setMessage({
        type: 'success',
        text: `Rate File imported: ${data.rate_inserted} Rate row(s), ${data.category_inserted} Materials Category row(s). This replaced whatever was saved before.`
      });
      fetchRateFileSummary();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to import the Rate file.' });
    } finally {
      setImportingRateFile(false);
    }
  };

  const openRangeModal = (budget: Budget) => {
    setRangeBudget(budget);
    setRangeFrom(budget.delivery_date_from || '');
    setRangeTo(budget.delivery_date_to || '');
    setRangeError('');
  };

  const closeRangeModal = () => {
    setRangeBudget(null);
    setRangeFrom('');
    setRangeTo('');
    setRangeError('');
  };

  const handleSaveDeliveryRange = async () => {
    if (!rangeBudget) return;
    if (rangeFrom && rangeTo && rangeFrom > rangeTo) {
      setRangeError('Delivery Date From must be on or before Delivery Date To.');
      return;
    }
    setSavingRange(true);
    setRangeError('');
    try {
      const res = await fetch(apiUrl(`/api/budgets/${rangeBudget.id}/delivery-range`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ delivery_date_from: rangeFrom || null, delivery_date_to: rangeTo || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save Delivery Date range');

      setBudgets((prev) =>
        prev.map((b) =>
          b.id === rangeBudget.id ? { ...b, delivery_date_from: rangeFrom || null, delivery_date_to: rangeTo || null } : b
        )
      );
      setMessage({ type: 'success', text: `Delivery Date range saved for "${rangeBudget.budget_name}".` });
      closeRangeModal();
    } catch (err: any) {
      setRangeError(err.message);
    } finally {
      setSavingRange(false);
    }
  };

  // --- Budget Submissions modal (manual unlock) ---

  const fetchBudgetSubmissions = async (budget: Budget) => {
    setLoadingSubmissions(true);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${budget.id}/submissions`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (res.ok) setBudgetSubmissions(await res.json());
    } catch (err) {
      console.error('Failed to load Budget submissions', err);
    } finally {
      setLoadingSubmissions(false);
    }
  };

  const openSubmissionsModal = (budget: Budget) => {
    setSubmissionsBudget(budget);
    setBudgetSubmissions([]);
    fetchBudgetSubmissions(budget);
  };

  const closeSubmissionsModal = () => {
    setSubmissionsBudget(null);
    setBudgetSubmissions([]);
  };

  // Manual unlock: lifts this one user's Final Submit lock on this Budget, whether
  // or not they still have active entries under it (the automatic version — see
  // EntriesRoutes.ts unlockBudgetSubmissionIfEmpty — only fires once their entries
  // are all gone; this is the Admin's override for any other reason to reopen it).
  const handleUnlockSubmission = async (userId: number) => {
    if (!submissionsBudget) return;
    if (!confirm('Unlock this user\'s Final Submit on this Budget? They will be able to add new entries to it again.')) return;
    setUnlockingUserId(userId);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${submissionsBudget.id}/submissions/${userId}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to unlock');
      setBudgetSubmissions((prev) => prev.filter((s) => s.user_id !== userId));
      setMessage({ type: 'success', text: 'Submission unlocked — this user can add entries to this Budget again.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to unlock this submission.' });
    } finally {
      setUnlockingUserId(null);
    }
  };

  const handleViewBudget = async (budget: Budget) => {
    setViewingBudget(budget);
    setViewingBudgetItems([]);
    setLoadingBudgetItems(true);
    try {
      const res = await fetch(apiUrl(`/api/budgets/${budget.id}/items`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) throw new Error('Failed to load budget data');
      setViewingBudgetItems(await res.json());
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to load budget data' });
    } finally {
      setLoadingBudgetItems(false);
    }
  };

  const handleDownloadBudgetFile = async (budgetId: number, fallbackName: string) => {
    try {
      const res = await fetch(apiUrl(`/api/budgets/${budgetId}/file`), {
        headers: { Authorization: `Bearer ${token}` }
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        throw new Error(data.error || 'Failed to download the Excel file');
      }
      const disposition = res.headers.get('Content-Disposition') || '';
      const match = disposition.match(/filename="?([^"]+)"?/);
      const filename = match ? decodeURIComponent(match[1]) : `${fallbackName || 'budget'}.xlsx`;
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to download the Excel file' });
    }
  };

  // --- User Management Handlers ---
  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!newUserName.trim() || !newUserEmail.trim() || !newUserPassword.trim()) return;

    setCreatingUser(true);
    setMessage(null);
    try {
      const res = await fetch(apiUrl('/api/users'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          name: newUserName.trim(),
          email: newUserEmail.trim(),
          password: newUserPassword,
          role: newUserRole
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create user');

      setNewUserName('');
      setNewUserEmail('');
      setNewUserPassword('');
      setNewUserRole('user');
      fetchAllData();
      setMessage({ type: 'success', text: `User "${data.name}" created successfully.` });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setCreatingUser(false);
    }
  };

  // --- Bulk Add Users Handlers ---
  const addBulkRow = () => setBulkRows((rows) => [...rows, { project_name: '', password: '' }]);

  const removeBulkRow = (idx: number) =>
    setBulkRows((rows) => (rows.length > 1 ? rows.filter((_, i) => i !== idx) : rows));

  const updateBulkRow = (idx: number, field: 'project_name' | 'password', value: string) =>
    setBulkRows((rows) => rows.map((r, i) => (i === idx ? { ...r, [field]: value } : r)));

  // Parses pasted rows (e.g. copied straight from Excel: Project Name, Password
  // columns) — accepts tab, comma, or multi-space separated values, one row per line.
  const handleParseBulkPaste = () => {
    const lines = bulkPasteText.split('\n').map((l) => l.trim()).filter(Boolean);
    if (lines.length === 0) return;
    const parsed = lines.map((line) => {
      const parts = line.split(/\t|,|\s{2,}/).map((p) => p.trim()).filter(Boolean);
      return { project_name: parts[0] || '', password: parts[1] || '' };
    });
    setBulkRows(parsed);
    setBulkPasteText('');
  };

  const triggerBulkUsersFileImport = () => bulkUsersFileInputRef.current?.click();

  // Reads an uploaded Excel/CSV (columns: SL, Project Name, Password — SL is
  // optional/ignored, header names are matched loosely so "Project" / "Password" /
  // "Pass" etc. still work) and fills the rows table below for review before Import.
  const handleBulkUsersFileSelected = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = ''; // allow re-selecting the same file later
    if (!file) return;

    setMessage(null);
    try {
      const buf = await file.arrayBuffer();
      const workbook = XLSX.read(buf, { type: 'array', cellDates: true });
      const sheet = workbook.Sheets[workbook.SheetNames[0]];
      const rawRows: any[] = XLSX.utils.sheet_to_json(sheet, { defval: '' });

      if (rawRows.length === 0) {
        setMessage({ type: 'error', text: 'The Excel file has no data rows.' });
        return;
      }

      const parsed = rawRows.map((row) => {
        let project_name = '';
        let password = '';
        for (const key of Object.keys(row)) {
          const normalized = normalizeHeader(key);
          const value = String(row[key] ?? '').trim();
          if (normalized.includes('project')) project_name = value;
          else if (normalized.includes('pass')) password = value;
        }
        return { project_name, password };
      }).filter((r) => r.project_name || r.password);

      if (parsed.length === 0) {
        setMessage({ type: 'error', text: 'Could not find "Project Name" / "Password" columns in that file.' });
        return;
      }

      setBulkRows(parsed);
      setBulkResult(null);
      setMessage({ type: 'success', text: `Loaded ${parsed.length} row(s) from the Excel file — review below, then click Import Users.` });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Failed to read the Excel file.' });
    }
  };

  const handleBulkImport = async () => {
    const rows = bulkRows
      .map((r, i) => ({ sl: i + 1, project_name: r.project_name.trim(), password: r.password }))
      .filter((r) => r.project_name || r.password);

    if (rows.length === 0) {
      setMessage({ type: 'error', text: 'Add at least one row (Project Name + Password) before importing.' });
      return;
    }

    setBulkImporting(true);
    setMessage(null);
    setBulkResult(null);
    try {
      const res = await fetch(apiUrl('/api/users/bulk'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ rows })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Bulk import failed');

      setBulkResult({ created: data.created, skipped: data.skipped });
      setMessage({
        type: data.skipped_count > 0 ? 'error' : 'success',
        text: `Imported ${data.created_count} user${data.created_count === 1 ? '' : 's'}.` +
          (data.skipped_count > 0 ? ` ${data.skipped_count} row${data.skipped_count === 1 ? '' : 's'} skipped — see details below.` : '')
      });
      if (data.created_count > 0) {
        setBulkRows([{ project_name: '', password: '' }]);
        fetchAllData();
      }
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setBulkImporting(false);
    }
  };

  const handleRoleChange = async (userId: number, newRole: 'admin' | 'user') => {
    try {
      const res = await fetch(apiUrl(`/api/users/${userId}/role`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ role: newRole })
      });
      if (res.ok) {
        fetchAllData();
        setMessage({ type: 'success', text: 'User role updated.' });
      }
    } catch (err) {
      console.error(err);
    }
  };

  // Toggle one of the per-user feature permissions — can_edit_delivery_date
  // (Delivery Date edit, ON by default), can_job_edit (the User Page's "Job Edit"
  // section, OFF by default), or can_use_attendance (the Remote Attendance card on
  // their own Dashboard, OFF by default). Sends only the one field that changed;
  // the server keeps the others at their current value.
  const handleFeaturePermissionToggle = async (
    userId: number,
    field:
      | 'can_edit_delivery_date'
      | 'can_job_edit'
      | 'can_use_attendance'
      | 'can_use_tracking'
      | 'can_view_leave_summary'
      // Superadmin-only, and only ever sent for a role='admin' target — the
      // server silently ignores it from anyone/anything else (see PUT
      // /api/users/:id/feature-permissions in UserManagement.ts).
      | 'can_grant_module_access',
    value: boolean
  ) => {
    try {
      const res = await fetch(apiUrl(`/api/users/${userId}/feature-permissions`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ [field]: value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update permission');
      fetchAllData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  // Sets or clears the single Project a user/admin account is pinned to for
  // Remote Attendance (Admin Panel -> Users -> "Attend. Project", right next
  // to the can_use_attendance toggle). Reuses the same feature-permissions
  // endpoint as the toggles above — sending just this one field leaves every
  // other permission untouched. `projectId` is null to clear back to
  // unrestricted (falls back to whatever Projects the account can otherwise
  // see for Attendance).
  const handleAttendanceProjectChange = async (userId: number, projectId: number | null) => {
    try {
      const res = await fetch(apiUrl(`/api/users/${userId}/feature-permissions`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ attendance_project_id: projectId })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update attendance project');
      fetchAllData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  // Superadmin-only: grant/revoke a given Admin's ability to see the "Last Login
  // Location" column for other users (Admin Panel -> Users). OFF by default for
  // every Admin; a Superadmin always sees it regardless of this toggle.
  const handleLoginLocationAccessToggle = async (userId: number, value: boolean) => {
    try {
      const res = await fetch(apiUrl(`/api/users/${userId}/login-location-access`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ can_view_login_location: value })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update permission');
      fetchAllData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    }
  };

  const handleDeleteUser = async (userId: number) => {
    if (!confirm('Are you sure you want to delete this user?')) return;
    try {
      const res = await fetch(apiUrl(`/api/users/${userId}`), {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${token}` }
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete user');
      fetchAllData();
      setMessage({ type: 'success', text: 'User deleted.' });
    } catch (err: any) {
      alert(err.message);
    }
  };

  // A quick, memorable random password — 8 characters drawn from an
  // unambiguous set (no 0/O/1/l/I) so it's easy to read aloud or retype if the
  // Admin hands it to the user verbally instead of typing it in for them.
  const generateRandomPassword = () => {
    const chars = 'ABCDEFGHJKMNPQRSTUVWXYZabcdefghjkmnpqrstuvwxyz23456789';
    let out = '';
    for (let i = 0; i < 8; i++) out += chars[Math.floor(Math.random() * chars.length)];
    setNewPasswordInput(out);
  };

  const handleResetPassword = async () => {
    if (!resettingPasswordFor) return;
    if (newPasswordInput.length < 6) {
      setMessage({ type: 'error', text: 'New password must be at least 6 characters.' });
      return;
    }
    setResettingPassword(true);
    try {
      const res = await fetch(apiUrl(`/api/users/${resettingPasswordFor.id}/reset-password`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ new_password: newPasswordInput })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to reset password');
      setMessage({ type: 'success', text: `Password reset for ${resettingPasswordFor.name}. Share the new password with them directly — it won't be shown again.` });
      setResettingPasswordFor(null);
      setNewPasswordInput('');
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setResettingPassword(false);
    }
  };

  const handleChangeEmail = async () => {
    if (!changingEmailFor) return;
    const trimmed = (newEmailInput || '').trim();
    if (!trimmed || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(trimmed)) {
      setMessage({ type: 'error', text: 'Enter a valid email address.' });
      return;
    }
    setChangingEmail(true);
    try {
      const res = await fetch(apiUrl(`/api/users/${changingEmailFor.id}/email`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ new_email: trimmed })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update Login ID');
      setMessage({ type: 'success', text: `Login ID updated for ${changingEmailFor.name}.` });
      setChangingEmailFor(null);
      setNewEmailInput('');
      fetchAllData();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setChangingEmail(false);
    }
  };

  // --- User <-> Project Permissions ---

  const projectIdsForUser = (userId: number) =>
    new Set(permissions.filter((p) => p.user_id === userId).map((p) => p.project_id));

  const openManageProjects = (u: User) => {
    setSelectedProjectIds(projectIdsForUser(u.id));
    setManagePermSearch('');
    setManagingUser(u);
  };

  const toggleSelectedProject = (projectId: number) => {
    setSelectedProjectIds((prev) => {
      const next = new Set(prev);
      if (next.has(projectId)) next.delete(projectId);
      else next.add(projectId);
      return next;
    });
  };

  // The "Project Access" modal's checklist, filtered by the search box.
  const filteredManageProjects = React.useMemo(() => {
    const q = managePermSearch.trim().toLowerCase();
    if (!q) return projects;
    return projects.filter((p) => p.project_name.toLowerCase().includes(q));
  }, [projects, managePermSearch]);

  const handleSavePermissions = async () => {
    if (!managingUser) return;
    setSavingPermissions(true);
    try {
      const res = await fetch(apiUrl(`/api/users/${managingUser.id}/projects`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ project_ids: Array.from(selectedProjectIds) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save project permissions');

      setManagingUser(null);
      fetchAllData();
      setMessage({ type: 'success', text: `Project access updated for ${managingUser.name}.` });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message });
    } finally {
      setSavingPermissions(false);
    }
  };

  // --- Filtered Entries ---
  // Memoized: previously this ran on EVERY render of the whole Admin panel (a large,
  // multi-tab component), including renders triggered by typing in totally unrelated
  // inputs elsewhere on the page. Scoping recomputation to just these 6 dependencies
  // means unrelated keystrokes no longer re-filter (and, via stableOpenEntryHistory +
  // ReportRow below, no longer re-render) this whole entries table.
  const filteredEntries = React.useMemo(() => entries.filter((ent) => {
    const matchJob = filterJobNo ? ent.job_no.toLowerCase().includes(filterJobNo.toLowerCase()) : true;
    const matchProj = filterProjectId ? ent.project_id.toString() === filterProjectId : true;
    const matchStart = filterStartDate ? ent.entry_date >= filterStartDate : true;
    const matchEnd = filterEndDate ? ent.entry_date <= filterEndDate : true;
    const matchBudget = filterBudgetId ? String(ent.budget_id ?? '') === filterBudgetId : true;
    return matchJob && matchProj && matchStart && matchEnd && matchBudget;
  }), [entries, filterJobNo, filterProjectId, filterStartDate, filterEndDate, filterBudgetId]);

  const stableOpenEntryHistory = useStableCallback(openEntryHistory);
  const stableDeleteEntry = useStableCallback(handleDeleteEntry);

  // --- Approved Projects / MPR Numbers lists ---
  // These are imported straight from Excel and can run into the hundreds, so by
  // default only a capped number renders (search narrows it; "Show all" opts in to
  // the full list) instead of always mounting every single row at once.
  const LIST_PAGE_SIZE = 30;

  const visibleProjects = React.useMemo(() => {
    const q = projectListSearch.trim().toLowerCase();
    const filtered = q ? projects.filter((p) => p.project_name.toLowerCase().includes(q)) : projects;
    return showAllProjects || q ? filtered : filtered.slice(0, LIST_PAGE_SIZE);
  }, [projects, projectListSearch, showAllProjects]);

  const visibleBranches = React.useMemo(() => {
    const q = branchListSearch.trim().toLowerCase();
    const filtered = q ? branches.filter((b) => b.branch_name.toLowerCase().includes(q)) : branches;
    return showAllBranches || q ? filtered : filtered.slice(0, LIST_PAGE_SIZE);
  }, [branches, branchListSearch, showAllBranches]);

  const visibleMprNumbers = React.useMemo(() => {
    const q = mprListSearch.trim().toLowerCase();
    const filtered = q ? mprNumbers.filter((m) => m.mpr_no.toLowerCase().includes(q)) : mprNumbers;
    return showAllMprs || q ? filtered : filtered.slice(0, LIST_PAGE_SIZE);
  }, [mprNumbers, mprListSearch, showAllMprs]);

  // --- Export filtered entries to Excel (.xlsx) ---
  // Two groups of columns, kept together rather than interleaved:
  // 1. Entry-specific columns (things that only exist because a Job/MPR was entered —
  //    not part of the original imported sheet) — placed first.
  // 2. The original imported Budget Excel's own columns, in the EXACT same header text
  //    and order as that template (see BUDGET_HEADER_MAP above / schema.sql comment):
  //    Sl.No. | Project Name | Req. No. | MRF No | Date | Description of Materials |
  //    Unit | Specification | Req. Qty | Purchase Order Qty | Received Qty |
  //    Balance Qty | Entry User | Aproved Date | App. User | Site Sup. Date
  // Project Name / MRF No / Description of Materials come from the entry's own fields
  // (always present) rather than the joined budget_items row, so they still show even
  // for an older entry that predates the Budget feature or doesn't have a matching
  // budget_items row — every other original column comes from that joined row and is
  // blank when there's no match, which is accurate (that import data doesn't exist).
  const handleDownloadExcel = () => {
    const rows = filteredEntries.map((ent) => ({
      'Entry Date': ent.entry_date,
      'Job Name': ent.job_name,
      'Job No': ent.job_no,
      'Job Duration': ent.job_duration,
      'Delivery Date': ent.delivery_date,
      'Logged By': ent.user_name || 'User',
      Budget: ent.budget_name || '—',
      'Sl.No.': ent.bi_sl_no || '',
      'Project Name': ent.project_name,
      'Req. No.': ent.bi_req_no || '',
      'MRF No': ent.mpr_no,
      Date: ent.bi_item_date || '',
      'Description of Materials': ent.item_name,
      Unit: ent.unit || '',
      Specification: ent.specification || '',
      'Req. Qty': ent.req_qty || '',
      'Purchase Order Qty': ent.po_qty || '',
      'Received Qty': ent.received_qty || '',
      'Balance Qty': ent.balance_qty || '',
      'Entry User': ent.bi_entry_user || '',
      'Aproved Date': ent.bi_approved_date || '',
      'App. User': ent.bi_app_user || '',
      'Site Sup. Date': ent.site_sup_date || ''
    }));

    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = new Array(23).fill({ wch: 16 });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'MPR Entries');
    XLSX.writeFile(workbook, `MPR_Report_${todayDateOnlyString()}.xlsx`);
  };

  // --- Export a Budget's raw imported sheet (every column, every row) to Excel ---
  const handleDownloadBudgetItemsExcel = (budget: Budget, items: BudgetItem[]) => {
    const rows = items.map((it) => ({
      'Sl.No.': it.sl_no || '',
      'Project Name': it.project_name || '',
      'Req. No.': it.req_no || '',
      'MRF No': it.mrf_no || '',
      Date: it.item_date || '',
      'Description of Materials': it.description || '',
      Unit: it.unit || '',
      Specification: it.specification || '',
      'Req. Qty': it.req_qty || '',
      'Purchase Order Qty': it.po_qty || '',
      'Received Qty': it.received_qty || '',
      'Balance Qty': it.balance_qty || '',
      'Entry User': it.entry_user || '',
      'Aproved Date': it.approved_date || '',
      'App. User': it.app_user || '',
      'Site Sup. Date': it.site_sup_date || ''
    }));
    const worksheet = XLSX.utils.json_to_sheet(rows);
    worksheet['!cols'] = new Array(16).fill({ wch: 16 });
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, 'Budget Items');
    XLSX.writeFile(workbook, `${budget.budget_name.replace(/[^\w\- ]+/g, '')}_ImportedSheet.xlsx`);
  };

  return (
    <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8 space-y-4 min-h-[calc(100vh-4rem)] text-slate-900" style={{ background: 'var(--g-bg-gradient)' }}>
      {/* Violet gradient welcome banner — same brand gradient as the logo/hero
          text elsewhere (see --g-gradient in index.css), sitting right below the
          title the way the reference dashboard's "Welcome Back" card does.
          Hidden on mobile for Monthly Leave Application specifically — that
          report's own header (title + search/filter row) already needs the
          space on a small screen, and this repeated greeting doesn't add
          anything there; desktop keeps it, and every other tab keeps it on
          both mobile and desktop, unchanged. */}
      <div
        className={`rounded-2xl px-6 py-5 sm:px-8 sm:py-6 text-white shadow-sm ${
          activeTab === 'leave_applications' ? 'hidden md:block' : ''
        }`}
        style={{ background: 'var(--g-gradient)' }}
      >
        <h3 className="text-xl sm:text-2xl font-bold">Welcome back, {user.name.split(' ')[0]}!</h3>
        <p className="mt-1 text-sm text-white/85">
          {isSuperAdmin
            ? "Here's your full overview — projects, reports, users, and every admin module."
            : "Here's your overview for the modules you've been granted access to."}
        </p>
      </div>

      {visibleModules.length === 0 && activeTab !== 'dashboard' && (
        <div className="p-6 rounded-xl border border-amber-200 bg-amber-50 text-amber-800 text-sm">
          Your Superadmin hasn't granted you access to any Admin Panel section yet. Please contact them.
        </div>
      )}

      {message && (
        <div className={`p-4 rounded-xl border flex items-center justify-between text-sm ${
          message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
        }`}>
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} className="text-xs underline opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {/* TAB 0: DASHBOARD — role admin/superadmin only (see isAdminRole above) */}
      {activeTab === 'dashboard' && isAdminRole && (
        <AdminDashboard token={token} user={user} />
      )}

      {/* TAB 1: REPORTS */}
      {activeTab === 'reports' && (
        <div className="space-y-6">
          {/* Filters Bar */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <h3 className="text-sm font-bold text-slate-900 mb-4 flex items-center gap-2">
              <Filter className="w-4 h-4 text-blue-600" /> Filter Entries Report
            </h3>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">Job No</label>
                <input
                  type="text"
                  value={filterJobNo}
                  onChange={(e) => setFilterJobNo(e.target.value)}
                  placeholder="e.g. JOB-9901"
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">Project Name</label>
                <select
                  value={filterProjectId}
                  onChange={(e) => setFilterProjectId(e.target.value)}
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="">All Projects</option>
                  {projects.map(p => (
                    <option key={p.id} value={p.id}>{p.project_name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">Budget</label>
                <select
                  value={filterBudgetId}
                  onChange={(e) => setFilterBudgetId(e.target.value)}
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                >
                  <option value="">All Budgets</option>
                  {budgets.map(b => (
                    <option key={b.id} value={b.id}>{b.budget_name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">Start Date</label>
                <input
                  type="date"
                  value={filterStartDate}
                  onChange={(e) => setFilterStartDate(e.target.value)}
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">End Date</label>
                <input
                  type="date"
                  value={filterEndDate}
                  onChange={(e) => setFilterEndDate(e.target.value)}
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            {(filterJobNo || filterProjectId || filterStartDate || filterEndDate || filterBudgetId) && (
              <div className="mt-4 flex justify-end">
                <button
                  onClick={() => { setFilterJobNo(''); setFilterProjectId(''); setFilterStartDate(''); setFilterEndDate(''); setFilterBudgetId(''); }}
                  className="text-xs text-blue-600 hover:underline font-medium"
                >
                  Clear Filters
                </button>
              </div>
            )}
          </div>

          {/* Entries Report Table */}
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="p-6 border-b border-slate-200 flex justify-between items-center">
              <div>
                <h3 className="text-lg font-bold text-slate-900">All MPR Entries Report</h3>
                <p className="text-xs text-slate-500">Showing {filteredEntries.length} matching records</p>
              </div>
              <button
                onClick={handleDownloadExcel}
                disabled={filteredEntries.length === 0}
                className="flex items-center gap-1.5 px-3 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold rounded-xl transition-colors shadow-2xs disabled:opacity-50 disabled:cursor-not-allowed"
              >
                <Download className="w-3.5 h-3.5" />
                Download Excel
              </button>
            </div>

            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-3 text-left">Date</th>
                    <th className="px-4 py-3 text-left">Job Name</th>
                    <th className="px-4 py-3 text-left">Project</th>
                    <th className="px-4 py-3 text-left">Job No & Duration</th>
                    <th className="px-4 py-3 text-left">MPR No</th>
                    <th className="px-4 py-3 text-left">Item Name</th>
                    <th className="px-4 py-3 text-left">Rate &amp; Amount</th>
                    <th className="px-4 py-3 text-left">Head</th>
                    <th className="px-4 py-3 text-left">Sub-1</th>
                    <th className="px-4 py-3 text-left">Sub-2</th>
                    <th className="px-4 py-3 text-left">Sub-3</th>
                    <th className="px-4 py-3 text-left">Sector</th>
                    <th className="px-4 py-3 text-left">Delivery Date</th>
                    <th className="px-4 py-3 text-left">Logged By</th>
                    <th className="px-4 py-3 text-left">Budget</th>
                    <th className="px-4 py-3 text-left">History</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-200 text-sm">
                  {filteredEntries.length === 0 ? (
                    <tr>
                      <td colSpan={15} className="px-6 py-12 text-center text-slate-400">
                        No entries found matching the filter criteria.
                      </td>
                    </tr>
                  ) : (
                    filteredEntries.map((ent) => (
                      <ReportRow key={ent.id} ent={ent} onOpenHistory={stableOpenEntryHistory} onDelete={stableDeleteEntry} deletingEntryId={deletingEntryId} />
                    ))
                  )}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}

      {/* Entry Edit History Modal */}
      {historyEntryId !== null && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={closeEntryHistory}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[80vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-slate-200 flex justify-between items-center">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <History className="w-4 h-4 text-blue-600" /> Edit History — Entry #{historyEntryId}
              </h3>
              <button
                onClick={closeEntryHistory}
                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-auto flex-1 p-5">
              {loadingHistory ? (
                <p className="text-xs text-slate-400 text-center py-6">Loading history...</p>
              ) : historyRecords.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-6">No edits have been made to this entry yet.</p>
              ) : (
                <div className="space-y-3">
                  {historyRecords.map((h) => (
                    <div key={h.id} className="border border-slate-200 rounded-xl p-3 text-xs">
                      <div className="flex items-center justify-between mb-1.5">
                        <span className="font-semibold text-slate-900">{FIELD_LABELS[h.field_name] || h.field_name}</span>
                        <span className="text-[10px] text-slate-400">
                          {formatDate(h.edited_at)} {h.editor_name ? `• ${h.editor_name}` : ''}
                        </span>
                      </div>
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="px-2 py-0.5 rounded-md bg-rose-50 text-rose-700 border border-rose-100 line-through">
                          {h.old_value || '—'}
                        </span>
                        <span className="text-slate-400">→</span>
                        <span className="px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-100 font-medium">
                          {h.new_value || '—'}
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB: REMOTE ATTENDANCE — every Check In / Check Out a User has recorded,
          system-wide, with the exact distance from the Project's pin at the time. */}
      {activeTab === 'attendance' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <Navigation className="w-4 h-4 text-blue-600" /> Remote Attendance
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Every Check In / Check Out a User has recorded from the User Panel — only accepted when their device's
                  location fell inside that Project's attendance circle.
                </p>
              </div>
            </div>
            <div className="flex flex-wrap items-end gap-2">
              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">Project</label>
                <select
                  value={attendanceProjectFilter}
                  onChange={(e) => setAttendanceProjectFilter(e.target.value)}
                  className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                >
                  <option value="">All Projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.project_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">User</label>
                <select
                  value={attendanceUserFilter}
                  onChange={(e) => setAttendanceUserFilter(e.target.value)}
                  className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                >
                  <option value="">All Users</option>
                  {users.filter((u) => u.role === 'user').map((u) => (
                    <option key={u.id} value={u.id}>{u.name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">From</label>
                <input
                  type="date"
                  value={attendanceFromFilter}
                  onChange={(e) => setAttendanceFromFilter(e.target.value)}
                  className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">To</label>
                <input
                  type="date"
                  value={attendanceToFilter}
                  onChange={(e) => setAttendanceToFilter(e.target.value)}
                  className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={fetchAttendance}
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium whitespace-nowrap transition-colors"
              >
                <Filter className="w-3.5 h-3.5" /> Apply
              </button>
              {(attendanceProjectFilter || attendanceUserFilter || attendanceFromFilter || attendanceToFilter) && (
                <button
                  type="button"
                  onClick={() => {
                    setAttendanceProjectFilter('');
                    setAttendanceUserFilter('');
                    setAttendanceFromFilter('');
                    setAttendanceToFilter('');
                  }}
                  className="text-xs px-3 py-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-50 font-medium whitespace-nowrap transition-colors"
                >
                  Clear
                </button>
              )}
            </div>
          </div>

          {loadingAttendance ? (
            <p className="text-xs text-slate-400 text-center py-12">Loading attendance...</p>
          ) : attendanceRecords.length === 0 ? (
            <div className="text-center text-xs text-slate-400 py-12 flex flex-col items-center gap-2">
              <Navigation className="w-6 h-6 text-slate-300" />
              No attendance recorded yet.
            </div>
          ) : (
            <div className="overflow-x-auto">
              <table className="min-w-full divide-y divide-slate-200">
                <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                  <tr>
                    <th className="px-4 py-2.5 text-left">Date</th>
                    <th className="px-4 py-2.5 text-left">User</th>
                    <th className="px-4 py-2.5 text-left">Project</th>
                    <th className="px-4 py-2.5 text-left">Check In</th>
                    <th className="px-4 py-2.5 text-left">In Distance</th>
                    <th className="px-4 py-2.5 text-left">In Remarks</th>
                    <th className="px-4 py-2.5 text-left">Check Out</th>
                    <th className="px-4 py-2.5 text-left">Out Distance</th>
                    <th className="px-4 py-2.5 text-left">Out Remarks</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100 text-sm">
                  {attendanceRecords.map((r) => (
                    <tr key={r.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">{formatDate(r.attendance_date)}</td>
                      <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900 text-xs">{r.user_name || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-700 text-xs">{r.project_name || '—'}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        {r.check_in_at ? (
                          <span className="inline-flex items-center gap-1 text-emerald-700">
                            <LogIn className="w-3 h-3" /> {new Date(r.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                        {r.check_in_at && (
                          <div className="mt-1">
                            <ApprovalBadge approval={r.check_in_approval} />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-500 text-xs">
                        {r.check_in_distance_m != null ? `${r.check_in_distance_m} m` : '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-600 text-xs max-w-[220px]">
                        {r.check_in_remarks ? (
                          <span className="block truncate" title={r.check_in_remarks}>{r.check_in_remarks}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs">
                        {r.check_out_at ? (
                          <span className="inline-flex items-center gap-1 text-blue-700">
                            <LogOut className="w-3 h-3" /> {new Date(r.check_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                        {r.check_out_at && (
                          <div className="mt-1">
                            <ApprovalBadge approval={r.check_out_approval} />
                          </div>
                        )}
                      </td>
                      <td className="px-4 py-3 whitespace-nowrap text-slate-500 text-xs">
                        {r.check_out_distance_m != null ? `${r.check_out_distance_m} m` : '—'}
                      </td>
                      <td className="px-4 py-3 text-slate-600 text-xs max-w-[220px]">
                        {r.check_out_remarks ? (
                          <span className="block truncate" title={r.check_out_remarks}>{r.check_out_remarks}</span>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {/* TAB: MONTHLY ATTENDANCE REPORT — Month Wise (day-by-day grid per user
          for one month) / Date Wise (Present vs Absent for one day). Separate
          'attendance_reports' module from the raw 'attendance' log above. */}
      {activeTab === 'attendance_reports' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
            <div>
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <Calendar className="w-4 h-4 text-blue-600" /> Monthly Attendance Report
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                The final Attendance record for everyone — merges GPS (Remote Attendance Check In/Out) with ZKT (office biometric device) for whichever
                one an account actually used each day, with remarks — view a whole month at once, or one day across everyone.
              </p>
            </div>

            <div className="flex flex-wrap items-end gap-2">
              <div className="flex rounded-lg border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => setAttendanceReportView('month')}
                  className={`text-xs px-3 py-2 font-semibold transition-colors ${
                    attendanceReportView === 'month' ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Month Wise
                </button>
                <button
                  type="button"
                  onClick={() => setAttendanceReportView('date')}
                  className={`text-xs px-3 py-2 font-semibold transition-colors border-l border-slate-200 ${
                    attendanceReportView === 'date' ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                  }`}
                >
                  Date Wise
                </button>
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">Project</label>
                <select
                  value={reportProjectFilter}
                  onChange={(e) => setReportProjectFilter(e.target.value)}
                  className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                >
                  <option value="">All Projects</option>
                  {projects.map((p) => (
                    <option key={p.id} value={p.id}>{p.project_name}</option>
                  ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">Employee</label>
                <select
                  value={reportEmployeeFilter}
                  onChange={(e) => setReportEmployeeFilter(e.target.value)}
                  className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none max-w-[160px]"
                >
                  <option value="">All Employees</option>
                  {users
                    .filter((u) => u.role === 'user' || u.role === 'admin')
                    .slice()
                    .sort((a, b) => a.name.localeCompare(b.name))
                    .map((u) => (
                      <option key={u.id} value={u.id}>{u.name}</option>
                    ))}
                </select>
              </div>

              <div>
                <label className="block text-[10px] font-semibold text-slate-500 mb-1">Department</label>
                <select
                  value={reportDepartmentFilter}
                  onChange={(e) => setReportDepartmentFilter(e.target.value)}
                  className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none max-w-[160px]"
                >
                  <option value="">All Departments</option>
                  {reportDepartments.map((d) => (
                    <option key={d} value={d}>{d}</option>
                  ))}
                </select>
              </div>

              {attendanceReportView === 'month' ? (
                <>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">Year</label>
                    <input
                      type="number"
                      value={reportYear}
                      onChange={(e) => setReportYear(Number(e.target.value))}
                      className="text-xs px-2.5 py-2 w-24 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                    />
                  </div>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">Month</label>
                    <select
                      value={reportMonth}
                      onChange={(e) => setReportMonth(Number(e.target.value))}
                      className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                    >
                      {Array.from({ length: 12 }, (_, i) => i + 1).map((m) => (
                        <option key={m} value={m}>
                          {new Date(2000, m - 1, 1).toLocaleString('en-US', { month: 'long' })}
                        </option>
                      ))}
                    </select>
                  </div>
                  <button
                    type="button"
                    onClick={fetchMonthlyReport}
                    className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium whitespace-nowrap transition-colors"
                  >
                    <Filter className="w-3.5 h-3.5" /> Apply
                  </button>

                  <div className="flex rounded-lg border border-slate-200 overflow-hidden ml-1">
                    <button
                      type="button"
                      onClick={() => setMonthlyCellDisplay('symbol')}
                      className={`text-xs px-3 py-2 font-semibold transition-colors ${
                        monthlyCellDisplay === 'symbol' ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      Symbols
                    </button>
                    <button
                      type="button"
                      onClick={() => setMonthlyCellDisplay('times')}
                      className={`text-xs px-3 py-2 font-semibold transition-colors border-l border-slate-200 ${
                        monthlyCellDisplay === 'times' ? 'bg-blue-600 text-white' : 'bg-slate-50 text-slate-600 hover:bg-slate-100'
                      }`}
                    >
                      In/Out Times
                    </button>
                  </div>

                  <button
                    type="button"
                    onClick={handleExportMonthlyReportPdf}
                    disabled={!monthlyReport || monthlyReport.users.length === 0}
                    title="Download this report as a PDF"
                    className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed transition-colors ml-1"
                  >
                    <FileDown className="w-3.5 h-3.5" /> Export PDF
                  </button>
                </>
              ) : (
                <>
                  <div>
                    <label className="block text-[10px] font-semibold text-slate-500 mb-1">Date</label>
                    <input
                      type="date"
                      value={reportDate}
                      onChange={(e) => setReportDate(e.target.value)}
                      className="text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={fetchDailyReport}
                    className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium whitespace-nowrap transition-colors"
                  >
                    <Filter className="w-3.5 h-3.5" /> Apply
                  </button>

                  <button
                    type="button"
                    onClick={handleExportDailyReportPdf}
                    disabled={!dailyReport}
                    title="Download this report as a PDF"
                    className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed transition-colors ml-1"
                  >
                    <FileDown className="w-3.5 h-3.5" /> Export PDF
                  </button>
                </>
              )}
            </div>
          </div>

          {attendanceReportView === 'month' ? (
            loadingMonthlyReport ? (
              <p className="text-xs text-slate-400 text-center py-12">Loading report...</p>
            ) : !monthlyReport || monthlyReport.users.length === 0 ? (
              <div className="text-center text-xs text-slate-400 py-12 flex flex-col items-center gap-2">
                <Calendar className="w-6 h-6 text-slate-300" />
                No users to report on yet.
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-2.5 text-left sticky left-0 bg-slate-50">User</th>
                      {Array.from({ length: monthlyReport.days_in_month }, (_, i) => i + 1).map((d) => (
                        <th key={d} className={`px-1.5 py-2.5 text-center ${monthlyCellDisplay === 'times' ? 'w-16' : 'w-6'}`}>{d}</th>
                      ))}
                      <th className="px-4 py-2.5 text-center">Present</th>
                      <th className="px-4 py-2.5 text-center">Holiday</th>
                      <th className="px-4 py-2.5 text-center">Absent</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {monthlyReport.users.map((u: any) => (
                      <tr key={u.user_id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900 text-xs sticky left-0 bg-white">{u.user_name}</td>
                        {u.days.map((d: any) => {
                          // A Global Calendar date (Admin Panel -> Holidays) is never
                          // shown as Absent, whether or not this person checked in.
                          const isHoliday = !!d.day_type;
                          const label = d.present ? 'P' : isHoliday ? (d.day_type === 'weekend' ? 'W' : 'H') : '·';
                          const colorClass = d.present
                            ? d.source === 'office' ? 'text-sky-600' : 'text-emerald-600'
                            : isHoliday
                              ? d.day_type === 'weekend' ? 'text-sky-500' : 'text-amber-500'
                              : 'text-slate-300';
                          // "Which way" attendance was given (GPS via Remote
                          // Attendance, or ZKT via the office biometric device),
                          // plus either Check In/Out remarks, in the tooltip.
                          const remarksPart = [d.check_in_remarks && `In: ${d.check_in_remarks}`, d.check_out_remarks && `Out: ${d.check_out_remarks}`]
                            .filter(Boolean)
                            .join(' \u2022 ');
                          const sourcePart = d.present ? (d.source === 'office' ? ' \u2014 ZKT' : ' \u2014 GPS') : '';
                          // Compact "8:58a"/"5:32p" — short enough to fit two
                          // stacked lines in a day column without wrapping.
                          const shortTime = (v: string | null) => {
                            if (!v) return null;
                            const full = new Date(v).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit', hour12: true });
                            return full.replace(' AM', 'a').replace(' PM', 'p');
                          };
                          const cellTitle =
                            d.present
                              ? `${d.date}${d.project_name ? ' — ' + d.project_name : ''}${sourcePart}${remarksPart ? ' — ' + remarksPart : ''}`
                              : isHoliday
                                ? `${d.date} — ${d.holiday_title || (d.day_type === 'weekend' ? 'Weekend' : 'Holiday')}`
                                : d.date;
                          if (monthlyCellDisplay === 'times') {
                            const inTime = shortTime(d.check_in_at);
                            const outTime = shortTime(d.check_out_at);
                            return (
                              <td key={d.date} title={cellTitle} className="px-1 py-2 text-center align-middle">
                                {d.present ? (
                                  <div className={`leading-tight text-[9px] font-bold ${colorClass}`}>
                                    <div>{inTime}</div>
                                    <div>{outTime || '—'}</div>
                                  </div>
                                ) : (
                                  <span className={`text-[10px] font-bold ${colorClass}`}>{label}</span>
                                )}
                              </td>
                            );
                          }
                          return (
                            <td
                              key={d.date}
                              title={cellTitle}
                              className={`px-1.5 py-3 text-center text-[10px] font-bold ${colorClass}`}
                            >
                              {label}
                            </td>
                          );
                        })}
                        <td className="px-4 py-3 text-center text-xs font-semibold text-emerald-700">{u.present_days}</td>
                        <td className="px-4 py-3 text-center text-xs font-semibold text-amber-600">{u.holiday_days ?? 0}</td>
                        <td className="px-4 py-3 text-center text-xs font-semibold text-rose-600">{u.absent_days}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <div className="flex flex-wrap items-center gap-4 px-4 py-3 text-[10px] text-slate-500 border-t border-slate-100">
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-emerald-500" /> Present — GPS (Remote Attendance)</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-sky-500" /> Present — ZKT (Office Attendance)</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-amber-400" /> Holiday</span>
                  <span className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-full bg-slate-300" /> Absent</span>
                  <span className="text-slate-400">Hover a day for check-in time, project, source and remarks.</span>
                </div>
              </div>
            )
          ) : loadingDailyReport ? (
            <p className="text-xs text-slate-400 text-center py-12">Loading report...</p>
          ) : !dailyReport ? (
            <div className="text-center text-xs text-slate-400 py-12 flex flex-col items-center gap-2">
              <Calendar className="w-6 h-6 text-slate-300" />
              Pick a date and click Apply.
            </div>
          ) : (
            <div className="grid grid-cols-1 lg:grid-cols-2 divide-y lg:divide-y-0 lg:divide-x divide-slate-200">
              {dailyReport.day_type && (
                <div
                  className={`lg:col-span-2 mx-4 mt-4 px-4 py-2.5 rounded-xl text-xs font-semibold ${
                    dailyReport.day_type === 'weekend' ? 'bg-sky-50 text-sky-700 border border-sky-200' : 'bg-amber-50 text-amber-700 border border-amber-200'
                  }`}
                >
                  {dailyReport.day_type === 'weekend' ? 'Weekend' : 'Holiday'} — {dailyReport.holiday_title}. Nobody is counted Absent on this date.
                </div>
              )}
              <div className="overflow-x-auto">
                <h4 className="px-4 pt-4 pb-2 text-xs font-bold text-emerald-700">Present ({dailyReport.present.length})</h4>
                {dailyReport.present.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-8">No one checked in this day.</p>
                ) : (
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                      <tr>
                        <th className="px-4 py-2.5 text-left">User</th>
                        <th className="px-4 py-2.5 text-left">Source</th>
                        <th className="px-4 py-2.5 text-left">Project</th>
                        <th className="px-4 py-2.5 text-left">Check In</th>
                        <th className="px-4 py-2.5 text-left">Check Out</th>
                        <th className="px-4 py-2.5 text-left">Remarks</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100 text-sm">
                      {dailyReport.present.map((r: any) => (
                        <tr key={r.user_id} className="hover:bg-slate-50/80 transition-colors">
                          <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900 text-xs">{r.user_name}</td>
                          <td className="px-4 py-3 whitespace-nowrap text-xs">
                            {/* "Which way" the attendance was given — GPS (Remote
                                Attendance, Self Service Check In/Out) or ZKT
                                (the office biometric device). */}
                            {r.source === 'office' ? (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-sky-50 text-sky-700">
                                ZKT
                              </span>
                            ) : (
                              <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
                                GPS
                              </span>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-slate-700 text-xs">
                            {r.source === 'office' ? <span className="text-slate-300">—</span> : r.project_name || '—'}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-xs">
                            {r.check_in_at ? (
                              <span className="inline-flex items-center gap-1 text-emerald-700">
                                <LogIn className="w-3 h-3" /> {new Date(r.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-xs">
                            {r.check_out_at ? (
                              <span className="inline-flex items-center gap-1 text-blue-700">
                                <LogOut className="w-3 h-3" /> {new Date(r.check_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                              </span>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                          <td className="px-4 py-3 text-slate-600 text-xs max-w-[220px]">
                            {r.check_in_remarks || r.check_out_remarks ? (
                              <div className="space-y-0.5">
                                {r.check_in_remarks && <p className="truncate" title={r.check_in_remarks}><span className="text-slate-400">In:</span> {r.check_in_remarks}</p>}
                                {r.check_out_remarks && <p className="truncate" title={r.check_out_remarks}><span className="text-slate-400">Out:</span> {r.check_out_remarks}</p>}
                              </div>
                            ) : (
                              <span className="text-slate-300">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
              <div className="overflow-x-auto">
                <h4 className={`px-4 pt-4 pb-2 text-xs font-bold ${dailyReport.day_type ? 'text-amber-600' : 'text-rose-600'}`}>
                  {dailyReport.day_type ? `Not Checked In (${dailyReport.on_holiday.length})` : `Absent (${dailyReport.absent.length})`}
                </h4>
                {dailyReport.day_type ? (
                  dailyReport.on_holiday.length === 0 ? (
                    <p className="text-xs text-slate-400 text-center py-8">Everyone checked in this day.</p>
                  ) : (
                    <ul className="divide-y divide-slate-100 text-xs">
                      {dailyReport.on_holiday.map((u: any) => (
                        <li key={u.user_id} className="px-4 py-2.5 text-slate-700">{u.user_name}</li>
                      ))}
                    </ul>
                  )
                ) : dailyReport.absent.length === 0 ? (
                  <p className="text-xs text-slate-400 text-center py-8">Everyone checked in this day.</p>
                ) : (
                  <ul className="divide-y divide-slate-100 text-xs">
                    {dailyReport.absent.map((u: any) => (
                      <li key={u.user_id} className="px-4 py-2.5 text-slate-700">{u.user_name}</li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </div>
      )}

      {/* TAB: MONTHLY LEAVE APPLICATION — read-only, Department-scoped list of
          every submitted Leave Application, gated by its own
          'leave_applications' module (see ADMIN_MODULES in types.ts). Distinct
          from "Leave Approvals" (approver-only, decision workflow) and from
          "Leave Manage" (can_manage_leave, balances) — this is purely a
          viewing report, the same "Monthly Attendance Report" pattern applied
          to Leave Applications instead of attendance. */}
      {activeTab === 'leave_applications' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
            <div>
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <CalendarClock className="w-5 h-5 text-blue-600" />
                Monthly Leave Application
              </h3>
              <p className="text-sm text-slate-500 mt-1">
                Every submitted Leave Application{leaveApplicationsReportDeptFilter ? ` — ${leaveApplicationsReportDeptFilter}` : ''}.
                {leaveApplicationsReportDepartments.length > 0 && ' Only Departments you have access to are listed below.'}
              </p>
            </div>
            <div className="flex flex-wrap gap-3 items-center">
              <div className="relative flex-1 min-w-[200px]">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={leaveApplicationsReportSearch}
                  onChange={(e) => setLeaveApplicationsReportSearch(e.target.value)}
                  placeholder="Search by name..."
                  className="w-full pl-9 pr-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
                />
              </div>
              <select
                value={leaveApplicationsReportDeptFilter}
                onChange={(e) => setLeaveApplicationsReportDeptFilter(e.target.value)}
                className="px-3 py-2 text-sm border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">All Departments</option>
                {leaveApplicationsReportDepartments.map((d) => (
                  <option key={d} value={d}>{d}</option>
                ))}
              </select>
            </div>
          </div>

          {leaveApplicationsReportLoading ? (
            <div className="p-10 flex justify-center"><Spinner /></div>
          ) : leaveApplicationsReportError ? (
            <p className="p-6 text-sm text-rose-600">{leaveApplicationsReportError}</p>
          ) : (
            <>
              {/* Desktop — unchanged full table. */}
              <div className="hidden md:block overflow-x-auto">
                <table className="w-full text-sm">
                  <thead className="bg-slate-50 text-left text-xs font-semibold text-slate-500 uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-3">Employee</th>
                      <th className="px-4 py-3">Department</th>
                      <th className="px-4 py-3">Leave Type</th>
                      <th className="px-4 py-3">Start Date</th>
                      <th className="px-4 py-3">End Date</th>
                      <th className="px-4 py-3">Days</th>
                      <th className="px-4 py-3">Status</th>
                      <th className="px-4 py-3">Approver</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {leaveApplicationsReport
                      .filter((a) => (a.user_name || '').toLowerCase().includes(leaveApplicationsReportSearch.trim().toLowerCase()))
                      .map((a) => (
                        <tr key={a.id} className="hover:bg-slate-50">
                          <td className="px-4 py-3 font-medium text-slate-900">{a.user_name || '(account removed)'}</td>
                          <td className="px-4 py-3 text-slate-600">{a.department || '—'}</td>
                          <td className="px-4 py-3 text-slate-600 capitalize">{a.leave_type.replace('_', ' ')}</td>
                          <td className="px-4 py-3 text-slate-600">{formatDate(a.start_date)}</td>
                          <td className="px-4 py-3 text-slate-600">{formatDate(a.end_date)}</td>
                          <td className="px-4 py-3 text-slate-600">{a.day_count}</td>
                          <td className="px-4 py-3">
                            <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                              a.status === 'approved' ? 'bg-emerald-50 text-emerald-700' :
                              a.status === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'
                            }`}>
                              {a.status}
                            </span>
                          </td>
                          <td className="px-4 py-3 text-slate-600">{a.approver_name || '—'}</td>
                        </tr>
                      ))}
                    {leaveApplicationsReport.length === 0 && (
                      <tr>
                        <td colSpan={8} className="px-4 py-10 text-center text-slate-400">No Leave Applications found.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>

              {/* Mobile — stacked cards instead of the same table squeezed
                  into a horizontal scroll (same pattern as ClaimsPanel.tsx /
                  ConveyanceClaimCard.tsx's own mobile treatment). */}
              <div className="md:hidden divide-y divide-slate-100">
                {leaveApplicationsReport
                  .filter((a) => (a.user_name || '').toLowerCase().includes(leaveApplicationsReportSearch.trim().toLowerCase()))
                  .map((a) => (
                    <div key={a.id} className="p-4 flex flex-col gap-2">
                      <div className="flex items-start justify-between gap-2">
                        <div className="min-w-0">
                          <p className="font-semibold text-slate-900 text-sm truncate">{a.user_name || '(account removed)'}</p>
                          <p className="text-xs text-slate-500 mt-0.5">{a.department || '—'}</p>
                        </div>
                        <span className={`shrink-0 inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${
                          a.status === 'approved' ? 'bg-emerald-50 text-emerald-700' :
                          a.status === 'rejected' ? 'bg-rose-50 text-rose-700' : 'bg-amber-50 text-amber-700'
                        }`}>
                          {a.status}
                        </span>
                      </div>

                      <div className="flex items-center gap-1.5 text-xs text-slate-600 capitalize">
                        <CalendarClock className="w-3.5 h-3.5 text-slate-400 shrink-0" />
                        {a.leave_type.replace('_', ' ')} &middot; {a.day_count} day{Number(a.day_count) === 1 ? '' : 's'}
                      </div>

                      <div className="flex items-center justify-between text-xs">
                        <span className="text-slate-500">
                          {formatDate(a.start_date)} &rarr; {formatDate(a.end_date)}
                        </span>
                        <span className="text-slate-400">{a.approver_name || '—'}</span>
                      </div>
                    </div>
                  ))}
                {leaveApplicationsReport.length === 0 && (
                  <p className="px-4 py-10 text-center text-slate-400 text-sm">No Leave Applications found.</p>
                )}
              </div>
            </>
          )}
        </div>
      )}

      {/* TAB: EMPLOYEE TRACKING — live map + last-known location of every user
          with can_use_tracking granted, plus per-user path playback. */}
      {activeTab === 'tracking' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          <EmployeeTrackingPanel token={token} />
        </div>
      )}

      {/* TAB: OFFICE ATTENDANCE — raw ZKTeco biometric punches, auto-synced off
          the office terminals every 5 minutes (zkSync.ts). Separate from Remote
          Attendance above: no project/GPS involved, keyed to the employee
          roster's zk_device_pin instead of a logged-in user. */}
      {activeTab === 'office_attendance' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          <OfficeAttendancePanel token={token} />
        </div>
      )}

      {/* TAB: HOLIDAYS — Global Calendar of Weekend/Holiday dates, gated behind
          its own 'holidays' module so a Superadmin can grant just this to
          whoever should maintain it. Every date added here is picked up by the
          Monthly/Date-Wise Attendance Report above and by every account's own
          Timesheet, so nobody is marked Absent on a date set here. */}
      {activeTab === 'holidays' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          <HolidayCalendarPanel token={token} />
        </div>
      )}

      {/* TAB: ASSET MANAGEMENT — IT/Admin side: inventory, final approval
          queue, and fulfilling/dispatching approved requests. Gated behind
          the 'asset_management' AdminModuleKey like every other tab here. */}
      {activeTab === 'asset_management' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          <AssetManagementAdmin />
        </div>
      )}

      {/* TABS: world-class HRM extension modules — Exit/Offboarding,
          Performance Management, Recruitment/ATS, Grievance & Disciplinary,
          HR Analytics, Document Vault. Each gated behind its own
          AdminModuleKey, same as every tab above. */}
      {activeTab === 'exit_offboarding' && <ExitOffboardingPanel token={token} />}
      {activeTab === 'performance_management' && <PerformanceManagementPanel token={token} />}
      {activeTab === 'recruitment' && <RecruitmentPanel token={token} />}
      {activeTab === 'grievance_disciplinary' && <GrievanceDisciplinaryPanel token={token} />}
      {activeTab === 'hr_analytics' && <HRAnalyticsDashboard token={token} />}
      {activeTab === 'document_vault' && <DocumentVaultPanel token={token} />}

      {/* TAB: SERVERS — Superadmin-only catalog of backend deployments
          (IP/URL) the Android app can switch between after login. Not a
          grantable AdminModuleKey (see ServerProfileRoutes.ts) — access is
          gated purely by isSuperAdmin in the effects above, same as the
          "Users" tab's role-promotion controls. */}
      {activeTab === 'servers' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
          <ServerProfilesPanel token={token} />
        </div>
      )}

      {/* TAB: PERMANENT DELETE LOG — Superadmin-only (see GET
          /api/entries/permanent-delete-log and the comment on DELETE
          /api/entries/:id/permanent) audit trail of every entry ever erased
          from the Job Recycle bin below, including an Admin's erases and a
          Superadmin's own. Not a grantable AdminModuleKey — gated purely by
          isSuperAdmin in the effects above, same as the "Servers" tab. */}
      {activeTab === 'permanent_delete_log' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200">
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-rose-600" /> Permanent Delete Log
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Every entry ever permanently erased from the Job Recycle bin — by an Admin or a Superadmin, including a
              Superadmin's own erases. This log itself can never be cleared or hidden from here.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left">Entry Date</th>
                  <th className="px-4 py-3 text-left">Job Name</th>
                  <th className="px-4 py-3 text-left">Project</th>
                  <th className="px-4 py-3 text-left">Job No</th>
                  <th className="px-4 py-3 text-left">MPR No</th>
                  <th className="px-4 py-3 text-left">Item Name</th>
                  <th className="px-4 py-3 text-left">Originally Logged By</th>
                  <th className="px-4 py-3 text-left">Soft-Deleted By</th>
                  <th className="px-4 py-3 text-left">Permanently Deleted By</th>
                  <th className="px-4 py-3 text-left">Permanently Deleted At</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {loadingPermanentDeleteLog ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-12 text-center text-slate-400">
                      Loading Permanent Delete Log...
                    </td>
                  </tr>
                ) : permanentDeleteLog.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-12 text-center text-slate-400">
                      No entry has ever been permanently deleted.
                    </td>
                  </tr>
                ) : (
                  permanentDeleteLog.map((log) => (
                    <tr key={log.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-4 py-3.5 whitespace-nowrap text-slate-600 text-xs">
                        {log.entry_date ? formatDate(log.entry_date) : '—'}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap font-semibold text-slate-900 text-xs">{log.job_name || '—'}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap font-medium text-slate-900 text-xs">{log.project_name || '—'}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-xs font-semibold text-blue-600">{log.job_no || '—'}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
                        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 font-mono">
                          {log.mpr_no || '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-slate-800 text-xs">{log.item_name || '—'}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-slate-500 text-xs">{log.entry_created_by_name || '—'}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-amber-600 text-xs">{log.entry_deleted_by_name || '—'}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-rose-600 font-semibold text-xs">
                        {log.permanently_deleted_by_name}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-slate-500 text-xs">{formatDate(log.permanently_deleted_at)}</td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: JOB RECYCLE — every soft-deleted entry, with Restore + permanently erase */}
      {activeTab === 'recycle' && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200">
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Recycle className="w-4 h-4 text-blue-600" /> Job Recycle
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Entries deleted by Users (from their own Job Entries) or by an Admin land here first. Restore brings an
              entry back into the live Reports list; permanently erasing it cannot be undone.
            </p>
          </div>

          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-3 text-left">Date</th>
                  <th className="px-4 py-3 text-left">Job Name</th>
                  <th className="px-4 py-3 text-left">Project</th>
                  <th className="px-4 py-3 text-left">Job No & Duration</th>
                  <th className="px-4 py-3 text-left">MPR No</th>
                  <th className="px-4 py-3 text-left">Item Name</th>
                  <th className="px-4 py-3 text-left">Logged By</th>
                  <th className="px-4 py-3 text-left">Deleted By</th>
                  <th className="px-4 py-3 text-left">Deleted At</th>
                  <th className="px-4 py-3 text-left">Action</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {loadingRecycle ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-12 text-center text-slate-400">
                      Loading Job Recycle bin...
                    </td>
                  </tr>
                ) : recycledEntries.length === 0 ? (
                  <tr>
                    <td colSpan={10} className="px-6 py-12 text-center text-slate-400">
                      Job Recycle bin is empty — no deleted entries.
                    </td>
                  </tr>
                ) : (
                  recycledEntries.map((ent) => (
                    <tr key={ent.id} className="hover:bg-slate-50/80 transition-colors">
                      <td className="px-4 py-3.5 whitespace-nowrap text-slate-600 text-xs">{formatDate(ent.entry_date)}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap font-semibold text-slate-900 text-xs">{ent.job_name}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap font-medium text-slate-900 text-xs">{ent.project_name}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
                        <div className="font-semibold text-blue-600">{ent.job_no}</div>
                        <div className="text-[10px] text-slate-400">{ent.job_duration}</div>
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
                        <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 font-mono">
                          {ent.mpr_no}
                        </span>
                      </td>
                      <td className="px-4 py-3.5 text-slate-800 text-xs">{ent.item_name}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-slate-500 text-xs">{ent.user_name || 'User'}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-rose-600 text-xs">{ent.deleted_by_name || '—'}</td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-slate-500 text-xs">
                        {ent.deleted_at ? formatDate(ent.deleted_at) : '—'}
                      </td>
                      <td className="px-4 py-3.5 whitespace-nowrap text-xs">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => handleRestoreEntry(ent.id)}
                            disabled={restoringEntryId === ent.id}
                            className="p-1.5 text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors disabled:opacity-50"
                            title="Restore this entry"
                          >
                            <RotateCcw className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handlePermanentDelete(ent.id)}
                            disabled={erasingEntryId === ent.id}
                            className="p-1.5 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                            title="Permanently erase"
                          >
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* TAB: MPR EDIT LOG — every entry edit across every User, grouped by the day it
          happened, so an Admin can see at a glance which day which Job/MPR rows were
          touched (and by whom) without opening each entry's own history one at a time. */}
      {activeTab === 'editlog' && (
        <>
        {/* Job Edit Approvals — pending first, so an Admin with "editlog" access sees
            what needs action before scrolling into the (much longer) permanent log
            below. Only an Admin/User account with the "editlog" module actually gets
            data back from GET /api/job-edits — this section simply doesn't render
            anything for anyone else since this whole tab is already gated the same way. */}
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden mb-4">
          <div className="p-6 border-b border-slate-200">
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Clock3 className="w-4 h-4 text-amber-600" /> Job Edit Approvals
              {pendingJobEditRequests.length > 0 && (
                <span className="text-xs font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-700">
                  {pendingJobEditRequests.length} pending
                </span>
              )}
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Add MPR / Delete MPR / New Job requests a User submitted through Job Edit on an already Final
              Submitted Budget (via the can_job_edit permission) — each one needs your Approve or Reject before it takes effect.
            </p>
          </div>

          {jobEditActionError && (
            <div className="mx-6 mt-4 p-3 rounded-xl bg-rose-50 border border-rose-200 text-rose-700 text-xs">
              {jobEditActionError}
            </div>
          )}

          {loadingJobEditRequests ? (
            <p className="text-xs text-slate-400 text-center py-10">Loading Job Edit requests...</p>
          ) : pendingJobEditRequests.length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-10">No Job Edit requests are pending review.</p>
          ) : (
            <div className="divide-y divide-slate-100">
              {pendingJobEditRequests.map((r) => (
                <div key={r.id} className="px-6 py-3.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-xs font-semibold text-blue-600">
                        {r.job_no || (r.action === 'add_job' ? (r.payload || {}).job_name : '') || '—'}
                      </span>
                      <span
                        className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                          r.action === 'add_item'
                            ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
                            : r.action === 'add_job'
                            ? 'bg-blue-50 text-blue-700 border-blue-200'
                            : 'bg-rose-50 text-rose-700 border-rose-200'
                        }`}
                      >
                        {r.action === 'add_item' ? 'Add MPR' : r.action === 'add_job' ? 'New Job' : 'Delete MPR'}
                      </span>
                    </div>
                    <p className="text-sm text-slate-800 mt-1 break-words">{describeJobEditRequest(r)}</p>
                    {jobEditRequestReason(r) && (
                      <p className="text-xs text-slate-500 mt-1 italic break-words">Reason: {jobEditRequestReason(r)}</p>
                    )}
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Requested by {r.requested_by_name || '—'} on {formatDate(r.created_at) || r.created_at}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 flex-shrink-0">
                    <button
                      type="button"
                      disabled={actingJobEditId === r.id}
                      onClick={() => actOnJobEditRequest(r.id, 'approve')}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 transition-colors"
                    >
                      <CheckCircle2 className="w-3.5 h-3.5" /> Approve
                    </button>
                    <button
                      type="button"
                      disabled={actingJobEditId === r.id}
                      onClick={() => actOnJobEditRequest(r.id, 'reject')}
                      className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-rose-50 hover:bg-rose-100 text-rose-700 border border-rose-200 disabled:opacity-50 transition-colors"
                    >
                      <XCircle className="w-3.5 h-3.5" /> Reject
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {recentlyReviewedJobEditRequests.length > 0 && (
            <div className="border-t border-slate-200">
              <p className="px-6 pt-3 pb-1 text-[11px] font-semibold text-slate-400 uppercase tracking-wide">
                Recently Reviewed
              </p>
              <div className="divide-y divide-slate-100">
                {recentlyReviewedJobEditRequests.map((r) => (
                  <div key={r.id} className="px-6 py-2.5 flex items-center justify-between gap-3">
                    <p className="text-xs text-slate-500 truncate">{describeJobEditRequest(r)}</p>
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full flex-shrink-0 ${
                        r.status === 'approved'
                          ? 'bg-emerald-50 text-emerald-700'
                          : 'bg-rose-50 text-rose-700'
                      }`}
                    >
                      {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.reviewed_by_name || '—'}
                    </span>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
            <div>
              <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                <History className="w-4 h-4 text-blue-600" /> MPR Edit Log
              </h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Every change made to a submitted MPR row (mostly Delivery Date updates, since other fields lock after
                submission), grouped by the day it was edited.
              </p>
            </div>
            <div className="flex items-center gap-2 w-full sm:w-auto">
              <div className="relative flex-1 sm:w-64">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={editLogSearch}
                  onChange={(e) => setEditLogSearch(e.target.value)}
                  placeholder="Search Job No, MPR No, User..."
                  className="w-full pl-8 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none"
                />
              </div>
              <button
                type="button"
                onClick={handleExportEditLogExcel}
                disabled={mprEditLogByDay().length === 0}
                title="Download this log as an Excel file"
                className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-medium whitespace-nowrap disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex-shrink-0"
              >
                <FileDown className="w-3.5 h-3.5" /> Export Excel
              </button>
            </div>
          </div>

          {loadingMprEditLog ? (
            <p className="text-xs text-slate-400 text-center py-12">Loading edit log...</p>
          ) : mprEditLogByDay().length === 0 ? (
            <p className="text-xs text-slate-400 text-center py-12">No MPR edits recorded yet.</p>
          ) : (
            <div className="divide-y divide-slate-200">
              {mprEditLogByDay().map(([day, records]) => (
                <div key={day}>
                  <div className="px-6 py-2.5 bg-slate-50 flex items-center gap-2 sticky top-0">
                    <Calendar className="w-3.5 h-3.5 text-blue-600" />
                    <span className="text-xs font-bold text-slate-700">{day}</span>
                    <span className="text-[10px] text-slate-400">
                      ({records.length} edit{records.length === 1 ? '' : 's'})
                    </span>
                  </div>
                  <div className="overflow-x-auto">
                    <table className="min-w-full divide-y divide-slate-200">
                      <thead className="bg-white text-slate-500 text-[11px] uppercase tracking-wider">
                        <tr>
                          <th className="px-4 py-2 text-left">Time</th>
                          <th className="px-4 py-2 text-left">Job No</th>
                          <th className="px-4 py-2 text-left">MPR No</th>
                          <th className="px-4 py-2 text-left">Item Name</th>
                          <th className="px-4 py-2 text-left">Job Owner</th>
                          <th className="px-4 py-2 text-left">Field Changed</th>
                          <th className="px-4 py-2 text-left">From</th>
                          <th className="px-4 py-2 text-left">To</th>
                          <th className="px-4 py-2 text-left">Edited By</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100 text-sm">
                        {records.map((h) => (
                          <tr key={h.id} className="hover:bg-slate-50/80 transition-colors">
                            <td className="px-4 py-2.5 whitespace-nowrap text-slate-500 text-xs">
                              {new Date(h.edited_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap font-semibold text-blue-600 text-xs">{h.job_no || '—'}</td>
                            <td className="px-4 py-2.5 whitespace-nowrap text-xs">
                              <span className="px-2 py-0.5 rounded-md bg-slate-100 text-slate-700 border border-slate-200 font-mono">
                                {h.mpr_no || '—'}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-slate-800 text-xs">{h.item_name || '—'}</td>
                            <td className="px-4 py-2.5 whitespace-nowrap text-slate-600 text-xs">{h.entry_owner_name || '—'}</td>
                            <td className="px-4 py-2.5 whitespace-nowrap text-xs">
                              <span className="px-2 py-0.5 rounded-md bg-amber-50 text-amber-700 border border-amber-200">
                                {FIELD_LABELS[h.field_name] || h.field_name}
                              </span>
                            </td>
                            <td className="px-4 py-2.5 text-slate-500 text-xs max-w-[160px] truncate" title={h.old_value || ''}>
                              {h.old_value || '—'}
                            </td>
                            <td className="px-4 py-2.5 text-slate-800 text-xs max-w-[160px] truncate font-medium" title={h.new_value || ''}>
                              {h.new_value || '—'}
                            </td>
                            <td className="px-4 py-2.5 whitespace-nowrap text-slate-500 text-xs">{h.editor_name || '—'}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
        </>
      )}

      {/* TAB 2: PROJECTS */}
      {activeTab === 'projects' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1">
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
              <h3 className="text-lg font-bold text-slate-900 mb-4">
                {editingProject ? 'Edit Project' : 'Add New Project'}
              </h3>
              <form onSubmit={handleSaveProject} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
                    Project Name
                  </label>
                  <input
                    type="text"
                    required
                    value={newProjectName}
                    onChange={(e) => setNewProjectName(e.target.value)}
                    placeholder="e.g. Metro Rail Extension"
                    className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
                    Project Location
                  </label>
                  {projectLocation.lat != null && projectLocation.lng != null ? (
                    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-xl">
                      <span className="inline-flex items-center gap-1.5 text-xs font-mono text-blue-800 truncate">
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        {projectLocation.label || `${Number(projectLocation.lat).toFixed(6)}, ${Number(projectLocation.lng).toFixed(6)}`}
                        {projectLocation.radius != null && (
                          <span className="text-blue-500">· {projectLocation.radius >= 1000 ? `${(projectLocation.radius / 1000).toFixed(1)}km` : `${projectLocation.radius}m`} radius</span>
                        )}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => setShowLocationPicker(true)}
                          className="text-[11px] font-semibold text-blue-700 hover:text-blue-900 px-2 py-1 rounded-lg hover:bg-blue-100"
                        >
                          Change
                        </button>
                        <button
                          type="button"
                          onClick={() => setProjectLocation({ lat: null, lng: null, label: null, radius: null })}
                          className="text-[11px] font-semibold text-rose-600 hover:text-rose-800 px-2 py-1 rounded-lg hover:bg-rose-50"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowLocationPicker(true)}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-50 hover:bg-slate-100 text-slate-600 text-xs font-semibold rounded-xl border border-dashed border-slate-300 transition-colors"
                    >
                      <MapPin className="w-3.5 h-3.5" />
                      Set Location on Map
                    </button>
                  )}
                  <p className="text-[11px] text-slate-400 mt-1">Optional — mark this project's site on a free map.</p>
                </div>
                <div className="flex space-x-3">
                  <button
                    type="submit"
                    className="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-sm transition-all shadow-sm"
                  >
                    {editingProject ? 'Update Project' : 'Add Project'}
                  </button>
                  {editingProject && (
                    <button
                      type="button"
                      onClick={() => { setEditingProject(null); setNewProjectName(''); setProjectLocation({ lat: null, lng: null, label: null, radius: null }); }}
                      className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl border border-slate-200"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="p-6 border-b border-slate-200">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">Approved Projects List</h3>
                    <p className="text-xs text-slate-500">Users select projects strictly from this list</p>
                  </div>
                  <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-medium border border-slate-200 whitespace-nowrap">
                    {projects.length} Project{projects.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-3 relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={projectListSearch}
                    onChange={(e) => setProjectListSearch(e.target.value)}
                    placeholder="Search projects..."
                    className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
              <div className="divide-y divide-slate-200 max-h-[32rem] overflow-y-auto">
                {visibleProjects.length === 0 ? (
                  <p className="p-4 text-xs text-slate-400 text-center">No projects match your search.</p>
                ) : (
                  visibleProjects.map((p) => (
                    <div key={p.id} className="p-4 flex items-center justify-between hover:bg-slate-50/80 transition-colors">
                      <div className="flex items-center space-x-3">
                        <div className="bg-blue-50 text-blue-600 p-2 rounded-xl border border-blue-100">
                          <Building2 className="w-5 h-5" />
                        </div>
                        <div>
                          <span className="font-semibold text-slate-900 text-sm block">{p.project_name}</span>
                          {p.location_lat != null && p.location_lng != null && (
                            <a
                              href={`https://www.openstreetmap.org/?mlat=${p.location_lat}&mlon=${p.location_lng}#map=17/${p.location_lat}/${p.location_lng}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-900 hover:underline font-mono mt-0.5"
                              title="View on map"
                            >
                              <MapPin className="w-3 h-3 shrink-0" />
                              {p.location_label ? p.location_label : `${Number(p.location_lat).toFixed(5)}, ${Number(p.location_lng).toFixed(5)}`}
                              {p.location_radius != null && (
                                <span className="text-blue-400">· {Number(p.location_radius) >= 1000 ? `${(Number(p.location_radius) / 1000).toFixed(1)}km` : `${p.location_radius}m`}</span>
                              )}
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => {
                            setEditingProject(p);
                            setNewProjectName(p.project_name);
                            setProjectLocation({
                              lat: p.location_lat != null ? Number(p.location_lat) : null,
                              lng: p.location_lng != null ? Number(p.location_lng) : null,
                              label: p.location_label ?? null,
                              radius: p.location_radius != null ? Number(p.location_radius) : null
                            });
                          }}
                          className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                          title="Edit project"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteProject(p.id)}
                          className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                          title="Delete project"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {!projectListSearch && !showAllProjects && projects.length > LIST_PAGE_SIZE && (
                <div className="p-3 border-t border-slate-200 text-center">
                  <button
                    type="button"
                    onClick={() => setShowAllProjects(true)}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-800"
                  >
                    Show all {projects.length} projects
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Branches — same layout as Projects above (form + searchable list) */}
      {activeTab === 'branches' && (
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1">
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
              <h3 className="text-lg font-bold text-slate-900 mb-4">
                {editingBranch ? 'Edit Branch' : 'Add New Branch'}
              </h3>
              <form onSubmit={handleSaveBranch} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
                    Branch Name
                  </label>
                  <input
                    type="text"
                    required
                    value={newBranchName}
                    onChange={(e) => setNewBranchName(e.target.value)}
                    placeholder="e.g. Head Office"
                    className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
                    Branch Location
                  </label>
                  {branchLocation.lat != null && branchLocation.lng != null ? (
                    <div className="flex items-center justify-between gap-2 px-3 py-2 bg-blue-50 border border-blue-100 rounded-xl">
                      <span className="inline-flex items-center gap-1.5 text-xs font-mono text-blue-800 truncate">
                        <MapPin className="w-3.5 h-3.5 shrink-0" />
                        {branchLocation.label || `${Number(branchLocation.lat).toFixed(6)}, ${Number(branchLocation.lng).toFixed(6)}`}
                        {branchLocation.radius != null && (
                          <span className="text-blue-500">· {branchLocation.radius >= 1000 ? `${(branchLocation.radius / 1000).toFixed(1)}km` : `${branchLocation.radius}m`} radius</span>
                        )}
                      </span>
                      <div className="flex items-center gap-1 shrink-0">
                        <button
                          type="button"
                          onClick={() => setShowBranchLocationPicker(true)}
                          className="text-[11px] font-semibold text-blue-700 hover:text-blue-900 px-2 py-1 rounded-lg hover:bg-blue-100"
                        >
                          Change
                        </button>
                        <button
                          type="button"
                          onClick={() => setBranchLocation({ lat: null, lng: null, label: null, radius: null })}
                          className="text-[11px] font-semibold text-rose-600 hover:text-rose-800 px-2 py-1 rounded-lg hover:bg-rose-50"
                        >
                          Clear
                        </button>
                      </div>
                    </div>
                  ) : (
                    <button
                      type="button"
                      onClick={() => setShowBranchLocationPicker(true)}
                      className="w-full flex items-center justify-center gap-1.5 px-3 py-2 bg-slate-50 hover:bg-slate-100 text-slate-600 text-xs font-semibold rounded-xl border border-dashed border-slate-300 transition-colors"
                    >
                      <MapPin className="w-3.5 h-3.5" />
                      Set Location on Map
                    </button>
                  )}
                  <p className="text-[11px] text-slate-400 mt-1">Optional — mark this branch's site on a free map.</p>
                </div>
                <div className="flex space-x-3">
                  <button
                    type="submit"
                    className="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-sm transition-all shadow-sm"
                  >
                    {editingBranch ? 'Update Branch' : 'Add Branch'}
                  </button>
                  {editingBranch && (
                    <button
                      type="button"
                      onClick={() => { setEditingBranch(null); setNewBranchName(''); setBranchLocation({ lat: null, lng: null, label: null, radius: null }); }}
                      className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl border border-slate-200"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="p-6 border-b border-slate-200">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">Branches List</h3>
                    <p className="text-xs text-slate-500">Company branches — Phase 1 (management only)</p>
                  </div>
                  <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-medium border border-slate-200 whitespace-nowrap">
                    {branches.length} Branch{branches.length === 1 ? '' : 'es'}
                  </span>
                </div>
                <div className="mt-3 relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={branchListSearch}
                    onChange={(e) => setBranchListSearch(e.target.value)}
                    placeholder="Search branches..."
                    className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
              <div className="divide-y divide-slate-200 max-h-[32rem] overflow-y-auto">
                {visibleBranches.length === 0 ? (
                  <p className="p-4 text-xs text-slate-400 text-center">No branches match your search.</p>
                ) : (
                  visibleBranches.map((b) => (
                    <div key={b.id} className="p-4 flex items-center justify-between hover:bg-slate-50/80 transition-colors">
                      <div className="flex items-center space-x-3">
                        <div className="bg-blue-50 text-blue-600 p-2 rounded-xl border border-blue-100">
                          <Building2 className="w-5 h-5" />
                        </div>
                        <div>
                          <span className="font-semibold text-slate-900 text-sm block">{b.branch_name}</span>
                          {b.location_lat != null && b.location_lng != null && (
                            <a
                              href={`https://www.openstreetmap.org/?mlat=${b.location_lat}&mlon=${b.location_lng}#map=17/${b.location_lat}/${b.location_lng}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              onClick={(e) => e.stopPropagation()}
                              className="inline-flex items-center gap-1 text-[11px] text-blue-700 hover:text-blue-900 hover:underline font-mono mt-0.5"
                              title="View on map"
                            >
                              <MapPin className="w-3 h-3 shrink-0" />
                              {b.location_label ? b.location_label : `${Number(b.location_lat).toFixed(5)}, ${Number(b.location_lng).toFixed(5)}`}
                              {b.location_radius != null && (
                                <span className="text-blue-400">· {Number(b.location_radius) >= 1000 ? `${(Number(b.location_radius) / 1000).toFixed(1)}km` : `${b.location_radius}m`}</span>
                              )}
                            </a>
                          )}
                        </div>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => {
                            setEditingBranch(b);
                            setNewBranchName(b.branch_name);
                            setBranchLocation({
                              lat: b.location_lat != null ? Number(b.location_lat) : null,
                              lng: b.location_lng != null ? Number(b.location_lng) : null,
                              label: b.location_label ?? null,
                              radius: b.location_radius != null ? Number(b.location_radius) : null
                            });
                          }}
                          className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                          title="Edit branch"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteBranch(b.id)}
                          className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                          title="Delete branch"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {!branchListSearch && !showAllBranches && branches.length > LIST_PAGE_SIZE && (
                <div className="p-3 border-t border-slate-200 text-center">
                  <button
                    type="button"
                    onClick={() => setShowAllBranches(true)}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-800"
                  >
                    Show all {branches.length} branches
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {/* TAB 3: DATA IMPORT (Rate File + Budget Excel Import) */}
      {activeTab === 'imports' && (
        <div className="space-y-8">
          {/* Hidden file input shared by every "Import Excel" button */}
          <input
            ref={budgetFileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleBudgetFileSelected}
            className="hidden"
          />
          <input
            ref={rateFileInputRef}
            type="file"
            accept=".xlsx,.xls"
            onChange={handleRateFileSelected}
            className="hidden"
          />

          {/* Rate File Excel Import — reference data, not tied to any Budget */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Import Rate File</h3>
                <p className="text-xs text-slate-500 mt-1">
                  One Excel file with two sheets — <span className="font-semibold">"Rate"</span> (materials price list) and{' '}
                  <span className="font-semibold">"Materials Category"</span> (Head / Sub-1 / Sub-2 / Sub-3 tree) — both sheets
                  are imported together, with all their columns. Re-importing replaces whatever was saved before.
                </p>
              </div>
              <div className="flex items-center gap-2">
                {rateFileSummary && (rateFileSummary.rate_count > 0 || rateFileSummary.category_count > 0) && (
                  <button
                    type="button"
                    onClick={openRateFileModal}
                    className="flex items-center gap-1.5 py-2 px-4 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-semibold rounded-xl shadow-sm transition-all text-sm whitespace-nowrap"
                  >
                    <Eye className="w-4 h-4" /> View
                  </button>
                )}
                <button
                  type="button"
                  onClick={triggerRateFileImport}
                  disabled={importingRateFile}
                  className="flex items-center gap-1.5 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-sm transition-all text-sm disabled:opacity-50 whitespace-nowrap"
                >
                  <Upload className="w-4 h-4" />
                  {importingRateFile ? 'Importing...' : 'Choose & Import Rate File'}
                </button>
              </div>
            </div>

            {rateFileSummary && (rateFileSummary.rate_count > 0 || rateFileSummary.category_count > 0) ? (
              <div className="flex items-center gap-4 flex-wrap bg-slate-50 border border-slate-200 rounded-xl px-4 py-3 text-xs text-slate-600">
                <span className="flex items-center gap-1.5">
                  <ListChecks className="w-3.5 h-3.5 text-blue-600" />
                  <span className="font-semibold text-slate-900">{rateFileSummary.rate_count}</span> Rate row(s)
                </span>
                <span className="flex items-center gap-1.5">
                  <ListChecks className="w-3.5 h-3.5 text-blue-600" />
                  <span className="font-semibold text-slate-900">{rateFileSummary.category_count}</span> Materials Category row(s)
                </span>
                {rateFileSummary.original_filename && (
                  <span className="text-slate-400 truncate">
                    from <span className="font-medium text-slate-600">{rateFileSummary.original_filename}</span>
                    {rateFileSummary.imported_at && ` · ${formatDate(rateFileSummary.imported_at)}`}
                  </span>
                )}
              </div>
            ) : (
              <div className="text-center text-xs text-slate-400 bg-slate-50 border border-dashed border-slate-200 rounded-xl py-6 px-4">
                No Rate File imported yet.
              </div>
            )}
          </div>

          {/* Budget Excel Import */}
          <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
            <div className="flex items-start justify-between gap-4 flex-wrap mb-4">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Import Budget from Excel</h3>
                <p className="text-xs text-slate-500 mt-1">
                  Click "New Budget", give it a name, then import the Excel sheet into it. Every MRF No in the
                  sheet is added to the Approved MPR list, and every Project Name is added to the Approved
                  Project list, automatically. A new budget stays in <span className="font-semibold">Draft</span> and
                  is hidden from Users until you click <span className="font-semibold">Submit</span> on it below.
                </p>
              </div>
              {!showNewBudgetForm && (
                <button
                  type="button"
                  onClick={() => { setShowNewBudgetForm(true); setActiveBudgetId(null); setActiveBudgetName(''); }}
                  className="flex items-center gap-1.5 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-sm transition-all text-sm whitespace-nowrap"
                >
                  <FolderPlus className="w-4 h-4" /> New Budget
                </button>
              )}
            </div>

            {/* New Budget Name form */}
            {showNewBudgetForm && (
              <form onSubmit={handleCreateBudget} className="flex items-end gap-3 flex-wrap bg-slate-50 border border-slate-200 rounded-xl p-4 mb-4">
                <div className="flex-1 min-w-[220px]">
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                    Budget Name
                  </label>
                  <input
                    type="text"
                    required
                    autoFocus
                    value={newBudgetName}
                    onChange={(e) => setNewBudgetName(e.target.value)}
                    placeholder="e.g. FY2026 Q1 Budget"
                    className="block w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <button
                  type="submit"
                  disabled={creatingBudget}
                  className="py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-sm transition-all shadow-sm disabled:opacity-50"
                >
                  {creatingBudget ? 'Creating...' : 'Create Budget'}
                </button>
                <button
                  type="button"
                  onClick={() => { setShowNewBudgetForm(false); setNewBudgetName(''); }}
                  className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl border border-slate-200"
                >
                  Cancel
                </button>
              </form>
            )}

            {/* Active budget ready for import */}
            {activeBudgetId && (
              <div className="flex items-center justify-between gap-4 flex-wrap bg-emerald-50 border border-emerald-200 rounded-xl p-4 mb-4">
                <div className="text-sm text-emerald-800">
                  Budget <span className="font-bold">"{activeBudgetName}"</span> is ready. Choose the Excel file to import its rows.
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    onClick={() => triggerBudgetImport(activeBudgetId)}
                    disabled={importingBudgetId === activeBudgetId}
                    className="flex items-center gap-1.5 py-2 px-4 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl shadow-sm transition-all text-sm disabled:opacity-50 whitespace-nowrap"
                  >
                    <Upload className="w-4 h-4" />
                    {importingBudgetId === activeBudgetId ? 'Importing...' : 'Choose & Import Excel'}
                  </button>
                  <button
                    type="button"
                    onClick={() => { setActiveBudgetId(null); setActiveBudgetName(''); }}
                    className="p-2 text-emerald-700 hover:bg-emerald-100 rounded-lg transition-colors"
                    title="Done"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              </div>
            )}

            {/* Existing budgets list */}
            {budgets.length > 0 ? (
              <div className="overflow-x-auto border border-slate-200 rounded-xl">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Budget Name</th>
                      <th className="px-4 py-2.5 text-left">Imported Rows</th>
                      <th className="px-4 py-2.5 text-left">Delivery Date Range</th>
                      <th className="px-4 py-2.5 text-left">Rate &amp; Category</th>
                      <th className="px-4 py-2.5 text-left">Status</th>
                      <th className="px-4 py-2.5 text-left">Created</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-200 text-sm">
                    {budgets.map((b) => (
                      <tr key={b.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="px-4 py-3 text-xs">
                          <button
                            type="button"
                            onClick={() => handleViewBudget(b)}
                            className="font-semibold text-blue-700 hover:text-blue-900 hover:underline text-left"
                            title="View full imported Excel data"
                          >
                            {b.budget_name}
                          </button>
                          {b.original_filename && (
                            <div className="flex items-center gap-1 text-slate-400 text-[10px] mt-0.5">
                              <FileSpreadsheet className="w-3 h-3" /> {b.original_filename}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-slate-600 text-xs">{b.item_count ?? 0}</td>
                        <td className="px-4 py-3 text-xs">
                          {b.delivery_date_from || b.delivery_date_to ? (
                            <span className="inline-flex items-center gap-1 text-slate-600">
                              {formatDate(b.delivery_date_from) || '—'} <span className="text-slate-300">→</span> {formatDate(b.delivery_date_to) || '—'}
                            </span>
                          ) : (
                            <span className="text-slate-300">Not restricted</span>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          <button
                            type="button"
                            onClick={() => handleApproveBudget(b)}
                            disabled={approvingBudgetId === b.id}
                            className="flex items-center gap-1.5 py-1.5 px-2.5 bg-white hover:bg-emerald-50 border border-slate-200 hover:border-emerald-300 text-slate-700 hover:text-emerald-700 font-semibold rounded-lg transition-all disabled:opacity-50 whitespace-nowrap"
                            title="Match Rate + Category onto every entry in this Budget from the Rate File"
                          >
                            <ListChecks className="w-3.5 h-3.5" />
                            {approvingBudgetId === b.id ? 'Calculating...' : 'Approve & Calculate'}
                          </button>
                          {b.rate_approved_at && (
                            <div className="text-[10px] text-slate-400 mt-1">
                              Last calculated {formatDate(b.rate_approved_at)}
                            </div>
                          )}
                        </td>
                        <td className="px-4 py-3 text-xs">
                          {b.is_published ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700 border border-emerald-200 font-semibold">
                              Published
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-slate-100 text-slate-500 border border-slate-200 font-semibold">
                              Draft — hidden from Users
                            </span>
                          )}
                          <div className="mt-1.5">
                            {b.is_published ? (
                              <button
                                type="button"
                                onClick={() => handlePublishBudget(b, false)}
                                disabled={publishingBudgetId === b.id}
                                className="text-[11px] font-semibold text-slate-500 hover:text-rose-600 underline disabled:opacity-50"
                                title="Hide this budget from Users again"
                              >
                                {publishingBudgetId === b.id ? 'Updating...' : 'Withdraw'}
                              </button>
                            ) : (
                              <button
                                type="button"
                                onClick={() => handlePublishBudget(b, true)}
                                disabled={publishingBudgetId === b.id}
                                className="flex items-center gap-1.5 py-1.5 px-2.5 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-lg transition-all disabled:opacity-50 whitespace-nowrap text-[11px]"
                                title="Make this budget visible to Users"
                              >
                                {publishingBudgetId === b.id ? 'Submitting...' : 'Submit'}
                              </button>
                            )}
                          </div>
                        </td>
                        <td className="px-4 py-3 text-slate-500 text-xs">
                          {b.created_at ? formatDate(b.created_at) : 'N/A'}
                        </td>
                        <td className="px-4 py-3 text-right text-xs">
                          <div className="flex items-center justify-end gap-1">
                            <button
                              onClick={() => openSubmissionsModal(b)}
                              className="p-1.5 text-slate-400 hover:text-amber-600 hover:bg-amber-50 rounded-lg transition-colors"
                              title="See who has Final Submitted this budget, and unlock them if needed"
                            >
                              <Unlock className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => openRangeModal(b)}
                              className="p-1.5 text-slate-400 hover:text-indigo-600 hover:bg-indigo-50 rounded-lg transition-colors"
                              title="Set allowed Delivery Date range for this budget"
                            >
                              <Calendar className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleViewBudget(b)}
                              className="p-1.5 text-slate-400 hover:text-emerald-600 hover:bg-emerald-50 rounded-lg transition-colors"
                              title="View full imported data"
                            >
                              <Eye className="w-4 h-4" />
                            </button>
                            {b.has_file && (
                              <button
                                onClick={() => handleDownloadBudgetFile(b.id, b.budget_name)}
                                className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                                title="Download the original Excel file"
                              >
                                <Download className="w-4 h-4" />
                              </button>
                            )}
                            <button
                              onClick={() => triggerBudgetImport(b.id)}
                              disabled={importingBudgetId === b.id}
                              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors disabled:opacity-50"
                              title="Import more rows into this budget"
                            >
                              <Upload className="w-4 h-4" />
                            </button>
                            <button
                              onClick={() => handleDeleteBudget(b.id)}
                              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                              title="Delete budget"
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
            ) : (
              !showNewBudgetForm && !activeBudgetId && (
                <p className="text-xs text-slate-400">No budgets yet. Click "New Budget" to import your first Excel sheet.</p>
              )
            )}
          </div>

          {/* Delivery Date "minimum lead time" — see DeliveryDateConditionsPanel.tsx */}
          <DeliveryDateConditionsPanel token={token} />
        </div>
      )}

      {/* TAB 3: MPR NUMBERS */}
      {activeTab === 'mprs' && (
        <div className="space-y-8">
          <div className="grid grid-cols-1 lg:grid-cols-3 gap-8">
          <div className="lg:col-span-1">
            <div className="bg-white border border-slate-200 rounded-2xl p-6 shadow-sm">
              <h3 className="text-lg font-bold text-slate-900 mb-4">
                {editingMpr ? 'Edit MPR No' : 'Add New MPR No'}
              </h3>
              <form onSubmit={handleSaveMpr} className="space-y-4">
                <div>
                  <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
                    MPR Number
                  </label>
                  <input
                    type="text"
                    required
                    value={newMprNo}
                    onChange={(e) => setNewMprNo(e.target.value)}
                    placeholder="e.g. MPR-2026-006"
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
                <div className="flex space-x-3">
                  <button
                    type="submit"
                    className="flex-1 py-2.5 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-sm transition-all shadow-sm"
                  >
                    {editingMpr ? 'Update MPR' : 'Add MPR'}
                  </button>
                  {editingMpr && (
                    <button
                      type="button"
                      onClick={() => { setEditingMpr(null); setNewMprNo(''); }}
                      className="px-4 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl border border-slate-200"
                    >
                      Cancel
                    </button>
                  )}
                </div>
              </form>
            </div>
          </div>

          <div className="lg:col-span-2">
            <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
              <div className="p-6 border-b border-slate-200">
                <div className="flex items-center justify-between gap-3 flex-wrap">
                  <div>
                    <h3 className="text-lg font-bold text-slate-900">Approved MPR Numbers List</h3>
                    <p className="text-xs text-slate-500">Users select MPR numbers strictly from this list</p>
                  </div>
                  <span className="text-xs px-2.5 py-1 rounded-full bg-slate-100 text-slate-700 font-medium border border-slate-200 whitespace-nowrap">
                    {mprNumbers.length} MPR{mprNumbers.length === 1 ? '' : 's'}
                  </span>
                </div>
                <div className="mt-3 relative">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={mprListSearch}
                    onChange={(e) => setMprListSearch(e.target.value)}
                    placeholder="Search MPR numbers..."
                    className="w-full pl-9 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-sm focus:outline-none focus:ring-2 focus:ring-blue-600"
                  />
                </div>
              </div>
              <div className="divide-y divide-slate-200 max-h-[32rem] overflow-y-auto">
                {visibleMprNumbers.length === 0 ? (
                  <p className="p-4 text-xs text-slate-400 text-center">No MPR numbers match your search.</p>
                ) : (
                  visibleMprNumbers.map((m) => (
                    <div key={m.id} className="p-4 flex items-center justify-between hover:bg-slate-50/80 transition-colors">
                      <div className="flex items-center space-x-3">
                        <div className="bg-indigo-50 text-indigo-600 p-2 rounded-xl border border-indigo-100">
                          <FileText className="w-5 h-5" />
                        </div>
                        <span className="font-mono font-semibold text-slate-900 text-sm">{m.mpr_no}</span>
                      </div>
                      <div className="flex items-center space-x-2">
                        <button
                          onClick={() => { setEditingMpr(m); setNewMprNo(m.mpr_no); }}
                          className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-lg transition-colors"
                          title="Edit MPR"
                        >
                          <Edit2 className="w-4 h-4" />
                        </button>
                        <button
                          onClick={() => handleDeleteMpr(m.id)}
                          className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                          title="Delete MPR"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      </div>
                    </div>
                  ))
                )}
              </div>
              {!mprListSearch && !showAllMprs && mprNumbers.length > LIST_PAGE_SIZE && (
                <div className="p-3 border-t border-slate-200 text-center">
                  <button
                    type="button"
                    onClick={() => setShowAllMprs(true)}
                    className="text-xs font-semibold text-blue-600 hover:text-blue-800"
                  >
                    Show all {mprNumbers.length} MPR numbers
                  </button>
                </div>
              )}
            </div>
          </div>
        </div>
        </div>
      )}

      {/* TAB 4: USERS */}
      {activeTab === 'users' && (
        <div className="space-y-6">
          {/* Add New User Form */}
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
            <h3 className="text-lg font-bold text-slate-900 mb-1">Add New User</h3>
            <p className="text-xs text-slate-500 mb-4">
              Create an account for a User or Admin. There is no public sign-up — accounts are only created here.
            </p>
            <form onSubmit={handleCreateUser} className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-3 items-end">
              <div className="lg:col-span-1">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Full Name</label>
                <input
                  type="text"
                  required
                  value={newUserName}
                  onChange={(e) => setNewUserName(e.target.value)}
                  placeholder="John Doe"
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                />
              </div>
              <div className="lg:col-span-1">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Email</label>
                <input
                  type="email"
                  required
                  value={newUserEmail}
                  onChange={(e) => setNewUserEmail(e.target.value)}
                  placeholder="user@company.com"
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                />
              </div>
              <div className="lg:col-span-1">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Password</label>
                <input
                  type="text"
                  required
                  minLength={6}
                  value={newUserPassword}
                  onChange={(e) => setNewUserPassword(e.target.value)}
                  placeholder="Min. 6 characters"
                  className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                />
              </div>
              <div className="lg:col-span-1">
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Role</label>
                {isSuperAdmin ? (
                  <select
                    value={newUserRole}
                    onChange={(e) => setNewUserRole(e.target.value as 'user' | 'admin')}
                    className="block w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none cursor-pointer"
                  >
                    <option value="user">User</option>
                    <option value="admin">Admin</option>
                  </select>
                ) : (
                  <div
                    className="block w-full px-3 py-2 bg-slate-100 border border-slate-200 rounded-xl text-slate-500 text-sm"
                    title="Only the Superadmin can create Admin accounts"
                  >
                    User
                  </div>
                )}
              </div>
              <div className="lg:col-span-1">
                <button
                  type="submit"
                  disabled={creatingUser}
                  className="w-full flex items-center justify-center gap-1.5 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-sm transition-all text-sm disabled:opacity-50"
                >
                  <Plus className="w-4 h-4" />
                  {creatingUser ? 'Creating...' : 'Create User'}
                </button>
              </div>
            </form>
          </div>

          {/* Bulk Add Users — SL, Project Name, Password only. These accounts log in
              with Project Name (spaces ignored) + Password instead of email. */}
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-6">
            <button
              type="button"
              onClick={() => setShowBulkUsers((v) => !v)}
              className="w-full flex items-center justify-between text-left"
            >
              <div>
                <h3 className="text-lg font-bold text-slate-900">Bulk Add Users</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Add many Project logins at once — SL, Project Name, Password. These users sign in with
                  their Project Name (no spaces) + Password.
                </p>
              </div>
              <Upload className="w-5 h-5 text-slate-400 flex-shrink-0" />
            </button>

            {showBulkUsers && (
              <div className="mt-5 space-y-4">
                <input
                  ref={bulkUsersFileInputRef}
                  type="file"
                  accept=".xlsx,.xls,.csv"
                  onChange={handleBulkUsersFileSelected}
                  className="hidden"
                />
                <div className="flex items-center justify-between gap-3 bg-slate-50 border border-slate-200 rounded-xl p-3">
                  <p className="text-xs text-slate-500">
                    Upload an Excel/CSV with <span className="font-semibold text-slate-700">SL, Project Name, Password</span> columns
                    (SL is optional — column names are matched loosely).
                  </p>
                  <button
                    type="button"
                    onClick={triggerBulkUsersFileImport}
                    className="flex items-center gap-1.5 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl text-xs transition-all shadow-sm whitespace-nowrap"
                  >
                    <FileSpreadsheet className="w-3.5 h-3.5" /> Import from Excel
                  </button>
                </div>

                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                    Or paste rows — Project Name, Password per line
                  </label>
                  <div className="flex gap-2">
                    <textarea
                      value={bulkPasteText}
                      onChange={(e) => setBulkPasteText(e.target.value)}
                      placeholder={"Riverside Tower, ab12cd\nGreenfield Plaza, xy98zt"}
                      rows={3}
                      className="flex-1 px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs font-mono focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                    />
                    <button
                      type="button"
                      onClick={handleParseBulkPaste}
                      disabled={!bulkPasteText.trim()}
                      className="self-start px-3 py-2 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl text-xs transition-colors disabled:opacity-40"
                    >
                      Fill rows below
                    </button>
                  </div>
                </div>

                <div className="border border-slate-200 rounded-xl overflow-hidden">
                  <table className="min-w-full divide-y divide-slate-200">
                    <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                      <tr>
                        <th className="px-3 py-2 text-left w-14">SL</th>
                        <th className="px-3 py-2 text-left">Project Name</th>
                        <th className="px-3 py-2 text-left w-40">Password (6 chars)</th>
                        <th className="px-3 py-2 w-10"></th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-200">
                      {bulkRows.map((row, idx) => (
                        <tr key={idx}>
                          <td className="px-3 py-2 text-xs text-slate-500">{idx + 1}</td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={row.project_name}
                              onChange={(e) => updateBulkRow(idx, 'project_name', e.target.value)}
                              placeholder="Project Name"
                              className="block w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                            />
                          </td>
                          <td className="px-3 py-2">
                            <input
                              type="text"
                              value={row.password}
                              onChange={(e) => updateBulkRow(idx, 'password', e.target.value.slice(0, 6))}
                              maxLength={6}
                              placeholder="6 characters"
                              className="block w-full px-2.5 py-1.5 bg-slate-50 border border-slate-200 rounded-lg text-slate-900 text-xs font-mono focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                            />
                          </td>
                          <td className="px-3 py-2 text-right">
                            <button
                              type="button"
                              onClick={() => removeBulkRow(idx)}
                              className="p-1 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                              title="Remove row"
                            >
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>

                <div className="flex items-center justify-between gap-3">
                  <button
                    type="button"
                    onClick={addBulkRow}
                    className="flex items-center gap-1.5 py-2 px-3 bg-slate-100 hover:bg-slate-200 text-slate-700 font-semibold rounded-xl text-xs transition-colors"
                  >
                    <Plus className="w-3.5 h-3.5" /> Add Row
                  </button>
                  <button
                    type="button"
                    onClick={handleBulkImport}
                    disabled={bulkImporting}
                    className="flex items-center gap-1.5 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-sm transition-all text-xs disabled:opacity-50"
                  >
                    <Upload className="w-3.5 h-3.5" />
                    {bulkImporting ? 'Importing...' : 'Import Users'}
                  </button>
                </div>

                {bulkResult && (bulkResult.created.length > 0 || bulkResult.skipped.length > 0) && (
                  <div className="border border-slate-200 rounded-xl divide-y divide-slate-200 text-xs">
                    {bulkResult.created.length > 0 && (
                      <div className="p-3">
                        <p className="font-semibold text-emerald-700 mb-1.5">
                          Created ({bulkResult.created.length})
                        </p>
                        <ul className="space-y-0.5 text-slate-600">
                          {bulkResult.created.map((r) => (
                            <li key={`c-${r.sl}`}>
                              SL {r.sl}: <span className="font-medium text-slate-900">{r.project_name}</span>
                              {r.username && <span className="text-slate-400"> — login: {r.username}</span>}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                    {bulkResult.skipped.length > 0 && (
                      <div className="p-3">
                        <p className="font-semibold text-rose-700 mb-1.5">
                          Skipped ({bulkResult.skipped.length})
                        </p>
                        <ul className="space-y-0.5 text-slate-600">
                          {bulkResult.skipped.map((r) => (
                            <li key={`s-${r.sl}`}>
                              SL {r.sl}: <span className="font-medium text-slate-900">{r.project_name || '(blank)'}</span>
                              <span className="text-rose-500"> — {r.reason}</span>
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </div>
                )}
              </div>
            )}
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
          <div className="p-6 border-b border-slate-200 flex flex-col lg:flex-row lg:items-center lg:justify-between gap-4">
            <div>
              <h3 className="text-lg font-bold text-slate-900">User Management</h3>
              <p className="text-xs text-slate-500">
                {isSuperAdmin
                  ? 'Manage system users, promote/demote Admins, and set which Admin Panel modules each Admin can access.'
                  : 'Manage system users. Only the Superadmin can change roles or an Admin\u2019s module access.'}
              </p>
            </div>
            {/* Search (name / Login ID) + role filter \u2014 narrows filteredUsers below
                without touching the `users` state other tabs on this page depend on. */}
            <div className="flex items-center gap-2 shrink-0">
              <div className="relative">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={userSearchText}
                  onChange={(e) => setUserSearchText(e.target.value)}
                  placeholder="Search name or Login ID..."
                  className="w-full sm:w-56 pl-8 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                />
              </div>
              <div className="relative">
                <Filter className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                <select
                  value={userRoleFilter}
                  onChange={(e) => setUserRoleFilter(e.target.value as typeof userRoleFilter)}
                  className="pl-8 pr-7 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs focus:ring-2 focus:ring-blue-600 focus:outline-none cursor-pointer appearance-none"
                >
                  <option value="all">All Roles</option>
                  <option value="superadmin">Superadmin</option>
                  <option value="admin">Admin</option>
                  <option value="user">User</option>
                </select>
              </div>
            </div>
          </div>
          {(userSearchText || userRoleFilter !== 'all') && (
            <div className="px-6 py-2 border-b border-slate-100 text-[11px] text-slate-500">
              Showing {filteredUsers.length} of {users.length} users
            </div>
          )}
          <div className="overflow-x-auto">
            <table className="w-full divide-y divide-slate-200">
              {/* Was `sticky top-16 z-10` (to keep column headers visible
                  while scrolling a long User list, under Navbar's own
                  sticky top-0 h-16) — removed: `position: sticky` on a
                  <thead> inside a plain (non-scrolling-container) table
                  doesn't reliably reserve its own space against the
                  <tbody> that follows it, so once stuck it painted directly
                  on top of the table's very first row, hiding it entirely
                  behind this opaque background (most visible with a
                  search narrowed to exactly one result — the row was still
                  there, just invisible underneath the header). A plain
                  static header has no such conflict. */}
              <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="w-24 px-2.5 py-2 text-left">Name</th>
                  <th className="w-28 px-2.5 py-2 text-left">Login ID</th>
                  <th className="w-20 px-2.5 py-2 text-left">Role</th>
                  {canGrantModuleAccess && <th className="w-24 px-2.5 py-2 text-left">Modules</th>}
                  <th className="w-24 px-2.5 py-2 text-left">Projects</th>
                  <th className="px-2.5 py-2 text-left">Joined</th>
                  {canSeeLoginLocation && <th className="w-48 px-2.5 py-2 text-left">Last Login</th>}
                  {isSuperAdmin && <th className="px-2.5 py-2 text-left">Location</th>}
                  {isSuperAdmin && <th className="w-24 px-2.5 py-2 text-left">Grants Modules</th>}
                  <th className="px-2.5 py-2 text-left">Delivery</th>
                  <th className="px-2.5 py-2 text-left">Job Edit</th>
                  <th className="px-2.5 py-2 text-left">Attend.</th>
                  <th className="w-28 px-2.5 py-2 text-left">Attend. Project</th>
                  <th className="px-2.5 py-2 text-left">Tracking</th>
                  <th className="px-2.5 py-2 text-left">Leave</th>
                  <th className="px-2.5 py-2 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-200 text-sm">
                {filteredUsers.length === 0 ? (
                  <tr>
                    <td
                      colSpan={
                        3 + (canGrantModuleAccess ? 1 : 0) + 1 + 1 + (canSeeLoginLocation ? 1 : 0) +
                        (isSuperAdmin ? 1 : 0) + (isSuperAdmin ? 1 : 0) + 1 + 1 + 1 + 1 + 1 + 1 + 1
                      }
                      className="px-4 py-8 text-center text-sm text-slate-400"
                    >
                      No users match your search.
                    </td>
                  </tr>
                ) : filteredUsers.map((u) => {
                  const grantedCount = projectIdsForUser(u.id).size;
                  const grantedModuleCount = (u.module_permissions || []).length;
                  // Same rule the Actions column (Change Login ID/Reset Password/
                  // Delete) already applies: a delegated (non-superadmin) Admin
                  // can only touch a role='user' row, never another 'admin' —
                  // reused here for the Delivery/Job Edit/Attend./Attend.
                  // Project/Tracking/Leave toggle cells below, which previously
                  // had no such gate at all (server-enforced now too, see PUT
                  // /api/users/:id/feature-permissions in UserManagement.ts).
                  const canEditFeaturesFor = u.role !== 'superadmin' && (u.role !== 'admin' || isSuperAdmin);
                  return (
                  <tr key={u.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-3 py-3 font-medium text-slate-900 text-xs truncate" title={u.name}>{u.name}</td>
                    <td className="px-3 py-3 text-slate-600 text-xs truncate" title={u.email || u.username || undefined}>
                      {u.email || (u.username ? <span className="font-mono">{u.username}</span> : '—')}
                    </td>
                    <td className="px-3 py-3">
                      {u.role === 'superadmin' ? (
                        <span className="inline-block text-[11px] font-semibold px-2 py-1 rounded-full border bg-rose-50 text-rose-800 border-rose-200 truncate max-w-full">
                          Superadmin
                        </span>
                      ) : isSuperAdmin ? (
                        <select
                          value={u.role}
                          onChange={(e) => handleRoleChange(u.id, e.target.value as 'admin' | 'user')}
                          className={`text-[11px] font-semibold px-2 py-1 rounded-full border cursor-pointer max-w-full ${
                            u.role === 'admin'
                              ? 'bg-amber-50 text-amber-800 border-amber-200'
                              : 'bg-blue-50 text-blue-800 border-blue-200'
                          }`}
                        >
                          <option value="admin" className="bg-white text-slate-900">Admin</option>
                          <option value="user" className="bg-white text-slate-900">User</option>
                        </select>
                      ) : (
                        <span className={`inline-block text-[11px] font-semibold px-2 py-1 rounded-full border truncate max-w-full ${
                          u.role === 'admin'
                            ? 'bg-amber-50 text-amber-800 border-amber-200'
                            : 'bg-blue-50 text-blue-800 border-blue-200'
                        }`}>
                          {u.role === 'admin' ? 'Admin' : 'User'}
                        </span>
                      )}
                    </td>
                    {canGrantModuleAccess && (
                      <td className="px-3 py-3 text-xs">
                        {u.role === 'superadmin' ? (
                          <span className="text-slate-400 truncate block">All (Super)</span>
                        ) : /* A delegated (non-superadmin) Admin with can_grant_module_access can only
                               ever reach a role='user' target here — an 'admin' row falls through to
                               the "—" case below for them, same restriction the server enforces on
                               PUT /api/users/:id/module-permissions. */
                        u.role === 'user' || (u.role === 'admin' && isSuperAdmin) ? (
                          <button
                            type="button"
                            onClick={() => openManageModules(u)}
                            className={`flex items-center gap-1 px-2 py-1 rounded-full border font-semibold transition-colors max-w-full truncate ${
                              grantedModuleCount > 0
                                ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                                : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
                            }`}
                          >
                            <LayoutGrid className="w-3.5 h-3.5 shrink-0" />
                            <span className="truncate">{grantedModuleCount > 0 ? `${grantedModuleCount} Mod.` : 'Set Access'}</span>
                          </button>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-3 text-xs">
                      {u.role === 'admin' || u.role === 'superadmin' ? (
                        <span className="text-slate-400 truncate block">All (Admin)</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => openManageProjects(u)}
                          className={`flex items-center gap-1 px-2 py-1 rounded-full border font-semibold transition-colors max-w-full truncate ${
                            grantedCount > 0
                              ? 'bg-emerald-50 text-emerald-800 border-emerald-200 hover:bg-emerald-100'
                              : 'bg-slate-100 text-slate-500 border-slate-200 hover:bg-slate-200'
                          }`}
                        >
                          <KeyRound className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{grantedCount > 0 ? `${grantedCount} Proj.` : 'Set Access'}</span>
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-slate-500 text-xs">
                      {u.created_at ? formatDate(u.created_at) : 'N/A'}
                    </td>
                    {canSeeLoginLocation && (
                      <td className="px-3 py-3 text-xs">
                        {u.last_login_lat != null && u.last_login_lng != null ? (
                          <LastLoginAddress
                            lat={Number(u.last_login_lat)}
                            lng={Number(u.last_login_lng)}
                            asOf={u.last_login_at || undefined}
                          />
                        ) : (
                          <span className="text-slate-400">No login yet</span>
                        )}
                      </td>
                    )}
                    {isSuperAdmin && (
                      <td className="px-3 py-3 whitespace-nowrap text-xs">
                        {u.role === 'admin' ? (
                          <button
                            type="button"
                            onClick={() => handleLoginLocationAccessToggle(u.id, !u.can_view_login_location)}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                              u.can_view_login_location ? 'bg-emerald-500' : 'bg-slate-300'
                            }`}
                            title={
                              u.can_view_login_location
                                ? 'Can see Last Login Location — click to revoke'
                                : 'Cannot see Last Login Location — click to grant'
                            }
                          >
                            <span
                              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                                u.can_view_login_location ? 'translate-x-[18px]' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    )}
                    {isSuperAdmin && (
                      <td className="px-3 py-3 whitespace-nowrap text-xs">
                        {u.role === 'admin' ? (
                          <button
                            type="button"
                            onClick={() => handleFeaturePermissionToggle(u.id, 'can_grant_module_access', !u.can_grant_module_access)}
                            className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                              u.can_grant_module_access ? 'bg-emerald-500' : 'bg-slate-300'
                            }`}
                            title={
                              u.can_grant_module_access
                                ? "Can set OTHER Users' Module Access (never another Admin's) — click to revoke"
                                : "Can't set Module Access for anyone — click to grant"
                            }
                          >
                            <span
                              className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                                u.can_grant_module_access ? 'translate-x-[18px]' : 'translate-x-1'
                              }`}
                            />
                          </button>
                        ) : (
                          <span className="text-slate-300">—</span>
                        )}
                      </td>
                    )}
                    <td className="px-3 py-3 whitespace-nowrap text-xs">
                      {canEditFeaturesFor ? (
                        <button
                          type="button"
                          onClick={() => handleFeaturePermissionToggle(u.id, 'can_edit_delivery_date', !(u.can_edit_delivery_date ?? true))}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            (u.can_edit_delivery_date ?? true) ? 'bg-emerald-500' : 'bg-slate-300'
                          }`}
                          title={(u.can_edit_delivery_date ?? true) ? 'On — click to turn off' : 'Off — click to turn on'}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                              (u.can_edit_delivery_date ?? true) ? 'translate-x-[18px]' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-xs">
                      {canEditFeaturesFor ? (
                        <button
                          type="button"
                          onClick={() => handleFeaturePermissionToggle(u.id, 'can_job_edit', !u.can_job_edit)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            u.can_job_edit ? 'bg-emerald-500' : 'bg-slate-300'
                          }`}
                          title={u.can_job_edit ? 'On — click to turn off' : 'Off — click to turn on'}
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                              u.can_job_edit ? 'translate-x-[18px]' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-xs">
                      {!canEditFeaturesFor ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleFeaturePermissionToggle(u.id, 'can_use_attendance', !u.can_use_attendance)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            u.can_use_attendance ? 'bg-emerald-500' : 'bg-slate-300'
                          }`}
                          title={
                            u.can_use_attendance
                              ? 'Sees Remote Attendance on their Dashboard — click to revoke'
                              : "Doesn't see Remote Attendance on their Dashboard — click to grant"
                          }
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                              u.can_use_attendance ? 'translate-x-[18px]' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-xs">
                      {!canEditFeaturesFor ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <select
                          value={u.attendance_project_id ?? ''}
                          onChange={(e) =>
                            handleAttendanceProjectChange(u.id, e.target.value ? Number(e.target.value) : null)
                          }
                          disabled={!u.can_use_attendance}
                          title={
                            u.can_use_attendance
                              ? 'Locks this account to one Project for Remote Attendance — leave unset for no restriction. Budget/Jobs/MPR project selection is unaffected.'
                              : 'Grant Remote Attendance first to pin a Project.'
                          }
                          className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg disabled:bg-slate-50 disabled:text-slate-300 focus:ring-2 focus:ring-blue-600 focus:outline-none"
                        >
                          <option value="">Unrestricted</option>
                          {projects.map((p) => (
                            <option key={p.id} value={p.id}>{p.project_name}</option>
                          ))}
                        </select>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-xs">
                      {!canEditFeaturesFor ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleFeaturePermissionToggle(u.id, 'can_use_tracking', !u.can_use_tracking)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            u.can_use_tracking ? 'bg-emerald-500' : 'bg-slate-300'
                          }`}
                          title={
                            u.can_use_tracking
                              ? "Their APK reports live location — click to revoke"
                              : "Their APK doesn't report location — click to grant"
                          }
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                              u.can_use_tracking ? 'translate-x-[18px]' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-xs">
                      {!canEditFeaturesFor ? (
                        <span className="text-slate-300">—</span>
                      ) : (
                        <button
                          type="button"
                          onClick={() => handleFeaturePermissionToggle(u.id, 'can_view_leave_summary', !u.can_view_leave_summary)}
                          className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors ${
                            u.can_view_leave_summary ? 'bg-emerald-500' : 'bg-slate-300'
                          }`}
                          title={
                            u.can_view_leave_summary
                              ? 'Sees Leave Summary on their Dashboard — click to revoke'
                              : "Doesn't see Leave Summary on their Dashboard — click to grant"
                          }
                        >
                          <span
                            className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                              u.can_view_leave_summary ? 'translate-x-[18px]' : 'translate-x-1'
                            }`}
                          />
                        </button>
                      )}
                    </td>
                    <td className="px-3 py-3 whitespace-nowrap text-right text-xs">
                      {u.role !== 'superadmin' && (u.role !== 'admin' || isSuperAdmin) && (
                        <button
                          onClick={() => {
                            setNewEmailInput(u.email || '');
                            setChangingEmailFor(u);
                          }}
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Change Login ID (email)"
                        >
                          <Mail className="w-4 h-4" />
                        </button>
                      )}
                      {u.role !== 'superadmin' && (u.role !== 'admin' || isSuperAdmin) && (
                        <button
                          onClick={() => {
                            setNewPasswordInput('');
                            setResettingPasswordFor(u);
                          }}
                          className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          title="Reset password"
                        >
                          <Lock className="w-4 h-4" />
                        </button>
                      )}
                      {u.role !== 'superadmin' && (u.role !== 'admin' || isSuperAdmin) && (
                        <button
                          onClick={() => handleDeleteUser(u.id)}
                          className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                          title="Delete user"
                        >
                          <Trash2 className="w-4 h-4" />
                        </button>
                      )}
                    </td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          </div>
        </div>
      )}

      {/* TAB: EMPLOYEES — the company-wide employee directory (Employee ID,
          Name, Designation, Department, Email, Phone). Plain hand-entered
          reference data, not tied to a login account. */}
      {activeTab === 'employees' && (
        <EmployeesPanel token={token} user={user} />
      )}

      {/* TAB: DEPARTMENTS — real org-structure master data: a Department name
          + an optional Supervisor (a login account) who, unless turned off,
          is auto-inserted as the first layer of the Approval Workflow for
          every request an Employee in that Department submits (Conveyance
          Bill Claim / Timesheet Correction / Leave Application) — ahead of
          whatever Approval Template applies. See the `departments` table
          comment in server.ts for the full design. */}
      {activeTab === 'departments' && (
        <div className="space-y-4">
          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2 mb-1">
              <Users2 className="w-4 h-4 text-blue-600" /> {editingDepartment ? 'Edit Department' : 'Add Department'}
            </h3>
            <p className="text-xs text-slate-500 mb-4">
              Set a Supervisor here and, by default, they become the first Approval Workflow layer for every request an
              Employee in this Department submits — turn "Include in Approval Workflow" off if this Department's
              Supervisor should stay informational only.
            </p>
            <form onSubmit={handleSaveDepartment} className="space-y-4">
              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Department Name</label>
                  <input
                    type="text"
                    required
                    value={deptForm.name}
                    onChange={(e) => setDeptForm((f) => ({ ...f, name: e.target.value }))}
                    placeholder="e.g. Accounts & Finance"
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  />
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Supervisor</label>
                  <select
                    value={deptForm.supervisor_user_id}
                    onChange={(e) => setDeptForm((f) => ({ ...f, supervisor_user_id: e.target.value }))}
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                  >
                    <option value="">— None —</option>
                    {users.map((u) => (
                      <option key={u.id} value={u.id}>{u.name} ({u.role})</option>
                    ))}
                  </select>
                </div>
              </div>

              <div className="flex flex-wrap items-center gap-6">
                <label className="flex items-center gap-2 cursor-pointer">
                  <button
                    type="button"
                    onClick={() => setDeptForm((f) => ({ ...f, include_supervisor_approval: !f.include_supervisor_approval }))}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                      deptForm.include_supervisor_approval ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        deptForm.include_supervisor_approval ? 'translate-x-[18px]' : 'translate-x-1'
                      }`}
                    />
                  </button>
                  <span className="text-xs font-medium text-slate-700">Include Supervisor in Approval Workflow (first layer)</span>
                </label>
                <label className="flex items-center gap-2 cursor-pointer">
                  <button
                    type="button"
                    onClick={() => setDeptForm((f) => ({ ...f, is_active: !f.is_active }))}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                      deptForm.is_active ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        deptForm.is_active ? 'translate-x-[18px]' : 'translate-x-1'
                      }`}
                    />
                  </button>
                  <span className="text-xs font-medium text-slate-700">Active</span>
                </label>
              </div>

              <div className="flex gap-2">
                <button
                  type="submit"
                  disabled={savingDepartment}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
                >
                  {savingDepartment ? 'Saving...' : editingDepartment ? 'Save Changes' : 'Add Department'}
                </button>
                {editingDepartment && (
                  <button
                    type="button"
                    onClick={openCreateDepartment}
                    className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all"
                  >
                    Cancel
                  </button>
                )}
              </div>
            </form>
          </div>

          <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
            <div className="p-4 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-bold text-slate-900">{departments.length} Department{departments.length === 1 ? '' : 's'}</h3>
            </div>
            {departments.length === 0 ? (
              <p className="p-4 text-xs text-slate-400 text-center">No Departments yet — add one above.</p>
            ) : (
              <div className="overflow-x-auto">
                <table className="min-w-full divide-y divide-slate-200">
                  <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                    <tr>
                      <th className="px-4 py-2.5 text-left">Department</th>
                      <th className="px-4 py-2.5 text-left">Supervisor</th>
                      <th className="px-4 py-2.5 text-left">Approval Workflow</th>
                      <th className="px-4 py-2.5 text-left">Status</th>
                      <th className="px-4 py-2.5 text-right">Actions</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100 text-sm">
                    {departments.map((d) => (
                      <tr key={d.id} className="hover:bg-slate-50/80 transition-colors">
                        <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900 text-xs">{d.name}</td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs text-slate-700">
                          {d.supervisor_name ? (
                            <span className="inline-flex items-center gap-1"><Users2 className="w-3 h-3 text-slate-400" />{d.supervisor_name}</span>
                          ) : (
                            <span className="text-slate-300">—</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs">
                          {d.supervisor_user_id && d.include_supervisor_approval ? (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-emerald-50 text-emerald-700">
                              Supervisor is 1st layer
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded bg-slate-100 text-slate-500">
                              Template only
                            </span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-xs">
                          {d.is_active ? (
                            <span className="text-emerald-700 font-semibold">Active</span>
                          ) : (
                            <span className="text-slate-400 font-semibold">Inactive</span>
                          )}
                        </td>
                        <td className="px-4 py-3 whitespace-nowrap text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            <button
                              onClick={() => openEditDepartment(d)}
                              className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                              title="Edit"
                            >
                              <Edit2 className="w-3.5 h-3.5" />
                            </button>
                            <button
                              onClick={() => handleDeleteDepartment(d.id)}
                              className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors"
                              title="Delete"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        </div>
      )}

      {/* TAB: NOTICES — compose a login popup (text/HTML + optional custom Lottie
          animation) that shows to Users right after they sign in. */}
      {activeTab === 'notices' && (
        <NoticeManager token={token} user={user} />
      )}

      {/* TAB: MOVEMENT CLAIMS — review point A -> point B travel check-in/outs
          Users have recorded for office work (TA/DA-style reimbursement). */}
      {activeTab === 'claims' && (
        <ClaimsPanel token={token} users={users} />
      )}

      {/* TAB: CONVEYANCE BILL CLAIM — Superadmin + explicitly-granted Admins only.
          Build a travel/conveyance claim bill for a User: pull items in from their
          completed Movement Claims (computing Amount at a Rate/KM) or add items by
          hand, then export a printable PDF bill. */}
      {activeTab === 'conveyance' && (
        <ConveyanceBillPanel token={token} users={users} />
      )}

      {/* TAB: MY CONVEYANCE BILL CLAIM — same "conveyance" module grant as the
          tab above, but scoped to THIS Admin's own Bills/Claims and read-only
          (no Approve/Reject/Edit/Delete) — see MyConveyanceBillClaimPanel.tsx
          for why this exists as a separate page. */}
      {activeTab === 'my_conveyance' && (
        <MyConveyanceBillClaimPanel token={token} user={user} />
      )}

      {/* TAB: CONVEYANCE DISBURSEMENT — Superadmin + explicitly-granted Admins
          only. Marks a Conveyance Bill's claim(s) as actually paid out (voucher
          no. + disbursed date/by) and prints a Payment Voucher PDF for it. Kept
          as its own module (separate from 'conveyance' above) so an Admin can be
          allowed to BUILD bills without also being able to authorize payouts. */}
      {activeTab === 'disbursement' && (
        <DisbursementPanel token={token} users={users} />
      )}

      {/* TAB: APPROVALS — the OLD single global chain (Queue) sits alongside the
          NEW per-Employee/per-Request-Type Templates engine (Templates), so
          nothing already in flight on the old chain is disrupted while the
          new Dynamic Approval Engine is rolled out request-type by request-type. */}
      {activeTab === 'approvals' && (
        <div className="space-y-4">
          <div className="flex bg-slate-100 rounded-xl p-1 w-fit">
            <button
              type="button"
              onClick={() => setApprovalsSection('queue')}
              className={`text-xs font-semibold px-4 py-2 rounded-lg transition-colors ${
                approvalsSection === 'queue' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
              }`}
            >
              Queue (Global Chain)
            </button>
            <button
              type="button"
              onClick={() => setApprovalsSection('templates')}
              className={`text-xs font-semibold px-4 py-2 rounded-lg transition-colors ${
                approvalsSection === 'templates' ? 'bg-white text-slate-900 shadow-xs' : 'text-slate-500'
              }`}
            >
              Templates
            </button>
          </div>
          {approvalsSection === 'queue' ? (
            <ApprovalManager token={token} user={user} users={users} />
          ) : (
            <ApprovalTemplateManager token={token} user={user} users={users} />
          )}
        </div>
      )}

      {/* Budget full imported-data modal */}
      {viewingBudget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-6xl max-h-[85vh] flex flex-col">
            <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-200">
              <div>
                <h3 className="text-lg font-bold text-slate-900">{viewingBudget.budget_name}</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {viewingBudgetItems.length} imported row{viewingBudgetItems.length === 1 ? '' : 's'}
                  {viewingBudget.original_filename && <> — from <span className="font-medium">{viewingBudget.original_filename}</span></>}
                </p>
              </div>
              <div className="flex items-center gap-2">
                {viewingBudgetItems.length > 0 && (
                  <button
                    onClick={() => handleDownloadBudgetItemsExcel(viewingBudget, viewingBudgetItems)}
                    className="flex items-center gap-1.5 py-2 px-3 bg-emerald-600 hover:bg-emerald-700 text-white font-semibold rounded-xl text-xs transition-all shadow-sm whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" /> Download Imported Sheet (All Columns)
                  </button>
                )}
                {viewingBudget.has_file && (
                  <button
                    onClick={() => handleDownloadBudgetFile(viewingBudget.id, viewingBudget.budget_name)}
                    className="flex items-center gap-1.5 py-2 px-3 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl text-xs transition-all shadow-sm whitespace-nowrap"
                  >
                    <Download className="w-3.5 h-3.5" /> Download Original Excel
                  </button>
                )}
                <button
                  onClick={() => {
                    // Jump to the Reports tab pre-filtered to this Budget, where
                    // "Download Excel" exports every entry-MPR row with full columns.
                    setFilterBudgetId(String(viewingBudget.id));
                    setActiveTab('reports');
                    setViewingBudget(null);
                    setViewingBudgetItems([]);
                  }}
                  className="flex items-center gap-1.5 py-2 px-3 bg-white hover:bg-slate-50 border border-slate-200 text-slate-700 font-semibold rounded-xl text-xs transition-all shadow-sm whitespace-nowrap"
                >
                  <FileSpreadsheet className="w-3.5 h-3.5" /> View Entries Report
                </button>
                <button
                  onClick={() => { setViewingBudget(null); setViewingBudgetItems([]); }}
                  className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                  title="Close"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            <div className="overflow-auto flex-1">
              {loadingBudgetItems ? (
                <p className="text-sm text-slate-400 p-6">Loading...</p>
              ) : viewingBudgetItems.length === 0 ? (
                <p className="text-sm text-slate-400 p-6">No rows imported into this budget yet.</p>
              ) : (
                <table className="min-w-full divide-y divide-slate-200 text-xs">
                  <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider sticky top-0">
                    <tr>
                      <th className="px-3 py-2 text-left">Sl.No.</th>
                      <th className="px-3 py-2 text-left">Project Name</th>
                      <th className="px-3 py-2 text-left">Req. No.</th>
                      <th className="px-3 py-2 text-left">MRF No</th>
                      <th className="px-3 py-2 text-left">Date</th>
                      <th className="px-3 py-2 text-left">Description of Materials</th>
                      <th className="px-3 py-2 text-left">Unit</th>
                      <th className="px-3 py-2 text-left">Specification</th>
                      <th className="px-3 py-2 text-left">Req. Qty</th>
                      <th className="px-3 py-2 text-left">Purchase Order Qty</th>
                      <th className="px-3 py-2 text-left">Received Qty</th>
                      <th className="px-3 py-2 text-left">Balance Qty</th>
                      <th className="px-3 py-2 text-left">Entry User</th>
                      <th className="px-3 py-2 text-left">Approved Date</th>
                      <th className="px-3 py-2 text-left">App. User</th>
                      <th className="px-3 py-2 text-left">Site Sup. Date</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {viewingBudgetItems.map((it) => (
                      <tr key={it.id} className="hover:bg-slate-50/80">
                        <td className="px-3 py-2 whitespace-nowrap">{it.sl_no}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.project_name}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.req_no}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.mrf_no}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatDate(it.item_date)}</td>
                        <td className="px-3 py-2 min-w-[180px]">{it.description}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.unit}</td>
                        <td className="px-3 py-2 min-w-[150px]">{it.specification}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.req_qty}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.po_qty}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.received_qty}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.balance_qty}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.entry_user}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatDate(it.approved_date)}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{it.app_user}</td>
                        <td className="px-3 py-2 whitespace-nowrap">{formatDate(it.site_sup_date)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Rate File "View" modal — Rate list / Materials Category tree, each with a
          client-side search filter since Materials Category alone can run into the
          thousands of rows. */}
      {showRateFileModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-6xl max-h-[85vh] flex flex-col">
            <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-200">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Rate File</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {rateFileSummary?.original_filename && (
                    <>from <span className="font-medium">{rateFileSummary.original_filename}</span></>
                  )}
                </p>
              </div>
              <button
                onClick={closeRateFileModal}
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {/* Sub-tabs + search */}
            <div className="flex items-center justify-between gap-3 flex-wrap px-5 py-3 border-b border-slate-100 bg-slate-50">
              <div className="flex items-center gap-1.5 bg-white border border-slate-200 rounded-xl p-1">
                <button
                  type="button"
                  onClick={() => setRateFileModalTab('rate')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    rateFileModalTab === 'rate' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Rate ({rateListData.length})
                </button>
                <button
                  type="button"
                  onClick={() => setRateFileModalTab('category')}
                  className={`px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors ${
                    rateFileModalTab === 'category' ? 'bg-blue-600 text-white' : 'text-slate-600 hover:text-slate-900'
                  }`}
                >
                  Materials Category ({categoryListData.length})
                </button>
              </div>
              <div className="relative flex-1 min-w-[200px] max-w-xs">
                <Search className="w-3.5 h-3.5 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  type="text"
                  value={rateFileSearch}
                  onChange={(e) => setRateFileSearch(e.target.value)}
                  placeholder="Search this table..."
                  className="w-full pl-8 pr-3 py-1.5 bg-white border border-slate-200 rounded-lg text-xs focus:outline-none focus:ring-2 focus:ring-blue-600"
                />
              </div>
            </div>

            <div className="overflow-auto flex-1">
              {loadingRateFileData ? (
                <p className="text-sm text-slate-400 p-6">Loading...</p>
              ) : rateFileModalTab === 'rate' ? (
                (() => {
                  const q = rateFileSearch.trim().toLowerCase();
                  const filtered = q
                    ? rateListData.filter((r) =>
                        [r.materials_name, r.unit, r.specification, r.assigned_person, r.remarks]
                          .some((v) => v != null && String(v).toLowerCase().includes(q))
                      )
                    : rateListData;
                  return filtered.length === 0 ? (
                    <p className="text-sm text-slate-400 p-6">No Rate rows found.</p>
                  ) : (
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider sticky top-0">
                        <tr>
                          <th className="px-3 py-2 text-left">Materials Name</th>
                          <th className="px-3 py-2 text-left">Unit</th>
                          <th className="px-3 py-2 text-left">Rate</th>
                          <th className="px-3 py-2 text-left">Specification</th>
                          <th className="px-3 py-2 text-left">Assigned Person</th>
                          <th className="px-3 py-2 text-left">Remarks</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filtered.map((r) => (
                          <tr key={r.id} className="hover:bg-slate-50/80">
                            <td className="px-3 py-2 min-w-[180px]">{r.materials_name}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.unit}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.rate}</td>
                            <td className="px-3 py-2 min-w-[150px]">{r.specification}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.assigned_person}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.remarks}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  );
                })()
              ) : (
                (() => {
                  const q = rateFileSearch.trim().toLowerCase();
                  const filtered = q
                    ? categoryListData.filter((r) =>
                        [r.head, r.sub1, r.sub2, r.sub3, r.details, r.sector]
                          .some((v) => v != null && String(v).toLowerCase().includes(q))
                      )
                    : categoryListData;
                  return filtered.length === 0 ? (
                    <p className="text-sm text-slate-400 p-6">No Materials Category rows found.</p>
                  ) : (
                    <table className="min-w-full divide-y divide-slate-200 text-xs">
                      <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider sticky top-0">
                        <tr>
                          <th className="px-3 py-2 text-left">Sl No.</th>
                          <th className="px-3 py-2 text-left">Head</th>
                          <th className="px-3 py-2 text-left">Sub-1</th>
                          <th className="px-3 py-2 text-left">Sub-2</th>
                          <th className="px-3 py-2 text-left">Sub-3</th>
                          <th className="px-3 py-2 text-left">Detials</th>
                          <th className="px-3 py-2 text-left">Sector</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {filtered.map((r) => (
                          <tr key={r.id} className="hover:bg-slate-50/80">
                            <td className="px-3 py-2 whitespace-nowrap">{r.sl_no}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.head}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.sub1}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.sub2}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.sub3}</td>
                            <td className="px-3 py-2 min-w-[180px]">{r.details}</td>
                            <td className="px-3 py-2 whitespace-nowrap">{r.sector}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  );
                })()
              )}
            </div>
          </div>
        </div>
      )}

      {/* "Approve & Calculate" result — Missing Rate / Missing Category review lists.
          The Admin resolves these by updating the Rate File (both sheets) and
          re-importing via "Import Rate File", then running Approve & Calculate again —
          no separate edit UI needed since that already fully replaces both tables. */}
      {approveResult && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setApproveResult(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl max-w-2xl w-full max-h-[85vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-start justify-between gap-4 p-5 border-b border-slate-200">
              <div>
                <h3 className="text-lg font-bold text-slate-900">Approve &amp; Calculate — {approveResult.budgetName}</h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  {approveResult.matched_rate_count} of {approveResult.total_entries} entr
                  {approveResult.total_entries === 1 ? 'y' : 'ies'} matched a Rate.
                </p>
              </div>
              <button
                onClick={() => setApproveResult(null)}
                className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="overflow-auto flex-1 p-5 space-y-6">
              {approveResult.missing_rate.length === 0 && approveResult.missing_category.length === 0 ? (
                <div className="flex items-center gap-2 text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-xl px-4 py-3 text-sm font-medium">
                  Every entry matched both a Rate and a Category. Nothing to review.
                </div>
              ) : (
                <>
                  {approveResult.missing_rate.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <h4 className="text-sm font-bold text-rose-700">
                          Missing Rate ({approveResult.missing_rate.length})
                        </h4>
                        <button
                          type="button"
                          onClick={() => downloadMissingListExcel('rate', approveResult)}
                          className="flex items-center gap-1 py-1 px-2.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 font-semibold rounded-lg text-[11px] transition-colors whitespace-nowrap"
                        >
                          <Download className="w-3 h-3" /> Download Excel
                        </button>
                      </div>
                      <p className="text-xs text-slate-500 mb-2">
                        No exact Item Name + Specification match in the Rate sheet. Add these to the Rate File and
                        re-import, then run Approve &amp; Calculate again.
                      </p>
                      <div className="border border-slate-200 rounded-xl overflow-hidden">
                        <table className="min-w-full divide-y divide-slate-200 text-xs">
                          <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider">
                            <tr>
                              <th className="px-3 py-2 text-left">Item Name</th>
                              <th className="px-3 py-2 text-left">Specification</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {approveResult.missing_rate.map((r, i) => (
                              <tr key={i}>
                                <td className="px-3 py-2">{r.item_name}</td>
                                <td className="px-3 py-2 text-slate-500">{r.specification || <span className="text-slate-300">(blank)</span>}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}

                  {approveResult.missing_category.length > 0 && (
                    <div>
                      <div className="flex items-center justify-between gap-2 mb-1">
                        <h4 className="text-sm font-bold text-amber-700">
                          Missing Category ({approveResult.missing_category.length})
                        </h4>
                        <button
                          type="button"
                          onClick={() => downloadMissingListExcel('category', approveResult)}
                          className="flex items-center gap-1 py-1 px-2.5 bg-white hover:bg-slate-50 border border-slate-200 text-slate-600 font-semibold rounded-lg text-[11px] transition-colors whitespace-nowrap"
                        >
                          <Download className="w-3 h-3" /> Download Excel
                        </button>
                      </div>
                      <p className="text-xs text-slate-500 mb-2">
                        No matching Item Name in the Materials Category sheet. Add these (with their Head / Sub-1 /
                        Sub-2 / Sub-3 / Sector) to the Rate File and re-import, then run Approve &amp; Calculate again.
                      </p>
                      <div className="border border-slate-200 rounded-xl overflow-hidden">
                        <table className="min-w-full divide-y divide-slate-200 text-xs">
                          <thead className="bg-slate-50 text-slate-500 uppercase tracking-wider">
                            <tr>
                              <th className="px-3 py-2 text-left">Item Name</th>
                            </tr>
                          </thead>
                          <tbody className="divide-y divide-slate-100">
                            {approveResult.missing_category.map((name, i) => (
                              <tr key={i}>
                                <td className="px-3 py-2">{name}</td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      </div>
                    </div>
                  )}
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {/* Manage Projects modal — Admin sets which Projects a User can access */}
      {managingUser && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setManagingUser(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl max-w-md w-full max-h-[85vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-slate-200 flex justify-between items-center">
              <div>
                <h3 className="text-base font-bold text-slate-900">Project Access</h3>
                <p className="text-xs text-slate-500">{managingUser.name} • {managingUser.email}</p>
              </div>
              <button
                onClick={() => setManagingUser(null)}
                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {projects.length > 0 && (
              <div className="px-5 pt-4">
                <div className="relative">
                  <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none text-slate-400">
                    <Search className="w-4 h-4" />
                  </div>
                  <input
                    type="text"
                    value={managePermSearch}
                    onChange={(e) => setManagePermSearch(e.target.value)}
                    placeholder="Search Project Name..."
                    autoComplete="off"
                    className="block w-full pl-10 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                  />
                </div>
              </div>
            )}

            <div className="p-5 overflow-y-auto flex-1 space-y-2">
              {projects.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-6">No projects exist yet. Add one from the Projects tab first.</p>
              ) : filteredManageProjects.length === 0 ? (
                <p className="text-sm text-slate-400 text-center py-6">No Project matches "{managePermSearch}".</p>
              ) : (
                filteredManageProjects.map((p) => (
                  <label
                    key={p.id}
                    className="flex items-center gap-3 p-3 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors"
                  >
                    <input
                      type="checkbox"
                      checked={selectedProjectIds.has(p.id)}
                      onChange={() => toggleSelectedProject(p.id)}
                      className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                    />
                    <span className="text-sm font-medium text-slate-900">{p.project_name}</span>
                  </label>
                ))
              )}
            </div>

            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setManagingUser(null)}
                className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleSavePermissions}
                disabled={savingPermissions}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
              >
                {savingPermissions ? 'Saving...' : 'Save Access'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Module Access modal — Superadmin sets which Admin Panel tabs a given Admin
          may open (projects, mprs, imports, reports, users, recycle, editlog). */}
      {managingModulesFor && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => setManagingModulesFor(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl max-w-md md:max-w-5xl xl:max-w-6xl w-full max-h-[92vh] flex flex-col shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 md:p-6 border-b border-slate-200">
              <div className="flex justify-between items-center mb-3">
                <div>
                  <h3 className="text-base md:text-lg font-bold text-slate-900">Module Access</h3>
                  <p className="text-xs md:text-sm text-slate-500">{managingModulesFor.name} • {managingModulesFor.email}</p>
                </div>
                <button
                  onClick={() => setManagingModulesFor(null)}
                  className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
              {/* Search (filters the Admin Module checklist below) + Copy
                  Access (pre-fills every field on this form — toggles, Admin
                  Module checkboxes, permission layers, Department scopes —
                  from another account's saved access, so a Superadmin can
                  set up one account and reuse it for the next instead of
                  re-ticking everything by hand; nothing is saved until "Save
                  Access" is clicked) both live in the header now — no room
                  for them once the two columns below start, and they apply
                  to the whole form, not just one column. */}
              <div className="flex flex-col sm:flex-row gap-2 sm:gap-3">
                <div className="relative flex-1">
                  <Search className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={moduleSearchQuery}
                    onChange={(e) => setModuleSearchQuery(e.target.value)}
                    placeholder="Search modules…"
                    className="w-full pl-10 pr-3 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600"
                  />
                </div>
                <div className="relative flex-1 sm:max-w-[220px]">
                  <Copy className="w-4 h-4 text-slate-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
                  <select
                    value=""
                    onChange={(e) => {
                      if (e.target.value) copyAccessFrom(Number(e.target.value));
                    }}
                    className="w-full pl-10 pr-3 py-2.5 text-sm bg-slate-50 border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-600 focus:border-blue-600 cursor-pointer appearance-none"
                  >
                    <option value="">Copy access from…</option>
                    {users
                      .filter((u) => u.id !== managingModulesFor.id && u.role !== 'superadmin')
                      .map((u) => (
                        <option key={u.id} value={u.id}>{u.name} ({u.role === 'admin' ? 'Admin' : 'User'})</option>
                      ))}
                  </select>
                </div>
              </div>
              {copyAccessNotice && (
                <p className="mt-2 text-xs text-emerald-700 bg-emerald-50 border border-emerald-200 rounded-lg px-3 py-2">
                  {copyAccessNotice}
                </p>
              )}
            </div>

            {/* Two columns on desktop (User Module toggles on the left, Admin
                Module tab checkboxes on the right) instead of one long
                cramped-looking vertical list stretched across a narrow
                fixed-width card — the modal itself is much wider on md+/xl+
                too (see max-w-md md:max-w-5xl xl:max-w-6xl above), with more
                generous padding/gaps than a mobile-first default so the web
                view has real breathing room instead of reading like a phone
                layout just stretched wide. Mobile keeps the original single
                stacked column, unchanged. */}
            <div className="p-5 md:p-8 overflow-y-auto flex-1 md:grid md:grid-cols-2 md:gap-x-10 xl:gap-x-16 md:items-start">
            <div className="space-y-3">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">User Module</p>
              {managingModulesFor.role === 'admin' && (
                <label
                  className="flex items-center justify-between gap-3 p-3.5 mb-3 bg-blue-50 border border-blue-200 rounded-xl cursor-pointer"
                >
                  <span>
                    <span className="text-sm font-semibold text-slate-900 block">Also allow User Panel access</span>
                    <span className="text-[11px] text-slate-500">
                      Lets this Admin use the User Panel too — mark Remote Attendance, submit Claims/Conveyance Bills,
                      and enter Job/MPR data — on top of their Admin Panel.
                    </span>
                  </span>
                  <button
                    type="button"
                    onClick={() => setUserPanelAccessEnabled((v) => !v)}
                    className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                      userPanelAccessEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                    }`}
                    title={userPanelAccessEnabled ? 'On — click to turn off' : 'Off — click to turn on'}
                  >
                    <span
                      className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                        userPanelAccessEnabled ? 'translate-x-[18px]' : 'translate-x-1'
                      }`}
                    />
                  </button>
                </label>
              )}
              <label
                className="flex items-center justify-between gap-3 p-3.5 mb-3 bg-indigo-50 border border-indigo-200 rounded-xl cursor-pointer"
              >
                <span>
                  <span className="text-sm font-semibold text-slate-900 block">Allow Budget / Jobs / Job Entry Details</span>
                  <span className="text-[11px] text-slate-500">
                    Lets this {managingModulesFor.role === 'user' ? 'User' : 'Admin'} see and use "Select a Budget", "Jobs" and
                    "Job Entry Details" on their own User Panel. On by default for everyone — turn this off to hide all three
                    (mobile tiles, bottom nav tabs, and the desktop "Jobs" menu) for just this account.
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setBudgetModuleAccessEnabled((v) => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    budgetModuleAccessEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                  title={budgetModuleAccessEnabled ? 'On — click to turn off' : 'Off — click to turn on'}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      budgetModuleAccessEnabled ? 'translate-x-[18px]' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <label
                className="flex items-center justify-between gap-3 p-3.5 mb-3 bg-sky-50 border border-sky-200 rounded-xl cursor-pointer"
              >
                <span>
                  <span className="text-sm font-semibold text-slate-900 block">Also allow Movement Claim</span>
                  <span className="text-[11px] text-slate-500">
                    Lets this {managingModulesFor.role === 'user' ? 'User' : 'Admin'} see and use the Movement Claim (GPS
                    Check In/Out) section on their own User Panel. Off by default, like every other module here.
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setMovementClaimAccessEnabled((v) => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    movementClaimAccessEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                  title={movementClaimAccessEnabled ? 'On — click to turn off' : 'Off — click to turn on'}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      movementClaimAccessEnabled ? 'translate-x-[18px]' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <label
                className="flex items-center justify-between gap-3 p-3.5 mb-3 bg-sky-50 border border-sky-200 rounded-xl cursor-pointer"
              >
                <span>
                  <span className="text-sm font-semibold text-slate-900 block">Also allow Conveyance Bill Claim</span>
                  <span className="text-[11px] text-slate-500">
                    Lets this {managingModulesFor.role === 'user' ? 'User' : 'Admin'} see and use the Conveyance Bill Claim
                    section on their own User Panel. Off by default, like every other module here.
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setConveyanceClaimAccessEnabled((v) => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    conveyanceClaimAccessEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                  title={conveyanceClaimAccessEnabled ? 'On — click to turn off' : 'Off — click to turn on'}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      conveyanceClaimAccessEnabled ? 'translate-x-[18px]' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <label
                className="flex items-center justify-between gap-3 p-3.5 mb-3 bg-sky-50 border border-sky-200 rounded-xl cursor-pointer"
              >
                <span>
                  <span className="text-sm font-semibold text-slate-900 block">Also allow Timesheet</span>
                  <span className="text-[11px] text-slate-500">
                    Lets this {managingModulesFor.role === 'user' ? 'User' : 'Admin'} see and use Self Service → Timesheet
                    (own Attendance history, Correct Attendance). Off by default, like every other module here.
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setTimesheetAccessEnabled((v) => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    timesheetAccessEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                  title={timesheetAccessEnabled ? 'On — click to turn off' : 'Off — click to turn on'}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      timesheetAccessEnabled ? 'translate-x-[18px]' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <label
                className="flex items-center justify-between gap-3 p-3.5 mb-3 bg-sky-50 border border-sky-200 rounded-xl cursor-pointer"
              >
                <span>
                  <span className="text-sm font-semibold text-slate-900 block">Also allow Leave Application</span>
                  <span className="text-[11px] text-slate-500">
                    Lets this {managingModulesFor.role === 'user' ? 'User' : 'Admin'} see and use Self Service → Leave
                    Application (submit a new Leave request). Off by default, like every other module here.
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setLeaveApplicationAccessEnabled((v) => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    leaveApplicationAccessEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                  title={leaveApplicationAccessEnabled ? 'On — click to turn off' : 'Off — click to turn on'}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      leaveApplicationAccessEnabled ? 'translate-x-[18px]' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              <label
                className="flex items-center justify-between gap-3 p-3.5 mb-3 bg-sky-50 border border-sky-200 rounded-xl cursor-pointer"
              >
                <span>
                  <span className="text-sm font-semibold text-slate-900 block">Also allow My Leave</span>
                  <span className="text-[11px] text-slate-500">
                    Lets this {managingModulesFor.role === 'user' ? 'User' : 'Admin'} see Self Service → My Leave (own
                    Casual/Sick/Leave-without-Pay balance, read-only). Off by default, like every other module here.
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setMyLeaveAccessEnabled((v) => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    myLeaveAccessEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                  title={myLeaveAccessEnabled ? 'On — click to turn off' : 'Off — click to turn on'}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      myLeaveAccessEnabled ? 'translate-x-[18px]' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
            </div>

            <div className="space-y-3 mt-6 md:mt-0 pt-6 md:pt-0 border-t md:border-t-0 md:border-l border-slate-100 md:pl-10 xl:pl-16">
              <p className="text-[11px] font-bold uppercase tracking-wider text-slate-500 mb-1">Admin Module</p>
              <p className="text-xs md:text-sm text-slate-500 mb-2">
                Choose which Admin Panel tabs this {managingModulesFor.role === 'user' ? 'User' : 'Admin'} can open.
                {managingModulesFor.role === 'user' && ' They\'ll keep their normal User Panel too, with a switcher to open these tabs.'}
                {' '}Unchecked tabs are hidden for them, and the matching API routes are blocked server-side too.
              </p>
              {/* "Also allow editing Leave balances" — this is an Admin Panel
                  module toggle (Leave Manage), not a User-Panel-facing grant
                  like the switches on the left, even though it isn't part of
                  the ADMIN_MODULES/module_permissions checklist below (it's
                  gated by the separate can_manage_leave flag) — so it lives
                  here in the Admin Module column instead. */}
              <label
                className="flex items-center justify-between gap-3 p-3.5 mb-3 bg-emerald-50 border border-emerald-200 rounded-xl cursor-pointer"
              >
                <span>
                  <span className="text-sm font-semibold text-slate-900 block">Also allow editing Leave balances</span>
                  <span className="text-[11px] text-slate-500">
                    Lets this {managingModulesFor.role === 'user' ? 'User' : 'Admin'} edit everyone's Casual/Sick/Leave-without-Pay
                    balance on Self Service → Leave Management, the same as the Superadmin can.
                  </span>
                </span>
                <button
                  type="button"
                  onClick={() => setLeaveManagementAccessEnabled((v) => !v)}
                  className={`relative inline-flex h-5 w-9 items-center rounded-full transition-colors shrink-0 ${
                    leaveManagementAccessEnabled ? 'bg-emerald-500' : 'bg-slate-300'
                  }`}
                  title={leaveManagementAccessEnabled ? 'On — click to turn off' : 'Off — click to turn on'}
                >
                  <span
                    className={`inline-block h-3.5 w-3.5 transform rounded-full bg-white transition-transform ${
                      leaveManagementAccessEnabled ? 'translate-x-[18px]' : 'translate-x-1'
                    }`}
                  />
                </button>
              </label>
              {leaveManagementAccessEnabled && (
                <div className="mb-3 p-3 bg-violet-50 border border-violet-200 rounded-xl">
                  <p className="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5 mb-1">
                    <ShieldCheck className="w-3.5 h-3.5 text-violet-600" />
                    Permission Layers for Leave Manage
                  </p>
                  <p className="text-[11px] text-slate-500 mb-2">
                    Choose exactly what {managingModulesFor.role === 'user' ? 'this User' : 'this Admin'} may do inside
                    Leave Manage — any combination. Leaving all of these unchecked (while the toggle above stays on)
                    blocks every action here.
                  </p>
                  <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
                    {LEAVE_MANAGE_LAYERS.map((layer) => (
                      <label
                        key={layer.key}
                        className="flex items-center gap-2 px-2.5 py-1.5 bg-white border border-violet-100 rounded-lg cursor-pointer hover:bg-violet-100/40"
                      >
                        <input
                          type="checkbox"
                          checked={leaveManageLayers.has(layer.key)}
                          onChange={() => toggleLeaveManageLayer(layer.key)}
                          className="w-3.5 h-3.5 rounded border-slate-300 text-violet-600 focus:ring-violet-600 cursor-pointer"
                        />
                        <span className="text-xs text-slate-800">{layer.label}</span>
                      </label>
                    ))}
                  </div>
                </div>
              )}
              {MODULE_ACCESS_GROUPS.map((group) => {
                const moduleQuery = moduleSearchQuery.trim().toLowerCase();
                const groupModules = ADMIN_MODULES.filter((m) => group.keys.includes(m.key) && m.label.toLowerCase().includes(moduleQuery));
                if (groupModules.length === 0) return null;
                return (
                  <div key={group.label} className="mb-4">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-2">{group.label}</p>
                    <div className="space-y-2">
                      {groupModules.map((m) => (
                        <React.Fragment key={m.key}>
                          <label
                            className="flex items-center gap-3 p-3.5 bg-slate-50 border border-slate-200 rounded-xl cursor-pointer hover:bg-slate-100 transition-colors"
                          >
                            <input
                              type="checkbox"
                              checked={selectedModules.has(m.key)}
                              onChange={() => toggleSelectedModule(m.key)}
                              className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-600 cursor-pointer"
                            />
                            <span className="text-sm font-medium text-slate-900">{m.label}</span>
                          </label>
                          {(PERMISSION_LAYER_MODULES as readonly AdminModuleKey[]).includes(m.key) && selectedModules.has(m.key) && (
                            <div className="ml-2 mt-1 mb-1 p-3 bg-violet-50 border border-violet-200 rounded-xl">
                              <p className="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5 mb-1">
                                <ShieldCheck className="w-3.5 h-3.5 text-violet-600" />
                                Permission Layers for {m.label}
                              </p>
                              <p className="text-[11px] text-slate-500 mb-2">
                                Choose exactly what {managingModulesFor?.role === 'user' ? 'this User' : 'this Admin'} may
                                do inside {m.label} — any combination. Leaving all of these unchecked (while the module
                                itself stays checked above) blocks every action here.
                              </p>
                              <div className="grid grid-cols-2 xl:grid-cols-3 gap-2">
                                {PERMISSION_LAYERS.map((layer) => (
                                  <label
                                    key={layer.key}
                                    className="flex items-center gap-2 px-2.5 py-1.5 bg-white border border-violet-100 rounded-lg cursor-pointer hover:bg-violet-100/40"
                                  >
                                    <input
                                      type="checkbox"
                                      checked={(moduleLayers[m.key] || new Set()).has(layer.key)}
                                      onChange={() => toggleModuleLayer(m.key, layer.key)}
                                      className="w-3.5 h-3.5 rounded border-slate-300 text-violet-600 focus:ring-violet-600 cursor-pointer"
                                    />
                                    <span className="text-xs text-slate-800">{layer.label}</span>
                                  </label>
                                ))}
                              </div>
                            </div>
                          )}
                          {m.key === 'attendance_reports' && selectedModules.has('attendance_reports') && (
                            <div className="ml-2 mt-1 mb-1 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                              <p className="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5 mb-1">
                                <Building2 className="w-3.5 h-3.5 text-amber-600" />
                                Department Access for this Report
                              </p>
                              <p className="text-[11px] text-slate-500 mb-2">
                                Leave every Department unchecked to keep seeing all of them (default). Tick one or
                                more to restrict {managingModulesFor?.role === 'user' ? 'this User' : 'this Admin'} to
                                only those Department(s) on the Monthly Attendance Report — a Department they
                                supervise is pre-ticked here the first time this is set up, but that can be
                                unticked, and this can be set for any account either way.
                              </p>
                              {loadingAttendanceReportDepts ? (
                                <p className="text-[11px] text-slate-400">Loading…</p>
                              ) : departments.length === 0 ? (
                                <p className="text-[11px] text-slate-400">No Departments set up yet (Admin Panel -&gt; Departments).</p>
                              ) : (
                                <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                                  {departments.map((d) => (
                                    <label
                                      key={d.id}
                                      className="flex items-center gap-2 px-2 py-1.5 bg-white border border-amber-100 rounded-lg cursor-pointer hover:bg-amber-100/40"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={attendanceReportDepts.has(d.name)}
                                        onChange={() => toggleAttendanceReportDept(d.name)}
                                        className="w-3.5 h-3.5 rounded border-slate-300 text-amber-600 focus:ring-amber-600 cursor-pointer"
                                      />
                                      <span className="text-xs text-slate-800">{d.name}</span>
                                      {d.supervisor_user_id === managingModulesFor?.id && (
                                        <span className="text-[10px] text-amber-700 font-semibold">Supervisor</span>
                                      )}
                                    </label>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {m.key === 'leave_applications' && selectedModules.has('leave_applications') && (
                            <div className="ml-2 mt-1 mb-1 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                              <p className="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5 mb-1">
                                <Building2 className="w-3.5 h-3.5 text-amber-600" />
                                Department Access for this Report
                              </p>
                              <p className="text-[11px] text-slate-500 mb-2">
                                Leave every Department unchecked to keep seeing all of them (default). Tick one or
                                more to restrict {managingModulesFor?.role === 'user' ? 'this User' : 'this Admin'} to
                                only those Department(s) on the Monthly Leave Application report — a Department they
                                supervise is pre-ticked here the first time this is set up, but that can be
                                unticked, and this can be set for any account either way.
                              </p>
                              {loadingLeaveApplicationDepts ? (
                                <p className="text-[11px] text-slate-400">Loading…</p>
                              ) : departments.length === 0 ? (
                                <p className="text-[11px] text-slate-400">No Departments set up yet (Admin Panel -&gt; Departments).</p>
                              ) : (
                                <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                                  {departments.map((d) => (
                                    <label
                                      key={d.id}
                                      className="flex items-center gap-2 px-2 py-1.5 bg-white border border-amber-100 rounded-lg cursor-pointer hover:bg-amber-100/40"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={leaveApplicationDepts.has(d.name)}
                                        onChange={() => toggleLeaveApplicationDept(d.name)}
                                        className="w-3.5 h-3.5 rounded border-slate-300 text-amber-600 focus:ring-amber-600 cursor-pointer"
                                      />
                                      <span className="text-xs text-slate-800">{d.name}</span>
                                      {d.supervisor_user_id === managingModulesFor?.id && (
                                        <span className="text-[10px] text-amber-700 font-semibold">Supervisor</span>
                                      )}
                                    </label>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                          {m.key === 'conveyance' && selectedModules.has('conveyance') && (
                            <div className="ml-2 mt-1 mb-1 p-3 bg-amber-50 border border-amber-200 rounded-xl">
                              <p className="text-[11px] font-semibold text-slate-700 flex items-center gap-1.5 mb-1">
                                <Building2 className="w-3.5 h-3.5 text-amber-600" />
                                Department Access for this Report
                              </p>
                              <p className="text-[11px] text-slate-500 mb-2">
                                Leave every Department unchecked to keep seeing all of them (default). Tick one or
                                more to restrict {managingModulesFor?.role === 'user' ? 'this User' : 'this Admin'} to
                                only those Department(s) on the Conveyance Bill Claim tab — a Department they
                                supervise is pre-ticked here the first time this is set up, but that can be
                                unticked, and this can be set for any account either way.
                              </p>
                              {loadingConveyanceClaimDepts ? (
                                <p className="text-[11px] text-slate-400">Loading…</p>
                              ) : departments.length === 0 ? (
                                <p className="text-[11px] text-slate-400">No Departments set up yet (Admin Panel -&gt; Departments).</p>
                              ) : (
                                <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                                  {departments.map((d) => (
                                    <label
                                      key={d.id}
                                      className="flex items-center gap-2 px-2 py-1.5 bg-white border border-amber-100 rounded-lg cursor-pointer hover:bg-amber-100/40"
                                    >
                                      <input
                                        type="checkbox"
                                        checked={conveyanceClaimDepts.has(d.name)}
                                        onChange={() => toggleConveyanceClaimDept(d.name)}
                                        className="w-3.5 h-3.5 rounded border-slate-300 text-amber-600 focus:ring-amber-600 cursor-pointer"
                                      />
                                      <span className="text-xs text-slate-800">{d.name}</span>
                                      {d.supervisor_user_id === managingModulesFor?.id && (
                                        <span className="text-[10px] text-amber-700 font-semibold">Supervisor</span>
                                      )}
                                    </label>
                                  ))}
                                </div>
                              )}
                            </div>
                          )}
                        </React.Fragment>
                      ))}
                    </div>
                  </div>
                );
              })}
            </div>
            </div>

            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setManagingModulesFor(null)}
                className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all"
              >
                Cancel
              </button>
              <button
                onClick={handleSaveModulePermissions}
                disabled={savingModules}
                className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
              >
                {savingModules ? 'Saving...' : 'Save Access'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Reset Password modal — Admin/Superadmin sets a brand new password for a
          user who's forgotten theirs. No old password is asked for; that's the
          entire point of this flow existing (see PUT /api/users/:id/reset-password). */}
      {resettingPasswordFor && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !resettingPassword && setResettingPasswordFor(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl max-w-sm w-full shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-slate-200 flex justify-between items-center">
              <div>
                <h3 className="text-base font-bold text-slate-900">Reset Password</h3>
                <p className="text-xs text-slate-500">{resettingPasswordFor.name} • {resettingPasswordFor.email}</p>
              </div>
              <button
                onClick={() => setResettingPasswordFor(null)}
                disabled={resettingPassword}
                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <label className="block text-xs font-semibold text-slate-600">New password</label>
              <div className="flex gap-2">
                <input
                  type="text"
                  value={newPasswordInput}
                  onChange={(e) => setNewPasswordInput(e.target.value)}
                  placeholder="At least 6 characters"
                  className="flex-1 px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                  autoFocus
                />
                <button
                  type="button"
                  onClick={generateRandomPassword}
                  className="px-3 py-2 text-xs font-semibold rounded-lg bg-slate-100 hover:bg-slate-200 text-slate-700 transition-colors whitespace-nowrap"
                >
                  Generate
                </button>
              </div>
              <p className="text-xs text-slate-500">
                This immediately replaces {resettingPasswordFor.name}'s current password. Make sure to share it with
                them directly — it won't be shown again after this.
              </p>
            </div>
            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setResettingPasswordFor(null)}
                disabled={resettingPassword}
                className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleResetPassword}
                disabled={resettingPassword || newPasswordInput.length < 6}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50"
              >
                {resettingPassword ? 'Resetting…' : 'Reset Password'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Change Login ID modal — Admin/Superadmin changes the email address a user
          logs in with. No old value confirmation asked for, same as Reset
          Password (see PUT /api/users/:id/email). */}
      {changingEmailFor && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4"
          onClick={() => !changingEmail && setChangingEmailFor(null)}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl max-w-sm w-full shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="p-5 border-b border-slate-200 flex justify-between items-center">
              <div>
                <h3 className="text-base font-bold text-slate-900">Change Login ID</h3>
                <p className="text-xs text-slate-500">{changingEmailFor.name} • {changingEmailFor.email}</p>
              </div>
              <button
                onClick={() => setChangingEmailFor(null)}
                disabled={changingEmail}
                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors disabled:opacity-50"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-5 space-y-3">
              <label className="block text-xs font-semibold text-slate-600">New Login ID (email)</label>
              <input
                type="email"
                value={newEmailInput || ''}
                onChange={(e) => setNewEmailInput(e.target.value)}
                placeholder="name@example.com"
                className="w-full px-3 py-2 border border-slate-300 rounded-lg text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
                autoFocus
              />
              <p className="text-xs text-slate-500">
                {changingEmailFor.name} will need to use this new email to log in going forward.
              </p>
            </div>
            <div className="p-5 border-t border-slate-200 flex justify-end gap-2">
              <button
                onClick={() => setChangingEmailFor(null)}
                disabled={changingEmail}
                className="px-4 py-2 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-lg transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={handleChangeEmail}
                disabled={changingEmail || !(newEmailInput || '').trim()}
                className="px-4 py-2 text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 rounded-lg transition-colors disabled:opacity-50"
              >
                {changingEmail ? 'Saving…' : 'Save New Login ID'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Delivery Date range modal — Admin sets the allowed Delivery Date window for
          a Budget; Users then can't pick a Delivery Date outside it. */}
      {rangeBudget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50">
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-md">
            <div className="p-5 border-b border-slate-200">
              <h3 className="text-lg font-bold text-slate-900">Set Delivery Date Range</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                Budget <span className="font-semibold">"{rangeBudget.budget_name}"</span> — Users won't be able to pick a
                Delivery Date outside this range when creating or editing an MPR entry under this Budget. Leave both blank to remove the restriction.
              </p>
            </div>
            <div className="p-5 space-y-4">
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
                  Delivery Date From
                </label>
                <input
                  type="date"
                  value={rangeFrom}
                  onChange={(e) => setRangeFrom(e.target.value)}
                  max={rangeTo || undefined}
                  className="block w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">
                  Delivery Date To
                </label>
                <input
                  type="date"
                  value={rangeTo}
                  onChange={(e) => setRangeTo(e.target.value)}
                  min={rangeFrom || undefined}
                  className="block w-full px-3 py-2 bg-white border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                />
              </div>
              {rangeError && <p className="text-xs text-rose-600">{rangeError}</p>}
            </div>
            <div className="p-5 border-t border-slate-200 flex justify-between items-center">
              <button
                type="button"
                onClick={() => { setRangeFrom(''); setRangeTo(''); }}
                className="text-xs font-semibold text-slate-500 hover:text-slate-700"
              >
                Clear Dates
              </button>
              <div className="flex gap-2">
                <button
                  onClick={closeRangeModal}
                  className="px-5 py-2.5 bg-slate-100 hover:bg-slate-200 text-slate-700 text-xs font-semibold rounded-xl transition-all"
                >
                  Cancel
                </button>
                <button
                  onClick={handleSaveDeliveryRange}
                  disabled={savingRange}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-all disabled:opacity-50"
                >
                  {savingRange ? 'Saving...' : 'Save Range'}
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Budget Submissions modal — every user who has Final Submitted this budget,
          with a manual Unlock per user. See openSubmissionsModal/handleUnlockSubmission
          above and GET/DELETE /api/budgets/:id/submissions on the server. */}
      {submissionsBudget && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-slate-900/50" onClick={closeSubmissionsModal}>
          <div className="bg-white rounded-2xl shadow-xl w-full max-w-lg max-h-[80vh] flex flex-col" onClick={(e) => e.stopPropagation()}>
            <div className="p-5 border-b border-slate-200 flex items-start justify-between gap-3">
              <div>
                <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
                  <Unlock className="w-4 h-4 text-amber-600" /> Budget Submissions
                </h3>
                <p className="text-xs text-slate-500 mt-0.5">
                  Budget <span className="font-semibold">"{submissionsBudget.budget_name}"</span> — everyone who has Final
                  Submitted this budget. A submitted user can't add new entries to it; Unlock lifts that for one user, even
                  if they still have entries here. (This lifts on its own the moment a user's last active entry under this
                  Budget is deleted — Unlock is only needed for any other reason to reopen it.)
                </p>
              </div>
              <button
                onClick={closeSubmissionsModal}
                className="p-2 text-slate-400 hover:text-slate-900 hover:bg-slate-100 rounded-xl transition-colors shrink-0"
              >
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="overflow-auto flex-1 p-5">
              {loadingSubmissions ? (
                <p className="text-xs text-slate-400 text-center py-6">Loading...</p>
              ) : budgetSubmissions.length === 0 ? (
                <p className="text-xs text-slate-400 text-center py-6">No one has Final Submitted this budget yet.</p>
              ) : (
                <div className="space-y-2">
                  {budgetSubmissions.map((s) => (
                    <div
                      key={s.user_id}
                      className="flex items-center justify-between gap-3 border border-slate-200 rounded-xl p-3"
                    >
                      <div className="min-w-0">
                        <div className="text-sm font-semibold text-slate-900 truncate">{s.user_name || `User #${s.user_id}`}</div>
                        <div className="text-[11px] text-slate-500 mt-0.5">
                          Submitted {formatDate(s.submitted_at)} •{' '}
                          {s.active_entry_count > 0
                            ? `${s.active_entry_count} active entr${s.active_entry_count === 1 ? 'y' : 'ies'}`
                            : 'No active entries left'}
                        </div>
                      </div>
                      <button
                        onClick={() => handleUnlockSubmission(s.user_id)}
                        disabled={unlockingUserId === s.user_id}
                        className="flex items-center gap-1.5 py-1.5 px-3 bg-amber-50 hover:bg-amber-100 border border-amber-200 text-amber-700 font-semibold rounded-lg transition-all disabled:opacity-50 whitespace-nowrap text-xs shrink-0"
                      >
                        <Unlock className="w-3.5 h-3.5" />
                        {unlockingUserId === s.user_id ? 'Unlocking...' : 'Unlock'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>
        </div>
      )}

      {showLocationPicker && (
        <LocationMapPicker
          title={editingProject ? `Set Location — ${editingProject.project_name}` : 'Set Project Location'}
          initialLat={projectLocation.lat}
          initialLng={projectLocation.lng}
          initialLabel={projectLocation.label}
          initialRadius={projectLocation.radius}
          onCancel={() => setShowLocationPicker(false)}
          onConfirm={(lat, lng, label, radius) => {
            setProjectLocation({ lat, lng, label, radius });
            setShowLocationPicker(false);
          }}
        />
      )}

      {showBranchLocationPicker && (
        <LocationMapPicker
          title={editingBranch ? `Set Location — ${editingBranch.branch_name}` : 'Set Branch Location'}
          initialLat={branchLocation.lat}
          initialLng={branchLocation.lng}
          initialLabel={branchLocation.label}
          initialRadius={branchLocation.radius}
          onCancel={() => setShowBranchLocationPicker(false)}
          onConfirm={(lat, lng, label, radius) => {
            setBranchLocation({ lat, lng, label, radius });
            setShowBranchLocationPicker(false);
          }}
        />
      )}
    </div>
  );
};