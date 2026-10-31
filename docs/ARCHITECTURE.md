# Architecture

## Layout

```
src/
  index.ts            routing only: /, /api/now, /health, and the cron
  config.ts           Env, tracked users, trimmed secrets, which cover sources a card may use
  serve/
    http.ts           SVG responses: cache headers, ETag, trace headers
    presence.ts       fast path: answer from the user's presence object
    plain.ts          plain path: Last.fm on the spot, edge cache, stale fallback; the no-presence cron
  presence-do.ts      the presence object (Durable Object): polls Last.fm, keeps the card's state ready
  presence.ts         settling: stuck "now playing" flags and Last.fm's momentary flips
  mood.ts             a song's mood from its Last.fm tags
  lastfm.ts           user.getRecentTracks and its normalisation
  art.ts              public surface of the cover code below
  art/
    resolve.ts        priority, parallel asking, per-track and per-source memory, back-off
    sources/          lastfm.ts, genius.ts, itunes.ts, musicbrainz.ts, youtube.ts
    image.ts          decode, shrink to 240px JPEG, crop art-track thumbnails
    match.ts          title and artist matching across catalogues
    http.ts           fetching with timeouts; Throttled and BadImage
    types.ts
  store.ts            KV, Cache API and Durable Object stores; expiry sweep
  card.ts             track or failure -> card data and its change key
  palette.ts, color.ts  cover -> seed -> OKLCH tonal schemes with enforced contrast
  render/             expressive, minimal, terminal, and shared pieces (wave, corners, motion)
  shapes.ts, util.ts  shapes, text measurement
  serve/theme.ts      GET /api/theme: the live card's palette and song, for the website
  serve/go.ts         GET /api/go: a redirect from the card's link to the song it shows (Last.fm, or a search elsewhere)
  (index.ts also)     GET /api/key: the card's key and trace without drawing it, which the website polls
site/                 the website, served as static assets (see "The website" below)
test/                 unit and Worker integration tests
scripts/preview.ts    renders every theme and state to PNG
scripts/covers.ts     checks which of a user's songs get a cover, and from which source
```

## Request flow

`GET /api/now?user=...` ([src/index.ts](../src/index.ts)):

1. Parameters are validated and reduced to a canonical form ([src/params.ts](../src/params.ts)); unknown parameters never change the cache key.
2. **Tracked user** (in `LASTFM_USER`): one request to their presence object, which already holds the settled state and the cover, then a render ([src/serve/presence.ts](../src/serve/presence.ts)). About 70 ms on the server.
3. **Anyone else**, or a tracked user whose object cannot answer: the plain path ([src/serve/plain.ts](../src/serve/plain.ts)). Edge cache (custom domains only: the Cache API does nothing on workers.dev), then one Last.fm call, settling and a cover lookup that may take 300 ms before the placeholder is drawn; the lookup finishes in the background.
4. Every response is a card with status 200 (a designed error card beats a broken image), plus `X-Ode-State`, `X-Ode-Key` and `X-Ode-Poll`.

## The presence object

[src/presence-do.ts](../src/presence-do.ts), one Durable Object per tracked user. Its alarm polls Last.fm every 5 s while playing, 8 s when idle and 10 s after two silent hours; the alarm handler returns at once and the poll runs in the background, because requests that arrived while it awaited Last.fm used to wait for it. On a track change it settles the state and resolves the cover straight away (waiting up to 1.5 s before showing the new song without it). The snapshot lives in memory and in the object's storage; a card request does no storage I/O at all.

- A late alarm never makes a card wait: a snapshot under 2 minutes old is answered at once and a poll catches up.
- The cron kicks every tracked user each minute; it restarts a dead loop and carries a fingerprint of the secrets and the deployment's version (`version_metadata`), so `wrangler secret put` and new code both take effect within a minute: kept awake by its alarm, the object would otherwise keep running the code and secrets it started with. It restarts itself at most once per 10 minutes.
- A loop nobody asks about for 15 minutes ends.
- Every 10 minutes one page of expired covers and notes is deleted from its storage ([src/store.ts](../src/store.ts) `sweepExpired`), so storage does not grow without bound.

## Covers

[src/art/resolve.ts](../src/art/resolve.ts). Only official artwork, always matched on the same artist and the same song.

1. A cover remembered for this track (30 days) is used at once.
2. The cover that came with the scrobble gets a 700 ms head start.
3. Otherwise Last.fm's catalogue (album.getInfo, track.getInfo with and without "(feat. X)", then album.search), Genius, iTunes and MusicBrainz are asked at the same time. A lower source is used only once every source above it has answered without a cover, and only the winner's image is downloaded and decoded. Then the scrobble's late cover.
4. If all of them miss and `YOUTUBE_API_KEY` is set: the artist's "Topic" channels are found once (one channel search, 100 quota units, remembered for a week; up to three channels, since artists share names), the song is looked for in their uploads (1 unit per 50 songs), with one search inside the channel (100 units) for long catalogues. The cover is cut out of the art track's thumbnail; a frame whose side panels are not flat (a music video) is refused.

YouTube's daily quota belongs to the owner, so only tracked users spend it ([src/config.ts](../src/config.ts) `coverOptions`); everyone gets Last.fm, Genius, iTunes and MusicBrainz. A source's "not there" is remembered for 10 minutes (YouTube: a day); a source that is throttled, times out or rejects our key is skipped for a minute and never remembered as a miss. Each source's misses carry a revision, bumped when it learns to find more, so old misses are retried at once.

[MusicBrainz](../src/art/sources/musicbrainz.ts) is keyless and is not hidden by country the way some catalogues are. It searches recordings by title and artist, keeps those credited to the same artist with the same core title, prefers the release the scrobble names and official studio releases over compilations, live albums and remixes, and takes the release group's front cover from the Cover Art Archive (up to three release groups are tried). It is the slowest source (a few seconds) and asks callers to stay near one request a second, so a 503 is treated like any throttling: skipped for a minute, never remembered as a miss.

`npm run covers` ([scripts/covers.ts](../scripts/covers.ts)) runs this whole pipeline against a user's real listening and reports the source that won for each song.

Images are shrunk to a 240px JPEG (the cover is drawn about 110 CSS px wide) and embedded as a `data:` URI, since GitHub blocks external images inside SVGs.

### Where did that cover come from?

`X-Ode-State` ends with `art=<source>`: `lastfm`, `lastfm-info`, `genius`, `itunes`, `musicbrainz`, `youtube`, `cache`, `pending` (still looking), `retrying` (a source was briefly unavailable; not remembered as a miss) or `none` (no source has it; remembered for 3 minutes). Misses list what each source said, for example `youtube:no-match(channels=1/4 uploads=50)` or `lastfm-info:bad-image(http-404)`. Check it with `curl -sI "https://YOUR-WORKER/api/now?user=YOU"`.

## The website

[site/](../site) is static HTML, CSS and JavaScript with no build step, served by Workers static assets (`wrangler.toml`, `assets`). Only `/` goes through the Worker first, so the home page can arrive already wearing the owner's live card and colours ([src/serve/page.ts](../src/serve/page.ts)); `?demo` shows the demo card instead.

| File | What it does |
|---|---|
| `index.html`, `styles.css` | The page. Material 3 Expressive, with every colour a role token that `app.js` rewrites from the song's palette. |
| `app.js` | Colour, the live card, polling, the switches and menus, and the small interactions. |
| `liquid.js` | The hero card turns to liquid near the pointer: a WebGL2 particle engine ported from "Sculpture Hero" by Guglielmo Giannattasio (21st.dev). It is built quietly a few seconds after the page has loaded (on phones the build takes about a second, which a first tap must not wait for), and nothing changes on screen until someone first hovers the card or touches on or near it; then the card stops where it is, with no jump, and takes over. A touch that comes before the build is done is played back once it is, so the first tap always disperses the card. When it settles, the real card is put back underneath the canvas first and the canvas fades away over it afterwards, so the card never dips. It is never built under reduced motion or data saver, and never without WebGL2 (the plain card stays). |
| `halftone.js` | The footer's "Ode" printed in halftone dots that part around the pointer, ported from "Halftone Wordmark Footer" (21st.dev). Every dot is one instance of a single WebGL2 draw, so a frame costs the same whether ten dots are moving or all of them, and the print grain is worked out per pixel on the GPU; only the dots in motion are re-uploaded. Without WebGL2 it falls back to a 2D canvas that paints the word once into a still layer and repaints only the rectangle around the moving dots; if the GPU takes its context away, the plain wordmark stands in until it is back. A click sends a ring that travels a bounded distance, so only a few thousand of its ten thousand dots ever move at once. It is built in small slices between frames, starting when the visitor first scrolls, so it is finished long before the footer is reached. |
| `fonts/` | Google Sans Flex (trimmed to Latin and to the axis ranges the page uses) and Google Sans Code, under the SIL OFL. Served from here so no third-party stylesheet blocks the first paint; until they arrive, text is set in a local face scaled to the same widths so nothing reflows. |
| `_headers` | Cache and security headers for the static files (fonts are immutable for a year). |

Rules the page keeps:

- **One card on screen at a time.** Switching a card fades the old one out, then the new one springs in; the panel around it never changes size, so nothing jumps and there is never a double image.
- **Optional things cost nothing until used.** The liquid card, the footer word and the glass lens (desktop only) are built late or on demand, and the page is fully usable without any of them.
- **Reduced motion and data saver are honoured**, and the controls are real buttons, lists and fields with keyboard support (the dropdowns follow the listbox pattern).

## Caching and freshness

Cards are sent with `Cache-Control: max-age=0, s-maxage=1, must-revalidate`. GitHub's image proxy (camo, behind Fastly) ignores a bare `no-cache` or `no-store` and keeps an image for about 60 seconds; measured through real camo URLs, it honours an explicit `max-age=0` or `s-maxage`, so each page load gets a fresh card. Camo drops the ETag, so the 304 path only helps browsers that load the card directly. A camo cache miss costs about 0.7 to 1 s of the proxy's own time, which is why the README snippet carries a width and height: the space stays reserved while the card arrives.

On the plain path, the copy kept at the edge lasts:

| State | Edge TTL |
|---|---|
| looking for the cover | 5 s |
| playing | 10 s |
| idle | 15 s |
| empty / unknown user | 300 s |
| error | 20 s |

A good card is also kept for 2 minutes as a stand-in for a Last.fm hiccup.

The website ([site/](../site)) wears the colours of the song on the live card: it reads the palette from `/api/theme` (Material role colours for light and dark, computed exactly as the card's are) and rewrites its CSS tokens; every surface fades to the new colours over 300 ms when the song or colour style changes. A theme switch fetches only the preview card, so it shows within a few hundred milliseconds. It polls `X-Ode-Key` with HEAD requests while the tab is visible, at the interval `X-Ode-Poll` suggests (4 s for tracked users, whose checks are in-memory reads; 20 s for anyone else, whose checks each cost a Last.fm call), and swaps the image only when the key changes.

## The card

- **The wavy line** (`liveWave` in [src/render/common.ts](../src/render/common.ts)) is drawn only while a song plays, across the whole column. It is not a progress bar: Last.fm reports no position, and an estimate from when a song was first noticed was wrong for long songs, repeats and late detection. It is a dash along a longer sine, so both ends are round caps; two SMIL animations on one timeline shift the sine by a wavelength while moving the dash the same distance, so the crests travel and the ends stay put.
- **Mood** ([src/mood.ts](../src/mood.ts)): on a track change the presence object reads the song's Last.fm tags (the artist's when the song has too few), and the ten strongest vote for calm, lively or intense; otherwise steady. `tempoFor` in [src/render/common.ts](../src/render/common.ts) turns it into the wave's speed and height, the equaliser's beat and the ring's turn. Plain-path cards stay steady (one more Last.fm call per request is not worth it there).
- **Living cover** (`livingCover`): while playing, a 28 s zoom between 1.02x and 1.08x with a drift that stays inside that margin, and an 11 s cycle in which a soft band of light crosses the cover. SMIL, applied inside the cover's clip so the outline never moves; reduced motion pins it.
- **Colour styles** (`styleSeed` in [src/palette.ts](../src/palette.ts)): `?scheme=` rewrites the seed before the tonal schemes are built, mirroring Android's Tonal Spot, Vibrant, Expressive (hues rotated 240 degrees) and Fidelity variants, plus monochrome. Contrast is enforced the same way for all of them.
- **Corners** outside the rounded card are painted in GitHub's page colour, because signed-in GitHub draws a lighter box behind README images. `?corners=clear` leaves them transparent.
- **Text** cannot be measured inside an SVG, so widths are estimated conservatively ([src/util.ts](../src/util.ts) `textEm`): combining marks take no width, Indic letters are measured wider than Latin, CJK and emoji at full width. The status pill's label is set to an exact `textLength`, so its padding is even in any font.

## Decisions

- **Always 200 with a card.** The real state is in the trace header.
- **Colour roles as CSS classes.** Light and dark palettes are emitted once, with a `prefers-color-scheme` block for `mode=auto`.
- **Own colour maths.** OKLCH tones with gamut clamping and enforced contrast, rather than a heavy dependency; the tests sweep every hue.
- **Deterministic shapes.** Blobs, scallops and waves are seeded from artist and album, so a card does not change shape between loads of the same track.
- **Presence objects over request-time work.** Polling every few seconds costs about 17,000 Durable Object requests a day (the free plan allows 100,000) and makes every card a memory read.

## Adding another music source

A source returns a `NowPlaying` ([src/model.ts](../src/model.ts)). `fetchNowPlaying` in [src/lastfm.ts](../src/lastfm.ts) is the only Last.fm-specific code on the request path; a ListenBrainz adapter would return the same shape.
