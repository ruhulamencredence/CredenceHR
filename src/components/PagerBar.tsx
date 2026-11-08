import React from 'react';

// "1–50 of 9,326 · [50 / page] Prev  Page 2 / 187  Next" — for lists the server pages.
export const PagerBar: React.FC<{
  page: number;
  pageSize: number;
  total: number;
  onPage: (page: number) => void;
  onPageSize: (size: number) => void;
}> = ({ page, pageSize, total, onPage, onPageSize }) => {
  if (total <= 0) return null;
  const pages = Math.max(1, Math.ceil(total / pageSize));
  const btn = 'px-3 py-1 rounded-lg border border-slate-200 bg-white hover:bg-slate-50 disabled:opacity-40';
  return (
    <div className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 border-t border-slate-200 text-xs text-slate-600">
      <span>
        {(page - 1) * pageSize + 1}–{Math.min(page * pageSize, total)} of {total.toLocaleString()}
      </span>
      <div className="flex items-center gap-2">
        <select value={pageSize} onChange={(e) => onPageSize(Number(e.target.value))} className="border border-slate-200 rounded-lg px-2 py-1 bg-white" aria-label="Rows per page">
          {[25, 50, 100, 200].map((n) => (
            <option key={n} value={n}>
              {n} / page
            </option>
          ))}
        </select>
        <button type="button" disabled={page <= 1} onClick={() => onPage(page - 1)} className={btn}>
          Prev
        </button>
        <span>
          Page {page} / {pages}
        </span>
        <button type="button" disabled={page >= pages} onClick={() => onPage(page + 1)} className={btn}>
          Next
        </button>
      </div>
    </div>
  );
};
