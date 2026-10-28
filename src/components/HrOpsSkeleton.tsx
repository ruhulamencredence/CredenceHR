/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Loading placeholders for HR Operations, in the shapes of the real page so
// nothing jumps when the data arrives:
//   ServiceBookSkeleton — one employee's Service Book (HrOps360.tsx): the
//     header card with photo and figures, the summary tiles, the tab row
//     and two cards.
//   HrOpsBodySkeleton — the body of any HR Operations tab while the page's
//     own data (meta, employees) loads.
//   HrOpsPageSkeleton — the whole page, shown by App.tsx while the Admin
//     Panel's code downloads (it would otherwise be a blank page).
// Kept free of heavy imports: App.tsx loads it with the app shell.

import React from "react";

const Bar: React.FC<{ className: string }> = ({ className }) => (
  <div className={`rounded bg-slate-200/80 ${className}`} />
);

// Fades in quickly (no pause — a blank page first reads as broken).
const DELAYED: React.CSSProperties = {
  animation: "skeleton-in .2s ease both",
};

const CardSkeleton: React.FC<{ rows?: number }> = ({ rows = 4 }) => (
  <div className="rounded-xl border border-slate-200 bg-white">
    <div className="px-4 py-3 border-b border-slate-100">
      <Bar className="h-3.5 w-32" />
    </div>
    <div className="p-4 space-y-3">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="flex items-center gap-3">
          <Bar className="h-3 w-24 bg-slate-100" />
          <Bar className={`h-3 ${i % 2 ? "w-1/3" : "w-1/2"}`} />
        </div>
      ))}
    </div>
  </div>
);

const PickerSkeleton = () => (
  <div className="max-w-md space-y-1.5">
    <Bar className="h-3 w-16 bg-slate-100" />
    <div className="h-10 rounded-lg border border-slate-200 bg-white" />
  </div>
);

export const ServiceBookSkeleton: React.FC<{ withPicker?: boolean }> = ({
  withPicker = false,
}) => (
  <div style={DELAYED} role="status" aria-label="Loading service book">
    <div className="space-y-4 animate-pulse">
      {withPicker && <PickerSkeleton />}
      <div className="rounded-xl border border-slate-200 bg-gradient-to-r from-blue-50/60 to-white p-4">
        <div className="flex flex-wrap items-start gap-4">
          <div className="w-14 h-14 rounded-full bg-slate-200/80 shrink-0" />
          <div className="flex-1 min-w-[200px] space-y-2">
            <Bar className="h-4 w-48" />
            <Bar className="h-3 w-64 max-w-full bg-slate-100" />
            <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3 pt-2">
              {Array.from({ length: 6 }).map((_, i) => (
                <div key={i} className="space-y-1.5">
                  <Bar className="h-2.5 w-14 bg-slate-100" />
                  <Bar className="h-3.5 w-20" />
                </div>
              ))}
            </div>
          </div>
          <div className="flex gap-2">
            <div className="h-8 w-24 rounded-lg bg-slate-200/80" />
            <div className="h-8 w-20 rounded-lg border border-slate-200 bg-white" />
          </div>
        </div>
      </div>
      <div className="grid grid-cols-2 sm:grid-cols-4 xl:grid-cols-8 gap-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <div
            key={i}
            className="rounded-lg border border-slate-200 bg-white px-3 py-2.5 space-y-1.5"
          >
            <Bar className="h-2.5 w-16 bg-slate-100" />
            <Bar className="h-4 w-10" />
          </div>
        ))}
      </div>
      <div className="flex gap-3 border-b border-slate-200 pb-2 overflow-hidden">
        {Array.from({ length: 8 }).map((_, i) => (
          <Bar
            key={i}
            className={`h-3.5 shrink-0 ${
              i === 0 ? "w-20 bg-blue-200/70" : "w-16 bg-slate-100"
            }`}
          />
        ))}
      </div>
      <div className="grid gap-4 lg:grid-cols-2">
        <CardSkeleton rows={5} />
        <CardSkeleton rows={5} />
      </div>
    </div>
  </div>
);

export const HrOpsBodySkeleton: React.FC<{
  tab?: string | null;
  employeeChosen?: boolean;
}> = ({ tab, employeeChosen = false }) => {
  if (tab === "service_book") {
    return employeeChosen ? (
      <ServiceBookSkeleton withPicker />
    ) : (
      <div style={DELAYED} role="status" aria-label="Loading service book">
        <div className="space-y-4 animate-pulse">
          <PickerSkeleton />
          <div className="flex flex-col items-center gap-3 py-14">
            <div className="w-9 h-9 rounded-lg bg-slate-200/80" />
            <Bar className="h-3 w-80 max-w-full bg-slate-100" />
            <Bar className="h-3 w-56 max-w-full bg-slate-100" />
          </div>
        </div>
      </div>
    );
  }
  return (
    <div style={DELAYED} role="status" aria-label="Loading">
      <div className="space-y-4 animate-pulse">
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
          {Array.from({ length: 4 }).map((_, i) => (
            <div
              key={i}
              className="rounded-xl border border-slate-200 bg-white p-4 space-y-2"
            >
              <Bar className="h-2.5 w-20 bg-slate-100" />
              <Bar className="h-5 w-12" />
            </div>
          ))}
        </div>
        <div className="grid gap-4 lg:grid-cols-2">
          <CardSkeleton />
          <CardSkeleton />
        </div>
      </div>
    </div>
  );
};

const storedTab = () => {
  try {
    return sessionStorage.getItem("hr_ops_tab");
  } catch {
    return null;
  }
};

// Same frame as HROperationsPanel inside the Admin Panel's page wrapper.
export const HrOpsPageSkeleton: React.FC = () => (
  <div
    className="w-full px-4 sm:px-6 lg:px-8 pt-3 pb-8 space-y-4 min-h-[calc(100vh-4rem)]"
    style={DELAYED}
  >
    <div className="animate-pulse">
      <Bar className="h-3 w-56 bg-slate-200/70" />
    </div>
    <div className="bg-white rounded-2xl shadow-sm border border-slate-200 overflow-hidden">
      <div className="p-6 pb-0 border-b border-slate-200 animate-pulse">
        <div className="flex items-start gap-3">
          <div className="w-10 h-10 rounded-full bg-blue-50 shrink-0" />
          <div className="space-y-2 flex-1">
            <Bar className="h-4 w-36" />
            <Bar className="h-3 w-full max-w-xl bg-slate-100" />
          </div>
        </div>
        <div className="flex gap-4 mt-5 pb-3 overflow-hidden">
          {Array.from({ length: 8 }).map((_, i) => (
            <Bar key={i} className="h-3.5 w-24 shrink-0 bg-slate-100" />
          ))}
        </div>
      </div>
      <div className="p-6">
        <HrOpsBodySkeleton tab={storedTab()} />
      </div>
    </div>
  </div>
);
