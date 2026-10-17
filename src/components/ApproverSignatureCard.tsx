/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Approve Application -> "My signature": the signature kept with every
// Conveyance Bill Claim the person approves and printed under "Approved By" on
// the Conveyance Bill and Payment Voucher (Bill Claim Policy -> "Put each
// approver's signature on the Bill and Voucher"). Shown only while that rule is
// on (GET /api/claim-signature says so); it is the same saved signature as
// Self Service -> Documents to Sign.

import React, { useEffect, useState } from 'react';
import { PenLine } from 'lucide-react';
import { MailPopup as Popup, ghostBtn } from './mail/MailPopup';
import { SignaturePad } from './SignaturePad';
import { esignFetch } from '../lib/esign';

const saveBtn = 'liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold text-white bg-blue-600 disabled:opacity-60 inline-flex items-center gap-2';

export const ApproverSignatureCard: React.FC<{ token: string }> = ({ token }) => {
  const [state, setState] = useState<{ enabled: boolean; image: string | null } | null>(null);
  const [edit, setEdit] = useState(false);
  const [png, setPng] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const load = () => esignFetch<{ enabled: boolean; image: string | null }>(token, '/api/claim-signature').then(setState).catch(() => setState(null));
  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);
  if (!state?.enabled) return null;
  const save = async () => {
    setBusy(true);
    setError('');
    try {
      await esignFetch(token, '/api/claim-signature', { method: 'PUT', body: { image: png } });
      setEdit(false);
      setPng(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async () => {
    try {
      await esignFetch(token, '/api/claim-signature', { method: 'DELETE' });
      setEdit(false);
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };
  return (
    <>
      <div className="mb-4 rounded-2xl bg-white border border-slate-200 p-4 flex items-center gap-4 flex-wrap">
        <div className="min-w-0 flex-1">
          <div className="text-xs font-semibold uppercase tracking-wider text-slate-500">My signature</div>
          <div className="text-xs text-slate-500">
            {state.image ? 'Printed under "Approved By" on the Conveyance Bill and Voucher of every claim you approve.' : 'Not saved yet — claims you approve will show your name only. Draw it once and it goes on every Bill you approve.'}
          </div>
        </div>
        {state.image && <img src={state.image} alt="Your saved signature" className="h-12 max-w-[12rem] object-contain bg-white" />}
        <button type="button" onClick={() => setEdit(true)} className="px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
          {state.image ? 'Change' : 'Draw it now'}
        </button>
      </div>
      {edit && (
        <Popup
          title="My signature"
          icon={<PenLine className="w-4 h-4 text-blue-600" />}
          size="md"
          onClose={() => setEdit(false)}
          footer={
            <>
              {state.image && (
                <button type="button" className="px-4 py-2 rounded-full text-sm text-rose-600 hover:bg-rose-50 mr-auto" onClick={() => void remove()}>
                  Remove
                </button>
              )}
              <button type="button" className={ghostBtn} onClick={() => setEdit(false)}>Cancel</button>
              <button type="button" className={saveBtn} disabled={!png || busy} onClick={() => void save()}>Save</button>
            </>
          }
        >
          <SignaturePad onChange={setPng} />
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mt-2">{error}</div>}
        </Popup>
      )}
    </>
  );
};
