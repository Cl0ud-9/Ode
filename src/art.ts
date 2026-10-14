/**
 * Album covers: where they come from and how they are made ready to embed. The work lives in src/art/; this file
 * is the public surface the rest of the Worker (and the tests) import from.
 *
 *   art/resolve.ts         priority, parallel asking, memory and back-off
 *   art/sources/*.ts       Last.fm, Genius, iTunes and YouTube lookups
 *   art/image.ts           decoding, shrinking and cropping
 *   art/match.ts           matching titles and artists across catalogues
 *   art/http.ts            fetching with timeouts, and the errors the resolver understands
 */
export type { Art, ArtOptions, ArtSource, ArtStore, Resolved } from "./art/types.ts";
export { artStore, resetBackoff, resolveArt } from "./art/resolve.ts";
export { compactCover, coverFromArtTrack, decodeToRgba } from "./art/image.ts";
export { loadArt, sizedUrl } from "./art/sources/lastfm.ts";
export { resetTopicChannels } from "./art/sources/youtube.ts";
export { plainTitle } from "./art/match.ts";
