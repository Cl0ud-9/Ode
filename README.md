# Tidemark

A now-playing card for your GitHub profile that actually looks designed.

Tidemark reads your listening from [Last.fm](https://www.last.fm), pulls its colours from the album art, and draws an SVG you drop into your README. Anything that scrobbles to Last.fm works, including [LastWave](https://github.com/Clash-Projects/LastWave-native).

![Now playing, dark](docs/img/expressive-dark-playing.png)

|  |  |
|---|---|
| ![Last played, light](docs/img/expressive-light-idle.png) | ![No cover art](docs/img/expressive-dark-noart.png) |
| ![Minimal theme](docs/img/minimal-dark-playing.png) | ![Terminal theme](docs/img/terminal-dark-playing.png) |

- **Colours from the cover.** A Material-style tonal palette is built from each album, with contrast checked so text stays readable in light and dark.
- **A cover for every song.** If Last.fm has no artwork, Tidemark asks Genius and iTunes, and as a last resort reads the official cover off the artist's YouTube "Topic" upload. If none has it, the card draws a tonal placeholder, seeded from the artist and album so each one gets its own colours.
- **A real progress bar.** The Material 3 Expressive wavy indicator, with its gap, track and stop dot, advances in real time from when the song started, using the song's length from Last.fm.
- **Calm when nothing plays.** It shows what you last listened to and how long ago. Empty and error states are designed too, and a day-old good card is served if Last.fm has a bad moment.
- **Light, dark or follow the viewer.** One image adapts to the reader's colour scheme.
- **Gentle motion, never required.** Animation is CSS only, honours reduced motion, and can be switched off with `still=1`.
- **No database, no always-on server.** One Cloudflare Worker, edge cache, one secret.

## Use it in your README

Deploy your own copy (below). Each person runs their own, so there is no shared public instance. Then add:

```html
<a href="https://www.last.fm/user/YOUR_LASTFM_NAME"><img src="https://YOUR-WORKER.workers.dev/api/now?user=YOUR_LASTFM_NAME" alt="Now playing on Last.fm" width="480" height="150"></a>
```

Keep the `width` and `height` (use `height="86"` for the minimal theme): GitHub fetches a fresh card on every page load, and without a size the section collapses for the moment it takes to arrive. The outer link makes the card open your Last.fm profile; GitHub does not follow links inside an SVG, so the link has to wrap the image.

Open your Worker's home page for a live preview (it updates by itself while open) and a snippet generator.

To follow GitHub's own theme instead of the viewer's system setting:

```markdown
<a href="https://www.last.fm/user/YOU">
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://YOUR-WORKER.workers.dev/api/now?user=YOU&mode=dark">
  <img alt="Now playing" src="https://YOUR-WORKER.workers.dev/api/now?user=YOU&mode=light" width="480" height="150">
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
npx wrangler secret put YOUTUBE_API_KEY  # optional: last-resort covers (free key, YouTube Data API v3, Google Cloud console)
npm run deploy
```

Set `LASTFM_USER` in `wrangler.toml` to your username: that user gets the fast path below.

Local development: put `LASTFM_API_KEY=...` in `.dev.vars`, then `npm run dev`.

## How it works

```
Last.fm  <- every 5 s --  presence object (current track, cover, palette, kept ready)
                                   |  one in-memory read
GitHub image proxy  ->  Worker /api/now  ->  SVG (fresh on every page load: max-age=0)
```

A presence object (a Cloudflare Durable Object, free plan) watches your Last.fm in the background. When the track changes it fetches the official cover straight away, so a card request never waits on Last.fm or a lookup: it is one read and a render. Users not in `LASTFM_USER` use the plain path (Last.fm on each request).

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model, caching and how to add another music source.

## Honest limits

- **On GitHub it updates on reload.** GitHub's image proxy used to keep each card for about a minute; Tidemark now sends `max-age=0`, which the proxy honours, so every reload shows the current song. The image itself cannot be swapped while the page stays open, though the progress bar keeps moving. Your Worker's home page does update by itself.
- **"Now playing" depends on your player.** It appears only if the app tells Last.fm what is playing right now. Otherwise you see the last scrobble. If a player never clears that flag, a track "playing" for over 20 minutes is shown as last played. If Last.fm briefly drops the flag mid-song, the track seen playing in the last 90 seconds is kept, so the card does not flip back to the previous song.
- **Progress is an estimate.** Last.fm reports no playback position. The bar counts from when the song was first seen playing (within about 5 seconds) against its length from Last.fm, so it cannot see a pause or a skip within the song. Without a known length it shows the full wave and no stop dot rather than invent progress.
- **Only official artwork.** Covers come from Last.fm's own album data (with your key, several lookups in parallel, also trying the title without "(feat. X)"), then Genius if you set a token, then iTunes. All of them are asked at the same time, so a new song costs one round trip, and only the winning cover is downloaded. With a YouTube key, a song none of them has is looked up on YouTube, using only the artist's auto-generated "Topic" upload, whose picture is the label's cover (a music video's frame is rejected). Every match is on the same artist and title. A track in none of them (edits, mashups, YouTube uploads with a channel as the "artist") gets a generated placeholder rather than a wrong cover.
- **How fast.** A new song is noticed within about 5 seconds of Last.fm hearing about it, and its cover is fetched at that moment, so a reload shortly after shows both. If a cover takes over 1.5 seconds, the song appears first and the cover a moment later. iTunes throttles shared cloud IPs, so it rarely helps from Cloudflare; Last.fm and Genius carry the load.
- **Free-plan budget.** Polling every 5 seconds is about 17,000 Durable Object requests a day (the free plan allows 100,000). Polling slows after hours of silence and stops for users no longer in `LASTFM_USER`.
- **Fonts vary by device.** The text uses the reader's system fonts, which an SVG image cannot change. Titles are measured conservatively and shortened with an ellipsis rather than overflowing; the status pill's label is set to an exact width, so its padding is even in any font.
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
