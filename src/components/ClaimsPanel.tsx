import React, { useEffect, useState } from 'react';
import { Route, Filter, LogIn, LogOut, Trash2 } from 'lucide-react';
import { ClaimRecord, User } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { Spinner } from './Spinner';

interface ClaimsPanelProps {
  token: string;
  users: User[];
}

// Admin Panel -> Movement Claims: every point A -> point B travel check-in/out a
// User has recorded from the User Panel's Movement Claim card, system-wide,
// filterable by User/date/status — for TA/DA-style reimbursement review.
export const ClaimsPanel: React.FC<ClaimsPanelProps> = ({ token, users }) => {
  const [claims, setClaims] = useState<ClaimRecord[]>([]);
  const [loading, setLoading] = useState(false);
  const [userFilter, setUserFilter] = useState('');
  const [fromFilter, setFromFilter] = useState('');
  const [toFilter, setToFilter] = useState('');
  const [statusFilter, setStatusFilter] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const fetchClaims = async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams();
      if (userFilter) params.set('user_id', userFilter);
      if (fromFilter) params.set('from', fromFilter);
      if (toFilter) params.set('to', toFilter);
      if (statusFilter) params.set('status', statusFilter);
      const res = await fetch(apiUrl(`/api/claims?${params.toString()}`), { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setClaims(await res.json());
    } catch (err) {
      console.error('Failed to load claims', err);
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    fetchClaims();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this claim? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      const res = await fetch(apiUrl(`/api/claims/${id}`), { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) setClaims((prev) => prev.filter((c) => c.id !== id));
    } catch (err) {
      console.error('Failed to delete claim', err);
    } finally {
      setDeletingId(null);
    }
  };

  const hasFilters = userFilter || fromFilter || toFilter || statusFilter;

  return (
    <div className="bg-white border border-slate-200 rounded-2xl shadow-sm overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex flex-col gap-4">
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-3">
          <div>
            <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
              <Route className="w-4 h-4 text-blue-600" /> Movement Claims
            </h3>
            <p className="text-xs text-slate-500 mt-0.5">
              Point A → point B travel check-ins/outs Users have recorded for office work — review for TA/DA-style
              reimbursement.
            </p>
          </div>
        </div>
        <div className="grid grid-cols-2 gap-2 sm:flex sm:flex-wrap sm:items-end">
          <div className="min-w-0">
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">User</label>
            <select
              value={userFilter}
              onChange={(e) => setUserFilter(e.target.value)}
              className="w-full sm:w-auto text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
            >
              <option value="">All Users</option>
              {users.filter((u) => u.role === 'user').map((u) => (
                <option key={u.id} value={u.id}>{u.name}</option>
              ))}
            </select>
          </div>
          <div className="min-w-0">
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">Status</label>
            <select
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value)}
              className="w-full sm:w-auto text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
            >
              <option value="">All</option>
              <option value="open">Open (not checked out)</option>
              <option value="completed">Completed</option>
            </select>
          </div>
          <div className="min-w-0">
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">From</label>
            <input
              type="date"
              value={fromFilter}
              onChange={(e) => setFromFilter(e.target.value)}
              className="w-full sm:w-auto text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
            />
          </div>
          <div className="min-w-0">
            <label className="block text-[10px] font-semibold text-slate-500 mb-1">To</label>
            <input
              type="date"
              value={toFilter}
              onChange={(e) => setToFilter(e.target.value)}
              className="w-full sm:w-auto text-xs px-2.5 py-2 bg-slate-50 border border-slate-200 rounded-lg focus:ring-2 focus:ring-blue-600 focus:outline-none"
            />
          </div>
          <button
            type="button"
            onClick={fetchClaims}
            className="col-span-1 flex items-center justify-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium whitespace-nowrap transition-colors"
          >
            <Filter className="w-3.5 h-3.5" /> Apply
          </button>
          {hasFilters && (
            <button
              type="button"
              onClick={() => {
                setUserFilter('');
                setFromFilter('');
                setToFilter('');
                setStatusFilter('');
              }}
              className="col-span-1 text-xs px-3 py-2 rounded-lg border border-slate-200 text-slate-500 hover:text-slate-900 hover:bg-slate-50 font-medium whitespace-nowrap transition-colors"
            >
              Clear
            </button>
          )}
        </div>
      </div>

      {loading ? (
        <p className="text-xs text-slate-400 text-center py-12">Loading claims...</p>
      ) : claims.length === 0 ? (
        <div className="text-center text-xs text-slate-400 py-12 flex flex-col items-center gap-2">
          <Route className="w-6 h-6 text-slate-300" />
          No movement claims recorded yet.
        </div>
      ) : (
        <>
          {/* Mobile — stacked cards instead of a squeezed/scrolled table. */}
          <div className="md:hidden divide-y divide-slate-100">
            {claims.map((c) => (
              <div key={c.id} className="p-4 flex flex-col gap-2.5">
                <div className="flex items-start justify-between gap-2">
                  <div className="min-w-0">
                    <p className="font-semibold text-slate-900 text-sm truncate">{c.user_name || '—'}</p>
                    <p className="text-xs text-slate-500 mt-0.5 line-clamp-2" title={c.purpose}>{c.purpose}</p>
                  </div>
                  <span
                    className={`shrink-0 px-2 py-0.5 rounded-full text-[11px] font-semibold border ${
                      c.status === 'open'
                        ? 'bg-amber-50 text-amber-700 border-amber-200'
                        : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                    }`}
                  >
                    {c.status === 'open' ? 'Open' : 'Completed'}
                  </span>
                </div>

                <div className="flex flex-col gap-1.5 text-xs">
                  <div className="flex items-start gap-1.5 text-emerald-700">
                    <LogIn className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                    <div className="min-w-0">
                      <span>
                        {formatDate(c.check_in_at)} {new Date(c.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {c.check_in_remarks && (
                        <div className="text-[11px] text-slate-400 mt-0.5 truncate" title={c.check_in_remarks}>
                          {c.check_in_remarks}
                        </div>
                      )}
                    </div>
                  </div>
                  {c.check_out_at ? (
                    <div className="flex items-start gap-1.5 text-blue-700">
                      <LogOut className="w-3.5 h-3.5 shrink-0 mt-0.5" />
                      <div className="min-w-0">
                        <span>
                          {formatDate(c.check_out_at)} {new Date(c.check_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                        </span>
                        {c.check_out_remarks && (
                          <div className="text-[11px] text-slate-400 mt-0.5 truncate" title={c.check_out_remarks}>
                            {c.check_out_remarks}
                          </div>
                        )}
                      </div>
                    </div>
                  ) : (
                    <div className="flex items-center gap-1.5 text-slate-400">
                      <LogOut className="w-3.5 h-3.5 shrink-0" />
                      <span>Not checked out</span>
                    </div>
                  )}
                </div>

                <div className="flex items-center justify-between pt-1">
                  <span className="text-xs text-slate-500">
                    {c.distance_km != null ? `${c.distance_km} km` : '—'}
                  </span>
                  <button
                    type="button"
                    onClick={() => handleDelete(c.id)}
                    disabled={deletingId === c.id}
                    className="flex items-center gap-1.5 text-xs px-2.5 py-1.5 text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                  >
                    {deletingId === c.id ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />} Delete
                  </button>
                </div>
              </div>
            ))}
          </div>

          {/* Desktop — full table. */}
          <div className="hidden md:block overflow-x-auto">
            <table className="min-w-full divide-y divide-slate-200">
              <thead className="bg-slate-50 text-slate-500 text-[11px] uppercase tracking-wider">
                <tr>
                  <th className="px-4 py-2.5 text-left">User</th>
                  <th className="px-4 py-2.5 text-left">Purpose</th>
                  <th className="px-4 py-2.5 text-left">Check In</th>
                  <th className="px-4 py-2.5 text-left">Check Out</th>
                  <th className="px-4 py-2.5 text-left">Distance</th>
                  <th className="px-4 py-2.5 text-left">Status</th>
                  <th className="px-4 py-2.5 text-left"></th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100 text-sm">
                {claims.map((c) => (
                  <tr key={c.id} className="hover:bg-slate-50/80 transition-colors">
                    <td className="px-4 py-3 whitespace-nowrap font-semibold text-slate-900 text-xs">{c.user_name || '—'}</td>
                    <td className="px-4 py-3 text-slate-700 text-xs max-w-[220px]">
                      <span className="block truncate" title={c.purpose}>{c.purpose}</span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">
                      <span className="inline-flex items-center gap-1 text-emerald-700">
                        <LogIn className="w-3 h-3" />
                        {formatDate(c.check_in_at)} {new Date(c.check_in_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                      </span>
                      {c.check_in_remarks && (
                        <div className="text-[10px] text-slate-400 mt-0.5 max-w-[180px] truncate" title={c.check_in_remarks}>
                          {c.check_in_remarks}
                        </div>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">
                      {c.check_out_at ? (
                        <>
                          <span className="inline-flex items-center gap-1 text-blue-700">
                            <LogOut className="w-3 h-3" />
                            {formatDate(c.check_out_at)} {new Date(c.check_out_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}
                          </span>
                          {c.check_out_remarks && (
                            <div className="text-[10px] text-slate-400 mt-0.5 max-w-[180px] truncate" title={c.check_out_remarks}>
                              {c.check_out_remarks}
                            </div>
                          )}
                        </>
                      ) : (
                        <span className="text-slate-300">—</span>
                      )}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-slate-600 text-xs">
                      {c.distance_km != null ? `${c.distance_km} km` : <span className="text-slate-300">—</span>}
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">
                      <span
                        className={`px-2 py-0.5 rounded-full font-semibold border ${
                          c.status === 'open'
                            ? 'bg-amber-50 text-amber-700 border-amber-200'
                            : 'bg-emerald-50 text-emerald-700 border-emerald-200'
                        }`}
                      >
                        {c.status === 'open' ? 'Open' : 'Completed'}
                      </span>
                    </td>
                    <td className="px-4 py-3 whitespace-nowrap text-xs">
                      <button
                        type="button"
                        onClick={() => handleDelete(c.id)}
                        disabled={deletingId === c.id}
                        className="p-1.5 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                        title="Delete this claim"
                      >
                        {deletingId === c.id ? <Spinner size={14} /> : <Trash2 className="w-3.5 h-3.5" />}
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
};