import React from 'react';

interface WelcomeBannerProps {
  title: string;
  subtitle: string;
}

// Violet gradient welcome card with a "drop nose" top edge — a single rounded
// bump rising out of the center of the top edge, per the reference image,
// instead of a plain rounded rectangle. Built as an actual SVG shape (not a
// CSS mask) so it renders identically everywhere, including older Android
// WebViews on the APK build.
export const WelcomeBanner: React.FC<WelcomeBannerProps> = ({ title, subtitle }) => {
  // ViewBox units — the SVG stretches to fill its container (preserveAspectRatio
  //="none"), so only the relative proportions here matter, not literal pixels.
  const W = 400;
  const H = 132;
  const r = 24; // corner radius
  const bumpTopY = 30; // flat top edge level (away from the bump)
  const bumpHalfWidth = 58;
  const bumpCenter = W / 2;
  const x1 = bumpCenter - bumpHalfWidth;
  const x2 = bumpCenter + bumpHalfWidth;

  const path = `
    M0,${bumpTopY + r}
    A${r},${r} 0 0 1 ${r},${bumpTopY}
    L${x1},${bumpTopY}
    C${x1 + 26},${bumpTopY} ${bumpCenter - 34},0 ${bumpCenter},0
    C${bumpCenter + 34},0 ${x2 - 26},${bumpTopY} ${x2},${bumpTopY}
    L${W - r},${bumpTopY}
    A${r},${r} 0 0 1 ${W},${bumpTopY + r}
    L${W},${H - r}
    A${r},${r} 0 0 1 ${W - r},${H}
    L${r},${H}
    A${r},${r} 0 0 1 0,${H - r}
    Z
  `.trim();

  return (
    <div className="relative w-full">
      <svg
        className="absolute inset-0 w-full h-full"
        viewBox={`0 0 ${W} ${H}`}
        preserveAspectRatio="none"
        style={{ filter: 'drop-shadow(0 6px 16px rgba(71,0,142,0.25))' }}
      >
        <defs>
          <linearGradient id="welcomeBannerGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" stopColor="#7F00FF" />
            <stop offset="50%" stopColor="#6300C6" />
            <stop offset="100%" stopColor="#47008E" />
          </linearGradient>
        </defs>
        <path d={path} fill="url(#welcomeBannerGradient)" />
      </svg>
      <div className="relative pt-8 sm:pt-9 px-6 sm:px-8 pb-5 sm:pb-6 text-white">
        <h3 className="text-xl sm:text-2xl font-bold">{title}</h3>
        <p className="mt-1 text-sm text-white/85">{subtitle}</p>
      </div>
    </div>
  );
};
