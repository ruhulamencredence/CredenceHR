/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Receipt } from 'lucide-react';
import { UserClaimItem } from '../types';
import { formatDate } from '../lib/formatDate';

const money = (n: number) => `৳${Number(n).toLocaleString('en-BD', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

// The bills inside a Conveyance Bill Claim (category / date / amount), shown
// wherever the claim is looked at — the claimant's own detail view, the Admin's
// Bill Claim review and the approvers' screens. Category names are the ones
// the bills were filed under.
export const ClaimBillLines: React.FC<{ items?: UserClaimItem[] | null; compact?: boolean }> = ({ items, compact }) => {
  if (!items || items.length === 0) return null;
  const total = items.reduce((s, i) => s + Number(i.amount), 0);
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
            </tr>
          </tfoot>
        )}
      </table>
    </div>
  );
};
