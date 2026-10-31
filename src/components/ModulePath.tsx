import React from 'react';
import { ChevronLeft } from 'lucide-react';

interface ModulePathProps {
  // e.g. ['Self Service', 'Timesheet'] renders as "Self Service / Timesheet",
  // with the final (current-page) segment styled a bit darker than the rest.
  path: string[];
  // A "‹ Back" on the same row, in place of a Back line of its own under the
  // trail (that took a whole row of empty space on every page).
  onBack?: () => void;
}

// Small breadcrumb-style trail shown above a page's own header,
// so it's always clear which module a page belongs to (mirrors the classic
// ERP "Self Service > Timesheet" module-path pattern). The segments are
// plain text; only the optional Back is clickable.
export const ModulePath: React.FC<ModulePathProps> = ({ path, onBack }) => (
  <div className="flex items-center gap-1.5 text-[11px] text-slate-400 mb-2 select-none min-h-[22px]">
    {onBack && (
      <>
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-0.5 -ml-1 pl-0.5 pr-2 py-0.5 rounded-full text-xs font-medium text-slate-500 hover:text-blue-600 hover:bg-black/5 transition-colors"
        >
          <ChevronLeft className="w-3.5 h-3.5" /> Back
        </button>
        <span className="text-slate-300">|</span>
      </>
    )}
    {path.map((segment, i) => (
      <React.Fragment key={segment}>
        {i > 0 && <span className="text-slate-300">/</span>}
        <span className={i === path.length - 1 ? 'text-slate-500 font-medium' : ''}>{segment}</span>
      </React.Fragment>
    ))}
  </div>
);
