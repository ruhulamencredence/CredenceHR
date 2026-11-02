// Profile photo rules (Design B, three steps), shown before a new profile
// photo is picked — a new photo only goes up once the Superadmin approves it
// (profileRoutes.ts), so people see first which photos get approved and
// which are rejected:
//   1. what a good photo looks like,
//   2. what gets rejected (tap one for the reason),
//   3. confirm it is their own clear, recent photo, then Take photo (front
//      camera) or Choose from gallery.
// The liquid-glass sheet of the house style (CLAUDE.md -> Popup style).
import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Camera, ImageIcon, X } from 'lucide-react';
import { useBackButtonClose } from '../lib/useBackButtonClose';

// One person drawing (200×200), with the "wrong" variants built on it.
function person(o: { bg?: string; skin?: string; hair?: string; shirt?: string; extra?: string } = {}) {
  const { bg = '#dff3ea', skin = '#f1c7a3', hair = '#2b2118', shirt = '#1e3a8a', extra = '' } = o;
  return `<rect width="200" height="200" fill="${bg}"/>
    <path d="M44 200c4-38 28-58 56-58s52 20 56 58z" fill="${shirt}"/>
    <path d="M86 140l14 18 14-18z" fill="#fff"/>
    <rect x="88" y="118" width="24" height="24" rx="8" fill="${skin}"/>
    <ellipse cx="100" cy="88" rx="34" ry="40" fill="${skin}"/>
    <path d="M66 84c0-26 16-42 34-42s34 14 34 40c-8-12-20-18-34-18s-26 8-34 20z" fill="${hair}"/>
    <circle cx="88" cy="92" r="3.2" fill="#1f2937"/><circle cx="112" cy="92" r="3.2" fill="#1f2937"/>
    <path d="M90 110q10 7 20 0" stroke="#9a5b3c" stroke-width="3" fill="none" stroke-linecap="round"/>${extra}`;
}
const GOOD = person();
// The same reasons the Superadmin picks from when rejecting (ProfilePhotoRequestsPopup.tsx).
export const PHOTO_REJECT_REASONS: { title: string; why: string; svg: string }[] = [
  {
    title: 'সানগ্লাস / মাস্ক / ক্যাপ',
    why: 'মুখ ঢাকা থাকলে চেনা যায় না — সানগ্লাস, মাস্ক, ক্যাপ ছাড়া ছবি দিন।',
    svg: person({ bg: '#fde68a', shirt: '#7c2d12', extra: '<rect x="74" y="84" width="22" height="13" rx="6" fill="#111"/><rect x="104" y="84" width="22" height="13" rx="6" fill="#111"/><rect x="96" y="88" width="8" height="3" fill="#111"/><path d="M60 62q40-40 80 0v6H60z" fill="#dc2626"/><rect x="56" y="64" width="96" height="8" rx="4" fill="#b91c1c"/>' })
  },
  {
    title: 'গ্রুপ / অন্য কেউ',
    why: 'ছবিতে শুধু আপনি থাকবেন — গ্রুপ, অন্য কারও, শিশু বা পোষা প্রাণীসহ ছবি নয়।',
    svg: `<rect width="200" height="200" fill="#ede9fe"/><g transform="translate(-48 18) scale(.8)">${person({ bg: 'none', shirt: '#6d28d9' })}</g><g transform="translate(88 18) scale(.8)">${person({ bg: 'none', shirt: '#0f766e', skin: '#e0ac86', hair: '#4b2e1e' })}</g><g transform="translate(20 4) scale(.8)">${person({ bg: 'none', shirt: '#be123c', skin: '#f5d0b0' })}</g>`
  },
  {
    title: 'ঝাপসা / অন্ধকার',
    why: 'ঝাপসা বা অন্ধকারে মুখ বোঝা যায় না — ভালো আলোয়, ফোকাস করে তুলুন।',
    svg: `<defs><filter id="prs-blur"><feGaussianBlur stdDeviation="7"/></filter></defs><g filter="url(#prs-blur)" opacity=".75">${person({ bg: '#475569', shirt: '#1f2937', skin: '#a87b5d' })}</g>`
  },
  {
    title: 'ফুল / প্রকৃতি / লোগো',
    why: 'প্রকৃতি, ফুল, গাড়ি, লোগো, কার্টুন বা সেলিব্রিটির ছবি প্রোফাইল ছবি নয় — নিজের ছবি দিন।',
    svg: '<rect width="200" height="200" fill="#bbf7d0"/><path d="M0 150q50-40 100 0t100 0v50H0z" fill="#4ade80"/><g fill="#f472b6"><circle cx="100" cy="62" r="22"/><circle cx="138" cy="100" r="22"/><circle cx="100" cy="138" r="22"/><circle cx="62" cy="100" r="22"/></g><circle cx="100" cy="100" r="18" fill="#facc15"/>'
  },
  {
    title: 'ফিল্টার / স্টিকার',
    why: 'ফিল্টার, স্টিকার, ইমোজি বা কানের মতো সাজ দিলে আসল চেহারা দেখা যায় না।',
    svg: person({ bg: '#fbcfe8', shirt: '#be185d', extra: '<path d="M70 58l12-30 14 26zM104 54l14-26 12 30z" fill="#f472b6"/><circle cx="76" cy="104" r="7" fill="#fda4af" opacity=".8"/><circle cx="124" cy="104" r="7" fill="#fda4af" opacity=".8"/>' })
  },
  {
    title: 'অনেক দূর থেকে',
    why: 'অনেক দূর থেকে তোলা ছবিতে মুখ খুব ছোট — কাঁধ পর্যন্ত, কাছ থেকে তুলুন।',
    svg: `<rect width="200" height="200" fill="#e0f2fe"/><path d="M0 150l55-60 45 45 30-30 70 65v30H0z" fill="#94a3b8"/><circle cx="160" cy="44" r="16" fill="#fde047"/><g transform="translate(78 108) scale(.22)">${person({ bg: 'none' })}</g>`
  },
  {
    title: 'লেখা / ফ্রেম',
    why: 'ছবির ওপর লেখা, তারিখ, ওয়াটারমার্ক বা ফ্রেম থাকলে বাতিল হবে — সাধারণ ছবি দিন।',
    svg: ''
  },
  {
    title: 'পুরনো ছবি',
    why: 'অনেক পুরনো বা ছোটবেলার ছবি নয় — গত ১ বছরের মধ্যে তোলা ছবি দিন।',
    svg: ''
  }
];
const SHOWN = PHOTO_REJECT_REASONS.slice(0, 6);
const svgOf = (inner: string) => ({ __html: `<svg viewBox="0 0 200 200" width="100%" height="100%" preserveAspectRatio="xMidYMid slice">${inner}</svg>` });

const TICKS: [string, string][] = [
  ['☺', 'শুধু আপনি, মুখ সোজা'],
  ['☀', 'ভালো আলো, পরিষ্কার'],
  ['▢', 'হালকা এক রঙের পেছন'],
  ['👔', 'অফিসের উপযোগী পোশাক']
];

export const PhotoRulesSheet: React.FC<{ open: boolean; onClose: () => void; onPick: (file: File) => void }> = ({ open, onClose, onPick }) => {
  const [step, setStep] = useState(0);
  const [agreed, setAgreed] = useState(false);
  const [why, setWhy] = useState<number | null>(null);
  const cameraRef = useRef<HTMLInputElement>(null);
  const galleryRef = useRef<HTMLInputElement>(null);
  useBackButtonClose(open, onClose);
  useEffect(() => {
    if (!open) return;
    setStep(0);
    setAgreed(false);
    setWhy(null);
    const onKey = (e: KeyboardEvent) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open, onClose]);
  if (!open) return null;

  const picked = (e: React.ChangeEvent<HTMLInputElement>) => {
    const f = e.target.files?.[0];
    e.target.value = '';
    if (f) onPick(f);
  };
  const stepNames = ['ভালো ছবি কেমন', 'এগুলো বাতিল হবে', 'নিশ্চিত করুন'];

  const sheet = (
    <>
      <div className="fixed inset-0 z-[95] liquid-glass-backdrop" onClick={onClose} aria-hidden="true" />
      <div className="fixed inset-x-0 bottom-0 sm:inset-0 z-[96] flex items-end sm:items-center justify-center p-2 sm:p-4 pointer-events-none">
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Profile photo rules"
          className="pointer-events-auto liquid-glass liquid-glass-in rounded-[32px] w-full max-w-md max-h-[92dvh] flex flex-col overflow-hidden"
        >
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
            <p className="text-center text-[11px] font-bold tracking-wide text-violet-700 mt-1.5">ধাপ {['১', '২', '৩'][step]} / ৩</p>
            <h3 className="text-center text-lg font-bold text-slate-900 mt-0.5">{stepNames[step]}</h3>
          </div>

          <div className="flex-1 min-h-0 overflow-y-auto px-4 pb-2 pt-1">
            {step === 0 && (
              <>
                <p className="text-center text-xs text-slate-500 mb-3">নতুন ছবি Superadmin দেখে অনুমোদন দিলে তবেই বসবে — এমন ছবি দিলে সহজে অনুমোদন হয়</p>
                <div className="relative w-40 h-40 mx-auto mb-4 rounded-full overflow-hidden shadow-[0_18px_40px_-18px_rgba(91,33,182,0.8)]" dangerouslySetInnerHTML={svgOf(GOOD)} />
                <div className="grid grid-cols-2 gap-2">
                  {TICKS.map(([icon, text]) => (
                    <div key={text} className="liquid-glass-inset rounded-2xl px-2.5 py-2.5 flex items-center gap-2 text-xs font-semibold text-slate-700">
                      <span className="w-7 h-7 rounded-lg bg-emerald-100 text-emerald-700 flex items-center justify-center shrink-0">{icon}</span>
                      {text}
                    </div>
                  ))}
                </div>
              </>
            )}
            {step === 1 && (
              <>
                <p className="text-center text-xs text-slate-500 mb-3">ছবিতে চাপলে কারণ দেখাবে</p>
                <div className="grid grid-cols-3 gap-2.5">
                  {SHOWN.map((r, i) => (
                    <button
                      key={r.title}
                      type="button"
                      onClick={() => setWhy(i)}
                      aria-pressed={why === i}
                      className={`relative rounded-2xl bg-white/80 p-1.5 text-center ${why === i ? 'ring-2 ring-rose-500' : 'shadow-sm'}`}
                    >
                      <span className="relative block aspect-square rounded-xl overflow-hidden">
                        <span className="block w-full h-full" dangerouslySetInnerHTML={svgOf(r.svg)} />
                        <span className="absolute inset-0" style={{ background: 'linear-gradient(135deg, transparent 47%, rgba(244,63,94,.8) 47%, rgba(244,63,94,.8) 53%, transparent 53%)' }} />
                      </span>
                      <span className="block text-[10.5px] font-semibold text-slate-700 mt-1 leading-tight">{r.title}</span>
                    </button>
                  ))}
                </div>
                <p className="mt-3 rounded-2xl bg-rose-50 text-rose-800 text-xs px-3 py-2 min-h-[38px]">
                  {why == null ? '✕ যেকোনো ছবিতে চাপুন' : `✕ ${SHOWN[why].why}`}
                </p>
                <p className="mt-2 text-[11px] text-slate-500">আরও বাতিল হবে: ছবির ওপর লেখা / ফ্রেম / ওয়াটারমার্ক, আর অনেক পুরনো বা ছোটবেলার ছবি।</p>
              </>
            )}
            {step === 2 && (
              <>
                <p className="text-center text-xs text-slate-500 mb-3">তারপর ছবি তুলুন বা গ্যালারি থেকে বাছুন</p>
                <div className="liquid-glass-inset rounded-3xl p-3 flex items-center gap-3 mb-3">
                  <span className="w-14 h-14 rounded-full overflow-hidden shrink-0" dangerouslySetInnerHTML={svgOf(GOOD)} />
                  <p className="text-xs text-slate-600">নতুন ছবি Superadmin দেখবেন। অনুমোদন হলে বসবে, না হলে কারণসহ জানানো হবে — ততক্ষণ আগের ছবিই থাকবে।</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={agreed}
                  onClick={() => setAgreed((v) => !v)}
                  className={`w-full flex items-center justify-between gap-3 rounded-2xl border-[1.5px] px-3.5 py-3 text-left ${agreed ? 'border-violet-300 bg-violet-50/70' : 'border-slate-200 bg-white/60'}`}
                >
                  <span className="text-[13px] font-semibold text-slate-800">এটা আমার নিজের পরিষ্কার ও সাম্প্রতিক (১ বছরের মধ্যে) ছবি</span>
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
                    পেছনে
                  </button>
                )}
                <button type="button" onClick={() => setStep(step + 1)} className="liquid-glass-button rounded-full flex-1 py-3 text-sm font-semibold">
                  পরের ধাপ →
                </button>
              </div>
            ) : (
              <div className="grid grid-cols-[auto_1fr_1fr] gap-2">
                <button type="button" onClick={() => setStep(1)} className="liquid-glass-chip rounded-full px-3 py-3 text-sm font-semibold text-slate-600">
                  পেছনে
                </button>
                <button type="button" disabled={!agreed} onClick={() => cameraRef.current?.click()} className="rounded-full py-3 text-sm font-semibold bg-violet-100 text-violet-800 inline-flex items-center justify-center gap-1.5 disabled:opacity-45">
                  <Camera className="w-4 h-4" /> ছবি তুলুন
                </button>
                <button type="button" disabled={!agreed} onClick={() => galleryRef.current?.click()} className="liquid-glass-button rounded-full py-3 text-sm font-semibold inline-flex items-center justify-center gap-1.5 disabled:opacity-45">
                  <ImageIcon className="w-4 h-4" /> গ্যালারি থেকে
                </button>
              </div>
            )}
            <p className="text-center text-[11px] text-slate-500 mt-2">
              {step < 2 ? '৩টা ছোট ধাপ' : agreed ? 'এবার ছবি তুলুন বা বাছুন' : 'আগে ওপরের সুইচটা চালু করুন'}
            </p>
            <input ref={cameraRef} type="file" accept="image/jpeg,image/png" capture="user" className="hidden" onChange={picked} />
            <input ref={galleryRef} type="file" accept="image/jpeg,image/png" className="hidden" onChange={picked} />
          </div>
        </div>
      </div>
    </>
  );
  return createPortal(sheet, document.body);
};
