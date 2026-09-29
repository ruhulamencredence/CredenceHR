/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> "Letters": the issue register (every letter with its
// reference number and whether the Employee has acknowledged it), the
// Employees' own certificate requests from Self Service, and the Letter
// Composer — pick an Employee + letter type (+ template), the server fills
// the template's {{placeholders}}, HR can still edit the text, preview the
// PDF, then issue it (reference number assigned on issue).

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { FilePlus2, Eye, Download, Ban, CheckCircle2, Clock, Inbox, Search } from 'lucide-react';
import { Spinner } from './Spinner';
import { PdfPreviewModal } from './PdfPreviewModal';
import {
  useHrApi,
  EmployeePicker,
  Modal,
  Notice,
  Badge,
  fmtDate,
  inputCls,
  labelCls,
  btnPrimary,
  btnGhost,
  companyFromSettings,
  letterPdfBytes,
  saveLetterPdf,
  type HrOpsEmployee,
  type HrOpsMeta,
  type HrLetter
} from './HrOpsShared';
import { letterFileName } from '../lib/hrLetterPdf';

interface Template {
  id: number;
  letter_type: string;
  name: string;
  subject: string;
  body: string;
  is_default: number | boolean;
  is_active: number | boolean;
}

export interface ComposerInit {
  employee_id?: number | null;
  letter_type?: string;
  hr_action_id?: number | null;
  request?: { id: number; employee_id: number; letter_type: string; purpose: string | null } | null;
}

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const LetterComposer: React.FC<{
  token: string;
  meta: HrOpsMeta;
  employees: HrOpsEmployee[];
  init: ComposerInit;
  onClose: () => void;
  onIssued: (ref: string) => void;
}> = ({ token, meta, employees, init, onClose, onIssued }) => {
  const api = useHrApi(token);
  const [employeeId, setEmployeeId] = useState<number | null>(init.request?.employee_id ?? init.employee_id ?? null);
  const [letterType, setLetterType] = useState(init.request?.letter_type || init.letter_type || 'appointment');
  const [templates, setTemplates] = useState<Template[]>([]);
  const [templateId, setTemplateId] = useState<number | ''>('');
  const [letterDate, setLetterDate] = useState(todayStr());
  const [extra, setExtra] = useState<Record<string, string>>({ purpose: init.request?.purpose || '' });
  const [preview, setPreview] = useState<{ ref_no: string; subject: string; body: string; letter_type: string; template_id: number } | null>(null);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [edited, setEdited] = useState(false);
  const [loading, setLoading] = useState(false);
  const [issuing, setIssuing] = useState(false);
  const [err, setErr] = useState('');
  const [pdf, setPdf] = useState<Uint8Array | null>(null);
  const lockedType = !!init.hr_action_id || !!init.request;

  useEffect(() => {
    api.get<Template[]>('/api/hr-ops/letter-templates').then(setTemplates).catch(() => setTemplates([]));
  }, [api]);
  const typeTemplates = templates.filter((t) => t.letter_type === letterType && Number(t.is_active) !== 0);

  // Re-render the template whenever an input changes (unless HR already
  // edited the text — then only "Reload from template" replaces it).
  const seq = useRef(0);
  const refresh = async (force = false) => {
    if (!employeeId) return;
    const my = ++seq.current;
    setLoading(true);
    setErr('');
    try {
      const r = await api.post<any>('/api/hr-ops/letters/preview', {
        employee_id: employeeId,
        letter_type: init.hr_action_id ? undefined : letterType,
        hr_action_id: init.hr_action_id || undefined,
        template_id: templateId || undefined,
        letter_date: letterDate,
        extra
      });
      if (my !== seq.current) return;
      setPreview(r);
      if (!edited || force) {
        setSubject(r.subject);
        setBody(r.body);
        setEdited(false);
      }
    } catch (e: any) {
      if (my === seq.current) {
        setErr(e.message);
        setPreview(null);
      }
    } finally {
      if (my === seq.current) setLoading(false);
    }
  };
  useEffect(() => {
    const t = setTimeout(() => refresh(), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [employeeId, letterType, templateId, letterDate, JSON.stringify(extra)]);

  const emp = employees.find((e) => e.id === employeeId);
  const company = companyFromSettings(meta.settings);

  const issue = async () => {
    if (!employeeId || !preview) return;
    setIssuing(true);
    setErr('');
    try {
      const payload = {
        employee_id: employeeId,
        letter_type: letterType,
        hr_action_id: init.hr_action_id || undefined,
        template_id: templateId || preview.template_id,
        letter_date: letterDate,
        extra,
        subject,
        body
      };
      const r = init.request
        ? await api.post<any>(`/api/hr-ops/letter-requests/${init.request.id}/decision`, { decision: 'issued', ...payload })
        : await api.post<any>('/api/hr-ops/letters', payload);
      onIssued(r.ref_no);
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setIssuing(false);
    }
  };

  return (
    <>
      <Modal
        title={init.request ? 'Issue Requested Letter' : 'New Letter'}
        onClose={onClose}
        wide
        footer={
          <>
            <button
              type="button"
              className={btnGhost}
              disabled={!preview}
              onClick={async () => setPdf(await letterPdfBytes(company, { ref_no: preview!.ref_no, letter_date: letterDate, subject, body, employee_name: emp?.name }, true))}
            >
              <Eye className="w-3.5 h-3.5" /> Preview PDF
            </button>
            <button type="button" className={btnPrimary} disabled={!preview || issuing || !subject.trim() || !body.trim()} onClick={issue}>
              {issuing ? <Spinner size={14} /> : <FilePlus2 className="w-3.5 h-3.5" />} Issue Letter
            </button>
          </>
        }
      >
        <div className="grid md:grid-cols-[280px_1fr] gap-5">
          <div className="space-y-3">
            <div>
              <label className={labelCls}>Employee</label>
              {init.request || init.hr_action_id ? (
                <div className="text-sm font-semibold text-slate-800">
                  {emp?.name} <span className="text-slate-400 font-normal">{emp?.employee_code}</span>
                </div>
              ) : (
                <EmployeePicker employees={employees} value={employeeId} onChange={setEmployeeId} includeInactive />
              )}
            </div>
            <div>
              <label className={labelCls}>Letter type</label>
              <select
                value={letterType}
                disabled={lockedType}
                onChange={(e) => {
                  setLetterType(e.target.value);
                  setTemplateId('');
                }}
                className={inputCls}
              >
                {meta.letter_types.map((l) => (
                  <option key={l.key} value={l.key}>
                    {l.label}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className={labelCls}>Template</label>
              <select value={templateId} onChange={(e) => setTemplateId(e.target.value ? Number(e.target.value) : '')} className={inputCls}>
                <option value="">Default for this type</option>
                {templates
                  .filter((t) => (init.hr_action_id ? true : t.letter_type === letterType) && Number(t.is_active) !== 0)
                  .map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                      {Number(t.is_default) ? ' (default)' : ''}
                    </option>
                  ))}
              </select>
              {!init.hr_action_id && typeTemplates.length === 0 && <p className="text-[11px] text-amber-600 mt-1">No template for this type yet — add one in Settings.</p>}
            </div>
            <div>
              <label className={labelCls}>Letter date</label>
              <input type="date" value={letterDate} onChange={(e) => setLetterDate(e.target.value || todayStr())} className={inputCls} />
            </div>
            {letterType === 'bank_account' && (
              <>
                <div>
                  <label className={labelCls}>Bank name</label>
                  <input value={extra.bank_name || ''} onChange={(e) => setExtra({ ...extra, bank_name: e.target.value })} placeholder="e.g. Dutch-Bangla Bank PLC" className={inputCls} />
                </div>
                <div>
                  <label className={labelCls}>Bank branch</label>
                  <input value={extra.bank_branch || ''} onChange={(e) => setExtra({ ...extra, bank_branch: e.target.value })} placeholder="e.g. Uttara Branch, Dhaka" className={inputCls} />
                </div>
              </>
            )}
            {['salary_certificate', 'noc', 'experience'].includes(letterType) && (
              <div>
                <label className={labelCls}>Purpose</label>
                <input value={extra.purpose || ''} onChange={(e) => setExtra({ ...extra, purpose: e.target.value })} placeholder="e.g. visa processing" className={inputCls} />
              </div>
            )}
            {letterType === 'release' && !init.hr_action_id && (
              <div>
                <label className={labelCls}>Last working day</label>
                <input type="date" value={extra.last_working_day || ''} onChange={(e) => setExtra({ ...extra, last_working_day: e.target.value })} className={inputCls} />
              </div>
            )}
            {preview && (
              <div className="text-[11px] text-slate-500 bg-slate-50 border border-slate-200 rounded-lg p-2.5">
                Reference No. on issue: <span className="font-semibold text-slate-800">{preview.ref_no}</span>
              </div>
            )}
          </div>
          <div className="space-y-3 min-w-0">
            {err && <Notice msg={{ type: 'error', text: err }} />}
            {!employeeId ? (
              <p className="text-sm text-slate-400 py-16 text-center">Pick an employee to prepare the letter.</p>
            ) : loading && !preview ? (
              <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
                <Spinner size={16} /> Preparing…
              </div>
            ) : preview ? (
              <>
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[11px] text-slate-500">{edited ? 'Edited — your text will be issued as shown.' : 'Filled from the template — you can edit anything below.'}</span>
                  {edited && (
                    <button type="button" className="text-[11px] font-semibold text-blue-600" onClick={() => refresh(true)}>
                      Reload from template
                    </button>
                  )}
                </div>
                <div>
                  <label className={labelCls}>Subject</label>
                  <input
                    value={subject}
                    onChange={(e) => {
                      setSubject(e.target.value);
                      setEdited(true);
                    }}
                    className={inputCls}
                  />
                </div>
                <div>
                  <label className={labelCls}>Letter</label>
                  <textarea
                    value={body}
                    onChange={(e) => {
                      setBody(e.target.value);
                      setEdited(true);
                    }}
                    rows={18}
                    className={`${inputCls} font-serif leading-relaxed text-[13px]`}
                  />
                </div>
              </>
            ) : null}
          </div>
        </div>
      </Modal>
      <PdfPreviewModal
        isOpen={pdf !== null}
        pdfBytes={pdf}
        filename={letterFileName(preview?.ref_no || 'draft', emp?.name)}
        onClose={() => setPdf(null)}
        onDownload={() => saveLetterPdf(company, { ref_no: preview!.ref_no, letter_date: letterDate, subject, body, employee_name: emp?.name })}
      />
    </>
  );
};

interface LetterRequest {
  id: number;
  employee_id: number;
  employee_name: string | null;
  employee_code: string | null;
  designation: string | null;
  letter_type: string;
  letter_label: string;
  purpose: string | null;
  status: 'pending' | 'issued' | 'rejected';
  remarks: string | null;
  created_at: string;
}

export const HrOpsLetters: React.FC<{ token: string; meta: HrOpsMeta; employees: HrOpsEmployee[]; refreshKey?: number }> = ({ token, meta, employees, refreshKey }) => {
  const api = useHrApi(token);
  const [view, setView] = useState<'register' | 'requests'>('register');
  const [letters, setLetters] = useState<HrLetter[]>([]);
  const [requests, setRequests] = useState<LetterRequest[]>([]);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [composer, setComposer] = useState<ComposerInit | null>(null);
  const [pdf, setPdf] = useState<{ bytes: Uint8Array; letter: HrLetter } | null>(null);
  const [q, setQ] = useState('');
  const [typeFilter, setTypeFilter] = useState('');
  const [ackFilter, setAckFilter] = useState('');
  const company = companyFromSettings(meta.settings);

  const load = async () => {
    setLoading(true);
    try {
      const [l, r] = await Promise.all([api.get<HrLetter[]>('/api/hr-ops/letters'), api.get<LetterRequest[]>('/api/hr-ops/letter-requests')]);
      setLetters(l);
      setRequests(r);
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [refreshKey]);

  const filtered = useMemo(
    () =>
      letters.filter((l) => {
        if (typeFilter && l.letter_type !== typeFilter) return false;
        if (ackFilter === 'pending' && (l.acknowledged_at || !Number(l.requires_ack) || l.status !== 'issued')) return false;
        if (ackFilter === 'done' && !l.acknowledged_at) return false;
        const s = q.trim().toLowerCase();
        return !s || [l.ref_no, l.employee_name, l.employee_code, l.subject].some((v) => String(v || '').toLowerCase().includes(s));
      }),
    [letters, q, typeFilter, ackFilter]
  );
  const pendingRequests = requests.filter((r) => r.status === 'pending');

  const cancel = async (l: HrLetter) => {
    const reason = window.prompt(`Cancel ${l.ref_no}? Write the reason:`);
    if (!reason) return;
    try {
      await api.post(`/api/hr-ops/letters/${l.id}/cancel`, { reason });
      setMsg({ type: 'success', text: `${l.ref_no} cancelled.` });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };
  const reject = async (r: LetterRequest) => {
    const remarks = window.prompt(`Reject ${r.employee_name}'s ${r.letter_label} request? Write the reason:`);
    if (!remarks) return;
    try {
      await api.post(`/api/hr-ops/letter-requests/${r.id}/decision`, { decision: 'rejected', remarks });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    }
  };

  return (
    <div className="space-y-4">
      <Notice msg={msg} onClose={() => setMsg(null)} />
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="inline-flex rounded-lg border border-slate-200 p-0.5 bg-slate-50">
          <button type="button" onClick={() => setView('register')} className={`text-xs font-semibold px-3 py-1.5 rounded-md ${view === 'register' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}>
            Letter Register
          </button>
          <button type="button" onClick={() => setView('requests')} className={`text-xs font-semibold px-3 py-1.5 rounded-md flex items-center gap-1.5 ${view === 'requests' ? 'bg-white shadow-sm text-slate-900' : 'text-slate-500'}`}>
            Requests
            {pendingRequests.length > 0 && <span className="text-[10px] bg-violet-600 text-white rounded-full px-1.5">{pendingRequests.length}</span>}
          </button>
        </div>
        <button type="button" className={btnPrimary} onClick={() => setComposer({})}>
          <FilePlus2 className="w-3.5 h-3.5" /> New Letter
        </button>
      </div>

      {loading ? (
        <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
          <Spinner size={16} /> Loading…
        </div>
      ) : view === 'register' ? (
        <>
          <div className="flex flex-wrap gap-2">
            <div className="relative flex-1 min-w-[200px]">
              <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
              <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Search ref no, employee, subject…" className={`${inputCls} pl-8`} />
            </div>
            <select value={typeFilter} onChange={(e) => setTypeFilter(e.target.value)} className={`${inputCls} w-auto`}>
              <option value="">All letter types</option>
              {meta.letter_types.map((l) => (
                <option key={l.key} value={l.key}>
                  {l.label}
                </option>
              ))}
            </select>
            <select value={ackFilter} onChange={(e) => setAckFilter(e.target.value)} className={`${inputCls} w-auto`}>
              <option value="">Any acknowledgement</option>
              <option value="pending">Not yet acknowledged</option>
              <option value="done">Acknowledged</option>
            </select>
          </div>
          {filtered.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-12">No letters yet.</p>
          ) : (
            <div className="rounded-xl border border-slate-200 overflow-x-auto bg-white">
              <table className="min-w-full text-xs">
                <thead className="bg-slate-50 text-slate-500">
                  <tr>
                    {['Ref No.', 'Date', 'Employee', 'Letter', 'Acknowledgement', ''].map((h) => (
                      <th key={h} className="px-3 py-2 text-left font-semibold whitespace-nowrap">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-100">
                  {filtered.map((l) => (
                    <tr key={l.id} className={l.status === 'cancelled' ? 'opacity-60' : ''}>
                      <td className="px-3 py-2 font-semibold text-slate-800 whitespace-nowrap">{l.ref_no}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{fmtDate(l.letter_date)}</td>
                      <td className="px-3 py-2">
                        <div className="font-semibold text-slate-800">{l.employee_name}</div>
                        <div className="text-[11px] text-slate-400">{[l.employee_code, l.designation].filter(Boolean).join(' · ')}</div>
                      </td>
                      <td className="px-3 py-2">
                        <div className="text-slate-800">{l.letter_label}</div>
                        <div className="text-[11px] text-slate-400 truncate max-w-[240px]">{l.subject}</div>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">
                        {l.status === 'cancelled' ? (
                          <Badge tone="cancelled">Cancelled</Badge>
                        ) : l.acknowledged_at ? (
                          <Badge tone="approved">
                            <CheckCircle2 className="w-3 h-3" /> {fmtDate(String(l.acknowledged_at).slice(0, 10))}
                          </Badge>
                        ) : Number(l.requires_ack) ? (
                          <Badge tone="pending">
                            <Clock className="w-3 h-3" /> Waiting
                          </Badge>
                        ) : (
                          <span className="text-slate-400">Not needed</span>
                        )}
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap text-right">
                        <button
                          type="button"
                          title="View"
                          className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600"
                          onClick={async () => setPdf({ bytes: await letterPdfBytes(company, l), letter: l })}
                        >
                          <Eye className="w-4 h-4" />
                        </button>
                        <button type="button" title="Download PDF" className="p-1.5 rounded-md hover:bg-slate-100 text-slate-600" onClick={() => saveLetterPdf(company, l)}>
                          <Download className="w-4 h-4" />
                        </button>
                        {l.status === 'issued' && (
                          <button type="button" title="Cancel letter" className="p-1.5 rounded-md hover:bg-rose-50 text-rose-500" onClick={() => cancel(l)}>
                            <Ban className="w-4 h-4" />
                          </button>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      ) : requests.length === 0 ? (
        <div className="text-center py-12 text-sm text-slate-400">
          <Inbox className="w-8 h-8 mx-auto mb-2 text-slate-300" />
          No certificate requests from employees yet.
        </div>
      ) : (
        <div className="space-y-2">
          {requests.map((r) => (
            <div key={r.id} className="rounded-xl border border-slate-200 bg-white p-4 flex flex-wrap items-center justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-800">
                  {r.letter_label} — {r.employee_name} <span className="text-slate-400 font-normal text-xs">{r.employee_code}</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  {fmtDate(String(r.created_at).slice(0, 10))} · Purpose: {r.purpose || '—'}
                  {r.remarks && ` · ${r.remarks}`}
                </div>
              </div>
              {r.status === 'pending' ? (
                <div className="flex gap-2">
                  <button type="button" className={btnGhost} onClick={() => reject(r)}>
                    Reject
                  </button>
                  <button type="button" className={btnPrimary} onClick={() => setComposer({ request: r })}>
                    <FilePlus2 className="w-3.5 h-3.5" /> Prepare &amp; Issue
                  </button>
                </div>
              ) : (
                <Badge tone={r.status === 'issued' ? 'issued' : 'rejected'}>{r.status === 'issued' ? 'Issued' : 'Rejected'}</Badge>
              )}
            </div>
          ))}
        </div>
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
            setMsg({ type: 'success', text: `Letter ${ref} issued — the employee has been notified.` });
            load();
          }}
        />
      )}
      <PdfPreviewModal
        isOpen={pdf !== null}
        pdfBytes={pdf?.bytes || null}
        filename={pdf ? letterFileName(pdf.letter.ref_no, pdf.letter.employee_name) : ''}
        onClose={() => setPdf(null)}
        onDownload={() => pdf && saveLetterPdf(company, pdf.letter)}
      />
    </div>
  );
};
