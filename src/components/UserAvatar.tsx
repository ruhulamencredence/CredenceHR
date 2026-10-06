/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// One avatar for every place that shows a person: their uploaded profile photo
// (Self Service -> Personal Data, GET /api/profile/photo/:userId), or the
// coloured initials circle while it loads / when they have none.
//
// Photos are fetched once per person and shared by every avatar on screen
// (cache + in-flight dedup), so a list of 50 rows costs 50 requests at most
// the first time, none afterwards. After someone uploads a new photo,
// App.tsx calls refreshAvatars() so every avatar updates at once.

import React, { useEffect, useState } from 'react';
import { apiUrl } from '../lib/api';

const AVATAR_PALETTE = ['#7F00FF', '#059669', '#0891b2', '#d97706', '#dc2626', '#4f46e5', '#be185d', '#0d9488'];

export function avatarColorFor(seed: string): string {
  let hash = 0;
  for (let i = 0; i < seed.length; i++) hash = (hash * 31 + seed.charCodeAt(i)) >>> 0;
  return AVATAR_PALETTE[hash % AVATAR_PALETTE.length];
}

export function initialsFor(name: string): string {
  const parts = (name || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return '?';
  return (parts[0][0] + (parts[1]?.[0] || '')).toUpperCase();
}

const urlCache = new Map<number, string | null>();
const inflight = new Map<number, Promise<string | null>>();
const listeners = new Set<() => void>();

function fetchPhoto(userId: number, token: string): Promise<string | null> {
  if (urlCache.has(userId)) return Promise.resolve(urlCache.get(userId)!);
  const running = inflight.get(userId);
  if (running) return running;
  const p = (async () => {
    try {
      const res = await fetch(apiUrl(`/api/profile/photo/${userId}`), { headers: { Authorization: `Bearer ${token}` } });
      if (!res.ok) {
        // 404 = no photo yet. Other errors (offline, 5xx) aren't cached so the next render retries.
        if (res.status === 404) urlCache.set(userId, null);
        return null;
      }
      const url = URL.createObjectURL(await res.blob());
      urlCache.set(userId, url);
      return url;
    } catch {
      return null;
    } finally {
      inflight.delete(userId);
    }
  })();
  inflight.set(userId, p);
  return p;
}

/** Forget every cached photo and tell mounted avatars to load again (after an upload, sign-out or account switch). */
export function refreshAvatars(): void {
  for (const u of urlCache.values()) if (u) URL.revokeObjectURL(u);
  urlCache.clear();
  listeners.forEach((l) => l());
}

export function useUserPhoto(userId: number | null | undefined, token: string | null | undefined): string | null {
  const [version, bump] = useState(0);
  useEffect(() => {
    const l = () => bump((n) => n + 1);
    listeners.add(l);
    return () => {
      listeners.delete(l);
    };
  }, []);
  useEffect(() => {
    if (!userId || !token || urlCache.has(userId)) return;
    let cancelled = false;
    fetchPhoto(userId, token).then(() => {
      // Only re-render when something was cached (a failed fetch must not loop).
      if (!cancelled && urlCache.has(userId)) bump((n) => n + 1);
    });
    return () => {
      cancelled = true;
    };
  }, [userId, token, version]);
  return userId ? urlCache.get(userId) ?? null : null;
}

function readToken(): string | null {
  try {
    return localStorage.getItem('mpr_token');
  } catch {
    return null;
  }
}

interface UserAvatarProps {
  userId?: number | null;
  name: string;
  /** Size + text size, e.g. "w-8 h-8 text-[11px]". */
  className?: string;
  /** Background of the initials circle; default is a colour picked from the name. */
  color?: string;
  style?: React.CSSProperties;
  /** Shown instead of the initials when there is no photo (e.g. a group icon). */
  fallback?: React.ReactNode;
  token?: string | null;
}

export const UserAvatar: React.FC<UserAvatarProps> = ({ userId, name, className = 'w-8 h-8 text-[11px]', color, style, fallback, token }) => {
  const photo = useUserPhoto(userId, token ?? readToken());
  if (photo) {
    return <img src={photo} alt={name} className={`${className} rounded-full object-cover shrink-0`} style={style} />;
  }
  return (
    <span
      className={`${className} rounded-full flex items-center justify-center font-bold text-white shrink-0`}
      style={{ background: color || avatarColorFor(name || ''), ...style }}
    >
      {fallback ?? initialsFor(name)}
    </span>
  );
};

export default UserAvatar;
