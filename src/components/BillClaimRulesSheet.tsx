/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Capacitor } from '@capacitor/core';
import { X, Check } from 'lucide-react';
import type { MyBillClaimPolicy } from '../types';
import { apiUrl } from '../lib/api';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Spinner } from './Spinner';

// Bill Claim → (i) Rules. The Bill Claim Policy in plain words, written from
// the rules as they are set now (GET /api/bill-claim-policy/mine — this
// person's own designation limits included), so it never goes out of date.
// Before the first claim (and after any change to the rules) it opens by
// itself and must be read to the end and confirmed; the server refuses the
// person's own claim until then (BillClaimPolicy.ts hasReadCurrentRules).

export interface RulesReading {
  version: { id: number; no: number; at: string | null; changed_by: string | null; summary: string | null };
  confirmed_at: string | null;
  confirmed_older: boolean;
  last_confirmed_at: string | null;
}

type Lang = 'bn' | 'en';
type Mark = 'do' | 'no' | 'i';
interface Section {
  icon: string;
  tint: string;
  title: string;
  items?: [Mark, string][];
  limits?: { label: string; value: string; unit: string }[];
}

// Names typed in Bill Claim Policy go into the rule text as plain text.
const esc = (t: string) => t.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c] as string);
const taka = (n: number) => `৳${Number(n).toLocaleString('en-US', { maximumFractionDigits: 2 })}`;
const bnNum = (n: number | string) => String(n).replace(/[0-9]/g, (d) => '০১২৩৪৫৬৭৮৯'[Number(d)]);

export function deviceLabel(): string {
  if (Capacitor.isNativePlatform()) return Capacitor.getPlatform() === 'ios' ? 'iPhone app' : 'Android app';
  const ua = navigator.userAgent;
  const browser = /Edg\//.test(ua) ? 'Edge' : /Chrome\//.test(ua) ? 'Chrome' : /Firefox\//.test(ua) ? 'Firefox' : /Safari\//.test(ua) ? 'Safari' : 'browser';
  return `${/Mobi|Android|iPhone/i.test(ua) ? 'Phone' : 'Web'} · ${browser}`;
}

function buildSections(p: MyBillClaimPolicy, lang: Lang): Section[] {
  const v = p.values;
  const bn = lang === 'bn';
  const n = (x: number) => (bn ? bnNum(x) : String(x));
  const back = Number(v.backdate_days) || 0;
  const out: Section[] = [];

  const dates: [Mark, string][] = [];
  dates.push(['i', bn ? (back === 0 ? 'শুধু <b>আজকের</b> bill দেওয়া যায়।' : `আজ আর আগের <b>${n(back)} দিনের</b> bill দেওয়া যায়।`) : back === 0 ? 'Only <b>today\'s</b> bills.' : `Bills from today and the last <b>${back} days</b>.`]);
  if (!v.allow_future_dates) dates.push(['no', bn ? 'ভবিষ্যতের তারিখের bill দেওয়া যাবে না।' : 'No future dates.']);
  if (v.one_claim_per_date)
    dates.push(['do', bn ? 'একটা তারিখের সব bill <b>একটাই claim-এ</b>। পরে কিছু যোগ করতে চাইলে নতুন claim নয়, আগের claim-টা <b>Edit</b> করুন।' : 'All bills of one date go in <b>one claim</b> — to add more, <b>Edit</b> that claim instead of filing a new one.']);
  if (v.one_claim_per_date && v.lock_whole_range)
    dates.push(['i', bn ? 'একটা claim যে From–To দিনগুলো ধরে, সেগুলো অন্য claim-এ নেওয়া যায় না।' : 'The days between a claim\'s From and To dates belong to that claim only.']);
  if (v.one_claim_per_day) dates.push(['i', bn ? 'দিনে <b>একটাই নতুন claim</b>।' : '<b>One new claim a day</b>.']);
  if (v.lock_dates_after_day) dates.push(['no', bn ? 'যে তারিখের claim হয়ে গেছে, পরের দিন থেকে সেই তারিখে আর bill যোগ করা যায় না।' : 'From the next day on, no more bills can be added for a date already claimed.']);
  out.push({ icon: '📅', tint: 'bg-sky-50', title: bn ? 'কোন তারিখের bill দেওয়া যায়' : 'Which dates you can claim', items: dates });

  const transport = p.categories.find((c) => /transport/i.test(c.name));
  if (transport) {
    out.push({
      icon: '🚕',
      tint: 'bg-orange-50',
      title: 'Transport',
      items: v.transport_from_check_in_out
        ? [
            ['no', bn ? 'Transport-এর টাকা <b>হাতে লেখা যায় না</b>।' : 'A Transport amount <b>can\'t be typed in</b>.'],
            ['do', bn ? 'যে Check In/Out-এ গিয়েছেন সেগুলোয় টিক দিন, প্রতিটার টাকা লিখুন — যোগফলই bill।' : 'Tick the Check In/Outs you travelled on and enter each one\'s amount — their total is the bill.'],
            ['i', bn ? 'এক claim-এ একটাই Transport bill; Check Out আর তার approval শেষ হলে তবেই দেওয়া যায়।' : 'One Transport bill per claim; a Check In/Out goes on it once you\'ve checked out and it is approved.']
          ]
        : [['i', bn ? 'Transport bill-এ Check In/Out জুড়তে পারেন — যোগফলই তখন bill-এর টাকা।' : 'You can add your Check In/Outs to a Transport bill — their total becomes its amount.']]
    });
  }

  const enforce = !!v.enforce_category_limits;
  const limited = enforce ? p.categories.filter((c) => c.max_per_bill != null || c.daily_limit != null || c.monthly_limit != null) : [];
  const limits: Section['limits'] = [];
  limited.forEach((c) => {
    if (c.daily_limit != null) limits.push({ label: c.name, value: taka(c.daily_limit), unit: bn ? 'দিনে' : 'a day' });
    if (c.max_per_bill != null) limits.push({ label: c.name, value: taka(c.max_per_bill), unit: bn ? 'প্রতি bill' : 'per bill' });
    if (c.monthly_limit != null) limits.push({ label: c.name, value: taka(c.monthly_limit), unit: bn ? 'মাসে' : 'a month' });
  });
  limits.push({ label: bn ? 'Bill' : 'Bills', value: n(Number(v.max_bills_per_claim) || 20), unit: bn ? 'এক claim-এ' : 'per claim' });
  if (Number(v.max_claim_total) > 0) limits.push({ label: bn ? 'মোট' : 'Total', value: taka(Number(v.max_claim_total)), unit: bn ? 'এক claim-এ' : 'per claim' });
  const money: [Mark, string][] = [];
  const receipts = enforce ? p.categories.filter((c) => c.receipt_required).map((c) => esc(c.name)) : [];
  if (receipts.length) money.push(['do', bn ? `রসিদ লাগবে: <b>${receipts.join(', ')}</b> (ছবি / PDF, ৫MB পর্যন্ত)।` : `A receipt is needed for <b>${receipts.join(', ')}</b> (photo / PDF, up to 5MB).`]);
  if (Number(v.attachment_required_above) > 0) money.push(['do', bn ? `মোট ${taka(Number(v.attachment_required_above))}-এর বেশি হলে রসিদ লাগবে।` : `A receipt is needed when the claim is over ${taka(Number(v.attachment_required_above))}.`]);
  out.push({ icon: '💳', tint: 'bg-violet-50', title: bn ? 'আপনার টাকার সীমা' : 'Your money limits', limits, items: money });

  const layer = Number(v.edit_lock_layer) || 1;
  const after: [Mark, string][] = [];
  after.push(['do', bn ? `${layer === 1 ? 'Supervisor' : `Layer ${n(layer)}`} approve করার আগ পর্যন্ত <b>Edit</b> বা <b>Withdraw</b> করা যায়।` : `<b>Edit</b> or <b>Withdraw</b> until ${layer === 1 ? 'your Supervisor' : `Layer ${layer}`} approves.`]);
  if (v.allow_return) after.push(['i', bn ? '<b>Return</b> হলে ঠিক করে আবার জমা দিন — approval আবার প্রথম থেকে।' : '<b>Returned:</b> fix it and submit again — approval starts over.']);
  after.push(['no', bn ? `<b>Reject</b> হলে সেটা শেষ${v.allow_reclaim_on_reject ? '; approver "Allow re-claim" দিলে তবেই আবার দেওয়া যায়' : ''}।` : `<b>Rejected</b> is final${v.allow_reclaim_on_reject ? ' unless the approver allows a re-claim' : ''}.`]);
  after.push(['i', bn ? 'Approver Approved Amount কমাতে পারেন, বাড়াতে পারেন না।' : 'The approver can lower the Approved Amount, never raise it.']);
  out.push({ icon: '✏️', tint: 'bg-emerald-50', title: bn ? 'জমা দেওয়ার পর' : 'After you submit', items: after });

  out.push({
    icon: '⚠️',
    tint: 'bg-rose-50',
    title: bn ? 'ভুল করলে' : 'If something is wrong',
    items: [
      ['i', bn ? 'নিয়ম না মানলে form জমা নেবে না, কারণ লাল লেখায় দেখাবে।' : 'The form refuses a claim that breaks a rule and says why in red.'],
      ['no', bn ? 'মিথ্যা বা বানানো bill পাওয়া গেলে claim Reject হবে আর HR-কে জানানো হবে।' : 'A false or made-up bill is rejected and reported to HR.']
    ]
  });
  return out;
}

const MARK: Record<Mark, [string, string]> = {
  do: ['✓', 'bg-emerald-50 text-emerald-700'],
  no: ['✕', 'bg-rose-50 text-rose-600'],
  i: ['i', 'bg-sky-50 text-sky-700']
};

export const BillClaimRulesSheet: React.FC<{
  token: string;
  reading: RulesReading | null;
  // 'confirm': must read to the end and confirm (first visit / rules changed).
  mode: 'confirm' | 'view';
  onConfirmed: (r: RulesReading) => void;
  onClose: () => void;
}> = ({ token, reading, mode, onConfirmed, onClose }) => {
  const [policy, setPolicy] = useState<MyBillClaimPolicy | null>(null);
  const [error, setError] = useState('');
  const [lang, setLang] = useState<Lang>(() => {
    try {
      return (localStorage.getItem('chr_bill_rules_lang') as Lang) || 'bn';
    } catch {
      return 'bn';
    }
  });
  const [progress, setProgress] = useState(0);
  const [reached, setReached] = useState(mode === 'view');
  const [ticked, setTicked] = useState(false);
  const [busy, setBusy] = useState(false);
  const listRef = useRef<HTMLDivElement>(null);
  useBackButtonClose(true, onClose);

  useEffect(() => {
    fetch(apiUrl('/api/bill-claim-policy/mine'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => r.json().then((d) => ({ ok: r.ok, d })))
      .then(({ ok, d }) => (ok ? setPolicy(d) : setError(d?.error || 'Could not load the rules.')))
      .catch(() => setError('Could not load the rules — check the connection.'));
    // Recorded once per opening (the server keeps one per 30 minutes).
    fetch(apiUrl('/api/bill-claim-rules/read'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ action: 'open', device: deviceLabel() })
    }).catch(() => {});
  }, [token]);
  useEffect(() => {
    try {
      localStorage.setItem('chr_bill_rules_lang', lang);
    } catch {
      /* not kept */
    }
  }, [lang]);

  const onScroll = () => {
    const el = listRef.current;
    if (!el) return;
    const p = el.scrollHeight <= el.clientHeight ? 1 : Math.min(1, (el.scrollTop + el.clientHeight) / (el.scrollHeight - 2));
    setProgress(p);
    if (p >= 0.99) setReached(true);
  };
  useEffect(() => {
    // A short list that needs no scrolling counts as read.
    const t = setTimeout(onScroll, 50);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [policy, lang]);

  const confirm = async () => {
    setBusy(true);
    setError('');
    try {
      const r = await fetch(apiUrl('/api/bill-claim-rules/read'), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({ action: 'confirm', version_id: reading?.version.id, device: deviceLabel() })
      });
      const d = await r.json();
      if (!r.ok) throw new Error(d.error || 'Could not confirm.');
      onConfirmed(d);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const sections = policy ? buildSections(policy, lang) : [];
  const bn = lang === 'bn';
  const pct = Math.round((mode === 'view' ? 1 : progress) * 100);
  const C = 2 * Math.PI * 23;
  const fmt = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }) : '');
  const sub =
    mode === 'view'
      ? reading?.confirmed_at
        ? bn
          ? `আপনি ${fmt(reading.confirmed_at)}-এ পড়ে নিশ্চিত করেছেন`
          : `You confirmed these on ${fmt(reading.confirmed_at)}`
        : bn
          ? 'Bill Claim-এর নিয়ম'
          : 'How Bill Claim works'
      : reading?.confirmed_older
        ? bn
          ? 'নিয়ম বদলেছে — আবার শেষ পর্যন্ত পড়ে নিশ্চিত করুন'
          : 'The rules changed — read them to the end and confirm again'
        : bn
          ? 'প্রথম claim-এর আগে একবার শেষ পর্যন্ত পড়ুন'
          : 'Read to the end once before your first claim';

  return createPortal(
    <div className="fixed inset-0 z-[1200] liquid-glass-backdrop flex items-end sm:items-center justify-center sm:p-4" onClick={mode === 'view' ? onClose : undefined}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Bill Claim rules"
        onClick={(e) => e.stopPropagation()}
        className="liquid-glass liquid-glass-in w-full sm:max-w-lg h-[92dvh] sm:h-[86vh] rounded-t-[32px] sm:rounded-[32px] flex flex-col overflow-hidden"
      >
        <div className="flex items-center gap-3 px-5 pt-5 pb-3">
          <div className="relative w-14 h-14 shrink-0">
            <svg width="56" height="56" viewBox="0 0 56 56" className="-rotate-90">
              <circle cx="28" cy="28" r="23" fill="none" stroke="rgba(148,163,184,.3)" strokeWidth="6" />
              <circle cx="28" cy="28" r="23" fill="none" stroke="var(--g-accent, #f26a10)" strokeWidth="6" strokeLinecap="round" strokeDasharray={C} strokeDashoffset={C * (1 - pct / 100)} />
            </svg>
            <span className="absolute inset-0 grid place-items-center text-[11px] font-extrabold" style={{ color: 'var(--g-accent, #f26a10)' }}>
              {mode === 'view' ? <Check className="w-5 h-5" /> : `${pct}%`}
            </span>
          </div>
          <div className="min-w-0 flex-1">
            <h3 className="text-lg font-extrabold text-slate-900">Bill Claim rules</h3>
            <p className="text-xs text-slate-500">{sub}</p>
          </div>
          <div className="self-start inline-flex rounded-full bg-white/70 border border-white/60 p-0.5 text-[11px] font-bold" role="group" aria-label="Language">
            {(['bn', 'en'] as Lang[]).map((l) => (
              <button key={l} type="button" aria-pressed={lang === l} onClick={() => setLang(l)} className={`px-2.5 py-1 rounded-full ${lang === l ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500'}`}>
                {l === 'bn' ? 'বাংলা' : 'EN'}
              </button>
            ))}
          </div>
          {mode === 'view' && (
            <button type="button" onClick={onClose} className="liquid-glass-chip w-9 h-9 rounded-full self-start flex items-center justify-center" aria-label="Close">
              <X className="w-4 h-4" />
            </button>
          )}
        </div>
        {mode === 'confirm' && sections.length > 0 && (
          <div className="flex gap-1.5 px-5 pb-2">
            {sections.map((_, i) => (
              <i key={i} className="flex-1 h-1 rounded-full" style={{ background: progress * sections.length > i + 0.2 ? 'var(--g-accent, #f26a10)' : 'rgba(148,163,184,.3)' }} />
            ))}
          </div>
        )}

        <div ref={listRef} onScroll={onScroll} className="flex-1 min-h-0 overflow-y-auto overscroll-contain px-4 pb-4 space-y-3">
          {!policy && !error && (
            <div className="py-16 flex justify-center">
              <Spinner size={20} />
            </div>
          )}
          {sections.map((s, i) => (
            <section key={i} className="liquid-glass-inset rounded-[22px] p-3.5">
              <h4 className="flex items-center gap-2.5 mb-2.5 text-[13.5px] font-bold text-slate-900">
                <span className={`w-8 h-8 rounded-xl grid place-items-center text-base ${s.tint}`}>{s.icon}</span>
                {s.title}
                <span className="ml-auto text-[10px] font-bold text-slate-400">
                  {i + 1}/{sections.length}
                </span>
              </h4>
              {s.limits && (
                <>
                  {policy?.categories.some((c) => c.limits_for) && (
                    <span className="inline-block mb-2 text-[10.5px] font-bold px-2 py-0.5 rounded-full bg-violet-50 text-violet-700">
                      👤 {bn ? `${policy.categories.find((c) => c.limits_for)?.limits_for} হিসেবে আপনার সীমা` : `Your limits as ${policy.categories.find((c) => c.limits_for)?.limits_for}`}
                    </span>
                  )}
                  <div className="grid grid-cols-3 gap-2 mb-2">
                    {s.limits.map((l, k) => (
                      <div key={k} className="rounded-2xl px-2.5 py-2 bg-white/70 border border-white/70">
                        <div className="text-[10.5px] font-semibold text-slate-500 truncate">{l.label}</div>
                        <div className="text-base font-extrabold tracking-tight" style={{ color: 'var(--g-accent, #c2410c)' }}>
                          {l.value}
                        </div>
                        <div className="text-[10px] text-slate-400">{l.unit}</div>
                      </div>
                    ))}
                  </div>
                </>
              )}
              {!!s.items?.length && (
                <ul className="space-y-2">
                  {s.items.map(([m, html], k) => (
                    <li key={k} className="grid grid-cols-[20px_1fr] gap-2 text-[12.5px] text-slate-700">
                      <span className={`w-5 h-5 rounded-md grid place-items-center text-[11px] font-extrabold ${MARK[m][1]}`}>{MARK[m][0]}</span>
                      <span dangerouslySetInnerHTML={{ __html: html }} />
                    </li>
                  ))}
                </ul>
              )}
            </section>
          ))}
          {policy && mode === 'confirm' && reached && <p className="text-center text-xs font-bold text-emerald-600">{bn ? '✓ সব পড়া হয়েছে' : '✓ All read'}</p>}
        </div>

        <div className="px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom,0px))] border-t border-white/50 space-y-2.5">
          {error && <p className="text-xs text-rose-600 text-center">{error}</p>}
          {mode === 'confirm' ? (
            <>
              {!reached && <p className="text-center text-[11.5px] font-semibold text-amber-700">{bn ? '↓ শেষ পর্যন্ত পড়ুন — তারপর টিক দেওয়া যাবে' : '↓ Read to the end — then you can tick'}</p>}
              <label className={`flex items-start gap-2.5 rounded-2xl px-3 py-2.5 bg-white/70 border ${ticked ? 'border-emerald-500' : 'border-white/70'} ${reached ? 'cursor-pointer' : 'opacity-45 cursor-not-allowed'}`}>
                <input type="checkbox" className="mt-0.5 w-4 h-4 accent-emerald-600" disabled={!reached} checked={ticked} onChange={(e) => setTicked(e.target.checked)} />
                <span className="text-[12.5px] text-slate-700">{bn ? 'আমি সব নিয়ম পড়েছি ও বুঝেছি।' : 'I have read and understood every rule.'}</span>
              </label>
              <button
                type="button"
                disabled={!ticked || busy || !policy}
                onClick={() => void confirm()}
                className="liquid-glass-button rounded-full w-full py-3 text-sm font-extrabold disabled:opacity-40 flex items-center justify-center gap-2"
              >
                {busy && <Spinner size={14} />} {bn ? 'নিশ্চিত করে claim শুরু করুন' : 'Confirm & start claiming'}
              </button>
              <button type="button" onClick={onClose} className="w-full text-xs font-semibold text-slate-500">
                {bn ? 'পরে পড়ব (ততক্ষণ New Claim বন্ধ থাকবে)' : 'Later (New Claim stays locked)'}
              </button>
            </>
          ) : (
            <button type="button" onClick={onClose} className="liquid-glass-button rounded-full w-full py-3 text-sm font-bold">
              {bn ? 'বন্ধ করুন' : 'Close'}
            </button>
          )}
        </div>
      </div>
    </div>,
    document.body
  );
};
