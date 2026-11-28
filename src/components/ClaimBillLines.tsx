/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { Receipt, Paperclip } from 'lucide-react';
import { BillClaimItem } from '../types';
import { formatDate } from '../lib/formatDate';
import { AttachmentViewer } from './AttachmentViewer';

const money = (n: number) => `৳${Number(n).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The bills inside a Bill Claim (category / date / amount), shown
// wherever the claim is looked at — the claimant's own detail view, the Admin's
// Bill Claim review and the approvers' screens. Category names are the ones
// the bills were filed under. With `token` + `fileSrc`, each bill's receipts
// open in the app (‹ › through all the claim's receipts); fileSrc gives the
// URL the viewer may use (/api/bill-claims/:id/item-files/:f for the owner and
// Bill Claim admins, /api/approval-details/file?…&file= for approvers).
export const ClaimBillLines: React.FC<{
  items?: BillClaimItem[] | null;
  compact?: boolean;
  token?: string;
  fileSrc?: (fileId: number) => string;
}> = ({ items, compact, token, fileSrc }) => {
  const [viewing, setViewing] = useState<number | null>(null);
  if (!items || items.length === 0) return null;
  const total = items.reduce((s, i) => s + Number(i.amount), 0);
  const all = items.flatMap((i) => (i.files || []).map((f) => ({ f, label: `${i.category_name} · ${formatDate(i.bill_date)}` })));
  const showReceipts = all.length > 0;
  const canOpen = !!token && !!fileSrc;
  const cur = viewing != null ? all[viewing] : null;
  return (
    <div className={compact ? 'mt-2 max-w-md' : ''}>
      {!compact && (
        <div className="text-[11px] font-semibold text-slate-400 mb-1.5 flex items-center gap-1">
          <Receipt className="w-3.5 h-3.5" /> Bills ({items.length})
        </div>
      )}
      <table className="w-full text-[11px] border-collapse">
        <thead>
          <tr className="bg-slate-50 text-slate-500">
            <th className="text-left font-semibold px-2 py-1 border border-slate-200">Date</th>
            <th className="text-left font-semibold px-2 py-1 border border-slate-200">Category</th>
            {!compact && <th className="text-left font-semibold px-2 py-1 border border-slate-200">Note</th>}
            <th className="text-right font-semibold px-2 py-1 border border-slate-200">Amount</th>
            {showReceipts && <th className="text-center font-semibold px-2 py-1 border border-slate-200">Receipt</th>}
          </tr>
        </thead>
        <tbody>
          {items.map((i, idx) => (
            <tr key={i.id ?? idx}>
              <td className="px-2 py-1 border border-slate-200 whitespace-nowrap text-slate-700">{formatDate(i.bill_date)}</td>
              <td className="px-2 py-1 border border-slate-200 text-slate-800" title={compact && i.description ? i.description : undefined}>
                {i.category_name}
              </td>
              {!compact && <td className="px-2 py-1 border border-slate-200 text-slate-500 break-words">{i.description || '—'}</td>}
              <td className="px-2 py-1 border border-slate-200 text-right tabular-nums text-slate-900">{money(i.amount)}</td>
              {showReceipts && (
                <td className="px-1.5 py-1 border border-slate-200 text-center whitespace-nowrap">
                  {i.files?.length ? (
                    canOpen ? (
                      <button
                        type="button"
                        onClick={(e) => {
                          e.stopPropagation();
                          setViewing(all.findIndex((x) => x.f.id === i.files![0].id));
                        }}
                        aria-label={`Open the receipt of ${i.category_name} on ${formatDate(i.bill_date)}`}
                        className="inline-flex items-center gap-0.5 rounded-full bg-emerald-50 text-emerald-700 px-1.5 py-px font-semibold hover:bg-emerald-100"
                      >
                        <Paperclip className="w-3 h-3" /> {i.files.length}
                      </button>
                    ) : (
                      <span className="inline-flex items-center gap-0.5 text-emerald-700 font-semibold">
                        <Paperclip className="w-3 h-3" /> {i.files.length}
                      </span>
                    )
                  ) : (
                    <span className="text-slate-300">—</span>
                  )}
                </td>
              )}
            </tr>
          ))}
        </tbody>
        {items.length > 1 && (
          <tfoot>
            <tr className="font-semibold text-slate-800">
              <td colSpan={compact ? 2 : 3} className="px-2 py-1 border border-slate-200">
                Bills total
              </td>
              <td className="px-2 py-1 border border-slate-200 text-right tabular-nums">{money(total)}</td>
              {showReceipts && <td className="border border-slate-200" />}
            </tr>
          </tfoot>
        )}
      </table>
      {cur && canOpen && (
        <AttachmentViewer
          token={token!}
          src={fileSrc!(cur.f.id)}
          type={cur.f.file_mimetype}
          name={`${cur.label} — ${cur.f.file_name}`}
          nav={
            all.length > 1
              ? {
                  index: viewing!,
                  count: all.length,
                  onPrev: () => setViewing((v) => Math.max(0, (v ?? 0) - 1)),
                  onNext: () => setViewing((v) => Math.min(all.length - 1, (v ?? 0) + 1))
                }
              : undefined
          }
          onClose={() => setViewing(null)}
        />
      )}
    </div>
  );
};
