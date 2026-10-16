/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Document Vault -> E-Signature settings (ESignRoutes.ts, esign_settings),
// shown only with the "E-Signature settings" layer: switch the sign-in code
// (OTP by email) and "read to the end before signing" on or off. Both start
// off. The history and the server seal are always on.

import React, { useEffect, useState } from 'react';
import { Settings2, Loader2, Save, KeyRound, BookOpenCheck, History, ShieldCheck } from 'lucide-react';
import { MailPopup as Popup, ghostBtn, Toggle } from './mail/MailPopup';
import { esignFetch } from '../lib/esign';

interface Settings {
  otp_required: boolean;
  otp_doc_types: string[];
  require_read: boolean;
  can_edit: boolean;
  email_ready: boolean;
  seal_ready: boolean;
  doc_types: string[];
}
const PRESETS = ['Appointment Letter', 'Employment Contract', 'NID / Passport Copy', 'Certificate', 'Experience Letter', 'Other'];

export const ESignSettingsPopup: React.FC<{ token: string; onClose: () => void; onSaved: (msg: string) => void }> = ({ token, onClose, onSaved }) => {
  const [s, setS] = useState<Settings | null>(null);
  const [otp, setOtp] = useState(false);
  const [allTypes, setAllTypes] = useState(true);
  const [types, setTypes] = useState<Set<string>>(new Set());
  const [read, setRead] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => {
    esignFetch<Settings>(token, '/api/esign/settings')
      .then((r) => {
        setS(r);
        setOtp(r.otp_required);
        setAllTypes(!r.otp_doc_types.length);
        setTypes(new Set(r.otp_doc_types));
        setRead(r.require_read);
      })
      .catch((e) => setError(e.message));
  }, [token]);
  const options = [...new Set([...PRESETS, ...(s?.doc_types || []), ...types])];
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await esignFetch(token, '/api/esign/settings', { method: 'PUT', body: { otp_required: otp, otp_doc_types: allTypes ? [] : [...types], require_read: read } });
      onSaved('E-Signature settings saved.');
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <Popup
      title="E-Signature settings"
      icon={<Settings2 className="w-4 h-4 text-blue-600" />}
      size="md"
      onClose={onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>Close</button>
          <button type="button" className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-blue-600 disabled:opacity-60 inline-flex items-center gap-2" disabled={!s || busy || (otp && !allTypes && !types.size)} onClick={() => void save()}>
            {busy ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />} Save
          </button>
        </>
      }
    >
      {!s && !error ? (
        <div className="py-10 flex justify-center">
          <Loader2 className="w-5 h-5 animate-spin text-slate-400" />
        </div>
      ) : (
        s && (
          <div className="space-y-4">
            <div className="liquid-glass-inset rounded-2xl p-3 space-y-3">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <KeyRound className="w-4 h-4 text-blue-600" /> Sign-in code (OTP)
              </div>
              <Toggle
                checked={otp}
                onChange={setOtp}
                label="Ask for a code from email before signing"
                hint="A 6-digit code is emailed to the signer; it works once, for 5 minutes; 5 wrong tries lock it for 15 minutes."
              />
              {!s.email_ready && <p className="text-[11px] px-3 py-2 rounded-xl bg-amber-50 text-amber-800">Email isn't set up on the server yet (SMTP_HOST / SMTP_USER / SMTP_PASS), so this can't be turned on.</p>}
              <p className="text-[11px] text-slate-500">SMS codes can be added once an SMS gateway is connected.</p>
              {otp && (
                <div>
                  <Toggle checked={allTypes} onChange={setAllTypes} label="For every document type" />
                  {!allTypes && (
                    <div className="flex flex-wrap gap-1.5 mt-2">
                      {options.map((t) => (
                        <button
                          key={t}
                          type="button"
                          onClick={() =>
                            setTypes((cur) => {
                              const n = new Set(cur);
                              if (n.has(t)) n.delete(t);
                              else n.add(t);
                              return n;
                            })
                          }
                          className={`text-xs font-semibold rounded-full px-3 py-1.5 border ${types.has(t) ? 'bg-slate-900 text-white border-slate-900' : 'bg-white/70 text-slate-600 border-slate-200'}`}
                        >
                          {t}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}
            </div>
            <div className="liquid-glass-inset rounded-2xl p-3 space-y-2">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-800">
                <BookOpenCheck className="w-4 h-4 text-blue-600" /> Read to the end
              </div>
              <Toggle checked={read} onChange={setRead} label="Signers must scroll the document to its end first" hint="In the in-app reader; the time they spent is written in the history." />
            </div>
            <div className="liquid-glass-inset rounded-2xl p-3 text-[11px] text-slate-600 space-y-1.5">
              <div className="flex items-start gap-2">
                <History className="w-3.5 h-3.5 mt-0.5 text-slate-500 shrink-0" /> History is always kept: every step with time, IP and device, chained so a changed or deleted entry shows. It is printed on the signed PDF.
              </div>
              <div className="flex items-start gap-2">
                <ShieldCheck className="w-3.5 h-3.5 mt-0.5 text-slate-500 shrink-0" />
                {s.seal_ready ? 'Server seal is on — every signed PDF is sealed and the verify page checks it.' : 'Server seal is off — set ESIGN_SEAL_KEY on the server to seal signed PDFs.'}
              </div>
            </div>
            {!s.can_edit && <p className="text-[11px] text-slate-500">You can see these settings but not change them.</p>}
          </div>
        )
      )}
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mt-2">{error}</div>}
    </Popup>
  );
};
