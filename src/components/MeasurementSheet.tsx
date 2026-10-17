/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> PEPM Management -> Measurement Sheet (module "measurement_sheet",
// MeasurementRoutes.ts + MeasurementEngine.ts).
//   read          open a sheet, look at the plan, export Excel / PDF
//   edit_add      upload a drawing, name beams, set sizes / thickness, add rows
//   delete_trash  delete a sheet
// The DWG is read on the server; the drawing's beams, columns and slab panels
// become a BOQ measurement sheet (Nos x L x B x D = quantity). What the drawing
// cannot say (an unnamed beam, the slab thickness...) is filled here and the
// sheet follows.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Ruler, Upload, Trash2, ArrowLeft, FileSpreadsheet, FileText, Loader2, Save, Plus, AlertTriangle, RefreshCw } from 'lucide-react';
import * as XLSX from 'xlsx';
import jsPDF from 'jspdf';
import autoTable from 'jspdf-autotable';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { MailPopup as Popup, Tabs, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';

interface Row { id: string; desc: string; nos: number; l: number | null; b: number | null; d: number | null; qty: number; unit: string; remark?: string; kind: 'item' | 'sub' | 'head'; ref?: string }
interface Section { key: string; title: string; rows: Row[]; totals: { label: string; qty: number; unit: string }[] }
interface SheetT { plan: { id: string; title: string }; repeats: number; assumptions: string[]; sections: Section[] }
interface Beam { id: string; dir: 'H' | 'V'; c: number; a: number; b: number; widthIn: number; length: number; tag: string | null; tagFrom: 'leader' | 'run' | null }
interface Column { id: string; x0: number; y0: number; x1: number; y1: number; w: number; d: number; kind: 'column' | 'wall' }
interface Panel { id: string; areaSqIn: number; x0: number; y0: number; x1: number; y1: number; kind: string; note: string | null }
interface Plan { id: string; title: string; bbox: { x0: number; y0: number; x1: number; y1: number }; beams: Beam[]; columns: Column[]; panels: Panel[]; tags: { tag: string; widthIn: number; depthIn: number }[]; warnings: string[] }
interface Settings { inchPerUnit: number | null; beamLayers: string[] | null; columnLayers: string[] | null; tagLayers: string[] | null; defaultBeamWidthIn: number; defaultBeamDepthIn: number; slabThicknessIn: number; deductSlabFromBeam: boolean; storeyHeightFt: number; repeats: number }
interface Extra { section: 'beam' | 'column' | 'slab' | 'other'; desc: string; nos: number; l: number | null; b: number | null; d: number | null; unit: 'cft' | 'sft' | 'rft' | 'nos' }
interface Overrides {
  beamTags?: Record<string, string>;
  tagSizes?: Record<string, { widthIn: number; depthIn: number }>;
  skipBeams?: string[];
  skipColumns?: string[];
  panels?: Record<string, { include?: boolean; thicknessIn?: number }>;
  columnHeights?: Record<string, number>;
  extra?: Extra[];
}
interface Detail {
  id: number; title: string; file_name: string | null; created_at: string; updated_at: string;
  settings: Settings; overrides: Record<string, Overrides>;
  model: { unitName: string; inchPerUnit: number; plans: Plan[]; notes: string[]; usedBeamLayers: string[]; usedColumnLayers: string[] };
  sheets: SheetT[];
  all_layers: { name: string; lines: number; polys: number; texts: number; leaders: number }[];
  guessed: { beam: string[]; column: string[] };
  can_edit: boolean; can_delete: boolean; can_budget?: boolean;
  budget_config?: BudgetCfg; budget?: BudgetOut;
}
type Part = 'beam' | 'column' | 'slab';
interface BudgetCfg {
  cementBagCft: number; dryFactor: number; wastagePct: number; steelWastagePct: number;
  mix: Record<Part, [number, number, number]>; steelKgPerCft: Record<Part, number>;
  rates: { cement: number; sand: number; stone: number; steel: number; shuttering: number };
}
interface BudgetOut {
  repeatsNote: string; total: number; rateMissing: boolean; notes: string[];
  parts: { key: Part; label: string; concrete: number; cement: number; sand: number; stone: number; steel: number; shuttering: number }[];
  lines: { key: string; label: string; qty: number; unit: string; rate: number; amount: number }[];
}
interface ListItem { id: number; title: string; file_name: string | null; created_at: string; created_by_name: string | null }

async function api<T>(token: string, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: init?.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

const n2 = (v: number | null | undefined) => (v == null ? '' : (Math.round(v * 100) / 100).toFixed(2));
const q2 = (v: number) => (Math.round(v * 100) / 100).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmtDate = (s: string) => (s ? new Date(s).toLocaleString('en-GB', { dateStyle: 'medium', timeStyle: 'short' }) : '');
const hue = (s: string) => { let h = 0; for (const ch of s) h = (h * 31 + ch.charCodeAt(0)) % 360; return h; };
const numOrNull = (s: string) => (s.trim() === '' || !Number.isFinite(Number(s)) ? null : Number(s));
const SECTION_LABEL: Record<string, string> = { beam: 'A. Beams', column: 'B. Columns & walls', slab: 'C. Slab', other: 'D. Other' };

// ---------------------------------------------------------------------------
export const MeasurementSheet: React.FC<{ token: string }> = ({ token }) => {
  const [items, setItems] = useState<ListItem[] | null>(null);
  const [perm, setPerm] = useState({ edit: false, del: false });
  const [openId, setOpenId] = useState<number | null>(null);
  const [uploading, setUploading] = useState(false);
  const [err, setErr] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await api<{ items: ListItem[]; can_edit: boolean; can_delete: boolean }>(token, '/api/measurement-sheets');
      setItems(r.items);
      setPerm({ edit: r.can_edit, del: r.can_delete });
      setErr('');
    } catch (e: any) {
      setErr(e.message);
      setItems([]);
    }
  }, [token]);
  useEffect(() => { load(); }, [load]);

  if (openId !== null) return <SheetView token={token} id={openId} onBack={() => { setOpenId(null); load(); }} />;

  const remove = async (it: ListItem) => {
    if (!(await confirmDialog(`Delete the measurement sheet "${it.title}"? This cannot be undone.`, { confirmLabel: 'Delete', tone: 'danger' }))) return;
    try { await api(token, `/api/measurement-sheets/${it.id}`, { method: 'DELETE' }); load(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="p-4 sm:p-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
        <div>
          <h2 className="text-xl font-bold text-slate-900 flex items-center gap-2"><Ruler className="w-5 h-5 text-sky-600" /> Measurement Sheet</h2>
          <p className="text-sm text-slate-500">Upload a building design (DWG / DXF) and get the BOQ measurement sheet: beams, columns and slab, worked out from the drawing.</p>
        </div>
        {perm.edit && (
          <button type="button" className={primaryBtn} onClick={() => setUploading(true)}><Upload className="w-4 h-4" /> Upload drawing</button>
        )}
      </div>
      {err && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{err}</div>}
      {items === null ? (
        <div className="py-16 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline" /></div>
      ) : items.length === 0 ? (
        <div className="liquid-glass-inset rounded-2xl p-10 text-center text-slate-500 text-sm">No measurement sheet yet.{perm.edit ? ' Upload a drawing to make one.' : ''}</div>
      ) : (
        <div className="grid gap-3 sm:grid-cols-2">
          {items.map((it) => (
            <div key={it.id} className="liquid-glass-inset rounded-2xl p-4 flex items-start gap-3">
              <button type="button" className="flex-1 min-w-0 text-left" onClick={() => setOpenId(it.id)}>
                <div className="font-semibold text-slate-900 truncate">{it.title}</div>
                <div className="text-xs text-slate-500 truncate">{it.file_name}</div>
                <div className="text-xs text-slate-400 mt-1">{fmtDate(it.created_at)}{it.created_by_name ? ` · ${it.created_by_name}` : ''}</div>
              </button>
              {perm.del && (
                <button type="button" className="liquid-glass-chip p-2 rounded-full text-red-600" aria-label={`Delete ${it.title}`} onClick={() => remove(it)}><Trash2 className="w-4 h-4" /></button>
              )}
            </div>
          ))}
        </div>
      )}
      {uploading && <UploadPopup token={token} onClose={() => setUploading(false)} onDone={(id) => { setUploading(false); setOpenId(id); }} />}
    </div>
  );
};

// ---------------------------------------------------------------------------
const UploadPopup: React.FC<{ token: string; onClose: () => void; onDone: (id: number) => void }> = ({ token, onClose, onDone }) => {
  const [file, setFile] = useState<File | null>(null);
  const [title, setTitle] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const go = async () => {
    if (!file) return;
    setBusy(true); setErr('');
    try {
      const buf = new Uint8Array(await file.arrayBuffer());
      let bin = '';
      for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      const r = await api<Detail>(token, '/api/measurement-sheets', { method: 'POST', body: { title: title.trim() || undefined, file_name: file.name, data_base64: btoa(bin) } });
      onDone(r.id);
    } catch (e: any) { setErr(e.message); setBusy(false); }
  };
  return (
    <Popup title="Upload drawing" icon={<Upload className="w-4 h-4" />} onClose={busy ? () => {} : onClose} size="md"
      footer={<><button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Cancel</button><button type="button" className={primaryBtn} onClick={go} disabled={!file || busy}>{busy && <Loader2 className="w-4 h-4 animate-spin" />} Make measurement sheet</button></>}>
      <div className="space-y-3 pt-1">
        <div>
          <label className={labelCls}>Structure drawing (.dwg or .dxf)</label>
          <input type="file" accept=".dwg,.dxf" className={inputCls} onChange={(e) => { const f = e.target.files?.[0] || null; setFile(f); if (f && !title) setTitle(f.name.replace(/\.[^.]+$/, '').replace(/[_]+/g, ' ')); }} />
        </div>
        <div>
          <label className={labelCls}>Title</label>
          <input className={inputCls} value={title} onChange={(e) => setTitle(e.target.value)} placeholder="e.g. Ground floor beam layout" />
        </div>
        <p className="text-xs text-slate-500">Beam edges must be on a layer with "beam" in its name. Reading a large drawing can take up to a minute.</p>
        {err && <div className="text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{err}</div>}
      </div>
    </Popup>
  );
};

// ---------------------------------------------------------------------------
const SheetView: React.FC<{ token: string; id: number; onBack: () => void }> = ({ token, id, onBack }) => {
  const [d, setD] = useState<Detail | null>(null);
  const [err, setErr] = useState('');
  const [planIdx, setPlanIdx] = useState(0);
  const [tab, setTab] = useState('sheet');
  const [settings, setSettings] = useState<Settings | null>(null);
  const [ov, setOv] = useState<Record<string, Overrides>>({});
  const [title, setTitle] = useState('');
  const [dirty, setDirty] = useState(false);
  const [saving, setSaving] = useState(false);
  const [picked, setPicked] = useState<string | null>(null);
  const [bcfg, setBcfg] = useState<BudgetCfg | null>(null);

  const apply = (r: Detail) => { setD(r); setBcfg(r.budget_config || null); setSettings(r.settings); setOv(r.overrides || {}); setTitle(r.title); setDirty(false); };
  useEffect(() => {
    api<Detail>(token, `/api/measurement-sheets/${id}`).then(apply).catch((e) => setErr(e.message));
  }, [token, id]);

  const save = async () => {
    setSaving(true); setErr('');
    try { apply(await api<Detail>(token, `/api/measurement-sheets/${id}`, { method: 'PUT', body: { title, settings, overrides: ov, ...(bcfg && d?.can_budget ? { budget: bcfg } : {}) } })); }
    catch (e: any) { setErr(e.message); }
    setSaving(false);
  };

  if (!d || !settings) return <div className="p-10 text-center text-slate-500">{err ? <span className="text-red-700">{err}</span> : <Loader2 className="w-5 h-5 animate-spin inline" />}</div>;
  const plan = d.model.plans[Math.min(planIdx, d.model.plans.length - 1)];
  const sheet = d.sheets.find((s) => s.plan.id === plan.id)!;
  const o: Overrides = ov[plan.id] || {};
  const edit = d.can_edit;
  const setO = (fn: (x: Overrides) => Overrides) => { setOv((p) => ({ ...p, [plan.id]: fn({ ...(p[plan.id] || {}) }) })); setDirty(true); };
  const setS = (patch: Partial<Settings>) => { setSettings((p) => ({ ...(p as Settings), ...patch })); setDirty(true); };
  const tagOf = (b: Beam) => (o.beamTags && b.id in o.beamTags ? o.beamTags[b.id] || null : b.tag);
  const untagged = plan.beams.filter((b) => !tagOf(b) && !(o.skipBeams || []).includes(b.id));
  const guessed = plan.beams.filter((b) => b.tagFrom === 'run' && !(o.beamTags && b.id in o.beamTags));

  const remove = async () => {
    if (!(await confirmDialog(`Delete the measurement sheet "${d.title}"? This cannot be undone.`, { confirmLabel: 'Delete', tone: 'danger' }))) return;
    try { await api(token, `/api/measurement-sheets/${id}`, { method: 'DELETE' }); onBack(); } catch (e: any) { setErr(e.message); }
  };

  return (
    <div className="p-3 sm:p-6 max-w-6xl mx-auto">
      <div className="flex items-center gap-2 flex-wrap mb-3">
        <button type="button" className="liquid-glass-chip p-2 rounded-full" onClick={onBack} aria-label="Back"><ArrowLeft className="w-4 h-4" /></button>
        {edit ? <input className={`${inputCls} !w-auto flex-1 min-w-[10rem] max-w-md font-semibold`} value={title} onChange={(e) => { setTitle(e.target.value); setDirty(true); }} aria-label="Title" /> : <h2 className="text-lg font-bold text-slate-900">{d.title}</h2>}
        <div className="flex-1" />
        <button type="button" className={ghostBtn} onClick={() => exportExcel(d.title, d.sheets, settings, d.budget)}><FileSpreadsheet className="w-4 h-4 inline mr-1" />Excel</button>
        <button type="button" className={ghostBtn} onClick={() => exportPdf(d.title, d.file_name, d.sheets, settings, d.budget)}><FileText className="w-4 h-4 inline mr-1" />PDF</button>
        {d.can_delete && <button type="button" className="liquid-glass-chip p-2 rounded-full text-red-600" onClick={remove} aria-label="Delete sheet"><Trash2 className="w-4 h-4" /></button>}
      </div>
      {err && <div className="mb-3 text-sm text-red-700 bg-red-50 border border-red-200 rounded-xl px-3 py-2">{err}</div>}
      {dirty && edit && (
        <div className="mb-3 flex items-center gap-3 flex-wrap text-sm bg-amber-50 border border-amber-200 rounded-xl px-3 py-2">
          <span className="flex-1">Changes are not saved yet — the sheet below still shows the last saved figures.</span>
          <button type="button" className={primaryBtn} onClick={save} disabled={saving}>{saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save & recalculate</button>
        </div>
      )}
      {d.model.plans.length > 1 && (
        <div className="mb-3"><Tabs tabs={d.model.plans.map((p, i) => ({ key: String(i), label: p.title }))} value={String(planIdx)} onChange={(k) => { setPlanIdx(Number(k)); setPicked(null); }} /></div>
      )}
      {(untagged.length > 0 || guessed.length > 0) && (
        <div className="mb-3 text-sm bg-amber-50 border border-amber-200 rounded-xl px-3 py-2 flex gap-2">
          <AlertTriangle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
          <div>
            {untagged.length > 0 && <div><b>{untagged.length} beam{untagged.length === 1 ? '' : 's'}</b> ({untagged.map((b) => b.id).slice(0, 12).join(', ')}{untagged.length > 12 ? '…' : ''}) {untagged.length === 1 ? 'has' : 'have'} no tag in the drawing and are measured at the default size. Name them in the Beams tab.</div>}
            {guessed.length > 0 && <div><b>{guessed.length} beam{guessed.length === 1 ? ' was' : 's were'}</b> named from the beam in line with {guessed.length === 1 ? 'it' : 'them'}, not from a tag of their own — please check ({guessed.map((b) => b.id).slice(0, 12).join(', ')}{guessed.length > 12 ? '…' : ''}).</div>}
          </div>
        </div>
      )}
      <Tabs tabs={[{ key: 'sheet', label: 'Measurement sheet' }, { key: 'plan', label: 'Plan' }, { key: 'beams', label: 'Beams' }, { key: 'slabs', label: 'Slabs' }, ...(d.can_budget && d.budget ? [{ key: 'budget', label: 'Material Budget' }] : []), { key: 'settings', label: 'Settings' }]} value={tab} onChange={setTab} />
      {tab === 'sheet' && <SheetTable sheet={sheet} edit={edit} extra={o.extra || []} onExtra={(extra) => setO((x) => ({ ...x, extra }))} />}
      {tab === 'plan' && <PlanView token={token} id={id} plan={plan} tagOf={tagOf} picked={picked} setPicked={setPicked} ov={o} />}
      {tab === 'beams' && <BeamsTab plan={plan} edit={edit} ov={o} setO={setO} tagOf={tagOf} settings={settings} picked={picked} />}
      {tab === 'slabs' && <SlabsTab plan={plan} edit={edit} ov={o} setO={setO} settings={settings} />}
      {tab === 'budget' && d.can_budget && d.budget && bcfg && <BudgetTab budget={d.budget} cfg={bcfg} edit={edit} onChange={(c) => { setBcfg(c); setDirty(true); }} />}
      {tab === 'settings' && <SettingsTab d={d} settings={settings} setS={setS} edit={edit} onReset={() => { setSettings(d.settings); setDirty(true); }} />}
      <p className="text-xs text-slate-400 mt-4">{d.file_name} · read {fmtDate(d.created_at)} · drawing unit: {d.model.unitName}</p>
    </div>
  );
};

// ---------------------------------------------------------------------------
const SheetTable: React.FC<{ sheet: SheetT; edit: boolean; extra: Extra[]; onExtra: (e: Extra[]) => void }> = ({ sheet, edit, extra, onExtra }) => {
  const [adding, setAdding] = useState(false);
  return (
    <div className="space-y-5">
      {sheet.sections.map((sec) => (
        <div key={sec.key} className="liquid-glass-inset rounded-2xl p-3">
          <div className="font-bold text-slate-900 mb-2">{SECTION_LABEL[sec.key] || sec.title}</div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm min-w-[640px]">
              <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200">
                <th className="py-1.5 pr-2">Description</th><th className="px-2 text-right">Nos</th><th className="px-2 text-right">L (ft)</th><th className="px-2 text-right">B (ft)</th><th className="px-2 text-right">D (ft)</th><th className="px-2 text-right">Qty</th><th className="px-2">Unit</th><th className="pl-2">Remark</th>
              </tr></thead>
              <tbody>
                {sec.rows.length === 0 && <tr><td colSpan={8} className="py-3 text-slate-400">Nothing measured here.</td></tr>}
                {sec.rows.map((r) => r.kind === 'head' ? (
                  <tr key={r.id}><td colSpan={8} className="pt-3 pb-1 font-semibold text-slate-800">{r.desc}</td></tr>
                ) : (
                  <tr key={r.id} className={`border-b border-slate-100 ${r.kind === 'sub' ? 'font-semibold bg-white/50' : ''}`}>
                    <td className="py-1 pr-2">{r.desc}</td>
                    <td className="px-2 text-right tabular-nums">{r.kind === 'item' ? r.nos : ''}</td>
                    <td className="px-2 text-right tabular-nums">{n2(r.l)}</td>
                    <td className="px-2 text-right tabular-nums">{n2(r.b)}</td>
                    <td className="px-2 text-right tabular-nums">{n2(r.d)}</td>
                    <td className="px-2 text-right tabular-nums">{q2(r.qty)}</td>
                    <td className="px-2">{r.unit}</td>
                    <td className="pl-2 text-xs text-slate-500">{r.remark}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          {sec.totals.length > 0 && (
            <div className="mt-2 flex gap-4 flex-wrap text-sm font-bold text-slate-900">
              {sec.totals.map((t) => <span key={t.label}>{t.label}: {q2(t.qty)} {t.unit}</span>)}
            </div>
          )}
        </div>
      ))}
      {sheet.assumptions.length > 0 && (
        <div className="text-xs text-slate-500">
          <div className="font-semibold mb-1">How this was worked out</div>
          <ul className="list-disc pl-5 space-y-0.5">{sheet.assumptions.map((a, i) => <li key={i}>{a}</li>)}</ul>
        </div>
      )}
      {edit && (
        <div>
          <button type="button" className={ghostBtn} onClick={() => setAdding(true)}><Plus className="w-4 h-4 inline mr-1" />Add a row by hand</button>
          {extra.length > 0 && (
            <ul className="mt-2 text-sm space-y-1">
              {extra.map((e, i) => (
                <li key={i} className="flex items-center gap-2"><span className="flex-1">{SECTION_LABEL[e.section]} — {e.desc} ({e.nos} × {n2(e.l)} × {n2(e.b)} × {n2(e.d)} {e.unit})</span>
                  <button type="button" className="text-red-600 text-xs" onClick={() => onExtra(extra.filter((_, k) => k !== i))}>Remove</button></li>
              ))}
            </ul>
          )}
        </div>
      )}
      {adding && <ExtraPopup onClose={() => setAdding(false)} onAdd={(e) => { onExtra([...extra, e]); setAdding(false); }} />}
    </div>
  );
};

const ExtraPopup: React.FC<{ onClose: () => void; onAdd: (e: Extra) => void }> = ({ onClose, onAdd }) => {
  const [e, setE] = useState({ section: 'other', desc: '', nos: '1', l: '', b: '', d: '', unit: 'cft' });
  const f = (k: string) => (ev: React.ChangeEvent<HTMLInputElement | HTMLSelectElement>) => setE((p) => ({ ...p, [k]: ev.target.value }));
  return (
    <Popup title="Add a row" icon={<Plus className="w-4 h-4" />} onClose={onClose} size="md"
      footer={<><button type="button" className={ghostBtn} onClick={onClose}>Cancel</button><button type="button" className={primaryBtn} disabled={!e.desc.trim()} onClick={() => onAdd({ section: e.section as any, desc: e.desc.trim(), nos: Number(e.nos) || 1, l: numOrNull(e.l), b: numOrNull(e.b), d: numOrNull(e.d), unit: e.unit as any })}>Add</button></>}>
      <div className="space-y-3 pt-1">
        <div><label className={labelCls}>Description</label><input className={inputCls} value={e.desc} onChange={f('desc')} placeholder="e.g. Cantilever slab, north side" /></div>
        <div className="grid grid-cols-2 gap-3">
          <div><label className={labelCls}>Section</label><select className={inputCls} value={e.section} onChange={f('section')}>{Object.entries(SECTION_LABEL).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select></div>
          <div><label className={labelCls}>Unit</label><select className={inputCls} value={e.unit} onChange={f('unit')}><option value="cft">cft</option><option value="sft">sft</option><option value="rft">rft</option><option value="nos">nos</option></select></div>
        </div>
        <div className="grid grid-cols-4 gap-2">
          <div><label className={labelCls}>Nos</label><input className={inputCls} inputMode="decimal" value={e.nos} onChange={f('nos')} /></div>
          <div><label className={labelCls}>L (ft)</label><input className={inputCls} inputMode="decimal" value={e.l} onChange={f('l')} /></div>
          <div><label className={labelCls}>B (ft)</label><input className={inputCls} inputMode="decimal" value={e.b} onChange={f('b')} /></div>
          <div><label className={labelCls}>D (ft)</label><input className={inputCls} inputMode="decimal" value={e.d} onChange={f('d')} /></div>
        </div>
      </div>
    </Popup>
  );
};

// ---------------------------------------------------------------------------
interface DrawingData { bbox: { x0: number; y0: number; x1: number; y1: number }; focus: { x0: number; y0: number; x1: number; y1: number }; layers: { name: string; d: string; texts: { t: string; x: number; y: number; h: number; r: number }[] }[]; notes: string[] }
const layerColor = (n: string) => `hsl(${hue(n)} 55% 38%)`;

// The whole drawing as the reader found it: every layer's lines and texts, with
// wheel / pinch zoom and drag to move.
const boxOf = (b: { x0: number; y0: number; x1: number; y1: number }) => { const p = Math.max(b.x1 - b.x0, b.y1 - b.y0, 1) * 0.04; return { x: b.x0 - p, y: -b.y1 - p, w: b.x1 - b.x0 + 2 * p, h: b.y1 - b.y0 + 2 * p }; };
const FullDrawing: React.FC<{ token: string; id: number }> = ({ token, id }) => {
  const [data, setData] = useState<DrawingData | null>(null);
  const [err, setErr] = useState('');
  const [off, setOff] = useState<Set<string>>(new Set());
  const [vb, setVb] = useState<{ x: number; y: number; w: number; h: number } | null>(null);
  const [drag, setDrag] = useState<{ cx: number; cy: number; vx: number; vy: number } | null>(null);
  useEffect(() => { api<DrawingData>(token, `/api/measurement-sheets/${id}/drawing`).then((r) => { setData(r); setVb(boxOf(r.focus)); }).catch((e) => setErr(e.message)); }, [token, id]);
  if (err) return <div className="text-sm text-red-700">{err}</div>;
  if (!data || !vb) return <div className="py-10 text-center text-slate-500"><Loader2 className="w-5 h-5 animate-spin inline" /></div>;
  const zoom = (f: number, cx = 0.5, cy = 0.5) => setVb((v) => v && ({ x: v.x + v.w * cx * (1 - f), y: v.y + v.h * cy * (1 - f), w: v.w * f, h: v.h * f }));
  const stroke = vb.w / 900;
  return (
    <div>
      <div className="flex flex-wrap gap-1.5 mb-2">
        {data.layers.map((l) => { const on = !off.has(l.name); return (
          <button key={l.name} type="button" onClick={() => setOff((p) => { const n = new Set(p); on ? n.add(l.name) : n.delete(l.name); return n; })} className={`text-xs px-2.5 py-1 rounded-full border ${on ? 'bg-white text-slate-800 border-slate-300' : 'bg-slate-100 text-slate-400 border-slate-200 line-through'}`}>
            <span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: layerColor(l.name) }} />{l.name}
          </button>); })}
      </div>
      <div className="liquid-glass-inset rounded-2xl p-1 relative overflow-hidden">
        <div className="absolute right-3 top-3 z-10 flex gap-1">
          <button type="button" className="liquid-glass-chip px-2.5 py-1 rounded-full text-sm" onClick={() => zoom(0.7)} aria-label="Zoom in">+</button>
          <button type="button" className="liquid-glass-chip px-2.5 py-1 rounded-full text-sm" onClick={() => zoom(1 / 0.7)} aria-label="Zoom out">−</button>
          <button type="button" className="liquid-glass-chip px-3 py-1 rounded-full text-xs" onClick={() => setVb(boxOf(data.focus))}>Fit</button>
          <button type="button" className="liquid-glass-chip px-3 py-1 rounded-full text-xs" onClick={() => setVb(boxOf(data.bbox))}>All</button>
        </div>
        <svg viewBox={`${vb.x} ${vb.y} ${vb.w} ${vb.h}`} className="w-full h-[70vh] bg-white rounded-xl touch-none select-none" role="img" aria-label="Full drawing preview"
          style={{ cursor: drag ? 'grabbing' : 'grab' }}
          onWheel={(e) => { const r = e.currentTarget.getBoundingClientRect(); zoom(e.deltaY > 0 ? 1.15 : 1 / 1.15, (e.clientX - r.left) / r.width, (e.clientY - r.top) / r.height); }}
          onPointerDown={(e) => { e.currentTarget.setPointerCapture(e.pointerId); setDrag({ cx: e.clientX, cy: e.clientY, vx: vb.x, vy: vb.y }); }}
          onPointerMove={(e) => { if (!drag) return; const r = e.currentTarget.getBoundingClientRect(); setVb({ ...vb, x: drag.vx - ((e.clientX - drag.cx) / r.width) * vb.w, y: drag.vy - ((e.clientY - drag.cy) / r.height) * vb.h }); }}
          onPointerUp={() => setDrag(null)}>
          {data.layers.filter((l) => !off.has(l.name)).map((l) => (
            <g key={l.name} stroke={layerColor(l.name)} fill="none" strokeWidth={stroke}>
              <path d={l.d} transform="scale(1,-1)" vectorEffect="non-scaling-stroke" strokeWidth={1} />
              {l.texts.map((t, i) => <text key={i} x={t.x} y={-t.y} fontSize={Math.max(t.h, vb.w / 400)} fill={layerColor(l.name)} stroke="none" transform={t.r ? `rotate(${-t.r} ${t.x} ${-t.y})` : undefined}>{t.t}</text>)}
            </g>
          ))}
        </svg>
      </div>
      <p className="text-xs text-slate-500 mt-2">The drawing as the reader found it: lines, polylines, leaders and texts. Turn layers on or off above; scroll or +/− to zoom, drag to move. Arcs, circles, hatches, dimensions and blocks are not drawn here.{data.notes.length ? ` ${data.notes.join(' ')}` : ''}</p>
    </div>
  );
};

const PlanView: React.FC<{ token: string; id: number; plan: Plan; tagOf: (b: Beam) => string | null; picked: string | null; setPicked: (id: string | null) => void; ov: Overrides }> = ({ token, id, plan, tagOf, picked, setPicked, ov }) => {
  const [mode, setMode] = useState<'found' | 'full'>('found');
  const { x0, y0, x1, y1 } = plan.bbox;
  const pad = 30;
  const W = x1 - x0 + pad * 2, H = y1 - y0 + pad * 2;
  const X = (x: number) => x - x0 + pad;
  const Y = (y: number) => y1 - y + pad;
  const fs = Math.max(8, W / 90);
  const skipped = new Set(ov.skipBeams || []);
  return (
    <div>
      <div className="mb-2 inline-flex liquid-glass-inset rounded-full p-1 gap-1">
        {([['found', 'Beams, columns & slab'], ['full', 'Full drawing']] as const).map(([k, label]) => (
          <button key={k} type="button" onClick={() => setMode(k)} className={`text-xs font-semibold px-3 py-1.5 rounded-full ${mode === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>{label}</button>
        ))}
      </div>
      {mode === 'full' ? <FullDrawing token={token} id={id} /> : (<>
      <div className="liquid-glass-inset rounded-2xl p-2 overflow-auto">
        <svg viewBox={`0 0 ${W} ${H}`} className="w-full h-auto min-w-[640px]" role="img" aria-label="Plan preview">
          {plan.panels.map((p) => {
            const inc = ov.panels?.[p.id]?.include;
            const on = p.kind === 'slab' ? inc !== false : inc === true;
            return <rect key={p.id} x={X(p.x0)} y={Y(p.y1)} width={p.x1 - p.x0} height={p.y1 - p.y0} fill={p.kind === 'slab' ? (on ? '#38bdf8' : '#94a3b8') : '#f59e0b'} opacity={0.14} stroke="#0ea5e9" strokeDasharray="6 6" strokeWidth={1} />;
          })}
          {plan.beams.map((b) => {
            const t = tagOf(b);
            const col = skipped.has(b.id) ? '#cbd5e1' : t ? `hsl(${hue(t)} 65% 45%)` : '#dc2626';
            const [ax, ay, bx, by] = b.dir === 'H' ? [X(b.a), Y(b.c), X(b.b), Y(b.c)] : [X(b.c), Y(b.a), X(b.c), Y(b.b)];
            return <line key={b.id} x1={ax} y1={ay} x2={bx} y2={by} stroke={col} strokeWidth={Math.max(b.widthIn, 4)} opacity={picked === b.id ? 1 : 0.75} strokeLinecap="butt" onClick={() => setPicked(picked === b.id ? null : b.id)} style={{ cursor: 'pointer' }} />;
          })}
          {plan.columns.map((c) => <rect key={c.id} x={X(c.x0)} y={Y(c.y1)} width={c.x1 - c.x0} height={c.y1 - c.y0} fill={c.kind === 'wall' ? '#475569' : '#0f172a'} />)}
          {plan.beams.map((b) => {
            const t = tagOf(b);
            const mx = b.dir === 'H' ? (b.a + b.b) / 2 : b.c, my = b.dir === 'H' ? b.c : (b.a + b.b) / 2;
            return <text key={`t${b.id}`} x={X(mx)} y={Y(my) - b.widthIn * 0.8} fontSize={fs} textAnchor="middle" fill="#0f172a" style={{ pointerEvents: 'none' }}>{b.id}{t ? ` ${t.split('(')[0]}` : ''}</text>;
          })}
        </svg>
      </div>
      <p className="text-xs text-slate-500 mt-2">Beams are coloured by their tag; <span className="text-red-600 font-semibold">red</span> = no tag. Tap a beam to select it in the Beams tab. Black = columns / walls, blue wash = slab panels.</p>
      </>)}
    </div>
  );
};

// ---------------------------------------------------------------------------
const BeamsTab: React.FC<{ plan: Plan; edit: boolean; ov: Overrides; setO: (fn: (x: Overrides) => Overrides) => void; tagOf: (b: Beam) => string | null; settings: Settings; picked: string | null }> = ({ plan, edit, ov, setO, tagOf, settings, picked }) => {
  const tags = useMemo(() => {
    const set = new Set<string>(plan.tags.map((t) => t.tag));
    for (const b of plan.beams) { const t = tagOf(b); if (t) set.add(t); }
    return [...set].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
  }, [plan, ov]);
  const sizeOf = (t: string) => ov.tagSizes?.[t] || plan.tags.find((x) => x.tag === t) || { widthIn: settings.defaultBeamWidthIn, depthIn: settings.defaultBeamDepthIn };
  const setSize = (t: string, k: 'widthIn' | 'depthIn', v: number) => setO((x) => ({ ...x, tagSizes: { ...(x.tagSizes || {}), [t]: { ...sizeOf(t), [k]: v } } }));
  const skipped = new Set(ov.skipBeams || []);
  return (
    <div className="space-y-4">
      <div className="liquid-glass-inset rounded-2xl p-3">
        <div className="font-bold text-slate-900 mb-2">Beam sizes</div>
        {tags.length === 0 ? <div className="text-sm text-slate-400">No beam is named yet.</div> : (
          <div className="grid gap-2 sm:grid-cols-2">
            {tags.map((t) => { const s = sizeOf(t); return (
              <div key={t} className="flex items-center gap-2 text-sm"><span className="w-20 font-semibold truncate">{t}</span>
                <input className={`${inputCls} !w-20`} inputMode="decimal" disabled={!edit} value={s.widthIn} onChange={(e) => setSize(t, 'widthIn', Number(e.target.value) || 0)} aria-label={`${t} width`} /><span>×</span>
                <input className={`${inputCls} !w-20`} inputMode="decimal" disabled={!edit} value={s.depthIn} onChange={(e) => setSize(t, 'depthIn', Number(e.target.value) || 0)} aria-label={`${t} depth`} /><span className="text-xs text-slate-500">in (W × overall D)</span></div>
            ); })}
          </div>
        )}
      </div>
      <div className="liquid-glass-inset rounded-2xl p-3 overflow-x-auto">
        <div className="font-bold text-slate-900 mb-2">Beams ({plan.beams.length})</div>
        <datalist id="ms-tags">{tags.map((t) => <option key={t} value={t} />)}</datalist>
        <table className="w-full text-sm min-w-[560px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1.5">Beam</th><th>Length (ft)</th><th>Width</th><th>Tag</th><th>From</th><th className="text-right">Leave out</th></tr></thead>
          <tbody>
            {plan.beams.map((b) => (
              <tr key={b.id} className={`border-b border-slate-100 ${picked === b.id ? 'bg-sky-50' : ''} ${skipped.has(b.id) ? 'opacity-50' : ''}`}>
                <td className="py-1 font-semibold">{b.id}</td>
                <td className="tabular-nums">{n2(b.length / 12)}</td>
                <td className="tabular-nums">{b.widthIn}"</td>
                <td><input list="ms-tags" disabled={!edit} className={`${inputCls} !py-1 !w-44 ${!tagOf(b) ? 'border-red-300' : ''}`} value={tagOf(b) || ''} placeholder="no tag" aria-label={`${b.id} tag`} onChange={(e) => setO((x) => ({ ...x, beamTags: { ...(x.beamTags || {}), [b.id]: e.target.value } }))} /></td>
                <td className="text-xs text-slate-500">{ov.beamTags && b.id in ov.beamTags ? 'you' : b.tagFrom === 'leader' ? 'drawing' : b.tagFrom === 'run' ? 'beam in line' : ''}</td>
                <td className="text-right"><input type="checkbox" disabled={!edit} checked={skipped.has(b.id)} aria-label={`Leave out ${b.id}`} onChange={(e) => setO((x) => ({ ...x, skipBeams: e.target.checked ? [...(x.skipBeams || []), b.id] : (x.skipBeams || []).filter((i) => i !== b.id) }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="liquid-glass-inset rounded-2xl p-3 overflow-x-auto">
        <div className="font-bold text-slate-900 mb-2">Columns & walls ({plan.columns.length})</div>
        <table className="w-full text-sm min-w-[480px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1.5">Mark</th><th>Kind</th><th>Size</th><th>Height (ft)</th><th className="text-right">Leave out</th></tr></thead>
          <tbody>
            {plan.columns.map((c) => (
              <tr key={c.id} className="border-b border-slate-100">
                <td className="py-1 font-semibold">{c.id}</td><td>{c.kind}</td><td className="tabular-nums">{Math.round(c.w * 10) / 10}" × {Math.round(c.d * 10) / 10}"</td>
                <td><input disabled={!edit} className={`${inputCls} !py-1 !w-20`} inputMode="decimal" value={ov.columnHeights?.[c.id] ?? settings.storeyHeightFt} aria-label={`${c.id} height`} onChange={(e) => setO((x) => ({ ...x, columnHeights: { ...(x.columnHeights || {}), [c.id]: Number(e.target.value) || 0 } }))} /></td>
                <td className="text-right"><input type="checkbox" disabled={!edit} checked={(ov.skipColumns || []).includes(c.id)} aria-label={`Leave out ${c.id}`} onChange={(e) => setO((x) => ({ ...x, skipColumns: e.target.checked ? [...(x.skipColumns || []), c.id] : (x.skipColumns || []).filter((i) => i !== c.id) }))} /></td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
};

const SlabsTab: React.FC<{ plan: Plan; edit: boolean; ov: Overrides; setO: (fn: (x: Overrides) => Overrides) => void; settings: Settings }> = ({ plan, edit, ov, setO, settings }) => (
  <div className="liquid-glass-inset rounded-2xl p-3 overflow-x-auto">
    <div className="font-bold text-slate-900 mb-1">Slab panels ({plan.panels.length})</div>
    <p className="text-xs text-slate-500 mb-2">Each panel is the clear area between beams and columns. Openings (void, stair, lift) are left out unless you tick them.</p>
    <table className="w-full text-sm min-w-[520px]">
      <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1.5">Panel</th><th>Kind</th><th>Area (sft)</th><th>Thickness (in)</th><th className="text-right">Include</th></tr></thead>
      <tbody>
        {plan.panels.map((p) => {
          const e = ov.panels?.[p.id] || {};
          const inc = p.kind === 'slab' ? e.include !== false : e.include === true;
          return (
            <tr key={p.id} className="border-b border-slate-100">
              <td className="py-1 font-semibold">{p.id}</td><td>{p.kind}{p.note ? <span className="text-xs text-slate-400"> · {p.note}</span> : null}</td>
              <td className="tabular-nums">{q2(p.areaSqIn / 144)}</td>
              <td><input disabled={!edit} className={`${inputCls} !py-1 !w-20`} inputMode="decimal" value={e.thicknessIn ?? settings.slabThicknessIn} aria-label={`${p.id} thickness`} onChange={(ev) => setO((x) => ({ ...x, panels: { ...(x.panels || {}), [p.id]: { ...e, thicknessIn: Number(ev.target.value) || 0 } } }))} /></td>
              <td className="text-right"><input type="checkbox" disabled={!edit} checked={inc} aria-label={`Include ${p.id}`} onChange={(ev) => setO((x) => ({ ...x, panels: { ...(x.panels || {}), [p.id]: { ...e, include: ev.target.checked } } }))} /></td>
            </tr>
          );
        })}
      </tbody>
    </table>
  </div>
);

const PART_LABEL: Record<Part, string> = { beam: 'Beams', column: 'Columns & walls', slab: 'Slab' };
const BudgetTab: React.FC<{ budget: BudgetOut; cfg: BudgetCfg; edit: boolean; onChange: (c: BudgetCfg) => void }> = ({ budget, cfg, edit, onChange }) => {
  const num = (v: string) => (v.trim() === '' || !Number.isFinite(Number(v)) ? 0 : Number(v));
  const setRate = (k: keyof BudgetCfg['rates'], v: string) => onChange({ ...cfg, rates: { ...cfg.rates, [k]: num(v) } });
  const setMix = (p: Part, i: number, v: string) => { const m = [...cfg.mix[p]] as [number, number, number]; m[i] = num(v); onChange({ ...cfg, mix: { ...cfg.mix, [p]: m } }); };
  const field = (label: string, value: number, on: (v: string) => void, aria: string) => (
    <div><label className={labelCls}>{label}</label><input disabled={!edit} className={inputCls} inputMode="decimal" value={value} aria-label={aria} onChange={(e) => on(e.target.value)} /></div>
  );
  return (
    <div className="space-y-4">
      <div className="liquid-glass-inset rounded-2xl p-3 overflow-x-auto">
        <div className="font-bold text-slate-900 mb-2">Material needed</div>
        <table className="w-full text-sm min-w-[640px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1.5">Element</th><th className="text-right">Concrete (cft)</th><th className="text-right">Cement (bag)</th><th className="text-right">Sand (cft)</th><th className="text-right">Stone (cft)</th><th className="text-right">Rod (kg)</th><th className="text-right">Shuttering (sft)</th></tr></thead>
          <tbody>
            {budget.parts.map((p) => (
              <tr key={p.key} className="border-b border-slate-100"><td className="py-1 font-semibold">{p.label}</td>{[p.concrete, p.cement, p.sand, p.stone, p.steel, p.shuttering].map((v, i) => <td key={i} className="text-right tabular-nums">{q2(v)}</td>)}</tr>
            ))}
            <tr className="font-bold"><td className="py-1">Total</td>{(['concrete', 'cement', 'sand', 'stone', 'steel', 'shuttering'] as const).map((k) => <td key={k} className="text-right tabular-nums">{q2(budget.parts.reduce((t, p) => t + p[k], 0))}</td>)}</tr>
          </tbody>
        </table>
        <div className="text-xs text-slate-500 mt-1">Rod total: {q2(budget.parts.reduce((t, p) => t + p.steel, 0) / 1000)} ton</div>
      </div>
      <div className="liquid-glass-inset rounded-2xl p-3 overflow-x-auto">
        <div className="font-bold text-slate-900 mb-2">Cost</div>
        <table className="w-full text-sm min-w-[520px]">
          <thead><tr className="text-left text-xs text-slate-500 border-b border-slate-200"><th className="py-1.5">Material</th><th className="text-right">Qty</th><th>Unit</th><th className="text-right">Rate (Tk)</th><th className="text-right">Amount (Tk)</th></tr></thead>
          <tbody>
            {budget.lines.map((l) => (
              <tr key={l.key} className="border-b border-slate-100"><td className="py-1">{l.label}</td><td className="text-right tabular-nums">{q2(l.qty)}</td><td className="pl-1">{l.unit}</td>
                <td className="text-right"><input disabled={!edit} className={`${inputCls} !py-1 !w-28 text-right`} inputMode="decimal" value={cfg.rates[l.key as keyof BudgetCfg['rates']]} aria-label={`${l.label} rate`} onChange={(e) => setRate(l.key as keyof BudgetCfg['rates'], e.target.value)} /></td>
                <td className="text-right tabular-nums">{q2(l.amount)}</td></tr>
            ))}
            <tr className="font-bold"><td className="py-1.5" colSpan={4}>Total material cost</td><td className="text-right tabular-nums">Tk {q2(budget.total)}</td></tr>
          </tbody>
        </table>
        {budget.rateMissing && <div className="text-xs text-amber-700 mt-2">Some rates are 0 — fill them in and Save & recalculate to get the cost.</div>}
      </div>
      <div className="liquid-glass-inset rounded-2xl p-4 space-y-4">
        <div className="font-bold text-slate-900">Mix and rod, per element</div>
        <div className="grid gap-3 sm:grid-cols-3">
          {(['beam', 'column', 'slab'] as Part[]).map((p) => (
            <div key={p} className="space-y-2">
              <div className="text-sm font-semibold">{PART_LABEL[p]}</div>
              <label className={labelCls}>Mix (cement : sand : stone)</label>
              <div className="flex gap-1.5">{[0, 1, 2].map((i) => <input key={i} disabled={!edit} className={inputCls} inputMode="decimal" value={cfg.mix[p][i]} aria-label={`${PART_LABEL[p]} mix ${i + 1}`} onChange={(e) => setMix(p, i, e.target.value)} />)}</div>
              {field('Rod (kg per cft of concrete)', cfg.steelKgPerCft[p], (v) => onChange({ ...cfg, steelKgPerCft: { ...cfg.steelKgPerCft, [p]: num(v) } }), `${PART_LABEL[p]} rod kg per cft`)}
            </div>
          ))}
        </div>
        <div className="grid gap-3 sm:grid-cols-4">
          {field('Cement bag volume (cft)', cfg.cementBagCft, (v) => onChange({ ...cfg, cementBagCft: num(v) }), 'Cement bag volume')}
          {field('Dry volume factor', cfg.dryFactor, (v) => onChange({ ...cfg, dryFactor: num(v) }), 'Dry volume factor')}
          {field('Waste — materials (%)', cfg.wastagePct, (v) => onChange({ ...cfg, wastagePct: num(v) }), 'Material waste')}
          {field('Waste — rod (%)', cfg.steelWastagePct, (v) => onChange({ ...cfg, steelWastagePct: num(v) }), 'Rod waste')}
        </div>
        <ul className="text-xs text-slate-500 list-disc pl-5 space-y-0.5">{[...budget.notes, ...(budget.repeatsNote ? [budget.repeatsNote] : [])].map((n, i) => <li key={i}>{n}</li>)}</ul>
      </div>
    </div>
  );
};

const SettingsTab: React.FC<{ d: Detail; settings: Settings; setS: (p: Partial<Settings>) => void; edit: boolean; onReset: () => void }> = ({ d, settings, setS, edit, onReset }) => {
  const num = (label: string, k: keyof Settings, hint?: string) => (
    <div><label className={labelCls}>{label}</label><input disabled={!edit} className={inputCls} inputMode="decimal" value={String(settings[k] ?? '')} onChange={(e) => setS({ [k]: Number(e.target.value) || 0 } as any)} />{hint && <div className="text-[11px] text-slate-400 mt-0.5">{hint}</div>}</div>
  );
  const layerPick = (label: string, k: 'beamLayers' | 'columnLayers', used: string[]) => (
    <div>
      <label className={labelCls}>{label}</label>
      <div className="flex flex-wrap gap-1.5">
        {d.all_layers.filter((l) => l.lines + l.polys > 0).map((l) => {
          const cur = settings[k] ?? used;
          const on = cur.includes(l.name);
          return <button key={l.name} type="button" disabled={!edit} onClick={() => setS({ [k]: on ? cur.filter((x) => x !== l.name) : [...cur, l.name] } as any)} className={`text-xs px-2.5 py-1 rounded-full border ${on ? 'bg-sky-600 text-white border-sky-600' : 'bg-white/70 text-slate-600 border-slate-200'}`}>{l.name} <span className="opacity-60">{l.lines + l.polys}</span></button>;
        })}
      </div>
    </div>
  );
  return (
    <div className="liquid-glass-inset rounded-2xl p-4 space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        {num('Slab thickness (in)', 'slabThicknessIn')}
        {num('Storey height — columns & walls (ft)', 'storeyHeightFt')}
        {num('Floors this plan repeats for', 'repeats', 'Typical floors: totals are multiplied')}
        {num('Beam width when untagged (in)', 'defaultBeamWidthIn')}
        {num('Beam overall depth when untagged (in)', 'defaultBeamDepthIn')}
        <div><label className={labelCls}>Drawing unit</label><div className="text-sm py-2.5">{d.model.unitName}</div></div>
      </div>
      <label className="flex items-center gap-2 text-sm"><input type="checkbox" disabled={!edit} checked={settings.deductSlabFromBeam} onChange={(e) => setS({ deductSlabFromBeam: e.target.checked })} /> Take the slab thickness off the beam depth (the slab is measured on its own)</label>
      {layerPick('Beam layers', 'beamLayers', d.model.usedBeamLayers)}
      {layerPick('Column / wall layers', 'columnLayers', d.model.usedColumnLayers)}
      {d.model.notes.length > 0 && <ul className="text-xs text-slate-500 list-disc pl-5">{d.model.notes.map((n, i) => <li key={i}>{n}</li>)}</ul>}
      {edit && <button type="button" className={ghostBtn} onClick={onReset}><RefreshCw className="w-4 h-4 inline mr-1" />Undo setting changes</button>}
    </div>
  );
};

// ---------------------------------------------------------------------------
const fileBase = (t: string) => t.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_|_$/g, '') || 'Measurement_Sheet';

function exportExcel(title: string, sheets: SheetT[], settings: Settings, budget?: BudgetOut) {
  const wb = XLSX.utils.book_new();
  sheets.forEach((sh) => {
    const aoa: any[][] = [[title], [sh.plan.title + (sh.repeats > 1 ? ` — x${sh.repeats} floors` : '')], []];
    for (const sec of sh.sections) {
      aoa.push([SECTION_LABEL[sec.key] || sec.title]);
      aoa.push(['Description', 'Nos', 'L (ft)', 'B (ft)', 'D (ft)', 'Qty', 'Unit', 'Remark']);
      for (const r of sec.rows) aoa.push(r.kind === 'head' ? [r.desc] : [r.desc, r.kind === 'item' ? r.nos : '', r.l ?? '', r.b ?? '', r.d ?? '', Math.round(r.qty * 100) / 100, r.unit, r.remark || '']);
      for (const t of sec.totals) aoa.push([`TOTAL ${t.label}`, '', '', '', '', Math.round(t.qty * 100) / 100, t.unit]);
      aoa.push([]);
    }
    aoa.push(['How this was worked out']);
    sh.assumptions.forEach((a) => aoa.push([a]));
    aoa.push([`Slab ${settings.slabThicknessIn}" · storey ${settings.storeyHeightFt} ft`]);
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 52 }, { wch: 7 }, { wch: 10 }, { wch: 10 }, { wch: 10 }, { wch: 12 }, { wch: 7 }, { wch: 30 }];
    XLSX.utils.book_append_sheet(wb, ws, sh.plan.title.replace(/[\\/?*[\]:]/g, ' ').slice(0, 31) || 'Plan');
  });
  if (budget) {
    const aoa: any[][] = [[title], ['Material Budget'], [], ['Element', 'Concrete (cft)', 'Cement (bag)', 'Sand (cft)', 'Stone (cft)', 'Rod (kg)', 'Shuttering (sft)']];
    budget.parts.forEach((p) => aoa.push([p.label, p.concrete, p.cement, p.sand, p.stone, p.steel, p.shuttering]));
    aoa.push([], ['Material', 'Qty', 'Unit', 'Rate (Tk)', 'Amount (Tk)']);
    budget.lines.forEach((l) => aoa.push([l.label, l.qty, l.unit, l.rate, l.amount]));
    aoa.push(['Total material cost', '', '', '', budget.total], []);
    budget.notes.forEach((n) => aoa.push([n]));
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    ws['!cols'] = [{ wch: 30 }, { wch: 16 }, { wch: 14 }, { wch: 14 }, { wch: 14 }, { wch: 12 }, { wch: 16 }];
    XLSX.utils.book_append_sheet(wb, ws, 'Material Budget');
  }
  XLSX.writeFile(wb, `${fileBase(title)}.xlsx`);
}

function exportPdf(title: string, fileName: string | null, sheets: SheetT[], settings: Settings, budget?: BudgetOut) {
  const doc = new jsPDF({ orientation: 'landscape', unit: 'pt', format: 'a4' });
  sheets.forEach((sh, i) => {
    if (i > 0) doc.addPage();
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text('Measurement Sheet', 40, 40);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal');
    doc.text(`${title} — ${sh.plan.title}${sh.repeats > 1 ? ` (x${sh.repeats} floors)` : ''}`, 40, 56);
    if (fileName) doc.text(`Drawing: ${fileName}`, 40, 70);
    let y = 82;
    for (const sec of sh.sections) {
      const body: any[] = sec.rows.map((r) => r.kind === 'head'
        ? [{ content: r.desc, colSpan: 8, styles: { fontStyle: 'bold', fillColor: [241, 245, 249] } }]
        : [r.desc, r.kind === 'item' ? String(r.nos) : '', n2(r.l), n2(r.b), n2(r.d), q2(r.qty), r.unit, r.remark || '']);
      for (const t of sec.totals) body.push([{ content: `TOTAL ${t.label}`, colSpan: 5, styles: { fontStyle: 'bold', halign: 'right' } }, { content: q2(t.qty), styles: { fontStyle: 'bold', halign: 'right' } }, { content: t.unit, styles: { fontStyle: 'bold' } }, '']);
      autoTable(doc, {
        startY: y, head: [[{ content: SECTION_LABEL[sec.key] || sec.title, colSpan: 8, styles: { halign: 'left' } }], ['Description', 'Nos', 'L (ft)', 'B (ft)', 'D (ft)', 'Qty', 'Unit', 'Remark']],
        body, styles: { fontSize: 8, cellPadding: 3 }, headStyles: { fillColor: [14, 116, 144] },
        columnStyles: { 1: { halign: 'right' }, 2: { halign: 'right' }, 3: { halign: 'right' }, 4: { halign: 'right' }, 5: { halign: 'right' } },
        margin: { left: 40, right: 40 }
      });
      y = (doc as any).lastAutoTable.finalY + 14;
      if (y > 520) { doc.addPage(); y = 40; }
    }
    doc.setFontSize(8);
    const notes = [...sh.assumptions, `Slab ${settings.slabThicknessIn}" · storey height ${settings.storeyHeightFt} ft`];
    const lines = doc.splitTextToSize(notes.join('  •  '), 760);
    if (y + lines.length * 10 > 560) { doc.addPage(); y = 40; }
    doc.text(lines, 40, y + 8);
  });
  if (budget) {
    doc.addPage();
    doc.setFontSize(14); doc.setFont('helvetica', 'bold'); doc.text('Material Budget', 40, 40);
    doc.setFontSize(10); doc.setFont('helvetica', 'normal'); doc.text(title, 40, 56);
    autoTable(doc, {
      startY: 70, head: [['Element', 'Concrete (cft)', 'Cement (bag)', 'Sand (cft)', 'Stone (cft)', 'Rod (kg)', 'Shuttering (sft)']],
      body: budget.parts.map((p) => [p.label, q2(p.concrete), q2(p.cement), q2(p.sand), q2(p.stone), q2(p.steel), q2(p.shuttering)]),
      styles: { fontSize: 8, cellPadding: 3 }, headStyles: { fillColor: [14, 116, 144] }, margin: { left: 40, right: 40 }
    });
    autoTable(doc, {
      startY: (doc as any).lastAutoTable.finalY + 14, head: [['Material', 'Qty', 'Unit', 'Rate (Tk)', 'Amount (Tk)']],
      body: [...budget.lines.map((l) => [l.label, q2(l.qty), l.unit, q2(l.rate), q2(l.amount)]), [{ content: 'Total material cost', colSpan: 4, styles: { fontStyle: 'bold', halign: 'right' } }, { content: q2(budget.total), styles: { fontStyle: 'bold' } }]],
      styles: { fontSize: 8, cellPadding: 3 }, headStyles: { fillColor: [14, 116, 144] }, margin: { left: 40, right: 40 }
    });
    doc.setFontSize(8);
    doc.text(doc.splitTextToSize(budget.notes.join('  •  '), 760), 40, (doc as any).lastAutoTable.finalY + 16);
  }
  doc.save(`${fileBase(title)}.pdf`);
}
