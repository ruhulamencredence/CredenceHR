/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Office Attendance -> Machines: every ZKTeco machine with its office, how it
// connects (same network, or over the internet with Cloud push), whether it
// is being heard from, today's punches, and — for a machine with its own PIN
// numbers — who each of its PINs is. Add / edit in a liquid-glass form.
// Server: OfficeAttendanceRoutes.ts + zkMachines.ts.

import React, { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Fingerprint, Pencil, Plus, Trash2, Users, Wifi, Globe, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { confirmDialog } from '../lib/confirmDialog';
import { useBackButtonClose } from '../lib/useBackButtonClose';

export interface ZkMachine {
  id: number;
  name: string;
  branch: string | null;
  connection: 'lan' | 'push';
  pin_mode: 'shared' | 'own';
  ip_address: string | null;
  port: number;
  serial_number: string | null;
  allowed_ip: string | null;
  is_active: boolean;
  last_seen_at: string | null;
  last_sync_status: string | null;
  status: 'online' | 'quiet' | 'offline' | 'never' | 'off';
  minutes_ago: number | null;
  today_punches: number;
  linked_pins: number;
}

const STATUS: Record<ZkMachine['status'], { label: string; dot: string; text: string }> = {
  online: { label: 'Online', dot: 'bg-emerald-500', text: 'text-emerald-700' },
  quiet: { label: 'Quiet', dot: 'bg-amber-400', text: 'text-amber-700' },
  offline: { label: 'Offline', dot: 'bg-rose-500', text: 'text-rose-700' },
  never: { label: 'Not heard from yet', dot: 'bg-slate-300', text: 'text-slate-500' },
  off: { label: 'Turned off', dot: 'bg-slate-300', text: 'text-slate-500' }
};
const ago = (m: number | null) => (m == null ? '' : m < 1 ? 'just now' : m < 60 ? `${m} min ago` : m < 1440 ? `${Math.round(m / 60)} h ago` : `${Math.round(m / 1440)} days ago`);

type Form = { name: string; branch: string; connection: 'lan' | 'push'; pin_mode: 'shared' | 'own'; ip_address: string; port: string; serial_number: string; allowed_ip: string; is_active: boolean };
const emptyForm: Form = { name: '', branch: '', connection: 'lan', pin_mode: 'shared', ip_address: '', port: '4370', serial_number: '', allowed_ip: '', is_active: true };

const Seg: React.FC<{ value: string; options: [string, string][]; onChange: (v: any) => void; label: string }> = ({ value, options, onChange, label }) => (
  <div className="flex rounded-full bg-white/60 p-0.5 text-xs font-semibold" role="radiogroup" aria-label={label}>
    {options.map(([k, l]) => (
      <button key={k} type="button" role="radio" aria-checked={value === k} onClick={() => onChange(k)} className={`flex-1 py-1.5 px-2 rounded-full ${value === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
        {l}
      </button>
    ))}
  </div>
);

const inputCls = 'mt-1 w-full text-sm px-3 py-2 rounded-xl bg-white/80 border border-white focus:outline-none focus:ring-2 focus:ring-emerald-300';

// Add / edit one machine.
const MachineForm: React.FC<{ token: string; machine: ZkMachine | null; onClose: () => void; onSaved: () => void }> = ({ token, machine, onClose, onSaved }) => {
  const [f, setF] = useState<Form>(
    machine
      ? {
          name: machine.name,
          branch: machine.branch || '',
          connection: machine.connection,
          pin_mode: machine.pin_mode,
          ip_address: machine.ip_address || '',
          port: String(machine.port || 4370),
          serial_number: machine.serial_number || '',
          allowed_ip: machine.allowed_ip || '',
          is_active: machine.is_active
        }
      : emptyForm
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useBackButtonClose(true, onClose);
  const set = (k: keyof Form, v: any) => setF((x) => ({ ...x, [k]: v }));
  const save = async () => {
    if (machine && machine.pin_mode !== f.pin_mode) {
      const ok = await confirmDialog(
        f.pin_mode === 'own'
          ? `Give ${f.name || 'this machine'} its own PIN numbers? Its punches stop counting for anyone until you link its PINs (Unlinked PINs).`
          : `Use the office-wide PINs on ${f.name || 'this machine'}? Its PIN links are kept but no longer used.`
      );
      if (!ok) return;
    }
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl(machine ? `/api/zk-devices/${machine.id}` : '/api/zk-devices'), {
        method: machine ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ ...f, port: Number(f.port) || 4370 })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save the machine.');
      onSaved();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const host = typeof window !== 'undefined' ? window.location.host : 'hr.credencegroupbd.com';
  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 mx-auto max-w-md max-h-[90vh] overflow-y-auto rounded-[32px]">
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5">
          <div className="flex items-start justify-between gap-3">
            <div className="text-base font-bold text-slate-900">{machine ? `Edit ${machine.name}` : 'Add a ZKTeco machine'}</div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="space-y-3 mt-3">
            <label className="block text-[11px] font-semibold text-slate-500">
              Name
              <input value={f.name} onChange={(e) => set('name', e.target.value)} placeholder="e.g. Gazipur Site gate" className={inputCls} />
            </label>
            <label className="block text-[11px] font-semibold text-slate-500">
              Office / branch / site
              <input value={f.branch} onChange={(e) => set('branch', e.target.value)} placeholder="e.g. Gazipur Site" className={inputCls} />
            </label>
            <div>
              <div className="text-[11px] font-semibold text-slate-500 mb-1">How does it connect?</div>
              <Seg value={f.connection} label="How does it connect?" onChange={(v) => set('connection', v)} options={[['lan', 'Same network (LAN / VPN)'], ['push', 'Over the internet (Cloud push)']]} />
            </div>
            {f.connection === 'lan' ? (
              <div className="grid grid-cols-[1fr_90px] gap-2">
                <label className="block text-[11px] font-semibold text-slate-500">
                  IP address
                  <input value={f.ip_address} onChange={(e) => set('ip_address', e.target.value)} placeholder="192.168.1.201" className={inputCls} />
                </label>
                <label className="block text-[11px] font-semibold text-slate-500">
                  Port
                  <input value={f.port} onChange={(e) => set('port', e.target.value.replace(/\D/g, ''))} className={inputCls} />
                </label>
              </div>
            ) : (
              <>
                <label className="block text-[11px] font-semibold text-slate-500">
                  Serial number
                  <input value={f.serial_number} onChange={(e) => set('serial_number', e.target.value)} placeholder="Menu → System Info → Device Info" className={inputCls} />
                </label>
                <div className="liquid-glass-inset rounded-2xl p-3 text-[11.5px] text-slate-600 leading-relaxed">
                  On the machine: <b>Menu → Comm. → Cloud Server Setting</b> (or ADMS) → Server address <b>{host}</b>, port <b>443</b> with HTTPS on (or 80), then restart it. It then sends every punch here by itself — no VPN needed.
                </div>
                <label className="block text-[11px] font-semibold text-slate-500">
                  Only from this internet address (optional)
                  <input value={f.allowed_ip} onChange={(e) => set('allowed_ip', e.target.value)} placeholder="the site's fixed public IP, if it has one" className={inputCls} />
                </label>
              </>
            )}
            {f.connection === 'lan' && (
              <label className="block text-[11px] font-semibold text-slate-500">
                Serial number (optional)
                <input value={f.serial_number} onChange={(e) => set('serial_number', e.target.value)} className={inputCls} />
              </label>
            )}
            <div>
              <div className="text-[11px] font-semibold text-slate-500 mb-1">PIN numbers on this machine</div>
              <Seg value={f.pin_mode} label="PIN numbers on this machine" onChange={(v) => set('pin_mode', v)} options={[['shared', 'Same as the office (Employee PIN)'], ['own', 'Its own numbers']]} />
              <p className="text-[11px] text-slate-500 mt-1.5">
                {f.pin_mode === 'own'
                  ? 'PIN 15 here can be someone else than PIN 15 at Head Office — link each PIN of this machine in Unlinked PINs.'
                  : 'A punch counts for the Employee whose Office PIN it is (Employees → PIN).'}
              </p>
            </div>
            {machine && (
              <label className="flex items-center justify-between gap-3 text-sm text-slate-700 bg-white/60 rounded-2xl px-3 py-2.5">
                Machine is in use
                <input type="checkbox" checked={f.is_active} onChange={(e) => set('is_active', e.target.checked)} className="w-4 h-4" />
              </label>
            )}
          </div>
          {error && <p className="text-xs text-rose-600 mt-3">{error}</p>}
          <button type="button" disabled={busy} onClick={() => void save()} className="liquid-glass-button rounded-full w-full py-2.5 text-sm font-semibold mt-4 disabled:opacity-50">
            {busy ? 'Saving…' : machine ? 'Save changes' : 'Add machine'}
          </button>
        </div>
      </div>
    </div>,
    document.body
  );
};

// Who each PIN of an own-PIN machine is (needs Link Device PINs).
const MachinePins: React.FC<{ token: string; machine: ZkMachine; onClose: () => void; onChanged: () => void }> = ({ token, machine, onClose, onChanged }) => {
  const [rows, setRows] = useState<any[] | null>(null);
  const [error, setError] = useState('');
  useBackButtonClose(true, onClose);
  const load = useCallback(() => {
    fetch(apiUrl(`/api/zk-devices/${machine.id}/pins`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => (ok ? setRows(d) : (setError(d?.error || 'Could not load'), setRows([]))))
      .catch(() => setRows([]));
  }, [token, machine.id]);
  useEffect(load, [load]);
  const unlink = async (pin: string, name: string) => {
    if (!(await confirmDialog(`Unlink PIN ${pin} (${name}) on ${machine.name}? Their punches there stop counting until it is linked again.`, { tone: 'danger' }))) return;
    const r = await fetch(apiUrl(`/api/zk-devices/${machine.id}/pins/${encodeURIComponent(pin)}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error || 'Could not unlink');
    load();
    onChanged();
  };
  return createPortal(
    <div className="fixed inset-0 z-[90]">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 mx-auto max-w-md max-h-[85vh] overflow-y-auto rounded-[32px]">
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-bold text-slate-900">{machine.name} — PINs</div>
              <div className="text-xs text-slate-500 mt-0.5">Who each PIN on this machine is. New ones are linked from Unlinked PINs.</div>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="liquid-glass-inset rounded-2xl mt-3 divide-y divide-white/60">
            {!rows ? (
              <div className="p-4"><Spinner size={14} /></div>
            ) : rows.length === 0 ? (
              <p className="p-4 text-sm text-slate-500">No PIN linked yet.</p>
            ) : (
              rows.map((r) => (
                <div key={r.pin} className="flex items-center gap-3 px-3 py-2.5">
                  <span className="w-12 font-mono font-bold text-slate-800">{r.pin}</span>
                  <span className="flex-1 min-w-0">
                    <span className="block text-sm font-semibold text-slate-800 truncate">{r.name}</span>
                    <span className="block text-[11px] text-slate-500 truncate">{[r.employee_code, r.designation, r.department].filter(Boolean).join(' · ')}</span>
                  </span>
                  <button type="button" onClick={() => void unlink(String(r.pin), r.name)} className="w-8 h-8 rounded-full bg-white/70 text-rose-600 flex items-center justify-center" aria-label={`Unlink PIN ${r.pin}`}>
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                </div>
              ))
            )}
          </div>
          {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
        </div>
      </div>
    </div>,
    document.body
  );
};

export const ZkMachinesModal: React.FC<{ token: string; canLinkPins: boolean; onClose: () => void; onChanged: () => void }> = ({ token, canLinkPins, onClose, onChanged }) => {
  const [rows, setRows] = useState<ZkMachine[] | null>(null);
  const [error, setError] = useState('');
  const [editing, setEditing] = useState<ZkMachine | 'new' | null>(null);
  const [pinsOf, setPinsOf] = useState<ZkMachine | null>(null);
  useBackButtonClose(!editing && !pinsOf, onClose);
  const load = useCallback(() => {
    fetch(apiUrl('/api/zk-devices/overview'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => (ok ? setRows(d) : (setError(d?.error || 'Could not load'), setRows([]))))
      .catch(() => setRows([]));
  }, [token]);
  useEffect(load, [load]);
  const remove = async (m: ZkMachine) => {
    if (!(await confirmDialog(`Delete ${m.name}? Its punch history is deleted too. To keep the history, edit it and switch it off instead.`, { tone: 'danger' }))) return;
    const r = await fetch(apiUrl(`/api/zk-devices/${m.id}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!r.ok) setError((await r.json().catch(() => ({}))).error || 'Could not delete');
    load();
    onChanged();
  };
  return createPortal(
    <div className="fixed inset-0 z-[80]">
      <div className="absolute inset-0 liquid-glass-backdrop" onClick={onClose} />
      <div className="absolute inset-x-3 top-1/2 -translate-y-1/2 mx-auto max-w-3xl max-h-[88vh] overflow-y-auto rounded-[32px]">
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Fingerprint className="w-4 h-4 text-emerald-600" /> Attendance machines
              </div>
              <div className="text-xs text-slate-500 mt-0.5">Every ZKTeco machine, where it is, how it connects and whether its punches are arriving.</div>
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button type="button" onClick={() => setEditing('new')} className="liquid-glass-button rounded-full px-3.5 py-2 text-xs font-semibold inline-flex items-center gap-1.5">
                <Plus className="w-3.5 h-3.5" /> Add machine
              </button>
              <button type="button" onClick={onClose} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center" aria-label="Close">
                <X className="w-4 h-4" />
              </button>
            </div>
          </div>
          {error && <p className="text-xs text-rose-600 mt-2">{error}</p>}
          <div className="mt-4 space-y-2">
            {!rows ? (
              <Spinner size={16} />
            ) : rows.length === 0 ? (
              <p className="text-sm text-slate-500">No machine yet — add the first one.</p>
            ) : (
              rows.map((m) => {
                const st = STATUS[m.status];
                return (
                  <div key={m.id} className="liquid-glass-inset rounded-2xl px-3.5 py-3 flex flex-wrap items-center gap-x-4 gap-y-2">
                    <div className="min-w-[180px] flex-1">
                      <div className="text-sm font-bold text-slate-900">{m.name}</div>
                      <div className="text-[11px] text-slate-500">{m.branch || 'No office set'}</div>
                      {/* Why the last pull failed, straight from the machine's
                          answer (timed out, refused…) — not only on hover. */}
                      {m.connection !== 'push' && m.status !== 'online' && /^error/i.test(m.last_sync_status || '') && (
                        <div className="text-[11px] text-rose-600 mt-0.5 break-words">Last try: {(m.last_sync_status || '').replace(/^error:?\s*/i, '')}</div>
                      )}
                    </div>
                    <div className="text-[11px] text-slate-600 min-w-[150px] flex items-center gap-1.5">
                      {m.connection === 'push' ? <Globe className="w-3.5 h-3.5 text-violet-600" /> : <Wifi className="w-3.5 h-3.5 text-blue-600" />}
                      {m.connection === 'push' ? `Cloud push · SN ${m.serial_number || '—'}` : `LAN · ${m.ip_address}:${m.port}`}
                    </div>
                    <div className={`text-[11px] font-semibold min-w-[130px] flex items-center gap-1.5 ${st.text}`} title={m.last_sync_status || undefined}>
                      <span className={`w-2 h-2 rounded-full ${st.dot}`} />
                      {st.label}
                      {m.status !== 'never' && m.status !== 'off' && m.minutes_ago != null && <span className="font-normal text-slate-500">· {ago(m.minutes_ago)}</span>}
                    </div>
                    <div className="text-[11px] text-slate-600 min-w-[90px]">
                      <b className="text-slate-900">{m.today_punches}</b> today
                    </div>
                    <div className="text-[11px] text-slate-600 min-w-[110px]">
                      {m.pin_mode === 'own' ? (
                        canLinkPins ? (
                          <button type="button" onClick={() => setPinsOf(m)} className="inline-flex items-center gap-1 font-semibold text-violet-700 hover:underline">
                            <Users className="w-3.5 h-3.5" /> Own PINs · {m.linked_pins}
                          </button>
                        ) : (
                          `Own PINs · ${m.linked_pins}`
                        )
                      ) : (
                        'Office PINs'
                      )}
                    </div>
                    <div className="flex items-center gap-1 ml-auto">
                      <button type="button" onClick={() => setEditing(m)} className="w-8 h-8 rounded-full bg-white/70 text-slate-600 flex items-center justify-center" aria-label={`Edit ${m.name}`}>
                        <Pencil className="w-3.5 h-3.5" />
                      </button>
                      <button type="button" onClick={() => void remove(m)} className="w-8 h-8 rounded-full bg-white/70 text-rose-600 flex items-center justify-center" aria-label={`Delete ${m.name}`}>
                        <Trash2 className="w-3.5 h-3.5" />
                      </button>
                    </div>
                  </div>
                );
              })
            )}
          </div>
          <p className="text-[11px] text-slate-500 mt-3">
            Online = heard from in the last 30 minutes; a machine not heard from for an hour (07:00–21:00) is sent to the Office Attendance people as an alert, once.
          </p>
        </div>
      </div>
      {editing && (
        <MachineForm
          token={token}
          machine={editing === 'new' ? null : editing}
          onClose={() => setEditing(null)}
          onSaved={() => {
            setEditing(null);
            load();
            onChanged();
          }}
        />
      )}
      {pinsOf && <MachinePins token={token} machine={pinsOf} onClose={() => setPinsOf(null)} onChanged={onChanged} />}
    </div>,
    document.body
  );
};
