// Warm the browser cache with art the next screens are about to draw.
//
// Every thumbnail renders `loading="lazy"` (ui/gameComponents.js Img), so an operator card whose art is still cold
// shows the placeholder until the image approaches the viewport. In the native shells the art already sits inside
// the package, so lazy loading only costs a visible pop-in: the card is drawn, then the picture replaces the
// placeholder a frame or two later. Queueing the operator art of the room's content set while the player reads the
// briefing fills the cache before the battlefield opens the shop and the deploy bar.
//
// Best effort only: duplicates, failures and a missing manifest are ignored, nothing here blocks a screen, and no
// image is kept alive after it loads (the HTTP cache holds the bytes).

import { chessAvatarUrl, chessPortraitUrl } from './ui/assetUrls.js';

const MAX_PARALLEL = 4;
const MAX_URLS = 240;

const seen = new Set();
const queue = [];
let active = 0;

function pump() {
  while (active < MAX_PARALLEL && queue.length) {
    const url = queue.shift();
    active += 1;
    const done = () => {
      active = Math.max(0, active - 1);
      pump();
    };
    try {
      const img = new Image();
      img.decoding = 'async';
      img.onload = done;
      img.onerror = done;
      img.src = url;
    } catch {
      done();
    }
  }
}

/** Queue `urls` (strings) for a cache warm-up; returns how many were newly queued. */
export function preloadArt(urls, { max = MAX_URLS } = {}) {
  const added = [];
  for (const raw of urls || []) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (!url || seen.has(url)) continue;
    seen.add(url);
    added.push(url);
    if (added.length >= max) break;
  }
  queue.push(...added);
  pump();
  return added.length;
}

/** Queue the avatar and the portrait of every chess in `chessList` (the room's content set). */
export function preloadChessArt(m, chessList, { max = MAX_URLS } = {}) {
  const urls = [];
  for (const chess of chessList || []) {
    if (!chess) continue;
    urls.push(chessAvatarUrl(m, chess), chessPortraitUrl(m, chess));
  }
  return preloadArt(urls, { max });
}

/** Test/diagnostics hook: forget every queued URL (the running queue keeps draining). */
export function resetPreloadQueue() {
  seen.clear();
  queue.length = 0;
  active = 0;
}
