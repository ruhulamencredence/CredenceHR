/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Loading placeholders for the Self Service pages, in each page's own shape,
// so a page shows ONE placeholder from the tap until its data is there:
//
//   - App.tsx shows <SelfPageSkeleton view=…> while a page's code downloads
//     (was the generic AppLoader: a purple header, four stat tiles and big
//     blocks no Self Service page has). It also puts the page's name in the
//     phone header at once, so the header doesn't jump from the logo to the
//     page name when the code arrives.
//   - UserPanel's bottom-bar pages (Check In/Out, Timesheet, Leave…) show
//     <SelfBodySkeleton shape=…> there (was the infinity loader).
//   - The pages themselves show the same shape while their data loads
//     (Timesheet, Payroll, Approve Application, Break Time), so the code ->
//     data step is the same picture.
//
// Kept free of heavy imports — App.tsx loads it with the app shell.

import React from 'react';
import { LoadingBlock } from './LoadingBlock';
import { usePhoneHeaderTitle } from '../lib/headerPageTitle';

export type SkeletonShape = 'list' | 'requests' | 'timesheet' | 'timesheetDays' | 'payroll' | 'status' | 'leave';

const Bar: React.FC<{ className: string }> = ({ className }) => <div className={`rounded bg-slate-200/80 ${className}`} />;
const Card: React.FC<{ className?: string; children: React.ReactNode }> = ({ className = '', children }) => (
  <div className={`rounded-3xl border border-slate-200/80 bg-white/80 ${className}`}>{children}</div>
);

// Timesheet: month switcher, the attendance gauge card, then day cards.
// `timesheetDays` leaves out the month switcher — the page shows the real
// one above while its days load.
const TimesheetBody: React.FC<{ period: boolean }> = ({ period }) => (
  <div className="space-y-3">
    {period && <div className="h-12 rounded-full bg-white/80 border border-slate-200/80 flex items-center justify-between px-3">
      <div className="w-7 h-7 rounded-full bg-slate-200/80" />
      <div className="space-y-1.5 flex flex-col items-center">
        <Bar className="h-3 w-28" />
        <Bar className="h-2 w-16 bg-slate-200/60" />
      </div>
      <div className="w-7 h-7 rounded-full bg-slate-200/60" />
    </div>}
    <Card className="p-5 flex flex-col items-center gap-3">
      <div className="w-36 h-[72px] rounded-t-full border-[12px] border-b-0 border-slate-200/80" />
      <Bar className="h-2.5 w-32 bg-slate-200/60" />
      <div className="w-full grid grid-cols-4 gap-2 pt-1">
        {[0, 1, 2, 3].map((i) => (
          <div key={i} className="flex flex-col items-center gap-1.5">
            <Bar className="h-3 w-6" />
            <Bar className="h-2 w-10 bg-slate-200/60" />
          </div>
        ))}
      </div>
    </Card>
    <Bar className="h-3.5 w-20 mt-2" />
    {[0, 1, 2, 3].map((i) => (
      <Card key={i} className="p-3.5 flex items-center gap-3">
        <div className="w-9 h-9 rounded-full bg-slate-200/80 shrink-0" />
        <div className="flex-1 space-y-2">
          <Bar className={`h-3 ${i % 2 ? 'w-24' : 'w-28'}`} />
          <Bar className="h-2.5 w-20 bg-slate-200/60" />
        </div>
        <div className="w-2 h-3 rounded bg-slate-200/60" />
      </Card>
    ))}
  </div>
);

// Payroll dashboard: 2 x 2 money tiles, then the trend chart card.
const PayrollBody = () => (
  <div className="space-y-3">
    <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
      {[0, 1, 2, 3].map((i) => (
        <div key={i} className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 flex gap-3">
          <div className="w-9 h-9 rounded-xl bg-slate-200/80 shrink-0" />
          <div className="flex-1 space-y-2">
            <Bar className="h-2.5 w-3/4 bg-slate-200/60" />
            <Bar className="h-4 w-1/2" />
            <Bar className="h-2 w-2/3 bg-slate-200/60" />
          </div>
        </div>
      ))}
    </div>
    <div className="rounded-2xl border border-slate-200/80 bg-white/80 p-4 space-y-3">
      <Bar className="h-3.5 w-48" />
      <div className="h-40 flex items-end gap-3 px-2">
        {[40, 65, 50, 80, 60, 90].map((h, i) => (
          <div key={i} className="flex-1 rounded-t-md bg-slate-200/70" style={{ height: `${h}%` }} />
        ))}
      </div>
    </div>
  </div>
);

// Approve Application: request cards — who, what, a remark box, buttons.
const RequestsBody = () => (
  <div className="space-y-3 p-1">
    {[0, 1, 2].map((i) => (
      <Card key={i} className="p-4 space-y-3">
        <div className="flex gap-3">
          <div className="w-9 h-9 rounded-full bg-slate-200/80 shrink-0" />
          <div className="flex-1 space-y-2">
            <Bar className={`h-3 ${i % 2 ? 'w-1/2' : 'w-2/3'}`} />
            <Bar className="h-2.5 w-full bg-slate-200/60" />
            <Bar className="h-2.5 w-3/5 bg-slate-200/60" />
          </div>
        </div>
        <div className="h-8 rounded-xl bg-slate-200/50" />
        <div className="flex gap-2">
          <div className="h-8 w-20 rounded-lg bg-slate-200/60" />
          <div className="h-8 w-24 rounded-lg bg-slate-200/80" />
        </div>
      </Card>
    ))}
  </div>
);

// Break Time: the status card (label, note box, round button), then today.
const StatusBody = () => (
  <div className="space-y-4">
    <Card className="p-5 flex flex-col items-center gap-3">
      <Bar className="h-2.5 w-28 bg-slate-200/60" />
      <div className="h-9 w-full max-w-sm rounded-xl bg-slate-200/50" />
      <div className="h-11 w-36 rounded-full bg-slate-200/80" />
    </Card>
    <Card className="p-4 space-y-3">
      <div className="flex justify-between">
        <Bar className="h-3 w-14" />
        <Bar className="h-3 w-20" />
      </div>
      <div className="h-2 rounded-full bg-slate-200/60" />
      <div className="flex justify-between">
        <Bar className="h-2.5 w-16 bg-slate-200/60" />
        <Bar className="h-2.5 w-16 bg-slate-200/60" />
      </div>
    </Card>
  </div>
);

// Leave (phone): the balance gauge with Submit leave, the three tabs, a card.
const LeaveBody = () => (
  <div className="space-y-3">
    <Card className="p-5 flex flex-col items-center gap-3">
      <div className="w-32 h-16 rounded-t-full border-[10px] border-b-0 border-slate-200/80" />
      <Bar className="h-2.5 w-28 bg-slate-200/60" />
      <div className="w-full grid grid-cols-3 gap-2">
        {[0, 1, 2].map((i) => (
          <div key={i} className="flex flex-col items-center gap-1.5">
            <Bar className="h-3 w-5" />
            <Bar className="h-2 w-10 bg-slate-200/60" />
          </div>
        ))}
      </div>
      <div className="h-11 w-full rounded-full bg-slate-200/80" />
    </Card>
    <div className="h-[50px] rounded-full bg-white/75 border border-slate-200/80 grid grid-cols-3 gap-1 p-[5px]">
      <div className="rounded-full bg-slate-200/70" />
      <div />
      <div />
    </div>
    <Card className="p-6 flex flex-col items-center gap-2">
      <Bar className="h-3 w-40 bg-slate-200/60" />
      <Bar className="h-2.5 w-52 bg-slate-200/50" />
    </Card>
  </div>
);

/** The body of a Self Service page while it loads, in that page's shape. */
export const SelfBodySkeleton: React.FC<{ shape?: SkeletonShape; className?: string }> = ({ shape = 'list', className = '' }) =>
  shape === 'list' ? (
    <LoadingBlock className={className} />
  ) : (
    <div className={`animate-pulse ${className}`} role="status" aria-label="Loading">
      {shape === 'timesheet' || shape === 'timesheetDays' ? <TimesheetBody period={shape === 'timesheet'} /> : shape === 'payroll' ? <PayrollBody /> : shape === 'requests' ? <RequestsBody /> : shape === 'status' ? <StatusBody /> : <LeaveBody />}
    </div>
  );

// Each Self Service page (App.tsx's selfServiceView): the name it puts in the
// phone header (only where the page itself does — the same text, so nothing
// changes when it arrives) and the shape of its body.
const SELF_PAGES: Record<string, { title?: string; shape: SkeletonShape }> = {
  leaveManagement: { shape: 'list' },
  timesheet: { title: 'Timesheet', shape: 'timesheet' },
  approveApplications: { title: 'Approve Application', shape: 'requests' },
  payroll: { shape: 'payroll' },
  employeeDirectory: { title: 'Employee Directory', shape: 'list' },
  resignation: { title: 'My Resignation', shape: 'list' },
  assetManagement: { title: 'My Asset', shape: 'list' },
  vehicleManagement: { title: 'Book a Ride', shape: 'list' },
  myCases: { title: 'Grievance & Disciplinary', shape: 'list' },
  myLetters: { title: 'My Letters & Service Record', shape: 'list' },
  teamAttendance: { shape: 'list' },
  myTasks: { title: 'My Tasks', shape: 'list' },
  myMobileSim: { title: 'My Mobile SIM', shape: 'list' },
  myLoans: { title: 'My Loan / Advance', shape: 'list' },
  myTargets: { title: 'My Targets', shape: 'list' },
  credenceMail: { title: 'Credence Mail', shape: 'list' },
  myRoster: { title: 'My Duty Roster', shape: 'list' },
  myBreak: { title: 'Break Time', shape: 'status' },
  mySignatures: { title: 'Documents to Sign', shape: 'list' },
  myPayslips: { title: 'My Payslip', shape: 'list' },
  materialReceive: { shape: 'list' },
  myRequisitions: { title: 'SIM & ID Card', shape: 'list' }
};

/** A whole Self Service page while its code downloads (App.tsx's Suspense). */
export const SelfPageSkeleton: React.FC<{ view: string }> = ({ view }) => {
  const page = SELF_PAGES[view] || { shape: 'list' as SkeletonShape };
  usePhoneHeaderTitle(page.title || '', !!page.title);
  return (
    <div className="w-full min-h-[calc(100vh-4rem)]">
      <div className="w-full px-3 sm:px-6 lg:px-8 pt-3 pb-28 md:pb-8">
        <SelfBodySkeleton shape={page.shape} />
      </div>
    </div>
  );
};
