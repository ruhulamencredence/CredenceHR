import React, { useState, useEffect } from 'react';
import {
  X, LogOut, Home, Wallet, Briefcase, FileText, Edit2, Route, CreditCard,
  CalendarClock, ListChecks, CheckSquare, ChevronDown, Building2, Users, Users2,
  BarChart3, Upload, History, Recycle, Navigation, Bell, ShieldCheck,
  Contact, Calendar, Clock, Fingerprint, Banknote, Package, LayoutDashboard, Server, MessageSquare,
  ChevronsLeft, ChevronsRight, ShieldAlert, Search,
  Target, UserPlus, Gavel, FolderLock, Sparkles,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { User, AdminModuleKey } from '../types';
import credenceLogo from '../assets/credence-logo.png';
import { useProfilePhoto } from '../lib/useProfilePhoto';
import { ServerSwitcherModal } from './ServerSwitcherModal';

// Temporarily disabled per request — "Set Server" isn't being worked on
// right now, so the button (and the modal it opens) is hidden until it's
// picked back up. Nothing else about the feature was touched/removed.
const SERVER_SWITCHER_ENABLED = false;

interface NavItem {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  onClick: () => void;
}

interface GlobalSidebarProps {
  open: boolean;
  onClose: () => void;
  // 'overlay' (default) — the original mobile drawer: fixed, slides in over
  // a backdrop, closable via the X button / backdrop tap / selecting an item.
  // 'persistent' — desktop web: a permanent left column sitting beside the
  // main content (see App.tsx), always visible, no backdrop/X/close-on-select.
  variant?: 'overlay' | 'persistent';
  user: User;
  // Needed for the profile-header avatar's own /api/profile/photo fetch —
  // see useProfilePhoto.ts.
  token: string;
  // Bumped by App.tsx right after a Personal Data photo upload succeeds, so
  // this drawer's avatar swaps from initials to the new photo immediately.
  photoVersion?: number;
  onLogout: () => void;
  // "Dashboard" — lands back on the User Panel's own dashboard.
  onGoToDashboard: () => void;
  // User Panel's own MPR entry workflow (Entry / Jobs / Entry Details / Job
  // Edits) — every target here lives ONLY in the User Panel, so selecting any
  // of these also switches the account into the User Panel first.
  onGoToJobsTab: (target: 'entry' | 'jobs' | 'entryDetails' | 'jobEdit') => void;
  // The User Panel's OWN Movement Claims / Conveyance Bill Claim section
  // (submitting a claim) — gated separately from the Admin Panel's review
  // tabs below by can_view_movement_claims / can_view_conveyance_claims.
  onGoToUserClaims: (target: 'movementClaims' | 'conveyanceBill') => void;
  // Everyday employee self-service items — not Admin-gated, shown to every
  // account regardless of role/module access.
  onGoToSelfServiceTab: (target: 'leaveApplication' | 'leaveManagement' | 'myLeave' | 'leaveApprovals' | 'timesheet' | 'approveApplications' | 'payroll' | 'employeeDirectory') => void;
  // Admin Panel's own Movement Claims / Conveyance Bill Claim review tabs —
  // separate feature from onGoToUserClaims above, gated by module_permissions
  // like every other Admin Panel module.
  onGoToAdminClaims: (target: 'claims' | 'conveyance') => void;
  // Every other Admin Panel module (Reports, Projects, Users, ...) — gated by
  // module_permissions (a Superadmin always sees all of them).
  // 'my_conveyance' is the one exception below: not its own module_permissions
  // entry, just the "My Conveyance Bill Claim" sub-view shown alongside
  // 'conveyance' in the HR group, gated on the same 'conveyance' grant.
  onGoToAdminModule: (target: Exclude<AdminModuleKey, 'claims' | 'conveyance'> | 'my_conveyance' | 'dashboard' | 'servers' | 'permanent_delete_log') => void;
  // Android APK build info modal — previously a header icon, moved in here so
  // the header itself can stay down to just hamburger + profile + logout.
  onOpenApkInfo: () => void;
  // Tapping the profile header (avatar + name, below) opens ProfilePage.tsx —
  // same destination Navbar's own avatar button opens on desktop.
  onOpenProfile: () => void;
  // "Chat" item (self-service list below) opens ChatPanel.tsx — same
  // destination the Navbar chat bell opens on desktop.
  onOpenChat: () => void;
  // "Alerts" item (self-service list below) opens AlertsPage.tsx — same
  // destination the Navbar AlertsBell dropdown's "View all" link opens.
  onOpenAlerts: () => void;
  // Which item's key currently matches what's actually on screen (see
  // App.tsx's computeSidebarActiveKey) — highlighted so this drawer/column
  // shows a "you are here" mark instead of every item looking the same
  // regardless of which page is open. null/undefined means nothing is
  // highlighted (e.g. ProfilePage is open, which has no sidebar item).
  activeKey?: string | null;
}

// One global navigation drawer for the whole app, reachable from the header's
// single hamburger button regardless of which panel (User/Admin) is currently
// showing. Replaces the old Navbar desktop dropdowns (Claims/Jobs/Budget/
// Manage/Workforce/Self Service), the Admin<->User switcher pill, and the
// old Admin-only AdminSidebar mobile drawer with one permission-filtered list:
// every User Panel section and every Admin Panel module this account has been
// granted, side by side. Visual language (profile header, violet glass
// drawer) carried over from the old AdminSidebar.
export const GlobalSidebar: React.FC<GlobalSidebarProps> = ({
  open, onClose, variant = 'overlay', user, token, photoVersion, onLogout, onGoToDashboard, onGoToJobsTab, onGoToUserClaims,
  onGoToSelfServiceTab, onGoToAdminClaims, onGoToAdminModule, onOpenProfile, onOpenChat, onOpenAlerts, activeKey,
}) => {
  const isPersistent = variant === 'persistent';
  // Closed by default — a group only opens when the user explicitly taps its
  // header, or (see the effect below, once every group's items are known)
  // when the item currently on screen turns out to live inside one, so its
  // highlight is never hidden behind a collapsed group.
  const [jobEntryOpen, setJobEntryOpen] = useState(false);
  const [hrmOpen, setHrmOpen] = useState(false);
  // HRM's own sub-groups (My Claim/Bill, Attendance, Leave Manage) each
  // toggle independently — keyed by hrmSubGroups[].key rather than one
  // useState per sub-group, since which sub-groups even exist depends on
  // this account's permissions (see hrmSubGroups below).
  const [hrmSubOpenKeys, setHrmSubOpenKeys] = useState<Record<string, boolean>>({});
  const toggleHrmSub = (key: string) => setHrmSubOpenKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  const [reportsOpen, setReportsOpen] = useState(false);
  const [hrOpen, setHrOpen] = useState(false);
  // HR's own sub-groups (Attendance, Claims/Bill/Disbursement, Employee) —
  // same independent-toggle pattern as hrmSubOpenKeys above, kept as its own
  // state so HR's and HRM's sub-group keys never collide.
  const [hrSubOpenKeys, setHrSubOpenKeys] = useState<Record<string, boolean>>({});
  const toggleHrSub = (key: string) => setHrSubOpenKeys((prev) => ({ ...prev, [key]: !prev[key] }));
  const [misOpen, setMisOpen] = useState(false);
  // "SELF SERVICE" / "ADMIN PANEL" — the two top-level section headers
  // above, now clickable the same way every group inside them already is:
  // tap the header to reveal its groups/items, tap a group inside to reveal
  // its own items. Closed by default, same convention as every group below
  // (see the auto-reveal effect further down for the one exception: whatever
  // section holds the currently-active item always opens).
  const [selfServiceOpen, setSelfServiceOpen] = useState(false);
  const [adminPanelOpen, setAdminPanelOpen] = useState(false);
  const photoUrl = useProfilePhoto(token, photoVersion);

  // Minimized/collapsed mode — desktop persistent column only (the mobile
  // overlay drawer is already a full-width sheet the user opens on demand,
  // so "minimizing" it wouldn't make sense). Remembers the user's choice
  // across reloads via localStorage; the overlay-variant instance of this
  // component never reads/writes it since `isPersistent` gates it below.
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    if (!isPersistent) return false;
    try {
      return localStorage.getItem('gsidebar_collapsed') === '1';
    } catch {
      return false;
    }
  });
  const toggleCollapsed = () => {
    setCollapsed((prev) => {
      const next = !prev;
      try {
        localStorage.setItem('gsidebar_collapsed', next ? '1' : '0');
      } catch {
        // localStorage unavailable (private mode, etc.) — collapsed state
        // just won't persist across reloads, nothing else breaks.
      }
      return next;
    });
  };

  // Server switcher — every account, native app only (the Web build always
  // just uses the relative "/api/..." origin it's served from, so switching
  // servers is meaningless there). Opens a modal that navigates the WebView
  // to a different deployment entirely (see ServerSwitcherModal.tsx) — the
  // label below just shows this device's current host, straight off
  // window.location, since that's the actual source of truth now (no more
  // separate "active profile" bookkeeping — see src/lib/api.ts). Adding/
  // editing/removing entries in that catalog stays Superadmin-only (Admin
  // Panel -> Servers, "servers" item above).
  const isNativeApp = Capacitor.isNativePlatform();
  const [showServerModal, setShowServerModal] = useState(false);
  const currentServerHost = typeof window !== 'undefined' ? window.location.host : '';

  const initials = user.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || '?';

  const roleAvatarColors: Record<string, string> = {
    superadmin: '#7F00FF',
    admin: '#B36AFF',
    user: '#D2A8FF',
  };

  // Whether this account has a User Panel at all — a plain User always does;
  // an Admin only does once granted can_access_user_panel; a Superadmin
  // always does too now (every Superadmin can switch into the User Panel —
  // see App.tsx's canSwitchToUserPanel — so it was a bug for this sidebar to
  // hide Entry/Jobs/Entry Details/Job Edits from Superadmin accounts).
  const hasUserPanel = user.role === 'user' || user.role === 'superadmin' || (user.role === 'admin' && !!user.can_access_user_panel);

  // Whether this account has an Admin Panel at all — a plain Superadmin/Admin
  // always does; a plain User only does once granted at least one module.
  const hasAdminPanel =
    user.role === 'admin' || user.role === 'superadmin' || (user.role === 'user' && (user.module_permissions || []).length > 0);

  const isSuperAdmin = user.role === 'superadmin';

  // Same Superadmin-gated pattern as canSeeModule below, but ON by default —
  // gates the Entry/Jobs/Entry Details items in jobEntryGroup just below (Job
  // Edits stays on its own separate user.can_job_edit gate, and the Movement/
  // Conveyance Claims items further down (now in selfServiceItems) keep their
  // own OFF-by-default gates).
  const canSeeBudgetModule = isSuperAdmin || user.can_view_budget_module !== false;

  // Per-module visibility — mirrors AdminPanel.tsx's own `canSee` (Superadmin
  // sees every module; everyone else only the ones explicitly granted).
  const canSeeModule = (key: AdminModuleKey) => isSuperAdmin || (user.module_permissions || []).includes(key);

  const selectAndClose = (fn: () => void) => {
    fn();
    onClose();
  };

  // "Job Entry" — User Panel's own MPR workflow, now a collapsible sub-group
  // inside "Self Service" instead of its own top-level "MAIN" section (which
  // otherwise never actually collapsed anything — every account either saw
  // all of it or none of it). Named "Job Entry", not "PEPM Manage" — Admin
  // Panel already has its own group with that exact label (reportsGroup
  // below) for something unrelated (Reports/MPR Nos/Data Import/Job Recycle/
  // MPR Edit Log); reusing the name here would show two different "PEPM
  // Manage" groups in the same sidebar.
  const jobEntryGroup: NavItem[] = [];
  if (hasUserPanel) {
    if (canSeeBudgetModule) {
      jobEntryGroup.push({ key: 'entry', label: 'Entry', icon: Wallet, onClick: () => onGoToJobsTab('entry') });
      jobEntryGroup.push({ key: 'jobs', label: 'Jobs', icon: Briefcase, onClick: () => onGoToJobsTab('jobs') });
      jobEntryGroup.push({ key: 'entryDetails', label: 'Entry Details', icon: FileText, onClick: () => onGoToJobsTab('entryDetails') });
    }
    if (user.can_job_edit) {
      jobEntryGroup.push({ key: 'jobEdit', label: 'Job Edits', icon: Edit2, onClick: () => onGoToJobsTab('jobEdit') });
    }
  }

  // "Self Service" — everyday employee items. Employee Directory stays
  // ungated for every account (company-wide roster); Timesheet/Leave
  // Application/My Leave are gated the same way as Movement Claim/
  // Conveyance Bill Claim below — OFF by default, granted per account via
  // Admin Panel -> Users -> Module Access.
  const canSeeTimesheet = isSuperAdmin || !!user.can_view_timesheet;
  const canSeeLeaveApplication = isSuperAdmin || !!user.can_view_leave_application;
  const canSeeMyLeave = isSuperAdmin || !!user.can_view_my_leave;
  // "Leave Manage" — same access as LeaveManage.tsx's own canManageAll check
  // (a Superadmin, or any Admin/User the Superadmin has granted
  // can_manage_leave to via Admin Panel -> Users -> Module Access -> "Also
  // allow editing Leave balances").
  const canManageLeave = user.role === 'superadmin' || !!user.can_manage_leave;

  // "HRM" — a nested group inside Self Service, one level deeper than every
  // other group here: HRM itself expands to reveal three further collapsible
  // sub-groups (My Claim/Bill, Attendance, Leave Manage), each independently
  // toggled. Same "closed by default, auto-opens (both levels) around the
  // active item" behavior as everything else — see the effect below.
  const hrmClaimGroup: NavItem[] = [];
  if (hasUserPanel && user.can_view_movement_claims) {
    hrmClaimGroup.push({ key: 'userMovementClaims', label: 'Movement Claims', icon: Route, onClick: () => onGoToUserClaims('movementClaims') });
  }
  if (hasUserPanel && user.can_view_conveyance_claims) {
    hrmClaimGroup.push({ key: 'userConveyanceClaims', label: 'Conveyance Bill Claim', icon: CreditCard, onClick: () => onGoToUserClaims('conveyanceBill') });
  }
  const hrmAttendanceGroup: NavItem[] = [];
  if (canSeeTimesheet) {
    hrmAttendanceGroup.push({ key: 'timesheet', label: 'Timesheet', icon: Clock, onClick: () => onGoToSelfServiceTab('timesheet') });
  }
  const hrmLeaveGroup: NavItem[] = [];
  if (canManageLeave) {
    hrmLeaveGroup.push({ key: 'leaveManagement', label: 'Leave Manage', icon: ListChecks, onClick: () => onGoToSelfServiceTab('leaveManagement') });
  }
  if (user.role === 'admin' || user.role === 'superadmin') {
    hrmLeaveGroup.push({ key: 'leaveApprovals', label: 'Leave Approvals', icon: CheckSquare, onClick: () => onGoToSelfServiceTab('leaveApprovals') });
  }
  // "Payroll" — Coming Soon placeholder (PayrollModule.tsx/PayrollRoutes.ts),
  // but permission-gated like every other module from the start: a
  // Superadmin always sees it (canSeeModule), everyone else only once
  // explicitly granted the 'payroll' module via Admin Panel -> Users ->
  // Module Access. GET /api/payroll/status enforces the same gate
  // server-side (requireModule('payroll')), so this is real access control,
  // not just a hidden menu item. Moved into HRM as its own sub-group.
  const hrmPayrollGroup: NavItem[] = [];
  if (canSeeModule('payroll')) {
    hrmPayrollGroup.push({ key: 'payroll', label: 'Payroll', icon: Banknote, onClick: () => onGoToSelfServiceTab('payroll') });
  }
  const hrmSubGroups: { key: string; label: string; icon: React.ComponentType<{ className?: string }>; items: NavItem[] }[] = [
    { key: 'my_claim_bill', label: 'My Claim/Bill', icon: Wallet, items: hrmClaimGroup },
    { key: 'hrm_attendance', label: 'Attendance', icon: Clock, items: hrmAttendanceGroup },
    { key: 'hrm_leave_manage', label: 'Leave Manage', icon: ListChecks, items: hrmLeaveGroup },
    { key: 'hrm_payroll', label: 'Payroll', icon: Banknote, items: hrmPayrollGroup },
  ].filter((g) => g.items.length > 0);

  const selfServiceItems: NavItem[] = [];
  if (canSeeLeaveApplication) {
    selfServiceItems.push({ key: 'leaveApplication', label: 'Leave Application', icon: CalendarClock, onClick: () => onGoToSelfServiceTab('leaveApplication') });
  }
  // Always visible to every account — only ever shows THIS account's own
  // Leave balance, read-only (see MyLeave.tsx). Distinct from "Leave
  // Manage" (now under HRM below), which is gated and shows/edits every
  // account's balance.
  if (canSeeMyLeave) {
    selfServiceItems.push({ key: 'myLeave', label: 'My Leave', icon: ListChecks, onClick: () => onGoToSelfServiceTab('myLeave') });
  }
  // Chat (Direct/Group/Community messaging, ChatPanel.tsx) — NOT gated,
  // every signed-in account gets it, same as Employee Directory just below.
  selfServiceItems.push({ key: 'chat', label: 'Chat', icon: MessageSquare, onClick: onOpenChat });
  // Alerts (AlertsPage.tsx) — same visibility as Chat above: every
  // signed-in account, not gated behind any module grant.
  selfServiceItems.push({ key: 'alerts', label: 'Alerts', icon: Bell, onClick: onOpenAlerts });
  // Company-wide roster, browsable by every account regardless of role or
  // Admin Panel module access (unlike Admin Panel -> Employees, which is
  // the HR-editing view gated behind the 'employees' module) — see
  // EmployeeDirectory.tsx / EmployeeDirectoryRoutes.ts.
  selfServiceItems.push({ key: 'employeeDirectory', label: 'Employee Directory', icon: Contact, onClick: () => onGoToSelfServiceTab('employeeDirectory') });
  // NOT Admin-gated — a Template Layer or a Leave Application's Reliever can
  // be ANY account, so every account gets this.
  selfServiceItems.push({ key: 'approveApplications', label: 'Approve Application', icon: ShieldCheck, onClick: () => onGoToSelfServiceTab('approveApplications') });

  // "Admin Dashboard" — the new HR-overview landing page (stat tiles, quick
  // view, charts, notices, leave balances). Unlike every other Admin Panel
  // item below, this is NOT module_permissions-gated — it's not a grantable
  // module, it's the Admin/Superadmin's own home screen — so a plain 'user'
  // role account (even one holding module_permissions) never sees it, only
  // real role === 'admin' | 'superadmin' accounts do.
  const isAdminRole = user.role === 'admin' || user.role === 'superadmin';
  const adminDashboardItem: NavItem | null = isAdminRole
    ? { key: 'admin_dashboard', label: 'Admin Dashboard', icon: LayoutDashboard, onClick: () => onGoToAdminModule('dashboard') }
    : null;

  // "Admin Panel" — PEPM Manage group (expandable) + flat items, same grouping
  // the old AdminSidebar used, each filtered by canSeeModule. (Group label
  // shown to the user is "PEPM Manage"; internal names kept as reportsGroup/
  // reportsOpen to minimize diff.)
  const reportsGroup: NavItem[] = [
    { key: 'reports', label: 'Reports', icon: BarChart3, onClick: () => onGoToAdminModule('reports') },
    { key: 'mprs', label: 'MPR Nos', icon: FileText, onClick: () => onGoToAdminModule('mprs') },
    { key: 'imports', label: 'Data Import', icon: Upload, onClick: () => onGoToAdminModule('imports') },
    { key: 'recycle', label: 'Job Recycle', icon: Recycle, onClick: () => onGoToAdminModule('recycle') },
    { key: 'editlog', label: 'MPR Edit Log', icon: History, onClick: () => onGoToAdminModule('editlog') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // "Claims" — Movement Claims, Conveyance Bill Claim, Conveyance
  // Disbursement. No longer its own collapsible group — merged as flat
  // items into "HR" below.
  const claimsItems: NavItem[] = [
    { key: 'claims', label: 'Movement Claims', icon: Route, onClick: () => onGoToAdminClaims('claims') },
    { key: 'conveyance', label: 'Conveyance Bill Claim', icon: CreditCard, onClick: () => onGoToAdminClaims('conveyance') },
    { key: 'disbursement', label: 'Conveyance Disbursement', icon: Banknote, onClick: () => onGoToAdminModule('disbursement') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));
  // "My Conveyance Bill Claim" — an Admin's own Bills/Claims, read-only. Not
  // a separately-grantable module: shown to anyone who already has the
  // 'conveyance' module, since that's exactly who has no other way to see
  // their own record (the tab above shows everyone ELSE's, and this account
  // may not have User Panel/can_view_conveyance_claims access at all).
  if (canSeeModule('conveyance')) {
    claimsItems.push({
      key: 'my_conveyance',
      label: 'My Conveyance Bill Claim',
      icon: Wallet,
      onClick: () => onGoToAdminModule('my_conveyance')
    });
  }

  // "Attendance" — Remote Attendance, Monthly Attendance Report, Office
  // Attendance. No longer its own collapsible group — merged as flat items
  // into "HR" below.
  const attendanceItems: NavItem[] = [
    { key: 'attendance', label: 'Remote Attendance', icon: Navigation, onClick: () => onGoToAdminModule('attendance') },
    { key: 'attendance_reports', label: 'Monthly Attendance Report', icon: Calendar, onClick: () => onGoToAdminModule('attendance_reports') },
    { key: 'office_attendance', label: 'Office Attendance', icon: Fingerprint, onClick: () => onGoToAdminModule('office_attendance') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // "Organization" — Projects, Branches. No longer its own collapsible
  // group — Projects/Branches merged into "MIS" below, Departments merged
  // into "HR" below.
  const orgItems: NavItem[] = [
    { key: 'projects', label: 'Projects', icon: Building2, onClick: () => onGoToAdminModule('projects') },
    { key: 'branches', label: 'Branches', icon: Building2, onClick: () => onGoToAdminModule('branches') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));
  const departmentsItem: NavItem[] = [
    { key: 'departments', label: 'Departments', icon: Users2, onClick: () => onGoToAdminModule('departments') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // "Employee" — Employees, Employee Tracking, Asset Management. No longer
  // its own "Workforce" top-level group — merged in as a nested sub-group
  // inside HR below (Users already moved out to MIS separately).
  const employeeItems: NavItem[] = [
    { key: 'employees', label: 'Employees', icon: Contact, onClick: () => onGoToAdminModule('employees') },
    { key: 'tracking', label: 'Employee Tracking', icon: Navigation, onClick: () => onGoToAdminModule('tracking') },
    { key: 'asset_management', label: 'Asset Management', icon: Package, onClick: () => onGoToAdminModule('asset_management') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // "HR" — approvals, notices, holidays, leave reporting, plus Departments
  // (from the dissolved Organization group) and every item from the
  // dissolved Claims/Attendance groups.
  const hrGroup: NavItem[] = [
    { key: 'approvals', label: 'Approvals', icon: ShieldCheck, onClick: () => onGoToAdminModule('approvals') },
    { key: 'notices', label: 'Notices', icon: Bell, onClick: () => onGoToAdminModule('notices') },
    { key: 'holidays', label: 'Holidays', icon: Calendar, onClick: () => onGoToAdminModule('holidays') },
    // Read-only "who applied for Leave" report, gated by its own
    // 'leave_applications' module (separate from can_manage_leave's "Leave
    // Manage" item and from the "Leave Approvals" item above) — see
    // ADMIN_MODULES in types.ts.
    { key: 'leave_applications', label: 'Monthly Leave Application', icon: CalendarClock, onClick: () => onGoToAdminModule('leave_applications') },
    ...departmentsItem,
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // HR's own nested sub-groups — "Attendance" (Remote Attendance, Monthly
  // Attendance Report, Office Attendance) and "Claims/Bill/Disbursement"
  // (Movement Claims, Conveyance Bill Claim, Conveyance Disbursement, My
  // Conveyance Bill Claim), each independently collapsible, same 2-level
  // nested pattern as HRM's own sub-groups above.
  // World-class HRM extension modules (Exit/Offboarding, Performance,
  // Recruitment, Grievance & Disciplinary, HR Analytics, Document Vault) —
  // each its own AdminModuleKey/admin_module_permissions grant, same as
  // every other item here; grouped together so they don't crowd the flat
  // hrGroup list above.
  const hrAdvancedItems: NavItem[] = [
    { key: 'exit_offboarding', label: 'Exit / Offboarding', icon: LogOut, onClick: () => onGoToAdminModule('exit_offboarding') },
    { key: 'performance_management', label: 'Performance Management', icon: Target, onClick: () => onGoToAdminModule('performance_management') },
    { key: 'recruitment', label: 'Recruitment (ATS)', icon: UserPlus, onClick: () => onGoToAdminModule('recruitment') },
    { key: 'grievance_disciplinary', label: 'Grievance & Disciplinary', icon: Gavel, onClick: () => onGoToAdminModule('grievance_disciplinary') },
    { key: 'hr_analytics', label: 'HR Analytics', icon: BarChart3, onClick: () => onGoToAdminModule('hr_analytics') },
    { key: 'document_vault', label: 'Document Vault', icon: FolderLock, onClick: () => onGoToAdminModule('document_vault') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  const hrSubGroups: { key: string; label: string; icon: React.ComponentType<{ className?: string }>; items: NavItem[] }[] = [
    { key: 'hr_attendance', label: 'Attendance', icon: Fingerprint, items: attendanceItems },
    { key: 'hr_claims_bill', label: 'Claims/Bill/Disbursement', icon: CreditCard, items: claimsItems },
    { key: 'hr_employee', label: 'Employee', icon: Contact, items: employeeItems },
    { key: 'hr_advanced', label: 'HR Advanced', icon: Sparkles, items: hrAdvancedItems },
  ].filter((g) => g.items.length > 0);

  // Auto-reveal whichever group the currently-active item lives in — every
  // group above starts collapsed (the user has to tap to open one), but that
  // must never hide the "you are here" highlight for whatever's actually on
  // screen right now (e.g. picked from the search results below, or just
  // landed on directly/after a reload) inside a still-closed group. Only
  // ever opens a group, never closes one the user already opened by hand.
  useEffect(() => {
    if (!activeKey) return;
    if (jobEntryGroup.some((i) => i.key === activeKey)) { setSelfServiceOpen(true); setJobEntryOpen(true); }
    const activeHrmSub = hrmSubGroups.find((g) => g.items.some((i) => i.key === activeKey));
    if (activeHrmSub) {
      setSelfServiceOpen(true);
      setHrmOpen(true);
      setHrmSubOpenKeys((prev) => (prev[activeHrmSub.key] ? prev : { ...prev, [activeHrmSub.key]: true }));
    }
    if (selfServiceItems.some((i) => i.key === activeKey)) setSelfServiceOpen(true);
    if (adminDashboardItem && adminDashboardItem.key === activeKey) setAdminPanelOpen(true);
    if (reportsGroup.some((i) => i.key === activeKey)) { setAdminPanelOpen(true); setReportsOpen(true); }
    if (hrGroup.some((i) => i.key === activeKey)) { setAdminPanelOpen(true); setHrOpen(true); }
    const activeHrSub = hrSubGroups.find((g) => g.items.some((i) => i.key === activeKey));
    if (activeHrSub) {
      setAdminPanelOpen(true);
      setHrOpen(true);
      setHrSubOpenKeys((prev) => (prev[activeHrSub.key] ? prev : { ...prev, [activeHrSub.key]: true }));
    }
    if (misGroup.some((i) => i.key === activeKey)) { setAdminPanelOpen(true); setMisOpen(true); }
    if (adminFlatItems.some((i) => i.key === activeKey)) setAdminPanelOpen(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // "MIS" — Users + Servers, plus Projects/Branches (from the dissolved
  // Organization group). "Servers" (Admin Panel tab, full catalog CRUD) is
  // Superadmin-only on any platform (this is the WEB-oriented management
  // surface — see ServerProfilesPanel.tsx) and not a grantable
  // module_permissions item like most other items, so it's gated directly
  // on isSuperAdmin rather than canSeeModule. Everything else here keeps its
  // normal canSeeModule gate.
  const misGroup: NavItem[] = [
    { key: 'users', label: 'Users', icon: Users, onClick: () => onGoToAdminModule('users') },
    ...orgItems,
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));
  if (isSuperAdmin) {
    misGroup.push({ key: 'servers', label: 'Servers', icon: Server, onClick: () => onGoToAdminModule('servers') });
  }

  // Not part of MIS — Superadmin-only, but not "Users/Servers management",
  // so kept as its own flat item like before.
  const adminFlatItems: NavItem[] = [];
  if (isSuperAdmin) {
    // Same "not a grantable module" reasoning as Servers above — this exists
    // specifically so a Superadmin can see an Admin's permanent Job Recycle
    // erases too, so it can never be delegated away via module_permissions.
    adminFlatItems.push({
      key: 'permanent_delete_log',
      label: 'Permanent Delete Log',
      icon: ShieldAlert,
      onClick: () => onGoToAdminModule('permanent_delete_log'),
    });
  }

  // Sidebar-wide menu search — flattens every item this account can actually
  // see (Dashboard + Main + Self Service + every Admin Panel group/flat item)
  // into one searchable list, so a menu buried a few groups deep is still one
  // search away instead of needing to expand each group to find it. Hidden
  // while the desktop column is minimized (collapsed) — no room for typed
  // input there, same as every other label in that mode.
  const [sidebarSearch, setSidebarSearch] = useState('');
  const dashboardSearchItem: NavItem = { key: 'dashboard', label: 'Dashboard', icon: Home, onClick: onGoToDashboard };
  const allSearchableItems: NavItem[] = [
    dashboardSearchItem,
    ...jobEntryGroup,
    ...hrmSubGroups.flatMap((g) => g.items),
    ...selfServiceItems,
    ...(adminDashboardItem ? [adminDashboardItem] : []),
    ...reportsGroup,
    ...hrGroup,
    ...hrSubGroups.flatMap((g) => g.items),
    ...misGroup,
    ...adminFlatItems,
  ];
  const searchQuery = sidebarSearch.trim().toLowerCase();
  const searchResults = searchQuery ? allSearchableItems.filter((i) => i.label.toLowerCase().includes(searchQuery)) : [];
  const selectSearchResult = (fn: () => void) => {
    setSidebarSearch('');
    selectAndClose(fn);
  };

  const renderItem = (item: NavItem) => {
    const active = item.key === activeKey;
    return (
      <button
        key={item.key}
        type="button"
        title={collapsed ? item.label : undefined}
        onClick={() => selectAndClose(item.onClick)}
        className={`w-full flex items-center rounded-xl transition-colors ${
          collapsed ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2.5'
        } ${active ? 'bg-white/15 text-white shadow-sm' : 'text-white/85 hover:bg-white/10'}`}
      >
        <item.icon className="w-[18px] h-[18px] shrink-0" />
        {!collapsed && <span className={`text-[13px] truncate ${active ? 'font-semibold' : 'font-medium'}`}>{item.label}</span>}
      </button>
    );
  };

  // Shared renderer for the collapsible category groups (PEPM Manage,
  // Claims, Attendance, Organization, Workforce, HR): a toggle header +
  // indented items when expanded. While the sidebar itself is minimized,
  // grouping into a flyout isn't worth the complexity, so it just falls
  // back to the same flat icon list every other item uses.
  const renderGroup = (
    items: NavItem[],
    label: string,
    icon: React.ComponentType<{ className?: string }>,
    isOpen: boolean,
    setOpen: (fn: (o: boolean) => boolean) => void,
  ) => {
    if (items.length === 0) return null;
    if (collapsed) {
      return <div key={label} className="space-y-0.5">{items.map(renderItem)}</div>;
    }
    const GroupIcon = icon;
    // Highlights the group's own header whenever the currently-active item
    // lives inside it — so "where am I" is visible even while the group
    // sits collapsed, not just once it's opened and the leaf item itself
    // lights up below.
    const groupActive = items.some((i) => i.key === activeKey);
    return (
      <div key={label}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 transition-colors ${
            groupActive ? 'bg-white/10 text-white' : 'text-white/85 hover:bg-white/10'
          }`}
        >
          <GroupIcon className="w-[18px] h-[18px] shrink-0" />
          <span className={`text-[13px] flex-1 text-left ${groupActive ? 'font-bold' : 'font-semibold'}`}>{label}</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {isOpen && (
          <div className="mt-0.5 ml-[13px] pl-3.5 border-l border-white/15 space-y-0.5">
            {items.map((item) => {
              const active = item.key === activeKey;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => selectAndClose(item.onClick)}
                  className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    active ? 'bg-white/15 text-white font-semibold' : 'text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <item.icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-[12.5px] truncate">{item.label}</span>
                </button>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  // "HRM"/"HR" — same idea as renderGroup above, one level deeper: the group
  // itself expands to a list of further collapsible sub-groups (HRM: My
  // Claim/Bill, Attendance, Leave Manage, Payroll; HR: Attendance,
  // Claims/Bill/Disbursement), each toggled independently via its own
  // subOpenKeys/toggleSub pair (kept separate per parent group so their sub-
  // group keys never collide). `flatItems`, when given, renders as plain
  // leaf buttons above the sub-groups — HR's own Approvals/Notices/Holidays/
  // Monthly Leave Application/Departments stay flat inside HR rather than
  // needing a sub-group of their own. While collapsed (desktop minimized
  // column), falls back to every flat item + sub-group item as one flat icon
  // list, same as renderGroup's own collapsed fallback.
  const renderNestedGroup = (
    subGroups: { key: string; label: string; icon: React.ComponentType<{ className?: string }>; items: NavItem[] }[],
    label: string,
    icon: React.ComponentType<{ className?: string }>,
    isOpen: boolean,
    setOpen: (fn: (o: boolean) => boolean) => void,
    subOpenKeys: Record<string, boolean>,
    toggleSub: (key: string) => void,
    flatItems: NavItem[] = [],
  ) => {
    if (subGroups.length === 0 && flatItems.length === 0) return null;
    if (collapsed) {
      return <div key={label} className="space-y-0.5">{[...flatItems, ...subGroups.flatMap((g) => g.items)].map(renderItem)}</div>;
    }
    const GroupIcon = icon;
    // Same "highlight the header whenever the active item lives inside"
    // behavior as renderGroup above, checked across both flatItems and every
    // sub-group's items — the outer HRM/HR header lights up whichever level
    // the active item sits at, and each sub-group's own header lights up too
    // when it's specifically that sub-group holding the active item.
    const groupActive = flatItems.some((i) => i.key === activeKey) || subGroups.some((g) => g.items.some((i) => i.key === activeKey));
    return (
      <div key={label}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 transition-colors ${
            groupActive ? 'bg-white/10 text-white' : 'text-white/85 hover:bg-white/10'
          }`}
        >
          <GroupIcon className="w-[18px] h-[18px] shrink-0" />
          <span className={`text-[13px] flex-1 text-left ${groupActive ? 'font-bold' : 'font-semibold'}`}>{label}</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {isOpen && (
          <div className="mt-0.5 ml-[13px] pl-3.5 border-l border-white/15 space-y-0.5">
            {flatItems.map((item) => {
              const active = item.key === activeKey;
              return (
                <button
                  key={item.key}
                  type="button"
                  onClick={() => selectAndClose(item.onClick)}
                  className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                    active ? 'bg-white/15 text-white font-semibold' : 'text-white/70 hover:bg-white/10 hover:text-white'
                  }`}
                >
                  <item.icon className="w-3.5 h-3.5 shrink-0" />
                  <span className="text-[12.5px] truncate">{item.label}</span>
                </button>
              );
            })}
            {subGroups.map((g) => {
              const subOpen = !!subOpenKeys[g.key];
              const subActive = g.items.some((i) => i.key === activeKey);
              const SubIcon = g.icon;
              return (
                <div key={g.key}>
                  <button
                    type="button"
                    onClick={() => toggleSub(g.key)}
                    className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                      subActive ? 'bg-white/10 text-white' : 'text-white/70 hover:bg-white/10 hover:text-white'
                    }`}
                  >
                    <SubIcon className="w-3.5 h-3.5 shrink-0" />
                    <span className={`text-[12.5px] flex-1 text-left truncate ${subActive ? 'font-bold' : 'font-semibold'}`}>{g.label}</span>
                    <ChevronDown className={`w-3 h-3 shrink-0 transition-transform duration-200 ${subOpen ? 'rotate-180' : ''}`} />
                  </button>
                  {subOpen && (
                    <div className="mt-0.5 ml-[11px] pl-3 border-l border-white/10 space-y-0.5">
                      {g.items.map((item) => {
                        const active = item.key === activeKey;
                        return (
                          <button
                            key={item.key}
                            type="button"
                            onClick={() => selectAndClose(item.onClick)}
                            className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-1.5 text-left transition-colors ${
                              active ? 'bg-white/15 text-white font-semibold' : 'text-white/60 hover:bg-white/10 hover:text-white'
                            }`}
                          >
                            <item.icon className="w-3 h-3 shrink-0" />
                            <span className="text-[12px] truncate">{item.label}</span>
                          </button>
                        );
                      })}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  };

  return (
    <div>
      {/* Backdrop — overlay variant only; the persistent desktop column has
          nothing floating above the page for it to dim. */}
      {!isPersistent && (
        <div
          onClick={onClose}
          className={`fixed inset-0 z-[1100] bg-slate-900/40 backdrop-blur-[2px] transition-opacity duration-300 ${
            open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
          }`}
        />
      )}

      {/* Drawer. z-[1200]/[1100] here (not the app's usual z-40/z-50) on
          purpose — Leaflet's own controls (Employee Tracking's map, see
          EmployeeTrackingPanel.tsx) render their zoom +/- box at z-index:1000
          by default, which sat above this drawer's old z-50 and showed
          through on top of it whenever the sidebar was opened from that page.
          (Persistent variant sits in normal flow beside <main> — see
          App.tsx — so it only needs a modest z-index, just enough to layer
          over page content it happens to sit beside.) */}
      <aside
        className={
          isPersistent
            ? `hidden md:flex sticky top-16 z-10 flex-col shrink-0 self-start h-[calc(100vh-4rem)] transition-[width] duration-200 ${
                collapsed ? 'w-[64px]' : 'w-[264px]'
              }`
            : `fixed left-0 top-0 bottom-0 z-[1200] flex flex-col w-[264px] max-w-[85vw] transition-transform duration-300 ease-out ${
                open ? 'translate-x-0' : '-translate-x-[110%]'
              }`
        }
        style={{
          background: 'linear-gradient(165deg, rgba(127,0,255,0.94) 0%, rgba(99,0,198,0.94) 55%, rgba(71,0,142,0.96) 100%)',
          boxShadow: isPersistent ? 'none' : '12px 0 40px rgba(47,0,94,0.35)',
          borderRight: isPersistent ? '1px solid rgba(255,255,255,0.08)' : undefined,
          paddingTop: isPersistent ? undefined : 'var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px))',
        }}
      >
        {!isPersistent && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 w-7 h-7 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            style={{ top: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 12px)' }}
            aria-label="Close menu"
          >
            <X className="w-4 h-4" />
          </button>
        )}

        {/* Logo + profile header — overlay (mobile) only. The persistent
            desktop column sits right under the header, which already shows
            the logo and the profile avatar/menu, so repeating them here
            would just duplicate what's already above. */}
        {!isPersistent && (
          <>
            <div className="w-full px-5 pt-4 flex items-center">
              <img src={credenceLogo} alt="Credence" className="h-6 w-auto opacity-95" style={{ filter: 'brightness(0) invert(1)' }} />
            </div>

            {/* Profile header — tapping it opens ProfilePage.tsx (same screen
                Navbar's desktop avatar button opens), then closes this drawer. */}
            <button
              type="button"
              onClick={() => selectAndClose(onOpenProfile)}
              className="flex flex-col items-center text-center pb-5 px-5 pt-3 w-full hover:bg-white/5 transition-colors"
              aria-label="Open profile"
            >
              <div
                className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold text-white ring-2 ring-white/30 overflow-hidden"
                style={{ background: roleAvatarColors[user.role] || '#B36AFF' }}
              >
                {photoUrl ? <img src={photoUrl} alt={user.name} className="w-full h-full object-cover" /> : initials}
              </div>
              <p className="mt-2.5 text-[10px] font-semibold tracking-wide text-white/60">
                {user.role === 'superadmin' ? 'SUPERADMIN' : user.role === 'admin' ? 'ADMIN' : 'USER'}
              </p>
              <p className="text-sm font-semibold text-white truncate max-w-[210px]">{user.name}</p>
            </button>

            <div className="h-px mx-4 bg-white/15" />
          </>
        )}

        {/* Menu search + Minimize/expand toggle, same row — both sit ABOVE
            <nav> (which is the only scrolling element in this drawer), so
            neither one ever scrolls out of view: they're not inside the
            scrollable area at all, rather than being "sticky" within it.
            The toggle is persistent (desktop) variant only — it shrinks the
            column down to a slim icon rail (labels/section headers hidden,
            collapsible groups fall back to a flat icon list — see
            renderGroup), remembered across reloads via localStorage above.
            Search itself searches every visible item (Dashboard, Main, Self
            Service, and every Admin Panel group), regardless of whether its
            group is currently expanded — selecting a result navigates
            straight there, same as clicking that item directly. */}
        <div className={`flex items-center gap-2 px-2.5 pt-3 ${isPersistent && collapsed ? 'justify-center' : ''}`}>
            {!(isPersistent && collapsed) && (
              <div className="relative flex-1 min-w-0">
                <div className="relative">
                  <Search className="w-3.5 h-3.5 text-white/40 absolute left-2.5 top-1/2 -translate-y-1/2" />
                  <input
                    type="text"
                    value={sidebarSearch}
                    onChange={(e) => setSidebarSearch(e.target.value)}
                    placeholder="Search menu…"
                    className="w-full pl-8 pr-7 py-2 rounded-xl bg-white/10 text-white text-[13px] placeholder-white/40 focus:outline-none focus:bg-white/15 transition-colors"
                  />
                  {sidebarSearch && (
                    <button
                      type="button"
                      onClick={() => setSidebarSearch('')}
                      className="absolute right-2 top-1/2 -translate-y-1/2 text-white/50 hover:text-white"
                      aria-label="Clear search"
                    >
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </div>

                {searchQuery && (
                  <div className="absolute left-0 right-0 mt-1 max-h-72 overflow-y-auto rounded-xl bg-[#3a0d70] border border-white/15 shadow-xl z-20 py-1">
                    {searchResults.length > 0 ? (
                      searchResults.map((item) => (
                        <button
                          key={item.key}
                          type="button"
                          onClick={() => selectSearchResult(item.onClick)}
                          className="w-full flex items-center gap-2.5 px-3 py-2 text-left text-white/85 hover:bg-white/10 transition-colors"
                        >
                          <item.icon className="w-4 h-4 shrink-0" />
                          <span className="text-[13px] truncate">{item.label}</span>
                        </button>
                      ))
                    ) : (
                      <p className="px-3 py-2.5 text-xs text-white/50">No matching menu.</p>
                    )}
                  </div>
                )}
              </div>
            )}

            {isPersistent && (
              <button
                type="button"
                onClick={toggleCollapsed}
                title={collapsed ? 'Expand sidebar' : 'Minimize sidebar'}
                aria-label={collapsed ? 'Expand sidebar' : 'Minimize sidebar'}
                className="w-7 h-7 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors shrink-0"
              >
                {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
              </button>
            )}
        </div>

        <nav className={`flex-1 overflow-y-auto py-4 px-2.5 space-y-0.5 ${isPersistent ? 'gsidebar-no-scrollbar' : ''}`}>
          {/* Dashboard — always available, lands back on the User Panel's own
              dashboard regardless of which panel is currently showing. */}
          <button
            type="button"
            onClick={() => selectAndClose(onGoToDashboard)}
            title={collapsed ? 'Dashboard' : undefined}
            className={`w-full flex items-center rounded-xl transition-colors ${
              collapsed ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2.5'
            } ${activeKey === 'dashboard' ? 'bg-white/15 text-white shadow-sm' : 'text-white/85 hover:bg-white/10'}`}
          >
            <Home className="w-[18px] h-[18px] shrink-0" />
            {!collapsed && (
              <span className={`text-[13px] truncate ${activeKey === 'dashboard' ? 'font-semibold' : 'font-medium'}`}>Dashboard</span>
            )}
          </button>

          {!collapsed && (
            <button
              type="button"
              onClick={() => setSelfServiceOpen((o) => !o)}
              className="w-full flex items-center justify-between px-2.5 mt-3 mb-1.5 py-1 rounded-lg hover:bg-white/10 transition-colors"
            >
              <span className="text-[10px] font-semibold tracking-wide text-white/50">SELF SERVICE</span>
              <ChevronDown className={`w-3 h-3 text-white/50 transition-transform duration-200 ${selfServiceOpen ? 'rotate-180' : ''}`} />
            </button>
          )}
          {(collapsed || selfServiceOpen) && (
            <>
              {renderGroup(jobEntryGroup, 'Job Entry', Briefcase, jobEntryOpen, setJobEntryOpen)}
              {renderNestedGroup(hrmSubGroups, 'HRM', Users2, hrmOpen, setHrmOpen, hrmSubOpenKeys, toggleHrmSub)}
              {selfServiceItems.map(renderItem)}
            </>
          )}

          {(!!adminDashboardItem || reportsGroup.length > 0 ||
            hrGroup.length > 0 || hrSubGroups.length > 0 || misGroup.length > 0 || adminFlatItems.length > 0) && (
            <>
              {!collapsed && (
                <button
                  type="button"
                  onClick={() => setAdminPanelOpen((o) => !o)}
                  className="w-full flex items-center justify-between px-2.5 mt-3 mb-1.5 py-1 rounded-lg hover:bg-white/10 transition-colors"
                >
                  <span className="text-[10px] font-semibold tracking-wide text-white/50">ADMIN PANEL</span>
                  <ChevronDown className={`w-3 h-3 text-white/50 transition-transform duration-200 ${adminPanelOpen ? 'rotate-180' : ''}`} />
                </button>
              )}
              {(collapsed || adminPanelOpen) && (
                <>
              {adminDashboardItem && renderItem(adminDashboardItem)}

              {renderGroup(reportsGroup, 'PEPM Manage', BarChart3, reportsOpen, setReportsOpen)}
              {renderNestedGroup(hrSubGroups, 'HR', ShieldCheck, hrOpen, setHrOpen, hrSubOpenKeys, toggleHrSub, hrGroup)}
              {renderGroup(misGroup, 'MIS', Server, misOpen, setMisOpen)}

              {adminFlatItems.map(renderItem)}
                </>
              )}
            </>
          )}

        </nav>

        <div className="p-3 pb-[calc(var(--native-safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+12px)] space-y-2">
          {/* "Set Server" — native-app-only, EVERY account (not just Superadmin):
              any employee's device may need to point at a different
              company/deployment server, same as picking a different site to sign
              into. Opens a picker (ServerSwitcherModal.tsx) fetched from the
              catalog a Superadmin manages on the web (Admin Panel -> Servers,
              still Superadmin-only to add/edit/delete). Kept out of the "ADMIN
              PANEL" section above since it isn't an admin-only action. */}
          {SERVER_SWITCHER_ENABLED && isNativeApp && (
            <button
              type="button"
              onClick={() => selectAndClose(() => setShowServerModal(true))}
              title={collapsed ? (currentServerHost ? `Server: ${currentServerHost}` : 'Set Server') : undefined}
              className="w-full flex items-center justify-center gap-2 rounded-full py-2.5 text-[13px] font-semibold text-white bg-white/10 hover:bg-white/15 active:scale-[0.98] transition-transform"
            >
              <Navigation className="w-4 h-4 shrink-0" />
              {!collapsed && (currentServerHost ? `Server: ${currentServerHost}` : 'Set Server')}
            </button>
          )}
          <button
            type="button"
            onClick={() => selectAndClose(onLogout)}
            title={collapsed ? 'Logout' : undefined}
            className="w-full flex items-center justify-center gap-2 rounded-full py-2.5 text-[13px] font-semibold text-[color:var(--g-accent-900)] bg-white active:scale-[0.98] transition-transform"
          >
            <LogOut className="w-4 h-4 shrink-0" />
            {!collapsed && 'Logout'}
          </button>
        </div>
      </aside>

      {SERVER_SWITCHER_ENABLED && showServerModal && (
        <ServerSwitcherModal
          token={token}
          onClose={() => setShowServerModal(false)}
        />
      )}
    </div>
  );
};