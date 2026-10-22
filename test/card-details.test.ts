import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { cardKey, dataForTrack, renderCard } from "../src/card.ts";
import { demoCard } from "../src/demo.ts";
import type { NowPlaying, Theme } from "../src/model.ts";

const now = 1_800_000_000;
const track = { title: "Closer", artist: "The Chainsmokers", album: "Collage", artUrl: null, playedAt: null };
const playing: NowPlaying = { user: "u", status: "playing", track };
const idle: NowPlaying = { user: "u", status: "idle", track: { ...track, playedAt: now - 600 } };
const card = (np: NowPlaying, theme: Theme = "expressive", still = false) => {
  const { data, seed } = dataForTrack(np, null, now);
  return renderCard(data, seed, { theme, mode: "dark", still });
};
const dashOf = (svg: string) => Number(svg.match(/class="pa [^"]*"[^>]*stroke-dasharray="([\d.]+) 9999"/)![1]);

describe("the wavy line", () => {
  it("spans the whole bar while a song plays, the same for every song", () => {
    const a = card(playing);
    const b = card({ ...playing, track: { ...track, title: "A much longer song title here" } });
    expect(dashOf(a)).toBeGreaterThan(500); // the full 490px column, measured along the curve
    expect(dashOf(a)).toBe(dashOf(b));
  });

  it("is not a progress bar: no stop dot, no growing part, no track", () => {
    const svg = card(playing);
    expect(svg).not.toMatch(/<circle cx="[\d.]+" cy="228"/);
    expect(svg).not.toContain("pgrow");
    expect(svg).not.toContain('class="pt ');
  });

  it("travels while both ends stay put: drift and dash move on one SMIL timeline", () => {
    const svg = card(playing);
    expect(svg).toContain("<animateTransform");
    expect(svg).toContain('<animate attributeName="stroke-dashoffset"');
    expect(svg).toMatch(/prefers-reduced-motion:reduce\)\{\.pw\{transform:none!important\}/);
  });

  it("is a still frame with ?still=1", () => {
    const svg = card(playing, "expressive", true);
    expect(svg).not.toContain("<animate");
    expect(svg).toContain('class="pa ');
  });

  it("is not drawn at all when nothing plays", () => {
    for (const theme of ["expressive", "minimal"] as const) {
      const svg = card(idle, theme);
      expect(svg).not.toContain('class="pa ');
      expect(svg).not.toContain("<animateTransform");
    }
  });

  it("is drawn by the minimal theme too", () => {
    expect(card(playing, "minimal")).toContain("<animateTransform");
  });
});

describe("the status pill", () => {
  it("hugs its label with even padding whatever font the viewer has", () => {
    const { data, seed } = demoCard("idle", now);
    const svg = renderCard(data, seed, { theme: "expressive", mode: "dark", still: true });
    const label = svg.match(/<text x="(\d+)" y="29" textLength="(\d+)" lengthAdjust="spacing"/)!;
    const pill = svg.match(/<rect width="(\d+)" height="44" rx="22"/)!;
    const left = Number(label[1]);
    const right = Number(pill[1]) - left - Number(label[2]);
    expect(left).toBe(right);
    expect(Number(pill[1])).toBeLessThan(255); // "PLAYED 3 H AGO" was 263 wide, padded 22 on the left and about 60 on the right
  });
});

describe("the card key the website polls", () => {
  it("stays the same between renders of the same song, so the page does not swap an identical card", () => {
    expect(cardKey(dataForTrack(playing, null, now).data)).toBe(cardKey(dataForTrack(playing, null, now + 30).data));
  });

  it("changes when the song, the cover or the status line changes", () => {
    const base = dataForTrack(playing, null, now).data;
    expect(cardKey({ ...base, track: { ...track, title: "Other" } })).not.toBe(cardKey(base));
    expect(cardKey({ ...base, artDataUri: "data:image/jpeg;base64,AAAA" })).not.toBe(cardKey(base));
    const ago = (s: number) => dataForTrack({ ...idle, track: { ...track, playedAt: now - s } }, null, now).data;
    expect(cardKey(ago(5 * 60))).not.toBe(cardKey(ago(9 * 60))); // "PLAYED 5 MIN AGO" -> "PLAYED 9 MIN AGO"
  });
});

describe("the website", () => {
  const html = readFileSync("site/index.html", "utf8");
  const app = readFileSync("site/app.js", "utf8");

  it("follows the live card: polls its key with HEAD requests while the tab is visible", () => {
    expect(app).toContain('method: "HEAD"');
    expect(app).toContain("X-Ode-Key");
    expect(app).toContain("X-Ode-Poll");
    expect(app).toContain("visibilitychange");
  });

  it("takes its colours from the card's palette, and CSS fades every surface to them", () => {
    expect(app).toContain("/api/theme");
    expect(html).toContain('<style id="palette">');
    expect(readFileSync("site/styles.css", "utf8")).toContain("--colour: background-color 300ms var(--ease)");
  });

  it("switches theme by swapping only the preview card, so the change is quick", () => {
    expect(app).toMatch(/state\.theme = btn\.dataset\.theme;\s*swapCard\(\$\("look-card"\), lookUrl\(\)\);/);
  });

  it("keeps buttons still: only the cards tilt toward the cursor", () => {
    expect(html).not.toContain("data-magnetic");
    expect(html).not.toMatch(/class="btn[^"]*tilt/);
    expect(html).toContain('<span class="tilt float"><img id="hero-card"');
  });

  it("is set in Google Sans Flex, served from the site itself", () => {
    const css = readFileSync("site/styles.css", "utf8");
    expect(css).toContain('--sans: "Google Sans Flex"');
    // The font files are real woff2 and are declared, preloaded and cached; nothing third-party blocks the first paint.
    for (const file of ["GoogleSansFlex.woff2", "GoogleSansCode.woff2"]) {
      expect(readFileSync(`site/fonts/${file}`).subarray(0, 4).toString("latin1"), file).toBe("wOF2");
      expect(css).toContain(`/fonts/${file}`);
    }
    expect(html).toContain('<link rel="preload" href="/fonts/GoogleSansFlex.woff2" as="font" type="font/woff2" crossorigin>');
    expect(html).not.toMatch(/fonts\.(googleapis|gstatic)\.com/);
    expect(readFileSync("site/_headers", "utf8")).toContain("/fonts/*");
    // The font's licence travels with it.
    expect(readFileSync("site/fonts/OFL.txt", "utf8")).toContain("SIL OPEN FONT LICENSE Version 1.1");
  });

  it("sets text in a width-matched local face until the real font arrives, so nothing reflows", () => {
    const css = readFileSync("site/styles.css", "utf8");
    expect(css).toMatch(/@font-face \{ font-family: "Ode Fallback";[^}]*size-adjust/);
    expect(css).toMatch(/@font-face \{ font-family: "Ode Fallback Display";[^}]*size-adjust/);
    expect(css).toContain('--sans: "Google Sans Flex", "Ode Fallback"');
  });

  it("hands out a snippet with a width and height, so GitHub reserves the space while the card loads", () => {
    expect(app).toContain('width="480" height="${height}"');
    expect(app).toContain('"minimal" ? 87 : 150');
  });

  it("lights each word from dim to bright as it scrolls, and back again, with legible dim words", () => {
    const css = readFileSync("site/styles.css", "utf8");
    // Scroll-driven, so it plays both ways; each word has its own view timeline, staggered by its index.
    expect(css).toMatch(/\.words \.w \{[^}]*animation: lit linear both; animation-timeline: view\(\);/);
    expect(css).toContain("@keyframes lit { to { color: var(--md-on-surface); } }");
    // The dim word is half ink: about 3.3:1 against the page, what large text needs, and clearly dimmer than the lit word.
    expect(css).toMatch(/\.words \.w \{ color: color-mix\(in srgb, var\(--md-on-surface\) 50%, var\(--md-surface\)\)/);
  });

  it("keeps the card and the controls still while they change", () => {
    const css = readFileSync("site/styles.css", "utf8");
    // The Copy button keeps one width for both labels; the real card is back at once when the liquid card settles.
    expect(css).toContain("#copy { min-width: 180px; }");
    expect(css).toContain(".liquid-live .hero-art .tilt .card-img { opacity: 0; transition: opacity 0s linear 180ms; }");
    // The snippet box morphs its height and fades only its text, never the whole box.
    expect(app).toContain("const morph = async (next)");
    expect(app).not.toContain('{ opacity: 0, transform: "translateY(8px)" }');
  });

  it("builds the footer word early and in slices, and bounds the click ring", () => {
    const ht = readFileSync("site/halftone.js", "utf8");
    // Built between frames and swapped in whole; the plain wordmark stays until it is ready.
    expect(ht).toContain("const slice = () => new Promise((done) => setTimeout(done, 0));");
    expect(ht).toContain("return { ready, stop };");
    expect(app).toContain("await halftone({ stage, canvas, word: \"Ode\", reduced }).ready;");
    // It starts when the visitor first scrolls, not when the footer arrives.
    expect(app).toContain('addEventListener("scroll", go, { passive: true });');
    // No ring runs by itself (one used to set the whole word moving on arrival), and a click's ring has a fixed reach.
    expect(ht).not.toContain("greeted");
    expect(ht).toContain("const RING_REACH = 520;");
  });

  it("lets you hold a card without the browser's image menu or a drag", () => {
    const css = readFileSync("site/styles.css", "utf8");
    // Neither card can be picked up, and neither can be selected.
    expect(html.match(/<img id="(?:hero|look)-card"[^>]*draggable="false"/g)?.length).toBe(2);
    expect(css).toContain(".card-img, .hero-art, .preview .tilt { -webkit-user-select: none; user-select: none; -webkit-touch-callout: none; -webkit-user-drag: none; }");
    // On touch, a long-press on a card does not open Chrome's Open / Download / Share sheet; a mouse's right-click still works.
    expect(app).toContain('document.addEventListener("contextmenu"');
    expect(app).toContain('e.target.closest?.(".hero-art, .preview, .foot-mark")');
    expect(app).toContain("holdSteady();");
  });

  it("keeps the footer word unselectable on iOS, which ignores the unprefixed property", () => {
    const css = readFileSync("site/styles.css", "utf8");
    // Safari needs the prefix, on the word and on everything in it, and the callout off; the page also refuses the
    // selection itself where iOS starts one anyway (a long press, a double tap).
    expect(css).toContain("-webkit-user-select: none; user-select: none; -webkit-touch-callout: none;");
    expect(css).toContain(".foot, .foot * { -webkit-user-select: none; user-select: none; }");
    // A long press on the empty space above the word used to select the nearest text, the small print; only that is selectable.
    expect(css).toContain(".foot-row, .foot-row * { -webkit-user-select: text; user-select: text; }");
    expect(css.indexOf(".foot-row, .foot-row * {")).toBeGreaterThan(css.indexOf(".foot, .foot * {"));
    expect(app).toContain('document.addEventListener("selectstart"');
    expect(app).toContain('at?.closest(".foot-mark")');
    // Chrome on Android still picks the nearest word for a press on the dark space above the word; that press is refused.
    expect(app).toContain("pressedAt.y > last.bottom && pressedAt.y < row.top");
    // A tap (the finger already up when the selection starts) must not select a word, nor open Touch to Search; a long press, which selects while
    // the finger is down, and a field's own caret are left alone.
    expect(app).toContain('if (touching === false && !at?.closest("input, textarea, [contenteditable]")) e.preventDefault();');
  });

  it("draws the footer word with WebGL2 where it can, and falls back to a 2D canvas", () => {
    const ht = readFileSync("site/halftone.js", "utf8");
    // One instanced draw for every dot; only the dots in motion are re-uploaded.
    expect(ht).toContain("gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, n);");
    expect(ht).toContain("gl.vertexAttribDivisor(1, 1);");
    expect(ht).toContain("gl.bufferSubData(gl.ARRAY_BUFFER, 0, data);");
    // A canvas that has had a WebGL context cannot give a 2D one: a failed build swaps in a fresh canvas.
    expect(ht).toContain("canvas.replaceWith(fresh);");
    expect(ht).toContain('canvas.getContext("2d")');
    // A lost context shows the plain wordmark (not a blank box) until it is back and the dots are drawn again.
    expect(ht).toContain('canvas.addEventListener("webglcontextlost", onLost);');
    expect(ht).toContain('canvas.addEventListener("webglcontextrestored", onRestored);');
    expect(ht).toContain('canvas.style.visibility = "hidden";');
  });

  it("keeps the background wash as tall as the screen can get, so a fast scroll never shows a bare strip", () => {
    const css = readFileSync("site/styles.css", "utf8");
    // The address bar sliding away grows the screen before the page's viewport catches up; the wash covers the large viewport.
    expect(css).toContain("@supports (height: 100lvh) { .wash { bottom: auto; height: 100lvh; } }");
  });

  it("lets the first tap disperse the card at once, without the card jumping", () => {
    const css = readFileSync("site/styles.css", "utf8");
    const liquid = readFileSync("site/liquid.js", "utf8");
    // The card is built quietly once the page has settled (it takes about a second on a phone, which a tap must not wait
    // for), where memory allows; nothing changes on screen until someone comes near the card.
    expect(app).toContain("function startLiquid() {");
    expect(app).toContain("const arm = () =>");
    expect(app).toContain('requestIdleCallback(arm, { timeout: 4000 })');
    expect(app).toContain("(navigator.deviceMemory || 4) > 2");
    // A touch on or near the card takes it over (one elsewhere in the hero is only a scroll); a touch that comes before the card is
    // ready is played back to it, so even then the first tap does what the second used to.
    expect(app).toContain("if (!nearCard(e)) return;");
    expect(app).toContain("if (!liquidReady) pokeAt = { x: e.clientX, y: e.clientY, t: performance.now() };");
    expect(app).toContain("function takeOver() {");
    expect(app).toContain("liquid.poke(pokeAt.x, pokeAt.y);");
    expect(liquid).toContain("    poke(clientX, clientY) {");
    expect(liquid).toContain('engine.pointer("down", ...at(pt), true);');
    // The built card waits (no liquid-on, no intro) until it is engaged by the first pointer near it.
    expect(liquid).toContain("const engage = () => {");
    expect(liquid).toContain("await build(src, intro && engaged);");
    expect(liquid).toContain("if (engaged) {");
    // The float stops where it is, and the tilt and the shrink on scroll go before the card is measured and built.
    expect(app).toContain("function stillHero() {");
    expect(app).toContain('tilt.style.setProperty("--rest"');
    expect(liquid).toContain('a.id === "ode-still"');
    expect(css).toContain(".liquid-still .hero-art .tilt { translate: var(--rest, none); transform: none; transition: none; }");
    expect(css).toContain(".liquid-on .hero-art .tilt { translate: var(--rest, none) !important; }");
    // A card that fails to load goes back to floating.
    expect(app).toContain('document.documentElement.classList.remove("liquid-still");');
    expect(liquid).toContain('root.classList.remove("liquid-on", "liquid-live", "liquid-still");');
  });

  it("answers a cursor that was already on the card when the page loaded, even if it then rests", () => {
    const liquid = readFileSync("site/liquid.js", "utf8");
    // The cursor's place is kept from the first moment (before the page starts and before the card exists), since a mouse that
    // rests after a refresh sends nothing more; once the card is ready it is told where the cursor is.
    expect(app).toContain("function watchHover() {");
    expect(app).toContain('hero.addEventListener("pointermove", track, { passive: true });');
    expect(app).toContain("watchHover();");
    expect(app).toContain("if (hover.in && nearCard(hover)) liquid.hover(hover.clientX, hover.clientY);");
    expect(app).toContain("if (hover.in) startLiquid();");
    expect(liquid).toContain("    hover(clientX, clientY) {");
    expect(liquid).toContain('engine.pointer("move", ...at(pt), false);');
  });

  it("builds the card quickly: shaders together, and the card image the page already has", () => {
    const liquid = readFileSync("site/liquid.js", "utf8");
    // Every program is linked before any is asked how it went, so the driver compiles them side by side.
    expect(liquid).toContain("function compileAll(gl, sources) {");
    expect(liquid).toContain("[this.pFlow, this.pSim, this.pPart, this.pImg] = compileAll(gl,");
    expect(liquid).not.toContain("function compile(gl, vs, fs)");
    // The card on the page is already decoded: it is not fetched and decoded again.
    expect(liquid).toContain("let img = card;");
  });

  it("draws the card on exactly the pixels the real one is on, with crisp edges at rest", () => {
    const liquid = readFileSync("site/liquid.js", "utf8");
    // Positions are worked out against the canvas's own rows, not its CSS height (a fraction of a device pixel different).
    expect(liquid).toContain("const resY = this.canvas.height / dpr;");
    expect(liquid).toContain("gl.uniform2f(I.u.uRes, this.cssW, resY);");
    expect(liquid).toContain("gl.uniform2f(P.u.uRes, this.cssW, resY);");
    // The card's edges only feather while the picture is pulled about; at rest they are one pixel of anti-aliasing.
    expect(liquid).toContain("vec2 fe = max(vec2(0.004,0.01)*smoothstep(0.0, 3.0, length(disp)), aa);");
    expect(liquid).not.toContain("smoothstep(vec2(0.0), vec2(0.004,0.01), suv)");
  });

  it("settles without the card thinning: the picture arrives before the particles leave", () => {
    const liquid = readFileSync("site/liquid.js", "utf8");
    // Fading the particles out in step with the picture fading in left the card at three quarters strength for a moment (two
    // layers at half strength cover 1 - 0.5 * 0.5). The particles now stay until the picture is nearly all the way in.
    expect(liquid).toContain("float restA = smoothstep(0.0, 0.15, uRest);");
    expect(liquid).toContain("float a = max(max(E, lift), max(restA, 1.0-uIntroVis));");
    expect(liquid).toContain("float show = (1.0 - max(E, uRest*uRest))*uIntroVis;");
  });

  it("puts the real card back under the canvas well before the canvas fades, so the card never dips", () => {
    const liquid = readFileSync("site/liquid.js", "utf8");
    const css = readFileSync("site/styles.css", "utf8");
    // Once the particles are home and the canvas is the whole card (opaque, copying the real one), the page puts the real card
    // back underneath; the canvas fades only after everything has settled, over the real card that has been there a while.
    expect(liquid).toContain("const backed = (!active || calm) && this.hide < 0.01;");
    expect(liquid).toContain("engine.onBack = (back) => {");
    expect(liquid).toContain('root.classList.add("liquid-back");');
    expect(css).toContain(".liquid-live.liquid-back .hero-art .tilt .card-img { opacity: 1; transition: none; }");
    // The fade is gentle (the shared curve is very front-loaded), and the engine keeps copying the live card through it.
    expect(css).toContain(".liquid-on:not(.liquid-live) .liquid { transition: opacity 240ms cubic-bezier(0.4, 0, 0.2, 1); }");
    expect(liquid).toContain("const HANDOFF_MS = 900;");
    expect(liquid).toContain("if (this.wasActive && !this.tailUntil) this.tailUntil = now + HANDOFF_MS;");
  });

  it("has no card-shaped glare hanging over the pieces of the liquid card", () => {
    const css = readFileSync("site/styles.css", "utf8");
    // The glare that follows the mouse is a rectangle the size of the card; it is off while the card is liquid, and the tilt
    // script does not feed it.
    expect(css).toContain(".liquid-still .hero-art .tilt::after { display: none; }");
    expect(app).toContain('if (liquidHero?.contains("liquid-still")) return;');
  });

  it("hands the particle card over to the real one without a soft, dim tail", () => {
    const liquid = readFileSync("site/liquid.js", "utf8");
    const css = readFileSync("site/styles.css", "utf8");
    // The tail is counted in real time, so a slow phone does not stretch it; frame-based decays are scaled to it.
    expect(liquid).toContain("const SETTLE_MS = 1800;");
    expect(liquid).toContain("this.settle = interacting ? 0 : this.settle + Math.min(rawMs, 100);");
    expect(liquid).toContain("const dtt = clamp(rawMs / 16.6667, 0.25, 8);");
    // The canvas has the screen's own pixel ratio (up to 3, as on phones), so it is as crisp as the real card.
    expect(liquid).toContain("let dpr = Math.min(devicePixelRatio || 1, 3);");
    // The card's shadow belongs to the spot, not the picture, so it does not vanish and reappear at the hand-off.
    expect(css).toContain(".hero-art .tilt::before { content: \"\"; position: absolute; inset: 0; z-index: -1; border-radius: 28px; box-shadow: 0 30px 60px var(--card-shadow);");
    // ...but it is a rectangle, so while the card is liquid it fades away instead of sitting under the moving pieces.
    expect(css).toContain(".liquid-live .hero-art .tilt::before { opacity: 0; transition-duration: 400ms; }");
    // The fades are an even ease-in-out, quick out and slow back in (the shared curve is front-loaded, and made the shadow blink).
    expect(css).toContain("transition: opacity 900ms cubic-bezier(0.4, 0, 0.2, 1); }");
    expect(css).toContain(".liquid-live.liquid-back .hero-art .tilt::before { opacity: 1; transition-duration: 900ms; }");
    // In dark mode the song's colour is a light one, which as a shadow read as a pale haze: there it is a plain dark shadow.
    expect(css).toContain("--card-shadow: var(--md-shadow);");
    expect(css).toContain("--card-shadow: color-mix(in srgb, #000 55%, transparent);");
    expect(css).toContain("box-shadow: 0 30px 60px var(--card-shadow);");
  });

  it("breaks the old card apart before the new song appears", () => {
    const liquid = readFileSync("site/liquid.js", "utf8");
    // The engine can dissolve the card and says when it has gone; a new card ends the dissolve, and a missing one is put back.
    expect(liquid).toContain("  dissolve(ms = 850) {");
    // A frame time is never negative: the first frame after waking from rest can be stamped before the wake, and a negative
    // dissolve step makes its power a NaN that empties every particle (the card vanished, then assembled the new one).
    expect(liquid).toContain("const rawMs = Math.max(0, now - this.last);");
    expect(liquid).toContain("  restore() {");
    expect(liquid).toContain("    async dissolve() {");
    expect(liquid).toContain("await engine.dissolve();");
    // Every viewer sees it, not only someone who has played with the card: a card nobody has touched is taken over first
    // (and measured once it is still), unless that would not be seen or would make it jump.
    const dissolve = liquid.slice(liquid.indexOf("    async dissolve() {"), liquid.indexOf("await engine.dissolve();"));
    expect(dissolve).toContain("if (!engine?.canShow() || !built) return;");
    expect(dissolve).toContain("if (!fullyInView()) return;");
    expect(dissolve.indexOf("engage();")).toBeLessThan(dissolve.indexOf("await easing;"));
    expect(liquid).toContain('getComputedStyle(art).opacity === "1"');
    expect(liquid).toContain("if (!this.canShow()) return Promise.resolve();");
    // The page starts the dissolve first, waits for it (and the new card) before changing the song, and restores on failure.
    const refresh = app.slice(app.indexOf("async function refresh()"), app.indexOf("/* Live updates:"));
    expect(refresh.indexOf("liquid.dissolve()")).toBeGreaterThan(refresh.indexOf("fetchTheme()"));
    // ...and it overlaps the loading of the new card, and the page waits for both before it changes anything.
    expect(refresh.indexOf("liquid.dissolve()")).toBeLessThan(refresh.indexOf("preload(url)"));
    expect(refresh.indexOf("leaving", refresh.indexOf("preload(url)"))).toBeLessThan(refresh.indexOf("paint(theme.palette)"));
    expect(refresh.indexOf("paint(theme.palette)")).toBeLessThan(refresh.indexOf("swapCard($(id), url)"));
    expect(refresh).toContain("liquid?.restore();");
  });

  it("only breaks the card apart for a different song, different colours or the song starting or ending, never for a tick of the clock", () => {
    const refresh = app.slice(app.indexOf("async function refresh()"), app.indexOf("/* Live updates:"));
    // The card's key also changes when "played 8 min ago" becomes "9 min ago", when the tempo is read, when the playing
    // flag flickers: none of those is a new card. The song and the palette decide.
    expect(refresh).toContain('const song = [theme.title, theme.artist, theme.album].join("\\u0000")');
    expect(refresh).toContain("look = JSON.stringify(theme.palette)");
    expect(refresh).toContain("const quiet = refreshed && song === state.song && look === state.look && !turned;");
    // The same song starting or ending (played again later, it goes from "last played" back to playing) is a change too,
    // unless the state it leaves held only a moment (the playing flag flickering); the state the page opened on counts as held.
    expect(refresh).toContain("turned = refreshed && theme.kind !== state.kind && now - state.kindAt >= FLICKER_MS;");
    expect(refresh).toContain("state.kindAt = refreshed ? now : 0;");
    expect(app).toContain("const FLICKER_MS = 15_000;");
    expect(refresh).toContain("if (refreshed && liquid && !quiet) leaving = liquid.dissolve();");
    // A quiet update waits until nobody is playing with the card, and builds without the assemble animation.
    expect(refresh).toContain("await liquid?.rested();");
    expect(refresh).toContain("await syncLiquid(false);");
    expect(readFileSync("site/liquid.js", "utf8")).toContain("rested: () =>");
    expect(app).not.toMatch(/\u0000/);
  });

  it("gives the GitHub link a bubble of its own, always visible, apart from the one that marks the section you are reading", () => {
    const css = readFileSync("site/styles.css", "utf8");
    // Only links to places on this page (they have a hash) move the sliding highlight; GitHub sends it back to the section being read.
    expect(app).toContain("const here = !!a.hash;");
    expect(app).toContain('a.addEventListener("pointerenter", () => (here ? point(a) : mark()));');
    expect(app).toContain('a.addEventListener("focus", () => (here ? point(a) : mark()));');
    // GitHub's own bubble is always there (not only on hover), deepens under the pointer or keyboard, and never travels.
    expect(css).toContain(".nav-gh::before { content: \"\"; position: absolute; inset: 0; z-index: -1;");
    expect(css).not.toMatch(/\.nav-gh::before \{[^}]*opacity: 0/);
    expect(css).toContain(".nav-gh:hover::before, .nav-gh:focus-visible::before { background-color:");
    expect(css).toContain(".nav-gh .gh-count { background-color: color-mix(in srgb, var(--md-on-secondary-container) 15%, transparent); }");
  });

  it("honours reduced motion", () => {
    expect(app).toContain("prefers-reduced-motion");
    expect(readFileSync("site/styles.css", "utf8")).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("points people to deploy their own", () => {
    expect(html).toContain("https://deploy.workers.cloudflare.com/?url=https://github.com/Cl0ud-9/Ode");
  });
});

describe("the repository's front door", () => {
  it("has link-preview tags that point at an image that exists, at the size they say", () => {
    const html = readFileSync("site/index.html", "utf8");
    expect(html).toContain('<meta property="og:image" content="https://ode.cl0ud-9.workers.dev/social.jpg">');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    // A JPEG: starts FF D8, and its frame header carries the size the tags promise (1280 x 640).
    const jpg = readFileSync("site/social.jpg");
    expect(jpg.subarray(0, 2).toString("hex")).toBe("ffd8");
    let at = 2, size: [number, number] | null = null;
    while (at < jpg.length && !size) {
      const marker = jpg[at + 1] ?? 0;
      if (marker >= 0xc0 && marker <= 0xc3) size = [jpg.readUInt16BE(at + 7), jpg.readUInt16BE(at + 5)];
      else at += 2 + jpg.readUInt16BE(at + 2);
    }
    expect(size).toEqual([1280, 640]);
    expect(jpg.length).toBeLessThan(1_000_000);
  });

  it("links only to files and anchors that exist", () => {
    const readme = readFileSync("README.md", "utf8");
    // Every local file the README links to or shows must be in the repository.
    const files = [...readme.matchAll(/(?:href|src|srcset)="((?:docs|site)\/[^"#?]+)"/g)].map((m) => m[1]!)
      .concat([...readme.matchAll(/\]\(((?:docs|site)\/[^)#?\s]+|[A-Z][A-Z-]+\.md)\)/g)].map((m) => m[1]!));
    expect(files.length).toBeGreaterThan(10);
    for (const f of new Set(files)) expect(existsSync(f), `${f} is linked from the README but is missing`).toBe(true);
    // Every in-page anchor must match a heading.
    const slug = (h: string) => h.toLowerCase().replace(/[^\w\s-]/g, "").trim().replace(/\s+/g, "-");
    const headings = new Set([...readme.matchAll(/^#{1,4} (.+)$/gm)].map((m) => slug(m[1]!)));
    for (const [, a] of readme.matchAll(/href="#([^"]+)"/g)) expect(headings.has(a!), `#${a} has no heading`).toBe(true);
    for (const [, a] of readme.matchAll(/\]\(#([^)]+)\)/g)) expect(headings.has(a!), `#${a} has no heading`).toBe(true);
  });

  it("sets the main title's stand-in font to match the real one, so the text does not jump when the font arrives", () => {
    const css = readFileSync("site/styles.css", "utf8");
    // The title is wider than the other headings, so it has its own scale: 132% above 430 px, 116% on a phone (chosen by comparing
    // where every word lands in both fonts from 1440 px down to 320 px).
    expect(css).toContain('@font-face { font-family: "Ode Fallback Hero"; src: local("Arial"), local("Helvetica Neue"), local("Helvetica"); size-adjust: 132%; }');
    expect(css).toContain("@media (max-width: 430px) { @font-face { font-family: \"Ode Fallback Hero\";");
    expect(css).toContain('--sans-hero: "Google Sans Flex", "Ode Fallback Hero"');
    expect(css).toContain("h1 { font-family: var(--sans-hero); }");
  });

  it("skips the work for sections below the first screen, and keeps their controls placed", () => {
    const css = readFileSync("site/styles.css", "utf8");
    // Off-screen sections are not laid out or painted until about to be seen (most of the page's work at load), hold the height
    // they will have, and keep room for the panels' shadows inside their paint area.
    expect(css).toContain("@supports (content-visibility: auto) {");
    expect(css).toContain(".section { position: relative; content-visibility: auto; contain-intrinsic-size: auto calc(var(--ih, 800px) - clamp(96px, 14vh, 168px));");
    expect(css).toContain("overflow-clip-margin: 160px; padding-bottom: 64px; margin-bottom: -64px; }");
    // The padding that the placeholder subtracts must be the one the section really has.
    expect(css).toContain(".section { padding: clamp(96px, 14vh, 168px) 0 0; }");
    for (const id of ["features", "card", "how", "get", "faq"]) expect(css).toContain(`#${id} { --ih:`);
    // The footer is left alone: its word is measured and built long before it is reached.
    expect(css).not.toMatch(/\.foot[^{]*\{[^}]*content-visibility/);
    // A segmented control in a section that has not been drawn has no size; it is placed when the section gets one.
    const app = readFileSync("site/app.js", "utf8");
    expect(app).toContain("groups.forEach((g) => new ResizeObserver(() => placeIndicator(g, true)).observe(g));");
    // The bar's highlight must switch where it always did: that box now reaches 64px further, so it watches a marker over the
    // section's own box (the same 64px) instead, and only where sections are skipped; elsewhere it watches the section as before.
    expect(css).toContain(".spy { position: absolute; inset: 0 0 64px; visibility: hidden; pointer-events: none; }");
    expect(app).toContain('CSS.supports("content-visibility", "auto")');
    expect(app).toContain("marks.set(watched, s);");
    expect(app).toContain("seen.observe(watched);");
    expect(app).toContain("`#${marks.get(e.target).id}`");
  });

  it("keeps the files GitHub's community profile looks for", () => {
    for (const f of ["README.md", "LICENSE", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md", "CHANGELOG.md", ".github/PULL_REQUEST_TEMPLATE.md", ".github/ISSUE_TEMPLATE/bug_report.yml", ".github/ISSUE_TEMPLATE/feature_request.yml", ".github/ISSUE_TEMPLATE/config.yml"]) expect(existsSync(f), f).toBe(true);
  });

  it("writes plainly: no em dashes in the README or the guides", () => {
    for (const f of ["README.md", "CONTRIBUTING.md", "CODE_OF_CONDUCT.md", "SECURITY.md", "CHANGELOG.md"]) expect(readFileSync(f, "utf8"), f).not.toContain("—");
  });
});

describe("consistency across states and scripts", () => {
  it("measures Indic titles by their letters, not their vowel signs, so they are not cut short", async () => {
    const { textEm } = await import("../src/util.ts");
    const hindi = "सम्पूर्ण गीता सार हिन्दी में";
    const marks = [...hindi].filter((c) => /\p{M}/u.test(c)).length;
    expect(marks).toBeGreaterThan(5);
    // Rendered, this title is about 10.5em wide in bold; counting every mark made it over 15em.
    expect(textEm(hindi, false, true)).toBeLessThan(12.5);
    expect(card({ ...playing, track: { ...track, title: hindi, album: "" } })).toContain(`>${hindi}</text>`);
  });

  it("measures emoji as emoji (they were caught by the CJK rule first)", async () => {
    const { textEm } = await import("../src/util.ts");
    expect(textEm("🎧")).toBeCloseTo(1.1 * 1.06, 5);
  });

  it("keeps the album on the minimal card after the song ends", () => {
    expect(card(idle, "minimal")).toContain("The Chainsmokers · Collage");
  });

  it("marks only an album with the disc icon, not the hint on a quiet or offline card", () => {
    const disc = /<circle cx="282" cy="\d+" r="10"/;
    expect(card(playing)).toMatch(disc);
    for (const demo of ["empty", "error"] as const) {
      const { data, seed } = demoCard(demo, now);
      expect(renderCard(data, seed, { theme: "expressive", mode: "dark", still: true })).not.toMatch(disc);
    }
  });
});
