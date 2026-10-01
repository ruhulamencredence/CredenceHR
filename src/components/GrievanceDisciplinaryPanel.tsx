import React, { useEffect, useState } from 'react';
import { Gavel, Plus, X, AlertTriangle, CheckCircle2, MessageSquareWarning, ShieldAlert } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface GrievanceDisciplinaryPanelProps {
  token: string;
}

interface Grievance {
  id: number;
  raised_by_name: string | null;
  against_user_name: string | null;
  category: string | null;
  description: string;
  is_anonymous: boolean;
  status: 'open' | 'investigating' | 'resolved' | 'dismissed';
  assigned_to_name: string | null;
  resolution_notes: string | null;
  created_at: string;
}

interface DisciplinaryAction {
  id: number;
  user_id: number;
  user_name: string | null;
  action_type: string;
  reason: string;
  issued_by_name: string | null;
  issued_at: string;
  acknowledged: boolean;
  status: 'active' | 'acknowledged' | 'closed';
}

const GRIEVANCE_STATUS_STYLE: Record<string, string> = {
  open: 'bg-amber-50 text-amber-700 border-amber-200',
  investigating: 'bg-blue-50 text-blue-700 border-blue-200',
  resolved: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  dismissed: 'bg-slate-100 text-slate-500 border-slate-200'
};

const ACTION_TYPE_LABEL: Record<string, string> = {
  verbal_warning: 'Verbal Warning',
  written_warning: 'Written Warning',
  show_cause: 'Show Cause',
  suspension: 'Suspension',
  termination: 'Termination'
};

// Admin Panel -> HR Advanced -> "Grievance & Disciplinary" — a shared
// grievance queue (assign/investigate/resolve) and a log of formal
// disciplinary actions issued to employees. Management-only view; the
// backend already lets any employee raise their OWN grievance
// (POST /api/grievances) and acknowledge their own disciplinary action
// (PUT .../:id with acknowledge:true) — those two are just not wired into a
// self-service page yet, same "layer on later" note as the other 5 HR
// Advanced panels.
export const GrievanceDisciplinaryPanel: React.FC<GrievanceDisciplinaryPanelProps> = ({ token }) => {
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [tab, setTab] = useState<'grievances' | 'disciplinary'>('grievances');
  const [grievances, setGrievances] = useState<Grievance[]>([]);
  const [actions, setActions] = useState<DisciplinaryAction[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [resolutionDrafts, setResolutionDrafts] = useState<Record<number, string>>({});

  const [showNewAction, setShowNewAction] = useState(false);
  const [newActionUserId, setNewActionUserId] = useState('');
  const [newActionType, setNewActionType] = useState('verbal_warning');
  const [newActionReason, setNewActionReason] = useState('');

  const fetchAll = async () => {
    setLoading(true);
    setError('');
    try {
      const [gRes, aRes, uRes] = await Promise.all([
        fetch(apiUrl('/api/grievances'), { headers: authHeaders }),
        fetch(apiUrl('/api/disciplinary-actions'), { headers: authHeaders }),
        fetch(apiUrl('/api/users'), { headers: authHeaders })
      ]);
      const gData = await gRes.json();
      const aData = await aRes.json();
      const uData = await uRes.json();
      if (!gRes.ok) throw new Error(gData.error || 'Failed to load grievances');
      if (!aRes.ok) throw new Error(aData.error || 'Failed to load disciplinary actions');
      setGrievances(Array.isArray(gData) ? gData : []);
      setActions(Array.isArray(aData) ? aData : []);
      if (uRes.ok) setUsers(Array.isArray(uData) ? uData.filter((u: any) => u.role !== 'superadmin') : []);
    } catch (err: any) {
      setError(err.message || 'Failed to load');
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchAll();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const updateGrievance = async (id: number, patch: { status?: string; resolution_notes?: string }) => {
    setError('');
    setSuccess('');
    try {
      const res = await fetch(apiUrl(`/api/grievances/${id}`), { method: 'PUT', headers: authHeaders, body: JSON.stringify(patch) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update grievance');
      setGrievances((prev) => prev.map((g) => (g.id === id ? data : g)));
      setSuccess('Grievance updated.');
    } catch (err: any) {
      setError(err.message || 'Failed to update grievance');
    }
  };

  const issueAction = async () => {
    if (!newActionUserId || !newActionReason.trim()) {
      setError('Employee and reason are required.');
      return;
    }
    setError('');
    try {
      const res = await fetch(apiUrl('/api/disciplinary-actions'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ user_id: Number(newActionUserId), action_type: newActionType, reason: newActionReason.trim() })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to issue action');
      setActions((prev) => [data, ...prev]);
      setShowNewAction(false);
      setNewActionUserId('');
      setNewActionReason('');
    } catch (err: any) {
      setError(err.message || 'Failed to issue action');
    }
  };

  const closeAction = async (id: number) => {
    try {
      const res = await fetch(apiUrl(`/api/disciplinary-actions/${id}`), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ status: 'closed' })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to close action');
      setActions((prev) => prev.map((a) => (a.id === id ? data : a)));
    } catch (err: any) {
      setError(err.message || 'Failed to close action');
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <Gavel className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Grievance &amp; Disciplinary</h1>
            <p className="text-xs text-slate-500 mt-0.5 max-w-md">Track employee grievances and formal disciplinary actions.</p>
          </div>
        </div>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => setTab('grievances')}
            className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
              tab === 'grievances' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'
            }`}
          >
            <MessageSquareWarning className="w-3.5 h-3.5 inline mr-1" /> Grievances
          </button>
          <button
            type="button"
            onClick={() => setTab('disciplinary')}
            className={`text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
              tab === 'disciplinary' ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200'
            }`}
          >
            <ShieldAlert className="w-3.5 h-3.5 inline mr-1" /> Disciplinary Actions
          </button>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}
      {success && (
        <div className="mx-6 mt-4 px-4 py-2.5 bg-emerald-50 border border-emerald-200 text-emerald-700 text-xs rounded-xl flex items-center gap-2">
          <CheckCircle2 className="w-3.5 h-3.5 shrink-0" /> {success}
        </div>
      )}

      {loading ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400">
          <Spinner size={24} className="mb-2" />
          <p className="text-xs">Loading…</p>
        </div>
      ) : tab === 'grievances' ? (
        <div className="p-4 space-y-2.5">
          {grievances.map((g) => (
            <div key={g.id} className="rounded-xl border border-slate-200 p-4">
              <div className="flex items-center justify-between gap-2 flex-wrap mb-2">
                <p className="text-xs font-semibold text-slate-800">
                  {g.raised_by_name} {g.against_user_name && <span className="text-slate-400 font-normal">against {g.against_user_name}</span>}
                  {g.category && <span className="text-slate-400 font-normal"> · {g.category}</span>}
                </p>
                <span className={`text-[11px] font-semibold px-2.5 py-1 rounded-full border ${GRIEVANCE_STATUS_STYLE[g.status]}`}>{g.status}</span>
              </div>
              <p className="text-xs text-slate-600 mb-3">{g.description}</p>
              <div className="flex flex-wrap items-center gap-2">
                {g.status === 'open' && (
                  <button type="button" onClick={() => updateGrievance(g.id, { status: 'investigating' })} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white">
                    Start Investigating
                  </button>
                )}
                {(g.status === 'open' || g.status === 'investigating') && (
                  <>
                    <input
                      type="text"
                      placeholder="Resolution notes"
                      value={resolutionDrafts[g.id] ?? g.resolution_notes ?? ''}
                      onChange={(e) => setResolutionDrafts((prev) => ({ ...prev, [g.id]: e.target.value }))}
                      className="text-xs px-2.5 py-1.5 border border-slate-200 rounded-lg flex-1 min-w-[160px]"
                    />
                    <button
                      type="button"
                      onClick={() => updateGrievance(g.id, { status: 'resolved', resolution_notes: resolutionDrafts[g.id] ?? g.resolution_notes ?? '' })}
                      className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
                    >
                      Resolve
                    </button>
                    <button
                      type="button"
                      onClick={() => updateGrievance(g.id, { status: 'dismissed', resolution_notes: resolutionDrafts[g.id] ?? g.resolution_notes ?? '' })}
                      className="text-[11px] font-semibold px-3 py-1.5 rounded-lg text-rose-600 border border-rose-200 hover:bg-rose-50"
                    >
                      Dismiss
                    </button>
                  </>
                )}
              </div>
            </div>
          ))}
          {grievances.length === 0 && <p className="px-2 py-10 text-center text-xs text-slate-400">No grievances raised yet.</p>}
        </div>
      ) : (
        <div className="p-4">
          <div className="flex justify-end mb-3">
            <button
              type="button"
              onClick={() => setShowNewAction((v) => !v)}
              className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl"
            >
              <Plus className="w-3.5 h-3.5" /> Issue Action
            </button>
          </div>
          {showNewAction && (
            <div className="rounded-xl border border-dashed border-blue-300 p-3.5 mb-3 flex flex-wrap items-end gap-2">
              <select value={newActionUserId} onChange={(e) => setNewActionUserId(e.target.value)} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg">
                <option value="">Select employee…</option>
                {users.map((u) => (
                  <option key={u.id} value={u.id}>
                    {u.name}
                  </option>
                ))}
              </select>
              <select value={newActionType} onChange={(e) => setNewActionType(e.target.value)} className="px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg">
                {Object.entries(ACTION_TYPE_LABEL).map(([k, label]) => (
                  <option key={k} value={k}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                type="text"
                placeholder="Reason"
                value={newActionReason}
                onChange={(e) => setNewActionReason(e.target.value)}
                className="flex-1 min-w-[200px] px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg"
              />
              <button type="button" onClick={issueAction} className="px-3 py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-lg">
                Issue
              </button>
              <button type="button" onClick={() => setShowNewAction(false)} className="px-2 py-1.5 text-slate-400 hover:text-slate-600">
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}
          <div className="space-y-2.5">
            {actions.map((a) => (
              <div key={a.id} className="rounded-xl border border-slate-200 p-4">
                <div className="flex items-center justify-between gap-2 flex-wrap mb-1.5">
                  <p className="text-xs font-semibold text-slate-800">
                    {a.user_name} <span className="text-rose-600 font-normal">— {ACTION_TYPE_LABEL[a.action_type] || a.action_type}</span>
                  </p>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`text-[10px] font-semibold px-2 py-0.5 rounded-full border ${
                        a.acknowledged ? 'bg-emerald-50 text-emerald-700 border-emerald-200' : 'bg-amber-50 text-amber-700 border-amber-200'
                      }`}
                    >
                      {a.acknowledged ? 'Acknowledged' : 'Pending acknowledgement'}
                    </span>
                    <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600 border border-slate-200">{a.status}</span>
                  </div>
                </div>
                <p className="text-xs text-slate-600 mb-2">{a.reason}</p>
                <p className="text-[11px] text-slate-400">
                  Issued by {a.issued_by_name || '—'} · {new Date(a.issued_at).toLocaleDateString()}
                </p>
                {a.status !== 'closed' && (
                  <button type="button" onClick={() => closeAction(a.id)} className="mt-2 text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-slate-600 hover:bg-slate-700 text-white">
                    Close
                  </button>
                )}
              </div>
            ))}
            {actions.length === 0 && <p className="px-2 py-10 text-center text-xs text-slate-400">No disciplinary actions issued yet.</p>}
          </div>
        </div>
      )}
    </div>
  );
};
