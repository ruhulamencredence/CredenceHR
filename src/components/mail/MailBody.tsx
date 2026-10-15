/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// One mail's HTML, made safe: DOMPurify removes scripts, forms, frames and
// event handlers; it is then shown in a sandboxed iframe (no scripts at all,
// and the mail's own styles can't touch the app). Pictures from the internet
// stay off until "Show pictures" — they tell the sender the mail was opened.

import React, { useEffect, useMemo, useRef, useState } from 'react';
import DOMPurify from 'dompurify';
import { ImageOff } from 'lucide-react';

const REMOTE = /^\s*(https?:)?\/\//i;
const CSS_REMOTE_URL = /url\(\s*(['"]?)\s*(https?:)?\/\/[^)]*\)/gi;

export function sanitizeMailHtml(html: string, showImages: boolean): { html: string; blocked: number } {
  let blocked = 0;
  const hook = (node: Element) => {
    if (node.tagName === 'A') {
      node.setAttribute('target', '_blank');
      node.setAttribute('rel', 'noopener noreferrer');
    }
    if (showImages) return;
    if (node.tagName === 'IMG') {
      const src = node.getAttribute('src') || '';
      if (REMOTE.test(src)) {
        node.removeAttribute('src');
        node.removeAttribute('srcset');
        node.setAttribute('alt', node.getAttribute('alt') || '');
        blocked++;
      }
    }
    if (node.hasAttribute('background') && REMOTE.test(node.getAttribute('background') || '')) {
      node.removeAttribute('background');
      blocked++;
    }
    const style = node.getAttribute('style');
    if (style && CSS_REMOTE_URL.test(style)) {
      node.setAttribute('style', style.replace(CSS_REMOTE_URL, 'none'));
      blocked++;
    }
    CSS_REMOTE_URL.lastIndex = 0;
  };
  DOMPurify.addHook('afterSanitizeAttributes', hook);
  let clean: string;
  try {
    clean = DOMPurify.sanitize(html || '', {
      FORBID_TAGS: ['script', 'iframe', 'frame', 'frameset', 'object', 'embed', 'form', 'input', 'button', 'textarea', 'select', 'meta', 'link', 'base', 'svg', 'math'],
      FORBID_ATTR: ['srcdoc', 'formaction', 'action'],
      ADD_TAGS: ['style'],
      ADD_ATTR: ['target'],
      FORCE_BODY: true,
      WHOLE_DOCUMENT: false
    }) as unknown as string;
  } finally {
    DOMPurify.removeHook('afterSanitizeAttributes');
  }
  if (!showImages) {
    // <style> blocks can load pictures too.
    clean = clean.replace(/<style[\s\S]*?<\/style>/gi, (block) => {
      const out = block.replace(CSS_REMOTE_URL, 'none');
      if (out !== block) blocked++;
      return out;
    });
  }
  return { html: clean, blocked };
}

const FRAME_CSS = `
  html, body { margin: 0; padding: 0; background: transparent; }
  body { font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Noto Sans Bengali", sans-serif; font-size: 14px; line-height: 1.55; color: #1e293b; overflow-wrap: anywhere; word-break: break-word; }
  img { max-width: 100%; height: auto; }
  table { max-width: 100%; }
  pre { white-space: pre-wrap; font-family: inherit; margin: 0; }
  blockquote { margin: 0 0 0 .6em; padding-left: .8em; border-left: 3px solid #cbd5e1; color: #475569; }
  a { color: #2563eb; }
`;

export const MailBody: React.FC<{ html: string; className?: string }> = ({ html, className }) => {
  const [showImages, setShowImages] = useState(false);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [height, setHeight] = useState(60);
  const { html: clean, blocked } = useMemo(() => sanitizeMailHtml(html, showImages), [html, showImages]);
  const srcDoc = useMemo(
    () => `<!doctype html><html><head><meta charset="utf-8"><base target="_blank"><style>${FRAME_CSS}</style></head><body>${clean}</body></html>`,
    [clean]
  );

  useEffect(() => setShowImages(false), [html]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    let ro: ResizeObserver | null = null;
    const measure = () => {
      const doc = frame.contentDocument;
      if (!doc?.body) return;
      // The body's own height — the document's is never less than the frame.
      setHeight(Math.max(40, Math.ceil(Math.max(doc.body.scrollHeight, doc.body.getBoundingClientRect().height)) + 4));
    };
    const onLoad = () => {
      measure();
      const doc = frame.contentDocument;
      if (doc?.body && typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(measure);
        ro.observe(doc.body);
      }
      // Pictures arriving later change the height.
      doc?.querySelectorAll('img').forEach((img) => img.addEventListener('load', measure));
    };
    frame.addEventListener('load', onLoad);
    return () => {
      frame.removeEventListener('load', onLoad);
      ro?.disconnect();
    };
  }, [srcDoc]);

  return (
    <div className={className}>
      {blocked > 0 && !showImages && (
        <div className="mb-3 flex items-center justify-between gap-2 rounded-xl bg-amber-50 text-amber-800 text-xs px-3 py-2">
          <span className="flex items-center gap-1.5">
            <ImageOff className="w-3.5 h-3.5 shrink-0" /> Pictures in this mail are hidden.
          </span>
          <button type="button" onClick={() => setShowImages(true)} className="font-semibold underline underline-offset-2 shrink-0">
            Show pictures
          </button>
        </div>
      )}
      <iframe
        ref={frameRef}
        title="Mail"
        // No allow-scripts: nothing in a mail can run. allow-same-origin only
        // lets this page measure the height; allow-popups opens links.
        sandbox="allow-same-origin allow-popups allow-popups-to-escape-sandbox"
        srcDoc={srcDoc}
        style={{ height }}
        className="w-full border-0 block"
      />
    </div>
  );
};
