/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> PEPM Manage -> Edit Log -> Job Edit Approvals -> Details:
// everything a New Job / Add MPR / Delete MPR request proposes, so it can be
// checked before Approve or Reject. Same "editlog" module as the list
// (GET /api/job-edits, which adds each row's Specification / Unit / Budget
// Req. Qty).

import React, { useEffect, useState } from 'react';
import { AlertTriangle, CheckCircle2, XCircle, ListChecks, Loader2, Plus, Trash2 } from 'lucide-react';
import { formatDate } from '../lib/formatDate';
import { apiUrl } from '../lib/api';
import { MD_STATUS, MdStatus } from './MprDispatchShared';
import { MailPopup as Popup, primaryBtn, ghostBtn } from './mail/MailPopup';
import type { PendingJobEdit } from '../types';

const TITLE: Record<PendingJobEdit['action'], string> = { add_job: 'New Job', add_item: 'Add MPR', delete_entry: 'Delete MPR' };
// GET /api/job-edits/:id/context — the Job as it stands now.
interface JobContextRow {
  id: number;
  mpr_no: string | null;
  item_name: string | null;
  specification: string | null;
  unit: string | null;
  budget_qty: any;
  requisitioned_qty: any;
  delivery_date: string | null;
  entry_date: string | null;
  deleted_at: string | null;
  md_status: string | null;
  md_dispatched_qty: any;
  md_received_qty: any;
  created_by_name: string | null;
}
interface JobContext {
  job: { job_no: string | null; job_name: string | null; project_name: string | null; budget_name: string | null; job_duration: string | null } | null;
  rows: JobContextRow[];
  item: { budget_qty: number | null; specification: string; unit: string; used: number } | null;
}

const qty = (v: any) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));

export const JobEditDetailsPopup: React.FC<{
  r: PendingJobEdit;
  token: string;
  acting: boolean;
  onClose: () => void;
  onAct: (action: 'approve' | 'reject') => void;
}> = ({ r, token, acting, onClose, onAct }) => {
  const p = r.payload || {};
  const [ctx, setCtx] = useState<JobContext | null>(null);
  const [ctxError, setCtxError] = useState('');
  useEffect(() => {
    if (r.action === 'add_job') return;
    let cancelled = false;
    fetch(apiUrl(`/api/job-edits/${r.id}/context`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => {
        const data = await res.json().catch(() => ({}));
        if (cancelled) return;
        if (!res.ok) setCtxError(data.error || 'Could not load the Job.');
        else setCtx(data);
      })
      .catch(() => !cancelled && setCtxError('Could not load the Job.'));
    return () => {
      cancelled = true;
    };
  }, [r.id, r.action, token]);
  const target = r.action === 'delete_entry' && ctx ? ctx.rows.find((x) => x.id === r.entry_id) || null : null;
  const rows: any[] =
    r.action === 'add_job'
      ? Array.isArray(p.items)
        ? p.items
        : []
      : r.action === 'add_item'
        ? [p]
        : [{ mpr_no: r.entry_mpr_no, item_name: r.entry_item_name, requisitioned_qty: r.entry_requisitioned_qty, delivery_date: r.entry_delivery_date }];
  const facts: [string, React.ReactNode][] = [
    ...(r.action === 'add_job'
      ? ([
          ['New Job', p.job_name || '—'],
          ['Project', p.project_name || '—'],
          ['Budget', p.budget_name || '—'],
          ['Job duration', p.job_duration || '—']
        ] as [string, React.ReactNode][])
      : []),
    ...(r.action !== 'add_job' ? ([['Job', r.job_no || r.job_name || '—']] as [string, React.ReactNode][]) : []),
    ['Requested by', `${r.requested_by_name || '—'} · ${formatDate(r.created_at) || r.created_at}`]
  ];
  const pending = r.status === 'pending';
  return (
    <Popup
      title={`${TITLE[r.action]} — details`}
      icon={<ListChecks className="w-4 h-4" />}
      size="xl"
      onClose={acting ? () => {} : onClose}
      footer={
        pending ? (
          <>
            <button type="button" className={ghostBtn} disabled={acting} onClick={() => onAct('reject')}>
              <XCircle className="w-4 h-4 inline mr-1 -mt-0.5 text-rose-600" />Reject
            </button>
            <button type="button" className={primaryBtn} disabled={acting} onClick={() => onAct('approve')}>
              {acting ? <Loader2 className="w-4 h-4 animate-spin" /> : <CheckCircle2 className="w-4 h-4" />} Approve
            </button>
          </>
        ) : (
          <button type="button" className={ghostBtn} onClick={onClose}>Close</button>
        )
      }
    >
      <div className="space-y-3 text-left">
        <div className="liquid-glass-inset rounded-[24px] p-3 grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1.5 text-xs">
          {facts.map(([k, v]) => (
            <div key={k} className="min-w-0">
              <span className="text-slate-500">{k}: </span>
              <span className="font-semibold text-slate-800 break-words">{v}</span>
            </div>
          ))}
          {String(p.reason || '').trim() && (
            <div className="sm:col-span-2 min-w-0">
              <span className="text-slate-500">Reason: </span>
              <span className="italic text-slate-800 break-words">{String(p.reason).trim()}</span>
            </div>
          )}
        </div>

        {r.action !== 'add_job' && (
          <JobChangePreview r={r} ctx={ctx} error={ctxError} target={target} pending={pending} />
        )}

        {r.action === 'add_job' && (
        <div className="text-xs font-semibold text-slate-700">
          {rows.length} MPR row{rows.length === 1 ? '' : 's'}
          {' to add'}
        </div>
        )}
        {/* Cards on a phone, a table from sm up. */}
        {r.action === 'add_job' && (
        <>
        <div className="sm:hidden space-y-2">
          {rows.map((it, i) => (
            <div key={i} className="liquid-glass-inset rounded-[20px] p-3 text-xs space-y-0.5">
              <div className="text-sm font-semibold text-slate-900">{it.item_name || '—'}</div>
              {it.specification && <div className="text-slate-600">{it.specification}</div>}
              <div className="text-slate-600">MPR {it.mpr_no || '—'} · Qty <b>{qty(it.requisitioned_qty)}</b>{it.unit ? ` ${it.unit}` : ''}{it.budget_qty != null ? ` (Budget ${qty(it.budget_qty)})` : ''}</div>
              <div className="text-slate-600">Delivery {formatDate(it.delivery_date || '') || '—'}</div>
            </div>
          ))}
        </div>
        <div className="hidden sm:block liquid-glass-inset rounded-[20px] overflow-x-auto">
          <table className="w-full text-xs">
            <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
              <tr>
                <th className="px-3 py-2">#</th>
                <th className="px-3 py-2">MPR No</th>
                <th className="px-3 py-2">Item</th>
                <th className="px-3 py-2">Specification</th>
                <th className="px-3 py-2 text-right">Qty</th>
                <th className="px-3 py-2">Unit</th>
                <th className="px-3 py-2 text-right">Budget Qty</th>
                <th className="px-3 py-2">Delivery</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-200/60">
              {rows.map((it, i) => (
                <tr key={i} className="align-top">
                  <td className="px-3 py-2 text-slate-400">{i + 1}</td>
                  <td className="px-3 py-2 font-semibold text-slate-800 whitespace-nowrap">{it.mpr_no || '—'}</td>
                  <td className="px-3 py-2 text-slate-800">{it.item_name || '—'}</td>
                  <td className="px-3 py-2 text-slate-600">{it.specification || '—'}</td>
                  <td className="px-3 py-2 text-right font-semibold text-slate-800 whitespace-nowrap">{qty(it.requisitioned_qty)}</td>
                  <td className="px-3 py-2 text-slate-600">{it.unit || '—'}</td>
                  <td className="px-3 py-2 text-right text-slate-500 whitespace-nowrap">{qty(it.budget_qty)}</td>
                  <td className="px-3 py-2 text-slate-700 whitespace-nowrap">{formatDate(it.delivery_date || '') || '—'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        </>
        )}
        {!pending && (
          <p className="text-[11px] text-slate-500">
            {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.reviewed_by_name || '—'}.
          </p>
        )}
      </div>
    </Popup>
  );
};

// Add MPR / Delete MPR: exactly what changes. A delete lists everything about
// the row going away (and warns when material was already sent against it);
// an Add MPR shows the Budget item's quantity before and after. Below that,
// the Job's MPR rows with the change marked in place: the new row in green,
// the deleted row in red and struck through.
const JobChangePreview: React.FC<{
  r: PendingJobEdit;
  ctx: JobContext | null;
  error: string;
  target: JobContextRow | null;
  pending: boolean;
}> = ({ r, ctx, error, target, pending }) => {
  const p = r.payload || {};
  const isDelete = r.action === 'delete_entry';
  if (error) return <p className="text-xs text-rose-600">{error}</p>;
  if (!ctx) {
    return (
      <p className="text-xs text-slate-500 flex items-center gap-1.5">
        <Loader2 className="w-3.5 h-3.5 animate-spin" /> Loading the Job…
      </p>
    );
  }

  const unit = (u?: string | null) => (u ? ` ${u}` : '');
  const sent = target ? Number(target.md_dispatched_qty || 0) : 0;
  const received = target ? Number(target.md_received_qty || 0) : 0;
  const status = target?.md_status && MD_STATUS[target.md_status as MdStatus] ? MD_STATUS[target.md_status as MdStatus] : null;

  // Delete: the row itself (from the Job context, falling back to what the
  // request list already carries).
  const delFacts: [string, React.ReactNode][] = isDelete
    ? [
        ['MPR No', target?.mpr_no || r.entry_mpr_no || '—'],
        ['Item', target?.item_name || r.entry_item_name || '—'],
        ['Specification', target?.specification || '—'],
        ['Requisitioned Qty', `${qty(target?.requisitioned_qty ?? r.entry_requisitioned_qty)}${unit(target?.unit)}`],
        ['Budget Qty', `${qty(target?.budget_qty)}${unit(target?.unit)}`],
        ['Delivery Date', formatDate(target?.delivery_date || r.entry_delivery_date || '') || '—'],
        ['Entry Date', formatDate(target?.entry_date || '') || '—'],
        ['Entered by', target?.created_by_name || '—'],
        ['Dispatch', status ? `${status.label}${sent ? ` · sent ${qty(sent)}` : ''}${received ? ` · received ${qty(received)}` : ''}` : 'Not dispatched']
      ]
    : [];

  // Add MPR: the Budget item before / after.
  const addQty = Number(p.requisitioned_qty || 0);
  const item = ctx.item;
  const after = item ? item.used + addQty : null;
  const leftAfter = item && item.budget_qty != null && after != null ? item.budget_qty - after : null;

  const activeRows = ctx.rows.filter((x) => !x.deleted_at || x.id === r.entry_id);
  const before = ctx.rows.filter((x) => !x.deleted_at).length;
  const afterCount = pending ? (isDelete ? before - 1 : before + 1) : before;

  return (
    <div className="space-y-3">
      {isDelete ? (
        <div className="rounded-[20px] border border-rose-200 bg-rose-50/70 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-rose-700 mb-2">
            <Trash2 className="w-3.5 h-3.5" /> {pending ? 'This MPR row will be deleted' : 'MPR row in this request'}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
            {delFacts.map(([k, v]) => (
              <div key={k} className="min-w-0">
                <span className="text-rose-900/60">{k}: </span>
                <span className="font-semibold text-rose-950 break-words">{v}</span>
              </div>
            ))}
          </div>
          {pending && (sent > 0 || received > 0) && (
            <p className="mt-2 flex items-start gap-1.5 text-amber-800 bg-amber-50 border border-amber-200 rounded-xl px-2.5 py-1.5">
              <AlertTriangle className="w-3.5 h-3.5 shrink-0 mt-px" />
              Material was already {received > 0 ? 'received' : 'dispatched'} against this row.
            </p>
          )}
        </div>
      ) : (
        <div className="rounded-[20px] border border-emerald-200 bg-emerald-50/70 p-3 text-xs">
          <div className="flex items-center gap-1.5 font-semibold text-emerald-700 mb-2">
            <Plus className="w-3.5 h-3.5" /> {pending ? 'This MPR row will be added' : 'MPR row in this request'}
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-1">
            {(
              [
                ['MPR No', p.mpr_no || '—'],
                ['Item', p.item_name || '—'],
                ['Specification', item?.specification || p.specification || '—'],
                ['Requisitioned Qty', `${qty(p.requisitioned_qty)}${unit(item?.unit || p.unit)}`],
                ['Delivery Date', formatDate(p.delivery_date || '') || '—']
              ] as [string, React.ReactNode][]
            ).map(([k, v]) => (
              <div key={k} className="min-w-0">
                <span className="text-emerald-900/60">{k}: </span>
                <span className="font-semibold text-emerald-950 break-words">{v}</span>
              </div>
            ))}
          </div>
          {pending && item && (
            <p className="mt-2 text-emerald-900">
              Budget Qty {qty(item.budget_qty)}{unit(item.unit)} · already requisitioned <b>{qty(item.used)}</b> → after this <b>{qty(after)}</b>
              {leftAfter != null && (
                <span className={leftAfter < 0 ? 'text-rose-700 font-semibold' : ''}> · left {qty(leftAfter)}</span>
              )}
            </p>
          )}
        </div>
      )}

      {ctx.job && (
        <div className="text-xs text-slate-600">
          <span className="font-semibold text-slate-800">{ctx.job.job_no || '—'}</span>
          {ctx.job.job_name ? ` · ${ctx.job.job_name}` : ''}
          {ctx.job.project_name ? ` · ${ctx.job.project_name}` : ''}
          {ctx.job.budget_name ? ` · ${ctx.job.budget_name}` : ''}
          {pending && (
            <span className="ml-1 text-slate-500">
              — MPR rows: {before} → <b className="text-slate-800">{afterCount}</b>
            </span>
          )}
        </div>
      )}

      <div className="liquid-glass-inset rounded-[20px] overflow-x-auto">
        <table className="w-full text-xs">
          <thead className="text-left text-[10px] uppercase tracking-wider text-slate-500">
            <tr>
              <th className="px-3 py-2">MPR No</th>
              <th className="px-3 py-2">Item</th>
              <th className="px-3 py-2 hidden sm:table-cell">Specification</th>
              <th className="px-3 py-2 text-right">Qty</th>
              <th className="px-3 py-2">Delivery</th>
              <th className="px-3 py-2">Change</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-200/60">
            {activeRows.map((x) => {
              const del = isDelete && x.id === r.entry_id;
              return (
                <tr key={x.id} className={del ? 'bg-rose-50 text-rose-800' : 'text-slate-700'}>
                  <td className={`px-3 py-2 font-semibold whitespace-nowrap ${del ? 'line-through' : ''}`}>{x.mpr_no || '—'}</td>
                  <td className={`px-3 py-2 ${del ? 'line-through' : ''}`}>{x.item_name || '—'}</td>
                  <td className={`px-3 py-2 hidden sm:table-cell text-slate-500 ${del ? 'line-through' : ''}`}>{x.specification || '—'}</td>
                  <td className={`px-3 py-2 text-right whitespace-nowrap ${del ? 'line-through' : ''}`}>{qty(x.requisitioned_qty)}{unit(x.unit)}</td>
                  <td className={`px-3 py-2 whitespace-nowrap ${del ? 'line-through' : ''}`}>{formatDate(x.delivery_date || '') || '—'}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {del ? (
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-100 text-rose-700">{x.deleted_at ? 'Deleted' : 'Delete'}</span>
                    ) : (
                      <span className="text-slate-300">—</span>
                    )}
                  </td>
                </tr>
              );
            })}
            {!isDelete && pending && (
              <tr className="bg-emerald-50 text-emerald-900">
                <td className="px-3 py-2 font-semibold whitespace-nowrap">{p.mpr_no || '—'}</td>
                <td className="px-3 py-2">{p.item_name || '—'}</td>
                <td className="px-3 py-2 hidden sm:table-cell">{item?.specification || '—'}</td>
                <td className="px-3 py-2 text-right whitespace-nowrap">{qty(p.requisitioned_qty)}{unit(item?.unit)}</td>
                <td className="px-3 py-2 whitespace-nowrap">{formatDate(p.delivery_date || '') || '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">
                  <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-100 text-emerald-700">+ New</span>
                </td>
              </tr>
            )}
            {activeRows.length === 0 && !(!isDelete && pending) && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-slate-400">No MPR rows on this Job.</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
};
