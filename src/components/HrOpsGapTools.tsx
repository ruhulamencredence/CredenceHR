/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Closing the gaps Employee Reports finds (HrOpsInfoRequestsRoutes.ts):
//   FixGapsModal       — HR fills one employee's gaps right from a report row
//                        (upload a missing document, add nominee / emergency
//                        contact), without leaving the report.
//   RequestInfoModal   — ask the selected employees to submit what they are
//                        missing themselves (Self Service -> Pending Items).
//   InfoRequestsReview — HR's queue: what employees submitted, approve (it is
//                        then written to their record) or reject with a
//                        reason; plus what is still waiting on employees.

import React, { useEffect, useState } from 'react';
import { CheckCircle2, Clock, FileWarning, Paperclip, Plus, Send, ShieldAlert, Upload, Users, XCircle } from 'lucide-react';
import { Spinner } from './Spinner';
import { apiUrl } from '../lib/api';
import { RecordModal, UploadDocumentModal } from './HrOps360Parts';
import { useHrApi, Modal, Notice, Badge, fmtDate, inputCls, labelCls, btnPrimary, btnGhost } from './HrOpsShared';
import { confirmDialog } from '../lib/confirmDialog';

async function openFile(token: string, path: string) {
  const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return;
  window.open(URL.createObjectURL(await res.blob()), '_blank');
}

// ---------------------------------------------------------------------------
// Fix one employee's gaps from a report row
// ---------------------------------------------------------------------------

export const FixGapsModal: React.FC<{
  token: string;
  employee: { employee_id: number; name: string; user_id: number | null };
  canUpload: boolean;
  onClose: (changed: boolean) => void;
}> = ({ token, employee, canUpload, onClose }) => {
  const api = useHrApi(token);
  const [docs, setDocs] = useState<{ missing: string[]; expired: string[] } | null>(null);
  const [family, setFamily] = useState<any[] | null>(null);
  const [sub, setSub] = useState<null | { kind: 'upload'; doc: string } | { kind: 'family'; initial: Record<string, any>; row: any | null }>(null);
  const [changed, setChanged] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const load = async () => {
    const [d, r] = await Promise.all([
      api.get<any>(`/api/hr-ops/p360/${employee.employee_id}/section/documents`),
      api.get<any>(`/api/hr-ops/p360/${employee.employee_id}/section/records`)
    ]);
    setDocs({ missing: d.missing, expired: d.documents.filter((x: any) => x.expired).map((x: any) => x.doc_type) });
    setFamily(r.family);
  };
  useEffect(() => {
    load().catch((e) => setMsg({ type: 'error', text: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const noms = (family || []).filter((f) => f.is_nominee);
  const share = noms.reduce((s, f) => s + Number(f.nominee_percent || 0), 0);
  const nomineeOk = noms.length > 0 && Math.abs(share - 100) < 0.01;
  const emergencyOk = (family || []).some((f) => f.is_emergency);
  const done = (text: string) => {
    setSub(null);
    setChanged(true);
    setMsg({ type: 'success', text });
    load();
  };

  return (
    <>
      <Modal
        title={`Fix gaps — ${employee.name}`}
        onClose={() => onClose(changed)}
        footer={
          <button type="button" className={btnPrimary} onClick={() => onClose(changed)}>
            Done
          </button>
        }
      >
        {!docs || !family ? (
          <div className="flex items-center justify-center gap-2 py-10 text-sm text-slate-500">
            <Spinner size={16} /> Loading…
          </div>
        ) : (
          <div className="space-y-4">
            <Notice msg={msg} onClose={() => setMsg(null)} />
            <div>
              <div className="text-xs font-bold text-slate-700 mb-1.5 flex items-center gap-1">
                <FileWarning className="w-3.5 h-3.5" /> Documents
              </div>
              {!employee.user_id ? (
                <p className="text-xs text-rose-600">No app login — documents can't be attached until a login is created (Employees).</p>
              ) : docs.missing.length === 0 && docs.expired.length === 0 ? (
                <p className="text-xs text-emerald-700 flex items-center gap-1">
                  <CheckCircle2 className="w-3.5 h-3.5" /> All required documents are on file.
                </p>
              ) : (
                <div className="space-y-1.5">
                  {[...docs.missing.map((d) => ({ d, why: 'missing' })), ...docs.expired.map((d) => ({ d, why: 'expired' }))].map(({ d, why }) => (
                    <div key={`${why}${d}`} className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
                      <span className="text-xs text-slate-700">
                        {d} <Badge tone={why === 'missing' ? 'rejected' : 'pending'}>{why}</Badge>
                      </span>
                      {canUpload ? (
                        <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={() => setSub({ kind: 'upload', doc: d })}>
                          <Upload className="w-3 h-3" /> Upload
                        </button>
                      ) : (
                        <span className="text-[10px] text-slate-400">needs Document Vault access</span>
                      )}
                    </div>
                  ))}
                </div>
              )}
            </div>
            <div>
              <div className="text-xs font-bold text-slate-700 mb-1.5 flex items-center gap-1">
                <ShieldAlert className="w-3.5 h-3.5" /> Nominee &amp; emergency contact
              </div>
              <div className="space-y-1.5">
                <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
                  <span className="text-xs text-slate-700">
                    Nominee{' '}
                    {nomineeOk ? (
                      <Badge tone="approved">{noms.map((n) => `${n.name} ${n.nominee_percent ?? ''}%`).join(', ')}</Badge>
                    ) : noms.length ? (
                      <Badge tone="pending">shares {share}%</Badge>
                    ) : (
                      <Badge tone="rejected">none</Badge>
                    )}
                  </span>
                  <div className="flex gap-2">
                    {noms.length > 0 && !nomineeOk &&
                      noms.map((n) => (
                        <button key={n.id} type="button" className="text-[11px] font-semibold text-blue-600" onClick={() => setSub({ kind: 'family', initial: {}, row: n })}>
                          Edit {n.name.split(' ')[0]}
                        </button>
                      ))}
                    {!nomineeOk && (
                      <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={() => setSub({ kind: 'family', initial: { is_nominee: true, nominee_percent: noms.length ? String(Math.max(0, 100 - share)) : '100' }, row: null })}>
                        <Plus className="w-3 h-3" /> Add nominee
                      </button>
                    )}
                  </div>
                </div>
                <div className="flex items-center justify-between gap-2 rounded-lg border border-slate-100 px-3 py-2">
                  <span className="text-xs text-slate-700">
                    Emergency contact{' '}
                    {emergencyOk ? (
                      <Badge tone="approved">{(family || []).filter((f) => f.is_emergency).map((f) => f.name).join(', ')}</Badge>
                    ) : (
                      <Badge tone="rejected">none</Badge>
                    )}
                  </span>
                  {!emergencyOk && (
                    <button type="button" className="text-[11px] font-semibold text-blue-600 inline-flex items-center gap-1" onClick={() => setSub({ kind: 'family', initial: { is_emergency: true }, row: null })}>
                      <Plus className="w-3 h-3" /> Add contact
                    </button>
                  )}
                </div>
              </div>
            </div>
          </div>
        )}
      </Modal>
      {sub?.kind === 'upload' && employee.user_id && (
        <UploadDocumentModal token={token} userId={employee.user_id} missing={[sub.doc]} onClose={() => setSub(null)} onSaved={() => done(`${sub.doc} uploaded.`)} />
      )}
      {sub?.kind === 'family' && (
        <RecordModal token={token} employeeId={employee.employee_id} kind="family" record={sub.row} initial={sub.initial} onClose={() => setSub(null)} onSaved={() => done('Saved.')} />
      )}
    </>
  );
};

// ---------------------------------------------------------------------------
// Ask employees to submit their missing information
// ---------------------------------------------------------------------------

export const RequestInfoModal: React.FC<{ token: string; employees: { employee_id: number; name: string }[]; onClose: () => void; onSent: (text: string) => void }> = ({
  token,
  employees,
  onClose,
  onSent
}) => {
  const api = useHrApi(token);
  const [gaps, setGaps] = useState<Set<string>>(new Set(['documents', 'nominee', 'emergency_contact']));
  const [extraDoc, setExtraDoc] = useState('');
  const [due, setDue] = useState(() => {
    const d = new Date();
    d.setDate(d.getDate() + 7);
    return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  });
  const [note, setNote] = useState('');
  const [sending, setSending] = useState(false);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const toggle = (k: string) =>
    setGaps((g) => {
      const n = new Set(g);
      if (n.has(k)) n.delete(k);
      else n.add(k);
      return n;
    });
  const send = async () => {
    setSending(true);
    try {
      const r = await api.post<any>('/api/hr-ops/info-requests', {
        employee_ids: employees.map((e) => e.employee_id),
        from_gaps: [...gaps],
        items: extraDoc.trim() ? [{ item_type: 'document', doc_type: extraDoc.trim() }] : [],
        due_date: due || null,
        note
      });
      const parts = [`${r.created} item(s) requested from ${r.employees} employee(s).`];
      if (r.already_requested) parts.push(`${r.already_requested} already requested earlier.`);
      if (r.nothing_missing?.length) parts.push(`Nothing missing for ${r.nothing_missing.length}.`);
      if (r.no_login?.length) parts.push(`No app login (fill from Service Book): ${r.no_login.join(', ')}.`);
      onSent(parts.join(' '));
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSending(false);
    }
  };
  return (
    <Modal
      title={`Request from ${employees.length} employee(s)`}
      onClose={onClose}
      footer={
        <>
          <button type="button" className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button type="button" className={btnPrimary} disabled={sending || (gaps.size === 0 && !extraDoc.trim())} onClick={send}>
            {sending ? <Spinner size={14} /> : <Send className="w-3.5 h-3.5" />} Send Request
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <Notice msg={msg} onClose={() => setMsg(null)} />
        <p className="text-xs text-slate-500">
          Each employee is asked only for what <span className="font-semibold">they</span> are missing. They get a notification and submit from Self Service → My Letters &amp; Service
          Record → Pending Items; nothing is recorded until you approve it under Requests.
        </p>
        <div className="space-y-1.5">
          {[
            ['documents', 'Missing required documents'],
            ['nominee', 'Nominee details (if none, or shares not 100%)'],
            ['emergency_contact', 'Emergency contact (if none)']
          ].map(([k, l]) => (
            <label key={k} className="flex items-center gap-2 text-xs text-slate-700">
              <input type="checkbox" checked={gaps.has(k)} onChange={() => toggle(k)} /> {l}
            </label>
          ))}
        </div>
        <div>
          <label className={labelCls}>Also ask everyone for (optional)</label>
          <input value={extraDoc} onChange={(e) => setExtraDoc(e.target.value)} placeholder="e.g. Updated Photograph, TIN Certificate" className={inputCls} />
        </div>
        <div className="grid grid-cols-[160px_1fr] gap-3">
          <div>
            <label className={labelCls}>Submit by</label>
            <input type="date" value={due} onChange={(e) => setDue(e.target.value)} className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Note to employees (optional)</label>
            <input value={note} onChange={(e) => setNote(e.target.value)} className={inputCls} />
          </div>
        </div>
        <p className="text-[11px] text-slate-400">A reminder goes out the day before the date and every day after, until they submit.</p>
        <div className="text-[11px] text-slate-500 max-h-20 overflow-y-auto">
          <Users className="w-3 h-3 inline" /> {employees.map((e) => e.name).join(', ')}
        </div>
      </div>
    </Modal>
  );
};

// ---------------------------------------------------------------------------
// HR's review queue
// ---------------------------------------------------------------------------

interface InfoItem {
  id: number;
  employee_id: number;
  employee_name: string;
  employee_code: string | null;
  department: string | null;
  item_type: string;
  item_label: string;
  note: string | null;
  due_date: string | null;
  overdue: boolean;
  status: string;
  submission: any;
  has_file: boolean;
  file_name: string | null;
  submitted_at: string | null;
  review_remarks: string | null;
  reviewed_by: string | null;
  requested_by: string | null;
  created_at: string;
}

const STATUS_LABEL: Record<string, string> = { pending: 'Waiting on employee', submitted: 'Submitted — review', rejected: 'Sent back', approved: 'Approved' };

export const InfoRequestsReview: React.FC<{ token: string; canApproveDocs: boolean; onOpenEmployee: (id: number) => void }> = ({ token, canApproveDocs, onOpenEmployee }) => {
  const api = useHrApi(token);
  const [data, setData] = useState<{ items: InfoItem[]; summary: Record<string, number> } | null>(null);
  const [status, setStatus] = useState('submitted');
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const load = () => api.get<any>('/api/hr-ops/info-requests').then(setData).catch((e) => setMsg({ type: 'error', text: e.message }));
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const act = async (it: InfoItem, path: string, body?: any) => {
    setBusy(it.id);
    try {
      await api.post(`/api/hr-ops/info-requests/${it.id}/${path}`, body);
      setMsg({ type: 'success', text: path === 'cancel' ? 'Request cancelled.' : body?.decision === 'approved' ? `${it.item_label} added to ${it.employee_name}'s record.` : 'Sent back to the employee.' });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setBusy(null);
    }
  };
  if (!data)
    return (
      <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
        <Spinner size={16} /> Loading…
      </div>
    );
  const s = data.summary;
  const list = data.items.filter((i) => i.status === status && (!q || `${i.employee_name} ${i.employee_code} ${i.item_label}`.toLowerCase().includes(q.toLowerCase())));
  return (
    <div className="space-y-3">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="flex flex-wrap gap-2">
        {(['submitted', 'pending', 'rejected', 'approved'] as const).map((k) => (
          <button
            key={k}
            type="button"
            onClick={() => setStatus(k)}
            className={`rounded-xl border px-3 py-2 text-left ${status === k ? 'border-blue-300 bg-blue-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
          >
            <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{STATUS_LABEL[k]}</div>
            <div className="text-sm font-bold text-slate-800">{s[k] || 0}</div>
          </button>
        ))}
        {s.overdue > 0 && (
          <div className="rounded-xl border border-rose-200 bg-rose-50/60 px-3 py-2">
            <div className="text-[10px] font-semibold uppercase tracking-wide text-rose-500">Overdue</div>
            <div className="text-sm font-bold text-rose-700">{s.overdue}</div>
          </div>
        )}
      </div>
      <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search employee or item…" className={`${inputCls} max-w-xs`} />
      {list.length === 0 ? (
        <p className="text-sm text-slate-400 text-center py-12">
          {status === 'submitted' ? 'Nothing waiting for review.' : 'Nothing here.'} Send requests from any report: tick employees → "Request from employees".
        </p>
      ) : (
        <div className="space-y-2">
          {list.map((it) => (
            <div key={it.id} className={`rounded-xl border bg-white p-3 ${it.overdue ? 'border-rose-200' : 'border-slate-200'}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <div className="text-sm font-semibold text-slate-800">
                    <button type="button" className="text-blue-700 hover:underline" onClick={() => onOpenEmployee(it.employee_id)}>
                      {it.employee_name}
                    </button>{' '}
                    <span className="font-normal text-slate-400 text-xs">{[it.employee_code, it.department].filter(Boolean).join(' · ')}</span>
                  </div>
                  <div className="text-xs text-slate-700 mt-0.5">
                    {it.item_label}
                    {it.due_date && (
                      <span className={it.overdue ? 'text-rose-600 font-semibold' : 'text-slate-400'}>
                        {' '}
                        · due {fmtDate(it.due_date)}
                      </span>
                    )}
                  </div>
                  <div className="text-[11px] text-slate-400">
                    Requested {fmtDate(it.created_at)}
                    {it.requested_by && ` by ${it.requested_by}`}
                    {it.submitted_at && ` · submitted ${fmtDate(it.submitted_at)}`}
                    {it.reviewed_by && it.status !== 'pending' && it.status !== 'submitted' && ` · ${it.status} by ${it.reviewed_by}`}
                  </div>
                  {it.review_remarks && <div className="text-[11px] text-rose-600 mt-0.5">“{it.review_remarks}”</div>}
                </div>
                <Badge tone={it.status === 'approved' ? 'approved' : it.status === 'rejected' ? 'rejected' : 'pending'}>
                  {it.status === 'pending' ? <Clock className="w-3 h-3" /> : null}
                  {STATUS_LABEL[it.status]}
                </Badge>
              </div>
              {it.status === 'submitted' || it.status === 'approved' ? (
                <div className="mt-2 rounded-lg bg-slate-50 p-2.5 text-xs">
                  {it.item_type === 'document' ? (
                    it.has_file ? (
                      <button type="button" className="inline-flex items-center gap-1 font-semibold text-blue-700" onClick={() => openFile(token, `/api/hr-ops/info-requests/${it.id}/file`)}>
                        <Paperclip className="w-3.5 h-3.5" /> {it.file_name}
                      </button>
                    ) : (
                      <span className="text-slate-400">No file</span>
                    )
                  ) : (
                    <ul className="space-y-0.5">
                      {(it.submission?.people || []).map((p: any, i: number) => (
                        <li key={i}>
                          <span className="font-semibold">{p.name}</span>
                          {[p.relation, p.phone, p.nominee_percent != null ? `${p.nominee_percent}%` : null, p.date_of_birth && fmtDate(p.date_of_birth), p.nid && `NID ${p.nid}`]
                            .filter(Boolean)
                            .map((x) => ` · ${x}`)
                            .join('')}
                        </li>
                      ))}
                    </ul>
                  )}
                  {it.submission?.comment && <div className="text-slate-500 mt-1">“{it.submission.comment}”</div>}
                </div>
              ) : null}
              <div className="flex flex-wrap gap-2 mt-2">
                {it.status === 'submitted' && (
                  <>
                    <button
                      type="button"
                      className={btnPrimary}
                      disabled={busy === it.id || (it.item_type === 'document' && !canApproveDocs)}
                      title={it.item_type === 'document' && !canApproveDocs ? 'Needs the Document Vault module' : undefined}
                      onClick={() => act(it, 'review', { decision: 'approved' })}
                    >
                      {busy === it.id ? <Spinner size={14} /> : <CheckCircle2 className="w-3.5 h-3.5" />} Approve
                    </button>
                    <button
                      type="button"
                      className={btnGhost}
                      disabled={busy === it.id}
                      onClick={() => {
                        const reason = window.prompt('Why is it being sent back? (the employee will see this)');
                        if (reason && reason.trim()) act(it, 'review', { decision: 'rejected', remarks: reason.trim() });
                      }}
                    >
                      <XCircle className="w-3.5 h-3.5" /> Send back
                    </button>
                  </>
                )}
                {(it.status === 'pending' || it.status === 'rejected' || it.status === 'submitted') && (
                  <button
                    type="button"
                    className="text-[11px] font-semibold text-slate-500 hover:text-rose-600"
                    disabled={busy === it.id}
                    onClick={async () => (await confirmDialog('Cancel this request?')) && act(it, 'cancel')}
                  >
                    Cancel request
                  </button>
                )}
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};
