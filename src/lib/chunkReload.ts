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

// Vite fires this when a chunk's preload fails.
export function installChunkReload() {
  window.addEventListener('vite:preloadError', (e) => {
    if (reloadForNewVersion()) e.preventDefault();
  });
}

// lazy(() => import(...)) that retries once, then reloads for a new version.
export function retryImport<T>(load: () => Promise<T>): () => Promise<T> {
  return () =>
    load().catch(
      (err) =>
        new Promise<T>((resolve, reject) => {
          setTimeout(() => {
            load()
              .then(resolve)
              .catch((err2) => {
                if (isChunkLoadError(err2) && reloadForNewVersion()) return; // page is reloading
                reject(err2 || err);
              });
          }, 600);
        })
    );
}
