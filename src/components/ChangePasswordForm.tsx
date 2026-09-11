/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useState } from 'react';
import { ChevronLeft, Lock, AlertCircle, CheckCircle2 } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { Spinner } from './Spinner';

interface ChangePasswordFormProps {
  token: string;
  onBack: () => void;
}

// Self-service Change Password — reachable from ProfilePage's "Change
// Password" row. Unlike the Admin's "Reset Password" (Admin Panel -> Users),
// which needs no old password, this is the account holder changing their OWN
// password, so the Current Password is verified server-side first (see
// PUT /api/profile/password in profileRoutes.ts) before the new one is saved.
export const ChangePasswordForm: React.FC<ChangePasswordFormProps> = ({ token, onBack }) => {
  const [currentPassword, setCurrentPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState(false);

  const authHeaders = { Authorization: `Bearer ${token}` };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setSuccess(false);
    if (!currentPassword) {
      setError('Enter your current password.');
      return;
    }
    if (newPassword.length < 6) {
      setError('New password must be at least 6 characters.');
      return;
    }
    if (newPassword !== confirmPassword) {
      setError('New password and confirmation do not match.');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(apiUrl('/api/profile/password'), {
        method: 'PUT',
        headers: { ...authHeaders, 'Content-Type': 'application/json' },
        body: JSON.stringify({ current_password: currentPassword, new_password: newPassword })
      });
      const json = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(json.error || 'Could not change your password.');
      setSuccess(true);
      setCurrentPassword('');
      setNewPassword('');
      setConfirmPassword('');
    } catch (err: any) {
      setError(err.message || 'Could not change your password.');
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
          <h1 className="text-base font-bold">Change Password</h1>
        </div>

        <form onSubmit={handleSubmit} className="space-y-4">
          {error && (
            <div className="flex items-start gap-2 text-sm px-3 py-2.5 rounded-xl bg-rose-50 text-rose-700 border border-rose-200">
              <AlertCircle className="w-4 h-4 mt-0.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}
          {success && (
            <div className="flex items-start gap-2 text-sm px-3 py-2.5 rounded-xl bg-emerald-50 text-emerald-700 border border-emerald-200">
              <CheckCircle2 className="w-4 h-4 mt-0.5 shrink-0" />
              <span>Password changed successfully.</span>
            </div>
          )}

          <section className="gemini-card p-4">
            <p className="text-sm font-bold">Update Your Password</p>
            <p className="text-xs mb-4" style={{ color: 'var(--g-text-muted)' }}>
              Enter your current password, then choose a new one.
            </p>

            <div className="space-y-3">
              <Field label="Current Password">
                <input
                  type="password"
                  value={currentPassword}
                  onChange={(e) => setCurrentPassword(e.target.value)}
                  required
                  autoComplete="current-password"
                  className="profile-field-input"
                  placeholder="Current Password"
                />
              </Field>
              <Field label="New Password">
                <input
                  type="password"
                  value={newPassword}
                  onChange={(e) => setNewPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  className="profile-field-input"
                  placeholder="At least 6 characters"
                />
              </Field>
              <Field label="Confirm New Password">
                <input
                  type="password"
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                  autoComplete="new-password"
                  className="profile-field-input"
                  placeholder="Re-enter New Password"
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
                Update Password
              </button>
            </div>
          </div>
        </form>
      </div>
    </div>
  );
};

const Field: React.FC<{ label: string; children: React.ReactNode }> = ({ label, children }) => (
  <div>
    <label className="text-xs mb-1 block" style={{ color: 'var(--g-text-muted)' }}>
      {label}
    </label>
    <div className="profile-field-box">
      <Lock className="w-4 h-4 shrink-0" style={{ color: 'var(--g-accent)' }} />
      {children}
    </div>
  </div>
);
