// OKLab/OKLCH helpers (Bjorn Ottosson). Used to build Material-style tonal palettes.

export interface Rgb { r: number; g: number; b: number } // 0..255
export interface Lch { l: number; c: number; h: number } // l 0..1, c ~0..0.4, h degrees

const toLin = (v: number) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4);
const fromLin = (v: number) => (v <= 0.0031308 ? v * 12.92 : 1.055 * v ** (1 / 2.4) - 0.055);

export function rgbToLch({ r, g, b }: Rgb): Lch {
  const lr = toLin(r / 255), lg = toLin(g / 255), lb = toLin(b / 255);
  const l = Math.cbrt(0.4122214708 * lr + 0.5363325363 * lg + 0.0514459929 * lb);
  const m = Math.cbrt(0.2119034982 * lr + 0.6806995451 * lg + 0.1073969566 * lb);
  const s = Math.cbrt(0.0883024619 * lr + 0.2817188376 * lg + 0.6299787005 * lb);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const A = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const B = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return { l: L, c: Math.hypot(A, B), h: ((Math.atan2(B, A) * 180) / Math.PI + 360) % 360 };
}

/** Linear (unclamped) sRGB for a given OKLCH colour. */
function lchToLinear({ l, c, h }: Lch): [number, number, number] {
  const a = c * Math.cos((h * Math.PI) / 180);
  const b = c * Math.sin((h * Math.PI) / 180);
  const l_ = (l + 0.3963377774 * a + 0.2158037573 * b) ** 3;
  const m_ = (l - 0.1055613458 * a - 0.0638541728 * b) ** 3;
  const s_ = (l - 0.0894841775 * a - 1.291485548 * b) ** 3;
  return [
    4.0767416621 * l_ - 3.3077115913 * m_ + 0.2309699292 * s_,
    -1.2684380046 * l_ + 2.6097574011 * m_ - 0.3413193965 * s_,
    -0.0041960863 * l_ - 0.7034186147 * m_ + 1.707614701 * s_,
  ];
}

const inGamut = (v: [number, number, number]) => v.every((x) => x >= -0.0005 && x <= 1.0005);

/** Convert, reducing chroma until the colour fits in sRGB. */
export function lchToRgb(color: Lch): Rgb {
  const l = Math.min(1, Math.max(0, color.l));
  let { c } = color;
  let lin = lchToLinear({ l, c, h: color.h });
  if (!inGamut(lin)) {
    let lo = 0, hi = c;
    for (let i = 0; i < 18; i++) {
      const mid = (lo + hi) / 2;
      if (inGamut(lchToLinear({ l, c: mid, h: color.h }))) lo = mid; else hi = mid;
    }
    c = lo;
    lin = lchToLinear({ l, c, h: color.h });
  }
  const ch = (v: number) => Math.round(Math.min(1, Math.max(0, fromLin(Math.min(1, Math.max(0, v))))) * 255);
  return { r: ch(lin[0]), g: ch(lin[1]), b: ch(lin[2]) };
}

export function toHex({ r, g, b }: Rgb): string {
  return "#" + [r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("");
}

export function luminance({ r, g, b }: Rgb): number {
  return 0.2126 * toLin(r / 255) + 0.7152 * toLin(g / 255) + 0.0722 * toLin(b / 255);
}

export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a), lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** Nudge `fg` lightness away from `bg` until the contrast ratio is met. */
export function ensureContrast(fg: Lch, bg: Rgb, min: number): Lch {
  const bgLight = luminance(bg) > 0.4;
  let cur = { ...fg };
  for (let i = 0; i < 60; i++) {
    if (contrast(lchToRgb(cur), bg) >= min) return cur;
    cur = { ...cur, l: bgLight ? cur.l - 0.015 : cur.l + 0.015 };
    if (cur.l <= 0 || cur.l >= 1) break;
  }
  return cur;
}
