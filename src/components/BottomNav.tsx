import React from 'react';
import { LayoutGrid, Wallet, Briefcase, FileText, Edit2, Route, Clock } from 'lucide-react';

export type MobileSection = 'budget' | 'jobs' | 'entries' | 'jobEdit' | 'claim' | 'claims' | 'conveyanceClaim' | 'leave' | 'timesheet' | null;

interface BottomNavProps {
  active: MobileSection;
  onChange: (section: MobileSection) => void;
  canJobEdit: boolean;
  jobsCount?: number;
  entriesCount?: number;
  // Superadmin-gated, same as every other module (see UserPanel's
  // canSeeMovementClaim) — hides the "Claim" tab entirely until the Superadmin
  // grants can_view_movement_claims. Defaults to true so any other caller of
  // this component keeps its previous behavior.
  canViewMovementClaim?: boolean;
  // Same idea, gates the "Budget"/"Jobs"/"Entries" tabs (see UserPanel's
  // canSeeBudgetModule) — ON by default, so any other caller keeps today's
  // behavior unless it explicitly passes false.
  canViewBudgetModule?: boolean;
  // Gates the "Timesheet" tab — Self Service's own Timesheet is not
  // Admin-gated (every account sees it, see GlobalSidebar's selfServiceItems),
  // but ON by default here too so a future permission can hide this tab the
  // same way the others are hidden without another caller needing changes.
  canViewTimesheet?: boolean;
}

interface NavItem {
  key: MobileSection;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  badge?: number;
}

// Mobile-only (APK) bottom tab bar — mirrors the same sections as the
// dashboard tile menu (see UserPanel's mobileActiveSection) so every menu
// item is reachable from a persistent bar instead of only from the tiles.
// Hidden on md+ where all sections already sit side by side.
export function BottomNav({ active, onChange, canJobEdit, jobsCount = 0, entriesCount = 0, canViewMovementClaim = true, canViewBudgetModule = true, canViewTimesheet = true }: BottomNavProps) {
  const items: NavItem[] = [
    { key: null, label: 'Dashboard', icon: LayoutGrid },
    ...(canViewBudgetModule ? [{ key: 'budget' as MobileSection, label: 'Budget', icon: Wallet }] : []),
    ...(canViewBudgetModule ? [{ key: 'jobs' as MobileSection, label: 'Jobs', icon: Briefcase, badge: jobsCount }] : []),
    ...(canViewMovementClaim ? [{ key: 'claim' as MobileSection, label: 'Claim', icon: Route }] : []),
    ...(canViewBudgetModule ? [{ key: 'entries' as MobileSection, label: 'Entries', icon: FileText, badge: entriesCount }] : []),
    ...(canViewTimesheet ? [{ key: 'timesheet' as MobileSection, label: 'Timesheet', icon: Clock }] : []),
    ...(canJobEdit ? [{ key: 'jobEdit' as MobileSection, label: 'Job Edit', icon: Edit2 }] : [])
  ];

  return (
    <nav
      className="md:hidden fixed bottom-0 left-0 right-0 z-40 flex items-stretch gap-1 rounded-t-[26px] px-2 pt-2.5 shadow-[0_-8px_24px_rgba(127,0,255,0.25)]"
      style={{ background: 'var(--g-accent)', paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
    >
      {items.map(({ key, label, icon: Icon, badge }) => {
        const isActive = active === key;
        return (
          <button
            key={label}
            type="button"
            onClick={() => onChange(key)}
            className="relative flex-1 min-w-0 flex flex-col items-center justify-center gap-1 py-1.5 active:scale-95 transition-transform"
          >
            {/* Active-tab indicator pill riding the top edge of the bar. */}
            <span
              className={`absolute -top-2.5 h-1 w-8 rounded-full bg-white transition-opacity duration-200 ${
                isActive ? 'opacity-100' : 'opacity-0'
              }`}
            />
            <span
              className={`relative inline-flex items-center justify-center w-11 h-11 rounded-2xl transition-colors duration-200 ${
                isActive ? 'bg-white/20' : ''
              }`}
            >
              <Icon className={`transition-all duration-200 ${isActive ? 'w-6 h-6 text-white' : 'w-5 h-5 text-white/55'}`} />
              {!!badge && badge > 0 && (
                <span
                  className="absolute top-0.5 right-0.5 text-[9px] font-bold text-white rounded-full min-w-[16px] h-[16px] flex items-center justify-center px-1 shadow-sm"
                  style={{ background: 'var(--g-accent-950)' }}
                >
                  {badge > 99 ? '99+' : badge}
                </span>
              )}
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
    </nav>
  );
}