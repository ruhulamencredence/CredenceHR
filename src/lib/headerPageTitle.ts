/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';

// A tiny module-level pub/sub (same pattern as headerSearch.ts, not a React
// Context) so a mobile sub-page like "Select a Budget" can tell Navbar.tsx
// to show its own title in place of the company logo while it's the active
// section — mirroring how EmployeeDirectory swaps the logo for a search
// icon, but for a plain page title instead. Only one page can own this at a
// time, matching the header being a single global singleton.

type Listener = () => void;

let title: string | null = null;
const listeners = new Set<Listener>();

function emit() {
  listeners.forEach((listener) => listener());
}

export function setHeaderPageTitle(next: string | null) {
  if (title !== next) {
    title = next;
    emit();
  }
}

export function useHeaderPageTitle(): string | null {
  const [, forceRerender] = useState(0);
  useEffect(() => {
    const listener = () => forceRerender((n) => n + 1);
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);
  return title;
}

// Phone pages whose header blends into the page: no coloured bar, round
// white buttons, dark title, and a soft glow behind it — the colour picked in
// Profile -> Appearance, else the theme's (Navbar.tsx, index.css .hdr-blend /
// .page-glow, backgroundTheme.ts HEADER_GLOWS).
export const BLENDED_HEADER_TITLES = new Set([
  'Timesheet',
  'My Claims',
  'Leave',
  'My Tasks',
  'My Targets',
  'Approve Application',
  'Documents to Sign',
  'My Duty Roster',
  'Break Time',
  'Conveyance Bill Claim',
  'My Loan / Advance',
  'My Payslip',
  'My Asset',
  'My Mobile SIM',
  'SIM & ID Card',
  'Book a Ride',
  'My Letters & Service Record',
  'Credence Mail',
  'Alerts',
  'Employee Directory',
  'Grievance & Disciplinary',
  'My Resignation'
]);

// A page that puts its own title in the phone header while it's open (the
// title row on the page itself is then hidden on a phone). Desktop shows the
// logo either way — the header's title slot is phone-only.
export function usePhoneHeaderTitle(next: string, active = true) {
  useEffect(() => {
    if (!active) return;
    setHeaderPageTitle(next);
    return () => setHeaderPageTitle(null);
  }, [next, active]);
}
