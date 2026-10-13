import { rng } from "./util.ts";

const f = (n: number) => (Math.round(n * 10) / 10).toString();

/** Rounded "cookie" outline: a circle whose radius ripples with `lobes` soft bumps (curves only, no facets). */
export function scallopPath(cx: number, cy: number, r: number, lobes: number, depth: number, rot = 0): string {
  const n = lobes * 8;
  const pts: [number, number][] = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const rr = r * (1 + depth * Math.cos(lobes * a + rot));
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return smoothClosed(pts);
}

/** Smooth closed path through points (midpoint quadratic smoothing). */
function smoothClosed(pts: [number, number][]): string {
  const n = pts.length;
  const mid = (a: [number, number], b: [number, number]): [number, number] => [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
  const start = mid(pts[n - 1]!, pts[0]!);
  let d = `M${f(start[0])} ${f(start[1])}`;
  for (let i = 0; i < n; i++) {
    const p = pts[i]!;
    const m = mid(p, pts[(i + 1) % n]!);
    d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`;
  }
  return d + "Z";
}

/** Soft organic blob around (cx, cy); `wobble` is the radius variance (0..0.5). */
export function blobPath(cx: number, cy: number, r: number, seed: number, wobble = 0.22, points = 8): string {
  const rand = rng(seed);
  const phase = rand() * Math.PI * 2;
  const pts: [number, number][] = [];
  for (let i = 0; i < points; i++) {
    const a = phase + (i / points) * Math.PI * 2;
    const rr = r * (1 - wobble / 2 + rand() * wobble);
    pts.push([cx + rr * Math.cos(a), cy + rr * Math.sin(a)]);
  }
  return smoothClosed(pts);
}

/** Eighth-note glyph used when there is no album art. Fits roughly a 56x72 box at (x, y). */
export function notePath(x: number, y: number, s = 1): string {
  const p = (dx: number, dy: number) => `${f(x + dx * s)} ${f(y + dy * s)}`;
  return (
    `M${p(18, 0)}L${p(52, 10)}L${p(52, 22)}L${p(26, 14)}L${p(26, 52)}` +
    `C${p(26, 62)} ${p(16, 70)} ${p(8, 70)}C${p(-2, 70)} ${p(-6, 62)} ${p(-4, 55)}` +
    `C${p(-2, 47)} ${p(8, 44)} ${p(18, 47)}Z`
  );
}

export function eqHeights(seed: number, count: number, max: number): number[] {
  const rand = rng(seed ^ 0x51ed270b);
  return Array.from({ length: count }, () => Math.round(max * (0.35 + rand() * 0.65)));
}

/**
 * A pure sine for the Material 3 Expressive wavy progress indicator, from x0 to one wavelength past x1 (room to
 * drift left by a wavelength), plus its arc length per unit of x. Dashes are measured along the curve, so the
 * renderer uses `perX` to turn "up to this x" into a dash length.
 */
export function progressWave(x0: number, x1: number, y: number, amp: number, wavelength: number): { d: string; perX: number } {
  const step = wavelength / 16;
  const to = x1 + wavelength;
  const pts: [number, number][] = [];
  for (let x = x0; x <= to + 0.01; x += step) pts.push([x, y - amp * Math.sin(((x - x0) / wavelength) * Math.PI * 2)]);
  let length = 0;
  for (let i = 1; i < pts.length; i++) length += Math.hypot(pts[i]![0] - pts[i - 1]![0], pts[i]![1] - pts[i - 1]![1]);
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!, q = pts[i + 1]!;
    d += `Q${f(p[0])} ${f(p[1])} ${f((p[0] + q[0]) / 2)} ${f((p[1] + q[1]) / 2)}`;
  }
  const last = pts[pts.length - 1]!;
  return { d: d + `L${f(last[0])} ${f(last[1])}`, perX: length / (pts[pts.length - 1]![0] - x0) };
}
