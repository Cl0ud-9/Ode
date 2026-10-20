# Security policy

## Reporting a vulnerability

Please do not open a public issue for a security problem.

Report it privately through GitHub: open the [Security tab](https://github.com/Cl0ud-9/Ode/security) and choose
**Report a vulnerability**, or go straight to
[the advisory form](https://github.com/Cl0ud-9/Ode/security/advisories/new). Only the maintainer sees what you send.

Please include what you found, how to reproduce it (a card address or a request is ideal), and what you think an
attacker could do with it.

The maintainer aims to answer within a week. Fixes for confirmed problems are released as soon as they are ready, and
you will be credited in the notes unless you would rather not be.

## What counts

Examples of things worth reporting:

- A way to read or leak a deployment's keys (`LASTFM_API_KEY`, `GENIUS_TOKEN`, `YOUTUBE_API_KEY`) or secrets.
- A way around the `LASTFM_USER` lock, so that someone else can spend a deployment's keys or limits.
- Script or markup injection through a card (a title, an artist, an album, a URL parameter) or through the website.
- A request that makes a Worker fetch an address it should not (server-side request forgery).
- Anything that lets one deployment's visitors affect another's.

Not in scope: problems in Last.fm, Cloudflare or GitHub themselves, settings you chose yourself (such as
`OPEN_TO_ALL = "true"`), and findings that need access to your own Cloudflare or GitHub account.

## Supported versions

Only the latest release, and the current `main`, get security fixes. Ode is deployed as a copy in your own
account, so to receive a fix you pull it in: see **Updating your copy** in the [README](README.md#updating-your-copy).

## Keeping your own deployment safe

- Keep keys in Worker secrets (`npx wrangler secret put ...`) or in `.dev.vars`, which is git-ignored. Never put a
  key in `wrangler.toml` or commit it.
- Leave `OPEN_TO_ALL` unset unless you want to serve any Last.fm user.
