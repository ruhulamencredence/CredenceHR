import React from 'react';

// Wraps a handler that closes over frequently-changing state (e.g. entries,
// editingEntryId) so the FUNCTION IDENTITY handed down to memoized child
// components stays stable across renders, while it always calls the latest
// version internally via a ref. Without this, every keystroke anywhere in a
// component would hand its list-row children a brand-new function prop each
// render, defeating React.memo and forcing every row (not just the one being
// interacted with) to re-render on every keystroke.
export function useStableCallback<T extends (...args: any[]) => any>(fn: T): T {
  const ref = React.useRef(fn);
  ref.current = fn;
  return React.useCallback(((...args: any[]) => ref.current(...args)) as T, []);
}
