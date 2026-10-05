/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Shared pieces of Tasks (TaskRoutes.ts): the task card, the detail drawer
// (start / submit / cancel / assign / comments), the "give a task" form
// (with "repeat") and the "request to HR" form. Used by Admin Panel -> Task
// Management (TaskManagement.tsx) and Self Service -> My Tasks (MyTasks.tsx).

import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { AlertTriangle, CalendarDays, CheckCircle2, Clock, MessageSquare, Play, Repeat, Search, Send, UserPlus, X, XCircle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { confirmDialog } from '../lib/confirmDialog';

export interface TaskPerson {
  id: number;
  name: string;
}
export interface Task {
  id: number;
  title: string;
  description: string;
  source: 'hr' | 'hod' | 'request';
  category: string;
  request_type: string | null;
  priority: 'low' | 'normal' | 'high' | 'urgent';
  due_date: string | null;
  department: string | null;
  status: 'open' | 'in_progress' | 'done' | 'cancelled';
  overdue: boolean;
  on_time: boolean | null;
  created_by: number;
  created_by_name: string | null;
  created_at: string;
  started_at: string | null;
  completed_by_name: string | null;
  completed_at: string | null;
  completion_note: string | null;
  recurrence_id: number | null;
  assignees: TaskPerson[];
  comment_count: number;
}
interface TaskDetail extends Task {
  rights: { work: boolean; cancel: boolean; assign: boolean; comment: boolean };
  comments: { id: number; user_id: number; user_name: string; message: string; kind: 'comment' | 'event'; created_at: string }[];
}
export interface Assignable {
  id: number;
  name: string;
  employee_id: string | null;
  designation: string | null;
  department: string | null;
  can_see_tasks: boolean;
}
export interface TaskAccess {
  hr: boolean;
  my_tasks: boolean;
  hod: boolean;
  departments: string[];
  request_types: { key: string; label: string }[];
  categories: string[];
}

export const authHeaders = (token: string) => ({ Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' });

export async function api<T = any>(token: string, path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(apiUrl(path), { method, headers: authHeaders(token), body: body ? JSON.stringify(body) : undefined });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

export const STATUS_LABEL: Record<Task['status'], string> = { open: 'Open', in_progress: 'In progress', done: 'Done', cancelled: 'Cancelled' };
const STATUS_STYLE: Record<Task['status'], string> = {
  open: 'bg-sky-50 text-sky-700 border-sky-200',
  in_progress: 'bg-amber-50 text-amber-700 border-amber-200',
  done: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200'
};
const PRIORITY_STYLE: Record<Task['priority'], string> = {
  low: 'bg-slate-100 text-slate-600',
  normal: 'bg-blue-50 text-blue-700',
  high: 'bg-orange-50 text-orange-700',
  urgent: 'bg-rose-100 text-rose-700'
};
export const SOURCE_LABEL: Record<Task['source'], string> = { hr: 'From HR', hod: 'Department', request: 'Request to HR' };
export const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1).replace(/_/g, ' ');
export const fmtDate = (d: string | null) => {
  if (!d) return '';
  const t = new Date(d.length <= 10 ? `${d}T00:00:00` : d.replace(' ', 'T'));
  return isNaN(t.getTime()) ? d : t.toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' });
};
const fmtWhen = (d: string) => {
  const t = new Date(d.replace(' ', 'T'));
  return isNaN(t.getTime()) ? d : t.toLocaleString('en-GB', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
};
export const todayYmd = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Dhaka' }).format(new Date());

export const StatusBadge: React.FC<{ task: Task }> = ({ task }) => (
  <span className="flex items-center gap-1">
    {task.overdue && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-rose-600 text-white">Overdue</span>}
    <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_STYLE[task.status]}`}>{STATUS_LABEL[task.status]}</span>
  </span>
);

export const TaskCard: React.FC<{ task: Task; onOpen: () => void; showAssignees?: boolean; showCreator?: boolean }> = ({ task, onOpen, showAssignees = true, showCreator = true }) => (
  <button
    type="button"
    onClick={onOpen}
    className={`w-full text-left rounded-xl border bg-white p-3.5 hover:shadow-md transition-shadow ${task.overdue ? 'border-rose-300' : 'border-slate-200'}`}
  >
    <div className="flex items-start justify-between gap-2">
      <div className="min-w-0">
        <div className="text-sm font-semibold text-slate-900 truncate">{task.title}</div>
        <div className="text-[11px] text-slate-500 mt-0.5 flex flex-wrap gap-x-2">
          <span>#{task.id}</span>
          <span>{SOURCE_LABEL[task.source]}</span>
          {showCreator && task.created_by_name && <span>by {task.created_by_name}</span>}
          {task.recurrence_id && (
            <span className="inline-flex items-center gap-0.5">
              <Repeat className="w-3 h-3" /> Repeats
            </span>
          )}
        </div>
      </div>
      <StatusBadge task={task} />
    </div>
    <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[11px]">
      <span className={`px-2 py-0.5 rounded-full font-semibold ${PRIORITY_STYLE[task.priority]}`}>{cap(task.priority)}</span>
      {task.due_date && (
        <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full ${task.overdue ? 'bg-rose-50 text-rose-700' : 'bg-slate-100 text-slate-600'}`}>
          <CalendarDays className="w-3 h-3" /> Due {fmtDate(task.due_date)}
        </span>
      )}
      {showAssignees && (
        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full bg-violet-50 text-violet-700">
          {task.assignees.length ? task.assignees.map((a) => a.name).join(', ') : 'Not assigned yet'}
        </span>
      )}
      {task.comment_count > 0 && (
        <span className="inline-flex items-center gap-1 text-slate-500">
          <MessageSquare className="w-3 h-3" /> {task.comment_count}
        </span>
      )}
    </div>
  </button>
);

// Modal shell, portalled so blurred ancestors never trap it.
export const Modal: React.FC<{ title: string; onClose: () => void; children: React.ReactNode; wide?: boolean }> = ({ title, onClose, children, wide }) =>
  createPortal(
    <div className="fixed inset-0 z-[80] bg-slate-950/50 backdrop-blur-sm flex items-end sm:items-center justify-center p-0 sm:p-4" onClick={onClose}>
      <div
        role="dialog"
        aria-label={title}
        onClick={(e) => e.stopPropagation()}
        className={`bg-white w-full ${wide ? 'sm:max-w-2xl' : 'sm:max-w-lg'} max-h-[92vh] rounded-t-3xl sm:rounded-3xl shadow-2xl flex flex-col`}
      >
        <div className="flex items-center justify-between px-5 py-4 border-b border-slate-100">
          <h3 className="text-base font-bold text-slate-900">{title}</h3>
          <button type="button" onClick={onClose} className="p-1.5 rounded-full hover:bg-slate-100 text-slate-500" aria-label="Close">
            <X className="w-4 h-4" />
          </button>
        </div>
        <div className="overflow-y-auto px-5 py-4">{children}</div>
      </div>
    </div>,
    document.body
  );

const inputCls = 'w-full rounded-xl border border-slate-200 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-violet-300';
const labelCls = 'block text-xs font-semibold text-slate-600 mb-1';
const primaryBtn = 'px-4 py-2 rounded-xl text-sm font-semibold text-white bg-violet-600 hover:bg-violet-700 disabled:opacity-50';

// Pick people (search + checkboxes).
export const PeoplePicker: React.FC<{ people: Assignable[]; value: number[]; onChange: (v: number[]) => void }> = ({ people, value, onChange }) => {
  const [q, setQ] = useState('');
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return s ? people.filter((p) => [p.name, p.employee_id, p.department, p.designation].some((v) => String(v || '').toLowerCase().includes(s))) : people;
  }, [people, q]);
  const toggle = (id: number) => onChange(value.includes(id) ? value.filter((v) => v !== id) : [...value, id]);
  return (
    <div className="rounded-xl border border-slate-200">
      <div className="flex items-center gap-2 px-3 py-2 border-b border-slate-100">
        <Search className="w-4 h-4 text-slate-400" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search name, ID, department" className="flex-1 text-sm outline-none" />
        {value.length > 0 && <span className="text-[11px] font-semibold text-violet-700">{value.length} picked</span>}
      </div>
      <ul className="max-h-48 overflow-y-auto divide-y divide-slate-50">
        {list.length === 0 && <li className="px-3 py-3 text-xs text-slate-400">No one found.</li>}
        {list.map((p) => (
          <li key={p.id}>
            <label className="flex items-center gap-2.5 px-3 py-2 cursor-pointer hover:bg-slate-50">
              <input type="checkbox" checked={value.includes(p.id)} onChange={() => toggle(p.id)} aria-label={`Pick ${p.name}`} className="accent-violet-600" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm text-slate-800 truncate">{p.name}</span>
                <span className="block text-[11px] text-slate-500 truncate">
                  {[p.employee_id, p.designation, p.department].filter(Boolean).join(' · ') || '—'}
                </span>
              </span>
              {!p.can_see_tasks && <span className="text-[10px] text-amber-700 bg-amber-50 px-1.5 py-0.5 rounded">No My Tasks access</span>}
            </label>
          </li>
        ))}
      </ul>
    </div>
  );
};

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

// Give a task (HR to anyone, a department head to their team), once or
// repeating.
export const NewTaskForm: React.FC<{
  token: string;
  categories: string[];
  asHod?: boolean;
  onClose: () => void;
  onSaved: (repeat: boolean) => void;
}> = ({ token, categories, asHod, onClose, onSaved }) => {
  const [people, setPeople] = useState<Assignable[] | null>(null);
  const [form, setForm] = useState({ title: '', description: '', category: 'general', priority: 'normal', due_date: '' });
  const [assignees, setAssignees] = useState<number[]>([]);
  const [repeat, setRepeat] = useState(false);
  const [rep, setRep] = useState({ frequency: 'monthly', weekday: 0, month_day: 1, due_in_days: 0 });
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');

  useEffect(() => {
    api<Assignable[]>(token, '/api/tasks/assignable')
      .then(setPeople)
      .catch((e) => setError(e.message));
  }, [token]);

  const save = async () => {
    setError('');
    if (!form.title.trim()) return setError('Write a title.');
    if (!assignees.length) return setError('Pick at least one person.');
    setSaving(true);
    try {
      const body = { ...form, due_date: form.due_date || null, assignee_ids: assignees, as_hod: !!asHod };
      if (repeat) await api(token, '/api/task-recurrences', 'POST', { ...body, ...rep });
      else await api(token, '/api/tasks', 'POST', body);
      onSaved(repeat);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <Modal title={asHod ? 'Give a task to my team' : 'Give a task'} onClose={onClose} wide>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>Title</label>
          <input className={inputCls} value={form.title} onChange={(e) => setForm({ ...form, title: e.target.value })} placeholder="e.g. Prepare October attendance report" maxLength={200} />
        </div>
        <div>
          <label className={labelCls}>Details</label>
          <textarea className={inputCls} rows={3} value={form.description} onChange={(e) => setForm({ ...form, description: e.target.value })} placeholder="What needs to be done" />
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
          <div>
            <label className={labelCls}>Type</label>
            <select className={inputCls} value={form.category} onChange={(e) => setForm({ ...form, category: e.target.value })}>
              {categories.map((c) => (
                <option key={c} value={c}>
                  {cap(c)}
                </option>
              ))}
            </select>
          </div>
          <div>
            <label className={labelCls}>Priority</label>
            <select className={inputCls} value={form.priority} onChange={(e) => setForm({ ...form, priority: e.target.value })}>
              {['low', 'normal', 'high', 'urgent'].map((p) => (
                <option key={p} value={p}>
                  {cap(p)}
                </option>
              ))}
            </select>
          </div>
          {!repeat && (
            <div className="col-span-2 sm:col-span-1">
              <label className={labelCls}>Due date</label>
              <input type="date" className={inputCls} min={todayYmd()} value={form.due_date} onChange={(e) => setForm({ ...form, due_date: e.target.value })} />
            </div>
          )}
        </div>
        <div>
          <label className={labelCls}>Give it to</label>
          {people ? <PeoplePicker people={people} value={assignees} onChange={setAssignees} /> : <Spinner />}
          {people && people.length === 0 && <p className="text-xs text-slate-500 mt-1">{asHod ? 'No one in your department has an app login yet.' : 'No accounts found.'}</p>}
        </div>
        <label className="flex items-center gap-2 text-sm font-semibold text-slate-700">
          <input type="checkbox" checked={repeat} onChange={(e) => setRepeat(e.target.checked)} className="accent-violet-600" />
          <Repeat className="w-4 h-4 text-violet-600" /> Repeat this task
        </label>
        {repeat && (
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3 rounded-xl bg-violet-50/60 border border-violet-100 p-3">
            <div>
              <label className={labelCls}>Every</label>
              <select className={inputCls} value={rep.frequency} onChange={(e) => setRep({ ...rep, frequency: e.target.value })}>
                <option value="daily">Day</option>
                <option value="weekly">Week</option>
                <option value="monthly">Month</option>
              </select>
            </div>
            {rep.frequency === 'weekly' && (
              <div>
                <label className={labelCls}>On</label>
                <select className={inputCls} value={rep.weekday} onChange={(e) => setRep({ ...rep, weekday: Number(e.target.value) })}>
                  {WEEKDAYS.map((d, i) => (
                    <option key={d} value={i}>
                      {d}
                    </option>
                  ))}
                </select>
              </div>
            )}
            {rep.frequency === 'monthly' && (
              <div>
                <label className={labelCls}>On day</label>
                <input type="number" min={1} max={31} className={inputCls} value={rep.month_day} onChange={(e) => setRep({ ...rep, month_day: Number(e.target.value) })} />
              </div>
            )}
            <div>
              <label className={labelCls}>Due after (days)</label>
              <input type="number" min={0} max={60} className={inputCls} value={rep.due_in_days} onChange={(e) => setRep({ ...rep, due_in_days: Number(e.target.value) })} />
            </div>
            <p className="col-span-2 sm:col-span-3 text-[11px] text-slate-500">A new task is created on each run and given to the same people. 0 days = due the same day.</p>
          </div>
        )}
        {error && <p className="text-xs text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving} className={primaryBtn}>
            {saving ? 'Saving…' : repeat ? 'Save repeating task' : 'Give task'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

// An employee asks HR for something.
export const RequestToHrForm: React.FC<{ token: string; types: { key: string; label: string }[]; onClose: () => void; onSaved: () => void }> = ({ token, types, onClose, onSaved }) => {
  const [type, setType] = useState(types[0]?.key || 'other');
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [due, setDue] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    setSaving(true);
    try {
      await api(token, '/api/tasks/request', 'POST', { request_type: type, title, description, due_date: due || null });
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };
  return (
    <Modal title="Request to HR" onClose={onClose}>
      <div className="space-y-3">
        <div>
          <label className={labelCls}>What do you need?</label>
          <div className="grid grid-cols-2 gap-2">
            {types.map((t) => (
              <button
                key={t.key}
                type="button"
                onClick={() => setType(t.key)}
                className={`text-left text-xs font-semibold rounded-xl border px-3 py-2.5 ${type === t.key ? 'border-violet-500 bg-violet-50 text-violet-800' : 'border-slate-200 text-slate-700 hover:bg-slate-50'}`}
              >
                {t.label}
              </button>
            ))}
          </div>
        </div>
        {type === 'other' && (
          <div>
            <label className={labelCls}>Name it</label>
            <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} maxLength={150} placeholder="e.g. Update my bank account" />
          </div>
        )}
        <div>
          <label className={labelCls}>Details (optional)</label>
          <textarea className={inputCls} rows={3} value={description} onChange={(e) => setDescription(e.target.value)} placeholder="e.g. Needed for a bank loan, addressed to …" />
        </div>
        <div>
          <label className={labelCls}>Needed by (optional)</label>
          <input type="date" className={inputCls} min={todayYmd()} value={due} onChange={(e) => setDue(e.target.value)} />
        </div>
        {error && <p className="text-xs text-rose-600">{error}</p>}
        <div className="flex justify-end gap-2 pt-1">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100">
            Cancel
          </button>
          <button type="button" onClick={save} disabled={saving} className={primaryBtn}>
            {saving ? 'Sending…' : 'Send to HR'}
          </button>
        </div>
      </div>
    </Modal>
  );
};

// One task: details, actions and the comment thread.
export const TaskDrawer: React.FC<{ token: string; taskId: number; onClose: () => void; onChanged: () => void; meId: number }> = ({ token, taskId, onClose, onChanged, meId }) => {
  const [task, setTask] = useState<TaskDetail | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState('');
  const [showSubmit, setShowSubmit] = useState(false);
  const [comment, setComment] = useState('');
  const [assigning, setAssigning] = useState(false);
  const [people, setPeople] = useState<Assignable[] | null>(null);
  const [picked, setPicked] = useState<number[]>([]);

  const load = () =>
    api<TaskDetail>(token, `/api/tasks/${taskId}`)
      .then((t) => {
        setTask(t);
        setPicked(t.assignees.map((a) => a.id));
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [taskId]);

  const act = async (path: string, body?: any) => {
    setBusy(true);
    setError('');
    try {
      await api(token, `/api/tasks/${taskId}/${path}`, 'POST', body);
      await load();
      onChanged();
      return true;
    } catch (e: any) {
      setError(e.message);
      return false;
    } finally {
      setBusy(false);
    }
  };

  const openAssign = async () => {
    setAssigning(true);
    if (!people) api<Assignable[]>(token, '/api/tasks/assignable').then(setPeople).catch((e) => setError(e.message));
  };

  const isMine = !!task?.assignees.some((a) => a.id === meId);

  return (
    <Modal title={task ? `Task #${task.id}` : 'Task'} onClose={onClose} wide>
      {!task ? (
        error ? <p className="text-sm text-rose-600">{error}</p> : <Spinner />
      ) : (
        <div className="space-y-4">
          <div>
            <div className="flex items-start justify-between gap-2">
              <h4 className="text-lg font-bold text-slate-900">{task.title}</h4>
              <StatusBadge task={task} />
            </div>
            {task.description && <p className="mt-1.5 text-sm text-slate-700 whitespace-pre-wrap">{task.description}</p>}
          </div>
          <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs">
            <div>
              <dt className="text-slate-500">From</dt>
              <dd className="font-semibold text-slate-800">
                {task.created_by_name} · {SOURCE_LABEL[task.source]}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">Given to</dt>
              <dd className="font-semibold text-slate-800">{task.assignees.length ? task.assignees.map((a) => a.name).join(', ') : 'Not assigned yet'}</dd>
            </div>
            <div>
              <dt className="text-slate-500">Priority / Type</dt>
              <dd className="font-semibold text-slate-800">
                {cap(task.priority)} · {cap(task.category)}
              </dd>
            </div>
            <div>
              <dt className="text-slate-500">{task.source === 'request' ? 'Needed by' : 'Due'}</dt>
              <dd className={`font-semibold ${task.overdue ? 'text-rose-600' : 'text-slate-800'}`}>{task.due_date ? fmtDate(task.due_date) : '—'}</dd>
            </div>
            {task.department && (
              <div>
                <dt className="text-slate-500">Department</dt>
                <dd className="font-semibold text-slate-800">{task.department}</dd>
              </div>
            )}
            <div>
              <dt className="text-slate-500">Created</dt>
              <dd className="font-semibold text-slate-800">{fmtWhen(task.created_at)}</dd>
            </div>
          </dl>

          {task.status === 'done' && (
            <div className="rounded-xl bg-emerald-50 border border-emerald-200 px-3 py-2.5 text-xs text-emerald-900">
              <div className="flex items-center gap-1.5 font-semibold">
                <CheckCircle2 className="w-4 h-4" /> Done by {task.completed_by_name} · {task.completed_at && fmtWhen(task.completed_at)}
                {task.on_time === false && <span className="ml-1 text-rose-700">(late)</span>}
              </div>
              {task.completion_note && <p className="mt-1 whitespace-pre-wrap">{task.completion_note}</p>}
            </div>
          )}

          {/* Actions */}
          {(task.rights.work || task.rights.assign || task.rights.cancel) && (
            <div className="flex flex-wrap gap-2">
              {task.rights.work && task.status === 'open' && (
                <button type="button" disabled={busy} onClick={() => act('start')} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50">
                  <Play className="w-3.5 h-3.5" /> Start
                </button>
              )}
              {task.rights.work && (
                <button type="button" disabled={busy} onClick={() => setShowSubmit((v) => !v)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50">
                  <CheckCircle2 className="w-3.5 h-3.5" /> Submit (done)
                </button>
              )}
              {task.rights.assign && !isMine && (
                <button type="button" disabled={busy} onClick={() => act('assign', { take: true })} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-violet-100 text-violet-800 hover:bg-violet-200 disabled:opacity-50">
                  <UserPlus className="w-3.5 h-3.5" /> Take it
                </button>
              )}
              {task.rights.assign && (
                <button type="button" disabled={busy} onClick={openAssign} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-slate-100 text-slate-700 hover:bg-slate-200 disabled:opacity-50">
                  <UserPlus className="w-3.5 h-3.5" /> Assign to…
                </button>
              )}
              {task.rights.cancel && (
                <button
                  type="button"
                  disabled={busy}
                  onClick={() => {
                    const reason = window.prompt('Cancel this task? Reason (optional):');
                    if (reason !== null) void act('cancel', { reason });
                  }}
                  className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold text-rose-700 hover:bg-rose-50 disabled:opacity-50"
                >
                  <XCircle className="w-3.5 h-3.5" /> Cancel task
                </button>
              )}
            </div>
          )}
          {showSubmit && task.rights.work && (
            <div className="rounded-xl border border-emerald-200 bg-emerald-50/50 p-3 space-y-2">
              <label className={labelCls}>What was done? (optional)</label>
              <textarea className={inputCls} rows={2} value={note} onChange={(e) => setNote(e.target.value)} placeholder={task.source === 'request' ? 'e.g. Ready — collect it from the HR desk' : 'e.g. Report sent to MD'} />
              <div className="flex justify-end">
                <button
                  type="button"
                  disabled={busy}
                  onClick={async () => {
                    if (await act('submit', { note })) setShowSubmit(false);
                  }}
                  className="px-4 py-2 rounded-xl text-xs font-semibold text-white bg-emerald-600 hover:bg-emerald-700 disabled:opacity-50"
                >
                  Submit — mark as done
                </button>
              </div>
            </div>
          )}
          {assigning && (
            <div className="rounded-xl border border-violet-200 bg-violet-50/40 p-3 space-y-2">
              {people ? <PeoplePicker people={people} value={picked} onChange={setPicked} /> : <Spinner />}
              <div className="flex justify-end gap-2">
                <button type="button" onClick={() => setAssigning(false)} className="px-3 py-1.5 rounded-lg text-xs font-semibold text-slate-600 hover:bg-white">
                  Close
                </button>
                <button
                  type="button"
                  disabled={busy || !picked.length}
                  onClick={async () => {
                    if (await act('assign', { assignee_ids: picked })) setAssigning(false);
                  }}
                  className="px-3 py-1.5 rounded-lg text-xs font-semibold text-white bg-violet-600 disabled:opacity-50"
                >
                  Assign
                </button>
              </div>
            </div>
          )}
          {error && (
            <p className="text-xs text-rose-600 flex items-center gap-1">
              <AlertTriangle className="w-3.5 h-3.5" /> {error}
            </p>
          )}

          {/* Thread */}
          <div>
            <h5 className="text-xs font-bold uppercase tracking-wide text-slate-500 mb-2">Updates &amp; comments</h5>
            <ul className="space-y-2">
              {task.comments.length === 0 && <li className="text-xs text-slate-400">Nothing yet.</li>}
              {task.comments.map((c) =>
                c.kind === 'event' ? (
                  <li key={c.id} className="flex items-center gap-1.5 text-[11px] text-slate-500">
                    <Clock className="w-3 h-3" /> {c.user_name}: {c.message} · {fmtWhen(c.created_at)}
                  </li>
                ) : (
                  <li key={c.id} className={`rounded-xl px-3 py-2 text-xs ${c.user_id === meId ? 'bg-violet-50 ml-6' : 'bg-slate-50 mr-6'}`}>
                    <div className="font-semibold text-slate-700">
                      {c.user_name} <span className="font-normal text-slate-400">· {fmtWhen(c.created_at)}</span>
                    </div>
                    <p className="mt-0.5 text-slate-800 whitespace-pre-wrap">{c.message}</p>
                  </li>
                )
              )}
            </ul>
            {task.rights.comment && (
              <div className="mt-2 flex items-end gap-2">
                <textarea className={inputCls} rows={1} value={comment} onChange={(e) => setComment(e.target.value)} placeholder="Write a comment or question" />
                <button
                  type="button"
                  disabled={busy || !comment.trim()}
                  onClick={async () => {
                    if (await act('comments', { message: comment })) setComment('');
                  }}
                  className="shrink-0 p-2.5 rounded-xl bg-violet-600 text-white disabled:opacity-50"
                  aria-label="Send comment"
                >
                  <Send className="w-4 h-4" />
                </button>
              </div>
            )}
          </div>
        </div>
      )}
    </Modal>
  );
};

// Repeating tasks list (HR: all; department head: their own).
export interface Recurrence {
  id: number;
  title: string;
  frequency: 'daily' | 'weekly' | 'monthly';
  weekday: number | null;
  month_day: number | null;
  due_in_days: number;
  next_run: string | null;
  last_run: string | null;
  is_active: boolean;
  source: string;
  created_by_name: string | null;
  assignees: TaskPerson[];
}
export const describeRepeat = (r: Recurrence) =>
  r.frequency === 'daily' ? 'Every day' : r.frequency === 'weekly' ? `Every ${WEEKDAYS[r.weekday ?? 0]}` : `Every month on day ${r.month_day}`;

export const RecurrenceList: React.FC<{ token: string; scope?: 'team'; reloadKey: number }> = ({ token, scope, reloadKey }) => {
  const [rows, setRows] = useState<Recurrence[] | null>(null);
  const [error, setError] = useState('');
  const load = () =>
    api<Recurrence[]>(token, `/api/task-recurrences${scope ? `?scope=${scope}` : ''}`)
      .then(setRows)
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token, reloadKey]);
  if (error) return <p className="text-sm text-rose-600">{error}</p>;
  if (!rows) return <Spinner />;
  if (!rows.length) return <p className="text-sm text-slate-500 py-6 text-center">No repeating tasks yet. Tick “Repeat this task” when giving a task.</p>;
  return (
    <ul className="space-y-2">
      {rows.map((r) => (
        <li key={r.id} className="rounded-xl border border-slate-200 bg-white p-3.5 flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <div className="text-sm font-semibold text-slate-900 flex items-center gap-1.5">
              <Repeat className="w-4 h-4 text-violet-600" /> {r.title}
            </div>
            <div className="text-[11px] text-slate-500 mt-0.5">
              {describeRepeat(r)} · due {r.due_in_days ? `${r.due_in_days} day${r.due_in_days === 1 ? '' : 's'} later` : 'same day'} · to {r.assignees.map((a) => a.name).join(', ')}
              {r.is_active && r.next_run && ` · next ${fmtDate(r.next_run)}`}
              {r.created_by_name && ` · by ${r.created_by_name}`}
            </div>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={async () => {
                await api(token, `/api/task-recurrences/${r.id}/active`, 'PUT', { is_active: !r.is_active }).catch((e) => setError(e.message));
                void load();
              }}
              className={`text-xs font-semibold px-3 py-1.5 rounded-lg ${r.is_active ? 'bg-emerald-50 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}
            >
              {r.is_active ? 'On' : 'Paused'}
            </button>
            <button
              type="button"
              onClick={async () => {
                if (!(await confirmDialog(`Delete the repeating task "${r.title}"? Tasks it already created stay.`))) return;
                await api(token, `/api/task-recurrences/${r.id}`, 'DELETE').catch((e) => setError(e.message));
                void load();
              }}
              className="text-xs font-semibold px-3 py-1.5 rounded-lg text-rose-700 hover:bg-rose-50"
            >
              Delete
            </button>
          </div>
        </li>
      ))}
    </ul>
  );
};

// Reads (and clears) the task an alert asked to open.
export function takePendingTaskId(): number | null {
  try {
    const v = sessionStorage.getItem('open_task_id');
    if (!v) return null;
    sessionStorage.removeItem('open_task_id');
    return Number(v) || null;
  } catch {
    return null;
  }
}
