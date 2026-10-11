/** 32-bit FNV-1a, used to seed deterministic shapes. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** Small deterministic PRNG (mulberry32). */
export function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function esc(s: string): string {
  return s
    // eslint-disable-next-line no-control-regex
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Conservative text width in em. SVG cannot measure its own text and the reader's font is unknown, so these
 * widths are padded: measured against Arial, Segoe UI, Verdana, Tahoma and Calibri, real bold text came out up
 * to ~20% wider than the base table and regular text up to ~7%. Erring wide only costs an early ellipsis.
 */
export function textEm(s: string, mono = false, bold = false): number {
  if (mono) return s.length * 0.6;
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code > 0x2e80) w += 1;
    else if (code >= 0x1f000) w += 1.1; // emoji
    else if ("il.,;:'|!jI ".includes(ch)) w += 0.3;
    else if ("mwMW@%".includes(ch)) w += 0.88;
    else if (ch >= "A" && ch <= "Z") w += 0.68;
    else w += 0.56;
  }
  return w * (bold ? 1.18 : 1.06);
}

export function fit(s: string, maxPx: number, fontPx: number, mono = false, bold = false): string {
  if (textEm(s, mono, bold) * fontPx <= maxPx) return s;
  let out = "";
  for (const ch of s) {
    if (textEm(out + ch + "…", mono, bold) * fontPx > maxPx) break;
    out += ch;
  }
  return out.trimEnd() + "…";
}

/** Greedy word wrap into at most `maxLines` lines; the last line is ellipsised if text remains. */
export function wrapLines(s: string, maxPx: number, fontPx: number, maxLines: number, bold = false): string[] {
  const words = s.split(/\s+/).filter(Boolean);
  const lines: string[] = [];
  let cur = "";
  for (let i = 0; i < words.length; i++) {
    const next = cur ? `${cur} ${words[i]}` : words[i]!;
    if (textEm(next, false, bold) * fontPx <= maxPx || !cur) { cur = next; continue; }
    if (lines.length === maxLines - 1) { cur = [cur, ...words.slice(i)].join(" "); break; }
    lines.push(cur);
    cur = words[i]!;
  }
  if (cur) lines.push(cur);
  return lines.map((l, i) => (i === lines.length - 1 || textEm(l, false, bold) * fontPx > maxPx ? fit(l, maxPx, fontPx, false, bold) : l));
}

export function timeAgo(playedAt: number | null, now: number): string {
  if (!playedAt) return "";
  const s = Math.max(0, now - playedAt);
  if (s < 90) return "just now";
  const m = Math.round(s / 60);
  if (m < 60) return `${m} min ago`;
  const h = Math.round(m / 60);
  if (h < 36) return `${h} h ago`;
  const d = Math.round(h / 24);
  return d < 60 ? `${d} d ago` : "a while ago";
}

export function bytesToBase64(bytes: Uint8Array): string {
  let bin = "";
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  return btoa(bin);
}
