import React, { useState } from 'react';
import { User } from '../types';
import { ChevronLeft, Mail, ShieldCheck, User as UserIcon, Lock, Info, LogOut, BadgeCheck, Building2, UserCircle2, Package } from 'lucide-react';
import { PersonalDataForm } from './PersonalDataForm';
import { ChangePasswordForm } from './ChangePasswordForm';
import { ChangeUsernameForm } from './ChangeUsernameForm';
import { AssetManagement } from './AssetManagement';
import { useProfilePhoto } from '../lib/useProfilePhoto';
import { BACKGROUND_THEMES, BackgroundThemeId, applyBackgroundTheme, getSavedBackgroundTheme } from '../lib/backgroundTheme';

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
  const [username, setUsername] = useState(user.username || '');
  const [bgTheme, setBgTheme] = useState<BackgroundThemeId>(getSavedBackgroundTheme());
  const handlePickBackgroundTheme = (id: BackgroundThemeId) => {
    applyBackgroundTheme(id);
    setBgTheme(id);
  };
  const initial = (user.name || user.username || '?').trim().charAt(0).toUpperCase();
  const roleLabel = user.role.charAt(0).toUpperCase() + user.role.slice(1);
  const photoUrl = useProfilePhoto(token, photoVersion);

  if (showPersonalData) {
    return (
      <PersonalDataForm
        token={token}
        onBack={() => setShowPersonalData(false)}
        onSaved={onProfileNameUpdated}
        onPhotoUpdated={onPhotoUpdated}
      />
    );
  }

  if (showChangePassword) {
    return <ChangePasswordForm token={token} onBack={() => setShowChangePassword(false)} />;
  }

  if (showChangeUsername) {
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

  if (showAssetManagement) {
    // AssetManagement.tsx now carries its own Leave-Application-style
    // header/back link (see AssetManagement.tsx's return) — same component
    // App.tsx's Asset Management sidebar entry renders, so both entry
    // points land on an identical page.
    return <AssetManagement onBack={() => setShowAssetManagement(false)} />;
  }

  return (
    <div className="w-full">

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
                <stop offset="0%" stopColor="#7F00FF" />
                <stop offset="50%" stopColor="#6300C6" />
                <stop offset="100%" stopColor="#47008E" />
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
              <div
                className="w-[104px] h-[104px] rounded-full bg-white flex items-center justify-center text-3xl font-semibold overflow-hidden"
                style={{ color: 'var(--g-accent)', border: '3px solid rgba(255,255,255,0.55)' }}
              >
                {photoUrl ? <img src={photoUrl} alt={user.name} className="w-full h-full object-cover" /> : initial}
              </div>
              <div className="mt-3 flex items-center gap-1.5 text-white text-base font-semibold">
                {user.name}
                <BadgeCheck className="w-4 h-4" style={{ color: '#C9A6FF' }} />
              </div>
              <div className="text-xs text-white/80 mt-0.5">{roleLabel}</div>
            </div>
          </div>
        </div>

        <div className="px-4 -mt-8 relative space-y-4 pb-8">
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
              <BackgroundThemePicker selected={bgTheme} onPick={handlePickBackgroundTheme} />
            </section>
          </div>

          <div>
            <p className="text-[11px] font-medium uppercase tracking-wide mb-2 px-1" style={{ color: 'var(--g-text-muted)' }}>
              Settings
            </p>
            <section className="gemini-card overflow-hidden">
              <ProfileRow icon={<Lock className="w-4 h-4" />} label="Change Password" onClick={() => setShowChangePassword(true)} />
              {!!username && (
                <ProfileRow icon={<UserCircle2 className="w-4 h-4" />} label="Change Username" onClick={() => setShowChangeUsername(true)} />
              )}
              <ProfileRow icon={<Info className="w-4 h-4" />} label="Version Info" muted />
              <ProfileRow
                icon={<LogOut className="w-4 h-4" style={{ color: '#B3261E' }} />}
                label="Logout"
                labelColor="#B3261E"
                onClick={onLogout}
                last
              />
            </section>
          </div>
        </div>
      </div>

      {/* ---------------- Desktop layout ----------------
          max-w-5xl, not 3xl: at 3xl this sat as a 768px column stranded in
          the middle of the content area beside the sidebar, which read as the
          phone layout blown up rather than a desktop page. */}
      <div className="hidden md:block max-w-5xl mx-auto px-6 py-8">
        <button
          type="button"
          onClick={onBack}
          className="flex items-center gap-1.5 text-sm mb-6 hover:opacity-70 transition-opacity"
          style={{ color: 'var(--g-text-muted)' }}
        >
          <ChevronLeft className="w-4 h-4" />
          Back
        </button>

        <section className="gemini-card p-6 flex items-center gap-5">
          <div
            className="w-16 h-16 rounded-full flex items-center justify-center text-xl font-semibold shrink-0 overflow-hidden"
            style={{ background: 'var(--g-accent-soft)', color: 'var(--g-accent)' }}
          >
            {photoUrl ? <img src={photoUrl} alt={user.name} className="w-full h-full object-cover" /> : initial}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 text-lg font-semibold">
              {user.name}
              <BadgeCheck className="w-4 h-4" style={{ color: 'var(--g-accent)' }} />
            </div>
            <p className="text-sm mt-0.5" style={{ color: 'var(--g-text-muted)' }}>
              {roleLabel} &middot; Credence Housing Limited
            </p>
          </div>
          <span
            className="text-xs font-medium px-3 py-1 rounded-full shrink-0"
            style={{ background: 'var(--g-accent-soft)', color: 'var(--g-accent-hover)' }}
          >
            {roleLabel}
          </span>
        </section>

        {/* Two columns rather than one stacked run: Contact and Personal Data
            are two or three lines each, so side by side with Settings they
            fill the width instead of leaving most of the page empty. */}
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-4 mt-4 items-start">
          <div className="lg:col-span-1 space-y-4">
            <section className="gemini-card p-5">
              <p className="text-[11px] font-medium uppercase tracking-wide mb-3" style={{ color: 'var(--g-text-muted)' }}>
                Contact
              </p>
              <div className="flex items-center gap-2.5 py-1.5 text-sm">
                <Mail className="w-4 h-4 shrink-0" style={{ color: 'var(--g-accent)' }} />
                <span className="truncate">{user.email || username || '—'}</span>
              </div>
              <div className="flex items-center gap-2.5 py-1.5 text-sm">
                <Building2 className="w-4 h-4 shrink-0" style={{ color: 'var(--g-accent)' }} />
                <span>Credence Housing Limited, Dhaka</span>
              </div>
            </section>

            {/* `block` matters: a <button> centres its content vertically, so
                whenever this card was stretched to match the one beside it,
                its heading sat lower than that card's and the two rows
                visibly failed to line up. */}
            <button
              type="button"
              onClick={() => setShowPersonalData(true)}
              className="gemini-card p-5 block w-full text-left hover:opacity-80 transition-opacity"
            >
              <p className="text-[11px] font-medium uppercase tracking-wide mb-3" style={{ color: 'var(--g-text-muted)' }}>
                Personal Data
              </p>
              <div className="flex items-center justify-between gap-2.5 py-1.5 text-sm">
                <div className="flex items-center gap-2.5">
                  <UserIcon className="w-4 h-4 shrink-0" style={{ color: 'var(--g-accent)' }} />
                  <span>Edit your details</span>
                </div>
                <ChevronLeft className="w-4 h-4 rotate-180 shrink-0" style={{ color: 'var(--g-text-muted)' }} />
              </div>
            </button>
          </div>

          <section className="gemini-card lg:col-span-2 overflow-hidden">
            {/* pt-5, matching the p-5 on the cards beside it, so this heading
                and theirs sit on the same line now that they're side by side. */}
            <p className="text-[11px] font-medium uppercase tracking-wide px-5 pt-5 pb-1" style={{ color: 'var(--g-text-muted)' }}>
              Appearance
            </p>
            <div className="border-b" style={{ borderColor: 'var(--g-border)' }}>
              <BackgroundThemePicker selected={bgTheme} onPick={handlePickBackgroundTheme} padded />
            </div>
            <p className="text-[11px] font-medium uppercase tracking-wide px-5 pt-4 pb-1" style={{ color: 'var(--g-text-muted)' }}>
              Settings
            </p>
            <ProfileRow icon={<Package className="w-4 h-4" />} label="My Asset" onClick={() => setShowAssetManagement(true)} padded />
            <ProfileRow icon={<Lock className="w-4 h-4" />} label="Change Password" onClick={() => setShowChangePassword(true)} padded />
            {!!username && (
              <ProfileRow icon={<UserCircle2 className="w-4 h-4" />} label="Change Username" onClick={() => setShowChangeUsername(true)} padded />
            )}
            <ProfileRow
              icon={<LogOut className="w-4 h-4" style={{ color: '#B3261E' }} />}
              label="Logout"
              labelColor="#B3261E"
              onClick={onLogout}
              last
              padded
            />
          </section>
        </div>
      </div>
    </div>
  );
};

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
  padded?: boolean;
}> = ({ selected, onPick, padded }) => (
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
  </div>
);