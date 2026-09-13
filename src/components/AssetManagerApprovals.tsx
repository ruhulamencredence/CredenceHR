/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Line Manager approval queue for Asset Requisitions — deliberately separate
// from AssetManagementAdmin.tsx: this is NOT gated behind the
// 'asset_management' AdminModuleKey. Any account that is someone's direct
// Supervisor (Employee Directory -> Supervisor tab) sees their
// subordinates' pending requests here, whether or not they're an Admin.
// Renders nothing if the account has no one reporting to them.
//
// NOT wired into the app shell yet — suggested spot: Self Service header
// menu, next to Leave Approvals. See CHANGES_asset_management.md.

import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';

interface Requisition {
  id: number;
  employee_name: string;
  asset_category: string;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
  created_at: string;
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export function AssetManagerApprovals() {
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [error, setError] = useState<string | null>(null);

  async function load() {
    try {
      const res = await fetch(apiUrl('/api/assets/requisitions/for-manager-approval'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load approvals.');
      setRequisitions(data);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    load();
  }, []);

  async function decide(id: number, decision: 'approve' | 'reject') {
    const remarks = window.prompt(decision === 'reject' ? 'Reason for rejection?' : 'Any remarks? (optional)') || '';
    try {
      const res = await fetch(apiUrl(`/api/assets/requisitions/${id}/manager-decision`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ decision, remarks })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not record decision.');
      load();
    } catch (err: any) {
      setError(err.message);
    }
  }

  if (!error && requisitions.length === 0) return null;

  return (
    <div className="w-full">
      <h3 className="text-sm font-semibold text-gray-700 mb-3">Asset Requisitions Awaiting Your Approval</h3>
      {error && <div className="mb-3 rounded bg-red-50 text-red-700 text-sm px-3 py-2">{error}</div>}
      <div className="space-y-3">
        {requisitions.map((r) => (
          <div key={r.id} className="border rounded-lg p-4">
            <div className="flex items-center justify-between">
              <div className="font-semibold text-gray-800">
                {r.employee_name} — {r.asset_category}
              </div>
              <span className="text-xs font-medium px-2 py-1 rounded bg-yellow-100 text-yellow-800">{r.urgency}</span>
            </div>
            <div className="text-xs text-gray-500 mt-1">Requested: {r.created_at}</div>
            <div className="text-sm text-gray-600 mt-2">{r.reason}</div>
            <div className="flex gap-2 mt-3">
              <button onClick={() => decide(r.id, 'approve')} className="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700">
                Approve
              </button>
              <button onClick={() => decide(r.id, 'reject')} className="px-3 py-1.5 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700">
                Reject
              </button>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
