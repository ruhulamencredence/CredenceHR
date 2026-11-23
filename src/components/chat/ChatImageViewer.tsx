/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Chat -> tap a photo: every photo of the conversation in one full-screen
// viewer, inside the app (window.open of a blob did nothing useful in the
// Android / iPhone app and couldn't go to the next picture).
//   - swipe left / right (phone), the arrows or ← → keys (computer), or a
//     thumbnail in the strip below to move between photos;
//   - double-tap / double-click or pinch to zoom, drag to look around while
//     zoomed (swiping to the next photo waits until it is back to normal size);
//   - Download (the Share sheet on the apps, saveBlobCrossPlatform);
//   - ✕, Esc or the phone's Back button closes it.
// Photos come through chatAttachmentUrl (one fetch per photo, shared with the
// bubbles, so opening the viewer doesn't download them again).

import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { ChevronLeft, ChevronRight, Download, X, ZoomIn, ZoomOut } from 'lucide-react';
import { apiUrl } from '../../lib/api';
import { saveBlobCrossPlatform } from '../../lib/saveFile';
import { useBackButtonClose } from '../../lib/useBackButtonClose';

export interface ChatImageItem {
  id: number;
  sender_name?: string | null;
  created_at?: string | null;
  filename?: string | null;
}

// messageId -> object URL of the photo, for the whole session (the bubbles and
// the viewer use the same one; nothing is downloaded twice).
const urlCache = new Map<number, Promise<string | null>>();
export function chatAttachmentUrl(token: string, messageId: number): Promise<string | null> {
  let p = urlCache.get(messageId);
  if (!p) {
    p = fetch(apiUrl(`/api/chat/messages/${messageId}/attachment`), { headers: { Authorization: `Bearer ${token}` } })
      .then(async (res) => (res.ok ? URL.createObjectURL(await res.blob()) : null))
      .catch(() => null);
    // A failed fetch may be tried again next time.
    p.then((u) => {
      if (!u) urlCache.delete(messageId);
    });
    urlCache.set(messageId, p);
  }
  return p;
}

export function useChatImageUrl(token: string, messageId: number | null): string | null {
  const [url, setUrl] = useState<string | null>(null);
  useEffect(() => {
    let alive = true;
    setUrl(null);
    if (messageId == null) return;
    void chatAttachmentUrl(token, messageId).then((u) => alive && setUrl(u));
    return () => {
      alive = false;
    };
  }, [token, messageId]);
  return url;
}

const when = (s?: string | null) => {
  if (!s) return '';
  const d = new Date(s);
  return Number.isNaN(d.getTime())
    ? ''
    : `${d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' })}, ${d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit' })}`;
};

const Thumb: React.FC<{ token: string; id: number; on: boolean; onClick: () => void }> = ({ token, id, on, onClick }) => {
  const url = useChatImageUrl(token, id);
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label="Show this photo"
      aria-current={on}
      className={`shrink-0 w-12 h-12 rounded-xl overflow-hidden bg-white/10 transition-all ${on ? 'ring-2 ring-white opacity-100' : 'opacity-55 hover:opacity-90'}`}
    >
      {url && <img src={url} alt="" className="w-full h-full object-cover" draggable={false} />}
    </button>
  );
};

// One photo, with its own zoom / pan.
const Slide: React.FC<{
  token: string;
  id: number;
  active: boolean;
  scale: number;
  pan: { x: number; y: number };
}> = ({ token, id, active, scale, pan }) => {
  const url = useChatImageUrl(token, id);
  return (
    <div className="w-full h-full shrink-0 flex items-center justify-center overflow-hidden px-2">
      {url ? (
        <img
          src={url}
          alt=""
          draggable={false}
          className="max-w-full max-h-full object-contain select-none"
          style={{
            transform: active ? `translate3d(${pan.x}px, ${pan.y}px, 0) scale(${scale})` : 'none',
            transition: 'transform .18s ease-out',
            touchAction: 'none'
          }}
        />
      ) : (
        <div className="w-10 h-10 rounded-full border-2 border-white/30 border-t-white animate-spin" />
      )}
    </div>
  );
};

export const ChatImageViewer: React.FC<{
  token: string;
  images: ChatImageItem[];
  startId: number;
  onClose: () => void;
}> = ({ token, images, startId, onClose }) => {
  const [index, setIndex] = useState(() => Math.max(0, images.findIndex((i) => i.id === startId)));
  const [scale, setScale] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [drag, setDrag] = useState(0); // swipe offset in px while a finger moves
  const [saving, setSaving] = useState(false);
  useBackButtonClose(true, onClose);
  const cur = images[index];
  const many = images.length > 1;

  const go = useCallback(
    (to: number) => {
      if (to < 0 || to >= images.length) return;
      setIndex(to);
      setScale(1);
      setPan({ x: 0, y: 0 });
    },
    [images.length]
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onClose();
      else if (e.key === 'ArrowLeft') go(index - 1);
      else if (e.key === 'ArrowRight') go(index + 1);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [go, index, onClose]);

  // The neighbours load before they are needed.
  useEffect(() => {
    for (const k of [index - 1, index + 1]) if (images[k]) void chatAttachmentUrl(token, images[k].id);
  }, [index, images, token]);

  // The active thumbnail stays in view.
  const stripRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = stripRef.current?.children[index] as HTMLElement | undefined;
    el?.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'smooth' });
  }, [index]);

  // Touch: one finger swipes (or pans when zoomed), two fingers pinch.
  // dx: the swipe so far, kept here (not only in state) so a quick flick that
  // ends before React has re-rendered still counts.
  const touch = useRef<{ x: number; y: number; dist: number; scale: number; pan: { x: number; y: number }; moved: boolean; dx: number } | null>(null);
  const lastTap = useRef(0);
  const dist = (t: React.TouchList) => Math.hypot(t[0].clientX - t[1].clientX, t[0].clientY - t[1].clientY);
  const onTouchStart = (e: React.TouchEvent) => {
    const t = e.touches;
    touch.current = { x: t[0].clientX, y: t[0].clientY, dist: t.length > 1 ? dist(t) : 0, scale, pan, moved: false, dx: 0 };
  };
  const onTouchMove = (e: React.TouchEvent) => {
    const s = touch.current;
    if (!s) return;
    const t = e.touches;
    if (t.length > 1 && s.dist) {
      s.moved = true;
      setScale(Math.min(4, Math.max(1, (s.scale * dist(t)) / s.dist)));
      return;
    }
    const dx = t[0].clientX - s.x;
    const dy = t[0].clientY - s.y;
    if (Math.abs(dx) > 6 || Math.abs(dy) > 6) s.moved = true;
    if (scale > 1) setPan({ x: s.pan.x + dx, y: s.pan.y + dy });
    else if (many) {
      s.dx = dx;
      setDrag(dx);
    }
  };
  const onTouchEnd = (e: React.TouchEvent) => {
    const s = touch.current;
    touch.current = null;
    if (scale <= 1.02 && scale !== 1) {
      setScale(1);
      setPan({ x: 0, y: 0 });
    }
    const dx = s?.dx || 0;
    if (dx) {
      const w = window.innerWidth;
      if (dx < -Math.min(80, w * 0.18)) go(index + 1);
      else if (dx > Math.min(80, w * 0.18)) go(index - 1);
      setDrag(0);
      return;
    }
    // Double tap: zoom in / back.
    if (s && !s.moved && e.touches.length === 0) {
      const now = Date.now();
      if (now - lastTap.current < 300) {
        toggleZoom();
        lastTap.current = 0;
      } else lastTap.current = now;
    }
  };
  const toggleZoom = () => {
    if (scale > 1) {
      setScale(1);
      setPan({ x: 0, y: 0 });
    } else setScale(2.5);
  };

  // Mouse drag to look around while zoomed (computer).
  const mouse = useRef<{ x: number; y: number; pan: { x: number; y: number } } | null>(null);

  const download = async () => {
    if (!cur) return;
    setSaving(true);
    try {
      const url = await chatAttachmentUrl(token, cur.id);
      if (!url) return;
      const blob = await (await fetch(url)).blob();
      const ext = (blob.type.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
      await saveBlobCrossPlatform(blob, cur.filename || `chat-photo-${cur.id}.${ext}`);
    } finally {
      setSaving(false);
    }
  };

  const trackStyle = useMemo(
    () => ({
      transform: `translate3d(calc(${-index * 100}% + ${drag}px), 0, 0)`,
      transition: drag ? 'none' : 'transform .28s cubic-bezier(.22,1,.36,1)'
    }),
    [index, drag]
  );

  if (!cur) return null;
  return createPortal(
    <div className="fixed inset-0 z-[95] flex flex-col bg-black/90 backdrop-blur-md text-white select-none" role="dialog" aria-modal="true" aria-label="Photo viewer">
      {/* Top: close, who / when, count, zoom, download */}
      <div className="flex items-center gap-2 px-3 shrink-0" style={{ paddingTop: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 0.6rem)', paddingBottom: '0.6rem' }}>
        <button type="button" onClick={onClose} aria-label="Close" className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center shrink-0">
          <X className="w-5 h-5" />
        </button>
        <div className="min-w-0 flex-1 px-1">
          <p className="text-sm font-semibold truncate">{cur.sender_name || 'Photo'}</p>
          <p className="text-[11px] text-white/60 truncate">{when(cur.created_at)}</p>
        </div>
        {many && (
          <span data-testid="chat-viewer-count" className="text-xs font-semibold text-white/80 tabular-nums px-2">
            {index + 1} / {images.length}
          </span>
        )}
        <button type="button" onClick={toggleZoom} aria-label={scale > 1 ? 'Zoom out' : 'Zoom in'} className="hidden md:flex w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 items-center justify-center shrink-0">
          {scale > 1 ? <ZoomOut className="w-5 h-5" /> : <ZoomIn className="w-5 h-5" />}
        </button>
        <button type="button" onClick={download} disabled={saving} aria-label="Download" className="w-10 h-10 rounded-full bg-white/15 hover:bg-white/25 flex items-center justify-center shrink-0 disabled:opacity-50">
          <Download className="w-5 h-5" />
        </button>
      </div>

      {/* The photos side by side; the track slides to the current one. */}
      <div
        className="relative flex-1 min-h-0 overflow-hidden"
        onTouchStart={onTouchStart}
        onTouchMove={onTouchMove}
        onTouchEnd={onTouchEnd}
        onDoubleClick={toggleZoom}
        onMouseDown={(e) => {
          if (scale > 1) mouse.current = { x: e.clientX, y: e.clientY, pan };
        }}
        onMouseMove={(e) => {
          const m = mouse.current;
          if (m) setPan({ x: m.pan.x + e.clientX - m.x, y: m.pan.y + e.clientY - m.y });
        }}
        onMouseUp={() => (mouse.current = null)}
        onMouseLeave={() => (mouse.current = null)}
        style={{ touchAction: 'none', cursor: scale > 1 ? 'grab' : 'zoom-in' }}
      >
        <div className="flex h-full" style={trackStyle} data-testid="chat-viewer-track">
          {images.map((im, i) => (
            <Slide key={im.id} token={token} id={im.id} active={i === index} scale={i === index ? scale : 1} pan={i === index ? pan : { x: 0, y: 0 }} />
          ))}
        </div>
        {many && index > 0 && (
          <button type="button" onClick={() => go(index - 1)} aria-label="Previous photo" className="hidden md:flex absolute left-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/15 hover:bg-white/30 items-center justify-center">
            <ChevronLeft className="w-6 h-6" />
          </button>
        )}
        {many && index < images.length - 1 && (
          <button type="button" onClick={() => go(index + 1)} aria-label="Next photo" className="hidden md:flex absolute right-3 top-1/2 -translate-y-1/2 w-11 h-11 rounded-full bg-white/15 hover:bg-white/30 items-center justify-center">
            <ChevronRight className="w-6 h-6" />
          </button>
        )}
      </div>

      {/* Every photo of the conversation, small. */}
      {many && (
        <div
          ref={stripRef}
          className="flex gap-2 overflow-x-auto no-scrollbar px-3 pt-2 shrink-0 justify-start md:justify-center"
          style={{ paddingBottom: 'calc(var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)) + 0.75rem)' }}
        >
          {images.map((im, i) => (
            <Thumb key={im.id} token={token} id={im.id} on={i === index} onClick={() => go(i)} />
          ))}
        </div>
      )}
    </div>,
    document.body
  );
};
