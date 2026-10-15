/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail (Self Service, users.can_use_mail) — the shapes the
// /api/mail/* routes (MailRoutes.ts) return, and one small fetch helper.

import { apiUrl } from './api';

export interface MailAccount {
  id: number;
  emailAddress: string;
  name: string;
  provider: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  isDefault: boolean;
  isConnected: boolean;
  lastSyncAt: string | null;
  lastError: string | null;
}

export interface MailAttachment {
  idx: number;
  name: string;
  type: string;
  size: number;
}

export interface MailMessage {
  id: string;
  accountId: number;
  threadId: string;
  from: { name: string; email: string };
  to: string[];
  cc: string[];
  bcc: string[];
  subject: string;
  body?: string;
  snippet: string;
  date: string | null;
  isRead: boolean;
  isStarred: boolean;
  isImportant: boolean;
  isDraft: boolean;
  labels: string[];
  category: string;
  attachments: MailAttachment[];
  hasAttachments: boolean;
  scheduledSendTime: string | null;
  sendError: string | null;
  messageId: string | null;
}

export interface MailList {
  items: MailMessage[];
  total: number;
  unread: number;
  page: number;
  limit: number;
}

export interface MailCounts {
  inboxUnread: number;
  spamUnread: number;
  drafts: number;
  scheduled: number;
  starred: number;
}

export interface MailStatus {
  enabled: boolean;
  serverReady: boolean;
  accounts: MailAccount[];
}

export interface MailSignature {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
}

export interface MailSettings {
  signatures: MailSignature[];
  vacationResponder: { enabled: boolean; subject: string; message: string; startDate?: string; endDate?: string };
  blockedSenders: string[];
  layout: any;
  language: string;
  timezone: string;
}

export interface AddressSuggestion {
  name: string;
  email: string;
  source: 'contact' | 'colleague' | 'recent';
}

export interface OutgoingFile {
  name: string;
  type: string;
  dataUrl: string;
}

export class MailApiError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}

export async function mailFetch<T = any>(token: string, path: string, init: { method?: string; body?: any } = {}): Promise<T> {
  const res = await fetch(apiUrl(`/api/mail${path}`), {
    method: init.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new MailApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

// Attachments are fetched with the token (they're not public links).
export async function fetchAttachment(token: string, messageId: string, idx: number): Promise<Blob> {
  const res = await fetch(apiUrl(`/api/mail/messages/${messageId}/attachments/${idx}`), { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) {
    const data = await res.json().catch(() => null);
    throw new MailApiError(data?.error || 'Could not open the attachment.', res.status);
  }
  return res.blob();
}

export const fileToDataUrl = (file: File) =>
  new Promise<string>((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });

export const formatBytes = (n: number) => (n >= 1048576 ? `${(n / 1048576).toFixed(1)} MB` : n >= 1024 ? `${Math.round(n / 1024)} KB` : `${n} B`);

// "10:42" today, "14 Oct" this year, "14/10/25" before.
export function shortMailDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  if (d.toDateString() === now.toDateString()) return d.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit' });
  if (d.getFullYear() === now.getFullYear()) return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-GB', { day: '2-digit', month: '2-digit', year: '2-digit' });
}

export const fullMailDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

// Folder list (left column). `label` is what /api/mail/messages takes.
export const MAIL_FOLDERS = [
  { label: 'Inbox', title: 'Inbox' },
  { label: 'Starred', title: 'Starred' },
  { label: 'Important', title: 'Important' },
  { label: 'Sent', title: 'Sent' },
  { label: 'Drafts', title: 'Drafts' },
  { label: 'Scheduled', title: 'Scheduled' },
  { label: 'Archive', title: 'Archive' },
  { label: 'Spam', title: 'Spam' },
  { label: 'Trash', title: 'Trash' }
] as const;

export const MAIL_CATEGORIES = [
  { key: '', title: 'All' },
  { key: 'primary', title: 'Primary' },
  { key: 'updates', title: 'Updates' },
  { key: 'promotions', title: 'Promotions' },
  { key: 'social', title: 'Social' }
] as const;

// Labels the server uses for folders — anything else on a message is the
// user's own label (rules' "apply label").
export const SYSTEM_LABELS = new Set(['Inbox', 'Sent', 'Drafts', 'Scheduled', 'Spam', 'Trash', 'Archive', 'Outbox']);

// Opens / saves an attachment: a normal download on the web; on the app the
// file goes to the Share sheet (Save to Files, Drive, WhatsApp…).
export async function saveBlob(blob: Blob, name: string): Promise<void> {
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const dataUrl = await fileToDataUrl(new File([blob], name, { type: blob.type }));
      const safe = name.replace(/[\\/:*?"<>|]+/g, '_') || 'attachment';
      const written = await Filesystem.writeFile({ path: safe, data: dataUrl.split(',')[1] || '', directory: Directory.Cache });
      await Share.share({ title: safe, url: written.uri, dialogTitle: `Save or share ${safe}` });
      return;
    }
  } catch {
    // Falls back to the browser download below.
  }
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = name || 'attachment';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 30_000);
}
