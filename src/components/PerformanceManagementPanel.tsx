import React, { useEffect, useState } from 'react';
import { Target, Plus, X, AlertTriangle, CheckCircle2, Save } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface PerformanceManagementPanelProps {
  token: string;
}

interface Cycle {
  id: number;
  name: string;
  period_start: string | null;
  period_end: string | null;
  status: 'draft' | 'active' | 'closed';
}

interface Goal {
  id: number;
  cycle_id: number;
  user_id: number;
  user_name: string | null;
  title: string;
  description: string | null;
  weight: number;
  self_rating: number | null;
  manager_rating: number | null;
  status: 'active' | 'completed';
}

interface Review {
  id: number;
  cycle_id: number;
  user_id: number;
  user_name: string | null;
  reviewer_name: string | null;
  overall_rating: number | null;
  strengths: string | null;
  improvements: string | null;
  status: 'pending' | 'submitted' | 'acknowledged';
}

const CYCLE_STATUS_STYLE: Record<string, string> = {
  draft: 'bg-slate-100 text-slate-600 border-slate-200',
  active: 'bg-blue-50 text-blue-700 border-blue-200',
  closed: 'bg-emerald-50 text-emerald-700 border-emerald-200'
};

// Admin Panel -> HR Advanced -> "Performance Management" — KPI/appraisal
// cycles, per-employee goals within a cycle, and an overall review per
// employee. Management-only view (same reasoning as ExitOffboardingPanel.tsx
// — an employee-facing "my goals"/"acknowledge my review" self-service page
// can be layered on later against the same GET endpoints, scoped to the
// signed-in account).
export const PerformanceManagementPanel: React.FC<PerformanceManagementPanelProps> = ({ token }) => {
  const authHeaders = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

  const [cycles, setCycles] = useState<Cycle[]>([]);
  const [users, setUsers] = useState<{ id: number; name: string }[]>([]);
  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);
  const [goals, setGoals] = useState<Goal[]>([]);
  const [reviews, setReviews] = useState<Review[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [success, setSuccess] = useState('');

  const [showNewCycle, setShowNewCycle] = useState(false);
  const [newCycleName, setNewCycleName] = useState('');
  const [newCycleStart, setNewCycleStart] = useState('');
  const [newCycleEnd, setNewCycleEnd] = useState('');

  const [showNewGoal, setShowNewGoal] = useState(false);
  const [newGoalUserId, setNewGoalUserId] = useState('');
  const [newGoalTitle, setNewGoalTitle] = useState('');
  const [newGoalWeight, setNewGoalWeight] = useState('');

  const [showNewReview, setShowNewReview] = useState(false);
  const [newReviewUserId, setNewReviewUserId] = useState('');

  const [reviewDrafts, setReviewDrafts] = useState<Record<number, { overall_rating: string; strengths: string; improvements: string }>>({});

  const fetchCycles = async () => {
    const res = await fetch(apiUrl('/api/performance-cycles'), { headers: authHeaders });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || 'Failed to load cycles');
    setCycles(Array.isArray(data) ? data : []);
    if (!selectedCycleId && data.length > 0) setSelectedCycleId(data[0].id);
  };

  const fetchGoalsAndReviews = async (cycleId: number) => {
    const [goalsRes, reviewsRes] = await Promise.all([
      fetch(apiUrl(`/api/performance-goals?cycle_id=${cycleId}`), { headers: authHeaders }),
      fetch(apiUrl(`/api/performance-reviews?cycle_id=${cycleId}`), { headers: authHeaders })
    ]);
    const goalsData = await goalsRes.json();
    const reviewsData = await reviewsRes.json();
    if (goalsRes.ok) setGoals(Array.isArray(goalsData) ? goalsData : []);
    if (reviewsRes.ok) {
      const list: Review[] = Array.isArray(reviewsData) ? reviewsData : [];
      setReviews(list);
      setReviewDrafts((prev) => {
        const next = { ...prev };
        for (const r of list) {
          if (!next[r.id]) {
            next[r.id] = {
              overall_rating: r.overall_rating === null ? '' : String(r.overall_rating),
              strengths: r.strengths || '',
              improvements: r.improvements || ''
            };
          }
        }
        return next;
      });
    }
  };

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const [, usersRes] = await Promise.all([fetchCycles(), fetch(apiUrl('/api/users'), { headers: authHeaders })]);
        const usersData = await usersRes.json();
        if (usersRes.ok) setUsers(Array.isArray(usersData) ? usersData.filter((u: any) => u.role !== 'superadmin') : []);
      } catch (err: any) {
        setError(err.message || 'Failed to load Performance Management');
      } finally {
        setLoading(false);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (selectedCycleId) fetchGoalsAndReviews(selectedCycleId).catch((err) => setError(err.message));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedCycleId]);

  const createCycle = async () => {
    if (!newCycleName.trim()) {
      setError('Cycle name is required.');
      return;
    }
    setError('');
    try {
      const res = await fetch(apiUrl('/api/performance-cycles'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ name: newCycleName.trim(), period_start: newCycleStart || null, period_end: newCycleEnd || null })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to create cycle');
      setCycles((prev) => [data, ...prev]);
      setSelectedCycleId(data.id);
      setShowNewCycle(false);
      setNewCycleName('');
      setNewCycleStart('');
      setNewCycleEnd('');
    } catch (err: any) {
      setError(err.message || 'Failed to create cycle');
    }
  };

  const changeCycleStatus = async (id: number, status: string) => {
    try {
      const res = await fetch(apiUrl(`/api/performance-cycles/${id}`), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({ status })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update cycle');
      setCycles((prev) => prev.map((c) => (c.id === id ? data : c)));
    } catch (err: any) {
      setError(err.message || 'Failed to update cycle');
    }
  };

  const addGoal = async () => {
    if (!selectedCycleId || !newGoalUserId || !newGoalTitle.trim()) {
      setError('Employee and goal title are required.');
      return;
    }
    try {
      const res = await fetch(apiUrl('/api/performance-goals'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({
          cycle_id: selectedCycleId,
          user_id: Number(newGoalUserId),
          title: newGoalTitle.trim(),
          weight: newGoalWeight ? Number(newGoalWeight) : 0
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to add goal');
      setGoals((prev) => [...prev, data]);
      setShowNewGoal(false);
      setNewGoalUserId('');
      setNewGoalTitle('');
      setNewGoalWeight('');
    } catch (err: any) {
      setError(err.message || 'Failed to add goal');
    }
  };

  const updateGoal = async (id: number, patch: { manager_rating?: string; status?: string }) => {
    try {
      const res = await fetch(apiUrl(`/api/performance-goals/${id}`), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify(patch)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to update goal');
      setGoals((prev) => prev.map((g) => (g.id === id ? data : g)));
    } catch (err: any) {
      setError(err.message || 'Failed to update goal');
    }
  };

  const addReview = async () => {
    if (!selectedCycleId || !newReviewUserId) {
      setError('Select an employee.');
      return;
    }
    try {
      const res = await fetch(apiUrl('/api/performance-reviews'), {
        method: 'POST',
        headers: authHeaders,
        body: JSON.stringify({ cycle_id: selectedCycleId, user_id: Number(newReviewUserId) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to start review');
      setReviews((prev) => [...prev, data]);
      setShowNewReview(false);
      setNewReviewUserId('');
    } catch (err: any) {
      setError(err.message || 'Failed to start review');
    }
  };

  const saveReview = async (id: number, submit: boolean) => {
    const draft = reviewDrafts[id];
    if (!draft) return;
    setError('');
    setSuccess('');
    try {
      const res = await fetch(apiUrl(`/api/performance-reviews/${id}`), {
        method: 'PUT',
        headers: authHeaders,
        body: JSON.stringify({
          overall_rating: draft.overall_rating === '' ? null : Number(draft.overall_rating),
          strengths: draft.strengths,
          improvements: draft.improvements,
          submit
        })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save review');
      setReviews((prev) => prev.map((r) => (r.id === id ? data : r)));
      setSuccess(submit ? 'Review submitted.' : 'Review saved.');
    } catch (err: any) {
      setError(err.message || 'Failed to save review');
    }
  };

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex items-start justify-between gap-4 flex-wrap">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
            <Target className="w-5 h-5 text-blue-600" />
          </div>
          <div>
            <h1 className="text-lg font-semibold text-slate-800">Performance Management</h1>
            <p className="text-xs text-slate-500 mt-0.5 max-w-md">Appraisal cycles, per-employee KPI goals, and overall reviews.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => setShowNewCycle((v) => !v)}
          className="flex items-center gap-1.5 px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white text-xs font-semibold rounded-xl transition-colors"
        >
          <Plus className="w-3.5 h-3.5" /> New Cycle
        </button>
      </div>

      {showNewCycle && (
        <div className="px-6 py-5 border-b border-slate-200 bg-slate-50/60 flex flex-wrap items-end gap-3">
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Cycle name</label>
            <input
              type="text"
              value={newCycleName}
              onChange={(e) => setNewCycleName(e.target.value)}
              placeholder="e.g. 2026 H1"
              className="w-48 px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Period Start</label>
            <input
              type="date"
              value={newCycleStart}
              onChange={(e) => setNewCycleStart(e.target.value)}
              className="px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <div>
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Period End</label>
            <input
              type="date"
              value={newCycleEnd}
              onChange={(e) => setNewCycleEnd(e.target.value)}
              className="px-3 py-2 text-xs border border-slate-200 rounded-xl focus:outline-none focus:ring-2 focus:ring-blue-500"
            />
          </div>
          <button type="button" onClick={createCycle} className="px-4 py-2 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-xl">
            Create
          </button>
          <button type="button" onClick={() => setShowNewCycle(false)} className="px-2.5 py-2 text-slate-400 hover:text-slate-600">
            <X className="w-3.5 h-3.5" />
          </button>
        </div>
      )}

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
      ) : (
        <div className="p-6">
          <div className="flex flex-wrap gap-2 mb-5">
            {cycles.map((c) => (
              <button
                key={c.id}
                type="button"
                onClick={() => setSelectedCycleId(c.id)}
                className={`flex items-center gap-1.5 text-xs font-semibold px-3 py-1.5 rounded-full border transition-colors ${
                  selectedCycleId === c.id ? 'bg-blue-600 text-white border-blue-600' : 'bg-white text-slate-600 border-slate-200 hover:border-blue-300'
                }`}
              >
                {c.name}
                <span className={`text-[9px] px-1.5 py-0.5 rounded-full border ${CYCLE_STATUS_STYLE[c.status]} ${selectedCycleId === c.id ? 'bg-white/20 text-white border-white/40' : ''}`}>
                  {c.status}
                </span>
              </button>
            ))}
            {cycles.length === 0 && <p className="text-xs text-slate-400">No cycles yet — create one above.</p>}
          </div>

          {selectedCycleId && (
            <>
              {(() => {
                const cycle = cycles.find((c) => c.id === selectedCycleId);
                if (!cycle) return null;
                return (
                  <div className="flex items-center gap-2 mb-5">
                    {cycle.status === 'draft' && (
                      <button type="button" onClick={() => changeCycleStatus(cycle.id, 'active')} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white">
                        Activate Cycle
                      </button>
                    )}
                    {cycle.status === 'active' && (
                      <button type="button" onClick={() => changeCycleStatus(cycle.id, 'closed')} className="text-[11px] font-semibold px-3 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white">
                        Close Cycle
                      </button>
                    )}
                  </div>
                );
              })()}

              <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold text-slate-700">Goals / KPIs</p>
                    <button type="button" onClick={() => setShowNewGoal((v) => !v)} className="text-[11px] font-semibold text-blue-600 flex items-center gap-1">
                      <Plus className="w-3 h-3" /> Add Goal
                    </button>
                  </div>
                  {showNewGoal && (
                    <div className="rounded-xl border border-dashed border-blue-300 p-3 mb-3 space-y-2">
                      <select value={newGoalUserId} onChange={(e) => setNewGoalUserId(e.target.value)} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg">
                        <option value="">Select employee…</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                      <input
                        type="text"
                        value={newGoalTitle}
                        onChange={(e) => setNewGoalTitle(e.target.value)}
                        placeholder="Goal title"
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg"
                      />
                      <input
                        type="number"
                        value={newGoalWeight}
                        onChange={(e) => setNewGoalWeight(e.target.value)}
                        placeholder="Weight %"
                        className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg"
                      />
                      <button type="button" onClick={addGoal} className="w-full py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-lg">
                        Add
                      </button>
                    </div>
                  )}
                  <div className="space-y-2">
                    {goals.map((g) => (
                      <div key={g.id} className="rounded-xl border border-slate-200 p-3">
                        <p className="text-xs font-semibold text-slate-800">
                          {g.title} <span className="text-slate-400 font-normal">({g.weight}%)</span>
                        </p>
                        <p className="text-[11px] text-slate-500 mb-2">{g.user_name}</p>
                        <div className="flex items-center gap-2">
                          <input
                            type="number"
                            min={0}
                            max={5}
                            step={0.5}
                            placeholder="Rating"
                            defaultValue={g.manager_rating ?? ''}
                            onBlur={(e) => updateGoal(g.id, { manager_rating: e.target.value })}
                            className="w-20 px-2 py-1 text-xs border border-slate-200 rounded-lg"
                          />
                          <select
                            value={g.status}
                            onChange={(e) => updateGoal(g.id, { status: e.target.value })}
                            className="text-xs border border-slate-200 rounded-lg px-2 py-1"
                          >
                            <option value="active">Active</option>
                            <option value="completed">Completed</option>
                          </select>
                        </div>
                      </div>
                    ))}
                    {goals.length === 0 && <p className="text-xs text-slate-400">No goals in this cycle yet.</p>}
                  </div>
                </div>

                <div>
                  <div className="flex items-center justify-between mb-2">
                    <p className="text-xs font-bold text-slate-700">Reviews</p>
                    <button type="button" onClick={() => setShowNewReview((v) => !v)} className="text-[11px] font-semibold text-blue-600 flex items-center gap-1">
                      <Plus className="w-3 h-3" /> Start Review
                    </button>
                  </div>
                  {showNewReview && (
                    <div className="rounded-xl border border-dashed border-blue-300 p-3 mb-3 space-y-2">
                      <select value={newReviewUserId} onChange={(e) => setNewReviewUserId(e.target.value)} className="w-full px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg">
                        <option value="">Select employee…</option>
                        {users.map((u) => (
                          <option key={u.id} value={u.id}>
                            {u.name}
                          </option>
                        ))}
                      </select>
                      <button type="button" onClick={addReview} className="w-full py-1.5 bg-slate-800 hover:bg-slate-900 text-white text-xs font-semibold rounded-lg">
                        Start
                      </button>
                    </div>
                  )}
                  <div className="space-y-2">
                    {reviews.map((r) => {
                      const draft = reviewDrafts[r.id] || { overall_rating: '', strengths: '', improvements: '' };
                      return (
                        <div key={r.id} className="rounded-xl border border-slate-200 p-3">
                          <div className="flex items-center justify-between mb-2">
                            <p className="text-xs font-semibold text-slate-800">{r.user_name}</p>
                            <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">{r.status}</span>
                          </div>
                          <input
                            type="number"
                            min={0}
                            max={5}
                            step={0.5}
                            placeholder="Overall rating"
                            value={draft.overall_rating}
                            onChange={(e) => setReviewDrafts((prev) => ({ ...prev, [r.id]: { ...draft, overall_rating: e.target.value } }))}
                            className="w-full mb-1.5 px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg"
                          />
                          <textarea
                            placeholder="Strengths"
                            value={draft.strengths}
                            onChange={(e) => setReviewDrafts((prev) => ({ ...prev, [r.id]: { ...draft, strengths: e.target.value } }))}
                            className="w-full mb-1.5 px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg"
                            rows={2}
                          />
                          <textarea
                            placeholder="Areas to improve"
                            value={draft.improvements}
                            onChange={(e) => setReviewDrafts((prev) => ({ ...prev, [r.id]: { ...draft, improvements: e.target.value } }))}
                            className="w-full mb-2 px-2.5 py-1.5 text-xs border border-slate-200 rounded-lg"
                            rows={2}
                          />
                          <div className="flex items-center gap-1.5">
                            <button
                              type="button"
                              onClick={() => saveReview(r.id, false)}
                              className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-slate-700 hover:bg-slate-800 text-white"
                            >
                              <Save className="w-3 h-3" /> Save
                            </button>
                            <button
                              type="button"
                              onClick={() => saveReview(r.id, true)}
                              className="flex items-center gap-1 text-[11px] font-semibold px-2.5 py-1.5 rounded-lg bg-emerald-600 hover:bg-emerald-700 text-white"
                            >
                              <CheckCircle2 className="w-3 h-3" /> Submit
                            </button>
                          </div>
                        </div>
                      );
                    })}
                    {reviews.length === 0 && <p className="text-xs text-slate-400">No reviews started in this cycle yet.</p>}
                  </div>
                </div>
              </div>
            </>
          )}
        </div>
      )}
    </div>
  );
};
