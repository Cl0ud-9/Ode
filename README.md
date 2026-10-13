# Tidemark

A now-playing card for your GitHub profile that actually looks designed.

Tidemark reads your listening from [Last.fm](https://www.last.fm), pulls its colours from the album art, and draws an SVG you drop into your README. Anything that scrobbles to Last.fm works, including [LastWave](https://github.com/Clash-Projects/LastWave-native).

![Now playing, dark](docs/img/expressive-dark-playing.png)

|  |  |
|---|---|
| ![Last played, light](docs/img/expressive-light-idle.png) | ![No cover art](docs/img/expressive-dark-noart.png) |
| ![Minimal theme](docs/img/minimal-dark-playing.png) | ![Terminal theme](docs/img/terminal-dark-playing.png) |

- **Colours from the cover.** A Material-style tonal palette is built from each album, with contrast checked so text stays readable in light and dark.
- **A cover for every song.** If Last.fm has no artwork, Tidemark looks the track up in the iTunes catalogue. If that finds nothing too, the card draws a tonal placeholder, seeded from the artist and album so each one gets its own colours.
- **Calm when nothing plays.** It shows what you last listened to and how long ago. Empty and error states are designed too, and a day-old good card is served if Last.fm has a bad moment.
- **Light, dark or follow the viewer.** One image adapts to the reader's colour scheme.
- **Gentle motion, never required.** Animation is CSS only, honours reduced motion, and can be switched off with `still=1`.
- **No database, no always-on server.** One Cloudflare Worker, edge cache, one secret.

## Use it in your README

Deploy your own copy (below). Each person runs their own, so there is no shared public instance. Then add:

```markdown
[![Now playing](https://YOUR-WORKER.workers.dev/api/now?user=YOUR_LASTFM_NAME)](https://www.last.fm/user/YOUR_LASTFM_NAME)
```

The outer link makes the card open your Last.fm profile when clicked. GitHub does not follow links inside an SVG, so the link has to wrap the image in your markdown.

Open your Worker's home page for a live preview and a markdown generator that includes the link.

To follow GitHub's own theme instead of the viewer's system setting:

```markdown
<a href="https://www.last.fm/user/YOU">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://YOUR-WORKER.workers.dev/api/now?user=YOU&mode=dark">
  <img alt="Now playing" src="https://YOUR-WORKER.workers.dev/api/now?user=YOU&mode=light">
</picture>
</a>
```

### Options

| Parameter | Values | Default |
|---|---|---|
| `user` | Your Last.fm username (profile must be public) | required |
| `theme` | `expressive`, `minimal`, `terminal` | `expressive` |
| `mode` | `auto`, `light`, `dark` | `auto` |
| `still` | `1` for no animation | off |
| `demo` | `playing`, `idle`, `noart`, `empty`, `error` (no key or user needed) | none |
| `fallback` | `artist`: use the artist's latest release when a track has no official cover (skips the fast path) | placeholder |

## Deploy your own

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and a free [Last.fm API key](https://www.last.fm/api/account/create).

```bash
npm install
npx wrangler login
npx wrangler secret put LASTFM_API_KEY   # paste your key
npx wrangler secret put GENIUS_TOKEN     # optional: more covers (free client token from genius.com/api-clients)
npm run deploy
```

Set `LASTFM_USER` in `wrangler.toml` to your username: that user gets the fast path below.

Local development: put `LASTFM_API_KEY=...` in `.dev.vars`, then `npm run dev`.

## How it works

```
Last.fm  <- every 5 s --  presence object (current track, cover, palette, kept ready)
                                   |  one in-memory read
GitHub image proxy  ->  Worker /api/now  ->  SVG (ETag; unchanged reloads get a 304)
```

A presence object (a Cloudflare Durable Object, free plan) watches your Last.fm in the background. When the track changes it fetches the official cover straight away, so a card request never waits on Last.fm or a lookup: it is one read and a render. Users not in `LASTFM_USER` use the plain path (Last.fm on each request).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model, caching and how to add another music source.

## Honest limits

- **It is not live.** GitHub proxies and caches README images, so the card updates when the page is reloaded and the proxy has refreshed, typically within a minute or two, sometimes longer. It will never tick like a real player.
- **"Now playing" depends on your player.** It appears only if the app tells Last.fm what is playing right now. Otherwise you see the last scrobble. If a player never clears that flag, a track "playing" for over 20 minutes is shown as last played. If Last.fm briefly drops the flag mid-song, the track seen playing in the last 90 seconds is kept, so the card does not flip back to the previous song.
- **No listening time.** Last.fm scrobbles carry no durations, so Tidemark does not claim minutes listened.
- **Only official artwork.** Covers come from Last.fm's own album data (with your key, several lookups in parallel, also trying the title without "(feat. X)"), then Genius if you set a token, then iTunes. All of them are asked at the same time, so a new song costs one round trip, and only the winning cover is downloaded. Every match is on the same artist and title. Nothing community-uploaded is used. A track in none of them (edits, mashups, YouTube uploads with a channel as the "artist") gets a generated placeholder rather than a wrong cover.
- **How fast.** A new song is noticed within about 5 seconds of Last.fm hearing about it, and its cover is fetched at that moment, so a reload shortly after shows both. If a cover takes over 1.5 seconds, the song appears first and the cover a moment later. iTunes throttles shared cloud IPs, so it rarely helps from Cloudflare; Last.fm and Genius carry the load.
- **Free-plan budget.** Polling every 5 seconds is about 17,000 Durable Object requests a day (the free plan allows 100,000). Polling slows after hours of silence and stops for users no longer in `LASTFM_USER`.
- **Fonts vary by device.** The text uses the reader's system fonts, which an SVG image cannot change. Text is measured conservatively and shortened with an ellipsis rather than overflowing.
- Verify SVG behaviour on GitHub itself: see [docs/VERIFY-ON-GITHUB.md](docs/VERIFY-ON-GITHUB.md).

## Development

```bash
npm run check      # typecheck + tests
npm run preview    # render every theme and state to ./preview (PNG + SVG)
```

Tidemark is an independent project. It is not affiliated with or endorsed by Last.fm or any music player. Last.fm is a trademark of its owner.

## License

Tidemark is **source-available**: Copyright 2026 Cloud/9, all rights reserved. You can read the source, deploy your own copy for your own profile, and fork it to contribute back. Redistributing it, publishing modified or rebranded copies, running a public instance for other people, selling it, or using it to train AI models is not allowed without written permission. See [LICENSE](LICENSE) for the full terms and [CONTRIBUTING.md](CONTRIBUTING.md) to help out.

Bundled libraries keep their own licenses, listed in [NOTICE](NOTICE).
