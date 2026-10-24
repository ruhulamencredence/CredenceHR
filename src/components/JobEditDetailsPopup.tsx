/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> PEPM Manage -> Edit Log -> Job Edit Approvals -> Details:
// everything a New Job / Add MPR / Delete MPR request proposes, so it can be
// checked before Approve or Reject. Same "editlog" module as the list
// (GET /api/job-edits, which adds each row's Specification / Unit / Budget
// Req. Qty).

import React from 'react';
import { CheckCircle2, XCircle, ListChecks, Loader2 } from 'lucide-react';
import { formatDate } from '../lib/formatDate';
import { MailPopup as Popup, primaryBtn, ghostBtn } from './mail/MailPopup';
import type { PendingJobEdit } from '../types';

const TITLE: Record<PendingJobEdit['action'], string> = { add_job: 'New Job', add_item: 'Add MPR', delete_entry: 'Delete MPR' };
const qty = (v: any) => (v === null || v === undefined || v === '' ? '—' : Number(v).toLocaleString('en-US', { maximumFractionDigits: 2 }));

export const JobEditDetailsPopup: React.FC<{
  r: PendingJobEdit;
  acting: boolean;
  onClose: () => void;
  onAct: (action: 'approve' | 'reject') => void;
}> = ({ r, acting, onClose, onAct }) => {
  const p = r.payload || {};
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

        <div className="text-xs font-semibold text-slate-700">
          {rows.length} MPR row{rows.length === 1 ? '' : 's'}
          {r.action === 'delete_entry' ? ' to delete' : ' to add'}
        </div>
        {/* Cards on a phone, a table from sm up. */}
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
        {!pending && (
          <p className="text-[11px] text-slate-500">
            {r.status === 'approved' ? 'Approved' : 'Rejected'} by {r.reviewed_by_name || '—'}.
          </p>
        )}
      </div>
    </Popup>
  );
};
