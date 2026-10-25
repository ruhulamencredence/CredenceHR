/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> PEPM Management -> Reports -> P.O Import (Reports layer
// "po_import"; server PoImportRoutes.ts). Upload the ERP's purchase-order
// export: each line is matched to the MPR row with the same project, MPR /
// MRF No, material and specification (Brand Name). The page shows what
// matched and why the rest didn't, then saves the matched P.O numbers onto
// their MPR rows (shown on the MPR Entries report and Dispatch Material).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import { FileSpreadsheet, Upload, RefreshCw, Loader2, CheckCircle2, History, X } from 'lucide-react';
import { formatDate } from '../lib/formatDate';
import { readPoSheet, type PoSheetLine } from '../lib/poSheet';
import { mdFetch } from './MprDispatchShared';

type Status = 'matched' | 'mpr_not_found' | 'material_not_found' | 'project_differs' | 'spec_differs' | 'no_po';
interface Result extends Omit<PoSheetLine, 'orderQty' | 'appQty' | 'rate' | 'amount' | 'receivedQty'> {
  orderQty: number | null;
  rate: number | null;
  amount: number | null;
  status: Status;
  note: string;
  entries: { id: number; project: string; mprNo: string; item: string; spec: string; qty: number | null; unit: string; already: boolean }[];
}
interface ImportRow {
  id: number;
  file_name: string | null;
  total_lines: number;
  matched_lines: number;
  new_pos: number;
  updated_pos: number;
  unmatched_lines: number;
  created_by_name: string | null;
  created_at: string;
}

const STATUS: Record<Status, { label: string; cls: string; hint: string }> = {
  matched: { label: 'Matched', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', hint: 'Project, MPR No, material and specification match an MPR row.' },
  spec_differs: { label: 'Different specification', cls: 'bg-rose-50 text-rose-700 border-rose-200', hint: "Same MPR and material, but the sheet's Brand Name isn't the MPR row's Specification." },
  project_differs: { label: 'Different project', cls: 'bg-amber-50 text-amber-800 border-amber-200', hint: 'This MPR No and material are under another project in PEPM.' },
  material_not_found: { label: 'Material not in this MPR', cls: 'bg-amber-50 text-amber-800 border-amber-200', hint: "The MPR No is in PEPM but has no row for this material." },
  mpr_not_found: { label: 'MPR not in PEPM', cls: 'bg-slate-100 text-slate-600 border-slate-200', hint: 'No MPR row with this MPR / MRF No has been entered in PEPM.' },
  no_po: { label: 'No P.O No', cls: 'bg-slate-100 text-slate-600 border-slate-200', hint: 'The line has no Order No.' }
};
const ORDER: Status[] = ['matched', 'spec_differs', 'project_differs', 'material_not_found', 'mpr_not_found', 'no_po'];
const money = (n: number | null) => (n === null || n === undefined ? '' : n.toLocaleString('en-IN', { maximumFractionDigits: 2 }));
const PAGE = 150;

// onImported: the MPR Entries report reloads its rows (their P.O numbers).
export const MprPoImport: React.FC<{ token: string; onImported?: () => void }> = ({ token, onImported }) => {
  const fileRef = useRef<HTMLInputElement>(null);
  const [fileName, setFileName] = useState('');
  const [lines, setLines] = useState<PoSheetLine[] | null>(null);
  const [chargeLines, setChargeLines] = useState(0);
  const [results, setResults] = useState<Result[] | null>(null);
  const [filter, setFilter] = useState<Status | ''>('matched');
  const [q, setQ] = useState('');
  const [shown, setShown] = useState(PAGE);
  const [busy, setBusy] = useState<'' | 'read' | 'save'>('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [history, setHistory] = useState<ImportRow[] | null>(null);

  const loadHistory = () =>
    mdFetch<ImportRow[]>(token, '/api/mpr-po/imports')
      .then(setHistory)
      .catch(() => setHistory([]));
  useEffect(() => {
    void loadHistory();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  const readFile = async (file: File) => {
    setBusy('read');
    setError('');
    setDone('');
    setResults(null);
    try {
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array' });
      const rows: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[wb.SheetNames[0]], { header: 1, raw: false, defval: '' });
      const sheet = readPoSheet(rows);
      if (sheet.error) throw new Error(sheet.error);
      if (!sheet.lines.length) throw new Error('No P.O lines with an MPR / MRF No were found in this sheet.');
      setFileName(file.name);
      setLines(sheet.lines);
      setChargeLines(sheet.chargeLines);
      const d = await mdFetch<{ results: Result[] }>(token, '/api/mpr-po/preview', 'POST', { lines: sheet.lines });
      setResults(d.results);
      setFilter(d.results.some((r) => r.status === 'matched') ? 'matched' : '');
      setShown(PAGE);
    } catch (e: any) {
      setError(e.message || "Couldn't read this file.");
      setLines(null);
    } finally {
      setBusy('');
    }
  };

  const counts = useMemo(() => {
    const c: Partial<Record<Status, number>> = {};
    for (const r of results || []) c[r.status] = (c[r.status] || 0) + 1;
    return c;
  }, [results]);
  const matched = counts.matched || 0;
  const visible = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (results || []).filter(
      (r) => (!filter || r.status === filter) && (!t || [r.poNo, r.mrfNo, r.project, r.material, r.brand, r.supplier].some((v) => String(v || '').toLowerCase().includes(t)))
    );
  }, [results, filter, q]);

  const save = async () => {
    if (!lines) return;
    setBusy('save');
    setError('');
    try {
      const d = await mdFetch<{ matchedLines: number; newPos: number; updatedPos: number; unmatched: number }>(token, '/api/mpr-po/import', 'POST', { lines, fileName });
      setDone(`Saved: ${d.newPos} new P.O on MPR rows${d.updatedPos ? `, ${d.updatedPos} already there updated` : ''}. ${d.unmatched} line(s) didn't match and were left out.`);
      setResults(null);
      setLines(null);
      void loadHistory();
      onImported?.();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  return (
    <div className="space-y-4">
      <input
        ref={fileRef}
        type="file"
        accept=".xls,.xlsx"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void readFile(f);
        }}
      />
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <FileSpreadsheet className="w-5 h-5 text-blue-600" /> P.O Import
            </h3>
            <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
              Upload the purchase order export (Excel). Each line is put on the MPR row with the same <b>Project</b>, <b>MPR / MRF No</b>, <b>Material</b> and
              <b> Specification</b> (the sheet's Brand Name; "NONE" isn't checked). Check the result first, then save. Importing the same P.O again updates it.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => fileRef.current?.click()}
              disabled={!!busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50"
            >
              {busy === 'read' ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />} Upload P.O sheet
            </button>
            <button type="button" onClick={() => void loadHistory()} className="p-2 rounded-xl bg-white border border-slate-200 hover:bg-slate-50" aria-label="Refresh" title="Refresh">
              <RefreshCw className="w-4 h-4 text-slate-600" />
            </button>
          </div>
        </div>
        {done && (
          <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-800 flex items-start justify-between gap-2">
            <span className="flex items-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 shrink-0" /> {done}
            </span>
            <button type="button" className="shrink-0" onClick={() => setDone('')} aria-label="Dismiss">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        )}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>

      {results && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-3">
          <div className="flex items-start justify-between gap-3 flex-wrap">
            <div className="text-sm text-slate-700">
              <b>{fileName}</b> — {results.length.toLocaleString()} P.O line(s) with an MPR No
              {chargeLines ? <span className="text-slate-500">; {chargeLines} carrying / loading / discount line(s) left out</span> : null}
            </div>
            <div className="flex items-center gap-2">
              <button type="button" onClick={() => { setResults(null); setLines(null); }} className="px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
                Cancel
              </button>
              <button
                type="button"
                onClick={() => void save()}
                disabled={!matched || busy === 'save'}
                className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700 disabled:opacity-40"
              >
                {busy === 'save' && <Loader2 className="w-4 h-4 animate-spin" />} Save {matched} matched
              </button>
            </div>
          </div>
          <div className="flex items-center gap-1.5 flex-wrap">
            {ORDER.filter((s) => counts[s]).map((s) => (
              <button
                key={s}
                type="button"
                title={STATUS[s].hint}
                onClick={() => {
                  setFilter(filter === s ? '' : s);
                  setShown(PAGE);
                }}
                className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${filter === s ? 'ring-2 ring-offset-1 ring-slate-400' : ''} ${STATUS[s].cls}`}
              >
                {STATUS[s].label} ({counts[s]!.toLocaleString()})
              </button>
            ))}
            {filter && (
              <button type="button" onClick={() => setFilter('')} className="text-[11px] text-slate-500 underline">
                Show all
              </button>
            )}
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setShown(PAGE);
              }}
              placeholder="Search P.O, MPR, project, material…"
              className="ml-auto w-full sm:w-64 text-sm px-3 py-1.5 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-sky-200"
            />
          </div>
          <div className="overflow-x-auto border border-slate-200 rounded-xl">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-600">
                <tr>
                  {['Line', 'P.O No', 'Date', 'Project', 'MPR No', 'Material', 'Specification (Brand)', 'Order Qty', 'Rate', 'Result'].map((h) => (
                    <th key={h} className="px-2.5 py-2 text-left font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {visible.slice(0, shown).map((r) => (
                  <tr key={r.line} className="align-top">
                    <td className="px-2.5 py-2 text-slate-400">{r.line}</td>
                    <td className="px-2.5 py-2 font-semibold whitespace-nowrap">{r.poNo || '—'}</td>
                    <td className="px-2.5 py-2 whitespace-nowrap">{r.poDate}</td>
                    <td className="px-2.5 py-2 max-w-[220px]">{r.project}</td>
                    <td className="px-2.5 py-2 whitespace-nowrap">{r.mrfNo}</td>
                    <td className="px-2.5 py-2 max-w-[200px]">{r.material}</td>
                    <td className="px-2.5 py-2 max-w-[180px]">{r.brand}</td>
                    <td className="px-2.5 py-2 text-right whitespace-nowrap">
                      {money(r.orderQty)} {r.unit}
                    </td>
                    <td className="px-2.5 py-2 text-right">{money(r.rate)}</td>
                    <td className="px-2.5 py-2 min-w-[200px]">
                      <span className={`inline-block text-[10.5px] font-semibold px-2 py-0.5 rounded-full border ${STATUS[r.status].cls}`}>{STATUS[r.status].label}</span>
                      {r.note && <div className="text-[11px] text-slate-500 mt-1">{r.note}</div>}
                      {r.entries.map((e) => (
                        <div key={e.id} className="text-[11px] text-slate-600 mt-1">
                          → {e.project} · {e.item}
                          {e.spec ? ` · ${e.spec}` : ''}
                          {e.already && <span className="ml-1 text-sky-700 font-semibold">(already has this P.O — will update)</span>}
                        </div>
                      ))}
                    </td>
                  </tr>
                ))}
                {!visible.length && (
                  <tr>
                    <td colSpan={10} className="px-3 py-6 text-center text-slate-500">No lines here.</td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {visible.length > shown && (
            <button type="button" onClick={() => setShown(shown + PAGE)} className="text-xs font-semibold text-blue-600">
              Show more ({(visible.length - shown).toLocaleString()} left)
            </button>
          )}
        </div>
      )}

      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
        <div className="text-sm font-semibold text-slate-800 flex items-center gap-2 mb-2">
          <History className="w-4 h-4 text-slate-500" /> Past imports
        </div>
        {history === null ? (
          <div className="text-xs text-slate-500">Loading…</div>
        ) : !history.length ? (
          <div className="text-xs text-slate-500">Nothing imported yet.</div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="text-slate-500">
                <tr>
                  {['When', 'By', 'File', 'Lines', 'Matched', 'New P.O', 'Updated', 'Not matched'].map((h) => (
                    <th key={h} className="px-2 py-1.5 text-left font-semibold whitespace-nowrap">{h}</th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {history.map((h) => (
                  <tr key={h.id}>
                    <td className="px-2 py-1.5 whitespace-nowrap">{formatDate(h.created_at)}</td>
                    <td className="px-2 py-1.5">{h.created_by_name || ''}</td>
                    <td className="px-2 py-1.5 max-w-[240px] truncate">{h.file_name || ''}</td>
                    <td className="px-2 py-1.5">{h.total_lines}</td>
                    <td className="px-2 py-1.5 text-emerald-700 font-semibold">{h.matched_lines}</td>
                    <td className="px-2 py-1.5">{h.new_pos}</td>
                    <td className="px-2 py-1.5">{h.updated_pos}</td>
                    <td className="px-2 py-1.5 text-slate-500">{h.unmatched_lines}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
};
