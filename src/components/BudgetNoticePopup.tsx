/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Opens right after a Budget import (Data Import -> Budget), for the draft
// notice the import wrote (BudgetNoticeDraft.ts):
//   "<Budget> - MPR Updated up to <date>" /
//   "<date> তারিখ পর্যন্ত যে সকল MPR পোস্টিং হয়েছে সেগুলো Budget Optimization Software এ এন্ট্রি দিতে পারবেন।"
// Picking the date (or a From - Up to range) rewrites both until they are
// edited by hand. Publish shows it to its audience now (with the pushes);
// "Keep as draft" leaves it in Admin Panel -> Notices. Needs the Notices module.

import React, { useEffect, useState } from 'react';
import { Bell, Loader2, Users as UsersIcon, Globe } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn } from './mail/MailPopup';

export interface BudgetNoticeDraftInfo {
  id: number;
  created: boolean;
  budget_name: string;
  title: string;
  content_html: string;
  target_type: 'all' | 'specific';
  target_user_ids: number[];
}

const MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const noticeDate = (iso: string) => (/^\d{4}-\d{2}-\d{2}$/.test(iso) ? `${iso.slice(8, 10)}-${MON[Number(iso.slice(5, 7)) - 1]}-${iso.slice(0, 4)}` : iso);
const todayDhaka = () => new Date().toLocaleDateString('en-CA', { timeZone: 'Asia/Dhaka' });
// Same wording as BudgetNoticeDraft.ts on the server.
const textFor = (budget: string, upTo: string, from: string) => ({
  title: `${budget} - MPR Updated up to ${from ? `${noticeDate(from)} to ${noticeDate(upTo)}` : noticeDate(upTo)}`.slice(0, 200),
  message: `${from ? `${noticeDate(from)} থেকে ${noticeDate(upTo)}` : noticeDate(upTo)} তারিখ পর্যন্ত যে সকল MPR পোস্টিং হয়েছে সেগুলো Budget Optimization Software এ এন্ট্রি দিতে পারবেন।`
});
const esc = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const toHtml = (text: string) =>
  text
    .split(/\n{2,}/)
    .map((p) => p.trim())
    .filter(Boolean)
    .map((p) => `<p>${esc(p).replace(/\n/g, '<br>')}</p>`)
    .join('');

export const BudgetNoticePopup: React.FC<{ token: string; draft: BudgetNoticeDraftInfo; onClose: () => void; onDone: (text: string) => void }> = ({ token, draft, onClose, onDone }) => {
  const [upTo, setUpTo] = useState(todayDhaka());
  const [from, setFrom] = useState('');
  const start = textFor(draft.budget_name, todayDhaka(), '');
  const [title, setTitle] = useState(start.title);
  const [message, setMessage] = useState(start.message);
  const [titleEdited, setTitleEdited] = useState(false);
  const [messageEdited, setMessageEdited] = useState(false);
  const [toAll, setToAll] = useState(draft.target_type === 'all');
  const [busy, setBusy] = useState<'' | 'draft' | 'publish'>('');
  const [error, setError] = useState('');

  // The date rewrites whatever hasn't been typed over.
  useEffect(() => {
    const t = textFor(draft.budget_name, upTo, from);
    if (!titleEdited) setTitle(t.title);
    if (!messageEdited) setMessage(t.message);
  }, [upTo, from, draft.budget_name, titleEdited, messageEdited]);

  const save = async (publish: boolean) => {
    setBusy(publish ? 'publish' : 'draft');
    setError('');
    try {
      const headers = { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` };
      const put = await fetch(apiUrl(`/api/notices/${draft.id}`), {
        method: 'PUT',
        headers,
        body: JSON.stringify({
          title: title.trim(),
          content_html: toHtml(message),
          target_type: toAll ? 'all' : 'specific',
          target_user_ids: toAll ? [] : draft.target_user_ids
        })
      });
      const pj = await put.json().catch(() => ({}));
      if (!put.ok) throw new Error(pj.error || 'Could not save the notice');
      if (publish) {
        const act = await fetch(apiUrl(`/api/notices/${draft.id}/active`), { method: 'PUT', headers, body: JSON.stringify({ is_active: true }) });
        const aj = await act.json().catch(() => ({}));
        if (!act.ok) throw new Error(aj.error || 'Saved, but could not publish it');
      }
      onDone(publish ? `Notice "${title.trim()}" published.` : `Notice "${title.trim()}" kept as a draft in Admin Panel -> Notices.`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy('');
    }
  };

  const audience = draft.target_user_ids.length;
  return (
    <Popup
      title="Edit notice"
      icon={<Bell className="w-4 h-4" />}
      size="lg"
      onClose={busy ? () => {} : onClose}
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={() => void save(false)} disabled={!!busy || !title.trim() || !message.trim()}>
            {busy === 'draft' && <Loader2 className="w-4 h-4 animate-spin inline mr-1" />}Keep as draft
          </button>
          <button type="button" className={primaryBtn} onClick={() => void save(true)} disabled={!!busy || !title.trim() || !message.trim()}>
            {busy === 'publish' && <Loader2 className="w-4 h-4 animate-spin" />} Publish
          </button>
        </>
      }
    >
      <div className="space-y-3 text-left">
        <p className="text-xs text-slate-500">
          The Budget import wrote this notice. Pick the date the MPRs are posted up to, check it and publish — nobody sees it before that.
        </p>
        <div className="grid grid-cols-2 gap-2">
          <div>
            <label className={labelCls}>From (optional)</label>
            <input type="date" className={inputCls} value={from} max={upTo} onChange={(e) => setFrom(e.target.value)} />
          </div>
          <div>
            <label className={labelCls}>MPR posted up to</label>
            <input type="date" className={inputCls} value={upTo} onChange={(e) => e.target.value && setUpTo(e.target.value)} />
          </div>
        </div>
        <div>
          <label className={labelCls}>Title</label>
          <input
            className={inputCls}
            value={title}
            maxLength={200}
            onChange={(e) => {
              setTitle(e.target.value);
              setTitleEdited(true);
            }}
          />
        </div>
        <div>
          <label className={labelCls}>Message</label>
          <textarea
            className={`${inputCls} min-h-[96px]`}
            value={message}
            onChange={(e) => {
              setMessage(e.target.value);
              setMessageEdited(true);
            }}
          />
          {(titleEdited || messageEdited) && (
            <button
              type="button"
              className="text-[11px] underline text-slate-500 mt-1"
              onClick={() => {
                setTitleEdited(false);
                setMessageEdited(false);
              }}
            >
              Go back to the standard wording
            </button>
          )}
        </div>
        <div className="liquid-glass-inset rounded-[20px] p-3 text-xs space-y-2">
          <div className="font-semibold text-slate-700">Who sees it</div>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={!toAll} disabled={!audience} onChange={() => setToAll(false)} />
            <UsersIcon className="w-3.5 h-3.5 text-slate-500" />
            {audience ? `The ${audience} project account${audience === 1 ? '' : 's'} of this Budget's projects` : "No project account is set up for this Budget's projects"}
          </label>
          <label className="flex items-center gap-2 cursor-pointer">
            <input type="radio" checked={toAll} onChange={() => setToAll(true)} />
            <Globe className="w-3.5 h-3.5 text-slate-500" /> Everyone
          </label>
        </div>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};
