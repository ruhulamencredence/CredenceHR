/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { apiUrl } from './api';
import { BillClaimCategory, USER_CLAIM_CATEGORIES } from '../types';

// Active Bill Claim category names (Bill Claim Policy), for the Admin's claim
// edit forms. Falls back to the starting five while loading or offline.
export function useBillClaimCategoryNames(token: string): string[] {
  const [names, setNames] = useState<string[]>(USER_CLAIM_CATEGORIES);
  useEffect(() => {
    let cancelled = false;
    fetch(apiUrl('/api/bill-claim-categories'), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((rows: BillClaimCategory[] | null) => {
        if (!cancelled && Array.isArray(rows) && rows.length) setNames(rows.filter((c) => c.is_active).map((c) => c.name));
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token]);
  return names;
}
