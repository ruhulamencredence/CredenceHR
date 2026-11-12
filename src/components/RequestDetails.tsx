/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Details" for any request an approver is asked to decide — the full
// request, who asked, attachments, map points and how far the approval has
// got — so whoever approves sees exactly what they approve. One popup used
// everywhere approvals show: Approve Application (pending and history), the
// Dashboard's Pending Approvals card, the approvals bell, Admin Panel ->
// Approvals. Data: GET /api/approval-details (ApprovalDetailsRoutes.ts),
// which only answers people who may see that request.

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Check, Clock, Eye, FileText, MapPin, Paperclip, User, X, XCircle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';

interface Details {
  type: string;
  id: number;
  type_label: string;
  title: string;
  status: string | null;
  submitted_at: string | null;
  requester: { name: string | null; employee_id: string | null; designation: string | null; department: string | null; branch: string | null } | null;
  fields: { label: string; value: string }[];
  table: { columns: string[]; rows: string[][] } | null;
  attachments: { label: string }[];
  has_file: boolean;
  locations: { label: string; lat: number; lng: number; place?: string | null }[];
  timeline: {
    status: string;
    current_step: number | null;
    total_steps: number | null;
    steps: { step: number | null; who: string | null; action: string | null; note: string | null; at: string | null }[];
    waiting_on: string[];
  } | null;
}

const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/;
const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const nice = (v: string) => {
  // Plain dates ("2026-11-03", "2026-11-02 to 2026-11-05") read as 03-Nov-2026.
  if (!ISO.test(v)) return v.replace(/\b(\d{4})-(\d{2})-(\d{2})\b/g, (m, y, mo, d) => (MON[Number(mo) - 1] ? `${d}-${MON[Number(mo) - 1]}-${y}` : m));
  const d = new Date(v);
  return isNaN(d.getTime()) ? v : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};
const statusTone = (s: string | null) =>
  s === 'approved' || s === 'fulfilled' || s === 'completed'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : s === 'rejected' || s === 'cancelled' || s === 'expired'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : 'bg-amber-50 text-amber-700 border-amber-200';

export const RequestDetailsPopup: React.FC<{ token: string; type: string; id: number; onClose: () => void }> = ({ token, type, id, onClose }) => {
  const [data, setData] = useState<Details | null>(null);
  const [error, setError] = useState('');
  useBackButtonClose(true, onClose);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        const r = await fetch(apiUrl(`/api/approval-details?type=${encodeURIComponent(type)}&id=${id}`), { headers: { Authorization: `Bearer ${token}` } });
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || 'Could not load the details.');
        if (alive) setData(d);
      } catch (e: any) {
        if (alive) setError(e.message);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, type, id]);

  const openFile = async () => {
    const r = await fetch(apiUrl(`/api/approval-details/file?type=${encodeURIComponent(type)}&id=${id}`), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return setError('Could not open the attachment.');
    const url = URL.createObjectURL(await r.blob());
    window.open(url, '_blank', 'noopener');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };

  const rq = data?.requester;
  return createPortal(
    <div className="fixed inset-0 z-[120] liquid-glass-backdrop flex items-end sm:items-center justify-center sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Request details"
        onClick={(e) => e.stopPropagation()}
        className="liquid-glass liquid-glass-in w-full sm:max-w-2xl rounded-t-[32px] sm:rounded-[32px] max-h-[90vh] flex flex-col overflow-hidden"
      >
        <div className="flex items-start gap-3 px-5 pt-5 pb-3">
          <span className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center text-blue-600 shrink-0">
            <FileText className="w-5 h-5" />
          </span>
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{data?.type_label || 'Request'}</p>
            <h3 className="text-base font-bold text-slate-900 leading-snug">{data?.title || (error ? 'Request details' : 'Loading…')}</h3>
            {data?.status && <span className={`inline-block mt-1 text-[10px] font-semibold uppercase border rounded-full px-2 py-0.5 ${statusTone(data.status)}`}>{data.status}</span>}
          </div>
          <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600 shrink-0">
            <X className="w-4 h-4" />
          </button>
        </div>

        <div className="flex-1 overflow-y-auto px-4 sm:px-5 pb-5 space-y-3">
          {error && <div className="rounded-2xl bg-rose-50 border border-rose-200 text-rose-700 text-xs px-3 py-2">{error}</div>}
          {!data && !error && <div className="liquid-glass-inset rounded-2xl px-4 py-10 text-center text-sm text-slate-400">Loading…</div>}
          {data && (
            <>
              {rq && (
                <div className="liquid-glass-inset rounded-2xl p-3 flex items-center gap-3">
                  <span className="w-9 h-9 rounded-full bg-blue-600 text-white flex items-center justify-center shrink-0">
                    <User className="w-4 h-4" />
                  </span>
                  <div className="min-w-0">
                    <p className="text-sm font-semibold text-slate-900 truncate">{rq.name || '—'}</p>
                    <p className="text-[11px] text-slate-500 truncate">{[rq.employee_id, rq.designation, rq.department, rq.branch].filter(Boolean).join(' · ') || '—'}</p>
                  </div>
                  {data.submitted_at && <p className="ml-auto text-[11px] text-slate-500 text-right shrink-0">Asked<br />{nice(data.submitted_at)}</p>}
                </div>
              )}

              {data.fields.length > 0 && (
                <dl className="liquid-glass-inset rounded-2xl p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-2.5">
                  {data.fields.map((f, i) => (
                    <div key={i} className={f.value.length > 60 ? 'sm:col-span-2' : ''}>
                      <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-500">{f.label}</dt>
                      <dd className="text-sm text-slate-800 whitespace-pre-wrap break-words">{nice(f.value)}</dd>
                    </div>
                  ))}
                </dl>
              )}

              {data.table && data.table.rows.length > 0 && (
                <div className="liquid-glass-inset rounded-2xl overflow-x-auto">
                  <table className="w-full text-xs">
                    <thead>
                      <tr className="text-left text-slate-500">
                        {data.table.columns.map((c) => (
                          <th key={c} className="px-3 py-2 font-semibold capitalize">
                            {c}
                          </th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {data.table.rows.map((row, i) => (
                        <tr key={i} className="border-t border-slate-200/70">
                          {row.map((cell, j) => (
                            <td key={j} className="px-3 py-2 text-slate-800 align-top">
                              {nice(cell)}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {(data.attachments.length > 0 || data.locations.length > 0) && (
                <div className="flex flex-wrap gap-2">
                  {data.attachments.map((a, i) => (
                    <button
                      key={i}
                      type="button"
                      onClick={() => void openFile()}
                      disabled={!data.has_file}
                      className="liquid-glass-chip rounded-full px-3 py-1.5 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5 disabled:opacity-50"
                    >
                      <Paperclip className="w-3.5 h-3.5" /> {a.label}
                    </button>
                  ))}
                  {data.locations.map((l, i) => (
                    <a
                      key={i}
                      href={`https://www.google.com/maps?q=${l.lat},${l.lng}`}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="liquid-glass-chip rounded-full px-3 py-1.5 text-xs font-semibold text-slate-700 inline-flex items-center gap-1.5"
                    >
                      <MapPin className="w-3.5 h-3.5 text-rose-500" /> {l.label}
                      {l.place ? ` — ${l.place}` : ''}
                    </a>
                  ))}
                </div>
              )}

              {data.timeline && (
                <div className="liquid-glass-inset rounded-2xl p-3">
                  <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-500 mb-2">
                    Approval{data.timeline.total_steps ? ` — Layer ${Math.min(data.timeline.current_step || 1, data.timeline.total_steps)} of ${data.timeline.total_steps}` : ''}
                  </p>
                  {data.timeline.steps.length === 0 && data.timeline.waiting_on.length === 0 && <p className="text-xs text-slate-500">No one has decided yet.</p>}
                  <ol className="space-y-2">
                    {data.timeline.steps.map((s, i) => (
                      <li key={i} className="flex items-start gap-2 text-xs">
                        {s.action === 'rejected' ? <XCircle className="w-4 h-4 text-rose-500 shrink-0" /> : <Check className="w-4 h-4 text-emerald-600 shrink-0" />}
                        <div className="min-w-0">
                          <p className="text-slate-800">
                            {s.step ? `Layer ${s.step} · ` : ''}
                            <b>{s.who || '—'}</b> {s.action || ''}
                            {s.at ? <span className="text-slate-500"> · {nice(s.at)}</span> : null}
                          </p>
                          {s.note && <p className="text-slate-500">“{s.note}”</p>}
                        </div>
                      </li>
                    ))}
                    {data.timeline.status === 'pending' && data.timeline.waiting_on.length > 0 && (
                      <li className="flex items-start gap-2 text-xs">
                        <Clock className="w-4 h-4 text-amber-500 shrink-0" />
                        <p className="text-slate-800">
                          Waiting on <b>{data.timeline.waiting_on.join(', ')}</b>
                        </p>
                      </li>
                    )}
                  </ol>
                </div>
              )}
            </>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};

/** A small "Details" button that opens the popup above for one request. */
export const RequestDetailsButton: React.FC<{ token: string; type: string; id: number | string; className?: string; label?: string }> = ({ token, type, id, className = '', label = 'Details' }) => {
  const [open, setOpen] = useState(false);
  const n = Number(id);
  if (!type || !Number.isFinite(n) || n <= 0) return null;
  return (
    <>
      <button
        type="button"
        onClick={(e) => {
          e.stopPropagation();
          setOpen(true);
        }}
        className={`inline-flex items-center gap-1 rounded-full border border-blue-200 bg-blue-50 px-2.5 py-1 text-[11px] font-semibold text-blue-700 hover:bg-blue-100 ${className}`}
      >
        <Eye className="w-3.5 h-3.5" /> {label}
      </button>
      {open && <RequestDetailsPopup token={token} type={type} id={n} onClose={() => setOpen(false)} />}
    </>
  );
};

/**
 * The same details, laid straight into a request card (Approve Application),
 * so the approver reads what they decide without opening anything: the
 * request's fields, its item lines, attachments and map points. The
 * requester, status and approval layer already show on the card, so they
 * are left out here. `hide` drops fields the card already shows itself;
 * `noTable` drops the item lines when the card draws its own.
 */
export const RequestDetailsInline: React.FC<{ token: string; type: string; id: number | string; hide?: string[]; noTable?: boolean; className?: string }> = ({
  token,
  type,
  id,
  hide = [],
  noTable = false,
  className = ''
}) => {
  const n = Number(id);
  const [data, setData] = useState<Details | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    if (!type || !Number.isFinite(n) || n <= 0) return;
    let alive = true;
    (async () => {
      try {
        const r = await fetch(apiUrl(`/api/approval-details?type=${encodeURIComponent(type)}&id=${n}`), { headers: { Authorization: `Bearer ${token}` } });
        if (!r.ok) throw new Error();
        const d = await r.json();
        if (alive) setData(d);
      } catch {
        if (alive) setFailed(true);
      }
    })();
    return () => {
      alive = false;
    };
  }, [token, type, n]);

  if (!type || !Number.isFinite(n) || n <= 0 || failed) return null;
  if (!data)
    return (
      <div className={`mt-2 max-w-xl grid grid-cols-2 gap-x-4 gap-y-2 ${className}`} aria-hidden="true">
        {[0, 1, 2, 3].map((i) => (
          <div key={i}>
            <div className="h-2 w-14 rounded-full bg-slate-200/80 animate-pulse" />
            <div className="mt-1 h-2.5 w-24 rounded-full bg-slate-200/80 animate-pulse" />
          </div>
        ))}
      </div>
    );

  const skip = new Set(['Status', ...hide]);
  const fields = data.fields.filter((f) => !skip.has(f.label) && f.value !== '');
  const openFile = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const r = await fetch(apiUrl(`/api/approval-details/file?type=${encodeURIComponent(type)}&id=${n}`), { headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) return;
    const url = URL.createObjectURL(await r.blob());
    window.open(url, '_blank', 'noopener');
    window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
  };
  const table = !noTable && data.table && data.table.rows.length ? data.table : null;
  if (!fields.length && !table && !data.attachments.length && !data.locations.length) return null;
  return (
    <div className={`mt-2 max-w-xl space-y-2 ${className}`}>
      {fields.length > 0 && (
        <dl className="grid grid-cols-2 gap-x-4 gap-y-1.5 rounded-xl bg-white/60 border border-slate-200/80 px-3 py-2">
          {fields.map((f, i) => (
            <div key={i} className={f.value.length > 40 ? 'col-span-2' : ''}>
              <dt className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{f.label}</dt>
              <dd className="text-xs text-slate-800 whitespace-pre-wrap break-words">{nice(f.value)}</dd>
            </div>
          ))}
        </dl>
      )}
      {table && (
        <div className="rounded-xl border border-slate-200/80 bg-white/60 overflow-x-auto">
          <table className="w-full text-[11px]">
            <thead>
              <tr className="text-left text-slate-400">
                {table.columns.map((c) => (
                  <th key={c} className="px-2.5 py-1.5 font-semibold capitalize">
                    {c}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {table.rows.map((row, i) => (
                <tr key={i} className="border-t border-slate-100">
                  {row.map((cell, j) => (
                    <td key={j} className="px-2.5 py-1.5 text-slate-700 align-top">
                      {nice(cell)}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {(data.attachments.length > 0 || data.locations.length > 0) && (
        <div className="flex flex-wrap gap-1.5">
          {data.attachments.map((a, i) => (
            <button
              key={i}
              type="button"
              onClick={(e) => void openFile(e)}
              disabled={!data.has_file}
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 inline-flex items-center gap-1 hover:bg-slate-50 disabled:opacity-50"
            >
              <Paperclip className="w-3 h-3" /> {a.label}
            </button>
          ))}
          {data.locations.map((l, i) => (
            <a
              key={i}
              href={`https://www.google.com/maps?q=${l.lat},${l.lng}`}
              target="_blank"
              rel="noopener noreferrer"
              onClick={(e) => e.stopPropagation()}
              className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-semibold text-slate-700 inline-flex items-center gap-1 hover:bg-slate-50"
            >
              <MapPin className="w-3 h-3 text-rose-500" /> {l.label}
            </a>
          ))}
        </div>
      )}
    </div>
  );
};
