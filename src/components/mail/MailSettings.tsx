/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail -> Settings: General (blocked senders, list density, time
// zone), Signatures (the Credence design with a logo, or your own), and the
// Vacation responder. Saved with PUT /api/mail/settings (MailRoutes.ts).

import React, { useRef, useState } from 'react';
import { Settings, Plus, Trash2, Star, ImagePlus, Loader2, X, PenLine } from 'lucide-react';
import { confirmDialog } from '../../lib/confirmDialog';
import { MAIL_TIME_ZONES, MailSettings as Settings_, MailSignature, SignatureFields, credenceSignatureHtml, fileToDataUrl, mailFetch } from '../../lib/mailApi';
import { sanitizeMailHtml } from './MailBody';
import { MailPopup, Tabs, Toggle, inputCls, labelCls, primaryBtn, ghostBtn } from './MailPopup';

const EMPTY_FIELDS: SignatureFields = { fullName: '', title: '', department: '', mobile: '', pabx: '' };
const newId = () => (typeof crypto !== 'undefined' && 'randomUUID' in crypto ? crypto.randomUUID() : `s${Date.now()}${Math.random().toString(36).slice(2, 8)}`);

// Logos are made small (at most 360 px wide) before they're uploaded.
async function shrinkImage(file: File): Promise<string> {
  const src = await fileToDataUrl(file);
  const img = await new Promise<HTMLImageElement>((resolve, reject) => {
    const i = new Image();
    i.onload = () => resolve(i);
    i.onerror = () => reject(new Error('That picture could not be read.'));
    i.src = src;
  });
  const scale = Math.min(1, 360 / Math.max(1, img.width));
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(img.width * scale));
  c.height = Math.max(1, Math.round(img.height * scale));
  c.getContext('2d')!.drawImage(img, 0, 0, c.width, c.height);
  return c.toDataURL(file.type === 'image/jpeg' ? 'image/jpeg' : 'image/png', 0.9);
}

const SignatureEditor: React.FC<{ token: string; sig: MailSignature; onChange: (s: MailSignature) => void; onDone: () => void }> = ({ token, sig, onChange, onDone }) => {
  const design = sig.fields ? 'credence' : 'custom';
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState('');
  const fileRef = useRef<HTMLInputElement>(null);
  const customRef = useRef<HTMLDivElement>(null);
  const setFields = (f: SignatureFields, logoUrl = sig.logoUrl) => onChange({ ...sig, fields: f, logoUrl, content: credenceSignatureHtml(f, logoUrl) });

  const upload = async (file: File | undefined) => {
    if (!file) return;
    setError('');
    setUploading(true);
    try {
      const dataUrl = await shrinkImage(file);
      const r = await mailFetch<{ url: string }>(token, '/signature-images', { method: 'POST', body: { dataUrl } });
      // Recipients' mail apps load it from this server, so it needs the full address.
      setFields(sig.fields || EMPTY_FIELDS, `${window.location.origin}${r.url}`);
    } catch (e: any) {
      setError(e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-[1fr_auto] gap-2 items-end">
        <div>
          <label className={labelCls}>Signature name</label>
          <input value={sig.name} onChange={(e) => onChange({ ...sig, name: e.target.value })} placeholder="Work" className={inputCls} />
        </div>
        <div className="liquid-glass-inset rounded-full p-1 flex gap-1">
          {(['credence', 'custom'] as const).map((d) => (
            <button
              key={d}
              type="button"
              onClick={() => {
                if (d === design) return;
                if (d === 'credence') setFields(EMPTY_FIELDS, undefined);
                else onChange({ ...sig, fields: undefined, logoUrl: undefined });
              }}
              className={`text-xs font-semibold px-3 py-1.5 rounded-full ${design === d ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-600'}`}
            >
              {d === 'credence' ? 'Credence design' : 'My own'}
            </button>
          ))}
        </div>
      </div>

      {design === 'credence' ? (
        <>
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
            {(
              [
                ['fullName', 'Full name', 'Ruhul Amen'],
                ['title', 'Title', 'Executive'],
                ['department', 'Department', 'MIS Dept.'],
                ['mobile', 'Mobile', '+8801XXXXXXXXX'],
                ['pabx', 'PABX', '634']
              ] as [keyof SignatureFields, string, string][]
            ).map(([k, label, ph]) => (
              <div key={k}>
                <label className={labelCls}>{label}</label>
                <input value={sig.fields?.[k] || ''} onChange={(e) => setFields({ ...(sig.fields || EMPTY_FIELDS), [k]: e.target.value })} placeholder={ph} className={inputCls} />
              </div>
            ))}
            <div>
              <label className={labelCls}>Logo</label>
              <div className="flex items-center gap-2">
                <button type="button" onClick={() => fileRef.current?.click()} disabled={uploading} className="inline-flex items-center gap-1.5 text-xs font-semibold px-3 py-2.5 rounded-xl bg-white/80 border border-slate-200 hover:bg-white">
                  {uploading ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <ImagePlus className="w-3.5 h-3.5" />} {sig.logoUrl ? 'Change logo' : 'Add logo'}
                </button>
                {sig.logoUrl && (
                  <button type="button" onClick={() => setFields(sig.fields || EMPTY_FIELDS, undefined)} className="p-2 rounded-full text-slate-500 hover:text-rose-600 hover:bg-rose-50" aria-label="Remove logo">
                    <X className="w-3.5 h-3.5" />
                  </button>
                )}
              </div>
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/gif,image/webp" className="hidden" onChange={(e) => { void upload(e.target.files?.[0]); e.target.value = ''; }} />
            </div>
          </div>
          {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
        </>
      ) : (
        <div>
          <label className={labelCls}>Signature</label>
          <div
            ref={customRef}
            contentEditable
            suppressContentEditableWarning
            onBlur={() => onChange({ ...sig, content: customRef.current?.innerHTML || '' })}
            dangerouslySetInnerHTML={{ __html: sanitizeMailHtml(sig.content, true).html }}
            className="min-h-[6rem] text-sm px-3 py-2.5 bg-white/80 border border-slate-200 rounded-xl focus:ring-2 focus:ring-sky-200 focus:outline-none"
          />
        </div>
      )}

      {design === 'credence' && (
        <div>
          <div className={labelCls}>Preview</div>
          <div className="rounded-2xl bg-white border border-slate-200 p-3 overflow-x-auto" dangerouslySetInnerHTML={{ __html: sanitizeMailHtml(sig.content, true).html }} />
        </div>
      )}
      <div className="flex justify-end">
        <button type="button" onClick={onDone} className={ghostBtn}>Done</button>
      </div>
    </div>
  );
};

export const MailSettingsPopup: React.FC<{ token: string; userName: string; settings: Settings_; onSaved: (s: Settings_) => void; onClose: () => void; startTab?: string }> = ({
  token, userName, settings, onSaved, onClose, startTab
}) => {
  const [tab, setTab] = useState(startTab || 'general');
  const [draft, setDraft] = useState<Settings_>(() => JSON.parse(JSON.stringify(settings)));
  const [editing, setEditing] = useState<string | null>(null);
  const [blockedInput, setBlockedInput] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const set = (patch: Partial<Settings_>) => setDraft((d) => ({ ...d, ...patch }));
  const vac = draft.vacationResponder || { enabled: false, subject: '', message: '' };

  const save = async () => {
    setBusy(true);
    setError('');
    try {
      // Whatever is typed in the box counts too.
      const extra = blockedInput.trim().toLowerCase();
      const body = { ...draft, blockedSenders: extra && !draft.blockedSenders.includes(extra) ? [...draft.blockedSenders, extra] : draft.blockedSenders };
      if (body.vacationResponder.enabled && !String(body.vacationResponder.message || '').trim()) {
        setTab('vacation');
        throw new Error('Write the reply people get while you are away.');
      }
      onSaved(await mailFetch<Settings_>(token, '/settings', { method: 'PUT', body }));
      onClose();
    } catch (e: any) {
      setError(e.message);
    } finally {
      setBusy(false);
    }
  };

  const addBlocked = () => {
    const v = blockedInput.trim().toLowerCase();
    if (!v) return;
    if (!draft.blockedSenders.includes(v)) set({ blockedSenders: [...draft.blockedSenders, v] });
    setBlockedInput('');
  };

  const addSignature = () => {
    const s: MailSignature = {
      id: newId(),
      name: draft.signatures.length ? `Signature ${draft.signatures.length + 1}` : 'Work',
      isDefault: !draft.signatures.length,
      fields: { ...EMPTY_FIELDS, fullName: userName },
      content: ''
    };
    s.content = credenceSignatureHtml(s.fields!);
    set({ signatures: [...draft.signatures, s] });
    setEditing(s.id);
  };
  const editingSig = draft.signatures.find((s) => s.id === editing) || null;

  return (
    <MailPopup
      title="Mail settings"
      icon={<Settings className="w-4 h-4 text-sky-600" />}
      onClose={onClose}
      head={<Tabs tabs={[{ key: 'general', label: 'General' }, { key: 'signatures', label: 'Signatures' }, { key: 'vacation', label: 'Vacation reply' }]} value={tab} onChange={(k) => { setTab(k); setEditing(null); }} />}
      footer={
        <>
          {error && <span className="mr-auto text-xs text-rose-600">{error}</span>}
          <button type="button" onClick={onClose} className={ghostBtn}>Cancel</button>
          <button type="button" onClick={() => void save()} disabled={busy} className={primaryBtn}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} Save
          </button>
        </>
      }
    >
      {tab === 'general' && (
        <div className="space-y-5">
          <div className="liquid-glass-inset rounded-[24px] p-4 space-y-4">
            <Toggle
              checked={draft.layout?.density === 'compact'}
              onChange={(v) => set({ layout: { ...(draft.layout || {}), density: v ? 'compact' : 'comfortable' } })}
              label="Compact list"
              hint="More mails on screen, smaller rows."
            />
            <div>
              <label className={labelCls}>Time zone for mail dates</label>
              <select value={draft.timezone} onChange={(e) => set({ timezone: e.target.value })} className={inputCls}>
                {[...new Set([draft.timezone, ...MAIL_TIME_ZONES])].filter(Boolean).map((z) => (
                  <option key={z} value={z}>{z.replace(/_/g, ' ')}</option>
                ))}
              </select>
            </div>
          </div>
          <div>
            <div className="text-sm font-semibold text-slate-800">Blocked senders</div>
            <p className="text-[11px] text-slate-500 mb-2">Mail from these goes straight to Spam. An address, or a part of it (e.g. <span className="font-mono">@spam-site.com</span>).</p>
            <div className="flex gap-2">
              <input
                value={blockedInput}
                onChange={(e) => setBlockedInput(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    addBlocked();
                  }
                }}
                placeholder="someone@example.com"
                className={inputCls}
              />
              <button type="button" onClick={addBlocked} className="shrink-0 inline-flex items-center gap-1 text-xs font-semibold px-3 rounded-xl bg-white/80 border border-slate-200 hover:bg-white">
                <Plus className="w-3.5 h-3.5" /> Block
              </button>
            </div>
            {draft.blockedSenders.length > 0 && (
              <div className="mt-2 flex flex-wrap gap-1.5">
                {draft.blockedSenders.map((b) => (
                  <span key={b} className="inline-flex items-center gap-1 rounded-full bg-white/80 ring-1 ring-slate-200 pl-3 pr-1 py-1 text-xs text-slate-700">
                    {b}
                    <button type="button" onClick={() => set({ blockedSenders: draft.blockedSenders.filter((x) => x !== b) })} className="p-0.5 rounded-full hover:bg-black/5" aria-label={`Unblock ${b}`}>
                      <X className="w-3 h-3" />
                    </button>
                  </span>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {tab === 'signatures' &&
        (editingSig ? (
          <SignatureEditor
            token={token}
            sig={editingSig}
            onChange={(s) => set({ signatures: draft.signatures.map((x) => (x.id === s.id ? s : x)) })}
            onDone={() => setEditing(null)}
          />
        ) : (
          <div className="space-y-3">
            {draft.signatures.length === 0 ? (
              <p className="text-sm text-slate-500 py-4 text-center">No signature yet. It's added to the end of every mail you write.</p>
            ) : (
              <div className="liquid-glass-inset rounded-[24px] divide-y divide-slate-200/60">
                {draft.signatures.map((s) => (
                  <div key={s.id} className="flex items-center gap-3 px-4 py-3">
                    <PenLine className="w-4 h-4 text-slate-400 shrink-0" />
                    <button type="button" onClick={() => setEditing(s.id)} className="flex-1 min-w-0 text-left">
                      <span className="block text-sm font-medium text-slate-800 truncate">{s.name}</span>
                      <span className="block text-[11px] text-slate-500">{s.fields ? 'Credence design' : 'My own'}{s.isDefault ? ' · added to new mail' : ''}</span>
                    </button>
                    <button
                      type="button"
                      onClick={() => set({ signatures: draft.signatures.map((x) => ({ ...x, isDefault: x.id === s.id ? !s.isDefault : false })) })}
                      className="p-1.5 rounded-full hover:bg-black/5"
                      title={s.isDefault ? 'Default — added to new mail' : 'Make default'}
                      aria-label={s.isDefault ? 'Default signature' : 'Make default'}
                    >
                      <Star className={`w-4 h-4 ${s.isDefault ? 'fill-amber-400 text-amber-400' : 'text-slate-400'}`} />
                    </button>
                    <button
                      type="button"
                      onClick={async () => {
                        if (await confirmDialog(`Delete the signature "${s.name}"?`, { confirmLabel: 'Delete' })) set({ signatures: draft.signatures.filter((x) => x.id !== s.id) });
                      }}
                      className="p-1.5 rounded-full text-slate-400 hover:text-rose-600 hover:bg-rose-50"
                      aria-label={`Delete ${s.name}`}
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
            {draft.signatures.length < 20 && (
              <button type="button" onClick={addSignature} className="w-full inline-flex items-center justify-center gap-1.5 text-sm font-semibold px-4 py-2.5 rounded-full bg-white/80 border border-slate-200 hover:bg-white text-slate-700">
                <Plus className="w-4 h-4" /> New signature
              </button>
            )}
          </div>
        ))}

      {tab === 'vacation' && (
        <div className="space-y-3">
          <div className="liquid-glass-inset rounded-[24px] p-4">
            <Toggle
              checked={!!vac.enabled}
              onChange={(v) => set({ vacationResponder: { ...vac, enabled: v } })}
              label="Reply automatically while I'm away"
              hint="Once a day per sender; never to no-reply addresses or mailing systems."
            />
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className={labelCls}>From</label>
              <input type="date" value={vac.startDate || ''} onChange={(e) => set({ vacationResponder: { ...vac, startDate: e.target.value || undefined } })} className={inputCls} />
            </div>
            <div>
              <label className={labelCls}>Until</label>
              <input type="date" value={vac.endDate || ''} min={vac.startDate || undefined} onChange={(e) => set({ vacationResponder: { ...vac, endDate: e.target.value || undefined } })} className={inputCls} />
            </div>
          </div>
          <div>
            <label className={labelCls}>Subject</label>
            <input value={vac.subject || ''} onChange={(e) => set({ vacationResponder: { ...vac, subject: e.target.value } })} placeholder="Out of office" className={inputCls} />
          </div>
          <div>
            <label className={labelCls}>Message</label>
            <textarea
              value={vac.message || ''}
              onChange={(e) => set({ vacationResponder: { ...vac, message: e.target.value } })}
              rows={5}
              placeholder="I'm on leave until … and will reply when I'm back. For anything urgent, please contact …"
              className={inputCls}
            />
          </div>
        </div>
      )}
    </MailPopup>
  );
};
