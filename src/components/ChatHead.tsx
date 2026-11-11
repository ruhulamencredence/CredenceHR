/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// The phone's Chat head (Dashboard, BottomNav.tsx), like Messenger's:
//   - drag it anywhere; let go and it snaps to the nearer side edge, kept
//     between the header and the bottom bar; its place is remembered on this
//     phone (localStorage — a convenience only);
//   - tap it and Chat opens in a window over the page (liquid glass, the
//     house popup style) with the head parked at the top-right above it;
//     tap the head again, Chat's ←, or outside to close;
//   - steps aside to its edge while the page scrolls, like More did;
//   - a red number shows unread messages.
// Shown only for accounts that may use Chat (the caller checks chatAllowed);
// Chat's own API checks are unchanged.
import React, { Suspense, lazy, useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { User } from '../types';
import { useScrolling } from '../lib/useScrolling';
import { useChatUnread } from '../lib/useChatUnread';
import { retryImport } from '../lib/chunkReload';
import { ChatBubbleLogo } from './FloatingChatButton';

const ChatPanel = lazy(retryImport(() => import('./ChatPanel').then((m) => ({ default: m.ChatPanel }))));

const SIZE = 44;
const EDGE = 16; // gap to the side edge once it has snapped
const POS_KEY = 'chr_chat_head_pos';
// Above the bottom bar (80 px) by default, like More was.
const DEFAULT_BOTTOM = 94;
const TOP_LIMIT = 84; // stays below the app header

type Side = 'left' | 'right';
interface Pos {
  side: Side;
  bottom: number;
}
const safeBottom = 'var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px))';

function readPos(): Pos {
  try {
    const p = JSON.parse(localStorage.getItem(POS_KEY) || 'null');
    if (p && (p.side === 'left' || p.side === 'right') && Number.isFinite(p.bottom)) return { side: p.side, bottom: Number(p.bottom) };
  } catch {
    // storage unavailable — the default place
  }
  return { side: 'right', bottom: DEFAULT_BOTTOM };
}
const clampBottom = (b: number) => Math.max(DEFAULT_BOTTOM - 8, Math.min(window.innerHeight - TOP_LIMIT - SIZE, b));

export const ChatHead: React.FC<{ token: string; user: User; hidden?: boolean }> = ({ token, user, hidden }) => {
  const unread = useChatUnread(token);
  const scrolling = useScrolling();
  const [pos, setPos] = useState<Pos>(readPos);
  const [open, setOpen] = useState(false);
  // While a finger drags it: free x / y (px from the left / bottom).
  const [dragAt, setDragAt] = useState<{ x: number; bottom: number } | null>(null);
  const drag = useRef<{ startX: number; startY: number; x0: number; b0: number; moved: boolean } | null>(null);
  const justDragged = useRef(false);

  useEffect(() => {
    const onResize = () => setPos((p) => ({ ...p, bottom: clampBottom(p.bottom) }));
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && setOpen(false);
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  useEffect(() => {
    if (hidden) setOpen(false);
  }, [hidden]);

  const onPointerDown = (e: React.PointerEvent<HTMLButtonElement>) => {
    if (open) return;
    const r = e.currentTarget.getBoundingClientRect();
    drag.current = { startX: e.clientX, startY: e.clientY, x0: r.left, b0: window.innerHeight - r.bottom, moved: false };
    e.currentTarget.setPointerCapture(e.pointerId);
  };
  const onPointerMove = (e: React.PointerEvent<HTMLButtonElement>) => {
    const d = drag.current;
    if (!d) return;
    const dx = e.clientX - d.startX;
    const dy = e.clientY - d.startY;
    if (!d.moved && Math.hypot(dx, dy) > 6) d.moved = true;
    if (!d.moved) return;
    const x = Math.max(4, Math.min(window.innerWidth - SIZE - 4, d.x0 + dx));
    setDragAt({ x, bottom: clampBottom(d.b0 - dy) });
  };
  const endDrag = useCallback(() => {
    const d = drag.current;
    drag.current = null;
    justDragged.current = !!d?.moved;
    if (!d?.moved || !dragAt) {
      setDragAt(null);
      return;
    }
    // Snap to the nearer side edge.
    const next: Pos = { side: dragAt.x + SIZE / 2 < window.innerWidth / 2 ? 'left' : 'right', bottom: Math.round(dragAt.bottom) };
    setPos(next);
    setDragAt(null);
    try {
      localStorage.setItem(POS_KEY, JSON.stringify(next));
    } catch {
      // storage unavailable — the place just isn't remembered
    }
  }, [dragAt]);

  if (hidden) return null;

  // Where the head sits: following the finger, parked top-right over the
  // open window, or snapped to its edge (slid off it while the page scrolls).
  const style: React.CSSProperties = dragAt
    ? { left: dragAt.x, bottom: `calc(${dragAt.bottom}px + ${safeBottom})`, transition: 'none' }
    : open
      ? { right: EDGE, top: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 14px)' }
      : {
          [pos.side]: EDGE,
          bottom: `calc(${pos.bottom}px + ${safeBottom})`,
          transform: scrolling ? `translateX(${pos.side === 'right' ? 'calc(100% + 1.5rem)' : 'calc(-100% - 1.5rem)'})` : undefined
        };

  return createPortal(
    <>
      {open && (
        <div className="md:hidden fixed inset-0 z-[62]" role="dialog" aria-modal="true" aria-label="Chat">
          <div className="absolute inset-0 liquid-glass-backdrop" onClick={() => setOpen(false)} />
          <div
            className="absolute left-2 right-2"
            style={{
              top: 'calc(var(--native-safe-area-inset-top, env(safe-area-inset-top, 0px)) + 66px)',
              bottom: `calc(12px + ${safeBottom})`
            }}
          >
            {/* No ✕ of its own: it would cover Chat's "+" (new chat). Chat's
                ← , the head above, or a tap outside closes it. */}
            <div className="liquid-glass liquid-glass-in rounded-[28px] h-full overflow-hidden flex flex-col">
              <div className="flex-1 min-h-0 flex">
                <Suspense fallback={<div className="m-auto text-xs text-slate-500">Loading…</div>}>
                  <ChatPanel user={user} token={token} onBack={() => setOpen(false)} variant="modal" />
                </Suspense>
              </div>
            </div>
          </div>
        </div>
      )}
      <button
        type="button"
        data-tour="nav-chat"
        aria-label={open ? 'Close chat' : unread > 0 ? `Chat, ${unread} unread — drag to move` : 'Chat — drag to move'}
        aria-expanded={open}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={endDrag}
        onPointerCancel={() => {
          drag.current = null;
          setDragAt(null);
        }}
        onClick={() => {
          if (justDragged.current) {
            justDragged.current = false;
            return;
          }
          setOpen((v) => !v);
        }}
        style={{ width: SIZE, height: SIZE, transition: 'left 0.25s ease-out, right 0.25s ease-out, bottom 0.25s ease-out, top 0.25s ease-out, transform 0.3s ease-out', ...style }}
        className={`md:hidden fixed z-[63] flex items-center justify-center rounded-full bg-white/45 backdrop-blur-xl border border-white/70 shadow-[0_8px_20px_-6px_rgba(42,0,85,0.45),inset_0_1px_0_rgba(255,255,255,0.7)] touch-none select-none ${dragAt ? 'scale-110' : 'active:scale-95'}`}
      >
        <ChatBubbleLogo className="w-[26px] h-[26px] pointer-events-none" style={{ color: 'var(--g-accent)' }} />
        {unread > 0 && !open && (
          <span className="absolute -top-1 -right-1 min-w-[18px] h-[18px] px-1 rounded-full bg-red-500 text-white text-[10px] font-bold leading-none flex items-center justify-center border-2 border-white pointer-events-none">
            {unread > 99 ? '99+' : unread}
          </span>
        )}
      </button>
    </>,
    document.body
  );
};
