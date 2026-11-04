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
  Smartphone, Monitor, LayoutList, Send, Save, ChevronRight, ChevronLeft, Loader2, Eye, Check, Megaphone, Upload, Pin, Mail, Repeat, AlertTriangle
} from 'lucide-react';
import type { ActiveNotice, Notice, NoticeAudience, NoticeAudiencePerson, NoticeFile, NoticePriority, User } from '../../types';
import { apiUrl } from '../../lib/api';
import { SearchSelect } from '../Combobox';
import { NoticeEditor, NoticeEditorHandle } from './NoticeEditor';
import { NoticeCover, NoticeBadges, PRIORITY_STYLE, PRIORITY_TILE, noticeText } from './NoticeParts';
import { NoticeArticle } from './NoticeDetail';
import { NoticeSheet } from '../NoticePopup';
import { BoardCard } from '../NoticeBoard';
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

const Toggle: React.FC<{ on: boolean; onChange: (v: boolean) => void; label: React.ReactNode; hint?: string; disabled?: boolean; icon?: React.ComponentType<{ className?: string }> }> = ({ on, onChange, label, hint, disabled, icon: I }) => (
  <label className={`flex items-center justify-between gap-3 py-2.5 border-t border-slate-100 first:border-t-0 ${disabled ? 'opacity-60' : 'cursor-pointer'}`}>
    <span className="flex items-center gap-3 min-w-0">
      {I && (
        <span className={`w-8 h-8 rounded-[11px] shrink-0 flex items-center justify-center ${on ? 'bg-violet-100 text-violet-700' : 'bg-slate-100 text-slate-400'}`}>
          <I className="w-4 h-4" />
        </span>
      )}
      <span className="min-w-0">
        <span className="block text-[13px] font-semibold text-slate-800">{label}</span>
        {hint && <span className="block text-[11px] text-slate-500">{hint}</span>}
      </span>
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
  <div className="flex rounded-full bg-slate-200/60 p-1 gap-1" role="radiogroup" aria-label={label}>
    {options.map(([k, l, Icon]) => (
      <button key={k} type="button" role="radio" aria-checked={value === k} onClick={() => onChange(k)} className={`flex-1 flex items-center justify-center gap-1.5 py-2 px-2 rounded-full text-xs font-semibold ${value === k ? 'bg-white text-slate-900 shadow-[0_4px_10px_-6px_rgba(15,23,42,0.4)]' : 'text-slate-500 hover:text-slate-700'}`}>
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
  const whenLabel = form.publish_mode === 'later' && form.publish_at ? fmtWhen(form.publish_at.replace('T', ' ')) : 'Right away';
  const stepSub: Record<StepKey, string> = {
    write: form.title.trim() ? form.title.trim() : 'Title & message',
    who: opts ? `${form.target_type === 'all' ? 'Everyone' : form.target_type === 'groups' ? 'Groups' : 'People'} · ${reach}` : 'Everyone',
    when: `${PRIORITY_STYLE[form.priority].label} · ${form.publish_mode === 'later' ? 'Later' : 'Now'}`,
    review: problems() ? 'Something to fix' : 'Ready'
  };
  const issue = problems();
  const issueStep: StepKey | null = !issue ? null : issue.includes('title') || issue.includes('Write') ? 'write' : issue.includes('Pick at least') ? 'who' : 'when';

  // The notice as people will get it, for the previews.
  const previewNotice: ActiveNotice = {
    id: 0,
    title: form.title.trim() || 'Untitled notice',
    content_html: contentIsEmpty ? '<p>Your message shows here.</p>' : form.content_html,
    priority: form.priority,
    pinned: form.pinned,
    require_ack: requireAck,
    cover: coverLocal ? null : form.cover,
    attachments: form.attachments,
    created_at: form.publish_mode === 'later' && form.publish_at ? form.publish_at : new Date().toISOString(),
    from_name: user.name,
    opened_at: null,
    lottie_json: form.lottie_json || null,
    lottie_url: form.lottie_url || null
  };
  const noop = () => {};
  const sheetPreview = (
    <NoticeSheet notice={previewNotice} token={token} done={0} total={1} coverLocalUrl={coverLocal} onAck={noop} onRemind={noop} onDismiss={noop} onReadFull={noop} />
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
    <SearchSelect value="" onChange={(e) => e.target.value && onAdd(Number(e.target.value))} className={inputCls}>
      <option value="">{placeholder}</option>
      {people.filter((p) => !chosen.includes(p.id)).map((p) => (
        <option key={p.id} value={p.id}>
          {personText(p)}
        </option>
      ))}
    </SearchSelect>
  );

  const extTone = (f: NoticeFile) =>
    /pdf/i.test(f.mimetype) ? 'from-rose-400 to-rose-600' : /sheet|excel|csv/i.test(f.mimetype) ? 'from-emerald-400 to-emerald-600' : /word|document/i.test(f.mimetype) ? 'from-sky-400 to-blue-600' : 'from-violet-400 to-violet-600';

  return createPortal(
    <div className="liquid-glass-backdrop fixed inset-0 z-[70] flex items-stretch sm:items-center justify-center sm:p-4">
      <div className="w-full max-w-6xl h-full sm:h-auto">
        <div className="liquid-glass liquid-glass-in sm:rounded-[32px] h-full sm:h-[94vh] flex flex-col overflow-hidden">
          {/* header */}
          <div className="flex items-center gap-3 px-5 pt-4 pb-3">
            <span className="w-11 h-11 rounded-[15px] shrink-0 flex items-center justify-center text-white bg-gradient-to-br from-violet-400 to-violet-700 shadow-[0_8px_18px_-8px_rgba(124,0,255,0.8)]">
              <Megaphone className="w-5 h-5" />
            </span>
            <div className="flex-1 min-w-0">
              <h3 className="text-[17px] font-extrabold tracking-tight text-slate-900">{notice ? 'Edit notice' : copyOf ? 'Copy of a notice' : 'New notice'}</h3>
              <p className="text-[11.5px] text-slate-500 truncate">Write it, choose who gets it and when — the right side shows it exactly as people will see it.</p>
            </div>
            {!notice && (form.title || !contentIsEmpty) && (
              <span className="hidden sm:inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700 bg-emerald-50 border border-emerald-100 rounded-full px-2.5 py-1 shrink-0">
                <CheckCircle2 className="w-3.5 h-3.5" /> Kept in this browser
              </span>
            )}
            <button type="button" onClick={onClose} className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600 shrink-0" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          </div>

          {/* steps */}
          <div className="px-5 pb-3">
            <div className="liquid-glass-inset rounded-[22px] p-1.5 flex items-stretch gap-1 overflow-x-auto no-scrollbar">
              {STEPS.map((s, i) => {
                const on = s.key === step;
                const past = i < stepIndex;
                const bad = s.key === issueStep && step === 'review';
                return (
                  <button
                    key={s.key}
                    type="button"
                    ref={on ? (el) => el?.scrollIntoView({ block: 'nearest', inline: 'center' }) : undefined}
                    onClick={() => setStep(s.key)}
                    aria-current={on ? 'step' : undefined}
                    className={`flex-1 min-w-[150px] flex items-center gap-2.5 px-2.5 py-2 rounded-[17px] text-left transition-colors ${on ? 'bg-white shadow-[0_6px_16px_-10px_rgba(76,29,149,0.6)]' : 'hover:bg-white/50'}`}
                  >
                    <span
                      className={`w-8 h-8 rounded-full shrink-0 flex items-center justify-center text-xs font-bold ${
                        on ? 'text-white shadow-[0_6px_14px_-6px_rgba(124,0,255,0.9)]' : bad ? 'bg-amber-100 text-amber-700' : past ? 'bg-emerald-500 text-white' : 'bg-white text-slate-400 border border-slate-200'
                      }`}
                      style={on ? { background: 'linear-gradient(135deg, #b36aff, var(--g-accent,#7f00ff))' } : undefined}
                    >
                      {past && !on && !bad ? <Check className="w-4 h-4" /> : <s.icon className="w-4 h-4" />}
                    </span>
                    <span className="min-w-0">
                      <span className={`block text-[12.5px] font-bold ${on ? 'text-slate-900' : 'text-slate-600'}`}>
                        {i + 1}. {s.label}
                      </span>
                      <span className={`block text-[11px] truncate max-w-[150px] ${bad ? 'text-amber-700' : 'text-slate-400'}`}>{stepSub[s.key]}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          </div>

          <div className="flex-1 min-h-0 grid lg:grid-cols-[1fr_380px] gap-0 overflow-hidden border-t border-white/60">
            <div className="min-h-0 overflow-y-auto px-5 py-4">
              {restorable && (
                <div className="mb-4 flex flex-wrap items-center gap-2 rounded-2xl bg-amber-50 border border-amber-200 px-3.5 py-2.5 text-xs text-amber-900">
                  <Save className="w-4 h-4 text-amber-600" />
                  You have an unsaved notice from earlier{restorable.title ? ` — “${restorable.title}”` : ''}.
                  <span className="ml-auto flex gap-3">
                    <button type="button" className="font-bold underline" onClick={() => { setForm(restorable); setRestorable(null); setResetKey((k) => k + 1); }}>Continue it</button>
                    <button type="button" className="text-amber-700" onClick={() => { clearDraft(); setRestorable(null); }}>Discard</button>
                  </span>
                </div>
              )}

              {step === 'write' && (
                <div className="space-y-5">
                  <div>
                    <SectionLabel>Start from a template</SectionLabel>
                    <div className="flex gap-2 overflow-x-auto no-scrollbar -mx-5 px-5 pb-1">
                      {TEMPLATES.map((t) => {
                        const [emoji, ...rest] = t.label.split(' ');
                        return (
                          <button
                            key={t.key}
                            type="button"
                            onClick={() => void applyTemplate(t.key)}
                            className="shrink-0 flex items-center gap-2 pl-1.5 pr-3.5 py-1.5 rounded-2xl bg-white/80 border border-white shadow-[0_4px_12px_-10px_rgba(76,29,149,0.6)] text-xs font-semibold text-slate-700 hover:text-violet-700 hover:border-violet-200"
                          >
                            <span className="w-8 h-8 rounded-xl bg-violet-50 flex items-center justify-center text-base">{emoji}</span>
                            {rest.join(' ')}
                          </button>
                        );
                      })}
                    </div>
                  </div>

                  <div>
                    <div className="flex items-end justify-between mb-1.5">
                      <SectionLabel className="mb-0">Title</SectionLabel>
                      <span className={`text-[10.5px] ${form.title.length > 180 ? 'text-amber-600' : 'text-slate-400'}`}>{form.title.length}/200</span>
                    </div>
                    <input
                      value={form.title}
                      onChange={(e) => set('title', e.target.value)}
                      maxLength={200}
                      placeholder="e.g. Office closed on 16 December — Victory Day"
                      className="w-full px-4 py-3 rounded-2xl border border-white bg-white/90 text-[16px] font-semibold text-slate-900 placeholder:font-normal placeholder:text-slate-400 shadow-[0_6px_18px_-14px_rgba(76,29,149,0.6)] focus:outline-none focus:ring-2 focus:ring-violet-200"
                    />
                  </div>

                  <div>
                    <SectionLabel>Message</SectionLabel>
                    <NoticeEditor
                      ref={editor}
                      value={form.content_html}
                      resetKey={resetKey}
                      onChange={(h) => set('content_html', h)}
                      token={token}
                      onUploadImage={(f) => uploadNoticeFile(token, f, 'image')}
                    />
                    <p className="text-[11px] text-slate-500 mt-1.5">Bangla or English · Enter for a new line · drop, paste (Ctrl+V) or pick pictures — big photos are made smaller by themselves.</p>
                  </div>

                  <div className="grid sm:grid-cols-2 gap-3">
                    {/* cover */}
                    <div
                      className="rounded-[22px] bg-white/70 border border-white p-3 shadow-[0_8px_20px_-16px_rgba(76,29,149,0.6)]"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        const f = Array.from(e.dataTransfer.files || []).find((x) => x.type.startsWith('image/'));
                        if (f) void setCover(f);
                      }}
                    >
                      <CardTitle icon={ImagePlus} title="Cover picture" hint="optional" />
                      {form.cover ? (
                        <div className="relative rounded-2xl overflow-hidden">
                          <NoticeCover file={coverLocal ? null : form.cover} localUrl={coverLocal} token={token} className="h-32" />
                          <div className="absolute inset-x-0 bottom-0 p-2 flex justify-end gap-1.5 bg-gradient-to-t from-black/50 to-transparent">
                            <button type="button" onClick={() => coverInput.current?.click()} className="px-3 py-1.5 rounded-full text-[11px] font-semibold text-white bg-white/25 border border-white/60 backdrop-blur-md">
                              Change
                            </button>
                            <button type="button" onClick={() => { set('cover', null); setCoverLocal(null); }} className="w-8 h-8 rounded-full bg-white/90 text-rose-600 flex items-center justify-center" aria-label="Remove cover">
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>
                      ) : (
                        <button type="button" onClick={() => coverInput.current?.click()} className="w-full h-32 rounded-2xl border-2 border-dashed border-violet-200 bg-gradient-to-br from-violet-50/80 to-sky-50/60 flex flex-col items-center justify-center gap-1.5 hover:border-violet-400">
                          <span className="w-10 h-10 rounded-full bg-white flex items-center justify-center text-violet-600 shadow-sm">
                            {uploading ? <Loader2 className="w-4.5 h-4.5 animate-spin" /> : <ImagePlus className="w-4.5 h-4.5" />}
                          </span>
                          <span className="text-xs font-bold text-violet-700">Pick or drop a picture</span>
                          <span className="text-[10.5px] text-slate-500">Shown across the top · wide pictures look best</span>
                        </button>
                      )}
                    </div>

                    {/* attachments */}
                    <div
                      className="rounded-[22px] bg-white/70 border border-white p-3 shadow-[0_8px_20px_-16px_rgba(76,29,149,0.6)]"
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={(e) => {
                        e.preventDefault();
                        void addAttachments(Array.from(e.dataTransfer.files || []));
                      }}
                    >
                      <CardTitle icon={Paperclip} title="Attachments" hint="PDF, Word, Excel… up to 20 MB" />
                      <div className="space-y-1.5">
                        {form.attachments.map((a) => (
                          <div key={a.id} className="flex items-center gap-2.5 bg-white rounded-2xl p-1.5 pr-2.5 text-xs border border-slate-100">
                            <span className={`w-8 h-9 rounded-[9px] shrink-0 flex items-end justify-center pb-1 text-[8.5px] font-extrabold text-white bg-gradient-to-br ${extTone(a)}`}>
                              {(a.name.split('.').pop() || 'file').slice(0, 4).toUpperCase()}
                            </span>
                            <span className="flex-1 min-w-0">
                              <span className="block truncate font-semibold text-slate-800">{a.name}</span>
                              <span className="block text-[10.5px] text-slate-400">{fileSize(a.size)}</span>
                            </span>
                            <button type="button" onClick={() => set('attachments', form.attachments.filter((x) => x.id !== a.id))} className="w-7 h-7 rounded-full hover:bg-rose-50 text-rose-600 flex items-center justify-center" aria-label={`Remove ${a.name}`}>
                              <X className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        ))}
                        <button
                          type="button"
                          onClick={() => attachInput.current?.click()}
                          className={`w-full rounded-2xl border-2 border-dashed border-violet-200 bg-gradient-to-br from-violet-50/80 to-sky-50/60 flex items-center justify-center gap-2 text-xs font-bold text-violet-700 hover:border-violet-400 ${form.attachments.length ? 'py-2.5' : 'h-32 flex-col'}`}
                        >
                          <span className="w-10 h-10 rounded-full bg-white flex items-center justify-center shadow-sm" style={form.attachments.length ? { width: 28, height: 28 } : undefined}>
                            {uploading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Upload className="w-4 h-4" />}
                          </span>
                          {uploading ? 'Uploading…' : form.attachments.length ? 'Add another file' : 'Pick or drop files'}
                        </button>
                      </div>
                    </div>
                  </div>

                  <div className="rounded-[22px] bg-white/60 border border-white">
                    <button type="button" onClick={() => setShowAnim(!showAnim)} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left">
                      <span className="w-8 h-8 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center">
                        <Sparkles className="w-4 h-4" />
                      </span>
                      <span className="flex-1">
                        <span className="block text-[13px] font-bold text-slate-800">Animation</span>
                        <span className="block text-[11px] text-slate-500">Optional — a Lottie animation at the top instead of a picture</span>
                      </span>
                      <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${showAnim ? 'rotate-90' : ''}`} />
                    </button>
                    {showAnim && (
                      <div className="grid sm:grid-cols-2 gap-2 px-3 pb-3">
                        <textarea value={form.lottie_json} onChange={(e) => set('lottie_json', e.target.value)} rows={3} placeholder='Paste Lottie JSON {"v":"5.7.0",…}' className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-mono" />
                        <input value={form.lottie_url} onChange={(e) => set('lottie_url', e.target.value)} placeholder="or a link to one: https://…/animation.json" className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs" />
                      </div>
                    )}
                  </div>
                </div>
              )}

              {step === 'who' && (
                <div className="space-y-5">
                  <div className="grid sm:grid-cols-3 gap-2.5" role="radiogroup" aria-label="Who gets it">
                    {(
                      [
                        ['all', 'Everyone', 'All staff with an account.', Globe],
                        ['groups', 'Groups', 'Departments, branches / sites, plus people.', UsersRound],
                        ['specific', 'Specific people', 'Only the people you pick.', UserRound]
                      ] as [Form['target_type'], string, string, React.ComponentType<{ className?: string }>][]
                    ).map(([k, l, d, I]) => (
                      <OptionCard key={k} on={form.target_type === k} onClick={() => set('target_type', k)} icon={I} title={l} text={d} />
                    ))}
                  </div>

                  {form.target_type === 'groups' && (
                    <div className="rounded-[22px] bg-white/70 border border-white p-3.5 space-y-3">
                      <div className="grid sm:grid-cols-2 gap-3">
                        <div>
                          <SectionLabel>Department</SectionLabel>
                          <SearchSelect value="" onChange={(e) => e.target.value && setAud('departments', [...form.audience.departments, Number(e.target.value)])} className={inputCls}>
                            <option value="">— Type to add a department —</option>
                            {(opts?.departments || []).filter((d) => !form.audience.departments.includes(d.id)).map((d) => (
                              <option key={d.id} value={d.id}>{d.name}</option>
                            ))}
                          </SearchSelect>
                        </div>
                        <div>
                          <SectionLabel>Branch / site</SectionLabel>
                          <SearchSelect value="" onChange={(e) => e.target.value && setAud('branches', [...form.audience.branches, Number(e.target.value)])} className={inputCls}>
                            <option value="">— Type to add a branch —</option>
                            {(opts?.branches || []).filter((b) => !form.audience.branches.includes(b.id)).map((b) => (
                              <option key={b.id} value={b.id}>{b.name}</option>
                            ))}
                          </SearchSelect>
                        </div>
                      </div>
                      <div>
                        <SectionLabel>Also these people</SectionLabel>
                        {personPicker('— Type to add a person —', form.audience.include, (id) => setAud('include', [...form.audience.include, id]))}
                      </div>
                    </div>
                  )}
                  {form.target_type === 'specific' && (
                    <div className="rounded-[22px] bg-white/70 border border-white p-3.5">
                      <SectionLabel>People</SectionLabel>
                      {personPicker('— Type a name, Employee ID, designation… —', form.target_user_ids, (id) => set('target_user_ids', [...form.target_user_ids, id]))}
                    </div>
                  )}
                  <div className="flex flex-wrap gap-1.5 empty:hidden">
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
                      <SectionLabel>Leave out</SectionLabel>
                      {personPicker('— Type to leave someone out —', form.audience.exclude, (id) => setAud('exclude', [...form.audience.exclude, id]))}
                    </div>
                  )}
                  <div className="flex items-center gap-3.5 rounded-[22px] bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-100 px-4 py-3.5">
                    <span className="w-11 h-11 rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white flex items-center justify-center shadow-[0_8px_16px_-8px_rgba(16,185,129,0.9)]">
                      <Users className="w-5 h-5" />
                    </span>
                    <span>
                      <span className="block text-2xl font-extrabold text-emerald-800 leading-none">{opts ? reach : '…'}</span>
                      <span className="block text-xs text-emerald-700 mt-1">{reach === 1 ? 'person gets' : 'people get'} this notice · {audienceText}</span>
                    </span>
                  </div>
                </div>
              )}

              {step === 'when' && (
                <div className="space-y-5">
                  <div>
                    <SectionLabel>How important is it?</SectionLabel>
                    <div className="grid sm:grid-cols-3 gap-2.5" role="radiogroup" aria-label="Priority">
                      {(
                        [
                          ['normal', 'Normal', 'On the Notice Board and Dashboard.'],
                          ['important', 'Important', 'Also pops up after login.'],
                          ['urgent', 'Urgent', 'Pops up until “I have read this” is tapped.']
                        ] as [NoticePriority, string, string][]
                      ).map(([k, l, d]) => (
                        <OptionCard key={k} on={form.priority === k} onClick={() => set('priority', k)} icon={PRIORITY_TILE[k].Icon} tile={PRIORITY_TILE[k].cls} title={l} text={d} danger={k === 'urgent'} />
                      ))}
                    </div>
                  </div>
                  <div className="grid sm:grid-cols-2 gap-3">
                    <div className="rounded-[22px] bg-white/70 border border-white p-3.5 space-y-2">
                      <CardTitle icon={Send} title="Publish" />
                      <Seg label="Publish" value={form.publish_mode} onChange={(v) => set('publish_mode', v)} options={[['now', 'Now'], ['later', 'Later']]} />
                      {form.publish_mode === 'later' && (
                        <input type="datetime-local" value={form.publish_at} min={dhakaNowLocal()} onChange={(e) => set('publish_at', e.target.value)} className={inputCls} />
                      )}
                    </div>
                    <div className="rounded-[22px] bg-white/70 border border-white p-3.5 space-y-2">
                      <CardTitle icon={CalendarClock} title="Take down" />
                      <Seg label="Take down" value={form.expire_mode} onChange={(v) => set('expire_mode', v)} options={[['never', 'Keep it up'], ['at', 'After…']]} />
                      {form.expire_mode === 'at' && (
                        <input type="datetime-local" value={form.expire_at} min={form.publish_at || dhakaNowLocal()} onChange={(e) => set('expire_at', e.target.value)} className={inputCls} />
                      )}
                    </div>
                  </div>
                  <p className="text-[11px] text-slate-500 -mt-3">Times are Dhaka time.</p>
                  <div>
                    <SectionLabel>Options</SectionLabel>
                    <div className="rounded-[22px] bg-white/70 border border-white px-3.5 py-1">
                      <Toggle icon={Pin} on={form.pinned} onChange={(v) => set('pinned', v)} label="Pin it on top of the Notice Board" />
                      <Toggle icon={CheckCircle2} on={requireAck} disabled={urgent} onChange={(v) => set('require_ack', v)} label="Ask for “I have read this”" hint={urgent ? 'Always on for an urgent notice.' : 'Shows who has read it, and the popup comes back until they tap it.'} />
                      <Toggle icon={Smartphone} on={form.send_push} onChange={(v) => set('send_push', v)} label="Push notification to phones" />
                      {canEmail && <Toggle icon={Mail} on={form.send_email} onChange={(v) => set('send_email', v)} label="Email it too" hint="To each person's email address, from the company's mail account." />}
                      <Toggle icon={Repeat} on={form.remind_unread} onChange={(v) => set('remind_unread', v)} label="Remind whoever hasn't read it, next day" />
                    </div>
                  </div>
                </div>
              )}

              {step === 'review' && (
                <div className="space-y-4">
                  {issue ? (
                    <div className="flex items-center gap-3 rounded-[22px] bg-amber-50 border border-amber-200 px-4 py-3">
                      <span className="w-10 h-10 rounded-2xl bg-amber-400 text-white flex items-center justify-center shrink-0">
                        <AlertTriangle className="w-5 h-5" />
                      </span>
                      <span className="flex-1 text-sm text-amber-900">
                        <b className="block">One thing before it can go out</b>
                        {issue}
                      </span>
                      {issueStep && (
                        <button type="button" onClick={() => setStep(issueStep)} className="px-3.5 py-2 rounded-full bg-white text-xs font-bold text-amber-800 border border-amber-200 shrink-0">
                          Fix it
                        </button>
                      )}
                    </div>
                  ) : (
                    <div className="flex items-center gap-3 rounded-[22px] bg-gradient-to-br from-emerald-50 to-teal-50 border border-emerald-100 px-4 py-3">
                      <span className="w-10 h-10 rounded-2xl bg-gradient-to-br from-emerald-400 to-teal-600 text-white flex items-center justify-center shrink-0">
                        <CheckCircle2 className="w-5 h-5" />
                      </span>
                      <span className="text-sm text-emerald-900">
                        <b className="block">Ready to {form.publish_mode === 'later' ? 'schedule' : 'publish'}</b>
                        {reach} {reach === 1 ? 'person' : 'people'} · {whenLabel}
                      </span>
                    </div>
                  )}
                  <div className="rounded-[22px] bg-white/75 border border-white divide-y divide-slate-100">
                    <ReviewRow icon={Users} label="Goes to" onEdit={() => setStep('who')}>
                      <b>{audienceText}</b> <span className="text-slate-500">· {reach} {reach === 1 ? 'person' : 'people'}</span>
                    </ReviewRow>
                    <ReviewRow icon={Megaphone} label="Priority" onEdit={() => setStep('when')}>
                      <NoticeBadges priority={form.priority} pinned={form.pinned} />
                    </ReviewRow>
                    <ReviewRow icon={Send} label="Publish" onEdit={() => setStep('when')}>
                      <b>{whenLabel}</b>
                    </ReviewRow>
                    <ReviewRow icon={CalendarClock} label="Take down" onEdit={() => setStep('when')}>
                      <b>{form.expire_mode === 'at' && form.expire_at ? fmtWhen(form.expire_at.replace('T', ' ')) : 'Stays up'}</b>
                    </ReviewRow>
                    <ReviewRow icon={Smartphone} label="Delivery" onEdit={() => setStep('when')}>
                      {['Notice Board', form.priority !== 'normal' && 'popup after login', form.send_push && 'push', canEmail && form.send_email && 'email', form.remind_unread && 'reminder next day'].filter(Boolean).join(' · ')}
                    </ReviewRow>
                    <ReviewRow icon={CheckCircle2} label="Read receipt" onEdit={() => setStep('when')}>
                      {requireAck ? '“I have read this” asked' : 'Opened only'}
                    </ReviewRow>
                    <ReviewRow icon={Paperclip} label="Files" onEdit={() => setStep('write')}>
                      {[form.cover && 'cover picture', form.attachments.length && `${form.attachments.length} attachment${form.attachments.length === 1 ? '' : 's'}`].filter(Boolean).join(' · ') || '—'}
                    </ReviewRow>
                  </div>
                  <button type="button" onClick={() => setPreviewPopup(true)} className="inline-flex items-center gap-1.5 text-xs font-bold text-violet-700">
                    <Eye className="w-3.5 h-3.5" /> See it as a popup
                  </button>
                </div>
              )}

              {error && <div className="mt-4 text-xs px-3.5 py-2.5 rounded-2xl bg-rose-50 border border-rose-100 text-rose-700">{error}</div>}
            </div>

            {/* live preview */}
            <div className="hidden lg:flex flex-col min-h-0 border-l border-white/60 bg-gradient-to-b from-white/40 to-violet-50/40 px-4 py-3">
              <div className="flex items-center justify-between mb-2.5">
                <span className="text-[11px] font-extrabold tracking-[0.09em] text-slate-400">LIVE PREVIEW</span>
                <span className="text-[11px] text-slate-500">{opts ? `${reach} ${reach === 1 ? 'person' : 'people'}` : ''}</span>
              </div>
              <Seg
                label="Preview"
                value={view}
                onChange={setView}
                options={[
                  ['phone', 'Popup', Smartphone],
                  ['desktop', 'Opened', Monitor],
                  ['board', 'Board', LayoutList]
                ]}
              />
              <div className="flex-1 min-h-0 overflow-y-auto mt-3 pb-2">
                {view === 'phone' && (
                  <div className="mx-auto w-[284px] rounded-[42px] bg-slate-900 p-[7px] shadow-[0_24px_50px_-20px_rgba(15,23,42,0.7)]">
                    <div className="relative rounded-[35px] overflow-hidden h-[520px] bg-[#f3f0fb]">
                      {/* the app behind the popup */}
                      <div className="absolute inset-x-0 top-0 h-[150px] rounded-b-[26px]" style={{ background: 'linear-gradient(120deg, #7c00ff, #5b00c8)' }} />
                      <div className="absolute left-4 right-4 top-[165px] grid grid-cols-3 gap-3">
                        {['bg-sky-300', 'bg-violet-300', 'bg-rose-300', 'bg-indigo-300', 'bg-cyan-300', 'bg-lime-300'].map((c) => (
                          <span key={c} className={`h-16 rounded-2xl ${c} opacity-70`} />
                        ))}
                      </div>
                      <div className="absolute left-1/2 -translate-x-1/2 top-2 w-20 h-5 rounded-full bg-slate-900 z-20" />
                      <div className="absolute inset-0 liquid-glass-backdrop" />
                      <div className="absolute left-0 bottom-0 w-[390px] origin-bottom-left pointer-events-none" style={{ transform: 'scale(0.6872)' }}>
                        <div className="px-2.5 pb-3">{sheetPreview}</div>
                      </div>
                    </div>
                  </div>
                )}
                {view === 'desktop' && (
                  <div className="rounded-[26px] overflow-hidden bg-[#fbfaff] border border-white shadow-[0_18px_40px_-24px_rgba(76,29,149,0.6)]">
                    <NoticeArticle notice={previewNotice} token={token} coverLocalUrl={coverLocal} />
                    <div className="px-4 pb-4">
                      <div className="liquid-glass-button rounded-full py-2.5 text-center text-sm font-semibold">{requireAck ? 'I have read this' : 'Got it'}</div>
                    </div>
                  </div>
                )}
                {view === 'board' && (
                  <div className="rounded-[26px] p-3 bg-gradient-to-b from-[#f6f3ff] to-[#efeafb] border border-white">
                    <p className="text-lg font-extrabold tracking-tight text-slate-900 px-1">Notices</p>
                    <p className="text-[11px] text-slate-500 px-1 mb-3">How it sits on the Notice Board</p>
                    <BoardCard n={previewNotice} token={token} text={noticeText(previewNotice.content_html)} onOpen={noop} onAck={noop} coverLocalUrl={coverLocal} />
                  </div>
                )}
              </div>
            </div>
          </div>

          {/* footer */}
          <div className="flex flex-wrap items-center justify-end sm:justify-between gap-2 px-5 py-3 border-t border-white/60 bg-white/30" style={{ paddingBottom: 'max(0.75rem, env(safe-area-inset-bottom))' }}>
            <span className="hidden sm:flex text-[11px] text-slate-500 items-center gap-1.5">
              <span className={`w-1.5 h-1.5 rounded-full ${notice?.status === 'live' ? 'bg-emerald-500' : 'bg-slate-400'}`} />
              {notice ? (notice.status === 'live' ? 'Live now — changes show at once.' : `Now: ${notice.status}`) : 'Kept in this browser until you publish or save it.'}
            </span>
            <div className="flex flex-wrap justify-end gap-2">
              <button type="button" onClick={() => setPreviewPopup(true)} aria-label="Preview" className="lg:hidden px-4 py-2 rounded-full text-sm font-semibold bg-white border border-slate-200 inline-flex items-center gap-1.5">
                <Eye className="w-4 h-4" /> <span className="hidden sm:inline">Preview</span>
              </button>
              {stepIndex > 0 && (
                <button type="button" onClick={() => setStep(STEPS[stepIndex - 1].key)} aria-label="Back" className="px-4 py-2 rounded-full text-sm font-semibold bg-white border border-slate-200 inline-flex items-center gap-1">
                  <ChevronLeft className="w-4 h-4" /> <span className="hidden sm:inline">Back</span>
                </button>
              )}
              <button type="button" disabled={saving} onClick={() => void save(false)} className="px-4 py-2 rounded-full text-sm font-semibold bg-white border border-slate-200 inline-flex items-center gap-1.5 disabled:opacity-60">
                <Save className="w-4 h-4" /> <span className="hidden sm:inline">Save as draft</span><span className="sm:hidden">Draft</span>
              </button>
              {step !== 'review' ? (
                <button type="button" onClick={() => setStep(STEPS[stepIndex + 1].key)} className="liquid-glass-button rounded-full px-5 py-2 text-sm font-semibold inline-flex items-center gap-1">
                  Next<span className="hidden sm:inline">: {STEPS[stepIndex + 1].label}</span> <ChevronRight className="w-4 h-4" />
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
        <div className="liquid-glass-backdrop fixed inset-0 z-[80] flex items-end sm:items-center justify-center p-2.5 sm:p-4" onClick={() => setPreviewPopup(false)}>
          <div className="w-full max-w-md" onClick={(e) => e.stopPropagation()}>
            <NoticeSheet
              notice={previewNotice}
              token={token}
              done={0}
              total={1}
              coverLocalUrl={coverLocal}
              onAck={() => setPreviewPopup(false)}
              onRemind={() => setPreviewPopup(false)}
              onDismiss={() => setPreviewPopup(false)}
              onReadFull={() => {
                setPreviewPopup(false);
                setView('desktop');
              }}
            />
            <p className="text-center text-[11px] text-white/90 mt-2">Preview — tapping a button only closes it</p>
          </div>
        </div>
      )}
    </div>,
    document.body
  );
};

const inputCls = 'w-full px-3 py-2.5 bg-white border border-slate-200 rounded-xl text-sm';

const SectionLabel: React.FC<{ children: React.ReactNode; className?: string }> = ({ children, className = 'mb-1.5' }) => (
  <span className={`block text-[11px] font-extrabold tracking-[0.08em] uppercase text-slate-400 ${className}`}>{children}</span>
);

const CardTitle: React.FC<{ icon: React.ComponentType<{ className?: string }>; title: string; hint?: string }> = ({ icon: I, title, hint }) => (
  <div className="flex items-center gap-2 mb-2.5">
    <span className="w-7 h-7 rounded-[10px] bg-violet-50 text-violet-600 flex items-center justify-center">
      <I className="w-3.5 h-3.5" />
    </span>
    <span className="text-[13px] font-bold text-slate-800">{title}</span>
    {hint && <span className="text-[11px] text-slate-400 truncate">{hint}</span>}
  </div>
);

const OptionCard: React.FC<{
  on: boolean;
  onClick: () => void;
  icon: React.ComponentType<{ className?: string }>;
  title: string;
  text: string;
  tile?: string;
  danger?: boolean;
}> = ({ on, onClick, icon: I, title, text, tile, danger }) => (
  <button
    type="button"
    role="radio"
    aria-checked={on}
    onClick={onClick}
    className={`relative text-left rounded-[22px] p-3 sm:p-3.5 border transition-all flex items-center gap-3 sm:block ${
      on ? `bg-white shadow-[0_12px_26px_-16px_rgba(76,29,149,0.7)] ${danger ? 'border-rose-300 ring-2 ring-rose-100' : 'border-violet-300 ring-2 ring-violet-100'}` : 'bg-white/60 border-white hover:bg-white/85'
    }`}
  >
    <span className={`w-10 h-10 rounded-[14px] shrink-0 flex items-center justify-center text-white bg-gradient-to-br ${tile || 'from-violet-400 to-violet-700 shadow-[0_8px_16px_-8px_rgba(124,0,255,0.7)]'}`}>
      <I className="w-5 h-5" />
    </span>
    <span className="block min-w-0 pr-6 sm:pr-0">
      <span className={`block text-sm font-bold sm:mt-2.5 ${danger ? 'text-rose-600' : 'text-slate-900'}`}>{title}</span>
      <span className="block text-[11.5px] text-slate-500 mt-0.5 leading-snug">{text}</span>
    </span>
    <span className={`absolute top-1/2 -translate-y-1/2 sm:translate-y-0 sm:top-3 right-3 w-5 h-5 rounded-full flex items-center justify-center ${on ? (danger ? 'bg-rose-500 text-white' : 'bg-[color:var(--g-accent,#7F00FF)] text-white') : 'border-2 border-slate-200'}`}>
      {on && <Check className="w-3 h-3" />}
    </span>
  </button>
);

const ReviewRow: React.FC<{ icon: React.ComponentType<{ className?: string }>; label: string; onEdit: () => void; children: React.ReactNode }> = ({ icon: I, label, onEdit, children }) => (
  <div className="flex items-center gap-3 px-3.5 py-2.5 text-[13px]">
    <span className="w-8 h-8 rounded-[11px] bg-violet-50 text-violet-600 flex items-center justify-center shrink-0">
      <I className="w-4 h-4" />
    </span>
    <span className="w-24 text-slate-500 shrink-0">{label}</span>
    <span className="flex-1 min-w-0 text-slate-800">{children}</span>
    <button type="button" onClick={onEdit} className="text-[11.5px] font-bold text-violet-700 shrink-0">
      Edit
    </button>
  </div>
);
