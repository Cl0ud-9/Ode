# Contributing to Ode

Thanks for wanting to help. Bug reports, ideas, new themes and pull requests are all welcome. Please keep to the
[code of conduct](CODE_OF_CONDUCT.md).

Ode is source-available, not open source: see [LICENSE](LICENSE). You may fork this repository to prepare
contributions, but not to publish or share your own copies. By opening a pull request you agree to clause 8 of the
license: you have the right to submit the change, and it becomes part of Ode under the author's terms.

## Before you start

- **Found a bug?** Search the [issues](https://github.com/Cl0ud-9/Ode/issues) first, then open one. Include the
  card URL, the theme and mode, and a screenshot of what GitHub showed.
- **Have an idea?** Open an issue before writing code, so we can agree on the approach. Large changes that were not
  discussed may be closed.
- **Found a security problem?** Do not open a public issue. Report it privately: see [SECURITY.md](SECURITY.md).

## Setup

Requirements: Node 22 or newer.

```bash
git clone https://github.com/<your-account>/ode.git
cd ode
npm install
npm run check      # typecheck + tests
npm run preview    # renders every theme and state to ./preview
npm run covers -- --track "Artist | Title | Album"   # which source finds a song's cover
```

To run against real data, put `LASTFM_API_KEY=...` in `.dev.vars` and use `npm run dev`. Demo cards
(`/api/now?demo=playing`) need no key.

## What a pull request needs

- `npm run check` passes.
- Visual changes include before and after images from `npm run preview`, in light and dark.
- New themes render every state (`playing`, `idle`, `noart`, `empty`, `error`) and keep text readable. The render
  tests cover this automatically once the theme is registered.
- Cards stay self-contained: no scripts, no `foreignObject`, no external images or fonts, only embedded `data:` art.
- Motion is CSS only, optional, and removed by `still=1`.
- Keep a card under about 50 KB with real art.
- Website changes work on a phone and with the keyboard, honour reduced motion, and add no build step. Check them in light and dark, and run Lighthouse (accessibility should stay at 100).
- A new cover source goes in `src/art/sources/`, matches on the same artist and the same title, treats throttling as `Throttled` (never as "no cover"), and comes with tests that use a fake `fetch`.

## Style

Match the surrounding code. Comments are short and explain why, not what. Plain wording in docs and in text shown on
cards, with no marketing language.
