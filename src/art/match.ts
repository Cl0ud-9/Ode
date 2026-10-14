/** Matching titles and artists across catalogues that spell them differently. */

// Accents are dropped, not turned into spaces: NFKD splits "ë" into "e" plus a combining mark, and treating that
// mark as a separator made "Tiësto" into "tie sto", so accented artists never matched any catalogue.
export const norm = (s: string) => s.toLowerCase().normalize("NFKD").replace(/\p{M}+/gu, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The same artist, allowing for "The Chainsmokers" vs "Chainsmokers" and "A, B & C" credit lists. */
export const sameArtist = (a: string, b: string) => {
  const x = norm(a);
  const y = norm(b);
  return x.length > 0 && y.length > 0 && (x === y || x.includes(y) || y.includes(x));
};

/** Release noise that differs between catalogues: "(Remastered)", "[Live]", "- Radio Edit", "feat. X". */
const stripNoise = (t: string) => t.replace(/[(\[][^)\]]*[)\]]/g, " ").replace(/\s[-–—]\s.*$/, " ").replace(/\b(?:feat|ft)\b.*$/i, " ");

/** A title reduced for comparison: noise stripped and normalised (falls back to the whole title if nothing is left). */
export const core = (t: string) => norm(stripNoise(t)) || norm(t);

/** A title minus release noise, as Last.fm names the song: "Closer (feat. Halsey)" -> "Closer". */
export const plainTitle = (t: string) => stripNoise(t).replace(/\s+/g, " ").trim();

/** Some APIs (YouTube) HTML-escape their titles. */
export const unescapeHtml = (s: string) => s.replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
