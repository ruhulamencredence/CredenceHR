/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// New Joiner Onboarding — the joiner's own form (personal details, address,
// emergency contacts, nominees, documents) on My Onboarding, and the same
// data read-only for HR's review (OnboardingSummary). The server keeps only
// known fields and decides what is still missing (OnboardingSelfServiceRoutes.ts).

import React, { useState } from 'react';
import { Plus, Trash2, Upload, FileText, Eye, Save, Send, AlertTriangle, User as UserIcon, MapPin, Phone, HeartHandshake, FolderOpen, CreditCard } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { confirmDialog } from '../lib/confirmDialog';
import { RequisitionPanel } from './MyRequisitions';

export interface PersonEntry {
  name: string;
  relation: string | null;
  phone: string | null;
  nid: string | null;
  date_of_birth: string | null;
  address: string | null;
  nominee_percent: number | null;
}
export interface OnboardingData {
  personal: Record<string, string | null>;
  contacts: PersonEntry[];
  nominees: PersonEntry[];
}
export interface OnboardingDocument {
  id: number;
  doc_type: string;
  file_name: string;
  file_mime: string | null;
  size: number;
  uploaded_at: string | null;
}
export interface OnboardingFormState {
  data: OnboardingData;
  documents: OnboardingDocument[];
  required_documents: string[];
  required_fields: string[];
  missing: string[];
}

const PERSONAL: { key: string; label: string; type?: 'date' | 'email' | 'tel'; options?: string[]; required?: boolean }[] = [
  { key: 'gender', label: 'Gender', options: ['Male', 'Female', 'Other'], required: true },
  { key: 'date_of_birth', label: 'Date of birth', type: 'date', required: true },
  { key: 'nid_ssn', label: 'NID number', required: true },
  { key: 'nationality', label: 'Nationality' },
  { key: 'marital_status', label: 'Marital status', options: ['Single', 'Married', 'Divorced', 'Widowed'] },
  { key: 'blood_group', label: 'Blood group', options: ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'] },
  { key: 'religion', label: 'Religion' },
  { key: 'mobile', label: 'Mobile', type: 'tel', required: true },
  { key: 'telephone', label: 'Other phone', type: 'tel' },
  { key: 'personal_email', label: 'Personal email', type: 'email' }
];
const ADDRESS_PARTS = [
  { key: 'address', label: 'Address', required: true },
  { key: 'city', label: 'City / district' },
  { key: 'zip', label: 'Post code' }
];

const inputCls = 'w-full text-sm px-3 py-2.5 bg-white border border-slate-200 rounded-xl focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:bg-slate-50 disabled:text-slate-500';
const labelCls = 'block text-[11px] font-semibold text-slate-500 mb-1';
const emptyPerson = (): PersonEntry => ({ name: '', relation: '', phone: '', nid: '', date_of_birth: '', address: '', nominee_percent: null });
const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);

const Card: React.FC<{ icon: React.ComponentType<{ className?: string }>; title: string; hint?: string; children: React.ReactNode }> = ({ icon: Icon, title, hint, children }) => (
  <section className="rounded-2xl border border-slate-200 bg-white p-5">
    <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
      <Icon className="w-4 h-4 text-blue-600" /> {title}
    </div>
    {hint && <p className="text-xs text-slate-500 mt-0.5">{hint}</p>}
    <div className="mt-4">{children}</div>
  </section>
);

// Opens a stored file in a new tab (it needs the sign-in header, so it goes
// through a blob instead of a plain link).
export async function openOnboardingFile(token: string, path: string) {
  const win = window.open('', '_blank');
  const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    win?.close();
    return;
  }
  const url = URL.createObjectURL(await res.blob());
  if (win) win.location.href = url;
  else window.open(url, '_blank');
  setTimeout(() => URL.revokeObjectURL(url), 60_000);
}

const PeopleEditor: React.FC<{
  list: PersonEntry[];
  nominee?: boolean;
  disabled: boolean;
  onChange: (l: PersonEntry[]) => void;
}> = ({ list, nominee, disabled, onChange }) => {
  const set = (i: number, k: keyof PersonEntry, v: any) => onChange(list.map((p, j) => (j === i ? { ...p, [k]: v } : p)));
  return (
    <div className="space-y-3">
      {list.map((p, i) => (
        <div key={i} className="rounded-xl border border-slate-200 bg-slate-50/60 p-3 space-y-2">
          <div className="flex items-center justify-between">
            <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
              {nominee ? 'Nominee' : 'Contact'} {i + 1}
            </span>
            {!disabled && (
              <button type="button" onClick={() => onChange(list.filter((_, j) => j !== i))} className="p-1 rounded text-slate-400 hover:text-rose-600" aria-label="Remove">
                <Trash2 className="w-4 h-4" />
              </button>
            )}
          </div>
          <div className="grid sm:grid-cols-2 gap-2">
            <input disabled={disabled} placeholder="Full name *" value={p.name || ''} onChange={(e) => set(i, 'name', e.target.value)} className={inputCls} />
            <input disabled={disabled} placeholder="Relation (e.g. Father, Spouse)" value={p.relation || ''} onChange={(e) => set(i, 'relation', e.target.value)} className={inputCls} />
            <input disabled={disabled} type="tel" placeholder={nominee ? 'Phone' : 'Phone *'} value={p.phone || ''} onChange={(e) => set(i, 'phone', e.target.value)} className={inputCls} />
            {nominee ? (
              <>
                <input disabled={disabled} placeholder="NID number" value={p.nid || ''} onChange={(e) => set(i, 'nid', e.target.value)} className={inputCls} />
                <div>
                  <label className={labelCls}>Date of birth</label>
                  <input disabled={disabled} type="date" value={p.date_of_birth || ''} onChange={(e) => set(i, 'date_of_birth', e.target.value)} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Share %</label>
                  <input
                    disabled={disabled}
                    type="number"
                    min={0}
                    max={100}
                    inputMode="decimal"
                    value={p.nominee_percent ?? ''}
                    onChange={(e) => set(i, 'nominee_percent', e.target.value === '' ? null : Number(e.target.value))}
                    className={inputCls}
                  />
                </div>
              </>
            ) : null}
          </div>
          <input disabled={disabled} placeholder="Address" value={p.address || ''} onChange={(e) => set(i, 'address', e.target.value)} className={inputCls} />
        </div>
      ))}
      {!disabled && list.length < 10 && (
        <button
          type="button"
          onClick={() => onChange([...list, emptyPerson()])}
          className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-dashed border-slate-300 text-slate-600 hover:bg-slate-50"
        >
          <Plus className="w-3.5 h-3.5" /> Add {nominee ? 'nominee' : 'contact'}
        </button>
      )}
      {nominee && list.length > 1 && (
        <p className="text-[11px] text-slate-500">With more than one nominee, give each a share — together 100 %.</p>
      )}
    </div>
  );
};

export const OnboardingForm: React.FC<{
  token: string;
  initial: OnboardingFormState;
  editable: boolean;
  onSubmitted: () => void;
}> = ({ token, initial, editable, onSubmitted }) => {
  const [data, setData] = useState<OnboardingData>(() => ({
    personal: { ...initial.data.personal },
    contacts: initial.data.contacts.length ? initial.data.contacts : [emptyPerson()],
    nominees: initial.data.nominees.length ? initial.data.nominees : [emptyPerson()]
  }));
  const [docs, setDocs] = useState(initial.documents);
  const [missing, setMissing] = useState(initial.missing);
  const [sameAddress, setSameAddress] = useState(false);
  const [busy, setBusy] = useState<'save' | 'submit' | string | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [otherType, setOtherType] = useState('');
  const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const setP = (k: string, v: string) => setData((d) => ({ ...d, personal: { ...d.personal, [k]: v } }));
  // The permanent address follows the present one while "same" is ticked.
  const payload = (): OnboardingData => {
    if (!sameAddress) return data;
    const personal = { ...data.personal };
    for (const part of ADDRESS_PARTS) personal[`permanent_${part.key}`] = personal[`present_${part.key}`];
    return { ...data, personal };
  };
  const call = async (method: string, path: string, body?: any) => {
    const res = await fetch(apiUrl(path), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
    const json = await res.json().catch(() => ({}));
    if (!res.ok) throw Object.assign(new Error(json.error || 'Something went wrong.'), { missing: json.missing });
    return json;
  };
  const apply = (state: Partial<OnboardingFormState>) => {
    if (state.documents) setDocs(state.documents);
    if (state.missing) setMissing(state.missing);
  };

  const save = async () => {
    setBusy('save');
    setMsg(null);
    try {
      apply(await call('PUT', '/api/onboarding/me', payload()));
      setMsg({ type: 'success', text: 'Saved. You can come back and finish later.' });
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  };
  const submit = async () => {
    setMsg(null);
    setBusy('save');
    try {
      const state = await call('PUT', '/api/onboarding/me', payload());
      apply(state);
      if (state.missing?.length) {
        setMsg({ type: 'error', text: 'Fill in what is listed above first.' });
        return;
      }
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
      return;
    } finally {
      setBusy(null);
    }
    if (!(await confirmDialog('Submit your details to HR? You can’t change them while HR reviews.', { title: 'Submit to HR', confirmLabel: 'Submit', tone: 'default' }))) return;
    setBusy('submit');
    try {
      await call('POST', '/api/onboarding/me/submit', payload());
      onSubmitted();
    } catch (e: any) {
      if (e.missing) setMissing(e.missing);
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  };

  const upload = (docType: string, file: File) => {
    if (file.size > 8 * 1024 * 1024) return setMsg({ type: 'error', text: 'File is larger than 8 MB.' });
    const reader = new FileReader();
    reader.onload = async () => {
      setBusy(`doc:${docType}`);
      try {
        apply(
          await call('POST', '/api/onboarding/me/documents', {
            doc_type: docType,
            file_name: file.name,
            file_mime: file.type || 'application/octet-stream',
            file_base64: String(reader.result).split(',')[1]
          })
        );
        setOtherType('');
      } catch (e: any) {
        setMsg({ type: 'error', text: e.message });
      } finally {
        setBusy(null);
      }
    };
    reader.readAsDataURL(file);
  };
  const removeDoc = async (d: OnboardingDocument) => {
    if (!(await confirmDialog(`Remove ${d.file_name}?`))) return;
    try {
      apply(await call('DELETE', `/api/onboarding/me/documents/${d.id}`));
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };

  const docRow = (type: string, required: boolean) => {
    const d = docs.find((x) => x.doc_type === type);
    return (
      <li key={type} className="flex flex-wrap items-center gap-3 py-2.5">
        <FileText className={`w-4 h-4 shrink-0 ${d ? 'text-emerald-600' : 'text-slate-300'}`} />
        <div className="flex-1 min-w-[140px]">
          <div className="text-sm font-medium text-slate-800">
            {type}
            {required && <span className="text-rose-500"> *</span>}
          </div>
          <div className="text-[11px] text-slate-500 truncate">{d ? `${d.file_name} · ${kb(d.size)}` : 'Not uploaded'}</div>
        </div>
        <div className="flex gap-1.5">
          {d && (
            <button type="button" onClick={() => openOnboardingFile(token, `/api/onboarding/me/documents/${d.id}`)} className="p-2 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-50" aria-label={`View ${type}`}>
              <Eye className="w-3.5 h-3.5" />
            </button>
          )}
          {editable && (
            <label className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border cursor-pointer ${d ? 'border-slate-200 text-slate-700 bg-white hover:bg-slate-50' : 'border-blue-200 text-blue-700 bg-blue-50 hover:bg-blue-100'}`}>
              <Upload className="w-3.5 h-3.5" /> {busy === `doc:${type}` ? 'Uploading…' : d ? 'Replace' : 'Upload'}
              <input
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f) upload(type, f);
                }}
              />
            </label>
          )}
          {editable && d && !required && (
            <button type="button" onClick={() => removeDoc(d)} className="p-2 rounded-lg border border-slate-200 text-slate-400 hover:text-rose-600" aria-label={`Remove ${type}`}>
              <Trash2 className="w-3.5 h-3.5" />
            </button>
          )}
        </div>
      </li>
    );
  };
  // Field checks follow what is typed now (same rules as the server's);
  // document checks come from the server's last answer.
  const liveMissing = (() => {
    const d = payload();
    const out = PERSONAL.filter((f) => f.required && !String(d.personal[f.key] || '').trim()).map((f) => f.label);
    for (const kind of ['present', 'permanent']) if (!String(d.personal[`${kind}_address`] || '').trim()) out.push(kind === 'present' ? 'Present address' : 'Permanent address');
    if (!d.contacts.some((c) => String(c.name || '').trim() && String(c.phone || '').trim())) out.push('An emergency contact with a phone number');
    const nominees = d.nominees.filter((n) => String(n.name || '').trim());
    if (nominees.length === 0) out.push('A nominee');
    const shares = nominees.map((n) => n.nominee_percent).filter((x): x is number => x !== null && x !== undefined);
    if (shares.length > 0 && Math.abs(shares.reduce((a, b) => a + b, 0) - 100) > 0.01) out.push('Nominee shares adding up to 100 %');
    return [...out, ...missing.filter((m) => m.startsWith('Document:'))];
  })();
  const others = docs.filter((d) => !initial.required_documents.includes(d.doc_type)).map((d) => d.doc_type);

  return (
    <div className="space-y-4">
      <Card icon={UserIcon} title="Personal details" hint="Fields marked * are needed before you submit.">
        <div className="grid sm:grid-cols-2 gap-3">
          {PERSONAL.map((f) => (
            <div key={f.key}>
              <label className={labelCls}>
                {f.label}
                {f.required && <span className="text-rose-500"> *</span>}
              </label>
              {f.options ? (
                <select disabled={!editable} value={data.personal[f.key] || ''} onChange={(e) => setP(f.key, e.target.value)} className={inputCls}>
                  <option value="">—</option>
                  {f.options.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              ) : (
                <input disabled={!editable} type={f.type || 'text'} value={data.personal[f.key] || ''} onChange={(e) => setP(f.key, e.target.value)} className={inputCls} />
              )}
            </div>
          ))}
        </div>
      </Card>

      <Card icon={MapPin} title="Address">
        {(['present', 'permanent'] as const).map((kind) => (
          <div key={kind} className={kind === 'permanent' ? 'mt-4' : ''}>
            <div className="flex items-center justify-between mb-2">
              <div className="text-xs font-bold text-slate-700">{kind === 'present' ? 'Present address' : 'Permanent address'}</div>
              {kind === 'permanent' && editable && (
                <label className="flex items-center gap-1.5 text-xs text-slate-600">
                  <input type="checkbox" checked={sameAddress} onChange={(e) => setSameAddress(e.target.checked)} /> Same as present
                </label>
              )}
            </div>
            {kind === 'permanent' && sameAddress ? (
              <p className="text-xs text-slate-500">The present address is used.</p>
            ) : (
              <div className="grid sm:grid-cols-[2fr_1fr_1fr] gap-2">
                {ADDRESS_PARTS.map((part) => (
                  <input
                    key={part.key}
                    disabled={!editable}
                    placeholder={`${part.label}${part.required ? ' *' : ''}`}
                    value={data.personal[`${kind}_${part.key}`] || ''}
                    onChange={(e) => setP(`${kind}_${part.key}`, e.target.value)}
                    className={inputCls}
                  />
                ))}
              </div>
            )}
          </div>
        ))}
      </Card>

      <Card icon={Phone} title="Emergency contact *" hint="Who we call if something happens to you at work.">
        <PeopleEditor list={data.contacts} disabled={!editable} onChange={(contacts) => setData((d) => ({ ...d, contacts }))} />
      </Card>

      <Card icon={HeartHandshake} title="Nominee *" hint="Who receives your benefits (provident fund, gratuity, insurance) if you can't.">
        <PeopleEditor nominee list={data.nominees} disabled={!editable} onChange={(nominees) => setData((d) => ({ ...d, nominees }))} />
      </Card>

      <Card icon={FolderOpen} title="Documents" hint="PDF or a photo, up to 8 MB each.">
        <ul className="divide-y divide-slate-100">
          {initial.required_documents.map((t) => docRow(t, true))}
          {others.map((t) => docRow(t, false))}
        </ul>
        {editable && (
          <div className="mt-3 flex flex-wrap gap-2 items-center">
            <input value={otherType} onChange={(e) => setOtherType(e.target.value)} placeholder="Other document (e.g. Experience certificate)" className={`${inputCls} flex-1 min-w-[200px]`} />
            <label
              className={`inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2.5 rounded-xl border ${otherType.trim() ? 'border-slate-200 text-slate-700 bg-white hover:bg-slate-50 cursor-pointer' : 'border-slate-100 text-slate-300 pointer-events-none'}`}
            >
              <Upload className="w-3.5 h-3.5" /> Upload
              <input
                type="file"
                accept="image/*,application/pdf"
                className="hidden"
                disabled={!otherType.trim()}
                onChange={(e) => {
                  const f = e.target.files?.[0];
                  e.target.value = '';
                  if (f && otherType.trim()) upload(otherType.trim(), f);
                }}
              />
            </label>
          </div>
        )}
      </Card>

      {/* SIM / ID card requests — only while HR has them turned on (RequisitionRoutes.ts). */}
      <RequisitionPanel
        token={token}
        joiner
        wrap={(body) => (
          <Card icon={CreditCard} title="SIM & ID card" hint="Ask HR for a company SIM or an ID card. They are handed over once you join.">
            {body}
          </Card>
        )}
      />

      {editable && (
        <>
          {liveMissing.length > 0 && (
            <div className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-xs text-amber-900">
              <div className="flex items-center gap-1.5 font-semibold">
                <AlertTriangle className="w-4 h-4" /> Still needed before you can submit
              </div>
              <ul className="mt-1.5 list-disc pl-5 space-y-0.5">
                {liveMissing.map((m) => (
                  <li key={m}>{m}</li>
                ))}
              </ul>
            </div>
          )}
          {msg && (
            <div className={`rounded-xl px-4 py-3 text-sm border ${msg.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>{msg.text}</div>
          )}
          <div className="sticky bottom-0 -mx-4 px-4 py-3 bg-slate-50/95 backdrop-blur border-t border-slate-200 flex gap-2.5" style={{ paddingBottom: 'calc(12px + env(safe-area-inset-bottom, 0px))' }}>
            <button type="button" onClick={save} disabled={!!busy} className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm font-semibold text-slate-700 disabled:opacity-50">
              <Save className="w-4 h-4" /> {busy === 'save' ? 'Saving…' : 'Save draft'}
            </button>
            <button type="button" onClick={submit} disabled={!!busy} className="flex-1 inline-flex items-center justify-center gap-1.5 py-2.5 rounded-xl bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold disabled:opacity-50">
              <Send className="w-4 h-4" /> {busy === 'submit' ? 'Submitting…' : 'Submit to HR'}
            </button>
          </div>
        </>
      )}
    </div>
  );
};

// Read-only view of the same data, for HR's review.
export const OnboardingSummary: React.FC<{ data: OnboardingData }> = ({ data }) => {
  const row = (label: string, v: any) => (
    <div key={label} className="min-w-0">
      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{label}</div>
      <div className="text-xs font-medium text-slate-800 break-words">{v || '—'}</div>
    </div>
  );
  const addr = (kind: 'present' | 'permanent') =>
    [data.personal[`${kind}_address`], data.personal[`${kind}_city`], data.personal[`${kind}_zip`]].filter(Boolean).join(', ');
  const people = (list: PersonEntry[], nominee: boolean) =>
    list.length === 0 ? (
      <div className="text-xs text-slate-400">None given</div>
    ) : (
      <ul className="space-y-1.5">
        {list.map((p, i) => (
          <li key={i} className="text-xs text-slate-700">
            <b>{p.name}</b>
            {p.relation ? ` (${p.relation})` : ''}
            {p.phone ? ` · ${p.phone}` : ''}
            {nominee && p.nid ? ` · NID ${p.nid}` : ''}
            {nominee && p.nominee_percent != null ? ` · ${p.nominee_percent}%` : ''}
            {p.address ? <div className="text-slate-500">{p.address}</div> : null}
          </li>
        ))}
      </ul>
    );
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-x-4 gap-y-3">{PERSONAL.map((f) => row(f.label, data.personal[f.key]))}</div>
      <div className="grid sm:grid-cols-2 gap-x-4 gap-y-3">
        {row('Present address', addr('present'))}
        {row('Permanent address', addr('permanent'))}
      </div>
      <div className="grid sm:grid-cols-2 gap-4">
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Emergency contacts</div>
          {people(data.contacts, false)}
        </div>
        <div>
          <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400 mb-1">Nominees</div>
          {people(data.nominees, true)}
        </div>
      </div>
    </div>
  );
};
