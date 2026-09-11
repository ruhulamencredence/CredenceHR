/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useEffect, useRef, useState } from 'react';
import { X, FileDown, ZoomIn, ZoomOut, RotateCcw, ListChecks, FileStack } from 'lucide-react';
import { Lottie } from 'lottie-react';
import { useBackButtonClose } from '../lib/useBackButtonClose';
import { Entry } from '../types';
import * as pdfjsLib from 'pdfjs-dist';
// Vite-specific import: resolves to the actual URL of pdf.js's worker script
// so it can run PDF parsing off the main thread. Without this pdf.js can't
// find its worker at runtime and silently fails to render.
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import businessPlanAnimation from '../assets/business-plan.json';

pdfjsLib.GlobalWorkerOptions.workerSrc = pdfWorkerUrl;

const ZOOM_MIN = 0.5;
const ZOOM_MAX = 2.5;
const ZOOM_STEP = 0.25;

// Clamps one axis of the pan offset so the (scaled) content can always be dragged
// all the way to any of its edges, but never past them:
// - If the content is smaller than the viewport on this axis, it's centered and
//   locked (nothing to pan on that axis).
// - Otherwise pan ranges from `containerSize - scaledSize` (content's far edge
//   flush with the viewport's far edge) up to `0` (content's near edge flush with
//   the viewport's near edge). Both directions are always reachable — this is
//   what the old CSS-scale-with-native-scroll approach got wrong: the browser's
//   own overflow scrolling only ever exposed the "grows to the right/down" side
//   of a centered transform, so the left side of a zoomed page could never be
//   reached. Panning here is plain translation, so there's no such asymmetry.
const clampAxis = (pan: number, scaledSize: number, containerSize: number): number => {
  if (scaledSize <= containerSize) return (containerSize - scaledSize) / 2;
  const min = containerSize - scaledSize;
  return Math.min(0, Math.max(min, pan));
};

interface PdfPreviewModalProps {
  isOpen: boolean;
  // Raw PDF bytes (from jsPDF's `doc.output('arraybuffer')`) rather than a
  // blob URL — an <iframe src="blob:...">  only renders where the browser/
  // WebView has its own built-in PDF viewer wired up to iframes, which the
  // Android WebView used by the APK does NOT have. Rendering the bytes
  // ourselves with pdf.js onto <canvas> elements works identically on web
  // and inside the APK, with nothing written to disk just to look at it.
  pdfBytes: Uint8Array | null;
  filename: string;
  onClose: () => void;
  onDownload: () => void;
  // The exact rows this PDF was built from — lets the preview offer an "Edit"
  // list alongside the rendered pages. Optional: omit to hide the Edit list
  // entirely (e.g. for a future report that isn't a list of editable entries).
  entries?: Entry[];
  // Renders ONE row of the "Edit Entries" list — either the plain tappable
  // summary row, or (when that entry is the one currently being edited) the
  // app's EXISTING inline edit form (same component/validation already used
  // in the main Job Entry Details table — Delivery Date range, MPR reuse
  // checks, required fields, etc. all still apply exactly as they do when
  // editing from the table directly). Editing therefore happens right here,
  // inside the preview, instead of closing the preview and jumping back to
  // the Job Entry Details table underneath it.
  renderEntry?: (entry: Entry) => React.ReactNode;
}

export const PdfPreviewModal: React.FC<PdfPreviewModalProps> = ({
  isOpen,
  pdfBytes,
  filename,
  onClose,
  onDownload,
  entries,
  renderEntry
}) => {
  useBackButtonClose(isOpen, onClose);

  // previewAreaRef: the fixed-size viewport the user sees (overflow-hidden — no
  // native scrolling anymore; panning is done entirely by hand below).
  // pageStackRef: the natural, UN-scaled block that holds the rendered <canvas>
  // pages. Its own offsetWidth/offsetHeight never change with zoom (CSS transform
  // is paint-only and doesn't affect an element's own layout box), which is
  // exactly what's needed as the stable baseline for every pan/zoom calculation
  // below — multiply by the current zoom to get the actual on-screen size.
  const previewAreaRef = useRef<HTMLDivElement>(null);
  const pageStackRef = useRef<HTMLDivElement>(null);

  const [rendering, setRendering] = useState(true);
  const [renderError, setRenderError] = useState('');
  const [zoom, setZoom] = useState(1);
  // Pan offset in plain CSS pixels, applied as `translate(pan.x, pan.y)` BEFORE
  // `scale(zoom)` with transform-origin at the top-left — so pan.x/pan.y always
  // mean exactly "how many screen pixels the content's top-left corner has moved
  // from the viewport's top-left corner", independent of the current zoom level.
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [showEntryList, setShowEntryList] = useState(false);
  // Disables the smooth transform transition while a pinch/drag gesture is
  // actively in progress — otherwise every update (many per second) fights the
  // transition and the page visibly lags behind your fingers. The transition is
  // only wanted for the +/- buttons and Reset.
  const [isInteracting, setIsInteracting] = useState(false);

  // Always-current mirrors of the two pieces of state every gesture handler
  // below needs to read — kept as refs so those handlers (attached once, not
  // re-created on every zoom/pan tick) never read stale values.
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  useEffect(() => {
    zoomRef.current = zoom;
  }, [zoom]);
  useEffect(() => {
    panRef.current = pan;
  }, [pan]);

  useEffect(() => {
    if (!isOpen) return;
    setZoom(1);
    setPan({ x: 0, y: 0 });
    setShowEntryList(false);
  }, [isOpen]);

  // Re-clamps the current pan to whatever is actually reachable at a given zoom
  // level (used after the +/- buttons change zoom, and continuously while
  // pinching, so panning never leaves blank space stranded on any side).
  const clampPan = (p: { x: number; y: number }, z: number): { x: number; y: number } => {
    const container = previewAreaRef.current;
    const content = pageStackRef.current;
    if (!container || !content) return p;
    const scaledWidth = content.offsetWidth * z;
    const scaledHeight = content.offsetHeight * z;
    return {
      x: clampAxis(p.x, scaledWidth, container.clientWidth),
      y: clampAxis(p.y, scaledHeight, container.clientHeight)
    };
  };

  const applyZoom = (nextZoom: number) => {
    const clampedZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, +nextZoom.toFixed(2)));
    setZoom(clampedZoom);
    setPan((p) => clampPan(p, clampedZoom));
  };

  // Touch (pinch-to-zoom anchored under your fingers + one-finger drag-to-pan),
  // mouse (click-and-drag-to-pan), and wheel/trackpad (scroll-to-pan) all drive
  // the same `pan`/`zoom` state. Attached as native listeners (not React's
  // onTouch*/onWheel props) specifically so touchmove/wheel can be registered
  // non-passive — only that lets preventDefault() actually stop the WebView/
  // browser's own pinch/scroll gestures from fighting our own.
  useEffect(() => {
    const el = previewAreaRef.current;
    if (!isOpen || showEntryList || !el) return;

    const dist = (t1: Touch, t2: Touch) => Math.hypot(t2.clientX - t1.clientX, t2.clientY - t1.clientY);
    const mid = (t1: Touch, t2: Touch) => ({ x: (t1.clientX + t2.clientX) / 2, y: (t1.clientY + t2.clientY) / 2 });

    let drag: { startX: number; startY: number; startPan: { x: number; y: number } } | null = null;
    let pinch: {
      startDist: number;
      startZoom: number;
      // The content pixel (in the page stack's own, un-scaled coordinate space)
      // that sat directly under the fingers when the pinch began — recomputed
      // into `pan` on every move so that exact pixel stays under the fingers as
      // zoom changes, instead of always zooming from a fixed center point.
      contentX: number;
      contentY: number;
    } | null = null;

    // Re-derives drag/pinch anchors from however many fingers are down right
    // now — called on every touchstart AND touchend so a gesture can smoothly
    // hand off between one- and two-finger without a jump (e.g. lifting one
    // finger mid-pinch just continues as a one-finger drag from that point).
    const rebase = (touches: TouchList) => {
      const rect = el.getBoundingClientRect();
      if (touches.length === 1) {
        drag = { startX: touches[0].clientX, startY: touches[0].clientY, startPan: panRef.current };
        pinch = null;
      } else if (touches.length === 2) {
        const m = mid(touches[0], touches[1]);
        const midRelX = m.x - rect.left;
        const midRelY = m.y - rect.top;
        pinch = {
          startDist: dist(touches[0], touches[1]),
          startZoom: zoomRef.current,
          contentX: (midRelX - panRef.current.x) / zoomRef.current,
          contentY: (midRelY - panRef.current.y) / zoomRef.current
        };
        drag = null;
      } else {
        drag = null;
        pinch = null;
      }
    };

    const onTouchStart = (e: TouchEvent) => {
      rebase(e.touches);
      if (e.touches.length > 0) setIsInteracting(true);
    };
    const onTouchMove = (e: TouchEvent) => {
      if (e.touches.length === 2 && pinch) {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        const m = mid(e.touches[0], e.touches[1]);
        const newZoom = Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, pinch.startZoom * (dist(e.touches[0], e.touches[1]) / pinch.startDist)));
        const newPan = {
          x: m.x - rect.left - pinch.contentX * newZoom,
          y: m.y - rect.top - pinch.contentY * newZoom
        };
        setZoom(+newZoom.toFixed(2));
        setPan(clampPan(newPan, newZoom));
      } else if (e.touches.length === 1 && drag) {
        e.preventDefault();
        const newPan = {
          x: drag.startPan.x + (e.touches[0].clientX - drag.startX),
          y: drag.startPan.y + (e.touches[0].clientY - drag.startY)
        };
        setPan(clampPan(newPan, zoomRef.current));
      }
    };
    const onTouchEnd = (e: TouchEvent) => {
      rebase(e.touches);
      if (e.touches.length === 0) setIsInteracting(false);
    };

    let mouseDrag: { startX: number; startY: number; startPan: { x: number; y: number } } | null = null;
    const onMouseDown = (e: MouseEvent) => {
      mouseDrag = { startX: e.clientX, startY: e.clientY, startPan: panRef.current };
      setIsInteracting(true);
      e.preventDefault();
    };
    const onMouseMove = (e: MouseEvent) => {
      if (!mouseDrag) return;
      const newPan = {
        x: mouseDrag.startPan.x + (e.clientX - mouseDrag.startX),
        y: mouseDrag.startPan.y + (e.clientY - mouseDrag.startY)
      };
      setPan(clampPan(newPan, zoomRef.current));
    };
    const onMouseUp = () => {
      mouseDrag = null;
      setIsInteracting(false);
    };

    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const newPan = { x: panRef.current.x - e.deltaX, y: panRef.current.y - e.deltaY };
      setPan(clampPan(newPan, zoomRef.current));
    };

    el.addEventListener('touchstart', onTouchStart, { passive: true });
    el.addEventListener('touchmove', onTouchMove, { passive: false });
    el.addEventListener('touchend', onTouchEnd, { passive: true });
    el.addEventListener('touchcancel', onTouchEnd, { passive: true });
    el.addEventListener('mousedown', onMouseDown);
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    el.addEventListener('wheel', onWheel, { passive: false });
    return () => {
      el.removeEventListener('touchstart', onTouchStart);
      el.removeEventListener('touchmove', onTouchMove);
      el.removeEventListener('touchend', onTouchEnd);
      el.removeEventListener('touchcancel', onTouchEnd);
      el.removeEventListener('mousedown', onMouseDown);
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
      el.removeEventListener('wheel', onWheel);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, showEntryList]);

  useEffect(() => {
    if (!isOpen || !pdfBytes) return;
    let cancelled = false;
    setRendering(true);
    setRenderError('');

    (async () => {
      try {
        // pdf.js detaches/transfers the buffer it's given, so hand it a copy —
        // otherwise a second preview of the same doc (e.g. reopening after
        // Download) would fail with an already-detached-buffer error.
        const loadingTask = pdfjsLib.getDocument({ data: pdfBytes.slice() });
        const pdf = await loadingTask.promise;
        if (cancelled || !pageStackRef.current) return;

        pageStackRef.current.innerHTML = '';
        for (let pageNum = 1; pageNum <= pdf.numPages; pageNum++) {
          if (cancelled) return;
          const page = await pdf.getPage(pageNum);
          // The canvas is displayed at a CSS size set by "w-full" (the container's
          // width), completely independent of how many actual pixels we render into
          // it — so the old flat "scale: 1.5" was both (a) ignoring the screen's
          // device pixel ratio, making every page look soft on any high-DPI/mobile
          // display even before zooming, and (b) not leaving enough headroom for the
          // 2.5x in-toolbar zoom, which stretched that same soft bitmap further and
          // made it visibly blurry/pixelated once zoomed. Rendering at a higher pixel
          // density up front (capped so multi-page PDFs don't get too heavy) fixes
          // both: the browser downsamples a sharper source into the same CSS size,
          // so it's crisp at 100% AND stays crisp through the full zoom range.
          const outputScale = Math.min(window.devicePixelRatio || 1, 2);
          const viewport = page.getViewport({ scale: 2 * outputScale });

          const canvas = document.createElement('canvas');
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.className = 'w-full h-auto shadow-sm border border-slate-200 rounded-lg mb-3 last:mb-0';
          pageStackRef.current.appendChild(canvas);

          const ctx = canvas.getContext('2d');
          if (!ctx) continue;
          await page.render({ canvasContext: ctx, viewport, canvas }).promise;
        }
      } catch (err) {
        console.error('PDF preview render failed', err);
        if (!cancelled) setRenderError("Couldn't render the preview — you can still Download to view it.");
      } finally {
        if (!cancelled) setRendering(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [isOpen, pdfBytes]);

  if (!isOpen) return null;

  return (
    <div className="fixed inset-0 z-50 bg-slate-950/60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4">
      <div className="bg-white rounded-2xl w-full max-w-3xl h-[92vh] flex flex-col shadow-2xl overflow-hidden">
        <div className="flex items-center justify-between gap-2 p-4 border-b border-slate-200 flex-wrap">
          <h3 className="text-sm font-bold text-slate-900 truncate flex-1 min-w-0" title={filename}>
            {filename}
          </h3>
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* Zoom controls */}
            <div className="flex items-center gap-0.5 bg-slate-100 rounded-lg p-0.5 mr-1">
              <button
                type="button"
                onClick={() => applyZoom(zoom - ZOOM_STEP)}
                disabled={zoom <= ZOOM_MIN}
                className="p-1.5 text-slate-600 hover:bg-white rounded-md disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label="Zoom out"
              >
                <ZoomOut className="w-4 h-4" />
              </button>
              <span className="text-[11px] font-medium text-slate-500 w-9 text-center select-none">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                onClick={() => applyZoom(zoom + ZOOM_STEP)}
                disabled={zoom >= ZOOM_MAX}
                className="p-1.5 text-slate-600 hover:bg-white rounded-md disabled:opacity-30 disabled:cursor-not-allowed transition-colors"
                aria-label="Zoom in"
              >
                <ZoomIn className="w-4 h-4" />
              </button>
              {(zoom !== 1 || pan.x !== 0 || pan.y !== 0) && (
                <button
                  type="button"
                  onClick={() => {
                    setZoom(1);
                    setPan({ x: 0, y: 0 });
                  }}
                  className="p-1.5 text-slate-600 hover:bg-white rounded-md transition-colors"
                  aria-label="Reset zoom"
                >
                  <RotateCcw className="w-3.5 h-3.5" />
                </button>
              )}
            </div>

            {entries && entries.length > 0 && renderEntry && (
              <button
                type="button"
                onClick={() => setShowEntryList((v) => !v)}
                className={`flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg font-medium transition-colors ${
                  showEntryList ? 'bg-blue-50 text-blue-700 border border-blue-200' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                }`}
              >
                {showEntryList ? <FileStack className="w-3.5 h-3.5" /> : <ListChecks className="w-3.5 h-3.5" />}
                {showEntryList ? 'Preview' : 'Edit Entries'}
              </button>
            )}

            <button
              type="button"
              onClick={onDownload}
              className="flex items-center gap-1.5 text-xs px-3 py-2 rounded-lg bg-blue-600 hover:bg-blue-700 text-white font-medium transition-colors"
            >
              <FileDown className="w-3.5 h-3.5" /> Download
            </button>
            <button
              type="button"
              onClick={onClose}
              className="p-2 text-slate-400 hover:text-slate-700 hover:bg-slate-100 rounded-lg transition-colors"
              aria-label="Close preview"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
        </div>

        {showEntryList && entries && renderEntry ? (
          // "Edit Entries" list. Each row is either a plain tappable summary, or —
          // for whichever entry is currently being edited — the full inline edit
          // form dropped in right in its place, so editing happens inside this
          // same preview instead of closing it and jumping elsewhere.
          <div className="flex-1 overflow-y-auto divide-y divide-slate-100 p-2 sm:p-3 space-y-2 divide-y-0">
            {entries.map((entry) => (
              <div key={entry.id}>{renderEntry(entry)}</div>
            ))}
          </div>
        ) : (
          // overflow-hidden, not overflow-auto: panning is done entirely by hand
          // (see the gesture effect above) via `pan`, not the browser's native
          // scroll — native scroll of a centered CSS transform can only ever
          // reach the overflow it creates to the right/bottom, never the left/
          // top, which is exactly why the page couldn't be dragged leftward
          // before. touchAction 'none' hands ALL touch gestures here to our own
          // JS instead of letting the WebView/browser try to scroll or pinch-zoom
          // the element itself.
          <div
            ref={previewAreaRef}
            className="flex-1 bg-slate-100 overflow-hidden relative select-none"
            style={{ touchAction: 'none', cursor: isInteracting ? 'grabbing' : 'grab' }}
          >
            {rendering && (
              <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-slate-400 text-sm">
                <div className="w-28 h-28 sm:w-36 sm:h-36 pointer-events-none">
                  <Lottie src={businessPlanAnimation} autoplay loop className="w-full h-full" />
                </div>
                Rendering preview…
              </div>
            )}
            {renderError && !rendering && (
              <p className="text-center text-sm text-rose-600 py-8">{renderError}</p>
            )}
            <div
              className="p-3 sm:p-4"
              style={{
                transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})`,
                transformOrigin: '0 0',
                transition: isInteracting ? 'none' : 'transform 0.15s ease-out',
                willChange: 'transform'
              }}
            >
              <div ref={pageStackRef} />
            </div>
          </div>
        )}
      </div>
    </div>
  );
};