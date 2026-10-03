import React, { useState, useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import {
  X, LogOut, Home, Wallet, Briefcase, FileText, Edit2, Route, CreditCard,
  CalendarClock, ListChecks, CheckSquare, ChevronDown, Building2, Users, Users2, Smartphone, Activity,
  BarChart3, FileSpreadsheet, Upload, History, Recycle, Navigation, Bell, ShieldCheck,
  Contact, Calendar, Clock, Fingerprint, Banknote, Package, LayoutDashboard, Server, MessageSquare,
  ChevronsLeft, ChevronsRight, ShieldAlert, Search, PieChart, FileUp,
  Target, UserPlus, Gavel, FolderLock, Sparkles, ExternalLink, Car,
  ClipboardList, BookOpen, ClipboardCheck, TrendingUp, Settings, Pencil, Check,
} from 'lucide-react';
import { User, AdminModuleKey, REPORTS_INSIGHTS_MODULES, DATA_IMPORT_MODULES } from '../types';
import credenceLogo from '../assets/credence-logo.png';
import { useProfilePhoto } from '../lib/useProfilePhoto';
import { useSiteSupervisor } from './TeamAttendance';

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
  onGoToSelfServiceTab: (target: 'leaveApplication' | 'leaveManagement' | 'timesheet' | 'approveApplications' | 'payroll' | 'employeeDirectory' | 'resignation' | 'assetManagement' | 'vehicleManagement' | 'myCases' | 'myLetters' | 'teamAttendance' | 'myTasks') => void;
  // Admin Panel's own Movement Claims / Conveyance Bill Claim review tabs —
  // separate feature from onGoToUserClaims above, gated by module_permissions
  // like every other Admin Panel module.
  onGoToAdminClaims: (target: 'claims' | 'conveyance') => void;
  // Every other Admin Panel module (Reports, Projects, Users, ...) — gated by
  // module_permissions (a Superadmin always sees all of them).
  // 'bill_claim_policy' is the one exception below: not its own
  // module_permissions entry, shown alongside 'conveyance' in the HR group
  // and gated on the same 'conveyance' grant.
  onGoToAdminModule: (target: Exclude<AdminModuleKey, 'claims' | 'conveyance'> | 'bill_claim_policy' | 'reports_insights' | 'data_import' | 'dashboard' | 'permanent_delete_log' | 'companies' | 'devices' | 'active_users') => void;
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
  // "360 ERP" item (self-service list below) — calls POST /api/sso/erp360/
  // initiate and opens the returned forward_url in a new tab (SSO hand-off
  // into the separate 360 ERP site). No page of its own here.
  onOpenErp360: () => void;
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
  onGoToSelfServiceTab, onGoToAdminClaims, onGoToAdminModule, onOpenProfile, onOpenChat, onOpenAlerts, onOpenErp360, activeKey,
}) => {
  const isPersistent = variant === 'persistent';
  // One group open at a time (tap another and the first closes); the group
  // holding the page on screen opens by itself (see the effect further down).
  const [openGroup, setOpenGroup] = useState<string | null>(null);
  // Minimized column: the group whose popup is showing beside its icon.
  const [flyout, setFlyout] = useState<{ key: string; top: number; bottom: number; left: number } | null>(null);
  const [editingFavs, setEditingFavs] = useState(false);
  const photoUrl = useProfilePhoto(token, photoVersion);
  // Site Attendance supervisor? (shows Self Service -> Team Attendance)
  const siteSupervisor = useSiteSupervisor(token);

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
  // PEPM exists only in the Credence workspace (user.pepm_enabled).
  const pepmOn = user.pepm_enabled !== false;
  const canSeeBudgetModule = pepmOn && (isSuperAdmin || user.can_view_budget_module !== false);

  // Per-module visibility — mirrors AdminPanel.tsx's own `canSee` (Superadmin
  // sees every module; everyone else only the ones explicitly granted).
  const canSeeModule = (key: AdminModuleKey) => isSuperAdmin || (user.module_permissions || []).includes(key);

  const selectAndClose = (fn: () => void) => {
    fn();
    onClose();
  };

  // "PEPM Operation" (label; internal name kept as jobEntryGroup/jobEntryOpen
  // to minimize diff) — User Panel's own MPR workflow, a collapsible
  // sub-group inside "Self Service". Distinct label from Admin Panel's own
  // "PEPM Management" group (reportsGroup below, Reports/MPR Nos/Data
  // Import/Job Recycle/MPR Edit Log) so the two don't read as the same
  // group in the same sidebar.
  const jobEntryGroup: NavItem[] = [];
  if (hasUserPanel) {
    if (canSeeBudgetModule) {
      jobEntryGroup.push({ key: 'entry', label: 'Entry', icon: Wallet, onClick: () => onGoToJobsTab('entry') });
      jobEntryGroup.push({ key: 'jobs', label: 'Jobs', icon: Briefcase, onClick: () => onGoToJobsTab('jobs') });
      jobEntryGroup.push({ key: 'entryDetails', label: 'Entry Details', icon: FileText, onClick: () => onGoToJobsTab('entryDetails') });
    }
    if (pepmOn && user.can_job_edit) {
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
  // Holding the Bill Claim ("conveyance") Admin module also brings your OWN
  // claims here (it used to be a separate "My Conveyance Bill Claim" page
  // under Claims/Bill/Disbursement).
  if ((hasUserPanel && user.can_view_conveyance_claims) || canSeeModule('conveyance')) {
    hrmClaimGroup.push({ key: 'userConveyanceClaims', label: 'Conveyance Bill Claim', icon: CreditCard, onClick: () => onGoToUserClaims('conveyanceBill') });
  }
  const hrmAttendanceGroup: NavItem[] = [];
  if (canSeeTimesheet) {
    hrmAttendanceGroup.push({ key: 'timesheet', label: 'Timesheet', icon: Clock, onClick: () => onGoToSelfServiceTab('timesheet') });
  }
  // "Leave Application" — the merged submit/review + own-balance interface
  // (LeaveReviewPage.tsx now shows both, see its own comment) — one single
  // menu item instead of the old separate "Leave Application" and "My
  // Leave" items, living inside "Leave Manage" alongside Leave Manage/Leave
  // Approvals. Gated by EITHER of the two old separate grants (an account
  // already holding just one of them keeps access to the merged page).
  const hrmLeaveGroup: NavItem[] = [];
  if (canSeeLeaveApplication || canSeeMyLeave) {
    hrmLeaveGroup.push({ key: 'leaveApplication', label: 'Leave Application', icon: CalendarClock, onClick: () => onGoToSelfServiceTab('leaveApplication') });
  }
  // "Leave Manage" (every account's balances, Year Settings, Balance
  // Workflows) is HR's work, so it lives in Admin Panel -> HRM -> Leave
  // (hrLeaveItems below). Approving a Leave Application happens in
  // "Approve Application", the one queue for everything waiting on you.
  const hrmSubGroups: { key: string; label: string; icon: React.ComponentType<{ className?: string }>; items: NavItem[] }[] = [
    { key: 'my_claim_bill', label: 'My Claim/Bill', icon: Wallet, items: hrmClaimGroup },
    { key: 'hrm_attendance', label: 'Attendance', icon: Clock, items: hrmAttendanceGroup },
    { key: 'hrm_leave_manage', label: 'Leave', icon: CalendarClock, items: hrmLeaveGroup },
  ].filter((g) => g.items.length > 0);

  const selfServiceItems: NavItem[] = [];
  // Chat (Direct/Group/Community messaging, ChatPanel.tsx) — NOT gated,
  // every signed-in account gets it, same as Employee Directory just below.
  selfServiceItems.push({ key: 'chat', label: 'Chat', icon: MessageSquare, onClick: onOpenChat });
  // Alerts (AlertsPage.tsx) — same visibility as Chat above: every
  // signed-in account, not gated behind any module grant.
  selfServiceItems.push({ key: 'alerts', label: 'Alerts', icon: Bell, onClick: onOpenAlerts });
  // 360 ERP SSO hand-off (Erp360SsoRoutes.ts) — same visibility as Chat/
  // Alerts above: every signed-in account, no module grant needed. No page
  // of its own; clicking it opens a new tab (or shows an error banner if
  // the server isn't configured / 360 ERP rejects the request).
  selfServiceItems.push({ key: 'erp360', label: '360 ERP', icon: ExternalLink, onClick: onOpenErp360 });
  // Company-wide roster, browsable by every account regardless of role or
  // Admin Panel module access (unlike Admin Panel -> Employees, which is
  // the HR-editing view gated behind the 'employees' module) — see
  // EmployeeDirectory.tsx / EmployeeDirectoryRoutes.ts.
  selfServiceItems.push({ key: 'employeeDirectory', label: 'Employee Directory', icon: Contact, onClick: () => onGoToSelfServiceTab('employeeDirectory') });
  // NOT Admin-gated — a Template Layer or a Leave Application's Reliever can
  // be ANY account, so every account gets this.
  selfServiceItems.push({ key: 'approveApplications', label: 'Approve Application', icon: ShieldCheck, onClick: () => onGoToSelfServiceTab('approveApplications') });
  // My Resignation (MyResignation.tsx) — NOT Admin-gated either: every
  // account can submit their own resignation (POST /api/exit-requests
  // already allows a plain account to submit for themselves, see that
  // route's own comment), regardless of whether they hold the
  // exit_offboarding module grant used by the management-side
  // ExitOffboardingPanel under Admin Panel -> HR Advanced.
  selfServiceItems.push({ key: 'resignation', label: 'My Resignation', icon: LogOut, onClick: () => onGoToSelfServiceTab('resignation') });
  // Asset Management (AssetManagement.tsx) — self-service My Assets/New
  // Requisition/Requisition Status, previously reachable only from Profile
  // -> Settings. NOT Admin-gated, same as Chat/Employee Directory/My
  // Resignation just above: any signed-in account can raise an asset
  // requisition for themselves, regardless of module_permissions.
  selfServiceItems.push({ key: 'assetManagement', label: 'My Asset', icon: Package, onClick: () => onGoToSelfServiceTab('assetManagement') });
  // Vehicle Requisition (VehicleManagement.tsx) — self-service "Book a
  // Ride"/Ride Status, same reasoning as My Asset just above: NOT
  // Admin-gated, any signed-in account can request a ride for themselves.
  selfServiceItems.push({ key: 'vehicleManagement', label: 'Book a Ride', icon: Car, onClick: () => onGoToSelfServiceTab('vehicleManagement') });
  // Grievance & Disciplinary (MyCases.tsx) — raise a grievance, and give
  // feedback on one that names you / is assigned to you, or on a
  // disciplinary action issued to you. Every account.
  selfServiceItems.push({ key: 'myCases', label: 'Grievance & Disciplinary', icon: Gavel, onClick: () => onGoToSelfServiceTab('myCases') });
  // My Letters & Service Record (MyLetters.tsx) — letters HR issued to this
  // account (view / download / acknowledge), certificate requests, and the
  // Employee's own service record. Every account.
  selfServiceItems.push({ key: 'myLetters', label: 'My Letters & Service Record', icon: FileText, onClick: () => onGoToSelfServiceTab('myLetters') });
  // Team Attendance (TeamAttendance.tsx) — only for accounts HR made the
  // supervisor (or backup) of a Site Attendance team.
  // My Tasks (MyTasks.tsx) — tasks given to me, requests to HR, a
  // department head's team tasks. Off until turned on in Module Access.
  if (isSuperAdmin || !!user.can_view_tasks || canSeeModule('task_management')) {
    selfServiceItems.push({ key: 'myTasks', label: 'My Tasks', icon: ListChecks, onClick: () => onGoToSelfServiceTab('myTasks') });
  }
  if (siteSupervisor.teams > 0) {
    selfServiceItems.push({ key: 'teamAttendance', label: 'Team Attendance', icon: ClipboardCheck, onClick: () => onGoToSelfServiceTab('teamAttendance') });
  }

  // "Admin Dashboard" — the HR-overview landing page (stat tiles, quick
  // view, charts, notices, leave balances). Every real role === 'admin' |
  // 'superadmin' account gets it automatically (their own home screen); a
  // plain 'user' role account only sees it once granted the 'admin_dashboard'
  // module (Admin Panel -> Users -> Module Access), same "Role
  // Permissiveness" pattern every other Admin Panel tab already follows —
  // see canSeeModule above.
  const isAdminRole = user.role === 'admin' || user.role === 'superadmin';
  const adminDashboardItem: NavItem | null = isAdminRole || canSeeModule('admin_dashboard')
    ? { key: 'admin_dashboard', label: 'Admin Dashboard', icon: LayoutDashboard, onClick: () => onGoToAdminModule('dashboard') }
    : null;
  // Reports & Insights — every operational report in one place; shown to
  // anyone holding at least one of the modules its reports come from.
  const reportsInsightsItem: NavItem | null = REPORTS_INSIGHTS_MODULES.some((m) => canSeeModule(m))
    ? { key: 'reports_insights', label: 'Reports & Insights', icon: PieChart, onClick: () => onGoToAdminModule('reports_insights') }
    : null;
  // Data Import — employees, leave, claims and attendance history from
  // Excel/CSV; shown to anyone holding at least one module it writes into.
  const dataImportItem: NavItem | null = DATA_IMPORT_MODULES.some((m) => canSeeModule(m))
    ? { key: 'data_import', label: 'HR Data Import', icon: FileUp, onClick: () => onGoToAdminModule('data_import') }
    : null;

  // "Admin Panel" — PEPM Management group (expandable) + flat items, same
  // grouping the old AdminSidebar used, each filtered by canSeeModule.
  // (Group label shown to the user is "PEPM Management"; internal names
  // kept as reportsGroup/reportsOpen to minimize diff.)
  const reportsGroup: NavItem[] = [
    { key: 'reports', label: 'Reports', icon: BarChart3, onClick: () => onGoToAdminModule('reports') },
    { key: 'mprs', label: 'MPR Nos', icon: FileText, onClick: () => onGoToAdminModule('mprs') },
    { key: 'imports', label: 'Data Import', icon: Upload, onClick: () => onGoToAdminModule('imports') },
    { key: 'recycle', label: 'Job Recycle', icon: Recycle, onClick: () => onGoToAdminModule('recycle') },
    { key: 'editlog', label: 'MPR Edit Log', icon: History, onClick: () => onGoToAdminModule('editlog') },
  ].filter((i) => pepmOn && canSeeModule(i.key as AdminModuleKey));

  // "Claims" — Movement Claims, Conveyance Bill Claim, Conveyance
  // Disbursement. No longer its own collapsible group — merged as flat
  // items into "HR" below.
  const claimsItems: NavItem[] = [
    { key: 'claims', label: 'Movement Claims', icon: Route, onClick: () => onGoToAdminClaims('claims') },
    { key: 'conveyance', label: 'Bill Claim', icon: CreditCard, onClick: () => onGoToAdminClaims('conveyance') },
    { key: 'disbursement', label: 'Bill Disbursement', icon: Banknote, onClick: () => onGoToAdminModule('disbursement') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));
  if (canSeeModule('conveyance')) {
    // "Bill Claim Policy" — rules for Bill Claims (limits, receipts, deadlines…).
    // Rides along with the 'conveyance' module like My Conveyance Bill Claim.
    claimsItems.push({
      key: 'bill_claim_policy',
      label: 'Bill Claim Policy',
      icon: ShieldCheck,
      onClick: () => onGoToAdminModule('bill_claim_policy')
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
  // Site Attendance (supervisor muster roll) lives inside Office Attendance
  // (SiteAttendanceAdmin.tsx) — same module grant, its own entry here.
  if (canSeeModule('office_attendance')) {
    attendanceItems.push({
      key: 'site_attendance',
      label: 'Site Attendance',
      icon: ClipboardCheck,
      onClick: () => {
        try {
          sessionStorage.setItem('office_att_view', 'site');
        } catch {
          // storage unavailable — opens on the device view
        }
        onGoToAdminModule('office_attendance');
        setTimeout(() => window.dispatchEvent(new CustomEvent('credence:office-att-view', { detail: 'site' })), 0);
      }
    });
  }

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
    { key: 'vehicle_management', label: 'Vehicle Management', icon: Car, onClick: () => onGoToAdminModule('vehicle_management') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // "HR" — approvals, notices, holidays, leave reporting, plus Departments
  // (from the dissolved Organization group) and every item from the
  // dissolved Claims/Attendance groups.
  const hrGroup: NavItem[] = [
    { key: 'approvals', label: 'Approval Chain', icon: ShieldCheck, onClick: () => onGoToAdminModule('approvals') },
    { key: 'notices', label: 'Notices', icon: Bell, onClick: () => onGoToAdminModule('notices') },
    { key: 'holidays', label: 'Holidays', icon: Calendar, onClick: () => onGoToAdminModule('holidays') },
    { key: 'task_management', label: 'Task Management', icon: ClipboardList, onClick: () => onGoToAdminModule('task_management') },
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

  // "Payroll" — moved here from Self Service's "My HR" group: same
  // permission-gated PayrollModule.tsx/PayrollRoutes.ts feature (a
  // Superadmin always sees it via canSeeModule, everyone else only once
  // granted the 'payroll' module via Admin Panel -> Users -> Module
  // Access), just reached from Admin Panel -> HRM now instead of Self
  // Service. Still routes through onGoToSelfServiceTab('payroll') — the
  // page itself (App.tsx's selfServiceView === 'payroll') isn't part of
  // AdminPanel's own tab system, so this is only a menu-location change.
  const hrPayrollGroup: NavItem[] = [];
  if (canSeeModule('payroll')) {
    hrPayrollGroup.push({ key: 'payroll', label: 'Payroll', icon: Banknote, onClick: () => onGoToSelfServiceTab('payroll') });
  }

  // "HR Operations" (HROperationsPanel.tsx) — one 'hr_operations' module
  // grant; each item opens that page on its own tab (the panel listens for
  // the tab event, and reads the stored tab when it mounts fresh).
  const openHrOps = (tab: string) => {
    try {
      sessionStorage.setItem('hr_ops_tab', tab);
    } catch {
      // storage unavailable — the panel just opens on its default tab
    }
    onGoToAdminModule('hr_operations');
    setTimeout(() => window.dispatchEvent(new CustomEvent('credence:hr-ops-tab', { detail: tab })), 0);
  };
  const hrOperationsItems: NavItem[] = canSeeModule('hr_operations')
    ? [
        { key: 'hr_operations', label: 'Monthly Report', icon: BarChart3, onClick: () => openHrOps('dashboard') },
        { key: 'hr_operations_actions', label: 'Personnel Actions', icon: ClipboardList, onClick: () => openHrOps('actions') },
        { key: 'hr_operations_service_book', label: 'Service Book', icon: BookOpen, onClick: () => openHrOps('service_book') },
        { key: 'hr_operations_letters', label: 'Letters', icon: FileText, onClick: () => openHrOps('letters') },
        { key: 'hr_operations_onboarding', label: 'Onboarding', icon: ClipboardCheck, onClick: () => openHrOps('onboarding') },
        { key: 'hr_operations_increments', label: 'Increments', icon: TrendingUp, onClick: () => openHrOps('increments') },
        { key: 'hr_operations_reports', label: 'Employee Reports', icon: FileSpreadsheet, onClick: () => openHrOps('reports') },
        { key: 'hr_operations_settings', label: 'HR Ops Settings', icon: Settings, onClick: () => openHrOps('settings') },
      ]
    : [];

  // "Leave" — every account's Leave Applications (the 'leave_applications'
  // module) and "Leave Manage" (balances, Year Settings, Balance Workflows;
  // a Superadmin or anyone granted can_manage_leave). Leave Manage still
  // opens through onGoToSelfServiceTab like Payroll above — only its menu
  // moved here from Self Service.
  const hrLeaveItems: NavItem[] = [
    ...(canSeeModule('leave_applications')
      ? [{ key: 'leave_applications', label: 'Leave Applications', icon: CalendarClock, onClick: () => onGoToAdminModule('leave_applications') }]
      : []),
    ...(canManageLeave ? [{ key: 'leaveManagement', label: 'Leave Manage', icon: ListChecks, onClick: () => onGoToSelfServiceTab('leaveManagement') }] : []),
  ];

  const hrSubGroups: { key: string; label: string; icon: React.ComponentType<{ className?: string }>; items: NavItem[] }[] = [
    { key: 'hr_operations', label: 'HR Operations', icon: Briefcase, items: hrOperationsItems },
    { key: 'hr_leave', label: 'Leave', icon: CalendarClock, items: hrLeaveItems },
    { key: 'hr_attendance', label: 'Attendance', icon: Fingerprint, items: attendanceItems },
    { key: 'hr_claims_bill', label: 'Claims/Bill/Disbursement', icon: CreditCard, items: claimsItems },
    { key: 'hr_employee', label: 'Employee', icon: Contact, items: employeeItems },
    { key: 'hr_payroll', label: 'Payroll', icon: Banknote, items: hrPayrollGroup },
    { key: 'hr_advanced', label: 'HR Advanced', icon: Sparkles, items: hrAdvancedItems },
  ].filter((g) => g.items.length > 0);

  // "MIS" — Users, plus Projects/Branches (from the dissolved Organization
  // group). Everything here keeps its normal canSeeModule gate.
  const misGroup: NavItem[] = [
    { key: 'users', label: 'Users', icon: Users, onClick: () => onGoToAdminModule('users') },
    ...orgItems,
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // Not part of MIS — Superadmin-only, but not "Users management", so kept
  // as its own flat item like before.
  const adminFlatItems: NavItem[] = [];
  if (isSuperAdmin) {
    // Multi-company (SystemCompanies.tsx) — Superadmin-only, like the log below.
    adminFlatItems.push({ key: 'companies', label: 'Companies', icon: Building2, onClick: () => onGoToAdminModule('companies') });
    // Which phone each account may use the app on (DeviceAccess.tsx).
    adminFlatItems.push({ key: 'devices', label: 'Device Access', icon: Smartphone, onClick: () => onGoToAdminModule('devices') });
    // Who is signed in right now, with IP and device (ActiveUsers.tsx).
    adminFlatItems.push({ key: 'active_users', label: 'Active Users', icon: Activity, onClick: () => onGoToAdminModule('active_users') });
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


  // ---- How the menu is laid out ---------------------------------------
  // Every item above keeps its own permission gate; this only decides which
  // group it sits in. Self Service: Work & Approvals, PEPM Operation, Leave &
  // Attendance, Requests & Claims, Others. Admin Panel: the three dashboards
  // on show, then Employee Management, Attendance & Leave, Payroll & Claims,
  // HR Operations, Settings & Administration, PEPM Management. A
  // { heading } entry is a small title inside a group (dropped when nothing
  // follows it).
  type Entry = NavItem | { heading: string };
  interface MenuGroup {
    key: string;
    label: string;
    icon: React.ComponentType<{ className?: string }>;
    entries: Entry[];
  }
  const allItems: NavItem[] = [
    ...jobEntryGroup,
    ...hrmSubGroups.flatMap((g) => g.items),
    ...selfServiceItems,
    ...(adminDashboardItem ? [adminDashboardItem] : []),
    ...(reportsInsightsItem ? [reportsInsightsItem] : []),
    ...(dataImportItem ? [dataImportItem] : []),
    ...reportsGroup,
    ...hrGroup,
    ...hrSubGroups.flatMap((g) => g.items),
    ...misGroup,
    ...adminFlatItems
  ];
  const itemByKey = new Map<string, NavItem>(allItems.map((i) => [i.key, i]));
  const pick = (...keys: (string | { heading: string })[]): Entry[] => {
    const out: Entry[] = [];
    for (const k of keys) {
      if (typeof k !== 'string') out.push(k);
      else if (itemByKey.has(k)) out.push(itemByKey.get(k)!);
    }
    // Drop headings with nothing under them.
    return out.filter((e, i) => !('heading' in e) || (i + 1 < out.length && !('heading' in out[i + 1])));
  };
  const isItem = (e: Entry): e is NavItem => !('heading' in e);
  const makeGroups = (list: MenuGroup[]) => list.filter((g) => g.entries.some(isItem));
  const selfGroups = makeGroups([
    { key: 'g_work', label: 'Work & Approvals', icon: ListChecks, entries: pick('myTasks', 'approveApplications', 'teamAttendance') },
    { key: 'g_pepm_op', label: 'PEPM Operation', icon: Briefcase, entries: pick('entry', 'jobs', 'entryDetails', 'jobEdit') },
    { key: 'g_leave_att', label: 'Leave & Attendance', icon: CalendarClock, entries: pick('leaveApplication', 'timesheet') },
    { key: 'g_requests', label: 'Requests & Claims', icon: Wallet, entries: pick('userMovementClaims', 'userConveyanceClaims', 'vehicleManagement', 'assetManagement', 'myLetters') },
    { key: 'g_others', label: 'Others', icon: Users2, entries: pick('chat', 'alerts', 'erp360', 'employeeDirectory', 'myCases', 'resignation') }
  ]);
  const hrAnalyticsItem = itemByKey.get('hr_analytics') || null;
  const adminTopItems: NavItem[] = [adminDashboardItem, reportsInsightsItem, hrAnalyticsItem].filter((i): i is NavItem => !!i);
  const adminGroups = makeGroups([
    {
      key: 'g_employees',
      label: 'Employee Management',
      icon: Contact,
      entries: pick('employees', 'departments', 'tracking', 'recruitment', 'performance_management', 'exit_offboarding', 'grievance_disciplinary', 'document_vault')
    },
    {
      key: 'g_attendance',
      label: 'Attendance & Leave',
      icon: Fingerprint,
      entries: pick('attendance', 'office_attendance', 'site_attendance', 'attendance_reports', 'leave_applications', 'leaveManagement', 'holidays')
    },
    { key: 'g_payroll', label: 'Payroll & Claims', icon: Banknote, entries: pick('payroll', 'claims', 'conveyance', 'disbursement', 'bill_claim_policy') },
    {
      key: 'g_hr_ops',
      label: 'HR Operations',
      icon: Briefcase,
      entries: pick(
        { heading: 'Daily' }, 'task_management', 'notices', 'approvals',
        { heading: 'Employee records' }, 'hr_operations_actions', 'hr_operations_letters', 'hr_operations_service_book', 'hr_operations_onboarding', 'hr_operations_increments',
        { heading: 'Reports' }, 'hr_operations_reports', 'hr_operations',
        { heading: 'Facilities' }, 'asset_management', 'vehicle_management',
        { heading: 'Settings' }, 'hr_operations_settings'
      )
    },
    {
      key: 'g_settings',
      label: 'Settings & Administration',
      icon: Server,
      entries: pick('users', 'projects', 'branches', 'companies', 'devices', 'active_users', 'data_import', 'permanent_delete_log')
    },
    { key: 'g_pepm', label: 'PEPM Management', icon: BarChart3, entries: pick('reports', 'mprs', 'imports', 'recycle', 'editlog') }
  ]);
  const allGroups = [...selfGroups, ...adminGroups];
  // Which group an item lives in (search shows it beside the name).
  const groupLabelOf = new Map<string, string>();
  for (const g of allGroups) for (const e of g.entries) if (isItem(e)) groupLabelOf.set(e.key, g.label);
  for (const i of adminTopItems) groupLabelOf.set(i.key, 'Admin Panel');

  // The group holding the page on screen opens by itself, so its highlight
  // is never hidden.
  useEffect(() => {
    if (!activeKey) return;
    const g = allGroups.find((x) => x.entries.some((e) => isItem(e) && e.key === activeKey));
    if (g) setOpenGroup(g.key);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeKey]);

  // Favourites: up to four shortcuts at the top, chosen per account (kept in
  // this browser). Defaults to the most used pages this account can open.
  const favStoreKey = `gsidebar_favs_${user.id}`;
  const [favKeys, setFavKeys] = useState<string[] | null>(() => {
    try {
      const v = localStorage.getItem(favStoreKey);
      return v ? (JSON.parse(v) as string[]) : null;
    } catch {
      return null;
    }
  });
  const defaultFavs = (isAdminRole
    ? ['myTasks', 'approveApplications', 'userMovementClaims', 'employees', 'admin_dashboard', 'leaveApplication']
    : ['myTasks', 'userMovementClaims', 'leaveApplication', 'vehicleManagement', 'approveApplications', 'assetManagement']
  ).filter((k) => itemByKey.has(k));
  const favItems = (favKeys || defaultFavs).map((k) => itemByKey.get(k)).filter((i): i is NavItem => !!i).slice(0, 4);
  const saveFavs = (keys: string[]) => {
    setFavKeys(keys);
    try {
      localStorage.setItem(favStoreKey, JSON.stringify(keys));
    } catch {
      // storage unavailable — kept for this session only
    }
  };
  const toggleFav = (key: string) => {
    const cur = favItems.map((i) => i.key);
    if (cur.includes(key)) saveFavs(cur.filter((k) => k !== key));
    else if (cur.length < 4) saveFavs([...cur, key]);
  };

  // Sidebar-wide menu search — flattens every item this account can actually
  // see (Dashboard + Main + Self Service + every Admin Panel group/flat item)
  // into one searchable list, so a menu buried a few groups deep is still one
  // search away instead of needing to expand each group to find it. Hidden
  // while the desktop column is minimized (collapsed) — no room for typed
  // input there, same as every other label in that mode.
  const [sidebarSearch, setSidebarSearch] = useState('');
  const dashboardSearchItem: NavItem = { key: 'dashboard', label: 'Dashboard', icon: Home, onClick: onGoToDashboard };
  const allSearchableItems: NavItem[] = [dashboardSearchItem, ...adminTopItems, ...allGroups.flatMap((g) => g.entries.filter(isItem))];
  const searchQuery = sidebarSearch.trim().toLowerCase();
  const searchResults = searchQuery ? allSearchableItems.filter((i) => i.label.toLowerCase().includes(searchQuery)) : [];
  const selectSearchResult = (fn: () => void) => {
    setSidebarSearch('');
    setSearchActiveIndex(-1);
    selectAndClose(fn);
  };

  // Keyboard nav for the search results dropdown: Up/Down moves a highlighted
  // row (wrapping at each end), Enter opens whichever row is highlighted
  // (falling back to the first result if the user hasn't pressed an arrow
  // key yet), Escape clears the search. Reset back to "nothing highlighted"
  // any time the query itself changes, since the old index may no longer
  // point at a matching row.
  const [searchActiveIndex, setSearchActiveIndex] = useState(-1);
  const searchActiveItemRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    setSearchActiveIndex(-1);
  }, [searchQuery]);
  useEffect(() => {
    searchActiveItemRef.current?.scrollIntoView({ block: 'nearest' });
  }, [searchActiveIndex]);
  const handleSearchKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!searchQuery || searchResults.length === 0) return;
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setSearchActiveIndex((i) => (i + 1) % searchResults.length);
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setSearchActiveIndex((i) => (i <= 0 ? searchResults.length - 1 : i - 1));
    } else if (e.key === 'Enter') {
      e.preventDefault();
      const item = searchResults[searchActiveIndex >= 0 ? searchActiveIndex : 0];
      if (item) selectSearchResult(item.onClick);
    } else if (e.key === 'Escape') {
      setSidebarSearch('');
      setSearchActiveIndex(-1);
    }
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

  // One group: header (tap to open/close; one open at a time) and its items.
  // While the column is minimized it's a single icon that opens the group as
  // a popup beside it (see the flyout below).
  const renderMenuGroup = (g: MenuGroup) => {
    const items = g.entries.filter(isItem);
    const groupActive = items.some((i) => i.key === activeKey);
    const GroupIcon = g.icon;
    if (collapsed) {
      return (
        <button
          key={g.key}
          type="button"
          title={g.label}
          aria-label={g.label}
          onClick={(e) => {
            if (flyout?.key === g.key) return setFlyout(null);
            const r = (e.currentTarget as HTMLElement).getBoundingClientRect();
            const asideRight = (e.currentTarget.closest('aside') as HTMLElement | null)?.getBoundingClientRect().right ?? r.right;
            setFlyout({ key: g.key, top: r.top, bottom: r.bottom, left: asideRight + 8 });
          }}
          className={`w-full flex items-center justify-center rounded-xl px-0 py-2.5 transition-colors ${
            groupActive || flyout?.key === g.key ? 'bg-white/15 text-white shadow-sm' : 'text-white/85 hover:bg-white/10'
          }`}
        >
          <GroupIcon className="w-[18px] h-[18px] shrink-0" />
        </button>
      );
    }
    const isOpen = openGroup === g.key;
    return (
      <div key={g.key}>
        <button
          type="button"
          onClick={() => setOpenGroup(isOpen ? null : g.key)}
          aria-expanded={isOpen}
          className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 transition-colors ${
            groupActive || isOpen ? 'bg-white/10 text-white' : 'text-white/85 hover:bg-white/10'
          }`}
        >
          <GroupIcon className="w-[18px] h-[18px] shrink-0" />
          <span className={`text-[13px] flex-1 text-left truncate ${groupActive ? 'font-bold' : 'font-semibold'}`}>{g.label}</span>
          {isOpen ? (
            <ChevronDown className="w-3.5 h-3.5 shrink-0 rotate-180 transition-transform duration-200" />
          ) : (
            <span className="text-[10.5px] font-semibold px-1.5 rounded-full bg-white/15 text-white/80">{items.length}</span>
          )}
        </button>
        {isOpen && (
          <div className="mt-0.5 ml-[13px] pl-3.5 border-l border-white/15 space-y-0.5">{renderEntries(g.entries)}</div>
        )}
      </div>
    );
  };

  // A group's items (and small headings), as rows.
  const renderEntries = (entries: Entry[], onPicked?: () => void) =>
    entries.map((e, idx) => {
      if (!isItem(e)) {
        return (
          <p key={`h-${idx}`} className="px-2.5 pt-2.5 pb-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-white/45">
            {e.heading}
          </p>
        );
      }
      const active = e.key === activeKey;
      return (
        <button
          key={e.key}
          type="button"
          onClick={() => {
            onPicked?.();
            selectAndClose(e.onClick);
          }}
          className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
            active ? 'bg-white/15 text-white font-semibold' : 'text-white/75 hover:bg-white/10 hover:text-white'
          }`}
        >
          <e.icon className="w-3.5 h-3.5 shrink-0" />
          <span className="text-[12.5px] truncate">{e.label}</span>
        </button>
      );
    });

  // Minimized column: the open group's popup, beside its icon.
  const flyGroup = flyout ? allGroups.find((g) => g.key === flyout.key) || null : null;
  useEffect(() => {
    if (!flyout) return;
    const onDown = (e: MouseEvent) => {
      const t = e.target as HTMLElement;
      if (!t.closest('[data-gsidebar-flyout]') && !t.closest('aside')) setFlyout(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setFlyout(null);
    };
    document.addEventListener('mousedown', onDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [flyout]);
  useEffect(() => {
    if (!collapsed) setFlyout(null);
  }, [collapsed]);

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
                    onKeyDown={handleSearchKeyDown}
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
                      searchResults.map((item, idx) => (
                        <button
                          key={item.key}
                          type="button"
                          ref={idx === searchActiveIndex ? searchActiveItemRef : undefined}
                          onClick={() => selectSearchResult(item.onClick)}
                          onMouseEnter={() => setSearchActiveIndex(idx)}
                          className={`w-full flex items-center gap-2.5 px-3 py-2 text-left transition-colors ${
                            idx === searchActiveIndex ? 'bg-white/15 text-white' : 'text-white/85 hover:bg-white/10'
                          }`}
                        >
                          <item.icon className="w-4 h-4 shrink-0" />
                          <span className="text-[13px] truncate">{item.label}</span>
                          {groupLabelOf.get(item.key) && (
                            <span className="ml-auto pl-2 text-[10px] text-white/45 whitespace-nowrap">{groupLabelOf.get(item.key)}</span>
                          )}
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

          {/* Favourites — up to four shortcuts, chosen with the pencil. */}
          {!collapsed && (favItems.length > 0 || editingFavs) && (
            <>
              <div className="flex items-center justify-between px-2.5 mt-3 mb-1.5">
                <span className="text-[10px] font-semibold tracking-wide text-white/50">FAVOURITES</span>
                <button
                  type="button"
                  onClick={() => setEditingFavs((v) => !v)}
                  className="text-white/50 hover:text-white p-0.5 rounded"
                  aria-label={editingFavs ? 'Done choosing favourites' : 'Choose favourites'}
                  title={editingFavs ? 'Done' : 'Choose favourites (up to 4)'}
                >
                  {editingFavs ? <Check className="w-3.5 h-3.5" /> : <Pencil className="w-3 h-3" />}
                </button>
              </div>
              {editingFavs ? (
                <div className="rounded-xl bg-black/15 p-1.5 max-h-64 overflow-y-auto">
                  <p className="px-2 pb-1 text-[10.5px] text-white/55">Pick up to 4 ({favItems.length}/4)</p>
                  {[...adminTopItems, ...allGroups.flatMap((g) => g.entries.filter(isItem))]
                    .filter((i, idx, arr) => arr.findIndex((x) => x.key === i.key) === idx)
                    .map((i) => {
                      const on = favItems.some((f) => f.key === i.key);
                      return (
                        <label key={i.key} className="flex items-center gap-2 px-2 py-1.5 rounded-lg text-[12px] text-white/85 hover:bg-white/10 cursor-pointer">
                          <input type="checkbox" checked={on} disabled={!on && favItems.length >= 4} onChange={() => toggleFav(i.key)} className="accent-white" />
                          <i.icon className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{i.label}</span>
                        </label>
                      );
                    })}
                </div>
              ) : (
                <div className="grid grid-cols-4 gap-1.5">
                  {favItems.map((i) => (
                    <button
                      key={i.key}
                      type="button"
                      title={i.label}
                      onClick={() => selectAndClose(i.onClick)}
                      className={`flex flex-col items-center gap-1 rounded-xl px-1 py-2 text-[10px] leading-tight text-center transition-colors ${
                        i.key === activeKey ? 'bg-white/25 text-white' : 'bg-white/10 text-white/85 hover:bg-white/20'
                      }`}
                    >
                      <i.icon className="w-[18px] h-[18px]" />
                      <span className="line-clamp-2">{i.label.replace(' Application', '')}</span>
                    </button>
                  ))}
                </div>
              )}
            </>
          )}

          {selfGroups.length > 0 &&
            (collapsed ? (
              <div className="h-px mx-2 my-2 bg-white/15" />
            ) : (
              <p className="px-2.5 mt-3 mb-1.5 text-[10px] font-semibold tracking-wide text-white/50">SELF SERVICE</p>
            ))}
          {selfGroups.map(renderMenuGroup)}

          {(adminTopItems.length > 0 || adminGroups.length > 0) && (
            <>
              {collapsed ? (
                <div className="h-px mx-2 my-2 bg-white/15" />
              ) : (
                <p className="px-2.5 mt-3 mb-1.5 text-[10px] font-semibold tracking-wide text-white/50">ADMIN PANEL</p>
              )}
              {adminTopItems.map(renderItem)}
              {adminGroups.map(renderMenuGroup)}
            </>
          )}

        </nav>

        <div className="p-3 pb-[calc(var(--native-safe-area-inset-bottom,env(safe-area-inset-bottom,0px))+12px)] space-y-2">
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

      {collapsed && flyGroup && flyout &&
        createPortal(
          <div
            data-gsidebar-flyout
            className="fixed z-[1300] w-[250px] max-h-[70vh] overflow-y-auto rounded-2xl p-2 shadow-2xl border border-white/15"
            style={{
              // Opens downward from its icon in the top half of the screen,
              // upward in the bottom half, so it always fits.
              ...(flyout.top < window.innerHeight / 2 ? { top: Math.max(8, flyout.top - 6) } : { bottom: Math.max(8, window.innerHeight - flyout.bottom - 6) }),
              left: flyout.left,
              background: '#3a0d70'
            }}
            role="menu"
            aria-label={flyGroup.label}
          >
            <p className="flex items-center gap-2 px-2 pt-1 pb-1.5 text-[10.5px] font-semibold uppercase tracking-wider text-white/55">
              <flyGroup.icon className="w-3.5 h-3.5" /> {flyGroup.label}
            </p>
            <div className="space-y-0.5">{renderEntries(flyGroup.entries, () => setFlyout(null))}</div>
          </div>,
          document.body
        )}
    </div>
  );
};