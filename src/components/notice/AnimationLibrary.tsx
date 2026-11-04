/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Notices -> New notice -> Animation: pick one from the shared Animation
// library (GET /api/notices/animations), or paste one / give a link. People
// with the Notices layer "Animation library (add / remove)" can import a
// Lottie .json into the library once and remove it again; using one only
// needs the Notices module. The notice keeps its own copy of the animation.

import React, { useEffect, useRef, useState } from 'react';
import { Check, ChevronRight, Loader2, Plus, Sparkles, Trash2, Upload, X } from 'lucide-react';
import { apiUrl } from '../../lib/api';
import { confirmDialog } from '../../lib/confirmDialog';
import { LottieLight } from '../LazyLottie';

interface Item {
  id: number;
  name: string;
  size: number;
  by: string | null;
}

const kb = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
// One fetched animation per id, kept for the session (they don't change).
const jsonCache = new Map<number, string>();

const Thumb: React.FC<{ json: string | null; play: boolean }> = ({ json, play }) => {
  const data = React.useMemo(() => {
    try {
      return json ? JSON.parse(json) : null;
    } catch {
      return null;
    }
  }, [json]);
  if (!data) return <Loader2 className="w-4 h-4 animate-spin text-violet-400" />;
  // Re-mounted when "play" changes so a paused one rests on its first frame.
  return <LottieLight key={play ? 'p' : 's'} src={data} autoplay={play} loop={play} className="w-full h-full" />;
};

export const AnimationLibrary: React.FC<{
  token: string;
  // The notice's animation now (its own copy).
  value: string;
  url: string;
  onPick: (json: string) => void;
  onUrl: (url: string) => void;
  onError: (msg: string | null) => void;
}> = ({ token, value, url, onPick, onUrl, onError }) => {
  const [open, setOpen] = useState(!!(value || url));
  const [items, setItems] = useState<Item[] | null>(null);
  const [canManage, setCanManage] = useState(false);
  const [jsons, setJsons] = useState<Record<number, string>>({});
  const [hover, setHover] = useState<number | null>(null);
  const [adding, setAdding] = useState<{ name: string; json: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [paste, setPaste] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const auth = { Authorization: `Bearer ${token}` };

  const load = async () => {
    try {
      const r = await fetch(apiUrl('/api/notices/animations'), { headers: auth });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not load the animation library.');
      setItems(d.items || []);
      setCanManage(!!d.can_manage);
    } catch (e: any) {
      setItems([]);
      onError(e.message);
    }
  };
  useEffect(() => {
    if (open && !items) void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);
  // Each animation's file, for its thumbnail (and to use it).
  useEffect(() => {
    if (!items) return;
    let live = true;
    for (const it of items) {
      if (jsons[it.id]) continue;
      const cached = jsonCache.get(it.id);
      if (cached) {
        setJsons((j) => ({ ...j, [it.id]: cached }));
        continue;
      }
      fetch(apiUrl(`/api/notices/animations/${it.id}`), { headers: auth })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => {
          if (!d?.lottie_json || !live) return;
          jsonCache.set(it.id, d.lottie_json);
          setJsons((j) => ({ ...j, [it.id]: d.lottie_json }));
        })
        .catch(() => {});
    }
    return () => {
      live = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [items]);

  const pickFile = async (f: File) => {
    onError(null);
    if (f.size > 3 * 1024 * 1024) return onError('An animation can be up to 3 MB.');
    const text = await f.text();
    try {
      const d = JSON.parse(text);
      if (!Array.isArray(d?.layers)) throw new Error();
    } catch {
      return onError("That isn't a Lottie animation (.json from LottieFiles / After Effects).");
    }
    setAdding({ name: f.name.replace(/\.json$/i, '').replace(/[-_]+/g, ' ').trim().slice(0, 120), json: text });
  };
  const save = async () => {
    if (!adding) return;
    setBusy(true);
    onError(null);
    try {
      const r = await fetch(apiUrl('/api/notices/animations'), {
        method: 'POST',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: adding.name, lottie_json: adding.json })
      });
      const d = await r.json().catch(() => ({}));
      if (!r.ok) throw new Error(d.error || 'Could not add it.');
      setAdding(null);
      await load();
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const remove = async (it: Item) => {
    if (!(await confirmDialog(`Remove "${it.name}" from the animation library? Notices that already use it keep it.`, { tone: 'danger' }))) return;
    try {
      const r = await fetch(apiUrl(`/api/notices/animations/${it.id}`), { method: 'DELETE', headers: auth });
      if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || 'Could not remove it.');
      jsonCache.delete(it.id);
      setItems((list) => (list || []).filter((x) => x.id !== it.id));
    } catch (e: any) {
      onError(e.message);
    }
  };

  const chosenId = items?.find((it) => jsons[it.id] && jsons[it.id] === value)?.id ?? null;
  const custom = !!value && chosenId == null;

  return (
    <div className="rounded-[22px] bg-white/60 border border-white">
      <button type="button" onClick={() => setOpen(!open)} className="w-full flex items-center gap-2.5 px-3 py-2.5 text-left">
        <span className="w-8 h-8 rounded-xl bg-violet-50 text-violet-600 flex items-center justify-center">
          <Sparkles className="w-4 h-4" />
        </span>
        <span className="flex-1 min-w-0">
          <span className="block text-[13px] font-bold text-slate-800">Animation</span>
          <span className="block text-[11px] text-slate-500 truncate">
            {chosenId != null ? `From the library: ${items?.find((x) => x.id === chosenId)?.name}` : custom ? 'A pasted animation' : url ? 'From a link' : 'Optional — pick one from the library instead of a picture'}
          </span>
        </span>
        <ChevronRight className={`w-4 h-4 text-slate-400 transition-transform ${open ? 'rotate-90' : ''}`} />
      </button>
      {open && (
        <div className="px-3 pb-3 space-y-3">
          <div className="grid grid-cols-3 sm:grid-cols-5 gap-2">
            <button
              type="button"
              onClick={() => {
                onPick('');
                onUrl('');
              }}
              className={`relative aspect-square rounded-2xl border-2 flex flex-col items-center justify-center gap-1 text-[11px] font-semibold ${
                !value && !url ? 'border-violet-400 bg-white text-violet-700' : 'border-dashed border-slate-200 bg-white/60 text-slate-500 hover:border-slate-300'
              }`}
            >
              <X className="w-4 h-4" /> None
            </button>
            {(items || []).map((it) => {
              const on = chosenId === it.id;
              return (
                <div
                  key={it.id}
                  onMouseEnter={() => setHover(it.id)}
                  onMouseLeave={() => setHover(null)}
                  className={`group relative aspect-square rounded-2xl border-2 overflow-hidden bg-gradient-to-br from-violet-50 to-sky-50 ${on ? 'border-violet-500 ring-2 ring-violet-100' : 'border-white hover:border-violet-200'}`}
                >
                  <button
                    type="button"
                    disabled={!jsons[it.id]}
                    onClick={() => {
                      onPick(jsons[it.id]);
                      onUrl('');
                    }}
                    className="absolute inset-0 flex flex-col"
                    aria-label={`Use ${it.name}`}
                  >
                    <span className="flex-1 min-h-0 flex items-center justify-center p-1.5 pointer-events-none">
                      <Thumb json={jsons[it.id] || null} play={hover === it.id || on} />
                    </span>
                    <span className="block w-full truncate px-1.5 pb-1.5 text-[10.5px] font-semibold text-slate-700 text-center">{it.name}</span>
                  </button>
                  {on && (
                    <span className="absolute top-1.5 left-1.5 w-5 h-5 rounded-full bg-[color:var(--g-accent,#7F00FF)] text-white flex items-center justify-center">
                      <Check className="w-3 h-3" />
                    </span>
                  )}
                  {canManage && (
                    <button
                      type="button"
                      onClick={() => void remove(it)}
                      className="absolute top-1.5 right-1.5 w-6 h-6 rounded-full bg-white/90 text-rose-600 flex items-center justify-center opacity-0 group-hover:opacity-100 focus:opacity-100"
                      aria-label={`Remove ${it.name} from the library`}
                    >
                      <Trash2 className="w-3 h-3" />
                    </button>
                  )}
                </div>
              );
            })}
            {canManage && (
              <button
                type="button"
                onClick={() => fileInput.current?.click()}
                className="aspect-square rounded-2xl border-2 border-dashed border-violet-200 bg-gradient-to-br from-violet-50/80 to-sky-50/60 flex flex-col items-center justify-center gap-1 text-[11px] font-bold text-violet-700 hover:border-violet-400"
              >
                <Upload className="w-4 h-4" /> Import .json
              </button>
            )}
          </div>
          {items === null && <p className="text-[11px] text-slate-400">Loading the library…</p>}
          {items && items.length === 0 && (
            <p className="text-[11px] text-slate-500">
              The library is empty.{canManage ? ' Import a Lottie .json to keep it here for every notice.' : ' Someone with "Animation library (add / remove)" can import some.'}
            </p>
          )}

          {adding && (
            <div className="flex flex-wrap items-center gap-2 rounded-2xl bg-white border border-violet-100 p-2.5">
              <span className="w-12 h-12 rounded-xl bg-violet-50 overflow-hidden shrink-0">
                <Thumb json={adding.json} play />
              </span>
              <input
                value={adding.name}
                onChange={(e) => setAdding({ ...adding, name: e.target.value })}
                maxLength={120}
                placeholder="Name, e.g. Eid Mubarak"
                className="flex-1 min-w-[140px] px-3 py-2 rounded-xl border border-slate-200 bg-white text-sm"
              />
              <button type="button" onClick={() => setAdding(null)} className="px-3 py-2 rounded-full text-xs font-semibold text-slate-600">
                Cancel
              </button>
              <button type="button" disabled={busy || !adding.name.trim()} onClick={() => void save()} className="liquid-glass-button rounded-full px-4 py-2 text-xs font-semibold inline-flex items-center gap-1 disabled:opacity-50">
                {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Plus className="w-3.5 h-3.5" />} Add to library
              </button>
            </div>
          )}

          <div>
            <button type="button" onClick={() => setPaste(!paste)} className="text-[11.5px] font-semibold text-violet-700 inline-flex items-center gap-1">
              <ChevronRight className={`w-3.5 h-3.5 transition-transform ${paste ? 'rotate-90' : ''}`} /> Paste an animation or give a link instead
            </button>
            {paste && (
              <div className="grid sm:grid-cols-2 gap-2 mt-2">
                <textarea
                  value={custom ? value : ''}
                  onChange={(e) => {
                    onPick(e.target.value);
                    if (e.target.value) onUrl('');
                  }}
                  rows={3}
                  placeholder='Paste Lottie JSON {"v":"5.7.0",…}'
                  className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs font-mono"
                />
                <input
                  value={url}
                  onChange={(e) => {
                    onUrl(e.target.value);
                    if (e.target.value) onPick('');
                  }}
                  placeholder="or a link to one: https://…/animation.json"
                  className="px-3 py-2 rounded-xl border border-slate-200 bg-white text-xs"
                />
              </div>
            )}
          </div>
        </div>
      )}
      <input
        ref={fileInput}
        type="file"
        accept=".json,application/json"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          e.target.value = '';
          if (f) void pickFile(f);
        }}
      />
    </div>
  );
};
