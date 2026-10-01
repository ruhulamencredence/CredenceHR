/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { ChevronLeft, UserCircle2, Lock, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface ChangeUsernameFormProps {
  token: string;
  currentUsername: string;
  onBack: () => void;
  // Called once the change succeeds, with the new (already lowercased,
  // space-stripped) username, so the caller (ProfilePage -> App) can refresh
  // it everywhere user.username is shown/used, same idea as
  // PersonalDataForm's onSaved for the account's name.
  onSaved: (newUsername: string) => void;
}

// Self-service Change Username — reachable from ProfilePage's "Change
// Username" row, only shown for accounts that log in with a Project Name +
// Password instead of an email (see users.username in types.ts). Requires the
// current password to confirm, same as Change Password, since this is the
// credential used to log in (see PUT /api/profile/username in
// profileRoutes.ts).
export const ChangeUsernameForm: React.FC<ChangeUsernameFormProps> = ({ token, currentUsername, onBack, onSaved }) => {
  const [newUsername, setNewUsername] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    const trimmed = newUsername.trim();
    if (!trimmed) {
      setError('Enter a new username.');
      return;
    }
    if (!currentPassword) {
      setError('Enter your current password to confirm.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/profile/username'), {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ new_username: trimmed, current_password: currentPassword })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not change your username.');
      onSaved(json.username || trimmed.replace(/\s+/g, '').toLowerCase());
      onBack();
    } catch (err: any) {
      setError(err.message || 'Could not change your username.');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="w-full min-h-[calc(100vh-4rem)]" style={{ background: 'var(--g-surface-muted)' }}>
      <div className="max-w-lg mx-auto px-4 pt-3 pb-28">
        <div className="flex items-center gap-2 mb-3">
          <button
            type="button"
            onClick={onBack}
            className="w-9 h-9 rounded-full flex items-center justify-center hover:bg-black/5 transition-colors"
            style={{ color: 'var(--g-text-muted)' }}
            aria-label="Back"
          >
            <ChevronLeft className="w-5 h-5" />
          </button>
          <h1 className="text-base font-bold">Change Username</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-start gap-2 text-sm px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700 border border-rose-200">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <section className="gemini-card p-4">
            <p className="text-sm font-bold">Update Your Username</p>
            <p className="text-xs mb-4" style={{ color: 'var(--g-text-muted)' }}>
              This is the ID you log in with. Current: <span className="font-medium">{currentUsername}</span>
            </p>

            <div className="space-y-3">
              <Field label="New Username" icon={<UserCircle2 className="w-4 h-4" />}>
                <input
                  type="text"
                  value={newUsername}
                  onChange={(e) => setNewUsername(e.target.value)}
                  required
                  autoComplete="username"
                  className="profile-field-input"
                  placeholder="New Username"
                />
              </Field>
              <Field label="Current Password" icon={<Lock className="w-4 h-4" />}>
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="profile-field-input"
                  placeholder="Confirm with Current Password"
                />
              </Field>
            </div>
          </section>

          <div className="fixed bottom-0 left-0 right-0 p-4 bg-gradient-to-t from-white via-white/95 to-transparent">
            <div className="max-w-lg mx-auto">
              <button
                type="submit"
                disabled={saving}
                className="w-full py-3 rounded-full text-white text-sm font-semibold shadow-sm disabled:opacity-60 flex items-center justify-center gap-2"
                style={{ background: 'linear-gradient(90deg, #7F00FF, #6300C6)' }}
              >
                {saving && <Spinner size={16} className="text-white" />}
                Update Username
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; icon: React.ReactNode; children: React.ReactNode }> = ({ label, icon, children }) => (
  <div>
    <label className="text-xs mb-1 block" style={{ color: 'var(--g-text-muted)' }}>
      {label}
    </label>
    <div className="profile-field-box">
      <span className="shrink-0" style={{ color: 'var(--g-accent)' }}>
        {icon}
      </span>
      {children}
    </div>
  </div>
);
