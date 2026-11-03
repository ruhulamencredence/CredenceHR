/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// A notice's pictures and attachments (NoticeRoutes.ts /api/notices/files):
// fetched with the sign-in token and kept as object URLs for the session;
// uploads shrink big photos first.

import { apiUrl } from './api';
import type { NoticeFile } from '../types';

const cache = new Map<string, Promise<string>>();

export function noticeFileObjectUrl(token: string, url: string): Promise<string> {
  let p = cache.get(url);
  if (!p) {
    p = fetch(apiUrl(url), { headers: { Authorization: `Bearer ${token}` } }).then(async (r) => {
      if (!r.ok) throw new Error('Could not open the file.');
      return URL.createObjectURL(await r.blob());
    });
    p.catch(() => cache.delete(url));
    cache.set(url, p);
  }
  return p;
}

// Saves an attachment (browser download; on the phone app the share sheet).
export async function downloadNoticeFile(token: string, f: NoticeFile): Promise<void> {
  const r = await fetch(apiUrl(f.url), { headers: { Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error('Could not download the file.');
  const blob = await r.blob();
  try {
    const { Capacitor } = await import('@capacitor/core');
    if (Capacitor.isNativePlatform()) {
      const { Filesystem, Directory } = await import('@capacitor/filesystem');
      const { Share } = await import('@capacitor/share');
      const data = await new Promise<string>((res, rej) => {
        const fr = new FileReader();
        fr.onload = () => res(String(fr.result).split(',')[1] || '');
        fr.onerror = rej;
        fr.readAsDataURL(blob);
      });
      const written = await Filesystem.writeFile({ path: f.name, data, directory: Directory.Cache });
      await Share.share({ title: f.name, url: written.uri });
      return;
    }
  } catch {
    // not the phone app — a normal download below
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = f.name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => {
    URL.revokeObjectURL(a.href);
    a.remove();
  }, 1000);
}

// Big photos are made smaller (longest side 1600 px, JPEG/WebP) before they
// go up; GIFs and small pictures go as they are.
async function shrinkImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif' || file.size < 600 * 1024) return file;
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1600 / Math.max(bmp.width, bmp.height));
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const type = file.type === 'image/png' ? 'image/webp' : 'image/jpeg';
    const out = await new Promise<Blob | null>((res) => c.toBlob(res, type, 0.85));
    return out && out.size < file.size ? out : file;
  } catch {
    return file;
  }
}

export async function uploadNoticeFile(token: string, file: File, kind: 'image' | 'file'): Promise<NoticeFile> {
  const body = kind === 'image' ? await shrinkImage(file) : file;
  const type = body.type || file.type || 'application/octet-stream';
  let name = file.name || (kind === 'image' ? 'picture' : 'file');
  if (body !== file && type === 'image/webp') name = name.replace(/\.\w+$/, '') + '.webp';
  if (body !== file && type === 'image/jpeg') name = name.replace(/\.\w+$/, '') + '.jpg';
  const r = await fetch(apiUrl(`/api/notices/files?${new URLSearchParams({ kind, name, type })}`), {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': type },
    body
  });
  const d = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(d.error || (r.status === 413 ? 'The file is too big.' : 'Upload failed.'));
  return { id: d.id, kind: d.kind, name: d.name, mimetype: d.mimetype, size: d.size, url: d.url, role: kind === 'image' ? 'inline' : 'attachment' };
}

export const fileSize = (n: number) => (n >= 1024 * 1024 ? `${(n / 1024 / 1024).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1024))} KB`);
