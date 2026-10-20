/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Small shared bits for admin pages: a JSON API helper, button classes and a
// dismissible notice line.

import React, { useMemo } from 'react';
import { X } from 'lucide-react';
import { apiUrl } from '../lib/api';

export function useHrApi(token: string) {
  return useMemo(() => {
    const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
    const call = async <T = any,>(method: string, path: string, body?: any): Promise<T> => {
      const res = await fetch(apiUrl(path), { method, headers, body: body !== undefined ? JSON.stringify(body) : undefined });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || `Request failed (${res.status})`);
      return data as T;
    };
    return {
      get: <T = any,>(path: string) => call<T>('GET', path),
      post: <T = any,>(path: string, body?: any) => call<T>('POST', path, body ?? {}),
      put: <T = any,>(path: string, body?: any) => call<T>('PUT', path, body ?? {}),
      del: <T = any,>(path: string, body?: any) => call<T>('DELETE', path, body)
    };
  }, [token]);
}

export const btnPrimary = 'inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3.5 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-50 transition-colors';
export const btnGhost = 'inline-flex items-center justify-center gap-1.5 text-xs font-semibold px-3 py-2 rounded-lg border border-slate-200 text-slate-700 bg-white hover:bg-slate-50 disabled:opacity-50 transition-colors';

export const Notice: React.FC<{ msg: { type: 'success' | 'error'; text: string } | null; onClose?: () => void }> = ({ msg, onClose }) =>
  msg ? (
    <div className={`flex items-start justify-between gap-2 text-xs px-3 py-2 rounded-lg border ${msg.type === 'success' ? 'bg-emerald-50 border-emerald-200 text-emerald-800' : 'bg-rose-50 border-rose-200 text-rose-700'}`}>
      <span>{msg.text}</span>
      {onClose && (
        <button type="button" onClick={onClose} aria-label="Dismiss" className="opacity-60 hover:opacity-100">
          <X className="w-3.5 h-3.5" />
        </button>
      )}
    </div>
  ) : null;
