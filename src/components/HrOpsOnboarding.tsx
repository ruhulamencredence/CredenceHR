/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> "Onboarding": new joiners (last 120 days) with how far
// their checklist is, and each Employee's checklist — appointment letter,
// documents, bank account opening + the bank's acknowledgement, login,
// device PIN, ID card, supervisor, assets, orientation, probation. Items the
// app can already see (a letter issued, a bank account saved, a login…) tick
// themselves; the rest HR ticks, with a note/value and an optional file
// (e.g. the bank's acknowledgement letter).

import React, { useEffect, useState } from 'react';
import { ClipboardCheck, PlayCircle, Paperclip, CheckCircle2, Circle, MinusCircle, ArrowLeft, FileText, AlertTriangle } from 'lucide-react';
import { Spinner } from './Spinner';
import { apiUrl } from '../lib/api';
import { LetterComposer, type ComposerInit } from './HrOpsLetters';
import { useHrApi, Notice, Badge, fmtDate, inputCls, btnPrimary, btnGhost, type HrOpsEmployee, type HrOpsMeta } from './HrOpsShared';

interface Joiner {
  employee_id: number;
  name: string;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  joining_date: string | null;
  started: boolean;
  total: number;
  done: number;
  overdue: number;
}
interface Item {
  id: number;
  task_key: string;
  label: string;
  category: string | null;
  status: 'pending' | 'done' | 'na';
  due_date: string | null;
  note: string | null;
  value_text: string | null;
  attachment_name: string | null;
  has_attachment: boolean;
  done_by_name: string | null;
  done_at: string | null;
}

// Items that open a letter composer instead of a plain tick.
const LETTER_FOR_TASK: Record<string, string> = { appointment_letter: 'appointment', bank_letter: 'bank_account', joining_report: 'joining' };

export const HrOpsOnboarding: React.FC<{ token: string; meta: HrOpsMeta; employees: HrOpsEmployee[] }> = ({ token, meta, employees }) => {
  const api = useHrApi(token);
  const [joiners, setJoiners] = useState<Joiner[]>([]);
  const [loading, setLoading] = useState(true);
  const [current, setCurrent] = useState<number | null>(null);
  const [items, setItems] = useState<Item[]>([]);
  const [itemsLoading, setItemsLoading] = useState(false);
  const [drafts, setDrafts] = useState<Record<number, { note: string; value_text: string }>>({});
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [composer, setComposer] = useState<ComposerInit | null>(null);
  const today = new Date().toISOString().slice(0, 10);

  const loadJoiners = async () => {
    setLoading(true);
    try {
      setJoiners(await api.get<Joiner[]>('/api/hr-ops/onboarding'));
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  };
  const loadItems = async (id: number) => {
    setItemsLoading(true);
    try {
      const list = await api.get<Item[]>(`/api/hr-ops/onboarding/${id}`);
      setItems(list);
      setDrafts(Object.fromEntries(list.map((i) => [i.id, { note: i.note || '', value_text: i.value_text || '' }])));
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setItemsLoading(false);
    }
  };
  useEffect(() => {
    loadJoiners();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (current) loadItems(current);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [current]);

  const start = async (id: number) => {
    try {
      await api.post(`/api/hr-ops/onboarding/${id}/start`);
      setCurrent(id);
      loadJoiners();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  const update = async (it: Item, patch: Record<string, any>) => {
    try {
      await api.put(`/api/hr-ops/onboarding/items/${it.id}`, { ...drafts[it.id], ...patch });
      loadItems(current!);
      loadJoiners();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  const attach = (it: Item, file: File) => {
    if (file.size > 8 * 1024 * 1024) return setMsg({ type: 'error', text: 'File is larger than 8 MB.' });
    const reader = new FileReader();
    reader.onload = () => {
      const base64 = String(reader.result).split(',')[1];
      update(it, { attachment_base64: base64, attachment_name: file.name, attachment_mime: file.type || 'application/octet-stream', status: it.status === 'pending' ? 'done' : it.status });
    };
    reader.readAsDataURL(file);
  };
  const openAttachment = async (it: Item) => {
    const res = await fetch(apiUrl(`/api/hr-ops/onboarding/items/${it.id}/attachment`), { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return;
    const url = URL.createObjectURL(await res.blob());
    window.open(url, '_blank');
  };

  if (current) {
    const j = joiners.find((x) => x.employee_id === current);
    const emp = employees.find((e) => e.id === current);
    const groups = Array.from(new Set(items.map((i) => i.category || 'Other')));
    const done = items.filter((i) => i.status !== 'pending').length;
    return (
      <div className="space-y-4">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <button type="button" onClick={() => setCurrent(null)} className="text-xs font-semibold text-slate-500 hover:text-slate-800 flex items-center gap-1">
          <ArrowLeft className="w-3.5 h-3.5" /> All new joiners
        </button>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="text-base font-bold text-slate-900">{j?.name || emp?.name}</div>
            <div className="text-xs text-slate-500">
              {[j?.employee_code || emp?.employee_code, j?.designation || emp?.designation, j?.department || emp?.department].filter(Boolean).join(' · ')} · Joined {fmtDate(j?.joining_date || emp?.joining_date)}
            </div>
          </div>
          <div className="min-w-[200px]">
            <div className="flex justify-between text-[11px] text-slate-500 mb-1">
              <span>Checklist</span>
              <span className="font-semibold text-slate-800">
                {done}/{items.length}
              </span>
            </div>
            <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
              <div className="h-full bg-emerald-500 transition-all" style={{ width: `${items.length ? (done / items.length) * 100 : 0}%` }} />
            </div>
          </div>
        </div>
        {itemsLoading && items.length === 0 ? (
          <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
            <Spinner size={16} /> Loading…
          </div>
        ) : (
          groups.map((g) => (
            <div key={g} className="rounded-xl border border-slate-200 bg-white overflow-hidden">
              <div className="px-4 py-2 bg-slate-50 border-b border-slate-100 text-[11px] font-bold uppercase tracking-wide text-slate-500">{g}</div>
              <ul className="divide-y divide-slate-100">
                {items
                  .filter((i) => (i.category || 'Other') === g)
                  .map((it) => {
                    const overdue = it.status === 'pending' && it.due_date && it.due_date < today;
                    return (
                      <li key={it.id} className="px-4 py-3 flex flex-wrap items-start gap-3">
                        <button
                          type="button"
                          title={it.status === 'done' ? 'Mark as pending' : 'Mark as done'}
                          onClick={() => update(it, { status: it.status === 'done' ? 'pending' : 'done' })}
                          className="mt-0.5"
                        >
                          {it.status === 'done' ? (
                            <CheckCircle2 className="w-5 h-5 text-emerald-600" />
                          ) : it.status === 'na' ? (
                            <MinusCircle className="w-5 h-5 text-slate-300" />
                          ) : (
                            <Circle className={`w-5 h-5 ${overdue ? 'text-rose-400' : 'text-slate-300'}`} />
                          )}
                        </button>
                        <div className="flex-1 min-w-[220px]">
                          <div className={`text-sm ${it.status === 'done' ? 'text-slate-500' : 'text-slate-800 font-medium'}`}>{it.label}</div>
                          <div className="text-[11px] text-slate-400 mt-0.5 flex flex-wrap gap-x-2">
                            <span className={overdue ? 'text-rose-600 font-semibold' : ''}>Due {fmtDate(it.due_date)}</span>
                            {it.status === 'done' && it.done_at && (
                              <span>
                                Done {fmtDate(String(it.done_at).slice(0, 10))}
                                {it.done_by_name ? ` by ${it.done_by_name}` : ''}
                              </span>
                            )}
                            {it.note === 'Auto-detected' && <span className="text-emerald-600">Auto-detected</span>}
                          </div>
                          <div className="grid sm:grid-cols-2 gap-2 mt-2">
                            <input
                              value={drafts[it.id]?.value_text ?? ''}
                              onChange={(e) => setDrafts({ ...drafts, [it.id]: { ...drafts[it.id], value_text: e.target.value } })}
                              onBlur={() => (drafts[it.id]?.value_text || '') !== (it.value_text || '') && update(it, {})}
                              placeholder={it.task_key === 'bank_account' ? 'Bank & account number' : it.task_key === 'id_card' ? 'ID card number' : 'Value (optional)'}
                              className={`${inputCls} text-xs py-1.5`}
                            />
                            <input
                              value={drafts[it.id]?.note ?? ''}
                              onChange={(e) => setDrafts({ ...drafts, [it.id]: { ...drafts[it.id], note: e.target.value } })}
                              onBlur={() => (drafts[it.id]?.note || '') !== (it.note || '') && update(it, {})}
                              placeholder="Note"
                              className={`${inputCls} text-xs py-1.5`}
                            />
                          </div>
                        </div>
                        <div className="flex items-center gap-1.5 flex-wrap">
                          {LETTER_FOR_TASK[it.task_key] && it.status === 'pending' && (
                            <button type="button" className={btnGhost} onClick={() => setComposer({ employee_id: current, letter_type: LETTER_FOR_TASK[it.task_key] })}>
                              <FileText className="w-3.5 h-3.5" /> Issue Letter
                            </button>
                          )}
                          {it.has_attachment ? (
                            <button type="button" className={btnGhost} onClick={() => openAttachment(it)} title={it.attachment_name || ''}>
                              <Paperclip className="w-3.5 h-3.5" /> {String(it.attachment_name || 'File').slice(0, 18)}
                            </button>
                          ) : (
                            <label className={`${btnGhost} cursor-pointer`}>
                              <Paperclip className="w-3.5 h-3.5" /> Attach
                              <input type="file" className="hidden" onChange={(e) => e.target.files?.[0] && attach(it, e.target.files[0])} />
                            </label>
                          )}
                          {it.status === 'pending' && (
                            <button type="button" className="text-[11px] text-slate-400 hover:text-slate-600 px-1" onClick={() => update(it, { status: 'na' })}>
                              N/A
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
              </ul>
            </div>
          ))
        )}
        {composer && (
          <LetterComposer
            token={token}
            meta={meta}
            employees={employees}
            init={composer}
            onClose={() => setComposer(null)}
            onIssued={(ref) => {
              setComposer(null);
              setMsg({ type: 'success', text: `Letter ${ref} issued.` });
              loadItems(current);
            }}
          />
        )}
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <p className="text-xs text-slate-500">Employees who joined in the last 120 days, and anyone whose checklist has been started. The checklist items can be changed in Settings → Onboarding Checklist.</p>
      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Spinner size={16} /> Loading…
        </div>
      ) : joiners.length === 0 ? (
        <div className="text-center py-14 text-sm text-slate-400">
          <ClipboardCheck className="w-9 h-9 mx-auto mb-2 text-slate-300" />
          No new joiners. Set an employee's Joining Date to see them here.
        </div>
      ) : (
        <div className="grid sm:grid-cols-2 xl:grid-cols-3 gap-3">
          {joiners.map((j) => (
            <div key={j.employee_id} className="rounded-xl border border-slate-200 bg-white p-4 flex flex-col gap-3">
              <div>
                <div className="text-sm font-bold text-slate-800">{j.name}</div>
                <div className="text-[11px] text-slate-500">{[j.employee_code, j.designation, j.department].filter(Boolean).join(' · ')}</div>
                <div className="text-[11px] text-slate-400 mt-0.5">Joined {fmtDate(j.joining_date)}</div>
              </div>
              {j.started ? (
                <>
                  <div>
                    <div className="flex justify-between text-[11px] text-slate-500 mb-1">
                      <span>{j.done === j.total ? 'Complete' : `${j.total - j.done} left`}</span>
                      <span className="font-semibold text-slate-800">{Math.round((j.done / Math.max(1, j.total)) * 100)}%</span>
                    </div>
                    <div className="h-1.5 rounded-full bg-slate-100 overflow-hidden">
                      <div className="h-full bg-emerald-500" style={{ width: `${(j.done / Math.max(1, j.total)) * 100}%` }} />
                    </div>
                  </div>
                  <div className="flex items-center justify-between">
                    {j.overdue > 0 ? (
                      <Badge tone="rejected">
                        <AlertTriangle className="w-3 h-3" /> {j.overdue} overdue
                      </Badge>
                    ) : (
                      <span />
                    )}
                    <button type="button" className={btnGhost} onClick={() => setCurrent(j.employee_id)}>
                      Open Checklist
                    </button>
                  </div>
                </>
              ) : (
                <button type="button" className={btnPrimary} onClick={() => start(j.employee_id)}>
                  <PlayCircle className="w-3.5 h-3.5" /> Start Onboarding
                </button>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
