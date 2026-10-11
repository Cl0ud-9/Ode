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

/** Rough text width in em, good enough to truncate without real font metrics. */
export function textEm(s: string, mono = false): number {
  if (mono) return s.length * 0.6;
  let w = 0;
  for (const ch of s) {
    const code = ch.codePointAt(0)!;
    if (code > 0x2e80) w += 1;
    else if ("il.,;:'|!jI ".includes(ch)) w += 0.3;
    else if ("mwMW@%".includes(ch)) w += 0.88;
    else if (ch >= "A" && ch <= "Z") w += 0.68;
    else w += 0.56;
  }
  return w;
}

export function fit(s: string, maxPx: number, fontPx: number, mono = false): string {
  if (textEm(s, mono) * fontPx <= maxPx) return s;
  let out = "";
  for (const ch of s) {
    if (textEm(out + ch + "…", mono) * fontPx > maxPx) break;
    out += ch;
  }
  return out.trimEnd() + "…";
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
