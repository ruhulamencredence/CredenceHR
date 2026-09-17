import React, { useState } from 'react';
import {
  X, LogOut, Home, Wallet, Briefcase, FileText, Edit2, Route, CreditCard,
  CalendarClock, ListChecks, CheckSquare, ChevronDown, Building2, Users, Users2,
  BarChart3, Upload, History, Recycle, Navigation, Bell, ShieldCheck,
  Contact, Calendar, Clock, Fingerprint, Banknote, Package, LayoutDashboard, Server, MessageSquare,
  ChevronsLeft, ChevronsRight, ShieldAlert,
} from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { User, AdminModuleKey } from '../types';
import credenceLogo from '../assets/credence-logo.png';
import { useProfilePhoto } from '../lib/useProfilePhoto';
import { ServerSwitcherModal } from './ServerSwitcherModal';

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
  // 'conveyance' in claimsGroup, gated on the same 'conveyance' grant.
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
  onGoToSelfServiceTab, onGoToAdminClaims, onGoToAdminModule, onOpenProfile, onOpenChat,
}) => {
  const isPersistent = variant === 'persistent';
  const [reportsOpen, setReportsOpen] = useState(true);
  const [claimsOpen, setClaimsOpen] = useState(true);
  const [attendanceOpen, setAttendanceOpen] = useState(true);
  const [orgOpen, setOrgOpen] = useState(true);
  const [workforceOpen, setWorkforceOpen] = useState(true);
  const [hrOpen, setHrOpen] = useState(true);
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
  // gates the Entry/Jobs/Entry Details items in mainItems just below (Job
  // Edits stays on its own separate user.can_job_edit gate, and the Movement/
  // Conveyance Claims items further down keep their own OFF-by-default gates).
  const canSeeBudgetModule = isSuperAdmin || user.can_view_budget_module !== false;

  // Per-module visibility — mirrors AdminPanel.tsx's own `canSee` (Superadmin
  // sees every module; everyone else only the ones explicitly granted).
  const canSeeModule = (key: AdminModuleKey) => isSuperAdmin || (user.module_permissions || []).includes(key);

  const selectAndClose = (fn: () => void) => {
    fn();
    onClose();
  };

  // "Main" — User Panel's own workflow, this account's identity as an
  // employee rather than an admin reviewer.
  const mainItems: NavItem[] = [];
  if (hasUserPanel) {
    if (canSeeBudgetModule) {
      mainItems.push({ key: 'entry', label: 'Entry', icon: Wallet, onClick: () => onGoToJobsTab('entry') });
      mainItems.push({ key: 'jobs', label: 'Jobs', icon: Briefcase, onClick: () => onGoToJobsTab('jobs') });
      mainItems.push({ key: 'entryDetails', label: 'Entry Details', icon: FileText, onClick: () => onGoToJobsTab('entryDetails') });
    }
    if (user.can_job_edit) {
      mainItems.push({ key: 'jobEdit', label: 'Job Edits', icon: Edit2, onClick: () => onGoToJobsTab('jobEdit') });
    }
  }
  if (hasUserPanel && user.can_view_movement_claims) {
    mainItems.push({ key: 'userMovementClaims', label: 'Movement Claims', icon: Route, onClick: () => onGoToUserClaims('movementClaims') });
  }
  if (hasUserPanel && user.can_view_conveyance_claims) {
    mainItems.push({ key: 'userConveyanceClaims', label: 'Conveyance Bill Claim', icon: CreditCard, onClick: () => onGoToUserClaims('conveyanceBill') });
  }

  // "Self Service" — everyday employee items. Employee Directory stays
  // ungated for every account (company-wide roster); Timesheet/Leave
  // Application/My Leave are gated the same way as Movement Claim/
  // Conveyance Bill Claim below — OFF by default, granted per account via
  // Admin Panel -> Users -> Module Access.
  const canSeeTimesheet = isSuperAdmin || !!user.can_view_timesheet;
  const canSeeLeaveApplication = isSuperAdmin || !!user.can_view_leave_application;
  const canSeeMyLeave = isSuperAdmin || !!user.can_view_my_leave;
  const selfServiceItems: NavItem[] = [];
  if (canSeeTimesheet) {
    selfServiceItems.push({ key: 'timesheet', label: 'Timesheet', icon: Clock, onClick: () => onGoToSelfServiceTab('timesheet') });
  }
  if (canSeeLeaveApplication) {
    selfServiceItems.push({ key: 'leaveApplication', label: 'Leave Application', icon: CalendarClock, onClick: () => onGoToSelfServiceTab('leaveApplication') });
  }
  // Always visible to every account — only ever shows THIS account's own
  // Leave balance, read-only (see MyLeave.tsx). Distinct from "Leave
  // Manage" below, which is gated and shows/edits every account's balance.
  if (canSeeMyLeave) {
    selfServiceItems.push({ key: 'myLeave', label: 'My Leave', icon: ListChecks, onClick: () => onGoToSelfServiceTab('myLeave') });
  }
  // Chat (Direct/Group/Community messaging, ChatPanel.tsx) — NOT gated,
  // every signed-in account gets it, same as Employee Directory just below.
  selfServiceItems.push({ key: 'chat', label: 'Chat', icon: MessageSquare, onClick: onOpenChat });
  // Company-wide roster, browsable by every account regardless of role or
  // Admin Panel module access (unlike Admin Panel -> Employees, which is
  // the HR-editing view gated behind the 'employees' module) — see
  // EmployeeDirectory.tsx / EmployeeDirectoryRoutes.ts.
  selfServiceItems.push({ key: 'employeeDirectory', label: 'Employee Directory', icon: Contact, onClick: () => onGoToSelfServiceTab('employeeDirectory') });
  // "Payroll" — Coming Soon placeholder (PayrollModule.tsx/PayrollRoutes.ts),
  // but permission-gated like every other module from the start: a
  // Superadmin always sees it (canSeeModule), everyone else only once
  // explicitly granted the 'payroll' module via Admin Panel -> Users ->
  // Module Access. GET /api/payroll/status enforces the same gate
  // server-side (requireModule('payroll')), so this is real access control,
  // not just a hidden menu item.
  if (canSeeModule('payroll')) {
    selfServiceItems.push({ key: 'payroll', label: 'Payroll', icon: Banknote, onClick: () => onGoToSelfServiceTab('payroll') });
  }
  // "Leave Manage" — same access as LeaveManage.tsx's own canManageAll check
  // (a Superadmin, or any Admin/User the Superadmin has granted
  // can_manage_leave to via Admin Panel -> Users -> Module Access -> "Also
  // allow editing Leave balances"). Everyone else never sees this item at
  // all — same "Set Balance in Bulk" access as before, just its own page/
  // menu entry now instead of living inside the "My Leave" page.
  const canManageLeave = user.role === 'superadmin' || !!user.can_manage_leave;
  if (canManageLeave) {
    selfServiceItems.push({ key: 'leaveManagement', label: 'Leave Manage', icon: ListChecks, onClick: () => onGoToSelfServiceTab('leaveManagement') });
  }
  if (user.role === 'admin' || user.role === 'superadmin') {
    selfServiceItems.push({ key: 'leaveApprovals', label: 'Leave Approvals', icon: CheckSquare, onClick: () => onGoToSelfServiceTab('leaveApprovals') });
  }
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

  // "Claims" group (expandable, same pattern as Reports above) — was three
  // separate flat items (Movement Claims, Conveyance Bill Claim, Conveyance
  // Disbursement); grouped under one collapsible header now that there are
  // three of them, instead of each sitting loose in the flat admin list.
  const claimsGroup: NavItem[] = [
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
    claimsGroup.push({
      key: 'my_conveyance',
      label: 'My Conveyance Bill Claim',
      icon: Wallet,
      onClick: () => onGoToAdminModule('my_conveyance')
    });
  }

  // "Attendance" group (expandable, same pattern as Claims above) — was
  // three separate flat items (Remote Attendance, Monthly Attendance Report,
  // Office Attendance); grouped under one collapsible header now that there
  // are three of them, instead of each sitting loose in the flat admin list.
  const attendanceGroup: NavItem[] = [
    { key: 'attendance', label: 'Remote Attendance', icon: Navigation, onClick: () => onGoToAdminModule('attendance') },
    { key: 'attendance_reports', label: 'Monthly Attendance Report', icon: Calendar, onClick: () => onGoToAdminModule('attendance_reports') },
    { key: 'office_attendance', label: 'Office Attendance', icon: Fingerprint, onClick: () => onGoToAdminModule('office_attendance') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // The rest of the Admin Panel's modules, grouped into categories (same
  // collapsible-group pattern as PEPM Manage/Claims/Attendance above)
  // instead of one long flat list — easier to scan once "Employees",
  // "Departments", "Notices" etc. all sit loose together.

  // "Organization" — company structure/setup.
  const orgGroup: NavItem[] = [
    { key: 'projects', label: 'Projects', icon: Building2, onClick: () => onGoToAdminModule('projects') },
    { key: 'branches', label: 'Branches', icon: Building2, onClick: () => onGoToAdminModule('branches') },
    { key: 'departments', label: 'Departments', icon: Users2, onClick: () => onGoToAdminModule('departments') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // "Workforce" — people + what's assigned/tracked against them.
  const workforceGroup: NavItem[] = [
    { key: 'users', label: 'Users', icon: Users, onClick: () => onGoToAdminModule('users') },
    { key: 'employees', label: 'Employees', icon: Contact, onClick: () => onGoToAdminModule('employees') },
    { key: 'tracking', label: 'Employee Tracking', icon: Navigation, onClick: () => onGoToAdminModule('tracking') },
    { key: 'asset_management', label: 'Asset Management', icon: Package, onClick: () => onGoToAdminModule('asset_management') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // "HR" — approvals, notices, holidays, leave reporting.
  const hrGroup: NavItem[] = [
    { key: 'approvals', label: 'Approvals', icon: ShieldCheck, onClick: () => onGoToAdminModule('approvals') },
    { key: 'notices', label: 'Notices', icon: Bell, onClick: () => onGoToAdminModule('notices') },
    { key: 'holidays', label: 'Holidays', icon: Calendar, onClick: () => onGoToAdminModule('holidays') },
    // Read-only "who applied for Leave" report, gated by its own
    // 'leave_applications' module (separate from can_manage_leave's "Leave
    // Manage" item and from the "Leave Approvals" item above) — see
    // ADMIN_MODULES in types.ts.
    { key: 'leave_applications', label: 'Monthly Leave Application', icon: CalendarClock, onClick: () => onGoToAdminModule('leave_applications') },
  ].filter((i) => canSeeModule(i.key as AdminModuleKey));

  // "Servers" — Admin Panel tab (full catalog CRUD), Superadmin-only on any
  // platform (this is the WEB-oriented management surface — see
  // ServerProfilesPanel.tsx). Not a grantable module_permissions item like
  // the groups above (canSeeModule wouldn't apply), so kept as its own flat
  // item, gated directly on isSuperAdmin.
  const adminFlatItems: NavItem[] = [];
  if (isSuperAdmin) {
    adminFlatItems.push({
      key: 'servers',
      label: 'Servers',
      icon: Server,
      onClick: () => onGoToAdminModule('servers'),
    });
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

  const renderItem = (item: NavItem) => (
    <button
      key={item.key}
      type="button"
      title={collapsed ? item.label : undefined}
      onClick={() => selectAndClose(item.onClick)}
      className={`w-full flex items-center rounded-xl text-white/85 hover:bg-white/10 transition-colors ${
        collapsed ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2.5'
      }`}
    >
      <item.icon className="w-[18px] h-[18px] shrink-0" />
      {!collapsed && <span className="text-[13px] font-medium truncate">{item.label}</span>}
    </button>
  );

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
    return (
      <div key={label}>
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          className="w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 text-white/85 hover:bg-white/10 transition-colors"
        >
          <GroupIcon className="w-[18px] h-[18px] shrink-0" />
          <span className="text-[13px] font-semibold flex-1 text-left">{label}</span>
          <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${isOpen ? 'rotate-180' : ''}`} />
        </button>
        {isOpen && (
          <div className="mt-0.5 ml-[13px] pl-3.5 border-l border-white/15 space-y-0.5">
            {items.map((item) => (
              <button
                key={item.key}
                type="button"
                onClick={() => selectAndClose(item.onClick)}
                className="w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-white/70 hover:bg-white/10 hover:text-white transition-colors"
              >
                <item.icon className="w-3.5 h-3.5 shrink-0" />
                <span className="text-[12.5px] truncate">{item.label}</span>
              </button>
            ))}
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
          paddingTop: isPersistent ? undefined : 'env(safe-area-inset-top, 0px)',
        }}
      >
        {!isPersistent && (
          <button
            type="button"
            onClick={onClose}
            className="absolute right-3 w-7 h-7 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            style={{ top: 'calc(env(safe-area-inset-top, 0px) + 12px)' }}
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

        {/* Minimize/expand toggle — persistent (desktop) variant only. Shrinks
            the column down to a slim icon rail (labels/section headers
            hidden, collapsible groups fall back to a flat icon list — see
            renderGroup) so the main content gets more width without losing
            one-click access to every item. Choice is remembered across
            reloads via localStorage above. */}
        {isPersistent && (
          <div className={`flex px-2.5 pt-3 ${collapsed ? 'justify-center' : 'justify-end'}`}>
            <button
              type="button"
              onClick={toggleCollapsed}
              title={collapsed ? 'Expand sidebar' : 'Minimize sidebar'}
              aria-label={collapsed ? 'Expand sidebar' : 'Minimize sidebar'}
              className="w-7 h-7 rounded-full flex items-center justify-center text-white/70 hover:text-white hover:bg-white/10 transition-colors"
            >
              {collapsed ? <ChevronsRight className="w-4 h-4" /> : <ChevronsLeft className="w-4 h-4" />}
            </button>
          </div>
        )}

        <nav className={`flex-1 overflow-y-auto py-4 px-2.5 space-y-0.5 ${isPersistent ? 'gsidebar-no-scrollbar' : ''}`}>
          {/* Dashboard — always available, lands back on the User Panel's own
              dashboard regardless of which panel is currently showing. */}
          <button
            type="button"
            onClick={() => selectAndClose(onGoToDashboard)}
            title={collapsed ? 'Dashboard' : undefined}
            className={`w-full flex items-center rounded-xl text-white/85 hover:bg-white/10 transition-colors ${
              collapsed ? 'justify-center px-0 py-2.5' : 'gap-2.5 px-2.5 py-2.5'
            }`}
          >
            <Home className="w-[18px] h-[18px] shrink-0" />
            {!collapsed && <span className="text-[13px] font-medium truncate">Dashboard</span>}
          </button>

          {mainItems.length > 0 && (
            <>
              {!collapsed && <p className="px-2.5 mt-3 mb-1.5 text-[10px] font-semibold tracking-wide text-white/50">MAIN</p>}
              {mainItems.map(renderItem)}
            </>
          )}

          {!collapsed && <p className="px-2.5 mt-3 mb-1.5 text-[10px] font-semibold tracking-wide text-white/50">SELF SERVICE</p>}
          {selfServiceItems.map(renderItem)}

          {(!!adminDashboardItem || reportsGroup.length > 0 || claimsGroup.length > 0 || attendanceGroup.length > 0 ||
            orgGroup.length > 0 || workforceGroup.length > 0 || hrGroup.length > 0 || adminFlatItems.length > 0) && (
            <>
              {!collapsed && <p className="px-2.5 mt-3 mb-1.5 text-[10px] font-semibold tracking-wide text-white/50">ADMIN PANEL</p>}

              {adminDashboardItem && renderItem(adminDashboardItem)}

              {renderGroup(reportsGroup, 'PEPM Manage', BarChart3, reportsOpen, setReportsOpen)}
              {renderGroup(claimsGroup, 'Claims', CreditCard, claimsOpen, setClaimsOpen)}
              {renderGroup(attendanceGroup, 'Attendance', Fingerprint, attendanceOpen, setAttendanceOpen)}
              {renderGroup(orgGroup, 'Organization', Building2, orgOpen, setOrgOpen)}
              {renderGroup(workforceGroup, 'Workforce', Users, workforceOpen, setWorkforceOpen)}
              {renderGroup(hrGroup, 'HR', ShieldCheck, hrOpen, setHrOpen)}

              {adminFlatItems.map(renderItem)}
            </>
          )}

        </nav>

        <div className="p-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] space-y-2">
          {/* "Set Server" — native-app-only, EVERY account (not just Superadmin):
              any employee's device may need to point at a different
              company/deployment server, same as picking a different site to sign
              into. Opens a picker (ServerSwitcherModal.tsx) fetched from the
              catalog a Superadmin manages on the web (Admin Panel -> Servers,
              still Superadmin-only to add/edit/delete). Kept out of the "ADMIN
              PANEL" section above since it isn't an admin-only action. */}
          {isNativeApp && (
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

      {showServerModal && (
        <ServerSwitcherModal
          token={token}
          onClose={() => setShowServerModal(false)}
        />
      )}
    </div>
  );
};