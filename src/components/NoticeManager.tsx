/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Notices: every notice with its state (live, scheduled,
// expired, paused, draft), who it goes to and how many have read it; the
// composer (notice/NoticeComposer.tsx) writes and edits them; "Who has read
// it" (notice/NoticeReportModal.tsx) needs the notice_read_report layer and
// email the notice_email layer (both off unless ticked in Module Access).

import React, { useState, useEffect, useCallback } from 'react';
import { Bell, Plus, Trash2, Edit2, Eye, EyeOff, Sparkles, Users as UsersIcon, Globe, UsersRound, BarChart3, CalendarClock, Paperclip, Copy } from 'lucide-react';
import { Notice, User, EXPLICIT_ONLY_LAYERS, PermissionLayerKey } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { confirmDialog } from '../lib/confirmDialog';
import { LoadingBlock } from './LoadingBlock';
import { NoticeComposer } from './notice/NoticeComposer';
import { NoticeReportModal } from './notice/NoticeReportModal';
import { NoticeBadges } from './notice/NoticeParts';

interface NoticeManagerProps {
  token: string;
  user: User;
}

const STATUS: Record<NonNullable<Notice['status']>, { label: string; cls: string }> = {
  live: { label: 'Live', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  scheduled: { label: 'Scheduled', cls: 'bg-blue-50 text-blue-700 border-blue-200' },
  expired: { label: 'Taken down', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  paused: { label: 'Paused', cls: 'bg-slate-100 text-slate-500 border-slate-200' },
  draft: { label: 'Draft — review & publish', cls: 'bg-amber-50 text-amber-800 border-amber-200' }
};

const when = (v?: string | null) => {
  if (!v) return '';
  const d = new Date(String(v).replace(' ', 'T') + ':00+06:00');
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Dhaka' });
};

export const NoticeManager: React.FC<NoticeManagerProps> = ({ token, user }) => {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [composer, setComposer] = useState<{ notice: Notice | null; copyOf?: Notice } | null>(null);
  const [reportOf, setReportOf] = useState<number | null>(null);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  const [filter, setFilter] = useState<'all' | 'live' | 'scheduled' | 'off'>('all');

  // Notices layers (Module Access): saved ones, else everything but the explicit ones.
  const layer = (key: PermissionLayerKey) => {
    if (user.role === 'superadmin') return true;
    const saved = user.module_permission_layers?.notices;
    return saved && saved.length > 0 ? saved.includes(key) : !EXPLICIT_ONLY_LAYERS.includes(key);
  };
  const canReport = layer('notice_read_report');
  const canEmail = layer('notice_email');

  const authHeaders = { Authorization: `Bearer ${token}` };
  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/notices'), { headers: authHeaders });
      if (res.ok) setNotices(await res.json());
    } catch {
      setMessage({ type: 'error', text: "Couldn't reach the server. Please try again." });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  useEffect(() => {
    void fetchAll();
  }, [fetchAll]);
  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 5000);
    return () => clearTimeout(t);
  }, [message]);

  const handleToggleActive = async (n: Notice) => {
    try {
      const res = await fetch(apiUrl(`/api/notices/${n.id}/active`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ is_active: !n.is_active })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to update');
      void fetchAll();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    }
  };

  const handleDelete = async (id: number) => {
    if (!(await confirmDialog('Delete this notice? Its pictures, attachments and read history go too. This cannot be undone.'))) return;
    setDeletingId(id);
    try {
      const res = await fetch(apiUrl(`/api/notices/${id}`), { method: 'DELETE', headers: authHeaders });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete');
      setNotices((prev) => prev.filter((n) => n.id !== id));
      setMessage({ type: 'success', text: 'Notice deleted.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setDeletingId(null);
    }
  };

  // A copy to start from: same text and settings, no files, not published.
  const duplicate = (n: Notice) => setComposer({ notice: null, copyOf: n });

  const shown = notices.filter((n) =>
    filter === 'all' ? true : filter === 'live' ? n.status === 'live' : filter === 'scheduled' ? n.status === 'scheduled' : n.status !== 'live' && n.status !== 'scheduled'
  );

  const audienceLabel = (n: Notice) =>
    n.target_type === 'all'
      ? 'Everyone'
      : n.target_type === 'specific'
        ? `${n.target_users?.length || 0} ${(n.target_users?.length || 0) === 1 ? 'person' : 'people'}`
        : 'Groups';

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Bell className="w-5 h-5 text-violet-600" />
            Notices
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">Write a notice with pictures and files, choose who gets it and when, and see who has read it.</p>
        </div>
        <button type="button" onClick={() => setComposer({ notice: null })} className="liquid-glass-button rounded-full inline-flex items-center justify-center gap-1.5 py-2 px-4 font-semibold text-sm whitespace-nowrap">
          <Plus className="w-4 h-4" /> New notice
        </button>
      </div>

      {message && (
        <div className={`p-3.5 rounded-xl border flex items-center justify-between text-sm ${message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'}`}>
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} className="text-xs underline opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      <div className="flex gap-1.5 flex-wrap">
        {([['all', 'All'], ['live', 'Live'], ['scheduled', 'Scheduled'], ['off', 'Drafts, paused & taken down']] as const).map(([k, l]) => (
          <button key={k} type="button" onClick={() => setFilter(k)} className={`px-3 py-1.5 rounded-full text-xs font-semibold ${filter === k ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>
            {l} {k === 'all' ? notices.length : notices.filter((n) => (k === 'live' ? n.status === 'live' : k === 'scheduled' ? n.status === 'scheduled' : n.status !== 'live' && n.status !== 'scheduled')).length}
          </button>
        ))}
      </div>

      {loading ? (
        <LoadingBlock />
      ) : shown.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-10 text-center">
          <Bell className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">{notices.length ? 'No notice here.' : 'No notices yet. Write one to reach your people right after they sign in.'}</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {shown.map((n) => {
            const st = STATUS[n.status || (n.is_active ? 'live' : 'paused')];
            const files = (n.files || []).filter((f) => f.role === 'attachment').length;
            return (
              <div key={n.id} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 sm:p-5">
                <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                  <div className="flex items-start gap-3 min-w-0">
                    <div className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${n.status === 'live' ? 'bg-violet-50 text-violet-600' : 'bg-slate-100 text-slate-400'}`}>
                      {n.lottie_json || n.lottie_url ? <Sparkles className="w-4 h-4" /> : <Bell className="w-4 h-4" />}
                    </div>
                    <div className="min-w-0">
                      <div className="flex items-center gap-1.5 flex-wrap">
                        <h4 className="font-semibold text-slate-900 text-sm truncate max-w-full">{n.title}</h4>
                        <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold border ${st.cls}`}>{st.label}</span>
                        <NoticeBadges priority={n.priority} pinned={n.pinned} />
                        <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-600 border border-slate-200 inline-flex items-center gap-1">
                          {n.target_type === 'all' ? <Globe className="w-2.5 h-2.5" /> : n.target_type === 'groups' ? <UsersRound className="w-2.5 h-2.5" /> : <UsersIcon className="w-2.5 h-2.5" />}
                          {audienceLabel(n)} · {n.audience_count ?? 0}
                        </span>
                        {files > 0 && (
                          <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-600 border border-slate-200 inline-flex items-center gap-1">
                            <Paperclip className="w-2.5 h-2.5" /> {files}
                          </span>
                        )}
                        {n.source === 'budget_import' && <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-50 text-blue-700 border border-blue-200">From Budget import</span>}
                        {n.source === 'tracking' && <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-50 text-emerald-700 border border-emerald-200">Employee Tracking</span>}
                      </div>
                      <p className="text-xs text-slate-500 mt-1 line-clamp-2 break-words">{n.content_html.replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').trim().slice(0, 160) || '—'}</p>
                      <div className="text-[11px] text-slate-400 mt-1.5 flex flex-wrap gap-x-3 gap-y-0.5">
                        <span>{n.created_by_name ? `By ${n.created_by_name} · ` : ''}{n.created_at ? formatDate(n.created_at) : ''}</span>
                        {n.publish_at && <span className="inline-flex items-center gap-1"><CalendarClock className="w-3 h-3" /> {n.status === 'scheduled' ? 'Goes out' : 'Out'} {when(n.publish_at)}</span>}
                        {n.expire_at && <span>Taken down {when(n.expire_at)}</span>}
                        <span>
                          Opened by {n.seen_count ?? 0} of {n.audience_count ?? 0}
                          {n.require_ack ? ` · read ✓ ${n.ack_count ?? 0}` : ''}
                        </span>
                      </div>
                    </div>
                  </div>
                  <div className="flex items-center gap-1 shrink-0 self-end sm:self-start">
                    {canReport && (
                      <button type="button" onClick={() => setReportOf(n.id)} className="px-2.5 py-1.5 text-xs font-semibold text-violet-700 hover:bg-violet-50 rounded-lg inline-flex items-center gap-1" title="Who has read it">
                        <BarChart3 className="w-4 h-4" /> Who read it
                      </button>
                    )}
                    <button type="button" onClick={() => handleToggleActive(n)} className="p-2 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg" title={n.is_active ? 'Pause (hide from people)' : 'Publish'} aria-label={n.is_active ? 'Pause' : 'Publish'}>
                      {n.is_active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                    </button>
                    <button type="button" onClick={() => duplicate(n)} className="p-2 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg" title="Make a copy" aria-label="Make a copy">
                      <Copy className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => setComposer({ notice: n })} className="p-2 text-slate-400 hover:text-violet-600 hover:bg-violet-50 rounded-lg" title="Edit" aria-label="Edit">
                      <Edit2 className="w-4 h-4" />
                    </button>
                    <button type="button" onClick={() => handleDelete(n.id)} disabled={deletingId === n.id} className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg disabled:opacity-50" title="Delete" aria-label="Delete">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {composer && (
        <NoticeComposer
          token={token}
          user={user}
          notice={composer.notice}
          copyOf={composer.copyOf || null}
          canEmail={canEmail}
          onClose={() => setComposer(null)}
          onSaved={(text) => {
            setComposer(null);
            setMessage({ type: 'success', text });
            void fetchAll();
          }}
        />
      )}
      {reportOf != null && canReport && <NoticeReportModal token={token} noticeId={reportOf} onClose={() => setReportOf(null)} />}
    </div>
  );
};
