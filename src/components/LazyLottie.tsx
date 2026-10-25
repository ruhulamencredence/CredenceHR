/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { Suspense, lazy } from 'react';
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
