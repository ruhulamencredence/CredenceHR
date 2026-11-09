/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// "Credence Assistant" — the floating AI helper (AiAssistantRoutes.ts).
// A round sparkle button sits above the Chat button on the website and above
// the bottom bar on phones; it opens a liquid-glass chat card. Answers can
// carry buttons that open the page they talk about (onNavigate).
//
// Shown to every account unless HR switched it off for them in Module Access
// (users.can_use_ai_assistant); the API checks the same switch.
//
// Voice (users.can_use_assistant_voice, off by default; needs Gemini on the
// server): a mic button records a spoken question, the server writes it
// down (POST /api/assistant/transcribe) and it is asked like a typed one;
// the answer to a spoken question is read aloud, and any answer has a
// speaker button (lib/assistantVoice.ts).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarCheck, Car, CheckCircle2, Clock, MapPin, FileSpreadsheet, FileText, Headphones, Loader2, Mic, RotateCcw, Send, Sparkles, Square, Volume2, X } from 'lucide-react';
import { GEMINI_VOICES, MAX_RECORD_SECONDS, deviceBanglaVoices, getVoicePref, prepareVoices, previewVoice, setVoicePref, speak, startRecording, stopRecording, stopSpeaking, toWavBase64, unlockAudio } from '../lib/assistantVoice';
import { useKeyboardInset } from '../lib/useKeyboardInset';
import { apiUrl } from '../lib/api';
import type { User } from '../types';
import { downloadAssistantExcel, downloadAssistantPdf, type AssistantReport } from '../lib/assistantReportExport';
import { EmailReportButton, useCanEmailReports } from '../lib/reportEmail';
import { LiveChat, SupportInbox, supportApi, useSupportSocket, type SupportMessage, type SupportSession } from './AssistantSupport';
import { useIsPhone, useScrolling } from '../lib/useScrolling';

import { SearchSelect } from './Combobox';
import { DurationPicker } from './DurationPicker';
import { getCurrentCoords } from './ClaimCard';
import { personLabel } from '../lib/personLabel';
interface Action { label: string; nav: string }
// A leave application the Assistant filled in (AiAssistantRoutes.ts LeaveDraft).
// Nothing is sent until the person presses "জমা দিন" on the card.
interface LeaveDraft {
  kind: 'leave_application';
  leave_type: string;
  start_date: string;
  end_date: string;
  is_half_day: boolean;
  purpose: string;
  today: string;
  types: { value: string; label: string; balance: number | null; reliever_required: boolean }[];
  relievers: { id: number; name: string }[];
}
// Book a Ride (RideDraft) and Timesheet -> Correct Attendance
// (CorrectionDraft) filled in the same way — nothing is sent until the
// person presses the card's own button.
interface RideDraft {
  kind: 'ride_booking';
  purpose: string;
  pickup_location: string;
  destination: string;
  ride_date: string;
  start_time: string;
  estimated_duration_hours: number;
  self_drive: boolean;
  self_drive_note: string | null;
  today: string;
}
interface CorrectionDraft {
  kind: 'attendance_correction';
  attendance_date: string;
  check_in: string;
  check_out: string;
  remarks: string;
  options: { project_id: number; name: string; check_in: string; check_out: string }[];
  today: string;
}
// Check In/Out: a live Check In (purpose) or Check Out of the open claim —
// the phone's location is taken when the button is pressed.
interface MovementDraft {
  kind: 'movement_claim';
  mode: 'check_in' | 'check_out';
  purpose: string;
  remarks: string;
  claim_id: number | null;
  since: string | null;
}
type AnyDraft = LeaveDraft | RideDraft | CorrectionDraft | MovementDraft;
// What the card says once it's done (and the page it points to).
type DraftDone = (result: 'submitted' | 'cancelled', done?: { text: string; action?: Action }) => void;
interface Msg { role: 'user' | 'assistant'; text: string; actions?: Action[]; draft?: AnyDraft; draftDone?: 'submitted' | 'cancelled'; report?: AssistantReport }

// PDF / Excel of the full list behind an answer. The server only sends a
// report to accounts with "Assistant — report PDF / Excel download" ticked.
const ReportButtons: React.FC<{ token: string; report: AssistantReport; preparedBy: string }> = ({ token, report, preparedBy }) => {
  const [busy, setBusy] = useState<'pdf' | 'xlsx' | 'email' | null>(null);
  const [err, setErr] = useState('');
  const canEmailReports = useCanEmailReports();
  const run = async (kind: 'pdf' | 'xlsx' | 'email') => {
    setBusy(kind);
    setErr('');
    try {
      if (kind === 'pdf') await downloadAssistantPdf(token, report, preparedBy);
      else if (kind === 'email') await downloadAssistantPdf(token, report, preparedBy, 'email');
      else await downloadAssistantExcel(report, preparedBy);
    } catch {
      setErr('ফাইল বানানো যায়নি, আবার চেষ্টা করুন।');
    } finally {
      setBusy(null);
    }
  };
  const btn = 'liquid-glass-chip rounded-full px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50';
  return (
    <div className="mt-2.5">
      <p className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 mb-1">পুরো তালিকা ({report.rows.length})</p>
      <div className="flex flex-wrap gap-1.5">
        <button type="button" disabled={!!busy} onClick={() => run('pdf')} className={`${btn} text-rose-700`} aria-label="Download PDF">
          {busy === 'pdf' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileText className="w-3.5 h-3.5" />} PDF
        </button>
        {canEmailReports && <EmailReportButton onClick={() => run('email')} disabled={!!busy} className={`${btn} text-sky-700`} />}
        <button type="button" disabled={!!busy} onClick={() => run('xlsx')} className={`${btn} text-emerald-700`} aria-label="Download Excel">
          {busy === 'xlsx' ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <FileSpreadsheet className="w-3.5 h-3.5" />} Excel
        </button>
      </div>
      {err && <p className="text-[11px] text-rose-600 mt-1">{err}</p>}
    </div>
  );
};

const dayCountOf = (from: string, to: string, half: boolean) => {
  if (!from || !to || to < from) return 0;
  const days = Math.round((Date.parse(to + 'T00:00:00Z') - Date.parse(from + 'T00:00:00Z')) / 86400000) + 1;
  return half ? Math.max(0.5, days - 0.5) : days;
};

const LeaveDraftCard: React.FC<{ token: string; draft: LeaveDraft; onDone: DraftDone }> = ({ token, draft, onDone }) => {
  const [type, setType] = useState(draft.leave_type);
  const [from, setFrom] = useState(draft.start_date);
  const [to, setTo] = useState(draft.end_date || draft.start_date);
  const [half, setHalf] = useState(draft.is_half_day);
  const [purpose, setPurpose] = useState(draft.purpose);
  const [reliever, setReliever] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const t = draft.types.find((x) => x.value === type);
  // Same rule as the Leave Application form and the server: Sick Leave and a
  // backdated application never need a Reliever.
  const needsReliever = !!t?.reliever_required && type !== 'sick' && !!from && from >= draft.today;
  const days = dayCountOf(from, to, half);
  const field = 'w-full rounded-xl bg-white/70 border border-white/80 px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:ring-2 focus:ring-violet-300';

  const submit = async () => {
    if (!from || !to) return setError('তারিখ দিন।');
    if (to < from) return setError('শেষ তারিখ শুরুর আগে হতে পারে না।');
    if (!purpose.trim()) return setError('কারণ লিখুন।');
    if (needsReliever && !reliever) return setError('Reliever বেছে নিন।');
    setSaving(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/leave-applications'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          leave_type: type,
          start_date: from,
          end_date: to,
          day_count: days,
          is_half_day: half,
          include_extra_work_dates: false,
          is_foreign_leave: false,
          purpose: purpose.trim(),
          reliever_id: needsReliever ? Number(reliever) : null
        })
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || 'আবেদন জমা হয়নি।');
      onDone('submitted', {
        text: `✅ আবেদন জমা হয়েছে — ${t?.label || type}, ${from}${to !== from ? ` – ${to}` : ''} (${days} দিন)। এখন এটা অনুমোদনের অপেক্ষায়; অবস্থা জানতে আমাকে জিজ্ঞেস করুন বা Leave Application খুলুন।`,
        action: { label: 'Leave Application খুলুন', nav: 'self:leaveApplication' }
      });
    } catch (e: any) {
      setError(e.message || 'আবেদন জমা হয়নি।');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="mt-2.5 rounded-2xl bg-white/55 border border-white/80 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-800">
        <CalendarCheck className="w-4 h-4" /> ছুটির আবেদন — দেখে নিন
      </div>
      <label className="block text-[11px] text-slate-500">
        ছুটির ধরন
        <select value={type} onChange={(e) => setType(e.target.value)} className={field}>
          {draft.types.map((x) => (
            <option key={x.value} value={x.value}>
              {x.label}{x.balance != null ? ` (বাকি ${x.balance})` : ''}
            </option>
          ))}
        </select>
      </label>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-slate-500">
          শুরু
          <input type="date" value={from} onChange={(e) => { setFrom(e.target.value); if (!to || to < e.target.value) setTo(e.target.value); }} className={field} />
        </label>
        <label className="block text-[11px] text-slate-500">
          শেষ
          <input type="date" value={to} min={from || undefined} onChange={(e) => setTo(e.target.value)} className={field} />
        </label>
      </div>
      <label className="flex items-center gap-2 text-xs text-slate-700">
        <input type="checkbox" checked={half} onChange={(e) => setHalf(e.target.checked)} className="accent-violet-600" /> Half day
        <span className="ml-auto text-[11px] text-slate-500">{days > 0 ? `মোট ${days} দিন` : ''}</span>
      </label>
      {needsReliever && (
        <label className="block text-[11px] text-slate-500">
          Reliever (আপনার অনুপস্থিতিতে কাজ দেখবেন)
          <SearchSelect value={reliever} onChange={(e) => setReliever(e.target.value)} className={field}>
            <option value="">— বেছে নিন —</option>
            {draft.relievers.map((r) => (
              <option key={r.id} value={r.id}>{personLabel(r)}</option>
            ))}
          </SearchSelect>
        </label>
      )}
      <label className="block text-[11px] text-slate-500">
        কারণ
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={300} className={`${field} resize-none`} />
      </label>
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
      <div className="flex gap-2 pt-0.5">
        <button type="button" onClick={submit} disabled={saving} className="liquid-glass-button flex-1 rounded-full py-2 text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} জমা দিন
        </button>
        <button type="button" onClick={() => onDone('cancelled')} disabled={saving} className="liquid-glass-chip rounded-full px-4 py-2 text-xs text-slate-700">
          বাতিল
        </button>
      </div>
    </div>
  );
};

const cardField = 'w-full rounded-xl bg-white/70 border border-white/80 px-2.5 py-1.5 text-xs text-slate-900 outline-none focus:ring-2 focus:ring-violet-300';

// Book a Ride, filled by the Assistant -> POST /api/vehicles/requisitions
// (the server checks everything the Book a Ride form's own submit does).
const RideDraftCard: React.FC<{ token: string; draft: RideDraft; onDone: DraftDone }> = ({ token, draft, onDone }) => {
  const [pickup, setPickup] = useState(draft.pickup_location);
  const [dest, setDest] = useState(draft.destination);
  const [date, setDate] = useState(draft.ride_date);
  const [time, setTime] = useState(draft.start_time);
  const [hours, setHours] = useState(draft.estimated_duration_hours || 1);
  const [purpose, setPurpose] = useState(draft.purpose);
  const [selfDrive, setSelfDrive] = useState(draft.self_drive);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const submit = async () => {
    if (!pickup.trim() || !dest.trim()) return setError('কোথা থেকে আর কোথায় — দুটোই দিন।');
    if (!date || !time) return setError('তারিখ আর সময় দিন।');
    if (new Date(`${date}T${time}`).getTime() < Date.now() - 60000) return setError('এই সময় পেরিয়ে গেছে — সামনের সময় দিন।');
    if (!purpose.trim()) return setError('উদ্দেশ্য লিখুন।');
    setSaving(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/vehicles/requisitions'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ purpose: purpose.trim(), pickup_location: pickup.trim(), destination: dest.trim(), ride_date: date, start_time: time, estimated_duration_hours: hours, self_drive: selfDrive })
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || 'Request জমা হয়নি।');
      onDone('submitted', {
        text: `✅ গাড়ির request জমা হয়েছে — ${pickup.trim()} → ${dest.trim()}, ${date} ${time}${selfDrive ? ' (নিজে চালাবেন)' : ''}। অনুমোদন হলে গাড়ি ও ড্রাইভার জানানো হবে; অবস্থা জানতে আমাকে জিজ্ঞেস করুন বা Ride Status খুলুন।`,
        action: { label: 'Ride Status খুলুন', nav: 'self:vehicleManagement' }
      });
    } catch (e: any) {
      setError(e.message || 'Request জমা হয়নি।');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2.5 rounded-2xl bg-white/55 border border-white/80 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-800">
        <Car className="w-4 h-4" /> গাড়ির request — দেখে নিন
      </div>
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-slate-500">
          কোথা থেকে
          <input value={pickup} onChange={(e) => setPickup(e.target.value)} maxLength={200} placeholder="যেমন Head Office" className={cardField} />
        </label>
        <label className="block text-[11px] text-slate-500">
          কোথায়
          <input value={dest} onChange={(e) => setDest(e.target.value)} maxLength={200} className={cardField} />
        </label>
        <label className="block text-[11px] text-slate-500">
          তারিখ
          <input type="date" value={date} min={draft.today} onChange={(e) => setDate(e.target.value)} className={cardField} />
        </label>
        <label className="block text-[11px] text-slate-500">
          সময়
          <input type="time" value={time} onChange={(e) => setTime(e.target.value)} className={cardField} />
        </label>
      </div>
      <label className="block text-[11px] text-slate-500">
        কতক্ষণ লাগবে
        <DurationPicker value={hours} onChange={setHours} className={cardField} />
      </label>
      <label className="block text-[11px] text-slate-500">
        উদ্দেশ্য
        <textarea value={purpose} onChange={(e) => setPurpose(e.target.value)} rows={2} maxLength={300} className={`${cardField} resize-none`} />
      </label>
      <label className="flex items-start gap-2 text-xs text-slate-700">
        <input type="checkbox" checked={selfDrive} onChange={(e) => setSelfDrive(e.target.checked)} className="accent-violet-600 mt-0.5" />
        <span>
          আমি নিজে চালাব
          {draft.self_drive_note && <span className="block text-[11px] text-amber-700">{draft.self_drive_note}</span>}
        </span>
      </label>
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
      <div className="flex gap-2 pt-0.5">
        <button type="button" onClick={submit} disabled={saving} className="liquid-glass-button flex-1 rounded-full py-2 text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Car className="w-3.5 h-3.5" />} Book করুন
        </button>
        <button type="button" onClick={() => onDone('cancelled')} disabled={saving} className="liquid-glass-chip rounded-full px-4 py-2 text-xs text-slate-700">
          বাতিল
        </button>
      </div>
    </div>
  );
};

// Timesheet -> Correct Attendance, filled by the Assistant ->
// POST /api/attendance/corrections (goes to approval like the page's own).
const CorrectionDraftCard: React.FC<{ token: string; draft: CorrectionDraft; onDone: DraftDone }> = ({ token, draft, onDone }) => {
  const [date, setDate] = useState(draft.attendance_date);
  const [projectId, setProjectId] = useState(draft.options[0] ? String(draft.options[0].project_id) : '');
  const [checkIn, setCheckIn] = useState(draft.check_in);
  const [checkOut, setCheckOut] = useState(draft.check_out);
  const [remarks, setRemarks] = useState(draft.remarks);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const nextDay = (d: string) => new Date(Date.parse(`${d}T00:00:00Z`) + 864e5).toISOString().slice(0, 10);
  // An Out earlier than the In is a night shift: out the next morning.
  const outNext = !!checkIn && !!checkOut && checkOut < checkIn;
  const submit = async () => {
    if (!projectId) return setError('Project বেছে নিন।');
    if (!date || date > draft.today) return setError('আজ বা আগের একটা দিন দিন।');
    if (!checkIn && !checkOut) return setError('ইন বা আউট সময় দিন।');
    if (!remarks.trim()) return setError('কারণ লিখুন।');
    setSaving(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/attendance/corrections'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          project_id: Number(projectId),
          attendance_date: date,
          check_in_at: checkIn ? `${date} ${checkIn}:00` : undefined,
          check_out_at: checkOut ? `${outNext ? nextDay(date) : date} ${checkOut}:00` : undefined,
          remarks: remarks.trim()
        })
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || 'জমা হয়নি।');
      onDone('submitted', {
        text: `✅ ${date}-এর হাজিরা ঠিক করার অনুরোধ জমা হয়েছে${checkIn ? ` — ইন ${checkIn}` : ''}${checkOut ? `${checkIn ? ',' : ' —'} আউট ${checkOut}` : ''}। অনুমোদন হলে Timesheet-এ বসে যাবে; কিছু ফাইল (প্রমাণ) দিতে চাইলে Timesheet থেকে দিতে পারবেন।`,
        action: { label: 'Timesheet খুলুন', nav: 'self:timesheet' }
      });
    } catch (e: any) {
      setError(e.message || 'জমা হয়নি।');
    } finally {
      setSaving(false);
    }
  };
  return (
    <div className="mt-2.5 rounded-2xl bg-white/55 border border-white/80 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-800">
        <Clock className="w-4 h-4" /> হাজিরা ঠিক করা — দেখে নিন
      </div>
      <label className="block text-[11px] text-slate-500">
        দিন
        <input type="date" value={date} max={draft.today} onChange={(e) => setDate(e.target.value)} className={cardField} />
      </label>
      {draft.options.length > 1 && (
        <label className="block text-[11px] text-slate-500">
          Project
          <SearchSelect value={projectId} onChange={(e) => setProjectId(e.target.value)} className={cardField}>
            <option value="">— Project বেছে নিন —</option>
            {draft.options.map((o) => (
              <option key={o.project_id} value={o.project_id}>{o.name}</option>
            ))}
          </SearchSelect>
        </label>
      )}
      <div className="grid grid-cols-2 gap-2">
        <label className="block text-[11px] text-slate-500">
          ইন টাইম
          <input type="time" value={checkIn} onChange={(e) => setCheckIn(e.target.value)} className={cardField} />
        </label>
        <label className="block text-[11px] text-slate-500">
          আউট টাইম{outNext ? ' (পরদিন)' : ''}
          <input type="time" value={checkOut} onChange={(e) => setCheckOut(e.target.value)} className={cardField} />
        </label>
      </div>
      <label className="block text-[11px] text-slate-500">
        কারণ
        <textarea value={remarks} onChange={(e) => setRemarks(e.target.value)} rows={2} maxLength={250} placeholder="যেমন: চেক ইন দিতে ভুলে গিয়েছিলাম" className={`${cardField} resize-none`} />
      </label>
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
      <div className="flex gap-2 pt-0.5">
        <button type="button" onClick={submit} disabled={saving} className="liquid-glass-button flex-1 rounded-full py-2 text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Send className="w-3.5 h-3.5" />} Submit করুন
        </button>
        <button type="button" onClick={() => onDone('cancelled')} disabled={saving} className="liquid-glass-chip rounded-full px-4 py-2 text-xs text-slate-700">
          বাতিল
        </button>
      </div>
    </div>
  );
};

// Check In/Out Check In / Check Out from the Assistant -> the same
// /api/claims/check-in and /api/claims/:id/check-out the Check In/Out card
// uses, with the location taken now (getCurrentCoords, ClaimCard.tsx).
const MovementDraftCard: React.FC<{ token: string; draft: MovementDraft; onDone: DraftDone }> = ({ token, draft, onDone }) => {
  const isIn = draft.mode === 'check_in';
  const [purpose, setPurpose] = useState(draft.purpose);
  const [remarks, setRemarks] = useState(draft.remarks);
  const [saving, setSaving] = useState<'' | 'locating' | 'sending'>('');
  const [error, setError] = useState('');
  const submit = async () => {
    if (isIn && !purpose.trim()) return setError('কোথায় / কেন যাচ্ছেন লিখুন।');
    setError('');
    setSaving('locating');
    try {
      const { latitude, longitude } = await getCurrentCoords();
      setSaving('sending');
      const r = await fetch(apiUrl(isIn ? '/api/claims/check-in' : `/api/claims/${draft.claim_id}/check-out`), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify(isIn ? { purpose: purpose.trim(), latitude, longitude, remarks: remarks.trim() || undefined } : { latitude, longitude, remarks: remarks.trim() || undefined })
      });
      const d = await r.json().catch(() => null);
      if (!r.ok) throw new Error(d?.error || 'জমা হয়নি।');
      onDone('submitted', {
        text: isIn
          ? `✅ Check In হয়েছে — ${purpose.trim()}। পৌঁছে বা কাজ শেষে আমাকে বলুন "movement check out" — অথবা Check In/Out পাতা থেকে Check Out করুন।`
          : `✅ Check Out হয়েছে — ${draft.purpose}${d?.distance_km != null ? `, সোজা দূরত্ব ${d.distance_km} km` : ''}। Claim সম্পূর্ণ।`,
        action: { label: 'Check In/Out খুলুন', nav: 'claims:movementClaims' }
      });
    } catch (e: any) {
      setError(e.message || 'জমা হয়নি।');
    } finally {
      setSaving('');
    }
  };
  return (
    <div className="mt-2.5 rounded-2xl bg-white/55 border border-white/80 p-3 space-y-2">
      <div className="flex items-center gap-1.5 text-xs font-semibold text-violet-800">
        <MapPin className="w-4 h-4" /> Check In/Out — {isIn ? 'Check In' : 'Check Out'}
      </div>
      {isIn ? (
        <label className="block text-[11px] text-slate-500">
          কোথায় / কেন যাচ্ছেন
          <input value={purpose} onChange={(e) => setPurpose(e.target.value)} maxLength={255} placeholder="যেমন: Client meeting, Gulshan" className={cardField} />
        </label>
      ) : (
        <p className="text-xs text-slate-700">
          <span className="font-semibold">{draft.purpose}</span>
          {draft.since && <span className="block text-[11px] text-slate-500">Check In: {draft.since.slice(0, 16).replace('T', ' ')}</span>}
        </p>
      )}
      <label className="block text-[11px] text-slate-500">
        মন্তব্য (ঐচ্ছিক)
        <input value={remarks} onChange={(e) => setRemarks(e.target.value)} maxLength={300} className={cardField} />
      </label>
      <p className="text-[11px] text-slate-500">বোতাম চাপলে এখনকার লোকেশন আর সময় নেওয়া হবে।</p>
      {error && <p className="text-[11px] text-rose-600">{error}</p>}
      <div className="flex gap-2 pt-0.5">
        <button type="button" onClick={submit} disabled={!!saving} className="liquid-glass-button flex-1 rounded-full py-2 text-xs font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-50">
          {saving ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <MapPin className="w-3.5 h-3.5" />}
          {saving === 'locating' ? 'লোকেশন নিচ্ছি…' : saving === 'sending' ? 'জমা হচ্ছে…' : isIn ? 'Check In' : 'Check Out'}
        </button>
        <button type="button" onClick={() => onDone('cancelled')} disabled={!!saving} className="liquid-glass-chip rounded-full px-4 py-2 text-xs text-slate-700">
          বাতিল
        </button>
      </div>
    </div>
  );
};

interface Props {
  token: string;
  user: User | null;
  onNavigate: (nav: string) => void;
  hidden?: boolean;
}

// **bold** and line breaks — all the formatting the answers use.
const RichText: React.FC<{ text: string }> = ({ text }) => (
  <>
    {text.split('\n').map((line, i) => (
      <span key={i} className="block min-h-[0.5em]">
        {line.split(/(\*\*[^*]+\*\*)/g).map((part, j) =>
          part.startsWith('**') && part.endsWith('**') ? <strong key={j} className="font-semibold text-slate-900">{part.slice(2, -2)}</strong> : <React.Fragment key={j}>{part}</React.Fragment>
        )}
      </span>
    ))}
  </>
);

export const AiAssistant: React.FC<Props> = ({ token, user, onNavigate, hidden }) => {
  const allowed = !!user && !user.is_onboarding && (user.role === 'superadmin' || user.can_use_ai_assistant !== false);
  const storeKey = user ? `credence_assistant_${user.id}` : '';
  const [open, setOpen] = useState(false);
  // Pixels the on-screen keyboard covers (0 when closed) — see the sheet below.
  const keyboardInset = useKeyboardInset();
  const isPhone = useIsPhone();
  const [msgs, setMsgs] = useState<Msg[]>(() => {
    try {
      const raw = storeKey ? sessionStorage.getItem(storeKey) : null;
      return raw ? (JSON.parse(raw) as Msg[]) : [];
    } catch {
      return [];
    }
  });
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [suggestions, setSuggestions] = useState<string[]>([]);
  // Voice: allowed for this account (status.voice), recording / writing-down
  // state, and which answer is being read aloud.
  const [voice, setVoice] = useState(false);
  const [voicePicker, setVoicePicker] = useState(false);
  const [recState, setRecState] = useState<'idle' | 'recording' | 'transcribing'>('idle');
  const [recSecs, setRecSecs] = useState(0);
  const [voiceErr, setVoiceErr] = useState('');
  const [speakingIdx, setSpeakingIdx] = useState<number | null>(null);
  // True until the answer being read actually makes sound.
  const [speakLoading, setSpeakLoading] = useState(false);
  const recTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  const stopping = useRef(false);
  const listRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Live support (AssistantSupport.tsx): 'bot' = the Assistant, 'live' = my
  // chat with a human, 'inbox' = agents' queue.
  const [view, setView] = useState<'bot' | 'live' | 'inbox'>('bot');
  const [live, setLive] = useState<{ session: SupportSession; messages: SupportMessage[] } | null>(null);
  const [isAgent, setIsAgent] = useState(false);
  const [waiting, setWaiting] = useState(0);
  const [unread, setUnread] = useState(0);
  const [focusId, setFocusId] = useState<number | null>(null);
  const [supportError, setSupportError] = useState('');
  const openRef = useRef(open);
  openRef.current = open;
  const liveRef = useRef(live);
  liveRef.current = live;

  const refreshSupport = useCallback(async () => {
    if (!token || !allowed) return;
    try {
      const a = await supportApi<{ is_agent: boolean; waiting: number }>(token, '/access');
      setIsAgent(a.is_agent);
      setWaiting(a.waiting);
      const mine = await supportApi<{ session: SupportSession | null; messages: SupportMessage[] }>(token, '/mine');
      setLive((cur) => (mine.session ? { session: mine.session, messages: mine.messages } : cur && cur.session.status === 'closed' ? cur : null));
    } catch {
      // live support unavailable — the Assistant itself still works
    }
  }, [token, allowed]);

  useEffect(() => {
    void refreshSupport();
  }, [refreshSupport]);

  useSupportSocket((e) => {
    const cur = liveRef.current;
    const sid = e.session?.id ?? e.session_id;
    if (cur && sid === cur.session.id) {
      setLive((l) => {
        if (!l) return l;
        const messages = e.message && !l.messages.some((m) => m.id === e.message!.id) ? [...l.messages, e.message] : l.messages;
        return { session: e.session || l.session, messages };
      });
      if (e.message && e.message.sender_id !== user?.id && (!openRef.current || view !== 'live')) setUnread((n) => n + 1);
    }
    if (e.queue_changed) {
      supportApi<{ is_agent: boolean; waiting: number }>(token, '/access').then((a) => setWaiting(a.waiting)).catch(() => {});
    }
  });

  // An "assistant_support" alert: agents open the chat in the inbox, the
  // person who asked opens their live chat.
  useEffect(() => {
    const onOpen = (e: Event) => {
      const id = Number((e as CustomEvent).detail) || null;
      setOpen(true);
      if (isAgent && id && (!liveRef.current || liveRef.current.session.id !== id)) {
        setFocusId(id);
        setView('inbox');
      } else {
        void refreshSupport();
        setView('live');
      }
    };
    window.addEventListener('credence:open-assistant-support', onOpen);
    return () => window.removeEventListener('credence:open-assistant-support', onOpen);
  }, [isAgent, refreshSupport]);

  // The phone More menu's "Credence Assistant" tile (UserPanel.tsx).
  useEffect(() => {
    const onOpen = () => setOpen(true);
    window.addEventListener('credence:open-assistant', onOpen);
    return () => window.removeEventListener('credence:open-assistant', onOpen);
  }, []);

  useEffect(() => {
    if (open && view === 'live') setUnread(0);
  }, [open, view, live?.messages.length]);

  const startSupport = async () => {
    setSupportError('');
    try {
      const lastUser = [...msgs].reverse().find((m) => m.role === 'user')?.text || '';
      const d = await supportApi<{ session: SupportSession; messages: SupportMessage[] }>(token, '/request', {
        topic: lastUser.slice(0, 200),
        context: msgs.slice(-6).map((m) => ({ role: m.role, text: m.text }))
      });
      setLive({ session: d.session, messages: d.messages });
      setView('live');
    } catch (e: any) {
      setSupportError(e.message || 'Support-এর সাথে যোগাযোগ করা গেল না।');
    }
  };

  useEffect(() => {
    try {
      if (storeKey) sessionStorage.setItem(storeKey, JSON.stringify(msgs.slice(-30)));
    } catch {
      // storage unavailable — the conversation just isn't kept across reloads
    }
  }, [msgs, storeKey]);

  useEffect(() => {
    if (!open || !token) return;
    let cancelled = false;
    fetch(apiUrl('/api/assistant/status'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (cancelled || !d) return;
        setSuggestions(d.suggestions || []);
        setVoice(!!d.voice);
        if (d.voice) prepareVoices();
      })
      .catch(() => {});
    setTimeout(() => inputRef.current?.focus(), 150);
    return () => {
      cancelled = true;
    };
  }, [open, token]);

  useEffect(() => {
    listRef.current?.scrollTo({ top: listRef.current.scrollHeight, behavior: 'smooth' });
  }, [msgs, busy, open]);

  // Closing the Assistant stops any reading aloud and drops a recording.
  useEffect(() => {
    if (open) return;
    stopSpeaking();
    setSpeakingIdx(null);
    if (recTimer.current) clearInterval(recTimer.current);
    recTimer.current = null;
    setRecState((st) => {
      if (st === 'recording') void stopRecording(false);
      return 'idle';
    });
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  if (!allowed) return null;

  const readAloud = async (index: number, text: string) => {
    if (speakingIdx === index) {
      stopSpeaking();
      setSpeakingIdx(null);
      setSpeakLoading(false);
      return;
    }
    unlockAudio(); // still inside the tap (iPhone)
    setSpeakingIdx(index);
    setSpeakLoading(true);
    try {
      await speak(text, token, () => setSpeakLoading(false));
    } catch {
      setVoiceErr('উত্তরটা পড়ে শোনানো গেল না।');
    } finally {
      setSpeakingIdx((cur) => (cur === index ? null : cur));
      setSpeakLoading(false);
    }
  };

  const ask = async (text: string, spoken = false) => {
    const message = text.trim();
    if (!message || busy) return;
    const history = msgs.slice(-10).map((m) => ({
      role: m.role,
      text: m.text + (m.draftDone === 'submitted' ? ` [The user submitted this ${m.draft?.kind === 'ride_booking' ? 'ride request' : m.draft?.kind === 'attendance_correction' ? 'attendance correction' : m.draft?.kind === 'movement_claim' ? `movement claim ${m.draft.mode === 'check_in' ? 'check in' : 'check out'}` : 'leave application'}.]` : m.draftDone === 'cancelled' ? ' [The user cancelled this draft.]' : m.draft ? ' [Draft shown, not submitted yet.]' : '')
    }));
    setMsgs((m) => [...m, { role: 'user', text: message }]);
    setInput('');
    setBusy(true);
    try {
      const r = await fetch(apiUrl('/api/assistant/chat'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ message, history })
      });
      const d = await r.json().catch(() => null);
      const reply = r.ok && d?.reply ? d.reply : d?.error || 'দুঃখিত, এখন উত্তর দিতে পারছি না। একটু পরে আবার চেষ্টা করুন।';
      setMsgs((m) => [...m, { role: 'assistant', text: reply, actions: r.ok ? d?.actions || [] : [], draft: r.ok && d?.draft ? d.draft : undefined, report: r.ok && d?.report ? d.report : undefined }]);
      // A spoken question gets its answer read aloud (it lands after the
      // question just added: index msgs.length + 1).
      if (spoken && r.ok) void readAloud(msgs.length + 1, reply);
    } catch {
      setMsgs((m) => [...m, { role: 'assistant', text: 'সংযোগে সমস্যা হয়েছে। ইন্টারনেট দেখে আবার চেষ্টা করুন।' }]);
    } finally {
      setBusy(false);
    }
  };

  const stopRec = async (keep: boolean) => {
    // Only once per recording (the ■ button and the 1-minute limit can both fire).
    if (stopping.current) return;
    stopping.current = true;
    if (recTimer.current) clearInterval(recTimer.current);
    recTimer.current = null;
    if (!keep) {
      setRecState('idle');
      await stopRecording(false);
      return;
    }
    setRecState('transcribing');
    try {
      const blob = await stopRecording(true);
      if (!blob || blob.size < 1200) throw new Error('কিছু শোনা যায়নি — মাইক চেপে আবার বলুন।');
      const { base64, mime } = await toWavBase64(blob);
      // The server gives up after ~30 s; never spin longer than that here.
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), 40000);
      let r: Response;
      try {
        r = await fetch(apiUrl('/api/assistant/transcribe'), {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
          body: JSON.stringify({ audio_base64: base64, mime_type: mime }),
          signal: ctl.signal
        });
      } catch {
        throw new Error('উত্তর আসতে বেশি সময় লাগছে — আবার বলুন বা লিখে প্রশ্ন করুন।');
      } finally {
        clearTimeout(timer);
      }
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'কথাটা বোঝা গেল না — আবার বলুন।');
      const text = String(d.text || '').trim();
      if (!text) throw new Error('কিছু শোনা যায়নি — মাইক চেপে আবার বলুন।');
      setRecState('idle');
      void ask(text, true);
    } catch (e: any) {
      setRecState('idle');
      setVoiceErr(e.message || 'কথাটা বোঝা গেল না।');
    }
  };

  const startRec = async () => {
    if (busy || recState !== 'idle') return;
    setVoiceErr('');
    stopSpeaking();
    setSpeakingIdx(null);
    // The answer to a spoken question is read out seconds later, outside
    // this tap — allow sound now (iPhone).
    unlockAudio();
    try {
      await startRecording();
    } catch (e: any) {
      setVoiceErr(e?.message || 'মাইক্রোফোন চালু করা গেল না।');
      return;
    }
    setRecSecs(0);
    stopping.current = false;
    setRecState('recording');
    const startedAt = Date.now();
    recTimer.current = setInterval(() => {
      const sec = Math.floor((Date.now() - startedAt) / 1000);
      setRecSecs(sec);
      if (sec >= MAX_RECORD_SECONDS) void stopRec(true);
    }, 1000);
  };

  const finishDraft = (index: number, result: 'submitted' | 'cancelled', done?: { text: string; action?: Action }) => {
    setMsgs((m) => {
      const next = m.map((x, i) => (i === index ? { ...x, draftDone: result } : x));
      next.push(
        result === 'submitted' && done
          ? { role: 'assistant', text: done.text, actions: done.action ? [done.action] : [] }
          : { role: 'assistant', text: 'ঠিক আছে, খসড়াটা বাতিল করলাম — কিছু জমা হয়নি।' }
      );
      return next;
    });
  };

  const go = (nav: string) => {
    if (nav === 'support:request') {
      void startSupport();
      return;
    }
    setOpen(false);
    // "admin:attendance_reports#custom": the page, opened on that tab.
    const [page, tab] = nav.split('#');
    if (tab) {
      try {
        sessionStorage.setItem('credence_attendance_report_view', tab);
      } catch {
        /* no storage */
      }
      // An already open page switches tab too (after the navigation settles).
      for (const ms of [0, 400, 1200]) setTimeout(() => window.dispatchEvent(new CustomEvent('credence:attendance-report-view', { detail: tab })), ms);
      setTimeout(() => {
        try {
          sessionStorage.removeItem('credence_attendance_report_view');
        } catch {
          /* no storage */
        }
      }, 4000);
    }
    onNavigate(page);
  };

  const firstName = (user?.name || '').split(' ')[0];

  return (
    <>
      {/* Phones: a small tab tucked against the right edge instead of a
          round button over the page — drag it up / down (the place is
          remembered), and it slides away while the page scrolls. */}
      {!open && !hidden && isPhone && <EdgeTab count={waiting + unread} onOpen={() => setOpen(true)} />}

      {/* .liquid-glass-button sets position: relative, so the wrapper is what's fixed. */}
      {!open && !hidden && !isPhone && (
        <div className="assistant-fab fixed z-50 right-4 md:right-7 bottom-[calc(88px+env(safe-area-inset-bottom,0px))] md:bottom-[100px]">
          <button
            type="button"
            onClick={() => setOpen(true)}
            title="Credence Assistant"
            aria-label="Open Credence Assistant"
            className="w-12 h-12 rounded-full liquid-glass-button flex items-center justify-center shadow-lg hover:scale-105 active:scale-95 transition-transform"
          >
            <Sparkles className="w-5 h-5" />
          </button>
          {waiting + unread > 0 && (
            <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white pointer-events-none">
              {waiting + unread}
            </span>
          )}
        </div>
      )}

      {open && (
        <>
        {/* Phones / small tablets: dim + blur behind the sheet, tap it to
            close. On a computer the page stays sharp and usable next to the
            Assistant — no backdrop at all. */}
        <div className="md:hidden fixed inset-0 z-[80] liquid-glass-backdrop" onClick={() => setOpen(false)} aria-hidden="true" />
        {voicePicker && (
          <VoicePicker
            token={token}
            onClose={() => {
              stopSpeaking();
              setVoicePicker(false);
            }}
          />
        )}
        {/* With the keyboard open the sheet sits right on top of it and is
            only as tall as what is left below the status bar, so the message
            box never goes under the keyboard (useKeyboardInset). */}
        <div
          className={`fixed inset-0 z-[81] pointer-events-none flex ${keyboardInset ? 'items-end' : 'items-end sm:items-center md:items-end'} justify-center md:justify-end p-2 sm:p-4 md:p-6`}
          style={keyboardInset ? { paddingBottom: keyboardInset + 8 } : undefined}
        >
          <div
            role="dialog"
            aria-label="Credence Assistant"
            className="pointer-events-auto liquid-glass liquid-glass-in rounded-[32px] w-full max-w-md flex flex-col overflow-hidden shadow-2xl"
            style={{
              height: keyboardInset
                ? `min(640px, calc(100vh - ${keyboardInset + 24}px - var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px))))`
                : 'min(640px, 88vh)'
            }}
          >
            <div className="flex items-center gap-3 px-5 pt-5 pb-3">
              <span className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center text-violet-700 shrink-0">
                <Sparkles className="w-5 h-5" />
              </span>
              <div className="min-w-0 flex-1">
                <h3 className="text-base font-bold text-slate-900 leading-tight">{view === 'bot' ? 'Credence Assistant' : view === 'live' ? 'Live support' : 'Support inbox'}</h3>
              </div>
              {view === 'bot' && voice && (
                <button
                  type="button"
                  onClick={() => setVoicePicker(true)}
                  title="কণ্ঠ বদলান"
                  aria-label="Choose voice"
                  className="liquid-glass-chip p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
                >
                  <Volume2 className="w-4 h-4" />
                </button>
              )}
              {view === 'bot' && msgs.length > 0 && (
                <button
                  type="button"
                  onClick={() => setMsgs([])}
                  title="নতুন করে শুরু"
                  aria-label="Clear conversation"
                  className="liquid-glass-chip p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
                >
                  <RotateCcw className="w-4 h-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => setOpen(false)}
                title="Close"
                aria-label="Close assistant"
                className="liquid-glass-chip p-1.5 text-slate-600 hover:text-slate-900 rounded-full"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            {(isAgent || live) && (
              <div className="flex gap-1.5 px-4 pb-2">
                <button type="button" onClick={() => setView('bot')} className={`rounded-full px-3 py-1 text-xs ${view === 'bot' ? 'liquid-glass-button font-semibold' : 'liquid-glass-chip text-slate-700'}`}>
                  Assistant
                </button>
                {live && (
                  <button type="button" onClick={() => setView('live')} className={`rounded-full px-3 py-1 text-xs inline-flex items-center gap-1 ${view === 'live' ? 'liquid-glass-button font-semibold' : 'liquid-glass-chip text-slate-700'}`}>
                    <Headphones className="w-3.5 h-3.5" /> আমার support chat{unread > 0 && view !== 'live' ? ` (${unread})` : ''}
                  </button>
                )}
                {isAgent && (
                  <button type="button" onClick={() => setView('inbox')} className={`rounded-full px-3 py-1 text-xs ${view === 'inbox' ? 'liquid-glass-button font-semibold' : 'liquid-glass-chip text-slate-700'}`}>
                    Support inbox{waiting > 0 ? ` (${waiting})` : ''}
                  </button>
                )}
              </div>
            )}

            {view === 'live' && live && user ? (
              <LiveChat
                token={token}
                meId={user.id}
                session={live.session}
                messages={live.messages}
                onChange={(session, messages) => setLive({ session, messages })}
                onBack={() => { setLive(null); setView('bot'); }}
              />
            ) : view === 'inbox' && isAgent && user ? (
              <SupportInbox token={token} meId={user.id} focusId={focusId} onFocusHandled={() => setFocusId(null)} onQueueCount={setWaiting} />
            ) : (
            <>
            <div ref={listRef} className="flex-1 overflow-y-auto overscroll-contain px-4 pb-3 space-y-3">
              {msgs.length === 0 && (
                <div className="liquid-glass-inset rounded-[24px] px-4 py-4">
                  <p className="text-sm text-slate-800">
                    আসসালামু আলাইকুম{firstName ? `, ${firstName}` : ''}! আমি আপনার নিজের তথ্য দেখে উত্তর দিতে পারি, আর app-এ কোন কাজ কোথায় তা দেখিয়ে দিতে পারি।
                  </p>
                  <p className="text-[11px] text-slate-500 mt-1.5">আমি শুধু দেখি আর পথ দেখাই (ছুটির আবেদন আপনি নিজে জমা দেন)। মানুষের সাহায্য লাগলে বলুন "মানুষের সাথে কথা বলতে চাই"।</p>
                  {suggestions.length > 0 && (
                    <div className="flex flex-wrap gap-1.5 mt-3">
                      {suggestions.map((s) => (
                        <button
                          key={s}
                          type="button"
                          onClick={() => ask(s)}
                          className="liquid-glass-chip rounded-full px-3 py-1.5 text-xs text-violet-800 hover:text-violet-950"
                        >
                          {s}
                        </button>
                      ))}
                    </div>
                  )}
                </div>
              )}

              {msgs.map((m, i) =>
                m.role === 'user' ? (
                  <div key={i} className="flex justify-end">
                    <div className="max-w-[85%] rounded-[20px] rounded-br-md px-3.5 py-2 text-sm text-white bg-violet-600 shadow-sm whitespace-pre-wrap break-words">{m.text}</div>
                  </div>
                ) : (
                  <div key={i} className="flex justify-start">
                    <div className="max-w-[92%] liquid-glass-inset rounded-[20px] rounded-bl-md px-3.5 py-2.5 text-sm text-slate-700 break-words">
                      <RichText text={m.text} />
                      {voice && (
                        <button
                          type="button"
                          onClick={() => void readAloud(i, m.text)}
                          aria-label={speakingIdx === i ? 'Stop reading' : 'Read aloud'}
                          title={speakingIdx === i ? 'থামান' : 'পড়ে শোনান'}
                          className={`mt-1.5 inline-flex items-center gap-1 rounded-full px-2 py-1 text-[11px] font-semibold ${speakingIdx === i ? 'bg-violet-600 text-white' : 'text-violet-700 hover:bg-violet-50'}`}
                        >
                          {speakingIdx === i ? (
                            speakLoading ? <Loader2 className="w-3 h-3 animate-spin" /> : <Square className="w-3 h-3" />
                          ) : (
                            <Volume2 className="w-3.5 h-3.5" />
                          )}
                          {speakingIdx === i ? (speakLoading ? 'আসছে…' : 'থামান') : 'শুনুন'}
                        </button>
                      )}
                      {m.draft && !m.draftDone && m.draft.kind === 'leave_application' && <LeaveDraftCard token={token} draft={m.draft} onDone={(r, done) => finishDraft(i, r, done)} />}
                      {m.draft && !m.draftDone && m.draft.kind === 'ride_booking' && <RideDraftCard token={token} draft={m.draft} onDone={(r, done) => finishDraft(i, r, done)} />}
                      {m.draft && !m.draftDone && m.draft.kind === 'attendance_correction' && <CorrectionDraftCard token={token} draft={m.draft} onDone={(r, done) => finishDraft(i, r, done)} />}
                      {m.draft && !m.draftDone && m.draft.kind === 'movement_claim' && <MovementDraftCard token={token} draft={m.draft} onDone={(r, done) => finishDraft(i, r, done)} />}
                      {m.draft && m.draftDone === 'submitted' && (
                        <p className="mt-2 inline-flex items-center gap-1 text-[11px] font-semibold text-emerald-700"><CheckCircle2 className="w-3.5 h-3.5" /> জমা দেওয়া হয়েছে</p>
                      )}
                      {m.report && <ReportButtons token={token} report={m.report} preparedBy={user?.name || ''} />}
                      {m.actions && m.actions.length > 0 && (
                        <div className="flex flex-wrap gap-1.5 mt-2.5">
                          {m.actions.map((a) => (
                            <button
                              key={a.nav}
                              type="button"
                              onClick={() => go(a.nav)}
                              className="liquid-glass-button rounded-full px-3 py-1.5 text-xs font-semibold inline-flex items-center gap-1"
                            >
                              {a.label}
                              <ArrowRight className="w-3.5 h-3.5" />
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                )
              )}

              {supportError && <p className="text-[11px] text-rose-600 px-1">{supportError}</p>}
              {busy && (
                <div className="flex justify-start">
                  <div className="liquid-glass-inset rounded-[20px] rounded-bl-md px-3.5 py-2.5 text-sm text-slate-500 inline-flex items-center gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> দেখছি…
                  </div>
                </div>
              )}
            </div>

            <form
              className="px-4 pb-4 pt-1"
              onSubmit={(e) => {
                e.preventDefault();
                void ask(input);
              }}
            >
              {voiceErr && <p className="text-[11px] text-rose-600 px-2 pb-1.5">{voiceErr}</p>}
              {recState !== 'idle' ? (
                <div className="liquid-glass-inset rounded-[24px] flex items-center gap-2 pl-4 pr-1.5 py-1.5 min-h-[48px]" role="status" aria-live="polite">
                  {recState === 'recording' ? (
                    <>
                      <span className="w-2.5 h-2.5 rounded-full bg-rose-600 animate-pulse shrink-0" aria-hidden="true" />
                      <span className="flex-1 text-sm text-slate-800">
                        শুনছি… <span className="tabular-nums text-slate-500">0:{String(recSecs).padStart(2, '0')}</span>
                        <span className="block text-[11px] text-slate-500">বলা শেষ হলে ■ চাপুন</span>
                      </span>
                      <button type="button" onClick={() => void stopRec(false)} aria-label="Cancel recording" className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center shrink-0 text-slate-600">
                        <X className="w-4 h-4" />
                      </button>
                      <button type="button" onClick={() => void stopRec(true)} aria-label="Stop and ask" className="w-9 h-9 rounded-full flex items-center justify-center shrink-0 bg-rose-600 text-white">
                        <Square className="w-3.5 h-3.5" />
                      </button>
                    </>
                  ) : (
                    <span className="flex-1 text-sm text-slate-600 inline-flex items-center gap-2">
                      <Loader2 className="w-4 h-4 animate-spin" /> কথাটা লিখে নিচ্ছি…
                    </span>
                  )}
                </div>
              ) : (
              <div className="liquid-glass-inset rounded-[24px] flex items-end gap-2 pl-4 pr-1.5 py-1.5">
                <textarea
                  ref={inputRef}
                  value={input}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !e.shiftKey) {
                      e.preventDefault();
                      void ask(input);
                    }
                  }}
                  rows={1}
                  maxLength={1000}
                  placeholder="প্রশ্ন লিখুন… (বাংলা / English)"
                  className="flex-1 resize-none bg-transparent outline-none text-sm text-slate-900 placeholder:text-slate-400 py-2 max-h-28"
                />
                {voice && !input.trim() ? (
                  <button
                    type="button"
                    onClick={() => void startRec()}
                    disabled={busy}
                    aria-label="Ask by voice"
                    title="বলে প্রশ্ন করুন"
                    className="liquid-glass-button w-9 h-9 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
                  >
                    <Mic className="w-4 h-4" />
                  </button>
                ) : (
                <button
                  type="submit"
                  disabled={busy || !input.trim()}
                  aria-label="Send"
                  className="liquid-glass-button w-9 h-9 rounded-full flex items-center justify-center shrink-0 disabled:opacity-40"
                >
                  <Send className="w-4 h-4" />
                </button>
                )}
              </div>
              )}
            </form>
            </>
            )}
          </div>
        </div>
        </>
      )}
    </>
  );
};

export default AiAssistant;

// ---- the phone edge tab ------------------------------------------------------
const TAB_KEY = 'credence_assistant_tab_y';
const TAB_H = 48;

// The 🔊 button in the Assistant's header: pick the voice answers are read
// in, hear each one first. Kept on this device (lib/assistantVoice.ts).
const VoicePicker: React.FC<{ token: string; onClose: () => void }> = ({ token, onClose }) => {
  const [pref, setPref] = useState(getVoicePref());
  const [device, setDevice] = useState<{ id: string; label: string }[]>([]);
  const [playing, setPlaying] = useState<{ id: string; loading: boolean } | null>(null);
  const [err, setErr] = useState('');
  useEffect(() => {
    void deviceBanglaVoices().then(setDevice);
  }, []);
  const choose = (v: string) => {
    setPref(v);
    setVoicePref(v);
  };
  const play = async (v: string) => {
    if (playing?.id === v) {
      stopSpeaking();
      setPlaying(null);
      return;
    }
    unlockAudio(); // inside the tap (iPhone)
    setErr('');
    setPlaying({ id: v, loading: true });
    try {
      await previewVoice(v, token, () => setPlaying((p) => (p?.id === v ? { id: v, loading: false } : p)));
    } catch {
      setErr('কণ্ঠটা শোনানো গেল না — একটু পরে আবার চেষ্টা করুন।');
    } finally {
      setPlaying((p) => (p?.id === v ? null : p));
    }
  };
  const Row: React.FC<{ id: string; title: string; sub: string }> = ({ id, title, sub }) => (
    <div className={`flex items-center gap-2 rounded-2xl px-3 py-2 ${pref === id ? 'bg-violet-100/80 ring-1 ring-violet-300' : ''}`}>
      <button type="button" onClick={() => choose(id)} aria-pressed={pref === id} className="flex-1 min-w-0 flex items-center gap-2.5 text-left">
        <span className={`w-4 h-4 rounded-full border-2 shrink-0 ${pref === id ? 'border-violet-600 bg-violet-600 shadow-[inset_0_0_0_3px_white]' : 'border-slate-300'}`} />
        <span className="min-w-0">
          <span className="block text-sm font-semibold text-slate-800 truncate">{title}</span>
          <span className="block text-[11px] text-slate-500 truncate">{sub}</span>
        </span>
      </button>
      <button
        type="button"
        onClick={() => void play(id)}
        aria-label={playing?.id === id ? 'Stop' : `Listen to ${title}`}
        className="liquid-glass-chip w-8 h-8 rounded-full flex items-center justify-center shrink-0 text-violet-700"
      >
        {playing?.id === id ? playing.loading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Square className="w-3 h-3" /> : <Volume2 className="w-3.5 h-3.5" />}
      </button>
    </div>
  );
  return (
    <>
      <div className="fixed inset-0 z-[90] liquid-glass-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="fixed inset-0 z-[91] flex items-end sm:items-center justify-center p-3 pointer-events-none">
        <div role="dialog" aria-label="Choose voice" className="pointer-events-auto liquid-glass liquid-glass-in rounded-[32px] w-full max-w-sm max-h-[80vh] flex flex-col overflow-hidden">
          <div className="flex items-center gap-3 px-5 pt-5 pb-2">
            <span className="liquid-glass-inset w-10 h-10 rounded-2xl flex items-center justify-center text-violet-700 shrink-0">
              <Volume2 className="w-5 h-5" />
            </span>
            <div className="min-w-0 flex-1">
              <h3 className="text-base font-bold text-slate-900 leading-tight">কণ্ঠ বেছে নিন</h3>
              <p className="text-[11px] text-slate-500">🔊 চেপে শুনে দেখুন, পছন্দেরটায় টিক দিন</p>
            </div>
            <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip p-1.5 text-slate-600 rounded-full">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div className="overflow-y-auto px-3 pb-2 space-y-1">
            <Row id="auto" title="ফোনের নিজের কণ্ঠ (স্বয়ংক্রিয়)" sub="সাথে সাথে বাজে; ফোনে বাংলা কণ্ঠ না থাকলে নিচের ডিফল্ট" />
            {device.length > 1 && device.map((d, i) => <Row key={d.id} id={`device:${d.id}`} title={`ফোনের কণ্ঠ ${i + 1}`} sub={d.label} />)}
            <p className="px-3 pt-3 pb-1 text-[10px] font-semibold uppercase tracking-wide text-slate-500">Gemini-র কণ্ঠ (আরও স্বাভাবিক, আসতে ২–৩ সেকেন্ড)</p>
            {GEMINI_VOICES.map((g) => (
              <Row key={g.name} id={`gemini:${g.name}`} title={g.label} sub={`${g.desc} · ${g.name}`} />
            ))}
          </div>
          {err && <p className="px-5 text-xs text-rose-600">{err}</p>}
          <div className="p-4 pt-2">
            <button type="button" onClick={onClose} className="liquid-glass-button rounded-full w-full py-2.5 text-sm font-semibold">
              ঠিক আছে
            </button>
          </div>
        </div>
      </div>
    </>
  );
};

const EdgeTab: React.FC<{ count: number; onOpen: () => void }> = ({ count, onOpen }) => {
  const scrolling = useScrolling();
  // Distance from the bottom of the screen, so it stays put above the
  // keyboard / bottom bars on any phone height.
  const [bottom, setBottom] = useState<number>(() => {
    try {
      const v = Number(localStorage.getItem(TAB_KEY));
      if (Number.isFinite(v) && v > 0) return v;
    } catch {
      // storage unavailable — the default place
    }
    return 132;
  });
  const drag = useRef<{ startY: number; startBottom: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);
  const clamp = (b: number) => Math.min(window.innerHeight - TAB_H - 80, Math.max(72, b));
  useEffect(() => {
    const onResize = () => setBottom((b) => clamp(b));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  return (
    <div
      className="assistant-fab assistant-edge-tab fixed z-50 right-0 transition-transform duration-300 ease-out"
      style={{ bottom: `calc(${bottom}px + env(safe-area-inset-bottom, 0px))`, transform: scrolling && !drag.current ? 'translateX(110%)' : 'translateX(0)' }}
    >
      <button
        type="button"
        title="Credence Assistant — drag to move"
        aria-label="Open Credence Assistant"
        onPointerDown={(e) => {
          drag.current = { startY: e.clientY, startBottom: bottom, moved: false };
          (e.currentTarget as HTMLElement).setPointerCapture(e.pointerId);
        }}
        onPointerMove={(e) => {
          const d = drag.current;
          if (!d) return;
          const dy = e.clientY - d.startY;
          if (Math.abs(dy) > 6) d.moved = true;
          if (d.moved) setBottom(clamp(d.startBottom - dy));
        }}
        onPointerUp={() => {
          const d = drag.current;
          drag.current = null;
          justDragged.current = !!d?.moved;
          if (d?.moved) {
            try {
              localStorage.setItem(TAB_KEY, String(Math.round(bottom)));
            } catch {
              // storage unavailable — the place just isn't remembered
            }
          }
        }}
        onPointerCancel={() => (drag.current = null)}
        // Opens on the click (not on finger-up), so the click that follows a
        // tap doesn't land on the Assistant's backdrop and close it again.
        onClick={() => {
          if (justDragged.current) {
            justDragged.current = false;
            return;
          }
          onOpen();
        }}
        className="liquid-glass-button w-10 rounded-l-2xl rounded-r-none flex items-center justify-center touch-none select-none shadow-lg"
        style={{ height: TAB_H }}
      >
        <Sparkles className="w-[18px] h-[18px]" />
      </button>
      {count > 0 && (
        <span className="absolute -top-1.5 left-[-6px] min-w-[18px] h-[18px] px-1 bg-rose-500 text-white text-[10px] font-bold rounded-full flex items-center justify-center border-2 border-white pointer-events-none">
          {count}
        </span>
      )}
    </div>
  );
};

