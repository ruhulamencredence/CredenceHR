/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Document Vault -> a document -> Signatures (ESignRoutes.ts): send it for
// signing (the employee alone, or — with the "Request signatures from
// others" layer — several people in order), follow who has signed, cancel,
// download the signed PDF and share its verification link.

import React, { useEffect, useState } from 'react';
import { PenLine, ArrowUp, ArrowDown, X, Send, Loader2, Download, ShieldCheck, Copy, Check, ExternalLink, CheckCircle2, Clock, XCircle, History, ShieldAlert, BadgeCheck, Search } from 'lucide-react';
import { MailPopup as Popup, inputCls, labelCls, ghostBtn } from './mail/MailPopup';
import { confirmDialog } from '../lib/confirmDialog';
import { esignFetch, openProtectedFile, dhakaTime, verifyLink, STATUS_LABEL, STATUS_CLS, type ESignDoc } from '../lib/esign';

interface Person { id: number; name: string; can_sign: boolean; employee_id?: string | null; designation?: string | null; department?: string | null; email?: string | null }

// Add a signer: type a name, Employee ID, designation, department or email;
// click (or Enter) adds them. People with Documents to Sign off are listed but
// can't be picked.
const SignerSearch: React.FC<{ people: Person[]; taken: Set<number>; full: boolean; onPick: (id: number) => void }> = ({ people, taken, full, onPick }) => {
  const [q, setQ] = useState('');
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const shown = React.useMemo(() => {
    const t = q.trim().toLowerCase();
    return people
      .filter((p) => !taken.has(p.id))
      .filter((p) => !t || `${p.name} ${p.employee_id || ''} ${p.designation || ''} ${p.department || ''} ${p.email || ''}`.toLowerCase().includes(t))
      .sort((a, b) => Number(b.can_sign) - Number(a.can_sign))
      .slice(0, 60);
  }, [people, taken, q]);
  useEffect(() => setActive(0), [q]);
  const pick = (p: Person | undefined) => {
    if (!p || !p.can_sign || full) return;
    onPick(p.id);
    setQ('');
  };
  return (
    <div>
      <div className="relative">
        <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
        <input
          className={`${inputCls} py-2 pl-9`}
          value={q}
          disabled={full}
          placeholder={full ? 'At most 10 signers' : 'Add a signer — name, Employee ID, designation or department'}
          onChange={(e) => {
            setQ(e.target.value);
            setOpen(true);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => setTimeout(() => setOpen(false), 150)}
          onKeyDown={(e) => {
            if (e.key === 'ArrowDown') {
              e.preventDefault();
              setOpen(true);
              setActive((a) => Math.min(a + 1, shown.length - 1));
            } else if (e.key === 'ArrowUp') {
              e.preventDefault();
              setActive((a) => Math.max(a - 1, 0));
            } else if (e.key === 'Enter') {
              e.preventDefault();
              pick(shown[active]);
            } else if (e.key === 'Escape') setOpen(false);
          }}
          aria-label="Add a signer"
        />
      </div>
      {open && !full && (
        <div className="mt-1 rounded-2xl bg-white shadow-lg ring-1 ring-black/5 max-h-60 overflow-y-auto" onMouseDown={(e) => e.preventDefault()}>
          {!shown.length ? (
            <div className="px-3 py-3 text-xs text-slate-500">{q ? `No one matches “${q}”.` : 'Everyone is added already.'}</div>
          ) : (
            shown.map((p, i) => (
              <button
                key={p.id}
                type="button"
                disabled={!p.can_sign}
                onClick={() => pick(p)}
                onMouseEnter={() => setActive(i)}
                className={`w-full text-left px-3 py-2 flex items-start gap-2 disabled:cursor-not-allowed ${i === active && p.can_sign ? 'bg-blue-50' : ''} ${p.can_sign ? '' : 'opacity-60'}`}
              >
                <span className="min-w-0 flex-1">
                  <span className="flex items-baseline gap-2 min-w-0">
                    <span className="text-sm font-medium text-slate-800 truncate">{p.name}</span>
                    {p.employee_id && <span className="text-[10px] font-semibold px-1.5 py-px rounded bg-slate-100 text-slate-600 shrink-0">ID {p.employee_id}</span>}
                  </span>
                  {(p.designation || p.department) && (
                    <span className="block text-xs text-slate-600 truncate">
                      {[p.designation, p.department].filter(Boolean).join(' · ')}
                    </span>
                  )}
                  {p.email && <span className="block text-[11px] text-slate-500 truncate">{p.email}</span>}
                </span>
                {!p.can_sign && <span className="text-[10px] text-rose-600 shrink-0 mt-0.5">Documents to Sign off</span>}
              </button>
            ))
          )}
        </div>
      )}
    </div>
  );
};
const sendBtn = 'liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-blue-600 disabled:opacity-60 inline-flex items-center gap-2';

export const DocumentSignaturesPopup: React.FC<{
  token: string;
  docId: number;
  ownerId: number;
  ownerName: string | null;
  // First-time signers (e.g. a letter: its issuer on the signature line).
  initialSigners?: { user_id: number; label: string; on_line?: boolean }[] | null;
  onClose: () => void;
  onChanged: () => void;
}> = ({ token, docId, ownerId, ownerName, initialSigners, onClose, onChanged }) => {
  const [doc, setDoc] = useState<ESignDoc | null>(null);
  const [people, setPeople] = useState<Person[]>([]);
  const [canOthers, setCanOthers] = useState(false);
  const [list, setList] = useState<{ user_id: number; label: string; on_line?: boolean }[]>(() =>
    initialSigners?.length ? initialSigners : [{ user_id: ownerId, label: 'Employee' }]
  );
  const [placement, setPlacement] = useState<'page' | 'last_page'>('page');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [copied, setCopied] = useState(false);
  const [history, setHistory] = useState<{ chain_ok: boolean; broken_at: number | null; events: { seq: number; label: string; user_name: string | null; ip: string | null; device: string; detail: string | null; at: string }[] } | null>(null);
  const [showHistory, setShowHistory] = useState(false);
  useEffect(() => {
    if (showHistory) void esignFetch<typeof history>(token, `/api/esign/documents/${docId}/events`).then(setHistory).catch((e) => setError(e.message));
  }, [showHistory, docId, token, doc?.sign_status]);

  const load = async () => {
    try {
      const [d, p, c] = await Promise.all([
        esignFetch<ESignDoc>(token, `/api/esign/documents/${docId}`),
        esignFetch<Person[]>(token, '/api/esign/signers'),
        esignFetch<{ can_request_others: boolean }>(token, '/api/esign/caps')
      ]);
      setDoc(d);
      setPeople(p);
      setCanOthers(c.can_request_others);
      if (d.signers.length && d.sign_status !== 'none') {
        setList(d.signers.map((s) => ({ user_id: s.user_id, label: s.label || '', on_line: !!s.on_line })));
        setPlacement(d.placement);
      }
    } catch (e: any) {
      setError(e.message);
    }
  };
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [docId]);

  const nameOf = (id: number) => people.find((p) => p.id === id)?.name || (id === ownerId ? ownerName : `#${id}`);
  const canSignOf = (id: number) => people.find((p) => p.id === id)?.can_sign ?? false;
  const editable = !doc || ['none', 'declined', 'cancelled'].includes(doc.sign_status);
  const move = (i: number, by: number) =>
    setList((l) => {
      const n = [...l];
      const j = i + by;
      if (j < 0 || j >= n.length) return l;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
  const send = async () => {
    setBusy(true);
    setError('');
    try {
      const signers = list.map((s) => ({ ...s, on_line: !!doc?.has_sign_box && !!s.on_line }));
      setDoc(await esignFetch<ESignDoc>(token, `/api/esign/documents/${docId}/request`, { method: 'POST', body: { signers, placement } }));
      onChanged();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const cancel = async () => {
    if (!(await confirmDialog('Cancel signing? Signatures already given are dropped and the document can be sent again.', { confirmLabel: 'Cancel signing', tone: 'danger' }))) return;
    try {
      setDoc(await esignFetch<ESignDoc>(token, `/api/esign/documents/${docId}/cancel`, { method: 'POST' }));
      onChanged();
    } catch (e: any) {
      setError(e.message);
    }
  };
  const blocked = list.filter((s) => !canSignOf(s.user_id));

  return (
    <Popup
      title="Signatures"
      icon={<PenLine className="w-4 h-4 text-blue-600" />}
      size="md"
      onClose={onClose}
      footer={
        editable ? (
          <>
            <button type="button" className={ghostBtn} onClick={onClose}>Close</button>
            <button type="button" className={sendBtn} disabled={busy || !list.length || blocked.length > 0} onClick={() => void send()}>
              {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} Send for signing
            </button>
          </>
        ) : (
          <>
            {doc?.sign_status === 'pending' && (
              <button type="button" className="px-4 py-2 rounded-full text-sm text-rose-600 hover:bg-rose-50 mr-auto" onClick={() => void cancel()}>
                Cancel signing
              </button>
            )}
            <button type="button" className={ghostBtn} onClick={onClose}>Close</button>
            {doc?.has_signed_file && (
              <button type="button" className={sendBtn.replace('bg-blue-600', 'bg-emerald-600')} onClick={() => void openProtectedFile(token, `/api/esign/documents/${docId}/signed`).catch((e) => setError(e.message))}>
                <Download className="w-4 h-4" /> Signed PDF
              </button>
            )}
          </>
        )
      }
    >
      {!doc && !error ? (
        <div className="py-10 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        </div>
      ) : (
        <div className="space-y-3">
          {doc && (
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-sm font-semibold text-slate-900">{doc.doc_type}</span>
              <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_CLS[doc.sign_status]}`}>{STATUS_LABEL[doc.sign_status]}</span>
              <span className="text-[11px] text-slate-500 truncate">{doc.file_name}</span>
            </div>
          )}

          {editable ? (
            <>
              {doc?.sign_status === 'declined' && (
                <p className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">
                  Declined by {doc.signers.find((s) => s.status === 'declined')?.name}: {doc.signers.find((s) => s.status === 'declined')?.decline_reason}
                </p>
              )}
              <div>
                <div className={labelCls}>Signers, in order</div>
                <ul className="liquid-glass-inset rounded-2xl divide-y divide-white/70">
                  {list.map((s, i) => (
                    <li key={s.user_id} className="flex items-center gap-2 px-3 py-2">
                      <span className="w-5 text-sm font-bold text-blue-600">{i + 1}</span>
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-slate-800 truncate">{nameOf(s.user_id)}</span>
                        {(() => {
                          const p = people.find((x) => x.id === s.user_id);
                          const sub = [p?.employee_id ? `ID ${p.employee_id}` : '', p?.designation, p?.department].filter(Boolean).join(' · ');
                          return sub ? <span className="block text-[11px] text-slate-500 truncate">{sub}</span> : null;
                        })()}
                        {!canSignOf(s.user_id) && <span className="block text-[10px] text-rose-600">Documents to Sign is off for them — turn it on in Module Access.</span>}
                        <input
                        className={`${inputCls} py-1 mt-1 text-xs`}
                        value={s.label}
                        placeholder="Role (e.g. HR Manager)"
                        onChange={(e) => setList((l) => l.map((x, k) => (k === i ? { ...x, label: e.target.value } : x)))}
                        aria-label={`Role of ${nameOf(s.user_id)}`}
                        />
                        {doc?.has_sign_box && (
                          <button
                            type="button"
                            onClick={() => setList((l) => l.map((x, k) => ({ ...x, on_line: k === i ? !x.on_line : false })))}
                            aria-pressed={!!s.on_line}
                            className={`mt-1 text-[10px] font-semibold rounded-full px-2 py-0.5 border inline-flex items-center gap-1 ${s.on_line ? 'bg-blue-600 text-white border-blue-600' : 'bg-white/70 text-slate-500 border-slate-200'}`}
                          >
                            <PenLine className="w-3 h-3" /> {s.on_line ? "Signs on the letter's signature line" : "Sign on the letter's signature line"}
                          </button>
                        )}
                      </span>
                      {canOthers && (
                        <>
                          <button type="button" onClick={() => move(i, -1)} disabled={i === 0} className="p-1 rounded-lg hover:bg-black/5 disabled:opacity-30" aria-label="Move up">
                            <ArrowUp className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => move(i, 1)} disabled={i === list.length - 1} className="p-1 rounded-lg hover:bg-black/5 disabled:opacity-30" aria-label="Move down">
                            <ArrowDown className="w-3.5 h-3.5" />
                          </button>
                          <button type="button" onClick={() => setList((l) => l.filter((_, k) => k !== i))} className="p-1 rounded-lg hover:bg-rose-50 text-rose-600" aria-label={`Remove ${nameOf(s.user_id)}`}>
                            <X className="w-3.5 h-3.5" />
                          </button>
                        </>
                      )}
                    </li>
                  ))}
                </ul>
              </div>
              {canOthers ? (
                <SignerSearch
                  people={people}
                  taken={new Set(list.map((s) => s.user_id))}
                  full={list.length >= 10}
                  onPick={(id) => setList((l) => [...l, { user_id: id, label: people.find((p) => p.id === id)?.designation || '' }])}
                />
              ) : (
                <p className="text-[11px] text-slate-500">Adding other HR / management signers needs the "Request signatures from others" permission (the employee and the letter signatory set in HR Operations → Settings don't).</p>
              )}
              <div>
                <div className={labelCls}>Where the signatures go</div>
                <div className="flex gap-2">
                  {(
                    [
                      ['page', 'Signature Certificate page at the end'],
                      ['last_page', 'Also along the bottom of the last page']
                    ] as const
                  ).map(([k, label]) => (
                    <button key={k} type="button" onClick={() => setPlacement(k)} className={`flex-1 text-xs font-semibold rounded-2xl px-3 py-2 border text-left ${placement === k ? 'bg-slate-900 text-white border-slate-900' : 'bg-white/70 text-slate-600 border-slate-200'}`}>
                      {label}
                    </button>
                  ))}
                </div>
              </div>
            </>
          ) : (
            doc && (
              <>
                <ul className="liquid-glass-inset rounded-2xl divide-y divide-white/70">
                  {doc.signers.map((s) => (
                    <li key={s.id} className="flex items-center gap-2 px-3 py-2.5">
                      {s.status === 'signed' ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : s.status === 'declined' ? <XCircle className="w-4 h-4 text-rose-600" /> : <Clock className={`w-4 h-4 ${s.status === 'pending' ? 'text-amber-500' : 'text-slate-300'}`} />}
                      <span className="min-w-0 flex-1">
                        <span className="block text-sm font-semibold text-slate-800 truncate">
                          {s.step}. {s.name}
                          {s.label ? <span className="font-normal text-slate-500"> · {s.label}</span> : null}
                          {s.on_line ? <span className="font-normal text-blue-600"> · on the signature line</span> : null}
                        </span>
                        <span className="block text-[11px] text-slate-500">
                          {s.status === 'signed' ? `Signed ${dhakaTime(s.signed_at)}` : s.status === 'pending' ? 'Their turn now' : s.status === 'cancelled' ? 'Cancelled' : 'Waiting'}
                        </span>
                      </span>
                    </li>
                  ))}
                </ul>
                <p className="text-[11px] text-slate-500">Sent by {doc.requested_by}, {dhakaTime(doc.requested_at)}{doc.completed_at ? ` · completed ${dhakaTime(doc.completed_at)}` : ''}</p>
              </>
            )
          )}

          {doc?.verify_code && !editable && (
            <div className="liquid-glass-inset rounded-2xl px-3 py-2.5">
              <div className="text-[11px] font-semibold text-slate-600 flex items-center gap-1.5">
                <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" /> Verification code {doc.verify_code}
              </div>
              <div className="flex items-center gap-2 mt-1">
                <span className="text-[11px] text-slate-500 truncate flex-1 min-w-0">{verifyLink(doc.verify_code)}</span>
                <button type="button" onClick={() => void navigator.clipboard?.writeText(verifyLink(doc.verify_code!)).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500); })} className="liquid-glass-chip p-1.5 rounded-full" aria-label="Copy link">
                  {copied ? <Check className="w-3.5 h-3.5" /> : <Copy className="w-3.5 h-3.5" />}
                </button>
                <a href={verifyLink(doc.verify_code)} target="_blank" rel="noreferrer" className="liquid-glass-chip p-1.5 rounded-full" aria-label="Open verification page">
                  <ExternalLink className="w-3.5 h-3.5" />
                </a>
              </div>
              {doc.sha256 && <div className="text-[10px] text-slate-400 mt-1 break-all">Original SHA-256 {doc.sha256}</div>}
              {doc.certificate && (
                <div className="text-[11px] text-emerald-700 mt-1 flex items-start gap-1">
                  <BadgeCheck className="w-3.5 h-3.5 mt-px shrink-0" />
                  <span className="min-w-0">
                    Digitally signed with the certificate of {doc.certificate.subject}
                    {doc.certificate.self_signed ? ' (self-signed)' : doc.certificate.issuer ? `, issued by ${doc.certificate.issuer}` : ''}
                  </span>
                </div>
              )}
            </div>
          )}
          {doc && doc.sign_status !== 'none' && (
            <div>
              <button type="button" onClick={() => setShowHistory((v) => !v)} className="text-xs font-semibold text-slate-600 hover:text-slate-900 inline-flex items-center gap-1.5">
                <History className="w-3.5 h-3.5" /> {showHistory ? 'Hide history' : 'History'}
              </button>
              {showHistory && history && (
                <div className="mt-2">
                  <p className={`text-[11px] font-semibold flex items-center gap-1.5 mb-1.5 ${history.chain_ok ? 'text-emerald-700' : 'text-rose-700'}`}>
                    {history.chain_ok ? <ShieldCheck className="w-3.5 h-3.5" /> : <ShieldAlert className="w-3.5 h-3.5" />}
                    {history.chain_ok ? `History intact — ${history.events.length} entries, each chained to the one before.` : `History was changed — entry ${history.broken_at} doesn't match.`}
                  </p>
                  <ul className="liquid-glass-inset rounded-2xl divide-y divide-white/70 max-h-64 overflow-y-auto">
                    {history.events.map((e) => (
                      <li key={e.seq} className="px-3 py-2">
                        <div className="flex items-baseline justify-between gap-2">
                          <span className="text-xs font-semibold text-slate-800">
                            {e.label}
                            {e.user_name ? <span className="font-normal text-slate-500"> · {e.user_name}</span> : null}
                          </span>
                          <span className="text-[10px] text-slate-500 whitespace-nowrap">{dhakaTime(e.at)}</span>
                        </div>
                        {(e.detail || e.ip) && <div className="text-[10px] text-slate-500 break-all">{[e.detail, [e.ip, e.device].filter(Boolean).join(' · ')].filter(Boolean).join(' — ')}</div>}
                      </li>
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
        </div>
      )}
    </Popup>
  );
};
