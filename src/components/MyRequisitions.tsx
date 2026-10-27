/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// SIM & ID card requisitions, the asker's side (RequisitionRoutes.ts):
//   Self Service -> SIM & ID Card   (users.can_request_items)
//   My Onboarding -> Requisitions   (a new joiner, while HR has it turned on)
// Ask for a SIM or an ID card, see what HR did with it, cancel one still waiting.

import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, CreditCard, Smartphone, X } from 'lucide-react';
import { ModulePath } from './ModulePath';
import { LoadingBlock } from './LoadingBlock';
import { MailPopup as Popup, primaryBtn, ghostBtn } from './mail/MailPopup';
import { confirmDialog } from '../lib/confirmDialog';
import { apiUrl } from '../lib/api';

export interface Requisition {
  id: number;
  kind: 'sim' | 'id_card';
  status: 'requested' | 'issued' | 'rejected' | 'cancelled';
  reason: string;
  note: string | null;
  operator: string | null;
  name_on_card: string | null;
  blood_group: string | null;
  card_number: string | null;
  sim_number: string | null;
  decision_note: string | null;
  decided_at: string | null;
  created_at: string;
}

export const KIND_LABEL = { sim: 'SIM', id_card: 'ID card' } as const;
export const REASON_LABEL: Record<string, string> = { new: 'New', replacement: 'Replacement', lost: 'Lost', damaged: 'Damaged' };
const REASONS = { sim: ['new', 'replacement'], id_card: ['new', 'lost', 'damaged', 'replacement'] } as const;
const OPERATORS = ['Grameenphone', 'Robi', 'Banglalink', 'Airtel', 'Teletalk'];
const BLOOD = ['A+', 'A-', 'B+', 'B-', 'AB+', 'AB-', 'O+', 'O-'];

export const statusChip = (s: Requisition['status']) =>
  s === 'issued'
    ? 'bg-emerald-50 text-emerald-700 border-emerald-200'
    : s === 'rejected'
      ? 'bg-rose-50 text-rose-700 border-rose-200'
      : s === 'cancelled'
        ? 'bg-slate-100 text-slate-500 border-slate-200'
        : 'bg-amber-50 text-amber-700 border-amber-200';
export const statusLabel = (s: Requisition['status']) => (s === 'requested' ? 'Waiting for HR' : s === 'issued' ? 'Issued' : s === 'rejected' ? 'Turned down' : 'Cancelled');
export const shortDate = (v: string | null) => (v ? new Date(v).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');

const fieldCls = 'block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none';
const labelCls = 'block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1';

/** The list + "New request". `joiner` = from My Onboarding (its own API). */
export const RequisitionPanel: React.FC<{ token: string; joiner?: boolean; defaultName?: string; wrap?: (body: React.ReactNode) => React.ReactNode }> = ({
  token,
  joiner = false,
  defaultName = '',
  wrap
}) => {
  const base = joiner ? '/api/onboarding/me/requisitions' : '/api/requisitions';
  const [rows, setRows] = useState<Requisition[] | null>(null);
  const [enabled, setEnabled] = useState(true);
  const [hasEmployee, setHasEmployee] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<{ kind: 'sim' | 'id_card'; reason: string; note: string; operator: string; name_on_card: string; blood_group: string } | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl(joiner ? base : `${base}/mine`), { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not load');
      setRows(d.rows || []);
      if (joiner) setEnabled(!!d.enabled);
      else setHasEmployee(d.has_employee !== false);
    } catch (e: any) {
      setError(e.message);
      setRows([]);
    }
  }, [token, joiner, base]);
  useEffect(() => {
    void load();
  }, [load]);

  const open = (kind: 'sim' | 'id_card') => {
    setError('');
    setForm({ kind, reason: 'new', note: '', operator: '', name_on_card: defaultName, blood_group: '' });
  };
  const waiting = (kind: 'sim' | 'id_card') => !!rows?.some((r) => r.kind === kind && r.status === 'requested');

  const submit = async () => {
    if (!form) return;
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl(base), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(form)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not send');
      setForm(null);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const cancel = async (q: Requisition) => {
    if (!(await confirmDialog(`Cancel your ${KIND_LABEL[q.kind]} request?`, { tone: 'danger' }))) return;
    try {
      const r = await fetch(apiUrl(`${base}/${q.id}/cancel`), { method: 'POST', headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not cancel');
      await load();
    } catch (e: any) {
      setError(e.message);
    }
  };

  if (rows === null) return <LoadingBlock />;
  if (joiner && !enabled && rows.length === 0) return null;

  const body = (
    <div className="space-y-3">
      {error && !form && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      {!hasEmployee ? (
        <p className="text-sm text-slate-600">Your login isn't linked to an Employee record yet — ask HR to link it, then you can ask for a SIM or an ID card here.</p>
      ) : (
        (enabled || !joiner) && (
          <div className="grid grid-cols-2 gap-2">
            {(['sim', 'id_card'] as const).map((k) => {
              const Icon = k === 'sim' ? Smartphone : CreditCard;
              return (
                <button
                  key={k}
                  type="button"
                  onClick={() => open(k)}
                  disabled={waiting(k)}
                  className="flex items-center gap-2 px-3 py-3 rounded-2xl bg-white border border-slate-200 hover:bg-slate-50 text-left disabled:opacity-50"
                >
                  <span className="w-9 h-9 rounded-full bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
                    <Icon className="w-4 h-4" />
                  </span>
                  <span className="min-w-0">
                    <span className="block text-sm font-semibold text-slate-800">Ask for {k === 'sim' ? 'a SIM' : 'an ID card'}</span>
                    <span className="block text-[11px] text-slate-500">{waiting(k) ? 'One is already waiting' : k === 'sim' ? 'Company SIM' : 'New, lost or damaged'}</span>
                  </span>
                </button>
              );
            })}
          </div>
        )
      )}

      {rows.length === 0 ? (
        <p className="text-xs text-slate-500">No requests yet.</p>
      ) : (
        <div className="rounded-2xl bg-white border border-slate-200 divide-y divide-slate-100">
          {rows.map((q) => (
            <div key={q.id} className="px-4 py-3 flex items-start gap-3">
              <span className="w-8 h-8 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center shrink-0 mt-0.5">
                {q.kind === 'sim' ? <Smartphone className="w-4 h-4" /> : <CreditCard className="w-4 h-4" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-800">
                    {KIND_LABEL[q.kind]} · {REASON_LABEL[q.reason] || q.reason}
                  </span>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusChip(q.status)}`}>{statusLabel(q.status)}</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">
                  Asked {shortDate(q.created_at)}
                  {q.operator ? ` · ${q.operator}` : ''}
                  {q.name_on_card ? ` · "${q.name_on_card}"` : ''}
                  {q.blood_group ? ` · ${q.blood_group}` : ''}
                </div>
                {q.note && <div className="text-xs text-slate-600 mt-1">{q.note}</div>}
                {q.status === 'issued' && (
                  <div className="text-xs text-emerald-700 mt-1">
                    {q.kind === 'sim' ? `SIM ${q.sim_number || ''}` : `Card ${q.card_number || ''}`} — issued {shortDate(q.decided_at)}
                    {q.decision_note ? ` · ${q.decision_note}` : ''}
                  </div>
                )}
                {q.status === 'rejected' && q.decision_note && <div className="text-xs text-rose-700 mt-1">HR: {q.decision_note}</div>}
              </div>
              {q.status === 'requested' && (
                <button type="button" onClick={() => void cancel(q)} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center text-slate-500" aria-label="Cancel request">
                  <X className="w-4 h-4" />
                </button>
              )}
            </div>
          ))}
        </div>
      )}

      {form && (
        <Popup
          title={form.kind === 'sim' ? 'Ask for a SIM' : 'Ask for an ID card'}
          icon={form.kind === 'sim' ? <Smartphone className="w-4 h-4" /> : <CreditCard className="w-4 h-4" />}
          size="md"
          onClose={busy ? () => {} : () => setForm(null)}
          footer={
            <>
              <button type="button" className={ghostBtn} onClick={() => setForm(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className={primaryBtn} onClick={() => void submit()} disabled={busy}>
                Send to HR
              </button>
            </>
          }
        >
          <div className="space-y-3 text-left">
            <div>
              <label className={labelCls}>Why</label>
              <div className="flex flex-wrap gap-1.5">
                {REASONS[form.kind].map((r) => (
                  <button
                    key={r}
                    type="button"
                    onClick={() => setForm({ ...form, reason: r })}
                    className={`text-xs font-semibold px-3 py-1.5 rounded-full border ${form.reason === r ? 'bg-slate-900 text-white border-slate-900' : 'bg-white text-slate-600 border-slate-200'}`}
                  >
                    {REASON_LABEL[r]}
                  </button>
                ))}
              </div>
            </div>
            {form.kind === 'sim' ? (
              <div>
                <label className={labelCls}>Operator you'd like (optional)</label>
                <select className={fieldCls} value={form.operator} onChange={(e) => setForm({ ...form, operator: e.target.value })}>
                  <option value="">No preference</option>
                  {OPERATORS.map((o) => (
                    <option key={o} value={o}>
                      {o}
                    </option>
                  ))}
                </select>
              </div>
            ) : (
              <div className="grid grid-cols-3 gap-2">
                <div className="col-span-2">
                  <label className={labelCls}>Name on the card</label>
                  <input className={fieldCls} value={form.name_on_card} maxLength={150} onChange={(e) => setForm({ ...form, name_on_card: e.target.value })} />
                </div>
                <div>
                  <label className={labelCls}>Blood group</label>
                  <select className={fieldCls} value={form.blood_group} onChange={(e) => setForm({ ...form, blood_group: e.target.value })}>
                    <option value="">—</option>
                    {BLOOD.map((b) => (
                      <option key={b} value={b}>
                        {b}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
            )}
            <div>
              <label className={labelCls}>{form.reason === 'new' ? 'Note (optional)' : 'What happened to the old one?'}</label>
              <textarea className={fieldCls} rows={3} maxLength={1000} value={form.note} onChange={(e) => setForm({ ...form, note: e.target.value })} />
            </div>
            {form.kind === 'id_card' && <p className="text-[11px] text-slate-500">HR uses the photo on your profile / documents for the card.</p>}
            {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
          </div>
        </Popup>
      )}
    </div>
  );
  return <>{wrap ? wrap(body) : body}</>;
};

/** Self Service -> SIM & ID Card (users.can_request_items). */
export const MyRequisitions: React.FC<{ token: string; userName?: string; onBack?: () => void }> = ({ token, userName, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8 max-w-2xl">
        {!isNativeApp && <ModulePath path={['Self Service', 'SIM & ID Card']} />}
        <div className="flex items-center gap-2 mb-4 mt-2">
          {onBack && (
            <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
              <ArrowLeft className="w-5 h-5 text-slate-500" />
            </button>
          )}
          <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
            <CreditCard className="w-5 h-5 text-violet-600 shrink-0" /> SIM & ID Card
          </h1>
        </div>
        <p className="text-xs text-slate-500 mb-3">Ask HR for a company SIM or an ID card. You'll get an alert when it's ready.</p>
        <RequisitionPanel token={token} defaultName={userName} />
      </div>
    </div>
  );
};
