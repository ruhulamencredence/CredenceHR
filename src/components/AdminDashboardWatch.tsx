/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Dashboard -> the cards that say what is waiting on someone:
//   - applications stuck at one approval layer for 3+ days (whose desk),
//   - New Joiner Onboarding (waiting for the joiner / HR / appointment letter),
//   - Exit / Offboarding (leaving this week, clearance open, settlement unpaid),
//   - Loan requests and Mobile Bill (limit requests, SIMs over their limit),
//   - Recruitment (open posts, interviews today / this week, offers out).
// Each card reads its own module's API with the viewer's token, so a card
// whose module (or layer) the account doesn't have gets a 403 and is simply
// not drawn — the same rule as the module's own page.

import React, { useEffect, useState } from 'react';
import { Briefcase, ChevronRight, Clock, DoorOpen, Smartphone, UserPlus, Wallet } from 'lucide-react';
import { apiUrl } from '../lib/api';

async function get<T>(path: string, token: string): Promise<T | null> {
  try {
    const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return null;
    return (await res.json()) as T;
  } catch {
    return null;
  }
}

const ymd = (d: Date) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
const today = () => ymd(new Date());
const plusDays = (n: number) => ymd(new Date(Date.now() + n * 86400000));
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const shortDate = (v: any) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(v || ''));
  return m ? `${Number(m[3])} ${MONTHS[Number(m[2]) - 1]}` : '—';
};
const timeOf = (v: any) => {
  const m = /(\d{2}):(\d{2})/.exec(String(v || '').slice(10));
  if (!m) return '';
  const h = Number(m[1]);
  return `${h % 12 || 12}:${m[2]} ${h < 12 ? 'AM' : 'PM'}`;
};
const tk = (n: any) => `৳${Math.round(Number(n) || 0).toLocaleString('en-IN')}`;
const daysText = (d: number) => (d === 0 ? 'today' : d === 1 ? '1 day' : `${d} days`);
const nameOf = (x: any) => (x && typeof x === 'object' ? x.name : x) || '—';

const card = 'bg-white/90 border border-white rounded-[22px] p-5 shadow-[0_6px_20px_-12px_rgba(31,38,135,0.25)]';

const Head: React.FC<{ icon: React.ElementType; color: string; title: string; note?: string; onOpen?: () => void }> = ({ icon: Icon, color, title, note, onOpen }) => (
  <div className="flex items-center justify-between gap-3 mb-3">
    <h3 className="text-sm font-bold text-slate-900 flex items-center gap-2 min-w-0">
      <span className="w-7 h-7 rounded-full flex items-center justify-center shrink-0" style={{ background: `${color}1A`, color }}>
        <Icon className="w-4 h-4" />
      </span>
      <span className="truncate">{title}</span>
      {note && <span className="text-[11px] font-medium text-slate-400 whitespace-nowrap">{note}</span>}
    </h3>
    {onOpen && (
      <button type="button" onClick={onOpen} className="text-[11px] font-semibold text-blue-600 hover:underline flex items-center gap-0.5 shrink-0">
        Open <ChevronRight className="w-3.5 h-3.5" />
      </button>
    )}
  </div>
);

// A figure with its label; red when it needs attention.
const Stat: React.FC<{ label: string; value: number | string; tone?: 'red' | 'amber' | 'slate'; onClick?: () => void }> = ({ label, value, tone = 'slate', onClick }) => {
  const zero = value === 0 || value === '0';
  const cls = zero ? 'bg-slate-50 text-slate-400' : tone === 'red' ? 'bg-rose-50 text-rose-700' : tone === 'amber' ? 'bg-amber-50 text-amber-800' : 'bg-slate-50 text-slate-800';
  return (
    <button type="button" onClick={onClick} disabled={!onClick} className={`text-left rounded-xl px-3 py-2 ${cls} ${onClick ? 'hover:shadow-sm' : 'cursor-default'}`}>
      <p className="text-lg font-bold leading-tight">{value}</p>
      <p className="text-[11px] leading-snug">{label}</p>
    </button>
  );
};

const Row: React.FC<{ title: React.ReactNode; sub?: React.ReactNode; right?: React.ReactNode; tone?: 'red' | 'amber'; onClick?: () => void }> = ({ title, sub, right, tone, onClick }) => (
  <button
    type="button"
    onClick={onClick}
    disabled={!onClick}
    className={`w-full min-w-0 overflow-hidden text-left text-xs px-3 py-2 rounded-lg border ${tone === 'red' ? 'bg-rose-50/70 border-rose-200' : tone === 'amber' ? 'bg-amber-50/60 border-amber-200' : 'bg-white border-slate-100'} ${onClick ? 'hover:shadow-sm' : 'cursor-default'}`}
  >
    <div className="flex items-center justify-between gap-2">
      <span className="font-semibold text-slate-800 truncate">{title}</span>
      {right && <span className="text-[10px] font-bold shrink-0">{right}</span>}
    </div>
    {sub && <div className="text-[11px] text-slate-500 truncate">{sub}</div>}
  </button>
);

interface Stuck {
  days: number;
  total: number;
  by_kind: { label: string; tab: string; count: number }[];
  items: { kind: string; label: string; tab: string; id: number; requester: string; detail: string | null; layer: string; step: number | null; total_steps: number | null; approvers: string[]; since: string; days_waiting: number }[];
}

export const AdminDashboardWatch: React.FC<{ token: string; onNavigate?: (tab: string) => void }> = ({ token, onNavigate }) => {
  const [stuck, setStuck] = useState<Stuck | null>(null);
  const [joiners, setJoiners] = useState<any[] | null>(null);
  const [exits, setExits] = useState<any | null>(null);
  const [loans, setLoans] = useState<any[] | null>(null);
  const [mobileReqs, setMobileReqs] = useState<any[] | null>(null);
  const [mobileBills, setMobileBills] = useState<{ month: string; rows: any[] } | null>(null);
  const [postings, setPostings] = useState<any[] | null>(null);
  const [candidates, setCandidates] = useState<any[] | null>(null);
  const [showAllStuck, setShowAllStuck] = useState(false);
  const go = (tab: string) => (onNavigate ? () => onNavigate(tab) : undefined);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const month = today().slice(0, 7);
      const [s, j, e, l, mr, mb, p, c] = await Promise.all([
        get<Stuck>('/api/admin-dashboard/stuck?days=3', token),
        get<any[]>('/api/hr-ops/joiner-onboarding', token),
        get<any>('/api/exit-requests/pending', token),
        get<any[]>('/api/payroll/advance-requests?status=pending', token),
        get<any[]>('/api/mobile-bill/requests', token),
        get<{ month: string; rows: any[] }>(`/api/mobile-bill/bills?month=${month}`, token),
        get<any[]>('/api/job-postings', token),
        get<any[]>('/api/job-candidates', token)
      ]);
      // No bill imported for this month yet: show last month's.
      let bills = mb;
      if (bills && !bills.rows.some((r) => r.amount != null)) {
        const d = new Date();
        d.setDate(1);
        d.setMonth(d.getMonth() - 1);
        const prev = await get<{ month: string; rows: any[] }>(`/api/mobile-bill/bills?month=${ymd(d).slice(0, 7)}`, token);
        if (prev && prev.rows.some((r) => r.amount != null)) bills = prev;
      }
      if (cancelled) return;
      setStuck(s);
      setJoiners(j);
      setExits(e);
      setLoans(l);
      setMobileReqs(mr);
      setMobileBills(bills);
      setPostings(p);
      setCandidates(c);
    })();
    return () => {
      cancelled = true;
    };
  }, [token]);

  // ---- Onboarding
  const live = (joiners || []).filter((a) => !['cancelled', 'expired'].includes(a.status));
  const jDraft = live.filter((a) => a.status === 'draft');
  const jSubmitted = live.filter((a) => a.status === 'submitted');
  const jReturned = live.filter((a) => a.status === 'rejected');
  const jNoLetter = live.filter((a) => a.status === 'approved' && !a.appointment_letter);
  const daysSince = (v: any) => {
    const d = /^\d{4}-\d{2}-\d{2}/.exec(String(v || ''))?.[0];
    return d ? Math.max(0, Math.round((Date.parse(today()) - Date.parse(d)) / 86400000)) : 0;
  };

  // ---- Loans / mobile
  const loanRows = (loans || []).filter((r) => r.request_kind !== 'advance');
  const advanceRows = (loans || []).filter((r) => r.request_kind === 'advance');
  const mPending = (mobileReqs || []).filter((r) => r.status === 'pending');
  const overLimit = (mobileBills?.rows || []).filter((r) => Number(r.excess) > 0).sort((a, b) => Number(b.excess) - Number(a.excess));

  // ---- Recruitment
  const openPosts = (postings || []).filter((p) => p.status === 'open');
  const postTitle = new Map<number, string>((postings || []).map((p) => [Number(p.id), p.title]));
  const scheduled = (candidates || []).filter((c) => c.status === 'interview_scheduled');
  const withTime = scheduled.filter((c) => c.interview_at).sort((a, b) => String(a.interview_at).localeCompare(String(b.interview_at)));
  const t0 = today();
  const wk = plusDays(6);
  const interviewsToday = withTime.filter((c) => String(c.interview_at).slice(0, 10) === t0);
  const interviewsWeek = withTime.filter((c) => String(c.interview_at).slice(0, 10) >= t0 && String(c.interview_at).slice(0, 10) <= wk);
  const offers = (candidates || []).filter((c) => c.status === 'offered');

  const showJoiners = joiners !== null;
  const showExits = exits !== null;
  const showMoney = loans !== null || mobileReqs !== null || mobileBills !== null;
  const showRecruit = postings !== null && candidates !== null;
  if (!stuck && !showJoiners && !showExits && !showMoney && !showRecruit) return null;

  const stuckList = stuck ? (showAllStuck ? stuck.items : stuck.items.slice(0, 6)) : [];

  return (
    <div className="space-y-4">
      {stuck && (
        <div className={`${card} ${stuck.total ? 'border-rose-200' : ''}`}>
          <Head icon={Clock} color="#E11D48" title="Stuck for 3+ days" note={stuck.total ? `${stuck.total} waiting at one approval layer` : 'nothing stuck'} />
          {stuck.total === 0 ? (
            <p className="text-xs text-slate-400 py-2">No application has been waiting at the same layer for 3 days or more. 👍</p>
          ) : (
            <>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {stuck.by_kind.map((k) => (
                  <button key={k.label} type="button" onClick={go(k.tab)} className="text-[11px] font-semibold px-2.5 py-1 rounded-full bg-rose-50 text-rose-700 border border-rose-200 hover:shadow-sm">
                    {k.label}: {k.count}
                  </button>
                ))}
              </div>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 min-w-0">
                {stuckList.map((it) => (
                  <Row
                    key={`${it.kind}-${it.id}`}
                    tone={it.days_waiting >= 7 ? 'red' : 'amber'}
                    onClick={go(it.tab)}
                    title={`${it.label} — ${it.requester}`}
                    right={<span className={it.days_waiting >= 7 ? 'text-rose-600' : 'text-amber-700'}>{daysText(it.days_waiting)}</span>}
                    sub={`${it.layer}${it.step && it.total_steps ? ` (${it.step}/${it.total_steps})` : ''} · ${it.approvers.join(' or ') || 'no approver set'}${it.detail ? ` · ${it.detail.replace(/\d{4}-\d{2}-\d{2}/g, (d) => shortDate(d))}` : ''}`}
                  />
                ))}
              </div>
              {stuck.items.length > 6 && (
                <button type="button" onClick={() => setShowAllStuck((v) => !v)} className="mt-2 text-[11px] font-semibold text-blue-600 hover:underline">
                  {showAllStuck ? 'Show fewer' : `Show all ${stuck.items.length}`}
                </button>
              )}
            </>
          )}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4 [&>*]:min-w-0">
        {showJoiners && (
          <div className={card}>
            <Head icon={UserPlus} color="#2563EB" title="New Joiners" note="onboarding" onOpen={go('hr_operations')} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <Stat label="Waiting for the joiner to submit" value={jDraft.length} tone="slate" />
              <Stat label="Submitted — HR to review / approve" value={jSubmitted.length} tone="amber" onClick={go('hr_operations')} />
              <Stat label="Sent back to the joiner" value={jReturned.length} tone="slate" />
              <Stat label="Approved — no appointment letter" value={jNoLetter.length} tone="red" onClick={go('hr_operations')} />
            </div>
            <div className="space-y-1.5">
              {jSubmitted.slice(0, 4).map((a) => (
                <Row key={a.id} tone="amber" onClick={go('hr_operations')} title={a.name} right={<span className="text-amber-700">{daysText(daysSince(a.submitted_at))}</span>} sub={`Submitted ${shortDate(a.submitted_at)} · ${a.designation || '—'}${a.joining_date ? ` · joins ${shortDate(a.joining_date)}` : ''}`} />
              ))}
              {jNoLetter.slice(0, 4).map((a) => (
                <Row key={`l${a.id}`} tone="red" onClick={go('hr_operations')} title={`${a.name}${a.employee_code ? ` (${a.employee_code})` : ''}`} right={<span className="text-rose-600">letter due</span>} sub={`Approved${a.reviewed_at ? ` ${shortDate(a.reviewed_at)}` : ''} · Appointment Letter not issued`} />
              ))}
              {!jSubmitted.length && !jNoLetter.length && <p className="text-xs text-slate-400 py-1">Nothing waiting on HR.</p>}
            </div>
          </div>
        )}

        {showExits && (
          <div className={card}>
            <Head icon={DoorOpen} color="#9333EA" title="Offboarding" note={`${exits.summary?.open ?? 0} open`} onOpen={go('exit_offboarding')} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <Stat label="Last working day within 7 days" value={exits.summary?.leaving_7_days ?? 0} tone="amber" onClick={go('exit_offboarding')} />
              <Stat label="Past last day, not settled" value={exits.summary?.past_last_day ?? 0} tone="red" onClick={go('exit_offboarding')} />
              <Stat label="Clearance items open" value={exits.summary?.clearance_open ?? 0} tone="amber" />
              <Stat label="Settlement not paid" value={exits.summary?.settlement_unpaid ?? 0} tone="slate" />
            </div>
            <div className="space-y-1.5">
              {(exits.exits || []).slice(0, 5).map((x: any) => (
                <Row
                  key={x.id}
                  tone={x.days_left !== null && x.days_left < 0 ? 'red' : x.days_left !== null && x.days_left <= 7 ? 'amber' : undefined}
                  onClick={go('exit_offboarding')}
                  title={`${x.name}${x.department ? ` · ${x.department}` : ''}`}
                  right={
                    x.days_left === null ? <span className="text-slate-400">no date</span> : x.days_left < 0 ? <span className="text-rose-600">{-x.days_left}d past</span> : <span className="text-amber-700">{x.days_left === 0 ? 'today' : `in ${x.days_left}d`}</span>
                  }
                  sub={`Last day ${shortDate(x.last_working_day)} · clearance ${x.clearance_done}/${x.clearance_total}${(x.pending || []).length ? ` · ${(x.pending || []).map((p: any) => p.label).slice(0, 2).join(', ')}` : ''}`}
                />
              ))}
              {!(exits.exits || []).length && <p className="text-xs text-slate-400 py-1">No exit in progress.</p>}
            </div>
          </div>
        )}

        {showMoney && (
          <div className={card}>
            <Head icon={Wallet} color="#059669" title="Loans & Mobile Bill" />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              {loans !== null && <Stat label="Loan requests waiting" value={loanRows.length} tone="amber" onClick={go('payroll')} />}
              {loans !== null && <Stat label="Salary advance requests" value={advanceRows.length} tone="amber" onClick={go('payroll')} />}
              {mobileReqs !== null && <Stat label="Mobile limit-raise requests" value={mPending.length} tone="amber" onClick={go('mobile_bill')} />}
              {mobileBills !== null && <Stat label={`SIMs over limit (${MONTHS[Number(mobileBills.month.slice(5, 7)) - 1] || mobileBills.month} bill)`} value={overLimit.length} tone="red" onClick={go('mobile_bill')} />}
            </div>
            <div className="space-y-1.5">
              {loans !== null &&
                [...loanRows, ...advanceRows].slice(0, 3).map((r) => (
                  <Row
                    key={`a${r.id}`}
                    onClick={go('payroll')}
                    title={`${r.employee_name || '—'} — ${r.request_kind === 'advance' ? 'Salary advance' : 'Loan'} ${tk(r.total_amount)}`}
                    right={<span className="text-amber-700">{daysText(daysSince(r.created_at))}</span>}
                    sub={r.chain_status === 'in_progress' ? 'In the approval chain' : 'Waiting for Payroll to decide'}
                  />
                ))}
              {mobileReqs !== null &&
                mPending.slice(0, 3).map((r) => (
                  <Row
                    key={`m${r.id}`}
                    onClick={go('mobile_bill')}
                    title={`${nameOf(r.employee) !== '—' ? nameOf(r.employee) : r.user_name || '—'} — limit ${tk(r.current_limit)} → ${tk(r.requested_limit)}`}
                    sub={`${r.phone_number || ''}${r.chain?.waiting_on?.length ? ` · waiting on ${r.chain.waiting_on.join(' or ')}` : ''}`}
                  />
                ))}
              {mobileBills !== null &&
                overLimit.slice(0, 3).map((r) => (
                  <Row key={`o${r.sim_id}`} tone="red" onClick={go('mobile_bill')} title={`${nameOf(r.employee)} — ${r.phone_number}`} right={<span className="text-rose-600">+{tk(r.excess)}</span>} sub={`Bill ${tk(r.amount)} · limit ${tk(r.limit_amount)}`} />
                ))}
              {!loanRows.length && !advanceRows.length && !mPending.length && !overLimit.length && <p className="text-xs text-slate-400 py-1">Nothing waiting.</p>}
            </div>
          </div>
        )}

        {showRecruit && (
          <div className={card}>
            <Head icon={Briefcase} color="#EA580C" title="Recruitment" onOpen={go('recruitment')} />
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 mb-3">
              <Stat label={`Open posts (${openPosts.reduce((t, p) => t + (Number(p.vacancy_count) || 1), 0)} vacancies)`} value={openPosts.length} onClick={go('recruitment')} />
              <Stat label="Interviews today" value={interviewsToday.length} tone="amber" onClick={go('recruitment')} />
              <Stat label="Interviews this week" value={interviewsWeek.length} tone="amber" onClick={go('recruitment')} />
              <Stat label="Offers awaiting reply" value={offers.length} tone="amber" onClick={go('recruitment')} />
            </div>
            <div className="space-y-1.5">
              {interviewsWeek.slice(0, 4).map((c) => (
                <Row key={`i${c.id}`} tone={String(c.interview_at).slice(0, 10) === t0 ? 'amber' : undefined} onClick={go('recruitment')} title={c.name} right={<span className="text-slate-600">{String(c.interview_at).slice(0, 10) === t0 ? 'today' : shortDate(c.interview_at)} {timeOf(c.interview_at)}</span>} sub={`Interview · ${postTitle.get(Number(c.posting_id)) || '—'}`} />
              ))}
              {offers.slice(0, 3).map((c) => (
                <Row key={`f${c.id}`} onClick={go('recruitment')} title={c.name} right={<span className="text-amber-700">offered</span>} sub={`Offer out · ${postTitle.get(Number(c.posting_id)) || '—'}`} />
              ))}
              {scheduled.length > withTime.length && (
                <p className="text-[11px] text-slate-400">{scheduled.length - withTime.length} “interview scheduled” candidate(s) have no interview time set.</p>
              )}
              {!interviewsWeek.length && !offers.length && scheduled.length === withTime.length && <p className="text-xs text-slate-400 py-1">No interviews this week and no offers out.</p>}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
