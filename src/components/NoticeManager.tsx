import React, { useState, useEffect, useCallback } from 'react';
import { Lottie } from 'lottie-react';
import {
  Bell, Plus, Trash2, Edit2, X, Eye, EyeOff, Sparkles,
  Users as UsersIcon, Globe, AlertCircle
} from 'lucide-react';
import { Notice, NoticeRecipient, User } from '../types';
import { apiUrl } from '../lib/api';
import { formatDate } from '../lib/formatDate';
import { Spinner } from './Spinner';

interface NoticeManagerProps {
  token: string;
  user: User;
}

interface NoticeFormState {
  title: string;
  content_html: string;
  lottie_json: string;
  lottie_url: string;
  target_type: 'all' | 'specific';
  target_user_ids: number[];
  is_active: boolean;
}

const emptyForm: NoticeFormState = {
  title: '',
  content_html: '',
  lottie_json: '',
  lottie_url: '',
  target_type: 'all',
  target_user_ids: [],
  is_active: true
};

// Best-effort parse of whatever is in the Lottie JSON textarea, purely for the
// live preview here — the server does its own validation on save, this is just
// so the Admin sees immediately if what they pasted is broken.
function tryParseLottie(text: string): any | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    return JSON.parse(trimmed);
  } catch {
    return null;
  }
}

export const NoticeManager: React.FC<NoticeManagerProps> = ({ token, user }) => {
  const [notices, setNotices] = useState<Notice[]>([]);
  const [recipients, setRecipients] = useState<NoticeRecipient[]>([]);
  const [loading, setLoading] = useState(true);
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null);

  const [showForm, setShowForm] = useState(false);
  const [editingId, setEditingId] = useState<number | null>(null);
  const [form, setForm] = useState<NoticeFormState>(emptyForm);
  const [saving, setSaving] = useState(false);
  const [recipientSearch, setRecipientSearch] = useState('');
  const [deletingId, setDeletingId] = useState<number | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const fetchAll = useCallback(async () => {
    setLoading(true);
    try {
      const [noticesRes, recipientsRes] = await Promise.all([
        fetch(apiUrl('/api/notices'), { headers: authHeaders }),
        fetch(apiUrl('/api/notices/recipients'), { headers: authHeaders })
      ]);
      if (noticesRes.ok) setNotices(await noticesRes.json());
      if (recipientsRes.ok) setRecipients(await recipientsRes.json());
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

  const openCreateForm = () => {
    setEditingId(null);
    setForm(emptyForm);
    setRecipientSearch('');
    setShowForm(true);
  };

  const openEditForm = (n: Notice) => {
    setEditingId(n.id);
    setForm({
      title: n.title,
      content_html: n.content_html,
      lottie_json: n.lottie_json ? formatMaybeJson(n.lottie_json) : '',
      lottie_url: n.lottie_url || '',
      target_type: n.target_type,
      target_user_ids: n.target_user_ids || [],
      is_active: n.is_active
    });
    setRecipientSearch('');
    setShowForm(true);
  };

  function formatMaybeJson(raw: string): string {
    try {
      return JSON.stringify(JSON.parse(raw), null, 2);
    } catch {
      return raw;
    }
  }

  const closeForm = () => {
    setShowForm(false);
    setEditingId(null);
    setForm(emptyForm);
  };

  const toggleTargetUser = (id: number) => {
    setForm((f) => ({
      ...f,
      target_user_ids: f.target_user_ids.includes(id)
        ? f.target_user_ids.filter((x) => x !== id)
        : [...f.target_user_ids, id]
    }));
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.title.trim()) return setMessage({ type: 'error', text: 'Please give the notice a title.' });
    if (!form.content_html.trim()) return setMessage({ type: 'error', text: 'Please write the notice message (text or HTML).' });
    if (form.target_type === 'specific' && form.target_user_ids.length === 0) {
      return setMessage({ type: 'error', text: 'Pick at least one user, or switch to "All Users".' });
    }
    if (form.lottie_json.trim() && !tryParseLottie(form.lottie_json)) {
      return setMessage({ type: 'error', text: "The pasted Lottie animation isn't valid JSON." });
    }

    setSaving(true);
    try {
      const payload = {
        title: form.title.trim(),
        content_html: form.content_html,
        lottie_json: form.lottie_json.trim() || null,
        lottie_url: form.lottie_url.trim() || null,
        target_type: form.target_type,
        target_user_ids: form.target_type === 'specific' ? form.target_user_ids : [],
        is_active: form.is_active
      };
      const url = editingId ? apiUrl(`/api/notices/${editingId}`) : apiUrl('/api/notices');
      const res = await fetch(url, {
        method: editingId ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify(payload)
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || 'Failed to save notice');

      setMessage({ type: 'success', text: editingId ? 'Notice updated.' : 'Notice created and sent to users.' });
      closeForm();
      fetchAll();
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setSaving(false);
    }
  };

  const handleToggleActive = async (n: Notice) => {
    try {
      const res = await fetch(apiUrl(`/api/notices/${n.id}/active`), {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', ...authHeaders },
        body: JSON.stringify({ is_active: !n.is_active })
      });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to update');
      setNotices((prev) => prev.map((x) => (x.id === n.id ? { ...x, is_active: !n.is_active } : x)));
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    }
  };

  const handleDelete = async (id: number) => {
    if (!confirm('Delete this notice? This cannot be undone.')) return;
    setDeletingId(id);
    try {
      const res = await fetch(apiUrl(`/api/notices/${id}`), { method: 'DELETE', headers: authHeaders });
      if (!res.ok) throw new Error((await res.json()).error || 'Failed to delete');
      setNotices((prev) => prev.filter((n) => n.id !== id));
      setMessage({ type: 'success', text: 'Notice deleted.' });
    } catch (err: any) {
      setMessage({ type: 'error', text: err.message || 'Something went wrong' });
    } finally {
      setDeletingId(null);
    }
  };

  const filteredRecipients = recipients.filter((r) => {
    const q = recipientSearch.trim().toLowerCase();
    if (!q) return true;
    return (
      r.name.toLowerCase().includes(q) ||
      (r.email || '').toLowerCase().includes(q) ||
      (r.username || '').toLowerCase().includes(q)
    );
  });

  const previewLottieData = tryParseLottie(form.lottie_json);

  return (
    <div className="space-y-5">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div>
          <h3 className="text-lg font-bold text-slate-900 flex items-center gap-2">
            <Bell className="w-5 h-5 text-blue-600" />
            Notices
          </h3>
          <p className="text-xs text-slate-500 mt-0.5">
            Compose a popup — text/HTML plus an optional custom Lottie animation — that shows to Users right after they log in.
          </p>
        </div>
        <button
          type="button"
          onClick={openCreateForm}
          className="flex items-center justify-center gap-1.5 py-2 px-4 bg-blue-600 hover:bg-blue-700 text-white font-semibold rounded-xl shadow-sm transition-all text-sm whitespace-nowrap"
        >
          <Plus className="w-4 h-4" /> New Notice
        </button>
      </div>

      {message && (
        <div className={`p-3.5 rounded-xl border flex items-center justify-between text-sm ${
          message.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-800'
        }`}>
          <span>{message.text}</span>
          <button onClick={() => setMessage(null)} className="text-xs underline opacity-70 hover:opacity-100">Dismiss</button>
        </div>
      )}

      {/* --- List --- */}
      {loading ? (
        <div className="flex items-center justify-center py-16 text-slate-400 gap-2 text-sm">
          <Spinner size={16} /> Loading notices…
        </div>
      ) : notices.length === 0 ? (
        <div className="bg-white border border-dashed border-slate-300 rounded-2xl p-10 text-center">
          <Bell className="w-8 h-8 text-slate-300 mx-auto mb-2" />
          <p className="text-sm text-slate-500">No notices yet. Create one to reach your users right after they sign in.</p>
        </div>
      ) : (
        <div className="grid gap-3">
          {notices.map((n) => (
            <div key={n.id} className="bg-white border border-slate-200 rounded-2xl shadow-sm p-4 sm:p-5">
              <div className="flex flex-col sm:flex-row sm:items-start justify-between gap-3">
                <div className="flex items-start gap-3 min-w-0">
                  <div className={`shrink-0 w-9 h-9 rounded-xl flex items-center justify-center ${n.is_active ? 'bg-blue-50 text-blue-600' : 'bg-slate-100 text-slate-400'}`}>
                    {(n.lottie_json || n.lottie_url) ? <Sparkles className="w-4.5 h-4.5" /> : <Bell className="w-4.5 h-4.5" />}
                  </div>
                  <div className="min-w-0">
                    <div className="flex items-center gap-2 flex-wrap">
                      <h4 className="font-semibold text-slate-900 text-sm truncate">{n.title}</h4>
                      <span className={`px-2 py-0.5 rounded-full text-[10px] font-semibold ${n.is_active ? 'bg-emerald-50 text-emerald-700 border border-emerald-200' : 'bg-slate-100 text-slate-500 border border-slate-200'}`}>
                        {n.is_active ? 'Active' : 'Paused'}
                      </span>
                      <span className="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-slate-50 text-slate-600 border border-slate-200 flex items-center gap-1">
                        {n.target_type === 'all' ? <Globe className="w-2.5 h-2.5" /> : <UsersIcon className="w-2.5 h-2.5" />}
                        {n.target_type === 'all' ? 'All Users' : `${n.target_users?.length || 0} selected user${(n.target_users?.length || 0) === 1 ? '' : 's'}`}
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 mt-1 line-clamp-2 break-words">
                      {n.content_html.replace(/<[^>]+>/g, ' ').trim().slice(0, 160) || '—'}
                    </p>
                    <p className="text-[11px] text-slate-400 mt-1.5">
                      {n.created_by_name ? `By ${n.created_by_name} · ` : ''}{n.created_at ? formatDate(n.created_at) : ''}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-1 shrink-0 self-end sm:self-start">
                  <button
                    type="button"
                    onClick={() => handleToggleActive(n)}
                    className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                    title={n.is_active ? 'Pause (hide from users)' : 'Activate (show to users)'}
                  >
                    {n.is_active ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                  </button>
                  <button
                    type="button"
                    onClick={() => openEditForm(n)}
                    className="p-2 text-slate-400 hover:text-blue-600 hover:bg-blue-50 rounded-lg transition-colors"
                    title="Edit"
                  >
                    <Edit2 className="w-4 h-4" />
                  </button>
                  <button
                    type="button"
                    onClick={() => handleDelete(n.id)}
                    disabled={deletingId === n.id}
                    className="p-2 text-slate-400 hover:text-rose-600 hover:bg-rose-50 rounded-lg transition-colors disabled:opacity-50"
                    title="Delete"
                  >
                    <Trash2 className="w-4 h-4" />
                  </button>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* --- Create / Edit Modal --- */}
      {showForm && (
        <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-4">
          <div className="bg-white rounded-2xl max-w-3xl w-full max-h-[92vh] overflow-y-auto shadow-2xl">
            <div className="p-5 border-b border-slate-200 flex items-center justify-between sticky top-0 bg-white z-10 rounded-t-2xl">
              <h3 className="text-base font-bold text-slate-900 flex items-center gap-2">
                <Bell className="w-4.5 h-4.5 text-blue-600" />
                {editingId ? 'Edit Notice' : 'New Notice'}
              </h3>
              <button onClick={closeForm} className="p-1.5 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors">
                <X className="w-4.5 h-4.5" />
              </button>
            </div>

            <form onSubmit={handleSubmit} className="p-5 space-y-5">
              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">Title</label>
                <input
                  type="text"
                  required
                  value={form.title}
                  onChange={(e) => setForm((f) => ({ ...f, title: e.target.value }))}
                  placeholder="e.g. Scheduled maintenance this weekend"
                  className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none"
                />
              </div>

              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                  Message (plain text or HTML)
                </label>
                <textarea
                  required
                  value={form.content_html}
                  onChange={(e) => setForm((f) => ({ ...f, content_html: e.target.value }))}
                  rows={5}
                  placeholder={'Write your announcement here. Basic HTML like <b>, <br>, <a href="...">, <ul><li> is supported.'}
                  className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm font-mono focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                />
                {form.content_html.trim() && (
                  <div className="mt-2 p-3 rounded-xl border border-slate-200 bg-slate-50">
                    <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1.5">Preview</p>
                    <div
                      className="text-sm text-slate-800 prose-sm max-w-none [&_a]:text-blue-600 [&_a]:underline"
                      dangerouslySetInnerHTML={{ __html: form.content_html }}
                    />
                  </div>
                )}
              </div>

              <div className="grid sm:grid-cols-2 gap-4">
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                    Custom Lottie animation — paste JSON (optional)
                  </label>
                  <textarea
                    value={form.lottie_json}
                    onChange={(e) => setForm((f) => ({ ...f, lottie_json: e.target.value }))}
                    rows={5}
                    placeholder='{"v":"5.7.0","fr":30, ...}'
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-xs font-mono focus:ring-2 focus:ring-blue-600 focus:outline-none placeholder-slate-400"
                  />
                  {form.lottie_json.trim() && !previewLottieData && (
                    <p className="mt-1 text-[11px] text-rose-600 flex items-center gap-1">
                      <AlertCircle className="w-3 h-3" /> Not valid JSON yet.
                    </p>
                  )}
                </div>
                <div>
                  <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-1">
                    Or a hosted Lottie URL (optional)
                  </label>
                  <input
                    type="text"
                    value={form.lottie_url}
                    onChange={(e) => setForm((f) => ({ ...f, lottie_url: e.target.value }))}
                    placeholder="https://example.com/animation.json"
                    disabled={!!form.lottie_json.trim()}
                    className="block w-full px-3 py-2.5 bg-slate-50 border border-slate-200 rounded-xl text-slate-900 text-sm focus:ring-2 focus:ring-blue-600 focus:outline-none disabled:opacity-50 disabled:cursor-not-allowed"
                  />
                  <p className="mt-1 text-[11px] text-slate-400">
                    {form.lottie_json.trim() ? 'Pasted JSON above will be used instead of a URL.' : 'Used only if no JSON is pasted on the left.'}
                  </p>
                  {(previewLottieData || form.lottie_url.trim()) && (
                    <div className="mt-2 w-24 h-24 mx-auto bg-slate-50 border border-slate-200 rounded-xl p-2">
                      <Lottie src={previewLottieData || form.lottie_url.trim()} autoplay loop className="w-full h-full" />
                    </div>
                  )}
                </div>
              </div>

              <div>
                <label className="block text-[11px] font-semibold uppercase tracking-wider text-slate-600 mb-2">Send to</label>
                <div className="flex gap-2 mb-3">
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, target_type: 'all' }))}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold border transition-all ${
                      form.target_type === 'all' ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <Globe className="w-3.5 h-3.5" /> All Users
                  </button>
                  <button
                    type="button"
                    onClick={() => setForm((f) => ({ ...f, target_type: 'specific' }))}
                    className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-3 rounded-xl text-xs font-semibold border transition-all ${
                      form.target_type === 'specific' ? 'bg-blue-600 border-blue-600 text-white' : 'bg-white border-slate-200 text-slate-600 hover:bg-slate-50'
                    }`}
                  >
                    <UsersIcon className="w-3.5 h-3.5" /> Specific Users
                  </button>
                </div>

                {form.target_type === 'specific' && (
                  <div className="border border-slate-200 rounded-xl overflow-hidden">
                    <input
                      type="text"
                      value={recipientSearch}
                      onChange={(e) => setRecipientSearch(e.target.value)}
                      placeholder="Search users…"
                      className="block w-full px-3 py-2 text-xs border-b border-slate-200 focus:outline-none"
                    />
                    <div className="max-h-48 overflow-y-auto divide-y divide-slate-100">
                      {filteredRecipients.length === 0 ? (
                        <p className="text-xs text-slate-400 p-3">No users found.</p>
                      ) : (
                        filteredRecipients.map((r) => (
                          <label key={r.id} className="flex items-center gap-2.5 px-3 py-2 hover:bg-slate-50 cursor-pointer text-sm">
                            <input
                              type="checkbox"
                              checked={form.target_user_ids.includes(r.id)}
                              onChange={() => toggleTargetUser(r.id)}
                              className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                            />
                            <span className="text-slate-800">{r.name}</span>
                            <span className="text-slate-400 text-xs">{r.email || r.username || ''}</span>
                          </label>
                        ))
                      )}
                    </div>
                    <div className="px-3 py-2 bg-slate-50 text-[11px] text-slate-500">
                      {form.target_user_ids.length} user{form.target_user_ids.length === 1 ? '' : 's'} selected
                    </div>
                  </div>
                )}
              </div>

              <label className="flex items-center gap-2.5 text-sm text-slate-700 cursor-pointer">
                <input
                  type="checkbox"
                  checked={form.is_active}
                  onChange={(e) => setForm((f) => ({ ...f, is_active: e.target.checked }))}
                  className="rounded border-slate-300 text-blue-600 focus:ring-blue-500"
                />
                Active — show to users immediately after saving
              </label>

              <div className="flex items-center justify-end gap-2 pt-2 border-t border-slate-100">
                <button
                  type="button"
                  onClick={closeForm}
                  className="px-4 py-2.5 text-sm font-semibold text-slate-600 hover:bg-slate-100 rounded-xl transition-colors"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={saving}
                  className="px-5 py-2.5 bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold rounded-xl shadow-sm transition-all disabled:opacity-50"
                >
                  {saving ? 'Saving…' : editingId ? 'Save Changes' : 'Create Notice'}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
};
