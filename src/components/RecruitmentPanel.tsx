import React, { useEffect, useState } from 'react';
import { UserPlus, Plus, X, AlertTriangle, ChevronDown, ChevronUp, Star, ClipboardCheck, CalendarClock, Mail } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { StartJoinerOnboarding, type OnboardingAccess } from './HrOpsJoinerOnboarding';
import { LoadingBlock } from './LoadingBlock';
import { InterviewModal, CandidateEmailModal, type RecruitmentAccess } from './RecruitmentInterview';

interface RecruitmentPanelProps {
  token: string;
}

interface Posting {
  id: number;
  title: string;
  department: string | null;
  designation: string | null;
  vacancy_count: number;
  status: 'open' | 'on_hold' | 'closed';
  closing_date: string | null;
}

interface Candidate {
  id: number;
  posting_id: number;
  name: string;
  email: string | null;
  phone: string | null;
  source: string | null;
  status: string;
  notes: string | null;
  // The scheduled interview, if any (candidate_interviews).
  interview_id?: number | null;
  interview_at?: string | null;
  interview_mode?: 'in_person' | 'online' | 'phone' | null;
  interview_venue?: string | null;
  interview_link?: string | null;
  // false = the interview changed after the last email to the candidate (or
  // none was sent).
  interview_informed?: boolean | null;
}

// A candidate's New Joiner Onboarding (HR Operations), from
// /api/hr-ops/joiner-onboarding/by-candidate.
interface CandidateOnboarding {
  id: number;
  onb_code: string;
  status: 'draft' | 'submitted' | 'approved' | 'rejected' | 'cancelled' | 'expired';
  employee_code: string | null;
}
const ONBOARDING_CHIP: Record<CandidateOnboarding['status'], { label: string; cls: string }> = {
  draft: { label: 'Onboarding: waiting for joiner', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  submitted: { label: 'Onboarding: submitted', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  rejected: { label: 'Onboarding: sent back', cls: 'bg-rose-50 text-rose-700 border-rose-200' },
  approved: { label: 'Joined', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  cancelled: { label: 'Onboarding: cancelled', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  expired: { label: 'Onboarding: expired', cls: 'bg-slate-100 text-slate-500 border-slate-200' }
};

const CANDIDATE_STATUSES = ['applied', 'shortlisted', 'interview_scheduled', 'interviewed', 'offered', 'hired', 'rejected'];

const POSTING_STATUS_STYLE: Record<string, string> = {
  open: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  on_hold: 'bg-amber-50 text-amber-700 border-amber-200',
  closed: 'bg-slate-100 text-slate-500 border-slate-200'
};

const CANDIDATE_STATUS_STYLE: Record<string, string> = {
  applied: 'bg-slate-100 text-slate-600 border-slate-200',
  shortlisted: 'bg-blue-50 text-blue-700 border-blue-200',
  interview_scheduled: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  interviewed: 'bg-purple-50 text-purple-700 border-purple-200',
  offered: 'bg-amber-50 text-amber-700 border-amber-200',
  hired: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  rejected: 'bg-rose-50 text-rose-700 border-rose-200'
};

// Admin Panel -> HR Advanced -> "Recruitment (ATS)" — job postings and their
// candidate pipeline (applied -> ... -> hired/rejected), plus interview
// scheduling per candidate. Management-only view, same reasoning as the
// other 5 HR Advanced panels.
export const RecruitmentPanel: React.FC<RecruitmentPanelProps> = ({ token }) => {
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [postings, setPostings] = useState<Posting[]>([]);
  const [candidatesByPosting, setCandidatesByPosting] = useState<Record<number, Candidate[]>>({});
  const [expandedPostingId, setExpandedPostingId] = useState<number | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  const [showNewPosting, setShowNewPosting] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [newDepartment, setNewDepartment] = useState('');
  const [newDesignation, setNewDesignation] = useState('');
  const [newVacancy, setNewVacancy] = useState('1');

  const [showNewCandidate, setShowNewCandidate] = useState<number | null>(null);
  const [newCandName, setNewCandName] = useState('');
  const [newCandEmail, setNewCandEmail] = useState('');
  const [newCandPhone, setNewCandPhone] = useState('');
  const [newCandSource, setNewCandSource] = useState('');

  // New Joiner Onboarding, shown only to accounts with an onboarding layer
  // in HR Operations (the server checks the same layers).
  const [onbAccess, setOnbAccess] = useState<OnboardingAccess | null>(null);
  const [onbByCandidate, setOnbByCandidate] = useState<Record<number, CandidateOnboarding>>({});
  const [startingFor, setStartingFor] = useState<number | null>(null);
  const canSeeOnboarding = !!onbAccess && (onbAccess.onboarding_create || onbAccess.onboarding_review || onbAccess.onboarding_approve);
  const loadOnboarding = async () => {
    try {
      const res = await fetch(apiUrl('/api/hr-ops/joiner-onboarding/by-candidate'), { headers: authHeaders });
      if (res.ok) setOnbByCandidate(await res.json());
    } catch {
      // the chips just don't show
    }
  };
  useEffect(() => {
    fetch(apiUrl('/api/hr-ops/joiner-onboarding/access'), { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then((a: OnboardingAccess | null) => {
        setOnbAccess(a);
        if (a && (a.onboarding_create || a.onboarding_review || a.onboarding_approve)) loadOnboarding();
      })
      .catch(() => setOnbAccess(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Emailing candidates is its own explicit permission (layer "email_candidates").
  const [access, setAccess] = useState<RecruitmentAccess | null>(null);
  const [interviewFor, setInterviewFor] = useState<{ postingId: number; c: Candidate } | null>(null);
  const [emailFor, setEmailFor] = useState<{ postingId: number; c: Candidate; kind: 'offered' | 'rejected' | 'custom' } | null>(null);
  useEffect(() => {
    fetch(apiUrl('/api/recruitment/access'), { headers: authHeaders })
      .then((r) => (r.ok ? r.json() : null))
      .then(setAccess)
      .catch(() => setAccess(null));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchPostings = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/job-postings'), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load job postings');
      setPostings(Array.isArray(data) ? data : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load job postings');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchPostings();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const fetchCandidates = async (postingId: number) => {
    try {
      const res = await fetch(apiUrl(`/api/job-candidates?posting_id=${postingId}`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load candidates');
      setCandidatesByPosting((prev) => ({ ...prev, [postingId]: Array.isArray(data) ? data : [] }));
    } catch (err: any) {
      setError(err.message || 'Failed to load candidates');
    }
  };

  const toggleExpand = (postingId: number) => {
    if (expandedPostingId === postingId) {
      setExpandedPostingId(null);
      return;
    }
    setExpandedPostingId(postingId);
    if (!candidatesByPosting[postingId]) fetchCandidates(postingId);
  };

  const createPosting = async () => {
    if (!newTitle.trim()) {
      setError('Job title is required.');
      return;
    }
    setError('');
    try {
      const res = await fetch(apiUrl('/api/job-postings'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          title: newTitle.trim(),
          department: newDepartment.trim() || null,
          designation: newDesignation.trim() || null,
          vacancy_count: Number(newVacancy) || 1
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create posting');
      setPostings((prev) => [data, ...prev]);
      setShowNewPosting(false);
      setNewTitle('');
      setNewDepartment('');
      setNewDesignation('');
      setNewVacancy('1');
    } catch (err: any) {
      setError(err.message || 'Failed to create posting');
    }
  };

  const changePostingStatus = async (id: number, status: string) => {
    try {
      const res = await fetch(apiUrl(`/api/job-postings/${id}`), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ status })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update posting');
      setPostings((prev) => prev.map((p) => (p.id === id ? data : p)));
    } catch (err: any) {
      setError(err.message || 'Failed to update posting');
    }
  };

  const addCandidate = async (postingId: number) => {
    if (!newCandName.trim()) {
      setError('Candidate name is required.');
      return;
    }
    try {
      const res = await fetch(apiUrl('/api/job-candidates'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          posting_id: postingId,
          name: newCandName.trim(),
          email: newCandEmail.trim() || null,
          phone: newCandPhone.trim() || null,
          source: newCandSource.trim() || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add candidate');
      setCandidatesByPosting((prev) => ({ ...prev, [postingId]: [data, ...(prev[postingId] || [])] }));
      setShowNewCandidate(null);
      setNewCandName('');
      setNewCandEmail('');
      setNewCandPhone('');
      setNewCandSource('');
    } catch (err: any) {
      setError(err.message || 'Failed to add candidate');
    }
  };

  const updateCandidateStatus = async (postingId: number, candidateId: number, status: string) => {
    try {
      const res = await fetch(apiUrl(`/api/job-candidates/${candidateId}`), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ status })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update candidate');
      const merged = { ...((candidatesByPosting[postingId] || []).find((c) => c.id === candidateId) || {}), ...data } as Candidate;
      setCandidatesByPosting((prev) => ({
        ...prev,
        [postingId]: (prev[postingId] || []).map((c) => (c.id === candidateId ? { ...c, ...data } : c))
      }));
      // Next step right away: set the interview, or tell the candidate.
      if (status === 'interview_scheduled' && !merged.interview_id) setInterviewFor({ postingId, c: merged });
      else if ((status === 'offered' || status === 'rejected') && access?.email_candidates && merged.email) setEmailFor({ postingId, c: merged, kind: status });
    } catch (err: any) {
      setError(err.message || 'Failed to update candidate');
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <UserPlus className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Recruitment (ATS)</h1>
            <p className="text-xs text-slate-500 mt-0.5 max-w-md">Job postings and their candidate pipeline, applied through hired.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowNewPosting((v) => !v)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> New Posting
        </button>
      </div>

      {showNewPosting && (
        <div className="px-6 py-5 border-b border-slate-200 bg-slate-50/60 flex flex-wrap items-end gap-3">
          <div className="flex-1 min-w-[160px]">
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Job Title</label>
            <input type="text" value={newTitle} onChange={(e) => setNewTitle(e.target.value)} className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl" />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Department</label>
            <input type="text" value={newDepartment} onChange={(e) => setNewDepartment(e.target.value)} className="w-36 px-3 py-2 text-xs border border-slate-200 rounded-xl" />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Designation</label>
            <input type="text" value={newDesignation} onChange={(e) => setNewDesignation(e.target.value)} className="w-36 px-3 py-2 text-xs border border-slate-200 rounded-xl" />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Vacancies</label>
            <input type="number" min={1} value={newVacancy} onChange={(e) => setNewVacancy(e.target.value)} className="w-20 px-3 py-2 text-xs border border-slate-200 rounded-xl" />
          </div>
          <button type="button" onClick={createPosting} className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-xl">
            Create
          </button>
          <button type="button" onClick={() => setShowNewPosting(false)} className="px-2.5 py-2 text-slate-400 hover:text-slate-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

      {error && (
        <div className="mx-6 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <LoadingBlock />
      ) : (
        <div className="p-4 space-y-2.5">
          {postings.map((p) => {
            const expanded = expandedPostingId === p.id;
            const candidates = candidatesByPosting[p.id] || [];
            return (
              <div key={p.id} className="rounded-xl border border-slate-200 overflow-hidden">
                <button type="button" onClick={() => toggleExpand(p.id)} className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50">
                  <div>
                    <p className="text-sm font-semibold text-slate-800">{p.title}</p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      {p.department || '—'} · {p.designation || '—'} · {p.vacancy_count} vacancy(ies)
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${POSTING_STATUS_STYLE[p.status]}`}>{p.status}</span>
                    {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                  </div>
                </button>

                {expanded && (
                  <div className="px-4 pb-4 border-t border-slate-100 pt-4">
                    <div className="flex items-center gap-2 mb-3 flex-wrap">
                      {p.status !== 'open' && (
                        <button type="button" onClick={() => changePostingStatus(p.id, 'open')} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white">
                          Reopen
                        </button>
                      )}
                      {p.status === 'open' && (
                        <button type="button" onClick={() => changePostingStatus(p.id, 'on_hold')} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-amber-500 hover:bg-amber-600 text-white">
                          Put On Hold
                        </button>
                      )}
                      {p.status !== 'closed' && (
                        <button type="button" onClick={() => changePostingStatus(p.id, 'closed')} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-slate-600 hover:bg-slate-700 text-white">
                          Close
                        </button>
                      )}
                      <button
                        type="button"
                        onClick={() => setShowNewCandidate(showNewCandidate === p.id ? null : p.id)}
                        className="flex items-center gap-1 text-[11px] font-semibold px-3 py-1.5 rounded-lg text-blue-600 border border-dashed border-blue-300 hover:bg-blue-50"
                      >
                        <Plus className="w-3 h-3" /> Add Candidate
                      </button>
                    </div>

                    {showNewCandidate === p.id && (
                      <div className="rounded-xl border border-dashed border-blue-300 p-3 mb-3 flex flex-wrap items-end gap-2">
                        <input type="text" placeholder="Name" value={newCandName} onChange={(e) => setNewCandName(e.target.value)} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg w-36" />
                        <input type="email" placeholder="Email" value={newCandEmail} onChange={(e) => setNewCandEmail(e.target.value)} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg w-40" />
                        <input type="text" placeholder="Phone" value={newCandPhone} onChange={(e) => setNewCandPhone(e.target.value)} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg w-32" />
                        <input type="text" placeholder="Source (LinkedIn, referral…)" value={newCandSource} onChange={(e) => setNewCandSource(e.target.value)} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg w-44" />
                        <button type="button" onClick={() => addCandidate(p.id)} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-lg">
                          Add
                        </button>
                      </div>
                    )}

                    <div className="space-y-2">
                      {candidates.map((c) => (
                        <div key={c.id} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-2 rounded-lg border border-slate-100 px-3 py-2">
                          <div className="min-w-0">
                            <p className="text-xs font-semibold text-slate-800 flex items-center gap-1">
                              {c.name}
                              {c.status === 'hired' && <Star className="w-3 h-3 text-amber-500 fill-amber-500" />}
                            </p>
                            <p className="text-[11px] text-slate-400">
                              {c.email || '—'} · {c.phone || '—'} · {c.source || '—'}
                            </p>
                            {c.status === 'interview_scheduled' && (
                              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px]">
                                <button
                                  type="button"
                                  onClick={() => setInterviewFor({ postingId: p.id, c })}
                                  className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border border-indigo-200 bg-indigo-50 text-indigo-700 font-semibold hover:bg-indigo-100"
                                >
                                  <CalendarClock className="w-3 h-3" />
                                  {c.interview_at
                                    ? `${new Date(String(c.interview_at).replace(' ', 'T')).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: 'numeric', minute: '2-digit' })}${c.interview_mode === 'online' ? ' · Online' : c.interview_mode === 'phone' ? ' · Phone' : c.interview_venue ? ` · ${c.interview_venue}` : ''}`
                                    : 'Set interview time'}
                                </button>
                                {c.interview_id && c.email && c.interview_informed === false && (
                                  <span className="inline-flex px-2 py-0.5 rounded-full border border-amber-200 bg-amber-50 text-amber-700 font-semibold">Candidate not emailed yet</span>
                                )}
                                {c.interview_id && c.interview_informed && <span className="inline-flex px-2 py-0.5 rounded-full border border-emerald-200 bg-emerald-50 text-emerald-700 font-semibold">Candidate emailed</span>}
                              </div>
                            )}
                            {c.status === 'hired' && canSeeOnboarding && (() => {
                              const o = onbByCandidate[c.id];
                              const reopen = !o || o.status === 'cancelled' || o.status === 'expired';
                              return (
                                <div className="mt-1 flex flex-wrap items-center gap-1.5">
                                  {o && (
                                    <span className={`inline-flex whitespace-nowrap text-[10px] font-semibold px-2 py-0.5 rounded-full border ${ONBOARDING_CHIP[o.status].cls}`}>
                                      {ONBOARDING_CHIP[o.status].label} · {o.employee_code ? `${o.onb_code} → ${o.employee_code}` : o.onb_code}
                                    </span>
                                  )}
                                  {reopen && onbAccess?.onboarding_create && (
                                    <button
                                      type="button"
                                      onClick={() => setStartingFor(c.id)}
                                      className="inline-flex items-center gap-1 whitespace-nowrap text-[10px] font-semibold px-2 py-0.5 rounded-full bg-blue-600 hover:bg-blue-700 text-white"
                                    >
                                      <ClipboardCheck className="w-3 h-3" /> Start onboarding
                                    </button>
                                  )}
                                </div>
                              );
                            })()}
                          </div>
                          <div className="flex items-center gap-1.5">
                          {(c.status === 'applied' || c.status === 'shortlisted') && (
                            <button type="button" onClick={() => setInterviewFor({ postingId: p.id, c })} className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-indigo-200 text-indigo-700 hover:bg-indigo-50 inline-flex items-center gap-1">
                              <CalendarClock className="w-3 h-3" /> Interview
                            </button>
                          )}
                          {access?.email_candidates && c.email && (
                            <button
                              type="button"
                              onClick={() => (c.status === 'interview_scheduled' && c.interview_id ? setInterviewFor({ postingId: p.id, c }) : setEmailFor({ postingId: p.id, c, kind: c.status === 'offered' || c.status === 'rejected' ? c.status : 'custom' }))}
                              className="text-[11px] font-semibold px-2 py-1 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50 inline-flex items-center gap-1"
                              aria-label={`Email ${c.name}`}
                            >
                              <Mail className="w-3 h-3" /> Email
                            </button>
                          )}
                          <select
                            value={c.status}
                            onChange={(e) => updateCandidateStatus(p.id, c.id, e.target.value)}
                            className={`text-[11px] font-semibold px-2 py-1 rounded-lg border ${CANDIDATE_STATUS_STYLE[c.status]}`}
                          >
                            {CANDIDATE_STATUSES.map((s) => (
                              <option key={s} value={s}>
                                {s.replace(/_/g, ' ')}
                              </option>
                            ))}
                          </select>
                          </div>
                        </div>
                      ))}
                      {candidates.length === 0 && <p className="text-xs text-slate-400 py-2">No candidates yet.</p>}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {postings.length === 0 && <p className="px-2 py-10 text-center text-xs text-slate-400">No job postings yet.</p>}
        </div>
      )}
      {interviewFor && (
        <InterviewModal
          token={token}
          candidate={interviewFor.c}
          access={access}
          onClose={() => setInterviewFor(null)}
          onChanged={() => fetchCandidates(interviewFor.postingId)}
        />
      )}
      {emailFor && (
        <CandidateEmailModal token={token} candidate={emailFor.c} kind={emailFor.kind} interviewId={null} onClose={() => setEmailFor(null)} />
      )}
      {startingFor !== null && <StartJoinerOnboarding token={token} candidateId={startingFor} onClose={() => setStartingFor(null)} onCreated={loadOnboarding} />}
    </div>
  );
};
