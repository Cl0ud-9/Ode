import { readFileSync } from "node:fs";
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
    expect(css).toContain(".liquid-live .hero-art .tilt { opacity: 0; transition: opacity 0s linear 180ms; }");
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
    expect(app).toContain('e.target.closest?.(".hero-art, .preview")');
    expect(app).toContain("holdSteady();");
  });

  it("honours reduced motion", () => {
    expect(app).toContain("prefers-reduced-motion");
    expect(readFileSync("site/styles.css", "utf8")).toContain("@media (prefers-reduced-motion: reduce)");
  });

  it("points people to deploy their own", () => {
    expect(html).toContain("https://deploy.workers.cloudflare.com/?url=https://github.com/Cl0ud-9/Ode");
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
