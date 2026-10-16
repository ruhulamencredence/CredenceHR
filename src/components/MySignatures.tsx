/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> Documents to Sign (ESignRoutes.ts, users.can_sign_documents):
// documents HR sent this account to sign, in order with any other signers,
// and this account's own documents sent for signing. Sign with a drawn or
// uploaded signature (kept for next time), or decline with a reason. Once
// everyone has signed, the signed PDF (with its Signature Certificate and
// verification QR) can be downloaded.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, PenLine, FileText, Download, Eye, CheckCircle2, Clock, XCircle, ShieldCheck, Loader2, Copy, Check, KeyRound, BookOpenCheck } from 'lucide-react';
import type { User } from '../types';
import { ModulePath } from './ModulePath';
import { Spinner } from './Spinner';
import { SignaturePad } from './SignaturePad';
import { DocReader } from './DocReader';
import { MailPopup as Popup, inputCls, labelCls, ghostBtn } from './mail/MailPopup';
import { useLiveRefresh } from '../lib/liveRefresh';
import { esignFetch, openProtectedFile, dhakaTime, verifyLink, STATUS_LABEL, STATUS_CLS, type ESignDoc } from '../lib/esign';

const signBtn = 'liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-blue-600 disabled:opacity-60 inline-flex items-center gap-2';

const SignerSteps: React.FC<{ d: ESignDoc; me: number }> = ({ d, me }) => (
  <ol className="flex flex-wrap items-center gap-1.5 mt-2">
    {d.signers.map((s, i) => (
      <li key={s.id} className="flex items-center gap-1.5">
        <span
          className={`inline-flex items-center gap-1 text-[11px] font-semibold rounded-full px-2 py-0.5 border ${
            s.status === 'signed' ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : s.status === 'pending' ? 'bg-amber-50 text-amber-700 border-amber-200' : s.status === 'declined' ? 'bg-rose-50 text-rose-700 border-rose-200' : 'bg-slate-50 text-slate-500 border-slate-200'
          }`}
          title={s.status === 'signed' ? `Signed ${dhakaTime(s.signed_at)}` : s.status === 'declined' ? `Declined: ${s.decline_reason || ''}` : s.status === 'pending' ? 'Their turn' : 'Waiting'}
        >
          {s.status === 'signed' ? <CheckCircle2 className="w-3 h-3" /> : s.status === 'declined' ? <XCircle className="w-3 h-3" /> : <Clock className="w-3 h-3" />}
          {s.step}. {s.user_id === me ? 'You' : s.name}
          {s.label ? <span className="font-normal opacity-75">· {s.label}</span> : null}
        </span>
        {i < d.signers.length - 1 && <span className="text-slate-300">›</span>}
      </li>
    ))}
  </ol>
);

const SignPopup: React.FC<{ token: string; user: User; d: ESignDoc; saved: string | null; onClose: () => void; onDone: (msg: string) => void }> = ({ token, user, d, saved, onClose, onDone }) => {
  const [useSaved, setUseSaved] = useState(!!saved);
  const [drawn, setDrawn] = useState<string | null>(null);
  const [name, setName] = useState(user.name || '');
  const [keep, setKeep] = useState(!saved);
  const [agree, setAgree] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  // E-Signature settings: read to the end first / a code from email.
  const [read, setRead] = useState(!!d.i_read);
  const [reading, setReading] = useState(false);
  const [otp, setOtp] = useState('');
  const [sentTo, setSentTo] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [wait, setWait] = useState(0);
  useEffect(() => {
    if (wait <= 0) return;
    const t = setTimeout(() => setWait((w) => w - 1), 1000);
    return () => clearTimeout(t);
  }, [wait]);
  const sendCode = async () => {
    setSending(true);
    setError('');
    try {
      const r = await esignFetch<{ sent_to: string }>(token, `/api/esign/documents/${d.id}/otp`, { method: 'POST' });
      setSentTo(r.sent_to);
      setWait(60);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSending(false);
    }
  };
  const ready = agree && name.trim().length >= 2 && (useSaved ? !!saved : !!drawn) && (!d.require_read || read) && (!d.otp_required || otp.length === 6);
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await esignFetch<ESignDoc>(token, `/api/esign/documents/${d.id}/sign`, {
        method: 'POST',
        body: { signed_name: name.trim(), image: useSaved ? null : drawn, save_signature: !useSaved && keep, agree: true, otp: d.otp_required ? otp : undefined }
      });
      onDone(r.sign_status === 'completed' ? 'Signed — everyone has signed, the signed PDF is ready.' : 'Signed. The next signer has been told.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
    <Popup
      title="Sign document"
      icon={<PenLine className="w-4 h-4 text-blue-600" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={signBtn} disabled={!ready || busy} onClick={() => void submit()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <PenLine className="w-4 h-4" />} Sign
          </button>
        </>
      }
    >
      <div className="space-y-3">
        <div className="liquid-glass-inset rounded-2xl px-3 py-2.5 flex items-center gap-3">
          <FileText className="w-5 h-5 text-slate-400 shrink-0" />
          <div className="min-w-0 flex-1">
            <div className="text-sm font-semibold text-slate-900 truncate">{d.doc_type}</div>
            <div className="text-[11px] text-slate-500 truncate">
              {d.file_name} · {d.owner_name}
            </div>
          </div>
          <button type="button" onClick={() => setReading(true)} className="liquid-glass-chip rounded-full px-3 py-1.5 text-xs font-semibold text-slate-700 inline-flex items-center gap-1">
            {read ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <Eye className="w-3.5 h-3.5" />} Read
          </button>
        </div>
        {d.require_read && !read && (
          <p className="text-[11px] px-3 py-2 rounded-xl bg-amber-50 text-amber-800 flex items-center gap-1.5">
            <BookOpenCheck className="w-3.5 h-3.5 shrink-0" /> Open <b>Read</b> and scroll to the end of the document before signing.
          </p>
        )}

        {saved && (
          <div className="flex gap-2">
            {(
              [
                [true, 'My saved signature'],
                [false, 'Draw a new one']
              ] as const
            ).map(([v, label]) => (
              <button key={String(v)} type="button" onClick={() => setUseSaved(v)} className={`flex-1 text-xs font-semibold rounded-full px-3 py-1.5 border ${useSaved === v ? 'bg-slate-900 text-white border-slate-900' : 'bg-white/70 text-slate-600 border-slate-200'}`}>
                {label}
              </button>
            ))}
          </div>
        )}
        {useSaved && saved ? (
          <div className="liquid-glass-inset rounded-2xl p-3 flex items-center justify-center bg-white">
            <img src={saved} alt="Your saved signature" className="max-h-20 object-contain" />
          </div>
        ) : (
          <>
            <SignaturePad onChange={setDrawn} />
            <label className="flex items-center gap-2 text-xs text-slate-700 cursor-pointer">
              <input type="checkbox" checked={keep} onChange={(e) => setKeep(e.target.checked)} className="accent-blue-600" /> Keep this as my signature for next time
            </label>
          </>
        )}
        <div>
          <label className={labelCls}>Your full name</label>
          <input className={inputCls} value={name} onChange={(e) => setName(e.target.value)} />
        </div>
        {d.otp_required && (
          <div className="liquid-glass-inset rounded-2xl p-3">
            <div className="text-xs font-semibold text-slate-700 flex items-center gap-1.5">
              <KeyRound className="w-3.5 h-3.5 text-blue-600" /> Code from your email
            </div>
            <p className="text-[11px] text-slate-500 mt-0.5">{sentTo ? `Sent to ${sentTo}. It works once, for 5 minutes.` : 'A 6-digit code is emailed to you to confirm it is really you.'}</p>
            <div className="flex gap-2 mt-2">
              <input
                className={`${inputCls} tracking-[0.4em] text-center font-semibold`}
                inputMode="numeric"
                autoComplete="one-time-code"
                maxLength={6}
                value={otp}
                onChange={(e) => setOtp(e.target.value.replace(/\D/g, '').slice(0, 6))}
                placeholder="••••••"
                aria-label="6-digit code"
              />
              <button type="button" onClick={() => void sendCode()} disabled={sending || wait > 0} className="liquid-glass-chip rounded-full px-3 text-xs font-semibold text-slate-700 whitespace-nowrap disabled:opacity-50">
                {sending ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : wait > 0 ? `Again in ${wait}s` : sentTo ? 'Send again' : 'Send code'}
              </button>
            </div>
          </div>
        )}
        <label className="flex items-start gap-2 text-xs text-slate-700 cursor-pointer">
          <input type="checkbox" checked={agree} onChange={(e) => setAgree(e.target.checked)} className="accent-blue-600 mt-0.5" />
          <span>I have read this document and I agree to sign it electronically. My name, signature, the time and this device's address are recorded on it.</span>
        </label>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
    {reading && <DocReader token={token} docId={d.id} title={d.doc_type} alreadyRead={read} onClose={() => setReading(false)} onRead={() => setRead(true)} />}
    </>
  );
};

const DeclinePopup: React.FC<{ token: string; d: ESignDoc; onClose: () => void; onDone: (msg: string) => void }> = ({ token, d, onClose, onDone }) => {
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    setBusy(true);
    setError('');
    try {
      await esignFetch(token, `/api/esign/documents/${d.id}/decline`, { method: 'POST', body: { reason } });
      onDone('Declined. HR has been told.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popup
      title="Decline to sign"
      icon={<XCircle className="w-4 h-4 text-rose-600" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-rose-600 disabled:opacity-60" disabled={!reason.trim() || busy} onClick={() => void submit()}>
            Decline
          </button>
        </>
      }
    >
      <p className="text-xs text-slate-600 mb-2">{d.doc_type} — tell HR why, so they can fix it and send it again.</p>
      <textarea className={`${inputCls} min-h-[6rem]`} value={reason} onChange={(e) => setReason(e.target.value)} placeholder="e.g. The joining date is wrong." autoFocus />
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mt-2">{error}</div>}
    </Popup>
  );
};

const CopyCode: React.FC<{ code: string }> = ({ code }) => {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      onClick={() => {
        void navigator.clipboard?.writeText(verifyLink(code)).then(() => {
          setDone(true);
          setTimeout(() => setDone(false), 1500);
        });
      }}
      className="inline-flex items-center gap-1 text-[11px] font-semibold text-slate-500 hover:text-slate-800"
      title={verifyLink(code)}
    >
      <ShieldCheck className="w-3.5 h-3.5" /> {code} {done ? <Check className="w-3 h-3" /> : <Copy className="w-3 h-3" />}
    </button>
  );
};

export const MySignatures: React.FC<{ token: string; user: User; onBack?: () => void }> = ({ token, user, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const [docs, setDocs] = useState<ESignDoc[] | null>(null);
  const [saved, setSaved] = useState<string | null>(null);
  const [tab, setTab] = useState<'todo' | 'all'>('todo');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [signing, setSigning] = useState<ESignDoc | null>(null);
  const [declining, setDeclining] = useState<ESignDoc | null>(null);
  const [editSig, setEditSig] = useState(false);

  const load = useCallback(() => {
    setError('');
    Promise.all([esignFetch<ESignDoc[]>(token, '/api/esign/my'), esignFetch<{ image: string | null }>(token, '/api/esign/my-signature')])
      .then(([d, s]) => {
        setDocs(d);
        setSaved(s.image);
      })
      .catch((e) => setError(e.message));
  }, [token]);
  useEffect(() => {
    load();
  }, [load]);
  useLiveRefresh(load);

  const todo = useMemo(() => (docs || []).filter((d) => d.my_turn), [docs]);
  const shown = tab === 'todo' ? todo : docs || [];
  const done = (msg: string) => {
    setSigning(null);
    setDeclining(null);
    setNotice(msg);
    load();
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-4xl">
        {!isNativeApp && <ModulePath path={['Self Service', 'Documents to Sign']} />}
        <div className="flex items-center justify-between gap-3 mb-4 mt-2 flex-wrap">
          <div className="flex items-center gap-2">
            {onBack && (
              <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
                <ArrowLeft className="w-5 h-5 text-slate-500" />
              </button>
            )}
            <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
              <PenLine className="w-5 h-5 text-blue-600 shrink-0" /> Documents to Sign
            </h1>
          </div>
          <div className="inline-flex rounded-xl bg-slate-100 p-1">
            {(
              [
                ['todo', `Waiting for me${todo.length ? ` (${todo.length})` : ''}`],
                ['all', 'All']
              ] as const
            ).map(([k, label]) => (
              <button key={k} type="button" onClick={() => setTab(k)} className={`px-3 py-1.5 rounded-lg text-xs font-semibold ${tab === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}>
                {label}
              </button>
            ))}
          </div>
        </div>

        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mb-3">{error}</div>}
        {notice && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700 mb-3">{notice}</div>}

        <div className="rounded-2xl bg-white border border-slate-200 p-4 mb-4 flex items-center gap-4 flex-wrap">
          <div className="min-w-0 flex-1">
            <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">My signature</div>
            <div className="text-xs text-slate-500">{saved ? 'Used when you sign, unless you draw a new one.' : 'Not saved yet — you can draw it when you sign.'}</div>
          </div>
          {saved && <img src={saved} alt="Your saved signature" className="h-12 max-w-[12rem] object-contain bg-white" />}
          <button type="button" onClick={() => setEditSig(true)} className="px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
            {saved ? 'Change' : 'Draw it now'}
          </button>
        </div>

        {!docs && !error ? (
          <div className="py-16 flex justify-center">
            <Spinner />
          </div>
        ) : docs && !shown.length ? (
          <div className="rounded-2xl bg-white border border-slate-200 p-8 text-center text-sm text-slate-500">{tab === 'todo' ? 'Nothing is waiting for your signature.' : 'No documents yet.'}</div>
        ) : (
          <div className="space-y-3">
            {shown.map((d) => (
              <div key={d.id} className={`rounded-2xl bg-white border p-4 ${d.my_turn ? 'border-blue-300 ring-1 ring-blue-100' : 'border-slate-200'}`}>
                <div className="flex items-start gap-3">
                  <FileText className="w-5 h-5 text-slate-400 shrink-0 mt-0.5" />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-sm font-semibold text-slate-900">{d.doc_type}</span>
                      <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${STATUS_CLS[d.sign_status]}`}>{d.my_turn ? 'Your turn' : STATUS_LABEL[d.sign_status]}</span>
                    </div>
                    <div className="text-[11px] text-slate-500 truncate">
                      {d.file_name} · {d.owner_id === user.id ? 'your document' : d.owner_name}
                      {d.requested_by ? ` · sent by ${d.requested_by}, ${dhakaTime(d.requested_at)}` : ''}
                    </div>
                    <SignerSteps d={d} me={user.id} />
                  </div>
                </div>
                <div className="flex items-center gap-2 flex-wrap mt-3 justify-end">
                  {d.verify_code && d.sign_status === 'completed' && <CopyCode code={d.verify_code} />}
                  <span className="flex-1" />
                  <button type="button" onClick={() => void openProtectedFile(token, `/api/employee-documents/${d.id}/file`).catch((e) => setError(e.message))} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
                    <Eye className="w-3.5 h-3.5" /> Read
                  </button>
                  {d.has_signed_file && (
                    <button type="button" onClick={() => void openProtectedFile(token, `/api/esign/documents/${d.id}/signed`).catch((e) => setError(e.message))} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-emerald-600 text-white hover:bg-emerald-700">
                      <Download className="w-3.5 h-3.5" /> Signed PDF
                    </button>
                  )}
                  {d.my_turn && (
                    <>
                      <button type="button" onClick={() => setDeclining(d)} className="px-3 py-2 rounded-xl text-xs font-semibold text-rose-700 hover:bg-rose-50">
                        Decline
                      </button>
                      <button type="button" onClick={() => setSigning(d)} className="inline-flex items-center gap-1.5 px-4 py-2 rounded-xl text-xs font-semibold bg-blue-600 text-white hover:bg-blue-700">
                        <PenLine className="w-3.5 h-3.5" /> Sign
                      </button>
                    </>
                  )}
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
      {signing && <SignPopup token={token} user={user} d={signing} saved={saved} onClose={() => setSigning(null)} onDone={done} />}
      {declining && <DeclinePopup token={token} d={declining} onClose={() => setDeclining(null)} onDone={done} />}
      {editSig && <SignatureEditor token={token} hasSaved={!!saved} onClose={() => setEditSig(false)} onDone={(m) => { setEditSig(false); setNotice(m); load(); }} />}
    </div>
  );
};

const SignatureEditor: React.FC<{ token: string; hasSaved: boolean; onClose: () => void; onDone: (msg: string) => void }> = ({ token, hasSaved, onClose, onDone }) => {
  const [png, setPng] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await esignFetch(token, '/api/esign/my-signature', { method: 'PUT', body: { image: png } });
      onDone('Signature saved.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await esignFetch(token, '/api/esign/my-signature', { method: 'DELETE' });
      onDone('Saved signature removed.');
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <Popup
      title="My signature"
      icon={<PenLine className="w-4 h-4 text-blue-600" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          {hasSaved && (
            <button type="button" className="px-4 py-2 rounded-full text-sm text-rose-600 hover:bg-rose-50 mr-auto" onClick={() => void remove()}>
              Remove
            </button>
          )}
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={signBtn} disabled={!png || busy} onClick={() => void save()}>
            Save
          </button>
        </>
      }
    >
      <SignaturePad onChange={setPng} />
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mt-2">{error}</div>}
    </Popup>
  );
};
