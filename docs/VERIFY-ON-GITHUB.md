# Verify on GitHub

Everything here has been tested against a local SVG renderer and the Workers runtime, but not against GitHub's image proxy (camo). Run this checklist once on a real profile README before announcing anything. Use a scratch repo named `YOUR_USERNAME/YOUR_USERNAME` or any repo README.

1. Deploy, then add `![x](https://YOUR-WORKER.workers.dev/api/now?demo=playing)` and view it on github.com.
2. **Renders at all?** If it is a broken image, the embedded art or CSS is being rejected. Try `?demo=noart`, then `still=1`, to find which feature.
3. **Animation.** Bars, wave and the cover rings should move. If they do not, use `still=1` and make that the documented default.
4. **Colour mode.** Switch your OS theme between light and dark and reload. `mode=auto` should follow it. If GitHub's own theme disagrees with the OS, use the `<picture>` snippet from the README.
5. **Mobile.** Open the profile in the GitHub mobile app or a narrow window. Title text should stay readable.
6. **Freshness.** Start a track, load the profile, change track, reload every 30 seconds. Record how long the card takes to change. Put the real number in the README.
7. **Size.** Check a card with real art: `curl -s URL | wc -c`. Keep it under about 50 KB.
8. **Fonts.** The title font depends on the viewer's system. Confirm nothing overflows with a long title in `expressive`.

Record findings here when done:

| Check | Result |
|---|---|
| Renders | |
| Animation | |
| Auto colour mode | |
| Freshness after a track change | |
| Largest card size seen | |
