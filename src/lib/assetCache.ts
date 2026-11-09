/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

// Keeps big, never-changing files (the login screen's animation) on the
// device in the browser's Cache Storage, so they are downloaded once and then
// shown with no network at all: on the website, a phone's browser, the
// "Add to Home screen" app and the Android app (its WebView) alike.
//
// - Keyed by the file's address, which carries a hash of its content
//   (Vite: …/office-illustration-AbC123.json). A changed file has a new
//   address, so it is fetched again; the old copy is then deleted.
// - Cache Storage, unlike the ordinary HTTP cache, is not thrown away when
//   the browser needs room for other sites' files.
// - Where Cache Storage is missing (an old browser, plain http) or fails, the
//   file is simply fetched — the HTTP cache (a year, immutable) still helps.
// - Only static app files go here, never anything from /api.

const CACHE_NAME = 'credence-static-v1';

const cacheStorage = (): CacheStorage | null => {
  try {
    return typeof caches !== 'undefined' && window.isSecureContext ? caches : null;
  } catch {
    return null;
  }
};

// Older copies of the same file (same name before the hash) are removed.
// Vite's build hash is 8 characters: office-illustration-AbC1_x-9.json.
const baseName = (url: string) => url.replace(/[?#].*$/, '').replace(/^.*\//, '').replace(/-[A-Za-z0-9_-]{8}(\.[a-z0-9]+)$/i, '$1');

async function fromCache(url: string): Promise<Response | null> {
  const cs = cacheStorage();
  if (!cs) return null;
  try {
    const c = await cs.open(CACHE_NAME);
    return (await c.match(url)) || null;
  } catch {
    return null;
  }
}

async function store(url: string, res: Response): Promise<void> {
  const cs = cacheStorage();
  if (!cs) return;
  try {
    const c = await cs.open(CACHE_NAME);
    await c.put(url, res);
    const name = baseName(url);
    const abs = new URL(url, window.location.href).href;
    for (const req of await c.keys()) {
      if (req.url !== abs && baseName(req.url) === name) await c.delete(req);
    }
  } catch {
    // full or unavailable — next time it is fetched again
  }
}

// One request per file at a time (the login screen draws the animation in
// two places, phone and desktop layouts, which ask at once).
const inFlight = new Map<string, Promise<any>>();

/** The JSON at `url` — from the device if kept there, else fetched (and kept). */
export function cachedJson(url: string): Promise<any> {
  let p = inFlight.get(url);
  if (!p) {
    p = loadJson(url).finally(() => inFlight.delete(url));
    inFlight.set(url, p);
  }
  return p;
}

async function loadJson(url: string): Promise<any> {
  const hit = await fromCache(url);
  if (hit) {
    try {
      return await hit.json();
    } catch {
      // damaged copy: fetch it again below
    }
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Could not load ${url}`);
  void store(url, res.clone());
  return res.json();
}

/** Make sure `url` is kept on the device (downloads it once if it isn't). */
export async function keepOnDevice(url: string): Promise<void> {
  if (!cacheStorage() || (await fromCache(url))) return;
  try {
    const res = await fetch(url);
    if (res.ok) await store(url, res);
  } catch {
    // offline — try again another time
  }
}
