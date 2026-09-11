/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React from 'react';
import { Lottie } from 'lottie-react';
import infinityLoaderAnimation from '../assets/infinity-loader.json';

interface AppLoaderProps {
  label?: string;
  minHeight?: string | number;
  size?: number;
}

// Shared app-wide loading indicator — same component/bundle for both the
// web build and the Capacitor mobile app (APK), so it's "the app's loader"
// on both. Renders the Infinity Lottie animation in place of the old CSS
// spin-ring.
//
// NOTE: this only covers loading states that happen AFTER React has
// mounted (Suspense fallbacks, in-panel data fetches, etc.) — Lottie is a
// JS library, so it can't render before the JS bundle itself has finished
// downloading/parsing. The very first, JS-free boot spinner in index.html
// (shown the instant the HTML arrives, before any JS has run) has to stay
// a plain CSS ring for that reason — swapping it to Lottie would remove
// the "shows before the bundle even starts downloading" property it exists
// for.
export const AppLoader: React.FC<AppLoaderProps> = ({ label = 'Loading…', minHeight = '60vh', size = 96 }) => (
  <div
    style={{
      display: 'flex',
      flexDirection: 'column',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
      minHeight
    }}
  >
    <div style={{ width: size, height: size }}>
      <Lottie src={infinityLoaderAnimation} autoplay loop style={{ width: '100%', height: '100%' }} />
    </div>
    {label && <div style={{ fontSize: 13, color: '#5f6368' }}>{label}</div>}
  </div>
);
