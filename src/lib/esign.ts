/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// E-Signature (ESignRoutes.ts) — shapes and calls shared by Document Vault,
// Self Service -> Documents to Sign and the public /verify page.

import { apiUrl } from './api';

export type SignStatus = 'none' | 'pending' | 'completed' | 'declined' | 'cancelled';
export interface ESignSigner {
  id: number;
  step: number;
  user_id: number;
  name: string;
  label: string | null;
  status: 'waiting' | 'pending' | 'signed' | 'declined' | 'cancelled';
  signed_name: string | null;
  signed_at: string | null;
  decline_reason: string | null;
}
export interface ESignDoc {
  id: number;
  doc_type: string;
  file_name: string;
  owner_id: number;
  owner_name: string | null;
  sign_status: SignStatus;
  placement: 'page' | 'last_page';
  verify_code: string | null;
  sha256: string | null;
  signed_sha256: string | null;
  requested_by: string | null;
  requested_at: string | null;
  completed_at: string | null;
  has_signed_file: boolean;
  signers: ESignSigner[];
  // Documents to Sign only:
  my_step?: number | null;
  my_status?: ESignSigner['status'] | null;
  my_turn?: boolean;
  i_read?: boolean;
  // E-Signature settings applied to this document.
  otp_required?: boolean;
  require_read?: boolean;
}

export async function esignFetch<T>(token: string | null, path: string, init?: { method?: string; body?: unknown }): Promise<T> {
  const res = await fetch(apiUrl(path), {
    method: init?.method || 'GET',
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(init?.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init?.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new Error(data?.error || `Request failed (${res.status})`);
  return data as T;
}

// Opens a protected file (the original or the signed PDF) in a new tab.
export async function openProtectedFile(token: string, path: string) {
  const win = window.open('', '_blank');
  const res = await fetch(apiUrl(path), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    win?.close();
    const j = await res.json().catch(() => null);
    throw new Error(j?.error || `Request failed (${res.status})`);
  }
  const url = URL.createObjectURL(await res.blob());
  if (win) win.location.href = url;
  else window.open(url, '_blank');
}

export const verifyLink = (code: string) => `${window.location.origin}/verify/${code}`;

export const STATUS_LABEL: Record<SignStatus, string> = {
  none: 'Not sent',
  pending: 'Out for signing',
  completed: 'Signed',
  declined: 'Declined',
  cancelled: 'Cancelled'
};
export const STATUS_CLS: Record<SignStatus, string> = {
  none: 'bg-slate-100 text-slate-600 border-slate-200',
  pending: 'bg-amber-50 text-amber-700 border-amber-200',
  completed: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  declined: 'bg-rose-50 text-rose-700 border-rose-200',
  cancelled: 'bg-slate-100 text-slate-500 border-slate-200'
};

// Always Bangladesh time, the same as on the signed PDF.
export const dhakaTime = (d: string | null) =>
  d ? new Date(d.includes('T') ? d : d.replace(' ', 'T')).toLocaleString('en-GB', { timeZone: 'Asia/Dhaka', day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true }) : '';

export const fileToBase64 = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result || '').split(',')[1] || '');
    r.onerror = reject;
    r.readAsDataURL(file);
  });
