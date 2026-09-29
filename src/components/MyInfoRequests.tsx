/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My Letters & Service Record -> "Pending Items": what HR
// has asked this Employee for (HrOpsInfoRequestsRoutes.ts) — a document to
// upload (photo from the phone camera or a PDF), nominee details (shares must
// total 100%) or an emergency contact. A submission goes to HR for approval
// and is added to the record only once HR approves it; if HR sends it back,
// the reason shows here and it can be submitted again.

import React, { useEffect, useState } from 'react';
import { Camera, CheckCircle2, Clock, Paperclip, Plus, Send, Trash2, XCircle } from 'lucide-react';
import { Spinner } from './Spinner';
import { readFileBase64 } from './HrOps360Parts';
import { useHrApi, Badge, Notice, fmtDate, inputCls, labelCls, btnPrimary, btnGhost } from './HrOpsShared';

interface MyItem {
  id: number;
  item_type: 'document' | 'nominee' | 'emergency_contact';
  item_label: string;
  note: string | null;
  due_date: string | null;
  overdue: boolean;
  status: 'pending' | 'submitted' | 'rejected' | 'approved';
  review_remarks: string | null;
  submitted_at: string | null;
  file_name: string | null;
}
interface Person {
  name: string;
  relation: string;
  phone: string;
  date_of_birth: string;
  nid: string;
  address: string;
  nominee_percent: string;
}
const blank = (): Person => ({ name: '', relation: '', phone: '', date_of_birth: '', nid: '', address: '', nominee_percent: '' });
const RELATIONS = ['Father', 'Mother', 'Spouse', 'Wife', 'Husband', 'Son', 'Daughter', 'Brother', 'Sister', 'Other'];

export function useMyOpenRequests(token: string) {
  const api = useHrApi(token);
  const [open, setOpen] = useState(0);
  useEffect(() => {
    api
      .get<{ open: number }>('/api/hr-ops/my/info-requests')
      .then((d) => setOpen(d.open))
      .catch(() => setOpen(0));
  }, [api]);
  return open;
}

const ItemForm: React.FC<{ token: string; item: MyItem; family: any[]; onDone: (text: string) => void }> = ({ token, item, family, onDone }) => {
  const api = useHrApi(token);
  const [file, setFile] = useState<File | null>(null);
  const [expiry, setExpiry] = useState('');
  const [comment, setComment] = useState('');
  const [people, setPeople] = useState<Person[]>(() => {
    // Start from what HR already has on record.
    const fromRecord = family
      .filter((f) => (item.item_type === 'nominee' ? f.is_nominee : f.is_emergency))
      .map((f) => ({
        name: f.name || '',
        relation: f.relation || '',
        phone: f.phone || '',
        date_of_birth: f.date_of_birth || '',
        nid: f.nid || '',
        address: f.address || '',
        nominee_percent: f.nominee_percent != null ? String(f.nominee_percent) : ''
      }));
    return fromRecord.length ? fromRecord : [{ ...blank(), nominee_percent: item.item_type === 'nominee' ? '100' : '' }];
  });
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const total = people.reduce((s, p) => s + Number(p.nominee_percent || 0), 0);
  const set = (i: number, p: Partial<Person>) => setPeople((ps) => ps.map((x, j) => (j === i ? { ...x, ...p } : x)));

  const submit = async () => {
    setSending(true);
    try {
      if (item.item_type === 'document') {
        if (!file) throw new Error('Choose a photo or PDF first.');
        const f = await readFileBase64(file);
        await api.post(`/api/hr-ops/my/info-requests/${item.id}/submit`, { file_base64: f.base64, file_name: f.name, file_mime: f.mime, expiry_date: expiry || null, comment });
      } else {
        await api.post(`/api/hr-ops/my/info-requests/${item.id}/submit`, { people, comment });
      }
      onDone(`${item.item_label} sent to HR for approval.`);
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="mt-3 space-y-3">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      {item.item_type === 'document' ? (
        <>
          <label className="flex flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed border-slate-300 bg-slate-50 py-5 cursor-pointer hover:border-blue-400">
            <Camera className="w-6 h-6 text-slate-400" />
            <span className="text-xs font-semibold text-slate-600">{file ? file.name : 'Take a photo or choose a file'}</span>
            <span className="text-[10px] text-slate-400">Image or PDF, up to 8 MB</span>
            <input type="file" accept="image/*,application/pdf" className="hidden" onChange={(e) => setFile(e.target.files?.[0] || null)} />
          </label>
          <div className="grid sm:grid-cols-2 gap-3">
            <div>
              <label className={labelCls}>Expiry date (if the document has one)</label>
              <input type="date" value={expiry} onChange={(e) => setExpiry(e.target.value)} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Comment (optional)</label>
              <input value={comment} onChange={(e) => setComment(e.target.value)} className={inputCls} />
            </div>
          </div>
        </>
      ) : (
        <>
          {people.map((p, i) => (
            <div key={i} className="rounded-xl border border-slate-200 p-3 space-y-2">
              <div className="flex items-center justify-between">
                <span className="text-[11px] font-bold uppercase tracking-wide text-slate-400">
                  {item.item_type === 'nominee' ? `Nominee ${i + 1}` : 'Emergency contact'}
                </span>
                {people.length > 1 && (
                  <button type="button" className="p-1 text-slate-400 hover:text-rose-600" onClick={() => setPeople((ps) => ps.filter((_, j) => j !== i))} aria-label="Remove">
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="col-span-2 sm:col-span-1">
                  <label className={labelCls}>Full name *</label>
                  <input value={p.name} onChange={(e) => set(i, { name: e.target.value })} className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Relation</label>
                  <select value={p.relation} onChange={(e) => set(i, { relation: e.target.value })} className={inputCls}>
                    <option value="">—</option>
                    {RELATIONS.map((r) => (
                      <option key={r}>{r}</option>
                    ))}
                  </select>
                </div>
                <div>
                  <label className={labelCls}>Phone{item.item_type === 'emergency_contact' ? ' *' : ''}</label>
                  <input type="tel" value={p.phone} onChange={(e) => set(i, { phone: e.target.value })} className={inputCls} />
                </div>
                {item.item_type === 'nominee' && (
                  <>
                    <div>
                      <label className={labelCls}>Share (%) *</label>
                      <input type="number" min={1} max={100} value={p.nominee_percent} onChange={(e) => set(i, { nominee_percent: e.target.value })} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>Date of birth</label>
                      <input type="date" value={p.date_of_birth} onChange={(e) => set(i, { date_of_birth: e.target.value })} className={inputCls} />
                    </div>
                    <div>
                      <label className={labelCls}>NID / Birth reg. no.</label>
                      <input value={p.nid} onChange={(e) => set(i, { nid: e.target.value })} className={inputCls} />
                    </div>
                  </>
                )}
                <div className="col-span-2">
                  <label className={labelCls}>Address</label>
                  <input value={p.address} onChange={(e) => set(i, { address: e.target.value })} className={inputCls} />
                </div>
              </div>
            </div>
          ))}
          {item.item_type === 'nominee' && (
            <div className="flex items-center justify-between">
              <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={() => setPeople((ps) => [...ps, blank()])}>
                <Plus className="w-3 h-3" /> Add another nominee
              </button>
              <span className={`text-[11px] font-semibold ${Math.abs(total - 100) < 0.01 ? 'text-emerald-700' : 'text-rose-600'}`}>Total {total}% (must be 100%)</span>
            </div>
          )}
          <div>
            <label className={labelCls}>Comment (optional)</label>
            <input value={comment} onChange={(e) => setComment(e.target.value)} className={inputCls} />
          </div>
        </>
      )}
      <button type="button" className={btnPrimary} disabled={sending} onClick={submit}>
        {sending ? <Spinner size={14} /> : <Send className="w-3.5 h-3.5" />} Submit to HR
      </button>
    </div>
  );
};

export const MyInfoRequests: React.FC<{ token: string; onCountChange?: (n: number) => void }> = ({ token, onCountChange }) => {
  const api = useHrApi(token);
  const [data, setData] = useState<{ items: MyItem[]; open: number; family: any[] } | null>(null);
  const [openId, setOpenId] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const load = () =>
    api
      .get<any>('/api/hr-ops/my/info-requests')
      .then((d) => {
        setData(d);
        onCountChange?.(d.open);
      })
      .catch((e) => setMsg({ type: 'error', text: e.message }));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  if (!data)
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Spinner size={16} /> Loading…
      </div>
    );
  const todo = data.items.filter((i) => i.status === 'pending' || i.status === 'rejected');
  const rest = data.items.filter((i) => i.status === 'submitted' || i.status === 'approved');
  return (
    <div className="space-y-4">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
        <div className="px-4 py-3 text-sm font-bold text-slate-800">HR needs from you ({todo.length})</div>
        {todo.length === 0 ? (
          <div className="p-6 text-center text-sm text-slate-400">
            <CheckCircle2 className="w-8 h-8 mx-auto mb-2 text-emerald-300" />
            Nothing pending — thank you!
          </div>
        ) : (
          todo.map((it) => (
            <div key={it.id} className={`p-4 ${it.overdue ? 'bg-rose-50/40' : it.status === 'rejected' ? 'bg-amber-50/40' : ''}`}>
              <div className="flex items-start justify-between gap-2 flex-wrap">
                <div>
                  <div className="text-sm font-semibold text-slate-800">{it.item_label}</div>
                  <div className="text-[11px] text-slate-500">
                    {it.due_date ? <span className={it.overdue ? 'text-rose-600 font-semibold' : ''}>Submit by {fmtDate(it.due_date)}</span> : 'No deadline'}
                    {it.note && ` · ${it.note}`}
                  </div>
                  {it.status === 'rejected' && it.review_remarks && (
                    <div className="text-[11px] text-rose-600 mt-0.5 flex items-center gap-1">
                      <XCircle className="w-3 h-3" /> HR sent this back: {it.review_remarks}
                    </div>
                  )}
                </div>
                {openId !== it.id && (
                  <button type="button" className={btnPrimary} onClick={() => setOpenId(it.id)}>
                    {it.item_type === 'document' ? <Paperclip className="w-3.5 h-3.5" /> : <Plus className="w-3.5 h-3.5" />}
                    {it.status === 'rejected' ? 'Submit again' : it.item_type === 'document' ? 'Upload' : 'Fill in'}
                  </button>
                )}
              </div>
              {openId === it.id && (
                <>
                  <ItemForm
                    token={token}
                    item={it}
                    family={data.family}
                    onDone={(text) => {
                      setOpenId(null);
                      setMsg({ type: 'success', text });
                      load();
                    }}
                  />
                  <button type="button" className={`${btnGhost} mt-2`} onClick={() => setOpenId(null)}>
                    Cancel
                  </button>
                </>
              )}
            </div>
          ))
        )}
      </div>
      {rest.length > 0 && (
        <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
          <div className="px-4 py-3 text-sm font-bold text-slate-800">Submitted</div>
          {rest.map((it) => (
            <div key={it.id} className="px-4 py-3 flex items-center justify-between gap-2">
              <div>
                <div className="text-xs font-semibold text-slate-700">{it.item_label}</div>
                <div className="text-[11px] text-slate-400">Sent {fmtDate(it.submitted_at)}</div>
              </div>
              {it.status === 'approved' ? (
                <Badge tone="approved">
                  <CheckCircle2 className="w-3 h-3" /> Accepted
                </Badge>
              ) : (
                <Badge tone="pending">
                  <Clock className="w-3 h-3" /> Waiting for HR
                </Badge>
              )}
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
