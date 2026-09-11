/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { useEffect, useRef, useState } from 'react';
import { apiUrl } from './api';

// Fetches this account's own Personal Data profile photo (see
// PersonalDataForm.tsx's own identical loadPhoto()) as an object URL, so
// every avatar spot in the app (Navbar's desktop header, GlobalSidebar's
// mobile drawer) can show the same uploaded photo instead of only initials,
// without each duplicating the fetch/blob/revoke dance.
//
// `version` is a bump-to-refetch signal: App.tsx increments it right after a
// photo upload succeeds in PersonalDataForm (see onPhotoUpdated), so the
// header/drawer avatar updates immediately instead of only after the next
// full page reload.
//
// Returns null (caller falls back to showing initials) when there's no photo
// yet, the account is logged out, offline, or the request fails.
export function useProfilePhoto(token: string, version: number = 0): string | null {
  const [photoUrl, setPhotoUrl] = useState<string | null>(null);
  const objectUrlRef = useRef<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    if (!token) {
      setPhotoUrl(null);
      return;
    }
    (async () => {
      try {
        const res = await fetch(apiUrl('/api/profile/photo'), {
          headers: { Authorization: `Bearer ${token}` }
        });
        if (!res.ok || cancelled) return;
        const blob = await res.blob();
        const url = URL.createObjectURL(blob);
        if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
        objectUrlRef.current = url;
        if (!cancelled) setPhotoUrl(url);
      } catch {
        // No photo yet, or offline — caller's initials fallback stays up.
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [token, version]);

  // Revoke the last object URL on unmount (not on every re-run above — a new
  // fetch already revokes the previous one itself before replacing it).
  useEffect(() => {
    return () => {
      if (objectUrlRef.current) URL.revokeObjectURL(objectUrlRef.current);
    };
  }, []);

  return photoUrl;
}