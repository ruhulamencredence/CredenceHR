/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The in-app reader for a document someone is asked to sign (ESignRoutes.ts):
// a PDF drawn page by page with pdf.js (works in the Android app too), or the
// image. Reaching the end tells the server "read to the end" with the time
// spent — needed to sign when E-Signature settings ask for it.

import React, { useEffect, useRef, useState } from 'react';
import { BookOpenCheck, CheckCircle2, Loader2 } from 'lucide-react';
import * as pdfjsLib from 'pdfjs-dist';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { apiUrl } from '../lib/api';
import { esignFetch } from '../lib/esign';
import { MailPopup as Popup } from './mail/MailPopup';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

export const DocReader: React.FC<{ token: string; docId: number; title: string; alreadyRead?: boolean; onClose: () => void; onRead: () => void }> = ({ token, docId, title, alreadyRead, onClose, onRead }) => {
  const box = useRef<HTMLDivElement>(null);
  const pagesRef = useRef<HTMLDivElement>(null);
  const started = useRef(Date.now());
  const sent = useRef(!!alreadyRead);
  const [pages, setPages] = useState(0);
  const [image, setImage] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [done, setDone] = useState(!!alreadyRead);

  useEffect(() => {
    let cancelled = false;
    let url: string | null = null;
    (async () => {
      try {
        const res = await fetch(apiUrl(`/api/employee-documents/${docId}/file`), { headers: { Authorization: `Bearer ${token}` } });
        if (!res.ok) throw new Error((await res.json().catch(() => null))?.error || `Request failed (${res.status})`);
        const type = res.headers.get('content-type') || '';
        const bytes = new Uint8Array(await res.arrayBuffer());
        if (/^image\//.test(type)) {
          url = URL.createObjectURL(new Blob([bytes], { type }));
          if (!cancelled) setImage(url);
        } else {
          const pdf = await pdfjsLib.getDocument({ data: bytes }).promise;
          if (cancelled) return;
          setPages(pdf.numPages);
          const width = Math.min(820, (box.current?.clientWidth || 600) - 16);
          for (let n = 1; n <= pdf.numPages && !cancelled; n++) {
            const page = await pdf.getPage(n);
            const base = page.getViewport({ scale: 1 });
            const vp = page.getViewport({ scale: (width / base.width) * (window.devicePixelRatio || 1) });
            const canvas = document.createElement('canvas');
            canvas.width = vp.width;
            canvas.height = vp.height;
            canvas.style.width = '100%';
            canvas.className = 'block bg-white rounded-lg shadow-sm mb-3';
            canvas.setAttribute('aria-label', `Page ${n}`);
            await page.render({ canvasContext: canvas.getContext('2d')!, viewport: vp, canvas } as any).promise;
            if (!cancelled) pagesRef.current?.appendChild(canvas);
          }
        }
      } catch (e: any) {
        if (!cancelled) setError(e.message || "The document couldn't be opened.");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      if (url) URL.revokeObjectURL(url);
    };
  }, [token, docId]);

  const reachedEnd = () => {
    if (sent.current || loading) return;
    sent.current = true;
    setDone(true);
    void esignFetch(token, `/api/esign/documents/${docId}/read`, { method: 'POST', body: { seconds: Math.round((Date.now() - started.current) / 1000), pages } })
      .then(onRead)
      .catch((e) => {
        sent.current = false;
        setDone(false);
        setError(e.message);
      });
  };
  const onScroll = () => {
    const el = box.current;
    if (el && el.scrollTop + el.clientHeight >= el.scrollHeight - 24) reachedEnd();
  };
  // A one-page document that already fits: reaching the end is seeing it.
  useEffect(() => {
    if (!loading) setTimeout(onScroll, 300);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  return (
    <Popup
      title={title}
      icon={<BookOpenCheck className="w-4 h-4 text-blue-600" />}
      size="xl"
      onClose={onClose}
      head={
        <div className="px-5 pb-2 text-[11px] font-semibold">
          {done ? (
            <span className="inline-flex items-center gap-1 text-emerald-700">
              <CheckCircle2 className="w-3.5 h-3.5" /> Read to the end
            </span>
          ) : (
            <span className="text-slate-500">Scroll to the end of the document{pages > 1 ? ` (${pages} pages)` : ''}.</span>
          )}
        </div>
      }
    >
      <div ref={box} onScroll={onScroll} className="liquid-glass-inset rounded-2xl p-2 max-h-[65vh] overflow-y-auto">
        {loading && (
          <div className="py-16 flex justify-center">
            <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
          </div>
        )}
        {image && <img src={image} alt={title} className="w-full rounded-lg bg-white" onLoad={() => setTimeout(onScroll, 200)} />}
        <div ref={pagesRef} />
        {!loading && !error && <div className="text-center text-[11px] text-slate-400 py-3">— End of document —</div>}
        {error && <div className="text-xs px-3 py-2 rounded-xl bg-rose-50 text-rose-700">{error}</div>}
      </div>
    </Popup>
  );
};
