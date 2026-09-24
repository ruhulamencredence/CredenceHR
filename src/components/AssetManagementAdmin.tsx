/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Asset Management — IT/Admin side: inventory (add/edit
// assets), the final approval queue (after a request clears the Line
// Manager step, or immediately if no manager is on file), and fulfilling an
// approved request by handing over a specific in-stock item. Gated behind
// the 'asset_management' AdminModuleKey the same way every other Admin
// Panel tab is (Admin Panel -> Users -> Module Access).
//
// NOT wired into AdminPanel.tsx yet — that file wasn't part of this export.
// See CHANGES_asset_management.md for the exact snippet to drop into it
// (a new tab entry + adding 'asset_management' to the AdminModuleKey union
// in types.ts).

import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';

interface Asset {
  id: number;
  asset_tag: string;
  name: string;
  category: string;
  serial_number: string | null;
  status: 'available' | 'assigned' | 'maintenance' | 'disposed';
  condition_note: string | null;
}

interface RequisitionItem {
  item_name: string;
  purpose: string;
  unit: string;
  quantity: number;
}

interface Requisition {
  id: number;
  employee_name: string;
  asset_category: string;
  reason: string;
  urgency: 'low' | 'medium' | 'high';
  status: 'pending' | 'manager_approved' | 'approved' | 'rejected' | 'dispatched' | 'fulfilled';
  manager_name: string | null;
  created_at: string;
  items: RequisitionItem[];
}

function authHeaders(): HeadersInit {
  const token = localStorage.getItem('mpr_token');
  return { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
}

export function AssetManagementAdmin() {
  const [tab, setTab] = useState<'inventory' | 'approvals'>('approvals');
  const [assets, setAssets] = useState<Asset[]>([]);
  const [requisitions, setRequisitions] = useState<Requisition[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [newAsset, setNewAsset] = useState({ asset_tag: '', name: '', category: '', serial_number: '' });
  const [fulfillFor, setFulfillFor] = useState<number | null>(null);
  const [fulfillAssetId, setFulfillAssetId] = useState<string>('');

  async function loadAssets() {
    try {
      const res = await fetch(apiUrl('/api/assets'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load inventory.');
      setAssets(data);
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function loadRequisitions() {
    try {
      const res = await fetch(apiUrl('/api/assets/requisitions'), { headers: authHeaders() });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to load requisitions.');
      setRequisitions(data);
    } catch (err: any) {
      setError(err.message);
    }
  }

  useEffect(() => {
    loadAssets();
    loadRequisitions();
  }, []);

  async function addAsset(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const res = await fetch(apiUrl('/api/assets'), { method: 'POST', headers: authHeaders(), body: JSON.stringify(newAsset) });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not add asset.');
      setNewAsset({ asset_tag: '', name: '', category: '', serial_number: '' });
      loadAssets();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function decide(id: number, decision: 'approve' | 'reject') {
    const rejection_reason = decision === 'reject' ? window.prompt('Reason for rejection?') || '' : undefined;
    try {
      const res = await fetch(apiUrl(`/api/assets/requisitions/${id}/admin-decision`), {
        method: 'PUT',
        headers: authHeaders(),
        body: JSON.stringify({ decision, rejection_reason })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not record decision.');
      loadRequisitions();
    } catch (err: any) {
      setError(err.message);
    }
  }

  async function fulfill(id: number) {
    if (!fulfillAssetId) return;
    try {
      const res = await fetch(apiUrl(`/api/assets/requisitions/${id}/fulfill`), {
        method: 'POST',
        headers: authHeaders(),
        body: JSON.stringify({ asset_id: Number(fulfillAssetId) })
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Could not fulfill request.');
      setFulfillFor(null);
      setFulfillAssetId('');
      loadRequisitions();
      loadAssets();
    } catch (err: any) {
      setError(err.message);
    }
  }

  const availableAssets = assets.filter((a) => a.status === 'available');

  return (
    <div className="w-full">
      <div className="flex gap-1 border-b border-gray-200 mb-4">
        {([
          ['approvals', 'Requisition Approvals'],
          ['inventory', 'Inventory']
        ] as const).map(([key, label]) => (
          <button
            key={key}
            onClick={() => setTab(key)}
            className={`px-4 py-2 text-sm font-medium border-b-2 -mb-px ${
              tab === key ? 'border-blue-600 text-blue-600' : 'border-transparent text-gray-500 hover:text-gray-800'
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {error && <div className="mb-3 rounded bg-red-50 text-red-700 text-sm px-3 py-2">{error}</div>}

      {tab === 'approvals' && (
        <div className="space-y-3">
          {requisitions.length === 0 && <div className="text-sm text-gray-500">No requisitions yet.</div>}
          {requisitions.map((r) => (
            <div key={r.id} className="border rounded-lg p-4">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-gray-800">
                  {r.employee_name} — {r.asset_category}
                </div>
                <span className="text-xs font-medium px-2 py-1 rounded bg-gray-100 text-gray-700">{r.status}</span>
              </div>
              <div className="text-xs text-gray-500 mt-1">
                Requested: {r.created_at} • Urgency: {r.urgency}
                {r.manager_name ? ` • Line Manager: ${r.manager_name}` : ' • No Line Manager on file'}
              </div>
              <div className="mt-2 space-y-1">
                {(r.items || []).map((it, idx) => (
                  <div key={idx} className="text-sm text-gray-600 flex items-baseline justify-between gap-2">
                    <span>
                      <span className="font-medium text-gray-800">{it.item_name}</span> — {it.purpose}
                    </span>
                    <span className="text-xs text-gray-500 shrink-0">
                      {it.quantity} {it.unit}
                    </span>
                  </div>
                ))}
              </div>

              {(r.status === 'pending' || r.status === 'manager_approved') && (
                <div className="flex gap-2 mt-3">
                  <button
                    onClick={() => decide(r.id, 'approve')}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-green-600 text-white hover:bg-green-700"
                  >
                    Approve
                  </button>
                  <button
                    onClick={() => decide(r.id, 'reject')}
                    className="px-3 py-1.5 text-xs font-medium rounded bg-red-600 text-white hover:bg-red-700"
                  >
                    Reject
                  </button>
                </div>
              )}

              {r.status === 'approved' && (
                <div className="mt-3">
                  {fulfillFor === r.id ? (
                    <div className="flex items-center gap-2">
                      <select value={fulfillAssetId} onChange={(e) => setFulfillAssetId(e.target.value)} className="border rounded px-2 py-1 text-xs">
                        <option value="">Pick an item…</option>
                        {(() => {
                          // A requisition can now list several items, so
                          // there's no single category to match inventory
                          // against — offer anything in stock whose
                          // category matches ANY requested item name first
                          // (most likely picks up top), then every other
                          // available item below, so IT/Admin can still
                          // hand over an asset that doesn't neatly match
                          // one of the item names as typed.
                          const requestedNames = (r.items || []).map((it) => it.item_name.toLowerCase());
                          const matching = availableAssets.filter((a) => requestedNames.includes(a.category.toLowerCase()));
                          const rest = availableAssets.filter((a) => !requestedNames.includes(a.category.toLowerCase()));
                          return (
                            <>
                              {matching.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name} ({a.asset_tag})
                                </option>
                              ))}
                              {rest.length > 0 && matching.length > 0 && <option disabled>──────────</option>}
                              {rest.map((a) => (
                                <option key={a.id} value={a.id}>
                                  {a.name} ({a.asset_tag})
                                </option>
                              ))}
                            </>
                          );
                        })()}
                      </select>
                      <button onClick={() => fulfill(r.id)} className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white">
                        Dispatch
                      </button>
                    </div>
                  ) : (
                    <button
                      onClick={() => setFulfillFor(r.id)}
                      className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white hover:bg-blue-700"
                    >
                      Fulfill / Hand Over
                    </button>
                  )}
                </div>
              )}
            </div>
          ))}
        </div>
      )}

      {tab === 'inventory' && (
        <div className="space-y-6">
          <form onSubmit={addAsset} className="grid grid-cols-4 gap-3 items-end max-w-3xl">
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Asset Tag</label>
              <input
                required
                value={newAsset.asset_tag}
                onChange={(e) => setNewAsset({ ...newAsset, asset_tag: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Name</label>
              <input
                required
                value={newAsset.name}
                onChange={(e) => setNewAsset({ ...newAsset, name: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-gray-700 mb-1">Category</label>
              <input
                required
                value={newAsset.category}
                onChange={(e) => setNewAsset({ ...newAsset, category: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
            </div>
            <div className="flex gap-2">
              <input
                placeholder="Serial No."
                value={newAsset.serial_number}
                onChange={(e) => setNewAsset({ ...newAsset, serial_number: e.target.value })}
                className="w-full border rounded px-2 py-1.5 text-sm"
              />
              <button type="submit" className="px-3 py-1.5 text-xs font-medium rounded bg-blue-600 text-white whitespace-nowrap">
                Add
              </button>
            </div>
          </form>

          <table className="w-full text-sm">
            <thead>
              <tr className="text-left text-xs text-gray-500 border-b">
                <th className="py-2">Tag</th>
                <th>Name</th>
                <th>Category</th>
                <th>Serial No.</th>
                <th>Status</th>
              </tr>
            </thead>
            <tbody>
              {assets.map((a) => (
                <tr key={a.id} className="border-b last:border-0">
                  <td className="py-2">{a.asset_tag}</td>
                  <td>{a.name}</td>
                  <td>{a.category}</td>
                  <td>{a.serial_number || '—'}</td>
                  <td>{a.status}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}