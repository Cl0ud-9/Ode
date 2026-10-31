// How often the page asks whether the song changed. Each ask is a request to the Worker, and a page left open in a tab all
// day would otherwise make 21,600 of them: about a fifth of the free plan's daily budget, taken from the card on a README.
// Someone watching or touching the page gets the fast rate; a page nobody has touched for a while slows right down.
export const FAST_FOR = 2 * 60_000;
export const MEDIUM_FOR = 10 * 60_000;
export const MEDIUM_MS = 10_000;
export const SLEEPY_MS = 30_000;

/** The wait before the next ask: the server's own pace while the page is in use, then slower the longer it has sat untouched. */
export function pollDelay(idleMs, serverMs = 4000) {
  const base = Math.max(4000, Number(serverMs) || 4000);
  if (idleMs < FAST_FOR) return base;
  if (idleMs < MEDIUM_FOR) return Math.max(base, MEDIUM_MS);
  return Math.max(base, SLEEPY_MS);
}
