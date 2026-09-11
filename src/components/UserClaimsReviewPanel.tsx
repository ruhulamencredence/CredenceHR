/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useState } from 'react';
import { Inbox, Check, X, Paperclip, ChevronDown, ChevronUp, Pencil, Trash2, Save, MapPin, Clock } from 'lucide-react';
import { UserClaim, UserClaimCategory, USER_CLAIM_CATEGORIES, UserClaimReference, ClaimRecord } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { UserClaimStatusBadge } from './UserClaimStatusBadge';
import ClaimLocationMap from './ClaimLocationMap';
import { Spinner } from './Spinner';

interface UserClaimsReviewPanelProps {
  token: string;
}

// Admin Panel -> Conveyance Bill Claim -> "User Claims" (source: user_claim) —
// direct User-submitted claims (ConveyanceClaimCard on the User Panel), separate
// from the Bills table below it which is built from completed Movement Claims /
// manual entries. This panel is READ-ONLY on status: it only shows where each
// claim stands (Pending/Approved/Rejected, and which step of the Approval Chain
// it's waiting on). The actual Approve/Reject action happens from the Admin
// Panel -> Approvals tab, same as Remote Attendance/Movement Claims — a Pending
// claim only shows Approve/Reject buttons HERE when it has no Approval Request
// tracking it at all (a claim submitted back when no Chain was configured yet).
export const UserClaimsReviewPanel: React.FC<UserClaimsReviewPanelProps> = ({ token }) => {
  const authHeaders = { Authorization: `Bearer ${token}` };
  const [claims, setClaims] = useState<UserClaim[]>([]);
  const [loading, setLoading] = useState(true);
  const [statusFilter, setStatusFilter] = useState<'pending' | 'all'>('pending');
  const [expanded, setExpanded] = useState(true);
  const [actingId, setActingId] = useState<number | null>(null);
  const [remarksDraft, setRemarksDraft] = useState<Record<number, string>>({});
  const [error, setError] = useState('');

  // Inline "Edit" — Admin corrections to a claim's core fields. Only pre-fills
  // when opened, so it always starts from the latest fetched values.
  const [editingId, setEditingId] = useState<number | null>(null);
  const [editDraft, setEditDraft] = useState<{
    claim_date: string;
    from_date: string;
    to_date: string;
    category: UserClaimCategory;
    amount: string;
    description: string;
  } | null>(null);
  const [savingEdit, setSavingEdit] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);
  // The referenced Movement Claim currently shown on the read-only location map
  // (opened by tapping a claim_refs row) — reuses the same ClaimLocationMap the
  // User's own My Claims history uses, shaped from the reference's own fields
  // (which already carry lat/lng + approval status, see attachUserClaimRefs).
  const [viewingRef, setViewingRef] = useState<{ ref: UserClaimReference; userId: number; userName?: string | null } | null>(null);

  const refToClaimRecord = (ref: UserClaimReference, userId: number, userName?: string | null): ClaimRecord => ({
    id: ref.claim_id,
    user_id: userId,
    user_name: userName,
    purpose: ref.purpose,
    status: ref.check_out_at ? 'completed' : 'open',
    check_in_at: ref.check_in_at,
    check_in_lat: Number(ref.check_in_lat),
    check_in_lng: Number(ref.check_in_lng),
    check_out_at: ref.check_out_at,
    check_out_lat: ref.check_out_lat != null ? Number(ref.check_out_lat) : null,
    check_out_lng: ref.check_out_lng != null ? Number(ref.check_out_lng) : null,
    distance_km: ref.distance_km,
    check_in_approval: ref.check_in_approval,
    check_out_approval: ref.check_out_approval
  });

  const fetchClaims = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (statusFilter === 'pending') params.set('status', 'pending');
      const res = await fetch(apiUrl(`/api/user-claims?${params.toString()}`), { headers: authHeaders });
      if (res.ok) setClaims(await res.json());
    } catch (err) {
      console.error('Failed to load user claims', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClaims();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [statusFilter]);

  // Legacy-only path: a Pending claim with NO Approval Request tracking it (it
  // was submitted before an Approval Chain existed). Everything submitted after
  // a Chain was configured always carries `approval` and is acted on from the
  // Approvals tab instead — see handleDecision below.
  const handleDecision = async (claim: UserClaim, action: 'approve' | 'reject') => {
    const remarks = (remarksDraft[claim.id] || '').trim();
    if (action === 'reject' && !remarks) {
      setError('Add a remark so the User understands why this was rejected.');
      return;
    }
    setActingId(claim.id);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/user-claims/${claim.id}/decision`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ action, remarks: remarks || undefined })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to record the decision');
      setClaims((prev) => prev.filter((c) => c.id !== claim.id));
    } catch (err: any) {
      setError(err.message || 'Failed to record the decision');
    } finally {
      setActingId(null);
    }
  };

  const startEdit = (claim: UserClaim) => {
    setError('');
    setEditingId(claim.id);
    setEditDraft({
      claim_date: String(claim.claim_date).slice(0, 10),
      from_date: String(claim.from_date).slice(0, 10),
      to_date: String(claim.to_date).slice(0, 10),
      category: claim.category,
      amount: String(claim.amount),
      description: claim.description || ''
    });
  };

  const cancelEdit = () => {
    setEditingId(null);
    setEditDraft(null);
  };

  const saveEdit = async (claim: UserClaim) => {
    if (!editDraft) return;
    if (String(editDraft.to_date) < String(editDraft.from_date)) {
      setError("To Date can't be before From Date.");
      return;
    }
    const hasRefs = !!claim.claim_refs && claim.claim_refs.length > 0;
    if (!hasRefs && (!editDraft.amount || Number(editDraft.amount) <= 0)) {
      setError('Claim Amount must be a positive number.');
      return;
    }
    setSavingEdit(true);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/user-claims/${claim.id}`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({
          claim_date: editDraft.claim_date,
          from_date: editDraft.from_date,
          to_date: editDraft.to_date,
          category: editDraft.category,
          amount: hasRefs ? undefined : Number(editDraft.amount),
          description: editDraft.description.trim() || undefined
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update claim');
      cancelEdit();
      await fetchClaims();
    } catch (err: any) {
      setError(err.message || 'Failed to update claim');
    } finally {
      setSavingEdit(false);
    }
  };

  const handleDelete = async (claim: UserClaim) => {
    if (!confirm(`Delete this ${claim.category} claim from ${claim.user_name || 'this user'}? This cannot be undone.`)) return;
    setDeletingId(claim.id);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/user-claims/${claim.id}`), { method: 'DELETE', headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to delete claim');
      setClaims((prev) => prev.filter((c) => c.id !== claim.id));
    } catch (err: any) {
      setError(err.message || 'Failed to delete claim');
    } finally {
      setDeletingId(null);
    }
  };

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        className="w-full flex items-center justify-between px-6 py-4 border-b border-slate-200"
      >
        <div className="flex items-center gap-2.5">
          <span className="text-sm font-bold text-slate-900">User Claims</span>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700 border border-amber-200">
            {claims.filter((c) => c.status === 'pending').length} pending
          </span>
        </div>
        {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
      </button>

      {expanded && (
        <>
          <div className="flex items-center gap-2 px-6 pt-4">
            <button
              type="button"
              onClick={() => setStatusFilter('pending')}
              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                statusFilter === 'pending' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              Pending
            </button>
            <button
              type="button"
              onClick={() => setStatusFilter('all')}
              className={`text-xs px-3 py-1.5 rounded-lg font-medium transition-colors ${
                statusFilter === 'all' ? 'bg-blue-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
              }`}
            >
              All
            </button>
          </div>

          {error && <p className="mx-6 mt-3 text-xs px-3 py-2 rounded-lg bg-rose-50 text-rose-700">{error}</p>}

          {loading ? (
            <p className="text-xs text-slate-400 text-center py-10">Loading claims...</p>
          ) : claims.length === 0 ? (
            <div className="text-center text-xs text-slate-400 py-10 flex flex-col items-center gap-2">
              <Inbox className="w-5 h-5 text-slate-300" />
              {statusFilter === 'pending' ? 'No claims awaiting review.' : 'No User Claims yet.'}
            </div>
          ) : (
            <div className="divide-y divide-slate-100 mt-3">
              {claims.map((c) => (
                <div key={c.id} className="px-6 py-4">
                  <div className="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <div className="flex items-center gap-2 text-sm font-semibold text-slate-900">
                        {c.user_name} <span className="text-slate-300">&middot;</span> {c.category}
                        {c.has_file && <Paperclip className="w-3 h-3 text-slate-400" />}
                      </div>
                      {editingId !== c.id && (
                        <div className="text-xs text-slate-500 mt-0.5">
                          {formatDate(c.claim_date)}
                          {String(c.from_date) !== String(c.to_date) && (
                            <span> (covers {formatDate(c.from_date)} \u2192 {formatDate(c.to_date)})</span>
                          )}
                          {' \u00b7 '}৳{Number(c.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                        </div>
                      )}
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      {editingId !== c.id && (
                        <>
                          <button
                            type="button"
                            onClick={() => startEdit(c)}
                            title="Edit this claim"
                            className="p-1.5 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                          >
                            <Pencil className="w-3.5 h-3.5" />
                          </button>
                          <button
                            type="button"
                            onClick={() => handleDelete(c)}
                            disabled={deletingId === c.id}
                            title="Delete this claim"
                            className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                          >
                            {deletingId === c.id ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />}
                          </button>
                        </>
                      )}
                      <UserClaimStatusBadge status={c.status} />
                    </div>
                  </div>

                  {editingId === c.id && editDraft ? (
                    <div className="mt-3 space-y-2 bg-slate-50 border border-slate-200 rounded-xl p-3">
                      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-500 mb-1">Claim Date</label>
                          <input
                            type="date"
                            value={editDraft.claim_date}
                            onChange={(e) => setEditDraft((d) => (d ? { ...d, claim_date: e.target.value } : d))}
                            className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-500 mb-1">From</label>
                          <input
                            type="date"
                            value={editDraft.from_date}
                            onChange={(e) => setEditDraft((d) => (d ? { ...d, from_date: e.target.value } : d))}
                            className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-500 mb-1">To</label>
                          <input
                            type="date"
                            value={editDraft.to_date}
                            onChange={(e) => setEditDraft((d) => (d ? { ...d, to_date: e.target.value } : d))}
                            className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                        </div>
                        <div>
                          <label className="block text-[10px] font-semibold text-slate-500 mb-1">Category</label>
                          <select
                            value={editDraft.category}
                            onChange={(e) => setEditDraft((d) => (d ? { ...d, category: e.target.value as UserClaimCategory } : d))}
                            className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          >
                            {USER_CLAIM_CATEGORIES.map((cat) => (
                              <option key={cat} value={cat}>{cat}</option>
                            ))}
                          </select>
                        </div>
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-500 mb-1">
                          Amount {c.claim_refs && c.claim_refs.length > 0 && '(derived from referenced check-in/outs — not editable)'}
                        </label>
                        <input
                          type="number"
                          step="0.01"
                          value={editDraft.amount}
                          disabled={!!c.claim_refs && c.claim_refs.length > 0}
                          onChange={(e) => setEditDraft((d) => (d ? { ...d, amount: e.target.value } : d))}
                          className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:opacity-60"
                        />
                      </div>
                      <div>
                        <label className="block text-[10px] font-semibold text-slate-500 mb-1">Description</label>
                        <textarea
                          value={editDraft.description}
                          onChange={(e) => setEditDraft((d) => (d ? { ...d, description: e.target.value } : d))}
                          rows={2}
                          className="w-full text-xs px-2 py-1.5 bg-white border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none resize-none"
                        />
                      </div>
                      <div className="flex gap-2 justify-end">
                        <button
                          type="button"
                          onClick={cancelEdit}
                          disabled={savingEdit}
                          className="text-xs px-3 py-1.5 rounded-lg border border-slate-200 text-slate-600 hover:bg-slate-100 font-medium disabled:opacity-50"
                        >
                          Cancel
                        </button>
                        <button
                          type="button"
                          onClick={() => saveEdit(c)}
                          disabled={savingEdit}
                          className="flex items-center gap-1 text-xs px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-semibold disabled:opacity-50 transition-colors"
                        >
                          {savingEdit ? <Spinner size={14} /> : <Save className="w-3.5 h-3.5" />}
                          Save
                        </button>
                      </div>
                    </div>
                  ) : (
                    <>
                      {c.description && <p className="text-xs text-slate-600 mt-1 max-w-md">{c.description}</p>}
                      {c.claim_refs && c.claim_refs.length > 0 && (
                        <div className="mt-1.5 space-y-1 max-w-md">
                          {c.claim_refs.map((r) => (
                            <button
                              key={r.claim_id}
                              type="button"
                              onClick={() => setViewingRef({ ref: r, userId: c.user_id, userName: c.user_name })}
                              title="View check-in/out location"
                              className="w-full flex items-center justify-between gap-2 text-[11px] px-2 py-1 bg-slate-50 hover:bg-blue-50 border border-slate-200 hover:border-blue-200 rounded-lg transition-colors text-left"
                            >
                              <span className="flex items-center gap-1 text-slate-600 min-w-0 truncate">
                                <MapPin className="w-3 h-3 text-blue-500 shrink-0" />
                                {formatDate(r.check_in_at)} &middot; {r.purpose}
                              </span>
                              <span className="shrink-0 font-semibold text-slate-800">
                                ৳{Number(r.amount).toLocaleString('en-BD', { minimumFractionDigits: 2 })}
                              </span>
                            </button>
                          ))}
                        </div>
                      )}
                      {c.has_file && (
                        <a
                          href={apiUrl(`/api/user-claims/${c.id}/file`)}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-[11px] text-blue-600 font-semibold mt-1 hover:underline"
                        >
                          <Paperclip className="w-3 h-3" /> View attachment
                        </a>
                      )}
                    </>
                  )}

                  {c.status === 'pending' && editingId !== c.id && (
                    <>
                      {c.approval ? (
                        <div className="mt-3 flex items-center gap-2 text-xs px-3 py-2 rounded-lg bg-amber-50 border border-amber-200 text-amber-700">
                          <Clock className="w-3.5 h-3.5 shrink-0" />
                          Waiting on Approval Workflow — step {c.approval.current_step} of {c.approval.total_steps}. Act on it from
                          the <span className="font-semibold">Approvals</span> tab.
                        </div>
                      ) : (
                        <div className="mt-3 flex flex-col sm:flex-row sm:items-center gap-2">
                          <input
                            type="text"
                            placeholder="Remarks (required to reject)"
                            value={remarksDraft[c.id] || ''}
                            onChange={(e) => setRemarksDraft((prev) => ({ ...prev, [c.id]: e.target.value }))}
                            className="flex-1 min-w-[160px] text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
                          />
                          <div className="flex gap-2">
                            <button
                              type="button"
                              disabled={actingId === c.id}
                              onClick={() => handleDecision(c, 'approve')}
                              className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white font-semibold disabled:opacity-50 transition-colors"
                            >
                              {actingId === c.id ? <Spinner size={14} /> : <Check className="w-3.5 h-3.5" />}
                              Approve
                            </button>
                            <button
                              type="button"
                              disabled={actingId === c.id}
                              onClick={() => handleDecision(c, 'reject')}
                              className="flex items-center gap-1 text-xs px-3 py-2 rounded-lg bg-rose-600 hover:bg-rose-700 text-white font-semibold disabled:opacity-50 transition-colors"
                            >
                              {actingId === c.id ? <Spinner size={14} /> : <X className="w-3.5 h-3.5" />}
                              Reject
                            </button>
                          </div>
                        </div>
                      )}
                    </>
                  )}

                  {c.status !== 'pending' && c.admin_remarks && (
                    <p className="text-xs text-slate-500 mt-2">
                      <span className="font-semibold text-slate-600">Remarks:</span> {c.admin_remarks}
                    </p>
                  )}
                  {c.status === 'approved' && c.bill_id && (
                    <p className="text-[11px] text-slate-400 mt-1">Attached to Bill #{c.bill_id}.</p>
                  )}
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {viewingRef && (
        <ClaimLocationMap
          claim={refToClaimRecord(viewingRef.ref, viewingRef.userId, viewingRef.userName)}
          onClose={() => setViewingRef(null)}
        />
      )}
    </div>
  );
};