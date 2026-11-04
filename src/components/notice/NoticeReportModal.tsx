/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Notices -> a notice -> Who has read it (layer notice_read_report): who it
// went to, who opened it, who tapped "I have read this", by name and
// department; Excel; "Send again" to everyone who hasn't read it yet.

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { X, Search, Download, BellRing, Loader2 } from 'lucide-react';
import { apiUrl } from '../../lib/api';
import { formatDate } from '../../lib/formatDate';
import { saveWorkbookCrossPlatform } from '../../lib/saveFile';
import { confirmDialog } from '../../lib/confirmDialog';

interface Row {
  user_id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  opened_at: string | null;
  acknowledged_at: string | null;
  state: 'acknowledged' | 'opened' | 'not_yet';
}
interface Report {
  notice: { id: number; title: string; require_ack: boolean; status: string };
  total: number;
  acknowledged: number;
  opened: number;
  not_yet: number;
  rows: Row[];
}

const STATE = {
  acknowledged: { label: 'Read ✓', cls: 'bg-emerald-100 text-emerald-800', bar: '#10b981' },
  opened: { label: 'Opened', cls: 'bg-violet-100 text-violet-800', bar: '#a78bfa' },
  not_yet: { label: 'Not yet', cls: 'bg-slate-100 text-slate-600', bar: '#e2e8f0' }
} as const;

export const NoticeReportModal: React.FC<{ token: string; noticeId: number; onClose: () => void }> = ({ token, noticeId, onClose }) => {
  const [data, setData] = useState<Report | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [q, setQ] = useState('');
  const [tab, setTab] = useState<'all' | Row['state']>('all');
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<string | null>(null);

  const load = () =>
    fetch(apiUrl(`/api/notices/${noticeId}/report`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load the report.');
        setData(d);
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noticeId]);

  const rows = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data?.rows || []).filter(
      (r) => (tab === 'all' || r.state === tab) && (!s || [r.name, r.employee_code, r.designation, r.department].filter(Boolean).join(' ').toLowerCase().includes(s))
    );
  }, [data, q, tab]);

  const byDept = useMemo(() => {
    const m = new Map<string, { total: number; read: number }>();
    for (const r of data?.rows || []) {
      const k = r.department || 'No department';
      const e = m.get(k) || { total: 0, read: 0 };
      e.total++;
      if (data?.notice.require_ack ? r.state === 'acknowledged' : r.state !== 'not_yet') e.read++;
      m.set(k, e);
    }
    return [...m.entries()].sort((a, b) => b[1].total - a[1].total);
  }, [data]);

  const exportExcel = async () => {
    if (!data) return;
    const XLSX = await import('xlsx');
    const ws = XLSX.utils.json_to_sheet(
      data.rows.map((r) => ({
        Name: r.name,
        'Employee ID': r.employee_code || '',
        Designation: r.designation || '',
        Department: r.department || '',
        Status: STATE[r.state].label,
        Opened: r.opened_at ? formatDate(r.opened_at) : '',
        'Read (acknowledged)': r.acknowledged_at ? formatDate(r.acknowledged_at) : ''
      }))
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Who has read it');
    await saveWorkbookCrossPlatform(wb, `Notice-${data.notice.id}-readers.xlsx`);
  };

  const remind = async () => {
    if (!data) return;
    const n = data.notice.require_ack ? data.total - data.acknowledged : data.not_yet;
    if (!n) return setMsg('Everyone has read it.');
    if (!(await confirmDialog(`Send this notice again to the ${n} ${n === 1 ? 'person' : 'people'} who haven't read it yet?`))) return;
    setBusy(true);
    try {
      const r = await fetch(apiUrl(`/api/notices/${noticeId}/remind`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not send it again.');
      setMsg(`Sent again to ${d.sent} ${d.sent === 1 ? 'person' : 'people'}.`);
    } catch (e: any) {
      setMsg(e.message);
    } finally {
      setBusy(false);
    }
  };

  const pct = (n: number) => (data && data.total ? `${(n / data.total) * 100}%` : '0%');

  return createPortal(
    <div className="liquid-glass-backdrop fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={onClose}>
      <div className="w-full max-w-3xl" onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 max-h-[88vh] flex flex-col">
          <div className="flex items-start justify-between gap-3">
            <div className="min-w-0">
              <h3 className="text-base font-bold text-slate-900">Who has read it</h3>
              <p className="text-xs text-slate-500 truncate">{data?.notice.title || '…'}</p>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center text-slate-500 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          {error ? (
            <p className="text-sm text-rose-600 mt-4">{error}</p>
          ) : !data ? (
            <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-violet-600" /></div>
          ) : (
            <>
              <div className="h-2.5 rounded-full bg-slate-100 overflow-hidden flex mt-4">
                <i style={{ width: pct(data.acknowledged), background: STATE.acknowledged.bar }} />
                <i style={{ width: pct(data.opened), background: STATE.opened.bar }} />
              </div>
              <div className="flex flex-wrap gap-1.5 mt-3">
                {([['all', `All ${data.total}`], ['acknowledged', `Read ✓ ${data.acknowledged}`], ['opened', `Opened ${data.opened}`], ['not_yet', `Not yet ${data.not_yet}`]] as const).map(([k, l]) => (
                  <button key={k} type="button" onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-full text-xs font-semibold ${tab === k ? 'bg-slate-900 text-white' : 'bg-white border border-slate-200 text-slate-600'}`}>
                    {l}
                  </button>
                ))}
                <div className="flex-1" />
                <button type="button" onClick={() => void exportExcel()} className="px-3 py-1.5 rounded-full text-xs font-semibold bg-white border border-slate-200 inline-flex items-center gap-1"><Download className="w-3.5 h-3.5" /> Excel</button>
                <button type="button" disabled={busy || data.notice.status !== 'live'} onClick={() => void remind()} className="liquid-glass-button rounded-full px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-50" title={data.notice.status !== 'live' ? 'Only a live notice can be sent again' : undefined}>
                  <BellRing className="w-3.5 h-3.5" /> Send again to unread
                </button>
              </div>
              {msg && <p className="text-xs mt-2 text-slate-700">{msg}</p>}
              {byDept.length > 1 && (
                <div className="flex flex-wrap gap-1.5 mt-3">
                  {byDept.map(([d, v]) => (
                    <span key={d} className="text-[11px] px-2.5 py-1 rounded-full bg-white/80 border border-slate-200">
                      {d}: <b>{v.read}</b>/{v.total}
                    </span>
                  ))}
                </div>
              )}
              <div className="relative mt-3">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, Employee ID, department…" className="w-full pl-9 pr-3 py-2 rounded-xl border border-slate-200 bg-white text-sm" />
              </div>
              <div className="liquid-glass-inset rounded-2xl mt-3 overflow-y-auto min-h-0">
                <table className="w-full text-xs">
                  <thead className="text-slate-500 sticky top-0 bg-white/90">
                    <tr>
                      <th className="text-left px-3 py-2">Name</th>
                      <th className="text-left px-3 py-2">Department</th>
                      <th className="text-left px-3 py-2">Status</th>
                      <th className="text-left px-3 py-2">When</th>
                    </tr>
                  </thead>
                  <tbody>
                    {rows.map((r) => (
                      <tr key={r.user_id} className="border-t border-white/60">
                        <td className="px-3 py-2">
                          <div className="font-semibold text-slate-800">{r.name}</div>
                          <div className="text-[10.5px] text-slate-500">{[r.employee_code, r.designation].filter(Boolean).join(' · ')}</div>
                        </td>
                        <td className="px-3 py-2 text-slate-600">{r.department || '—'}</td>
                        <td className="px-3 py-2"><span className={`px-2 py-0.5 rounded-full font-semibold ${STATE[r.state].cls}`}>{STATE[r.state].label}</span></td>
                        <td className="px-3 py-2 text-slate-500 whitespace-nowrap">{r.acknowledged_at ? formatDate(r.acknowledged_at) : r.opened_at ? formatDate(r.opened_at) : '—'}</td>
                      </tr>
                    ))}
                    {!rows.length && (
                      <tr>
                        <td colSpan={4} className="px-3 py-8 text-center text-slate-500">Nobody here.</td>
                      </tr>
                    )}
                  </tbody>
                </table>
              </div>
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
