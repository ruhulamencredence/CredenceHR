import React from 'react';
import { Home, Route, Clock, CalendarClock, Contact } from 'lucide-react';

export type MobileSection = 'budget' | 'jobs' | 'entries' | 'jobEdit' | 'claim' | 'claims' | 'conveyanceClaim' | 'leave' | 'timesheet' | 'employeeDirectory' | null;

interface BottomNavProps {
  active: MobileSection;
  onChange: (section: MobileSection) => void;
  canViewMovementClaim?: boolean;
  canViewTimesheet?: boolean;
  // Gates the last tab: shows "Leave" when granted, otherwise falls back to
  // "Directory" (Employee Directory, ungated for every account — see
  // EmployeeDirectory.tsx) so the bar never collapses down to Home alone.
  canViewLeave?: boolean;
}

interface NavItem {
  key: MobileSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
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

export function BottomNav({ active, onChange, canViewMovementClaim = true, canViewTimesheet = true, canViewLeave = true }: BottomNavProps) {
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
  const dip =
    activeIndex >= 0
      ? {
          center: EDGE_PAD + itemWidth * (activeIndex + 0.5),
          // Slightly wider flare (0.82 -> 0.92) and shallower depth (50 -> 36,
          // ~45% of bar height instead of ~62%) to match image 1's low, wide
          // wave instead of a deep narrow notch.
          halfWidth: Math.min(110, itemWidth * 0.92),
          depth: 36
        }
      : null;
  const pathD = buildBarPath(dip);

  return (
    <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40">
      <div className="relative" style={{ height: BAR_H }}>
        <svg
          viewBox={`0 0 ${BAR_W} ${BAR_H}`}
          preserveAspectRatio="none"
          className="absolute inset-0 w-full h-full drop-shadow-[0_-8px_24px_rgba(127,0,255,0.25)]"
        >
          <path
            d={pathD}
            fill="var(--g-accent)"
            style={{ transition: 'd 280ms cubic-bezier(0.4, 0, 0.2, 1)' }}
          />
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
                <span
                  className={`absolute -top-4 left-1/2 -translate-x-1/2 flex items-center justify-center w-[52px] h-[52px] rounded-full bg-white bg-clip-padding border-[4px] border-transparent transition-all duration-200 ${
                    isActive ? 'opacity-100 scale-100' : 'opacity-0 scale-75 pointer-events-none'
                  }`}
                  style={
                    isActive
                      ? {
                          boxShadow: '0 6px 14px rgba(42,0,85,0.35)'
                        }
                      : undefined
                  }
                >
                  <Icon className="w-6 h-6" style={{ color: 'var(--g-accent)' }} />
                </span>
                {/* Inactive icon container: unchanged size, but centered with
                    the same flex rules as the active circle so the icon's
                    optical center lines up across active/inactive states
                    instead of shifting when the circle toggles in/out. */}
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
      </div>

      <div style={{ height: 'var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))', background: 'var(--g-accent)' }} />
    </nav>
  );
}