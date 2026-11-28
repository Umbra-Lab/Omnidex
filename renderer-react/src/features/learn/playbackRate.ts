/**
 * The lesson player's speed, kept across lessons and restarts.
 *
 * Every lesson mounts a fresh <video>, so the speed picked in Chromium's
 * player menu reset to 1x at each lesson. For a course library watched at
 * 1.5x that meant setting it again dozens of times a sitting.
 */
const KEY = 'omnidex.learn.playbackRate';
const MIN = 0.25;
const MAX = 4;

export function readPlaybackRate(): number {
  try {
    const n = Number(window.localStorage.getItem(KEY));
    return Number.isFinite(n) && n >= MIN && n <= MAX ? n : 1;
  } catch {
    return 1;
  }
}

export function savePlaybackRate(rate: number): void {
  if (!Number.isFinite(rate) || rate < MIN || rate > MAX) return;
  try {
    if (rate === 1) window.localStorage.removeItem(KEY);
    else window.localStorage.setItem(KEY, String(rate));
  } catch {
    // Storage can be unavailable; the speed just won't carry over.
  }
}
