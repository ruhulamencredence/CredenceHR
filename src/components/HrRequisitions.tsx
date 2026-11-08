/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> Requisitions (RequisitionRoutes.ts, layer "requisitions"):
// the SIM and ID card requests from employees and new joiners. Issue one
// (a SIM already given to the person in Mobile Bill, or the ID card number)
// or turn it down with a reason. A new joiner's request is issued after
// their onboarding is approved.

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { CreditCard, Smartphone, Check, X, Search } from 'lucide-react';
import { MailPopup as Popup, primaryBtn, ghostBtn } from './mail/MailPopup';
import { LoadingBlock } from './LoadingBlock';
import { apiUrl } from '../lib/api';
import { KIND_LABEL, REASON_LABEL, Requisition, shortDate, statusChip, statusLabel } from './MyRequisitions';

interface HrRequisition extends Requisition {
  person: string;
  employee_row_id: number | null;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  joiner: boolean;
  application_status: string | null;
  decided_by_name: string | null;
  person_sims: { id: number; phone_number: string; operator: string }[];
}

const fieldCls = 'block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none';
const labelCls = 'block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1';

export const HrRequisitions: React.FC<{ token: string }> = ({ token }) => {
  const [rows, setRows] = useState<HrRequisition[] | null>(null);
  const [error, setError] = useState('');
  const [filter, setFilter] = useState<'requested' | 'all'>('requested');
  const [q, setQ] = useState('');
  const [acting, setActing] = useState<{ row: HrRequisition; mode: 'issue' | 'reject' } | null>(null);
  const [simId, setSimId] = useState('');
  const [card, setCard] = useState('');
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const [popupError, setPopupError] = useState('');

  const load = useCallback(async () => {
    try {
      const r = await fetch(apiUrl('/api/hr-ops/requisitions'), { headers: { Authorization: `Bearer ${token}` } });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not load');
      setRows(Array.isArray(d) ? d : []);
    } catch (e: any) {
      setError(e.message);
      setRows([]);
    }
  }, [token]);
  useEffect(() => {
    void load();
  }, [load]);

  const shown = useMemo(() => {
    const t = q.trim().toLowerCase();
    return (rows || []).filter(
      (r) =>
        (filter === 'all' || r.status === 'requested') &&
        (!t || [r.person, r.employee_code, r.department, r.designation].some((v) => String(v || '').toLowerCase().includes(t)))
    );
  }, [rows, filter, q]);
  const waiting = (rows || []).filter((r) => r.status === 'requested').length;

  const start = (row: HrRequisition, mode: 'issue' | 'reject') => {
    setActing({ row, mode });
    setSimId(row.person_sims.length === 1 ? String(row.person_sims[0].id) : '');
    setCard('');
    setNote('');
    setPopupError('');
  };
  const send = async () => {
    if (!acting) return;
    setBusy(true);
    setPopupError('');
    try {
      const body = acting.mode === 'reject' ? { note } : acting.row.kind === 'sim' ? { sim_id: Number(simId), note } : { card_number: card, note };
      const r = await fetch(apiUrl(`/api/hr-ops/requisitions/${acting.row.id}/${acting.mode}`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not save');
      setActing(null);
      await load();
    } catch (e: any) {
      setPopupError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const openMobileBill = () => window.dispatchEvent(new CustomEvent('credence:open-admin-module', { detail: 'mobile_bill' }));

  if (rows === null) return <LoadingBlock />;
  return (
    <div className="space-y-4">
      <div className="flex flex-col sm:flex-row sm:items-center gap-2">
        <p className="text-xs text-slate-500 flex-1">
          SIM and ID card requests from employees (Self Service) and new joiners (My Onboarding). {waiting ? <b className="text-amber-700">{waiting} waiting.</b> : 'Nothing waiting.'}
        </p>
        <div className="relative">
          <Search className="w-3.5 h-3.5 text-slate-400 absolute left-2.5 top-1/2 -translate-y-1/2" />
          <input value={q} onChange={(e) => setQ(e.target.value)} placeholder="Name, ID, department…" className="pl-8 pr-3 py-2 bg-slate-50 border border-slate-200 rounded-xl text-xs w-full sm:w-52" />
        </div>
        <div className="flex rounded-xl border border-slate-200 overflow-hidden text-xs font-semibold">
          {(['requested', 'all'] as const).map((f) => (
            <button key={f} type="button" onClick={() => setFilter(f)} className={`px-3 py-2 ${filter === f ? 'bg-slate-900 text-white' : 'bg-white text-slate-600'}`}>
              {f === 'requested' ? 'Waiting' : 'All'}
            </button>
          ))}
        </div>
      </div>
      {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}

      {shown.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-8 text-center text-sm text-slate-500">{filter === 'requested' ? 'No requests waiting.' : 'No requests yet.'}</div>
      ) : (
        <div className="rounded-2xl border border-slate-200 bg-white divide-y divide-slate-100">
          {shown.map((r) => (
            <div key={r.id} className="px-4 py-3 flex flex-col sm:flex-row sm:items-start gap-3">
              <span className="w-9 h-9 rounded-full bg-slate-100 text-slate-500 flex items-center justify-center shrink-0">
                {r.kind === 'sim' ? <Smartphone className="w-4 h-4" /> : <CreditCard className="w-4 h-4" />}
              </span>
              <div className="flex-1 min-w-0">
                <div className="flex items-center gap-2 flex-wrap">
                  <span className="text-sm font-semibold text-slate-800">{r.person}</span>
                  {r.employee_code && <span className="text-[11px] font-mono text-slate-500">{r.employee_code}</span>}
                  {r.joiner && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-sky-50 text-sky-700 border border-sky-200">New joiner</span>}
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${statusChip(r.status)}`}>{statusLabel(r.status)}</span>
                </div>
                <div className="text-[11px] text-slate-500 mt-0.5">{[r.designation, r.department].filter(Boolean).join(' · ') || '—'}</div>
                <div className="text-xs text-slate-700 mt-1">
                  <b>{KIND_LABEL[r.kind]}</b> · {REASON_LABEL[r.reason] || r.reason} · asked {shortDate(r.created_at)}
                  {r.operator ? ` · prefers ${r.operator}` : ''}
                  {r.name_on_card ? ` · name on card "${r.name_on_card}"` : ''}
                  {r.blood_group ? ` · ${r.blood_group}` : ''}
                </div>
                {r.note && <div className="text-xs text-slate-500 mt-0.5">"{r.note}"</div>}
                {r.status === 'issued' && (
                  <div className="text-xs text-emerald-700 mt-1">
                    {r.kind === 'sim' ? `SIM ${r.sim_number || ''}` : `Card ${r.card_number || ''}`} — {shortDate(r.decided_at)}
                    {r.decided_by_name ? ` by ${r.decided_by_name}` : ''}
                  </div>
                )}
                {r.status === 'rejected' && <div className="text-xs text-rose-700 mt-1">Turned down: {r.decision_note}</div>}
                {r.status === 'requested' && r.joiner && (
                  <div className="text-[11px] text-sky-700 mt-1">Onboarding {r.application_status || ''} — approve it first, then issue this.</div>
                )}
              </div>
              {r.status === 'requested' && (
                <div className="flex gap-2 shrink-0">
                  <button type="button" onClick={() => start(r, 'reject')} className="flex items-center gap-1 px-3 py-1.5 rounded-lg border border-slate-200 text-xs font-semibold text-rose-600 hover:bg-rose-50">
                    <X className="w-3.5 h-3.5" /> Turn down
                  </button>
                  <button
                    type="button"
                    onClick={() => start(r, 'issue')}
                    disabled={r.joiner}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 disabled:opacity-40"
                  >
                    <Check className="w-3.5 h-3.5" /> Issue
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {acting && (
        <Popup
          title={acting.mode === 'reject' ? `Turn down ${KIND_LABEL[acting.row.kind]} request` : `Issue ${KIND_LABEL[acting.row.kind]}`}
          icon={acting.row.kind === 'sim' ? <Smartphone className="w-4 h-4" /> : <CreditCard className="w-4 h-4" />}
          size="md"
          onClose={busy ? () => {} : () => setActing(null)}
          footer={
            <>
              <button type="button" className={ghostBtn} onClick={() => setActing(null)} disabled={busy}>
                Cancel
              </button>
              <button type="button" className={primaryBtn} onClick={() => void send()} disabled={busy}>
                {acting.mode === 'reject' ? 'Turn down' : 'Issue'}
              </button>
            </>
          }
        >
          <div className="space-y-3 text-left">
            <p className="text-sm text-slate-700">
              {acting.row.person}
              {acting.row.employee_code ? ` (${acting.row.employee_code})` : ''}
            </p>
            {acting.mode === 'issue' && acting.row.kind === 'sim' && (
              <div>
                <label className={labelCls}>SIM</label>
                {acting.row.person_sims.length === 0 ? (
                  <div className="liquid-glass-inset rounded-2xl p-3 text-xs text-slate-600">
                    No SIM is given to this employee in Mobile Bill yet. Add the SIM there (with this employee), then come back and issue it.
                    <button type="button" onClick={openMobileBill} className="block mt-2 text-xs font-semibold text-blue-700 underline">
                      Open Mobile Bill
                    </button>
                  </div>
                ) : (
                  <select className={fieldCls} value={simId} onChange={(e) => setSimId(e.target.value)}>
                    <option value="">— Pick the SIM —</option>
                    {acting.row.person_sims.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.phone_number} ({s.operator})
                      </option>
                    ))}
                  </select>
                )}
              </div>
            )}
            {acting.mode === 'issue' && acting.row.kind === 'id_card' && (
              <div>
                <label className={labelCls}>ID card number</label>
                <input className={fieldCls} value={card} maxLength={60} onChange={(e) => setCard(e.target.value)} placeholder="e.g. CHL-ID-0201" />
                <p className="text-[11px] text-slate-500 mt-1">Their onboarding checklist's "ID card issued" is ticked with this number.</p>
              </div>
            )}
            <div>
              <label className={labelCls}>{acting.mode === 'reject' ? 'Why (they see this)' : 'Note to them (optional)'}</label>
              <textarea className={fieldCls} rows={3} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} placeholder={acting.mode === 'issue' ? 'e.g. Collect it from the HR desk' : ''} />
            </div>
            {popupError && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{popupError}</div>}
          </div>
        </Popup>
      )}
    </div>
  );
};
