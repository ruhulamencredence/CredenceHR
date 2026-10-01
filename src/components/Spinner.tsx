/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Lottie } from 'lottie-react';
import infinityLoaderAnimation from '../assets/infinity-loader.json';

interface SpinnerProps {
  // Pixel size — pass the same px value the old Loader2 icon was
  // (w-3=12, w-3.5=14, w-4=16, w-5=20, w-6=24) so it drops into the same
  // spot without changing layout.
  size?: number;
  className?: string;
}

// Small inline "this specific thing is busy" indicator — the Infinity Lottie
// animation at icon size, dropped in wherever a <Loader2 className="animate-spin" />
// used to sit inside a button/row (Delete, Approve, Save, check-in/out, etc.).
// Keeps the same call-site shape as a lucide icon (just size instead of a
// Tailwind width/height className) so every replacement is a 1:1 swap.
export const Spinner: React.FC<SpinnerProps> = ({ size = 16, className }) => (
  <span
    className={className}
    style={{ display: 'inline-block', width: size, height: size, verticalAlign: 'middle', lineHeight: 0 }}
  >
    <Lottie src={infinityLoaderAnimation} autoplay loop style={{ width: '100%', height: '100%' }} />
  </span>
);
