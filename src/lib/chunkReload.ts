/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// After a new version is deployed, a tab still running the old one asks for
// code files (chunks) that no longer exist; the page then failed to load and
// stayed white. Here: reload once to pick up the new version (at most once a
// minute, so a real outage can't loop), and let a lazy() page retry instead
// of throwing.

const KEY = 'chr_chunk_reload_at';

export function isChunkLoadError(err: unknown): boolean {
  const msg = String((err as any)?.message || err || '');
  return /Failed to fetch dynamically imported module|Importing a module script failed|error loading dynamically imported module|Loading chunk [\w-]+ failed|ChunkLoadError|Unable to preload CSS/i.test(msg);
}

// True when it reloaded (the caller should then render nothing more).
export function reloadForNewVersion(): boolean {
  try {
    const last = Number(sessionStorage.getItem(KEY) || 0);
    if (Date.now() - last < 60_000) return false;
    sessionStorage.setItem(KEY, String(Date.now()));
  } catch {
    // storage unavailable — still reload once
  }
  window.location.reload();
  return true;
}

// A chunk also fails to load when the phone simply has no internet. That is
// NOT a new version: reloading then threw the whole app onto the "Can't reach
// the server" page and restarted it (losing an ongoing call, a half-typed
// message…). So first check the server answers at all.
export async function serverReachable(): Promise<boolean> {
  if (typeof navigator !== 'undefined' && navigator.onLine === false) return false;
  try {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 5000);
    // Any answer (even 404) means the server is there.
    await fetch(`/?_ping=${Date.now()}`, { method: 'HEAD', cache: 'no-store', signal: ctl.signal });
    clearTimeout(t);
    return true;
  } catch {
    return false;
  }
}

// Resolves once the network is back and the server answers again.
export function waitUntilReachable(): Promise<void> {
  return new Promise((resolve) => {
    let done = false;
    const check = async () => {
      if (done) return;
      if (await serverReachable()) {
        done = true;
        window.removeEventListener('online', check);
        clearInterval(timer);
        resolve();
      }
    };
    window.addEventListener('online', check);
    const timer = setInterval(check, 5000);
  });
}

// Vite fires this when a chunk's preload fails.
export function installChunkReload() {
  window.addEventListener('vite:preloadError', (e) => {
    // Offline: let the import fail; retryImport waits for the network.
    if (typeof navigator !== 'undefined' && navigator.onLine === false) return;
    if (reloadForNewVersion()) e.preventDefault();
  });
}

// lazy(() => import(...)) that retries once; offline it waits for the
// network and tries again (the page's loader stays up); only when the server
// is reachable and the file is still missing is it a new version -> reload.
export function retryImport<T>(load: () => Promise<T>): () => Promise<T> {
  const attempt = (first: unknown): Promise<T> =>
    new Promise<T>((resolve, reject) => {
      setTimeout(() => {
        load()
          .then(resolve)
          .catch(async (err2) => {
            if (isChunkLoadError(err2) || isChunkLoadError(first)) {
              if (!(await serverReachable())) {
                await waitUntilReachable();
                return attempt(err2).then(resolve, reject);
              }
              if (reloadForNewVersion()) return; // page is reloading
            }
            reject(err2 || first);
          });
      }, 600);
    });
  return () => load().catch((err) => attempt(err));
}
