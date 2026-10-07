/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> HR Data Import (DataImportRoutes.ts): bring Employee Details,
// Leave history, Movement / Conveyance Bill Claim history, Check In / Check
// Out and office Attendance in from an Excel or CSV sheet.
//
// 1. Pick what to import and download its template (headers on the Data
//    sheet; what each column takes, with an example, on Instructions).
// 2. Upload the filled sheet — columns are matched by their header, in any
//    order; unknown columns are ignored.
// 3. Check: the server says, row by row, what would happen (New / Update /
//    Skip / Error, with the reason) without saving anything.
// 4. Import: the same rows are saved; the result can be downloaded as Excel.
// Which kinds show depends on the modules this account holds.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import * as XLSX from 'xlsx';
import {
  AlertTriangle,
  CalendarClock,
  CheckCircle2,
  Clock,
  Download,
  FileSpreadsheet,
  Fingerprint,
  Navigation,
  Receipt,
  RotateCcw,
  Upload,
  UserPlus,
  X,
} from 'lucide-react';
import { Spinner } from './Spinner';
import { useHrApi } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

type FieldType = 'text' | 'date' | 'time' | 'number' | 'yesno';
interface Field {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  aliases?: string[];
  example?: string | number;
  note?: string;
}
interface Kind {
  key: string;
  title: string;
  description: string;
  module: string;
  fields: Field[];
}
interface RowResult {
  row: number;
  status: 'create' | 'update' | 'skip' | 'error';
  message: string;
  employee?: string;
}
interface RunResponse {
  dry_run: boolean;
  summary: { total: number; create: number; update: number; skip: number; error: number };
  results: RowResult[];
}

const ICONS: Record<string, React.ComponentType<{ className?: string }>> = {
  employees: UserPlus,
  leave: CalendarClock,
  movement_claims: Navigation,
  bill_claims: Receipt,
  remote_attendance: Clock,
  office_attendance: Fingerprint,
};
const STATUS: Record<RowResult['status'], { label: string; tone: string }> = {
  create: { label: 'New', tone: 'bg-emerald-50 text-emerald-700' },
  update: { label: 'Update', tone: 'bg-blue-50 text-blue-700' },
  skip: { label: 'Skip', tone: 'bg-slate-100 text-slate-600' },
  error: { label: 'Error', tone: 'bg-rose-50 text-rose-700' },
};

const norm = (s: string) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const pad = (n: number) => String(n).padStart(2, '0');

// A cell as text the server can read. Excel keeps dates/times as serial
// numbers; those are turned into YYYY-MM-DD / HH:MM here, timezone-free.
function cellText(v: any, type: FieldType): string {
  if (v === null || v === undefined) return '';
  if (typeof v === 'number' && (type === 'date' || type === 'time')) {
    const d = XLSX.SSF.parse_date_code(v);
    if (d) {
      if (type === 'time') return `${pad(d.H)}:${pad(d.M)}`;
      return `${d.y}-${pad(d.m)}-${pad(d.d)}`;
    }
  }
  if (v instanceof Date) return type === 'time' ? `${pad(v.getHours())}:${pad(v.getMinutes())}` : `${v.getFullYear()}-${pad(v.getMonth() + 1)}-${pad(v.getDate())}`;
  return String(v).trim();
}

// Leave History can also come as HR's "Leave Summary Report" sheet: one block
// per employee ("Employee Id" in column A, the value in E), then a "Leave Year
// | Leave Type | Is Paid Leave | Leave From | Leave To | Leave Availed |
// Remarks" table where Leave Type is written only on its first row, and
// "Total Leave Availed" lines in between. This turns such a sheet into the
// plain rows the Leave History import reads (every leave Approved). Returns
// null when the sheet isn't laid out that way.
function leaveSummarySheetRows(grid: any[][]): Record<string, any>[] | null {
  const cell = (line: any[], c: number) => String(line?.[c] ?? '').trim();
  const isBlockSheet =
    grid.some((l) => norm(cell(l, 0)) === 'employeeid') && grid.some((l) => norm(cell(l, 6)) === 'leavefrom' && norm(cell(l, 2)) === 'leavetype');
  if (!isBlockSheet) return null;
  const out: Record<string, any>[] = [];
  let employeeId = '';
  let leaveType = '';
  for (let i = 0; i < grid.length; i++) {
    const line = grid[i] || [];
    const a = norm(cell(line, 0));
    if (a === 'employeeid') {
      employeeId = cell(line, 4);
      leaveType = '';
      continue;
    }
    if (a === 'leaveyear' || a.startsWith('total')) continue;
    // A leave line has dates under Leave From / Leave To. (Merged cells come
    // back with the value repeated in every cell, so the employee detail
    // lines also have text there — they're not dates.)
    const from = line[6];
    const to = line[8];
    const isDate = (v: any) => typeof v === 'number' || v instanceof Date || /^\d{1,4}[-/.]\d{1,2}[-/.]\d{1,4}$/.test(String(v ?? '').trim());
    if (!isDate(from) || !isDate(to)) continue;
    if (cell(line, 2)) leaveType = cell(line, 2);
    out.push({
      __row: i + 1,
      employee_id: employeeId,
      leave_type: leaveType,
      from_date: cellText(from, 'date'),
      to_date: cellText(to, 'date'),
      days: cell(line, 10),
      status: 'Approved',
      purpose: cell(line, 12)
    });
  }
  return out;
}

export const DataImport: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [kinds, setKinds] = useState<Kind[] | null>(null);
  const [maxRows, setMaxRows] = useState(5000);
  const [kindKey, setKindKey] = useState<string>('');
  const [fileName, setFileName] = useState('');
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [matched, setMatched] = useState<{ header: string; field: Field }[]>([]);
  const [ignored, setIgnored] = useState<string[]>([]);
  const [check, setCheck] = useState<RunResponse | null>(null);
  const [done, setDone] = useState<RunResponse | null>(null);
  const [busy, setBusy] = useState<'' | 'read' | 'check' | 'import'>('');
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'all' | RowResult['status']>('all');
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api
      .get('/api/data-import/kinds')
      .then((d) => {
        setKinds(d.kinds);
        setMaxRows(d.max_rows || 5000);
      })
      .catch((e) => {
        setKinds([]);
        setError(e.message);
      });
  }, [api]);

  const kind = kinds?.find((k) => k.key === kindKey) || null;
  const missingRequired = kind ? kind.fields.filter((f) => f.required && !matched.some((m) => m.field.key === f.key)) : [];

  const reset = () => {
    setFileName('');
    setRows([]);
    setMatched([]);
    setIgnored([]);
    setCheck(null);
    setDone(null);
    setError('');
    setFilter('all');
    if (fileRef.current) fileRef.current.value = '';
  };

  const pickKind = (key: string) => {
    setKindKey(key);
    reset();
  };

  const downloadTemplate = () => {
    if (!kind) return;
    const wb = XLSX.utils.book_new();
    const data = XLSX.utils.aoa_to_sheet([kind.fields.map((f) => f.label)]);
    data['!cols'] = kind.fields.map((f) => ({ wch: Math.max(12, f.label.length + 4) }));
    XLSX.utils.book_append_sheet(wb, data, 'Data');
    const info = XLSX.utils.aoa_to_sheet([
      ['Column', 'Required', 'Format', 'Example', 'Note'],
      ...kind.fields.map((f) => [
        f.label,
        f.required ? 'Yes' : '',
        f.type === 'date' ? 'Date (YYYY-MM-DD or DD/MM/YYYY)' : f.type === 'time' ? 'Time (HH:MM, e.g. 09:05 or 6:10 PM)' : f.type === 'number' ? 'Number' : f.type === 'yesno' ? 'Yes / No' : 'Text',
        f.example ?? '',
        f.note || (f.key === 'employee_id' ? 'Must match the Employee ID saved in Admin Panel -> Employees' : ''),
      ]),
      [],
      ['Fill the Data sheet, one row per record. Columns can be in any order; extra columns are ignored.'],
      [`At most ${maxRows} rows per upload. Rows already in the system are skipped, so the same sheet can be uploaded again safely.`],
    ]);
    info['!cols'] = [{ wch: 22 }, { wch: 10 }, { wch: 36 }, { wch: 22 }, { wch: 60 }];
    XLSX.utils.book_append_sheet(wb, info, 'Instructions');
    XLSX.writeFile(wb, `Import_Template_${kind.title.replace(/[^A-Za-z0-9]+/g, '_')}.xlsx`);
  };

  const readFile = async (file: File) => {
    if (!kind) return;
    reset();
    setBusy('read');
    setFileName(file.name);
    try {
      // A CSV is read as written (raw), so a phone number keeps its leading 0.
      const wb = XLSX.read(await file.arrayBuffer(), { type: 'array', raw: /\.csv$/i.test(file.name) });
      // The first sheet that has a header row (skips an Instructions sheet put first).
      const sheetName = wb.SheetNames.find((n) => n.toLowerCase() === 'data') || wb.SheetNames[0];
      const grid: any[][] = XLSX.utils.sheet_to_json(wb.Sheets[sheetName], { header: 1, raw: true, defval: '' });
      if (!grid.length) throw new Error('The sheet is empty.');
      const blockRows = kind.key === 'leave' ? leaveSummarySheetRows(grid) : null;
      if (blockRows) {
        if (!blockRows.length) throw new Error('No leave rows found in this Leave Summary Report.');
        if (blockRows.length > maxRows) throw new Error(`${blockRows.length} rows — at most ${maxRows} per upload. Split the sheet.`);
        const from = (key: string, header: string) => ({ header, field: kind.fields.find((f) => f.key === key)! });
        setMatched(
          [
            from('employee_id', 'Employee Id'),
            from('leave_type', 'Leave Type'),
            from('from_date', 'Leave From'),
            from('to_date', 'Leave To'),
            from('days', 'Leave Availed'),
            from('purpose', 'Remarks'),
            from('status', 'Approved (Leave Summary Report)')
          ].filter((m) => m.field)
        );
        setIgnored(['Leave Year', 'Is Paid Leave', 'Total Leave Availed']);
        setRows(blockRows);
        return;
      }
      const headers = (grid[0] || []).map((h) => String(h || '').trim());
      const fieldFor = (h: string) =>
        kind.fields.find((f) => [f.label, f.key, ...(f.aliases || [])].some((name) => norm(name) === norm(h)));
      const map: { col: number; header: string; field: Field }[] = [];
      const extra: string[] = [];
      headers.forEach((h, col) => {
        if (!h) return;
        const f = fieldFor(h);
        if (f && !map.some((m) => m.field.key === f.key)) map.push({ col, header: h, field: f });
        else extra.push(h);
      });
      const out: Record<string, string>[] = [];
      for (let i = 1; i < grid.length; i++) {
        const line = grid[i] || [];
        const rec: Record<string, any> = { __row: i + 1 };
        let any = false;
        for (const m of map) {
          const t = cellText(line[m.col], m.field.type);
          if (t) any = true;
          rec[m.field.key] = t;
        }
        if (any) out.push(rec);
      }
      if (!out.length) throw new Error('No filled rows under the header row.');
      if (out.length > maxRows) throw new Error(`${out.length} rows — at most ${maxRows} per upload. Split the sheet.`);
      setMatched(map.map(({ header, field }) => ({ header, field })));
      setIgnored(extra);
      setRows(out);
    } catch (e: any) {
      setError(e.message || "Couldn't read that file.");
    } finally {
      setBusy('');
    }
  };

  const run = async (dry: boolean) => {
    if (!kind) return;
    setBusy(dry ? 'check' : 'import');
    setError('');
    try {
      const d: RunResponse = await api.post(`/api/data-import/${kind.key}`, { rows, dry_run: dry });
      if (dry) setCheck(d);
      else setDone(d);
      setFilter(d.summary.error > 0 ? 'error' : 'all');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const shown = done || check;
  const listed = useMemo(() => (shown ? shown.results.filter((r) => filter === 'all' || r.status === filter) : []), [shown, filter]);

  const downloadResult = () => {
    if (!shown || !kind) return;
    const byRow = new Map(rows.map((r) => [Number(r.__row), r]));
    const sheet = XLSX.utils.json_to_sheet(
      shown.results.map((r) => {
        const src = byRow.get(r.row) || {};
        const rec: Record<string, any> = { 'Sheet Row': r.row, Result: STATUS[r.status].label, Message: r.message };
        for (const f of kind.fields) rec[f.label] = src[f.key] ?? '';
        return rec;
      })
    );
    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(wb, sheet, 'Result');
    XLSX.writeFile(wb, `Import_${done ? 'Result' : 'Check'}_${kind.title.replace(/[^A-Za-z0-9]+/g, '_')}.xlsx`);
  };

  if (!kinds) return <div className="py-16 flex justify-center"><Spinner /></div>;

  const willWrite = check ? check.summary.create + check.summary.update : 0;

  return (
    <div className="space-y-4">
      <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <FileSpreadsheet className="w-5 h-5 text-blue-600" /> HR Data Import
        </h2>
        <p className="text-xs text-slate-500 mt-0.5 max-w-3xl">
          Bring existing records in from Excel or CSV — download the template, fill it, upload it, check what each row will do, then import. Rows already in
          the system are skipped, so a sheet can be uploaded again safely.
        </p>
        {kinds.length === 0 ? (
          <p className="mt-4 text-sm text-slate-500">You don't have access to any import. {error}</p>
        ) : (
          <div className="mt-4 grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-2.5">
            {kinds.map((k) => {
              const Icon = ICONS[k.key] || FileSpreadsheet;
              const on = k.key === kindKey;
              return (
                <button
                  key={k.key}
                  type="button"
                  onClick={() => pickKind(k.key)}
                  className={`text-left rounded-xl border p-3.5 flex gap-3 transition-colors ${
                    on ? 'border-blue-400 bg-blue-50/60 ring-2 ring-blue-200' : 'border-slate-200 bg-white hover:bg-slate-50'
                  }`}
                >
                  <span className={`w-9 h-9 rounded-lg flex items-center justify-center shrink-0 ${on ? 'bg-blue-600 text-white' : 'bg-blue-50 text-blue-600'}`}>
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-800">{k.title}</span>
                    <span className="block text-[11px] text-slate-500 mt-0.5">{k.description}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {kind && (
        <div className="bg-white border border-slate-200 rounded-2xl shadow-sm p-5 space-y-4">
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <h3 className="text-sm font-bold text-slate-900">{kind.title}</h3>
              <p className="text-[11px] text-slate-500 mt-0.5">
                Columns: {kind.fields.map((f) => (f.required ? `${f.label}*` : f.label)).join(', ')} — * required
              </p>
            </div>
            <button
              type="button"
              onClick={downloadTemplate}
              className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50"
            >
              <Download className="w-3.5 h-3.5" /> Download template
            </button>
          </div>

          <label
            className="block rounded-xl border-2 border-dashed border-slate-200 hover:border-blue-300 bg-slate-50/50 px-4 py-6 text-center cursor-pointer"
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => {
              e.preventDefault();
              const f = e.dataTransfer.files?.[0];
              if (f) readFile(f);
            }}
          >
            <input
              ref={fileRef}
              type="file"
              accept=".xlsx,.xls,.csv"
              className="hidden"
              onChange={(e) => {
                const f = e.target.files?.[0];
                if (f) readFile(f);
              }}
            />
            {busy === 'read' ? (
              <Spinner />
            ) : (
              <>
                <Upload className="w-6 h-6 text-blue-600 mx-auto" />
                <div className="text-sm font-semibold text-slate-700 mt-1.5">{fileName || 'Choose or drop the filled sheet'}</div>
                <div className="text-[11px] text-slate-500">Excel (.xlsx, .xls) or CSV · up to {maxRows} rows</div>
              </>
            )}
          </label>

          {error && (
            <div className="text-xs rounded-lg px-3 py-2 bg-rose-50 text-rose-700 border border-rose-200 flex items-start gap-2">
              <AlertTriangle className="w-4 h-4 shrink-0" /> <span>{error}</span>
            </div>
          )}

          {rows.length > 0 && (
            <div className="space-y-2">
              <div className="text-xs text-slate-600">
                <span className="font-semibold text-slate-800">{rows.length}</span> filled row{rows.length === 1 ? '' : 's'} in {fileName}.
              </div>
              <div className="flex flex-wrap gap-1.5">
                {matched.map((m) => (
                  <span key={m.field.key} className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-emerald-50 text-emerald-700" title={`Column "${m.header}"`}>
                    ✓ {m.field.label}
                  </span>
                ))}
                {missingRequired.map((f) => (
                  <span key={f.key} className="text-[10px] font-semibold px-2 py-0.5 rounded-md bg-rose-50 text-rose-700">
                    Missing column: {f.label}
                  </span>
                ))}
                {ignored.map((h) => (
                  <span key={h} className="text-[10px] px-2 py-0.5 rounded-md bg-slate-100 text-slate-500" title="Not a column of this import — ignored">
                    Ignored: {h}
                  </span>
                ))}
              </div>
              <div className="flex flex-wrap gap-2 pt-1">
                {!done && (
                  <button
                    type="button"
                    disabled={missingRequired.length > 0 || !!busy}
                    onClick={() => run(true)}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-slate-800 hover:bg-slate-900 text-white disabled:opacity-50"
                  >
                    {busy === 'check' ? <Spinner size={14} /> : <CheckCircle2 className="w-3.5 h-3.5" />} Check rows
                  </button>
                )}
                {check && !done && (
                  <button
                    type="button"
                    disabled={willWrite === 0 || !!busy}
                    onClick={async () => {
                      if ((await confirmDialog(`Import ${willWrite} row(s) into ${kind.title}? Rows marked Skip or Error are left out.`))) run(false);
                    }}
                    className="inline-flex items-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50"
                  >
                    {busy === 'import' ? <Spinner size={14} /> : <Upload className="w-3.5 h-3.5" />} Import {willWrite} row{willWrite === 1 ? '' : 's'}
                  </button>
                )}
                <button
                  type="button"
                  onClick={reset}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50"
                >
                  <RotateCcw className="w-3.5 h-3.5" /> Start over
                </button>
              </div>
            </div>
          )}

          {shown && (
            <div className="space-y-2.5">
              <div
                className={`rounded-xl px-3.5 py-2.5 text-xs border ${
                  done ? 'bg-emerald-50 border-emerald-200 text-emerald-900' : 'bg-blue-50 border-blue-200 text-blue-900'
                }`}
              >
                {done ? (
                  <>
                    <span className="font-semibold">Imported.</span> {done.summary.create} added, {done.summary.update} updated, {done.summary.skip} skipped,{' '}
                    {done.summary.error} with errors.
                  </>
                ) : (
                  <>
                    <span className="font-semibold">Check only — nothing saved yet.</span> {check!.summary.create} will be added, {check!.summary.update} updated,{' '}
                    {check!.summary.skip} skipped (already there), {check!.summary.error} have errors and will be left out. Fix them in the sheet and upload again,
                    or import the rest now.
                  </>
                )}
              </div>
              <div className="flex flex-wrap items-center gap-1.5">
                {(['all', 'create', 'update', 'skip', 'error'] as const).map((s) => {
                  const n = s === 'all' ? shown.summary.total : shown.summary[s];
                  return (
                    <button
                      key={s}
                      type="button"
                      onClick={() => setFilter(s)}
                      className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${
                        filter === s ? 'border-blue-300 bg-blue-600 text-white' : 'border-slate-200 bg-white text-slate-600 hover:bg-slate-50'
                      }`}
                    >
                      {s === 'all' ? 'All' : STATUS[s].label} {n}
                    </button>
                  );
                })}
                <div className="flex-1" />
                <button
                  type="button"
                  onClick={downloadResult}
                  className="inline-flex items-center gap-1.5 text-[11px] font-semibold px-2.5 py-1 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50"
                >
                  <Download className="w-3.5 h-3.5" /> Download {done ? 'result' : 'check'} (Excel)
                </button>
              </div>
              <div className="overflow-x-auto rounded-xl border border-slate-200 max-h-[520px] overflow-y-auto">
                <table className="w-full text-xs">
                  <thead className="bg-slate-50 text-left text-[10px] uppercase tracking-wide text-slate-500 sticky top-0">
                    <tr>
                      <th className="px-3 py-2 font-semibold whitespace-nowrap">Sheet row</th>
                      <th className="px-3 py-2 font-semibold">Employee</th>
                      <th className="px-3 py-2 font-semibold">Result</th>
                      <th className="px-3 py-2 font-semibold">Details</th>
                    </tr>
                  </thead>
                  <tbody>
                    {listed.slice(0, 500).map((r) => (
                      <tr key={r.row} className="border-t border-slate-100 align-top">
                        <td className="px-3 py-2 text-slate-500">{r.row}</td>
                        <td className="px-3 py-2 text-slate-800 whitespace-nowrap">{r.employee || '—'}</td>
                        <td className="px-3 py-2">
                          <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded-md ${STATUS[r.status].tone}`}>{STATUS[r.status].label}</span>
                        </td>
                        <td className="px-3 py-2 text-slate-600">{r.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                {listed.length > 500 && <p className="px-3 py-2 text-[11px] text-slate-500">Showing 500 of {listed.length} — download the Excel for all.</p>}
                {listed.length === 0 && <p className="px-3 py-4 text-center text-[11px] text-slate-500">Nothing here.</p>}
              </div>
              {done && (
                <button
                  type="button"
                  onClick={reset}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50"
                >
                  <X className="w-3.5 h-3.5" /> Done — import another sheet
                </button>
              )}
            </div>
          )}
        </div>
      )}
    </div>
  );
};
