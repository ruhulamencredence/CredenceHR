/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy, useEffect, useState } from 'react';
import { retryImport } from '../lib/chunkReload';

// lottie-react (≈750 KB with its player) loads only when an animation is
// first shown, instead of with the app's first download. Same props as
// lottie-react's Lottie / LottieLight; until the player arrives the box keeps
// its size and stays empty.
type LottieProps = React.ComponentProps<typeof import('lottie-react')['Lottie']>;
type LottieLightProps = React.ComponentProps<typeof import('lottie-react')['LottieLight']>;

const LottieFull = lazy(retryImport(() => import('lottie-react').then((m) => ({ default: m.Lottie }))));
const LottieSmall = lazy(retryImport(() => import('lottie-react').then((m) => ({ default: m.LottieLight }))));

const Placeholder: React.FC<{ className?: string; style?: React.CSSProperties }> = ({ className, style }) => (
  <span className={className} style={{ display: 'inline-block', ...style }} />
);

export const Lottie: React.FC<LottieProps> = (props) => (
  <Suspense fallback={<Placeholder className={(props as any).className} style={(props as any).style} />}>
    <LottieFull {...props} />
  </Suspense>
);

export const LottieLight: React.FC<LottieLightProps> = (props) => (
  <Suspense fallback={<Placeholder className={(props as any).className} style={(props as any).style} />}>
    <LottieSmall {...props} />
  </Suspense>
);

// An animation's JSON fetched on its own (not inside the page's code): the
// card shows at once, its animation a moment later. Big animations (100–300
// KB each) made the Home page's first download heavy on phones.
const jsonCache = new Map<() => Promise<any>, any>();
export function useLottieJson(load: () => Promise<{ default: any }>, enabled = true): any {
  const [data, setData] = useState<any>(() => jsonCache.get(load) || null);
  useEffect(() => {
    if (data || !enabled) return;
    let alive = true;
    load()
      .then((m) => {
        jsonCache.set(load, m.default);
        if (alive) setData(m.default);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [load, data, enabled]);
  return data;
}
