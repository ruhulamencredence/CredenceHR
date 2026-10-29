/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Recruitment (ATS) — the Interview popup (set / move / cancel an interview,
// where and how it happens, its history) and the Email candidate popup (a
// draft the person can change, sent with a calendar invite for interviews).
// Emailing is the explicit-only layer "email_candidates"; the server checks
// it too (RecruitmentRoutes.ts).

import React, { useEffect, useState } from 'react';
import { X, CalendarClock, Mail, MapPin, Video, Phone, History, AlertTriangle, CheckCircle2, XCircle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';

export interface RecruitmentAccess {
  email_candidates: boolean;
  mail_ready: boolean;
}

export type CandidateEmailKind = 'interview_scheduled' | 'interview_rescheduled' | 'interview_cancelled' | 'offered' | 'rejected' | 'custom';

export const EMAIL_KIND_LABEL: Record<CandidateEmailKind, string> = {
  interview_scheduled: 'Interview invitation',
  interview_rescheduled: 'Interview changed',
  interview_cancelled: 'Interview cancelled',
  offered: 'Job offer',
  rejected: 'Regret (not selected)',
  custom: 'Other message'
};

export interface InterviewCandidate {
  id: number;
  name: string;
  email: string | null;
  interview_id?: number | null;
}

interface Interview {
  id: number;
  scheduled_at: string | null;
  interviewer_id: number | null;
  interviewer_name: string | null;
  mode: 'in_person' | 'online' | 'phone' | null;
  venue: string | null;
  meeting_link: string | null;
  duration_minutes: number | null;
  candidate_note: string | null;
  status: 'scheduled' | 'completed' | 'cancelled';
}

interface HistoryEvent {
  id: number;
  interview_id: number;
  action: 'scheduled' | 'rescheduled' | 'venue_changed' | 'cancelled' | 'interviewer';
  old_scheduled_at: string | null;
  new_scheduled_at: string | null;
  old_place: string | null;
  new_place: string | null;
  reason: string | null;
  done_by_name: string | null;
  created_at: string;
}

interface HistoryEmail {
  id: number;
  kind: CandidateEmailKind;
  to_email: string;
  subject: string;
  status: 'sent' | 'failed';
  error: string | null;
  sent_by_name: string | null;
  created_at: string;
}

const ACTION_LABEL: Record<HistoryEvent['action'], string> = {
  scheduled: 'Scheduled',
  rescheduled: 'Time changed',
  venue_changed: 'Place changed',
  cancelled: 'Cancelled',
  interviewer: 'Interviewer changed'
};

const fmt = (dt: string | null) => {
  if (!dt) return '—';
  const d = new Date(String(dt).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? String(dt) : d.toLocaleString('en-GB', { day: 'numeric', month: 'short', year: 'numeric', hour: 'numeric', minute: '2-digit' });
};
const toInput = (dt: string | null) => (dt ? String(dt).replace(' ', 'T').slice(0, 16) : '');

const inputCls = 'w-full px-3 py-2 text-sm border border-slate-200 rounded-xl bg-white/80';
const labelCls = 'block text-[11px] font-semibold text-slate-500 mb-1';

// Same liquid-glass card as every other popup (CLAUDE.md).
const GlassModal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; footer?: React.ReactNode; z?: string }> = ({ title, onClose, children, footer, z = 'z-[90]' }) => (
  <div className={`liquid-glass-backdrop fixed inset-0 ${z} flex items-end sm:items-center justify-center p-3 sm:p-4`} onClick={onClose} role="presentation">
    <div className="w-full max-w-lg" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label={title}>
      <div className="liquid-glass liquid-glass-in rounded-[32px] max-h-[90vh] flex flex-col overflow-hidden">
        <div className="flex items-center justify-between gap-3 px-5 pt-5 pb-3">
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="px-5 pb-4 overflow-y-auto flex-1">{children}</div>
        {footer && <div className="px-5 pb-5 flex gap-2.5">{footer}</div>}
      </div>
    </div>
  </div>
);

// ---------- Email candidate ----------
export const CandidateEmailModal: React.FC<{
  token: string;
  candidate: InterviewCandidate;
  kind: CandidateEmailKind;
  interviewId: number | null;
  onClose: () => void;
  onSent?: () => void;
}> = ({ token, candidate, kind: initialKind, interviewId, onClose, onSent }) => {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [kind, setKind] = useState<CandidateEmailKind>(initialKind);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [calendar, setCalendar] = useState(false);
  const [mailReady, setMailReady] = useState(true);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const kinds: CandidateEmailKind[] = interviewId
    ? ['interview_scheduled', 'interview_rescheduled', 'interview_cancelled', 'offered', 'rejected', 'custom']
    : ['offered', 'rejected', 'custom'];

  useEffect(() => {
    let off = false;
    setLoading(true);
    setError('');
    fetch(apiUrl('/api/candidate-emails/draft'), { method: 'POST', headers, body: JSON.stringify({ candidate_id: candidate.id, interview_id: kind.startsWith('interview_') ? interviewId : null, kind }) })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (off) return;
        if (!r.ok) throw new Error(d.error || 'Could not prepare the email');
        setSubject(d.subject || '');
        setBody(d.body || '');
        setCalendar(!!d.calendar);
        setMailReady(d.mail_ready !== false);
      })
      .catch((e) => !off && setError(e.message || 'Could not prepare the email'))
      .finally(() => !off && setLoading(false));
    return () => {
      off = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [kind]);

  const send = async () => {
    setSending(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/candidate-emails/send'), {
        method: 'POST',
        headers,
        body: JSON.stringify({ candidate_id: candidate.id, interview_id: kind.startsWith('interview_') ? interviewId : null, kind, subject, body })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'The email could not be sent');
      setSent(true);
      onSent?.();
    } catch (e: any) {
      setError(e.message || 'The email could not be sent');
    } finally {
      setSending(false);
    }
  };

  if (sent) {
    return (
      <GlassModal
        title="Email sent"
        onClose={onClose}
        z="z-[95]"
        footer={
          <button type="button" onClick={onClose} className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold">
            Done
          </button>
        }
      >
        <div className="liquid-glass-inset rounded-2xl px-4 py-4 flex items-start gap-3">
          <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0" />
          <p className="text-sm text-slate-700">
            Sent to <b>{candidate.email}</b>.{calendar && ' A calendar invite went with it.'} It is listed in the candidate's history.
          </p>
        </div>
      </GlassModal>
    );
  }

  return (
    <GlassModal
      title={`Email ${candidate.name}`}
      onClose={onClose}
      z="z-[95]"
      footer={
        <>
          <button type="button" onClick={onClose} className="liquid-glass-chip flex-1 rounded-full py-2.5 text-sm font-semibold text-slate-700">
            Not now
          </button>
          <button type="button" onClick={send} disabled={sending || loading || !candidate.email || !mailReady} className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold disabled:opacity-50 inline-flex items-center justify-center gap-1.5">
            <Mail className="w-4 h-4" /> {sending ? 'Sending…' : 'Send email'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div>
          <label className={labelCls}>To</label>
          <p className="text-sm font-semibold text-slate-800">{candidate.email || <span className="text-rose-600">No email address — add one to the candidate first.</span>}</p>
        </div>
        <div>
          <label className={labelCls} htmlFor="cand-email-kind">Email about</label>
          <select id="cand-email-kind" value={kind} onChange={(e) => setKind(e.target.value as CandidateEmailKind)} className={inputCls}>
            {kinds.map((k) => (
              <option key={k} value={k}>
                {EMAIL_KIND_LABEL[k]}
              </option>
            ))}
          </select>
        </div>
        {loading ? (
          <p className="text-xs text-slate-500 py-6 text-center">Preparing the email…</p>
        ) : (
          <>
            <div>
              <label className={labelCls} htmlFor="cand-email-subject">Subject</label>
              <input id="cand-email-subject" value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={255} className={inputCls} />
            </div>
            <div>
              <label className={labelCls} htmlFor="cand-email-body">Message (you can change it)</label>
              <textarea id="cand-email-body" value={body} onChange={(e) => setBody(e.target.value)} rows={11} maxLength={8000} className={`${inputCls} font-[inherit] leading-relaxed`} />
            </div>
            {calendar && (
              <p className="text-[11px] text-slate-500 flex items-center gap-1.5">
                <CalendarClock className="w-3.5 h-3.5" /> A calendar invite goes with it, so the candidate can add the interview to their phone in one tap.
              </p>
            )}
          </>
        )}
        {!mailReady && (
          <p className="text-xs text-amber-700 flex items-start gap-1.5">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> Email isn't set up on the server yet (SMTP in .env), so nothing can be sent.
          </p>
        )}
        {error && (
          <p className="text-xs text-rose-700 flex items-start gap-1.5" role="alert">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
          </p>
        )}
      </div>
    </GlassModal>
  );
};

// ---------- Interview ----------
export const InterviewModal: React.FC<{
  token: string;
  candidate: InterviewCandidate;
  access: RecruitmentAccess | null;
  onClose: () => void;
  onChanged: () => void;
}> = ({ token, candidate, access, onClose, onChanged }) => {
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [loading, setLoading] = useState(true);
  const [interview, setInterview] = useState<Interview | null>(null);
  const [events, setEvents] = useState<HistoryEvent[]>([]);
  const [emails, setEmails] = useState<HistoryEmail[]>([]);
  const [people, setPeople] = useState<{ id: number; name: string }[]>([]);
  const [when, setWhen] = useState('');
  const [duration, setDuration] = useState('60');
  const [mode, setMode] = useState<'in_person' | 'online' | 'phone'>('in_person');
  const [venue, setVenue] = useState('');
  const [link, setLink] = useState('');
  const [interviewerId, setInterviewerId] = useState('');
  const [note, setNote] = useState('');
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const [emailFor, setEmailFor] = useState<{ kind: CandidateEmailKind; interviewId: number } | null>(null);
  const [notice, setNotice] = useState('');

  const canEmail = !!access?.email_candidates;

  const load = async () => {
    try {
      const r = await fetch(apiUrl(`/api/job-candidates/${candidate.id}/interview-history`), { headers });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not load the interview');
      const open: Interview | undefined = (d.interviews || []).find((i: Interview) => i.status === 'scheduled');
      setInterview(open || null);
      setEvents(d.events || []);
      setEmails(d.emails || []);
      if (open) {
        setWhen(toInput(open.scheduled_at));
        setDuration(String(open.duration_minutes || 60));
        setMode(open.mode || 'in_person');
        setVenue(open.venue || '');
        setLink(open.meeting_link || '');
        setInterviewerId(open.interviewer_id ? String(open.interviewer_id) : '');
        setNote(open.candidate_note || '');
      }
    } catch (e: any) {
      setError(e.message || 'Could not load the interview');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    load();
    fetch(apiUrl('/api/recruitment/interviewers'), { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setPeople(Array.isArray(rows) ? rows : []))
      .catch(() => setPeople([]));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // After a change: offer the matching email (with the permission), or say
  // plainly that the candidate still has to be told.
  const invited = emails.some((m) => m.status === 'sent' && m.kind.startsWith('interview_'));
  const afterChange = (kind: CandidateEmailKind, interviewId: number) => {
    onChanged();
    load();
    // A move before any invite went out is, for the candidate, the invite.
    if (kind === 'interview_rescheduled' && !invited) kind = 'interview_scheduled';
    if (canEmail && candidate.email) setEmailFor({ kind, interviewId });
    else setNotice(candidate.email ? 'Saved. The candidate has not been emailed — someone with the "Email candidates" permission can send it, or tell them yourself.' : 'Saved. This candidate has no email address, so tell them yourself.');
  };

  const save = async () => {
    if (!when) {
      setError('Pick the interview date and time.');
      return;
    }
    if (mode === 'online' && link && !/^https?:\/\//i.test(link.trim())) {
      setError('The meeting link must start with http:// or https://.');
      return;
    }
    setSaving(true);
    setError('');
    setNotice('');
    const payload = {
      scheduled_at: when,
      duration_minutes: Number(duration) || 60,
      mode,
      venue: mode === 'in_person' ? venue : '',
      meeting_link: mode === 'online' ? link : '',
      interviewer_id: interviewerId ? Number(interviewerId) : undefined,
      candidate_note: note,
      reason
    };
    try {
      const r = interview
        ? await fetch(apiUrl(`/api/candidate-interviews/${interview.id}`), { method: 'PUT', headers, body: JSON.stringify(payload) })
        : await fetch(apiUrl('/api/candidate-interviews'), { method: 'POST', headers, body: JSON.stringify({ ...payload, candidate_id: candidate.id }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save the interview');
      const moved = interview && toInput(interview.scheduled_at) !== when;
      const placeMoved =
        interview && ((interview.mode || 'in_person') !== mode || (interview.venue || '') !== (mode === 'in_person' ? venue : '') || (interview.meeting_link || '') !== (mode === 'online' ? link : ''));
      setReason('');
      if (!interview) afterChange('interview_scheduled', Number(d.id));
      else if (moved || placeMoved) afterChange('interview_rescheduled', interview.id);
      else {
        onChanged();
        load();
        setNotice('Saved.');
      }
    } catch (e: any) {
      setError(e.message || 'Could not save the interview');
    } finally {
      setSaving(false);
    }
  };

  const cancelInterview = async () => {
    if (!interview) return;
    if (!(await confirmDialog(`Cancel ${candidate.name}'s interview on ${fmt(interview.scheduled_at)}?`, { tone: 'danger', confirmLabel: 'Cancel interview', cancelLabel: 'Keep it' }))) return;
    setSaving(true);
    setError('');
    try {
      const r = await fetch(apiUrl(`/api/candidate-interviews/${interview.id}`), { method: 'PUT', headers, body: JSON.stringify({ status: 'cancelled', reason }) });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not cancel the interview');
      setReason('');
      const id = interview.id;
      setInterview(null);
      setWhen('');
      afterChange('interview_cancelled', id);
    } catch (e: any) {
      setError(e.message || 'Could not cancel the interview');
    } finally {
      setSaving(false);
    }
  };

  const modeBtn = (m: typeof mode, label: string, Icon: React.ComponentType<{ className?: string }>) => (
    <button
      type="button"
      onClick={() => setMode(m)}
      aria-pressed={mode === m}
      className={`flex-1 inline-flex items-center justify-center gap-1.5 py-2 rounded-full text-xs font-semibold ${mode === m ? 'liquid-glass-button' : 'liquid-glass-chip text-slate-600'}`}
    >
      <Icon className="w-3.5 h-3.5" /> {label}
    </button>
  );

  // Changes and emails, newest first, in one list.
  const timeline = [
    ...events.map((e) => ({ at: e.created_at, key: `e${e.id}`, ev: e as HistoryEvent | null, em: null as HistoryEmail | null })),
    ...emails.map((m) => ({ at: m.created_at, key: `m${m.id}`, ev: null as HistoryEvent | null, em: m as HistoryEmail | null }))
  ].sort((a, b) => String(b.at).localeCompare(String(a.at)));

  return (
    <>
      <GlassModal
        title={`Interview — ${candidate.name}`}
        onClose={onClose}
        footer={
          <>
            {interview && (
              <button type="button" onClick={cancelInterview} disabled={saving} className="liquid-glass-chip rounded-full px-4 py-2.5 text-sm font-semibold text-rose-700 disabled:opacity-50">
                Cancel interview
              </button>
            )}
            <button type="button" onClick={save} disabled={saving || loading} className="liquid-glass-button flex-1 rounded-full py-2.5 text-sm font-semibold disabled:opacity-50">
              {saving ? 'Saving…' : interview ? 'Save changes' : 'Schedule interview'}
            </button>
          </>
        }
      >
        {loading ? (
          <p className="text-xs text-slate-500 py-8 text-center">Loading…</p>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-[1fr_auto] gap-2">
              <div>
                <label className={labelCls} htmlFor="iv-when">Date & time</label>
                <input id="iv-when" type="datetime-local" value={when} onChange={(e) => setWhen(e.target.value)} className={inputCls} />
              </div>
              <div>
                <label className={labelCls} htmlFor="iv-dur">Length</label>
                <select id="iv-dur" value={duration} onChange={(e) => setDuration(e.target.value)} className={inputCls}>
                  {[30, 45, 60, 90, 120].map((m) => (
                    <option key={m} value={m}>
                      {m} min
                    </option>
                  ))}
                </select>
              </div>
            </div>
            <div>
              <span className={labelCls}>How</span>
              <div className="flex gap-1.5">
                {modeBtn('in_person', 'In person', MapPin)}
                {modeBtn('online', 'Online', Video)}
                {modeBtn('phone', 'Phone', Phone)}
              </div>
            </div>
            {mode === 'in_person' && (
              <div>
                <label className={labelCls} htmlFor="iv-venue">Venue / address</label>
                <input id="iv-venue" value={venue} onChange={(e) => setVenue(e.target.value)} maxLength={500} placeholder="e.g. Head Office, Level 5, Gulshan 1" className={inputCls} />
              </div>
            )}
            {mode === 'online' && (
              <div>
                <label className={labelCls} htmlFor="iv-link">Meeting link</label>
                <input id="iv-link" value={link} onChange={(e) => setLink(e.target.value)} maxLength={500} placeholder="https://meet.google.com/…" className={inputCls} />
              </div>
            )}
            <div>
              <label className={labelCls} htmlFor="iv-who">Interviewer</label>
              <select id="iv-who" value={interviewerId} onChange={(e) => setInterviewerId(e.target.value)} className={inputCls}>
                <option value="">{interview ? '— keep as is —' : 'Me'}</option>
                {people.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
              <p className="text-[11px] text-slate-500 mt-1">The interviewer gets an alert whenever the interview is set, moved or cancelled.</p>
            </div>
            <div>
              <label className={labelCls} htmlFor="iv-note">Note for the candidate (optional)</label>
              <input id="iv-note" value={note} onChange={(e) => setNote(e.target.value)} maxLength={2000} placeholder="e.g. Bring your CV and NID" className={inputCls} />
            </div>
            {interview && (
              <div>
                <label className={labelCls} htmlFor="iv-reason">Reason for the change (kept in the history)</label>
                <input id="iv-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={500} className={inputCls} />
              </div>
            )}

            {error && (
              <p className="text-xs text-rose-700 flex items-start gap-1.5" role="alert">
                <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-0.5" /> {error}
              </p>
            )}
            {notice && <p className="text-xs text-slate-700 liquid-glass-inset rounded-2xl px-3 py-2">{notice}</p>}

            {canEmail && candidate.email && (
              <button
                type="button"
                onClick={() => setEmailFor({ kind: interview ? (invited ? 'interview_rescheduled' : 'interview_scheduled') : 'custom', interviewId: interview?.id || 0 })}
                className="liquid-glass-chip w-full rounded-full py-2 text-xs font-semibold text-slate-700 inline-flex items-center justify-center gap-1.5"
              >
                <Mail className="w-3.5 h-3.5" /> Email the candidate
              </button>
            )}

            {timeline.length > 0 && (
              <div>
                <p className="text-[11px] font-semibold text-slate-500 mb-1.5 flex items-center gap-1.5">
                  <History className="w-3.5 h-3.5" /> History
                </p>
                <ul className="liquid-glass-inset rounded-2xl divide-y divide-slate-200/60 text-xs">
                  {timeline.map((t) => (
                    <li key={t.key} className="px-3 py-2">
                      {t.ev ? (
                        <>
                          <p className="font-semibold text-slate-800">
                            {ACTION_LABEL[t.ev.action] || t.ev.action}
                            {t.ev.action === 'rescheduled' && (
                              <span className="font-normal text-slate-600">
                                {' '}
                                · {fmt(t.ev.old_scheduled_at)} → {fmt(t.ev.new_scheduled_at)}
                              </span>
                            )}
                            {(t.ev.action === 'scheduled' || t.ev.action === 'interviewer') && <span className="font-normal text-slate-600"> · {fmt(t.ev.new_scheduled_at)}</span>}
                          </p>
                          {t.ev.action === 'venue_changed' && (
                            <p className="text-slate-600">
                              {t.ev.old_place || '—'} → {t.ev.new_place || '—'}
                            </p>
                          )}
                          {t.ev.action !== 'venue_changed' && t.ev.action !== 'cancelled' && t.ev.new_place && <p className="text-slate-600">{t.ev.new_place}</p>}
                          {t.ev.reason && <p className="text-slate-600">Reason: {t.ev.reason}</p>}
                          <p className="text-[10px] text-slate-400">
                            {t.ev.done_by_name || '—'} · {fmt(t.at)}
                          </p>
                        </>
                      ) : t.em ? (
                        <>
                          <p className="font-semibold text-slate-800 flex items-center gap-1">
                            {t.em.status === 'sent' ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-rose-600" />}
                            Email: {EMAIL_KIND_LABEL[t.em.kind] || t.em.kind} {t.em.status === 'sent' ? 'sent' : 'failed'}
                          </p>
                          <p className="text-slate-600 truncate">
                            {t.em.to_email} · {t.em.subject}
                          </p>
                          {t.em.error && <p className="text-rose-600">{t.em.error}</p>}
                          <p className="text-[10px] text-slate-400">
                            {t.em.sent_by_name || '—'} · {fmt(t.at)}
                          </p>
                        </>
                      ) : null}
                    </li>
                  ))}
                </ul>
              </div>
            )}
          </div>
        )}
      </GlassModal>
      {emailFor && (
        <CandidateEmailModal
          token={token}
          candidate={candidate}
          kind={emailFor.kind}
          interviewId={emailFor.interviewId || null}
          onClose={() => setEmailFor(null)}
          onSent={() => {
            load();
            onChanged();
          }}
        />
      )}
    </>
  );
};
