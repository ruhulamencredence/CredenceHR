/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Draw a signature with a finger / mouse / pen, or upload a photo of one.
// Hands back a trimmed, transparent PNG data URL (null when cleared).

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Eraser, Upload } from 'lucide-react';

const W = 640;
const H = 220;

// Crop to what was drawn (plus a margin); null if nothing was.
function trimmed(canvas: HTMLCanvasElement): string | null {
  const ctx = canvas.getContext('2d')!;
  const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
  let x0 = canvas.width, y0 = canvas.height, x1 = -1, y1 = -1;
  for (let y = 0; y < canvas.height; y++) {
    for (let x = 0; x < canvas.width; x++) {
      if (data[(y * canvas.width + x) * 4 + 3] > 20) {
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
        if (y < y0) y0 = y;
        if (y > y1) y1 = y;
      }
    }
  }
  if (x1 < 0 || x1 - x0 < 8) return null;
  const m = 8;
  const out = document.createElement('canvas');
  out.width = Math.min(canvas.width, x1 - x0 + 1 + m * 2);
  out.height = Math.min(canvas.height, y1 - y0 + 1 + m * 2);
  out.getContext('2d')!.drawImage(canvas, Math.max(0, x0 - m), Math.max(0, y0 - m), out.width, out.height, 0, 0, out.width, out.height);
  return out.toDataURL('image/png');
}

export const SignaturePad: React.FC<{ onChange: (png: string | null) => void }> = ({ onChange }) => {
  const ref = useRef<HTMLCanvasElement>(null);
  const drawing = useRef(false);
  const last = useRef<{ x: number; y: number } | null>(null);
  const [empty, setEmpty] = useState(true);
  const [error, setError] = useState('');

  const ctx = () => {
    const c = ref.current!.getContext('2d')!;
    c.lineCap = 'round';
    c.lineJoin = 'round';
    c.strokeStyle = '#1e1b4b';
    c.lineWidth = 3;
    return c;
  };
  const point = (e: React.PointerEvent) => {
    const r = ref.current!.getBoundingClientRect();
    return { x: ((e.clientX - r.left) / r.width) * W, y: ((e.clientY - r.top) / r.height) * H };
  };
  const emit = useCallback(() => {
    const png = trimmed(ref.current!);
    setEmpty(!png);
    onChange(png);
  }, [onChange]);
  const clear = () => {
    ref.current!.getContext('2d')!.clearRect(0, 0, W, H);
    setEmpty(true);
    onChange(null);
  };
  useEffect(() => {
    ref.current!.getContext('2d')!.clearRect(0, 0, W, H);
  }, []);

  // A photo / scan of a signature: scaled into the pad, near-white made
  // transparent so it sits cleanly on the document.
  const upload = (file: File) => {
    setError('');
    if (!/^image\//.test(file.type)) return setError('Choose an image (PNG or JPG).');
    if (file.size > 5 * 1024 * 1024) return setError('The image is too big (at most 5 MB).');
    const img = new Image();
    img.onload = () => {
      const c = ref.current!.getContext('2d')!;
      c.clearRect(0, 0, W, H);
      const s = Math.min((W - 20) / img.width, (H - 20) / img.height);
      const w = img.width * s;
      const h = img.height * s;
      c.drawImage(img, (W - w) / 2, (H - h) / 2, w, h);
      const d = c.getImageData(0, 0, W, H);
      for (let i = 0; i < d.data.length; i += 4) {
        const lum = (d.data[i] + d.data[i + 1] + d.data[i + 2]) / 3;
        if (lum > 200) d.data[i + 3] = 0;
      }
      c.putImageData(d, 0, 0);
      URL.revokeObjectURL(img.src);
      emit();
    };
    img.onerror = () => setError("That image couldn't be read.");
    img.src = URL.createObjectURL(file);
  };

  return (
    <div>
      <div className="liquid-glass-inset rounded-2xl p-1.5 relative">
        <canvas
          ref={ref}
          width={W}
          height={H}
          className="w-full h-auto rounded-xl bg-white touch-none cursor-crosshair"
          style={{ aspectRatio: `${W} / ${H}` }}
          aria-label="Signature pad — draw your signature here"
          onPointerDown={(e) => {
            (e.target as HTMLElement).setPointerCapture(e.pointerId);
            drawing.current = true;
            last.current = point(e);
            const c = ctx();
            c.beginPath();
            c.arc(last.current.x, last.current.y, 1.4, 0, Math.PI * 2);
            c.fillStyle = '#1e1b4b';
            c.fill();
          }}
          onPointerMove={(e) => {
            if (!drawing.current || !last.current) return;
            const p = point(e);
            const c = ctx();
            c.beginPath();
            c.moveTo(last.current.x, last.current.y);
            c.lineTo(p.x, p.y);
            c.stroke();
            last.current = p;
          }}
          onPointerUp={() => {
            drawing.current = false;
            last.current = null;
            emit();
          }}
          onPointerCancel={() => {
            drawing.current = false;
            last.current = null;
          }}
        />
        {empty && <div className="pointer-events-none absolute inset-0 flex items-center justify-center text-sm text-slate-300">Sign here</div>}
        <div className="pointer-events-none absolute left-8 right-8 bottom-9 border-b border-dashed border-slate-300" />
      </div>
      <div className="flex items-center justify-between gap-2 mt-2">
        <label className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900 cursor-pointer">
          <Upload className="w-3.5 h-3.5" /> Upload a photo of it
          <input type="file" accept="image/*" className="hidden" onChange={(e) => e.target.files?.[0] && upload(e.target.files[0])} />
        </label>
        <button type="button" onClick={clear} className="inline-flex items-center gap-1.5 text-xs font-semibold text-slate-600 hover:text-slate-900">
          <Eraser className="w-3.5 h-3.5" /> Clear
        </button>
      </div>
      {error && <p className="text-[11px] text-rose-600 mt-1">{error}</p>}
    </div>
  );
};
