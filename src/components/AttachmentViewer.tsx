/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// An attachment (a bill claim's receipt, a request's file) shown right here
// in a liquid-glass popup instead of a new browser tab — a new tab does
// nothing inside the Android / iPhone app and phone browsers often block it.
// A picture is shown as is (pinch / tap to enlarge), a PDF page by page
// (pdf.js, works in the app too), anything else offers Download. Download
// uses the Share sheet on the apps (saveBlobCrossPlatform).

import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, FileText, Loader2, Paperclip, X, ZoomIn, ZoomOut } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { loadPdfjs } from '../lib/pdfjs';
import { saveBlobCrossPlatform } from '../lib/saveFile';
import { useBackButtonClose } from '../lib/useBackButtonClose';

const kindOf = (type: string, name: string): 'image' | 'pdf' | 'other' => {
  const t = type.toLowerCase();
  const n = name.toLowerCase();
  if (t.startsWith('image/') || /\.(jpe?g|png|gif|webp|bmp|heic|heif)$/.test(n)) return 'image';
  if (t.includes('pdf') || n.endsWith('.pdf')) return 'pdf';
  return 'other';
};

export const AttachmentViewer: React.FC<{
  token: string;
  // An API path such as /api/bill-claims/12/file (sent with the sign-in).
  src: string;
  name?: string | null;
  // Instead of fetching `src`: the file from somewhere else (Credence Mail's
  // attachments come through mailApi.fetchAttachment). `type` is its MIME type.
  load?: () => Promise<Blob>;
  type?: string | null;
  // Several files to page through (e.g. one mail's attachments): "2 / 3" and
  // ‹ › in the header, ← → keys. The parent shows the next one.
  nav?: { index: number; count: number; onPrev: () => void; onNext: () => void };
  onClose: () => void;
}> = ({ token, src, name, load, type, nav, onClose }) => {
  const [blob, setBlob] = useState<Blob | null>(null);
  const [kind, setKind] = useState<'image' | 'pdf' | 'other' | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [pages, setPages] = useState(0);
  const [zoom, setZoom] = useState(false);
  const [fileName, setFileName] = useState(name || 'Attachment');
  const pagesRef = useRef<HTMLDivElement>(null);
  const boxRef = useRef<HTMLDivElement>(null);
  useBackButtonClose(true, onClose);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (nav && e.key === 'ArrowLeft' && nav.index > 0) nav.onPrev();
      else if (nav && e.key === 'ArrowRight' && nav.index < nav.count - 1) nav.onNext();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose, nav]);

  useEffect(() => {
    let cancelled = false;
    let made: string | null = null;
    (async () => {
      try {
        let b: Blob;
        let shownName: string;
        let contentType: string;
        if (load) {
          b = await load();
          shownName = name || 'Attachment';
          contentType = type || b.type || '';
        } else {
          const res = await fetch(apiUrl(src), { headers: { Authorization: `Bearer ${token}` } });
          if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || 'Could not open the attachment.');
          const disp = res.headers.get('content-disposition') || '';
          const fromHeader = /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disp)?.[1];
          shownName = name || (fromHeader ? decodeURIComponent(fromHeader) : 'Attachment');
          b = await res.blob();
          contentType = res.headers.get('content-type') || b.type || '';
        }
        if (cancelled) return;
        const k = kindOf(contentType, shownName);
        setFileName(shownName);
        setBlob(b);
        setKind(k);
        if (k === 'image') {
          made = URL.createObjectURL(b);
          setImgUrl(made);
        } else if (k === 'pdf') {
          const pdfjsLib = await loadPdfjs();
          const pdf = await pdfjsLib.getDocument({ data: new Uint8Array(await b.arrayBuffer()) }).promise;
          if (cancelled) return;
          setPages(pdf.numPages);
          const width = Math.min(860, (boxRef.current?.clientWidth || 600) - 24);
          for (let n = 1; n <= pdf.numPages && !cancelled; n++) {
            const page = await pdf.getPage(n);
            const base = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: (width / base.width) * (window.devicePixelRatio || 1) });
            const canvas = document.createElement('canvas');
            canvas.width = vp.width;
            canvas.height = vp.height;
            canvas.style.width = '100%';
            canvas.className = 'block bg-white rounded-xl shadow-sm mb-3';
            canvas.setAttribute('aria-label', `Page ${n}`);
            await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, canvas } as any).promise;
            if (!cancelled) pagesRef.current?.appendChild(canvas);
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e?.message || 'Could not open the attachment.');
      }
    })();
    return () => {
      cancelled = true;
      if (made) URL.revokeObjectURL(made);
    };
  }, [token, src, name]);

  return createPortal(
    <div className="liquid-glass-backdrop fixed inset-0 z-[1400] flex items-center justify-center p-3 sm:p-6" onClick={onClose}>
      <div className="w-full max-w-4xl max-h-[94dvh] flex" onClick={(e) => e.stopPropagation()}>
        <div role="dialog" aria-modal="true" aria-label={fileName} className="liquid-glass liquid-glass-in rounded-[32px] w-full flex flex-col overflow-hidden">
          <div className="flex items-center gap-2.5 px-4 sm:px-5 py-3">
            <span className="liquid-glass-inset w-9 h-9 rounded-xl flex items-center justify-center shrink-0">
              {kind === 'pdf' ? <FileText className="w-4 h-4 text-slate-600" /> : <Paperclip className="w-4 h-4 text-slate-600" />}
            </span>
            <div className="min-w-0 flex-1">
              <div className="text-sm font-bold text-slate-900 truncate">{fileName}</div>
              {kind === 'pdf' && pages > 0 && <div className="text-[11px] text-slate-500">{pages} page{pages === 1 ? '' : 's'}</div>}
            </div>
            {nav && nav.count > 1 && (
              <div className="flex items-center gap-1 shrink-0">
                <button type="button" onClick={nav.onPrev} disabled={nav.index === 0} aria-label="Previous file" className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600 disabled:opacity-35">
                  <ChevronLeft className="w-4 h-4" />
                </button>
                <span data-testid="attachment-viewer-count" className="text-xs font-semibold text-slate-600 tabular-nums px-0.5">
                  {nav.index + 1} / {nav.count}
                </span>
                <button type="button" onClick={nav.onNext} disabled={nav.index >= nav.count - 1} aria-label="Next file" className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600 disabled:opacity-35">
                  <ChevronRight className="w-4 h-4" />
                </button>
              </div>
            )}
            {kind === 'image' && (
              <button
                type="button"
                onClick={() => setZoom((z) => !z)}
                aria-label={zoom ? 'Fit to screen' : 'Enlarge'}
                className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600 shrink-0"
              >
                {zoom ? <ZoomOut className="w-4 h-4" /> : <ZoomIn className="w-4 h-4" />}
              </button>
            )}
            <button
              type="button"
              disabled={!blob}
              onClick={() => blob && void saveBlobCrossPlatform(blob, fileName)}
              aria-label="Download"
              className="liquid-glass-chip h-9 px-3 rounded-full flex items-center gap-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50 shrink-0"
            >
              <Download className="w-3.5 h-3.5" /> <span className="hidden sm:inline">Download</span>
            </button>
            <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip w-9 h-9 rounded-full flex items-center justify-center text-slate-600 shrink-0">
              <X className="w-4 h-4" />
            </button>
          </div>
          <div ref={boxRef} className="liquid-glass-inset mx-3 mb-3 sm:mx-4 sm:mb-4 rounded-2xl overflow-auto min-h-[200px] flex-1">
            {error ? (
              <div className="h-full min-h-[200px] flex items-center justify-center text-sm text-rose-600 p-6 text-center">{error}</div>
            ) : !kind ? (
              <div className="h-full min-h-[240px] flex items-center justify-center text-slate-500 text-sm gap-2">
                <Loader2 className="w-4 h-4 animate-spin" /> Opening…
              </div>
            ) : kind === 'image' && imgUrl ? (
              <div className={zoom ? 'p-2' : 'p-2 h-full flex items-center justify-center'}>
                <img
                  src={imgUrl}
                  alt={fileName}
                  onClick={() => setZoom((z) => !z)}
                  className={zoom ? 'max-w-none w-[200%] sm:w-auto cursor-zoom-out' : 'max-w-full max-h-[78dvh] object-contain mx-auto cursor-zoom-in rounded-xl'}
                />
              </div>
            ) : kind === 'pdf' ? (
              <div className="p-3">
                {pages === 0 && (
                  <div className="min-h-[240px] flex items-center justify-center text-slate-500 text-sm gap-2">
                    <Loader2 className="w-4 h-4 animate-spin" /> Opening…
                  </div>
                )}
                <div ref={pagesRef} />
              </div>
            ) : (
              <div className="min-h-[240px] flex flex-col items-center justify-center gap-3 p-6 text-center">
                <Paperclip className="w-6 h-6 text-slate-400" />
                <p className="text-sm text-slate-600">This file can't be shown here. Download it to open it.</p>
                <button type="button" onClick={() => blob && void saveBlobCrossPlatform(blob, fileName)} className="liquid-glass-button rounded-full px-4 py-2 text-sm font-semibold flex items-center gap-1.5">
                  <Download className="w-4 h-4" /> Download
                </button>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body
  );
};
