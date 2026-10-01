/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useId } from 'react';
import { pushBackHandler, popBackHandler } from './backButtonStack';

// Makes the Android hardware back button close THIS modal/drill-down (instead
// of exiting the whole app) while it's open. Drop this one line into any
// component that shows a dismissible overlay:
//
//   useBackButtonClose(isEditModalOpen, () => setIsEditModalOpen(false));
//
// Works no-op on the web build too (the underlying listener in App.tsx simply
// never fires there), so it's always safe to add.
export function useBackButtonClose(isOpen: boolean, onClose: () => void): void {
  const id = useId();

  useEffect(() => {
    if (!isOpen) return;
    pushBackHandler(id, onClose);
    return () => popBackHandler(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isOpen, id]);
}
