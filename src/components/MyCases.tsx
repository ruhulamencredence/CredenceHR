/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> "Grievance & Disciplinary" (GET /api/my-cases): raise a
// grievance, follow the ones you raised, and — when a grievance names you,
// is assigned to you to investigate, or a disciplinary action is issued to
// you — read it and give your feedback (required). A disciplinary action is
// acknowledged after the feedback.

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, Gavel, Plus, X, MessageSquare, AlertTriangle, CheckCircle2 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

interface Feedback {
  id: number;
  user_name: string | null;
  role: 'named' | 'assignee' | 'hr';
  message: string;
  created_at: string;
}

interface Grievance {
  id: number;
  raised_by_name: string | null;
  against_user_name: string | null;
  category: string | null;
  description: string;
  is_anonymous: boolean;
  status: 'open' | 'investigating' | 'resolved' | 'dismissed';
  assigned_to_name: string | null;
  resolution_notes: string | null;
  created_at: string;
  feedback: Feedback[];
  feedback_pending: { named: boolean; assignee: boolean };
}

interface Action {
  id: number;
  action_type: string;
  reason: string;
  document_text: string | null;
  issued_by_name: string | null;
  issued_at: string;
  acknowledged: boolean;
  status: 'active' | 'acknowledged' | 'closed';
  feedback: Feedback[];
  feedback_pending: boolean;
}

interface Cases {
  raised: Grievance[];
  named: Grievance[];
  assigned: Grievance[];
  disciplinary: Action[];
}

type Tab = 'action' | 'raised' | 'named' | 'assigned' | 'disciplinary';

const STATUS_STYLE: Record<string, string> = {
  open: 'bg-amber-50 text-amber-700 border-amber-200',
  investigating: 'bg-blue-50 text-blue-700 border-blue-200',
  resolved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  dismissed: 'bg-slate-100 text-slate-500 border-slate-200',
  active: 'bg-rose-50 text-rose-700 border-rose-200',
  acknowledged: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  closed: 'bg-slate-100 text-slate-500 border-slate-200'
};

const ACTION_LABEL: Record<string, string> = {
  verbal_warning: 'Verbal Warning',
  written_warning: 'Written Warning',
  show_cause: 'Show Cause',
  suspension: 'Suspension',
  termination: 'Termination'
};

const ROLE_LABEL: Record<string, string> = { named: 'Named person', assignee: 'Investigator', hr: 'HR' };

const fmt = (v: string) => {
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' });
};

export const MyCases: React.FC<{ token: string; onBack?: () => void }> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
  const [cases, setCases] = useState<Cases | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);
  const [tab, setTab] = useState<Tab>('action');
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState<string | null>(null);

  const [showRaise, setShowRaise] = useState(false);
  const [people, setPeople] = useState<{ id: number; name: string }[]>([]);
  const [form, setForm] = useState({ category: '', against_user_id: '', description: '', is_anonymous: false });

  const load = async () => {
    try {
      const res = await fetch(apiUrl('/api/my-cases'), { headers });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not load.');
      setCases(data);
    } catch (err: any) {
      setError(err.message);
    }
  };

  useEffect(() => {
    load();
    fetch(apiUrl('/api/grievances/people'), { headers })
      .then((r) => (r.ok ? r.json() : []))
      .then((rows) => setPeople(Array.isArray(rows) ? rows : []))
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const needsAction = cases
    ? [
        ...cases.named.filter((g) => g.feedback_pending.named).map((g) => ({ kind: 'named' as const, g })),
        ...cases.assigned.filter((g) => g.feedback_pending.assignee).map((g) => ({ kind: 'assigned' as const, g })),
        ...cases.disciplinary.filter((a) => a.status !== 'closed' && (a.feedback_pending || !a.acknowledged)).map((a) => ({ kind: 'disciplinary' as const, a }))
      ]
    : [];

  useEffect(() => {
    if (cases && needsAction.length === 0 && tab === 'action') setTab('raised');
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [cases]);

  const sendFeedback = async (url: string, key: string) => {
    const message = (drafts[key] || '').trim();
    if (!message) return setError('Write your feedback first.');
    setBusy(key);
    setError(null);
    try {
      const res = await fetch(apiUrl(url), { method: 'POST', headers, body: JSON.stringify({ message }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not send feedback.');
      setDrafts((p) => ({ ...p, [key]: '' }));
      setSuccess('Feedback sent.');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const acknowledge = async (id: number) => {
    setBusy(`ack-${id}`);
    setError(null);
    try {
      const res = await fetch(apiUrl(`/api/disciplinary-actions/${id}`), { method: 'PUT', headers, body: JSON.stringify({ acknowledge: true }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not acknowledge.');
      setSuccess('Acknowledged.');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const raise = async () => {
    if (!form.description.trim()) return setError('Describe the grievance.');
    setBusy('raise');
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/grievances'), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          category: form.category.trim() || null,
          against_user_id: form.against_user_id ? Number(form.against_user_id) : null,
          description: form.description.trim(),
          is_anonymous: form.is_anonymous
        })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not raise the grievance.');
      setShowRaise(false);
      setForm({ category: '', against_user_id: '', description: '', is_anonymous: false });
      setSuccess('Grievance raised — HR has been notified.');
      setTab('raised');
      await load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(null);
    }
  };

  const feedbackList = (list: Feedback[]) =>
    list.length === 0 ? null : (
      <div className="mt-3 space-y-1.5">
        {list.map((f) => (
          <div key={f.id} className="rounded-lg bg-slate-50 border border-slate-100 px-3 py-2 text-xs">
            <div className="text-[10px] font-semibold text-slate-500">
              {ROLE_LABEL[f.role] || f.role} · {f.user_name || '—'} · {fmt(f.created_at)}
            </div>
            <div className="text-slate-700 whitespace-pre-wrap mt-0.5">{f.message}</div>
          </div>
        ))}
      </div>
    );

  const feedbackBox = (k: string, url: string, label: string) => (
    <div className="mt-3">
      <textarea
        value={drafts[k] || ''}
        onChange={(e) => setDrafts((p) => ({ ...p, [k]: e.target.value }))}
        rows={3}
        placeholder={label}
        className="w-full text-xs px-3 py-2 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
      />
      <button
        type="button"
        disabled={busy === k}
        onClick={() => sendFeedback(url, k)}
        className="mt-1.5 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
      >
        {busy === k ? <Spinner size={12} /> : <MessageSquare className="w-3.5 h-3.5" />} Send feedback
      </button>
    </div>
  );

  const grievanceCard = (g: Grievance, mode: 'raised' | 'named' | 'assigned') => {
    const closed = g.status === 'resolved' || g.status === 'dismissed';
    const pending = mode === 'named' ? g.feedback_pending.named : mode === 'assigned' ? g.feedback_pending.assignee : false;
    return (
      <div key={`${mode}-${g.id}`} className={`rounded-xl border p-4 bg-white ${pending ? 'border-amber-300' : 'border-slate-200'}`}>
        <div className="flex items-start justify-between gap-2 flex-wrap">
          <div className="text-xs font-semibold text-slate-800">
            Grievance #{g.id}
            {g.category && <span className="font-normal text-slate-500"> · {g.category}</span>}
          </div>
          <div className="flex items-center gap-1.5">
            {pending && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Your feedback required</span>}
            <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border capitalize ${STATUS_STYLE[g.status]}`}>{g.status}</span>
          </div>
        </div>
        <div className="text-[11px] text-slate-500 mt-1">
          {fmt(g.created_at)}
          {mode !== 'raised' && ` · Raised by ${g.raised_by_name || '—'}`}
          {g.against_user_name && mode !== 'named' && ` · About ${g.against_user_name}`}
          {g.assigned_to_name && mode !== 'assigned' && ` · Investigator: ${g.assigned_to_name}`}
        </div>
        <p className="text-xs text-slate-700 mt-2 whitespace-pre-wrap">{g.description}</p>
        {g.resolution_notes && closed && (
          <p className="text-xs text-emerald-700 mt-2">
            <span className="font-semibold">Outcome:</span> {g.resolution_notes}
          </p>
        )}
        {feedbackList(g.feedback)}
        {mode !== 'raised' && !closed && (
          feedbackBox(`g-${g.id}`, `/api/grievances/${g.id}/feedback`, mode === 'named' ? 'Your side / explanation…' : 'Your investigation feedback…')
        )}
      </div>
    );
  };

  const actionCard = (a: Action) => (
    <div key={`d-${a.id}`} className={`rounded-xl border p-4 bg-white ${a.status !== 'closed' && (a.feedback_pending || !a.acknowledged) ? 'border-amber-300' : 'border-slate-200'}`}>
      <div className="flex items-start justify-between gap-2 flex-wrap">
        <div className="text-xs font-semibold text-rose-700">{ACTION_LABEL[a.action_type] || a.action_type}</div>
        <div className="flex items-center gap-1.5">
          {a.status !== 'closed' && a.feedback_pending && (
            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-100 text-amber-800">Your feedback required</span>
          )}
          <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border capitalize ${STATUS_STYLE[a.status]}`}>{a.status}</span>
        </div>
      </div>
      <div className="text-[11px] text-slate-500 mt-1">
        Issued by {a.issued_by_name || '—'} · {fmt(a.issued_at)}
      </div>
      <p className="text-xs text-slate-700 mt-2 whitespace-pre-wrap">{a.reason}</p>
      {a.document_text && <p className="text-xs text-slate-500 mt-1 whitespace-pre-wrap">{a.document_text}</p>}
      {feedbackList(a.feedback)}
      {a.status !== 'closed' && (
        feedbackBox(`d-${a.id}`, `/api/disciplinary-actions/${a.id}/feedback`, 'Your feedback / explanation…')
      )}
      {a.status === 'active' && !a.acknowledged && (
        <button
          type="button"
          disabled={a.feedback_pending || busy === `ack-${a.id}`}
          onClick={() => acknowledge(a.id)}
          title={a.feedback_pending ? 'Give your feedback first' : undefined}
          className="mt-2 inline-flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50"
        >
          <CheckCircle2 className="w-3.5 h-3.5" /> Acknowledge
        </button>
      )}
    </div>
  );

  const tabs: { key: Tab; label: string; count: number }[] = cases
    ? [
        { key: 'action', label: 'Needs my feedback', count: needsAction.length },
        { key: 'raised', label: 'My grievances', count: cases.raised.length },
        { key: 'named', label: 'Naming me', count: cases.named.length },
        { key: 'assigned', label: 'Assigned to me', count: cases.assigned.length },
        { key: 'disciplinary', label: 'Disciplinary', count: cases.disciplinary.length }
      ]
    : [];

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900" style={{ background: 'var(--g-bg-gradient)' }}>
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-4xl mx-auto">
        {!isNativeApp && <ModulePath path={['Self Service', 'Grievance & Disciplinary']} />}
        <div className="flex items-center justify-between gap-3 mb-4 mt-2">
          <div className="flex items-center gap-2">
            {onBack && (
              <button type="button" onClick={onBack} className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
                <ArrowLeft className="w-5 h-5 text-slate-500" />
              </button>
            )}
            <h1 className="text-lg font-bold flex items-center gap-2">
              <Gavel className="w-5 h-5 text-blue-600" /> Grievance &amp; Disciplinary
            </h1>
          </div>
          <button
            type="button"
            onClick={() => setShowRaise(true)}
            className="flex items-center gap-1.5 px-3.5 py-2 text-xs font-semibold rounded-xl bg-blue-600 hover:bg-blue-700 text-white"
          >
            <Plus className="w-3.5 h-3.5" /> Raise Grievance
          </button>
        </div>

        {error && (
          <div className="mb-3 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-center gap-2">
            <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
          </div>
        )}
        {success && (
          <div className="mb-3 px-4 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-xl flex items-center gap-2">
            <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {success}
          </div>
        )}

        {!cases ? (
          <div className="flex justify-center py-16">
            <Spinner size={22} className="text-slate-400" />
          </div>
        ) : (
          <>
            <div className="flex gap-1.5 overflow-x-auto pb-2 mb-3">
              {tabs.map((t) => (
                <button
                  key={t.key}
                  type="button"
                  onClick={() => setTab(t.key)}
                  className={`shrink-0 flex items-center gap-1.5 px-3 py-1.5 rounded-full border text-xs font-semibold ${
                    tab === t.key ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600'
                  }`}
                >
                  {t.label}
                  <span
                    className={`px-1.5 rounded-full text-[10px] ${
                      tab === t.key ? 'bg-white/20' : t.key === 'action' && t.count > 0 ? 'bg-amber-100 text-amber-800' : 'bg-slate-100 text-slate-500'
                    }`}
                  >
                    {t.count}
                  </span>
                </button>
              ))}
            </div>

            <div className="space-y-3">
              {tab === 'action' &&
                (needsAction.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-10">Nothing needs your feedback.</p>
                ) : (
                  needsAction.map((n) =>
                    n.kind === 'disciplinary' ? actionCard(n.a) : grievanceCard(n.g, n.kind)
                  )
                ))}
              {tab === 'raised' &&
                (cases.raised.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-10">You haven't raised a grievance.</p>
                ) : (
                  cases.raised.map((g) => grievanceCard(g, 'raised'))
                ))}
              {tab === 'named' &&
                (cases.named.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-10">No grievance names you.</p>
                ) : (
                  cases.named.map((g) => grievanceCard(g, 'named'))
                ))}
              {tab === 'assigned' &&
                (cases.assigned.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-10">No grievance is assigned to you.</p>
                ) : (
                  cases.assigned.map((g) => grievanceCard(g, 'assigned'))
                ))}
              {tab === 'disciplinary' &&
                (cases.disciplinary.length === 0 ? (
                  <p className="text-center text-xs text-slate-400 py-10">No disciplinary action.</p>
                ) : (
                  cases.disciplinary.map((a) => actionCard(a))
                ))}
            </div>
          </>
        )}
      </div>

      {showRaise && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4" onClick={(e) => e.target === e.currentTarget && setShowRaise(false)}>
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg p-5 space-y-3">
            <div className="flex items-center justify-between">
              <h2 className="text-sm font-bold text-slate-900">Raise a Grievance</h2>
              <button type="button" onClick={() => setShowRaise(false)} className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <label className="block">
              <span className="text-[11px] font-semibold text-slate-600">Category (optional)</span>
              <input
                value={form.category}
                onChange={(e) => setForm({ ...form, category: e.target.value })}
                placeholder="e.g. Harassment, Workload, Pay"
                className="mt-1 w-full text-sm px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-slate-600">About a person (optional)</span>
              <select
                value={form.against_user_id}
                onChange={(e) => setForm({ ...form, against_user_id: e.target.value })}
                className="mt-1 w-full text-sm px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
              >
                <option value="">— Nobody in particular —</option>
                {people.map((p) => (
                  <option key={p.id} value={p.id}>
                    {p.name}
                  </option>
                ))}
              </select>
              <span className="text-[10px] text-slate-400">They'll be notified and asked for their feedback; they won't see who raised it.</span>
            </label>
            <label className="block">
              <span className="text-[11px] font-semibold text-slate-600">Description</span>
              <textarea
                value={form.description}
                onChange={(e) => setForm({ ...form, description: e.target.value })}
                rows={5}
                className="mt-1 w-full text-sm px-3 py-2 bg-slate-50 border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none"
              />
            </label>
            <label className="flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={form.is_anonymous} onChange={(e) => setForm({ ...form, is_anonymous: e.target.checked })} />
              Raise anonymously (HR won't see your name)
            </label>
            <div className="flex justify-end gap-2 pt-1">
              <button type="button" onClick={() => setShowRaise(false)} className="px-4 py-2 text-sm font-semibold rounded-xl bg-slate-100 text-slate-700">
                Cancel
              </button>
              <button
                type="button"
                disabled={busy === 'raise'}
                onClick={raise}
                className="flex items-center gap-1.5 px-4 py-2 text-sm font-semibold rounded-xl bg-blue-600 text-white disabled:opacity-50"
              >
                {busy === 'raise' && <Spinner size={14} />} Submit
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
