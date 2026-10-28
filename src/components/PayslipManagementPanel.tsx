/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll -> Payslips — "পে-স্লিপ পেজ".
//
// Three things live here, all scoped to one selected month's payroll runs
// (GET /api/payroll?month_year=...):
//   * Bulk Payslip Generator — one PDF, one page per employee, built
//     client-side with the same jsPDF + letterhead helpers PayrollModule.tsx
//     already uses for a single payslip.
//   * Individual Payslip View & Print / Download — View opens the PDF in a
//     new tab (the browser's own viewer gives Print/Save for free);
//     Download saves it straight to disk via savePdfCrossPlatform.
//   * Email Payslips — per-employee and "Email All" buttons: each employee
//     gets an email with their payslip PDF (the same file as the PDF
//     button) attached, via POST /api/payroll/:id/email.
//   * Pick several people (tick boxes, search, Select all shown): the two
//     bulk buttons then work on just them — "Email Selected (N)" /
//     "PDF of Selected (N)". Nothing ticked = everyone, as before.

import React, { useEffect, useMemo, useState } from 'react';
import jsPDF from '../lib/jspdf';
import {
  ReceiptText,
  FileDown,
  Eye,
  Mail,
  RefreshCw,
  AlertTriangle,
  CheckCircle2,
  Layers,
  Search
} from 'lucide-react';
import { apiUrl } from '../lib/api';
import { buildSinglePayslip, drawPayslipPage, loadPayslipLogo, money, monthLabel, type PayrollRecord } from '../lib/payslipPdf';
import { Spinner } from './Spinner';
import { finalizePdfPageNumbers } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import { LoadingBlock } from './LoadingBlock';
import { confirmDialog } from '../lib/confirmDialog';

interface PayslipManagementPanelProps {
  token: string;
}

const currentMonthYear = () => new Date().toISOString().slice(0, 7);

export const PayslipManagementPanel: React.FC<PayslipManagementPanelProps> = ({ token }) => {
  const authHeaders = useMemo(() => ({ Authorization: `Bearer ${token}` }), [token]);

  const [monthYear, setMonthYear] = useState(currentMonthYear());
  const [records, setRecords] = useState<PayrollRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');

  const [busyId, setBusyId] = useState<number | null>(null);
  const [bulkBusy, setBulkBusy] = useState<'pdf' | 'email' | null>(null);
  const [notice, setNotice] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  // Who the bulk buttons are for: the ticked people, or everyone when none is.
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [query, setQuery] = useState('');
  const shown = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return records;
    return records.filter((r) => [r.employee_name, r.employee_code, r.department].some((v) => String(v || '').toLowerCase().includes(q)));
  }, [records, query]);
  const picked = useMemo(() => records.filter((r) => selected.has(r.id)), [records, selected]);
  const targets = picked.length ? picked : records;
  const allShownPicked = shown.length > 0 && shown.every((r) => selected.has(r.id));
  const someShownPicked = shown.some((r) => selected.has(r.id));
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const toggleShown = () =>
    setSelected((prev) => {
      const next = new Set(prev);
      for (const r of shown) {
        if (allShownPicked) next.delete(r.id);
        else next.add(r.id);
      }
      return next;
    });

  const fetchRecords = async () => {
    setLoading(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/payroll?month_year=${monthYear}`), { headers: authHeaders });
      if (!res.ok) {
        setError(res.status === 403 ? "You don't have access to Payroll." : 'Failed to load payroll records for this month.');
        return;
      }
      setRecords(await res.json());
    } catch {
      setError('Failed to load payroll records for this month.');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchRecords();
    setNotice(null);
    setSelected(new Set());
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [monthYear]);

  // ---- Individual: View (new tab) / Download -----------------------------
  const viewPayslip = async (record: PayrollRecord) => {
    setBusyId(record.id);
    try {
      const doc = await buildSinglePayslip(record);
      const url = doc.output('bloburl');
      window.open(url as unknown as string, '_blank');
    } finally {
      setBusyId(null);
    }
  };

  const downloadPayslip = async (record: PayrollRecord) => {
    setBusyId(record.id);
    try {
      const doc = await buildSinglePayslip(record);
      await savePdfCrossPlatform(doc, `Payslip_${record.employee_name.replace(/\s+/g, '_')}_${record.month_year}.pdf`);
    } finally {
      setBusyId(null);
    }
  };

  // ---- Bulk: one PDF, one page per employee -------------------------------
  const generateBulkPayslips = async () => {
    const list = targets;
    if (list.length === 0) return;
    setBulkBusy('pdf');
    setNotice(null);
    try {
      const logoImg = await loadPayslipLogo();
      const doc = new jsPDF();
      list.forEach((record, i) => {
        if (i > 0) doc.addPage();
        drawPayslipPage(doc, logoImg, record);
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, picked.length ? `Payslips_${monthYear}_selected.pdf` : `Payslips_${monthYear}.pdf`);
      setNotice({ type: 'success', text: `Generated ${list.length} payslip${list.length === 1 ? '' : 's'} in one PDF.` });
    } catch {
      setNotice({ type: 'error', text: 'Failed to generate the bulk payslip PDF.' });
    } finally {
      setBulkBusy(null);
    }
  };

  // ---- Email: per-employee and "Email All" --------------------------------
  // The same PDF as the PDF button, built here and attached by the server.
  const sendPayslipEmail = async (record: PayrollRecord) => {
    const doc = await buildSinglePayslip(record);
    const pdf_base64 = String(doc.output('datauristring')).split(',')[1] || '';
    return fetch(apiUrl(`/api/payroll/${record.id}/email`), {
      method: 'POST',
      headers: { ...authHeaders, 'Content-Type': 'application/json' },
      body: JSON.stringify({ pdf_base64 })
    });
  };
  const emailPayslip = async (record: PayrollRecord) => {
    setBusyId(record.id);
    setNotice(null);
    try {
      const res = await sendPayslipEmail(record);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setNotice({ type: 'error', text: data.error || `Couldn't email ${record.employee_name}'s payslip — email sending isn't set up on the server yet.` });
        return;
      }
      setNotice({ type: 'success', text: `Payslip emailed to ${record.employee_name} with the PDF attached.` });
    } catch {
      setNotice({ type: 'error', text: `Couldn't email ${record.employee_name}'s payslip — email sending isn't set up on the server yet.` });
    } finally {
      setBusyId(null);
    }
  };

  // One email per employee (the ticked ones, or everyone), each with their
  // own payslip PDF attached.
  const emailAllPayslips = async () => {
    const list = targets;
    if (list.length === 0) return;
    const who = picked.length ? `the ${list.length} selected employee${list.length === 1 ? '' : 's'}` : `all ${list.length} employee${list.length === 1 ? '' : 's'}`;
    if (!(await confirmDialog(`Email ${monthLabel(monthYear)} payslips to ${who}? Each gets their own payslip PDF.`, { title: 'Email payslips', confirmLabel: `Email ${list.length}` }))) return;
    setBulkBusy('email');
    setNotice(null);
    try {
      let sent = 0;
      const failed: string[] = [];
      for (const [i, record] of list.entries()) {
        setNotice({ type: 'success', text: `Emailing ${i + 1} of ${list.length}…` });
        const res = await sendPayslipEmail(record);
        const data = await res.json().catch(() => ({}));
        if (res.ok) sent++;
        else {
          failed.push(`${record.employee_name}: ${data.error || 'failed'}`);
          // Email not set up at all: stop instead of failing every one.
          if (/isn't set up/i.test(String(data.error || ''))) break;
        }
      }
      setNotice({
        type: failed.length && !sent ? 'error' : 'success',
        text: `Emailed ${sent} of ${list.length} payslip${list.length === 1 ? '' : 's'} with the PDF attached.${failed.length ? ` Not sent — ${failed.slice(0, 5).join('; ')}${failed.length > 5 ? ` and ${failed.length - 5} more` : ''}.` : ''}`
      });
    } catch {
      setNotice({ type: 'error', text: "Couldn't email payslips — email sending isn't set up on the server yet." });
    } finally {
      setBulkBusy(null);
    }
  };

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <ReceiptText className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h2 className="text-sm font-semibold text-slate-800">Payslips — {monthLabel(monthYear)}</h2>
            <p className="text-[11px] text-slate-500 mt-0.5 max-w-md">
              Generate, view, download, or email payslips for this month's processed payroll runs.
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <input
            type="month"
            value={monthYear}
            onChange={(e) => setMonthYear(e.target.value)}
            className="px-2.5 py-1.5 text-sm border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
          />
          <button
            onClick={fetchRecords}
            className="w-9 h-9 flex items-center justify-center rounded-lg border border-slate-200 text-slate-500 hover:text-blue-600 hover:border-blue-200 transition-colors shrink-0"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Bulk actions */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 p-4">
        <div className="flex items-center justify-between gap-2 flex-wrap mb-3">
          <h3 className="text-sm font-semibold text-slate-700">Bulk Actions</h3>
          <p className="text-[11px] text-slate-500">
            {picked.length ? (
              <>
                For the <b className="text-slate-700">{picked.length} selected</b> ·{' '}
                <button type="button" onClick={() => setSelected(new Set())} className="font-semibold text-blue-600 hover:underline">
                  Clear selection
                </button>
              </>
            ) : (
              'For everyone this month — tick people in the list below to send to just them.'
            )}
          </p>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <button
            onClick={generateBulkPayslips}
            disabled={records.length === 0 || bulkBusy !== null}
            className="flex items-center gap-2 px-4 py-3 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl transition-all justify-center disabled:opacity-50"
          >
            {bulkBusy === 'pdf' ? <Spinner size={16} /> : <Layers className="w-4 h-4" />}{' '}
            {picked.length ? `PDF of Selected (${picked.length})` : 'Generate All Payslips (PDF)'}
          </button>
          <button
            onClick={emailAllPayslips}
            disabled={records.length === 0 || bulkBusy !== null}
            className="flex items-center gap-2 px-4 py-3 bg-slate-100 hover:bg-slate-200 text-slate-700 text-sm font-semibold rounded-xl transition-all justify-center disabled:opacity-50"
          >
            {bulkBusy === 'email' ? <Spinner size={16} /> : <Mail className="w-4 h-4" />}{' '}
            {picked.length ? `Email Selected (${picked.length})` : 'Email All Payslips'}
          </button>
        </div>
      </div>

      {notice && (
        <p
          className={`text-xs rounded-lg px-3 py-2 flex items-center gap-1.5 ${
            notice.type === 'success' ? 'text-emerald-700 bg-emerald-50 border border-emerald-100' : 'text-rose-600 bg-rose-50 border border-rose-100'
          }`}
        >
          {notice.type === 'success' ? <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> : <AlertTriangle className="w-3.5 h-3.5 shrink-0" />}
          {notice.text}
        </p>
      )}

      {/* Individual list */}
      <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
        {loading ? (
          <LoadingBlock />
        ) : error ? (
          <p className="text-xs text-rose-600 text-center py-16">{error}</p>
        ) : records.length === 0 ? (
          <div className="text-center py-16">
            <AlertTriangle className="w-6 h-6 text-amber-400 mx-auto mb-2" />
            <p className="text-xs text-slate-400">No payroll runs generated for {monthLabel(monthYear)} yet — use "Run Payroll" first.</p>
          </div>
        ) : (
          <>
          <div className="flex items-center gap-3 px-4 py-2.5 border-b border-slate-100 bg-slate-50/60 flex-wrap">
            <label className="flex items-center gap-2 text-xs font-semibold text-slate-600 cursor-pointer">
              <input
                type="checkbox"
                checked={allShownPicked}
                ref={(el) => {
                  if (el) el.indeterminate = !allShownPicked && someShownPicked;
                }}
                onChange={toggleShown}
                className="w-4 h-4 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
              />
              {query.trim() ? `Select all shown (${shown.length})` : `Select all (${records.length})`}
            </label>
            <div className="relative flex-1 min-w-[180px] sm:max-w-xs ml-auto">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input
                type="search"
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder="Find by name, ID or department"
                aria-label="Find employee"
                className="w-full pl-8 pr-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-400"
              />
            </div>
          </div>
          {shown.length === 0 && <p className="text-xs text-slate-400 text-center py-10">No one matches "{query.trim()}".</p>}
          <ul className="divide-y divide-slate-100">
            {shown.map((r) => (
              <li key={r.id} className={`flex items-center justify-between px-4 py-2.5 gap-3 ${selected.has(r.id) ? 'bg-blue-50/50' : ''}`}>
                <label className="flex items-center gap-3 min-w-0 cursor-pointer">
                  <input
                    type="checkbox"
                    checked={selected.has(r.id)}
                    onChange={() => toggle(r.id)}
                    aria-label={`Select ${r.employee_name}`}
                    className="w-4 h-4 shrink-0 rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                  />
                  <span className="min-w-0">
                    <span className="block text-sm font-medium text-slate-800 truncate">{r.employee_name}</span>
                    <span className="block text-[11px] text-slate-400">
                      {r.employee_code ? `${r.employee_code} · ` : ''}
                      {r.department || '—'} &middot; Net {money(r.net_salary)}
                    </span>
                  </span>
                </label>
                <div className="flex items-center gap-1.5 shrink-0">
                  <button
                    onClick={() => viewPayslip(r)}
                    disabled={busyId === r.id}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-slate-50 hover:bg-slate-100 text-slate-600 text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
                    title="View / Print"
                  >
                    {busyId === r.id ? <Spinner size={14} /> : <Eye className="w-3.5 h-3.5" />} View
                  </button>
                  <button
                    onClick={() => downloadPayslip(r)}
                    disabled={busyId === r.id}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-blue-50 hover:bg-blue-100 text-blue-700 text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
                  >
                    {busyId === r.id ? <Spinner size={14} /> : <FileDown className="w-3.5 h-3.5" />} PDF
                  </button>
                  <button
                    onClick={() => emailPayslip(r)}
                    disabled={busyId === r.id}
                    className="flex items-center gap-1.5 px-2.5 py-1.5 bg-emerald-50 hover:bg-emerald-100 text-emerald-700 text-xs font-semibold rounded-lg transition-all disabled:opacity-50"
                  >
                    {busyId === r.id ? <Spinner size={14} /> : <Mail className="w-3.5 h-3.5" />} Email
                  </button>
                </div>
              </li>
            ))}
          </ul>
          </>
        )}
      </div>
    </div>
  );
};
