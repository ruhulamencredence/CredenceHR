import React from 'react';

interface ModulePathProps {
  // e.g. ['Self Service', 'Timesheet'] renders as "Self Service / Timesheet",
  // with the final (current-page) segment styled a bit darker than the rest.
  path: string[];
}

// Small breadcrumb-style trail shown above a page's own header/Back button,
// so it's always clear which module a page belongs to (mirrors the classic
// ERP "Self Service > Timesheet" module-path pattern). Purely presentational
// — not a navigation control, so no click handlers on the segments.
export const ModulePath: React.FC<ModulePathProps> = ({ path }) => (
  <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-2 select-none">
    {path.map((segment, i) => (
      <React.Fragment key={segment}>
        {i > 0 && <span className="text-slate-300">/</span>}
        <span className={i === path.length - 1 ? 'text-slate-500 font-medium' : ''}>{segment}</span>
      </React.Fragment>
    ))}
  </div>
);
