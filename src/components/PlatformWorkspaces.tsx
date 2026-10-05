/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Companies -> Workspaces (the system owner only): every group
// using the app. A workspace is what people type on the page before the login
// form (e.g. "credence"); it shows that group's logo and name on its sign-in
// page. Creating one also creates its companies (the first is the mother
// company) and its own Superadmin, who then runs it from Companies. The
// system owner can open any workspace (working there as its Superadmin — each
// visit is recorded below) and add, reset or remove a workspace's Superadmins.

import React, { useCallback, useEffect, useState } from 'react';
import { Globe, ImagePlus, KeyRound, Lock, LogIn, Pencil, Plus, Trash2, UserPlus } from 'lucide-react';
import { switchCompany } from '../lib/company';
import { Spinner } from './Spinner';
import { readFileBase64 } from './HrOps360Parts';
import { useHrApi, Modal, Notice, TypeToDelete, inputCls, labelCls, btnPrimary, btnGhost } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

interface Workspace {
  id: number;
  code: string;
  name: string;
  short_name: string | null;
  tagline: string | null;
  has_logo: boolean;
  is_active: boolean;
  can_sign_in: boolean;
  companies: { id: number; name: string; short_code: string; is_mother: boolean }[];
  superadmins: { id: number; name: string; email: string }[];
  user_count: number;
}
type Msg = { type: 'success' | 'error'; text: string } | null;
// The system owner's own workspace — never deleted.
const HOME_GROUP_ID = 1;

const WorkspaceForm: React.FC<{ token: string; ws: Workspace | null; onClose: () => void; onSaved: (t: string) => void }> = ({ token, ws, onClose, onSaved }) => {
  const api = useHrApi(token);
  const [f, setF] = useState({
    name: ws?.name || '',
    short_name: ws?.short_name || '',
    workspace_code: ws?.code || '',
    tagline: ws?.tagline || '',
    is_active: ws ? ws.is_active : true
  });
  const [companies, setCompanies] = useState([{ name: '', short_code: '' }]);
  const [admin, setAdmin] = useState({ name: '', email: '', password: '' });
  const [logo, setLogo] = useState<{ mime: string; data: string; preview: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const set = (k: string, v: any) => setF((p) => ({ ...p, [k]: v }));

  const save = async () => {
    setBusy(true);
    setMsg(null);
    try {
      const body: any = { ...f, logo: logo ? { mime: logo.mime, data: logo.data } : undefined };
      if (ws) await api.put(`/api/platform/workspaces/${ws.id}`, body);
      else await api.post('/api/platform/workspaces', { ...body, companies, admin });
      onSaved(ws ? 'Workspace updated.' : `Workspace "${f.workspace_code}" created with its Superadmin.`);
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal
      title={ws ? `Edit workspace — ${ws.name}` : 'New workspace'}
      onClose={onClose}
      wide
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
      <div className="space-y-4">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <div className="grid sm:grid-cols-2 gap-3">
          <div>
            <label className={labelCls}>Group name *</label>
            <input className={inputCls} value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. ABC Group" />
          </div>
          <div>
            <label className={labelCls}>Workspace (typed before sign-in) *</label>
            <input
              className={`${inputCls} lowercase`}
              value={f.workspace_code}
              onChange={(e) => set('workspace_code', e.target.value.replace(/\s+/g, '').toLowerCase())}
              placeholder="e.g. abc"
            />
          </div>
          <div>
            <label className={labelCls}>Short name (shown on the sign-in page)</label>
            <input className={inputCls} value={f.short_name} onChange={(e) => set('short_name', e.target.value)} placeholder="e.g. ABC" />
          </div>
          <div>
            <label className={labelCls}>Tagline</label>
            <input className={inputCls} value={f.tagline} onChange={(e) => set('tagline', e.target.value)} placeholder="Optional line under the name" />
          </div>
        </div>
        <div className="flex items-center gap-3">
          <label className={`${btnGhost} cursor-pointer`}>
            <ImagePlus className="w-3.5 h-3.5" /> {ws?.has_logo || logo ? 'Change sign-in logo' : 'Upload sign-in logo'}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={async (e) => {
                const file = e.target.files?.[0];
                if (!file) return;
                const { base64, mime } = await readFileBase64(file);
                setLogo({ mime, data: base64, preview: `data:${mime};base64,${base64}` });
              }}
            />
          </label>
          {logo && <img src={logo.preview} alt="" className="h-10 max-w-[140px] object-contain" />}
        </div>
        {ws && ws.id !== 1 && (
          <label className="flex items-center gap-2 text-xs">
            <input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} /> Active (switch off to close this workspace)
          </label>
        )}

        {!ws && (
          <>
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-1">Companies — the first one is the mother company</div>
              <div className="space-y-2">
                {companies.map((c, i) => (
                  <div key={i} className="flex gap-2 items-center">
                    <span className="w-16 text-[10px] font-semibold text-slate-500 shrink-0">{i === 0 ? 'Mother' : 'Sister'}</span>
                    <input
                      className={inputCls}
                      value={c.name}
                      placeholder="Company name"
                      onChange={(e) => setCompanies((l) => l.map((x, j) => (j === i ? { ...x, name: e.target.value } : x)))}
                    />
                    <input
                      className={`${inputCls} !w-28 uppercase`}
                      value={c.short_code}
                      maxLength={8}
                      placeholder="Code"
                      onChange={(e) => setCompanies((l) => l.map((x, j) => (j === i ? { ...x, short_code: e.target.value.toUpperCase() } : x)))}
                    />
                    {i > 0 && (
                      <button type="button" className={btnGhost} onClick={() => setCompanies((l) => l.filter((_, j) => j !== i))} aria-label="Remove company">
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                ))}
              </div>
              <button type="button" className={`${btnGhost} mt-2`} onClick={() => setCompanies((l) => [...l, { name: '', short_code: '' }])}>
                <Plus className="w-3.5 h-3.5" /> Add sister company
              </button>
            </div>
            <div>
              <div className="text-xs font-semibold text-slate-700 mb-1">Their Superadmin (runs this workspace)</div>
              <div className="grid sm:grid-cols-3 gap-2">
                <input className={inputCls} placeholder="Name" value={admin.name} onChange={(e) => setAdmin((a) => ({ ...a, name: e.target.value }))} />
                <input className={inputCls} placeholder="Email" value={admin.email} onChange={(e) => setAdmin((a) => ({ ...a, email: e.target.value }))} />
                <input
                  className={inputCls}
                  type="password"
                  placeholder="Password (8+)"
                  value={admin.password}
                  onChange={(e) => setAdmin((a) => ({ ...a, password: e.target.value }))}
                />
              </div>
            </div>
          </>
        )}
      </div>
    </Modal>
  );
};

// Add / reset password / remove a workspace's Superadmins.
const SuperadminsModal: React.FC<{ token: string; ws: Workspace; onClose: () => void; onChanged: () => void }> = ({ token, ws, onClose, onChanged }) => {
  const api = useHrApi(token);
  const [add, setAdd] = useState({ name: '', email: '', password: '' });
  const [reset, setReset] = useState<{ id: number; password: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [msg, setMsg] = useState<Msg>(null);
  const run = async (fn: () => Promise<any>, ok: string) => {
    setBusy(true);
    setMsg(null);
    try {
      await fn();
      setMsg({ type: 'success', text: ok });
      onChanged();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(false);
    }
  };
  return (
    <Modal
      title={`Superadmins — ${ws.name}`}
      onClose={onClose}
      wide
      footer={
        <button type="button" className={btnGhost} onClick={onClose}>
          Close
        </button>
      }
    >
      <div className="space-y-4">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <div className="space-y-2">
          {ws.superadmins.map((u) => (
            <div key={u.id} className="rounded-lg border border-slate-200 p-2.5">
              <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800">{u.name}</div>
                  <div className="text-[11px] text-slate-500">{u.email}</div>
                </div>
                <div className="flex gap-1.5">
                  <button type="button" className={btnGhost} onClick={() => setReset(reset?.id === u.id ? null : { id: u.id, password: '' })}>
                    <KeyRound className="w-3.5 h-3.5" /> Reset password
                  </button>
                  {ws.superadmins.length > 1 && (
                    <button
                      type="button"
                      className={btnGhost}
                      disabled={busy}
                      onClick={async () => {
                        if ((await confirmDialog(`Remove ${u.name} as Superadmin? The account stays as an Admin of ${ws.name}.`)))
                          run(() => api.del(`/api/platform/workspaces/${ws.id}/superadmins/${u.id}`), `${u.name} is no longer a Superadmin.`);
                      }}
                    >
                      <Trash2 className="w-3.5 h-3.5" /> Remove
                    </button>
                  )}
                </div>
              </div>
              {reset?.id === u.id && (
                <div className="mt-2 flex gap-2">
                  <input
                    className={inputCls}
                    type="password"
                    placeholder="New password (8+)"
                    value={reset.password}
                    onChange={(e) => setReset({ id: u.id, password: e.target.value })}
                  />
                  <button
                    type="button"
                    className={btnPrimary}
                    disabled={busy}
                    onClick={() =>
                      run(() => api.put(`/api/platform/workspaces/${ws.id}/superadmins/${u.id}/password`, { password: reset.password }), `Password changed for ${u.name}.`).then(() =>
                        setReset(null)
                      )
                    }
                  >
                    Save
                  </button>
                </div>
              )}
            </div>
          ))}
          {!ws.superadmins.length && <div className="text-xs text-slate-500">No Superadmin yet — add one below.</div>}
        </div>
        <div>
          <div className="text-xs font-semibold text-slate-700 mb-1">Add a Superadmin</div>
          <div className="grid sm:grid-cols-3 gap-2">
            <input className={inputCls} placeholder="Name" value={add.name} onChange={(e) => setAdd((a) => ({ ...a, name: e.target.value }))} />
            <input className={inputCls} placeholder="Email" value={add.email} onChange={(e) => setAdd((a) => ({ ...a, email: e.target.value }))} />
            <input
              className={inputCls}
              type="password"
              placeholder="Password (8+)"
              value={add.password}
              onChange={(e) => setAdd((a) => ({ ...a, password: e.target.value }))}
            />
          </div>
          <button
            type="button"
            className={`${btnPrimary} mt-2`}
            disabled={busy}
            onClick={() =>
              run(() => api.post(`/api/platform/workspaces/${ws.id}/superadmins`, add), `${add.name} can now sign in to "${ws.code}" as Superadmin.`).then(() =>
                setAdd({ name: '', email: '', password: '' })
              )
            }
          >
            {busy && <Spinner />} <UserPlus className="w-3.5 h-3.5" /> Add
          </button>
        </div>
      </div>
    </Modal>
  );
};

interface Visit {
  id: number;
  user: string;
  workspace: string;
  company: string;
  visited_at: string;
}

export const PlatformWorkspaces: React.FC<{ token: string }> = ({ token }) => {
  const api = useHrApi(token);
  const [list, setList] = useState<Workspace[] | null>(null);
  const [edit, setEdit] = useState<Workspace | 'new' | null>(null);
  const [admins, setAdmins] = useState<Workspace | null>(null);
  const [removing, setRemoving] = useState<Workspace | null>(null);
  const [visits, setVisits] = useState<Visit[]>([]);
  const [msg, setMsg] = useState<Msg>(null);
  const load = useCallback(() => {
    api
      .get('/api/platform/workspaces')
      .then((d) => {
        setList(d.workspaces);
        setAdmins((cur) => (cur ? d.workspaces.find((w: Workspace) => w.id === cur.id) || null : null));
      })
      .catch((e) => {
        setList([]);
        setMsg({ type: 'error', text: e.message });
      });
    api
      .get('/api/platform/visits')
      .then((v) => setVisits(Array.isArray(v) ? v : []))
      .catch(() => setVisits([]));
  }, [api]);
  useEffect(() => {
    load();
  }, [load]);
  if (!list) return <div className="py-10 flex justify-center"><Spinner /></div>;
  return (
    <div className="space-y-3">
      <div className="flex items-center justify-between gap-2 flex-wrap">
        <p className="text-xs text-slate-500">
          Each group signs in through its own workspace, typed on the page before the login form. As the system owner you can open any of them and work there as its Superadmin.
        </p>
        <button type="button" className={btnPrimary} onClick={() => setEdit('new')}>
          <Plus className="w-3.5 h-3.5" /> New workspace
        </button>
      </div>
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="grid md:grid-cols-2 gap-3">
        {list.map((w) => (
          <div key={w.id} className={`rounded-xl border bg-white p-4 ${w.is_active ? 'border-slate-200' : 'border-slate-200 opacity-60'}`}>
            <div className="flex items-start justify-between gap-2">
              <div className="min-w-0">
                <div className="text-sm font-semibold text-slate-800">{w.name}</div>
                <div className="text-[11px] text-slate-500 flex items-center gap-1">
                  <Globe className="w-3 h-3" /> Workspace: <span className="font-mono font-semibold text-slate-700">{w.code}</span>
                </div>
              </div>
              <button type="button" className={btnGhost} onClick={() => setEdit(w)} aria-label={`Edit ${w.name}`}>
                <Pencil className="w-3.5 h-3.5" />
              </button>
            </div>
            <div className="text-[11px] text-slate-600 mt-2 space-y-0.5">
              <div>
                Companies: {w.companies.map((c) => `${c.name} (${c.short_code})${c.is_mother ? ' ★' : ''}`).join(', ') || '—'}
              </div>
              <div>Superadmin: {w.superadmins.map((u) => `${u.name} — ${u.email}`).join(', ') || '—'}</div>
              <div>{w.user_count} account(s)</div>
            </div>
            <div className="mt-3 flex gap-1.5 flex-wrap">
              {w.is_active && w.companies.length > 0 && (
                <button
                  type="button"
                  className={btnPrimary}
                  onClick={() => switchCompany((w.companies.find((c) => c.is_mother) || w.companies[0]).id)}
                  title={`Work inside ${w.name} as its Superadmin`}
                >
                  <LogIn className="w-3.5 h-3.5" /> Open
                </button>
              )}
              <button type="button" className={btnGhost} onClick={() => setAdmins(w)}>
                <UserPlus className="w-3.5 h-3.5" /> Superadmins
              </button>
              {w.id !== HOME_GROUP_ID && (
                <button type="button" className={`${btnGhost} text-rose-600`} onClick={() => setRemoving(w)} aria-label={`Delete ${w.name}`}>
                  <Trash2 className="w-3.5 h-3.5" /> Delete
                </button>
              )}
            </div>
            {!w.can_sign_in && (
              <div className="mt-2 text-[11px] text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-2 py-1.5 flex items-start gap-1.5">
                <Lock className="w-3 h-3 mt-0.5 shrink-0" />
                Sign-in to other workspaces is switched off on this server.
              </div>
            )}
          </div>
        ))}
      </div>
      {visits.length > 0 && (
        <div className="rounded-xl border border-slate-200 bg-white p-4">
          <div className="text-sm font-semibold text-slate-800 mb-2">Recent visits by the system owner</div>
          <div className="divide-y divide-slate-100 text-[11px] text-slate-600">
            {visits.slice(0, 15).map((v) => (
              <div key={v.id} className="py-1.5 flex flex-wrap gap-x-3">
                <span className="font-semibold text-slate-700">{v.workspace}</span>
                <span>{v.company}</span>
                <span>{v.user}</span>
                <span className="text-slate-400">{String(v.visited_at).replace('T', ' ').slice(0, 16)}</span>
              </div>
            ))}
          </div>
        </div>
      )}
      {removing && (
        <TypeToDelete
          title={`Delete workspace ${removing.name}`}
          code={removing.code}
          onClose={() => setRemoving(null)}
          onDelete={async (typed) => {
            await api.del(`/api/platform/workspaces/${removing.id}`, { confirm: typed });
            setRemoving(null);
            setMsg({ type: 'success', text: `Workspace ${removing.name} was deleted.` });
            load();
          }}
        >
          <p>
            The whole group goes for good: its companies ({removing.companies.map((c) => c.short_code).join(', ') || '—'}), its {removing.user_count} account(s) and
            every record in it. Nobody can sign in to <span className="font-mono font-semibold">{removing.code}</span> again. This can't be undone.
          </p>
          <p>
            Only a workspace with no employees can be deleted. One that has employees can be switched off instead (edit ✎ → untick Active). If you are working
            inside it right now, go back to your workspace first.
          </p>
        </TypeToDelete>
      )}
      {admins && <SuperadminsModal token={token} ws={admins} onClose={() => setAdmins(null)} onChanged={load} />}
      {edit && (
        <WorkspaceForm
          token={token}
          ws={edit === 'new' ? null : edit}
          onClose={() => setEdit(null)}
          onSaved={(t) => {
            setEdit(null);
            setMsg({ type: 'success', text: t });
            load();
          }}
        />
      )}
    </div>
  );
};
