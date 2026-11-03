/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Panel -> Notices -> New / Edit notice. Four steps on one card:
//   1 Write   — a template, title, the editor (pictures, links, tables…),
//               a cover picture and attachments;
//   2 Who     — everyone, groups (departments / branches) or specific people,
//               with people added / left out, and how many it reaches;
//   3 When    — priority, publish now or later, take down after, pin,
//               "I have read this", push, email, next-day reminder;
//   4 Review  — what goes where, then publish / schedule / save as draft.
// The right side shows it as people will see it (phone popup, desktop,
// board) while it is written. An unsaved new notice is kept in this browser.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  X, PenLine, Users, CalendarClock, CheckCircle2, ImagePlus, Paperclip, Trash2, Globe, UsersRound, UserRound, Sparkles,
  Smartphone, Monitor, LayoutList, Send, Save, ChevronRight, ChevronLeft, Loader2, Eye
} from 'lucide-react';
import type { Notice, NoticeAudience, NoticeAudiencePerson, NoticeFile, NoticePriority, User } from '../../types';
import { apiUrl } from '../../lib/api';
import { SearchSelect } from '../Combobox';
import { NoticeEditor, NoticeEditorHandle } from './NoticeEditor';
import { NoticeView, NoticeContent, NoticeCover, NoticeAttachments, NoticeBadges } from './NoticeParts';
import { uploadNoticeFile, fileSize } from '../../lib/noticeFilesClient';
import { confirmDialog } from '../../lib/confirmDialog';

interface Form {
  title: string;
  content_html: string;
  priority: NoticePriority;
  target_type: 'all' | 'specific' | 'groups';
  audience: NoticeAudience;
  target_user_ids: number[];
  publish_mode: 'now' | 'later';
  publish_at: string;
  expire_mode: 'never' | 'at';
  expire_at: string;
  pinned: boolean;
  require_ack: boolean;
  send_push: boolean;
  send_email: boolean;
  remind_unread: boolean;
  cover: NoticeFile | null;
  attachments: NoticeFile[];
  lottie_json: string;
  lottie_url: string;
}

const emptyAudience = (): NoticeAudience => ({ departments: [], branches: [], include: [], exclude: [] });
const blank = (): Form => ({
  title: '',
  content_html: '',
  priority: 'important',
  target_type: 'all',
  audience: emptyAudience(),
  target_user_ids: [],
  publish_mode: 'now',
  publish_at: '',
  expire_mode: 'never',
  expire_at: '',
  pinned: false,
  require_ack: false,
  send_push: true,
  send_email: false,
  remind_unread: false,
  cover: null,
  attachments: [],
  lottie_json: '',
  lottie_url: ''
});

const TEMPLATES: { key: string; label: string; title: string; html: string; priority?: NoticePriority }[] = [
  { key: 'blank', label: '✍️ Blank', title: '', html: '' },
  {
    key: 'holiday',
    label: '🎉 Holiday / Off day',
    title: 'Office closed on [date] — [occasion]',
    html: '<h3>Dear colleagues,</h3><p>On the occasion of <b>[occasion]</b>, the office will remain <b>closed on [day, date]</b>.</p><p>Regular office hours resume on <b>[date]</b>.</p><ul><li>Site teams: as per the Duty Roster</li><li>For anything urgent, call HR: [number]</li></ul>'
  },
  {
    key: 'meeting',
    label: '📅 Meeting',
    title: '[Meeting name] — [date], [time]',
    html: '<p>You are invited to <b>[meeting name]</b>.</p><table><tbody><tr><th>Date</th><td>[date]</td></tr><tr><th>Time</th><td>[time]</td></tr><tr><th>Place</th><td>[room / link]</td></tr></tbody></table><p><b>Agenda</b></p><ol><li>[topic]</li><li>[topic]</li></ol><p>Please be on time.</p>'
  },
  {
    key: 'policy',
    label: '📜 Policy update',
    title: 'Update to the [policy name]',
    html: '<p>The <b>[policy name]</b> has been updated, effective <b>[date]</b>.</p><p><b>What changes</b></p><ul><li>[change]</li><li>[change]</li></ul><p>The full policy is attached. Please read it and tap <b>I have read this</b>.</p>'
  },
  {
    key: 'urgent',
    label: '⚠️ Urgent',
    title: 'Urgent: [subject]',
    priority: 'urgent',
    html: '<p><b>[What happened / what is needed]</b></p><p>Please [action] by <b>[time]</b>.</p><p>Contact: [name, number]</p>'
  },
  {
    key: 'congrats',
    label: '🎂 Congratulations',
    title: 'Congratulations, [name]! 🎉',
    priority: 'normal',
    html: '<p style="text-align:center">🎉 <b>Congratulations to [name]</b> 🎉</p><p style="text-align:center">[on the promotion / the new baby / winning …]</p><p style="text-align:center">From all of us at Credence.</p>'
  },
  {
    key: 'maintenance',
    label: '🛠️ Maintenance',
    title: 'Planned maintenance — [system], [date]',
    html: '<p><b>[System]</b> will be unavailable on <b>[date] from [time] to [time]</b> for maintenance.</p><p>Please save your work before then. Sorry for the trouble.</p>'
  }
];

const STEPS = [
  { key: 'write', label: 'Write', icon: PenLine },
  { key: 'who', label: 'Who gets it', icon: Users },
  { key: 'when', label: 'When & how', icon: CalendarClock },
  { key: 'review', label: 'Review & publish', icon: CheckCircle2 }
] as const;
type StepKey = (typeof STEPS)[number]['key'];

const dhakaNowLocal = () => new Date(Date.now() + 6 * 3600e3).toISOString().slice(0, 16);
const fmtWhen = (v: string) => {
  const d = new Date(v.replace(' ', 'T') + ':00+06:00');
  return Number.isNaN(d.getTime()) ? v : d.toLocaleString('en-GB', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: true, timeZone: 'Asia/Dhaka' });
};

const fromNotice = (n: Notice): Form => ({
  ...blank(),
  title: n.title,
  content_html: n.content_html,
  priority: n.priority || 'important',
  target_type: n.target_type || 'all',
  audience: { ...emptyAudience(), ...(n.audience || {}) },
  target_user_ids: n.target_user_ids || [],
  publish_mode: n.publish_at ? 'later' : 'now',
  publish_at: (n.publish_at || '').replace(' ', 'T'),
  expire_mode: n.expire_at ? 'at' : 'never',
  expire_at: (n.expire_at || '').replace(' ', 'T'),
  pinned: !!n.pinned,
  require_ack: !!n.require_ack,
  send_push: n.send_push !== false,
  send_email: !!n.send_email,
  remind_unread: !!n.remind_unread,
  cover: n.cover || null,
  attachments: (n.files || []).filter((f) => f.role === 'attachment'),
  lottie_json: n.lottie_json || '',
  lottie_url: n.lottie_url || ''
});

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: string; disabled?: boolean }> = ({ on, onChange, label, hint, disabled }) => (
  <label className={`flex items-center justify-between gap-3 py-2.5 border-t border-dashed border-slate-200 first:border-t-0 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
    <span>
      <span className="block text-[13px] text-slate-800">{label}</span>
      {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
    </span>
    <button
      type="button"
      role="switch"
      aria-checked={on}
      disabled={disabled}
      onClick={() => onChange(!on)}
      className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${on ? 'bg-[var(--g-accent,#7f00ff)]' : 'bg-slate-300'}`}
    >
      <span className={`absolute top-[3px] w-[18px] h-[18px] rounded-full bg-white shadow transition-all ${on ? 'left-[23px]' : 'left-[3px]'}`} />
    </button>
  </label>
);

const Seg: React.FC<{ value: string; options: [string, string, React.ComponentType<{ className?: string }>?][]; onChange: (v: any) => void; label: string }> = ({ value, options, onChange, label }) => (
  <div className="flex rounded-full bg-slate-100 p-1 gap-1" role="radiogroup" aria-label={label}>
    {options.map(([k, l, Icon]) => (
      <button key={k} type="button" role="radio" aria-checked={value === k} onClick={() => onChange(k)} className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-full text-xs font-semibold ${value === k ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
        {Icon && <Icon className="w-3.5 h-3.5" />}
        {l}
      </button>
    ))}
  </div>
);

const personText = (p: NoticeAudiencePerson) => [p.name, p.employee_code, p.designation, p.department].filter(Boolean).join(' · ');

export const NoticeComposer: React.FC<{
  token: string;
  user: User;
  notice: Notice | null;
  // "Make a copy": same text and settings, no files, a new notice.
  copyOf?: Notice | null;
  canEmail: boolean;
  onClose: () => void;
  onSaved: (msg: string) => void;
}> = ({ token, user, notice, copyOf, canEmail, onClose, onSaved }) => {
  const draftKey = `credence_notice_draft_${user.id}`;
  const [form, setForm] = useState<Form>(() =>
    notice
      ? fromNotice(notice)
      : copyOf
        ? {
            ...fromNotice(copyOf),
            title: `Copy of ${copyOf.title}`.slice(0, 200),
            // Pictures and files belong to the original; the copy starts without them.
            content_html: copyOf.content_html.replace(/<img\b[^>]*\/api\/notices\/files\/\d+[^>]*>/gi, ''),
            cover: null,
            attachments: [],
            publish_mode: 'now',
            publish_at: '',
            expire_mode: 'never',
            expire_at: ''
          }
        : blank()
  );
  const [resetKey, setResetKey] = useState(1);
  const [step, setStep] = useState<StepKey>('write');
  const [view, setView] = useState<'phone' | 'desktop' | 'board'>('phone');
  const [opts, setOpts] = useState<{ departments: { id: number; name: string }[]; branches: { id: number; name: string }[]; people: NoticeAudiencePerson[] } | null>(null);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [restorable, setRestorable] = useState<Form | null>(null);
  const [showAnim, setShowAnim] = useState(!!(notice?.lottie_json || notice?.lottie_url));
  const [previewPopup, setPreviewPopup] = useState(false);
  const [coverLocal, setCoverLocal] = useState<string | null>(null);
  const editor = useRef<NoticeEditorHandle>(null);
  const attachInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const set = <K extends keyof Form>(k: K, v: Form[K]) => setForm((f) => ({ ...f, [k]: v }));
  const setAud = <K extends keyof NoticeAudience>(k: K, v: NoticeAudience[K]) => setForm((f) => ({ ...f, audience: { ...f.audience, [k]: v } }));

  useEffect(() => {
    fetch(apiUrl('/api/notices/audience-options'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => d && setOpts(d))
      .catch(() => {});
  }, [token]);

  // An unsaved new notice from earlier, kept in this browser.
  useEffect(() => {
    if (notice || copyOf) return;
    try {
      const raw = localStorage.getItem(draftKey);
      if (raw) {
        const d = JSON.parse(raw);
        if (d && (d.title || d.content_html)) setRestorable({ ...blank(), ...d });
      }
    } catch {
      // storage unavailable
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (notice || restorable) return;
    const t = setTimeout(() => {
      try {
        if (form.title || form.content_html) localStorage.setItem(draftKey, JSON.stringify(form));
      } catch {
        // storage unavailable
      }
    }, 800);
    return () => clearTimeout(t);
  }, [form, notice, restorable, draftKey]);
  const clearDraft = () => {
    try {
      localStorage.removeItem(draftKey);
    } catch {
      // storage unavailable
    }
  };

  const people = opts?.people || [];
  const personById = useMemo(() => new Map(people.map((p) => [p.id, p])), [people]);
  const reach = useMemo(() => {
    const ex = new Set(form.audience.exclude);
    let ids: number[] = [];
    if (form.target_type === 'all') ids = people.map((p) => p.id);
    else if (form.target_type === 'specific') ids = form.target_user_ids;
    else {
      const d = new Set(form.audience.departments);
      const b = new Set(form.audience.branches);
      ids = people.filter((p) => (p.department_id && d.has(p.department_id)) || (p.branch_id && b.has(p.branch_id))).map((p) => p.id);
      ids = Array.from(new Set([...ids, ...form.audience.include]));
    }
    return ids.filter((id) => !ex.has(id) && id !== Number(notice?.created_by ?? user.id)).length;
  }, [form.target_type, form.audience, form.target_user_ids, people, notice, user.id]);

  const urgent = form.priority === 'urgent';
  const requireAck = urgent || form.require_ack;
  const contentIsEmpty = !form.content_html.replace(/<[^>]*>|&nbsp;|&#8203;|\s/g, '') && !/<img/i.test(form.content_html);

  const applyTemplate = async (key: string) => {
    const t = TEMPLATES.find((x) => x.key === key)!;
    if ((form.title || !contentIsEmpty) && !(await confirmDialog('Replace what you have written with this template?'))) return;
    setForm((f) => ({ ...f, title: t.title, content_html: t.html, priority: t.priority || f.priority }));
    setResetKey((k) => k + 1);
  };

  const addAttachments = async (files: File[]) => {
    setError(null);
    setUploading(true);
    try {
      for (const f of files) {
        const up = await uploadNoticeFile(token, f, 'file');
        setForm((s) => ({ ...s, attachments: [...s.attachments, up] }));
      }
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };
  const setCover = async (f: File) => {
    setError(null);
    setUploading(true);
    try {
      const up = await uploadNoticeFile(token, f, 'image');
      set('cover', up);
      setCoverLocal(URL.createObjectURL(f));
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  const problems = (): string | null => {
    if (!form.title.trim()) return 'Give the notice a title.';
    if (contentIsEmpty) return 'Write the notice.';
    if (form.target_type === 'groups' && !form.audience.departments.length && !form.audience.branches.length && !form.audience.include.length) return 'Pick at least one department, branch or person.';
    if (form.target_type === 'specific' && !form.target_user_ids.length) return 'Pick at least one person.';
    if (form.publish_mode === 'later' && !form.publish_at) return 'Pick when to publish it.';
    if (form.expire_mode === 'at' && !form.expire_at) return 'Pick when to take it down.';
    if (form.expire_mode === 'at' && form.expire_at <= (form.publish_mode === 'later' && form.publish_at ? form.publish_at : dhakaNowLocal())) return 'The take-down time must be after it is published.';
    return null;
  };

  const save = async (active: boolean) => {
    const p = problems();
    if (p) {
      setError(p);
      if (p.includes('title') || p.includes('Write')) setStep('write');
      else if (p.includes('Pick at least')) setStep('who');
      else setStep('when');
      return;
    }
    setSaving(true);
    setError(null);
    try {
      const body = {
        title: form.title.trim(),
        content_html: form.content_html,
        priority: form.priority,
        target_type: form.target_type,
        audience: form.audience,
        target_user_ids: form.target_user_ids,
        publish_at: form.publish_mode === 'later' ? form.publish_at : null,
        expire_at: form.expire_mode === 'at' ? form.expire_at : null,
        pinned: form.pinned,
        require_ack: requireAck,
        send_push: form.send_push,
        send_email: canEmail ? form.send_email : notice?.send_email || false,
        remind_unread: form.remind_unread,
        cover_file_id: form.cover?.id || null,
        attachment_ids: form.attachments.map((a) => a.id),
        lottie_json: form.lottie_json || null,
        lottie_url: form.lottie_url || null,
        is_active: active
      };
      const res = await fetch(apiUrl(notice ? `/api/notices/${notice.id}` : '/api/notices'), {
        method: notice ? 'PUT' : 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(body)
      });
      const d = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(d.error || 'Could not save the notice.');
      if (notice && active !== notice.is_active) {
        await fetch(apiUrl(`/api/notices/${notice.id}/active`), {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ is_active: active })
        });
      }
      clearDraft();
      onSaved(!active ? 'Saved as a draft — nobody sees it yet.' : d.status === 'scheduled' ? `Scheduled for ${fmtWhen(form.publish_at.replace('T', ' '))}.` : notice ? 'Notice updated.' : `Published to ${reach} ${reach === 1 ? 'person' : 'people'}.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setSaving(false);
    }
  };

  const stepIndex = STEPS.findIndex((s) => s.key === step);
  const publishLabel = form.publish_mode === 'later' ? 'Schedule' : notice?.is_active ? 'Save changes' : 'Publish now';
  const audienceText =
    form.target_type === 'all'
      ? 'Everyone'
      : form.target_type === 'specific'
        ? `${form.target_user_ids.length} specific ${form.target_user_ids.length === 1 ? 'person' : 'people'}`
        : [
            ...form.audience.departments.map((id) => opts?.departments.find((d) => d.id === id)?.name).filter(Boolean),
            ...form.audience.branches.map((id) => opts?.branches.find((b) => b.id === id)?.name).filter(Boolean),
            ...form.audience.include.map((id) => personById.get(id)?.name).filter(Boolean)
          ].join(', ') || 'No group picked';
  const meta = `${form.publish_mode === 'later' && form.publish_at ? fmtWhen(form.publish_at.replace('T', ' ')) : 'Now'} · ${user.name}`;

  const preview = (
    <NoticeView
      token={token}
      title={form.title}
      html={form.content_html}
      priority={form.priority}
      pinned={form.pinned}
      cover={coverLocal ? null : form.cover}
      coverLocalUrl={coverLocal}
      attachments={form.attachments}
      meta={meta}
      coverClass="h-28"
    />
  );

  const chip = (label: string, onRemove: () => void, tone = 'bg-violet-100 text-violet-800') => (
    <span key={label} className={`inline-flex items-center gap-1 pl-2.5 pr-1 py-1 rounded-full text-xs font-semibold ${tone}`}>
      {label}
      <button type="button" onClick={onRemove} className="w-5 h-5 rounded-full hover:bg-white/70 flex items-center justify-center" aria-label={`Remove ${label}`}>
        <X className="w-3 h-3" />
      </button>
    </span>
  );

  const personPicker = (placeholder: string, chosen: number[], onAdd: (id: number) => void) => (
    <SearchSelect value="" onChange={(e) => e.target.value && onAdd(Number(e.target.value))} className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-sm">
      <option value="">{placeholder}</option>
      {people.filter((p) => !chosen.includes(p.id)).map((p) => (
        <option key={p.id} value={p.id}>
          {personText(p)}
        </option>
      ))}
    </SearchSelect>
  );

  return createPortal(
    <div className="liquid-glass-backdrop fixed inset-0 z-[70] flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="w-full max-w-6xl h-full sm:h-auto">
        <div className="liquid-glass liquid-glass-in sm:rounded-[32px] h-full sm:max-h-[94vh] flex flex-col overflow-hidden">
          {/* header */}
          <div className="flex items-center justify-between gap-3 px-5 pt-4 pb-3">
            <div>
              <h3 className="text-base font-bold text-slate-900">{notice ? 'Edit notice' : 'New notice'}</h3>
              <p className="text-[11px] text-slate-500">Write it, choose who gets it and when — the right side shows it as people will see it.</p>
            </div>
            <button type="button" onClick={onClose} className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="flex gap-1.5 px-5 pb-3 overflow-x-auto">
            {STEPS.map((s, i) => {
              const Icon = s.icon;
              const on = s.key === step;
              return (
                <button
                  key={s.key}
                  type="button"
                  onClick={() => setStep(s.key)}
                  className={`flex-1 min-w-[120px] flex items-center gap-2 px-3 py-2 rounded-2xl text-xs font-semibold border ${on ? 'text-white border-transparent' : 'bg-white/70 border-slate-200 text-slate-500'}`}
                  style={on ? { background: 'linear-gradient(135deg, var(--g-accent,#7f00ff), #b36aff)' } : undefined}
                >
                  <span className={`w-5 h-5 rounded-full flex items-center justify-center text-[10px] ${on ? 'bg-white/25' : i < stepIndex ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100'}`}>{i + 1}</span>
                  <Icon className="w-3.5 h-3.5" /> {s.label}
                </button>
              );
            })}
          </div>

          <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_360px] gap-0 overflow-hidden">
            <div className="min-h-0 overflow-y-auto px-5 pb-4">
              {restorable && (
                <div className="mb-3 flex flex-wrap items-center gap-2 rounded-2xl bg-amber-50 border border-amber-200 px-3 py-2 text-xs text-amber-900">
                  You have an unsaved notice from earlier{restorable.title ? ` — “${restorable.title}”` : ''}.
                  <button type="button" className="font-bold underline" onClick={() => { setForm(restorable); setRestorable(null); setResetKey((k) => k + 1); }}>Continue it</button>
                  <button type="button" className="text-amber-700" onClick={() => { clearDraft(); setRestorable(null); }}>Discard</button>
                </div>
              )}

              {step === 'write' && (
                <div className="space-y-4">
                  <div>
                    <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1.5">Start from a template</div>
                    <div className="flex flex-wrap gap-1.5">
                      {TEMPLATES.map((t) => (
                        <button key={t.key} type="button" onClick={() => void applyTemplate(t.key)} className="px-3 py-1.5 rounded-full bg-white border border-slate-200 text-xs font-medium hover:border-violet-400 hover:text-violet-700">
                          {t.label}
                        </button>
                      ))}
                    </div>
                  </div>
                  <label className="block">
                    <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Title</span>
                    <input value={form.title} onChange={(e) => set('title', e.target.value)} maxLength={200} placeholder="e.g. Office closed on 16 December — Victory Day" className="w-full px-3.5 py-2.5 rounded-xl border border-slate-200 bg-white text-sm" />
                  </label>
                  <div>
                    <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Message</span>
                    <NoticeEditor
                      ref={editor}
                      value={form.content_html}
                      resetKey={resetKey}
                      onChange={(h) => set('content_html', h)}
                      token={token}
                      onUploadImage={(f) => uploadNoticeFile(token, f, 'image')}
                    />
                    <p className="text-[11px] text-slate-500 mt-1.5">Bangla or English, Enter for a new line. Drop, paste (Ctrl+V) or pick pictures — big photos are made smaller by themselves.</p>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="liquid-glass-inset rounded-2xl p-3">
                      <div className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5"><ImagePlus className="w-3.5 h-3.5 text-violet-600" /> Cover picture <span className="font-normal text-slate-500">(optional)</span></div>
                      {form.cover ? (
                        <div className="relative">
                          <NoticeCover file={coverLocal ? null : form.cover} localUrl={coverLocal} token={token} className="h-24 rounded-xl" />
                          <button type="button" onClick={() => { set('cover', null); setCoverLocal(null); }} className="absolute top-1.5 right-1.5 w-7 h-7 rounded-full bg-white/90 text-rose-600 flex items-center justify-center" aria-label="Remove cover">
                            <Trash2 className="w-3.5 h-3.5" />
                          </button>
                        </div>
                      ) : (
                        <button type="button" onClick={() => coverInput.current?.click()} className="w-full h-24 rounded-xl border-2 border-dashed border-violet-300 bg-violet-50/60 text-xs font-semibold text-violet-700">
                          Pick a picture for the top
                        </button>
                      )}
                    </div>
                    <div
                      className="liquid-glass-inset rounded-2xl p-3"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        void addAttachments(Array.from(e.dataTransfer.files || []));
                      }}
                    >
                      <div className="text-xs font-bold text-slate-800 mb-2 flex items-center gap-1.5"><Paperclip className="w-3.5 h-3.5 text-violet-600" /> Attachments <span className="font-normal text-slate-500">PDF, Word, Excel… up to 20 MB</span></div>
                      <div className="space-y-1.5">
                        {form.attachments.map((a) => (
                          <div key={a.id} className="flex items-center gap-2 bg-white rounded-xl px-2.5 py-1.5 text-xs">
                            <Paperclip className="w-3.5 h-3.5 text-slate-400" />
                            <span className="flex-1 truncate font-medium">{a.name}</span>
                            <span className="text-slate-400">{fileSize(a.size)}</span>
                            <button type="button" onClick={() => set('attachments', form.attachments.filter((x) => x.id !== a.id))} className="text-rose-600" aria-label={`Remove ${a.name}`}>
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        <button type="button" onClick={() => attachInput.current?.click()} className="w-full py-2 rounded-xl border-2 border-dashed border-violet-300 bg-violet-50/60 text-xs font-semibold text-violet-700">
                          {uploading ? 'Uploading…' : 'Add a file (or drop it here)'}
                        </button>
                      </div>
                    </div>
                  </div>
                  <div>
                    <button type="button" onClick={() => setShowAnim(!showAnim)} className="text-xs font-semibold text-violet-700 inline-flex items-center gap-1">
                      <Sparkles className="w-3.5 h-3.5" /> {showAnim ? 'Hide' : 'Add'} an animation (Lottie, optional)
                    </button>
                    {showAnim && (
                      <div className="grid sm:grid-cols-2 gap-2 mt-2">
                        <textarea value={form.lottie_json} onChange={(e) => set('lottie_json', e.target.value)} rows={3} placeholder='Paste Lottie JSON {"v":"5.7.0",…}' className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-mono" />
                        <input value={form.lottie_url} onChange={(e) => set('lottie_url', e.target.value)} placeholder="or a link to one: https://…/animation.json" className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs" />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {step === 'who' && (
                <div className="space-y-4">
                  <Seg
                    label="Who gets it"
                    value={form.target_type}
                    onChange={(v) => set('target_type', v)}
                    options={[
                      ['all', 'Everyone', Globe],
                      ['groups', 'Choose groups', UsersRound],
                      ['specific', 'Specific people', UserRound]
                    ]}
                  />
                  {form.target_type === 'groups' && (
                    <>
                      <div className="grid sm:grid-cols-2 gap-3">
                        <div>
                          <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Department</span>
                          <SearchSelect value="" onChange={(e) => e.target.value && setAud('departments', [...form.audience.departments, Number(e.target.value)])} className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-sm">
                            <option value="">— Type to add a department —</option>
                            {(opts?.departments || []).filter((d) => !form.audience.departments.includes(d.id)).map((d) => (
                              <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                          </SearchSelect>
                        </div>
                        <div>
                          <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Branch / site</span>
                          <SearchSelect value="" onChange={(e) => e.target.value && setAud('branches', [...form.audience.branches, Number(e.target.value)])} className="w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-sm">
                            <option value="">— Type to add a branch —</option>
                            {(opts?.branches || []).filter((b) => !form.audience.branches.includes(b.id)).map((b) => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                            ))}
                          </SearchSelect>
                        </div>
                      </div>
                      <div>
                        <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Also these people</span>
                        {personPicker('— Type to add a person —', form.audience.include, (id) => setAud('include', [...form.audience.include, id]))}
                      </div>
                    </>
                  )}
                  {form.target_type === 'specific' && (
                    <div>
                      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">People</span>
                      {personPicker('— Type a name, Employee ID, designation… —', form.target_user_ids, (id) => set('target_user_ids', [...form.target_user_ids, id]))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5">
                    {form.target_type === 'groups' &&
                      form.audience.departments.map((id) => chip(opts?.departments.find((d) => d.id === id)?.name || `Department ${id}`, () => setAud('departments', form.audience.departments.filter((x) => x !== id))))}
                    {form.target_type === 'groups' &&
                      form.audience.branches.map((id) => chip(opts?.branches.find((b) => b.id === id)?.name || `Branch ${id}`, () => setAud('branches', form.audience.branches.filter((x) => x !== id))))}
                    {form.target_type === 'groups' && form.audience.include.map((id) => chip(`+ ${personById.get(id)?.name || id}`, () => setAud('include', form.audience.include.filter((x) => x !== id))))}
                    {form.target_type === 'specific' && form.target_user_ids.map((id) => chip(personById.get(id) ? personText(personById.get(id)!) : String(id), () => set('target_user_ids', form.target_user_ids.filter((x) => x !== id))))}
                    {form.audience.exclude.map((id) => chip(`− ${personById.get(id)?.name || id}`, () => setAud('exclude', form.audience.exclude.filter((x) => x !== id)), 'bg-rose-100 text-rose-800'))}
                  </div>
                  {form.target_type !== 'specific' && (
                    <div>
                      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500 mb-1">Leave out</span>
                      {personPicker('— Type to leave someone out —', form.audience.exclude, (id) => setAud('exclude', [...form.audience.exclude, id]))}
                    </div>
                  )}
                  <div className="flex items-center gap-2 rounded-2xl bg-emerald-50 text-emerald-800 px-3.5 py-2.5 text-sm font-semibold">
                    <Users className="w-4 h-4" /> This reaches <b>{opts ? reach : '…'}</b> {reach === 1 ? 'person' : 'people'}
                  </div>
                </div>
              )}

              {step === 'when' && (
                <div className="space-y-4">
                  <div className="grid sm:grid-cols-3 gap-2" role="radiogroup" aria-label="Priority">
                    {(
                      [
                        ['normal', 'Normal', 'On the Notice Board and Dashboard.'],
                        ['important', 'Important', 'Also pops up after login.'],
                        ['urgent', 'Urgent', 'Pops up until “I have read this” is tapped.']
                      ] as [NoticePriority, string, string][]
                    ).map(([k, l, d]) => (
                      <button
                        key={k}
                        type="button"
                        role="radio"
                        aria-checked={form.priority === k}
                        onClick={() => set('priority', k)}
                        className={`text-left rounded-2xl border px-3 py-2.5 bg-white ${form.priority === k ? 'border-violet-500 ring-2 ring-violet-200' : 'border-slate-200'}`}
                      >
                        <span className={`block text-sm font-bold ${k === 'urgent' ? 'text-rose-600' : 'text-slate-900'}`}>{l}</span>
                        <span className="block text-[11.5px] text-slate-500">{d}</span>
                      </button>
                    ))}
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="space-y-1.5">
                      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Publish</span>
                      <Seg label="Publish" value={form.publish_mode} onChange={(v) => set('publish_mode', v)} options={[['now', 'Now'], ['later', 'Later']]} />
                      {form.publish_mode === 'later' && (
                        <input type="datetime-local" value={form.publish_at} min={dhakaNowLocal()} onChange={(e) => set('publish_at', e.target.value)} className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm" />
                      )}
                    </div>
                    <div className="space-y-1.5">
                      <span className="block text-[11px] font-semibold uppercase tracking-wide text-slate-500">Take down</span>
                      <Seg label="Take down" value={form.expire_mode} onChange={(v) => set('expire_mode', v)} options={[['never', 'Keep it up'], ['at', 'After…']]} />
                      {form.expire_mode === 'at' && (
                        <input type="datetime-local" value={form.expire_at} min={form.publish_at || dhakaNowLocal()} onChange={(e) => set('expire_at', e.target.value)} className="w-full px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm" />
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 -mt-2">Times are Dhaka time.</p>
                  <div className="liquid-glass-inset rounded-2xl px-3.5 py-1">
                    <Toggle on={form.pinned} onChange={(v) => set('pinned', v)} label="📌 Pin it on top of the Notice Board" />
                    <Toggle on={requireAck} disabled={urgent} onChange={(v) => set('require_ack', v)} label="✅ Ask for “I have read this”" hint={urgent ? 'Always on for an urgent notice.' : 'Shows who has read it, and the popup comes back until they tap it.'} />
                    <Toggle on={form.send_push} onChange={(v) => set('send_push', v)} label="📲 Push notification to phones" />
                    {canEmail && <Toggle on={form.send_email} onChange={(v) => set('send_email', v)} label="✉️ Email it too" hint="To each person's email address, from the company's mail account." />}
                    <Toggle on={form.remind_unread} onChange={(v) => set('remind_unread', v)} label="🔁 Remind whoever hasn't read it, next day" />
                  </div>
                </div>
              )}

              {step === 'review' && (
                <div className="space-y-3">
                  <div className="liquid-glass-inset rounded-2xl p-3.5 text-[13px] space-y-1.5">
                    <div className="flex gap-2"><span className="w-28 text-slate-500 shrink-0">Goes to</span><b>{audienceText}</b><span className="text-slate-500">· {reach} {reach === 1 ? 'person' : 'people'}</span></div>
                    <div className="flex gap-2"><span className="w-28 text-slate-500 shrink-0">Priority</span><NoticeBadges priority={form.priority} pinned={form.pinned} /></div>
                    <div className="flex gap-2"><span className="w-28 text-slate-500 shrink-0">Publish</span><b>{form.publish_mode === 'later' && form.publish_at ? fmtWhen(form.publish_at.replace('T', ' ')) : 'Right away'}</b></div>
                    <div className="flex gap-2"><span className="w-28 text-slate-500 shrink-0">Take down</span><b>{form.expire_mode === 'at' && form.expire_at ? fmtWhen(form.expire_at.replace('T', ' ')) : 'Stays up'}</b></div>
                    <div className="flex gap-2"><span className="w-28 text-slate-500 shrink-0">Delivery</span><span>{['Notice Board', form.priority !== 'normal' && 'popup after login', form.send_push && 'push', canEmail && form.send_email && 'email', form.remind_unread && 'reminder next day'].filter(Boolean).join(' · ')}</span></div>
                    <div className="flex gap-2"><span className="w-28 text-slate-500 shrink-0">Read receipt</span><span>{requireAck ? '“I have read this” asked' : 'Opened only'}</span></div>
                    <div className="flex gap-2"><span className="w-28 text-slate-500 shrink-0">Files</span><span>{[form.cover && 'cover picture', form.attachments.length && `${form.attachments.length} attachment${form.attachments.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || '—'}</span></div>
                  </div>
                  <button type="button" onClick={() => setPreviewPopup(true)} className="inline-flex items-center gap-1.5 text-xs font-semibold text-violet-700">
                    <Eye className="w-3.5 h-3.5" /> See it as a popup
                  </button>
                </div>
              )}

              {error && <div className="mt-3 text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
            </div>

            {/* live preview */}
            <div className="hidden lg:flex flex-col min-h-0 border-l border-white/60 bg-white/30 px-4 py-3">
              <div className="flex gap-1 mb-3">
                {([['phone', 'Phone', Smartphone], ['desktop', 'Desktop', Monitor], ['board', 'Board', LayoutList]] as const).map(([k, l, I]) => (
                  <button key={k} type="button" onClick={() => setView(k)} className={`flex-1 flex items-center justify-center gap-1 py-1.5 rounded-full text-[11px] font-semibold ${view === k ? 'bg-slate-900 text-white' : 'bg-white text-slate-500 border border-slate-200'}`}>
                    <I className="w-3.5 h-3.5" /> {l}
                  </button>
                ))}
              </div>
              <div className="flex-1 min-h-0 overflow-y-auto">
                {view === 'phone' && (
                  <div className="mx-auto w-[270px] rounded-[38px] bg-slate-900 p-2 shadow-xl">
                    <div className="rounded-[30px] overflow-hidden h-[500px] relative" style={{ background: 'linear-gradient(#6d28d9,#a855f7 32%,#f5f3ff 32%)' }}>
                      <div className="absolute inset-0 bg-slate-900/30 backdrop-blur-[2px]" />
                      <div className="absolute inset-x-2.5 top-10 bottom-4 rounded-[24px] bg-white/95 flex flex-col overflow-hidden">
                        <div className="flex-1 overflow-y-auto p-3 text-[12px]">{preview}</div>
                        <div className="p-2.5 space-y-1.5">
                          <div className="rounded-full py-2 text-center text-xs font-bold text-white" style={{ background: 'var(--g-accent,#7f00ff)' }}>{requireAck ? 'I have read this' : 'Got it'}</div>
                          {requireAck && <div className="text-center text-[11px] text-slate-500">Remind me later</div>}
                        </div>
                      </div>
                    </div>
                  </div>
                )}
                {view === 'desktop' && <div className="rounded-2xl bg-white p-4 shadow-sm border border-slate-200">{preview}</div>}
                {view === 'board' && (
                  <div className="rounded-2xl bg-white p-3 shadow-sm border border-slate-200">
                    <div className="flex items-center gap-2 mb-1">
                      <NoticeBadges priority={form.priority} pinned={form.pinned} />
                    </div>
                    <div className="text-sm font-bold text-slate-900">{form.title || 'Untitled notice'}</div>
                    <div className="text-[11px] text-slate-500 mb-2">{meta}</div>
                    <NoticeContent html={form.content_html} token={token} className="text-[12.5px] line-clamp-6" />
                    <NoticeAttachments files={form.attachments} token={token} compact />
                  </div>
                )}
                <p className="text-[11px] text-slate-500 text-center mt-3">{opts ? `Goes to ${reach} ${reach === 1 ? 'person' : 'people'}` : ''}</p>
              </div>
            </div>
          </div>

          {/* footer */}
          <div className="flex flex-wrap items-center justify-between gap-2 px-5 py-3 border-t border-white/60">
            <span className="text-[11px] text-slate-500">{notice ? (notice.status === 'live' ? 'Live now — changes show at once.' : `Now: ${notice.status}`) : 'Kept in this browser until you publish or save it.'}</span>
            <div className="flex flex-wrap gap-2">
              {stepIndex > 0 && (
                <button type="button" onClick={() => setStep(STEPS[stepIndex - 1].key)} className="px-4 py-2 rounded-full text-sm font-semibold bg-white border border-slate-200 inline-flex items-center gap-1">
                  <ChevronLeft className="w-4 h-4" /> Back
                </button>
              )}
              <button type="button" disabled={saving} onClick={() => void save(false)} className="px-4 py-2 rounded-full text-sm font-semibold bg-white border border-slate-200 inline-flex items-center gap-1.5 disabled:opacity-60">
                <Save className="w-4 h-4" /> Save as draft
              </button>
              {step !== 'review' ? (
                <button type="button" onClick={() => setStep(STEPS[stepIndex + 1].key)} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold inline-flex items-center gap-1">
                  Next <ChevronRight className="w-4 h-4" />
                </button>
              ) : (
                <button type="button" disabled={saving} onClick={() => void save(true)} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold inline-flex items-center gap-1.5 disabled:opacity-60">
                  {saving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Send className="w-4 h-4" />} {publishLabel}
                </button>
              )}
            </div>
          </div>
        </div>
      </div>

      <input ref={attachInput} type="file" multiple className="hidden" accept=".pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.txt,.csv,image/*" onChange={(e) => { const f = Array.from(e.target.files || []); e.target.value = ''; void addAttachments(f); }} />
      <input ref={coverInput} type="file" className="hidden" accept="image/png,image/jpeg,image/webp,image/gif" onChange={(e) => { const f = e.target.files?.[0]; e.target.value = ''; if (f) void setCover(f); }} />

      {previewPopup && (
        <div className="liquid-glass-backdrop fixed inset-0 z-[80] flex items-center justify-center p-4" onClick={() => setPreviewPopup(false)}>
          <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <div className="liquid-glass liquid-glass-in rounded-[32px] p-5 max-h-[85vh] overflow-y-auto">
              {preview}
              <button type="button" onClick={() => setPreviewPopup(false)} className="liquid-glass-button rounded-full w-full py-2.5 mt-4 text-sm font-semibold">
                {requireAck ? 'I have read this' : 'Got it'} (preview)
              </button>
            </div>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};
