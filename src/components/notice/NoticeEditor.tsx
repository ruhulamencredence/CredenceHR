/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The notice composer's text box: write like in Word — bold, headings,
// lists, a checklist, colours, links, tables, emoji and pictures (drop,
// paste or pick) — no HTML to know. Built on the browser's own editing
// (contentEditable), so it needs no extra library. What it hands back is
// plain HTML that the server cleans again (NoticeSafety.ts); pictures are
// written as <img src="/api/notices/files/ID">.

import React, { useEffect, useImperativeHandle, useRef, useState, forwardRef } from 'react';
import {
  Bold, Italic, Underline, Strikethrough, Heading2, Heading3, List, ListOrdered, ListChecks, AlignLeft, AlignCenter, AlignRight,
  Palette, Highlighter, Link2, ImagePlus, Table, Smile, Undo2, Redo2, Eraser, Quote, Loader2
} from 'lucide-react';
import { sanitizeNoticeHtml, withLineBreaks } from '../../lib/noticeHtml';
import { noticeFileObjectUrl } from '../../lib/noticeFilesClient';
import type { NoticeFile } from '../../types';

export interface NoticeEditorHandle {
  insertHtml: (html: string) => void;
  focus: () => void;
}

const COLOURS = ['#0f172a', '#7f00ff', '#2563eb', '#059669', '#d97706', '#dc2626', '#db2777', '#64748b'];
const MARKS = ['#fef08a', '#bbf7d0', '#bfdbfe', '#fbcfe8', '#fed7aa', '#e9d5ff'];
const EMOJI = ['🎉', '📢', '📅', '⏰', '✅', '⚠️', '❗', '📌', '💡', '🙏', '👏', '🎂', '🏆', '🛠️', '📄', '📞', '🕌', '🌙', '🇧🇩', '❤️', '😊', '👍', '🔔', '🚗'];

// The editor shows pictures from object URLs; the stored form is the file address.
function toStored(root: HTMLElement): string {
  const clone = root.cloneNode(true) as HTMLElement;
  clone.querySelectorAll('img[data-file-id]').forEach((img) => {
    img.setAttribute('src', `/api/notices/files/${img.getAttribute('data-file-id')}`);
    img.removeAttribute('data-file-id');
    img.classList.remove('nb-selected');
    if (!img.getAttribute('class')) img.removeAttribute('class');
  });
  return clone.innerHTML.trim();
}

function fromStored(html: string): string {
  return withLineBreaks(sanitizeNoticeHtml(html)).replace(/(<img\b[^>]*?)\ssrc="\/api\/notices\/files\/(\d+)"/gi, '$1 data-file-id="$2"');
}

// Word / Google Docs / web paste: keep the formatting, drop their own styling.
function cleanPasted(html: string): string {
  const doc = new DOMParser().parseFromString(sanitizeNoticeHtml(html), 'text/html');
  doc.body.querySelectorAll('*').forEach((el) => {
    el.removeAttribute('class');
    el.removeAttribute('id');
    const st = (el as HTMLElement).style;
    if (st) {
      const keep: [string, string][] = [];
      for (const p of ['color', 'background-color', 'text-align', 'font-weight', 'font-style', 'text-decoration']) {
        const v = st.getPropertyValue(p);
        if (v && !/^(inherit|initial|normal|windowtext|black|rgb\(0, 0, 0\)|transparent)$/i.test(v)) keep.push([p, v]);
      }
      el.removeAttribute('style');
      for (const [p, v] of keep) st.setProperty(p, v);
      if (!el.getAttribute('style')) el.removeAttribute('style');
    }
  });
  doc.body.querySelectorAll('o\\:p, meta, link, style').forEach((el) => el.remove());
  return doc.body.innerHTML;
}

const exec = (cmd: string, value?: string) => {
  try {
    document.execCommand('styleWithCSS', false, cmd === 'foreColor' || cmd === 'hiliteColor' ? 'true' : 'false');
  } catch {
    // older engines
  }
  document.execCommand(cmd, false, value);
};

interface Props {
  value: string;
  resetKey: number;
  onChange: (html: string) => void;
  token: string;
  onUploadImage: (file: File) => Promise<NoticeFile>;
  placeholder?: string;
}

export const NoticeEditor = forwardRef<NoticeEditorHandle, Props>(({ value, resetKey, onChange, token, onUploadImage, placeholder }, ref) => {
  const box = useRef<HTMLDivElement>(null);
  const saved = useRef<Range | null>(null);
  const [pop, setPop] = useState<null | 'colour' | 'mark' | 'link' | 'emoji'>(null);
  const [linkUrl, setLinkUrl] = useState('');
  const [uploading, setUploading] = useState(0);
  const [err, setErr] = useState<string | null>(null);
  const [selImg, setSelImg] = useState<HTMLImageElement | null>(null);
  const fileInput = useRef<HTMLInputElement>(null);

  const emit = () => box.current && onChange(toStored(box.current));

  const hydrateImages = () => {
    box.current?.querySelectorAll<HTMLImageElement>('img[data-file-id]').forEach((img) => {
      if (img.src.startsWith('blob:')) return;
      noticeFileObjectUrl(token, `/api/notices/files/${img.getAttribute('data-file-id')}`)
        .then((s) => (img.src = s))
        .catch(() => {});
    });
  };

  // (Re)loads the content only when asked (opening a notice, a template) —
  // never while typing, which would throw the cursor away.
  useEffect(() => {
    if (!box.current) return;
    box.current.innerHTML = fromStored(value || '');
    hydrateImages();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [resetKey]);

  const keepSelection = () => {
    const s = window.getSelection();
    if (s && s.rangeCount && box.current?.contains(s.anchorNode)) saved.current = s.getRangeAt(0).cloneRange();
  };
  const restoreSelection = () => {
    box.current?.focus();
    const s = window.getSelection();
    if (saved.current && s) {
      s.removeAllRanges();
      s.addRange(saved.current);
    }
  };
  const run = (cmd: string, v?: string) => {
    restoreSelection();
    exec(cmd, v);
    emit();
  };
  const insertHtml = (html: string) => {
    restoreSelection();
    exec('insertHTML', html);
    emit();
    hydrateImages();
  };
  useImperativeHandle(ref, () => ({ insertHtml, focus: () => box.current?.focus() }));

  const addImages = async (files: File[]) => {
    const pics = files.filter((f) => /^image\/(png|jpe?g|webp|gif)$/i.test(f.type));
    if (!pics.length) return;
    setErr(null);
    for (const f of pics) {
      setUploading((n) => n + 1);
      try {
        const up = await onUploadImage(f);
        const local = URL.createObjectURL(f);
        insertHtml(`<img src="${local}" data-file-id="${up.id}" alt="${up.name.replace(/"/g, '')}"><br>`);
      } catch (e: any) {
        setErr(e.message);
      } finally {
        setUploading((n) => n - 1);
      }
    }
  };

  const onPaste = (e: React.ClipboardEvent) => {
    const files = Array.from(e.clipboardData.files || []);
    if (files.some((f) => f.type.startsWith('image/'))) {
      e.preventDefault();
      keepSelection();
      void addImages(files);
      return;
    }
    const html = e.clipboardData.getData('text/html');
    if (html) {
      e.preventDefault();
      exec('insertHTML', cleanPasted(html));
      emit();
    }
  };

  const Btn: React.FC<{ title: string; onClick: () => void; active?: boolean; children: React.ReactNode }> = ({ title, onClick, active, children }) => (
    <button
      type="button"
      title={title}
      aria-label={title}
      onMouseDown={(e) => {
        e.preventDefault();
        keepSelection();
      }}
      onClick={onClick}
      className={`h-8 min-w-8 px-1.5 rounded-lg flex items-center justify-center text-slate-700 hover:bg-violet-100 ${active ? 'bg-violet-100 text-violet-700' : ''}`}
    >
      {children}
    </button>
  );
  const Sep = () => <span className="w-px self-stretch bg-slate-200 mx-0.5" />;

  return (
    <div className="rounded-2xl border border-slate-200 bg-white overflow-visible relative">
      <div className="flex flex-wrap items-center gap-0.5 p-1.5 border-b border-slate-200 bg-slate-50/80 rounded-t-2xl">
        <Btn title="Bold" onClick={() => run('bold')}><Bold className="w-4 h-4" /></Btn>
        <Btn title="Italic" onClick={() => run('italic')}><Italic className="w-4 h-4" /></Btn>
        <Btn title="Underline" onClick={() => run('underline')}><Underline className="w-4 h-4" /></Btn>
        <Btn title="Strikethrough" onClick={() => run('strikeThrough')}><Strikethrough className="w-4 h-4" /></Btn>
        <Sep />
        <Btn title="Heading" onClick={() => run('formatBlock', '<h2>')}><Heading2 className="w-4 h-4" /></Btn>
        <Btn title="Sub-heading" onClick={() => run('formatBlock', '<h3>')}><Heading3 className="w-4 h-4" /></Btn>
        <Btn title="Quote" onClick={() => run('formatBlock', '<blockquote>')}><Quote className="w-4 h-4" /></Btn>
        <Sep />
        <Btn title="Bulleted list" onClick={() => run('insertUnorderedList')}><List className="w-4 h-4" /></Btn>
        <Btn title="Numbered list" onClick={() => run('insertOrderedList')}><ListOrdered className="w-4 h-4" /></Btn>
        <Btn title="Checklist" onClick={() => insertHtml('<ul class="nb-checklist"><li data-checked="false">&#8203;</li></ul>')}><ListChecks className="w-4 h-4" /></Btn>
        <Sep />
        <Btn title="Align left" onClick={() => run('justifyLeft')}><AlignLeft className="w-4 h-4" /></Btn>
        <Btn title="Centre" onClick={() => run('justifyCenter')}><AlignCenter className="w-4 h-4" /></Btn>
        <Btn title="Align right" onClick={() => run('justifyRight')}><AlignRight className="w-4 h-4" /></Btn>
        <Sep />
        <Btn title="Text colour" onClick={() => setPop(pop === 'colour' ? null : 'colour')} active={pop === 'colour'}><Palette className="w-4 h-4" /></Btn>
        <Btn title="Highlight" onClick={() => setPop(pop === 'mark' ? null : 'mark')} active={pop === 'mark'}><Highlighter className="w-4 h-4" /></Btn>
        <Btn title="Link" onClick={() => { setLinkUrl(''); setPop(pop === 'link' ? null : 'link'); }} active={pop === 'link'}><Link2 className="w-4 h-4" /></Btn>
        <Btn title="Picture" onClick={() => fileInput.current?.click()}><ImagePlus className="w-4 h-4" /></Btn>
        <Btn
          title="Table"
          onClick={() =>
            insertHtml(
              '<table><thead><tr><th>Heading</th><th>Heading</th><th>Heading</th></tr></thead><tbody><tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr><tr><td>&nbsp;</td><td>&nbsp;</td><td>&nbsp;</td></tr></tbody></table><p><br></p>'
            )
          }
        >
          <Table className="w-4 h-4" />
        </Btn>
        <Btn title="Emoji" onClick={() => setPop(pop === 'emoji' ? null : 'emoji')} active={pop === 'emoji'}><Smile className="w-4 h-4" /></Btn>
        <Sep />
        <Btn title="Clear formatting" onClick={() => run('removeFormat')}><Eraser className="w-4 h-4" /></Btn>
        <Btn title="Undo" onClick={() => run('undo')}><Undo2 className="w-4 h-4" /></Btn>
        <Btn title="Redo" onClick={() => run('redo')}><Redo2 className="w-4 h-4" /></Btn>
        {uploading > 0 && <Loader2 className="w-4 h-4 text-violet-600 animate-spin ml-1" />}
      </div>

      {pop && (
        <div className="absolute z-20 left-2 top-12 rounded-2xl bg-white shadow-xl border border-slate-200 p-2.5" onMouseDown={(e) => e.target instanceof HTMLInputElement || e.preventDefault()}>
          {pop === 'colour' && (
            <div className="flex gap-1.5">
              {COLOURS.map((c) => (
                <button key={c} type="button" aria-label={`Colour ${c}`} className="w-7 h-7 rounded-full border border-white shadow" style={{ background: c }} onClick={() => { run('foreColor', c); setPop(null); }} />
              ))}
            </div>
          )}
          {pop === 'mark' && (
            <div className="flex gap-1.5">
              {MARKS.map((c) => (
                <button key={c} type="button" aria-label={`Highlight ${c}`} className="w-7 h-7 rounded-lg border border-slate-200" style={{ background: c }} onClick={() => { run('hiliteColor', c); setPop(null); }} />
              ))}
              <button type="button" className="px-2 text-xs text-slate-600" onClick={() => { run('hiliteColor', 'transparent'); setPop(null); }}>None</button>
            </div>
          )}
          {pop === 'emoji' && (
            <div className="grid grid-cols-8 gap-1 w-[272px]">
              {EMOJI.map((e) => (
                <button key={e} type="button" className="w-8 h-8 rounded-lg hover:bg-slate-100 text-lg" onClick={() => { run('insertText', e); setPop(null); }}>{e}</button>
              ))}
            </div>
          )}
          {pop === 'link' && (
            <form
              className="flex items-center gap-2 w-[300px]"
              onSubmit={(e) => {
                e.preventDefault();
                const u = linkUrl.trim();
                if (!/^(https?:\/\/|mailto:|tel:)/i.test(u)) return setErr('A link starts with https://, mailto: or tel:');
                run('createLink', u);
                setPop(null);
              }}
            >
              <input autoFocus value={linkUrl} onChange={(e) => setLinkUrl(e.target.value)} placeholder="https://…" className="flex-1 px-3 py-1.5 rounded-lg border border-slate-200 text-sm" />
              <button type="submit" className="liquid-glass-button rounded-full px-3 py-1.5 text-xs font-semibold">Add</button>
            </form>
          )}
        </div>
      )}

      <div
        ref={box}
        contentEditable
        suppressContentEditableWarning
        data-placeholder={placeholder || 'Write your notice… (Enter for a new line; paste from Word or WhatsApp keeps the formatting)'}
        className="notice-editor notice-content min-h-[220px] max-h-[52vh] overflow-y-auto px-4 py-3"
        onInput={emit}
        onBlur={() => {
          keepSelection();
          emit();
        }}
        onKeyUp={keepSelection}
        onMouseUp={keepSelection}
        onPaste={onPaste}
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          const files = Array.from(e.dataTransfer.files || []);
          if (!files.length) return;
          e.preventDefault();
          keepSelection();
          void addImages(files);
        }}
        onClick={(e) => {
          const t = e.target as HTMLElement;
          box.current?.querySelectorAll('img.nb-selected').forEach((i) => i.classList.remove('nb-selected'));
          if (t.tagName === 'IMG') {
            t.classList.add('nb-selected');
            setSelImg(t as HTMLImageElement);
          } else setSelImg(null);
          // A checklist line: tapping its box ticks it.
          const li = t.closest('ul.nb-checklist > li') as HTMLElement | null;
          if (li && e.nativeEvent.offsetX < 22) {
            li.setAttribute('data-checked', li.getAttribute('data-checked') === 'true' ? 'false' : 'true');
            emit();
          }
        }}
      />

      {selImg && (
        <div className="flex items-center gap-1.5 px-3 py-2 border-t border-slate-200 text-xs text-slate-600 bg-violet-50/60 rounded-b-2xl">
          Picture size:
          {[['Small', '33%'], ['Medium', '60%'], ['Full width', '100%']].map(([l, w]) => (
            <button key={l} type="button" className="px-2.5 py-1 rounded-full bg-white border border-slate-200 font-semibold" onClick={() => { selImg.style.width = w; emit(); }}>
              {l}
            </button>
          ))}
          <button type="button" className="ml-auto px-2.5 py-1 rounded-full bg-white border border-rose-200 text-rose-600 font-semibold" onClick={() => { selImg.remove(); setSelImg(null); emit(); }}>
            Remove picture
          </button>
        </div>
      )}
      {err && <p className="px-3 pb-2 text-[11px] text-rose-600">{err}</p>}
      <input
        ref={fileInput}
        type="file"
        accept="image/png,image/jpeg,image/webp,image/gif"
        multiple
        className="hidden"
        onChange={(e) => {
          const files = Array.from(e.target.files || []);
          e.target.value = '';
          void addImages(files);
        }}
      />
    </div>
  );
});
NoticeEditor.displayName = 'NoticeEditor';
