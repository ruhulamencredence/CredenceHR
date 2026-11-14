/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Dashboard: what a stat tile opens (On Leave Today, Pending
// Attendance Approval, Monthly Claim Amount…) — a full-screen liquid-glass
// sheet with the list as a table (a card per row on a phone). Each row can
// carry its request's details (RequestDetailsInline, same data and access
// check as Approve Application) and, for pending attendance, a tick for
// "Approve selected" — the dashboard keeps that logic; this only draws it.

import React, { useMemo, useState } from 'react';
import { Search, X } from 'lucide-react';
import { UserAvatar } from './UserAvatar';
import { RequestDetailsInline } from './RequestDetails';
import { useIsPhone } from '../lib/useScrolling';
import { useBackButtonClose } from '../lib/useBackButtonClose';

export interface SheetRow {
  key: string;
  name: string;
  user_id?: number | null;
  sub: string | null;
  right: string | null;
  // Rows are shown under a heading per group (Department), in this order.
  group?: string;
  detail?: { type: string; id: number };
  selectable?: boolean;
}

export const DashboardListSheet: React.FC<{
  token: string;
  title: string;
  subtitle?: string;
  rows: SheetRow[];
  subLabel?: string;
  rightLabel?: string;
  emptyText?: string;
  // Ticks (only for rows with selectable).
  picked?: Set<string>;
  onTogglePick?: (key: string) => void;
  onToggleAll?: () => void;
  busy?: boolean;
  message?: React.ReactNode;
  footer?: React.ReactNode;
  onClose: () => void;
}> = ({ token, title, subtitle, rows, subLabel = 'Details', rightLabel = 'Date', emptyText = 'Nothing is waiting.', picked, onTogglePick, onToggleAll, busy, message, footer, onClose }) => {
  const phone = useIsPhone();
  const [q, setQ] = useState('');
  useBackButtonClose(true, () => !busy && onClose());

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    if (!t) return rows;
    return rows.filter((r) => [r.name, r.sub, r.right, r.group].some((v) => String(v || '').toLowerCase().includes(t)));
  }, [rows, q]);

  // Keep the groups in the order they come (the dashboard sorts them).
  const groups = useMemo(() => {
    const out: { group: string | null; rows: SheetRow[] }[] = [];
    for (const r of shown) {
      const g = r.group ?? null;
      const last = out[out.length - 1];
      if (last && last.group === g) last.rows.push(r);
      else {
        const found = out.find((x) => x.group === g);
        if (found) found.rows.push(r);
        else out.push({ group: g, rows: [r] });
      }
    }
    return out;
  }, [shown]);

  const selectable = rows.filter((r) => r.selectable);
  const allPicked = selectable.length > 0 && selectable.every((r) => picked?.has(r.key));
  const hasDetails = rows.some((r) => r.detail);
  const hasRight = rows.some((r) => r.right);
  const hasSub = rows.some((r) => r.sub);

  const tick = (r: SheetRow) =>
    r.selectable ? (
      <input
        type="checkbox"
        checked={!!picked?.has(r.key)}
        onChange={() => onTogglePick?.(r.key)}
        aria-label={`Select ${r.name}`}
        className="w-4 h-4 shrink-0 accent-[var(--g-accent)]"
      />
    ) : null;
  const person = (r: SheetRow) => (
    <span className="flex items-center gap-2 min-w-0">
      <UserAvatar userId={r.user_id ?? undefined} name={r.name} className="w-7 h-7 text-[10px] shrink-0" />
      <span className="font-semibold text-slate-800 truncate">{r.name}</span>
    </span>
  );
  const details = (r: SheetRow) => (r.detail ? <RequestDetailsInline token={token} type={r.detail.type} id={r.detail.id} className="mt-0 max-w-none" /> : null);

  return (
    <div className="fixed inset-0 z-[90]" role="dialog" aria-modal="true" aria-label={title}>
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={() => !busy && onClose()} />
      <div className="absolute inset-0 sm:inset-4 lg:inset-6 flex">
        <div className="liquid-glass liquid-glass-in rounded-none sm:rounded-[32px] w-full h-full flex flex-col overflow-hidden">
          <div className="flex items-center gap-3 px-4 sm:px-6 pt-[max(1rem,env(safe-area-inset-top))] sm:pt-5 pb-3 shrink-0">
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-slate-900 truncate">{title}</h3>
              <p className="text-xs text-slate-500 mt-0.5">
                {subtitle ?? `${rows.length} total`}
                {q && ` · ${shown.length} shown`}
              </p>
            </div>
            {rows.length > 5 && (
              <label className="hidden sm:flex items-center gap-2 liquid-glass-inset rounded-full px-3 py-1.5 w-64">
                <Search className="w-3.5 h-3.5 text-slate-400" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, department…" className="bg-transparent text-xs outline-none flex-1 min-w-0" />
              </label>
            )}
            <button
              type="button"
              onClick={onClose}
              disabled={busy}
              className="liquid-glass-chip w-9 h-9 shrink-0 rounded-full flex items-center justify-center text-slate-600 active:scale-95 transition-transform"
              aria-label="Close"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
          {rows.length > 5 && (
            <label className="sm:hidden mx-4 mb-2 flex items-center gap-2 liquid-glass-inset rounded-full px-3 py-2">
              <Search className="w-3.5 h-3.5 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, department…" className="bg-transparent text-sm outline-none flex-1 min-w-0" />
            </label>
          )}
          {selectable.length > 0 && (
            <label className="mx-4 sm:mx-6 mb-2 flex items-center gap-2 text-xs font-semibold text-slate-700 select-none cursor-pointer">
              <input type="checkbox" checked={allPicked} onChange={() => onToggleAll?.()} className="w-4 h-4 accent-[var(--g-accent)]" />
              Select all you can approve ({selectable.length})
            </label>
          )}

          <div className="flex-1 min-h-0 overflow-y-auto px-3 sm:px-6 pb-4">
            {shown.length === 0 ? (
              <p className="text-sm text-slate-500 text-center py-16">{q ? 'No match.' : emptyText}</p>
            ) : phone ? (
              <div className="space-y-3">
                {groups.map((g) => (
                  <div key={g.group ?? '-'} className="space-y-1.5">
                    {g.group && (
                      <div className="flex items-center justify-between px-1 pt-1">
                        <span className="text-xs font-bold text-slate-700">{g.group}</span>
                        <span className="text-[11px] font-bold text-slate-500">{g.rows.length}</span>
                      </div>
                    )}
                    {g.rows.map((r) => (
                      <div key={r.key} className="liquid-glass-inset rounded-2xl px-3 py-2.5 space-y-2">
                        <div className="flex items-center gap-2 text-xs">
                          {tick(r)}
                          <span className="min-w-0 flex-1">
                            {person(r)}
                            {r.sub && <span className="block text-[11px] text-slate-500 mt-0.5 truncate">{r.sub}</span>}
                          </span>
                          {r.right && <span className="text-[11px] font-semibold text-blue-600 shrink-0">{r.right}</span>}
                        </div>
                        {details(r)}
                      </div>
                    ))}
                  </div>
                ))}
              </div>
            ) : (
              <div className="liquid-glass-inset rounded-2xl overflow-hidden">
                <table className="w-full text-xs">
                  <thead className="sticky top-0 z-[1] bg-white/85 backdrop-blur">
                    <tr className="text-left text-slate-500">
                      {selectable.length > 0 && <th className="w-10 px-3 py-2.5" />}
                      <th className="px-3 py-2.5 font-semibold whitespace-nowrap">Employee</th>
                      {hasSub && <th className="px-3 py-2.5 font-semibold whitespace-nowrap">{subLabel}</th>}
                      {hasRight && <th className="px-3 py-2.5 font-semibold whitespace-nowrap">{rightLabel}</th>}
                      {hasDetails && <th className="px-3 py-2.5 font-semibold whitespace-nowrap w-[48%]">Request</th>}
                    </tr>
                  </thead>
                  <tbody>
                    {groups.map((g) => (
                      <React.Fragment key={g.group ?? '-'}>
                        {g.group && (
                          <tr className="bg-slate-50/80">
                            <td colSpan={5} className="px-3 py-2 text-xs font-bold text-slate-700">
                              {g.group} <span className="ml-1 text-slate-400 font-semibold">({g.rows.length})</span>
                            </td>
                          </tr>
                        )}
                        {g.rows.map((r) => (
                          <tr key={r.key} className="border-t border-slate-200/60 align-top">
                            {selectable.length > 0 && <td className="px-3 py-2.5">{tick(r)}</td>}
                            <td className="px-3 py-2.5 min-w-[180px]">{person(r)}</td>
                            {hasSub && <td className="px-3 py-2.5 text-slate-600">{r.sub || '—'}</td>}
                            {hasRight && <td className="px-3 py-2.5 font-semibold text-blue-600 whitespace-nowrap">{r.right || '—'}</td>}
                            {hasDetails && <td className="px-3 py-2">{details(r) || <span className="text-slate-400">—</span>}</td>}
                          </tr>
                        ))}
                      </React.Fragment>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>

          {message && <div className="mx-4 sm:mx-6 mb-2">{message}</div>}
          {footer && <div className="px-4 sm:px-6 py-3 border-t border-white/60 flex items-center justify-between gap-3 shrink-0 pb-[max(0.75rem,env(safe-area-inset-bottom))]">{footer}</div>}
        </div>
      </div>
    </div>
  );
};

export default DashboardListSheet;
