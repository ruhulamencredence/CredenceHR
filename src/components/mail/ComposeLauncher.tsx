/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail's "New message" window, opened from anywhere in the app
// (the AI Assistant's report Email): the same MailCompose as Mail -> Write,
// with the person's own mailbox, default signature, templates, Cc / Bcc and
// the file already attached. It sends through /api/mail/send like any mail,
// so it goes from their own address and lands in their Sent.
//
// Only for people Credence Mail is on for (the server checks it too); with
// no mailbox connected yet, or while an admin has someone else's mailbox
// open (read only), it says what to do instead of opening.

import React, { useEffect, useState } from 'react';
import { createRoot, Root } from 'react-dom/client';
import { CheckCircle2, Loader2, Mail, X } from 'lucide-react';
import { MailCompose, type ComposeInit } from './MailCompose';
import { mailFetch, mailViewAsActive, type MailSettings, type MailStatus, type MailTemplate } from '../../lib/mailApi';

let root: Root | null = null;
let host: HTMLDivElement | null = null;
const unmount = () => root?.render(<></>);

/** Opens the New message window with `init` filled in (files attached). */
export function openMailCompose(token: string, init: ComposeInit) {
  if (!host) {
    host = document.createElement('div');
    document.body.appendChild(host);
    root = createRoot(host);
  }
  root!.render(<Launcher key={Date.now()} token={token} init={init} />);
}

const Notice: React.FC<{ tone: 'info' | 'ok'; text: string; onClose: () => void }> = ({ tone, text, onClose }) => (
  <div className="liquid-glass-backdrop fixed inset-0 z-[3000] flex items-center justify-center p-4" onClick={onClose} role="presentation">
    <div className="w-full max-w-sm" onClick={(e) => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Credence Mail">
      <div className="liquid-glass liquid-glass-in rounded-[32px] p-5">
        <div className="flex items-start gap-3.5">
          <div className={`liquid-glass-inset w-11 h-11 rounded-2xl flex items-center justify-center shrink-0 ${tone === 'ok' ? 'text-emerald-600' : 'text-violet-600'}`}>
            {tone === 'ok' ? <CheckCircle2 className="w-5 h-5" /> : <Mail className="w-5 h-5" />}
          </div>
          <p className="flex-1 text-sm text-slate-700 pt-1">{text}</p>
          <button type="button" onClick={onClose} className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center shrink-0" aria-label="Close">
            <X className="w-4 h-4 text-slate-600" />
          </button>
        </div>
        <button type="button" onClick={onClose} className="liquid-glass-button rounded-full w-full py-2.5 text-sm font-semibold mt-4">
          {tone === 'ok' ? 'Done' : 'OK'}
        </button>
      </div>
    </div>
  </div>
);

const Launcher: React.FC<{ token: string; init: ComposeInit }> = ({ token, init }) => {
  const [state, setState] = useState<
    | { kind: 'loading' }
    | { kind: 'closed' }
    | { kind: 'notice'; tone: 'info' | 'ok'; text: string }
    | { kind: 'compose'; status: MailStatus; settings: MailSettings | null; templates: MailTemplate[] }
  >({ kind: 'loading' });

  useEffect(() => {
    if (mailViewAsActive()) {
      setState({ kind: 'notice', tone: 'info', text: "Another person's mailbox is open in Credence Mail (read only). Close it, then send again." });
      return;
    }
    let gone = false;
    (async () => {
      try {
        const status = await mailFetch<MailStatus>(token, '/status');
        if (gone) return;
        if (!status.enabled) {
          setState({ kind: 'notice', tone: 'info', text: "Credence Mail isn't turned on for your account — ask the Superadmin (Module Access → Mail)." });
          return;
        }
        if (!status.accounts?.length) {
          setState({ kind: 'notice', tone: 'info', text: 'This goes from your own email, and no mailbox is connected yet. Open Self Service → Mail, add your email account, then send again.' });
          return;
        }
        const [settings, templates] = await Promise.all([
          mailFetch<MailSettings>(token, '/settings').catch(() => null),
          mailFetch<MailTemplate[]>(token, '/templates').catch(() => [] as MailTemplate[])
        ]);
        if (!gone) setState({ kind: 'compose', status, settings, templates });
      } catch (e: any) {
        if (!gone) setState({ kind: 'notice', tone: 'info', text: e?.message || "Couldn't open Credence Mail." });
      }
    })();
    return () => {
      gone = true;
    };
  }, [token]);

  if (state.kind === 'loading') {
    return (
      <div className="liquid-glass-backdrop fixed inset-0 z-[3000] flex items-center justify-center" role="presentation">
        <div className="liquid-glass liquid-glass-in rounded-[32px] px-5 py-4 flex items-center gap-2.5 text-sm text-slate-700">
          <Loader2 className="w-4 h-4 animate-spin text-violet-600" /> Opening Credence Mail…
        </div>
      </div>
    );
  }
  if (state.kind === 'closed') return null;
  if (state.kind === 'notice') return <Notice tone={state.tone} text={state.text} onClose={unmount} />;
  return (
    <div className="relative z-[3000]">
      <MailCompose
        token={token}
        accounts={state.status.accounts}
        signatures={state.settings?.signatures || []}
        templates={state.templates}
        init={init}
        // Closed without sending: it was kept in Mail -> Drafts (MailCompose saves it).
        onClose={() => setState((s) => (s.kind === 'compose' ? { kind: 'closed' } : s))}
        onDone={(text) => {
          // "Draft saved." keeps the window open; a send or a schedule closes it.
          if (/^(Sent|Will be sent)/.test(text)) setState({ kind: 'notice', tone: 'ok', text: /^Sent/.test(text) ? `${text} A copy is in your Mail → Sent.` : text });
        }}
      />
    </div>
  );
};
