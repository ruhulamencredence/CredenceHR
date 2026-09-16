import React, { useState, lazy, Suspense } from 'react';
import { Lock, ArrowUp, MapPin, Download } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import credenceLogo from '../assets/credence-logo.png';
import { apiUrl } from '../lib/api';

// Lazy-loaded: keeps lottie-react (a fairly heavy animation library) out of
// the very first JS chunk the app has to download+parse before anything
// shows on screen — see AuthHeroLottie.tsx. The login form below renders
// immediately either way; only this decorative animation pops in a beat
// later once its own chunk is ready.
const AuthHeroLottie = lazy(() => import('./AuthHeroLottie'));

interface AuthScreenProps {
  onLoginSuccess: (token: string, user: any) => void;
}

// Styled after the Gemini app's home screen: a quiet near-white canvas, a
// small Lottie hero animation as the one signature color accent, a large
// centered greeting, and a single pill-shaped input area.
export const AuthScreen: React.FC<AuthScreenProps> = ({ onLoginSuccess }) => {
  // Accepts either an Email (Admin-created accounts) or a Project Name (bulk-created
  // accounts log in with Project Name + Password, spaces are ignored) — sent to the
  // server as a single "identifier" field.
  const [identifier, setIdentifier] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  // Shown while we're specifically waiting on the location permission prompt /
  // GPS fix, distinct from the generic "Signing in…" state so the user knows
  // why nothing has happened yet if the OS permission dialog is slow to appear.
  const [locating, setLocating] = useState(false);

  // Location is only requested/required on the ANDROID APP (Capacitor native
  // build). On the plain WEB build (opened in a desktop/mobile browser),
  // login works as before with no location prompt at all.
  const isNativeApp = Capacitor.isNativePlatform();

  // Location permission is mandatory before login is allowed on the app
  // (Admin decision): if the user declines, login is blocked rather than
  // proceeding without a location. Only the LATEST login's coordinates are
  // ever kept — no history.
  const requestLoginLocation = async (): Promise<{ latitude: number; longitude: number }> => {
    // Dynamically imported (only ever called on the native app, isNativeApp
    // gated below) rather than a top-level import — same reasoning as the
    // Lottie split above: keeps this plugin's JS out of the chunk the login
    // form itself has to wait on, since it's only needed once the user
    // actually taps Sign In.
    const { Geolocation } = await import('@capacitor/geolocation');
    let status: string;
    try {
      status = (await Geolocation.checkPermissions()).location;
    } catch {
      status = 'prompt';
    }
    if (status !== 'granted') {
      try {
        status = (await Geolocation.requestPermissions()).location;
      } catch {
        throw new Error('Location permission is required to sign in. Please allow location access and try again.');
      }
    }
    if (status !== 'granted') {
      throw new Error('Location permission is required to sign in. Please allow location access and try again.');
    }
    try {
      const pos = await Geolocation.getCurrentPosition({ enableHighAccuracy: true, timeout: 15000 });
      return { latitude: pos.coords.latitude, longitude: pos.coords.longitude };
    } catch {
      throw new Error("Couldn't get your location. Please check that GPS/Location is turned on and try again.");
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);

    try {
      let coords: { latitude: number; longitude: number } | null = null;
      if (isNativeApp) {
        setLocating(true);
        try {
          coords = await requestLoginLocation();
        } finally {
          setLocating(false);
        }
      }

      const res = await fetch(apiUrl('/api/auth/login'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(
          coords
            ? { identifier, password, latitude: coords.latitude, longitude: coords.longitude, platform: 'app' }
            : { identifier, password }
        ),
      });

      const data = await res.json();
      if (!res.ok) {
        throw new Error(data.error || 'Authentication failed');
      }

      onLoginSuccess(data.token, data.user);
    } catch (err: any) {
      setError(
        err instanceof TypeError
          ? "Couldn't reach the server. Check that the server is running and reachable."
          : err.message || 'Something went wrong'
      );
    } finally {
      setLoading(false);
    }
  };

  return (
    <div
      className="min-h-dvh flex flex-col items-center justify-center px-5 py-6 sm:py-12 relative overflow-hidden"
      style={{ background: 'var(--g-bg-gradient)', paddingTop: 'calc(env(safe-area-inset-top, 0px) + 1.5rem)' }}
    >
      {/* Soft centered glow, sky blue fading into the violet brand accent —
          matches the Gemini app's home screen composition rather than
          corner-anchored blobs. */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(ellipse 900px 650px at 50% 55%, rgba(139, 195, 255, 0.50) 0%, rgba(180, 160, 255, 0.28) 40%, rgba(255, 255, 255, 0) 72%)',
        }}
      />

      <div className="w-full max-w-md lg:max-w-4xl relative z-10 lg:flex lg:items-center lg:gap-16">
        {/* Left side (desktop only): logo + hero animation, large and vertically
            centered next to the form. On mobile these stack above the form
            instead — see the lg:hidden duplicate block below. */}
        <div className="hidden lg:flex lg:w-1/2 flex-col items-center text-center">
          <img src={credenceLogo} alt="Credence" className="h-14 w-auto mb-6" />
          <div className="w-72 h-72 pointer-events-none">
            <Suspense fallback={<div className="w-full h-full" />}>
              <AuthHeroLottie className="w-full h-full" />
            </Suspense>
          </div>
        </div>

        {/* Mobile: logo + a smaller Lottie hero animation above the form
            (hidden on desktop, where the block above takes over on the left
            side instead, at full size). */}
        <div className="flex lg:hidden flex-col items-center text-center mb-4 sm:mb-6">
          <img src={credenceLogo} alt="Credence" className="h-9 sm:h-11 w-auto mb-3 sm:mb-4" />
          <div className="w-36 h-36 sm:w-44 sm:h-44 pointer-events-none">
            <Suspense fallback={<div className="w-full h-full" />}>
              <AuthHeroLottie className="w-full h-full" />
            </Suspense>
          </div>
        </div>

        {/* Right side (desktop) / below (mobile): greeting + the sign-in form,
            so "Welcome back" always sits directly above the fields it belongs to. */}
        <div className="lg:w-1/2">
        <div className="text-center lg:text-left mb-5">
          <h1 className="text-2xl sm:text-3xl font-semibold tracking-tight gemini-gradient-text mb-2">
            Welcome back
          </h1>
          <p className="text-sm" style={{ color: 'var(--g-text-muted)' }}>
            Sign in to CredenceHR to continue
          </p>
        </div>
        <div className="gemini-card px-6 py-6 sm:px-8 sm:py-8">
          {error && (
            <div
              className="mb-5 text-sm p-3.5 rounded-2xl flex items-center gap-2"
              style={{ background: '#fce8e6', color: '#c5221f' }}
            >
              <span>{error}</span>
            </div>
          )}

          <form className="space-y-4" onSubmit={handleSubmit}>
            <div>
              <label className="block text-xs font-medium mb-1.5 ml-1" style={{ color: 'var(--g-text-muted)' }}>
                Email or Project Name
              </label>
              <input
                type="text"
                required
                value={identifier}
                onChange={(e) => setIdentifier(e.target.value)}
                placeholder="you@company.com or Project Name"
                className="block w-full px-5 py-3.5 rounded-full text-[15px] placeholder-slate-400 focus:outline-none transition-shadow"
                style={{ background: 'var(--g-surface-muted)', border: '1px solid transparent', color: 'var(--g-text)' }}
                onFocus={(e) => (e.currentTarget.style.boxShadow = '0 0 0 2px var(--g-accent)')}
                onBlur={(e) => (e.currentTarget.style.boxShadow = 'none')}
              />
            </div>

            <div>
              <label className="block text-xs font-medium mb-1.5 ml-1" style={{ color: 'var(--g-text-muted)' }}>
                Password
              </label>
              <div className="relative">
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="••••••••"
                  className="block w-full pl-5 pr-11 py-3.5 rounded-full text-[15px] placeholder-slate-400 focus:outline-none transition-shadow"
                  style={{ background: 'var(--g-surface-muted)', border: '1px solid transparent', color: 'var(--g-text)' }}
                  onFocus={(e) => (e.currentTarget.style.boxShadow = '0 0 0 2px var(--g-accent)')}
                  onBlur={(e) => (e.currentTarget.style.boxShadow = 'none')}
                />
                <Lock className="w-4 h-4 absolute right-4 top-1/2 -translate-y-1/2" style={{ color: 'var(--g-text-muted)' }} />
              </div>
            </div>

            <button
              type="submit"
              disabled={loading}
              className="w-full mt-2 flex items-center justify-center gap-2 py-3.5 rounded-full text-white font-medium text-[15px] transition-all disabled:opacity-50"
              style={{ background: 'var(--g-accent)' }}
              onMouseEnter={(e) => !loading && (e.currentTarget.style.background = 'var(--g-accent-hover)')}
              onMouseLeave={(e) => (e.currentTarget.style.background = 'var(--g-accent)')}
            >
              <span>{locating ? 'Getting location…' : loading ? 'Signing in…' : 'Sign in'}</span>
              {!loading && <ArrowUp className="w-4 h-4 rotate-45" />}
            </button>
          </form>

          {isNativeApp && (
            <p className="mt-4 flex items-center justify-center gap-1.5 text-center text-[11px]" style={{ color: 'var(--g-text-muted)' }}>
              <MapPin className="w-3 h-3 shrink-0" />
              Signing in requires sharing your device location.
            </p>
          )}

          <p className="mt-2 text-center text-xs" style={{ color: 'var(--g-text-muted)' }}>
            Don't have an account? Contact your Admin to get one created.
          </p>

          {/* APK download — WEB build only. Someone already inside the native
              Android app has no use for this, so it's hidden there the same
              way the location notice above is shown only for isNativeApp. */}
          {!isNativeApp && (
            <a
              href="/downloads/CredenceHR.apk"
              download
              className="mt-5 flex items-center justify-center gap-2.5 py-3 px-5 rounded-2xl text-white transition-opacity hover:opacity-90"
              style={{ background: '#111318' }}
            >
              <Download className="w-4 h-4 shrink-0" />
              <span className="flex flex-col items-start leading-tight">
                <span className="text-[10px] tracking-wide" style={{ color: 'rgba(255,255,255,0.65)' }}>
                  GET IT ON
                </span>
                <span className="text-[15px] font-medium">Android (APK)</span>
              </span>
            </a>
          )}
        </div>
        </div>
      </div>
    </div>
  );
};