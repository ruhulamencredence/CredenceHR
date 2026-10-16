/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Public document check at /verify/<code> (and /verify to type a code) —
// main.tsx shows this instead of <App />, no sign-in, like /privacy. The QR
// code and link on a signed PDF's Signature Certificate (ESignRoutes.ts)
// open it: it shows who signed the document and when, and anyone holding a
// copy (a bank, an embassy, a new employer) can drop the file in to see
// whether it is exactly the signed copy. It never shows or sends the file.

import React, { useEffect, useState } from 'react';
import { ShieldCheck, ShieldAlert, FileCheck2, FileX2, Clock, CheckCircle2, XCircle, Loader2, Search, Upload } from 'lucide-react';
import { esignFetch, fileToBase64, dhakaTime } from '../lib/esign';

interface PublicView {
  code: string;
  doc_type: string;
  owner_name: string | null;
  status: 'pending' | 'completed' | 'declined' | 'cancelled';
  sent_at: string | null;
  completed_at: string | null;
  signed_sha256: string | null;
  original_sha256: string | null;
  integrity: { file_ok: boolean; history_ok: boolean; seal: 'valid' | 'invalid' | 'none' | 'unknown' } | null;
  signers: { step: number; name: string | null; label: string | null; status: string; signed_at: string | null }[];
}

const codeFromPath = () => {
  const m = /^\/verify\/([A-Za-z0-9-]+)\/?$/.exec(window.location.pathname);
  return m ? m[1].toUpperCase() : '';
};

export default function VerifyPage() {
  const [code, setCode] = useState(codeFromPath());
  const [typed, setTyped] = useState(codeFromPath());
  const [data, setData] = useState<PublicView | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [check, setCheck] = useState<{ match: 'signed' | 'original' | 'none'; name: string } | null>(null);
  const [checking, setChecking] = useState(false);

  useEffect(() => {
    document.title = 'Verify a document · CredenceHR';
    if (!code) return;
    setLoading(true);
    setError('');
    setData(null);
    setCheck(null);
    esignFetch<PublicView>(null, `/api/public/verify/${encodeURIComponent(code)}`)
      .then(setData)
      .catch((e) => setError(e.message))
      .finally(() => setLoading(false));
  }, [code]);

  const go = (e: React.FormEvent) => {
    e.preventDefault();
    const c = typed.trim().toUpperCase();
    if (!c) return;
    window.history.replaceState(null, '', `/verify/${c}`);
    setCode(c);
  };
  const checkFile = async (file: File) => {
    setChecking(true);
    setCheck(null);
    setError('');
    try {
      if (file.size > 20 * 1024 * 1024) throw new Error('The file is too big.');
      const r = await esignFetch<{ match: 'signed' | 'original' | 'none' }>(null, `/api/public/verify/${encodeURIComponent(code)}/check`, { method: 'POST', body: { file_base64: await fileToBase64(file) } });
      setCheck({ match: r.match, name: file.name });
    } catch (e: any) {
      setError(e.message);
    } finally {
      setChecking(false);
    }
  };

  const done = data?.status === 'completed';
  return (
    <div className="min-h-screen bg-gradient-to-b from-violet-50 via-white to-slate-50 text-slate-900 px-4 py-10">
      <div className="max-w-xl mx-auto">
        <div className="flex items-center gap-2 mb-6">
          <span className="w-10 h-10 rounded-2xl bg-gradient-to-b from-violet-400 to-violet-700 text-white font-extrabold flex items-center justify-center shadow-md">HR</span>
          <div>
            <div className="text-lg font-bold leading-tight">Document verification</div>
            <div className="text-xs text-slate-500">CredenceHR e-signature check</div>
          </div>
        </div>

        <form onSubmit={go} className="flex gap-2 mb-5">
          <input
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            placeholder="Verification code, e.g. ABCD-EFGH-JKLM"
            className="flex-1 text-sm px-3 py-2.5 rounded-xl bg-white border border-slate-200 focus:outline-none focus:ring-2 focus:ring-violet-200 uppercase"
            aria-label="Verification code"
          />
          <button type="submit" className="px-4 py-2.5 rounded-xl bg-violet-600 text-white text-sm font-semibold inline-flex items-center gap-1.5">
            <Search className="w-4 h-4" /> Check
          </button>
        </form>

        {loading && (
          <div className="py-12 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        )}
        {error && !loading && (
          <div className="rounded-2xl bg-rose-50 border border-rose-200 p-4 flex items-start gap-3">
            <ShieldAlert className="w-5 h-5 text-rose-600 shrink-0" />
            <div className="text-sm text-rose-800">{error}</div>
          </div>
        )}

        {data && (
          <div className="space-y-4">
            <div className={`rounded-3xl border p-5 ${done ? 'bg-emerald-50 border-emerald-200' : data.status === 'pending' ? 'bg-amber-50 border-amber-200' : 'bg-rose-50 border-rose-200'}`}>
              <div className="flex items-start gap-3">
                {done ? <ShieldCheck className="w-8 h-8 text-emerald-600 shrink-0" /> : data.status === 'pending' ? <Clock className="w-8 h-8 text-amber-600 shrink-0" /> : <ShieldAlert className="w-8 h-8 text-rose-600 shrink-0" />}
                <div>
                  <div className="text-base font-bold">
                    {done ? 'Signed by everyone' : data.status === 'pending' ? 'Still being signed' : data.status === 'declined' ? 'Signing was declined' : 'Signing was cancelled'}
                  </div>
                  <div className="text-sm text-slate-700 mt-0.5">
                    {data.doc_type}
                    {data.owner_name ? ` of ${data.owner_name}` : ''}
                  </div>
                  <div className="text-xs text-slate-500 mt-1">
                    Code {data.code}
                    {data.completed_at ? ` · completed ${dhakaTime(data.completed_at)}` : data.sent_at ? ` · sent ${dhakaTime(data.sent_at)}` : ''}
                  </div>
                </div>
              </div>
            </div>

            <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
              {data.signers.map((s) => (
                <div key={s.step} className="px-4 py-3 flex items-center gap-3">
                  {s.status === 'signed' ? <CheckCircle2 className="w-5 h-5 text-emerald-600" /> : s.status === 'declined' ? <XCircle className="w-5 h-5 text-rose-600" /> : <Clock className="w-5 h-5 text-slate-300" />}
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-semibold truncate">
                      {s.step}. {s.name || '—'}
                      {s.label ? <span className="font-normal text-slate-500"> · {s.label}</span> : null}
                    </div>
                    <div className="text-xs text-slate-500">{s.status === 'signed' ? `Signed ${dhakaTime(s.signed_at)}` : s.status === 'declined' ? 'Declined' : s.status === 'pending' ? 'Not signed yet (their turn)' : 'Not signed yet'}</div>
                  </div>
                </div>
              ))}
            </div>

            {done && data.integrity && (
              <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
                {(
                  [
                    [data.integrity.file_ok, 'The signed copy on record is unchanged', 'The signed copy on record was changed'],
                    [data.integrity.history_ok, 'The signing history is intact', 'The signing history was changed'],
                    ...(data.integrity.seal === 'none' || data.integrity.seal === 'unknown'
                      ? []
                      : [[data.integrity.seal === 'valid', 'Sealed by the CredenceHR server', "The server seal doesn't match"] as [boolean, string, string]])
                  ] as [boolean, string, string][]
                ).map(([ok, good, badText]) => (
                  <div key={good} className="px-4 py-2.5 flex items-center gap-2 text-sm">
                    {ok ? <CheckCircle2 className="w-4 h-4 text-emerald-600" /> : <XCircle className="w-4 h-4 text-rose-600" />}
                    <span className={ok ? 'text-slate-700' : 'text-rose-700 font-semibold'}>{ok ? good : badText}</span>
                  </div>
                ))}
              </div>
            )}
            {done && (
              <div className="rounded-2xl bg-white border border-slate-200 p-4">
                <div className="text-sm font-semibold mb-1">Is your copy the genuine one?</div>
                <p className="text-xs text-slate-500 mb-3">Choose the PDF you were given. It is checked by its fingerprint (SHA-256) — the file itself is not kept. If anything in it was changed, it won't match.</p>
                <label className="flex items-center justify-center gap-2 px-4 py-6 rounded-2xl border-2 border-dashed border-slate-200 hover:border-violet-300 cursor-pointer text-sm text-slate-600">
                  {checking ? <Loader2 className="w-5 h-5 animate-spin" /> : <Upload className="w-5 h-5" />} Choose the file
                  <input type="file" accept="application/pdf,image/*" className="hidden" onChange={(e) => e.target.files?.[0] && void checkFile(e.target.files[0])} />
                </label>
                {check && (
                  <div className={`mt-3 rounded-xl p-3 flex items-start gap-2 text-sm ${check.match === 'signed' ? 'bg-emerald-50 text-emerald-800' : check.match === 'original' ? 'bg-amber-50 text-amber-800' : 'bg-rose-50 text-rose-800'}`}>
                    {check.match === 'none' ? <FileX2 className="w-5 h-5 shrink-0" /> : <FileCheck2 className="w-5 h-5 shrink-0" />}
                    <span>
                      <b>{check.name}</b>{' '}
                      {check.match === 'signed'
                        ? 'is exactly the signed copy. It has not been changed.'
                        : check.match === 'original'
                          ? 'is the original document before signing — it does not carry the signatures.'
                          : 'does NOT match this document. It may have been changed, or it is a different file.'}
                    </span>
                  </div>
                )}
                {data.signed_sha256 && <div className="text-[10px] text-slate-400 mt-3 break-all">Signed copy SHA-256 {data.signed_sha256}</div>}
              </div>
            )}
          </div>
        )}
        <p className="text-[11px] text-slate-400 mt-8 text-center">This page shows only who signed and when — never the document itself.</p>
      </div>
    </div>
  );
}
