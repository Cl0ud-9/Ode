# Verify on GitHub

Everything here has been tested against a local SVG renderer and the Workers runtime, but not against GitHub's image proxy (camo). Run this checklist once on a real profile README before sharing your card. Use a scratch repo named `YOUR_USERNAME/YOUR_USERNAME` or any repo README.

1. Deploy, then add `![x](https://YOUR-WORKER.workers.dev/api/now?demo=playing)` and view it on github.com.
2. **Renders at all?** If it is a broken image, the embedded art or CSS is being rejected. Try `?demo=noart`, then `still=1`, to find which feature.
3. **Animation.** Bars, wave and the cover rings should move. If they do not, use `still=1` and make that the documented default.
4. **Colour mode.** Switch your OS theme between light and dark and reload. `mode=auto` should follow it. If GitHub's own theme disagrees with the OS, use the `<picture>` snippet from the README.
5. **Mobile.** Open the profile in the GitHub mobile app or a narrow window. Title text should stay readable.
6. **Freshness.** Start a track, load the profile, change track, reload every 30 seconds. Record how long the card takes to change. The README says a reload shows the current song; confirm that holds for you.
7. **Size.** Check a card with real art: `curl -s URL | wc -c`. Cards with real art run about 45 KB. The only limit I could find is camo's 5 MB default (unconfirmed for github.com), so this is a sanity check, not a hard ceiling.
8. **Fonts.** The title font depends on the viewer's system. Confirm nothing overflows with a long title in `expressive`.

If a check fails, open an issue with the card address, the theme and mode, and a screenshot of what GitHub showed.
