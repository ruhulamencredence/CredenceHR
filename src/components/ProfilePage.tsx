import React, { useEffect, useState } from 'react';
import { User } from '../types';
import { ChevronLeft, Mail, ShieldCheck, User as UserIcon, Lock, Info, LogOut, BadgeCheck, Building2, UserCircle2, Package, MessageSquareHeart, Fingerprint, BellRing, BookOpen, Camera, Palette, Contact } from 'lucide-react';
import { Employee360 } from './HrOps360';
import { FingerprintSettings } from './FingerprintSettings';
import { NotificationSettings } from './NotificationSettings';
import { Capacitor } from '@capacitor/core';
import { canUseFingerprint } from '../lib/fingerprint';
import { FeedbackPopup, canGiveFeedback } from './feedback/FeedbackPopup';
import { PersonalDataForm } from './PersonalDataForm';
import { ChangePasswordForm } from './ChangePasswordForm';
import { ChangeUsernameForm } from './ChangeUsernameForm';
import { AssetManagement } from './AssetManagement';
import { ModulePath } from './ModulePath';
import { useProfilePhoto } from '../lib/useProfilePhoto';
import { BACKGROUND_THEMES, BackgroundThemeId, applyBackgroundTheme, getSavedBackgroundTheme, MONO_ACCENTS, MonoAccentId, applyMonoAccent, getSavedMonoAccent } from '../lib/backgroundTheme';

interface ProfilePageProps {
  user: User;
  token: string;
  onBack: () => void;
  onLogout: () => void;
  // Called with the new "First Last" full name once Personal Data is saved,
  // so the caller (App.tsx) can refresh user.name everywhere it's shown
  // (Navbar, GlobalSidebar, this page's own header, etc.).
  onProfileNameUpdated: (fullName: string) => void;
  // Called with the new username once Change Username succeeds, so the
  // caller (App.tsx) can refresh user.username everywhere it's shown/used
  // (this page's Contact row, future logins), same idea as
  // onProfileNameUpdated above.
  onUsernameUpdated?: (newUsername: string) => void;
  // Called right after a Personal Data photo upload succeeds, so the caller
  // (App.tsx) can refresh the Navbar/GlobalSidebar avatar immediately —
  // forwarded straight through to PersonalDataForm's own onPhotoUpdated.
  onPhotoUpdated: () => void;
  // Bumped by App.tsx right after that upload succeeds, so this page's own
  // header avatar (both layouts below) also swaps to the new photo right
  // away instead of only after a reload.
  photoVersion?: number;
}

// Read-only profile screen — reference design, translated onto the app's own
// violet gradient brand (WelcomeBanner-style drop header, gemini-card rows).
// The "Personal Data" row/card below opens PersonalDataForm.tsx, "Change
// Password" opens ChangePasswordForm.tsx, and (only for accounts that log in
// with a Project Name + Password rather than an email — see user.username)
// "Change Username" opens ChangeUsernameForm.tsx — all three as in-place
// sub-views (see showPersonalData/showChangePassword/showChangeUsername).
// Every other Account row stays display-only. Mobile and desktop are two
// genuinely different layouts (not just breakpoint reflow of one structure),
// matching how WelcomeBanner/Dashboard already split mobile-only vs
// desktop-only blocks elsewhere in the app.
export const ProfilePage: React.FC<ProfilePageProps> = ({ user, token, onBack, onLogout, onProfileNameUpdated, onUsernameUpdated, onPhotoUpdated, photoVersion }) => {
  const [showPersonalData, setShowPersonalData] = useState(false);
  const [showChangePassword, setShowChangePassword] = useState(false);
  const [showChangeUsername, setShowChangeUsername] = useState(false);
  const [showAssetManagement, setShowAssetManagement] = useState(false);
  // My Service Book (own Employee 360, read only) — only with
  // users.can_view_service_book (the server checks it too, /api/hr-ops/my/p360).
  const canServiceBook = user.role === 'superadmin' || !!user.can_view_service_book;
  // Desktop: the left menu picks what the right side shows (My Service Book
  // first). Phone: two tabs, Service Book and Settings.
  const wide = useMdUp();
  const defaultPanel: Panel = canServiceBook ? 'book' : 'contact';
  const [panel, setPanel] = useState<Panel>(defaultPanel);
  const [mobileTab, setMobileTab] = useState<'book' | 'settings'>(canServiceBook ? 'book' : 'settings');
  const showServiceBook = () => {
    if (!canServiceBook) return;
    setPanel('book');
    setMobileTab('book');
  };
  useEffect(() => {
    try {
      if (sessionStorage.getItem('profile_open') === 'service_book') showServiceBook();
      sessionStorage.removeItem('profile_open');
    } catch {
      // storage unavailable
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  // The Assistant's "My Service Book" button while this page is already open.
  useEffect(() => {
    const onOpen = (e: Event) => {
      if ((e as CustomEvent).detail === 'service_book') showServiceBook();
      try {
        sessionStorage.removeItem('profile_open');
      } catch {
        // storage unavailable
      }
    };
    window.addEventListener('credence:profile-open', onOpen);
    return () => window.removeEventListener('credence:profile-open', onOpen);
  }, [canServiceBook]);
  const [showFeedback, setShowFeedback] = useState(false);
  const [showFingerprint, setShowFingerprint] = useState(false);
  const [showNotifications, setShowNotifications] = useState(false);
  const appVersion = `web ${typeof __APP_BUILD__ !== 'undefined' ? __APP_BUILD__ : ''}`.trim();
  const [username, setUsername] = useState(user.username || '');
  const [bgTheme, setBgTheme] = useState<BackgroundThemeId>(getSavedBackgroundTheme());
  const handlePickBackgroundTheme = (id: BackgroundThemeId) => {
    applyBackgroundTheme(id, true);
    setBgTheme(id);
  };
  const [monoAccent, setMonoAccent] = useState<MonoAccentId>(getSavedMonoAccent());
  const handlePickMonoAccent = (id: MonoAccentId) => {
    applyMonoAccent(id, true);
    setMonoAccent(id);
  };
  const initial = (user.name || user.username || '?').trim().charAt(0).toUpperCase();
  const roleLabel = user.role.charAt(0).toUpperCase() + user.role.slice(1);
  const photoUrl = useProfilePhoto(token, photoVersion);

  if (!wide && showPersonalData) {
    return (
      <PersonalDataForm
        token={token}
        onBack={() => setShowPersonalData(false)}
        onSaved={onProfileNameUpdated}
        onPhotoUpdated={onPhotoUpdated}
      />
    );
  }

  if (!wide && showChangePassword) {
    return <ChangePasswordForm token={token} onBack={() => setShowChangePassword(false)} />;
  }

  if (!wide && showChangeUsername) {
    return (
      <ChangeUsernameForm
        token={token}
        currentUsername={username}
        onBack={() => setShowChangeUsername(false)}
        onSaved={(newUsername) => {
          setUsername(newUsername);
          onUsernameUpdated?.(newUsername);
        }}
      />
    );
  }

  if (!wide && showAssetManagement) {
    // AssetManagement.tsx now carries its own Leave-Application-style
    // header/back link (see AssetManagement.tsx's return) — same component
    // App.tsx's Asset Management sidebar entry renders, so both entry
    // points land on an identical page.
    return <AssetManagement onBack={() => setShowAssetManagement(false)} />;
  }

  return (
    <div className="w-full">
      {showFeedback && <FeedbackPopup token={token} onClose={() => setShowFeedback(false)} />}
      {showNotifications && <NotificationSettings token={token} onClose={() => setShowNotifications(false)} />}
      {showFingerprint && <FingerprintSettings token={token} user={user} onClose={() => setShowFingerprint(false)} />}

      {/* ---------------- Mobile layout ---------------- */}
      <div className="md:hidden">
        <div className="relative">
          <svg
            viewBox="0 0 400 230"
            preserveAspectRatio="none"
            className="absolute inset-0 w-full h-full"
            style={{ filter: 'drop-shadow(0 6px 16px rgba(71,0,142,0.25))' }}
          >
            <defs>
              <linearGradient id="profileHeaderGradientMobile" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" style={{ stopColor: 'var(--g-banner-1, #7F00FF)' }} />
                <stop offset="50%" style={{ stopColor: 'var(--g-banner-2, #6300C6)' }} />
                <stop offset="100%" style={{ stopColor: 'var(--g-banner-3, #47008E)' }} />
              </linearGradient>
            </defs>
            <path
              d="M0,0 L400,0 L400,188 A28,28 0 0 1 372,216 L28,216 A28,28 0 0 1 0,188 Z"
              fill="url(#profileHeaderGradientMobile)"
            />
          </svg>
          <div className="relative px-4 pt-3 pb-14" style={{ paddingTop: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 12px)' }}>
            <button
              type="button"
              onClick={onBack}
              className="w-9 h-9 -ml-1 rounded-full flex items-center justify-center text-white hover:bg-white/10 transition-colors"
              aria-label="Back"
            >
              <ChevronLeft className="w-5 h-5" />
            </button>
            <div className="flex flex-col items-center mt-4">
              <div className="relative">
                <div
                  className="w-[124px] h-[124px] rounded-full bg-white flex items-center justify-center text-4xl font-semibold overflow-hidden shadow-[0_14px_30px_-10px_rgba(0,0,0,0.45)]"
                  style={{ color: 'var(--g-accent)', border: '4px solid rgba(255,255,255,0.7)' }}
                >
                  {photoUrl ? <img src={photoUrl} alt={user.name} className="w-full h-full object-cover" /> : initial}
                </div>
                <button
                  type="button"
                  onClick={() => setShowPersonalData(true)}
                  aria-label="Change photo"
                  className="absolute bottom-1 right-1 w-9 h-9 rounded-full bg-white flex items-center justify-center shadow-md"
                  style={{ color: 'var(--g-accent)' }}
                >
                  <Camera className="w-4 h-4" />
                </button>
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-white text-base font-semibold">
                {user.name}
                <BadgeCheck className="w-4 h-4" style={{ color: 'var(--g-badge-check, #C9A6FF)' }} />
              </div>
              <div className="text-xs text-white/80 mt-0.5">{roleLabel}</div>
            </div>
          </div>
        </div>

        <div className="px-4 -mt-8 relative space-y-4 pb-8">
          {canServiceBook && (
            <div className="gemini-card p-1 flex" role="tablist">
              {(['book', 'settings'] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={mobileTab === t}
                  onClick={() => setMobileTab(t)}
                  className="flex-1 flex items-center justify-center gap-1.5 py-2 rounded-xl text-[13px] font-semibold transition-colors"
                  style={mobileTab === t ? { background: 'var(--g-accent)', color: '#fff' } : { color: 'var(--g-text-muted)' }}
                >
                  {t === 'book' ? <BookOpen className="w-4 h-4" /> : <UserCircle2 className="w-4 h-4" />}
                  {t === 'book' ? 'Service Book' : 'Settings'}
                </button>
              ))}
            </div>
          )}
          {canServiceBook && mobileTab === 'book' && !wide && <Employee360 token={token} employeeId={null} self />}
          {mobileTab === 'settings' && (
          <>
          <section className="gemini-card p-4">
            <p className="text-[11px] font-medium uppercase tracking-wide mb-2" style={{ color: 'var(--g-text-muted)' }}>
              Contact
            </p>
            <div className="flex items-center gap-3 py-2">
              <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: 'var(--g-accent-100)' }}>
                <Mail className="w-4 h-4" style={{ color: 'var(--g-accent)' }} />
              </span>
              <span className="text-sm truncate">{user.email || username || '—'}</span>
            </div>
            <div className="flex items-center gap-3 py-2">
              <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: 'var(--g-accent-100)' }}>
                <ShieldCheck className="w-4 h-4" style={{ color: 'var(--g-accent)' }} />
              </span>
              <span className="text-sm">{roleLabel}</span>
            </div>
          </section>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide mb-2 px-1" style={{ color: 'var(--g-text-muted)' }}>
              Account
            </p>
            <section className="gemini-card overflow-hidden">
              <ProfileRow
                icon={<UserIcon className="w-4 h-4" />}
                label="Personal Data"
                onClick={() => setShowPersonalData(true)}
              />
              <ProfileRow
                icon={<Package className="w-4 h-4" />}
                label="My Asset"
                onClick={() => setShowAssetManagement(true)}
              />
              <ProfileRow icon={<Building2 className="w-4 h-4" />} label="Organization" value="Credence Housing Limited" last />
            </section>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide mb-2 px-1" style={{ color: 'var(--g-text-muted)' }}>
              Appearance
            </p>
            <section className="gemini-card overflow-hidden">
              <BackgroundThemePicker selected={bgTheme} onPick={handlePickBackgroundTheme} accent={monoAccent} onPickAccent={handlePickMonoAccent} />
            </section>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide mb-2 px-1" style={{ color: 'var(--g-text-muted)' }}>
              Settings
            </p>
            <section className="gemini-card overflow-hidden">
              <ProfileRow icon={<Lock className="w-4 h-4" />} label="Change Password" onClick={() => setShowChangePassword(true)} />
              {canUseFingerprint(user) && (
                <ProfileRow icon={<Fingerprint className="w-4 h-4" />} label="Fingerprint login" onClick={() => setShowFingerprint(true)} />
              )}
              {!Capacitor.isNativePlatform() && <ProfileRow icon={<BellRing className="w-4 h-4" />} label="Notifications" onClick={() => setShowNotifications(true)} />}
              {!!username && (
                <ProfileRow icon={<UserCircle2 className="w-4 h-4" />} label="Change Username" onClick={() => setShowChangeUsername(true)} />
              )}
              {canGiveFeedback(user) && (
                <ProfileRow icon={<MessageSquareHeart className="w-4 h-4" />} label="Give feedback" onClick={() => setShowFeedback(true)} />
              )}
              <ProfileRow icon={<Info className="w-4 h-4" />} label="Version Info" value={appVersion} muted />
              <ProfileRow
                icon={<LogOut className="w-4 h-4" style={{ color: '#B3261E' }} />}
                label="Logout"
                labelColor="#B3261E"
                onClick={onLogout}
                last
              />
            </section>
          </div>
          </>
          )}
        </div>
      </div>

      {/* ---------------- Desktop layout ----------------
          A hero header with a large photo, then a menu on the left (icons as
          in the app's own sidebar) and what it opens on the right — My
          Service Book first. */}
      <div className="hidden md:block max-w-[1400px] mx-auto px-6 py-6">
        <ModulePath path={['Profile']} />
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm mb-4 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--g-text-muted)' }}
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>

        <section className="gemini-card overflow-hidden">
          <div
            className="relative h-28 overflow-hidden"
            style={{ background: 'linear-gradient(120deg, var(--g-banner-1, #7F00FF) 0%, var(--g-banner-2, #6300C6) 55%, var(--g-banner-3, #47008E) 100%)' }}
          >
            <span className="absolute -right-10 -top-16 w-64 h-64 rounded-full bg-white/10" />
            <span className="absolute right-40 -bottom-20 w-48 h-48 rounded-full bg-white/10" />
            <span className="absolute left-1/3 -top-10 w-28 h-28 rounded-full bg-white/5" />
          </div>
          <div className="px-7 pb-5 flex items-end gap-5 -mt-16">
            <div className="relative shrink-0">
              <div
                className="w-36 h-36 rounded-full p-[5px] shadow-[0_18px_40px_-12px_rgba(71,0,142,0.55)]"
                style={{ background: 'linear-gradient(140deg, #ffffff 0%, var(--g-accent-100, #EDE9FE) 100%)' }}
              >
                <div
                  className="w-full h-full rounded-full overflow-hidden flex items-center justify-center text-5xl font-semibold"
                  style={{ background: 'var(--g-accent-soft)', color: 'var(--g-accent)' }}
                >
                  {photoUrl ? <img src={photoUrl} alt={user.name} className="w-full h-full object-cover" /> : initial}
                </div>
              </div>
              <button
                type="button"
                onClick={() => setPanel('personal')}
                aria-label="Change photo"
                title="Change photo (Personal Data)"
                className="absolute bottom-2 right-2 w-10 h-10 rounded-full bg-white flex items-center justify-center shadow-md hover:scale-105 transition-transform"
                style={{ color: 'var(--g-accent)' }}
              >
                <Camera className="w-[18px] h-[18px]" />
              </button>
            </div>
            <div className="min-w-0 flex-1 pb-2">
              <div className="flex items-center gap-2 text-2xl font-bold leading-tight">
                <span className="truncate">{user.name}</span>
                <BadgeCheck className="w-5 h-5 shrink-0" style={{ color: 'var(--g-accent)' }} />
              </div>
              <p className="text-sm mt-1 flex flex-wrap items-center gap-x-3 gap-y-1" style={{ color: 'var(--g-text-muted)' }}>
                {(user.email || username) && (
                  <span className="inline-flex items-center gap-1.5">
                    <Mail className="w-4 h-4" /> {user.email || username}
                  </span>
                )}
                <span className="inline-flex items-center gap-1.5">
                  <Building2 className="w-4 h-4" /> Credence Housing Limited
                </span>
              </p>
            </div>
            <span
              className="mb-3 text-xs font-semibold px-3 py-1 rounded-full shrink-0 inline-flex items-center gap-1.5"
              style={{ background: 'var(--g-accent-soft)', color: 'var(--g-accent-hover)' }}
            >
              <ShieldCheck className="w-3.5 h-3.5" /> {roleLabel}
            </span>
          </div>
        </section>

        <div className="grid grid-cols-[240px_minmax(0,1fr)] lg:grid-cols-[260px_minmax(0,1fr)] gap-5 mt-5 items-start">
          <nav className="gemini-card p-2.5 sticky top-4" aria-label="Profile menu">
            <MenuHeading>Profile</MenuHeading>
            {canServiceBook && <MenuItem icon={BookOpen} label="My Service Book" active={panel === 'book'} onClick={() => setPanel('book')} />}
            <MenuItem icon={Contact} label="Contact & Account" active={panel === 'contact'} onClick={() => setPanel('contact')} />
            <MenuItem icon={UserIcon} label="Personal Data" active={panel === 'personal'} onClick={() => setPanel('personal')} />
            <MenuItem icon={Package} label="My Asset" active={panel === 'asset'} onClick={() => setPanel('asset')} />
            <MenuHeading>Preferences</MenuHeading>
            <MenuItem icon={Palette} label="Appearance" active={panel === 'appearance'} onClick={() => setPanel('appearance')} />
            {!Capacitor.isNativePlatform() && <MenuItem icon={BellRing} label="Notifications" onClick={() => setShowNotifications(true)} />}
            {canUseFingerprint(user) && <MenuItem icon={Fingerprint} label="Fingerprint login" onClick={() => setShowFingerprint(true)} />}
            <MenuHeading>Security</MenuHeading>
            <MenuItem icon={Lock} label="Change Password" active={panel === 'password'} onClick={() => setPanel('password')} />
            {!!username && <MenuItem icon={UserCircle2} label="Change Username" active={panel === 'username'} onClick={() => setPanel('username')} />}
            {canGiveFeedback(user) && (
              <>
                <MenuHeading>Help</MenuHeading>
                <MenuItem icon={MessageSquareHeart} label="Give feedback" onClick={() => setShowFeedback(true)} />
              </>
            )}
            <div className="my-2 border-t" style={{ borderColor: 'var(--g-border)' }} />
            <MenuItem icon={LogOut} label="Logout" danger onClick={onLogout} />
            <p className="px-3 pt-2 pb-1 text-[11px]" style={{ color: 'var(--g-text-muted)' }}>
              {appVersion}
            </p>
          </nav>

          <div className="min-w-0">
            {wide && panel === 'book' && canServiceBook && <Employee360 token={token} employeeId={null} self />}
            {panel === 'contact' && (
              <section className="gemini-card p-6">
                <p className="text-[11px] font-medium uppercase tracking-wide mb-3" style={{ color: 'var(--g-text-muted)' }}>
                  Contact &amp; Account
                </p>
                <div className="grid sm:grid-cols-2 gap-3">
                  <InfoTile icon={Mail} label="Email" value={user.email || '—'} />
                  <InfoTile icon={UserCircle2} label="Username" value={username || '—'} />
                  <InfoTile icon={ShieldCheck} label="Role" value={roleLabel} />
                  <InfoTile icon={Building2} label="Organization" value="Credence Housing Limited, Dhaka" />
                </div>
              </section>
            )}
            {panel === 'appearance' && (
              <section className="gemini-card overflow-hidden">
                <p className="text-[11px] font-medium uppercase tracking-wide px-5 pt-5 pb-1" style={{ color: 'var(--g-text-muted)' }}>
                  Appearance
                </p>
                <BackgroundThemePicker selected={bgTheme} onPick={handlePickBackgroundTheme} accent={monoAccent} onPickAccent={handlePickMonoAccent} padded />
              </section>
            )}
            {wide && panel === 'personal' && (
              <PersonalDataForm token={token} onBack={() => setPanel(defaultPanel)} onSaved={onProfileNameUpdated} onPhotoUpdated={onPhotoUpdated} />
            )}
            {wide && panel === 'password' && <ChangePasswordForm token={token} onBack={() => setPanel(defaultPanel)} />}
            {wide && panel === 'username' && (
              <ChangeUsernameForm
                token={token}
                currentUsername={username}
                onBack={() => setPanel(defaultPanel)}
                onSaved={(newUsername) => {
                  setUsername(newUsername);
                  onUsernameUpdated?.(newUsername);
                }}
              />
            )}
            {wide && panel === 'asset' && <AssetManagement onBack={() => setPanel(defaultPanel)} />}
          </div>
        </div>
      </div>
    </div>
  );
};

type Panel = 'book' | 'contact' | 'appearance' | 'personal' | 'password' | 'username' | 'asset';

// md and up (768px): the desktop layout. Panels that load data render only
// in the layout actually on screen.
function useMdUp(): boolean {
  const q = '(min-width: 768px)';
  const [on, setOn] = useState(() => (typeof window !== 'undefined' && window.matchMedia ? window.matchMedia(q).matches : true));
  useEffect(() => {
    if (!window.matchMedia) return;
    const m = window.matchMedia(q);
    const f = () => setOn(m.matches);
    m.addEventListener?.('change', f);
    return () => m.removeEventListener?.('change', f);
  }, []);
  return on;
}

const MenuHeading: React.FC<{ children: React.ReactNode }> = ({ children }) => (
  <p className="px-3 pt-3 pb-1 text-[10.5px] font-semibold uppercase tracking-wider" style={{ color: 'var(--g-text-muted)' }}>
    {children}
  </p>
);

// Same shape as the app's sidebar items (GlobalSidebar.tsx renderItem): an
// 18px icon and the label, the open one filled with the accent colour.
const MenuItem: React.FC<{ icon: React.ComponentType<{ className?: string }>; label: string; active?: boolean; danger?: boolean; onClick: () => void }> = ({
  icon: Icon,
  label,
  active,
  danger,
  onClick
}) => (
  <button
    type="button"
    onClick={onClick}
    aria-current={active ? 'page' : undefined}
    className={`w-full flex items-center gap-2.5 px-3 py-2.5 rounded-xl text-[13.5px] text-left transition-colors ${active ? 'font-semibold shadow-sm' : 'hover:bg-[var(--g-accent-100)]'}`}
    style={active ? { background: 'var(--g-accent)', color: '#fff' } : { color: danger ? '#B3261E' : 'var(--g-text, #1f2937)' }}
  >
    <Icon className="w-[18px] h-[18px] shrink-0" />
    <span className="truncate">{label}</span>
  </button>
);

const InfoTile: React.FC<{ icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>; label: string; value: string }> = ({ icon: Icon, label, value }) => (
  <div className="flex items-center gap-3 rounded-2xl border p-3.5" style={{ borderColor: 'var(--g-border)' }}>
    <span className="w-9 h-9 rounded-full flex items-center justify-center shrink-0" style={{ background: 'var(--g-accent-100)' }}>
      <Icon className="w-4 h-4" style={{ color: 'var(--g-accent)' }} />
    </span>
    <span className="min-w-0">
      <span className="block text-[11px] uppercase tracking-wide" style={{ color: 'var(--g-text-muted)' }}>
        {label}
      </span>
      <span className="block text-sm font-medium truncate">{value}</span>
    </span>
  </div>
);

// One tappable/display row shared by both layouts — icon in a tinted circle,
// label, and either a value, a "Coming soon" badge (disabled rows), or a
// chevron (rows that will eventually navigate somewhere once that screen
// exists). `muted`/`disabled` rows have no chevron and aren't clickable, since
// there's nowhere for them to go yet.
const ProfileRow: React.FC<{
  icon: React.ReactNode;
  label: string;
  value?: string;
  labelColor?: string;
  badge?: string;
  muted?: boolean;
  disabled?: boolean;
  last?: boolean;
  padded?: boolean;
  onClick?: () => void;
}> = ({ icon, label, value, labelColor, badge, muted, disabled, last, padded, onClick }) => {
  const clickable = !!onClick && !disabled;
  return (
    <div
      role={clickable ? 'button' : undefined}
      onClick={clickable ? onClick : undefined}
      className={`flex items-center gap-3 ${padded ? 'px-5' : 'px-4'} py-3 ${!last ? 'border-b' : ''} ${clickable ? 'cursor-pointer hover:opacity-80' : ''} ${disabled ? 'opacity-60' : ''}`}
      style={{ borderColor: 'var(--g-border)' }}
    >
      <span className="w-8 h-8 rounded-full flex items-center justify-center shrink-0" style={{ background: 'var(--g-accent-100)', color: 'var(--g-accent)' }}>
        {icon}
      </span>
      <span className="text-sm flex-1 truncate" style={labelColor ? { color: labelColor } : undefined}>
        {label}
      </span>
      {value && (
        <span className="text-sm shrink-0" style={{ color: 'var(--g-text-muted)' }}>
          {value}
        </span>
      )}
      {badge && (
        <span className="text-[11px] font-medium px-2.5 py-1 rounded-full shrink-0" style={{ background: 'var(--g-accent-soft)', color: 'var(--g-accent-hover)' }}>
          {badge}
        </span>
      )}
      {!value && !badge && !muted && (
        <ChevronLeft className="w-4 h-4 rotate-180 shrink-0" style={{ color: 'var(--g-text-muted)' }} />
      )}
    </div>
  );
};

// "Appearance" row — three tappable swatches for the app's own background
// gradient (see backgroundTheme.ts). A per-device preference (localStorage),
// applied immediately on tap; no save/cancel step needed for a one-tap choice
// like this.
const BackgroundThemePicker: React.FC<{
  selected: BackgroundThemeId;
  onPick: (id: BackgroundThemeId) => void;
  // Minimal Mono's colour touch, shown under the swatches while it's picked.
  accent: MonoAccentId;
  onPickAccent: (id: MonoAccentId) => void;
  padded?: boolean;
}> = ({ selected, onPick, accent, onPickAccent, padded }) => (
  <div className={`${padded ? 'px-5' : 'px-4'} py-3.5`}>
    <div className="flex items-center gap-3">
      {BACKGROUND_THEMES.map((theme) => {
        const isSelected = theme.id === selected;
        return (
          <button
            key={theme.id}
            type="button"
            onClick={() => onPick(theme.id)}
            title={theme.label}
            aria-label={`${theme.label} background`}
            className="flex flex-col items-center gap-1.5"
          >
            <span
              className="w-10 h-10 rounded-full flex items-center justify-center transition-shadow"
              style={{
                background: theme.swatch,
                boxShadow: isSelected ? `0 0 0 2.5px var(--g-surface), 0 0 0 4.5px ${theme.swatch}` : 'none'
              }}
            >
              {isSelected && <BadgeCheck className="w-4 h-4 text-white" />}
            </span>
            <span className="text-[11px]" style={{ color: isSelected ? 'var(--g-text)' : 'var(--g-text-muted)' }}>
              {theme.label}
            </span>
          </button>
        );
      })}
    </div>
    {selected === 'mono' && (
      <div className="mt-3 pt-3 border-t" style={{ borderColor: 'var(--g-border)' }}>
        <p className="text-[11px] mb-2" style={{ color: 'var(--g-text-muted)' }}>
          Colour touch — a light colour on the pale parts; text and main buttons stay black.
        </p>
        <div className="flex items-center gap-3 flex-wrap">
          {MONO_ACCENTS.map((a) => {
            const on = a.id === accent;
            return (
              <button key={a.id} type="button" onClick={() => onPickAccent(a.id)} aria-label={`${a.label} colour touch`} className="flex flex-col items-center gap-1">
                <span
                  className="w-7 h-7 rounded-full flex items-center justify-center"
                  style={{
                    background: a.id === 'none' ? 'repeating-linear-gradient(45deg, #f4f4f5 0 4px, #e4e4e7 4px 8px)' : a.swatch,
                    boxShadow: on ? `0 0 0 2px var(--g-surface), 0 0 0 3.5px #18181b` : 'inset 0 0 0 1px rgba(0,0,0,0.06)'
                  }}
                >
                  {on && <BadgeCheck className="w-3.5 h-3.5 text-zinc-900" />}
                </span>
                <span className="text-[10px]" style={{ color: on ? 'var(--g-text)' : 'var(--g-text-muted)' }}>{a.label}</span>
              </button>
            );
          })}
        </div>
      </div>
    )}
  </div>
);