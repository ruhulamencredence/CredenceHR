/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { Bell, ChevronRight, Paperclip, Pin, Search, CheckCircle2, AlertTriangle } from 'lucide-react';
import { ActiveNotice } from '../types';
import { apiUrl } from '../lib/api';
import { ModulePath } from './ModulePath';
import { LoadingBlock } from './LoadingBlock';
import { NoticeCover, CoverChips, PRIORITY_TILE, noticeText, noticeWhen, readMinutes } from './notice/NoticeParts';
import { NoticeDetail } from './notice/NoticeDetail';

interface NoticeBoardProps {
  token: string;
  onBack: () => void;
}

type Filter = 'all' | 'unread' | 'urgent' | 'pinned' | 'files';
const FILTERS: { key: Filter; label: string }[] = [
  { key: 'all', label: 'All' },
  { key: 'unread', label: 'Unread' },
  { key: 'urgent', label: 'Urgent' },
  { key: 'pinned', label: 'Pinned' },
  { key: 'files', label: 'Has files' }
];
const matches = (n: ActiveNotice, f: Filter) =>
  f === 'unread' ? !n.opened_at : f === 'urgent' ? n.priority === 'urgent' : f === 'pinned' ? !!n.pinned : f === 'files' ? (n.attachments || []).length > 0 : true;
// Needs this person now: urgent and not yet read / acknowledged.
const needsAttention = (n: ActiveNotice) => n.priority === 'urgent' && (n.require_ack ? !n.acknowledged_at : !n.opened_at);

interface CardProps {
  n: ActiveNotice;
  token: string;
  // The notice as plain text (for the short excerpt).
  text: string;
  onOpen: () => void;
  onAck?: () => void | Promise<void>;
  acking?: boolean;
  coverLocalUrl?: string | null;
}

const Meta: React.FC<{ n: ActiveNotice }> = ({ n }) => (
  <span className="flex items-center gap-1.5 text-[11.5px] text-slate-500 min-w-0">
    {!n.opened_at && (
      <>
        <span className="w-1.5 h-1.5 rounded-full bg-[color:var(--g-accent,#7F00FF)] shrink-0" />
        <b className="text-[color:var(--g-accent,#7F00FF)]">New</b>
        <span className="w-[3px] h-[3px] rounded-full bg-slate-300 shrink-0" />
      </>
    )}
    <span className="truncate">{n.from_name || 'HR'}</span>
    <span className="w-[3px] h-[3px] rounded-full bg-slate-300 shrink-0" />
    <span className="shrink-0">{noticeWhen(n.created_at)}</span>
    <span className="w-[3px] h-[3px] rounded-full bg-slate-300 shrink-0" />
    <span className="shrink-0">{readMinutes(n.content_html)} min read</span>
  </span>
);

const UrgentCard: React.FC<CardProps> = ({ n, token, text, onOpen, onAck, acking, coverLocalUrl }) => (
  <div className="relative overflow-hidden rounded-[24px] border border-rose-200 bg-gradient-to-br from-rose-50 to-rose-100/80 p-3.5 pl-4 shadow-[0_14px_30px_-18px_rgba(225,29,72,0.55)] mb-2.5">
    <span className="absolute left-0 top-0 bottom-0 w-[5px] bg-gradient-to-b from-rose-400 to-rose-600" />
    <button type="button" onClick={() => onOpen()} className="block w-full text-left">
      <span className="flex items-center gap-2">
        <span className="w-8 h-8 rounded-[11px] flex items-center justify-center text-white bg-gradient-to-br from-rose-400 to-rose-600 shadow-[0_6px_14px_-6px_rgba(225,29,72,0.9)]">
          <AlertTriangle className="w-4 h-4" />
        </span>
        <span className="text-[10.5px] font-extrabold tracking-wider px-2 py-0.5 rounded-full bg-rose-600 text-white">URGENT</span>
        <span className="ml-auto text-[11.5px] text-slate-400">{noticeWhen(n.created_at)}</span>
      </span>
      <span className="block text-[15.5px] font-bold text-slate-900 mt-2.5 leading-snug">{n.title}</span>
      <span className="text-[13px] text-slate-600 leading-relaxed mt-0.5 line-clamp-2">{text}</span>
    </button>
    <div className="flex items-center justify-between gap-2 mt-3">
      <span className="text-[11.5px] text-slate-400 truncate">
        {n.from_name || 'HR'}
        {n.require_ack ? ' · needs your OK' : ''}
      </span>
      {n.require_ack ? (
        <button
          type="button"
          disabled={!!acking}
          onClick={() => void onAck?.()}
          className="shrink-0 text-[12.5px] font-bold text-white rounded-full px-3.5 py-2 bg-gradient-to-br from-rose-500 to-rose-600 shadow-[0_8px_16px_-8px_rgba(225,29,72,0.9)] disabled:opacity-60"
        >
          I have read this
        </button>
      ) : (
        <button type="button" onClick={() => onOpen()} className="shrink-0 text-[12.5px] font-bold text-rose-700 inline-flex items-center">
          Read <ChevronRight className="w-4 h-4" />
        </button>
      )}
    </div>
  </div>
);

const FeatureCard: React.FC<CardProps> = ({ n, token, text, onOpen, onAck, acking, coverLocalUrl }) => (
  <button
    type="button"
    onClick={() => onOpen()}
    className="block w-full text-left rounded-[26px] overflow-hidden bg-white/90 border border-white shadow-[0_18px_36px_-22px_rgba(76,29,149,0.45)] mb-2.5"
  >
    {(n.cover || coverLocalUrl) && (
      <span className="relative block">
        <NoticeCover file={n.cover} localUrl={coverLocalUrl} token={token} className="h-40 md:h-48" />
        <span className="absolute left-3 top-3">
          <CoverChips priority={n.priority} pinned={false} />
        </span>
      </span>
    )}
    <span className="block px-4 pt-3 pb-3.5">
      <span className="block text-[16.5px] font-extrabold tracking-tight text-slate-900 leading-snug">{n.title}</span>
      <span className="block mt-1">
        <Meta n={n} />
      </span>
      <span className="text-[13.2px] text-slate-600 leading-relaxed mt-2 line-clamp-2">{text}</span>
      <span className="flex items-center justify-between mt-3">
        {(n.attachments || []).length > 0 ? (
          <span className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-700 bg-violet-50 rounded-xl px-2.5 py-1.5">
            <Paperclip className="w-3.5 h-3.5 text-[color:var(--g-accent,#7F00FF)]" />
            {(n.attachments || []).length} file{(n.attachments || []).length === 1 ? '' : 's'}
          </span>
        ) : (
          <span />
        )}
        <span className="inline-flex items-center gap-0.5 text-[12.5px] font-bold text-[color:var(--g-accent,#7F00FF)]">
          Read more <ChevronRight className="w-4 h-4" />
        </span>
      </span>
    </span>
  </button>
);

const Row: React.FC<CardProps> = ({ n, text, onOpen }) => {
  const tile = PRIORITY_TILE[n.priority || 'important'];
  const done = n.require_ack ? !!n.acknowledged_at : !!n.opened_at;
  return (
    <button type="button" onClick={() => onOpen()} className="w-full flex items-start gap-3 text-left rounded-[20px] bg-white/85 border border-white p-3 mb-2 shadow-[0_10px_22px_-18px_rgba(76,29,149,0.5)]">
      <span className={`w-[42px] h-[42px] rounded-[14px] shrink-0 flex items-center justify-center text-white bg-gradient-to-br ${tile.cls}`}>
        <tile.Icon className="w-5 h-5" />
      </span>
      <span className="flex-1 min-w-0">
        <span className="block text-sm font-bold text-slate-900 truncate">{n.title}</span>
        <span className="block text-[12.5px] text-slate-500 truncate mt-0.5">{text}</span>
        <span className="flex items-center gap-1.5 text-[11px] text-slate-400 mt-1">
          <span className="truncate">{n.from_name || 'HR'}</span> · <span className="shrink-0">{noticeWhen(n.created_at)}</span>
          {(n.attachments || []).length > 0 && <Paperclip className="w-3 h-3 shrink-0" />}
          {done && (
            <span className="inline-flex items-center gap-0.5 font-semibold text-emerald-600 shrink-0">
              <CheckCircle2 className="w-3 h-3" /> Read
            </span>
          )}
        </span>
      </span>
      {!n.opened_at && <span className="w-2 h-2 mt-1.5 rounded-full bg-[color:var(--g-accent,#7F00FF)] ring-[3px] ring-violet-100 shrink-0" aria-label="Unread" />}
    </button>
  );
};


/** Which card a notice gets on the board. */
export const boardVariant = (n: ActiveNotice, hasCover = !!n.cover): 'urgent' | 'feature' | 'row' => (needsAttention(n) ? 'urgent' : n.pinned || hasCover ? 'feature' : 'row');
/** One notice as the board shows it (also the composer's "Board" preview). */
export const BoardCard: React.FC<CardProps> = (props) => {
  const v = boardVariant(props.n, !!props.n.cover || !!props.coverLocalUrl);
  return v === 'urgent' ? <UrgentCard {...props} /> : v === 'feature' ? <FeatureCard {...props} /> : <Row {...props} />;
};

// A persistent, browsable list of every notice currently active for this
// account — unlike NoticePopup.tsx (the same notices as a one-at-a-time
// sheet right after login), this page never dismisses anything: it's where
// people come back to re-read a notice. Tapping one opens it in full
// (NoticeDetail.tsx); that is when it counts as read.
export const NoticeBoard: React.FC<NoticeBoardProps> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const [notices, setNotices] = useState<ActiveNotice[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState<Filter>('all');
  const [openId, setOpenId] = useState<number | null>(null);
  const [acking, setAcking] = useState<number | null>(null);

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        // /api/notices/board, not /active — the latter is the login popup's
        // endpoint and hides anything this account has dismissed.
        const res = await fetch(apiUrl('/api/notices/board'), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || 'Failed to load Notice Board');
        setNotices(await res.json());
      } catch (err: any) {
        setError(err.message || 'Failed to load Notice Board');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  const markOpened = (id: number) => {
    const n = notices.find((x) => x.id === id);
    if (!n || n.opened_at) return;
    setNotices((prev) => prev.map((x) => (x.id === id ? { ...x, opened_at: new Date().toISOString() } : x)));
    fetch(apiUrl(`/api/notices/${id}/seen`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } }).catch(() => {});
  };
  const open = (id: number) => {
    setOpenId(id);
    markOpened(id);
  };
  const acknowledge = async (id: number) => {
    setAcking(id);
    try {
      const r = await fetch(apiUrl(`/api/notices/${id}/ack`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      if (r.ok) {
        const now = new Date().toISOString();
        setNotices((prev) => prev.map((n) => (n.id === id ? { ...n, acknowledged_at: now, opened_at: n.opened_at || now } : n)));
      }
    } finally {
      setAcking(null);
    }
  };

  const texts = useMemo(() => new Map(notices.map((n) => [n.id, noticeText(n.content_html)])), [notices]);
  const counts = useMemo(() => Object.fromEntries(FILTERS.map((f) => [f.key, notices.filter((n) => matches(n, f.key)).length])) as Record<Filter, number>, [notices]);
  const shown = useMemo(() => {
    const needle = q.trim().toLowerCase();
    return notices.filter((n) => matches(n, filter) && (!needle || `${n.title} ${texts.get(n.id) || ''} ${n.from_name || ''}`.toLowerCase().includes(needle)));
  }, [notices, filter, q, texts]);
  const attention = shown.filter(needsAttention);
  const pinned = shown.filter((n) => n.pinned && !needsAttention(n));
  const rest = shown.filter((n) => !n.pinned && !needsAttention(n));
  const unread = counts.unread;
  const current = notices.find((n) => n.id === openId) || null;
  const cardProps = (n: ActiveNotice): CardProps => ({ n, token, text: texts.get(n.id) || '', onOpen: () => open(n.id), onAck: () => acknowledge(n.id), acking: acking === n.id });

  const Section: React.FC<{ icon?: React.ReactNode; label: string }> = ({ icon, label }) => (
    <p className="flex items-center gap-1.5 text-[11px] font-extrabold tracking-[0.09em] text-slate-400 mt-5 mb-2 px-1">
      {icon}
      {label}
    </p>
  );
  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-2xl mx-auto">
        {!isNativeApp && <ModulePath path={['Self Service', 'Notice Board']} onBack={onBack} />}
        {/* On the native app the hardware / gesture back returns to the tile
            menu (UserPanel.tsx), so there's no on-screen Back here. */}

        <div className="flex items-end justify-between gap-3 mb-3 px-0.5">
          <div>
            <h1 className="text-[22px] font-extrabold tracking-tight text-slate-900">Notices</h1>
            <p className="text-[12.5px] text-slate-500 mt-0.5">Everything posted for you</p>
          </div>
          {unread > 0 && (
            <span className="text-[11.5px] font-bold text-[color:var(--g-accent,#7F00FF)] bg-white border border-violet-100 rounded-full px-2.5 py-1.5 shadow-[0_4px_10px_-6px_rgba(124,0,255,0.4)] shrink-0">
              {unread} unread
            </span>
          )}
        </div>

        {!loading && !error && notices.length > 0 && (
          <>
            <label className="flex items-center gap-2 rounded-2xl bg-white/80 border border-white px-3.5 py-2.5 shadow-[0_6px_18px_-12px_rgba(76,29,149,0.4)]">
              <Search className="w-4 h-4 text-slate-400 shrink-0" />
              <span className="sr-only">Search notices</span>
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search notices" className="flex-1 min-w-0 bg-transparent text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none" />
            </label>
            <div className="flex gap-1.5 mt-3 overflow-x-auto no-scrollbar -mx-4 px-4 pb-0.5">
              {FILTERS.map((f) => (
                <button
                  key={f.key}
                  type="button"
                  aria-pressed={filter === f.key}
                  onClick={() => setFilter(f.key)}
                  className={`shrink-0 text-[12.5px] font-semibold rounded-full px-3 py-2 border whitespace-nowrap ${
                    filter === f.key ? 'bg-slate-900 text-white border-slate-900' : 'bg-white/70 text-slate-600 border-white'
                  }`}
                >
                  {f.label}
                  {f.key !== 'files' && <b className="ml-1 opacity-60">{counts[f.key]}</b>}
                </button>
              ))}
            </div>
          </>
        )}

        {loading ? (
          <LoadingBlock />
        ) : error ? (
          <div className="mt-4 text-sm text-rose-600 bg-rose-50 border border-rose-200 rounded-xl px-4 py-3">{error}</div>
        ) : notices.length === 0 ? (
          <div className="flex flex-col items-center justify-center py-20 text-center">
            <div className="w-14 h-14 rounded-full bg-slate-100 flex items-center justify-center mb-3">
              <Bell className="w-6 h-6 text-slate-400" />
            </div>
            <p className="text-sm text-slate-500">No notices posted right now.</p>
          </div>
        ) : shown.length === 0 ? (
          <p className="text-sm text-slate-500 text-center py-14">Nothing matches.</p>
        ) : (
          <div className="mt-3.5">
            {attention.map((n) => (
              <UrgentCard key={n.id} {...cardProps(n)} />
            ))}
            {pinned.length > 0 && (
              <>
                <Section icon={<Pin className="w-3 h-3" />} label="PINNED" />
                {pinned.map((n) => (
                  <FeatureCard key={n.id} {...cardProps(n)} />
                ))}
              </>
            )}
            {rest.length > 0 && (
              <>
                {(attention.length > 0 || pinned.length > 0) && <Section label="LATEST" />}
                {rest.map((n) => (n.cover ? <FeatureCard key={n.id} {...cardProps(n)} /> : <Row key={n.id} {...cardProps(n)} />))}
              </>
            )}
          </div>
        )}
      </div>

      {current && (
        <NoticeDetail
          notice={current}
          token={token}
          busy={acking === current.id}
          onClose={() => setOpenId(null)}
          onAcknowledge={async () => {
            await acknowledge(current.id);
            setOpenId(null);
          }}
        />
      )}
    </div>
  );
};
