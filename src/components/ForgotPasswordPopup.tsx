/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Login page -> "Forgot password?" (PasswordResetRoutes.ts). Whichever of the
// two ways a Superadmin turned on:
//   Email code  Login ID -> a 6-digit code to the account's email -> code + new
//               password -> back to sign-in.
//   Ask HR      Login ID (+ a note) -> HR gets the request and gives a
//               temporary password.

import React, { useState } from 'react';
import { KeyRound, Mail, UserRound, Loader2, CheckCircle2, ArrowLeft } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { PasswordInput } from './PasswordInput';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';

export interface ForgotOptions {
  email: boolean;
  request: boolean;
}

type Step = 'none' | 'choose' | 'email' | 'code' | 'request' | 'done';

async function post(path: string, body: unknown) {
  const r = await fetch(apiUrl(path), { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(j.error || 'Something went wrong. Try again.');
  return j;
}

export const ForgotPasswordPopup: React.FC<{
  options: ForgotOptions;
  initialIdentifier: string;
  onClose: () => void;
  // The password was changed by email code: sign in with it.
  onReset: (identifier: string) => void;
}> = ({ options, initialIdentifier, onClose, onReset }) => {
  const none = !options.email && !options.request;
  const only = options.email && !options.request ? 'email' : !options.email && options.request ? 'request' : null;
  const [step, setStep] = useState<Step>(none ? 'none' : only || 'choose');
  const [identifier, setIdentifier] = useState(initialIdentifier);
  const [code, setCode] = useState('');
  const [pw, setPw] = useState('');
  const [pw2, setPw2] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [info, setInfo] = useState('');
  const [doneText, setDoneText] = useState('');
  const [resetDone, setResetDone] = useState(false);

  const run = async (fn: () => Promise<void>) => {
    setBusy(true);
    setError('');
    try {
      await fn();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const sendCode = () =>
    run(async () => {
      const j = await post('/api/auth/forgot/email', { identifier: identifier.trim() });
      setInfo(j.message);
      setStep('code');
    });
  const verify = () =>
    run(async () => {
      if (pw.length < 6) throw new Error('The new password must be at least 6 characters.');
      if (pw !== pw2) throw new Error("The two passwords don't match.");
      const j = await post('/api/auth/forgot/email/verify', { identifier: identifier.trim(), code: code.trim(), new_password: pw });
      setDoneText(j.message);
      setResetDone(true);
      setStep('done');
    });
  const ask = () =>
    run(async () => {
      const j = await post('/api/auth/forgot/request', { identifier: identifier.trim(), note: note.trim() });
      setDoneText(j.message);
      setStep('done');
    });

  const idField = (
    <div>
      <label className={labelCls}>Email or Project Name (your Login ID)</label>
      <input className={inputCls} value={identifier} onChange={(e) => setIdentifier(e.target.value)} autoFocus placeholder="you@company.com" />
    </div>
  );
  const back = !only && step !== 'choose' && step !== 'done' && (
    <button type="button" className={ghostBtn} onClick={() => { setError(''); setStep('choose'); }} disabled={busy}>
      <ArrowLeft className="w-4 h-4 inline -mt-0.5" /> Back
    </button>
  );

  let body: React.ReactNode = null;
  let footer: React.ReactNode = null;
  if (step === 'none') {
    // Both ways turned off by a Superadmin.
    body = (
      <div className="text-center py-2">
        <div className="liquid-glass-inset w-16 h-16 mx-auto rounded-[22px] flex items-center justify-center text-violet-700 mb-3">
          <KeyRound className="w-8 h-8" />
        </div>
        <p className="text-sm text-slate-700">Contact HR or your Admin — they can set a new password for you.</p>
      </div>
    );
    footer = <button type="button" className={primaryBtn} onClick={onClose}>OK</button>;
  } else if (step === 'choose') {
    body = (
      <div className="space-y-2">
        <p className="text-sm text-slate-600">How would you like to get back in?</p>
        <button type="button" onClick={() => setStep('email')} className="w-full liquid-glass-inset rounded-[22px] p-4 flex items-center gap-3 text-left hover:brightness-105">
          <span className="w-11 h-11 rounded-2xl bg-violet-100 text-violet-700 flex items-center justify-center shrink-0"><Mail className="w-5 h-5" /></span>
          <span><span className="block font-semibold text-slate-900">Get a code by email</span><span className="block text-xs text-slate-500">A 6-digit code goes to your account's email; set a new password yourself.</span></span>
        </button>
        <button type="button" onClick={() => setStep('request')} className="w-full liquid-glass-inset rounded-[22px] p-4 flex items-center gap-3 text-left hover:brightness-105">
          <span className="w-11 h-11 rounded-2xl bg-violet-100 text-violet-700 flex items-center justify-center shrink-0"><UserRound className="w-5 h-5" /></span>
          <span><span className="block font-semibold text-slate-900">Ask HR</span><span className="block text-xs text-slate-500">No email on your account? HR gives you a temporary password.</span></span>
        </button>
      </div>
    );
  } else if (step === 'email') {
    body = (
      <div className="space-y-3">
        {idField}
        <p className="text-xs text-slate-500">We send a 6-digit code to the email address on this account. It works for 15 minutes.</p>
      </div>
    );
    footer = (
      <>
        {back}
        <button type="button" className={primaryBtn} onClick={sendCode} disabled={busy || !identifier.trim()}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Send code
        </button>
      </>
    );
  } else if (step === 'code') {
    body = (
      <div className="space-y-3">
        {info && <div className="text-xs px-3 py-2 rounded-xl bg-violet-50 text-violet-800">{info}</div>}
        <div>
          <label className={labelCls}>6-digit code</label>
          <input className={`${inputCls} tracking-[0.4em] text-center text-lg font-semibold`} inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ''))} autoFocus placeholder="••••••" />
        </div>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>New password</label>
            <PasswordInput className={inputCls} value={pw} onChange={(e) => setPw(e.target.value)} autoComplete="new-password" />
          </div>
          <div>
            <label className={labelCls}>Type it again</label>
            <PasswordInput className={inputCls} value={pw2} onChange={(e) => setPw2(e.target.value)} autoComplete="new-password" />
          </div>
        </div>
        <button type="button" className="text-xs underline text-slate-500" onClick={sendCode} disabled={busy}>
          Didn't get it? Send a new code
        </button>
      </div>
    );
    footer = (
      <>
        <button type="button" className={ghostBtn} onClick={() => setStep('email')} disabled={busy}>
          <ArrowLeft className="w-4 h-4 inline -mt-0.5" /> Back
        </button>
        <button type="button" className={primaryBtn} onClick={verify} disabled={busy || code.length !== 6 || !pw}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Set new password
        </button>
      </>
    );
  } else if (step === 'request') {
    body = (
      <div className="space-y-3">
        {idField}
        <div>
          <label className={labelCls}>Note for HR (optional)</label>
          <input className={inputCls} value={note} maxLength={255} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Employee ID, phone number to reach you" />
        </div>
        <p className="text-xs text-slate-500">HR sees your request and gives you a temporary password. You set your own the next time you sign in.</p>
      </div>
    );
    footer = (
      <>
        {back}
        <button type="button" className={primaryBtn} onClick={ask} disabled={busy || !identifier.trim()}>
          {busy && <Loader2 className="w-4 h-4 animate-spin" />} Send to HR
        </button>
      </>
    );
  } else {
    body = (
      <div className="text-center py-2">
        <div className="liquid-glass-inset w-16 h-16 mx-auto rounded-[22px] flex items-center justify-center text-emerald-600 mb-3">
          <CheckCircle2 className="w-8 h-8" />
        </div>
        <p className="text-sm text-slate-700">{doneText}</p>
      </div>
    );
    footer = (
      <button type="button" className={primaryBtn} onClick={() => (resetDone ? onReset(identifier.trim()) : onClose())}>
        {resetDone ? 'Sign in' : 'OK'}
      </button>
    );
  }

  return (
    <Popup title="Forgot password" icon={<KeyRound className="w-4 h-4" />} size="md" onClose={busy ? () => {} : onClose} footer={footer}>
      <div className="space-y-3 text-left">
        {body}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};
