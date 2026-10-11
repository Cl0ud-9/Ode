# Architecture

## Request flow

1. `GET /api/now?user=...` arrives at the Worker ([src/index.ts](../src/index.ts)).
2. Parameters are validated and reduced to a canonical cache key ([src/params.ts](../src/params.ts)). Unknown parameters never change the key, so they cannot be used to bust the cache.
3. Cache hit: return it.
4. Miss: ask Last.fm for the most recent track ([src/lastfm.ts](../src/lastfm.ts)), fetch the cover twice at 64px and 174px, derive a colour seed from the small one and embed the larger one as a base64 `data:` URI ([src/art.ts](../src/art.ts)). GitHub blocks external images inside SVGs, so embedding is required.
5. Build a tonal palette ([src/palette.ts](../src/palette.ts), [src/color.ts](../src/color.ts)) and render the chosen theme ([src/render/](../src/render)).
6. Store at the edge with a short TTL, and a day-long "last known good" copy used when Last.fm fails.

## Caching

| State | Edge TTL |
|---|---|
| playing | 45 s |
| idle | 120 s |
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
