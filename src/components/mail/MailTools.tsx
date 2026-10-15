/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail tools: Rules (filters), Templates, Contacts, and Tasks &
// Calendar — each the account's own list (/api/mail/filters, /templates,
// /contacts, /tasks, /events in MailRoutes.ts).

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  Filter, Plus, Trash2, Pencil, FileText, Users, Search, Mail, Phone, Building2, ListChecks, CalendarDays, Check, MapPin, Loader2, ChevronLeft, ChevronRight, Clock, Link2
} from 'lucide-react';
import { confirmDialog } from '../../lib/confirmDialog';
import { MAIL_CATEGORIES, MailContact, MailEvent, MailFilter, MailTask, MailTemplate, mailFetch } from '../../lib/mailApi';
import { MailPopup, Tabs, Toggle, EmptyNote, RowsSkeleton, inputCls, labelCls, primaryBtn, ghostBtn } from './MailPopup';
import { MailAvatar } from './MailReader';

function useList<T>(token: string, path: string) {
  const [items, setItems] = useState<T[] | null>(null);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try {
      setError('');
      setItems(await mailFetch<T[]>(token, path));
    } catch (e: any) {
      setError(e.message);
    }
  }, [token, path]);
  useEffect(() => {
    void load();
  }, [load]);
  return { items, error, load, setItems, setError };
}

// ===========================================================================
// Rules
// ===========================================================================
const emptyRule = (): Omit<MailFilter, 'id'> => ({ name: '', conditions: {}, actions: { applyLabels: [] }, isActive: true });

const RuleForm: React.FC<{ token: string; rule: Partial<MailFilter>; onSaved: () => void; onCancel: () => void }> = ({ token, rule, onSaved, onCancel }) => {
  const [r, setR] = useState<Omit<MailFilter, 'id'>>({ ...emptyRule(), ...rule, conditions: { ...(rule.conditions || {}) }, actions: { applyLabels: [], ...(rule.actions || {}) } });
  const [labelsInput, setLabelsInput] = useState((rule.actions?.applyLabels || []).join(', '));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const c = r.conditions;
  const a = r.actions;
  const setC = (patch: Partial<MailFilter['conditions']>) => setR((x) => ({ ...x, conditions: { ...x.conditions, ...patch } }));
  const setA = (patch: Partial<MailFilter['actions']>) => setR((x) => ({ ...x, actions: { ...x.actions, ...patch } }));

  const save = async () => {
    setError('');
    if (!r.name.trim()) return setError('Give the rule a name.');
    if (!c.from && !c.to && !c.subjectContains && !c.bodyContains && !c.hasAttachment) return setError('Add at least one condition.');
    const applyLabels = labelsInput.split(',').map((x) => x.trim()).filter(Boolean).slice(0, 10);
    if (!a.archive && !a.markRead && !a.star && !applyLabels.length && !a.categorize) return setError('Pick at least one thing the rule does.');
    setBusy(true);
    try {
      const body = { ...r, actions: { ...a, applyLabels } };
      if (rule.id) await mailFetch(token, `/filters/${rule.id}`, { method: 'PUT', body });
      else await mailFetch(token, '/filters', { method: 'POST', body });
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <div>
        <label className={labelCls}>Rule name</label>
        <input value={r.name} onChange={(e) => setR({ ...r, name: e.target.value })} placeholder="Invoices to Finance" className={inputCls} autoFocus />
      </div>
      <div className="liquid-glass-inset rounded-[24px] p-4 space-y-2.5">
        <div className="text-xs font-semibold text-slate-700">When a new mail…</div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <input value={c.from || ''} onChange={(e) => setC({ from: e.target.value })} placeholder="is from (name or address)" className={inputCls} />
          <input value={c.to || ''} onChange={(e) => setC({ to: e.target.value })} placeholder="is sent to" className={inputCls} />
          <input value={c.subjectContains || ''} onChange={(e) => setC({ subjectContains: e.target.value })} placeholder="has in the subject" className={inputCls} />
          <input value={c.bodyContains || ''} onChange={(e) => setC({ bodyContains: e.target.value })} placeholder="has in the text" className={inputCls} />
        </div>
        <Toggle checked={!!c.hasAttachment} onChange={(v) => setC({ hasAttachment: v })} label="has an attachment" />
        <p className="text-[11px] text-slate-500">All the filled-in conditions must match.</p>
      </div>
      <div className="liquid-glass-inset rounded-[24px] p-4 space-y-3">
        <div className="text-xs font-semibold text-slate-700">…then</div>
        <Toggle checked={!!a.archive} onChange={(v) => setA({ archive: v })} label="Skip the Inbox (Archive it)" />
        <Toggle checked={!!a.markRead} onChange={(v) => setA({ markRead: v })} label="Mark it as read" />
        <Toggle checked={!!a.star} onChange={(v) => setA({ star: v })} label="Star it" />
        <div>
          <label className={labelCls}>Add labels (comma between)</label>
          <input value={labelsInput} onChange={(e) => setLabelsInput(e.target.value)} placeholder="Finance, Vendors" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Put it under</label>
          <select value={a.categorize || ''} onChange={(e) => setA({ categorize: e.target.value || undefined })} className={inputCls}>
            <option value="">(leave the category as it is)</option>
            {MAIL_CATEGORIES.filter((x) => x.key).map((x) => <option key={x.key} value={x.key}>{x.title}</option>)}
          </select>
        </div>
      </div>
      <p className="text-[11px] text-slate-500">Rules work on mail that arrives from now on.</p>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      <div className="flex justify-end gap-2">
        <button type="button" onClick={onCancel} className={ghostBtn}>Cancel</button>
        <button type="button" onClick={() => void save()} disabled={busy} className={primaryBtn}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save rule</button>
      </div>
    </div>
  );
};

const describeRule = (f: MailFilter) => {
  const c = f.conditions || {};
  const a = f.actions || {};
  const when = [c.from && `from “${c.from}”`, c.to && `to “${c.to}”`, c.subjectContains && `subject has “${c.subjectContains}”`, c.bodyContains && `text has “${c.bodyContains}”`, c.hasAttachment && 'has an attachment'].filter(Boolean).join(', ');
  const then = [a.archive && 'archive', a.markRead && 'mark read', a.star && 'star', ...(a.applyLabels || []).map((l) => `label ${l}`), a.categorize && `to ${a.categorize}`].filter(Boolean).join(', ');
  return `${when || 'any mail'} → ${then || 'nothing'}`;
};

export const MailRulesPopup: React.FC<{ token: string; onClose: () => void; onChanged: () => void; prefill?: Partial<MailFilter> | null }> = ({ token, onClose, onChanged, prefill }) => {
  const { items, error, load, setError } = useList<MailFilter>(token, '/filters');
  const [editing, setEditing] = useState<Partial<MailFilter> | null>(prefill || null);
  const saved = () => {
    setEditing(null);
    void load();
    onChanged();
  };
  const toggle = async (f: MailFilter) => {
    try {
      await mailFetch(token, `/filters/${f.id}`, { method: 'PATCH', body: { isActive: !f.isActive } });
      void load();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const remove = async (f: MailFilter) => {
    if (!(await confirmDialog(`Delete the rule "${f.name}"?`, { confirmLabel: 'Delete' }))) return;
    await mailFetch(token, `/filters/${f.id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    saved();
  };
  return (
    <MailPopup title={editing ? (editing.id ? 'Edit rule' : 'New rule') : 'Rules'} icon={<Filter className="w-4 h-4 text-sky-600" />} onClose={onClose}>
      {editing ? (
        <RuleForm token={token} rule={editing} onSaved={saved} onCancel={() => (prefill && !editing.id ? onClose() : setEditing(null))} />
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-600">Rules sort new mail for you as it arrives — label it, star it, mark it read or keep it out of the Inbox.</p>
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          {!items ? (
            <RowsSkeleton rows={3} />
          ) : !items.length ? (
            <EmptyNote icon={<Filter className="w-6 h-6" />} text="No rules yet." />
          ) : (
            <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">
              {items.map((f) => (
                <div key={f.id} className="flex items-center gap-3 px-4 py-3">
                  <button type="button" onClick={() => setEditing(f)} className="flex-1 min-w-0 text-left">
                    <span className={`block text-sm font-medium truncate ${f.isActive ? 'text-slate-800' : 'text-slate-400'}`}>{f.name}</span>
                    <span className="block text-[11px] text-slate-500 truncate">{describeRule(f)}</span>
                  </button>
                  <Toggle checked={f.isActive} onChange={() => void toggle(f)} label={<span className="sr-only">On</span>} />
                  <button type="button" onClick={() => void remove(f)} className="p-1.5 rounded-full text-slate-400 hover:text-rose-600 hover:bg-rose-50" aria-label={`Delete ${f.name}`}>
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setEditing({})} className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-full bg-white/80 border border-slate-200 hover:bg-white text-slate-700">
            <Plus className="w-4 h-4" /> New rule
          </button>
        </div>
      )}
    </MailPopup>
  );
};

// ===========================================================================
// Templates
// ===========================================================================
export const MailTemplatesPopup: React.FC<{ token: string; onClose: () => void; onChanged: (list: MailTemplate[]) => void }> = ({ token, onClose, onChanged }) => {
  const { items, error, load, setError } = useList<MailTemplate>(token, '/templates');
  const [editing, setEditing] = useState<Partial<MailTemplate> | null>(null);
  const [busy, setBusy] = useState(false);
  const editorRef = React.useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (items) onChanged(items);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const save = async () => {
    if (!editing) return;
    const body = { title: (editing.title || '').trim(), subject: editing.subject || '', body: editorRef.current?.innerHTML || '' };
    if (!body.title) return setError('Give the template a name.');
    setBusy(true);
    setError('');
    try {
      if (editing.id) await mailFetch(token, `/templates/${editing.id}`, { method: 'PUT', body });
      else await mailFetch(token, '/templates', { method: 'POST', body });
      setEditing(null);
      void load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (t: MailTemplate) => {
    if (!(await confirmDialog(`Delete the template "${t.title}"?`, { confirmLabel: 'Delete' }))) return;
    await mailFetch(token, `/templates/${t.id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    void load();
  };

  return (
    <MailPopup title={editing ? (editing.id ? 'Edit template' : 'New template') : 'Templates'} icon={<FileText className="w-4 h-4 text-sky-600" />} onClose={onClose}>
      {error && <div className="mb-3 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {editing ? (
        <div className="space-y-3">
          <div>
            <label className={labelCls}>Name</label>
            <input value={editing.title || ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} placeholder="Leave request reply" className={inputCls} autoFocus />
          </div>
          <div>
            <label className={labelCls}>Subject (optional)</label>
            <input value={editing.subject || ''} onChange={(e) => setEditing({ ...editing, subject: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Text</label>
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              dangerouslySetInnerHTML={{ __html: editing.body || '' }}
              className="min-h-[10rem] text-sm px-3 py-2.5 bg-white/80 border border-slate-200 rounded-xl focus:ring-2 focus:ring-sky-200 focus:outline-none [&_ul]:list-disc [&_ul]:pl-6 [&_ol]:list-decimal [&_ol]:pl-6"
            />
          </div>
          <div className="flex justify-end gap-2">
            <button type="button" onClick={() => setEditing(null)} className={ghostBtn}>Cancel</button>
            <button type="button" onClick={() => void save()} disabled={busy} className={primaryBtn}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save template</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <p className="text-xs text-slate-600">Text you write often. Put one into a mail from the Template button while writing.</p>
          {!items ? (
            <RowsSkeleton rows={3} />
          ) : !items.length ? (
            <EmptyNote icon={<FileText className="w-6 h-6" />} text="No templates yet." />
          ) : (
            <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">
              {items.map((t) => (
                <div key={t.id} className="flex items-center gap-3 px-4 py-3">
                  <button type="button" onClick={() => setEditing(t)} className="flex-1 min-w-0 text-left">
                    <span className="block text-sm font-medium text-slate-800 truncate">{t.title}</span>
                    <span className="block text-[11px] text-slate-500 truncate">{t.subject || t.body.replace(/<[^>]+>/g, ' ').slice(0, 80)}</span>
                  </button>
                  <button type="button" onClick={() => setEditing(t)} className="p-1.5 rounded-full text-slate-400 hover:bg-black/5" aria-label={`Edit ${t.title}`}><Pencil className="w-4 h-4" /></button>
                  <button type="button" onClick={() => void remove(t)} className="p-1.5 rounded-full text-slate-400 hover:text-rose-600 hover:bg-rose-50" aria-label={`Delete ${t.title}`}><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setEditing({})} className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-full bg-white/80 border border-slate-200 hover:bg-white text-slate-700">
            <Plus className="w-4 h-4" /> New template
          </button>
        </div>
      )}
    </MailPopup>
  );
};

// ===========================================================================
// Contacts
// ===========================================================================
const CONTACT_COLORS = ['', 'bg-sky-500', 'bg-violet-500', 'bg-emerald-500', 'bg-amber-500', 'bg-rose-500', 'bg-indigo-500', 'bg-teal-500'];

export const MailContactsPopup: React.FC<{ token: string; onClose: () => void; onWrite: (email: string) => void; prefill?: Partial<MailContact> | null }> = ({ token, onClose, onWrite, prefill }) => {
  const { items, error, load, setError } = useList<MailContact>(token, '/contacts');
  const [editing, setEditing] = useState<Partial<MailContact> | null>(prefill || null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (items || []).filter((c) => !t || `${c.name} ${c.email} ${c.company} ${c.phone}`.toLowerCase().includes(t));
  }, [items, q]);

  const save = async () => {
    if (!editing) return;
    setError('');
    if (!(editing.name || '').trim() || !/^\S+@\S+\.\S+$/.test((editing.email || '').trim())) return setError('A contact needs a name and a valid email.');
    setBusy(true);
    try {
      const body = { ...editing, name: editing.name!.trim(), email: editing.email!.trim() };
      if (editing.id) await mailFetch(token, `/contacts/${editing.id}`, { method: 'PUT', body });
      else await mailFetch(token, '/contacts', { method: 'POST', body });
      setEditing(null);
      void load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (c: MailContact) => {
    if (!(await confirmDialog(`Delete ${c.name} from your contacts?`, { confirmLabel: 'Delete' }))) return;
    await mailFetch(token, `/contacts/${c.id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    setEditing(null);
    void load();
  };

  return (
    <MailPopup title={editing ? (editing.id ? 'Edit contact' : 'New contact') : 'Contacts'} icon={<Users className="w-4 h-4 text-sky-600" />} onClose={onClose}>
      {error && <div className="mb-3 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {editing ? (
        <div className="space-y-3">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>Name</label>
              <input value={editing.name || ''} onChange={(e) => setEditing({ ...editing, name: e.target.value })} className={inputCls} autoFocus />
            </div>
            <div>
              <label className={labelCls}>Email</label>
              <input value={editing.email || ''} onChange={(e) => setEditing({ ...editing, email: e.target.value })} type="email" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Phone</label>
              <input value={editing.phone || ''} onChange={(e) => setEditing({ ...editing, phone: e.target.value })} inputMode="tel" className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Company</label>
              <input value={editing.company || ''} onChange={(e) => setEditing({ ...editing, company: e.target.value })} className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Notes</label>
            <textarea value={editing.notes || ''} onChange={(e) => setEditing({ ...editing, notes: e.target.value })} rows={3} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Colour</label>
            <div className="flex gap-2">
              {CONTACT_COLORS.map((c) => (
                <button
                  key={c || 'auto'}
                  type="button"
                  onClick={() => setEditing({ ...editing, avatarColor: c })}
                  className={`w-7 h-7 rounded-full ${c || 'bg-gradient-to-br from-slate-200 to-slate-400'} ${(editing.avatarColor || '') === c ? 'ring-2 ring-offset-2 ring-slate-800' : ''}`}
                  aria-label={c ? c.replace('bg-', '').replace('-500', '') : 'Automatic'}
                />
              ))}
            </div>
          </div>
          <div className="flex items-center justify-end gap-2">
            {editing.id && (
              <button type="button" onClick={() => void remove(editing as MailContact)} className="mr-auto p-2 rounded-full text-slate-500 hover:text-rose-600 hover:bg-rose-50" aria-label="Delete contact">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
            <button type="button" onClick={() => (prefill && !editing.id ? onClose() : setEditing(null))} className={ghostBtn}>Cancel</button>
            <button type="button" onClick={() => void save()} disabled={busy} className={primaryBtn}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save contact</button>
          </div>
        </div>
      ) : (
        <div className="space-y-3">
          <div className="flex gap-2">
            <div className="relative flex-1">
              <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search contacts" className={`${inputCls} pl-9`} />
            </div>
            <button type="button" onClick={() => setEditing({})} className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold px-3 rounded-xl bg-white/80 border border-slate-200 hover:bg-white">
              <Plus className="w-3.5 h-3.5" /> Add
            </button>
          </div>
          {!items ? (
            <RowsSkeleton rows={4} />
          ) : !shown.length ? (
            <EmptyNote icon={<Users className="w-6 h-6" />} text={q ? 'No contact matches.' : 'No contacts yet. Colleagues from the Employee Directory are suggested while you write anyway.'} />
          ) : (
            <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">
              {shown.map((c) => (
                <div key={c.id} className="flex items-center gap-3 px-3 py-2.5">
                  {c.avatarColor ? (
                    <span className={`w-10 h-10 rounded-full ${c.avatarColor} text-white text-xs font-semibold flex items-center justify-center shrink-0`}>{c.name.slice(0, 2).toUpperCase()}</span>
                  ) : (
                    <MailAvatar name={c.name} email={c.email} />
                  )}
                  <button type="button" onClick={() => setEditing(c)} className="flex-1 min-w-0 text-left">
                    <span className="block text-sm font-medium text-slate-800 truncate">{c.name}</span>
                    <span className="block text-[11px] text-slate-500 truncate">{c.email}</span>
                    {(c.phone || c.company) && (
                      <span className="flex items-center gap-2 text-[11px] text-slate-400 truncate">
                        {c.phone && <span className="inline-flex items-center gap-0.5"><Phone className="w-3 h-3" />{c.phone}</span>}
                        {c.company && <span className="inline-flex items-center gap-0.5"><Building2 className="w-3 h-3" />{c.company}</span>}
                      </span>
                    )}
                  </button>
                  <button type="button" onClick={() => onWrite(c.email)} className="p-2 rounded-full text-sky-700 hover:bg-sky-50" aria-label={`Write to ${c.name}`} title="Write">
                    <Mail className="w-4 h-4" />
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </MailPopup>
  );
};

// ===========================================================================
// Tasks & Calendar
// ===========================================================================
const p2 = (n: number) => String(n).padStart(2, '0');
const localDay = (d: Date) => `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())}`;
const localDT = (d: Date) => `${localDay(d)}T${p2(d.getHours())}:${p2(d.getMinutes())}`;
const showDay = (s?: string) => {
  if (!s) return '';
  const d = new Date(s.length <= 10 ? `${s}T00:00` : s);
  return Number.isNaN(d.getTime()) ? s : d.toLocaleDateString('en-GB', { weekday: 'short', day: 'numeric', month: 'short' });
};
const showTime = (s: string) => {
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
};

export interface FromMail {
  emailId: string;
  subject: string;
}

const TasksTab: React.FC<{ token: string; fromMail?: FromMail | null; onOpenMail?: (id: string) => void }> = ({ token, fromMail, onOpenMail }) => {
  const { items, error, load, setError } = useList<MailTask>(token, '/tasks');
  const [title, setTitle] = useState(fromMail ? fromMail.subject : '');
  const [due, setDue] = useState('');
  const [link, setLink] = useState<FromMail | null>(fromMail || null);
  const [showDone, setShowDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const today = localDay(new Date());

  const add = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setBusy(true);
    try {
      await mailFetch(token, '/tasks', { method: 'POST', body: { title: title.trim(), dueDate: due || undefined, emailId: link?.emailId, emailSubject: link?.subject } });
      setTitle('');
      setDue('');
      setLink(null);
      void load();
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  const toggle = async (t: MailTask) => {
    await mailFetch(token, `/tasks/${t.id}`, { method: 'PATCH', body: { completed: !t.completed } }).catch((e) => setError(e.message));
    void load();
  };
  const remove = async (t: MailTask) => {
    await mailFetch(token, `/tasks/${t.id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    void load();
  };
  const open = (items || []).filter((t) => !t.completed).sort((a, b) => (a.dueDate || '9999').localeCompare(b.dueDate || '9999'));
  const done = (items || []).filter((t) => t.completed);

  const row = (t: MailTask) => (
    <div key={t.id} className="flex items-start gap-3 px-3 py-2.5">
      <button
        type="button"
        onClick={() => void toggle(t)}
        className={`mt-0.5 w-5 h-5 rounded-full border-2 shrink-0 flex items-center justify-center ${t.completed ? 'bg-emerald-500 border-emerald-500 text-white' : 'border-slate-300 hover:border-emerald-500'}`}
        aria-label={t.completed ? 'Mark as not done' : 'Mark as done'}
      >
        {t.completed && <Check className="w-3 h-3" />}
      </button>
      <div className="flex-1 min-w-0">
        <div className={`text-sm ${t.completed ? 'line-through text-slate-400' : 'text-slate-800'}`}>{t.title}</div>
        <div className="flex flex-wrap gap-x-3 text-[11px]">
          {t.dueDate && <span className={!t.completed && t.dueDate < today ? 'text-rose-600 font-medium' : 'text-slate-500'}>Due {showDay(t.dueDate)}</span>}
          {t.emailId && (
            <button type="button" onClick={() => onOpenMail?.(t.emailId!)} className="text-sky-700 hover:underline inline-flex items-center gap-0.5 truncate max-w-[14rem]">
              <Link2 className="w-3 h-3 shrink-0" /> {t.emailSubject || 'the mail'}
            </button>
          )}
        </div>
      </div>
      <button type="button" onClick={() => void remove(t)} className="p-1 rounded-full text-slate-300 hover:text-rose-600" aria-label="Delete task"><Trash2 className="w-3.5 h-3.5" /></button>
    </div>
  );

  return (
    <div className="space-y-3">
      <form onSubmit={add} className="liquid-glass-inset rounded-[24px] p-3 space-y-2">
        <input value={title} onChange={(e) => setTitle(e.target.value)} placeholder="Add a task" className={inputCls} autoFocus={!!fromMail} />
        {link && (
          <div className="flex items-center gap-1 text-[11px] text-sky-700">
            <Link2 className="w-3 h-3" /> <span className="truncate">Linked to “{link.subject}”</span>
            <button type="button" onClick={() => setLink(null)} className="ml-1 text-slate-400 hover:text-slate-700">remove</button>
          </div>
        )}
        <div className="flex gap-2">
          <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={`${inputCls} flex-1`} aria-label="Due date" />
          <button type="submit" disabled={busy || !title.trim()} className={primaryBtn}>Add</button>
        </div>
      </form>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {!items ? (
        <RowsSkeleton rows={3} />
      ) : !open.length && !done.length ? (
        <EmptyNote icon={<ListChecks className="w-6 h-6" />} text="No tasks. Turn a mail into a task from the mail itself." />
      ) : (
        <>
          {open.length > 0 && <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">{open.map(row)}</div>}
          {done.length > 0 && (
            <div>
              <button type="button" onClick={() => setShowDone((v) => !v)} className="text-xs text-slate-500 hover:text-slate-800 px-1">
                {showDone ? 'Hide' : 'Show'} done ({done.length})
              </button>
              {showDone && <div className="mt-2 liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">{done.map(row)}</div>}
            </div>
          )}
        </>
      )}
    </div>
  );
};

const CalendarTab: React.FC<{ token: string; fromMail?: FromMail | null; onOpenMail?: (id: string) => void }> = ({ token, fromMail, onOpenMail }) => {
  const { items, error, load, setError } = useList<MailEvent>(token, '/events');
  const [month, setMonth] = useState(() => {
    const d = new Date();
    return new Date(d.getFullYear(), d.getMonth(), 1);
  });
  const [day, setDay] = useState(() => localDay(new Date()));
  const [editing, setEditing] = useState<Partial<MailEvent> | null>(() => {
    if (!fromMail) return null;
    const s = new Date();
    s.setHours(s.getHours() + 1, 0, 0, 0);
    const e = new Date(s.getTime() + 60 * 60_000);
    return { title: fromMail.subject, start: localDT(s), end: localDT(e), emailId: fromMail.emailId };
  });
  const [busy, setBusy] = useState(false);

  const byDay = useMemo(() => {
    const m = new Map<string, MailEvent[]>();
    for (const ev of items || []) {
      const k = ev.start.slice(0, 10);
      m.set(k, [...(m.get(k) || []), ev]);
    }
    return m;
  }, [items]);

  const cells = useMemo(() => {
    // Six weeks from the Sunday on or before the 1st.
    const first = new Date(month);
    const start = new Date(first);
    start.setDate(1 - first.getDay());
    return Array.from({ length: 42 }).map((_, i) => {
      const d = new Date(start);
      d.setDate(start.getDate() + i);
      return d;
    });
  }, [month]);

  const save = async () => {
    if (!editing) return;
    setError('');
    if (!(editing.title || '').trim() || !editing.start || !editing.end) return setError('An event needs a title, a start and an end.');
    if (editing.end < editing.start) return setError('The end is before the start.');
    setBusy(true);
    try {
      const body = { ...editing, title: editing.title!.trim() };
      if (editing.id) await mailFetch(token, `/events/${editing.id}`, { method: 'PUT', body });
      else await mailFetch(token, '/events', { method: 'POST', body });
      setDay(editing.start.slice(0, 10));
      setEditing(null);
      void load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    if (!editing?.id || !(await confirmDialog(`Delete the event "${editing.title}"?`, { confirmLabel: 'Delete' }))) return;
    await mailFetch(token, `/events/${editing.id}`, { method: 'DELETE' }).catch((e) => setError(e.message));
    setEditing(null);
    void load();
  };

  if (editing) {
    return (
      <div className="space-y-3">
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
        <div>
          <label className={labelCls}>Title</label>
          <input value={editing.title || ''} onChange={(e) => setEditing({ ...editing, title: e.target.value })} className={inputCls} autoFocus />
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>Starts</label>
            <input type="datetime-local" value={editing.start || ''} onChange={(e) => setEditing({ ...editing, start: e.target.value })} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Ends</label>
            <input type="datetime-local" value={editing.end || ''} min={editing.start} onChange={(e) => setEditing({ ...editing, end: e.target.value })} className={inputCls} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Place</label>
          <input value={editing.location || ''} onChange={(e) => setEditing({ ...editing, location: e.target.value })} placeholder="Head Office, Meeting room 2" className={inputCls} />
        </div>
        <div>
          <label className={labelCls}>Notes</label>
          <textarea value={editing.description || ''} onChange={(e) => setEditing({ ...editing, description: e.target.value })} rows={3} className={inputCls} />
        </div>
        {editing.emailId && <div className="text-[11px] text-sky-700 flex items-center gap-1"><Link2 className="w-3 h-3" /> Linked to a mail</div>}
        <div className="flex items-center justify-end gap-2">
          {editing.id && (
            <button type="button" onClick={() => void remove()} className="mr-auto p-2 rounded-full text-slate-500 hover:text-rose-600 hover:bg-rose-50" aria-label="Delete event"><Trash2 className="w-4 h-4" /></button>
          )}
          <button type="button" onClick={() => setEditing(null)} className={ghostBtn}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy} className={primaryBtn}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Save event</button>
        </div>
      </div>
    );
  }

  const today = localDay(new Date());
  const dayEvents = (byDay.get(day) || []).sort((a, b) => a.start.localeCompare(b.start));
  const newAt = () => {
    const s = new Date(`${day}T09:00`);
    if (day === today) {
      const n = new Date();
      s.setHours(n.getHours() + 1, 0, 0, 0);
    }
    setEditing({ title: '', start: localDT(s), end: localDT(new Date(s.getTime() + 60 * 60_000)) });
  };

  return (
    <div className="space-y-3">
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      <div className="liquid-glass-inset rounded-[24px] p-3">
        <div className="flex items-center justify-between mb-2">
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() - 1, 1))} className="p-1.5 rounded-full hover:bg-black/5" aria-label="Previous month"><ChevronLeft className="w-4 h-4" /></button>
          <span className="text-sm font-semibold text-slate-800">{month.toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span>
          <button type="button" onClick={() => setMonth(new Date(month.getFullYear(), month.getMonth() + 1, 1))} className="p-1.5 rounded-full hover:bg-black/5" aria-label="Next month"><ChevronRight className="w-4 h-4" /></button>
        </div>
        <div className="grid grid-cols-7 text-center text-[10px] font-semibold text-slate-400 mb-1">
          {['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].map((d) => <div key={d}>{d}</div>)}
        </div>
        <div className="grid grid-cols-7 gap-0.5">
          {cells.map((d) => {
            const k = localDay(d);
            const inMonth = d.getMonth() === month.getMonth();
            const n = byDay.get(k)?.length || 0;
            return (
              <button
                key={k}
                type="button"
                onClick={() => setDay(k)}
                className={`h-9 rounded-xl text-xs flex flex-col items-center justify-center ${k === day ? 'bg-sky-600 text-white font-semibold' : k === today ? 'bg-sky-50 text-sky-800 font-semibold' : inMonth ? 'text-slate-700 hover:bg-white/70' : 'text-slate-300'}`}
                aria-label={`${d.toDateString()}${n ? `, ${n} event${n > 1 ? 's' : ''}` : ''}`}
              >
                {d.getDate()}
                {n > 0 && <span className={`w-1 h-1 rounded-full mt-0.5 ${k === day ? 'bg-white' : 'bg-sky-500'}`} />}
              </button>
            );
          })}
        </div>
      </div>
      <div className="flex items-center justify-between">
        <span className="text-sm font-semibold text-slate-800">{showDay(day)}</span>
        <button type="button" onClick={newAt} className="inline-flex items-center gap-1 text-xs font-semibold px-3 py-1.5 rounded-full bg-white/80 border border-slate-200 hover:bg-white">
          <Plus className="w-3.5 h-3.5" /> Event
        </button>
      </div>
      {!items ? (
        <RowsSkeleton rows={2} />
      ) : !dayEvents.length ? (
        <p className="text-xs text-slate-500 px-1">Nothing on this day.</p>
      ) : (
        <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">
          {dayEvents.map((ev) => (
            <button key={ev.id} type="button" onClick={() => setEditing(ev)} className="w-full text-left flex items-start gap-3 px-3 py-2.5 hover:bg-white/40">
              <span className="w-1 self-stretch rounded-full bg-sky-500 shrink-0" />
              <span className="flex-1 min-w-0">
                <span className="block text-sm font-medium text-slate-800 truncate">{ev.title}</span>
                <span className="flex flex-wrap gap-x-3 text-[11px] text-slate-500">
                  <span className="inline-flex items-center gap-0.5"><Clock className="w-3 h-3" />{showTime(ev.start)} – {ev.end.slice(0, 10) !== ev.start.slice(0, 10) ? `${showDay(ev.end)} ` : ''}{showTime(ev.end)}</span>
                  {ev.location && <span className="inline-flex items-center gap-0.5 truncate"><MapPin className="w-3 h-3" />{ev.location}</span>}
                </span>
                {ev.emailId && (
                  <span
                    role="link"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation();
                      onOpenMail?.(ev.emailId!);
                    }}
                    className="text-[11px] text-sky-700 hover:underline inline-flex items-center gap-0.5"
                  >
                    <Link2 className="w-3 h-3" /> Open the mail
                  </span>
                )}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

export const MailPlannerPopup: React.FC<{
  token: string;
  onClose: () => void;
  startTab?: 'tasks' | 'calendar';
  fromMail?: FromMail | null;
  onOpenMail?: (id: string) => void;
}> = ({ token, onClose, startTab = 'tasks', fromMail, onOpenMail }) => {
  const [tab, setTab] = useState<string>(startTab);
  return (
    <MailPopup
      title="Tasks & Calendar"
      icon={tab === 'tasks' ? <ListChecks className="w-4 h-4 text-sky-600" /> : <CalendarDays className="w-4 h-4 text-sky-600" />}
      onClose={onClose}
      size="md"
      head={<Tabs tabs={[{ key: 'tasks', label: 'Tasks' }, { key: 'calendar', label: 'Calendar' }]} value={tab} onChange={setTab} />}
    >
      {tab === 'tasks' ? (
        <TasksTab token={token} fromMail={startTab === 'tasks' ? fromMail : null} onOpenMail={onOpenMail} />
      ) : (
        <CalendarTab token={token} fromMail={startTab === 'calendar' ? fromMail : null} onOpenMail={onOpenMail} />
      )}
    </MailPopup>
  );
};
