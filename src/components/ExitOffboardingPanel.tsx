import React, { useEffect, useState } from 'react';
import { LogOut, Plus, X, CheckCircle2, AlertTriangle, ChevronDown, ChevronUp, Save, Ban } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface ExitOffboardingPanelProps {
  token: string;
}

interface ClearanceItem {
  id: number;
  department: string;
  item_label: string;
  is_cleared: boolean;
  remarks: string | null;
}

interface Settlement {
  id: number;
  unused_leave_days: number;
  unused_leave_encashment: number;
  gratuity_amount: number;
  outstanding_dues: number;
  other_additions: number;
  other_deductions: number;
  net_payable: number;
  notes: string | null;
  status: 'draft' | 'approved' | 'paid';
}

interface ExitRequest {
  id: number;
  user_id: number;
  user_name: string | null;
  user_email: string | null;
  exit_type: 'resignation' | 'termination';
  reason: string | null;
  notice_date: string | null;
  last_working_day: string | null;
  status: 'pending' | 'clearance' | 'settled' | 'cancelled';
  requested_by_name: string | null;
  created_at: string;
  clearance_items: ClearanceItem[];
  settlement: Settlement | null;
}

const STATUS_STYLE: Record<string, string> = {
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  clearance: 'bg-blue-50 text-blue-700 border-blue-200',
  settled: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200'
};

// Admin Panel -> HR Advanced -> "Exit / Offboarding" — one place to raise a
// resignation/termination, walk it through a department clearance checklist
// (IT/Finance/Admin/HR, auto-seeded per request), and prepare + settle the
// Full & Final Settlement. Management-only view for now (reachable only once
// the 'exit_offboarding' module is granted, same gate as every other Admin
// Panel tab) — an employee-facing "submit my own resignation" self-service
// page can be layered on later against the same POST /api/exit-requests,
// which already allows a plain account to submit for themselves.
export const ExitOffboardingPanel: React.FC<ExitOffboardingPanelProps> = ({ token }) => {
  const [requests, setRequests] = useState<ExitRequest[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string; role: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [expandedId, setExpandedId] = useState<number | null>(null);

  const [showNew, setShowNew] = useState(false);
  const [newUserId, setNewUserId] = useState('');
  const [newExitType, setNewExitType] = useState<'resignation' | 'termination'>('resignation');
  const [newReason, setNewReason] = useState('');
  const [newNoticeDate, setNewNoticeDate] = useState('');
  const [newLastDay, setNewLastDay] = useState('');
  const [creating, setCreating] = useState(false);

  const [settlementDrafts, setSettlementDrafts] = useState<Record<number, Record<string, string>>>({});
  const [savingSettlementId, setSavingSettlementId] = useState<number | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const fetchAll = async () => {
    setLoading(true);
    setError('');
    try {
      const [reqRes, usersRes] = await Promise.all([
        fetch(apiUrl('/api/exit-requests'), { headers: authHeaders }),
        fetch(apiUrl('/api/users'), { headers: authHeaders })
      ]);
      const reqData = await reqRes.json();
      if (!reqRes.ok) throw new Error(reqData.error || 'Failed to load exit requests');
      setRequests(Array.isArray(reqData) ? reqData : []);
      const usersData = await usersRes.json();
      if (usersRes.ok) setUsers(Array.isArray(usersData) ? usersData.filter((u: any) => u.role !== 'superadmin') : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load exit requests');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const createRequest = async () => {
    if (!newUserId) {
      setError('Select an employee.');
      return;
    }
    setCreating(true);
    setError('');
    try {
      const res = await fetch(apiUrl('/api/exit-requests'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          user_id: Number(newUserId),
          exit_type: newExitType,
          reason: newReason,
          notice_date: newNoticeDate || null,
          last_working_day: newLastDay || null
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create exit request');
      setRequests((prev) => [data, ...prev]);
      setShowNew(false);
      setNewUserId('');
      setNewReason('');
      setNewNoticeDate('');
      setNewLastDay('');
    } catch (err: any) {
      setError(err.message || 'Failed to create exit request');
    } finally {
      setCreating(false);
    }
  };

  const changeStatus = async (id: number, status: string) => {
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/exit-requests/${id}/status`), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ status })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update status');
      setRequests((prev) => prev.map((r) => (r.id === id ? data : r)));
    } catch (err: any) {
      setError(err.message || 'Failed to update status');
    }
  };

  const toggleClearance = async (exitId: number, item: ClearanceItem) => {
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/exit-clearance-items/${item.id}`), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ is_cleared: !item.is_cleared })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update clearance item');
      setRequests((prev) =>
        prev.map((r) =>
          r.id === exitId ? { ...r, clearance_items: r.clearance_items.map((ci) => (ci.id === item.id ? data : ci)) } : r
        )
      );
    } catch (err: any) {
      setError(err.message || 'Failed to update clearance item');
    }
  };

  const openSettlement = async (exitId: number) => {
    if (settlementDrafts[exitId]) return;
    try {
      const res = await fetch(apiUrl(`/api/exit-requests/${exitId}/settlement`), { headers: authHeaders });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load settlement');
      setRequests((prev) => prev.map((r) => (r.id === exitId ? { ...r, settlement: data } : r)));
      setSettlementDrafts((prev) => ({
        ...prev,
        [exitId]: {
          unused_leave_days: String(data.unused_leave_days),
          unused_leave_encashment: String(data.unused_leave_encashment),
          gratuity_amount: String(data.gratuity_amount),
          outstanding_dues: String(data.outstanding_dues),
          other_additions: String(data.other_additions),
          other_deductions: String(data.other_deductions),
          notes: data.notes || ''
        }
      }));
    } catch (err: any) {
      setError(err.message || 'Failed to load settlement');
    }
  };

  const saveSettlement = async (exitId: number, markStatus?: 'approved' | 'paid') => {
    const draft = settlementDrafts[exitId];
    if (!draft) return;
    setSavingSettlementId(exitId);
    setError('');
    try {
      const res = await fetch(apiUrl(`/api/exit-requests/${exitId}/settlement`), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          unused_leave_days: Number(draft.unused_leave_days) || 0,
          unused_leave_encashment: Number(draft.unused_leave_encashment) || 0,
          gratuity_amount: Number(draft.gratuity_amount) || 0,
          outstanding_dues: Number(draft.outstanding_dues) || 0,
          other_additions: Number(draft.other_additions) || 0,
          other_deductions: Number(draft.other_deductions) || 0,
          notes: draft.notes,
          status: markStatus || 'draft'
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save settlement');
      setRequests((prev) => prev.map((r) => (r.id === exitId ? { ...r, settlement: data, status: markStatus === 'paid' ? 'settled' : r.status } : r)));
    } catch (err: any) {
      setError(err.message || 'Failed to save settlement');
    } finally {
      setSavingSettlementId(null);
    }
  };

  const netPayablePreview = (exitId: number) => {
    const d = settlementDrafts[exitId];
    if (!d) return 0;
    return (
      (Number(d.unused_leave_encashment) || 0) +
      (Number(d.gratuity_amount) || 0) +
      (Number(d.other_additions) || 0) -
      (Number(d.outstanding_dues) || 0) -
      (Number(d.other_deductions) || 0)
    );
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <LogOut className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Exit / Offboarding</h1>
            <p className="text-xs text-slate-500 mt-0.5 max-w-md">
              Raise a resignation or termination, track department clearance, and settle the Full &amp; Final payout.
            </p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowNew((v) => !v)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> New Exit Request
        </button>
      </div>

      {showNew && (
        <div className="px-6 py-5 border-b border-slate-200 bg-slate-50/60">
          <div className="flex flex-wrap items-end gap-3">
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 mb-1">Employee</label>
              <select
                value={newUserId}
                onChange={(e) => setNewUserId(e.target.value)}
                className="w-52 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="">Select…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 mb-1">Type</label>
              <select
                value={newExitType}
                onChange={(e) => setNewExitType(e.target.value as 'resignation' | 'termination')}
                className="w-36 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              >
                <option value="resignation">Resignation</option>
                <option value="termination">Termination</option>
              </select>
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 mb-1">Notice Date</label>
              <input
                type="date"
                value={newNoticeDate}
                onChange={(e) => setNewNoticeDate(e.target.value)}
                className="px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-[10px] font-semibold text-slate-500 mb-1">Last Working Day</label>
              <input
                type="date"
                value={newLastDay}
                onChange={(e) => setNewLastDay(e.target.value)}
                className="px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div className="flex-1 min-w-[200px]">
              <label className="block text-[10px] font-semibold text-slate-500 mb-1">Reason</label>
              <input
                type="text"
                value={newReason}
                onChange={(e) => setNewReason(e.target.value)}
                placeholder="Optional"
                className="w-full px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              type="button"
              onClick={createRequest}
              disabled={creating}
              className="flex items-center gap-1.5 px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-xl transition-colors disabled:opacity-50"
            >
              {creating && <Spinner size={12} />}
              {creating ? 'Creating…' : 'Create'}
            </button>
            <button type="button" onClick={() => setShowNew(false)} className="px-2.5 py-2 text-slate-400 hover:text-slate-600">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}

      {error && (
        <div className="mx-6 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400">
          <Spinner size={24} className="mb-2" />
          <p className="text-xs">Loading exit requests…</p>
        </div>
      ) : (
        <div className="p-4 space-y-2.5">
          {requests.map((r) => {
            const expanded = expandedId === r.id;
            const draft = settlementDrafts[r.id];
            return (
              <div key={r.id} className="rounded-xl border border-slate-200 overflow-hidden">
                <button
                  type="button"
                  onClick={() => {
                    setExpandedId(expanded ? null : r.id);
                    if (!expanded) openSettlement(r.id);
                  }}
                  className="w-full flex items-center justify-between gap-3 px-4 py-3 text-left hover:bg-slate-50 transition-colors"
                >
                  <div>
                    <p className="text-sm font-semibold text-slate-800">
                      {r.user_name || `User #${r.user_id}`}{' '}
                      <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 ml-1">
                        {r.exit_type}
                      </span>
                    </p>
                    <p className="text-[11px] text-slate-400 mt-0.5">
                      Last working day: {r.last_working_day || '—'} · Requested by {r.requested_by_name || '—'}
                    </p>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${STATUS_STYLE[r.status]}`}>{r.status}</span>
                    {expanded ? <ChevronUp className="w-4 h-4 text-slate-400" /> : <ChevronDown className="w-4 h-4 text-slate-400" />}
                  </div>
                </button>

                {expanded && (
                  <div className="px-4 pb-4 border-t border-slate-100 pt-4 space-y-4">
                    {r.reason && <p className="text-xs text-slate-600">Reason: {r.reason}</p>}

                    <div className="flex flex-wrap gap-2">
                      {r.status !== 'clearance' && r.status !== 'settled' && (
                        <button
                          type="button"
                          onClick={() => changeStatus(r.id, 'clearance')}
                          className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white transition-colors"
                        >
                          Start Clearance
                        </button>
                      )}
                      {r.status !== 'cancelled' && r.status !== 'settled' && (
                        <button
                          type="button"
                          onClick={() => changeStatus(r.id, 'cancelled')}
                          className="flex items-center gap-1 text-[11px] font-semibold px-3 py-1.5 rounded-lg text-rose-600 border border-rose-200 hover:bg-rose-50 transition-colors"
                        >
                          <Ban className="w-3 h-3" /> Cancel
                        </button>
                      )}
                    </div>

                    <div>
                      <p className="text-xs font-bold text-slate-700 mb-2">Clearance Checklist</p>
                      <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                        {r.clearance_items.map((item) => (
                          <label
                            key={item.id}
                            className={`flex items-start gap-2 text-xs px-3 py-2.5 rounded-xl border cursor-pointer transition-colors ${
                              item.is_cleared ? 'bg-emerald-50/60 border-emerald-200' : 'bg-white border-slate-200'
                            }`}
                          >
                            <input
                              type="checkbox"
                              checked={item.is_cleared}
                              onChange={() => toggleClearance(r.id, item)}
                              className="mt-0.5 w-3.5 h-3.5 rounded border-slate-300 text-emerald-600 focus:ring-emerald-500"
                            />
                            <span>
                              <span className="font-semibold text-slate-700">{item.department}</span>
                              <br />
                              <span className="text-slate-500">{item.item_label}</span>
                            </span>
                          </label>
                        ))}
                      </div>
                    </div>

                    <div>
                      <p className="text-xs font-bold text-slate-700 mb-2">Full &amp; Final Settlement</p>
                      {!draft ? (
                        <Spinner size={16} />
                      ) : (
                        <div className="rounded-xl border border-slate-200 p-3.5 space-y-3">
                          <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                            {[
                              ['unused_leave_days', 'Unused Leave (days)'],
                              ['unused_leave_encashment', 'Leave Encashment'],
                              ['gratuity_amount', 'Gratuity'],
                              ['outstanding_dues', 'Outstanding Dues (−)'],
                              ['other_additions', 'Other Additions'],
                              ['other_deductions', 'Other Deductions (−)']
                            ].map(([key, label]) => (
                              <div key={key}>
                                <label className="block text-[10px] font-semibold text-slate-500 mb-1">{label}</label>
                                <input
                                  type="number"
                                  value={draft[key] ?? ''}
                                  onChange={(e) =>
                                    setSettlementDrafts((prev) => ({ ...prev, [r.id]: { ...prev[r.id], [key]: e.target.value } }))
                                  }
                                  className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                                />
                              </div>
                            ))}
                          </div>
                          <div>
                            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Notes</label>
                            <input
                              type="text"
                              value={draft.notes ?? ''}
                              onChange={(e) => setSettlementDrafts((prev) => ({ ...prev, [r.id]: { ...prev[r.id], notes: e.target.value } }))}
                              className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
                            />
                          </div>
                          <div className="flex items-center justify-between flex-wrap gap-2 pt-1">
                            <p className="text-sm font-bold text-slate-800">
                              Net Payable: <span className="text-emerald-700">{netPayablePreview(r.id).toFixed(2)}</span>
                            </p>
                            <div className="flex items-center gap-1.5">
                              <button
                                type="button"
                                onClick={() => saveSettlement(r.id)}
                                disabled={savingSettlementId === r.id}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-800 text-white disabled:opacity-50 transition-colors"
                              >
                                {savingSettlementId === r.id ? <Spinner size={12} className="text-white" /> : <Save className="w-3 h-3" />}
                                Save Draft
                              </button>
                              <button
                                type="button"
                                onClick={() => saveSettlement(r.id, 'paid')}
                                disabled={savingSettlementId === r.id}
                                className="flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white disabled:opacity-50 transition-colors"
                              >
                                <CheckCircle2 className="w-3 h-3" /> Mark Paid &amp; Settle
                              </button>
                            </div>
                          </div>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            );
          })}
          {requests.length === 0 && <p className="px-2 py-10 text-center text-xs text-slate-400">No exit requests yet.</p>}
        </div>
      )}
    </div>
  );
};
