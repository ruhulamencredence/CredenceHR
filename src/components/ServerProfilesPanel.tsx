/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState, useEffect, useCallback } from 'react';
import { Server, Plus, Trash2, Edit2, X } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface ServerProfilesPanelProps {
  token: string;
}

interface ServerProfileRow {
  id: number;
  name: string;
  url: string;
  created_at?: string;
  updated_at?: string;
}

interface FormState {
  name: string;
  url: string;
}

const emptyForm: FormState = { name: '', url: '' };

// Admin Panel -> Servers (Superadmin-only, see GlobalSidebar's "Servers" item
// and ServerProfileRoutes.ts). This is the WEB-side management surface for
// the catalog of backend deployments (Head Office, a specific client site, a
// test server, ...) the Android APK build can switch between — a Superadmin
// adds/edits/removes entries here (from any browser), and the Android app's
// own GlobalSidebar "Server" switcher (native-app-only) just fetches this
// same list afterward and lets the device pick which one is active. Nothing
// here changes what server THIS web session itself talks to — the web build
// always just uses its own relative "/api/..." origin.
export const ServerProfilesPanel: React.FC<ServerProfilesPanelProps> = ({ token }) => {
  const [rows, setRows] = useState<ServerProfileRow[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<FormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch(apiUrl('/api/server-profiles'), { headers: authHeaders });
      if (res.ok) setRows(await res.json());
    } catch {
      setMessage({ type: 'error', text: "Couldn't reach the server. Please try again." });
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [token]);

  useEffect(() => {
    fetchAll();
  }, [fetchAll]);

  useEffect(() => {
    if (!message) return;
    const t = setTimeout(() => setMessage(null), 4000);
    return () => clearTimeout(t);
  }, [message]);

  const openAddForm = () => {
    setEditingId(null);
    setForm(emptyForm);
    setShowForm(true);
  };

  const openEditForm = (row: ServerProfileRow) => {
    setEditingId(row.id);
    setForm({ name: row.name, url: row.url });
    setShowForm(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) {
      setMessage({ type: 'error', text: 'Please enter a name for this server.' });
      return;
    }
    if (!form.url.trim()) {
      setMessage({ type: 'error', text: 'Please enter an IP/URL for this server.' });
      return;
    }
    setSaving(true);
    try {
      const url = editingId ? apiUrl(`/api/server-profiles/${editingId}`) : apiUrl('/api/server-profiles');
      const method = editingId ? 'PUT' : 'POST';
      const res = await fetch(url, {
        method,
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify(form)
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setMessage({ type: 'error', text: data.error || 'Could not save this server.' });
        return;
      }
      setMessage({ type: 'success', text: editingId ? 'Server updated.' : 'Server added.' });
      setShowForm(false);
      setForm(emptyForm);
      setEditingId(null);
      fetchAll();
    } catch {
      setMessage({ type: 'error', text: "Couldn't reach the server. Please try again." });
    } finally {
      setSaving(false);
    }
  };

  const handleDelete = async (id: number) => {
    if (!window.confirm('Remove this server from the list? Any Android device currently set to it will stay pointed there until switched.')) return;
    setDeletingId(id);
    try {
      const res = await fetch(apiUrl(`/api/server-profiles/${id}`), { method: 'DELETE', headers: authHeaders });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setMessage({ type: 'error', text: data.error || 'Could not remove this server.' });
        return;
      }
      setRows((prev) => prev.filter((r) => r.id !== id));
      setMessage({ type: 'success', text: 'Server removed.' });
    } catch {
      setMessage({ type: 'error', text: "Couldn't reach the server. Please try again." });
    } finally {
      setDeletingId(null);
    }
  };

  const Row: React.FC<{ row: ServerProfileRow }> = ({ row }) => (
    <div className="flex items-center justify-between gap-3 border border-slate-200 rounded-xl p-3.5 hover:bg-slate-50 transition-colors">
      <div className="flex items-center gap-3 min-w-0">
        <span className="w-9 h-9 rounded-lg flex items-center justify-center shrink-0 bg-violet-50 text-violet-600">
          <Server className="w-4 h-4" />
        </span>
        <div className="min-w-0">
          <p className="text-sm font-semibold text-slate-900 truncate">{row.name}</p>
          <p className="text-xs text-slate-500 truncate">{row.url}</p>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0">
        <button
          type="button"
          onClick={() => openEditForm(row)}
          className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
          title="Edit"
        >
          <Edit2 className="w-3.5 h-3.5" />
        </button>
        <button
          type="button"
          onClick={() => handleDelete(row.id)}
          disabled={deletingId === row.id}
          className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
          title="Remove"
        >
          <Trash2 className="w-3.5 h-3.5" />
        </button>
      </div>
    </div>
  );

  return (
    <div>
      <div className="flex flex-wrap items-center justify-between gap-3 mb-5">
        <div>
          <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
            <Server className="w-5 h-5 text-blue-600" /> Servers
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            The catalog of backend deployments (IP/URL) the Android app can switch between after login —
            managed here, applied on each device from its own Sidebar.
          </p>
        </div>
        <button
          type="button"
          onClick={openAddForm}
          className="flex items-center gap-1.5 px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition-colors"
        >
          <Plus className="w-4 h-4" /> Add Server
        </button>
      </div>

      {message && (
        <div
          className={`mb-4 text-sm p-3 rounded-xl ${
            message.type === 'success' ? 'bg-emerald-50 text-emerald-700' : 'bg-rose-50 text-rose-700'
          }`}
        >
          {message.text}
        </div>
      )}

      {showForm && (
        <div className="mb-5 bg-white border border-slate-200 rounded-2xl p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h4 className="text-sm font-bold text-slate-900">{editingId ? 'Edit Server' : 'Add New Server'}</h4>
            <button type="button" onClick={() => setShowForm(false)} className="p-1 text-slate-400 hover:text-slate-700">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">Name</label>
              <input
                type="text"
                value={form.name}
                onChange={(e) => setForm((f) => ({ ...f, name: e.target.value }))}
                placeholder="e.g. Head Office"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold uppercase tracking-wider text-slate-700 mb-1">IP / URL</label>
              <input
                type="text"
                value={form.url}
                onChange={(e) => setForm((f) => ({ ...f, url: e.target.value }))}
                placeholder="e.g. 192.168.0.10:3000 or https://myserver.com"
                className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
          </div>
          <div className="flex justify-end gap-2 mt-4">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-slate-600 hover:bg-slate-100 transition-colors"
            >
              Cancel
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={saving}
              className="px-4 py-2 rounded-xl text-sm font-semibold text-white bg-blue-600 hover:bg-blue-700 transition-colors disabled:opacity-50"
            >
              {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Add Server'}
            </button>
          </div>
        </div>
      )}

      {loading ? (
        <div className="flex justify-center py-10">
          <Spinner />
        </div>
      ) : rows.length === 0 ? (
        <div className="text-center py-10 text-sm text-slate-400">No servers added yet.</div>
      ) : (
        <div className="space-y-2">
          {rows.map((row) => (
            <Row key={row.id} row={row} />
          ))}
        </div>
      )}
    </div>
  );
};
