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

export interface WaveSpec { wavelength: number; harmonic: number; ratio: number; phase: number }

/** Seeded periodic wave: the harmonic is an integer so shifting by one wavelength loops seamlessly. */
export function waveSpec(seed: number, wavelength: number): WaveSpec {
  const rand = rng(seed ^ 0x9e3779b9);
  return {
    wavelength,
    harmonic: 2 + Math.floor(rand() * 2),
    ratio: 0.22 + rand() * 0.22,
    phase: rand() * Math.PI * 2,
  };
}

function waveY(spec: WaveSpec, x: number, amp: number): number {
  const t = (x / spec.wavelength) * Math.PI * 2;
  const v = Math.sin(t + spec.phase) + spec.ratio * Math.sin(spec.harmonic * t + spec.phase * 1.7);
  return (amp * v) / (1 + spec.ratio);
}

/** Open wave line from x0-wavelength to x1+wavelength so it can drift by one wavelength. */
export function wavePath(spec: WaveSpec, x0: number, x1: number, y: number, amp: number): string {
  const step = spec.wavelength / 20;
  const from = x0 - spec.wavelength;
  const to = x1 + spec.wavelength;
  const pts: [number, number][] = [];
  for (let x = from; x <= to + 0.01; x += step) pts.push([x, y + waveY(spec, x - x0, amp)]);
  let d = `M${f(pts[0]![0])} ${f(pts[0]![1])}`;
  for (let i = 1; i < pts.length - 1; i++) {
    const p = pts[i]!, q = pts[i + 1]!;
    d += `Q${f(p[0])} ${f(p[1])} ${f((p[0] + q[0]) / 2)} ${f((p[1] + q[1]) / 2)}`;
  }
  const last = pts[pts.length - 1]!;
  return d + `L${f(last[0])} ${f(last[1])}`;
}

/** Same wave closed down to `bottom`, for filled bands. */
export function waveBand(spec: WaveSpec, x0: number, x1: number, y: number, amp: number, bottom: number): string {
  const line = wavePath(spec, x0, x1, y, amp);
  const from = x0 - spec.wavelength;
  const to = x1 + spec.wavelength;
  return `${line}L${f(to)} ${f(bottom)}L${f(from)} ${f(bottom)}Z`;
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

/** Regular sine line in the style of the Material 3 Expressive wavy indicator; amp 0 gives a flat line. */
export function sineWavePath(x0: number, x1: number, y: number, amp: number, wavelength: number): string {
  // A flat line is exactly the column: the extra wavelength drawn for the drift loop would stick out past both ends.
  if (amp === 0) return `M${f(x0)} ${f(y)}L${f(x1)} ${f(y)}`;
  return wavePath({ wavelength, harmonic: 2, ratio: 0, phase: 0 }, x0, x1, y, amp);
}
