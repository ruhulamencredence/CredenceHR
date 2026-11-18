/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Credence Mail -> My folders (part of Mail, MailRoutes.ts):
// the person's own folders and sub-folders, real folders on their mail server
// (Outlook / the phone's mail app show the same ones). A mail in one carries
// the label "Folder:<id>"; the list opens it like any other folder.
//   - FolderTree: the sidebar part — open / close, counts, "+ New folder",
//     each folder's "⋯" (New sub-folder · Rename · Delete), mail dropped on it.
//   - FolderFormPopup: name a new folder (and where it goes) or rename one.
//   - MoveToFolderPopup: "Move to folder" for the selected / opened mail.

import React, { useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronDown, ChevronRight, Folder, FolderOpen, FolderPlus, Loader2, MoreHorizontal, Pencil, Trash2, Inbox, Send, FileText, ShieldAlert } from 'lucide-react';
import { MailAccount, MailFolder } from '../../lib/mailApi';
import { MailPopup as Popup, inputCls, labelCls, primaryBtn, ghostBtn, stickySearchCls } from './MailPopup';

export const folderLabel = (id: number) => `Folder:${id}`;
export const folderIdOfLabel = (label: string): number | null => {
  const m = /^Folder:(\d+)$/.exec(label);
  return m ? Number(m[1]) : null;
};
export const isFolderLabel = (l: string) => /^Folder:\d+$/.test(l);
// "Projects / Gulshan Tower"
export const folderPath = (folders: MailFolder[], id: number): string => {
  const f = folders.find((x) => x.id === id);
  if (!f) return '';
  const own = f.systemRole ? SYSTEM[f.systemRole]?.title || f.name : f.name;
  return f.parentId ? `${folderPath(folders, f.parentId)} / ${own}` : own;
};
const kidsOf = (folders: MailFolder[], parentId: number | null, accountId: number) =>
  folders.filter((f) => f.parentId === parentId && f.accountId === accountId).sort((a, b) => a.name.localeCompare(b.name));
// Every folder in tree order with its depth (for pickers).
export const flatTree = (folders: MailFolder[], accountId: number, skip?: number): { f: MailFolder; depth: number }[] => {
  const walk = (p: number | null, d: number): { f: MailFolder; depth: number }[] =>
    kidsOf(folders, p, accountId).filter((f) => f.id !== skip).flatMap((f) => [{ f, depth: d }, ...walk(f.id, d + 1)]);
  return walk(null, 0);
};

export const MAIL_DRAG_TYPE = 'application/x-credence-mail-ids';

// Sent / Trash / Spam / Drafts as headings of folders inside them: their own title, icon and list.
const SYSTEM: Record<string, { label: string; title: string; Icon: React.ComponentType<{ className?: string }> }> = {
  sent: { label: 'Sent', title: 'Sent', Icon: Send },
  trash: { label: 'Trash', title: 'Trash', Icon: Trash2 },
  junk: { label: 'Spam', title: 'Spam', Icon: ShieldAlert },
  drafts: { label: 'Drafts', title: 'Drafts', Icon: FileText }
};
export const folderTitle = (f: MailFolder) => (f.systemRole && SYSTEM[f.systemRole]?.title) || f.name;
// A folder inside Sent holds sent mail: the list shows who it went to.
export const isUnderSent = (folders: MailFolder[], id: number | null): boolean => {
  let f = folders.find((x) => x.id === id);
  while (f) {
    if (f.systemRole === 'sent') return true;
    f = f.parentId ? folders.find((x) => x.id === f!.parentId) : undefined;
  }
  return false;
};

export const FolderTree: React.FC<{
  folders: MailFolder[];
  accounts: MailAccount[];
  current: string;
  loading: boolean;
  readOnly?: boolean;
  onOpen: (label: string) => void;
  onNew: (accountId: number, parentId: number | null) => void;
  onRename: (f: MailFolder) => void;
  onDelete: (f: MailFolder) => void;
  onDropMail: (folder: MailFolder, ids: string[]) => void;
}> = ({ folders, accounts, current, loading, readOnly, onOpen, onNew, onRename, onDelete, onDropMail }) => {
  // Closed by default except the branch holding the open folder.
  const [open, setOpen] = useState<Set<number>>(() => new Set());
  // The open "⋯" menu and where to draw it (a portal: the glass sidebar would clip / trap it).
  const [menu, setMenu] = useState<number | null>(null);
  const [menuAt, setMenuAt] = useState<{ top: number; left: number }>({ top: 0, left: 0 });
  const [over, setOver] = useState<number | null>(null);
  const currentId = folderIdOfLabel(current);
  const openIds = useMemo(() => {
    const s = new Set(open);
    let f = folders.find((x) => x.id === currentId);
    while (f?.parentId) {
      s.add(f.parentId);
      f = folders.find((x) => x.id === f!.parentId);
    }
    return s;
  }, [open, folders, currentId]);
  const many = accounts.length > 1;

  const row = (f: MailFolder, depth: number): React.ReactNode => {
    const kids = kidsOf(folders, f.id, f.accountId);
    const isOpen = openIds.has(f.id);
    const sys = f.systemRole ? SYSTEM[f.systemRole] : null;
    const active = currentId === f.id || (!!sys && current === sys.label);
    return (
      <div key={f.id}>
        <div
          data-folder-id={f.id}
          onDragOver={(e) => {
            if (!f.selectable || readOnly || !e.dataTransfer.types.includes(MAIL_DRAG_TYPE)) return;
            e.preventDefault();
            setOver(f.id);
          }}
          onDragLeave={() => setOver((x) => (x === f.id ? null : x))}
          onDrop={(e) => {
            setOver(null);
            const raw = e.dataTransfer.getData(MAIL_DRAG_TYPE);
            if (!raw || !f.selectable) return;
            e.preventDefault();
            try {
              onDropMail(f, JSON.parse(raw));
            } catch {
              // not ours
            }
          }}
          className={`group relative flex items-start gap-1.5 pr-1 rounded-xl text-sm ${active ? 'bg-sky-100/80 text-sky-800 font-semibold' : 'text-slate-700 hover:bg-black/5'} ${over === f.id ? 'ring-2 ring-sky-500 bg-sky-50' : ''}`}
          style={{ paddingLeft: 8 + depth * 12 }}
        >
          <button
            type="button"
            aria-label={kids.length ? (isOpen ? `Close ${f.name}` : `Open ${f.name}`) : undefined}
            tabIndex={kids.length ? 0 : -1}
            onClick={() => kids.length && setOpen((s) => { const n = new Set(s); isOpen ? n.delete(f.id) : n.add(f.id); return n; })}
            className={`w-4 h-8 flex items-center justify-center shrink-0 ${kids.length ? 'text-slate-500' : 'invisible'}`}
          >
            {isOpen ? <ChevronDown className="w-3.5 h-3.5" /> : <ChevronRight className="w-3.5 h-3.5" />}
          </button>
          <button
            type="button"
            onClick={() =>
              sys ? onOpen(sys.label) : f.selectable ? onOpen(folderLabel(f.id)) : setOpen((s) => { const n = new Set(s); isOpen ? n.delete(f.id) : n.add(f.id); return n; })
            }
            className="flex-1 min-w-0 flex items-start gap-2 py-1.5 text-left"
            title={folderPath(folders, f.id)}
          >
            {sys ? <sys.Icon className="w-4 h-4 shrink-0 mt-px" /> : active ? <FolderOpen className="w-4 h-4 shrink-0 mt-px" /> : <Folder className="w-4 h-4 shrink-0 mt-px" />}
            {/* Long names ("Daily & Market Labor Actual Report") wrap rather than being cut. */}
            <span className="flex-1 min-w-0 break-words leading-snug">{folderTitle(f)}</span>
            {f.unread > 0 && <span className={`text-[11px] font-semibold ${active ? 'text-sky-800' : 'text-slate-500'}`}>{f.unread}</span>}
          </button>
          {!readOnly && (
            <button
              type="button"
              aria-label={`More for ${f.name}`}
              aria-expanded={menu === f.id}
              onClick={(e) => {
                const r = e.currentTarget.getBoundingClientRect();
                setMenuAt({ top: r.bottom + 4, left: Math.max(8, Math.min(r.right - 192, window.innerWidth - 200)) });
                setMenu((m) => (m === f.id ? null : f.id));
              }}
              className={`mt-1 p-1 rounded-lg hover:bg-black/10 shrink-0 ${menu === f.id ? '' : 'opacity-0 group-hover:opacity-100 focus:opacity-100'} [@media(hover:none)]:opacity-100`}
            >
              <MoreHorizontal className="w-3.5 h-3.5" />
            </button>
          )}
          {menu === f.id && createPortal(
            <>
              <div className="fixed inset-0 z-[95]" onClick={() => setMenu(null)} />
              <div className="fixed z-[96] w-48" style={{ top: menuAt.top, left: menuAt.left }} role="menu" aria-label={`${f.name} menu`}>
              <div className="liquid-glass liquid-glass-in rounded-2xl p-1.5 text-sm font-normal text-slate-700 shadow-lg">
                <button type="button" className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-black/5" onClick={() => { setMenu(null); onNew(f.accountId, f.id); }}>
                  <FolderPlus className="w-4 h-4" /> New sub-folder
                </button>
                {/* Sent / Trash / Spam / Drafts themselves: only folders inside them. */}
                {!sys && (
                  <>
                    <button type="button" className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-black/5" onClick={() => { setMenu(null); onRename(f); }}>
                      <Pencil className="w-4 h-4" /> Rename
                    </button>
                    <button type="button" className="w-full flex items-center gap-2 px-2.5 py-1.5 rounded-xl hover:bg-rose-50 text-rose-600" onClick={() => { setMenu(null); onDelete(f); }}>
                      <Trash2 className="w-4 h-4" /> Delete
                    </button>
                  </>
                )}
              </div>
              </div>
            </>,
            document.body
          )}
        </div>
        {kids.length > 0 && isOpen && kids.map((k) => row(k, depth + 1))}
      </div>
    );
  };

  return (
    <div className="pt-3" aria-label="My folders">
      <div className="flex items-center justify-between pb-1 px-3">
        <span className="text-[10px] font-semibold uppercase tracking-wider text-slate-400 inline-flex items-center gap-1">
          Folders {loading && <Loader2 className="w-3 h-3 animate-spin" />}
        </span>
        {!readOnly && (
          <button type="button" onClick={() => onNew(accounts[0]?.id, null)} className="text-[11px] font-semibold text-sky-700 hover:underline inline-flex items-center gap-1">
            <FolderPlus className="w-3.5 h-3.5" /> New folder
          </button>
        )}
      </div>
      {accounts.map((a) => {
        const top = kidsOf(folders, null, a.id);
        return (
          <div key={a.id}>
            {many && <div className="px-3 pt-1 text-[10px] text-slate-400 truncate">{a.emailAddress}</div>}
            {top.map((f) => row(f, 0))}
            {!top.length && !many && !loading && <p className="px-3 py-1 text-[11px] text-slate-400">No folders yet.</p>}
          </div>
        );
      })}
    </div>
  );
};

// New folder (in a mailbox, at the top or inside a folder) or Rename.
export const FolderFormPopup: React.FC<{
  folders: MailFolder[];
  accounts: MailAccount[];
  mode: { kind: 'new'; accountId: number; parentId: number | null } | { kind: 'rename'; folder: MailFolder };
  onClose: () => void;
  onSave: (v: { accountId: number; parentId: number | null; name: string }) => Promise<void>;
}> = ({ folders, accounts, mode, onClose, onSave }) => {
  const renaming = mode.kind === 'rename';
  const [accountId, setAccountId] = useState(renaming ? mode.folder.accountId : mode.accountId);
  const [parentId, setParentId] = useState<number | null>(renaming ? mode.folder.parentId : mode.parentId);
  const [name, setName] = useState(renaming ? mode.folder.name : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    if (!name.trim()) return setError('Give the folder a name.');
    setBusy(true);
    try {
      await onSave({ accountId, parentId, name: name.trim() });
    } catch (e: any) {
      setError(e.message);
      setBusy(false);
    }
  };
  return (
    <Popup
      title={renaming ? 'Rename folder' : 'New folder'}
      icon={<FolderPlus className="w-4 h-4 text-sky-600" />}
      onClose={onClose}
      size="md"
      footer={
        <>
          <button type="button" className={ghostBtn} onClick={onClose}>Cancel</button>
          <button type="button" className={primaryBtn} disabled={busy} onClick={() => void save()}>
            {busy && <Loader2 className="w-4 h-4 animate-spin" />} {renaming ? 'Save' : 'Create'}
          </button>
        </>
      }
    >
      <div className="space-y-3">
        {!renaming && accounts.length > 1 && (
          <div>
            <label className={labelCls} htmlFor="mf-account">Mailbox</label>
            <select id="mf-account" className={inputCls} value={accountId} onChange={(e) => { setAccountId(Number(e.target.value)); setParentId(null); }}>
              {accounts.map((a) => <option key={a.id} value={a.id}>{a.emailAddress}</option>)}
            </select>
          </div>
        )}
        <div>
          <label className={labelCls} htmlFor="mf-name">Name</label>
          <input
            id="mf-name"
            className={inputCls}
            value={name}
            maxLength={60}
            autoFocus
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && void save()}
            placeholder="e.g. Gulshan Tower"
          />
        </div>
        {!renaming && (
          <div>
            <label className={labelCls} htmlFor="mf-parent">Inside</label>
            <select id="mf-parent" className={inputCls} value={parentId ?? ''} onChange={(e) => setParentId(e.target.value ? Number(e.target.value) : null)}>
              <option value="">— Top level —</option>
              {flatTree(folders, accountId).map(({ f, depth }) => (
                <option key={f.id} value={f.id}>{`${'  '.repeat(depth)}${depth ? '└ ' : ''}${folderTitle(f)}`}</option>
              ))}
            </select>
          </div>
        )}
        <p className="text-[11px] text-slate-500">
          {renaming ? 'The folders inside it keep their mail.' : 'Made on your mail server — Outlook and your phone’s mail app show it too.'}
        </p>
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};

// Move to folder: the folders of that mail's mailbox, Inbox, or a new folder.
export const MoveToFolderPopup: React.FC<{
  folders: MailFolder[];
  accountId: number;
  count: number;
  current: string;
  onClose: () => void;
  onPick: (label: string) => void;
  onNewFolder: () => void;
}> = ({ folders, accountId, count, current, onClose, onPick, onNewFolder }) => {
  const [q, setQ] = useState('');
  const rows = flatTree(folders, accountId).filter(({ f }) => !q.trim() || folderPath(folders, f.id).toLowerCase().includes(q.trim().toLowerCase()));
  return (
    <Popup title={`Move ${count} mail${count === 1 ? '' : 's'} to…`} icon={<Folder className="w-4 h-4 text-sky-600" />} onClose={onClose} size="md">
      <div className="space-y-2">
        <div className={stickySearchCls}>
          <input className={inputCls} value={q} onChange={(e) => setQ(e.target.value)} placeholder="Find a folder" autoFocus aria-label="Find a folder" />
        </div>
        <div className="liquid-glass-inset rounded-2xl p-1.5">
          {current !== 'Inbox' && !q && (
            <button type="button" onClick={() => onPick('Inbox')} className="w-full flex items-center gap-2 px-3 py-2 rounded-xl text-sm text-slate-700 hover:bg-black/5">
              <Inbox className="w-4 h-4" /> Inbox
            </button>
          )}
          {rows.map(({ f, depth }) => (
            <button
              key={f.id}
              type="button"
              disabled={!f.selectable || current === folderLabel(f.id)}
              onClick={() => onPick(folderLabel(f.id))}
              className="w-full flex items-center gap-2 py-2 pr-3 rounded-xl text-sm text-slate-700 hover:bg-black/5 disabled:opacity-40 disabled:hover:bg-transparent"
              style={{ paddingLeft: 12 + depth * 16 }}
            >
              <Folder className="w-4 h-4 shrink-0" /> <span className="truncate">{folderTitle(f)}</span>
              {current === folderLabel(f.id) && <span className="ml-auto text-[10px] text-slate-400">here now</span>}
            </button>
          ))}
          {!rows.length && <p className="px-3 py-3 text-xs text-slate-500">{q ? 'No folder with that name.' : 'No folders yet.'}</p>}
        </div>
        <button type="button" onClick={onNewFolder} className="text-xs font-semibold text-sky-700 hover:underline inline-flex items-center gap-1">
          <FolderPlus className="w-3.5 h-3.5" /> New folder…
        </button>
      </div>
    </Popup>
  );
};
