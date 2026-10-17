/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Approved By" on the Conveyance Bill and Payment Voucher PDFs: each approving
// Layer's approver with the signature kept when they approved (GET
// /api/conveyance-bills/:id/approver-signatures; off in the Bill Claim Policy ->
// enabled:false -> the PDFs keep their plain "Approved By" line).

import type jsPDF from 'jspdf';
import { apiUrl } from './api';
import { formatDate } from './formatDate';

export interface BillApprover {
  step_order: number;
  label: string;
  approver_id: number;
  approver_name: string | null;
  approved_at: string | null;
  image: string | null;
}

export async function loadBillApprovers(token: string, billId: number): Promise<BillApprover[]> {
  try {
    const res = await fetch(apiUrl(`/api/conveyance-bills/${billId}/approver-signatures`), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return [];
    const data = await res.json();
    return data?.enabled && Array.isArray(data.approvers) ? data.approvers : [];
  } catch {
    return [];
  }
}

// Draws the approvers in columns (up to `perRow` a row) from `x0` to `x1`,
// starting at `y`; returns the y below the block. The signature sits on the
// line; under it the name, the Layer and the date.
export function drawApproverBlock(doc: jsPDF, approvers: BillApprover[], y: number, x0: number, x1: number, opts: { perRow?: number; title?: string } = {}): number {
  if (!approvers.length) return y;
  const perRow = Math.min(opts.perRow || 3, approvers.length);
  const gap = 8;
  const colW = (x1 - x0 - gap * (perRow - 1)) / perRow;
  const pageH = doc.internal.pageSize.getHeight();
  const rowH = 36;
  let top = y;
  if (opts.title) {
    if (top + 8 + rowH > pageH - 16) {
      doc.addPage();
      top = 20;
    }
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(8.5);
    doc.setTextColor(15, 23, 42);
    doc.text(opts.title, x0, top);
    top += 5;
  }
  approvers.forEach((a, i) => {
    const col = i % perRow;
    if (i > 0 && col === 0) top += rowH;
    if (top + rowH > pageH - 16) {
      doc.addPage();
      top = 20;
    }
    const x = x0 + col * (colW + gap);
    const lineY = top + 17;
    if (a.image) {
      try {
        const props = doc.getImageProperties(a.image);
        const sc = Math.min((colW - 4) / props.width, 15 / props.height);
        doc.addImage(a.image, 'PNG', x + 1, lineY - 1 - props.height * sc, props.width * sc, props.height * sc);
      } catch {
        // an unreadable image: the line and the name still print
      }
    }
    doc.setDrawColor(148, 163, 184);
    doc.setLineWidth(0.2);
    doc.line(x, lineY, x + colW, lineY);
    doc.setFont('helvetica', 'bold');
    doc.setFontSize(7.5);
    doc.setTextColor(30, 41, 59);
    doc.text(doc.splitTextToSize(a.approver_name || '—', colW)[0], x, lineY + 4);
    doc.setFont('helvetica', 'normal');
    doc.setFontSize(6.8);
    doc.setTextColor(71, 85, 105);
    doc.text(`${a.label}${a.approved_at ? ' · ' + (formatDate(String(a.approved_at).slice(0, 10)) || '') : ''}`, x, lineY + 8, { maxWidth: colW });
    if (!a.image) doc.text('(no signature on file)', x, lineY + 11.5, { maxWidth: colW });
  });
  return top + rowH;
}
