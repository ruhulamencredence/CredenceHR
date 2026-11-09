// Admin Panel -> Users -> Photo approvals (Superadmin only, profileRoutes.ts):
// new profile photos people uploaded, waiting for the Superadmin. Each shows
// the current photo beside the new one; Approve puts the new one up, Reject
// (with a reason) keeps the old one. A "New Profile Photo to Approve" alert
// opens this too.
import React, { useCallback, useEffect, useState } from 'react';
import { Check, ImageIcon, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { MailPopup as Popup, inputCls, ghostBtn } from './mail/MailPopup';
import { LoadingBlock } from './LoadingBlock';
import { Spinner } from './Spinner';
import { PHOTO_REJECT_REASONS } from './PhotoRulesSheet';

interface PhotoRequest {
  id: number;
  user_id: number;
  name: string;
  email: string | null;
  employee_code: string | null;
  designation: string | null;
  department: string | null;
  has_current: boolean;
  created_at: string;
}

// An image the API serves only with the account's token.
const AuthImage: React.FC<{ token: string; src: string; alt: string }> = ({ token, src, alt }) => {
  const [url, setUrl] = useState<string | null>(null);
  const [none, setNone] = useState(false);
  useEffect(() => {
    let gone = false;
    let made: string | null = null;
    fetch(apiUrl(src), { headers: { Authorization: `Bearer ${token}` }, cache: 'no-store' })
      .then(async (r) => {
        if (!r.ok || r.status === 204) throw new Error('none');
        made = URL.createObjectURL(await r.blob());
        if (!gone) setUrl(made);
      })
      .catch(() => !gone && setNone(true));
    return () => {
      gone = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [token, src]);
  return (
    <div className="liquid-glass-inset w-28 h-28 rounded-full overflow-hidden flex items-center justify-center">
      {url ? <img src={url} alt={alt} className="w-full h-full object-cover" /> : none ? <ImageIcon className="w-7 h-7 text-slate-300" /> : <Spinner size={16} />}
    </div>
  );
};

export const ProfilePhotoRequestsPopup: React.FC<{ token: string; onClose: () => void; onChanged?: (pending: number) => void }> = ({ token, onClose, onChanged }) => {
  const [rows, setRows] = useState<PhotoRequest[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState<number | null>(null);
  const [rejecting, setRejecting] = useState<number | null>(null);
  const [reason, setReason] = useState('');

  const load = useCallback(() => {
    fetch(apiUrl('/api/profile/photo-requests'), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (r) => {
        const d = await r.json().catch(() => null);
        if (!r.ok) throw new Error(d?.error || 'Could not load the photo requests.');
        setRows(d);
        onChanged?.(d.length);
      })
      .catch((e) => {
        setRows([]);
        setError(e.message);
      });
  }, [token, onChanged]);
  useEffect(load, [load]);

  const decide = async (id: number, decision: 'approve' | 'reject') => {
    if (decision === 'reject' && reason.trim().length < 3) return setError('Write why the photo is rejected (at least 3 letters).');
    setBusy(id);
    setError('');
    try {
      const r = await fetch(apiUrl(`/api/profile/photo-requests/${id}/${decision}`), {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(decision === 'reject' ? { reason: reason.trim() } : {})
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || 'Could not save the decision.');
      setRejecting(null);
      setReason('');
      load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(null);
    }
  };

  return (
    <Popup title="Profile photo approvals" icon={<ImageIcon className="w-4 h-4 text-violet-600" />} onClose={onClose} size="lg">
      <p className="text-xs text-slate-500 mb-3">A new profile photo shows only after you approve it; until then the person keeps their current photo.</p>
      {error && <p className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700 mb-3">{error}</p>}
      {!rows ? (
        <LoadingBlock />
      ) : rows.length === 0 ? (
        <p className="text-sm text-slate-500 text-center py-10">No new photos waiting.</p>
      ) : (
        <div className="space-y-3">
          {rows.map((r) => (
            <div key={r.id} className="liquid-glass-inset rounded-3xl p-4">
              <div className="flex flex-wrap items-start justify-between gap-2">
                <div className="min-w-0">
                  <p className="text-sm font-bold text-slate-900">{r.name}</p>
                  <p className="text-[11px] text-slate-500">{[r.employee_code, r.designation, r.department].filter(Boolean).join(' · ') || r.email}</p>
                </div>
                <p className="text-[11px] text-slate-400">Sent {new Date(r.created_at).toLocaleString('en-GB', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' })}</p>
              </div>
              <div className="flex items-center justify-center gap-6 sm:gap-10 my-3">
                <div className="flex flex-col items-center gap-1.5">
                  <AuthImage token={token} src={`/api/profile/photo/${r.user_id}`} alt={`${r.name} — current photo`} />
                  <span className="text-[11px] text-slate-500">{r.has_current ? 'Current' : 'No photo now'}</span>
                </div>
                <span className="text-slate-300 text-xl">→</span>
                <div className="flex flex-col items-center gap-1.5">
                  <AuthImage token={token} src={`/api/profile/photo-requests/${r.id}/image`} alt={`${r.name} — new photo`} />
                  <span className="text-[11px] font-semibold text-violet-700">New</span>
                </div>
              </div>
              {rejecting === r.id ? (
                <div className="flex flex-wrap items-center gap-2">
                  {/* One tap: the same rules the person saw before picking the photo (PhotoRulesSheet). */}
                  <div className="w-full flex flex-wrap gap-1.5">
                    {PHOTO_REJECT_REASONS.map((x) => (
                      <button
                        key={x.title}
                        type="button"
                        onClick={() => setReason(x.why)}
                        aria-pressed={reason === x.why}
                        className={`rounded-full px-2.5 py-1 text-[11px] font-semibold border ${reason === x.why ? 'bg-rose-600 text-white border-rose-600' : 'bg-rose-50 text-rose-800 border-rose-200 hover:bg-rose-100'}`}
                      >
                        {x.title}
                      </button>
                    ))}
                  </div>
                  <label htmlFor={`pr-reason-${r.id}`} className="sr-only">Reason</label>
                  <input
                    id={`pr-reason-${r.id}`}
                    autoFocus
                    value={reason}
                    onChange={(e) => setReason(e.target.value)}
                    placeholder="Why? e.g. face not clear, not a formal photo"
                    className={`${inputCls} flex-1 min-w-[200px]`}
                  />
                  <button type="button" className={ghostBtn} onClick={() => { setRejecting(null); setReason(''); }}>
                    Back
                  </button>
                  <button type="button" disabled={busy === r.id} onClick={() => void decide(r.id, 'reject')} className="rounded-full px-4 py-2 text-sm font-semibold text-white bg-rose-600 hover:bg-rose-700 disabled:opacity-60 inline-flex items-center gap-1.5">
                    {busy === r.id ? <Spinner size={14} className="text-white" /> : <X className="w-4 h-4" />} Reject
                  </button>
                </div>
              ) : (
                <div className="flex justify-end gap-2">
                  <button type="button" disabled={busy === r.id} onClick={() => { setRejecting(r.id); setReason(''); setError(''); }} className="rounded-full px-4 py-2 text-sm font-semibold text-rose-700 border border-rose-200 bg-white hover:bg-rose-50 disabled:opacity-60">
                    Reject…
                  </button>
                  <button type="button" disabled={busy === r.id} onClick={() => void decide(r.id, 'approve')} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-60">
                    {busy === r.id ? <Spinner size={14} /> : <Check className="w-4 h-4" />} Approve
                  </button>
                </div>
              )}
            </div>
          ))}
        </div>
      )}
    </Popup>
  );
};
