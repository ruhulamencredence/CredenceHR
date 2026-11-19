/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// HR Operations -> Onboarding -> Checklist: the first-day steps done right
// from the checklist — PEPM projects (the Project Access popup), Mobile App
// on, and shortcuts to give a SIM, an ID card and a department team. Each
// shows only for an account allowed to do it (GET
// /api/hr-ops/onboarding/:employeeId/first-day -> can), and each still goes
// through that module's own API and permission. The checklist item ticks
// itself once the step is done (autoDetect, HROperationsRoutes.ts).

import React, { useEffect, useState } from 'react';
import { FolderKanban, Smartphone, Users, CreditCard, Phone } from 'lucide-react';
import { apiUrl } from '../lib/api';
import { ProjectAccessPopup } from './ProjectAccessPopup';
import type { Project, User, UserProjectPermission } from '../types';

export interface FirstDay {
  employee_id: number;
  user_id: number | null;
  name: string;
  projects: string[];
  app_on: boolean;
  team: string | null;
  can: { projects: boolean; mobile_app: boolean; sim: boolean; id_card: boolean; team: boolean };
}

const btn = 'inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg border border-blue-200 bg-blue-50 text-blue-700 text-xs font-semibold hover:bg-blue-100';

// Goes to another Admin Panel page (or another HR Operations tab).
const go = (path: string, hrOpsTab?: string) => {
  try {
    if (hrOpsTab) localStorage.setItem('hr_ops_tab', hrOpsTab);
  } catch {
    // the tab just opens on its default
  }
  window.location.href = path;
};

export function useFirstDay(token: string, employeeId: number | null, reloadKey: number) {
  const [fd, setFd] = useState<FirstDay | null>(null);
  useEffect(() => {
    setFd(null);
    if (!employeeId) return;
    let cancelled = false;
    fetch(apiUrl(`/api/hr-ops/onboarding/${employeeId}/first-day`), { headers: { Authorization: `Bearer ${token}` } })
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => !cancelled && setFd(d))
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [token, employeeId, reloadKey]);
  return fd;
}

export const FirstDayAction: React.FC<{
  token: string;
  taskKey: string;
  fd: FirstDay | null;
  onDone: (text: string) => void;
  onError: (text: string) => void;
}> = ({ token, taskKey, fd, onDone, onError }) => {
  const [popup, setPopup] = useState<{ projects: Project[]; users: User[]; permissions: UserProjectPermission[]; selected: Set<number> } | null>(null);
  const [search, setSearch] = useState('');
  const [busy, setBusy] = useState(false);
  if (!fd) return null;
  const auth = { Authorization: `Bearer ${token}` };

  const openProjects = async () => {
    if (!fd.user_id) return onError('This employee has no login yet.');
    try {
      const [p, u, perms] = await Promise.all(
        ['/api/projects', '/api/users?slim=1', '/api/permissions'].map((path) => fetch(apiUrl(path), { headers: auth }).then((r) => (r.ok ? r.json() : Promise.reject(new Error('You need Users access to give projects.')))))
      );
      const mine = new Set<number>((perms as UserProjectPermission[]).filter((x) => Number(x.user_id) === fd.user_id).map((x) => Number(x.project_id)));
      setPopup({ projects: p, users: u, permissions: perms, selected: mine });
    } catch (e: any) {
      onError(e.message);
    }
  };
  const saveProjects = async () => {
    if (!popup || !fd.user_id) return;
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/users/${fd.user_id}/projects`), {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ project_ids: Array.from(popup.selected) })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not save the projects.');
      setPopup(null);
      onDone(`Projects saved for ${fd.name}.`);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };
  const turnOnApp = async () => {
    if (!fd.user_id) return onError('This employee has no login yet.');
    setBusy(true);
    try {
      const res = await fetch(apiUrl(`/api/users/${fd.user_id}/app-access`), {
        method: 'PUT',
        headers: { ...auth, 'Content-Type': 'application/json' },
        body: JSON.stringify({ can_use_app: true })
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || 'Could not turn the Mobile App on.');
      onDone(`Mobile App turned on for ${fd.name}.`);
    } catch (e: any) {
      onError(e.message);
    } finally {
      setBusy(false);
    }
  };

  if (taskKey === 'pepm_projects' && fd.can.projects && fd.user_id) {
    return (
      <>
        <button type="button" className={btn} onClick={openProjects}>
          <FolderKanban className="w-3.5 h-3.5" /> Give projects
        </button>
        {popup && (
          <ProjectAccessPopup
            user={popup.users.find((u) => Number(u.id) === fd.user_id) || ({ id: fd.user_id, name: fd.name } as User)}
            projects={popup.projects}
            users={popup.users}
            permissions={popup.permissions}
            selected={popup.selected}
            onToggle={(id) =>
              setPopup((p) => {
                if (!p) return p;
                const next = new Set(p.selected);
                if (next.has(id)) next.delete(id);
                else next.add(id);
                return { ...p, selected: next };
              })
            }
            search={search}
            onSearch={setSearch}
            saving={busy}
            onSave={saveProjects}
            onClose={() => setPopup(null)}
          />
        )}
      </>
    );
  }
  if (taskKey === 'mobile_app' && fd.can.mobile_app && fd.user_id && !fd.app_on) {
    return (
      <button type="button" className={btn} disabled={busy} onClick={turnOnApp}>
        <Smartphone className="w-3.5 h-3.5" /> Turn on Mobile App
      </button>
    );
  }
  if (taskKey === 'sim' && fd.can.sim) {
    return (
      <button type="button" className={btn} onClick={() => go('/admin/mobile_bill')} title="SIM & Mobile Bill → a SIM in stock → Give to employee">
        <Phone className="w-3.5 h-3.5" /> Give a SIM
      </button>
    );
  }
  if (taskKey === 'id_card' && fd.can.id_card) {
    return (
      <button type="button" className={btn} onClick={() => go('/admin/hr-operations', 'requisitions')} title="SIM & ID Card Requests">
        <CreditCard className="w-3.5 h-3.5" /> ID card requests
      </button>
    );
  }
  if (taskKey === 'dept_team' && fd.can.team) {
    return (
      <button type="button" className={btn} onClick={() => go('/admin/departments')} title="Departments → Edit → Teams">
        <Users className="w-3.5 h-3.5" /> Department teams
      </button>
    );
  }
  return null;
};
