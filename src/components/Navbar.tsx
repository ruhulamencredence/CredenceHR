import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { User } from '../types';
import { Shield, LogOut, Smartphone, Search, X } from 'lucide-react';
import credenceLogo from '../assets/credence-logo.png';
import { AlertsBell } from './AlertsBell';
import { ChatBell } from './ChatBell';
import { WeatherBadge } from './WeatherBadge';
import { useProfilePhoto } from '../lib/useProfilePhoto';
import { useHeaderSearchState } from '../lib/headerSearch';
import { useHeaderPageTitle } from '../lib/headerPageTitle';

// Mobile header's "open menu" glyph — three filled, rounded-square dots
// stacked vertically, matching the app's own rounded-corner language (the
// same rx used on buttons/cards elsewhere) instead of lucide's plain-circle
// MoreVertical or a 3-line hamburger. currentColor so it inherits whatever
// color/opacity the button around it sets (muted gray on the web header,
// white on the native app's translucent pill — see transparentHeader below).
const ThreeDotsMenuIcon: React.FC<{ className?: string }> = ({ className }) => (
  <svg viewBox="0 0 24 24" className={className} fill="none" xmlns="http://www.w3.org/2000/svg">
    <rect x="9.5" y="2.5" width="5" height="5" rx="1.6" fill="currentColor" />
    <rect x="9.5" y="9.5" width="5" height="5" rx="1.6" fill="currentColor" />
    <rect x="9.5" y="16.5" width="5" height="5" rx="1.6" fill="currentColor" />
  </svg>
);

interface NavbarProps {
  user: User;
  // Needed for AlertsBell's own /api/alerts calls (see below) — every other
  // prop here is UI state/callbacks, this is the only one Navbar didn't
  // already need for itself.
  token: string;
  // Bumped by App.tsx right after a Personal Data photo upload succeeds, so
  // this header's avatar swaps from initials to the new photo immediately —
  // see useProfilePhoto.ts.
  photoVersion?: number;
  // True while ProfilePage.tsx is the page currently showing (opened from
  // this very avatar, or from GlobalSidebar's own profile header) — hides
  // this avatar button while it's open, so the header doesn't show the same
  // avatar the open page itself is already showing. Reappears once the
  // account leaves ProfilePage via its own "Back" button.
  isProfilePageOpen?: boolean;
  onLogout: () => void;
  onOpenApkInfo: () => void;
  // Only passed (non-undefined) when this Admin has been granted
  // can_access_user_panel by the Superadmin. No longer renders a visible
  // switcher in the header (removed) — kept only so this component's
  // inUserView/canSeeMovementClaims/canSeeConveyanceBillClaim logic still
  // knows which panel App.tsx is currently showing for this account. Absent
  // entirely for a plain User or Superadmin, or an Admin without the grant.
  viewMode?: 'admin' | 'user';
  onViewModeChange?: (mode: 'admin' | 'user') => void;
  // Clicking the Credence logo (web/desktop only — the mobile hamburger's
  // GlobalSidebar already has its own "Dashboard" link) leaves any Self
  // Service page and lands back on the User Panel dashboard, mirroring
  // GlobalSidebar's onGoToDashboard exactly.
  onGoToDashboard: () => void;
  // Web-only "Claims" menu (see the dropdown below) — jumps straight to Movement
  // Claims or Conveyance Bill Claim on whichever panel is currently showing
  // (the Admin's own tab there, or the User's own section). Hidden on the
  // Android APK / narrow screens, where the existing tile menu / bottom nav
  // already covers this.
  onGoToMovementClaims: () => void;
  onGoToConveyanceBillClaim: () => void;
  // Web-only "Jobs" menu (see the dropdown below) — jumps straight to one of
  // the four User Panel sections it groups (Entry, Jobs, Entry Details, Job
  // Edits). Unlike Claims above, every one of these lives ONLY in the User
  // Panel, so App.tsx also switches an Admin<->User panel-switcher account
  // into 'user' view when this fires (mirrors "Budget" doing the opposite for
  // 'admin' below).
  onGoToJobsTab: (target: 'entry' | 'jobs' | 'entryDetails' | 'jobEdit') => void;
  // Web-only "Budget" menu (see the dropdown below) — jumps straight to one of
  // the five Admin Panel tabs it groups. Unlike the Claims menu above, every one
  // of these lives ONLY in the Admin Panel, so App.tsx also switches an
  // Admin<->User panel-switcher account into 'admin' view when this fires.
  onGoToBudgetTab: (target: 'reports' | 'mprs' | 'imports' | 'editlog' | 'recycle') => void;
  // Web-only "Manage" menu (see the dropdown below) — same idea as "Budget"
  // above, for the Projects / Users / Notices tabs.
  onGoToManageTab: (target: 'projects' | 'branches' | 'users' | 'employees' | 'departments' | 'notices') => void;
  // Web-only "Workforce" menu (see the dropdown below) — same idea again, for
  // the Approvals / Remote Attendance tabs (reviewing and tracking Users out in
  // the field), kept separate from the org-admin tabs grouped under "Manage".
  onGoToWorkforceTab: (target: 'approvals' | 'attendance' | 'attendance_reports' | 'office_attendance' | 'tracking' | 'holidays' | 'disbursement') => void;
  // Web-only "Self Service" menu (see the dropdown below) — everyday employee
  // self-service items, starting with Leave Application. Unlike Budget/Manage/
  // Workforce above, this isn't Admin-gated — every account sees it. Leave
  // Approvals is the one exception: only shown to Admin/Superadmin accounts,
  // since only they can ever be picked as a Leave Application's Approver.
  onGoToSelfServiceTab: (target: 'leaveApplication' | 'leaveManagement' | 'myLeave' | 'leaveApprovals' | 'timesheet' | 'approveApplications' | 'payroll' | 'employeeDirectory') => void;
  // Mobile-only hamburger button in the header — opens the single
  // GlobalSidebar drawer (see GlobalSidebar.tsx / App.tsx). Desktop
  // (md and up) keeps using the dropdown menus above instead, unchanged —
  // this only replaces the mobile navigation entry point.
  onOpenMobileMenu: () => void;
  // Clicking the avatar (desktop header, top-right) opens ProfilePage.tsx —
  // same destination GlobalSidebar's own profile header opens on mobile.
  onOpenProfile: () => void;
  // Chat bell (ChatBell.tsx) — opens ChatPanel.tsx, same destination
  // GlobalSidebar's own "Chat" item opens on mobile.
  onOpenChat: () => void;
  // Hides this bell while ChatPanel.tsx is the page currently showing, same
  // reasoning as isProfilePageOpen hiding the avatar button above.
  isChatOpen?: boolean;
}

// Styled after the Gemini app's top bar: a plain white surface, the Credence
// logo as the one brand-color accent, and quiet gray/neutral chrome elsewhere.
export const Navbar: React.FC<NavbarProps> = ({
  user,
  token,
  photoVersion,
  isProfilePageOpen,
  onLogout,
  onOpenApkInfo,
  viewMode,
  onViewModeChange,
  onGoToDashboard,
  onGoToMovementClaims,
  onGoToConveyanceBillClaim,
  onGoToJobsTab,
  onGoToBudgetTab,
  onGoToManageTab,
  onGoToWorkforceTab,
  onGoToSelfServiceTab,
  onOpenMobileMenu,
  onOpenProfile,
  onOpenChat,
  isChatOpen
}) => {
  // Both the User Panel and the Admin Panel now get the fully transparent
  // header on the native Android APK (per request) — the web build keeps the
  // solid header either way.
  const isNativeApp = Capacitor.isNativePlatform();
  const transparentHeader = isNativeApp;

  // Whichever page is showing may have docked its own search box into this
  // header (see headerSearch.ts) — while that page's own search bar has
  // scrolled out of view, this swaps the mobile logo for a search icon so
  // the user can keep searching without scrolling back up.
  const { registration: headerSearchReg, barHidden: headerSearchBarHidden } = useHeaderSearchState();
  const showMobileSearchIcon = !!headerSearchReg && headerSearchBarHidden;
  const [mobileSearchOpen, setMobileSearchOpen] = useState(false);
  useEffect(() => {
    if (!showMobileSearchIcon) setMobileSearchOpen(false);
  }, [showMobileSearchIcon]);

  // A mobile sub-page (e.g. "Select a Budget") can instead ask for its own
  // plain title in place of the logo (see headerPageTitle.ts) — same logo
  // swap as the search icon above, just with static text instead of a
  // search box. The two never happen at once in practice (different pages
  // own each), but the title wins if they somehow did.
  const headerPageTitle = useHeaderPageTitle();
  const showMobilePageTitle = !!headerPageTitle;
  const showMobileLogoSwap = showMobileSearchIcon || showMobilePageTitle;

  // Circular avatar shown at the top right (initial + role-tinted background) —
  // falls back to this when the account has no Personal Data photo uploaded
  // yet (or it hasn't loaded); shows the actual photo (PersonalDataForm.tsx)
  // once useProfilePhoto resolves one.
  const initial = (user.name || user.username || '?').trim().charAt(0).toUpperCase();
  const avatarColors =
    user.role === 'superadmin'
      ? { background: '#fde8e8', color: '#9b1c1c' }
      : user.role === 'admin'
      ? { background: '#fef7e0', color: '#986400' }
      : { background: 'var(--g-accent-soft)', color: 'var(--g-accent)' };
  const photoUrl = useProfilePhoto(token, photoVersion);

  return (
    <header
      className="sticky top-0 z-50"
      style={{
        // On the native Android APK the header no longer sits on plain
        // transparent/page background — it's filled with the same violet
        // gradient as WelcomeBanner (see WelcomeBanner.tsx's
        // #welcomeBannerGradient stops) so the header visually fuses with the
        // banner directly below it into one continuous card, instead of
        // looking like two separate pieces.
        background: transparentHeader
          ? 'linear-gradient(90deg, #7F00FF 0%, #6300C6 50%, #47008E 100%)'
          : 'var(--g-surface)',
        borderBottom: transparentHeader ? 'none' : '1px solid var(--g-border)',
        // App.tsx now makes the native status bar fully transparent and
        // lets the WebView draw underneath it (StatusBar.setOverlaysWebView
        // ({ overlay: true })), so this gradient itself extends up into the
        // status bar's strip instead of a separate solid-color approximation
        // sitting above it — the header's actual light-to-dark direction
        // (see the gradient above) now continues seamlessly behind the
        // clock/signal/battery row. This padding pushes the logo/menu row
        // below the notch/clock so nothing sits under it, while the
        // gradient painted on this same element keeps covering that area.
        paddingTop: 'env(safe-area-inset-top, 0px)'
      }}
    >
      <div className="w-full px-4 sm:px-6 lg:px-8 h-16 flex items-center justify-between">
        {/* Logo, left-aligned. The desktop dropdown menus that used to sit
            next to it (Claims / Jobs / Budget / Manage / Workforce / Self
            Service) have been removed — see the note below. */}
        {/* gap shrinks to gap-2 on mobile while the search icon is showing —
            the collapsed logo between hamburger and search (see below) still
            takes up its own gap on both sides even at 0 width, so the normal
            gap-8 doubled up into a much wider gap than intended. Desktop
            (md+) always keeps the full logo, so its spacing stays gap-8/10. */}
        <div className={`flex items-center min-w-0 md:gap-8 lg:gap-10 ${showMobileLogoSwap ? 'gap-2' : 'gap-8'}`}>
          {/* Mobile-only hamburger — opens the single GlobalSidebar drawer
              (see GlobalSidebar.tsx), regardless of which panel is currently
              showing. Desktop (md and up) still hides this button — the
              GlobalSidebar persistent variant is its desktop navigation now.
              On the native app the
              header is the purple gradient (transparentHeader — see above),
              where the old muted-gray icon color was nearly invisible; white
              on a soft translucent pill keeps it visible there while the
              plain web header (light background) keeps the original muted
              color. */}
          <button
            type="button"
            onClick={onOpenMobileMenu}
            className={`md:hidden -ml-1 w-9 h-9 rounded-xl flex items-center justify-center shrink-0 transition-colors ${
              transparentHeader
                ? 'text-white bg-white/15 hover:bg-white/25 active:bg-white/30'
                : 'hover:opacity-70'
            }`}
            style={transparentHeader ? undefined : { color: 'var(--g-text-muted)' }}
            aria-label="Open menu"
          >
            <ThreeDotsMenuIcon className="w-[18px] h-[18px]" />
          </button>
          {/* On mobile, once the current page's own search bar has scrolled
              out of view, this logo swaps for a search icon (see
              showMobileSearchIcon above) so search stays reachable without
              scrolling back up. Desktop always keeps the plain logo. Animated
              (collapsing width + fade) rather than an instant hidden/shown
              jump — both this button and the search area below stay mounted
              and transition together. */}
          <button
            type="button"
            onClick={onGoToDashboard}
            className={`flex-shrink-0 overflow-hidden transition-all duration-300 ease-in-out hover:opacity-80 ${
              showMobileLogoSwap
                ? 'max-w-0 opacity-0 -translate-x-3 pointer-events-none md:max-w-[220px] md:opacity-100 md:translate-x-0 md:pointer-events-auto'
                : 'max-w-[220px] opacity-100 translate-x-0'
            }`}
            aria-label="Go to dashboard"
          >
            <img src={credenceLogo} alt="Credence" className="h-8 sm:h-9 w-auto" />
          </button>

          {/* A mobile sub-page's own title (see headerPageTitle.ts), shown in
              the logo's place — same animated collapse/expand as the search
              icon below, just static text instead of an input. */}
          <div
            className={`md:hidden min-w-0 flex-1 flex items-center overflow-hidden transition-all duration-300 ease-in-out ${
              showMobilePageTitle ? 'max-w-none opacity-100 translate-x-0' : 'max-w-0 opacity-0 -translate-x-3 pointer-events-none'
            }`}
          >
            <span
              className="text-base font-semibold truncate"
              style={{ color: transparentHeader ? 'white' : 'var(--g-text)' }}
            >
              {headerPageTitle}
            </span>
          </div>

          <div
            className={`md:hidden min-w-0 flex items-center overflow-hidden transition-all duration-300 ease-in-out ${
              showMobileSearchIcon
                ? mobileSearchOpen
                  ? 'flex-1 max-w-none opacity-100'
                  : 'max-w-[40px] opacity-100'
                : 'max-w-0 opacity-0 pointer-events-none'
            }`}
          >
              {mobileSearchOpen ? (
                <div className="relative flex-1">
                  <Search
                    className="w-4 h-4 absolute left-3 top-1/2 -translate-y-1/2"
                    style={{ color: transparentHeader ? 'rgba(255,255,255,0.75)' : 'var(--g-text-muted)' }}
                  />
                  <input
                    autoFocus
                    type="text"
                    value={headerSearchReg?.value || ''}
                    onChange={(e) => headerSearchReg?.onChange(e.target.value)}
                    placeholder={headerSearchReg?.placeholder || 'Search…'}
                    className={`w-full pl-9 pr-8 py-2 rounded-xl text-sm focus:outline-none ${
                      transparentHeader
                        ? 'bg-white/15 text-white placeholder-white/70'
                        : 'bg-slate-50 text-slate-900 border border-slate-200'
                    }`}
                  />
                  <button
                    type="button"
                    onClick={() => setMobileSearchOpen(false)}
                    className="absolute right-2 top-1/2 -translate-y-1/2 p-1"
                    style={{ color: transparentHeader ? 'white' : 'var(--g-text-muted)' }}
                    aria-label="Close search"
                  >
                    <X className="w-4 h-4" />
                  </button>
                </div>
              ) : (
                <button
                  type="button"
                  onClick={() => setMobileSearchOpen(true)}
                  className={`w-9 h-9 rounded-xl flex items-center justify-center transition-colors ${
                    transparentHeader
                      ? 'text-white bg-white/15 hover:bg-white/25 active:bg-white/30'
                      : 'hover:opacity-70'
                  }`}
                  style={transparentHeader ? undefined : { color: 'var(--g-text-muted)' }}
                  aria-label="Search"
                >
                  <Search className="w-[18px] h-[18px]" />
                </button>
              )}
          </div>

          {/* Desktop dropdown menus (Claims / Jobs / Budget / Manage /
              Workforce / Self Service) removed from the web header per
              request — navigation to those sections now goes through
              GlobalSidebar (persistent variant) or the mobile drawer only. */}
        </div>

        {/* Right side — plain icon buttons (no pill backgrounds), same quiet
            treatment as the reference design's search/bell icons, ending in a
            round avatar. */}
        <div className="flex items-center gap-1 sm:gap-2 flex-shrink-0">
          {/* Admin Panel / User Panel switcher removed from the web header —
              the User Panel dashboard is now the only place accounts land on
              the web build; Admin Panel access for whoever has one still
              works via the Budget/Manage/Workforce menus (see the handlers
              above and onGoToBudgetTab/onGoToManageTab/onGoToWorkforceTab in
              App.tsx, which switch viewMode to 'admin' themselves). */}

          <button
            onClick={onOpenApkInfo}
            className="hidden md:flex items-center justify-center w-9 h-9 rounded-full transition-colors hover:opacity-70"
            style={{ color: 'var(--g-text-muted)' }}
            title="Android APK Build Instructions"
          >
            <Smartphone className="w-[18px] h-[18px]" />
          </button>

          {/* Live weather — free (no API key, no permission prompt of its
              own), shown on both the mobile and web header since this
              component is shared by both. See WeatherBadge.tsx for why it
              renders nothing at all rather than a placeholder while loading
              or offline. */}
          <WeatherBadge transparent={transparentHeader} />

          {/* Personal Alerts bell — on by default for every account (no
              module grant needed), shown on both web and the Capacitor
              mobile app since this header is shared by both. Clicking a
              Leave Application alert jumps to Self Service -> Leave
              Application, same destination the "Self Service" menu above
              points at. */}
          <AlertsBell token={token} onOpenLeaveApplication={() => onGoToSelfServiceTab('leaveApplication')} />

          {/* Chat bell — hidden while ChatPanel.tsx is already the page
              showing, same isProfilePageOpen/avatar pattern below. */}
          {!isChatOpen && <ChatBell token={token} onOpenChat={onOpenChat} />}

          <div className="hidden lg:block text-right mr-1">
            <div className="text-sm font-medium leading-tight" style={{ color: 'var(--g-text)' }}>{user.name}</div>
            <div className="text-xs leading-tight" style={{ color: 'var(--g-text-muted)' }}>{user.email || user.username}</div>
          </div>

          <span
            className="hidden sm:inline-flex items-center gap-1 px-2.5 py-1 rounded-full text-xs font-medium mr-1"
            style={
              user.role === 'superadmin'
                ? { background: '#fde8e8', color: '#9b1c1c' }
                : user.role === 'admin'
                ? { background: '#fef7e0', color: '#986400' }
                : { background: 'var(--g-accent-soft)', color: 'var(--g-accent)' }
            }
          >
            <Shield className="w-3.5 h-3.5" />
            {user.role === 'superadmin' ? 'Superadmin' : user.role === 'admin' ? 'Admin' : 'User'}
          </span>

          <button
            type="button"
            onClick={onOpenProfile}
            className={`w-9 h-9 rounded-full items-center justify-center text-sm font-semibold flex-shrink-0 transition-opacity hover:opacity-80 overflow-hidden ${
              isProfilePageOpen ? 'hidden' : 'flex'
            }`}
            style={photoUrl ? undefined : avatarColors}
            title={user.name}
            aria-label="Open profile"
          >
            {photoUrl ? <img src={photoUrl} alt={user.name} className="w-full h-full object-cover" /> : initial}
          </button>

          {/* Logout — hidden on mobile (md:flex) since the mobile drawer
              (AdminSidebar.tsx / GlobalSidebar.tsx) already has its own
              Logout button; kept here for the desktop header where there's
              no such drawer. */}
          <button
            onClick={onLogout}
            className="hidden md:flex w-9 h-9 rounded-full items-center justify-center transition-colors hover:opacity-70"
            style={{ color: 'var(--g-text-muted)' }}
            title="Logout"
          >
            <LogOut className="w-[18px] h-[18px]" />
          </button>
        </div>
      </div>
    </header>
  );
};