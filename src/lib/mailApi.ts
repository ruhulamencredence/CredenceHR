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
  // Came / went inside CredenceHR, not through the mail server.
  internal?: boolean;
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

export interface SignatureFields {
  fullName: string;
  title: string;
  department: string;
  mobile: string;
  pabx: string;
}

export interface MailSignature {
  id: string;
  name: string;
  content: string;
  isDefault: boolean;
  fields?: SignatureFields;
  logoUrl?: string;
}

export interface MailTemplate {
  id: string;
  title: string;
  subject: string;
  body: string;
}

export interface MailFilter {
  id: string;
  name: string;
  conditions: { from?: string; to?: string; subjectContains?: string; bodyContains?: string; hasAttachment?: boolean };
  actions: { archive?: boolean; markRead?: boolean; star?: boolean; applyLabels?: string[]; categorize?: string };
  isActive: boolean;
}

export interface MailContact {
  id: string;
  name: string;
  email: string;
  phone: string;
  company: string;
  notes: string;
  avatarColor: string;
}

export interface MailTask {
  id: string;
  title: string;
  dueDate?: string;
  completed: boolean;
  emailId?: string;
  emailSubject?: string;
}

export interface MailEvent {
  id: string;
  title: string;
  start: string;
  end: string;
  description: string;
  location: string;
  emailId?: string;
}

export interface MailAnalytics {
  sentCount: number;
  receivedCount: number;
  spamCount: number;
  averageResponseTimeMinutes: number;
  dailyTrends: { date: string; sent: number; received: number }[];
  contactEngagement: { name: string; email: string; count: number }[];
  categoryDistribution: { name: string; value: number }[];
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

// Admin Panel -> Mail Administration: while someone else's mailbox is open
// (read only), every call carries whose it is (MailRoutes.ts requireMail).
let viewAsUserId: number | null = null;
export function setMailViewAs(userId: number | null) {
  viewAsUserId = userId;
}
const viewAsHeader = (): Record<string, string> => (viewAsUserId ? { 'X-Mail-View-As': String(viewAsUserId) } : {});

export async function mailFetch<T = any>(token: string, path: string, init: { method?: string; body?: any } = {}): Promise<T> {
  const res = await fetch(apiUrl(`/api/mail${path}`), {
    method: init.method || 'GET',
    headers: { Authorization: `Bearer ${token}`, ...viewAsHeader(), ...(init.body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
    body: init.body !== undefined ? JSON.stringify(init.body) : undefined
  });
  const data = await res.json().catch(() => null);
  if (!res.ok) throw new MailApiError(data?.error || `Request failed (${res.status})`, res.status);
  return data as T;
}

// Attachments are fetched with the token (they're not public links).
export async function fetchAttachment(token: string, messageId: string, idx: number): Promise<Blob> {
  const res = await fetch(apiUrl(`/api/mail/messages/${messageId}/attachments/${idx}`), { headers: { Authorization: `Bearer ${token}`, ...viewAsHeader() } });
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

// Settings -> Time zone: every mail date is shown in it (default Dhaka).
let mailTimeZone: string | undefined = 'Asia/Dhaka';
export function setMailTimeZone(tz: string | undefined) {
  try {
    new Intl.DateTimeFormat('en-GB', { timeZone: tz }).format(new Date());
    mailTimeZone = tz;
  } catch {
    mailTimeZone = undefined;
  }
}
const dayKey = (d: Date) => new Intl.DateTimeFormat('en-CA', { timeZone: mailTimeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(d);

// "10:42" today, "14 Oct" this year, "14/10/25" before.
export function shortMailDate(iso: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '';
  const now = new Date();
  const tz = { timeZone: mailTimeZone };
  if (dayKey(d) === dayKey(now)) return d.toLocaleTimeString('en-GB', { ...tz, hour: '2-digit', minute: '2-digit' });
  if (dayKey(d).slice(0, 4) === dayKey(now).slice(0, 4)) return d.toLocaleDateString('en-GB', { ...tz, day: 'numeric', month: 'short' });
  return d.toLocaleDateString('en-GB', { ...tz, day: '2-digit', month: '2-digit', year: '2-digit' });
}

export const fullMailDate = (iso: string | null) => {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString('en-GB', { timeZone: mailTimeZone, weekday: 'short', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
};

export const MAIL_TIME_ZONES = ['Asia/Dhaka', 'Asia/Kolkata', 'Asia/Dubai', 'Asia/Riyadh', 'Asia/Singapore', 'Asia/Kuala_Lumpur', 'Asia/Tokyo', 'Europe/London', 'Europe/Berlin', 'America/New_York', 'America/Los_Angeles', 'Australia/Sydney', 'UTC'];

// The Credence signature (same design as the original credence-mail app):
// company lines fixed, the person's own lines from the signature maker.
const esc = (v: string) => String(v || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
export function credenceSignatureHtml(f: SignatureFields, logoUrl?: string): string {
  const contact: string[] = [];
  if (f.mobile) contact.push(`Mobile: <span style="color:#E05A1A;font-weight:700;">${esc(f.mobile)}</span>`);
  if (f.pabx) contact.push(`PABX: <span style="color:#E05A1A;font-weight:700;">${esc(f.pabx)}</span>`);
  const link = (href: string, label: string) =>
    `<a href="${href}" style="color:#E05A1A;font-weight:700;font-size:10px;text-decoration:none;font-family:Arial,sans-serif;letter-spacing:0.05em;">${label}</a>`;
  const links = [link('https://credencehousing.com', 'WEBSITE'), link('https://facebook.com/credencehousing', 'FACEBOOK'), link('https://linkedin.com/company/credencehousing', 'LINKEDIN')].join(
    '<span style="color:#ccc;margin:0 5px;">|</span>'
  );
  return `<table cellpadding="0" cellspacing="0" border="0" style="font-family:Arial,sans-serif;width:100%;max-width:520px;margin-top:16px;">
<tr><td style="padding-bottom:12px;">
<p style="margin:0;font-size:12px;font-style:italic;color:#555;font-family:Georgia,serif;">With Regards,</p>
<p style="margin:4px 0 2px;font-size:14px;font-weight:700;color:#1a1a1a;">${esc(f.fullName)}</p>
<p style="margin:0 0 2px;font-size:11px;color:#0B57D0;">${[f.title, f.department].filter(Boolean).map(esc).join(' | ')}</p>
${contact.length ? `<p style="margin:0;font-size:11px;color:#333;">${contact.join('&nbsp;&nbsp;|&nbsp;&nbsp;')}</p>` : ''}
</td></tr>
<tr><td style="border-top:1px solid #e0e0e0;padding-top:12px;">
<table cellpadding="0" cellspacing="0" border="0" style="width:100%;"><tr>
${logoUrl ? `<td style="width:80px;vertical-align:middle;padding-right:14px;"><img src="${esc(logoUrl)}" alt="Logo" style="width:72px;height:auto;display:block;"></td>` : ''}
<td style="vertical-align:top;">
<p style="margin:0 0 3px;font-size:13px;font-weight:700;color:#1a1a1a;letter-spacing:0.02em;">CREDENCE HOUSING LIMITED</p>
<p style="margin:0 0 1px;font-size:10px;color:#555;">Telephone: +8802 41021375, +8802 41021378 | Hotline: 16769</p>
<p style="margin:0 0 6px;font-size:10px;color:#555;">Corporate Address: House-15, Road-13/A, Dhanmondi, Dhaka-1209, Bangladesh</p>
<p style="margin:0;">${links}</p>
</td></tr></table>
</td></tr>
</table>`;
}

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
