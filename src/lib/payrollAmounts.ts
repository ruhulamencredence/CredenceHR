/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Payroll's "See salary amounts" permission on screen. The server already
// hides every amount ("*****", payrollAmountMask.ts) for an account without
// it; this makes every Payroll formatter print ***** too — for a hidden value
// and for anything the screen adds up itself (a total of hidden values would
// otherwise read ৳0).
import { useEffect, useState } from 'react';
import { apiUrl } from './api';

export const AMOUNT_MASK = '*****';

let hidden: boolean | null = null; // null = not known yet
const listeners = new Set<() => void>();

export function setPayrollAmountsHidden(v: boolean) {
  if (hidden === v) return;
  hidden = v;
  listeners.forEach((l) => l());
}

/** True when this account may not see Payroll amounts (or a value came back hidden). */
export const amountsHidden = (v?: unknown) => v === AMOUNT_MASK || hidden === true;

/**
 * Wraps a Payroll money formatter: a hidden value, or any value while the
 * account can't see amounts, prints *****.
 */
export function maskMoney<A extends unknown[]>(fmt: (v: any, ...rest: A) => string) {
  return (v: any, ...rest: A): string => (amountsHidden(v) ? AMOUNT_MASK : fmt(v, ...rest));
}

/**
 * Asks the server once (per sign-in) whether this account sees amounts, and
 * re-renders when that is known. Call it at the top of each Payroll screen.
 */
let asked: string | null = null;
export function usePayrollAmounts(token: string | null | undefined): boolean {
  const [, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    if (token && asked !== token) {
      asked = token;
      fetch(apiUrl('/api/payroll/approval-access'), { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .then((d) => d && setPayrollAmountsHidden(!d.salary_amounts))
        .catch(() => undefined);
    }
    return () => {
      listeners.delete(l);
    };
  }, [token]);
  return hidden !== true;
}
