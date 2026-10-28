/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail groups (MailRoutes.ts "Groups").
//   CentralGroupsAdmin  Admin Panel -> Mail Administration -> Groups: one
//                       address on our domain that reaches every member.
//                       Seeing them: mail_admin "read"; changing them: the
//                       explicit-only "mail_groups" layer.
//   MyGroupsPopup       Credence Mail -> Tools -> My groups: a person's own
//                       named lists of addresses (users.can_use_mail_groups).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Users, Plus, Pencil, Trash2, X, Loader2, Search, Lock, Globe, UserCheck, ListChecks, Building2 } from 'lucide-react';
import { apiUrl } from '../../lib/api';
import { confirmDialog } from '../../lib/confirmDialog';
import { useBackButtonClose } from '../../lib/useBackButtonClose';
import { useKeyboardInset } from '../../lib/useKeyboardInset';
import { DirectoryPerson, MyGroup, forgetMailGroups, loadDirectory, mailFetch } from '../../lib/mailApi';

const inputCls = 'w-full text-sm px-3 py-2 bg-white/80 border border-slate-200 rounded-xl focus:ring-2 focus:ring-sky-200 focus:outline-none';
const EMAIL_RE = /^[^\s@<>()",;]+@[^\s@<>()",;]+\.[^\s@<>()",;]+$/;

// ---------------------------------------------------------------------------
// Picking people: chips, plus a search over the Employee Directory; any
// address can be typed (or several pasted) and added with Enter.
// ---------------------------------------------------------------------------
const PeoplePicker: React.FC<{ token: string; value: string[]; onChange: (v: string[]) => void; placeholder?: string }> = ({ token, value, onChange, placeholder }) => {
  const [people, setPeople] = useState<DirectoryPerson[]>([]);
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    void loadDirectory(token).then(setPeople);
  }, [token]);
  const byEmail = useMemo(() => new Map(people.map((p) => [p.email.toLowerCase(), p])), [people]);
  const chosen = useMemo(() => new Set(value.map((x) => x.toLowerCase())), [value]);
  const found = useMemo(() => {
    const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
    if (!words.length) return [];
    return people
      .filter((p) => !chosen.has(p.email.toLowerCase()))
      .filter((p) => {
        const hay = `${p.name} ${p.email} ${p.employeeId || ''} ${p.designation} ${p.department}`.toLowerCase();
        return words.every((w) => hay.includes(w));
      })
      .slice(0, 30);
  }, [people, q, chosen]);
  const add = (emails: string[]) => {
    const next = [...value];
    for (const e of emails) {
      const x = e.trim().toLowerCase();
      if (EMAIL_RE.test(x) && !next.some((y) => y.toLowerCase() === x)) next.push(x);
    }
    onChange(next);
    setQ('');
    inputRef.current?.focus();
  };
  const typed = q.split(/[\s,;]+/).filter((x) => EMAIL_RE.test(x.trim()));
  return (
    <div className="relative">
      <div className="rounded-xl bg-white/80 border border-slate-200 p-1.5 flex flex-wrap gap-1.5 focus-within:ring-2 focus-within:ring-sky-200">
        {value.map((e) => {
          const p = byEmail.get(e.toLowerCase());
          return (
            <span key={e} className="inline-flex items-center gap-1 max-w-full rounded-full bg-slate-100 pl-2.5 pr-1 py-0.5 text-xs text-slate-700" title={e}>
              <span className="truncate">{p ? p.name : e}</span>
              <button type="button" onClick={() => onChange(value.filter((x) => x !== e))} className="p-0.5 rounded-full hover:bg-slate-200 shrink-0" aria-label={`Remove ${e}`}>
                <X className="w-3 h-3" />
              </button>
            </span>
          );
        })}
        <input
          ref={inputRef}
          value={q}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') {
              e.preventDefault();
              if (typed.length) add(typed);
              else if (found[0]) add([found[0].email]);
            } else if (e.key === 'Backspace' && !q && value.length) {
              onChange(value.slice(0, -1));
            }
          }}
          onPaste={(e) => {
            const text = e.clipboardData.getData('text');
            const many = text.split(/[\s,;]+/).filter((x) => EMAIL_RE.test(x.trim()));
            if (many.length > 1) {
              e.preventDefault();
              add(many);
            }
          }}
          placeholder={value.length ? '' : placeholder || 'Name, email, ID, designation…'}
          className="flex-1 min-w-[10rem] bg-transparent px-1.5 py-1 text-sm focus:outline-none"
        />
      </div>
      {open && (found.length > 0 || typed.length > 0) && (
        <div className="absolute left-0 right-0 top-full mt-1 z-20 rounded-xl bg-white shadow-xl ring-1 ring-black/10 overflow-y-auto max-h-60" onMouseDown={(e) => e.preventDefault()}>
          {typed.length > 0 && (
            <button type="button" onClick={() => add(typed)} className="w-full text-left px-3 py-2 text-xs text-sky-700 hover:bg-sky-50">
              Add {typed.join(', ')}
            </button>
          )}
          {found.map((p) => (
            <button key={p.email} type="button" onClick={() => add([p.email])} className="w-full text-left px-3 py-2 hover:bg-slate-50">
              <span className="flex items-center gap-1.5 min-w-0">
                <span className="text-sm font-medium text-slate-800 truncate">{p.name}</span>
                {p.employeeId && <span className="text-[10px] font-semibold px-1.5 py-px rounded bg-slate-100 text-slate-600 shrink-0">ID {p.employeeId}</span>}
              </span>
              <span className="block text-[11px] text-slate-500 truncate">
                {[p.designation, p.department].filter(Boolean).join(' · ')}
                {(p.designation || p.department) && ' · '}
                {p.email}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// The house popup: liquid-glass card over a dimmed page.
const Sheet: React.FC<{ title: string; onClose: () => void; wide?: boolean; children: React.ReactNode }> = ({ title, onClose, wide, children }) => {
  const keyboardInset = useKeyboardInset();
  useBackButtonClose(true, onClose);
  return (
    <div className="fixed inset-0 z-[95] liquid-glass-backdrop flex items-end sm:items-center justify-center p-3 sm:p-4" style={keyboardInset ? { paddingBottom: keyboardInset + 8 } : undefined} onClick={onClose}>
      <div className={`w-full ${wide ? 'max-w-2xl' : 'max-w-lg'} max-h-[92vh] flex`} onClick={(e) => e.stopPropagation()}>
        <div className="liquid-glass liquid-glass-in rounded-[32px] w-full p-5 overflow-y-auto text-left">
          <div className="flex items-center justify-between gap-2 mb-4">
            <h3 className="text-base font-bold text-slate-900">{title}</h3>
            <button type="button" onClick={onClose} className="liquid-glass-chip p-1.5 rounded-full text-slate-600 hover:text-slate-900" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          {children}
        </div>
      </div>
    </div>
  );
};

// ---------------------------------------------------------------------------
// Tools -> My groups
// ---------------------------------------------------------------------------
export const MyGroupsPopup: React.FC<{ token: string; onClose: () => void }> = ({ token, onClose }) => {
  const [items, setItems] = useState<MyGroup[] | null>(null);
  const [editing, setEditing] = useState<{ id?: number; name: string; members: string[] } | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const load = () =>
    mailFetch<{ mine: MyGroup[] }>(token, '/groups')
      .then((r) => setItems(r.mine))
      .catch((e) => {
        setError(e.message);
        setItems([]);
      });
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const save = async () => {
    if (!editing) return;
    setBusy(true);
    setError('');
    try {
      const body = { name: editing.name, members: editing.members };
      if (editing.id) await mailFetch(token, `/my-groups/${editing.id}`, { method: 'PUT', body });
      else await mailFetch(token, '/my-groups', { method: 'POST', body });
      forgetMailGroups();
      setEditing(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (g: MyGroup) => {
    if (!(await confirmDialog(`Delete the group "${g.name}"? The people in it aren't touched.`, { confirmLabel: 'Delete' }))) return;
    try {
      await mailFetch(token, `/my-groups/${g.id}`, { method: 'DELETE' });
      forgetMailGroups();
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <Sheet title={editing ? (editing.id ? 'Edit group' : 'New group') : 'My groups'} onClose={onClose}>
      {editing ? (
        <div className="space-y-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Group name</label>
            <input value={editing.name} onChange={(e) => setEditing({ ...editing, name: e.target.value })} placeholder="e.g. My team" className={inputCls} autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">People ({editing.members.length})</label>
            <PeoplePicker token={token} value={editing.members} onChange={(members) => setEditing({ ...editing, members })} />
            <p className="mt-1 text-[11px] text-slate-500">Search the Employee Directory, or type / paste any email address and press Enter.</p>
          </div>
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          <div className="flex justify-end gap-2 pt-1">
            <button type="button" onClick={() => { setEditing(null); setError(''); }} className="px-4 py-2 rounded-full text-sm text-slate-600 hover:bg-black/5">Cancel</button>
            <button type="button" disabled={busy} onClick={() => void save()} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-sky-600 disabled:opacity-60 inline-flex items-center gap-2">
              {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save
            </button>
          </div>
        </div>
      ) : (
        <>
          <p className="text-xs text-slate-600 mb-3">
            Your own lists of people. When writing a mail, type the group's name in To, Cc or Bcc and everyone in it is added. Only you see your groups.
          </p>
          {error && <div className="mb-3 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          {items === null ? (
            <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
          ) : (
            <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">
              {!items.length && <div className="px-4 py-6 text-center text-sm text-slate-500">No groups yet.</div>}
              {items.map((g) => (
                <div key={g.id} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="w-8 h-8 rounded-full bg-violet-100 text-violet-700 flex items-center justify-center shrink-0"><Users className="w-4 h-4" /></span>
                  <div className="flex-1 min-w-0">
                    <div className="text-sm font-medium text-slate-800 truncate">{g.name}</div>
                    <div className="text-[11px] text-slate-500 truncate">{g.members.length} {g.members.length === 1 ? 'person' : 'people'} · {g.members.slice(0, 3).join(', ')}{g.members.length > 3 ? '…' : ''}</div>
                  </div>
                  <button type="button" onClick={() => setEditing({ id: g.id, name: g.name, members: g.members })} className="p-1.5 rounded-full text-slate-500 hover:text-slate-900 hover:bg-black/5" aria-label={`Edit ${g.name}`}><Pencil className="w-4 h-4" /></button>
                  <button type="button" onClick={() => void remove(g)} className="p-1.5 rounded-full text-slate-400 hover:text-rose-600 hover:bg-rose-50" aria-label={`Delete ${g.name}`}><Trash2 className="w-4 h-4" /></button>
                </div>
              ))}
            </div>
          )}
          <button type="button" onClick={() => setEditing({ name: '', members: [] })} className="mt-4 w-full liquid-glass-button rounded-full px-5 py-2.5 text-sm font-semibold text-white bg-sky-600 inline-flex items-center justify-center gap-2">
            <Plus className="w-4 h-4" /> New group
          </button>
        </>
      )}
    </Sheet>
  );
};

// ---------------------------------------------------------------------------
// Mail Administration -> Groups
// ---------------------------------------------------------------------------
type SendPolicy = 'anyone' | 'members' | 'listed';
interface CentralGroupRow {
  id: number;
  email: string;
  name: string;
  description: string;
  members: string[];
  allEmployees: boolean;
  departments: string[];
  sendPolicy: SendPolicy;
  senders: string[];
  active: boolean;
  memberCount: number;
}
interface GroupList {
  items: CentralGroupRow[];
  canEdit: boolean;
  departments: string[];
  domains: string[];
}
type Draft = Omit<CentralGroupRow, 'id' | 'memberCount'> & { id?: number };
const POLICY_LABEL: Record<SendPolicy, string> = {
  anyone: 'Anyone on Credence Mail',
  members: 'Only its members',
  listed: 'Only the people listed'
};

// Not mailFetch: these calls must never carry X-Mail-View-As.
async function adminFetch<T>(token: string, path: string, method = 'GET', body?: any): Promise<T> {
  const res = await fetch(apiUrl(`/api/mail/admin${path}`), {
    method,
    headers: { Authorization: `Bearer ${token}`, ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: body !== undefined ? JSON.stringify(body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

const GroupEditor: React.FC<{ token: string; list: GroupList; draft: Draft; onClose: () => void; onSaved: () => void }> = ({ token, list, draft: start, onClose, onSaved }) => {
  const [d, setD] = useState<Draft>(start);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const domain = list.domains[0] || 'credencehousinglimited.com';
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      const body = { ...d, email: d.email.includes('@') ? d.email : d.email ? `${d.email}@${domain}` : '' };
      if (d.id) await adminFetch(token, `/groups/${d.id}`, 'PUT', body);
      else await adminFetch(token, '/groups', 'POST', body);
      forgetMailGroups();
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const toggleDept = (x: string) => setD({ ...d, departments: d.departments.includes(x) ? d.departments.filter((y) => y !== x) : [...d.departments, x] });
  return (
    <Sheet title={d.id ? `Edit ${start.name}` : 'New group'} onClose={onClose} wide>
      <div className="space-y-4">
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Group name</label>
            <input value={d.name} onChange={(e) => setD({ ...d, name: e.target.value })} placeholder="e.g. Accounts Team" className={inputCls} autoFocus />
          </div>
          <div>
            <label className="block text-xs font-medium text-slate-600 mb-1">Group address</label>
            <input value={d.email} onChange={(e) => setD({ ...d, email: e.target.value.trim() })} placeholder={`accounts-team@${domain}`} className={inputCls} inputMode="email" autoCapitalize="none" />
            {d.email && !d.email.includes('@') && <p className="mt-1 text-[11px] text-slate-500">{d.email}@{domain}</p>}
          </div>
        </div>
        <div>
          <label className="block text-xs font-medium text-slate-600 mb-1">Description (optional)</label>
          <input value={d.description} onChange={(e) => setD({ ...d, description: e.target.value })} placeholder="Who this group is for" className={inputCls} />
        </div>

        <div className="liquid-glass-inset rounded-[24px] p-3 space-y-3">
          <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5"><Users className="w-3.5 h-3.5" /> Members</div>
          <label className="flex items-start gap-2 text-sm text-slate-700">
            <input type="checkbox" className="mt-1" checked={d.allEmployees} onChange={(e) => setD({ ...d, allEmployees: e.target.checked })} />
            <span>
              Every active employee
              <span className="block text-[11px] text-slate-500">Read from the Employee Directory each time — joiners are in, leavers are out, nobody has to edit the group.</span>
            </span>
          </label>
          {!d.allEmployees && list.departments.length > 0 && (
            <div>
              <div className="text-[11px] text-slate-500 mb-1.5 flex items-center gap-1"><Building2 className="w-3.5 h-3.5" /> Everyone in these departments (also kept up to date):</div>
              <div className="flex flex-wrap gap-1.5">
                {list.departments.map((x) => (
                  <button
                    key={x}
                    type="button"
                    onClick={() => toggleDept(x)}
                    className={`text-xs px-2.5 py-1 rounded-full border ${d.departments.includes(x) ? 'bg-sky-600 border-sky-600 text-white' : 'bg-white/80 border-slate-200 text-slate-700 hover:bg-white'}`}
                  >
                    {x}
                  </button>
                ))}
              </div>
            </div>
          )}
          <div>
            <div className="text-[11px] text-slate-500 mb-1.5">{d.allEmployees || d.departments.length ? 'And these people too:' : 'These people:'}</div>
            <PeoplePicker token={token} value={d.members} onChange={(members) => setD({ ...d, members })} placeholder="Add people — name, email, ID… (an outside address works too)" />
          </div>
        </div>

        <div className="liquid-glass-inset rounded-[24px] p-3 space-y-2">
          <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5"><Lock className="w-3.5 h-3.5" /> Who may write to it</div>
          {(['members', 'anyone', 'listed'] as SendPolicy[]).map((p) => (
            <label key={p} className="flex items-center gap-2 text-sm text-slate-700">
              <input type="radio" name="sendPolicy" checked={d.sendPolicy === p} onChange={() => setD({ ...d, sendPolicy: p })} />
              {POLICY_LABEL[p]}
            </label>
          ))}
          {d.sendPolicy === 'listed' && <PeoplePicker token={token} value={d.senders} onChange={(senders) => setD({ ...d, senders })} placeholder="Who may write — name, email, ID…" />}
          <p className="text-[11px] text-slate-500">
            Mail to the group from Credence Mail reaches every member. Mail from outside CredenceHR (e.g. Gmail) to this address isn't covered — for that, set up a forwarder for it in cPanel.
          </p>
        </div>

        <label className="flex items-center gap-2 text-sm text-slate-700">
          <input type="checkbox" checked={d.active} onChange={(e) => setD({ ...d, active: e.target.checked })} />
          Group is on (when off, nobody can write to it)
        </label>

        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
        <div className="flex justify-end gap-2">
          <button type="button" onClick={onClose} className="px-4 py-2 rounded-full text-sm text-slate-600 hover:bg-black/5">Cancel</button>
          <button type="button" disabled={busy} onClick={() => void save()} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-sky-600 disabled:opacity-60 inline-flex items-center gap-2">
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} {d.id ? 'Save' : 'Create group'}
          </button>
        </div>
      </div>
    </Sheet>
  );
};

const GroupMembers: React.FC<{ token: string; group: CentralGroupRow; onClose: () => void }> = ({ token, group, onClose }) => {
  const [rows, setRows] = useState<{ email: string; name: string; employeeId: string; designation: string; department: string }[] | null>(null);
  const [error, setError] = useState('');
  const [q, setQ] = useState('');
  useEffect(() => {
    adminFetch<typeof rows>(token, `/groups/${group.id}/members`).then(setRows).catch((e) => {
      setError(e.message);
      setRows([]);
    });
  }, [token, group.id]);
  const shown = (rows || []).filter((r) => !q.trim() || `${r.name} ${r.email} ${r.employeeId} ${r.designation} ${r.department}`.toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Sheet title={`${group.name} — who it reaches`} onClose={onClose}>
      <div className="text-xs text-slate-500 mb-2">{group.email}</div>
      <div className="relative mb-2">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search members" className={`${inputCls} pl-9`} />
      </div>
      {error && <div className="mb-2 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {rows === null ? (
        <div className="py-8 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
      ) : (
        <>
          <div className="text-[11px] text-slate-500 mb-1 px-1">{rows.length} {rows.length === 1 ? 'person' : 'people'}</div>
          <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60 max-h-[55vh] overflow-y-auto">
            {!shown.length && <div className="px-4 py-6 text-center text-sm text-slate-500">No one.</div>}
            {shown.map((r) => (
              <div key={r.email} className="px-3 py-2">
                <div className="flex items-center gap-1.5 min-w-0">
                  <span className="text-sm font-medium text-slate-800 truncate">{r.name || r.email}</span>
                  {r.employeeId && <span className="text-[10px] font-semibold px-1.5 py-px rounded bg-slate-100 text-slate-600 shrink-0">ID {r.employeeId}</span>}
                </div>
                <div className="text-[11px] text-slate-500 truncate">
                  {[r.designation, r.department].filter(Boolean).join(' · ')}
                  {(r.designation || r.department) && ' · '}
                  {r.email}
                </div>
              </div>
            ))}
          </div>
        </>
      )}
    </Sheet>
  );
};

export const CentralGroupsAdmin: React.FC<{ token: string }> = ({ token }) => {
  const [list, setList] = useState<GroupList | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<Draft | null>(null);
  const [viewing, setViewing] = useState<CentralGroupRow | null>(null);
  const load = () =>
    adminFetch<GroupList>(token, '/groups')
      .then((r) => {
        setList(r);
        setError('');
      })
      .catch((e) => setError(e.message));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  const remove = async (g: CentralGroupRow) => {
    if (!(await confirmDialog(`Delete the group ${g.name} (${g.email})? Mail sent to it after this goes nowhere inside CredenceHR.`, { confirmLabel: 'Delete group' }))) return;
    try {
      await adminFetch(token, `/groups/${g.id}`, 'DELETE');
      forgetMailGroups();
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const ruleText = (g: CentralGroupRow) =>
    [
      g.allEmployees ? 'Every active employee' : '',
      !g.allEmployees && g.departments.length ? `Departments: ${g.departments.join(', ')}` : '',
      g.members.length ? `${g.members.length} added by hand` : ''
    ]
      .filter(Boolean)
      .join(' · ');
  return (
    <div className="space-y-3">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <p className="text-xs text-slate-600 max-w-2xl">
          A group is one address on our domain (e.g. accounts-team@…) that reaches everyone in it. Anyone allowed can pick it in To / Cc / Bcc in Credence Mail; the mail goes to every member —
          inside CredenceHR for colleagues, through the mail server for outside addresses.
        </p>
        {list?.canEdit && (
          <button
            type="button"
            onClick={() => setEditing({ email: '', name: '', description: '', members: [], allEmployees: false, departments: [], sendPolicy: 'members', senders: [], active: true })}
            className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-sky-600 text-white hover:bg-sky-700"
          >
            <Plus className="w-4 h-4" /> New group
          </button>
        )}
      </div>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {!list && !error ? (
        <div className="py-10 flex justify-center"><Loader2 className="w-5 h-5 animate-spin text-slate-400" /></div>
      ) : list && !list.items.length ? (
        <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">No groups yet.</div>
      ) : (
        list && (
          <div className="rounded-2xl bg-white border border-slate-200 overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead className="bg-slate-50 text-left text-[11px] uppercase tracking-wider text-slate-500">
                  <tr>
                    <th className="px-4 py-2.5 font-semibold">Group</th>
                    <th className="px-4 py-2.5 font-semibold">Members</th>
                    <th className="px-4 py-2.5 font-semibold">Who may write</th>
                    <th className="px-4 py-2.5 font-semibold text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {list.items.map((g) => (
                    <tr key={g.id} className="align-top">
                      <td className="px-4 py-3">
                        <div className="font-medium text-slate-900 flex items-center gap-1.5">
                          {g.name}
                          {!g.active && <span className="text-[10px] font-semibold px-1.5 py-px rounded-full bg-slate-100 text-slate-500">Off</span>}
                        </div>
                        <div className="text-[11px] text-sky-700">{g.email}</div>
                        {g.description && <div className="text-[11px] text-slate-500">{g.description}</div>}
                      </td>
                      <td className="px-4 py-3">
                        <div className="text-slate-800">{g.memberCount} {g.memberCount === 1 ? 'person' : 'people'}</div>
                        <div className="text-[11px] text-slate-500">{ruleText(g)}</div>
                      </td>
                      <td className="px-4 py-3 text-[12px] text-slate-700">
                        <span className="inline-flex items-center gap-1">
                          {g.sendPolicy === 'anyone' ? <Globe className="w-3.5 h-3.5" /> : g.sendPolicy === 'members' ? <UserCheck className="w-3.5 h-3.5" /> : <ListChecks className="w-3.5 h-3.5" />}
                          {POLICY_LABEL[g.sendPolicy]}
                          {g.sendPolicy === 'listed' ? ` (${g.senders.length})` : ''}
                        </span>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex flex-wrap justify-end items-center gap-2">
                          <button type="button" onClick={() => setViewing(g)} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
                            <Users className="w-3.5 h-3.5" /> Members
                          </button>
                          {list.canEdit && (
                            <>
                              <button type="button" onClick={() => setEditing({ ...g })} className="inline-flex items-center gap-1.5 px-2.5 py-1.5 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
                                <Pencil className="w-3.5 h-3.5" /> Edit
                              </button>
                              <button type="button" onClick={() => void remove(g)} className="p-1.5 rounded-xl text-slate-400 hover:text-rose-600 hover:bg-rose-50" aria-label={`Delete ${g.name}`}>
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </>
                          )}
                        </div>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        )
      )}
      {list && !list.canEdit && (
        <div className="text-[11px] text-slate-500 flex items-center gap-1"><Lock className="w-3.5 h-3.5" /> Adding or changing groups needs the "Set up mail groups" permission.</div>
      )}
      {editing && list && (
        <GroupEditor
          token={token}
          list={list}
          draft={editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            void load();
          }}
        />
      )}
      {viewing && <GroupMembers token={token} group={viewing} onClose={() => setViewing(null)} />}
    </div>
  );
};
