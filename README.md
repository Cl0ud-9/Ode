# Tidemark

A now-playing card for your GitHub profile that actually looks designed.

Tidemark reads your listening from [Last.fm](https://www.last.fm), pulls its colours from the album art, and draws an SVG you drop into your README. Anything that scrobbles to Last.fm works, including [LastWave](https://github.com/Clash-Projects/LastWave-native).

![Now playing, dark](docs/img/expressive-dark-playing.png)

|  |  |
|---|---|
| ![Last played, light](docs/img/expressive-light-idle.png) | ![No cover art](docs/img/expressive-dark-noart.png) |
| ![Minimal theme](docs/img/minimal-dark-playing.png) | ![Terminal theme](docs/img/terminal-dark-playing.png) |

- **Colours from the cover.** A Material-style tonal palette is built from each album, with contrast checked so text stays readable in light and dark.
- **A shape for every song.** The wave under the title is seeded from the track, so no two songs look alike. Covers with no art still get a deliberate design.
- **Calm when nothing plays.** It shows what you last listened to and how long ago. Empty and error states are designed too, and a day-old good card is served if Last.fm has a bad moment.
- **Light, dark or follow the viewer.** One image adapts to the reader's colour scheme.
- **Gentle motion, never required.** Animation is CSS only, honours reduced motion, and can be switched off with `still=1`.
- **No database, no always-on server.** One Cloudflare Worker, edge cache, one secret.

## Use it in your README

Deploy your own copy (below). Each person runs their own, so there is no shared public instance. Then add:

```markdown
![Now playing](https://YOUR-WORKER.workers.dev/api/now?user=YOUR_LASTFM_NAME)
```

Open your Worker's home page for a live preview and a markdown generator.

To follow GitHub's own theme instead of the viewer's system setting:

```markdown
<picture>
  <source media="(prefers-color-scheme: dark)" srcset="https://YOUR-WORKER.workers.dev/api/now?user=YOU&mode=dark">
  <img alt="Now playing" src="https://YOUR-WORKER.workers.dev/api/now?user=YOU&mode=light">
</picture>
```

### Options

| Parameter | Values | Default |
|---|---|---|
| `user` | Your Last.fm username (profile must be public) | required |
| `theme` | `expressive`, `minimal`, `terminal` | `expressive` |
| `mode` | `auto`, `light`, `dark` | `auto` |
| `still` | `1` for no animation | off |
| `demo` | `playing`, `idle`, `noart`, `empty`, `error` (no key or user needed) | none |

## Deploy your own

You need a free [Cloudflare](https://dash.cloudflare.com/sign-up) account and a free [Last.fm API key](https://www.last.fm/api/account/create).

```bash
npm install
npx wrangler login
npx wrangler secret put LASTFM_API_KEY   # paste your key
npm run deploy
```

Local development: put `LASTFM_API_KEY=...` in `.dev.vars`, then `npm run dev`.

## How it works

```
Last.fm  ->  Worker (fetch, palette, SVG)  ->  edge cache  ->  GitHub image proxy  ->  README
```

See [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the data model, caching and how to add another music source.

## Honest limits

- **It is not live.** GitHub proxies and caches README images, so the card updates when the page is reloaded and the proxy has refreshed, typically within a minute or two, sometimes longer. It will never tick like a real player.
- **"Now playing" depends on your player.** It appears only if the app tells Last.fm what is playing right now. Otherwise you see the last scrobble.
- **No listening time.** Last.fm scrobbles carry no durations, so Tidemark does not claim minutes listened.
- **Some tracks have no cover.** Last.fm does not always have art. Those cards use a generated design instead.
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
