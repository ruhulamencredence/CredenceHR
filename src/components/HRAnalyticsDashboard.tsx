import React, { useEffect, useState } from 'react';
import { BarChart3, Users, Briefcase, LogOut, MessageSquareWarning, Fingerprint, AlertTriangle } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface HRAnalyticsDashboardProps {
  token: string;
}

interface Summary {
  headcount_total: number;
  headcount_by_department: { department: string; count: number }[];
  open_positions: number;
  pending_exits: number;
  open_grievances: number;
  remote_attendance_rate: number;
  leave_applications_by_month: { month: string; label: string; count: number }[];
  exits_by_month: { month: string; label: string; count: number }[];
}

// One stat tile — the headline-number form the dataviz skill calls for when
// the job is "a single magnitude", not a full chart.
const StatTile: React.FC<{ icon: React.ComponentType<{ className?: string }>; label: string; value: string | number; accent: string }> = ({
  icon: Icon,
  label,
  value,
  accent
}) => (
  <div className="rounded-2xl border border-slate-200 bg-white p-4 flex items-center gap-3">
    <div className={`w-10 h-10 rounded-full flex items-center justify-center shrink-0 ${accent}`}>
      <Icon className="w-5 h-5" />
    </div>
    <div>
      <p className="text-lg font-bold text-slate-800 leading-tight">{value}</p>
      <p className="text-[11px] text-slate-500">{label}</p>
    </div>
  </div>
);

// A single-hue horizontal bar chart — magnitude only, one axis, thin bars
// with rounded data-ends, always-visible direct labels (no legend needed:
// the chart title already names the series, per the dataviz skill's
// single-series rule).
const HorizontalBars: React.FC<{ data: { label: string; count: number }[]; barClass: string }> = ({ data, barClass }) => {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="space-y-2.5">
      {data.map((d) => (
        <div key={d.label} className="flex items-center gap-2.5">
          <span className="w-24 shrink-0 text-[11px] text-slate-500 truncate" title={d.label}>
            {d.label}
          </span>
          <div className="flex-1 h-3 rounded-full bg-slate-100 overflow-hidden">
            <div className={`h-full rounded-full ${barClass}`} style={{ width: `${(d.count / max) * 100}%` }} />
          </div>
          <span className="w-6 shrink-0 text-[11px] font-semibold text-slate-700 text-right">{d.count}</span>
        </div>
      ))}
      {data.length === 0 && <p className="text-xs text-slate-400">No data yet.</p>}
    </div>
  );
};

// A single-hue vertical bar chart for a month-over-month trend — one axis,
// direct value labels on every bar (bounded to 6 bars, so this stays
// readable without a hover layer).
const MonthlyBars: React.FC<{ data: { label: string; count: number }[]; barClass: string }> = ({ data, barClass }) => {
  const max = Math.max(1, ...data.map((d) => d.count));
  return (
    <div className="flex items-end gap-3 h-32 px-1">
      {data.map((d) => (
        <div key={d.label} className="flex-1 flex flex-col items-center gap-1.5">
          <span className="text-[11px] font-semibold text-slate-700">{d.count}</span>
          <div className="w-full flex items-end h-20">
            <div className={`w-full rounded-t-md ${barClass}`} style={{ height: `${Math.max(4, (d.count / max) * 100)}%` }} />
          </div>
          <span className="text-[10px] text-slate-400">{d.label}</span>
        </div>
      ))}
    </div>
  );
};

// Admin Panel -> HR Advanced -> "HR Analytics" — headcount, open positions,
// exit/grievance counts, Remote Attendance rate, and two 6-month trends
// (Leave Applications, Exits/Attrition), all off GET /api/hr-analytics/summary.
// No new tables — pure aggregation over data every other module here already
// writes.
export const HRAnalyticsDashboard: React.FC<HRAnalyticsDashboardProps> = ({ token }) => {
  const [summary, setSummary] = useState<Summary | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(apiUrl('/api/hr-analytics/summary'), { headers: { Authorization: `Bearer ${token}` } });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load HR Analytics');
        setSummary(data);
      } catch (err: any) {
        setError(err.message || 'Failed to load HR Analytics');
      } finally {
        setLoading(false);
      }
    })();
  }, [token]);

  return (
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 border-b border-slate-200 flex items-center gap-3">
        <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
          <BarChart3 className="w-5 h-5 text-blue-600" />
        </div>
        <div>
          <h1 className="text-lg font-semibold text-slate-800">HR Analytics</h1>
          <p className="text-xs text-slate-500 mt-0.5">Headcount, hiring, attrition, and engagement at a glance.</p>
        </div>
      </div>

      {error && (
        <div className="mx-6 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl flex items-center gap-2">
          <AlertTriangle className="w-3.5 h-3.5 shrink-0" /> {error}
        </div>
      )}

      {loading || !summary ? (
        <div className="flex flex-col items-center justify-center py-16 text-slate-400">
          <Spinner size={24} className="mb-2" />
          <p className="text-xs">Loading…</p>
        </div>
      ) : (
        <div className="p-6 space-y-6">
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-5 gap-3">
            <StatTile icon={Users} label="Headcount" value={summary.headcount_total} accent="bg-blue-50 text-blue-600" />
            <StatTile icon={Briefcase} label="Open Positions" value={summary.open_positions} accent="bg-emerald-50 text-emerald-600" />
            <StatTile icon={LogOut} label="Exits In Progress" value={summary.pending_exits} accent="bg-amber-50 text-amber-600" />
            <StatTile icon={MessageSquareWarning} label="Open Grievances" value={summary.open_grievances} accent="bg-rose-50 text-rose-600" />
            <StatTile icon={Fingerprint} label="Remote Attendance" value={`${summary.remote_attendance_rate}%`} accent="bg-indigo-50 text-indigo-600" />
          </div>

          <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="text-xs font-bold text-slate-700 mb-3">Headcount by Department</p>
              <HorizontalBars data={summary.headcount_by_department.map((d) => ({ label: d.department, count: d.count }))} barClass="bg-blue-500" />
            </div>

            <div className="rounded-2xl border border-slate-200 p-4">
              <p className="text-xs font-bold text-slate-700 mb-3">Leave Applications (last 6 months)</p>
              <MonthlyBars data={summary.leave_applications_by_month} barClass="bg-blue-500" />
            </div>

            <div className="rounded-2xl border border-slate-200 p-4 lg:col-span-2">
              <p className="text-xs font-bold text-slate-700 mb-3">Attrition — Exit Requests (last 6 months)</p>
              <MonthlyBars data={summary.exits_by_month} barClass="bg-rose-500" />
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
