/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Tutorials — short guided tours over the real screens (GuidedTour.tsx draws
// them, TutorialsSheet.tsx lists them, WelcomeSlidesRoutes.ts keeps which
// ones an account finished and the Superadmin's on/off switch).
//
// Each step points at an element by a CSS selector (mostly `data-tour="…"`
// set on the page itself). A step whose element isn't on the screen — a
// card the account has no access to, a phone-only button on the website —
// is left out, so a tour never shows something the account can't use. A
// whole tour is listed only when the account may open its page.

import { useEffect, useState } from 'react';
import type { User } from '../types';

export type TourSection = null | 'claim' | 'leave' | 'timesheet';

export interface TourStep {
  /** Tried in order; the first one visible on screen is used. None -> a card in the middle. */
  sel?: string[];
  title: string;
  text: string;
}

export interface Tour {
  id: 'dashboard' | 'checkin' | 'leave' | 'timesheet';
  title: string;
  icon: string;
  tint: string;
  section: TourSection;
  can: (u: User) => boolean;
  steps: TourStep[];
}

const su = (u: User) => u.role === 'superadmin';

export const TOURS: Tour[] = [
  {
    id: 'dashboard',
    title: 'Dashboard tour',
    icon: '🏠',
    tint: '#efe7ff',
    section: null,
    can: () => true,
    steps: [
      { title: 'Your Dashboard', text: 'A quick look around. Tap Next, or Skip any time.' },
      { sel: ['[data-tour="dash-greeting"]'], title: 'Today at a glance', text: 'The date, search (Ctrl K) and the quick actions you use most.' },
      { sel: ['[data-tour="dash-attendance"]'], title: 'My Attendance', text: 'Tap Set Now to check in. Your location is saved with it — Out Time works the same way.' },
      { sel: ['[data-tour="dash-leave"]'], title: 'Leave Summary', text: 'How many leave days you have left, and what is waiting for approval. Tap it to open Leave.' },
      { sel: ['[data-tour="dash-tiles"]'], title: 'Shortcuts', text: 'Your most used pages, one tap away.' },
      { sel: ['[data-tour="nav-bar"]'], title: 'Bottom bar', text: 'Home, Check In/Out, Timesheet and Leave are always here.' },
      { sel: ['[data-tour="nav-more"]'], title: 'More', text: 'Everything else you can open — and the Tutorials, to watch this again.' },
      { sel: ['[data-tour="sidebar"]'], title: 'Menu', text: 'Every page you can open is in this menu. Tutorials is under Others.' },
      { sel: ['button[aria-label="Open menu"]'], title: 'Menu', text: 'Tap ⋮ to see every page you can open.' },
      { sel: ['button[aria-label="Alerts"]'], title: 'Alerts', text: 'Approvals, notices and reminders arrive here. You are ready!' }
    ]
  },
  {
    id: 'checkin',
    title: 'Check In / Check Out',
    icon: '🔁',
    tint: '#e6f6ef',
    section: 'claim',
    can: (u) => su(u) || !!u.can_view_movement_claims,
    steps: [
      { title: 'Check In / Check Out', text: 'Going out for office work — a client, a site, the bank? Check in when you get there and out when you leave.' },
      { sel: ['[data-tour="claim-form"]'], title: 'Check in here', text: 'Write the purpose and tap Check In — a map opens with you on it. Your location and time are saved.' },
      { sel: ['[data-tour="claim-add"]'], title: 'Add Check In/Out', text: 'Tap here: a map opens with you on it. Write the purpose and Check In — later the same button checks you out.' },
      { sel: ['[data-tour="claim-list"]'], title: 'Your visits', text: 'Open ones wait for a Check Out; completed ones become your claim and go for approval.' }
    ]
  },
  {
    id: 'leave',
    title: 'Apply for leave',
    icon: '🗓️',
    tint: '#fff1e3',
    section: 'leave',
    can: (u) => su(u) || !!u.can_view_leave_summary || !!u.can_view_leave_application || !!u.can_view_my_leave,
    steps: [
      { sel: ['[data-tour="leave-balance"]'], title: 'Your balance', text: 'Days left for each leave type this year. Tap Submit leave to apply.' },
      { sel: ['[data-tour="leave-tabs"]'], title: 'Follow the approval', text: 'Every application you sent — Review, Approved or Rejected — and where it is now.' },
      { title: 'That’s it', text: 'You get an alert as soon as your leave is approved or rejected.' }
    ]
  },
  {
    id: 'timesheet',
    title: 'Timesheet',
    icon: '⏱️',
    tint: '#e8f1ff',
    section: 'timesheet',
    can: (u) => su(u) || !!u.can_view_timesheet,
    steps: [
      { sel: ['[data-tour="ts-period"]'], title: 'Pick a period', text: 'A month, a day or your own date range.' },
      { sel: ['[data-tour="ts-days"]'], title: 'Every day', text: 'On time, Delay or Absent — tap a day to see its check-ins or ask for a correction.' }
    ]
  }
];

export const toursFor = (u: User | null | undefined) => (u ? TOURS.filter((t) => t.can(u)) : []);

// ---- Shared state: switched on? which ones are done? (App.tsx loads it) ----
type State = { enabled: boolean; done: string[] };
let state: State = { enabled: false, done: [] };
const listeners = new Set<(s: State) => void>();
export const setTutorialsState = (s: Partial<State>) => {
  state = { ...state, ...s };
  listeners.forEach((l) => l(state));
};
export const getTutorialsState = () => state;
export function useTutorialsState(): State {
  const [s, setS] = useState(state);
  useEffect(() => {
    listeners.add(setS);
    setS(state);
    return () => {
      listeners.delete(setS);
    };
  }, []);
  return s;
}

// ---- Events ----
export const OPEN_TUTORIALS_EVENT = 'credence:open-tutorials';
export const START_TOUR_EVENT = 'credence:start-tour';
/** App.tsx: back to the user Dashboard (no Self Service page / profile / chat on top). */
export const TOUR_GO_EVENT = 'credence:tour-go';
/** UserPanel.tsx: open this section of the Dashboard. */
export const TOUR_SECTION_EVENT = 'credence:tour-section';

export const openTutorials = () => window.dispatchEvent(new Event(OPEN_TUTORIALS_EVENT));
export const startTour = (id: Tour['id']) => window.dispatchEvent(new CustomEvent(START_TOUR_EVENT, { detail: id }));

// The section the running tour wants, kept until UserPanel (which may only
// be mounting now, e.g. coming from the Admin Panel) has opened it.
let pendingSection: { section: TourSection } | null = null;
export const requestTourSection = (section: TourSection) => {
  pendingSection = { section };
  window.dispatchEvent(new Event(TOUR_SECTION_EVENT));
};
export const takeTourSection = () => {
  const p = pendingSection;
  pendingSection = null;
  return p;
};
