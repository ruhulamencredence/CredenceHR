import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Home, Route, Clock, CalendarClock, Contact, LayoutGrid, X } from 'lucide-react';
import { useScrolling } from '../lib/useScrolling';

export type MobileSection = 'budget' | 'jobs' | 'entries' | 'jobEdit' | 'claim' | 'claims' | 'conveyanceClaim' | 'leave' | 'timesheet' | 'employeeDirectory' | 'noticeBoard' | null;

interface BottomNavProps {
  active: MobileSection;
  onChange: (section: MobileSection) => void;
  canViewMovementClaim?: boolean;
  canViewTimesheet?: boolean;
  // Gates the last tab: shows "Leave" when granted, otherwise falls back to
  // "Directory" (Employee Directory, ungated for every account — see
  // EmployeeDirectory.tsx) so the bar never collapses down to Home alone.
  canViewLeave?: boolean;
  // Self Service modules shown in the More popup (Dashboard only).
  moreItems?: MoreItem[];
}

// One tile in the More popup — same look as the mobile Dashboard's tile menu.
export interface MoreItem {
  key: string;
  label: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
  // Icon badge gradient/glow (Tailwind classes).
  iconBg: string;
  badge?: number;
  onClick: () => void;
}

interface NavItem {
  key: MobileSection;
  label: string;
  icon: React.ComponentType<{ className?: string; style?: React.CSSProperties }>;
}

const BAR_W = 400;
const BAR_H = 80;
const CORNER_R = 26;
const CORNER_BUFFER = 6;
// Extra breathing room reserved on the left/right edges of the icon row
// (in BAR_W units) so the first/last tabs (Home/Leave) sit inset from the
// bar's edges, like the reference image, instead of being flush against
// the rounded corners. Expressed as a % of BAR_W so it applies identically
// to the SVG dip math below and the CSS-positioned icon row, keeping the
// floating circle and its cutout aligned.
const EDGE_PAD = 34;
const EDGE_PAD_PCT = `${(EDGE_PAD / BAR_W) * 100}%`;

// The white circle that rides in the dip: its top edge, in px above the bar
// (where each tab's own circle used to sit), and the slide's easing.
const RIDER_TOP = -11;
const easeInOutCubic = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);
const reducedMotion = () => typeof window !== 'undefined' && !!window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;

function buildBarPath(dip: { center: number; halfWidth: number; depth: number } | null): string {
  const r = CORNER_R;
  const topLeft = `M0 ${r} C0 ${r * 0.45} ${r * 0.45} 0 ${r} 0`;
  const topRight = `H${BAR_W - r} C${BAR_W - r * 0.45} 0 ${BAR_W} ${r * 0.45} ${BAR_W} ${r}`;
  const bottom = `V${BAR_H} H0 Z`;

  if (!dip) {
    return `${topLeft} ${topRight} ${bottom}`;
  }

  const { center, depth } = dip;
  const maxHalfWidth = Math.min(center - (r + CORNER_BUFFER), BAR_W - r - CORNER_BUFFER - center);
  const halfWidth = Math.min(dip.halfWidth, maxHalfWidth);

  if (halfWidth < 16) {
    return `${topLeft} ${topRight} ${bottom}`;
  }

  const left = center - halfWidth;
  const right = center + halfWidth;
  // Wider, gentler shoulders (was 0.62) and a rounder trough floor (was 0.4)
  // so the dip reads as one smooth, shallow wave like image 1, instead of a
  // tighter U with straighter side-walls.
  const outerT = halfWidth * 0.78;
  const innerT = halfWidth * 0.26;

  const dipPath =
    `H${left} ` +
    `C${left + outerT} 0 ${center - innerT} ${depth} ${center} ${depth} ` +
    `C${center + innerT} ${depth} ${right - outerT} 0 ${right} 0`;

  return `${topLeft} ${dipPath} ${topRight} ${bottom}`;
}

export function BottomNav({ active, onChange, canViewMovementClaim = true, canViewTimesheet = true, canViewLeave = true, moreItems = [] }: BottomNavProps) {
  const items: NavItem[] = [
    { key: null, label: 'Home', icon: Home },
    ...(canViewMovementClaim ? [{ key: 'claim' as MobileSection, label: 'Claim', icon: Route }] : []),
    ...(canViewTimesheet ? [{ key: 'timesheet' as MobileSection, label: 'Timesheet', icon: Clock }] : []),
    canViewLeave
      ? { key: 'leave' as MobileSection, label: 'Leave', icon: CalendarClock }
      : { key: 'employeeDirectory' as MobileSection, label: 'Directory', icon: Contact }
  ];

  const activeIndex = items.findIndex((item) => item.key === active);
  // Items are laid out only within the padded region (BAR_W minus the two
  // edge pads), so each of the 4 columns is the same width and the gaps
  // between icon centers come out equal — only the outer margins grow.
  const itemWidth = (BAR_W - 2 * EDGE_PAD) / items.length;
  const centerOf = (index: number) => EDGE_PAD + itemWidth * (index + 0.5);
  // Slightly wider flare (0.82 -> 0.92) and shallower depth (50 -> 36,
  // ~45% of bar height instead of ~62%) to match image 1's low, wide
  // wave instead of a deep narrow notch.
  const dipAt = (center: number) => ({ center, halfWidth: Math.min(110, itemWidth * 0.92), depth: 36 });
  const pathD = buildBarPath(activeIndex >= 0 ? dipAt(centerOf(activeIndex)) : null);

  // Changing tab: ONE white circle rides the dip as it slides, both moved by
  // the same animation frame so they never drift apart, and inside it the
  // old icon is pushed out against the motion while the new one comes in.
  // Moved through refs, not state, so a frame doesn't re-render the bar.
  // pair = the icons in the circle: the one leaving and the one arriving.
  const [pair, setPair] = useState({ out: activeIndex, in: activeIndex });
  if (pair.in !== activeIndex) setPair({ out: pair.in, in: activeIndex });
  const pathRef = useRef<SVGPathElement>(null);
  const riderRef = useRef<HTMLSpanElement>(null);
  const outRef = useRef<HTMLSpanElement>(null);
  const inRef = useRef<HTMLSpanElement>(null);
  const centerRef = useRef<number | null>(null);
  const rafRef = useRef(0);
  useLayoutEffect(() => {
    const path = pathRef.current;
    const rider = riderRef.current;
    const outEl = outRef.current;
    const inEl = inRef.current;
    if (!path || !rider || !outEl || !inEl) return;
    cancelAnimationFrame(rafRef.current);
    const place = (center: number, stretch: number) => {
      path.setAttribute('d', buildBarPath(dipAt(center)));
      rider.style.left = `${(center / BAR_W) * 100}%`;
      rider.style.transform = `translateX(-50%) scale(${1 + stretch * 0.16}, ${1 - stretch * 0.08})`;
    };
    const settle = (center: number) => {
      place(center, 0);
      outEl.style.opacity = '0';
      inEl.style.opacity = '1';
      inEl.style.transform = '';
      rider.style.opacity = '1';
      centerRef.current = center;
    };
    if (activeIndex < 0) {
      path.setAttribute('d', buildBarPath(null));
      rider.style.opacity = '0';
      centerRef.current = null;
      return;
    }
    const to = centerOf(activeIndex);
    const from = centerRef.current;
    if (from === null || from === to || reducedMotion()) {
      settle(to);
      return;
    }
    const dir = Math.sign(to - from);
    // Same 0.28s as the page sliding in (index.css mobile-page-in-forward/back).
    const duration = 280;
    // Timed from the first frame: a frame's timestamp can be from just
    // before this effect ran, which would start the slide slightly backwards.
    let start = -1;
    const step = (now: number) => {
      if (start < 0) start = now;
      const t = Math.min(1, (now - start) / duration);
      const e = easeInOutCubic(t);
      const center = from + (to - from) * e;
      centerRef.current = center;
      place(center, Math.sin(Math.PI * t));
      outEl.style.transform = `translateX(${-dir * 34 * e}px)`;
      outEl.style.opacity = String(1 - e);
      inEl.style.transform = `translateX(${dir * 34 * (1 - e)}px)`;
      inEl.style.opacity = String(e);
      if (t < 1) rafRef.current = requestAnimationFrame(step);
      else settle(to);
    };
    rafRef.current = requestAnimationFrame(step);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pair, activeIndex, items.length]);
  useEffect(() => () => cancelAnimationFrame(rafRef.current), []);
  const OutIcon = items[pair.out]?.icon;
  const InIcon = items[pair.in]?.icon;
  // "More" popup — a liquid glass sheet opened from the round button that
  // sits on the bar's top-right edge. Empty for now; items get added later.
  // Only on the Dashboard (Home); any other page closes it.
  const [moreOpen, setMoreOpen] = useState(false);
  const scrollingAway = useScrolling() && !moreOpen;
  const showMore = active === null;
  useEffect(() => {
    if (!showMore) setMoreOpen(false);
  }, [showMore]);
  // While the More button is on screen, the Credence Assistant is reached
  // from inside it, so its floating button steps aside (index.css).
  useEffect(() => {
    if (!showMore) return;
    document.body.setAttribute('data-more-menu', '');
    return () => document.body.removeAttribute('data-more-menu');
  }, [showMore]);
  useEffect(() => {
    if (!moreOpen) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setMoreOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [moreOpen]);

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40">
      <div className="relative" style={{ height: BAR_H }}>
        {/* Floats on its own just above the bar's right side, not touching it. */}
        {showMore && (
        <button
          type="button"
          onClick={() => setMoreOpen((v) => !v)}
          aria-label="More"
          aria-expanded={moreOpen}
          // Steps aside while the page scrolls, so it doesn't sit on the
          // tiles / rows passing under it.
          style={{ bottom: BAR_H + 14, transform: scrollingAway ? 'translateX(calc(100% + 1.5rem))' : undefined, transition: 'transform 0.3s ease-out' }}
          className="absolute right-4 z-10 flex flex-col items-center justify-center w-11 h-11 rounded-full bg-white/45 backdrop-blur-xl border border-white/70 shadow-[0_8px_20px_-6px_rgba(42,0,85,0.45),inset_0_1px_0_rgba(255,255,255,0.7)] active:scale-95 transition-transform"
        >
          {moreOpen ? (
            <X className="w-5 h-5" style={{ color: 'var(--g-accent)' }} />
          ) : (
            <LayoutGrid className="w-5 h-5" style={{ color: 'var(--g-accent)' }} />
          )}
          <span className="sr-only">More</span>
        </button>
        )}
        {showMore && moreOpen &&
          createPortal(
            <div className="md:hidden fixed inset-0 z-[60]" role="dialog" aria-modal="true" aria-label="More">
              {/* Same liquid-glass sheet as the "Turn on location tracking"
                  notice (TrackingNoticeCard.tsx, .liquid-glass* in
                  index.css) — the house style for popups. Anchored to the
                  round More button: three rounded corners, the bottom-right
                  one square where the button sits. The wrapper does the
                  positioning since .liquid-glass sets position: relative. */}
              <div className="absolute inset-0 liquid-glass-backdrop" onClick={() => setMoreOpen(false)} />
              <div
                className="absolute left-4"
                style={{
                  right: 16 + 44 - 8,
                  bottom: `calc(${BAR_H + 14 + 44 - 8}px + var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))`
                }}
              >
                <div className="liquid-glass liquid-glass-in rounded-[32px] rounded-br-md max-h-[64vh] overflow-y-auto overscroll-contain">
                  {moreItems.length === 0 ? (
                    <p className="px-5 py-6 text-xs text-slate-500 text-center">Nothing else to show here.</p>
                  ) : (
                    <div className="grid grid-cols-3 gap-x-1 gap-y-3.5 px-3 pt-5 pb-4">
                      {moreItems.map(({ key, label, icon: Icon, iconBg, badge, onClick }) => (
                        <button
                          key={key}
                          type="button"
                          onClick={() => {
                            setMoreOpen(false);
                            onClick();
                          }}
                          className="flex flex-col items-center gap-1 active:scale-95 transition-transform"
                        >
                          <span className="liquid-glass-inset relative w-[52px] h-[52px] rounded-[18px] flex items-center justify-center">
                            <span className={`app-tile-icon w-8 h-8 rounded-[10px] bg-gradient-to-br ${iconBg} flex items-center justify-center`}>
                              <Icon className="w-4 h-4 text-white" />
                            </span>
                            {!!badge && (
                              <span className="absolute -top-1 -right-1 text-[9px] font-semibold bg-rose-600 text-white rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1 border-2 border-white">
                                {badge}
                              </span>
                            )}
                          </span>
                          <span className="text-[10.5px] font-medium text-slate-700 text-center leading-tight line-clamp-2 px-0.5">{label}</span>
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              </div>
              {/* The round button stays on top of the backdrop, now as Close. */}
              <button
                type="button"
                onClick={() => setMoreOpen(false)}
                aria-label="Close"
                className="liquid-glass-chip absolute right-4 flex items-center justify-center w-11 h-11 rounded-full active:scale-95 transition-transform"
                style={{ bottom: `calc(${BAR_H + 14}px + var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))` }}
              >
                <X className="w-5 h-5" style={{ color: 'var(--g-accent)' }} />
              </button>
            </div>,
            document.body
          )}
        <svg
          viewBox={`0 0 ${BAR_W} ${BAR_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full drop-shadow-[0_-8px_24px_rgba(var(--g-accent-rgb,127,0,255),0.25)]"
        >
          {/* d is redrawn every frame while the dip slides (above). */}
          <path ref={pathRef} d={pathD} fill="var(--g-accent)" />
        </svg>

        <div
          className="absolute inset-0 flex items-end gap-1 pb-1"
          style={{ paddingLeft: EDGE_PAD_PCT, paddingRight: EDGE_PAD_PCT }}
        >
          {items.map(({ key, label, icon: Icon }, index) => {
            const isActive = index === activeIndex;
            // Push effect: buttons next to the active dip nudge sideways,
            // like they're making room for the blob passing through. Decays
            // to 0px by the time you're 2+ columns away from active.
            const distance = activeIndex >= 0 ? index - activeIndex : 0;
            const pushPx = distance === 0 ? 0 : Math.sign(distance) * Math.max(0, 9 - Math.abs(distance) * 5);
            return (
              <button
                key={label}
                type="button"
                onClick={() => onChange(key)}
                aria-current={isActive ? 'page' : undefined}
                className="relative flex-1 min-w-0 flex flex-col items-center justify-end gap-1 pt-1.5 pb-1"
                style={{
                  transform: `translateX(${pushPx}px)`,
                  transition: 'transform 280ms cubic-bezier(0.4, 0, 0.2, 1)'
                }}
              >
                {/* Circle raised less far above the bar (-top-6 -> -top-4) to
                    match the shallower 36px-deep dip above, so it sits nested
                    into the cutout rather than floating clear of it. Icon
                    bumped from w-5/h-5 to w-6/h-6 so it reads centered and
                    proportionate inside the 52px circle, matching image 1's
                    icon-to-circle ratio. */}
                {/* Inactive icon container: unchanged size, but centered with
                    the same flex rules as the active circle so the icon's
                    optical center lines up across active/inactive states
                    instead of shifting when the circle toggles in/out. */}
                {/* Hidden under the riding circle while this tab is active. */}
                <span
                  className={`relative inline-flex items-center justify-center w-11 h-11 rounded-2xl transition-opacity duration-200 ${
                    isActive ? 'opacity-0' : ''
                  }`}
                >
                  <Icon className="w-5 h-5 text-white/55" />
                </span>
                <span
                  className={`text-[10.5px] leading-tight truncate max-w-[68px] transition-colors duration-200 ${
                    isActive ? 'text-white font-bold' : 'text-white/55 font-medium'
                  }`}
                >
                  {label}
                </span>
              </button>
            );
          })}
        </div>

        {/* The one white circle riding the dip (moved by the effect above);
            the two icon slots inside it are pushed past each other. The
            transparent border with bg-clip-padding keeps the 52px footprint
            the tabs' own circles had, and clips the icons to the white. */}
        <span
          ref={riderRef}
          aria-hidden="true"
          className="pointer-events-none absolute w-[52px] h-[52px] rounded-full bg-white bg-clip-padding border-[4px] border-transparent overflow-hidden will-change-transform"
          style={{ top: RIDER_TOP, opacity: 0, boxShadow: '0 6px 14px rgba(42,0,85,0.35)' }}
        >
          <span ref={outRef} className="absolute inset-0 flex items-center justify-center" style={{ opacity: 0 }}>
            {OutIcon && <OutIcon className="w-6 h-6" style={{ color: 'var(--g-accent)' }} />}
          </span>
          <span ref={inRef} className="absolute inset-0 flex items-center justify-center">
            {InIcon && <InIcon className="w-6 h-6" style={{ color: 'var(--g-accent)' }} />}
          </span>
        </span>
      </div>

      <div style={{ height: 'var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))', background: 'var(--g-accent)' }} />
    </nav>
  );
}