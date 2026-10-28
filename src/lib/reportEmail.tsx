/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Email" next to a report's PDF button: the same PDF the PDF button saves,
// sent as an attachment to people picked in the app and / or typed email
// addresses (ReportEmailRoutes.ts). Only for accounts with
// users.can_email_reports (Admin Panel -> Users -> Module Access); a
// Superadmin always has it. The popup is the liquid-glass card (CLAUDE.md ->
// Popup style) and mounts itself into <body>, like confirmDialog.
//
//   const canEmail = useCanEmailReports();
//   {canEmail && <EmailReportButton onClick={() => exportPdf('email')} />}
//   …in exportPdf: if (mode === 'email') return emailReport(doc, { fileName, title });

import React, { useEffect, useMemo, useRef, useState, useSyncExternalStore } from 'react';
import { createRoot, Root } from 'react-dom/client';
import type jsPDFType from 'jspdf';
import { CheckCircle2, FileText, Mail, Search, Send, X } from 'lucide-react';
import { apiUrl } from './api';

// ---- who may email (set by App.tsx from the signed-in account) -----------
let allowed = false;
let authToken: string | null = null;
const listeners = new Set<() => void>();
export function setReportEmailAccess(user: any, token: string | null) {
  const next = !!user && (user.role === 'superadmin' || !!user.can_email_reports);
  authToken = token;
  if (next !== allowed) {
    allowed = next;
    listeners.forEach((l) => l());
  }
}
export function useCanEmailReports(): boolean {
  return useSyncExternalStore(
    (l) => {
      listeners.add(l);
      return () => listeners.delete(l);
    },
    () => allowed
  );
}

// ---- the button -----------------------------------------------------------
export const EmailReportButton: React.FC<{ onClick: () => void; disabled?: boolean; className?: string; label?: string; title?: string }> = ({
  onClick,
  disabled,
  className,
  label = 'Email',
  title = 'Email this report as a PDF'
}) => (
  <button
    type="button"
    onClick={onClick}
    disabled={disabled}
    title={title}
    className={
      className ||
      'inline-flex items-center gap-1.5 px-3 py-2 rounded-xl border border-slate-200 bg-white text-slate-700 text-xs font-semibold hover:bg-slate-50 disabled:opacity-50'
    }
  >
    <Mail className="w-3.5 h-3.5" /> {label}
  </button>
);

// ---- opening the popup ----------------------------------------------------
export interface EmailReportOptions {
  fileName: string;
  title: string;
  subject?: string;
}
let root: Root | null = null;
let host: HTMLDivElement | null = null;

async function toBase64(file: jsPDFType | Blob | ArrayBuffer): Promise<string> {
  if (file && typeof (file as any).output === 'function') return String((file as jsPDFType).output('datauristring')).split(',')[1] || '';
  const buf = file instanceof Blob ? await file.arrayBuffer() : (file as ArrayBuffer);
  const bytes = new Uint8Array(buf);
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Opens the Email popup for a built PDF (a jsPDF document) or an Excel / PDF file. */
export async function emailReport(file: jsPDFType | Blob | ArrayBuffer, opts: EmailReportOptions): Promise<void> {
  const base64 = await toBase64(file);
  const fileName = /\.(pdf|xlsx)$/i.test(opts.fileName) ? opts.fileName : `${opts.fileName}.pdf`;
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root!.render(<EmailReportCard key={Date.now()} base64={base64} fileName={fileName} title={opts.title} subject={opts.subject || opts.title} onClose={() => root?.render(<></>)} />);
}

interface Person {
  id: number;
  name: string;
  email: string;
  designation: string | null;
  department: string | null;
}
const EMAIL_RE = /^[^\s@<>(),;:"]+@[^\s@<>(),;:"]+\.[^\s@<>(),;:"]+$/;
const sizeText = (b64: string) => {
  const kb = Math.round((b64.length * 3) / 4 / 1024);
  return kb > 1024 ? `${(kb / 1024).toFixed(1)} MB` : `${kb} KB`;
};

function EmailReportCard({ base64, fileName, title, subject: subject0, onClose }: { base64: string; fileName: string; title: string; subject: string; onClose: () => void }) {
  const [people, setPeople] = useState<Person[] | null>(null);
  const [mailer, setMailer] = useState(true);
  const [q, setQ] = useState('');
  const [picked, setPicked] = useState<Person[]>([]);
  const [typed, setTyped] = useState('');
  const [subject, setSubject] = useState(subject0);
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState('');
  const [done, setDone] = useState<{ sent: string[]; failed: { email: string; error: string }[] } | null>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const headers = useMemo(() => ({ Authorization: `Bearer ${authToken || localStorage.getItem('mpr_token') || ''}` }), []);

  useEffect(() => {
    searchRef.current?.focus();
    fetch(apiUrl('/api/reports/email/access'), { headers })
      .then((r) => r.json())
      .then((j) => setMailer(!!j.mailer))
      .catch(() => {});
    fetch(apiUrl('/api/reports/email/recipients'), { headers })
      .then(async (r) => {
        const j = await r.json().catch(() => null);
        if (!r.ok) throw new Error(j?.error || 'Could not load people.');
        setPeople(j);
      })
      .catch((e) => {
        setPeople([]);
        setErr(e.message);
      });
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [headers, onClose]);

  const typedList = typed
    .split(/[\s,;]+/)
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean);
  const badTyped = typedList.filter((e) => !EMAIL_RE.test(e));
  const matches = (people || [])
    .filter((p) => !picked.some((x) => x.id === p.id))
    .filter((p) => !q.trim() || [p.name, p.email, p.department, p.designation].some((v) => String(v || '').toLowerCase().includes(q.trim().toLowerCase())))
    .slice(0, 6);
  const count = picked.length + typedList.length;

  const send = async () => {
    if (!count) return setErr('Pick at least one person or type an email address.');
    if (badTyped.length) return setErr(`Not an email address: ${badTyped.join(', ')}`);
    setBusy(true);
    setErr('');
    try {
      const r = await fetch(apiUrl('/api/reports/email'), {
        method: 'POST',
        headers: { ...headers, 'Content-Type': 'application/json' },
        body: JSON.stringify({ title, file_name: fileName, subject, message, user_ids: picked.map((p) => p.id), emails: typedList, file_base64: base64 })
      });
      const j = await r.json().catch(() => null);
      if (!r.ok) throw new Error(j?.error || `Couldn't send (${r.status})`);
      setDone({ sent: j.sent || [], failed: j.failed || [] });
    } catch (e: any) {
      setErr(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="liquid-glass-backdrop fixed inset-0 z-[3000] flex items-center justify-center p-4" onClick={onClose} role="presentation">
      <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Email report">
        <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 max-h-[90vh] overflow-y-auto">
          <div className="flex items-start gap-3.5">
            <div className="liquid-glass-inset w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 text-violet-600">
              <Mail className="w-5 h-5" />
            </div>
            <div className="min-w-0 flex-1 pt-0.5">
              <h3 className="text-base font-bold text-slate-900">Email report</h3>
              <p className="mt-0.5 text-xs text-slate-600 truncate">{title}</p>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
              <X className="w-4 h-4 text-slate-600" />
            </button>
          </div>

          {done ? (
            <div className="mt-5">
              <div className="liquid-glass-inset rounded-2xl p-4 flex items-start gap-3">
                <CheckCircle2 className="w-5 h-5 text-emerald-600 shrink-0 mt-0.5" />
                <div className="text-sm text-slate-700 min-w-0">
                  <p className="font-semibold text-slate-900">Sent to {done.sent.length} {done.sent.length === 1 ? 'person' : 'people'}</p>
                  <p className="text-xs text-slate-500 break-words mt-0.5">{done.sent.join(', ')}</p>
                  {done.failed.length > 0 && <p className="text-xs text-rose-600 mt-2 break-words">Not sent: {done.failed.map((f) => `${f.email} (${f.error})`).join(', ')}</p>}
                </div>
              </div>
              <button type="button" onClick={onClose} className="liquid-glass-button rounded-full w-full py-2.5 text-sm font-semibold mt-4">
                Done
              </button>
            </div>
          ) : (
            <>
              <div className="liquid-glass-inset rounded-2xl px-3 py-2.5 mt-4 flex items-center gap-2.5">
                <FileText className="w-4 h-4 text-rose-500 shrink-0" />
                <span className="text-xs font-semibold text-slate-800 truncate flex-1">{fileName}</span>
                <span className="text-[11px] text-slate-500 shrink-0">{sizeText(base64)}</span>
              </div>
              {!mailer && <p className="text-xs text-amber-700 bg-amber-50/80 rounded-xl px-3 py-2 mt-3">Email isn't set up on the server yet (SMTP settings) — the Superadmin has to add them before reports can be sent.</p>}

              <label className="block text-xs font-semibold text-slate-600 mt-4 mb-1.5">To — people in the app</label>
              {picked.length > 0 && (
                <div className="flex flex-wrap gap-1.5 mb-2">
                  {picked.map((p) => (
                    <span key={p.id} className="inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full bg-violet-100 text-violet-800 text-xs font-semibold">
                      {p.name}
                      <button type="button" onClick={() => setPicked((l) => l.filter((x) => x.id !== p.id))} className="w-4 h-4 rounded-full flex items-center justify-center hover:bg-violet-200" aria-label={`Remove ${p.name}`}>
                        <X className="w-3 h-3" />
                      </button>
                    </span>
                  ))}
                </div>
              )}
              <div className="relative">
                <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
                <input
                  ref={searchRef}
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={people === null ? 'Loading…' : 'Search by name, department…'}
                  className="w-full pl-9 pr-3 py-2 rounded-xl border border-white/60 bg-white/70 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
                />
              </div>
              {q.trim() && (
                <ul className="liquid-glass-inset rounded-2xl mt-2 divide-y divide-white/50 overflow-hidden">
                  {matches.length === 0 ? (
                    <li className="px-3 py-2 text-xs text-slate-500">Nobody found</li>
                  ) : (
                    matches.map((p) => (
                      <li key={p.id}>
                        <button
                          type="button"
                          onClick={() => {
                            setPicked((l) => [...l, p]);
                            setQ('');
                            searchRef.current?.focus();
                          }}
                          className="w-full text-left px-3 py-2 hover:bg-white/40"
                        >
                          <span className="block text-sm font-semibold text-slate-800">{p.name}</span>
                          <span className="block text-[11px] text-slate-500 truncate">{[p.designation, p.department, p.email].filter(Boolean).join(' · ')}</span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              )}

              <label className="block text-xs font-semibold text-slate-600 mt-3 mb-1.5">Other email addresses</label>
              <input
                value={typed}
                onChange={(e) => setTyped(e.target.value)}
                placeholder="e.g. auditor@firm.com, md@company.com"
                className="w-full px-3 py-2 rounded-xl border border-white/60 bg-white/70 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400"
              />
              <label className="block text-xs font-semibold text-slate-600 mt-3 mb-1.5">Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} className="w-full px-3 py-2 rounded-xl border border-white/60 bg-white/70 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400" />
              <label className="block text-xs font-semibold text-slate-600 mt-3 mb-1.5">Message (optional)</label>
              <textarea value={message} onChange={(e) => setMessage(e.target.value)} rows={3} placeholder="Please find the attached report." className="w-full px-3 py-2 rounded-xl border border-white/60 bg-white/70 text-sm focus:outline-none focus:ring-2 focus:ring-violet-400 resize-none" />

              {err && <p className="text-xs text-rose-600 mt-3">{err}</p>}
              <button type="button" onClick={send} disabled={busy || !count} className="liquid-glass-button rounded-full w-full py-2.5 text-sm font-semibold mt-4 inline-flex items-center justify-center gap-2 disabled:opacity-60">
                <Send className="w-4 h-4" /> {busy ? 'Sending…' : count ? `Send to ${count}` : 'Send'}
              </button>
            </>
          )}
        </div>
      </div>
    </div>
  );
}
