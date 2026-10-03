/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Month-end Tracking Notice Report — everyone sent a "you're not tracked"
// notice from Employee Tracking -> Currently Not Tracked in the chosen month:
// how many times, when, why they weren't tracked then, and whether they
// opened it. Previewed on screen, downloadable as PDF or Excel. Needs the
// 'tracking' module (GET /api/tracking/notice-report refuses otherwise).

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { ChevronDown, ChevronRight, FileDown, FileSpreadsheet, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';

interface Send {
  notice_id: number;
  title: string;
  sent_at: string;
  reason: string | null;
  sent_by: string | null;
  seen_at: string | null;
}
interface Row {
  user_id: number;
  employee_id: string;
  name: string;
  designation: string;
  department: string;
  notices: number;
  seen: number;
  sends: Send[];
}
interface Report {
  month: string;
  total_notices: number;
  total_sends: number;
  employees: Row[];
}

const thisMonth = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
};
const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};
const dateTime = (v: string | null) => {
  if (!v) return '—';
  const d = new Date(String(v).replace(' ', 'T'));
  if (isNaN(d.getTime())) return String(v);
  return `${formatDate(String(v))}, ${d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' })}`;
};

export const TrackingNoticeReport: React.FC<{ token: string; onClose: () => void }> = ({ token, onClose }) => {
  const [month, setMonth] = useState(thisMonth());
  const [report, setReport] = useState<Report | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [exporting, setExporting] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/tracking/notice-report?month=${month}`), { headers: { Authorization: `Bearer ${token}` } });
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(body.error || 'Could not load the report.');
      setReport(body);
    } catch (err: any) {
      setError(err.message);
      setReport(null);
    } finally {
      setLoading(false);
    }
  }, [month, token]);

  useEffect(() => {
    load();
  }, [load]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const downloadPdf = async () => {
    if (!report) return;
    setExporting(true);
    try {
      const logoImg = await loadImageElement(credenceLogo);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const opts = {
        reportTitle: 'Employee Tracking — Not Tracked Notice Report',
        filters: [
          ['Month', monthLabel(report.month)],
          ['Employees notified', String(report.employees.length)],
          ['Notices sent', String(report.total_notices)],
          ['Total deliveries', String(report.total_sends)]
        ] as [string, string][]
      };
      const startY = drawPdfLetterhead(doc, logoImg, opts);
      autoTable(doc, {
        startY,
        margin: { top: startY, left: 8, right: 8 },
        head: [['SL', 'Employee', 'Department', 'Notices', 'Opened', 'Sent on (reason)']],
        body: report.employees.map((r, i) => [
          String(i + 1),
          `${r.name}${r.employee_id ? `\n${r.employee_id}` : ''}${r.designation ? ` · ${r.designation}` : ''}`,
          r.department,
          String(r.notices),
          `${r.seen} of ${r.notices}`,
          r.sends.map((s) => `${dateTime(s.sent_at)} — ${s.reason || '—'}${s.seen_at ? ' (opened)' : ''}`).join('\n')
        ]),
        styles: { fontSize: 8, cellPadding: 1.5, overflow: 'linebreak', valign: 'top' },
        headStyles: { fillColor: [37, 99, 235], textColor: 255, fontSize: 8 },
        columnStyles: { 0: { cellWidth: 10 }, 1: { cellWidth: 55 }, 2: { cellWidth: 35 }, 3: { cellWidth: 18 }, 4: { cellWidth: 20 } },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        didDrawPage: () => {
          drawPdfLetterhead(doc, logoImg, opts);
        }
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `Tracking-Notice-Report-${report.month}.pdf`);
    } catch (err: any) {
      setError(err.message || 'Could not make the PDF.');
    } finally {
      setExporting(false);
    }
  };

  const downloadExcel = () => {
    if (!report) return;
    const summary = report.employees.map((r, i) => ({
      SL: i + 1,
      'Employee ID': r.employee_id,
      Name: r.name,
      Designation: r.designation,
      Department: r.department,
      'Notices sent': r.notices,
      Opened: r.seen
    }));
    const details = report.employees.flatMap((r) =>
      r.sends.map((s) => ({
        'Employee ID': r.employee_id,
        Name: r.name,
        Department: r.department,
        'Sent at': dateTime(s.sent_at),
        Reason: s.reason || '',
        Title: s.title,
        'Sent by': s.sent_by || '',
        'Opened at': s.seen_at ? dateTime(s.seen_at) : ''
      }))
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary.length ? summary : [{ Note: 'No notices this month' }]), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(details.length ? details : [{ Note: 'No notices this month' }]), 'Details');
    XLSX.writeFile(wb, `Tracking-Notice-Report-${report.month}.xlsx`);
  };

  return createPortal(
    <div className="fixed inset-0 z-[1100] flex items-center justify-center bg-slate-900/40 backdrop-blur-sm p-3 sm:p-6" onClick={onClose}>
      <div
        role="dialog"
        aria-label="Not Tracked Notice Report"
        className="bg-white rounded-2xl shadow-xl border border-slate-200 w-full max-w-4xl max-h-[92vh] flex flex-col overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex flex-wrap items-start justify-between gap-3 px-5 py-4 border-b border-slate-100 shrink-0">
          <div>
            <h3 className="text-sm font-bold text-slate-900">Not Tracked Notice Report</h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Notices sent from Employee Tracking → Currently Not Tracked
              {report ? ` · ${report.employees.length} employee${report.employees.length === 1 ? '' : 's'}, ${report.total_notices} notice${report.total_notices === 1 ? '' : 's'}` : ''}
            </p>
          </div>
          <div className="flex items-center gap-2">
            <input
              type="month"
              value={month}
              onChange={(e) => e.target.value && setMonth(e.target.value)}
              className="text-xs border border-slate-200 rounded-lg px-2 py-1.5"
              aria-label="Month"
            />
            <button
              type="button"
              onClick={downloadExcel}
              disabled={!report}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-700 hover:bg-slate-50 disabled:opacity-40"
            >
              <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
            </button>
            <button
              type="button"
              onClick={downloadPdf}
              disabled={!report || exporting}
              className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded-lg bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-40"
            >
              <FileDown className="w-3.5 h-3.5" /> {exporting ? 'Preparing…' : 'PDF'}
            </button>
            <button type="button" onClick={onClose} className="w-8 h-8 rounded-full flex items-center justify-center text-slate-400 hover:bg-slate-100" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>
        <div className="overflow-auto">
          {loading && <p className="text-xs text-slate-400 text-center py-8">Loading…</p>}
          {!loading && error && <p className="text-xs text-rose-600 text-center py-8">{error}</p>}
          {!loading && report && report.employees.length === 0 && (
            <p className="text-xs text-slate-400 text-center py-8">No not-tracked notices were sent in {monthLabel(report.month)}.</p>
          )}
          {!loading && report && report.employees.length > 0 && (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-blue-600 text-white">
                <tr className="text-left">
                  <th className="px-3 py-2 font-semibold w-10">SL</th>
                  <th className="px-3 py-2 font-semibold">Employee</th>
                  <th className="px-3 py-2 font-semibold">Department</th>
                  <th className="px-3 py-2 font-semibold text-center">Notices</th>
                  <th className="px-3 py-2 font-semibold text-center">Opened</th>
                  <th className="px-3 py-2 font-semibold">Last sent</th>
                </tr>
              </thead>
              <tbody>
                {report.employees.map((r, i) => {
                  const isOpen = expanded.has(r.user_id);
                  return (
                    <React.Fragment key={r.user_id}>
                      <tr
                        className="border-b border-slate-100 hover:bg-slate-50 cursor-pointer"
                        onClick={() =>
                          setExpanded((prev) => {
                            const next = new Set(prev);
                            next.has(r.user_id) ? next.delete(r.user_id) : next.add(r.user_id);
                            return next;
                          })
                        }
                      >
                        <td className="px-3 py-2 text-slate-500">{i + 1}</td>
                        <td className="px-3 py-2">
                          <span className="flex items-center gap-1.5">
                            {isOpen ? <ChevronDown className="w-3.5 h-3.5 text-slate-400" /> : <ChevronRight className="w-3.5 h-3.5 text-slate-400" />}
                            <span>
                              <span className="font-semibold text-slate-800">{r.name}</span>
                              <span className="block text-[10px] text-slate-400">{[r.employee_id, r.designation].filter(Boolean).join(' · ') || '—'}</span>
                            </span>
                          </span>
                        </td>
                        <td className="px-3 py-2 text-slate-600">{r.department}</td>
                        <td className="px-3 py-2 text-center font-bold text-slate-900">{r.notices}</td>
                        <td className="px-3 py-2 text-center text-slate-600">
                          {r.seen} of {r.notices}
                        </td>
                        <td className="px-3 py-2 text-slate-600 whitespace-nowrap">{dateTime(r.sends[r.sends.length - 1]?.sent_at || null)}</td>
                      </tr>
                      {isOpen &&
                        r.sends.map((s, k) => (
                          <tr key={`${r.user_id}-${k}`} className="bg-slate-50/70 border-b border-slate-100 text-[11px]">
                            <td />
                            <td className="px-3 py-1.5 text-slate-700" colSpan={2}>
                              {dateTime(s.sent_at)} · <span className="text-slate-500">{s.reason || '—'}</span>
                            </td>
                            <td className="px-3 py-1.5 text-slate-500" colSpan={2}>
                              {s.title}
                              {s.sent_by ? ` · by ${s.sent_by}` : ''}
                            </td>
                            <td className={`px-3 py-1.5 ${s.seen_at ? 'text-emerald-600' : 'text-slate-400'}`}>{s.seen_at ? `Opened ${dateTime(s.seen_at)}` : 'Not opened yet'}</td>
                          </tr>
                        ))}
                    </React.Fragment>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
