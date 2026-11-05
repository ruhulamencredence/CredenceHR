/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Is this account a Site Attendance supervisor? (sidebar item / home tile)
// Kept apart from TeamAttendance.tsx so the sidebar and the Home page can ask
// without loading the whole Team Attendance page into the first download.

import { useEffect, useState } from 'react';
import { apiUrl } from './api';

let supervisorCache: { token: string; at: number; value: { teams: number; notSubmitted: number } } | null = null;
// The sidebar and the Home page ask at the same moment: one request.
let inFlight: { token: string; p: Promise<any> } | null = null;

// After a sheet is saved the counts change: ask the server again next time.
export function clearSiteSupervisorCache() {
  supervisorCache = null;
}

export function useSiteSupervisor(token: string) {
  const [value, setValue] = useState(() => (supervisorCache && supervisorCache.token === token ? supervisorCache.value : { teams: 0, notSubmitted: 0 }));
  useEffect(() => {
    if (!token) return;
    if (supervisorCache && supervisorCache.token === token && Date.now() - supervisorCache.at < 60000) {
      setValue(supervisorCache.value);
      return;
    }
    let alive = true;
    if (!inFlight || inFlight.token !== token) {
      const p = fetch(apiUrl('/api/site-attendance/my-teams'), { headers: { Authorization: `Bearer ${token}` } })
        .then((r) => (r.ok ? r.json() : null))
        .finally(() => {
          if (inFlight?.p === p) inFlight = null;
        });
      inFlight = { token, p };
    }
    inFlight.p
      .then((d) => {
        if (!d || !alive) return;
        const teams: any[] = Array.isArray(d.teams) ? d.teams : [];
        const v = { teams: teams.length, notSubmitted: teams.filter((t) => t.members?.length && !t.today?.sheet).length };
        supervisorCache = { token, at: Date.now(), value: v };
        setValue(v);
      })
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, [token]);
  return value;
}
