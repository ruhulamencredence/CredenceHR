/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> "My Letters & Service Record" — every letter HR has issued
// to this account's Employee record (view / download the PDF, and
// "Acknowledge" the ones that ask for it), requests for a Salary Certificate
// / Experience Certificate / NOC / Bank Account letter, and the Employee's
// own service record timeline, and Pending Items — documents / nominee /
// emergency contact HR has asked for (MyInfoRequests.tsx). With
// users.can_view_service_book also "Service Book": their own Employee 360,
// read only (HrOps360.tsx in `self` mode). Backed by
// HROperationsRoutes.ts's /api/hr-ops/my/* routes; works the same in the
// mobile app.

import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, FileText, CheckCircle2, Clock, Download, Eye, Send, BookOpen, Inbox, ClipboardList } from 'lucide-react';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';
import { PdfPreviewModal } from './PdfPreviewModal';
import { letterFileName } from '../lib/hrLetterPdf';
import { useHrApi, Badge, fmtDate, letterPdfBytes, saveLetterPdf, inputCls, labelCls, btnPrimary, btnGhost, Notice } from './HrOpsShared';
import { ServiceTimeline, serviceLength, type ServiceBookData } from './HrOpsServiceBook';
import { MyInfoRequests, useMyOpenRequests } from './MyInfoRequests';
import { Employee360 } from './HrOps360';

interface MyLetter {
  id: number;
  ref_no: string;
  letter_type: string;
  letter_label: string;
  subject: string;
  body: string;
  letter_date: string;
  requires_ack: number;
  acknowledged_at: string | null;
}
interface MyData {
  company?: { name: string; address: string; signatory_name: string; signatory_designation: string };
  employee?: { id: number; name: string; employee_code: string | null; designation: string | null; department: string | null };
  letters: MyLetter[];
  requests: { id: number; letter_label: string; purpose: string | null; status: string; remarks: string | null; created_at: string }[];
  requestable?: { key: string; label: string }[];
}

export const MyLetters: React.FC<{ token: string; onBack?: () => void; canServiceBook?: boolean }> = ({ token, onBack, canServiceBook = false }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const api = useHrApi(token);
  // An alert about a request opens straight on Pending Items.
  const [tab, setTab] = useState<'letters' | 'pending' | 'record' | 'book'>(() => {
    try {
      const t = sessionStorage.getItem('my_letters_tab');
      if (t) sessionStorage.removeItem('my_letters_tab');
      if (t === 'pending' || t === 'record') return t;
      if (t === 'book' && canServiceBook) return t;
    } catch {
      // storage unavailable
    }
    return 'letters';
  });
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = (e as CustomEvent).detail;
      if (t === 'letters' || t === 'pending' || t === 'record' || (t === 'book' && canServiceBook)) setTab(t);
      try {
        sessionStorage.removeItem('my_letters_tab');
      } catch {
        // storage unavailable
      }
    };
    window.addEventListener('credence:my-letters-tab', onTab);
    return () => window.removeEventListener('credence:my-letters-tab', onTab);
  }, [canServiceBook]);
  const initialOpen = useMyOpenRequests(token);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const pendingCount = openCount ?? initialOpen;
  const [data, setData] = useState<MyData | null>(null);
  const [book, setBook] = useState<ServiceBookData | null>(null);
  const [loading, setLoading] = useState(true);
  const [msg, setMsg] = useState<{ type: 'success' | 'error'; text: string } | null>(null);
  const [pdf, setPdf] = useState<{ bytes: Uint8Array; letter: MyLetter } | null>(null);
  const [reqType, setReqType] = useState('');
  const [purpose, setPurpose] = useState('');
  const [sending, setSending] = useState(false);
  const [acking, setAcking] = useState<number | null>(null);

  const load = async () => {
    setLoading(true);
    try {
      const [d, b] = await Promise.all([api.get<MyData>('/api/hr-ops/my/letters'), api.get<ServiceBookData>('/api/hr-ops/my/service-book')]);
      setData(d);
      setBook(b);
      if (!reqType && d.requestable?.length) setReqType(d.requestable[0].key);
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setLoading(false);
    }
  };
  useEffect(() => {
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const company = data?.company
    ? { name: data.company.name, address: data.company.address, signatory_name: data.company.signatory_name, signatory_designation: data.company.signatory_designation }
    : { name: '' };
  const asPdf = (l: MyLetter) => ({ ...l, employee_name: data?.employee?.name });
  const pendingAck = (data?.letters || []).filter((l) => Number(l.requires_ack) && !l.acknowledged_at);

  const acknowledge = async (l: MyLetter) => {
    setAcking(l.id);
    try {
      await api.post(`/api/hr-ops/my/letters/${l.id}/acknowledge`);
      setMsg({ type: 'success', text: `${l.ref_no} acknowledged — HR has been notified.` });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setAcking(null);
    }
  };
  const request = async () => {
    setSending(true);
    try {
      await api.post('/api/hr-ops/my/letter-requests', { letter_type: reqType, purpose });
      setPurpose('');
      setMsg({ type: 'success', text: 'Request sent to HR. You will be notified when the letter is ready.' });
      load();
    } catch (e: any) {
      setMsg({ type: 'error', text: e.message });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-4xl mx-auto">
        {!isNativeApp && <ModulePath path={['Self Service', 'My Letters & Service Record']} />}
        <div className="flex items-center gap-2 mb-4 mt-2">
          {onBack && (
            <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-slate-500" />
            </button>
          )}
          <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
            <FileText className="w-5 h-5 text-blue-600 shrink-0" /> My Letters &amp; Service Record
          </h1>
        </div>
        <div className="inline-flex rounded-xl border border-slate-200 p-0.5 bg-white/70 mb-4">
          <button type="button" onClick={() => setTab('letters')} className={`text-xs font-semibold px-3.5 py-2 rounded-lg flex items-center gap-1.5 ${tab === 'letters' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}>
            <FileText className="w-3.5 h-3.5" /> Letters
            {pendingAck.length > 0 && <span className={`text-[10px] rounded-full px-1.5 ${tab === 'letters' ? 'bg-white/25' : 'bg-amber-500 text-white'}`}>{pendingAck.length}</span>}
          </button>
          <button type="button" onClick={() => setTab('pending')} className={`text-xs font-semibold px-3.5 py-2 rounded-lg flex items-center gap-1.5 ${tab === 'pending' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}>
            <ClipboardList className="w-3.5 h-3.5" /> Pending Items
            {pendingCount > 0 && <span className={`text-[10px] rounded-full px-1.5 ${tab === 'pending' ? 'bg-white/25' : 'bg-rose-500 text-white'}`}>{pendingCount}</span>}
          </button>
          <button type="button" onClick={() => setTab('record')} className={`text-xs font-semibold px-3.5 py-2 rounded-lg flex items-center gap-1.5 ${tab === 'record' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}>
            <BookOpen className="w-3.5 h-3.5" /> Service Record
          </button>
          {canServiceBook && (
            <button type="button" onClick={() => setTab('book')} className={`text-xs font-semibold px-3.5 py-2 rounded-lg flex items-center gap-1.5 ${tab === 'book' ? 'bg-blue-600 text-white' : 'text-slate-600'}`}>
              <BookOpen className="w-3.5 h-3.5" /> Service Book
            </button>
          )}
        </div>
        <div className="space-y-4">
          <Notice msg={msg} onClose={() => setMsg(null)} />
          {loading ? (
            <div className="flex items-center justify-center gap-2 py-16 text-sm text-slate-500">
              <Spinner size={16} /> Loading…
            </div>
          ) : !data?.employee ? (
            <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">Your login isn't linked to an Employee record yet — please contact HR.</div>
          ) : tab === 'book' && canServiceBook ? (
            <Employee360 token={token} employeeId={null} self />
          ) : tab === 'pending' ? (
            <MyInfoRequests token={token} onCountChange={setOpenCount} />
          ) : tab === 'letters' ? (
            <>
              <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
                {data.letters.length === 0 ? (
                  <div className="p-8 text-center text-sm text-slate-400">
                    <Inbox className="w-8 h-8 mx-auto mb-2 text-slate-300" />
                    No letters yet.
                  </div>
                ) : (
                  data.letters.map((l) => {
                    const needsAck = Number(l.requires_ack) && !l.acknowledged_at;
                    return (
                      <div key={l.id} className={`p-4 ${needsAck ? 'bg-amber-50/40' : ''}`}>
                        <div className="flex items-start justify-between gap-2 flex-wrap">
                          <div className="min-w-0">
                            <div className="text-sm font-semibold text-slate-800">{l.letter_label}</div>
                            <div className="text-xs text-slate-600 truncate">{l.subject}</div>
                            <div className="text-[11px] text-slate-400 mt-0.5">
                              {l.ref_no} · {fmtDate(l.letter_date)}
                            </div>
                          </div>
                          {l.acknowledged_at ? (
                            <Badge tone="approved">
                              <CheckCircle2 className="w-3 h-3" /> Acknowledged
                            </Badge>
                          ) : needsAck ? (
                            <Badge tone="pending">
                              <Clock className="w-3 h-3" /> Please acknowledge
                            </Badge>
                          ) : null}
                        </div>
                        <div className="flex flex-wrap gap-2 mt-3">
                          <button type="button" className={btnGhost} onClick={async () => setPdf({ bytes: await letterPdfBytes(company, asPdf(l)), letter: l })}>
                            <Eye className="w-3.5 h-3.5" /> View
                          </button>
                          <button type="button" className={btnGhost} onClick={() => saveLetterPdf(company, asPdf(l))}>
                            <Download className="w-3.5 h-3.5" /> Download
                          </button>
                          {needsAck ? (
                            <button type="button" className={btnPrimary} disabled={acking === l.id} onClick={() => acknowledge(l)}>
                              {acking === l.id ? <Spinner size={14} /> : <CheckCircle2 className="w-3.5 h-3.5" />} I have received this letter
                            </button>
                          ) : null}
                        </div>
                      </div>
                    );
                  })
                )}
              </div>

              <div className="rounded-2xl bg-white border border-slate-200 p-4 space-y-3">
                <div className="text-sm font-bold text-slate-800">Request a letter</div>
                <div className="grid sm:grid-cols-[220px_1fr] gap-3">
                  <div>
                    <label className={labelCls}>Letter</label>
                    <select value={reqType} onChange={(e) => setReqType(e.target.value)} className={inputCls}>
                      {(data.requestable || []).map((r) => (
                        <option key={r.key} value={r.key}>
                          {r.label}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div>
                    <label className={labelCls}>What do you need it for?</label>
                    <input value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="e.g. bank loan application / visa processing" className={inputCls} />
                  </div>
                </div>
                <button type="button" className={btnPrimary} disabled={sending || !purpose.trim()} onClick={request}>
                  {sending ? <Spinner size={14} /> : <Send className="w-3.5 h-3.5" />} Send Request
                </button>
                {data.requests.length > 0 && (
                  <ul className="divide-y divide-slate-100 border-t border-slate-100 pt-1">
                    {data.requests.map((r) => (
                      <li key={r.id} className="py-2 flex items-center justify-between gap-2 text-xs">
                        <span>
                          <span className="font-semibold text-slate-700">{r.letter_label}</span> <span className="text-slate-400">· {r.purpose}</span>
                          {r.status === 'rejected' && r.remarks && <span className="block text-rose-600 text-[11px]">{r.remarks}</span>}
                        </span>
                        <Badge tone={r.status === 'issued' ? 'approved' : r.status}>{r.status === 'issued' ? 'Issued' : r.status === 'rejected' ? 'Rejected' : 'Pending'}</Badge>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </>
          ) : (
            <>
              {book?.employee && (
                <div className="rounded-2xl bg-white border border-slate-200 p-4 grid grid-cols-2 sm:grid-cols-4 gap-3">
                  {[
                    ['Designation', book.employee.designation],
                    ['Department', book.employee.department],
                    ['Grade', book.employee.grade],
                    ['Supervisor', book.employee.supervisor],
                    ['Joined', fmtDate(book.employee.joining_date)],
                    ['Service', serviceLength(book.employee.service_length_months)],
                    ['Confirmed', fmtDate(book.employee.confirmation_date)],
                    ['Employee ID', book.employee.employee_code]
                  ].map(([k, v]) => (
                    <div key={k as string}>
                      <div className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">{k}</div>
                      <div className="text-xs font-semibold text-slate-800">{v || '—'}</div>
                    </div>
                  ))}
                </div>
              )}
              <div className="rounded-2xl bg-white border border-slate-200 p-5">
                <ServiceTimeline events={book?.events || []} />
              </div>
            </>
          )}
        </div>
      </div>
      <PdfPreviewModal
        isOpen={pdf !== null}
        pdfBytes={pdf?.bytes || null}
        filename={pdf ? letterFileName(pdf.letter.ref_no, data?.employee?.name) : ''}
        onClose={() => setPdf(null)}
        onDownload={() => pdf && saveLetterPdf(company, asPdf(pdf.letter))}
      />
    </div>
  );
};
