import React, { useState } from 'react';
import {
  ChevronRight, ChevronDown, X, Building2, FileText, Users, Users2, BarChart3, Upload,
  History, Recycle, Navigation, Bell, Route, ShieldCheck, Wallet, Contact, Plus,
  Calendar,
} from 'lucide-react';
import { User, AdminModuleKey } from '../types';
import credenceLogo from '../assets/credence-logo.png';

export type AdminTab =
  | 'projects' | 'branches' | 'mprs' | 'imports' | 'reports' | 'users' | 'employees' | 'departments'
  | 'attendance' | 'attendance_reports' | 'tracking' | 'recycle' | 'editlog' | 'notices' | 'claims'
  | 'approvals' | 'conveyance';

interface FlatItem {
  tab: AdminTab;
  label: string;
  icon: React.ComponentType<{ className?: string }>;
  count?: number;
}

interface AdminSidebarProps {
  open: boolean;
  onClose: () => void;
  user: User;
  activeTab: AdminTab;
  onSelectTab: (tab: AdminTab) => void;
  canSee: (key: AdminModuleKey) => boolean;
  isSuperAdmin: boolean;
  counts: {
    reports: number;
    projects: number;
    branches: number;
    mprs: number;
    imports: number;
    users: number;
    recycle: number;
  };
  teamPreview: User[];
}

// Mobile-only Admin navigation drawer — a docked, collapsible glass sidebar
// (icon rail <-> full labels) with one expandable group and a flyout submenu
// when collapsed. Replaces the old wrapped pill tab-bar. Visual language
// (profile header, MAIN section, expand/flyout, bottom action card) follows
// the reference the user supplied, translated onto this app's own violet
// brand gradient instead of copying the reference's literal palette.
export const AdminSidebar: React.FC<AdminSidebarProps> = ({
  open, onClose, user, activeTab, onSelectTab, canSee, isSuperAdmin, counts, teamPreview,
}) => {
  const [collapsed, setCollapsed] = useState(false);
  // The one expandable group (mirrors the reference's "Dashboard" item):
  // groups the data/report-heavy modules that a Superadmin sees together.
  const [reportsOpen, setReportsOpen] = useState(true);
  // Only relevant in collapsed (icon-rail) mode — shows the same children as
  // a floating flyout instead of an inline expand, same as the reference.
  const [flyoutOpen, setFlyoutOpen] = useState(false);

  const initials = user.name
    .split(' ')
    .filter(Boolean)
    .slice(0, 2)
    .map((p) => p[0]?.toUpperCase())
    .join('') || 'A';

  const reportsGroup: FlatItem[] = [
    { tab: 'reports', label: 'Reports', icon: BarChart3, count: counts.reports },
    { tab: 'mprs', label: 'MPR Nos', icon: FileText, count: counts.mprs },
    { tab: 'imports', label: 'Data Import', icon: Upload, count: counts.imports },
    { tab: 'recycle', label: 'Job Recycle', icon: Recycle, count: counts.recycle },
    { tab: 'editlog', label: 'MPR Edit Log', icon: History },
  ].filter((i) => canSee(i.tab as AdminModuleKey));

  const flatItems: FlatItem[] = [
    { tab: 'projects', label: 'Projects', icon: Building2, count: counts.projects },
    { tab: 'branches', label: 'Branches', icon: Building2, count: counts.branches },
    { tab: 'users', label: 'Users', icon: Users, count: counts.users },
    { tab: 'employees', label: 'Employees', icon: Contact },
    { tab: 'departments', label: 'Departments', icon: Users2 },
    { tab: 'notices', label: 'Notices', icon: Bell },
    { tab: 'claims', label: 'Movement Claims', icon: Route },
    { tab: 'conveyance', label: 'Conveyance Bill', icon: Wallet },
    { tab: 'approvals', label: 'Approvals', icon: ShieldCheck },
    { tab: 'attendance', label: 'Remote Attendance', icon: Navigation },
    { tab: 'attendance_reports', label: 'Monthly Attendance Report', icon: Calendar },
    { tab: 'tracking', label: 'Employee Tracking', icon: Navigation },
  ].filter((i) => canSee(i.tab as AdminModuleKey));

  const roleAvatarColors: Record<string, string> = {
    superadmin: '#7F00FF',
    admin: '#B36AFF',
    user: '#D2A8FF',
  };

  const selectAndClose = (tab: AdminTab) => {
    onSelectTab(tab);
    setFlyoutOpen(false);
    onClose();
  };

  return (
    <div className="md:hidden">
      {/* Backdrop */}
      <div
        onClick={onClose}
        className={`fixed inset-0 z-[1100] bg-slate-900/40 backdrop-blur-[2px] transition-opacity duration-300 ${
          open ? 'opacity-100 pointer-events-auto' : 'opacity-0 pointer-events-none'
        }`}
      />

      {/* Drawer. z-[1200]/[1100] here (not the app's usual z-40/z-50) on
          purpose — Employee Tracking's Leaflet map (EmployeeTrackingPanel.tsx)
          renders its own zoom +/- control at z-index:1000 by default, which
          sat above this drawer's old z-50 and showed through on top of it
          whenever the sidebar was opened while that page was behind it. */}
      <aside
        className={`fixed left-0 top-0 bottom-0 z-[1200] flex flex-col overflow-visible transition-all duration-300 ease-out ${
          open ? 'translate-x-0' : '-translate-x-[110%]'
        } ${collapsed ? 'w-[84px]' : 'w-[248px]'}`}
        style={{
          background: 'linear-gradient(165deg, rgba(127,0,255,0.94) 0%, rgba(99,0,198,0.94) 55%, rgba(71,0,142,0.96) 100%)',
          boxShadow: '12px 0 40px rgba(47,0,94,0.35)',
          paddingTop: 'var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px))',
        }}
      >
        {/* Collapse/expand toggle riding the right edge, mirrors the reference */}
        <button
          type="button"
          onClick={() => {
            setCollapsed((c) => !c);
            setFlyoutOpen(false);
          }}
          className="absolute -right-3.5 top-16 w-7 h-7 rounded-full bg-white text-[color:var(--g-accent)] shadow-md flex items-center justify-center active:scale-90 transition-transform"
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
        >
          <ChevronRight className={`w-4 h-4 transition-transform duration-300 ${collapsed ? '' : 'rotate-180'}`} />
        </button>

        {/* Mobile close (X), only shown expanded — collapsed rail has enough
            tap-outside affordance via the backdrop already. */}
        {!collapsed && (
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

        {/* Logo — left-aligned at the top of the admin menu header. Inverted to
            white since the source mark is orange-on-transparent and this
            sidebar sits on the dark violet glass surface. Hidden collapsed:
            the wordmark is too wide for the 84px icon rail. */}
        {!collapsed && (
          <div className="w-full px-5 pt-4 flex items-center">
            <img
              src={credenceLogo}
              alt="Credence"
              className="h-6 w-auto opacity-95"
              style={{ filter: 'brightness(0) invert(1)' }}
            />
          </div>
        )}

        {/* Profile header */}
        <div className={`flex flex-col items-center text-center pb-5 ${collapsed ? 'px-2 pt-7' : 'px-5 pt-3'}`}>
          <div
            className="w-11 h-11 rounded-full flex items-center justify-center text-sm font-bold text-white ring-2 ring-white/30"
            style={{ background: roleAvatarColors[user.role] || '#B36AFF' }}
          >
            {initials}
          </div>
          {!collapsed && (
            <>
              <p className="mt-2.5 text-[10px] font-semibold tracking-wide text-white/60">
                {isSuperAdmin ? 'SUPERADMIN' : 'ADMIN'}
              </p>
              <p className="text-sm font-semibold text-white truncate max-w-[190px]">{user.name}</p>
            </>
          )}
        </div>

        <div className="h-px mx-4 bg-white/15" />

        {/* Nav */}
        <nav className="flex-1 overflow-y-auto py-4 px-2.5 space-y-0.5">
          {!collapsed && (
            <p className="px-2.5 mb-1.5 text-[10px] font-semibold tracking-wide text-white/50">MAIN</p>
          )}

          {reportsGroup.length > 0 && (
            <div className="relative">
              <button
                type="button"
                onClick={() => (collapsed ? setFlyoutOpen((f) => !f) : setReportsOpen((o) => !o))}
                className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 transition-colors ${
                  collapsed ? 'justify-center' : ''
                } ${
                  reportsGroup.some((i) => i.tab === activeTab)
                    ? 'bg-white text-[color:var(--g-accent-900)]'
                    : 'text-white/85 hover:bg-white/10'
                }`}
              >
                <BarChart3 className="w-[18px] h-[18px] shrink-0" />
                {!collapsed && (
                  <>
                    <span className="text-[13px] font-semibold flex-1 text-left">Reports</span>
                    <ChevronDown className={`w-3.5 h-3.5 transition-transform duration-200 ${reportsOpen ? 'rotate-180' : ''}`} />
                  </>
                )}
              </button>

              {/* Inline expand (expanded sidebar) */}
              {!collapsed && reportsOpen && (
                <div className="mt-0.5 ml-[13px] pl-3.5 border-l border-white/15 space-y-0.5">
                  {reportsGroup.map(({ tab, label, icon: Icon, count }) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => selectAndClose(tab)}
                      className={`w-full flex items-center gap-2 rounded-lg px-2.5 py-2 text-left transition-colors ${
                        activeTab === tab ? 'bg-white/20 text-white font-semibold' : 'text-white/70 hover:bg-white/10 hover:text-white'
                      }`}
                    >
                      <Icon className="w-3.5 h-3.5 shrink-0" />
                      <span className="text-[12.5px] truncate">{label}{typeof count === 'number' ? ` (${count})` : ''}</span>
                    </button>
                  ))}
                </div>
              )}

              {/* Flyout (collapsed rail) */}
              {collapsed && flyoutOpen && (
                <div
                  className="absolute left-full top-0 ml-3 w-52 rounded-2xl p-2 z-10"
                  style={{
                    background: 'rgba(99,0,198,0.97)',
                    boxShadow: '8px 8px 28px rgba(47,0,94,0.4)',
                  }}
                >
                  {reportsGroup.map(({ tab, label, icon: Icon, count }) => (
                    <button
                      key={tab}
                      type="button"
                      onClick={() => selectAndClose(tab)}
                      className={`w-full flex items-center gap-2.5 rounded-xl px-3 py-2.5 text-left transition-colors ${
                        activeTab === tab ? 'bg-white text-[color:var(--g-accent-900)] font-semibold' : 'text-white/85 hover:bg-white/10'
                      }`}
                    >
                      <Icon className="w-4 h-4 shrink-0" />
                      <span className="text-[13px] truncate">{label}{typeof count === 'number' ? ` (${count})` : ''}</span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {flatItems.map(({ tab, label, icon: Icon, count }) => (
            <button
              key={tab}
              type="button"
              onClick={() => selectAndClose(tab)}
              title={collapsed ? label : undefined}
              className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2.5 transition-colors ${
                collapsed ? 'justify-center' : ''
              } ${
                activeTab === tab ? 'bg-white text-[color:var(--g-accent-900)]' : 'text-white/85 hover:bg-white/10'
              }`}
            >
              <Icon className="w-[18px] h-[18px] shrink-0" />
              {!collapsed && (
                <span className="text-[13px] font-medium truncate">{label}{typeof count === 'number' ? ` (${count})` : ''}</span>
              )}
            </button>
          ))}

          {/* Team preview — real users from this admin's Users tab, echoes the
              reference's contact list without inventing a messaging feature
              that doesn't exist in this app. */}
          {canSee('users') && teamPreview.length > 0 && (
            <div className="pt-4">
              {!collapsed && (
                <div className="flex items-center justify-between px-2.5 mb-1.5">
                  <p className="text-[10px] font-semibold tracking-wide text-white/50">TEAM</p>
                  <button
                    type="button"
                    onClick={() => selectAndClose('users')}
                    className="w-5 h-5 rounded-full flex items-center justify-center text-white/60 hover:text-white hover:bg-white/10"
                    aria-label="See all users"
                  >
                    <Plus className="w-3 h-3" />
                  </button>
                </div>
              )}
              <div className="space-y-0.5">
                {teamPreview.slice(0, 3).map((u) => {
                  const uInitials = u.name.split(' ').filter(Boolean).slice(0, 2).map((p) => p[0]?.toUpperCase()).join('') || '?';
                  return (
                    <button
                      key={u.id}
                      type="button"
                      onClick={() => selectAndClose('users')}
                      className={`w-full flex items-center gap-2.5 rounded-xl px-2.5 py-2 transition-colors text-white/85 hover:bg-white/10 ${collapsed ? 'justify-center' : ''}`}
                    >
                      <span
                        className="w-6 h-6 rounded-full flex items-center justify-center text-[10px] font-bold text-white shrink-0"
                        style={{ background: roleAvatarColors[u.role] || '#B36AFF' }}
                      >
                        {uInitials}
                      </span>
                      {!collapsed && <span className="text-[12.5px] truncate">{u.name}</span>}
                    </button>
                  );
                })}
              </div>
            </div>
          )}
        </nav>

        {/* Bottom quick-action card */}
        {!collapsed ? (
          <div className="p-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)]">
            <div className="rounded-2xl p-4 bg-white/10 border border-white/15">
              <p className="text-[13px] font-semibold text-white">
                {counts.recycle > 0 ? `${counts.recycle} job${counts.recycle === 1 ? '' : 's'} in recycle` : "You're all caught up"}
              </p>
              <p className="mt-1 text-[11.5px] text-white/70 leading-snug">
                {counts.recycle > 0 ? 'Review or restore recycled jobs.' : 'No recycled jobs waiting on you right now.'}
              </p>
              <button
                type="button"
                onClick={() => selectAndClose(counts.recycle > 0 ? 'recycle' : 'reports')}
                className="mt-3 w-full flex items-center justify-center gap-1.5 rounded-full py-2.5 text-[12.5px] font-semibold text-[color:var(--g-accent-900)] bg-white active:scale-[0.98] transition-transform"
              >
                {counts.recycle > 0 ? 'Open Job Recycle' : 'Go to Reports'}
                <ChevronRight className="w-3.5 h-3.5" />
              </button>
            </div>
          </div>
        ) : (
          <div className="p-3 pb-[calc(env(safe-area-inset-bottom,0px)+12px)] flex justify-center">
            <button
              type="button"
              onClick={() => selectAndClose(counts.recycle > 0 ? 'recycle' : 'reports')}
              className="w-11 h-11 rounded-full flex items-center justify-center text-[color:var(--g-accent-900)] bg-white shadow-md active:scale-90 transition-transform"
              aria-label={counts.recycle > 0 ? 'Open Job Recycle' : 'Go to Reports'}
            >
              <ChevronRight className="w-5 h-5" />
            </button>
          </div>
        )}
      </aside>
    </div>
  );
};