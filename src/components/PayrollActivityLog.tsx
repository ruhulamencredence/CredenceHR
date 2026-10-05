/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Activity Log (GET /api/payroll/access-log, Payroll layer
// "access_log"): who opened Payroll and when, which pages they looked at,
// and everything they did — from which IP address and device. Excel export.

import React, { useEffect, useMemo, useState } from 'react';
import * as XLSX from 'xlsx';
import { Eye, FileSpreadsheet, LogIn, MousePointerClick, Search } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface LogRow {
  id: number;
  user_id: number | null;
  user_name: string | null;
  kind: 'open' | 'view' | 'action';
  area: string;
  detail: string | null;
  ip: string | null;
  device: string | null;
  created_at: string;
}

const day = (offset = 0) => {
  const d = new Date(Date.now() + offset * 86400000);
  return d.toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
};
const when = (v: string) => {
  const d = new Date(String(v).replace(' ', 'T'));
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true });
};
// "Mozilla/5.0 (Linux; Android 13; …) … Chrome/…" -> "Android · Chrome".
const deviceOf = (ua: string | null) => {
  if (!ua) return '';
  const os = /Android/i.test(ua) ? 'Android' : /iPhone|iPad/i.test(ua) ? 'iPhone' : /Windows/i.test(ua) ? 'Windows' : /Mac OS/i.test(ua) ? 'Mac' : /Linux/i.test(ua) ? 'Linux' : '';
  const br = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : '';
  return [os, br].filter(Boolean).join(' · ') || ua.slice(0, 40);
};
const KIND = {
  open: { label: 'Opened Payroll', icon: LogIn, cls: 'bg-blue-50 text-blue-700' },
  view: { label: 'Viewed', icon: Eye, cls: 'bg-slate-100 text-slate-600' },
  action: { label: 'Action', icon: MousePointerClick, cls: 'bg-amber-50 text-amber-700' }
} as const;

export const PayrollActivityLog: React.FC<{ token: string }> = ({ token }) => {
  const [from, setFrom] = useState(day(-6));
  const [to, setTo] = useState(day());
  const [kind, setKind] = useState('');
  const [who, setWho] = useState('');
  const [search, setSearch] = useState('');
  const [rows, setRows] = useState<LogRow[] | null>(null);
  const [error, setError] = useState('');

  useEffect(() => {
    setRows(null);
    setError('');
    const q = new URLSearchParams({ from, to });
    if (kind) q.set('kind', kind);
    fetch(apiUrl(`/api/payroll/access-log?${q}`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => ({}));
        if (!r.ok) throw new Error(d.error || 'Could not load the activity log.');
        setRows(d.rows);
      })
      .catch((e) => setError(e.message));
  }, [token, from, to, kind]);

  const people = useMemo(() => Array.from(new Set((rows || []).map((r) => r.user_name || '—'))).sort(), [rows]);
  const shown = useMemo(() => {
    const q = search.trim().toLowerCase();
    return (rows || []).filter((r) => (!who || (r.user_name || '—') === who) && (!q || `${r.area} ${r.detail || ''} ${r.ip || ''}`.toLowerCase().includes(q)));
  }, [rows, who, search]);

  const exportExcel = () => {
    const head = ['Date & time', 'User', 'Type', 'Page / Action', 'Detail', 'IP address', 'Device'];
    const body = shown.map((r) => [when(r.created_at), r.user_name || '', KIND[r.kind]?.label || r.kind, r.area, r.detail || '', r.ip || '', deviceOf(r.device)]);
    const ws = XLSX.utils.aoa_to_sheet([[`Payroll Activity Log — ${from} to ${to}`], [], head, ...body]);
    ws['!cols'] = [24, 22, 14, 34, 40, 16, 18].map((wch) => ({ wch }));
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, ws, 'Activity');
    XLSX.writeFile(wb, `Payroll-Activity-${from}-to-${to}.xlsx`);
  };

  const input = 'text-xs px-2.5 py-2 bg-white border border-slate-200 rounded-lg';
  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-end gap-2">
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 mb-1">From</label>
          <input type="date" value={from} max={to} onChange={(e) => e.target.value && setFrom(e.target.value)} className={input} />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 mb-1">To</label>
          <input type="date" value={to} min={from} onChange={(e) => e.target.value && setTo(e.target.value)} className={input} />
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 mb-1">User</label>
          <select value={who} onChange={(e) => setWho(e.target.value)} className={input}>
            <option value="">Everyone</option>
            {people.map((p) => (
              <option key={p}>{p}</option>
            ))}
          </select>
        </div>
        <div>
          <label className="block text-[11px] font-semibold text-slate-500 mb-1">Type</label>
          <select value={kind} onChange={(e) => setKind(e.target.value)} className={input}>
            <option value="">All</option>
            <option value="open">Opened Payroll</option>
            <option value="view">Viewed a page</option>
            <option value="action">Actions</option>
          </select>
        </div>
        <div className="relative">
          <label className="block text-[11px] font-semibold text-slate-500 mb-1">Search</label>
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 bottom-2.5" />
          <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Page, action, IP…" className={`${input} pl-8`} />
        </div>
        <button type="button" onClick={exportExcel} disabled={!shown.length} className="ml-auto inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-50">
          <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
        </button>
      </div>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {!rows ? (
        !error && (
          <div className="py-16 flex justify-center">
            <Spinner size={24} />
          </div>
        )
      ) : (
        <div className="bg-white rounded-2xl border border-slate-200 overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="bg-slate-50 text-slate-500">
              <tr>
                <th className="px-3 py-2 text-left">When</th>
                <th className="px-3 py-2 text-left">User</th>
                <th className="px-3 py-2 text-left">What</th>
                <th className="px-3 py-2 text-left">Detail</th>
                <th className="px-3 py-2 text-left">From</th>
              </tr>
            </thead>
            <tbody>
              {shown.length === 0 && (
                <tr>
                  <td colSpan={5} className="px-3 py-10 text-center text-slate-400">
                    No activity in this period.
                  </td>
                </tr>
              )}
              {shown.map((r) => {
                const k = KIND[r.kind] || KIND.view;
                return (
                  <tr key={r.id} className="border-t border-slate-100 align-top">
                    <td className="px-3 py-2 whitespace-nowrap text-slate-600">{when(r.created_at)}</td>
                    <td className="px-3 py-2 whitespace-nowrap font-medium text-slate-800">{r.user_name || '—'}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 text-[10px] font-semibold px-1.5 py-0.5 rounded ${k.cls}`}>
                        <k.icon className="w-3 h-3" /> {k.label}
                      </span>
                      <div className="text-slate-700 mt-0.5">{r.area}</div>
                    </td>
                    <td className="px-3 py-2 text-slate-600">{r.detail || ''}</td>
                    <td className="px-3 py-2 whitespace-nowrap text-slate-500">
                      {r.ip}
                      <div className="text-[10px] text-slate-400">{deviceOf(r.device)}</div>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      <p className="text-[11px] text-slate-400">Showing {shown.length} entries (the latest 5,000 in the period).</p>
    </div>
  );
};
