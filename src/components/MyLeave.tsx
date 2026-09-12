import React, { useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, ListChecks } from 'lucide-react';
import { User, LeaveBalance } from '../types';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';
import { ModulePath } from './ModulePath';

interface MyLeaveProps {
  token: string;
  user: User;
  onBack: () => void;
}

// "Self Service" > "My Leave" — split out of the old combined
// LeaveManagement.tsx (see LeaveManage.tsx for the admin-only "Leave Manage"
// page that now holds the rest of what that file used to do). Every account
// gets this page, and it ONLY ever shows their own Casual/Sick/Leave-without-
// Pay balance, read-only — no per-account table, no editing, no "Set Balance
// in Bulk", regardless of role or can_manage_leave.
export const MyLeave: React.FC<MyLeaveProps> = ({ token, user, onBack }) => {
  // Same isNativeApp split the rest of the app uses (JobEditPanel.tsx,
  // LeaveManage.tsx, etc.) — hides the web-only Back button/breadcrumb on the
  // Android APK build, which has its own header/back navigation instead.
  const isNativeApp = Capacitor.isNativePlatform();

  const [balance, setBalance] = useState<LeaveBalance | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    (async () => {
      setLoading(true);
      setError('');
      try {
        const res = await fetch(apiUrl('/api/leave-balances/mine'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Failed to load your Leave balance');
        // /api/leave-balances/mine always returns this account's own single
        // row — even for a Leave Manager/Superadmin — unlike GET
        // /api/leave-balances (see LeaveManage.tsx), which switches to the
        // "every account" shape for them.
        const rows: LeaveBalance[] = Array.isArray(data) ? data : [];
        setBalance(rows[0] || null);
      } catch (err: any) {
        setError(err.message || 'Failed to load your Leave balance');
      } finally {
        setLoading(false);
      }
    })();
  }, [token, user.id]);

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'My Leave']} />
            <button
              type="button"
              onClick={onBack}
              className="flex items-center gap-1.5 text-xs text-slate-500 hover:text-blue-600 mb-3 transition-colors"
            >
              <ArrowLeft className="w-3.5 h-3.5" /> Back
            </button>
          </>
        )}

        <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
          <div className="p-6 border-b border-slate-200 flex items-start gap-3">
            <div className="w-10 h-10 rounded-full bg-blue-50 flex items-center justify-center shrink-0">
              <ListChecks className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-800">My Leave</h1>
              <p className="text-xs text-slate-500 mt-0.5 max-w-md">
                Your current Casual Leave, Sick Leave and Leave without Pay balance.
              </p>
            </div>
          </div>

          {error && (
            <div className="mx-6 mt-4 px-4 py-2.5 bg-rose-50 border border-rose-200 text-rose-700 text-xs rounded-xl">
              {error}
            </div>
          )}

          {loading ? (
            <div className="flex flex-col items-center justify-center py-16 text-slate-400">
              <Spinner size={24} className="mb-2" />
              <p className="text-xs">Loading your Leave balance...</p>
            </div>
          ) : (
            <div className="p-6 grid grid-cols-1 sm:grid-cols-3 gap-4">
              {!balance ? (
                <p className="text-xs text-slate-400 sm:col-span-3 text-center py-8">
                  No Leave balance has been set for you yet.
                </p>
              ) : (
                <>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Casual Leave</p>
                    <p className="text-2xl font-bold text-slate-900">{balance.casual_leave}</p>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Sick Leave</p>
                    <p className="text-2xl font-bold text-slate-900">{balance.sick_leave}</p>
                  </div>
                  <div className="bg-slate-50 border border-slate-200 rounded-xl p-4 text-center">
                    <p className="text-[11px] uppercase tracking-wider text-slate-500 mb-1">Leave without Pay</p>
                    <p className="text-2xl font-bold text-slate-900">{balance.leave_without_pay}</p>
                  </div>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
