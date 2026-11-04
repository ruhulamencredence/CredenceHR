// Dashboard header (desktop): today's date, the greeting, one search box for
// pages / people / requests waiting on you (Ctrl K), Check in, quick actions
// and a row of "today" chips. Pages and quick actions come from the sidebar's
// own menu (navRegistry.ts), so nobody is offered a page their account can't
// open; people come from the Employee Directory every account already sees;
// requests are this account's own Approve Application queue.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Search, Plus, X, Clock3 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { getNavEntries, NavEntry } from '../lib/navRegistry';
import type { User } from '../types';

interface Person { id: number; name: string; employee_id?: string | null; designation?: string | null; department?: string | null }
interface Waiting { id: number; source_type: string; source_label?: string; requested_by_name?: string | null }

const SOURCE: Record<string, string> = {
  leave_application: 'Leave', leave_reliever: 'Reliever', leave_direct: 'Leave', user_claim: 'Conveyance claim', claim: 'Check in/out',
  attendance_correction: 'Timesheet correction', asset_requisition: 'Asset requisition', vehicle_requisition: 'Ride', mobile_limit_request: 'Mobile limit',
  advance_request: 'Loan / advance', exit_clearance: 'Exit clearance', hr_action: 'HR action', attendance: 'Attendance'
};
// The usual pages first when nothing is typed (whichever this account has).
const SUGGESTED = ['leaveApplication', 'timesheet', 'approveApplications', 'myPayslips', 'vehicleManagement', 'myTasks'];
const QUICK: [string, string][] = [
  ['leaveApplication', 'Apply leave'],
  ['entry', 'New MPR entry'],
  ['vehicleManagement', 'Book a ride'],
  ['userConveyanceClaims', 'Conveyance claim'],
  ['myTasks', 'Request to HR']
];

const timeText = (v: any) => {
  if (!v) return '';
  const d = new Date(v);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' });
};

export const DashboardGreeting: React.FC<{ token: string; user: User; onCheckIn?: () => void }> = ({ token, user, onCheckIn }) => {
  const auth = { Authorization: `Bearer ${token}` };
  const [now, setNow] = useState(() => new Date());
  const [query, setQuery] = useState('');
  const [open, setOpen] = useState(false);
  const [menu, setMenu] = useState(false);
  const [people, setPeople] = useState<Person[] | null>(null);
  const [waiting, setWaiting] = useState<Waiting[]>([]);
  const [today, setToday] = useState<{ check_in_at: any; check_out_at: any } | null>(null);
  const [tasksDue, setTasksDue] = useState(0);
  const [active, setActive] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 30000);
    return () => clearInterval(t);
  }, []);

  // Today's status for the chips.
  useEffect(() => {
    if (user.can_use_attendance) {
      fetch(apiUrl('/api/attendance/today-summary'), { headers: auth })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setToday(d))
        .catch(() => {});
    }
    fetch(apiUrl('/api/my-approvals'), { headers: auth })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setWaiting(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    if (user.role === 'superadmin' || user.can_view_tasks) {
      fetch(apiUrl('/api/tasks/mine'), { headers: auth })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          const todayStr = new Date().toISOString().slice(0, 10);
          const list: any[] = d?.assigned || [];
          setTasksDue(list.filter((t) => t.status !== 'done' && t.status !== 'cancelled' && t.due_date && String(t.due_date).slice(0, 10) <= todayStr).length);
        })
        .catch(() => {});
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  // People load the first time the search opens.
  useEffect(() => {
    if (!open || people !== null) return;
    fetch(apiUrl('/api/employee-directory'), { headers: auth })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setPeople(Array.isArray(rows) ? rows : Array.isArray(rows?.employees) ? rows.employees : []))
      .catch(() => setPeople([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  // Ctrl K / ⌘K opens the search; outside click and Esc close.
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        inputRef.current?.focus();
        setOpen(true);
        setMenu(false);
      } else if (e.key === 'Escape') {
        setOpen(false);
        setMenu(false);
      }
    };
    const away = (e: MouseEvent) => {
      const t = e.target as Node;
      if (!boxRef.current?.contains(t)) setOpen(false);
      if (!menuRef.current?.contains(t)) setMenu(false);
    };
    window.addEventListener('keydown', key);
    document.addEventListener('mousedown', away);
    return () => {
      window.removeEventListener('keydown', key);
      document.removeEventListener('mousedown', away);
    };
  }, []);

  const nav = getNavEntries();
  const navBy = (k: string) => nav.find((n) => n.key === k);
  const go = (fn?: () => void) => () => {
    setOpen(false);
    setMenu(false);
    setQuery('');
    fn?.();
  };

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase();
    const pages: NavEntry[] = q
      ? nav.filter((n) => n.label.toLowerCase().includes(q)).slice(0, 7)
      : (SUGGESTED.map((k) => nav.find((n) => n.key === k)).filter(Boolean) as NavEntry[]).slice(0, 5);
    const dir = navBy('employeeDirectory');
    const ppl = q && people
      ? people.filter((p) => [p.name, p.employee_id, p.designation, p.department].some((v) => String(v || '').toLowerCase().includes(q))).slice(0, 6)
      : [];
    const approve = navBy('approveApplications');
    const reqs = waiting
      .filter((w) => !q || `${SOURCE[w.source_type] || w.source_type} ${w.requested_by_name || ''} ${w.source_label || ''}`.toLowerCase().includes(q))
      .slice(0, 4);
    const out: { title: string; items: { key: string; label: string; sub: string; tile: string; tone: string; pick: () => void }[] }[] = [];
    if (pages.length) out.push({ title: 'Pages', items: pages.map((p) => ({ key: `p-${p.key}`, label: p.label, sub: 'Open page', tile: p.label.slice(0, 2).toUpperCase(), tone: 'bg-violet-100 text-violet-800', pick: go(p.onClick) })) });
    if (ppl.length && dir) out.push({ title: 'People', items: ppl.map((p) => ({ key: `e-${p.id}`, label: p.name, sub: [p.employee_id, p.designation, p.department].filter(Boolean).join(' · '), tile: p.name.split(' ').map((w) => w[0]).slice(0, 2).join(''), tone: 'bg-sky-100 text-sky-800', pick: go(dir.onClick) })) });
    if (reqs.length && approve) out.push({ title: 'Waiting for you', items: reqs.map((w) => ({ key: `r-${w.source_type}-${w.id}`, label: `${SOURCE[w.source_type] || w.source_type} — ${w.requested_by_name || 'someone'}`, sub: w.source_label || '', tile: '•', tone: 'bg-amber-100 text-amber-800', pick: go(approve.onClick) })) });
    return out;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, people, waiting, nav.length]);
  const flat = groups.flatMap((g) => g.items);
  useEffect(() => setActive(0), [query]);

  const h = now.getHours();
  const greeting = h < 12 ? 'Good morning' : h < 17 ? 'Good afternoon' : 'Good evening';
  const firstName = (user.name || '').split(' ')[0];
  const checkedIn = timeText(today?.check_in_at);
  const checkedOut = timeText(today?.check_out_at);
  const quick = QUICK.map(([k, label]) => ({ entry: navBy(k), label })).filter((x) => x.entry);

  const chip = 'h-9 px-3.5 rounded-full text-[13px] font-semibold inline-flex items-center gap-2 transition-colors';
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-wrap items-end justify-between gap-5">
        <div className="flex items-end gap-4">
          <div className="w-[66px] h-[70px] rounded-2xl bg-white border border-slate-200 flex flex-col items-center justify-center shrink-0" aria-hidden="true">
            <span className="text-[11px] font-bold tracking-[0.08em] text-rose-700">{now.toLocaleDateString('en-US', { month: 'short' }).toUpperCase()}</span>
            <span className="text-[28px] font-extrabold leading-none text-slate-900">{now.getDate()}</span>
          </div>
          <div className="flex flex-col gap-1">
            <span className="text-[13px] text-slate-500">
              {now.toLocaleDateString('en-US', { weekday: 'long' })} · {greeting}, {firstName}
            </span>
            <h1 className="m-0 text-[26px] font-extrabold tracking-tight text-slate-900">What do you need today?</h1>
          </div>
        </div>

        <div className="flex items-center gap-2.5 flex-[0_1_580px] min-w-0">
          <div ref={boxRef} className="relative flex-1 min-w-0">
            <label className={`h-[46px] flex items-center gap-2.5 px-3.5 bg-white border rounded-[14px] transition-shadow ${open ? 'border-violet-400 shadow-[0_0_0_4px_#ede7ff]' : 'border-slate-200'}`}>
              <Search className="w-[17px] h-[17px] text-slate-500 shrink-0" />
              <input
                ref={inputRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setOpen(true);
                }}
                onFocus={() => {
                  setOpen(true);
                  setMenu(false);
                }}
                onKeyDown={(e) => {
                  if (e.key === 'ArrowDown') {
                    e.preventDefault();
                    setActive((a) => Math.min(flat.length - 1, a + 1));
                  } else if (e.key === 'ArrowUp') {
                    e.preventDefault();
                    setActive((a) => Math.max(0, a - 1));
                  } else if (e.key === 'Enter' && flat[active]) {
                    flat[active].pick();
                  }
                }}
                placeholder="Search a person, page or request…"
                aria-label="Search pages, people and requests"
                className="flex-1 min-w-0 border-0 outline-none bg-transparent text-sm text-slate-900"
              />
              {query ? (
                <button type="button" onClick={() => setQuery('')} aria-label="Clear search" className="p-1 text-slate-400 hover:text-slate-700">
                  <X className="w-4 h-4" />
                </button>
              ) : (
                <kbd className="text-[11px] text-slate-500 border border-slate-200 rounded-md px-1.5 py-0.5 font-sans">Ctrl K</kbd>
              )}
            </label>
            {open && (
              <div className="absolute top-[54px] left-0 right-0 z-40 bg-white border border-slate-200 rounded-2xl shadow-[0_18px_40px_-18px_rgba(28,26,36,0.35)] p-2 max-h-[380px] overflow-y-auto">
                {groups.map((g) => (
                  <div key={g.title}>
                    <div className="px-2.5 pt-2 pb-1 text-[11px] font-bold tracking-[0.06em] uppercase text-slate-500">{g.title}</div>
                    {g.items.map((it) => {
                      const i = flat.indexOf(it);
                      return (
                        <button
                          key={it.key}
                          type="button"
                          onClick={it.pick}
                          onMouseEnter={() => setActive(i)}
                          className={`w-full text-left px-2.5 py-2 rounded-xl flex items-center gap-3 ${i === active ? 'bg-violet-50' : ''}`}
                        >
                          <span className={`w-8 h-8 rounded-[10px] flex items-center justify-center text-xs font-extrabold shrink-0 ${it.tone}`}>{it.tile}</span>
                          <span className="min-w-0">
                            <span className="block text-sm font-semibold text-slate-900 truncate">{it.label}</span>
                            {it.sub && <span className="block text-xs text-slate-500 truncate">{it.sub}</span>}
                          </span>
                        </button>
                      );
                    })}
                  </div>
                ))}
                {groups.length === 0 && <p className="px-3 py-5 text-center text-sm text-slate-500">{query ? `Nothing found for “${query}”.` : 'Type to search.'}</p>}
              </div>
            )}
          </div>

          {!!user.can_use_attendance && onCheckIn && (
            <button
              type="button"
              onClick={onCheckIn}
              className={`h-[46px] px-4 rounded-[14px] text-white text-sm font-semibold inline-flex items-center gap-2 shrink-0 ${checkedIn && !checkedOut ? 'bg-slate-900 hover:bg-slate-800' : 'bg-violet-700 hover:bg-violet-800'}`}
            >
              <Clock3 className="w-4 h-4" />
              {checkedIn && !checkedOut ? 'Check out' : 'Check in'}
            </button>
          )}
          {quick.length > 0 && (
            <div ref={menuRef} className="relative shrink-0">
              <button
                type="button"
                onClick={() => {
                  setMenu((m) => !m);
                  setOpen(false);
                }}
                aria-label="Quick actions"
                aria-expanded={menu}
                className={`w-[46px] h-[46px] rounded-[14px] border border-slate-200 flex items-center justify-center ${menu ? 'bg-violet-50' : 'bg-white hover:bg-slate-50'}`}
              >
                <Plus className="w-[18px] h-[18px] text-slate-800" />
              </button>
              {menu && (
                <div className="absolute top-[54px] right-0 z-40 w-60 bg-white border border-slate-200 rounded-2xl shadow-[0_18px_40px_-18px_rgba(28,26,36,0.35)] p-1.5">
                  {quick.map((q) => (
                    <button key={q.label} type="button" onClick={go(q.entry!.onClick)} className="w-full text-left px-3 py-2.5 rounded-xl text-sm font-medium text-slate-800 hover:bg-violet-50">
                      {q.label}
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        {!!user.can_use_attendance && (
          checkedIn ? (
            <button type="button" onClick={go(navBy('timesheet')?.onClick)} className={`${chip} bg-emerald-50 text-emerald-800 hover:bg-emerald-100`}>
              <span className="w-[7px] h-[7px] rounded-full bg-emerald-500" />
              Checked in at {checkedIn}
              {checkedOut ? ` · out ${checkedOut}` : ''}
            </button>
          ) : (
            <button type="button" onClick={onCheckIn} className={`${chip} bg-amber-50 text-amber-800 hover:bg-amber-100`}>
              <span className="w-[7px] h-[7px] rounded-full bg-amber-500" />
              Not checked in
            </button>
          )
        )}
        {waiting.length > 0 && navBy('approveApplications') && (
          <button type="button" onClick={go(navBy('approveApplications')!.onClick)} className={`${chip} bg-violet-50 text-violet-900 hover:bg-violet-100`}>
            {waiting.length} approval{waiting.length === 1 ? '' : 's'} waiting
          </button>
        )}
        {tasksDue > 0 && navBy('myTasks') && (
          <button type="button" onClick={go(navBy('myTasks')!.onClick)} className={`${chip} bg-violet-50 text-violet-900 hover:bg-violet-100`}>
            {tasksDue} task{tasksDue === 1 ? '' : 's'} due
          </button>
        )}
      </div>
    </div>
  );
};
