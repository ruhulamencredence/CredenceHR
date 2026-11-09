/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Admin Dashboard -> "Coming up — next 60 days": the same card as HR
// Operations -> Dashboard (HrRemindersCard.tsx) — probation and contract
// ends, expiring documents, retirements and increments, with the next step
// one click away. Only for accounts with HR Operations and its
// "reminders_receive" layer (the server checks both on every request); for
// anyone else nothing is drawn. onShown tells the dashboard it is up, so the
// shorter "HR Alerts" box isn't shown as well.

import React, { useEffect, useState } from 'react';
import type { User } from '../types';
import { useHrApi, type HrOpsMeta, type HrOpsEmployee } from './HrOpsShared';
import { HrRemindersCard } from './HrRemindersCard';

export const AdminDashboardReminders: React.FC<{
  token: string;
  user: User;
  onNavigate?: (tab: string) => void;
  onShown?: (shown: boolean) => void;
}> = ({ token, user, onNavigate, onShown }) => {
  const api = useHrApi(token);
  const [meta, setMeta] = useState<HrOpsMeta | null>(null);
  const [employees, setEmployees] = useState<HrOpsEmployee[] | null>(null);
  const hasModule = user.role === 'superadmin' || (user.module_permissions || []).includes('hr_operations');

  useEffect(() => {
    if (!hasModule) return;
    let cancelled = false;
    api
      .get<{ reminders_receive: boolean }>('/api/hr-ops/reminders/access')
      .then(async (r) => {
        if (!r.reminders_receive) return;
        const [m, e] = await Promise.all([api.get<HrOpsMeta>('/api/hr-ops/meta'), api.get<HrOpsEmployee[]>('/api/hr-ops/employees')]);
        if (cancelled) return;
        setMeta(m);
        setEmployees(e);
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [api, hasModule]);

  const shown = !!meta && !!employees;
  useEffect(() => {
    onShown?.(shown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shown]);

  if (!meta || !employees) return null;
  return <HrRemindersCard token={token} meta={meta} employees={employees} onOpenEmployee={() => onNavigate?.('hr_operations')} />;
};
