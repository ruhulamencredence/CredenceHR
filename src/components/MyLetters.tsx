/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> "My Letters & Service Record" — every letter HR has issued
// to this account's Employee record (view / download the PDF, and
// "Acknowledge" the ones that ask for it), requests for a Salary Certificate
// / Experience Certificate / NOC / Bank Account letter, and the Employee's
// own service record timeline, and Pending Items — documents / nominee /
// emergency contact HR has asked for (MyInfoRequests.tsx). (My Service Book —
// the own Employee 360 — lives on the Profile page, ProfilePage.tsx.) Backed by
// HROperationsRoutes.ts's /api/hr-ops/my/* routes; works the same in the
// mobile app.

import { useLiveRefresh } from '../lib/liveRefresh';
import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, FileText, CheckCircle2, Clock, Download, Eye, Send, BookOpen, Inbox, ClipboardList, BadgeCheck } from 'lucide-react';
import { esignFetch, openProtectedFile } from '../lib/esign';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';
import { PdfPreviewModal } from './PdfPreviewModal';
import { letterFileName } from '../lib/hrLetterPdf';
import { useHrApi, Badge, fmtDate, letterPdfBytes, saveLetterPdf, inputCls, labelCls, btnPrimary, btnGhost, Notice } from './HrOpsShared';
import { ServiceTimeline, serviceLength, type ServiceBookData } from './HrOpsServiceBook';
import { MyInfoRequests, useMyOpenRequests } from './MyInfoRequests';
import { LoadingBlock } from './LoadingBlock';

// Where a request / letter is now (HROperationsRoutes.ts /api/hr-ops/my/letters).
interface Signing {
  status: string;
  sent_at: string | null;
  completed_at: string | null;
  waiting_on: { name: string | null; label: string | null } | null;
  declined: { name: string | null; reason: string | null } | null;
  steps: { name: string | null; label: string | null; status: string; signed_at: string | null }[];
}
interface MyRequest {
  id: number;
  letter_label: string;
  purpose: string | null;
  status: string;
  remarks: string | null;
  created_at: string;
  handled_at?: string | null;
  handled_by_name?: string | null;
  stage?: 'with_hr' | 'signing' | 'done' | 'rejected';
  with?: string[];
  why?: string;
  signing?: Signing | null;
}
const daysSince = (d: string | null | undefined) => {
  if (!d) return null;
  const t = new Date(String(d).replace(' ', 'T')).getTime();
  if (Number.isNaN(t)) return null;
  const n = Math.floor((Date.now() - t) / 86_400_000);
  return n <= 0 ? 'today' : n === 1 ? '1 day' : `${n} days`;
};
// Who signs in what order, and whose turn it is.
const SignSteps: React.FC<{ s: Signing }> = ({ s }) => (
  <div className="flex flex-wrap items-center gap-1 mt-1.5">
    {s.steps.map((st, i) => (
      <React.Fragment key={i}>
        {i > 0 && <span className="text-slate-300 text-[10px]">→</span>}
        <span
          className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
            st.status === 'signed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : st.status === 'pending' ? 'bg-amber-50 text-amber-700 border-amber-300' : st.status === 'declined' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-slate-50 text-slate-500 border-slate-200'
          }`}
          title={st.status === 'signed' ? `Signed ${fmtDate(st.signed_at || '')}` : st.status === 'pending' ? 'Their turn now' : st.status === 'declined' ? 'Declined' : 'Waiting for the one before'}
        >
          {st.name || '—'}
          {st.label ? ` · ${st.label}` : ''}
          {st.status === 'signed' ? ' ✓' : st.status === 'pending' ? ' (now)' : ''}
        </span>
      </React.Fragment>
    ))}
  </div>
);

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
  signing?: Signing | null;
}
interface MyData {
  company?: { name: string; address: string; signatory_name: string; signatory_designation: string };
  employee?: { id: number; name: string; employee_code: string | null; designation: string | null; department: string | null };
  letters: MyLetter[];
  requests: MyRequest[];
  requestable?: { key: string; label: string }[];
}

export const MyLetters: React.FC<{ token: string; onBack?: () => void }> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const api = useHrApi(token);
  const [signed, setSigned] = useState<Map<number, { document_id: number; verify_code: string | null }>>(new Map());
  // An alert about a request opens straight on Pending Items.
  const [tab, setTab] = useState<'letters' | 'pending' | 'record'>(() => {
    try {
      const t = sessionStorage.getItem('my_letters_tab');
      if (t) sessionStorage.removeItem('my_letters_tab');
      if (t === 'pending') return t;
      if (t === 'record') return t;
    } catch {
      // storage unavailable
    }
    return 'letters';
  });
  useEffect(() => {
    const onTab = (e: Event) => {
      const t = (e as CustomEvent).detail;
      if (t === 'letters' || t === 'pending') setTab(t);
      else if (t === 'record') setTab(t);
      try {
        sessionStorage.removeItem('my_letters_tab');
      } catch {
        // storage unavailable
      }
    };
    window.addEventListener('credence:my-letters-tab', onTab);
    return () => window.removeEventListener('credence:my-letters-tab', onTab);
  }, []);
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

// Live refresh: reload when a request changes (src/lib/liveRefresh.ts).
useLiveRefresh(() => load(true));
  const load = async (silent?: unknown) => {
    if (silent !== true) setLoading(true);
    try {
      const [d, b, sg] = await Promise.all([
        api.get<MyData>('/api/hr-ops/my/letters'),
        api.get<ServiceBookData>('/api/hr-ops/my/service-book'),
        // Letters signed electronically (ESignRoutes.ts): the signed copy.
        esignFetch<{ source_id: number; document_id: number; verify_code: string | null }[]>(token, '/api/esign/my-sources?type=hr_letter').catch(() => [])
      ]);
      setData(d);
      setBook(b);
      setSigned(new Map(sg.map((x) => [x.source_id, x] as const)));
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
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8">
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
        </div>
        <div className="space-y-4">
          <Notice msg={msg} onClose={() => setMsg(null)} />
          {loading ? (
            <LoadingBlock />
          ) : !data?.employee ? (
            <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">Your login isn't linked to an Employee record yet — please contact HR.</div>
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
                            {l.signing && l.signing.status === 'pending' && (
                              <div className="mt-1.5 text-[11px] text-amber-700">
                                Waiting for {l.signing.waiting_on?.name || 'a signature'}
                                {l.signing.waiting_on?.label ? ` (${l.signing.waiting_on.label})` : ''} to sign
                                {daysSince(l.signing.sent_at) ? ` — sent ${daysSince(l.signing.sent_at)} ago` : ''}
                                <SignSteps s={l.signing} />
                              </div>
                            )}
                            {l.signing && l.signing.status === 'declined' && (
                              <div className="mt-1.5 text-[11px] text-rose-600">
                                {l.signing.declined?.name || 'A signer'} declined to sign{l.signing.declined?.reason ? `: ${l.signing.declined.reason}` : ''} — HR has to send it again.
                              </div>
                            )}
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
                          {signed.has(l.id) && (
                            <button
                              type="button"
                              className={btnPrimary}
                              title={signed.get(l.id)?.verify_code ? `Verification code ${signed.get(l.id)?.verify_code}` : undefined}
                              onClick={() => void openProtectedFile(token, `/api/esign/documents/${signed.get(l.id)!.document_id}/signed`).catch((e) => setMsg({ type: 'error', text: e.message }))}
                            >
                              <BadgeCheck className="w-3.5 h-3.5" /> Signed copy (PDF)
                            </button>
                          )}
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
                    {data.requests.map((r) => {
                      const stage = r.stage || (r.status === 'pending' ? 'with_hr' : r.status === 'rejected' ? 'rejected' : 'done');
                      const badge = stage === 'with_hr' ? 'With HR' : stage === 'signing' ? 'Waiting for signature' : stage === 'rejected' ? 'Rejected' : 'Issued';
                      return (
                        <li key={r.id} className="py-2.5 text-xs">
                          <div className="flex items-start justify-between gap-2">
                            <span className="min-w-0">
                              <span className="font-semibold text-slate-700">{r.letter_label}</span> <span className="text-slate-400">· {r.purpose}</span>
                              <span className="block text-[11px] text-slate-400">
                                Requested {fmtDate(r.created_at)}
                                {stage === 'with_hr' && daysSince(r.created_at) ? ` — waiting ${daysSince(r.created_at)}` : ''}
                              </span>
                            </span>
                            <Badge tone={stage === 'done' ? 'approved' : stage === 'rejected' ? 'rejected' : 'pending'}>{badge}</Badge>
                          </div>
                          {/* Where it is, with whom, and why */}
                          <div className={`mt-1.5 rounded-xl px-3 py-2 text-[11px] ${stage === 'rejected' ? 'bg-rose-50 text-rose-700' : stage === 'done' ? 'bg-emerald-50 text-emerald-800' : 'bg-amber-50 text-amber-800'}`}>
                            {stage === 'with_hr' && (
                              <>
                                <span className="font-semibold">Where:</span> HR Operations — not issued yet.
                                {r.with && r.with.length > 0 && (
                                  <span className="block mt-0.5">
                                    <span className="font-semibold">With:</span> {r.with.slice(0, 4).join(', ')}
                                    {r.with.length > 4 ? ` and ${r.with.length - 4} more` : ''} (anyone of them can issue it)
                                  </span>
                                )}
                              </>
                            )}
                            {stage === 'signing' && (
                              <>
                                <span className="font-semibold">Where:</span> {r.why}
                                {r.handled_by_name && <span className="block mt-0.5">Issued by {r.handled_by_name}{r.handled_at ? ` on ${fmtDate(r.handled_at)}` : ''}.</span>}
                                {r.signing && <SignSteps s={r.signing} />}
                              </>
                            )}
                            {stage === 'rejected' && (
                              <>
                                <span className="font-semibold">Rejected</span>
                                {r.handled_by_name ? ` by ${r.handled_by_name}` : ''}
                                {r.handled_at ? ` on ${fmtDate(r.handled_at)}` : ''}
                                {r.remarks ? ` — ${r.remarks}` : ''}
                              </>
                            )}
                            {stage === 'done' && (
                              <>
                                Issued{r.handled_by_name ? ` by ${r.handled_by_name}` : ''}
                                {r.handled_at ? ` on ${fmtDate(r.handled_at)}` : ''} — it is in your letters above.
                              </>
                            )}
                          </div>
                        </li>
                      );
                    })}
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
