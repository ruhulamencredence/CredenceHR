/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// lottie-react's Lottie and LottieLight loaded on their own, without its index
// that bundles every player (aliases in vite.config.ts, used by LazyLottie.tsx).
declare module 'lottie-react/full' {
  export { Lottie } from 'lottie-react';
}
declare module 'lottie-react/light' {
  export { LottieLight } from 'lottie-react';
}
