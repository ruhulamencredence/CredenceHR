// Profile photo rules (three steps), shown before a new profile photo is
// picked — a new photo only goes up once the Superadmin approves it
// (profileRoutes.ts), so people see first which photos get approved and
// which are rejected:
//   1. what a good photo looks like (grey passport-style references),
//   2. what gets rejected (cartoons with a red X — tap one for the reason),
//   3. confirm it is their own clear, recent photo, then Take photo (front
//      camera) or Gallery.
// The liquid-glass sheet of the house style (CLAUDE.md -> Popup style).
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, Check, ImageIcon, X } from 'lucide-react';
import { useBackButtonClose } from '../lib/useBackButtonClose';

// ---- good: grey passport-style references (faceless, flat) ----------------
const REF_FEMALE = `<rect width="200" height="200" fill="#c4c4c4"/>
  <circle cx="100" cy="38" r="22" fill="#6e6e6e"/>
  <path d="M38 200c2-40 30-58 62-58s60 18 62 58z" fill="#f2f2f2"/>
  <path d="M84 132h32v20c0 10-32 10-32 0z" fill="#dcdcdc"/>
  <ellipse cx="100" cy="92" rx="33" ry="42" fill="#ececec"/>
  <path d="M66 92c-2-34 14-52 34-52s36 18 34 52c-4-20-14-32-34-34-20 2-30 14-34 34z" fill="#6e6e6e"/>
  <ellipse cx="66" cy="96" rx="5" ry="8" fill="#e2e2e2"/><ellipse cx="134" cy="96" rx="5" ry="8" fill="#e2e2e2"/>`;
const REF_MALE = `<rect width="200" height="200" fill="#c4c4c4"/>
  <path d="M34 200c2-40 32-60 66-60s64 20 66 60z" fill="#6e6e6e"/>
  <path d="M84 136l16 26 16-26z" fill="#e6e6e6"/><path d="M96 152h8l4 48h-16z" fill="#8a8a8a"/>
  <path d="M78 140l22 22-12 10zM122 140l-22 22 12 10z" fill="#9a9a9a"/>
  <path d="M84 126h32v16c0 10-32 10-32 0z" fill="#dcdcdc"/>
  <ellipse cx="100" cy="88" rx="32" ry="40" fill="#ececec"/>
  <path d="M68 86c-4-30 10-50 34-50 22 0 36 16 32 48-4-12-12-22-24-24-14 6-30 6-42 26z" fill="#6e6e6e"/>
  <ellipse cx="68" cy="92" rx="5" ry="8" fill="#e2e2e2"/><ellipse cx="132" cy="92" rx="5" ry="8" fill="#e2e2e2"/>`;
// ---- rejected: a cartoon on white with a big red X ------------------------
function girl(extra = '', o: { top?: string; hair?: string; skin?: string } = {}) {
  const { top = '#c2410c', hair = '#1f2a37', skin = '#f8d3b5' } = o;
  return `<path d="M58 172c4-26 22-38 42-38s38 12 42 38z" fill="${top}"/>
    <rect x="92" y="118" width="16" height="20" rx="6" fill="${skin}"/>
    <path d="M60 96c0-34 18-54 40-54s40 20 40 54v26c-6-6-10-14-10-24H70c0 10-4 18-10 24z" fill="${hair}"/>
    <ellipse cx="100" cy="94" rx="27" ry="31" fill="${skin}"/>
    <path d="M72 80c4-18 16-26 28-26s26 8 28 26c-10-8-18-10-28-10s-18 2-28 10z" fill="${hair}"/>
    <circle cx="90" cy="96" r="2.6" fill="#111"/><circle cx="110" cy="96" r="2.6" fill="#111"/>
    <path d="M94 108q6 4 12 0" stroke="#b45309" stroke-width="2.4" fill="none" stroke-linecap="round"/>${extra}`;
}
function boy(extra = '', o: { top?: string; hair?: string; skin?: string } = {}) {
  const { top = '#2563eb', hair = '#3b2a1e', skin = '#eebf98' } = o;
  return `<path d="M54 172c4-28 24-40 46-40s42 12 46 40z" fill="${top}"/>
    <path d="M86 132l14 18 14-18z" fill="#fff"/>
    <rect x="91" y="116" width="18" height="20" rx="6" fill="${skin}"/>
    <ellipse cx="100" cy="92" rx="27" ry="31" fill="${skin}"/>
    <ellipse cx="73" cy="96" rx="4" ry="7" fill="${skin}"/><ellipse cx="127" cy="96" rx="4" ry="7" fill="${skin}"/>
    <path d="M72 84c-4-24 10-38 30-38 18 0 32 12 28 36-6-10-14-16-26-16-12 6-22 8-32 18z" fill="${hair}"/>
    <path d="M86 86h10M104 86h10" stroke="${hair}" stroke-width="3" stroke-linecap="round"/>
    <circle cx="91" cy="95" r="2.6" fill="#111"/><circle cx="109" cy="95" r="2.6" fill="#111"/>
    <path d="M93 108q7 4 14 0" stroke="#92400e" stroke-width="2.4" fill="none" stroke-linecap="round"/>${extra}`;
}
const RED_X = '<path d="M14 14L186 186M186 14L14 186" stroke="#ef4444" stroke-width="3.2" stroke-linecap="round"/>';
export const PHOTO_REJECT_REASONS: { title: string; why: string; svg: string }[] = [
  { title: 'Sunglasses / mask / cap', why: 'Your face must be fully visible — no sunglasses, mask, cap, or hand over the face.',
    svg: `<rect width="200" height="200" fill="#fff"/>${boy('<rect x="78" y="88" width="19" height="12" rx="5" fill="#111"/><rect x="103" y="88" width="19" height="12" rx="5" fill="#111"/><rect x="96" y="92" width="8" height="2.5" fill="#111"/><path d="M68 70q32-36 64 0v6H68z" fill="#dc2626"/><rect x="62" y="72" width="80" height="8" rx="4" fill="#b91c1c"/><rect x="118" y="72" width="30" height="7" rx="3" fill="#b91c1c"/>', { top: '#0f766e' })}${RED_X}` },
  { title: 'Group / someone else', why: 'Only you in the photo — no group photos, someone else, children or pets.',
    svg: `<rect width="200" height="200" fill="#fff"/><g transform="translate(-34 18) scale(.78)">${girl('', { top: '#7c3aed' })}</g><g transform="translate(78 18) scale(.78)">${boy('', { top: '#0f766e', skin: '#d9a07a' })}</g><g transform="translate(22 2) scale(.78)">${girl('', { top: '#be123c' })}</g>${RED_X}` },
  { title: 'Blurry / dark', why: 'A blurry or dark photo does not show your face — take it in good light, in focus.',
    svg: `<rect width="200" height="200" fill="#fff"/><defs><filter id="prs-blur"><feGaussianBlur stdDeviation="6"/></filter></defs><g filter="url(#prs-blur)" opacity=".55">${boy('', { top: '#1f2937', skin: '#9c7a62' })}</g>${RED_X}` },
  { title: 'Flowers / nature / logo', why: 'Flowers, nature, cars, logos, cartoons or celebrities are not a profile photo — use a photo of yourself.',
    svg: `<rect width="200" height="200" fill="#fff"/><path d="M40 170q60-50 120 0z" fill="#86efac"/><path d="M100 168V98" stroke="#16a34a" stroke-width="5"/><g fill="#f472b6"><circle cx="100" cy="66" r="15"/><circle cx="124" cy="88" r="15"/><circle cx="100" cy="110" r="15"/><circle cx="76" cy="88" r="15"/></g><circle cx="100" cy="88" r="12" fill="#facc15"/>${RED_X}` },
  { title: 'Filters / stickers', why: 'Filters, stickers, emojis or animal ears hide what you really look like.',
    svg: `<rect width="200" height="200" fill="#fff"/>${girl('<path d="M70 70l8-26 16 20zM106 64l16-20 8 26z" fill="#f472b6"/><circle cx="82" cy="106" r="6" fill="#fda4af" opacity=".8"/><circle cx="118" cy="106" r="6" fill="#fda4af" opacity=".8"/><text x="138" y="70" font-size="22">✨</text>')}${RED_X}` },
  { title: 'Too far away', why: 'Taken from too far, your face is tiny — take it close, from the shoulders up.',
    svg: `<rect width="200" height="200" fill="#fff"/><path d="M20 168l46-56 34 36 24-24 56 44z" fill="#cbd5e1"/><circle cx="150" cy="56" r="13" fill="#fde047"/><g transform="translate(84 120) scale(.18)">${boy()}</g>${RED_X}` },
  { title: 'Text / frame', why: 'No text, dates, watermarks or frames on the photo — use a plain photo.',
    svg: `<rect width="200" height="200" fill="#fff"/><rect x="34" y="30" width="132" height="146" rx="10" fill="none" stroke="#f59e0b" stroke-width="8" stroke-dasharray="14 8"/>${boy('<rect x="56" y="146" width="88" height="20" rx="6" fill="#111c"/><text x="100" y="160" font-size="11" fill="#fff" text-anchor="middle" font-weight="700">HAPPY EID</text>', { top: '#7c3aed' })}${RED_X}` },
  { title: 'Old photo', why: 'No old or childhood photos — use one taken within the last year.',
    svg: `<rect width="200" height="200" fill="#fff"/><defs><filter id="prs-old"><feColorMatrix type="saturate" values=".1"/></filter></defs><rect x="46" y="36" width="108" height="138" fill="#e7d8b8"/><g filter="url(#prs-old)" opacity=".8">${boy()}</g>${RED_X}` }
];

const SHOWN = PHOTO_REJECT_REASONS.slice(0, 6);
const svgOf = (inner: string) => ({ __html: `<svg viewBox="0 0 200 200" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">${inner}</svg>` });
const RULES = ['Only you, face straight', 'Good light, sharp', 'Plain light background', 'Office-appropriate clothes'];
const STEP_TITLES = ['What a good photo looks like', 'These will be rejected', 'Confirm and pick'];

export const PhotoRulesSheet: React.FC<{ open: boolean; onClose: () => void; onPick: (file: File) => void }> = ({ open, onClose, onPick }) => {
  const [step, setStep] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [why, setWhy] = useState<number | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  useBackButtonClose(open, onClose);
  // Start from step 1 each time the sheet OPENS — only then. The parent
  // passes a new onClose on every render it does (alerts, live refresh…),
  // and resetting on that threw people back to step 1 while they were
  // clicking through, so step 3 could never be reached.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setAgreed(false);
    setWhy(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onCloseRef.current();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);
  if (!open) return null;

  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) onPick(f);
  };

  const sheet = (
    <>
      <div className="fixed inset-0 z-[95] liquid-glass-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="fixed inset-x-0 bottom-0 sm:inset-0 z-[96] flex items-end sm:items-center justify-center p-2 sm:p-4 pointer-events-none">
        <div role="dialog" aria-modal="true" aria-label="Profile photo rules" className="pointer-events-auto liquid-glass liquid-glass-in rounded-[32px] w-full max-w-md max-h-[92dvh] flex flex-col overflow-hidden">
          <div className="relative pt-3 px-4">
            <div className="mx-auto w-10 h-1 rounded-full bg-slate-300/80 sm:hidden" />
            <button type="button" onClick={onClose} aria-label="Close" className="liquid-glass-chip absolute right-3 top-3 w-9 h-9 rounded-full flex items-center justify-center text-slate-600">
              <X className="w-4 h-4" />
            </button>
            <div className="flex justify-center gap-1.5 mt-3" aria-hidden="true">
              {[0, 1, 2].map((i) => (
                <span key={i} className={`h-1.5 rounded-full transition-all ${i === step ? 'w-10 bg-violet-600' : 'w-5 bg-slate-200'}`} />
              ))}
            </div>
            <p className="text-center text-[11px] font-bold tracking-wide uppercase text-violet-700 mt-1.5">Step {step + 1} of 3</p>
            <h3 className="text-center text-lg font-bold text-slate-900 mt-0.5">{STEP_TITLES[step]}</h3>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-2 pt-1">
            {step === 0 && (
              <>
                <p className="text-center text-xs text-slate-500 mb-3">A new photo shows only after the Superadmin approves it. Photos like these are approved.</p>
                <div className="grid grid-cols-2 gap-2.5 mb-3">
                  {[REF_FEMALE, REF_MALE].map((ref, i) => (
                    <div key={i} className="relative rounded-2xl overflow-hidden shadow-[0_10px_24px_-16px_rgba(31,41,55,0.9)]">
                      <div className="aspect-square" dangerouslySetInnerHTML={svgOf(ref)} />
                      <span className="absolute right-2 top-2 inline-flex items-center gap-0.5 rounded-full bg-emerald-500 text-white text-[11px] font-bold px-2 py-0.5 border-2 border-white">
                        <Check className="w-3 h-3" /> Good
                      </span>
                    </div>
                  ))}
                </div>
                <div className="grid grid-cols-2 gap-2">
                  {RULES.map((text) => (
                    <div key={text} className="liquid-glass-inset rounded-2xl px-2.5 py-2 flex items-center gap-2 text-xs font-semibold text-slate-700">
                      <span className="w-6 h-6 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">
                        <Check className="w-3.5 h-3.5" />
                      </span>
                      {text}
                    </div>
                  ))}
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <p className="text-center text-xs text-slate-500 mb-3">Tap one to see why</p>
                <div className="grid grid-cols-3 gap-2">
                  {SHOWN.map((r, i) => (
                    <button
                      key={r.title}
                      type="button"
                      onClick={() => setWhy(i)}
                      aria-pressed={why === i}
                      className={`rounded-2xl bg-white p-1.5 text-center border ${why === i ? 'border-rose-500 ring-2 ring-rose-200' : 'border-slate-100'}`}
                    >
                      <span className="block aspect-square" dangerouslySetInnerHTML={svgOf(r.svg)} />
                      <span className="block text-[10.5px] font-semibold text-slate-700 mt-1 leading-tight">{r.title}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-3 rounded-2xl bg-rose-50 text-rose-800 text-xs px-3 py-2 min-h-[38px]">{why == null ? '✕ Tap any example' : `✕ ${SHOWN[why].why}`}</p>
                <p className="mt-2 text-[11px] text-slate-500">Also rejected: text / frames / watermarks on the photo, and old or childhood photos.</p>
              </>
            )}
            {step === 2 && (
              <>
                <p className="text-center text-xs text-slate-500 mb-3">Then take a photo or choose one from your gallery</p>
                <div className="liquid-glass-inset rounded-3xl p-3 flex items-center gap-3 mb-3">
                  <span className="w-14 h-14 rounded-xl overflow-hidden shrink-0" dangerouslySetInnerHTML={svgOf(REF_MALE)} />
                  <p className="text-xs text-slate-600">The Superadmin checks your new photo. If approved it goes up; if not, you'll see why — your current photo stays meanwhile.</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={agreed}
                  onClick={() => setAgreed((v) => !v)}
                  className={`w-full flex items-center justify-between gap-3 rounded-2xl border-[1.5px] px-3.5 py-3 text-left ${agreed ? 'border-violet-300 bg-violet-50/70' : 'border-slate-200 bg-white/60'}`}
                >
                  <span className="text-[13px] font-semibold text-slate-800">This is a clear, recent photo of me (taken within the last year)</span>
                  <span className={`relative w-11 h-6 rounded-full shrink-0 transition-colors ${agreed ? 'bg-violet-600' : 'bg-slate-300'}`}>
                    <span className={`absolute top-0.5 w-5 h-5 rounded-full bg-white shadow transition-all ${agreed ? 'left-[22px]' : 'left-0.5'}`} />
                  </span>
                </button>
              </>
            )}
          </div>

          <div className="px-4 pt-2 pb-4" style={{ paddingBottom: 'max(1rem, var(--native-safe-area-inset-bottom, env(safe-area-inset-bottom, 0px)))' }}>
            {step < 2 ? (
              <div className="flex gap-2">
                {step > 0 && (
                  <button type="button" onClick={() => setStep(step - 1)} className="liquid-glass-chip rounded-full px-4 py-3 text-sm font-semibold text-slate-600">
                    Back
                  </button>
                )}
                <button type="button" onClick={() => setStep(step + 1)} className="liquid-glass-button rounded-full flex-1 py-3 text-sm font-semibold">
                  Next →
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-[auto_1fr_1fr] gap-2">
                <button type="button" onClick={() => setStep(1)} className="liquid-glass-chip rounded-full px-3 py-3 text-sm font-semibold text-slate-600">
                  Back
                </button>
                <button type="button" disabled={!agreed} onClick={() => cameraRef.current?.click()} className="rounded-full py-3 text-sm font-semibold bg-violet-100 text-violet-800 inline-flex items-center justify-center gap-1.5 disabled:opacity-45">
                  <Camera className="w-4 h-4" /> Take photo
                </button>
                <button type="button" disabled={!agreed} onClick={() => galleryRef.current?.click()} className="liquid-glass-button rounded-full py-3 text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-45">
                  <ImageIcon className="w-4 h-4" /> Gallery
                </button>
              </div>
            )}
            <p className="text-center text-[11px] text-slate-500 mt-2">{step < 2 ? '3 short steps' : agreed ? 'Now take a photo or choose one' : 'Turn the switch on first'}</p>
            <input ref={cameraRef} type="file" accept="image/jpeg,image/png" capture="user" className="hidden" onChange={picked} />
            <input ref={galleryRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={picked} />
          </div>
        </div>
      </div>
    </>
  );
  return createPortal(sheet, document.body);
};
