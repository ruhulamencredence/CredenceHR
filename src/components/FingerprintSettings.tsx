/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Profile -> Fingerprint login: turn fingerprint sign-in on for this phone /
// computer, and see or remove the devices it is on (src/lib/fingerprint.ts,
// server FingerprintRoutes.ts). Only for accounts with can_use_fingerprint.

import React, { useCallback, useEffect, useState } from 'react';
import { Fingerprint, Loader2, Smartphone, Monitor, Trash2, CheckCircle2 } from 'lucide-react';
import { Capacitor } from '@capacitor/core';
import { MailPopup as Popup, primaryBtn, ghostBtn } from './mail/MailPopup';
import { confirmDialog } from '../lib/confirmDialog';
import { apiUrl } from '../lib/api';
import { APP_TOO_OLD, enableFingerprint, fingerprintDetails, fingerprintStatus, removeFingerprint, savedFingerprint } from '../lib/fingerprint';
import type { User } from '../types';

interface Device {
  id: number;
  kind: 'app' | 'passkey';
  label: string | null;
  created_at: string;
  last_used_at: string | null;
}

const workspaceCode = () => {
  try {
    return JSON.parse(localStorage.getItem('credence_workspace') || 'null')?.code || null;
  } catch {
    return null;
  }
};

export const FingerprintSettings: React.FC<{ token: string; user: User; onClose: () => void }> = ({ token, user, onClose }) => {
  const [devices, setDevices] = useState<Device[] | null>(null);
  const [status, setStatus] = useState<'ok' | 'app_old' | 'no_sensor' | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState('');
  const [details, setDetails] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');
  const [hereId, setHereId] = useState(() => savedFingerprint()?.id || 0);

  const load = useCallback(async () => {
    try {
      const res = await fetch(apiUrl('/api/auth/fingerprint'), { headers: { Authorization: `Bearer ${token}` } });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not load');
      setDevices(d.devices || []);
    } catch (e: any) {
      setError(e.message);
      setDevices([]);
    }
  }, [token]);
  useEffect(() => {
    void load();
    fingerprintStatus().then(setStatus);
    fingerprintDetails().then(setDetails);
  }, [load]);

  const onHere = !!hereId && !!devices?.some((d) => d.id === hereId);
  const turnOn = async () => {
    setBusy(true);
    setError('');
    setDone('');
    try {
      await enableFingerprint(token, user, workspaceCode(), setStep);
      setHereId(savedFingerprint()?.id || 0);
      setDone('Done — next time, tap "Sign in with fingerprint" on the sign-in screen.');
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (d: Device) => {
    const ok = await confirmDialog(`Remove fingerprint sign-in from "${d.label || 'this device'}"? It will need the password there next time.`, { tone: 'danger' });
    if (!ok) return;
    setBusy(true);
    setError('');
    try {
      await removeFingerprint(token, d.id);
      setHereId(savedFingerprint()?.id || 0);
      await load();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const app = Capacitor.isNativePlatform();
  return (
    <Popup title="Fingerprint login" icon={<Fingerprint className="w-4 h-4" />} size="md" onClose={busy ? () => {} : onClose} footer={<button type="button" className={ghostBtn} onClick={onClose} disabled={busy}>Close</button>}>
      <div className="space-y-4 text-left">
        <div className="liquid-glass-inset rounded-[24px] p-4 text-center space-y-3">
          <Fingerprint className="w-12 h-12 mx-auto text-sky-600" strokeWidth={1.5} />
          {onHere ? (
            <p className="text-sm text-slate-700 flex items-center justify-center gap-1.5">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" /> On for this {app ? 'phone' : 'browser'}
            </p>
          ) : status === 'app_old' ? (
            <p className="text-sm text-amber-800 bg-amber-50 rounded-xl px-3 py-2">{APP_TOO_OLD}</p>
          ) : status === 'no_sensor' ? (
            <p className="text-sm text-slate-600">
              {app ? "This phone has no fingerprint or face set up. Add one in the phone's Settings → Security, then come back." : "This browser / computer has no fingerprint, face or Windows Hello set up, so it can't be used here."}
            </p>
          ) : (
            <>
              <p className="text-sm text-slate-600">Sign in with your fingerprint{app ? '' : ' (or face / Windows Hello)'} instead of typing the password on this {app ? 'phone' : 'browser'}.</p>
              <button type="button" className={primaryBtn} onClick={() => void turnOn()} disabled={busy || status === null}>
                {busy && <Loader2 className="w-4 h-4 animate-spin" />} Turn on for this {app ? 'phone' : 'browser'}
              </button>
              {busy && <p className="text-xs text-slate-600">{app ? step || 'Starting…' : 'Follow your browser\'s fingerprint / Windows Hello window…'}</p>}
            </>
          )}
        </div>
        {done && <div className="text-xs px-3 py-2 rounded-xl bg-emerald-50 text-emerald-700">{done}</div>}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
        <div>
          <div className="text-xs font-medium text-slate-600 mb-1.5">Where it is on</div>
          {devices === null ? (
            <div className="text-xs text-slate-500 py-2">Loading…</div>
          ) : !devices.length ? (
            <div className="text-xs text-slate-500 py-2">Not on any device yet.</div>
          ) : (
            <div className="liquid-glass-inset rounded-[20px] divide-y divide-slate-200/70">
              {devices.map((d) => {
                const Icon = d.kind === 'app' ? Smartphone : Monitor;
                return (
                  <div key={d.id} className="flex items-center gap-3 px-3 py-2.5">
                    <Icon className="w-4 h-4 text-slate-500 shrink-0" />
                    <div className="flex-1 min-w-0">
                      <div className="text-sm text-slate-800 truncate">
                        {d.label || (d.kind === 'app' ? 'Phone' : 'Browser')}
                        {d.id === hereId && <span className="ml-1.5 text-[10px] font-semibold text-emerald-700">(this one)</span>}
                      </div>
                      <div className="text-[11px] text-slate-500">
                        Added {new Date(d.created_at).toLocaleDateString()}
                        {d.last_used_at ? ` · last used ${new Date(d.last_used_at).toLocaleDateString()}` : ''}
                      </div>
                    </div>
                    <button type="button" onClick={() => void remove(d)} disabled={busy} className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center text-rose-600" aria-label="Remove">
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                );
              })}
            </div>
          )}
        </div>
        {details && <p className="text-[10px] text-slate-400 break-words">{details}</p>}
        <p className="text-[11px] text-slate-500">
          Your fingerprint never leaves the {app ? 'phone' : 'device'} — the {app ? 'phone' : 'browser'} only confirms it's you. Changing your password turns fingerprint sign-in off everywhere.
        </p>
      </div>
    </Popup>
  );
};
