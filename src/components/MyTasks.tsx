/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Self Service -> My Tasks (TaskRoutes.ts): tasks given to me, my requests to
// HR (salary certificate, experience letter…), and — for a department head —
// tasks given to my team, plus their repeating tasks. Shown only to accounts
// with users.can_view_tasks (Module Access) or the task_management module.

import React, { useCallback, useEffect, useState } from 'react';
import { Capacitor } from '@capacitor/core';
import { ArrowLeft, ClipboardList, Plus, Send } from 'lucide-react';
import { User } from '../types';
import { ModulePath } from './ModulePath';
import { Spinner } from './Spinner';
import { api, NewTaskForm, RecurrenceList, RequestToHrForm, Task, TaskAccess, TaskCard, TaskDrawer, takePendingTaskId } from './TaskParts';

type Tab = 'assigned' | 'requested' | 'team' | 'repeat';

export const MyTasks: React.FC<{ token: string; user: User; onBack?: () => void }> = ({ token, user, onBack }) => {
  const isNativeApp = Capacitor.isNativePlatform();
  const [access, setAccess] = useState<TaskAccess | null>(null);
  const [data, setData] = useState<{ assigned: Task[]; requested: Task[]; team: Task[] } | null>(null);
  const [error, setError] = useState('');
  const [tab, setTab] = useState<Tab>('assigned');
  const [showDone, setShowDone] = useState(false);
  const [openId, setOpenId] = useState<number | null>(() => takePendingTaskId());
  const [newTask, setNewTask] = useState(false);
  const [newRequest, setNewRequest] = useState(false);
  const [repeatKey, setRepeatKey] = useState(0);

  const load = useCallback(() => {
    api(token, '/api/tasks/mine')
      .then(setData)
      .catch((e) => setError(e.message));
  }, [token]);

  useEffect(() => {
    api<TaskAccess>(token, '/api/tasks/access')
      .then(setAccess)
      .catch((e) => setError(e.message));
    load();
    // An alert for a task, clicked while this page is already open.
    const onOpen = () => {
      const id = takePendingTaskId();
      if (id) setOpenId(id);
      load();
    };
    window.addEventListener('credence:open-task', onOpen);
    return () => window.removeEventListener('credence:open-task', onOpen);
  }, [token, load]);

  const list = data ? (tab === 'assigned' ? data.assigned : tab === 'requested' ? data.requested : tab === 'team' ? data.team : []) : [];
  const active = list.filter((t) => t.status === 'open' || t.status === 'in_progress');
  const finished = list.filter((t) => t.status === 'done' || t.status === 'cancelled');
  const openCount = (l: Task[]) => l.filter((t) => t.status === 'open' || t.status === 'in_progress').length;

  const tabs: { key: Tab; label: string; count?: number }[] = [
    { key: 'assigned', label: 'My Tasks', count: data ? openCount(data.assigned) : undefined },
    { key: 'requested', label: 'My Requests to HR', count: data ? openCount(data.requested) : undefined },
    ...(access?.hod
      ? ([
          { key: 'team', label: 'My Team', count: data ? openCount(data.team) : undefined },
          { key: 'repeat', label: 'Repeating' }
        ] as { key: Tab; label: string; count?: number }[])
      : [])
  ];

  return (
    <div className="w-full min-h-[calc(100vh-4rem)] text-slate-900">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8">
        {!isNativeApp && <ModulePath path={['Self Service', 'My Tasks']} />}
        <div className="flex items-center justify-between gap-3 mb-4 mt-2 flex-wrap">
          <div className="flex items-center gap-2">
            {onBack && (
              <button type="button" onClick={onBack} className="w-9 h-9 shrink-0 rounded-full flex items-center justify-center hover:bg-black/5" aria-label="Back">
                <ArrowLeft className="w-5 h-5 text-slate-500" />
              </button>
            )}
            <h1 className="text-base sm:text-lg font-bold flex items-center gap-2 leading-tight">
              <ClipboardList className="w-5 h-5 text-violet-600 shrink-0" /> My Tasks
            </h1>
          </div>
          <div className="flex items-center gap-2">
            <button type="button" onClick={() => setNewRequest(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-white border border-slate-200 text-slate-700 hover:bg-slate-50">
              <Send className="w-3.5 h-3.5" /> Request to HR
            </button>
            {access?.hod && (
              <button type="button" onClick={() => setNewTask(true)} className="inline-flex items-center gap-1.5 px-3 py-2 rounded-xl text-xs font-semibold bg-violet-600 text-white hover:bg-violet-700">
                <Plus className="w-3.5 h-3.5" /> Give a task
              </button>
            )}
          </div>
        </div>

        <div className="flex gap-1.5 overflow-x-auto pb-1 mb-3">
          {tabs.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => setTab(t.key)}
              className={`shrink-0 px-3.5 py-2 rounded-full text-xs font-semibold ${tab === t.key ? 'bg-violet-600 text-white' : 'bg-white text-slate-600 border border-slate-200'}`}
            >
              {t.label}
              {!!t.count && <span className={`ml-1.5 px-1.5 rounded-full ${tab === t.key ? 'bg-white/25' : 'bg-violet-100 text-violet-700'}`}>{t.count}</span>}
            </button>
          ))}
        </div>
        {access?.hod && tab === 'team' && <p className="text-[11px] text-slate-500 mb-2">Tasks you gave to {access.departments.join(', ')}.</p>}

        {error && <p className="text-sm text-rose-600">{error}</p>}
        {tab === 'repeat' ? (
          <RecurrenceList token={token} scope="team" reloadKey={repeatKey} />
        ) : !data ? (
          <div className="py-10 flex justify-center">
            <Spinner size={24} />
          </div>
        ) : (
          <>
            <div className="space-y-2">
              {active.length === 0 && (
                <p className="text-sm text-slate-500 py-8 text-center">
                  {tab === 'assigned' ? 'No open tasks for you. 🎉' : tab === 'requested' ? 'No open requests. Tap “Request to HR” to ask for an ID card, visiting card or something else (salary certificate, NOC and similar letters: My Letters).' : 'No open tasks for your team.'}
                </p>
              )}
              {active.map((t) => (
                <TaskCard key={t.id} task={t} onOpen={() => setOpenId(t.id)} showAssignees={tab !== 'assigned'} showCreator={tab !== 'requested'} />
              ))}
            </div>
            {finished.length > 0 && (
              <div className="mt-5">
                <button type="button" onClick={() => setShowDone((v) => !v)} className="text-xs font-semibold text-slate-500 hover:text-slate-700">
                  {showDone ? 'Hide' : 'Show'} finished ({finished.length})
                </button>
                {showDone && (
                  <div className="space-y-2 mt-2 opacity-90">
                    {finished.map((t) => (
                      <TaskCard key={t.id} task={t} onOpen={() => setOpenId(t.id)} showAssignees={tab !== 'assigned'} showCreator={tab !== 'requested'} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
      </div>

      {openId && <TaskDrawer token={token} taskId={openId} meId={user.id} onClose={() => setOpenId(null)} onChanged={load} />}
      {newTask && access && (
        <NewTaskForm
          token={token}
          categories={access.categories}
          asHod
          onClose={() => setNewTask(false)}
          onSaved={(repeat) => {
            setNewTask(false);
            setTab(repeat ? 'repeat' : 'team');
            setRepeatKey((k) => k + 1);
            load();
          }}
        />
      )}
      {newRequest && access && (
        <RequestToHrForm
          token={token}
          types={access.request_types}
          onClose={() => setNewRequest(false)}
          onSaved={() => {
            setNewRequest(false);
            setTab('requested');
            load();
          }}
        />
      )}
    </div>
  );
};
