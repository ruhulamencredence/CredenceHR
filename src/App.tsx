/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useRef, Suspense, lazy } from 'react';
import { Capacitor } from '@capacitor/core';
import { RefreshCw, ArrowLeft, X } from 'lucide-react';
import { User, ClaimsNavRequest, AdminNavRequest, JobsNavRequest, AdminModuleKey, DashboardNavRequest, LeaveNavRequest } from './types';
import { AuthScreen } from './components/AuthScreen';
import { Navbar } from './components/Navbar';
import { GlobalSidebar } from './components/GlobalSidebar';
import { ProfilePage } from './components/ProfilePage';
// UserPanel/AdminPanel are the two heaviest branches of the app (PDF export,
// Leaflet maps, Excel import/export, etc. all live under one of these two) —
// lazy-loading them means the Login screen only has to download/parse the
// small shared shell first, instead of that code being forced into the same
// eagerly-loaded bundle every visitor's phone has to fetch before they can
// even see the login form. See the Suspense fallback below for what shows
// during the brief gap while a panel's own chunk downloads after login.
const UserPanel = lazy(() => import('./components/UserPanel').then(m => ({ default: m.UserPanel })));
const AdminPanel = lazy(() => import('./components/AdminPanel').then(m => ({ default: m.AdminPanel })));
// Chat pulls in its own Socket.IO client — lazy-loaded for the same reason
// as UserPanel/AdminPanel above, so an account that never opens Chat never
// pays for it.
const ChatPanel = lazy(() => import('./components/ChatPanel').then(m => ({ default: m.ChatPanel })));
const AlertsPage = lazy(() => import('./components/AlertsPage').then(m => ({ default: m.AlertsPage })));

import { AppLoader } from './components/AppLoader';
import { Spinner } from './components/Spinner';
import { ApkModal } from './components/ApkModal';
import { FloatingChatButton } from './components/FloatingChatButton';
import { LeaveManage } from './components/LeaveManage';
import { LeaveApprovals } from './components/LeaveApprovals';
import { ApproveApplications } from './components/ApproveApplications';
import { Timesheet } from './components/Timesheet';
import { PayrollModule } from './components/PayrollModule';
import { EmployeeDirectory } from './components/EmployeeDirectory';
import { MyResignation } from './components/MyResignation';
import { AssetManagement } from './components/AssetManagement';
import { NoticePopup } from './components/NoticePopup';
import { useBackButtonClose } from './lib/useBackButtonClose';
import { closeTopmostOrReturnFalse } from './lib/backButtonStack';
import { installKeyboardScrollFix } from './lib/keyboardScrollFix';
import { usePullToRefresh } from './lib/usePullToRefresh';
import { apiUrl } from './lib/api';
import { startBackgroundTracking, stopBackgroundTracking } from './lib/backgroundTracking';
import { connectChatSocket, disconnectChatSocket } from './lib/chatSocket';
import { initPushNotifications, clearPushToken } from './lib/pushNotifications';

export default function App() {
  const [token, setToken] = useState<string | null>(localStorage.getItem('mpr_token'));
  const [user, setUser] = useState<User | null>(() => {
    const saved = localStorage.getItem('mpr_user');
    return saved ? JSON.parse(saved) : null;
  });
  const [isApkModalOpen, setIsApkModalOpen] = useState(false);
  useBackButtonClose(isApkModalOpen, () => setIsApkModalOpen(false));

  // Navbar's web-only "Claims" header menu — see ClaimsNavRequest in types.ts.
  const [claimsNavRequest, setClaimsNavRequest] = useState<ClaimsNavRequest | null>(null);
  // Navbar's web-only "Jobs" header menu — see JobsNavRequest in types.ts.
  const [jobsNavRequest, setJobsNavRequest] = useState<JobsNavRequest | null>(null);
  // Navbar's web-only "Budget" header menu — see AdminNavRequest in types.ts.
  const [adminNavRequest, setAdminNavRequest] = useState<AdminNavRequest | null>(null);
  // GlobalSidebar's "Dashboard" item — see DashboardNavRequest in types.ts.
  const [dashboardNavRequest, setDashboardNavRequest] = useState<DashboardNavRequest | null>(null);
  // GlobalSidebar's "Leave Application" item (and Navbar's AlertsBell) — see
  // LeaveNavRequest in types.ts.
  const [leaveNavRequest, setLeaveNavRequest] = useState<LeaveNavRequest | null>(null);
  // AdminPanel's own activeTab, reported live via onActiveTabChange (see
  // AdminPanel.tsx) — used below to tell GlobalSidebar which item is
  // actually on screen right now, so it can show a "you are here" highlight
  // instead of never marking anything as current.
  const [adminActiveTab, setAdminActiveTab] = useState<string>('dashboard');
  // UserPanel's own desktopActiveSection/mobileActiveSection, reported live
  // via onActiveSectionChange (see UserPanel.tsx) — same "you are here"
  // purpose as adminActiveTab above, just split by viewport since UserPanel
  // tracks a separate current section for each.
  const [userActiveSection, setUserActiveSection] = useState<{ desktop: string; mobile: string | null }>({
    desktop: 'dashboard',
    mobile: null
  });
  // Navbar's web-only "Self Service" header menu — takes over the main area
  // the same way the Claims/Jobs pages do (see the `main` block below),
  // instead of living inside the Admin/User panel tab structure. null means
  // neither Self Service page is showing (normal Admin/User Panel view).
  //
  // Restored from localStorage (same pattern as viewMode above) so a manual
  // reload — or the browser/WebView reloading the page on its own — lands
  // back on whichever Self Service page (Leave Application, Timesheet, etc.)
  // this account was actually looking at, instead of resetting to the
  // Admin/User Panel default every time.
  const selfServiceViewStorageKey = user ? `mpr_self_service_view_${user.id}` : null;
  const [selfServiceView, setSelfServiceView] = useState<'leaveApplication' | 'leaveManagement' | 'leaveApprovals' | 'timesheet' | 'approveApplications' | 'payroll' | 'employeeDirectory' | 'resignation' | 'assetManagement' | null>(() => {
    try {
      const saved = selfServiceViewStorageKey ? localStorage.getItem(selfServiceViewStorageKey) : null;
      if (saved === 'leaveApplication' || saved === 'leaveManagement' || saved === 'leaveApprovals' || saved === 'timesheet' || saved === 'approveApplications' || saved === 'employeeDirectory' || saved === 'resignation') {
        return saved;
      }
    } catch {
      // ignore — falls through to the "no Self Service page open" default below
    }
    return null;
  });
  useEffect(() => {
    if (!selfServiceViewStorageKey) return;
    try {
      if (selfServiceView) localStorage.setItem(selfServiceViewStorageKey, selfServiceView);
      else localStorage.removeItem(selfServiceViewStorageKey);
    } catch {
      // localStorage can be unavailable in some embedded WebViews — safe to
      // ignore, it just means a reload won't be able to restore this page.
    }
  }, [selfServiceView, selfServiceViewStorageKey]);
  // ProfilePage.tsx — opened from the avatar in Navbar (desktop header) or
  // GlobalSidebar (mobile drawer's own profile header). Takes over the main
  // area the same way Self Service does, and only ever clears itself via its
  // own "Back" button.
  //
  // Restored from localStorage same as selfServiceView above, so a reload
  // while on the Profile page lands back on it instead of the Admin/User
  // Panel default.
  const showProfilePageStorageKey = user ? `mpr_show_profile_page_${user.id}` : null;
  const [showProfilePage, setShowProfilePage] = useState(() => {
    try {
      return showProfilePageStorageKey ? localStorage.getItem(showProfilePageStorageKey) === '1' : false;
    } catch {
      return false;
    }
  });
  useEffect(() => {
    if (!showProfilePageStorageKey) return;
    try {
      if (showProfilePage) localStorage.setItem(showProfilePageStorageKey, '1');
      else localStorage.removeItem(showProfilePageStorageKey);
    } catch {
      // localStorage can be unavailable in some embedded WebViews — safe to
      // ignore, it just means a reload won't be able to restore this page.
    }
  }, [showProfilePage, showProfilePageStorageKey]);

  // ChatPanel.tsx — opened from the Navbar chat bell, takes over the main
  // area the same way ProfilePage does. Unlike showProfilePage above, this
  // isn't persisted across a reload — reopening Chat re-syncs instantly from
  // the server, so there's nothing worth restoring a stale "was open" flag for.
  const [showChat, setShowChat] = useState(false);
  // Docked FloatingChatButton's own popup — a New-Leave-Application-sized
  // centered modal card (see the render block near FloatingChatButton below),
  // kept fully separate from showChat above so Navbar's ChatBell (which still
  // opens Chat in a new browser tab on web, or takes over the whole screen on
  // native) is completely unaffected by this.
  const [showChatPopup, setShowChatPopup] = useState(false);
  // Set when a Chat push notification is tapped (see initPushNotifications
  // below) so ChatPanel opens straight to that conversation instead of just
  // landing on the room list. Cleared once ChatPanel has consumed it (see
  // its onInitialRoomHandled prop) so re-showing Chat later doesn't keep
  // jumping back to that same old room.
  const [pendingChatRoomId, setPendingChatRoomId] = useState<number | null>(null);

  // AlertsPage.tsx — opened from GlobalSidebar's "Alerts" item or the
  // AlertsBell dropdown's "View all" footer link. Same not-persisted-across-
  // reload reasoning as showChat above.
  const [showAlertsPage, setShowAlertsPage] = useState(false);

  // Bumped right after a Personal Data photo upload succeeds (see
  // ProfilePage's onPhotoUpdated below) — passed to every avatar spot
  // (Navbar, GlobalSidebar, ProfilePage itself) as a dependency so
  // useProfilePhoto.ts refetches and shows the new photo immediately,
  // instead of only after the next full page reload.
  const [photoVersion, setPhotoVersion] = useState(0);

  // Manual "pull down from the top to reload" — see usePullToRefresh.ts for
  // why this is safe to land back on the same screen (Admin tab / User Panel
  // section / in-progress MPR Entry draft are all mirrored to localStorage).
  const { pullDistance, ready, threshold, triggering, dragging } = usePullToRefresh();

  // Keeps whichever input the user is typing into scrolled above the on-screen
  // keyboard on mobile, instead of ending up hidden behind it (see
  // keyboardScrollFix.ts for why this is needed on top of the native resize
  // config in capacitor.config.ts). Attached once for the whole app.
  useEffect(() => installKeyboardScrollFix(), []);


  // Android hardware back button: closes whichever modal/drill-down is
  // currently open (see backButtonStack.ts / useBackButtonClose.ts) instead of
  // exiting the app. With nothing open — i.e. sitting at the main Admin/User
  // dashboard — the first press just shows "Press back again to exit" instead
  // of exiting immediately; a second press within 2 seconds actually exits.
  // No-ops entirely on the web build (Capacitor's native APIs simply aren't
  // there, so this whole effect silently does nothing).
  const [showExitPrompt, setShowExitPrompt] = useState(false);
  const awaitingExitConfirmRef = useRef(false);
  const exitPromptTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    let removeListener: (() => void) | undefined;

    (async () => {
      try {
        const [{ App: CapacitorApp }, { Capacitor }] = await Promise.all([
          import('@capacitor/app'),
          import('@capacitor/core')
        ]);
        if (!Capacitor.isNativePlatform()) return;

        const subscription = await CapacitorApp.addListener('backButton', () => {
          if (closeTopmostOrReturnFalse()) return;

          if (awaitingExitConfirmRef.current) {
            CapacitorApp.exitApp();
            return;
          }
          awaitingExitConfirmRef.current = true;
          setShowExitPrompt(true);
          if (exitPromptTimerRef.current) clearTimeout(exitPromptTimerRef.current);
          exitPromptTimerRef.current = setTimeout(() => {
            awaitingExitConfirmRef.current = false;
            setShowExitPrompt(false);
          }, 2000);
        });
        removeListener = () => subscription.remove();
      } catch {
        // @capacitor/app isn't installed/loadable (e.g. a plain web checkout
        // that hasn't run `npm install`) — nothing to wire up, safe to ignore.
      }
    })();

    return () => {
      removeListener?.();
      if (exitPromptTimerRef.current) clearTimeout(exitPromptTimerRef.current);
    };
  }, []);

  // Makes the native status bar strip (the OS clock/signal/battery row)
  // TRANSPARENT and lets the WebView draw underneath it (overlay: true),
  // instead of painting it as a solid approximate color. A solid strip
  // can only ever pick ONE stop of the header's left-to-right gradient
  // (see Navbar.tsx's `transparentHeader` / WelcomeBanner.tsx —
  // linear-gradient(90deg, #7F00FF 0%, #6300C6 50%, #47008E 100%)) which
  // always looks slightly off — light side of the gradient doesn't line
  // up with the light side of a flat color. With overlay true, the
  // header's OWN real gradient extends up under the status bar (Navbar.tsx
  // already reserves `paddingTop: env(safe-area-inset-top)` for exactly
  // this), so the join is pixel-perfect and the light side naturally
  // stays on whichever side the header's gradient itself puts it — even
  // if that gradient's direction ever changes later, nothing here needs
  // to be updated to match. No-ops entirely on the web build.
  useEffect(() => {
    (async () => {
      try {
        const [{ StatusBar, Style }, { Capacitor }] = await Promise.all([
          import('@capacitor/status-bar'),
          import('@capacitor/core')
        ]);
        if (!Capacitor.isNativePlatform()) return;

        await StatusBar.setOverlaysWebView({ overlay: true });
        // Light (white) status bar icons/clock read correctly against the
        // dark purple header showing through from underneath.
        await StatusBar.setStyle({ style: Style.Dark });
      } catch {
        // @capacitor/status-bar isn't installed/loadable (e.g. a plain web
        // checkout that hasn't run `npm install`) — nothing to wire up, safe
        // to ignore.
      }
    })();
  }, []);

  const handleLoginSuccess = (newToken: string, newUser: User) => {
    localStorage.setItem('mpr_token', newToken);
    localStorage.setItem('mpr_user', JSON.stringify(newUser));
    setToken(newToken);
    setUser(newUser);
    // Every fresh login lands on the User Panel dashboard — regardless of
    // role, and regardless of which panel this account was last looking at
    // on this device. Admin Panel (for whoever has it — see hasAdminPanel
    // below) is now reached from there via the header, not the default
    // landing screen. Also clear any persisted Self Service / Profile page
    // (see the lazy initializers above) so a fresh login doesn't jump
    // straight back into whichever page was on screen at the last reload.
    setViewMode('user');
    setSelfServiceView(null);
    setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
  };

  const handleLogout = () => {
    // Also drop this account's remembered mobile/desktop User Panel section
    // (see UserPanel.tsx) — otherwise the next login on this device restores
    // whichever section (e.g. Claims) was on screen when this account last
    // logged out, instead of landing on the Dashboard as intended above.
    // Same for the Self Service / Profile page persisted just above.
    if (user) {
      localStorage.removeItem(`mpr_user_section_${user.id}`);
      localStorage.removeItem(`mpr_user_desktop_section_${user.id}`);
      localStorage.removeItem(`mpr_self_service_view_${user.id}`);
      localStorage.removeItem(`mpr_show_profile_page_${user.id}`);
    }
    if (token) clearPushToken(token);
    localStorage.removeItem('mpr_token');
    localStorage.removeItem('mpr_user');
    setToken(null);
    setUser(null);
    stopBackgroundTracking();
    disconnectChatSocket();
  };

  // Employee Tracking (Admin Panel -> Employee Tracking): starts/stops the
  // APK's background location watcher whenever can_use_tracking changes for
  // the signed-in account — granted right after login, or picked up next
  // time the app opens via the /api/auth/me refresh above. No-ops entirely
  // on the web build. Deliberately NOT tied to which panel (User/Admin) is
  // on screen — an Admin/Superadmin who is also out in the field should
  // still report location while looking at their Admin Panel.
  useEffect(() => {
    if (token && user?.can_use_tracking) {
      startBackgroundTracking(token);
    } else {
      stopBackgroundTracking();
    }
  }, [token, user?.can_use_tracking]);

  // Chat (Direct/Group/Community messaging) — connects the one shared
  // Socket.IO connection for the whole session (see chatSocket.ts) as soon
  // as an account is signed in, every account, no permission gate (this is
  // internal org-wide messaging, same visibility as Employee Directory).
  // ChatPanel.tsx and the Navbar chat bell both reuse this same connection
  // rather than opening their own.
  useEffect(() => {
    if (token) connectChatSocket(token);
  }, [token]);

  // Push notifications — registers this device's FCM token (no-op on web /
  // without Firebase configured, see pushNotifications.ts). Tapping a Chat
  // push while the app was backgrounded/closed jumps straight into that
  // conversation via pendingChatRoomId, consumed by ChatPanel below. Tapping
  // an Alerts push (any other alert type — leave decisions, conveyance
  // claims, ...) opens the Alerts page instead, same as GlobalSidebar's own
  // "Alerts" item.
  useEffect(() => {
    if (token) {
      initPushNotifications(token, {
        onChatTap: (roomId) => {
          setSelfServiceView(null);
          setShowProfilePage(false);
          setShowAlertsPage(false);
          setPendingChatRoomId(roomId);
          setShowChat(true);
        },
        onAlertTap: () => {
          setSelfServiceView(null);
          setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(true);
        }
      });
    }
  }, [token]);

  // Which panel the account is currently looking at. Every account now lands
  // on the User Panel dashboard by default after logging in (see
  // handleLoginSuccess above) — Admin Panel access for whoever has one (see
  // hasAdminPanel below: Admin/Superadmin always, or a plain User granted one
  // or more Admin Panel modules) is reached from there via the header's
  // mobile menu / desktop Budget-Manage-Workforce-Jobs-Claims links, instead
  // of being the screen everyone starts on.
  //
  // Restored from localStorage (see the save effect just below) so a manual
  // "pull down to reload" — or a forced background reload — lands back on
  // whichever panel (Admin/User) this account was actually looking at mid-
  // session, instead of resetting to the User Panel dashboard every time.
  const [viewMode, setViewMode] = useState<'admin' | 'user'>(() => {
    try {
      const saved = user ? localStorage.getItem(`mpr_view_mode_${user.id}`) : null;
      if (saved === 'admin' || saved === 'user') return saved;
    } catch {
      // ignore — falls through to the User Panel default below
    }
    return 'user';
  });
  // Whether this account has an Admin Panel at all — a plain Superadmin/Admin
  // always does; a plain User only does once the Superadmin has granted them
  // at least one Admin Panel module (module_permissions). Same test Navbar.tsx
  // uses for its own "Budget" menu (hasAdminPanel there).
  const hasAdminPanel = !!user && (user.role === 'admin' || user.role === 'superadmin' ||
    (user.role === 'user' && (user.module_permissions || []).length > 0));
  // Every Admin/Superadmin can now switch into the User Panel — previously
  // gated behind a Superadmin-granted can_access_user_panel toggle, but since
  // the User Panel dashboard is everyone's default landing screen now, that
  // toggle no longer has anything left to gate here.
  const canSwitchToUserPanel = user?.role === 'admin' || user?.role === 'superadmin';
  const canSwitchToAdminPanel = user?.role === 'user' && (user.module_permissions || []).length > 0;
  const canSwitchPanels = canSwitchToUserPanel || canSwitchToAdminPanel;

  useEffect(() => {
    if (!user) return;
    try {
      localStorage.setItem(`mpr_view_mode_${user.id}`, viewMode);
    } catch {
      // localStorage can be unavailable in some embedded WebViews — safe to
      // ignore, it just means a reload won't be able to restore this.
    }
  }, [viewMode, user]);

  // Drives the single GlobalSidebar drawer — mobile-only (see Navbar.tsx's
  // `md:hidden` hamburger and GlobalSidebar.tsx). Desktop keeps using the
  // Navbar's own dropdown menus/switcher instead, untouched, so this state
  // never opens anything on md-and-up screens.
  const [globalSidebarOpen, setGlobalSidebarOpen] = useState(false);
  // True only while an account with an Admin Panel (hasAdminPanel) has
  // actively switched viewMode to 'admin' — no more hardcoded "Superadmin
  // always sees Admin Panel" case, since Superadmin now starts on the User
  // Panel dashboard like everyone else and switches in the same way.
  const isAdminView = hasAdminPanel && viewMode === 'admin';

  // Refresh the logged-in user's own record (role, and the Admin-toggleable
  // can_edit_delivery_date / can_job_edit feature permissions) once per app open.
  // These can change server-side at any time via the Admin Panel, and the cached
  // copy in localStorage is only ever as fresh as the last login — without this,
  // an Admin turning Job Edit on/off for a user wouldn't take effect until that
  // user logged out and back in.
  useEffect(() => {
    if (!token) return;
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/auth/me'), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) return;
        const fresh = await res.json();
        setUser((prev) => {
          if (!prev) return prev;
          const merged = { ...prev, ...fresh };
          localStorage.setItem('mpr_user', JSON.stringify(merged));
          return merged;
        });
      } catch {
        // Offline or server unreachable — keep using the cached user from login.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // Small floating indicator shown while the user is mid-pull, so there's
  // clear feedback that a swipe-down-from-the-top does something on
  // purpose. Below the threshold it's a plain rotating-icon pill with a
  // "Pull down to reload" hint; once it crosses the threshold the pill
  // drops its text and swells into the app's own loader animation instead
  // — the loader itself communicates "let go, it's ready" without needing
  // a "Release to reload" label. `dragging` gates the transform transition
  // so it only eases in for the snap-back-to-0 moment (finger lifted
  // early), never while the finger is actively dragging the pill around.
  const pullToRefreshIndicator = pullDistance > 0 && !triggering && (
    <div
      className="fixed top-0 left-1/2 z-[110] pointer-events-none transition-opacity"
      style={{
        transform: `translate(-50%, ${Math.max(pullDistance - 36, -36)}px)`,
        opacity: Math.min(pullDistance / threshold, 1),
        transition: dragging ? 'opacity 150ms ease-out' : 'transform 220ms ease-out, opacity 150ms ease-out'
      }}
    >
      {ready ? (
        <div className="p-1.5 rounded-full bg-white shadow-lg">
          <Spinner size={26} />
        </div>
      ) : (
        <div className="flex items-center gap-2 px-4 py-2 rounded-full text-xs font-medium text-white shadow-lg bg-slate-700">
          <RefreshCw
            className="w-3.5 h-3.5"
            style={{ transform: `rotate(${Math.min(pullDistance * 3, 360)}deg)` }}
          />
          Pull down to reload
        </div>
      )}
    </div>
  );

  // Fullscreen hand-off shown for the brief window between "finger
  // released, reload committed" and the actual window.location.reload() —
  // fades in the same app-wide AppLoader used for in-app loading states
  // instead of letting the page just freeze/flash white the instant the
  // reload fires, so the manual-reload gesture ends the same smooth way
  // every other loading state in the app does.
  const pullToRefreshFullscreenLoader = triggering && (
    <div
      className="fixed inset-0 z-[110] flex items-center justify-center bg-white"
      style={{ animation: 'pullToRefreshFadeIn 220ms ease-out both' }}
    >
      <AppLoader label="Reloading…" size={72} minHeight={0} />
      <style>{`
        @keyframes pullToRefreshFadeIn {
          0% { opacity: 0; }
          100% { opacity: 1; }
        }
      `}</style>
    </div>
  );

  // "Back to previous server" — global, ALWAYS present in the APK (not just
  // on the Sign In screen) after using GlobalSidebar's "Set Server" switcher,
  // so it's reachable even after signing in and moving around the new
  // server's app, not just in the one moment right after switching. Only
  // shown when window.history genuinely has a previous server's page to go
  // back to (see AuthScreen.tsx's original version of this same check) —
  // window.history.back() itself still works fine even though the hardware
  // back button is intercepted for the exit-app-confirmation flow above.
  //
  // Temporarily disabled (hardcoded false below) along with GlobalSidebar's
  // SERVER_SWITCHER_ENABLED flag — "Set Server" isn't being worked on right
  // now, so this popup (shown on both the Sign In screen and the Dashboard)
  // is hidden too until it's picked back up.
  const backToServerBadge = false && Capacitor.isNativePlatform() && typeof window !== 'undefined' && window.history.length > 1 && (
    <div
      className="fixed left-1/2 -translate-x-1/2 z-[90] flex items-center gap-2.5 pl-3.5 pr-2 py-2 rounded-full shadow-lg"
      style={{
        top: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 10px)',
        background: 'var(--g-surface)',
        border: '1px solid var(--g-border)'
      }}
    >
      <span className="text-xs font-medium whitespace-nowrap" style={{ color: 'var(--g-text)' }}>
        Switched server
      </span>
      <button
        type="button"
        onClick={() => window.history.back()}
        className="flex items-center gap-1 pl-2.5 pr-3 py-1.5 rounded-full text-xs font-semibold text-white whitespace-nowrap"
        style={{ background: 'var(--g-accent)' }}
      >
        <ArrowLeft className="w-3 h-3" />
        Back
      </button>
    </div>
  );

  if (!token || !user) {
    return (
      <>
        <AuthScreen onLoginSuccess={handleLoginSuccess} />
        {pullToRefreshIndicator}
        {pullToRefreshFullscreenLoader}
        {backToServerBadge}
        {showExitPrompt && (
          <div
            className="fixed left-1/2 -translate-x-1/2 z-[100] px-4 py-2.5 rounded-full text-sm font-medium text-white shadow-lg"
            style={{
              bottom: 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 20px)',
              background: 'rgba(15, 23, 42, 0.92)'
            }}
          >
            Press back again to exit
          </div>
        )}
      </>
    );
  }

  // "Chat" — on the web (desktop/mobile browser), opens in its own new
  // browser tab (/chat, see ChatStandalone.tsx + main.tsx) instead of taking
  // over this tab's main area, so a conversation stays open and reachable
  // (its own tab, its own back/forward history) while the rest of the app
  // keeps working here. Inside the Android APK there's no such thing as "a
  // new tab" — it's one WebView — so native keeps the original in-app panel
  // behavior.
  const openChat = () => {
    if (Capacitor.isNativePlatform()) {
      setSelfServiceView(null);
      setShowProfilePage(false);
      setShowChat(true);
    } else {
      window.open('/chat', '_blank', 'noopener');
    }
  };

  // Used only by the docked FloatingChatButton (bottom-right corner) — that
  // button is explicitly meant to open Chat as a centered popup card, sized
  // like the New Leave Application modal, rather than a full-screen takeover
  // or a new browser tab. See showChatPopup's render block below.
  const openChatPopup = () => {
    setShowChatPopup(true);
  };

  // UserPanel's desktopActiveSection/mobileActiveSection values don't share
  // GlobalSidebar's own item keys 1:1 (different naming/grouping) — this
  // translates one into the other. Sections with no matching sidebar item
  // (e.g. Notice Board, or no section open at all on mobile) return null,
  // which just means nothing gets highlighted.
  const mapUserSectionToSidebarKey = (section: string | null): string | null => {
    switch (section) {
      case 'dashboard': return 'dashboard';
      case 'budget': return 'entry';
      case 'jobs': return 'jobs';
      case 'entries': return 'entryDetails';
      case 'jobEdit': return 'jobEdit';
      case 'claim':
      case 'claims': return 'userMovementClaims';
      case 'conveyanceClaim': return 'userConveyanceClaims';
      case 'leave': return 'leaveApplication';
      case 'timesheet': return 'timesheet';
      case 'employeeDirectory': return 'employeeDirectory';
      default: return null;
    }
  };

  // mobileActiveSection isn't actually mobile-only for these values — per
  // UserPanel.tsx's showingClaimsPage, Movement Claim/My Claims/Conveyance
  // Bill Claim/Leave/Timesheet/Employee Directory/Notice Board show as their
  // OWN page on desktop too, driven by this same state. desktopActiveSection
  // only ever covers Entry/Jobs/Entry Details/Job Edit/Dashboard, so on
  // desktop these need to be checked first, before falling back to it.
  const CLAIMS_TYPE_SECTIONS = new Set([
    'claim', 'claims', 'conveyanceClaim', 'leave', 'timesheet', 'employeeDirectory', 'noticeBoard'
  ]);

  // Which GlobalSidebar item currently matches what's actually on screen —
  // computed separately for the mobile overlay drawer and the desktop
  // persistent column since UserPanel tracks a distinct "current section"
  // for each (see userActiveSection above). Everything else (Self Service,
  // Admin Panel, Chat) is the same regardless of viewport.
  const computeSidebarActiveKey = (viewport: 'mobile' | 'desktop'): string | null => {
    if (showChat) return 'chat';
    if (showAlertsPage) return 'alerts';
    if (showProfilePage) return null;
    if (selfServiceView) return selfServiceView;
    if (isAdminView) return adminActiveTab === 'dashboard' ? 'admin_dashboard' : adminActiveTab;
    if (viewport === 'mobile') return mapUserSectionToSidebarKey(userActiveSection.mobile);
    if (userActiveSection.mobile && CLAIMS_TYPE_SECTIONS.has(userActiveSection.mobile)) {
      return mapUserSectionToSidebarKey(userActiveSection.mobile);
    }
    return mapUserSectionToSidebarKey(userActiveSection.desktop);
  };

  // Shared nav handlers for GlobalSidebar — identical for the mobile overlay
  // drawer (hamburger-triggered, unchanged) and the persistent desktop
  // column that now sits beside <main> (see the layout below), so both stay
  // in sync automatically instead of drifting apart as two copies.
  const sidebarNavProps = {
    user,
    token: token || '',
    photoVersion,
    onLogout: handleLogout,
    onOpenApkInfo: () => setIsApkModalOpen(true),
    onGoToDashboard: () => {
      setSelfServiceView(null);
      setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
      setViewMode('user');
      // Also reset UserPanel's own persisted section (mobile tile menu /
      // desktop tab) back to the dashboard default — see dashboardNavRequest
      // and UserPanel.tsx's effect on it. Without this, switching viewMode
      // to 'user' alone isn't enough: UserPanel keeps showing whichever
      // section (e.g. a Claims page) was previously active or restored from
      // localStorage on the last reload.
      setDashboardNavRequest({ ts: Date.now() });
    },
    onGoToJobsTab: (target: 'entry' | 'jobs' | 'entryDetails' | 'jobEdit') => {
      setSelfServiceView(null);
      setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
      setViewMode('user');
      setJobsNavRequest({ target, ts: Date.now() });
    },
    onGoToUserClaims: (target: 'movementClaims' | 'conveyanceBill') => {
      setSelfServiceView(null);
      setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
      setViewMode('user');
      setClaimsNavRequest({ target, ts: Date.now() });
    },
    onGoToAdminClaims: (target: 'claims' | 'conveyance') => {
      setSelfServiceView(null);
      setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
      setViewMode('admin');
      setClaimsNavRequest({ target: target === 'claims' ? 'movementClaims' : 'conveyanceBill', ts: Date.now() });
    },
    onGoToAdminModule: (target: Exclude<AdminModuleKey, 'claims' | 'conveyance'> | 'my_conveyance' | 'dashboard' | 'servers' | 'permanent_delete_log') => {
      setSelfServiceView(null);
      setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
      setViewMode('admin');
      setAdminNavRequest({ target, ts: Date.now() });
    },
    onGoToSelfServiceTab: (target: 'leaveApplication' | 'leaveManagement' | 'leaveApprovals' | 'timesheet' | 'approveApplications' | 'payroll' | 'employeeDirectory' | 'resignation' | 'assetManagement') => {
      setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
      if (target === 'leaveApplication') {
        // Routes into UserPanel's own mobileActiveSection = 'leave' instead
        // of this file's separate selfServiceView state — the SAME
        // LeaveReviewPage.tsx the Dashboard's Leave Summary card and mobile
        // bottom nav already open, so there's exactly one Leave Application
        // interface regardless of entry point (see leaveNavRequest above and
        // LeaveNavRequest in types.ts). Switches into the User Panel first,
        // same as onGoToJobsTab/onGoToUserClaims above.
        setSelfServiceView(null);
        setViewMode('user');
        setLeaveNavRequest({ ts: Date.now() });
        return;
      }
      setSelfServiceView(target);
    },
    onOpenProfile: () => {
      setSelfServiceView(null);
      setShowChat(false);
      setShowAlertsPage(false);
      setShowProfilePage(true);
    },
    onOpenChat: openChat,
    onOpenAlerts: () => {
      setSelfServiceView(null);
      setShowProfilePage(false);
      setShowChat(false);
      setShowAlertsPage(true);
    },
  };

  return (
    <div
      className="min-h-screen flex flex-col selection:bg-indigo-500 selection:text-white"
      style={{ background: 'var(--g-bg-gradient)', color: 'var(--g-text)' }}
    >
      {pullToRefreshIndicator}
      {pullToRefreshFullscreenLoader}
      {backToServerBadge}
      <Navbar
        user={user}
        token={token || ''}
        photoVersion={photoVersion}
        isProfilePageOpen={showProfilePage}
        onLogout={handleLogout}
        onOpenApkInfo={() => setIsApkModalOpen(true)}
        viewMode={canSwitchPanels ? viewMode : undefined}
        onViewModeChange={
          canSwitchPanels
            ? (mode) => {
                // Same stuck-on-Self-Service issue as the nav handlers below —
                // the Admin Panel/User Panel switcher needs to exit Self
                // Service too, or it stays stuck showing the Self Service page.
                setSelfServiceView(null);
                setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
                setViewMode(mode);
              }
            : undefined
        }
        onGoToDashboard={() => {
          // Same "leave Self Service, land on the User Panel dashboard" reset
          // GlobalSidebar's own Dashboard link already uses (see below) — the
          // logo now does the same thing on desktop. Also bumps
          // dashboardNavRequest (see sidebarNavProps.onGoToDashboard above)
          // so UserPanel resets its own persisted section too, instead of
          // staying stuck on whichever section was previously active.
          setSelfServiceView(null);
          setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
          setViewMode('user');
          setDashboardNavRequest({ ts: Date.now() });
        }}
        onGoToMovementClaims={() => {
          // Self Service (Leave Application/Management/Approvals) and
          // ProfilePage both take over the whole main area (see the `main`
          // block below) and only ever clear themselves via their own "Back"
          // button — so without this, clicking Claims/Jobs/Budget/Manage/
          // Workforce while sitting on one of those pages left the UI stuck
          // showing that page forever, since selfServiceView/showProfilePage
          // stayed set and kept winning the ternary below regardless of
          // claimsNavRequest/jobsNavRequest/adminNavRequest changing
          // underneath it. Every other nav handler below needs the same reset.
          setSelfServiceView(null);
          setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
          setClaimsNavRequest({ target: 'movementClaims', ts: Date.now() });
        }}
        onGoToConveyanceBillClaim={() => {
          setSelfServiceView(null);
          setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
          setClaimsNavRequest({ target: 'conveyanceBill', ts: Date.now() });
        }}
        onGoToJobsTab={(target) => {
          // Every "Jobs" menu target lives only in the User Panel — the mirror
          // image of "Budget" below forcing 'admin' — so make sure an account
          // with the Admin<->User panel-switcher is actually looking at the
          // User Panel before UserPanel's own effect (below) tries to jump to
          // that section.
          setSelfServiceView(null);
          setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
          if (canSwitchPanels) setViewMode('user');
          setJobsNavRequest({ target, ts: Date.now() });
        }}
        onGoToBudgetTab={(target) => {
          // Every "Budget" menu target lives only in the Admin Panel — unlike
          // Claims above, so make sure an account with the Admin<->User
          // panel-switcher is actually looking at the Admin Panel before
          // AdminPanel's own effect (below) tries to jump to that tab.
          setSelfServiceView(null);
          setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
          if (canSwitchPanels) setViewMode('admin');
          setAdminNavRequest({ target, ts: Date.now() });
        }}
        onGoToManageTab={(target) => {
          setSelfServiceView(null);
          setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
          if (canSwitchPanels) setViewMode('admin');
          setAdminNavRequest({ target, ts: Date.now() });
        }}
        onGoToWorkforceTab={(target) => {
          setSelfServiceView(null);
          setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
          if (canSwitchPanels) setViewMode('admin');
          setAdminNavRequest({ target, ts: Date.now() });
        }}
        onGoToSelfServiceTab={(target) => {
          setShowProfilePage(false);
          setShowChat(false);
          setShowAlertsPage(false);
          setSelfServiceView(target);
        }}
        onOpenMobileMenu={() => setGlobalSidebarOpen(true)}
        onOpenProfile={() => {
          setSelfServiceView(null);
          setShowChat(false);
          setShowAlertsPage(false);
          setShowProfilePage(true);
        }}
        onOpenChat={openChat}
        isChatOpen={showChat}
        onOpenAlerts={sidebarNavProps.onOpenAlerts}
      />

      {/* Mobile-only overlay drawer (see Navbar.tsx's md:hidden hamburger) —
          never opens on md-and-up screens; the persistent column just below
          is what desktop web shows instead. */}
      <GlobalSidebar
        variant="overlay"
        open={globalSidebarOpen}
        onClose={() => setGlobalSidebarOpen(false)}
        activeKey={computeSidebarActiveKey('mobile')}
        {...sidebarNavProps}
      />

      {/* Row below the header: the persistent desktop sidebar (hidden below
          md — see GlobalSidebar's isPersistent branch) beside the main
          content column. On mobile this is just <main>/<footer> stacked as
          before, since the sidebar renders nothing there. */}
      <div className="flex-1 flex flex-col md:flex-row">
        <GlobalSidebar
          variant="persistent"
          open={true}
          onClose={() => {}}
          activeKey={computeSidebarActiveKey('desktop')}
          {...sidebarNavProps}
        />

        <div className="flex-1 min-w-0 flex flex-col">
      <main className="flex-1">
        <Suspense fallback={<AppLoader />}>
        {showChat ? (
          <ChatPanel
            user={user}
            token={token || ''}
            onBack={() => setShowChat(false)}
            initialRoomId={pendingChatRoomId}
            onInitialRoomHandled={() => setPendingChatRoomId(null)}
          />
        ) : showAlertsPage ? (
          <AlertsPage
            token={token || ''}
            onBack={() => setShowAlertsPage(false)}
            onOpenLeaveApplication={() => {
              setShowAlertsPage(false);
              sidebarNavProps.onGoToSelfServiceTab('leaveApplication');
            }}
          />
        ) : showProfilePage ? (
          <ProfilePage
            user={user}
            token={token || ''}
            photoVersion={photoVersion}
            onBack={() => setShowProfilePage(false)}
            onLogout={handleLogout}
            onPhotoUpdated={() => setPhotoVersion((v) => v + 1)}
            onProfileNameUpdated={(fullName) => {
              // Keep the header/sidebar avatar+name (and the cached user in
              // localStorage) in sync immediately after Personal Data is
              // saved, rather than waiting for the next /api/auth/me refresh.
              setUser((prev) => {
                if (!prev) return prev;
                const merged = { ...prev, name: fullName };
                localStorage.setItem('mpr_user', JSON.stringify(merged));
                return merged;
              });
            }}
          />
        ) : selfServiceView === 'leaveManagement' ? (
          <LeaveManage token={token} user={user} onBack={() => setSelfServiceView(null)} />
        ) : selfServiceView === 'leaveApprovals' ? (
          <LeaveApprovals token={token} user={user} onBack={() => setSelfServiceView(null)} />
        ) : selfServiceView === 'approveApplications' ? (
          <ApproveApplications token={token} onBack={() => setSelfServiceView(null)} />
        ) : selfServiceView === 'timesheet' ? (
          <Timesheet token={token} onBack={() => setSelfServiceView(null)} />
        ) : selfServiceView === 'payroll' ? (
          <PayrollModule token={token} onBack={() => setSelfServiceView(null)} />
        ) : selfServiceView === 'employeeDirectory' ? (
          <EmployeeDirectory token={token} user={user} onBack={() => setSelfServiceView(null)} isActive />
        ) : selfServiceView === 'resignation' ? (
          <MyResignation token={token} user={user} onBack={() => setSelfServiceView(null)} />
        ) : selfServiceView === 'assetManagement' ? (
          // AssetManagement.tsx (My Assets/New Requisition/Requisition
          // Status) has no header/back button of its own — same wrapper
          // ProfilePage -> Settings -> Asset Management already uses, so the
          // sidebar entry point and the Profile entry point land on an
          // identical page.
          <div className="w-full min-h-[calc(100vh-4rem)]" style={{ background: 'var(--g-surface-muted)' }}>
            <div className="max-w-3xl mx-auto px-4 pt-3 pb-28">
              <div className="flex items-center gap-2 mb-3">
                <button
                  type="button"
                  onClick={() => setSelfServiceView(null)}
                  className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors"
                  style={{ color: 'var(--g-text-muted)' }}
                  aria-label="Back"
                >
                  <ArrowLeft className="w-5 h-5" />
                </button>
                <h1 className="text-base font-bold">Asset Management</h1>
              </div>
              <AssetManagement />
            </div>
          </div>
        ) : isAdminView ? (
          <AdminPanel
            token={token}
            user={user}
            claimsNavRequest={claimsNavRequest}
            adminNavRequest={adminNavRequest}
            onActiveTabChange={setAdminActiveTab}
            // AdminPanel's own mobile drawer (navigating BETWEEN admin tabs
            // while already inside the Admin Panel) is now superseded by the
            // single GlobalSidebar above — same tabs are reachable from
            // there, so this drawer is permanently closed rather than
            // wired to a second mobile hamburger.
            mobileSidebarOpen={false}
            onCloseMobileSidebar={() => {}}
          />
        ) : (
          <>
            <UserPanel
              token={token}
              user={user}
              claimsNavRequest={claimsNavRequest}
              jobsNavRequest={jobsNavRequest}
              dashboardNavRequest={dashboardNavRequest}
              leaveNavRequest={leaveNavRequest}
              onActiveSectionChange={setUserActiveSection}
            />
            {/* Superadmin/Admin-authored Notice popup — only shown on the plain
                User's dashboard, right after they land here post-login. */}
            <NoticePopup token={token} user={user} />
          </>
        )}
        </Suspense>
      </main>

      {/* This footer line is web-only — hidden on the Capacitor Android APK
          build so mobile app users never see it, while the website keeps
          showing it exactly as before. */}
      {!Capacitor.isNativePlatform() && (
        <footer className="py-6 text-center text-xs" style={{ background: 'var(--g-text)', color: '#9aa0a6' }}>
          <p>CredenceHR — an in-house application of Credence Housing Limited</p>
          <p className="mt-1">&copy; 2026 Credence Housing Limited. All rights reserved.</p>
        </footer>
      )}
        </div>
      </div>

      <ApkModal
        isOpen={isApkModalOpen}
        onClose={() => setIsApkModalOpen(false)}
      />

      {/* Docked chat launcher — web only (see the component's own md:flex),
          bottom-right, above everything else. Navbar's ChatBell up top still
          opens the same place; this is just a second, always-visible way in.
          Hidden while the native in-app Chat page or this button's own popup
          is already open. */}
      <FloatingChatButton token={token || ''} onOpenChat={openChatPopup} hidden={showChat || showChatPopup} />

      {/* FloatingChatButton's popup — a centered card sized like
          NewLeaveApplicationModal (max-w-3xl, rounded-2xl, its own backdrop)
          instead of taking over the whole screen the way showChat above
          does. ChatPanel's own Back arrow is mobile-only (md:hidden), so
          this needs its own close button + backdrop-click-to-close. */}
      {showChatPopup && user && (
        <div
          className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4"
          onClick={(e) => { if (e.target === e.currentTarget) setShowChatPopup(false); }}
        >
          <div
            className="bg-white border border-slate-200 rounded-2xl max-w-3xl w-full overflow-hidden shadow-2xl flex flex-col relative"
            style={{ height: '85vh', maxHeight: '720px' }}
          >
            <button
              type="button"
              onClick={() => setShowChatPopup(false)}
              title="Close"
              aria-label="Close chat"
              className="absolute top-3 right-3 z-10 p-1.5 bg-white/90 text-slate-500 hover:text-slate-900 hover:bg-slate-100 rounded-full shadow transition-colors"
            >
              <X className="w-4 h-4" />
            </button>
            <Suspense fallback={<AppLoader />}>
              <ChatPanel
                user={user}
                token={token || ''}
                onBack={() => setShowChatPopup(false)}
                variant="modal"
              />
            </Suspense>
          </div>
        </div>
      )}

      {showExitPrompt && (
        <div
          className="fixed left-1/2 -translate-x-1/2 z-[100] px-4 py-2.5 rounded-full text-sm font-medium text-white shadow-lg"
          style={{
            bottom: 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 20px)',
            background: 'rgba(15, 23, 42, 0.92)'
          }}
        >
          Press back again to exit
        </div>
      )}
    </div>
  );
}