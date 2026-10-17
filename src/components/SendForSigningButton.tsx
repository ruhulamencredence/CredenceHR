/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Send for signing" next to a document the app makes itself — an HR letter
// (HR Operations -> Letters) or an exit's Clearance Certificate / Settlement
// Sheet. The page's own PDF becomes a Document Vault document linked to it
// (POST /api/esign/sources, ESignRoutes.ts) and the usual Signatures popup
// opens to pick the signers. Needs Document Vault access: the list call is
// refused without it, and then no button is shown at all.

import React, { useCallback, useEffect, useState } from 'react';
import { PenLine, Loader2 } from 'lucide-react';
import { DocumentSignaturesPopup } from './DocumentSignaturesPopup';
import { esignFetch, STATUS_LABEL, type ESignDoc, type SignStatus } from '../lib/esign';

export type SignSourceType = 'hr_letter' | 'exit_clearance' | 'exit_settlement';
export interface SignSourceState {
  source_id: number;
  document_id: number;
  sign_status: SignStatus;
  signers_total: number;
  signers_done: number;
}

// The signing state of every document of these source types; `enabled` is
// false when this account has no Document Vault access.
export function useSignSources(token: string, types: SignSourceType[]) {
  const key = types.join(',');
  const [enabled, setEnabled] = useState(false);
  const [byType, setByType] = useState<Record<string, Map<number, SignSourceState>>>({});
  const reload = useCallback(async () => {
    try {
      const lists = await Promise.all(key.split(',').map((t) => esignFetch<SignSourceState[]>(token, `/api/esign/sources?type=${t}`)));
      const next: Record<string, Map<number, SignSourceState>> = {};
      key.split(',').forEach((t, i) => (next[t] = new Map(lists[i].map((s) => [s.source_id, s]))));
      setByType(next);
      setEnabled(true);
    } catch {
      setEnabled(false);
    }
  }, [token, key]);
  useEffect(() => {
    void reload();
  }, [reload]);
  const stateOf = (type: SignSourceType, id: number) => byType[type]?.get(id) || null;
  return { enabled, stateOf, reload };
}

const toBase64 = (bytes: Uint8Array) => {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
};

const TONE: Record<SignStatus, string> = {
  none: 'text-slate-700 border-slate-200 hover:bg-slate-50',
  pending: 'text-amber-700 border-amber-200 bg-amber-50 hover:bg-amber-100',
  completed: 'text-emerald-700 border-emerald-200 bg-emerald-50 hover:bg-emerald-100',
  declined: 'text-rose-700 border-rose-200 bg-rose-50 hover:bg-rose-100',
  cancelled: 'text-slate-500 border-slate-200 hover:bg-slate-50'
};

export const SendForSigningButton: React.FC<{
  token: string;
  sourceType: SignSourceType;
  sourceId: number;
  state: SignSourceState | null;
  ownerName: string | null;
  docType: string;
  // Makes the same PDF the page downloads.
  makePdf: () => Promise<{ bytes: Uint8Array; fileName: string }>;
  onChanged: () => void;
  onError: (message: string) => void;
  compact?: boolean;
}> = ({ token, sourceType, sourceId, state, ownerName, docType, makePdf, onChanged, onError, compact }) => {
  const [busy, setBusy] = useState(false);
  const [open, setOpen] = useState<{ docId: number; ownerId: number } | null>(null);
  const status: SignStatus = state?.sign_status || 'none';
  const label =
    status === 'none'
      ? 'Send for signing'
      : status === 'pending'
        ? `Signing ${state?.signers_done ?? 0}/${state?.signers_total ?? 0}`
        : STATUS_LABEL[status];
  const click = async () => {
    setBusy(true);
    try {
      // Signed or out for signing: just open it. Otherwise send today's copy.
      if (state && (status === 'pending' || status === 'completed')) {
        const d = await esignFetch<ESignDoc>(token, `/api/esign/documents/${state.document_id}`);
        setOpen({ docId: d.id, ownerId: d.owner_id });
      } else {
        const { bytes, fileName } = await makePdf();
        const d = await esignFetch<ESignDoc>(token, '/api/esign/sources', {
          method: 'POST',
          body: { source_type: sourceType, source_id: sourceId, file_base64: toBase64(bytes), file_name: fileName, doc_type: docType }
        });
        setOpen({ docId: d.id, ownerId: d.owner_id });
      }
    } catch (e: any) {
      onError(e.message || 'Could not prepare the document for signing');
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <button
        type="button"
        title={compact ? label : undefined}
        aria-label={label}
        disabled={busy}
        onClick={() => void click()}
        className={
          compact
            ? `p-1.5 rounded-md disabled:opacity-50 ${status === 'none' ? 'text-slate-600 hover:bg-slate-100' : TONE[status]}`
            : `flex items-center gap-1 text-[11px] font-semibold px-3 py-1.5 rounded-lg border transition-colors disabled:opacity-50 ${TONE[status]}`
        }
      >
        {busy ? <Loader2 className={compact ? 'w-4 h-4 animate-spin' : 'w-3 h-3 animate-spin'} /> : <PenLine className={compact ? 'w-4 h-4' : 'w-3 h-3'} />}
        {!compact && label}
      </button>
      {open && (
        <DocumentSignaturesPopup
          token={token}
          docId={open.docId}
          ownerId={open.ownerId}
          ownerName={ownerName}
          onClose={() => {
            setOpen(null);
            onChanged();
          }}
          onChanged={onChanged}
        />
      )}
    </>
  );
};
