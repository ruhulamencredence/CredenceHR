/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useState } from 'react';
import { apiUrl } from './api';

interface EffectiveLeadTime {
  // "YYYY-MM-DD" — the earliest Delivery Date this account may currently pick
  // for this Project/Budget, or null when no Condition Set rule applies (see
  // Admin Panel -> PEPM Manage -> Data Import -> Condition Set). Options
  // strictly before this date should still render (so the picker's full
  // window stays visible — see EmployeeDirectory... no, formatDate.ts's
  // isDateBlockedByLeadTime) but be disabled.
  earliestAllowedDate: string | null;
}

// Reads GET /api/delivery-date-conditions/effective for the given
// condition_type ('entry' — New Job Entry/Add MPR, 'job_edit' — changing an
// existing entry's Delivery Date) + Project/Budget context, re-fetching
// whenever any of those change. Every Delivery Date picker in
// UserPanel.tsx/JobEditPanel.tsx uses this same hook so the "which dates are
// blocked" answer always comes from the one server-side resolver instead of
// being recomputed (and risking drifting out of sync) in N different places.
export function useDeliveryLeadTime(
  token: string,
  conditionType: 'entry' | 'job_edit',
  projectId: number | null | undefined,
  budgetId: number | null | undefined
): EffectiveLeadTime {
  const [earliestAllowedDate, setEarliestAllowedDate] = useState<string | null>(null);

  useEffect(() => {
    if (!projectId && !budgetId) {
      setEarliestAllowedDate(null);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const params = new URLSearchParams({ type: conditionType });
        if (projectId) params.set('project_id', String(projectId));
        if (budgetId) params.set('budget_id', String(budgetId));
        const res = await fetch(apiUrl(`/api/delivery-date-conditions/effective?${params.toString()}`), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok) return;
        const data = await res.json();
        if (!cancelled) setEarliestAllowedDate(data.earliest_date ?? null);
      } catch {
        // Best-effort — a network hiccup here just leaves dates unrestricted
        // client-side for this render; the server enforces the same rule
        // again on submit regardless, so nothing invalid can actually save.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, conditionType, projectId, budgetId]);

  return { earliestAllowedDate };
}
