# Changelog

What changed in each version of Ode. To take a new version into your own copy, see
[Updating your copy](README.md#updating-your-copy).

The format follows [Keep a Changelog](https://keepachangelog.com), and the versions follow
[Semantic Versioning](https://semver.org).

## [Unreleased]

### Fixed

- A song played again (hours later, or straight away on repeat) shows as playing again. Ode's 20-minute "stuck now
  playing" clock was kept per song rather than per play, so a song heard earlier the same day was judged stuck the
  moment it started again and shown as last played. The clock now starts again when the song was seen finishing, when
  it has not been seen playing for 20 minutes, or when Last.fm has scrobbled anything since the clock started.
- A response from Last.fm that lags behind no longer brings back a song that had already finished as "playing".
- Website: the live card breaks apart into particles and the new card assembles again when the song changes, and now
  also when a song starts or ends, for every visitor. Since the card started being built in the background, this only
  happened for someone who had already touched the card. It does not happen while the card is off screen or shrinking
  away as the page scrolls, and a playing flag that flickers for a few seconds triggers it at most once.
- Website: scrolling the page with a finger that starts on the hero card no longer turns the card liquid. On a phone the
  card sits where a thumb lands to scroll, and people rest a thumb for a moment before they scroll; the card breaking
  apart under that left a dark smear where it had been. A finger now plays with the card only when it taps it or drags
  across it sideways. Resting on it, moving up or down (a scroll, slow or fast), landing on a page that is still
  coasting from a flick, and a page that moves under the finger all leave the card as it is. A mouse is unchanged.

## [0.1.0] - 2026-10-20

The first public version.

### The card

- A now-playing SVG for your GitHub profile README, in three themes: **expressive** (Material 3 Expressive, the
  default), **minimal** and **terminal**, in light, dark or following the reader.
- Colours taken from the album art as a Material-style tonal palette, with contrast checked. `scheme=` picks the
  Material You variants: tonal spot, vibrant, expressive, fidelity or monochrome.
- A wavy line that travels while a song plays, with a speed and height set by the song's mood from its Last.fm tags.
  A slowly moving cover. No line when nothing plays.
- Designed quiet and error states, last-played cards that say how long ago, and a day-old good card served if Last.fm
  has a bad moment.
- All motion honours reduced motion, and `still=1` switches it off.

### Covers

- Last.fm's own artwork first, then Genius, iTunes, MusicBrainz with the Cover Art Archive, and the artist's YouTube
  "Topic" uploads, all asked at once and matched on the same artist and song.
- A generated placeholder, seeded from the artist and album, for songs no source has. Never a wrong cover.
- `npm run covers` shows which of your songs get a cover and from where.

### Running it

- One Cloudflare Worker on the free plan, with a presence object that watches Last.fm in the background, so a card
  request is one read and a render. A new song is noticed within about 5 seconds.
- Not a shared service: a deployment only serves the Last.fm users named in `LASTFM_USER`, so nobody can spend your
  keys or limits. `OPEN_TO_ALL` turns that off.
- A **Deploy to Cloudflare** button, and a website on your own Worker that shows your live card and writes the snippet
  for you.

### The website

- A Material 3 Expressive page set in Google Sans Flex, coloured by the song on the live card.
- A hero card that turns to liquid under a finger or the pointer, and settles back into the real, moving card.
- The footer word, printed in halftone dots that part around the pointer.
- Works on phones and with the keyboard, honours reduced motion, and has no build step.
