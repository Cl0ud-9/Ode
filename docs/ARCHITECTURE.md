# Architecture

## Request flow

1. `GET /api/now?user=...` arrives at the Worker ([src/index.ts](../src/index.ts)).
2. Parameters are validated and reduced to a canonical cache key ([src/params.ts](../src/params.ts)). Unknown parameters never change the key, so they cannot be used to bust the cache.
3. Cache hit: return it.
4. Miss: ask Last.fm for the most recent track ([src/lastfm.ts](../src/lastfm.ts)), fetch the cover twice at 64px and 174px, derive a colour seed from the small one and embed the larger one as a base64 `data:` URI ([src/art.ts](../src/art.ts)). GitHub blocks external images inside SVGs, so embedding is required.
5. Build a tonal palette ([src/palette.ts](../src/palette.ts), [src/color.ts](../src/color.ts)) and render the chosen theme ([src/render/](../src/render)).
5b. If the track is flagged as playing, `src/presence.ts` remembers when it was first seen; after 20 minutes it is shown as last played, since a crashed player never clears the flag. Missing covers are looked up on Last.fm first (album.getInfo, track.getInfo as scrobbled and without "(feat. X)", all in parallel, then album.search accepted only for the same artist and a matching title), then Genius when a token is set, then iTunes (`src/art.ts`). All sources search at once; the highest-priority one that finds the song wins as soon as every source above it has answered, and only its image is downloaded and decoded. If all of them miss and `YOUTUBE_API_KEY` is set, the YouTube Data API is asked last (it has a daily quota of 10,000 units): the artist's "Topic" channel is found once with a channel search (100 units, then remembered for a week), and the song is looked for in its uploads list (1 unit per 50 songs), falling back to one search inside the channel (100 units) for long catalogues or channels without an uploads list. A song the channel lacks is remembered for a day. Only an "Artist - Topic" upload of the same song counts, and the cover is cut out of its thumbnail (`coverFromArtTrack`), which refuses frames whose side panels are not flat, so a music video never becomes a cover. Results are remembered per track in KV (`src/store.ts`), and warmed by a per-minute cron. A lookup over 2.5 s is finished in the background.
6. Store at the edge with a short TTL, and a day-long "last known good" copy used when Last.fm fails.

## The fast path: presence objects

For users in `LASTFM_USER`, `src/presence-do.ts` (one Durable Object per user) polls Last.fm every 5 s while playing, 8 s when idle, 10 s after two silent hours. On a track change it settles the state (stuck tracks, a dropped flag), resolves the cover immediately (Last.fm, Genius and iTunes asked at once) and looks up the song's length (track.getInfo, for the progress indicator), and keeps a snapshot in memory and in its own SQLite storage. `/api/now` reads that snapshot and renders: no Last.fm call, no lookup and no storage read on the request path. If an alarm runs late, the request still answers from the snapshot and a poll catches up in the background. If the object fails, the card falls back to the plain path. The per-minute cron only kicks each object to keep its alarm loop alive; a loop nobody asks about for 15 minutes ends.

Cards are sent with `Cache-Control: max-age=0, s-maxage=1, must-revalidate`. GitHub's image proxy (camo, behind Fastly) ignores a bare `no-cache` or `no-store` and keeps an image for about 60 seconds; measured through real camo URLs, it honours an explicit `max-age=0` or `s-maxage`, so each page load gets a fresh card. Camo also drops the ETag, so the 304 path only helps browsers that load the card directly. A camo cache miss costs about 0.7 to 1 s of the proxy's own time on top of the Worker's ~100 ms, which is why the README snippet carries a width and height: the space is reserved while the card arrives.

Each card also carries `X-Tidemark-Key`, which changes only when what the card shows changes (song, cover, status line), not as the progress indicator moves. The landing page polls it with HEAD requests every 4 s while the tab is visible and swaps the image only when it changes.

## Progress indicator

`progressIndicator` in [src/render/common.ts](../src/render/common.ts) draws the Material 3 Expressive wavy indicator: a wavy active part, a gap, a flat track and a stop dot. Progress is `(now - since) mod length`, where `since` is when the presence object first saw the song playing. The active part is a dash along a longer sine; a CSS animation grows the dash over the rest of the song, and two SMIL animations on one timeline shift the sine left by a wavelength while moving the dash the same distance along it, so the crests travel and both ends stay put. Unknown length: a full wave with no stop dot. Not playing: the track and its stop dot.

## Where did that cover come from?

The `X-Tidemark-State` response header ends with `art=<source>`: `lastfm`, `lastfm-info`, `genius`, `itunes`, `youtube`, `cache` (found earlier, kept up to 30 days), `pending` (still looking, placeholder drawn), `itunes-blocked` (iTunes answered 429; not remembered as a miss) or `none` (genuinely not found, remembered for 3 minutes). Check it with `curl -sI "https://YOUR-WORKER/api/now?user=YOU"`.

## Caching

| State | Edge TTL |
|---|---|
| playing | 10 s |
| idle | 60 s |
| empty / unknown user | 300 s |
| error | 30 s |

Responses sent to GitHub use `max-age=0, must-revalidate`; the real TTL lives in the copy we store. GitHub's image proxy adds its own delay that we do not control.

## Decisions

- **No database.** Everything is derived from a public Last.fm call, so there is nothing to store. Cloudflare's Cache API is enough.
- **One shared API key.** Last.fm reads of public profiles need only a key, so each deployment holds one secret and takes `?user=`. If a deployment becomes popular, the cache absorbs repeat traffic.
- **Always 200 with a card.** A broken-image icon on someone's profile is worse than a designed error card. The real state is in the `X-Tidemark-State` header.
- **Colour roles as CSS classes.** Light and dark palettes are emitted once, with a `prefers-color-scheme` block for `mode=auto`. Static modes emit one palette only.
- **Own colour maths.** OKLCH tones with gamut clamping and enforced contrast, rather than a heavy dependency. The tests sweep every hue to guard readability.
- **Deterministic shapes.** Blobs, scallops and the wave are seeded from artist and album, so a card never changes shape between refreshes of the same track.
- **Size budget.** Embedded art is capped at 40 KB and typical cards are about 15 to 25 KB.

## Adding another music source

A source is any function that returns:

```ts
interface NowPlaying {
  user: string;
  status: "playing" | "idle";
  track: { title: string; artist: string; album: string; artUrl: string | null; playedAt: number | null };
}
```

`fetchNowPlaying` in `src/lastfm.ts` is the only Last.fm-specific code on the request path. A ListenBrainz adapter would return the same shape and be selected by a `source` parameter. The art loader currently allows only Last.fm image hosts (an SSRF guard), so a new source adds its own hosts to that list.

## Layout

```
src/
  index.ts        routes, caching, stale fallback
  lastfm.ts       API call + normalisation
  art.ts          cover fetch, decode, embed
  palette.ts      art -> seed -> tonal schemes
  color.ts        OKLCH maths and contrast
  shapes.ts       scallops, blobs, waves, equaliser
  render/         expressive, minimal, terminal
  card.ts         data -> renderer glue
  demo.ts         offline fixtures
  landing.ts      home page and generator
test/             unit + worker integration tests
scripts/preview.ts  render all states to PNG
```
