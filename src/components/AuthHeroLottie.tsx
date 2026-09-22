import React from 'react';
import { Lottie } from 'lottie-react';
import authHeroAnimation from '../assets/team-hierarchy.json';

// Split out from AuthScreen.tsx and loaded via React.lazy() there so the
// (fairly heavy) lottie-react library + this JSON animation are their own
// chunk, fetched/parsed AFTER the login form itself has already painted —
// instead of blocking the very first paint the boot spinner is covering for.
// Purely decorative, so a brief blank box while this chunk loads (see the
// Suspense fallback in AuthScreen.tsx) is not a problem.
const AuthHeroLottie: React.FC<{ className?: string }> = ({ className }) => (
  <Lottie src={authHeroAnimation} autoplay loop className={className} />
);

export default AuthHeroLottie;
