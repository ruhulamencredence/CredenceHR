/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Service Book building blocks — the timeline of one Employee's record from
// the joining date (every transfer, promotion, increment, confirmation,
// letter, disciplinary action and resignation in date order) and its PDF.
// Used by HR Operations -> Service Book (Employee 360, HrOps360.tsx) and by
// Self Service -> My Letters & Service Record.

import React from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { UserPlus, TrendingUp, ArrowLeftRight, BadgeCheck, Banknote, FileText, Gavel, LogOut, Award, Circle } from 'lucide-react';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';
import { Badge, fmtDate } from './HrOpsShared';

export interface ServiceEvent {
  date: string | null;
  kind: string;
  title: string;
  detail: string | null;
  status?: string;
  applied?: boolean;
  reason?: string | null;
  approved_by?: string[];
  acknowledged?: boolean;
}
export interface ServiceBookData {
  employee: {
    id: number;
    name: string;
    employee_code: string | null;
    designation: string | null;
    department: string | null;
    branch: string | null;
    grade: string | null;
    supervisor: string | null;
    project: string | null;
    joining_date: string | null;
    job_base: string | null;
    is_active: boolean;
    gross_salary: number | null;
    probation_end_date: string | null;
    confirmation_date: string | null;
    service_length_months: number | null;
  } | null;
  events: ServiceEvent[];
}

export const EVENT_STYLE: Record<string, { icon: React.ComponentType<{ className?: string }>; tint: string }> = {
  joining: { icon: UserPlus, tint: 'bg-emerald-100 text-emerald-700' },
  promotion: { icon: Award, tint: 'bg-violet-100 text-violet-700' },
  increment: { icon: TrendingUp, tint: 'bg-amber-100 text-amber-700' },
  salary_adjustment: { icon: TrendingUp, tint: 'bg-amber-100 text-amber-700' },
  salary: { icon: Banknote, tint: 'bg-amber-50 text-amber-600' },
  transfer: { icon: ArrowLeftRight, tint: 'bg-sky-100 text-sky-700' },
  designation_change: { icon: ArrowLeftRight, tint: 'bg-sky-50 text-sky-600' },
  confirmation: { icon: BadgeCheck, tint: 'bg-teal-100 text-teal-700' },
  letter: { icon: FileText, tint: 'bg-slate-100 text-slate-600' },
  disciplinary: { icon: Gavel, tint: 'bg-rose-100 text-rose-700' },
  exit: { icon: LogOut, tint: 'bg-rose-50 text-rose-600' },
  resignation: { icon: LogOut, tint: 'bg-rose-100 text-rose-700' },
  termination: { icon: LogOut, tint: 'bg-rose-100 text-rose-700' },
  retirement: { icon: LogOut, tint: 'bg-rose-100 text-rose-700' }
};

export const serviceLength = (months: number | null) => {
  if (months === null || months < 0) return '—';
  const y = Math.floor(months / 12);
  const m = months % 12;
  return [y ? `${y} yr${y > 1 ? 's' : ''}` : '', m ? `${m} mo` : '', !y && !m ? 'Less than a month' : ''].filter(Boolean).join(' ');
};

// Shared timeline (also used by Self Service -> My Letters & Service Record).
export const ServiceTimeline: React.FC<{ events: ServiceEvent[] }> = ({ events }) =>
  events.length === 0 ? (
    <p className="text-sm text-slate-400 text-center py-10">No records yet.</p>
  ) : (
    <ol className="relative border-l-2 border-slate-100 ml-3.5 space-y-4">
      {[...events].reverse().map((ev, i) => {
        const st = EVENT_STYLE[ev.kind] || { icon: Circle, tint: 'bg-slate-100 text-slate-500' };
        return (
          <li key={i} className="ml-6">
            <span className={`absolute -left-[15px] w-7 h-7 rounded-full flex items-center justify-center ring-4 ring-white ${st.tint}`}>
              <st.icon className="w-3.5 h-3.5" />
            </span>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs font-bold text-slate-800">{ev.title}</span>
              <span className="text-[11px] text-slate-400">{fmtDate(ev.date)}</span>
              {ev.status === 'pending' && <Badge tone="pending">Pending approval</Badge>}
              {ev.status === 'rejected' && <Badge tone="rejected">Rejected</Badge>}
              {ev.status === 'approved' && ev.applied === false && <Badge tone="pending">Takes effect {fmtDate(ev.date)}</Badge>}
              {ev.kind === 'letter' && (ev.acknowledged ? <Badge tone="approved">Acknowledged</Badge> : null)}
            </div>
            {ev.detail && <p className="text-xs text-slate-600 mt-0.5">{ev.detail}</p>}
            {ev.reason && <p className="text-[11px] text-slate-400 mt-0.5">{ev.reason}</p>}
            {ev.approved_by && ev.approved_by.length > 0 && <p className="text-[11px] text-emerald-700 mt-0.5">Approved by {ev.approved_by.join(' → ')}</p>}
          </li>
        );
      })}
    </ol>
  );

export async function saveServiceBookPdf(data: ServiceBookData) {
  if (!data.employee) return;
  const e = data.employee;
  const logo = await loadImageElement(credenceLogo);
  const doc = new jsPDF();
  const y = drawPdfLetterhead(doc, logo, {
    reportTitle: 'Employee Service Book',
    filtersLabel: 'Employee Details:',
    filters: [
      ['Name', e.name],
      ['Employee ID', e.employee_code || '—'],
      ['Designation', e.designation || '—'],
      ['Department', e.department || '—'],
      ['Grade', e.grade || '—'],
      ['Branch', e.branch || '—'],
      ['Joining Date', fmtDate(e.joining_date)],
      ['Service Length', serviceLength(e.service_length_months)],
      ['Confirmation', fmtDate(e.confirmation_date)],
      ['Current Gross', e.gross_salary != null ? `BDT ${Number(e.gross_salary).toLocaleString('en-IN')}` : '—']
    ]
  });
  autoTable(doc, {
    startY: y,
    head: [['Date', 'Event', 'Details', 'Status / Approved by']],
    body: data.events.map((ev) => [
      fmtDate(ev.date),
      ev.title,
      // Helvetica has no arrow glyph.
      [ev.detail, ev.reason].filter(Boolean).join('\n').replace(/→/g, '->'),
      ev.status === 'pending' ? 'Pending' : ev.approved_by?.length ? ev.approved_by.join(' -> ') : ev.kind === 'letter' ? (ev.acknowledged ? 'Acknowledged' : 'Issued') : ''
    ]),
    styles: { fontSize: 8, cellPadding: 2 },
    columnStyles: { 0: { cellWidth: 24 }, 1: { cellWidth: 36 }, 3: { cellWidth: 40 } },
    headStyles: { fillColor: [124, 58, 237] }
  });
  finalizePdfPageNumbers(doc);
  await savePdfCrossPlatform(doc, `Service_Book_${e.name.replace(/\s+/g, '_')}.pdf`);
}
