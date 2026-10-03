/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Task Management (module "task_management", TaskRoutes.ts):
// employees' requests to HR, every task of the company, repeating tasks and
// the monthly report (PDF / Excel).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import * as XLSX from 'xlsx';
import { ClipboardList, FileDown, FileSpreadsheet, Inbox, ListChecks, Plus, Repeat, Search, BarChart3 } from 'lucide-react';
import { User } from '../types';
import { Spinner } from './Spinner';
import { drawPdfLetterhead, finalizePdfPageNumbers, loadImageElement } from '../lib/pdfLetterhead';
import { savePdfCrossPlatform } from '../lib/saveFile';
import credenceLogo from '../assets/credence-logo.png';
import { api, cap, fmtDate, NewTaskForm, RecurrenceList, SOURCE_LABEL, STATUS_LABEL, Task, TaskAccess, TaskCard, TaskDrawer, takePendingTaskId } from './TaskParts';

type Tab = 'requests' | 'all' | 'repeat' | 'report';

interface ReportRow {
  user_id: number;
  name: string;
  total: number;
  done: number;
  on_time: number;
  late: number;
  open: number;
  overdue: number;
  requests: number;
}

const thisMonth = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date()).slice(0, 7);
const monthLabel = (m: string) => {
  const [y, mo] = m.split('-').map(Number);
  return new Date(y, mo - 1, 1).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' });
};

export const TaskManagement: React.FC<{ token: string; user: User }> = ({ token, user }) => {
  const [access, setAccess] = useState<TaskAccess | null>(null);
  const [tasks, setTasks] = useState<Task[] | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('requests');
  const [openId, setOpenId] = useState<number | null>(() => takePendingTaskId());
  const [newTask, setNewTask] = useState(false);
  const [repeatKey, setRepeatKey] = useState(0);
  const [q, setQ] = useState('');
  const [status, setStatus] = useState<'active' | Task['status'] | 'overdue' | 'all'>('active');
  const [source, setSource] = useState<'all' | Task['source']>('all');

  const load = useCallback(() => {
    api<Task[]>(token, '/api/tasks/all')
      .then(setTasks)
      .catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => {
    api<TaskAccess>(token, '/api/tasks/access').then(setAccess).catch(() => {});
    load();
    const onOpen = () => {
      const id = takePendingTaskId();
      if (id) setOpenId(id);
      load();
    };
    window.addEventListener('credence:open-task', onOpen);
    return () => window.removeEventListener('credence:open-task', onOpen);
  }, [token, load]);

  const isActive = (t: Task) => t.status === 'open' || t.status === 'in_progress';
  const requests = (tasks || []).filter((t) => t.source === 'request' && isActive(t));
  const waiting = requests.filter((t) => !t.assignees.length);

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (tasks || []).filter((t) => {
      if (source !== 'all' && t.source !== source) return false;
      if (status === 'active' && !isActive(t)) return false;
      if (status === 'overdue' && !t.overdue) return false;
      if (status !== 'active' && status !== 'overdue' && status !== 'all' && t.status !== status) return false;
      if (!s) return true;
      return [t.title, t.created_by_name, t.department, ...t.assignees.map((a) => a.name), `#${t.id}`].some((v) => String(v || '').toLowerCase().includes(s));
    });
  }, [tasks, q, status, source]);

  const counts = useMemo(() => {
    const all = tasks || [];
    return {
      open: all.filter(isActive).length,
      overdue: all.filter((t) => t.overdue).length,
      requests: requests.length,
      doneThisMonth: all.filter((t) => t.status === 'done' && String(t.completed_at || '').startsWith(thisMonth())).length
    };
  }, [tasks, requests.length]);

  const tabs: { key: Tab; label: string; icon: React.ComponentType<{ className?: string }>; count?: number }[] = [
    { key: 'requests', label: 'Requests to HR', icon: Inbox, count: requests.length },
    { key: 'all', label: 'All Tasks', icon: ListChecks },
    { key: 'repeat', label: 'Repeating', icon: Repeat },
    { key: 'report', label: 'Monthly Report', icon: BarChart3 }
  ];

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <h2 className="text-lg font-bold text-slate-900 flex items-center gap-2">
          <ClipboardList className="w-5 h-5 text-violet-600" /> Task Management
        </h2>
        <button type="button" onClick={() => setNewTask(true)} className="inline-flex items-center gap-1.5 px-3.5 py-2 rounded-xl text-sm font-semibold bg-violet-600 text-white hover:bg-violet-700">
          <Plus className="w-4 h-4" /> Give a task
        </button>
      </div>

      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        {[
          { label: 'Open tasks', value: counts.open, cls: 'text-sky-700' },
          { label: 'Overdue', value: counts.overdue, cls: 'text-rose-600' },
          { label: 'Requests to HR', value: counts.requests, cls: 'text-violet-700' },
          { label: 'Done this month', value: counts.doneThisMonth, cls: 'text-emerald-700' }
        ].map((c) => (
          <div key={c.label} className="rounded-2xl bg-white border border-slate-200 px-4 py-3">
            <div className="text-[11px] font-semibold text-slate-500">{c.label}</div>
            <div className={`text-2xl font-bold ${c.cls}`}>{tasks ? c.value : '–'}</div>
          </div>
        ))}
      </div>

      <div className="flex gap-1.5 overflow-x-auto pb-1">
        {tabs.map((t) => (
          <button
            key={t.key}
            type="button"
            onClick={() => setTab(t.key)}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-xs font-semibold ${tab === t.key ? 'bg-violet-600 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
          >
            <t.icon className="w-3.5 h-3.5" /> {t.label}
            {!!t.count && <span className={`px-1.5 rounded-full ${tab === t.key ? 'bg-white/25' : 'bg-violet-100 text-violet-700'}`}>{t.count}</span>}
          </button>
        ))}
      </div>

      {error && <p className="text-sm text-rose-600">{error}</p>}

      {tab === 'requests' &&
        (!tasks ? (
          <Spinner size={24} />
        ) : (
          <div className="space-y-4">
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Waiting for someone to take it ({waiting.length})</h3>
              <div className="space-y-2">
                {waiting.length === 0 && <p className="text-sm text-slate-500">Nothing waiting.</p>}
                {waiting.map((t) => (
                  <TaskCard key={t.id} task={t} onOpen={() => setOpenId(t.id)} />
                ))}
              </div>
            </section>
            <section>
              <h3 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Being handled ({requests.length - waiting.length})</h3>
              <div className="space-y-2">
                {requests
                  .filter((t) => t.assignees.length)
                  .map((t) => (
                    <TaskCard key={t.id} task={t} onOpen={() => setOpenId(t.id)} />
                  ))}
              </div>
            </section>
          </div>
        ))}

      {tab === 'all' && (
        <div className="space-y-3">
          <div className="flex flex-wrap gap-2">
            <div className="flex items-center gap-2 flex-1 min-w-[200px] rounded-xl bg-white border border-slate-200 px-3 py-2">
              <Search className="w-4 h-4 text-slate-400" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search task, person, department" className="flex-1 text-sm outline-none" />
            </div>
            <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" aria-label="Status">
              <option value="active">Open + in progress</option>
              <option value="overdue">Overdue</option>
              {(Object.keys(STATUS_LABEL) as Task['status'][]).map((s) => (
                <option key={s} value={s}>
                  {STATUS_LABEL[s]}
                </option>
              ))}
              <option value="all">All</option>
            </select>
            <select value={source} onChange={(e) => setSource(e.target.value as any)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" aria-label="From">
              <option value="all">From anyone</option>
              {(Object.keys(SOURCE_LABEL) as Task['source'][]).map((s) => (
                <option key={s} value={s}>
                  {SOURCE_LABEL[s]}
                </option>
              ))}
            </select>
          </div>
          {!tasks ? (
            <Spinner size={24} />
          ) : (
            <div className="space-y-2">
              {filtered.length === 0 && <p className="text-sm text-slate-500 py-6 text-center">No tasks match.</p>}
              {filtered.map((t) => (
                <TaskCard key={t.id} task={t} onOpen={() => setOpenId(t.id)} />
              ))}
            </div>
          )}
        </div>
      )}

      {tab === 'repeat' && <RecurrenceList token={token} reloadKey={repeatKey} />}
      {tab === 'report' && <TaskReport token={token} tasks={tasks || []} />}

      {openId && <TaskDrawer token={token} taskId={openId} meId={user.id} onClose={() => setOpenId(null)} onChanged={load} />}
      {newTask && access && (
        <NewTaskForm
          token={token}
          categories={access.categories}
          onClose={() => setNewTask(false)}
          onSaved={(repeat) => {
            setNewTask(false);
            setTab(repeat ? 'repeat' : 'all');
            setRepeatKey((k) => k + 1);
            load();
          }}
        />
      )}
    </div>
  );
};

// Month report: per person, tasks given / done / on time / late / still open.
const TaskReport: React.FC<{ token: string; tasks: Task[] }> = ({ token, tasks }) => {
  const [month, setMonth] = useState(thisMonth());
  const [data, setData] = useState<{ month: string; rows: ReportRow[]; unassigned_requests: number } | null>(null);
  const [error, setError] = useState('');
  const [exporting, setExporting] = useState(false);

  useEffect(() => {
    setData(null);
    api(token, `/api/tasks/report?month=${month}`)
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token, month]);

  const monthTasks = tasks.filter((t) => [t.created_at, t.due_date, t.completed_at].some((v) => String(v || '').startsWith(month)) && t.status !== 'cancelled');
  const totals = (data?.rows || []).reduce(
    (a, r) => ({ total: a.total + r.total, done: a.done + r.done, on_time: a.on_time + r.on_time, late: a.late + r.late, open: a.open + r.open, overdue: a.overdue + r.overdue }),
    { total: 0, done: 0, on_time: 0, late: 0, open: 0, overdue: 0 }
  );
  const pct = (a: number, b: number) => (b ? `${Math.round((a / b) * 100)}%` : '—');

  const downloadPdf = async () => {
    if (!data) return;
    setExporting(true);
    try {
      const logoImg = await loadImageElement(credenceLogo);
      const doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
      const opts = {
        reportTitle: 'Task Report',
        filters: [
          ['Month', monthLabel(data.month)],
          ['Tasks', String(monthTasks.length)],
          ['Done', String(totals.done)],
          ['On time', pct(totals.on_time, totals.done)]
        ] as [string, string][]
      };
      const startY = drawPdfLetterhead(doc, logoImg, opts);
      autoTable(doc, {
        startY,
        margin: { top: startY, left: 8, right: 8 },
        head: [['SL', 'Person', 'Tasks', 'Done', 'On time', 'Late', 'Still open', 'Overdue', 'Requests handled', 'Done %']],
        body: data.rows.map((r, i) => [String(i + 1), r.name, r.total, r.done, r.on_time, r.late, r.open, r.overdue, r.requests, pct(r.done, r.total)].map(String)),
        styles: { fontSize: 8, cellPadding: 1.5 },
        headStyles: { fillColor: [124, 58, 237], textColor: 255, fontSize: 8 },
        alternateRowStyles: { fillColor: [248, 250, 252] },
        didDrawPage: () => {
          drawPdfLetterhead(doc, logoImg, opts);
        }
      });
      autoTable(doc, {
        head: [['#', 'Task', 'From', 'Given to', 'Due', 'Status', 'Done on']],
        body: monthTasks.map((t) => [
          String(t.id),
          t.title,
          `${t.created_by_name || ''} (${SOURCE_LABEL[t.source]})`,
          t.assignees.map((a) => a.name).join(', ') || '—',
          t.due_date ? fmtDate(t.due_date) : '—',
          t.overdue ? 'Overdue' : STATUS_LABEL[t.status],
          t.completed_at ? `${fmtDate(t.completed_at)}${t.on_time === false ? ' (late)' : ''}` : ''
        ]),
        margin: { top: startY, left: 8, right: 8 },
        styles: { fontSize: 7.5, cellPadding: 1.3, overflow: 'linebreak' },
        headStyles: { fillColor: [100, 116, 139], textColor: 255, fontSize: 8 },
        didDrawPage: () => {
          drawPdfLetterhead(doc, logoImg, opts);
        }
      });
      finalizePdfPageNumbers(doc);
      await savePdfCrossPlatform(doc, `Task-Report-${data.month}.pdf`);
    } catch (err: any) {
      setError(err.message || 'Could not make the PDF.');
    } finally {
      setExporting(false);
    }
  };

  const downloadExcel = () => {
    if (!data) return;
    const wb = XLSX.utils.book_new();
    const summary = data.rows.map((r, i) => ({
      SL: i + 1,
      Person: r.name,
      Tasks: r.total,
      Done: r.done,
      'On time': r.on_time,
      Late: r.late,
      'Still open': r.open,
      Overdue: r.overdue,
      'Requests handled': r.requests,
      'Done %': pct(r.done, r.total)
    }));
    const details = monthTasks.map((t) => ({
      '#': t.id,
      Task: t.title,
      From: t.created_by_name || '',
      Kind: SOURCE_LABEL[t.source],
      Type: cap(t.category),
      Priority: cap(t.priority),
      'Given to': t.assignees.map((a) => a.name).join(', '),
      Department: t.department || '',
      Due: t.due_date || '',
      Status: t.overdue ? 'Overdue' : STATUS_LABEL[t.status],
      'Done on': t.completed_at || '',
      'On time': t.on_time === null ? '' : t.on_time ? 'Yes' : 'No',
      Note: t.completion_note || ''
    }));
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(summary.length ? summary : [{ Note: 'No tasks this month' }]), 'Summary');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.json_to_sheet(details.length ? details : [{ Note: 'No tasks this month' }]), 'Tasks');
    XLSX.writeFile(wb, `Task-Report-${data.month}.xlsx`);
  };

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap items-center gap-2">
        <input type="month" value={month} max={thisMonth()} onChange={(e) => e.target.value && setMonth(e.target.value)} className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm" aria-label="Month" />
        <div className="flex-1" />
        <button type="button" onClick={downloadExcel} disabled={!data} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white disabled:opacity-50">
          <FileSpreadsheet className="w-3.5 h-3.5" /> Excel
        </button>
        <button type="button" onClick={downloadPdf} disabled={!data || exporting} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-rose-600 text-white disabled:opacity-50">
          <FileDown className="w-3.5 h-3.5" /> {exporting ? 'Making PDF…' : 'PDF'}
        </button>
      </div>
      {error && <p className="text-sm text-rose-600">{error}</p>}
      {!data ? (
        <Spinner size={24} />
      ) : (
        <>
          <p className="text-xs text-slate-500">
            {monthLabel(data.month)}: {monthTasks.length} tasks · {totals.done} done ({pct(totals.on_time, totals.done)} on time) · {totals.overdue} overdue
            {data.unassigned_requests > 0 && ` · ${data.unassigned_requests} request(s) still waiting for someone`}
          </p>
          <div className="overflow-x-auto rounded-2xl border border-slate-200 bg-white">
            <table className="w-full text-sm">
              <thead className="bg-slate-50 text-[11px] uppercase tracking-wide text-slate-500">
                <tr>
                  {['Person', 'Tasks', 'Done', 'On time', 'Late', 'Still open', 'Overdue', 'Requests', 'Done %'].map((h) => (
                    <th key={h} className={`px-3 py-2 font-semibold ${h === 'Person' ? 'text-left' : 'text-right'}`}>
                      {h}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.rows.length === 0 && (
                  <tr>
                    <td colSpan={9} className="px-3 py-6 text-center text-slate-500">
                      No tasks this month.
                    </td>
                  </tr>
                )}
                {data.rows.map((r) => (
                  <tr key={r.user_id}>
                    <td className="px-3 py-2 font-semibold text-slate-800">{r.name}</td>
                    <td className="px-3 py-2 text-right">{r.total}</td>
                    <td className="px-3 py-2 text-right text-emerald-700">{r.done}</td>
                    <td className="px-3 py-2 text-right">{r.on_time}</td>
                    <td className="px-3 py-2 text-right text-amber-700">{r.late}</td>
                    <td className="px-3 py-2 text-right">{r.open}</td>
                    <td className="px-3 py-2 text-right text-rose-600">{r.overdue}</td>
                    <td className="px-3 py-2 text-right">{r.requests}</td>
                    <td className="px-3 py-2 text-right font-semibold">{pct(r.done, r.total)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};
