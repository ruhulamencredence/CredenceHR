/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Companies (Superadmin only): the companies of this group and
// who may work in which (CompanyRoutes.ts).
//   Companies — add / edit a company: name, short code (prefixes Employee IDs
//               and letter numbers), mother company, contact details, logo.
//   Access    — tick the companies each account may switch into, pick their
//               default, and copy an account's Module Access from one company
//               to others (shared-service HR).

import React, { useCallback, useEffect, useState } from 'react';
import { Building2, Copy, Crown, Globe, ImagePlus, Pencil, Plus, Search, Users } from 'lucide-react';
import { PlatformWorkspaces } from './PlatformWorkspaces';
import { Spinner } from './Spinner';
import { readFileBase64 } from './HrOps360Parts';
import { useHrApi, Modal, Notice, inputCls, labelCls, btnPrimary, btnGhost } from './HrOpsShared';

interface Company {
  id: number;
  name: string;
  short_code: string;
  is_mother: boolean;
  address: string | null;
  phone: string | null;
  email: string | null;
  website: string | null;
  has_logo: boolean;
  is_active: boolean;
  employee_count: number;
  additional_employee_count: number;
  user_count: number;
}
interface AccessUser {
  id: number;
  name: string;
  email: string | null;
  role: string;
  company_ids: number[];
  default_company_id: number | null;
  module_counts: Record<number, number>;
}
type Msg = { type: 'success' | 'error'; text: string } | null;

const CompanyForm: React.FC<{ token: string; company: Company | null; onClose: () => void; onSaved: (t: string) => void }> = ({ token, company, onClose, onSaved }) => {
  const api = useHrApi(token);
  const [f, setF] = useState({
    name: company?.name || '',
    short_code: company?.short_code || '',
    is_mother: company?.is_mother || false,
    address: company?.address || '',
    phone: company?.phone || '',
    email: company?.email || '',
    website: company?.website || '',
    is_active: company ? company.is_active : true
  });
  const [logo, setLogo] = useState<{ mime: string; data: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));
  const pickLogo = async (file?: File) => {
    if (!file) return;
    const { base64, mime } = await readFileBase64(file);
    setLogo({ mime, data: base64, preview: `data:${mime};base64,${base64}` });
  };
  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body = { ...f, logo: logo ? { mime: logo.mime, data: logo.data } : undefined };
      if (company) await api.put(`/api/system/companies/${company.id}`, body);
      else await api.post('/api/system/companies', body);
      onSaved(company ? 'Company updated.' : 'Company added.');
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={company ? `Edit ${company.name}` : 'Add company'}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={busy} onClick={save}>
            {busy && <Spinner />} Save
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <div className="grid grid-cols-3 gap-3">
          <div className="col-span-2">
            <label className={labelCls}>Company name *</label>
            <input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Credence Properties Ltd" />
          </div>
          <div>
            <label className={labelCls}>Short code *</label>
            <input className={`${inputCls} uppercase`} value={f.short_code} maxLength={8} onChange={(e) => set('short_code', e.target.value.toUpperCase())} placeholder="CPL" />
          </div>
        </div>
        <p className="text-[11px] text-slate-500 -mt-1">The short code starts this company's Employee IDs and letter numbers (e.g. CPL-0001).</p>
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Phone</label>
            <input className={inputCls} value={f.phone} onChange={(e) => set('phone', e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>Email</label>
            <input className={inputCls} value={f.email} onChange={(e) => set('email', e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Address</label>
            <input className={inputCls} value={f.address} onChange={(e) => set('address', e.target.value)} />
          </div>
          <div className="sm:col-span-2">
            <label className={labelCls}>Website</label>
            <input className={inputCls} value={f.website} onChange={(e) => set('website', e.target.value)} />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className={`${btnGhost} cursor-pointer`}>
            <ImagePlus className="w-3.5 h-3.5" /> {company?.has_logo || logo ? 'Change logo' : 'Upload logo'}
            <input type="file" accept="image/*" className="hidden" onChange={(e) => pickLogo(e.target.files?.[0])} />
          </label>
          {logo ? (
            <img src={logo.preview} alt="" className="h-10 max-w-[120px] object-contain" />
          ) : company?.has_logo ? (
            <span className="text-[11px] text-slate-500">Logo on file</span>
          ) : null}
        </div>
        <label className="flex items-center gap-2 text-xs">
          <input type="checkbox" checked={f.is_mother} onChange={(e) => set('is_mother', e.target.checked)} /> Mother company of the group
        </label>
        {company && !company.is_mother && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active
          </label>
        )}
      </div>
    </Modal>
  );
};

const CopyModal: React.FC<{ token: string; user: AccessUser; companies: Company[]; onClose: () => void; onDone: (t: string) => void }> = ({
  token,
  user,
  companies,
  onClose,
  onDone
}) => {
  const api = useHrApi(token);
  const withModules = companies.filter((c) => user.module_counts[c.id]);
  const [from, setFrom] = useState<number>(withModules[0]?.id || companies[0]?.id);
  const [to, setTo] = useState<Set<number>>(new Set());
  const [msg, setMsg] = useState<Msg>(null);
  const go = async () => {
    try {
      const d = await api.post(`/api/system/company-access/${user.id}/copy-permissions`, { from_company_id: from, to_company_ids: [...to] });
      onDone(`${user.name}: ${d.modules} module(s) copied to ${d.companies} company(ies).`);
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  return (
    <Modal
      title={`Copy Module Access — ${user.name}`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={!to.size} onClick={go}>
            <Copy className="w-3.5 h-3.5" /> Copy
          </button>
        </>
      }
    >
      <div className="space-y-3 text-xs">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <p className="text-slate-600">
          Gives this account the same modules (and action levels) in the chosen companies as it has in one company — for HR who serve the whole group. Their
          existing Module Access in the target companies is replaced.
        </p>
        <div>
          <label className={labelCls}>Copy from</label>
          <select className={inputCls} value={from} onChange={(e) => setFrom(Number(e.target.value))}>
            {companies.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name} ({user.module_counts[c.id] || 0} modules)
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className={labelCls}>To</label>
          <div className="space-y-1">
            {companies
              .filter((c) => c.id !== from)
              .map((c) => (
                <label key={c.id} className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={to.has(c.id)}
                    onChange={(e) =>
                      setTo((s) => {
                        const n = new Set(s);
                        if (e.target.checked) n.add(c.id);
                        else n.delete(c.id);
                        return n;
                      })
                    }
                  />
                  {c.name}
                </label>
              ))}
          </div>
        </div>
      </div>
    </Modal>
  );
};

export const SystemCompanies: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [tab, setTab] = useState<'companies' | 'access' | 'workspaces'>('companies');
  const [platformAdmin, setPlatformAdmin] = useState(false);
  const [workspaceCode, setWorkspaceCode] = useState<string | null>(null);
  const [companies, setCompanies] = useState<Company[] | null>(null);
  const [groupName, setGroupName] = useState('');
  const [users, setUsers] = useState<AccessUser[] | null>(null);
  const [edit, setEdit] = useState<Company | 'new' | null>(null);
  const [copyFor, setCopyFor] = useState<AccessUser | null>(null);
  const [q, setQ] = useState('');
  const [msg, setMsg] = useState<Msg>(null);
  const load = useCallback(() => {
    api
      .get('/api/system/companies')
      .then((d) => {
        setCompanies(d.companies);
        setGroupName(d.group?.name || '');
        setWorkspaceCode(d.group?.workspace_code || null);
        setPlatformAdmin(!!d.is_platform_admin);
      })
      .catch((e) => setMsg({ type: 'error', text: e.message }));
    api
      .get('/api/system/company-access')
      .then((d) => setUsers(d.users))
      .catch(() => setUsers([]));
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);

  const saveAccess = async (u: AccessUser, ids: number[], def: number | null) => {
    try {
      await api.put(`/api/system/company-access/${u.id}`, { company_ids: ids, default_company_id: def });
      setUsers((list) => (list || []).map((x) => (x.id === u.id ? { ...x, company_ids: ids, default_company_id: def && ids.includes(def) ? def : ids[0] } : x)));
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };

  if (!companies) return <div className="py-10 flex justify-center"><Spinner /></div>;
  const active = companies.filter((c) => c.is_active);
  const shown = (users || []).filter((u) => !q.trim() || [u.name, u.email].some((v) => String(v || '').toLowerCase().includes(q.trim().toLowerCase())));

  return (
    <div className="space-y-4">
      <div className="flex items-start justify-between gap-3 flex-wrap">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Building2 className="w-5 h-5 text-blue-600" /> Companies {groupName && <span className="text-sm font-medium text-slate-500">· {groupName}</span>}
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            The group's companies, and which accounts may work in each.
            {workspaceCode && (
              <>
                {' '}
                Sign-in workspace: <span className="font-mono font-semibold text-slate-700">{workspaceCode}</span>
              </>
            )}
          </p>
        </div>
        {tab === 'companies' && (
          <button type="button" className={btnPrimary} onClick={() => setEdit('new')}>
            <Plus className="w-3.5 h-3.5" /> Add company
          </button>
        )}
      </div>
      <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
        Kept apart per company now: employees, departments, branches, projects, attendance, leave, payroll, claims and HR records. Still shared by the
        whole group for now (next step): holiday calendar, leave types and policies, letter templates, notices, assets, vehicles, approval templates and chat.
      </div>
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="flex gap-1 border-b border-slate-200">
        {(
          [
            ['companies', 'Companies', Building2],
            ['access', 'Who can work where', Users],
            ...(platformAdmin ? ([['workspaces', 'Workspaces (all groups)', Globe]] as const) : [])
          ] as const
        ).map(([k, label, Icon]) => (
          <button
            key={k}
            type="button"
            onClick={() => setTab(k)}
            className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-2 border-b-2 -mb-px ${tab === k ? 'border-blue-600 text-blue-700' : 'border-transparent text-slate-500'}`}
          >
            <Icon className="w-3.5 h-3.5" /> {label}
          </button>
        ))}
      </div>

      {tab === 'workspaces' && platformAdmin && <PlatformWorkspaces token={token} />}

      {tab === 'companies' && (
        <div className="grid md:grid-cols-2 gap-3">
          {companies.map((c) => (
            <div key={c.id} className={`rounded-xl border bg-white p-4 ${c.is_active ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
              <div className="flex items-start justify-between gap-2">
                <div className="flex items-center gap-3 min-w-0">
                  {c.has_logo ? (
                    <AuthedImg token={token} src={`/api/companies/${c.id}/logo`} className="h-10 w-10 object-contain rounded-md border border-slate-100" />
                  ) : (
                    <div className="h-10 w-10 rounded-md bg-slate-100 flex items-center justify-center text-[10px] font-bold text-slate-500">{c.short_code}</div>
                  )}
                  <div className="min-w-0">
                    <div className="text-sm font-semibold text-slate-800 truncate flex items-center gap-1.5">
                      {c.name}
                      {c.is_mother && (
                        <span className="inline-flex items-center gap-0.5 text-[10px] font-semibold text-amber-700 bg-amber-50 border border-amber-200 rounded-full px-1.5">
                          <Crown className="w-3 h-3" /> Mother
                        </span>
                      )}
                      {!c.is_active && <span className="text-[10px] text-slate-500">(inactive)</span>}
                    </div>
                    <div className="text-[11px] text-slate-500">Code {c.short_code}</div>
                  </div>
                </div>
                <button type="button" className={btnGhost} onClick={() => setEdit(c)} aria-label={`Edit ${c.name}`}>
                  <Pencil className="w-3.5 h-3.5" />
                </button>
              </div>
              <div className="grid grid-cols-3 gap-2 mt-3 text-center">
                <div className="rounded-lg bg-slate-50 py-2">
                  <div className="text-base font-bold text-slate-800">{c.employee_count}</div>
                  <div className="text-[10px] text-slate-500">Employees</div>
                </div>
                <div className="rounded-lg bg-slate-50 py-2">
                  <div className="text-base font-bold text-slate-800">{c.additional_employee_count}</div>
                  <div className="text-[10px] text-slate-500">Also working here</div>
                </div>
                <div className="rounded-lg bg-slate-50 py-2">
                  <div className="text-base font-bold text-slate-800">{c.user_count}</div>
                  <div className="text-[10px] text-slate-500">Accounts</div>
                </div>
              </div>
              {(c.address || c.phone || c.email) && <div className="text-[11px] text-slate-500 mt-2">{[c.address, c.phone, c.email].filter(Boolean).join(' · ')}</div>}
            </div>
          ))}
        </div>
      )}

      {tab === 'access' && (
        <div className="space-y-2">
          <div className="relative max-w-sm">
            <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input className={`${inputCls} pl-8`} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find an account…" />
          </div>
          <div className="rounded-xl border border-slate-200 bg-white overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left px-3 py-2">Account</th>
                  {active.map((c) => (
                    <th key={c.id} className="px-3 py-2 text-center whitespace-nowrap" title={c.name}>
                      {c.short_code}
                    </th>
                  ))}
                  <th className="text-left px-3 py-2">Default</th>
                  <th />
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {shown.map((u) => {
                  const isSa = u.role === 'superadmin';
                  return (
                    <tr key={u.id}>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-800">{u.name}</div>
                        <div className="text-[10px] text-slate-500">
                          {u.email || '—'} · {u.role}
                        </div>
                      </td>
                      {active.map((c) => {
                        const on = u.company_ids.includes(c.id);
                        return (
                          <td key={c.id} className="px-3 py-2 text-center">
                            <input
                              type="checkbox"
                              aria-label={`${u.name} in ${c.short_code}`}
                              checked={on}
                              disabled={isSa}
                              onChange={(e) => {
                                const ids = e.target.checked ? [...u.company_ids, c.id] : u.company_ids.filter((x) => x !== c.id);
                                if (!ids.length) return setMsg({ type: 'error', text: 'An account needs at least one company.' });
                                saveAccess(u, ids, u.default_company_id);
                              }}
                            />
                            {on && !isSa && <div className="text-[9px] text-slate-400">{u.module_counts[c.id] || 0} mod.</div>}
                          </td>
                        );
                      })}
                      <td className="px-3 py-2">
                        {isSa ? (
                          <span className="text-slate-400">All companies</span>
                        ) : (
                          <select
                            className={`${inputCls} !py-1 !text-xs`}
                            value={u.default_company_id || ''}
                            onChange={(e) => saveAccess(u, u.company_ids, Number(e.target.value))}
                          >
                            {active
                              .filter((c) => u.company_ids.includes(c.id))
                              .map((c) => (
                                <option key={c.id} value={c.id}>
                                  {c.short_code}
                                </option>
                              ))}
                          </select>
                        )}
                      </td>
                      <td className="px-3 py-2 text-right">
                        {!isSa && active.length > 1 && (
                          <button type="button" className={btnGhost} onClick={() => setCopyFor(u)} title="Copy Module Access to other companies">
                            <Copy className="w-3.5 h-3.5" /> Copy access
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="text-[11px] text-slate-500">
            Module Access itself is set per company in Users → Module Access, while that company is selected in the header. The Superadmin can enter every company.
          </p>
        </div>
      )}

      {edit && (
        <CompanyForm
          token={token}
          company={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={(t) => {
            setEdit(null);
            setMsg({ type: 'success', text: t });
            load();
          }}
        />
      )}
      {copyFor && (
        <CopyModal
          token={token}
          user={copyFor}
          companies={active}
          onClose={() => setCopyFor(null)}
          onDone={(t) => {
            setCopyFor(null);
            setMsg({ type: 'success', text: t });
            load();
          }}
        />
      )}
    </div>
  );
};

// <img> for an endpoint that needs the Authorization header.
const AuthedImg: React.FC<{ token: string; src: string; className?: string }> = ({ token, src, className }) => {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let revoke: string | null = null;
    fetch(src, { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.blob() : null))
      .then((b) => {
        if (b) setUrl((revoke = URL.createObjectURL(b)));
      })
      .catch(() => {});
    return () => {
      if (revoke) URL.revokeObjectURL(revoke);
    };
  }, [token, src]);
  return url ? <img src={url} alt="" className={className} /> : <div className={className} />;
};
