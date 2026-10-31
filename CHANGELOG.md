# Changelog

What changed in each version of Ode. To take a new version into your own copy, see
[Updating your copy](README.md#updating-your-copy).

The format follows [Keep a Changelog](https://keepachangelog.com), and the versions follow
[Semantic Versioning](https://semver.org).

## [Unreleased]

### Added

- `/api/go`: the link around the card can open the song on it. Point the README's `<a>` at
  `/api/go?user=YOU&to=song` (or `spotify`, `youtube`, `apple`, `profile`) and the visitor is sent to the song that is on the card
  now, on Last.fm or a search for it on the service they prefer. See "Make the card open the song" in the README.

### Fixed

- A song that has just ended no longer reads "played 4 min ago". Last.fm stamps a play with when it started, so a 4-minute song
  that had only just finished looked as if it ended 4 minutes ago, which sounds wrong to someone still listening. When the song's
  length is known, "ago" now counts from when it ended ("just now" at the end of the song). Where the length is unknown, it counts
  from the start as before.
- The website asks about the song far less when nobody is using it. It polled the card every 4 seconds for as long as the tab
  was visible, and each ask drew the whole card: one tab left open all day was about 21,600 requests, and a few of them could use
  up the free plan's daily budget, which the cards on a README share. It now asks a new `/api/key` endpoint, which returns only
  the card's key (nothing is drawn), and slows from every 4 seconds to every 10 after two minutes untouched and every 30 after
  ten, returning to the quick rate the moment the page is used again.
- A long track is no longer called finished after 20 minutes. When Last.fm knows how long a song is, it may play that long and
  five minutes more before it counts as stuck, so a 45-minute mix keeps showing as playing. Where the length is unknown, the
  20 minutes stand, as before.
- A song on repeat stays shown as playing. Some scrobblers flag only the first play as now playing and just scrobble the
  repeats, so between scrobbles Last.fm says "last played" and the card said "played 3 min ago" while the song played on.
  The same song scrobbled again shortly after its previous scrobble is now taken as a loop and kept playing until the next
  scrobble is due (one loop after the last was seen, with a little to spare), then shown as last played once they stop.
  Ode learns how long a song is from its loops and remembers it, so the next time that song is looped, its first repeat is
  recognised at once (the "now playing" flag stays on for much longer than the song) instead of after a second scrobble. A
  song whose flag simply lasts longer than it, with no repeat following, is learned as such and not guessed at again.
- A long press on the dark space above the footer word no longer selects the text near it.
- A tap on the page's text no longer selects the word under the finger (or opens Chrome's search panel); a long press still does.
- Tapping away from a selection clears it again (refusing a tap's selection had left the old one standing), and "Select all" and the selection
  handles are no longer mistaken for a tap.
- A new song whose cover is still being found is waited for (up to 12 seconds) before the card is broken apart, so the song is drawn once, with
  its cover, instead of once as a placeholder and again with the cover. A song with no cover at all is shown at once.
- A new song now breaks the card apart in view, as it does when someone has touched it. For a card nobody had touched, its pieces vanished at once
  (a slightly negative first frame made their positions not a number), so the card snapped away and the new one assembled from nothing.
- A song played again (hours later, or straight away on repeat) shows as playing again. Ode's 20-minute "stuck now
  playing" clock was kept per song rather than per play, so a song heard earlier the same day was judged stuck the
  moment it started again and shown as last played. The clock now starts again when the song was seen finishing, when
  it has not been seen playing for 20 minutes, or when Last.fm has scrobbled anything since the clock started.
- A response from Last.fm that lags behind no longer brings back a song that had already finished as "playing".
- Website: the live card breaks apart into particles and the new card assembles again when the song changes, and now
  also when a song starts or ends, for every visitor. Since the card started being built in the background, this only
  happened for someone who had already touched the card. It does not happen while the card is off screen or shrinking
  away as the page scrolls, and a playing flag that flickers for a few seconds triggers it at most once.
- Website: scrolling fast on a phone no longer leaves a dark strip along the bottom of the screen. The address bar slides away
  as the page scrolls and the screen grows by its height at once, while the page's own viewport only catches up when the
  scrolling stops, so the background wash was shorter than the screen for the length of the scroll. It now covers the screen
  with the bar gone.

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
