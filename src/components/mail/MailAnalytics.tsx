/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail -> Analytics (GET /api/mail/analytics): totals, the last 14
// days received vs sent, who writes most, and the Inbox by category.
// Colours: two categorical slots (received = blue, sent = orange), checked
// with the data-viz palette validator; text never wears the series colour.

import React, { useEffect, useMemo, useState } from 'react';
import { BarChart3, Inbox, Send, ShieldAlert, Timer, Table2 } from 'lucide-react';
import { MailAnalytics, mailFetch } from '../../lib/mailApi';
import { MailPopup } from './MailPopup';

const RECEIVED = '#2a78d6';
const SENT = '#eb6834';

const fmtMinutes = (m: number) => {
  if (!m) return '—';
  if (m < 60) return `${m} min`;
  const h = Math.floor(m / 60);
  if (h < 48) return `${h} h ${m % 60 ? `${m % 60} min` : ''}`.trim();
  return `${Math.round(h / 24)} days`;
};

const Tile: React.FC<{ icon: React.ReactNode; label: string; value: string }> = ({ icon, label, value }) => (
  <div className="liquid-glass-inset rounded-[20px] p-3">
    <div className="flex items-center gap-1.5 text-[11px] font-medium text-slate-500">{icon}{label}</div>
    <div className="mt-1 text-xl font-bold text-slate-900 tabular-nums">{value}</div>
  </div>
);

// Last 14 days, every day present (a quiet day is a zero, not a gap).
function fourteenDays(rows: MailAnalytics['dailyTrends']) {
  const by = new Map(rows.map((r) => [r.date, r]));
  const out: { date: string; sent: number; received: number }[] = [];
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - 13);
  for (let i = 0; i < 14; i++) {
    const k = d.toISOString().slice(0, 10);
    out.push({ date: k, sent: by.get(k)?.sent || 0, received: by.get(k)?.received || 0 });
    d.setUTCDate(d.getUTCDate() + 1);
  }
  return out;
}
const dayLabel = (k: string, opts: Intl.DateTimeFormatOptions) => new Date(`${k}T00:00:00Z`).toLocaleDateString('en-GB', { timeZone: 'UTC', ...opts });

// A round-number top for the scale.
const niceMax = (v: number) => {
  if (v <= 4) return 4;
  const p = Math.pow(10, Math.floor(Math.log10(v)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((m) => m >= v) || v;
};

const TrendChart: React.FC<{ days: { date: string; sent: number; received: number }[] }> = ({ days }) => {
  const [hover, setHover] = useState<number | null>(null);
  const max = niceMax(Math.max(1, ...days.flatMap((d) => [d.sent, d.received])));
  const H = 160;
  return (
    <div>
      <div className="flex items-center gap-4 text-[11px] text-slate-600 mb-2" aria-hidden>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: RECEIVED }} />Received</span>
        <span className="inline-flex items-center gap-1.5"><span className="w-2.5 h-2.5 rounded-sm" style={{ background: SENT }} />Sent</span>
      </div>
      <div className="relative" role="img" aria-label={`Mail received and sent per day, last 14 days. Most in a day: ${Math.max(...days.map((d) => d.received + d.sent))}.`}>
        {/* Recessive grid: the top and the middle of the scale. */}
        <div className="absolute inset-x-0 top-0 flex flex-col justify-between pointer-events-none" style={{ height: H }}>
          {[max, max / 2, 0].map((v) => (
            <div key={v} className="flex items-center gap-2">
              <span className="w-6 text-right text-[10px] text-slate-400 tabular-nums">{Number.isInteger(v) ? v : v.toFixed(1)}</span>
              <span className={`flex-1 border-t ${v === 0 ? 'border-slate-300' : 'border-dashed border-slate-200'}`} />
            </div>
          ))}
        </div>
        <div className="relative ml-8 flex items-end" style={{ height: H }}>
          {days.map((d, i) => (
            <div
              key={d.date}
              className="relative flex-1 h-full flex items-end justify-center gap-[2px] cursor-default"
              onMouseEnter={() => setHover(i)}
              onMouseLeave={() => setHover(null)}
              onClick={() => setHover(hover === i ? null : i)}
            >
              {hover === i && <div className="absolute inset-y-0 inset-x-0.5 rounded-lg bg-slate-900/5" />}
              {[
                [d.received, RECEIVED],
                [d.sent, SENT]
              ].map(([v, c], j) => (
                <div
                  key={j}
                  className="relative w-full max-w-[12px] rounded-t-[4px]"
                  style={{ height: Number(v) ? `${Math.max(2, (Number(v) / max) * H)}px` : 0, background: c as string }}
                />
              ))}
              {hover === i && (
                <div className={`absolute top-0 z-10 rounded-xl bg-slate-900 text-white text-[11px] px-2.5 py-1.5 shadow-lg whitespace-nowrap pointer-events-none ${i >= 7 ? 'right-full mr-1' : 'left-full ml-1'}`}>
                  <div className="font-semibold">{dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</div>
                  <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: RECEIVED }} />Received {d.received}</div>
                  <div className="flex items-center gap-1.5"><span className="w-2 h-2 rounded-sm" style={{ background: SENT }} />Sent {d.sent}</div>
                </div>
              )}
            </div>
          ))}
        </div>
        <div className="ml-8 flex mt-1">
          {days.map((d, i) => (
            <div key={d.date} className="flex-1 text-center text-[10px] text-slate-400">
              {i % 2 === 0 ? dayLabel(d.date, { day: 'numeric' }) : ''}
            </div>
          ))}
        </div>
        <div className="ml-8 flex justify-between text-[10px] text-slate-400">
          <span>{dayLabel(days[0].date, { month: 'short' })}</span>
          <span>{dayLabel(days[days.length - 1].date, { month: 'short' })}</span>
        </div>
      </div>
    </div>
  );
};

// Single series, so one hue and no legend; the value sits at the bar's end.
const HBars: React.FC<{ rows: { label: string; sub?: string; value: number }[] }> = ({ rows }) => {
  const max = Math.max(1, ...rows.map((r) => r.value));
  return (
    <div className="space-y-2.5">
      {rows.map((r) => (
        <div key={r.label + (r.sub || '')} title={`${r.label}${r.sub ? ` (${r.sub})` : ''}: ${r.value}`}>
          <div className="flex items-baseline justify-between gap-2 text-xs">
            <span className="text-slate-700 truncate">{r.label}{r.sub && <span className="text-slate-400"> · {r.sub}</span>}</span>
          </div>
          <div className="mt-1 flex items-center gap-2">
            <div className="h-3 rounded-r-[4px]" style={{ width: `${Math.max(2, (r.value / max) * 85)}%`, background: RECEIVED }} />
            <span className="text-[11px] font-semibold text-slate-700 tabular-nums">{r.value}</span>
          </div>
        </div>
      ))}
    </div>
  );
};

const CATEGORY_NAMES: Record<string, string> = { primary: 'Primary', updates: 'Updates', promotions: 'Promotions', social: 'Social' };

export const MailAnalyticsPopup: React.FC<{ token: string; onClose: () => void }> = ({ token, onClose }) => {
  const [data, setData] = useState<MailAnalytics | null>(null);
  const [error, setError] = useState('');
  const [table, setTable] = useState(false);
  useEffect(() => {
    mailFetch<MailAnalytics>(token, '/analytics').then(setData).catch((e) => setError(e.message));
  }, [token]);
  const days = useMemo(() => (data ? fourteenDays(data.dailyTrends) : []), [data]);
  const card = 'rounded-[24px] bg-white/70 border border-white/60 p-4';

  return (
    <MailPopup title="Mail analytics" icon={<BarChart3 className="w-4 h-4 text-sky-600" />} onClose={onClose} size="xl">
      {error ? (
        <div className="text-sm text-rose-600 py-6 text-center">{error}</div>
      ) : !data ? (
        <div className="space-y-3" style={{ animation: 'skeleton-in .2s ease both' }}>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{Array.from({ length: 4 }).map((_, i) => <div key={i} className="h-[72px] rounded-[20px] bg-white/60" />)}</div>
          <div className="h-64 rounded-[24px] bg-white/60" />
        </div>
      ) : (
        <div className="space-y-3">
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
            <Tile icon={<Inbox className="w-3.5 h-3.5" />} label="Received" value={data.receivedCount.toLocaleString('en-GB')} />
            <Tile icon={<Send className="w-3.5 h-3.5" />} label="Sent" value={data.sentCount.toLocaleString('en-GB')} />
            <Tile icon={<ShieldAlert className="w-3.5 h-3.5" />} label="Spam" value={data.spamCount.toLocaleString('en-GB')} />
            <Tile icon={<Timer className="w-3.5 h-3.5" />} label="Your average reply" value={fmtMinutes(data.averageResponseTimeMinutes)} />
          </div>

          <div className={card}>
            <div className="flex items-center justify-between gap-2 mb-3">
              <div className="text-sm font-semibold text-slate-800">Last 14 days</div>
              <button type="button" onClick={() => setTable((v) => !v)} className="inline-flex items-center gap-1 text-[11px] text-slate-500 hover:text-slate-800">
                <Table2 className="w-3.5 h-3.5" /> {table ? 'Show chart' : 'Show as table'}
              </button>
            </div>
            {table ? (
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-left text-slate-500"><th className="py-1 pr-3 font-medium">Day</th><th className="py-1 pr-3 font-medium text-right">Received</th><th className="py-1 font-medium text-right">Sent</th></tr>
                  </thead>
                  <tbody className="divide-y divide-slate-100">
                    {days.map((d) => (
                      <tr key={d.date}><td className="py-1 pr-3 text-slate-700">{dayLabel(d.date, { weekday: 'short', day: 'numeric', month: 'short' })}</td><td className="py-1 pr-3 text-right tabular-nums">{d.received}</td><td className="py-1 text-right tabular-nums">{d.sent}</td></tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : (
              <TrendChart days={days} />
            )}
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className={card}>
              <div className="text-sm font-semibold text-slate-800 mb-3">Who writes to you most</div>
              {data.contactEngagement.length ? (
                <HBars rows={data.contactEngagement.map((c) => ({ label: c.name || c.email, sub: c.name && c.name !== c.email ? c.email : undefined, value: c.count }))} />
              ) : (
                <p className="text-xs text-slate-500">No mail received yet.</p>
              )}
            </div>
            <div className={card}>
              <div className="text-sm font-semibold text-slate-800 mb-3">Inbox by category</div>
              {data.categoryDistribution.length ? (
                <HBars rows={[...data.categoryDistribution].sort((a, b) => b.value - a.value).map((c) => ({ label: CATEGORY_NAMES[c.name] || c.name, value: c.value }))} />
              ) : (
                <p className="text-xs text-slate-500">No mail received yet.</p>
              )}
            </div>
          </div>
          <p className="text-[11px] text-slate-500">Counts the mail Credence Mail has copied from your mailbox{' '}(the latest few hundred per folder on the first sync, and everything after).</p>
        </div>
      )}
    </MailPopup>
  );
};
