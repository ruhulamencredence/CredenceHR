/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, Banknote, Clock } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { ModulePath } from './ModulePath';

interface PayrollModuleProps {
  token: string;
  onBack: () => void;
}

// "Self Service" -> "Payroll" — brand new module, Coming Soon placeholder
// while the actual Payroll workflow (salary structure, payslips, etc.) gets
// designed. Backend split out into its own file from day one (PayrollRoutes.ts,
// registered in server.ts) the same way Leave/Attendance/Conveyance are, so
// later Payroll routes just get added there without touching server.ts again.
// The one endpoint that exists so far (GET /api/payroll/status) is just
// pinged here to confirm the module is wired end-to-end — nothing else to
// show yet.
export const PayrollModule: React.FC<PayrollModuleProps> = ({ token, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();

  useEffect(() => {
    // Fire-and-forget — just confirms the module is wired end-to-end.
    // Coming Soon either way, so no loading/error state to show for this.
    fetch(apiUrl('/api/payroll/status'), {
      headers: { Authorization: `Bearer ${token}` }
    }).catch(() => {});
  }, [token]);

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] bg-[#dceeff] text-slate-900">
      <div className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8">
        {!isNativeApp && (
          <>
            <ModulePath path={['Self Service', 'Payroll']} />
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
              <Banknote className="w-5 h-5 text-blue-600" />
            </div>
            <div>
              <h1 className="text-lg font-semibold text-slate-800">Payroll</h1>
              <p className="text-xs text-slate-500 mt-0.5 max-w-md">
                Salary structure, payslips, and disbursement — all in one place.
              </p>
            </div>
          </div>

          <div className="flex flex-col items-center justify-center text-center px-6 py-16">
            <div className="w-14 h-14 rounded-full bg-blue-50 flex items-center justify-center mb-4">
              <Clock className="w-7 h-7 text-blue-600" />
            </div>
            <h2 className="text-base font-semibold text-slate-800">Coming Soon</h2>
            <p className="text-sm text-slate-500 mt-1.5 max-w-sm">
              The Payroll module is on its way. This space will show your salary details, payslips, and more once it's ready.
            </p>
          </div>
        </div>
      </div>
    </div>
  );
};
