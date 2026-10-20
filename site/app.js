// Ode's website. The page wears the colours of the song on the live card: it reads the card's palette from
// /api/theme and rewrites the Material role tokens; CSS fades every surface to the new colours.

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const dark = matchMedia("(prefers-color-scheme: dark)");

// A reload starts at the top (unless the address names a section): restoring the old position while fonts and cards
// are still settling would land somewhere further down the page.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
if (!location.hash) scrollTo(0, 0);

const state = { owner: null, theme: "expressive", style: "content", key: null, mood: "steady", heroOn: true, song: null, look: null };

/* ---------- Colour: palette roles -> CSS tokens ---------- */

const ROLE_VARS = {
  surface: "surface", container: "container", containerHigh: "container-high", onSurface: "on-surface", onVariant: "on-variant",
  outline: "outline", primary: "primary", onPrimary: "on-primary", primaryContainer: "primary-container",
  onPrimaryContainer: "on-primary-container", secondaryContainer: "secondary-container",
  onSecondaryContainer: "on-secondary-container", tertiary: "tertiary", tertiaryContainer: "tertiary-container", bgA: "bg-a", bgB: "bg-b",
};
const tokens = (scheme) => Object.entries(ROLE_VARS).map(([role, name]) => (scheme[role] ? `--md-${name}:${scheme[role]};` : "")).join("");

let lastPalette = null, painted = false;
function paint(palette) {
  lastPalette = palette;
  // The first palette is the page's colours arriving, not a change to animate: easing every surface into place at once
  // is a lot of work for a phone, for no benefit. Later palettes (a new song, a new style) do ease.
  const first = !painted;
  painted = true;
  const root = document.documentElement;
  if (first) {
    root.classList.add("no-ease");
    requestAnimationFrame(() => requestAnimationFrame(() => root.classList.remove("no-ease")));
  }
  $("palette").textContent = `:root{${tokens(palette.light)}}@media (prefers-color-scheme:dark){:root{${tokens(palette.dark)}}}`;
  const scheme = dark.matches ? palette.dark : palette.light;
  document.querySelector('meta[name="theme-color"]').setAttribute("content", scheme.surface);
}
dark.addEventListener("change", () => lastPalette && paint(lastPalette));

/* ---------- The live card ---------- */

const cardParams = (theme) => {
  const p = new URLSearchParams(state.owner ? { user: state.owner } : { demo: "playing" });
  p.set("corners", "clear");
  if (theme && theme !== "expressive") p.set("theme", theme);
  if (state.style !== "content") p.set("scheme", state.style);
  if (state.key) p.set("k", state.key);
  return p;
};
const heroUrl = () => `/api/now?${cardParams()}`;
const lookUrl = () => `/api/now?${cardParams(state.theme)}`;

/** Loads an image off-screen first, so swapping it in never shows a blank frame. */
const preload = (src) => new Promise((done) => { const img = new Image(); img.onload = img.onerror = () => done(src); img.src = src; });

/** Swaps a card image, one card on screen at a time: the old one leaves (a short fade and shrink) while the new one
    loads, and only then does the new one arrive, springing in from a soft blur. Nothing overlaps, so there is never a
    double image, and the panel around it does not move. Asking again mid-swap just changes what arrives. */
const swaps = new WeakMap();
const AWAY = [{ opacity: 1, transform: "none", filter: "blur(0px)" }, { opacity: 0, transform: "scale(0.95)", filter: "blur(6px)" }];
function swapCard(img, src) {
  const st = swaps.get(img) ?? {};
  swaps.set(img, st);
  st.want = src;
  if (st.busy) return st.busy;
  if (img.getAttribute("src") === src) return Promise.resolve();
  st.busy = (async () => {
    let out = null;
    const motion = () => !reduced && img.isConnected && !!img.naturalWidth && !(img.id === "hero-card" && document.documentElement.classList.contains("liquid-on"));
    if (motion()) out = img.animate(AWAY, { duration: 170, easing: "cubic-bezier(0.3, 0, 0.8, 0.15)", fill: "forwards" });
    while (img.getAttribute("src") !== st.want) {
      const next = st.want;
      await Promise.all([preload(next), out?.finished.catch(() => {})]);
      if (next !== st.want) continue; // a newer card was asked for while this one loaded
      img.src = next;
      await img.decode().catch(() => {});
    }
    if (out) {
      img.animate([...AWAY].reverse(), { duration: 420, easing: "cubic-bezier(0.34, 1.3, 0.64, 1)" });
      out.cancel();
    }
    st.busy = null;
  })();
  return st.busy;
}

/** The card's palette and song: the owner's when they are live, otherwise the demo's (`probe` asks for the owner). */
async function fetchTheme(probe = false) {
  const p = new URLSearchParams(probe ? {} : state.owner ? { user: state.owner } : { demo: "playing" });
  if (state.style !== "content") p.set("scheme", state.style);
  const res = await fetch(`/api/theme?${p}`, { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

// Per mood: the marquee's lap, the disc's turn and the equaliser's beat.
const MOOD_PACE = { calm: "70s", steady: "48s", lively: "34s", intense: "24s" };
const MOOD_SPIN = { calm: "6s", steady: "4s", lively: "2.8s", intense: "2s" };
const MOOD_BEAT = { calm: "1.4s", steady: "1s", lively: "0.75s", intense: "0.55s" };

function describe(t) {
  const playing = t.kind === "playing";
  $("live").classList.toggle("playing", playing && !!state.owner);
  const song = t.title ? `${t.title} · ${t.artist}` : "";
  if (!state.owner) { $("live-label").textContent = "Demo"; $("live-song").textContent = "deploy yours for the real thing"; }
  else if (playing) { $("live-label").textContent = "Live"; $("live-song").textContent = song; }
  else if (t.kind === "idle") { $("live-label").textContent = "Last played"; $("live-song").textContent = song; }
  else { $("live-label").textContent = "Quiet"; $("live-song").textContent = ""; }
  $("hero-card").alt = t.title ? `${playing ? "Now playing" : "Last played"}: ${t.title} by ${t.artist}` : "A now-playing card";
  state.mood = playing && MOOD_PACE[t.mood] ? t.mood : "steady";
  const root = document.documentElement;
  root.style.setProperty("--marquee", MOOD_PACE[state.mood]);
  root.style.setProperty("--spin", MOOD_SPIN[state.mood]);
  root.style.setProperty("--beat", MOOD_BEAT[state.mood]);
  root.classList.toggle("playing-now", playing);
  $("now-chip-text").textContent = state.owner && song ? song : "";
}

/** New palette and both cards at once: used when the song or the colour style changes. */
let refreshed = false;
async function refresh() {
  let leaving = Promise.resolve();
  try {
    const theme = await fetchTheme();
    state.key = theme.key;
    // The card's key changes for small things too: "played 8 min ago" becoming "9 min ago", the tempo being read a few
    // seconds into a song, Last.fm's playing flag flickering. Only a different song or different colours is worth
    // breaking the card apart for; anything else is a quiet update, with no dissolve.
    const song = [theme.title, theme.artist, theme.album].join("\u0000"), look = JSON.stringify(theme.palette);
    const quiet = refreshed && song === state.song && look === state.look;
    state.song = song;
    state.look = look;
    // On a change of song (or colour style) the card on the page breaks apart first, and only then does the new one
    // take its place: the particles go while the old song is still showing, and the page changes to the new one after.
    if (refreshed && liquid && !quiet) leaving = liquid.dissolve();
    // The demo card never changes, so on the first load the cards already on the page are right: the same address
    // plus a cache key is not worth fetching again (it would also be the page's biggest image, requested twice).
    const settled = !refreshed && !state.owner;
    refreshed = true;
    const cards = [["hero-card", heroUrl()], ["look-card", lookUrl()]].filter(([id, url]) => !(settled && $(id).getAttribute("src") === url.replace(/&k=[^&]*$/, "")));
    await Promise.all([...cards.map(([, url]) => preload(url)), leaving]);
    if (quiet) {
      // Not while someone is playing with the card: it would snap back together under their finger.
      await liquid?.rested();
      paint(theme.palette);
      describe(theme);
      for (const [id, url] of cards) if ($(id).getAttribute("src") !== url) $(id).src = url;
      await syncLiquid(false);
      return;
    }
    paint(theme.palette);
    describe(theme);
    await Promise.all(cards.map(([id, url]) => swapCard($(id), url)));
    await syncLiquid();
    liquid?.restore(); // does nothing once a new card has been built; if there was none, the old card comes back
  } catch (e) {
    liquid?.restore();
    throw e;
  }
}

/* Live updates: a HEAD request returns the card's key; when it changes, the song (or its cover) changed. */
let timer = 0;
async function poll() {
  clearTimeout(timer);
  if (document.hidden || !state.owner) return;
  let every = 4000;
  try {
    const res = await fetch(heroUrl(), { method: "HEAD", cache: "no-store" });
    every = Math.max(4000, Number(res.headers.get("X-Ode-Poll")) || 4000);
    const key = res.headers.get("X-Ode-Key");
    if (key && key !== state.key) await refresh();
  } catch { every = 15000; }
  timer = setTimeout(poll, every);
}
document.addEventListener("visibilitychange", () => (document.hidden ? clearTimeout(timer) : poll()));

async function start() {
  const boot = document.documentElement.dataset;
  if (new URLSearchParams(location.search).has("demo")) state.owner = null;
  else if (boot.owner) { state.owner = boot.owner; state.key = boot.key; }
  else try {
    const t = await fetchTheme(true);
    // The owner's card when it is live; otherwise (no keys yet, or offline) the demo.
    state.owner = t.kind === "playing" || t.kind === "idle" ? t.user : null;
  } catch { state.owner = null; }
  try { await refresh(); } catch { /* the demo cards are already showing */ }
  poll();
  // The liquid card is a flourish: it builds when the browser is idle, never in the way of the first paint. Where it
  // cannot run, the plain card gets its record at once; where it can, the record is never shown.
  if (!canLiquid()) document.documentElement.classList.add("vinyl-on");
  else {
    // It is built quietly once the page has settled, so that the first touch finds it ready: building takes about a second on a
    // phone, and a tap that has to wait for that feels broken. Nothing changes on screen until someone comes near the card
    // (then it takes over, see stillHero). Where memory is short it is built on the first hover or touch instead.
    const hero = document.querySelector(".hero"), card = $("hero-card");
    const nearCard = (e) => {
      const r = card.getBoundingClientRect();
      return e.clientX > r.left - 90 && e.clientX < r.right + 90 && e.clientY > r.top - 90 && e.clientY < r.bottom + 90;
    };
    hero.addEventListener("pointerenter", (e) => e.pointerType === "mouse" && startLiquid(), { passive: true });
    hero.addEventListener("pointerdown", (e) => {
      if (e.pointerType === "mouse") return startLiquid();
      // A touch away from the card is only someone scrolling.
      if (!nearCard(e)) return;
      // If the card is not ready for this touch, it is played back to it once it is (see loadLiquid).
      if (!liquidReady) pokeAt = { x: e.clientX, y: e.clientY, t: performance.now() };
      takeOver();
    }, { passive: true });
    hero.addEventListener("focusin", startLiquid, { once: true, passive: true });
    if ((navigator.deviceMemory || 4) > 2) {
      const arm = () => (document.hidden ? document.addEventListener("visibilitychange", arm, { once: true }) : startLiquid());
      const later = () => setTimeout(() => ("requestIdleCallback" in window ? requestIdleCallback(arm, { timeout: 4000 }) : arm()), 2500);
      if (document.readyState === "complete") later();
      else addEventListener("load", later, { once: true });
    }
    if ("requestIdleCallback" in window) requestIdleCallback(() => import("./liquid.js").catch(() => {}), { timeout: 6000 });
  }
}

/* ---------- The liquid card ---------- */

// The hero card, liquid (liquid.js): loads after the page is up, only with WebGL2 and float render targets, and not
// when motion is unwelcome or data is being saved. Everywhere else the card simply stays the card.
let liquid = null, liquidSrc = "", liquidReady = false, liquidStarted = false, wantTakeOver = false, pokeAt = null;
const canLiquid = () => !reduced && !navigator.connection?.saveData && !!document.createElement("canvas").getContext("webgl2");
function startLiquid() {
  if (liquidStarted) return;
  liquidStarted = true;
  loadLiquid();
}

/** Someone has touched the card (or come near it): it stops where it is and becomes the liquid one. */
function takeOver() {
  stillHero();
  wantTakeOver = true;
  liquid?.engage();
  startLiquid();
}

async function loadLiquid() {
  try {
    const { liquidCard } = await import("./liquid.js");
    // Built quietly, one step per frame (shader compile, then the particles), so the page stays responsive; with someone's
    // finger already on the card there is no time for that, and it is built at once.
    const frame = () => (wantTakeOver ? Promise.resolve() : new Promise((done) => requestAnimationFrame(() => done())));
    await frame();
    liquid = liquidCard({ hero: document.querySelector(".hero"), card: $("hero-card"), reduced, onEngage: stillHero });
    if (wantTakeOver) liquid.engage();
    await frame();
    await syncLiquid(false);
    liquidReady = true;
    // The touch that started all this was over before the card was ready. Playing it back means the first tap disperses
    // the card too, rather than only the second.
    if (pokeAt && performance.now() - pokeAt.t < 5000) liquid.poke(pokeAt.x, pokeAt.y);
    pokeAt = null;
  } catch (e) {
    console.warn("Ode: liquid card unavailable", e);
    document.documentElement.classList.remove("liquid-still");
    document.documentElement.classList.add("vinyl-on");
  }
}

/** Stops the hero card where it is, as the liquid card starts to build. The card floats, tilts and shrinks as the page scrolls,
    and the liquid card needs it still (the particles must know exactly where it is); stopping all that in one frame made the
    card jump. The float simply stops where it is, and stays there (`--rest`); the scroll shrink, which cannot be left as it
    is, eases away. Both are done before the card is built. */
const cardTop = (tilt) => tilt.querySelector("img").getBoundingClientRect().top;
function stillHero() {
  const root = document.documentElement;
  const art = document.querySelector(".hero-art"), tilt = art?.querySelector(".tilt");
  if (!art || !tilt || root.classList.contains("liquid-still")) return;
  const a = getComputedStyle(art), t = getComputedStyle(tilt);
  // It stops where it is, moved by a fraction of a pixel at most to sit on the device pixel grid: the browser draws a card at a
  // fractional position by rounding it its own way, and the liquid card has to land on exactly the same pixels.
  const dpr = devicePixelRatio || 1, top = cardTop(tilt);
  const [tx = "0px", ty = "0px"] = (t.translate === "none" ? "0px 0px" : t.translate).split(" ");
  tilt.style.setProperty("--rest", `${tx} ${(parseFloat(ty) || 0) + Math.round(top * dpr) / dpr - top}px`);
  const shrunk = a.transform !== "none" || a.translate !== "none" || a.opacity !== "1";
  const from = { translate: a.translate, transform: a.transform, opacity: a.opacity };
  root.classList.add("liquid-still");
  if (shrunk) art.animate([from, { translate: "none", transform: "none", opacity: 1 }], { duration: 320, easing: "cubic-bezier(0.2, 0, 0, 1)" }).id = "ode-still";
}

/** Gives the liquid card the card that is showing; a different one (a new song, a new style) assembles from particles. */
async function syncLiquid(intro = true) {
  const src = $("hero-card").getAttribute("src");
  if (!liquid || !src || src === liquidSrc) return;
  liquidSrc = src;
  await liquid.setCard(src, intro);
}

/* ---------- Page details ---------- */

/* The Material shapes behind the hero card: each holds a shape, then springs into the next. The song's mood
   sets how long each is held and how fast they turn. */
const SHAPES = {
  cookie: (t) => 1 + 0.07 * Math.cos(9 * t),
  clover: (t) => 1 + 0.16 * Math.cos(4 * t),
  flower: (t) => 1 + 0.09 * Math.cos(8 * t),
  burst: (t) => 1 + 0.12 * Math.cos(12 * t),
  soft: (t) => 1 + 0.05 * Math.cos(6 * t),
};
const MOOD = { calm: { hold: 9000, spin: 0.6 }, steady: { hold: 6000, spin: 1 }, lively: { hold: 4200, spin: 1.4 }, intense: { hold: 2800, spin: 1.9 } };
const N = 96;
const radii = (name) => Array.from({ length: N }, (_, i) => SHAPES[name]((i / N) * Math.PI * 2));

/** A closed path through the radii, smoothed with quadratic curves between midpoints. */
function pathFor(r, turn = 0) {
  const pts = r.map((k, i) => { const a = (i / N) * Math.PI * 2 + turn; return [Math.cos(a) * 50 * k, Math.sin(a) * 50 * k]; });
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const f = (x) => x.toFixed(2);
  const first = mid(pts[N - 1], pts[0]);
  let d = `M${f(first[0])} ${f(first[1])}`;
  for (let i = 0; i < N; i++) { const p = pts[i], m = mid(p, pts[(i + 1) % N]); d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`; }
  return d + "Z";
}

/** A spring that overshoots a little, then settles: the M3 Expressive spatial spring. */
const spring = (t) => 1 - Math.exp(-6 * t) * Math.cos(7.5 * t);

function morpher(el, order, offset, spin) {
  let index = offset % order.length;
  let from = radii(order[index]);
  el.setAttribute("d", pathFor(from));
  if (reduced) return;
  // The slow turn is a CSS rotation about the shape's centre (the origin of its viewBox), which costs the page nothing;
  // the outline itself is only rebuilt while one shape is springing into the next.
  el.style.transformOrigin = "0 0";
  let to = from, changed = performance.now(), turn = 0, last = changed, settled = true;
  const TWEEN = 1400;
  let drawn = 0;
  const frame = (now) => {
    if (!state.heroOn || now - drawn < 30) { if (!state.heroOn) last = now; requestAnimationFrame(frame); return; }
    drawn = now;
    const mood = MOOD[state.mood] ?? MOOD.steady;
    turn += (now - last) * spin * mood.spin;
    last = now;
    if (now - changed > mood.hold + TWEEN) {
      from = to;
      index = (index + 1) % order.length;
      to = radii(order[index]);
      changed = now;
    }
    const k = Math.min(1, (now - changed) / TWEEN);
    if (k < 1 || !settled) {
      el.setAttribute("d", pathFor(from.map((r, i) => r + (to[i] - r) * spring(k))));
      settled = k >= 1;
    }
    el.style.transform = `rotate(${turn.toFixed(4)}rad)`;
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The tempo rows in the features grid: the M3 Expressive wavy indicator's wave, with round caps, across the whole
    row. Each mood has its own wavelength, height and crawl speed. The geometry is laid out at the row's real width,
    so nothing stretches; the waves only move while the grid is on screen, and hold still under reduced motion. */
function tempoWaves() {
  const NS = "http://www.w3.org/2000/svg";
  const MOODS = { calm: { amp: 1.8, len: 54, speed: 0.3 }, steady: { amp: 2.6, len: 42, speed: 0.55 }, lively: { amp: 3.2, len: 34, speed: 0.9 }, intense: { amp: 3.8, len: 27, speed: 1.35 } };
  const H = 16, MID = 8, STROKE = 4;
  const rows = [...$("tempos").querySelectorAll(".tempo")].map((row) => {
    const svg = row.querySelector("svg");
    const make = (tag, cls) => { const el = document.createElementNS(NS, tag); el.setAttribute("class", cls); svg.append(el); return el; };
    return { svg, mood: MOODS[row.dataset.mood], wave: make("path", "wave-active"), end: 0, phase: 0 };
  });

  const layout = () => {
    for (const r of rows) {
      const w = r.svg.clientWidth;
      if (!w) continue;
      r.svg.setAttribute("viewBox", `0 0 ${w} ${H}`);
      r.end = w - STROKE / 2;
    }
  };
  // Hovering the tile picks the music up: the waves ease to a faster crawl, and back.
  let boost = 1, target = 1, last = 0;
  const cell = $("tempos").closest(".cell");
  cell.addEventListener("pointerenter", () => (target = 2.4));
  cell.addEventListener("pointerleave", () => (target = 1));
  const draw = (t) => {
    const dt = last ? Math.min(64, t - last) / 1000 : 0;
    last = t;
    boost += (target - boost) * Math.min(1, dt * 5);
    for (const r of rows) {
      if (!r.end) continue;
      const { amp, len, speed } = r.mood;
      r.phase += dt * speed * boost * Math.PI * 2;
      const phase = r.phase;
      const start = STROKE / 2;
      let d = "";
      for (let x = start; x <= r.end; x += 2) d += `${d ? "L" : "M"}${x} ${(MID + amp * Math.sin((x / len) * Math.PI * 2 - phase)).toFixed(2)}`;
      r.wave.setAttribute("d", d);
    }
  };

  layout();
  draw(0);
  new ResizeObserver(() => { layout(); draw(performance.now()); }).observe($("tempos"));
  if (reduced || !("IntersectionObserver" in window)) return;
  let running = false;
  const frame = (t) => { if (!running) { last = 0; return; } draw(t); requestAnimationFrame(frame); };
  new IntersectionObserver(([e]) => {
    const was = running;
    running = e.isIntersecting;
    if (running && !was) requestAnimationFrame(frame);
  }).observe($("tempos"));
}

/** Splits the story sentence into words, numbered so each lights up a moment after the one before. */
function splitWords(el) {
  const words = el.textContent.trim().split(/\s+/);
  el.textContent = "";
  words.forEach((w, i) => {
    const span = document.createElement("span");
    span.className = "w";
    span.style.setProperty("--i", String(i));
    span.textContent = w;
    el.append(span, i < words.length - 1 ? " " : "");
  });
}

/** Marks a button pressed in its group and slides the group's indicator to it. */
function press(group, btn) {
  group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
  placeIndicator(group, false);
}

/** Moves a group's indicator under its pressed button (measured, so it also works when the group wraps). */
function placeIndicator(group, instant) {
  const ind = group.querySelector(".indicator");
  const on = group.querySelector('button[aria-pressed="true"]');
  if (!ind || !on) return;
  ind.classList.toggle("instant", instant);
  ind.style.width = `${on.offsetWidth}px`;
  ind.style.height = `${on.offsetHeight}px`;
  ind.style.setProperty("--ix", `${on.offsetLeft}px`);
  ind.style.setProperty("--iy", `${on.offsetTop}px`);
  if (instant) requestAnimationFrame(() => ind.classList.remove("instant"));
}

/* ---------- The bar ---------- */

function bar() {
  // The disc: a click sends it round twice and takes you to the top.
  let turns = 0;
  $("brand").addEventListener("click", (e) => {
    e.preventDefault();
    $("brand").querySelector("svg").style.setProperty("--turns", String((turns += 2)));
    scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" });
  });
  $("now-chip").addEventListener("click", (e) => { e.preventDefault(); scrollTo({ top: 0, behavior: reduced ? "auto" : "smooth" }); });

  // The nav highlight sits on the section you are reading, and follows the pointer while it is over the nav.
  const nav = $("nav"), ind = nav.querySelector(".nav-ind"), links = [...nav.querySelectorAll("a")];
  const sheetLinks = [...$("sheet").querySelectorAll("a")];
  let current = null;
  const place = (a, instant = false) => {
    ind.classList.toggle("instant", instant || ind.style.opacity !== "1");
    if (!a) { ind.style.opacity = "0"; return; }
    ind.style.width = `${a.offsetWidth}px`;
    ind.style.setProperty("--nx", `${a.offsetLeft}px`);
    ind.style.opacity = "1";
    requestAnimationFrame(() => ind.classList.remove("instant"));
  };
  const mark = () => {
    links.forEach((l) => l.classList.toggle("on", l === current));
    sheetLinks.forEach((l) => l.classList.toggle("on", !!current && l.hash === current.hash));
    place(current);
  };
  const point = (a) => { links.forEach((l) => l.classList.toggle("on", l === a)); place(a); };
  // The highlight marks places on this page. The GitHub link leaves the site, so it is not one: the highlight does not
  // move onto it (it goes back to the section being read, or away at the top), and GitHub answers with its own colour.
  links.forEach((a) => {
    const here = !!a.hash;
    a.addEventListener("pointerenter", () => (here ? point(a) : mark()));
    a.addEventListener("focus", () => (here ? point(a) : mark()));
  });
  nav.addEventListener("pointerleave", mark);
  nav.addEventListener("focusout", (e) => { if (!nav.contains(e.relatedTarget) && !nav.matches(":hover")) mark(); });
  // A clicked link holds the highlight while the page scrolls to it, instead of it sliding through every section on
  // the way; the reading highlight takes over again once the scroll ends.
  let heldUntil = 0;
  links.forEach((a) => a.addEventListener("click", () => {
    if (!a.hash) return;
    current = a;
    heldUntil = performance.now() + 1500;
  }));
  addEventListener("scrollend", () => (heldUntil = 0));
  if ("IntersectionObserver" in window) {
    const seen = new IntersectionObserver((entries) => {
      if (performance.now() < heldUntil) return;
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const link = links.find((l) => l.hash === `#${e.target.id}`);
        if (link) current = link;
      }
      if (!nav.matches(":hover")) mark();
    }, { rootMargin: "-45% 0px -50% 0px" });
    document.querySelectorAll("main section[id]").forEach((s) => seen.observe(s));
    const top = new IntersectionObserver(([e]) => {
      state.heroOn = e.isIntersecting;
      if (e.isIntersecting) { current = null; if (!nav.matches(":hover")) mark(); }
      $("now-chip").classList.toggle("show", !e.isIntersecting && !!$("now-chip-text").textContent);
    });
    top.observe(document.querySelector(".hero"));
  }
  addEventListener("resize", () => place(current, true));
  document.fonts?.ready.then(() => place(current, true));

  const header = $("bar"), menu = $("menu-btn");
  // Past the very top the bar settles into its smaller pill.
  const settleBar = () => header.classList.toggle("scrolled", scrollY > 24);
  addEventListener("scroll", settleBar, { passive: true });
  settleBar();
  let openedAt = 0;
  const isOpen = () => header.classList.contains("open");
  const open = (on) => {
    if (on === isOpen()) return;
    header.classList.toggle("open", on);
    menu.setAttribute("aria-expanded", String(on));
    menu.setAttribute("aria-label", on ? "Close menu" : "Menu");
    openedAt = scrollY;
  };
  menu.addEventListener("click", (e) => {
    open(!isOpen());
    if (isOpen() && e.detail === 0) sheetLinks[0].focus();
  });
  header.addEventListener("click", (e) => { if (e.target.closest("a")) open(false); });
  addEventListener("scroll", () => { if (isOpen() && Math.abs(scrollY - openedAt) > 80) open(false); }, { passive: true });
  addEventListener("keydown", (e) => { if (e.key === "Escape" && isOpen()) { open(false); menu.focus(); } });
  document.addEventListener("pointerdown", (e) => { if (!header.contains(e.target)) open(false); });
  matchMedia("(max-width: 880px)").addEventListener("change", (e) => e.matches || open(false));

  // GitHub stars, when GitHub answers; the button works the same without them.
  fetch("https://api.github.com/repos/Cl0ud-9/Ode", { headers: { Accept: "application/vnd.github+json" } })
    .then((r) => (r.ok ? r.json() : null))
    .then((r) => { if (r?.stargazers_count > 0) $("gh-stars").textContent = r.stargazers_count.toLocaleString(); })
    .catch(() => {});
}

/* Liquid glass. Chromium (desktop and Android) can run an SVG filter on what lies behind an element, so there the rim
   of the bar and of the phone menu bends the page like the edge of a lens. With a mouse the light also splits a
   little at the rim (red, green and blue bend by different amounts); on phones one pass keeps it light enough to run
   while scrolling. Each lens map is drawn at its element's exact size and shape, and redrawn whenever that changes.
   Safari and Firefox cannot filter a backdrop this way, and accessibility settings ask for a solid bar: those keep
   the CSS glass. */
function liquidGlass() {
  const chromium = navigator.userAgentData?.brands?.some((b) => b.brand === "Chromium");
  const solid = matchMedia("(prefers-reduced-transparency: reduce), (prefers-contrast: more), (forced-colors: active)").matches;
  if (!chromium || solid || !CSS.supports("backdrop-filter", "url(#liquid)")) return;
  // The lens is a desktop flourish. An SVG filter over the page is costly for a phone's GPU, and the map behind it is
  // computed pixel by pixel at startup, so touch screens keep the CSS glass (which looks nearly the same).
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
  if (!fine) return;
  const NS = "http://www.w3.org/2000/svg";
  const svg = document.createElementNS(NS, "svg");
  svg.setAttribute("aria-hidden", "true");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  document.body.append(svg);

  const KEEP = ["1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 1 0", "0 0 0 0 0 0 1 0 0 0 0 0 0 0 0 0 0 0 1 0", "0 0 0 0 0 0 0 0 0 0 0 0 1 0 0 0 0 0 1 0"];
  const passes = fine
    ? [-36, -39, -42].map((k, i) => `<feDisplacementMap in="SourceGraphic" in2="map" scale="${k}" xChannelSelector="R" yChannelSelector="G" result="d${i}"/><feColorMatrix in="d${i}" type="matrix" values="${KEEP[i]}" result="c${i}"/>`).join("") +
      `<feBlend in="c0" in2="c1" mode="screen" result="rg"/><feBlend in="rg" in2="c2" mode="screen"/>`
    : `<feDisplacementMap in="SourceGraphic" in2="map" scale="-38" xChannelSelector="R" yChannelSelector="G"/>`;
  const clamp = (v, lo, hi) => Math.min(Math.max(v, lo), hi);

  const lens = (el, id) => {
    if (!el) return;
    svg.insertAdjacentHTML("beforeend", `<filter id="${id}" filterUnits="userSpaceOnUse" primitiveUnits="userSpaceOnUse" color-interpolation-filters="sRGB" x="0" y="0"><feImage result="map" x="0" y="0" preserveAspectRatio="none"/>${passes}</filter>`);
    const filter = svg.lastElementChild, image = filter.querySelector("feImage");
    const canvas = document.createElement("canvas");
    let size = "";

    // Each pixel's colour says where to look instead: neutral grey inside, pushed along the rim's normal near the
    // edge (always inward, where the backdrop exists), most strongly right at it, so the middle and its text stay calm.
    const draw = () => {
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (!w || !h || size === `${w}x${h}`) return;
      size = `${w}x${h}`;
      canvas.width = w;
      canvas.height = h;
      const ctx = canvas.getContext("2d");
      const img = ctx.createImageData(w, h);
      const r = Math.min(parseFloat(getComputedStyle(el).borderTopLeftRadius) || 0, w / 2, h / 2), bezel = Math.min(18, h / 2);
      for (let y = 0; y < h; y++) {
        for (let x = 0; x < w; x++) {
          const px = x + 0.5, py = y + 0.5;
          // Distance in from the rounded edge, and the outward direction there.
          const vx = px - clamp(px, r, w - r), vy = py - clamp(py, r, h - r);
          const dist = Math.hypot(vx, vy);
          let inset, nx, ny;
          if (dist > 0) { inset = r - dist; nx = vx / dist; ny = vy / dist; }
          else {
            const left = px, right = w - px, top = py, bottom = h - py;
            inset = Math.min(left, right, top, bottom);
            [nx, ny] = inset === left ? [-1, 0] : inset === right ? [1, 0] : inset === top ? [0, -1] : [0, 1];
          }
          let dx = 0, dy = 0;
          if (inset < bezel) {
            const t = 1 - Math.max(0, inset) / bezel, m = t * t;
            dx = nx * m;
            dy = ny * m;
          }
          const o = (y * w + x) * 4;
          img.data[o] = 128 + dx * 127;
          img.data[o + 1] = 128 + dy * 127;
          img.data[o + 2] = 128;
          img.data[o + 3] = 255;
        }
      }
      ctx.putImageData(img, 0, 0);
      for (const node of [filter, image]) { node.setAttribute("width", String(w)); node.setAttribute("height", String(h)); }
      image.setAttribute("href", canvas.toDataURL());
    };
    let settle = 0;
    new ResizeObserver(() => {
      const w = Math.round(el.offsetWidth), h = Math.round(el.offsetHeight);
      if (w && h) for (const node of [filter, image]) { node.setAttribute("width", String(w)); node.setAttribute("height", String(h)); }
      clearTimeout(settle);
      settle = setTimeout(draw, 160);
    }).observe(el);
    draw();
  };

  lens(document.querySelector(".bar-inner"), "liquid");
  lens($("sheet"), "liquid-sheet");
  document.documentElement.classList.add("glass-lens");
}

/* Pointer details for a real mouse only (never touch, never under reduced motion): the cards tilt toward the pointer
   with a soft glare, and panels light up under it. Nothing else follows the cursor. */
function pointerDetails() {
  if (reduced || !matchMedia("(hover: hover) and (pointer: fine)").matches) return;
  for (const el of document.querySelectorAll(".tilt")) {
    // The liquid hero card does not tilt, and has no glare (the card is in pieces): nothing to follow the mouse.
    const liquidHero = el.closest(".hero-art") && document.documentElement.classList;
    el.addEventListener("pointermove", (e) => {
      if (liquidHero?.contains("liquid-still")) return;
      const r = el.getBoundingClientRect();
      const x = (e.clientX - r.left) / r.width, y = (e.clientY - r.top) / r.height;
      el.classList.add("tilting");
      el.style.setProperty("--ry", `${((x - 0.5) * 10).toFixed(2)}deg`);
      el.style.setProperty("--rx", `${((0.5 - y) * 8).toFixed(2)}deg`);
      el.style.setProperty("--gx", `${(x * 100).toFixed(1)}%`);
      el.style.setProperty("--gy", `${(y * 100).toFixed(1)}%`);
    });
    el.addEventListener("pointerleave", () => {
      el.classList.remove("tilting");
      el.style.setProperty("--rx", "0deg");
      el.style.setProperty("--ry", "0deg");
    });
  }
  for (const el of document.querySelectorAll(".cell, .surface")) {
    el.addEventListener("pointermove", (e) => {
      const r = el.getBoundingClientRect();
      el.style.setProperty("--mx", `${e.clientX - r.left}px`);
      el.style.setProperty("--my", `${e.clientY - r.top}px`);
    });
  }
}

/** Splits a heading into words that rise into view from behind a mask, one after another, when it is first seen.
    Screen readers keep the plain heading through its label. */
function splitHeading(h) {
  const label = h.textContent.trim().replace(/\s+/g, " ");
  const words = label.split(" ");
  h.setAttribute("aria-label", label);
  h.textContent = "";
  words.forEach((w, i) => {
    const outer = document.createElement("span");
    outer.className = "hw";
    outer.setAttribute("aria-hidden", "true");
    const inner = document.createElement("span");
    inner.style.setProperty("--i", String(i));
    inner.textContent = w;
    outer.append(inner);
    h.append(outer, i < words.length - 1 ? " " : "");
  });
}

/** The "5s" counts up the first time it is seen. */
function countUp() {
  const el = $("five");
  if (reduced || !("IntersectionObserver" in window)) return;
  el.textContent = "0";
  const io = new IntersectionObserver(([e]) => {
    if (!e.isIntersecting) return;
    io.disconnect();
    const t0 = performance.now();
    const step = (t) => {
      const k = Math.min(1, (t - t0) / 1100), ease = 1 - Math.pow(1 - k, 3);
      el.textContent = String(Math.round(5 * ease));
      if (k < 1) requestAnimationFrame(step);
    };
    setTimeout(() => requestAnimationFrame(step), 350);
  }, { threshold: 0.6 });
  io.observe(el);
}

/** The marquee follows your scrolling: faster as you scroll down, backwards as you scroll up, then back to its pace. */
function marqueeVelocity() {
  const anim = document.querySelector(".marquee-track")?.getAnimations?.()[0];
  if (!anim || reduced) return;
  let lastY = scrollY, lastT = performance.now(), rate = 1, target = 1, running = false;
  const tick = () => {
    rate += (target - rate) * 0.1;
    target += (1 - target) * 0.05;
    anim.playbackRate = rate;
    if (Math.abs(rate - 1) > 0.01 || Math.abs(target - 1) > 0.01) requestAnimationFrame(tick);
    else { anim.playbackRate = 1; running = false; }
  };
  addEventListener("scroll", () => {
    const now = performance.now(), v = (scrollY - lastY) / Math.max(16, now - lastT);
    lastY = scrollY;
    lastT = now;
    target = Math.max(-5, Math.min(7, 1 + v * 5));
    if (!running) { running = true; requestAnimationFrame(tick); }
  }, { passive: true });
}

/** The footer wordmark in halftone dots (halftone.js). It waits for the face, so the dots are set in the real letters;
    without a canvas, or if anything fails, the plain wordmark stays. */
function halftoneMark() {
  const stage = $("foot-mark"), canvas = stage?.querySelector("canvas");
  if (!canvas?.getContext) return;
  const start = async () => {
    try {
      await document.fonts?.load('800 expanded 100px "Google Sans Flex"').catch(() => {});
      const { halftone } = await import("./halftone.js");
      // The plain wordmark stays until the dots are on the canvas, so there is never a moment with neither.
      await halftone({ stage, canvas, word: "Ode", reduced }).ready;
      stage.classList.add("on");
    } catch (e) {
      console.warn("Ode: halftone wordmark unavailable", e);
    }
  };
  // Building the word takes some work (it is done in slices, between frames). It starts as soon as the visitor starts
  // to scroll, so it is finished long before the footer is reached and nothing is built at the moment of arrival; a
  // page that is only looked at builds nothing. Reaching the footer first (a link, a jump) starts it too.
  let started = false, io = null;
  const go = () => {
    if (started) return;
    started = true;
    io?.disconnect();
    removeEventListener("scroll", go);
    if ("requestIdleCallback" in window) requestIdleCallback(start, { timeout: 1200 });
    else start();
  };
  addEventListener("scroll", go, { passive: true });
  if ("IntersectionObserver" in window) {
    io = new IntersectionObserver(([e]) => e.isIntersecting && go(), { rootMargin: "2200px 0px" });
    io.observe(stage);
  }
  // The script itself is fetched ahead, at idle, so starting it is quick.
  if ("requestIdleCallback" in window) requestIdleCallback(() => import("./halftone.js").catch(() => {}), { timeout: 8000 });
}

/* In-page links scroll without writing "#section" into the address, so a link copied from anywhere on the page is
   the plain page. An address that arrives with a section still lands on it, and drops it once you are back at the top.
   New-tab clicks (modifier keys, middle button) keep the browser's own behaviour. */
function cleanLinks() {
  document.addEventListener("click", (e) => {
    const a = e.target.closest('a[href^="#"]');
    if (!a || e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    const target = a.hash.length > 1 ? document.querySelector(a.hash) : null;
    if (!target) return;
    e.preventDefault();
    target.scrollIntoView({ behavior: reduced ? "auto" : "smooth", block: "start" });
    if (!target.hasAttribute("tabindex")) target.setAttribute("tabindex", "-1");
    target.focus({ preventScroll: true });
  });
  addEventListener("scroll", () => { if (scrollY < 40) clearHash(); }, { passive: true });
}
const clearHash = () => location.hash && history.replaceState(history.state, "", location.href.split("#")[0]);

/** On a touch screen, holding a finger on a card (which is how you play with the liquid one) must not open the browser's
    image menu (Open image, Download, Share). Right-clicking with a mouse still works, so the card's address can be copied. */
function holdSteady() {
  const touch = matchMedia("(hover: none), (pointer: coarse)");
  document.addEventListener("contextmenu", (e) => {
    if ((e.pointerType === "touch" || e.pointerType === "pen" || touch.matches) && e.target.closest?.(".hero-art, .preview, .foot-mark")) e.preventDefault();
  });
  // iOS starts a selection on a long press or a double tap even where `user-select` is off. The footer word is a picture,
  // not text to select.
  document.addEventListener("selectstart", (e) => {
    const at = e.target instanceof Element ? e.target : e.target?.parentElement;
    if (at?.closest(".foot-mark")) e.preventDefault();
  });
}

function wire() {
  morpher($("morph-front"), ["cookie", "clover", "flower", "burst", "soft"], 0, 0.00012);
  morpher($("morph-back"), ["flower", "soft", "cookie", "clover", "burst"], 2, -0.00008);
  tempoWaves();
  splitWords($("story"));

  // Theme: only the preview card changes, so only it is fetched: the switch shows within a few hundred ms.
  $("theme-group").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.getAttribute("aria-pressed") === "true") return;
    press($("theme-group"), btn);
    state.theme = btn.dataset.theme;
    swapCard($("look-card"), lookUrl());
  });
  // Colour style: the palette changes, so the colours and both cards are fetched together.
  $("style-group").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn || btn.getAttribute("aria-pressed") === "true") return;
    $("style-group").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    state.style = btn.dataset.style;
    refresh().catch(() => {});
  });

  const groups = [...document.querySelectorAll(".group")];
  const settle = () => groups.forEach((g) => placeIndicator(g, true));
  settle();
  document.fonts?.ready.then(settle);
  addEventListener("resize", settle);

  // Headings rise word by word; the tiles follow one another in.
  if (!reduced && "IntersectionObserver" in window) document.querySelectorAll(".head h2, #faq h2").forEach(splitHeading);
  document.querySelectorAll(".bento .cell").forEach((c, i) => c.style.setProperty("--d", `${i * 80}ms`));
  // The record slides out once the page has settled, rather than appearing already out.
  setTimeout(() => document.documentElement.classList.add("ready"), 350);

  // Headings, panels and the marquee rise into place the first time they are seen.
  const rise = document.querySelectorAll(".head, .surface, .cell, .marquee, #faq h2, details, .foot-mark");
  if (!reduced && "IntersectionObserver" in window) {
    rise.forEach((el) => el.classList.add("rise"));
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.15 });
    rise.forEach((el) => io.observe(el));
  }

  cleanLinks();
  countUp();
  marqueeVelocity();
  halftoneMark();
  bar();
  liquidGlass();
  pointerDetails();
  holdSteady();
  dropdowns();
  generator();
}

/** Material dropdowns, in place of the browser's: each `.tf.pick` gets a field-like button and a menu. The <select> is
    kept (hidden), and gets the value and the input and change events, so the rest of the page works as before. Arrow
    keys, Home and End, Enter or Space, typing to jump, Escape and Tab all behave as a native select does. */
function dropdowns() {
  const CHECK = '<svg class="menu-check" viewBox="0 0 24 24" aria-hidden="true"><path d="M9 16.2 4.8 12l-1.4 1.4L9 19 21 7l-1.4-1.4z"/></svg>';
  const CARET = '<svg class="tf-caret" viewBox="0 0 24 24" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>';
  let openFn = null;
  document.querySelectorAll(".tf.pick").forEach((tf) => {
    const select = tf.querySelector("select"), label = tf.querySelector(".tf-label"), id = select.id;
    const options = [...select.options];
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "tf-select";
    btn.setAttribute("role", "combobox");
    btn.setAttribute("aria-haspopup", "listbox");
    btn.setAttribute("aria-expanded", "false");
    btn.setAttribute("aria-controls", `${id}-menu`);
    btn.setAttribute("aria-labelledby", `${id}-label ${id}-value`);
    const value = document.createElement("span");
    value.className = "tf-value";
    value.id = `${id}-value`;
    btn.append(value);
    btn.insertAdjacentHTML("beforeend", CARET);
    const menu = document.createElement("ul");
    menu.className = "menu";
    menu.id = `${id}-menu`;
    menu.setAttribute("role", "listbox");
    menu.setAttribute("aria-labelledby", `${id}-label`);
    const items = options.map((o, i) => {
      const li = document.createElement("li");
      li.className = "menu-item";
      li.id = `${id}-opt${i}`;
      li.setAttribute("role", "option");
      li.style.setProperty("--i", String(i));
      li.innerHTML = `<span>${o.textContent}</span>${CHECK}`;
      menu.append(li);
      return li;
    });
    select.tabIndex = -1;
    select.setAttribute("aria-hidden", "true");
    tf.classList.add("enhanced");
    label.after(btn, menu);

    let active = select.selectedIndex, typed = "", typedAt = 0;
    const show = () => {
      value.textContent = options[select.selectedIndex]?.textContent ?? "";
      items.forEach((li, i) => li.setAttribute("aria-selected", String(i === select.selectedIndex)));
    };
    const mark = (i) => {
      active = Math.max(0, Math.min(items.length - 1, i));
      items.forEach((li, n) => li.classList.toggle("active", n === active));
      btn.setAttribute("aria-activedescendant", items[active].id);
      items[active].scrollIntoView({ block: "nearest" });
    };
    const isOpen = () => tf.classList.contains("open");
    const close = (refocus = true) => {
      if (!isOpen()) return;
      tf.classList.remove("open");
      btn.setAttribute("aria-expanded", "false");
      btn.removeAttribute("aria-activedescendant");
      items.forEach((li) => li.classList.remove("active"));
      if (openFn === close) openFn = null;
      if (refocus) btn.focus({ preventScroll: true });
    };
    const open = () => {
      if (isOpen()) return;
      openFn?.(false);
      // Open upward when there is no room below.
      const r = btn.getBoundingClientRect(), need = Math.min(menu.scrollHeight, 320) + 16;
      tf.classList.toggle("up", innerHeight - r.bottom < need && r.top > innerHeight - r.bottom);
      tf.classList.add("open");
      btn.setAttribute("aria-expanded", "true");
      openFn = close;
      mark(select.selectedIndex);
    };
    const choose = (i) => {
      const changed = i !== select.selectedIndex;
      select.selectedIndex = i;
      show();
      close();
      if (changed) for (const type of ["input", "change"]) select.dispatchEvent(new Event(type, { bubbles: true }));
    };

    btn.addEventListener("click", () => (isOpen() ? close() : open()));
    // Pressing an option must not steal focus from the button, or the menu would close before the click lands.
    menu.addEventListener("pointerdown", (e) => e.preventDefault());
    menu.addEventListener("click", (e) => { const li = e.target.closest(".menu-item"); if (li) choose(items.indexOf(li)); });
    menu.addEventListener("pointermove", (e) => { const li = e.target.closest(".menu-item"); if (li && e.pointerType === "mouse") mark(items.indexOf(li)); });
    btn.addEventListener("blur", () => close(false));
    btn.addEventListener("keydown", (e) => {
      const k = e.key;
      if (k === "ArrowDown" || k === "ArrowUp") {
        e.preventDefault();
        if (!isOpen()) open();
        else mark(active + (k === "ArrowDown" ? 1 : -1));
      } else if (k === "Home" || k === "End") {
        if (isOpen()) { e.preventDefault(); mark(k === "Home" ? 0 : items.length - 1); }
      } else if (k === "Enter" || k === " ") {
        e.preventDefault();
        if (isOpen()) choose(active); else open();
      } else if (k === "Escape") {
        if (isOpen()) { e.preventDefault(); e.stopPropagation(); close(); }
      } else if (k === "Tab") {
        close(false);
      } else if (k.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
        // Typing jumps to the next option that starts with what was typed.
        const now = performance.now();
        typed = now - typedAt > 600 ? k.toLowerCase() : typed + k.toLowerCase();
        typedAt = now;
        const from = typed.length === 1 ? active + 1 : active;
        const hit = [...options.keys()].map((n) => (n + from) % options.length).find((n) => options[n].textContent.toLowerCase().startsWith(typed));
        if (hit !== undefined) { if (!isOpen()) open(); mark(hit); }
      }
    });
    select.addEventListener("input", show);
    show();
  });
  // A press anywhere else closes the open menu.
  document.addEventListener("pointerdown", (e) => { if (openFn && !e.target.closest(".tf.open")) openFn(false); });
}

function generator() {
  let format = "html";
  const pre = $("snippet");
  let morphing = 0, current = "";
  /** Puts a new snippet in the box: the text fades out, the box eases to the new text's height (so what is below it
      glides, never jumps) and the new text fades in. Only the text fades, never the box. A newer call takes over. */
  const morph = async (next) => {
    if (reduced || !pre.isConnected || pre.textContent === next) { pre.textContent = next; return; }
    const id = ++morphing, from = pre.getBoundingClientRect().height, ink = "var(--md-on-surface)";
    pre.getAnimations().forEach((a) => a.cancel());
    pre.style.overflow = "hidden";
    pre.style.height = `${from}px`;
    const out = pre.animate([{ color: ink }, { color: "transparent" }], { duration: 110, easing: "cubic-bezier(0.3, 0, 0.8, 0.15)", fill: "forwards" });
    await out.finished.catch(() => {});
    if (id !== morphing) { out.cancel(); return; }
    pre.textContent = next;
    pre.style.height = "auto";
    const to = pre.getBoundingClientRect().height;
    pre.style.height = `${from}px`;
    pre.animate([{ color: "transparent" }, { color: ink }], { duration: 300, delay: 60, easing: "cubic-bezier(0.05, 0.7, 0.1, 1)", fill: "backwards" });
    out.cancel();
    const grow = pre.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: 380, easing: "cubic-bezier(0.05, 0.7, 0.1, 1)" });
    pre.style.height = `${to}px`;
    await grow.finished.catch(() => {});
    if (id === morphing) { pre.style.height = ""; pre.style.overflow = ""; }
  };
  const update = (animate = false) => {
    let base = $("f-worker").value.trim().replace(/\/+$/, "") || "https://ode.your-account.workers.dev";
    if (!/^https?:\/\//i.test(base)) base = `https://${base}`;
    const user = $("f-user").value.trim() || "your-name";
    const p = new URLSearchParams({ user });
    if ($("f-theme").value !== "expressive") p.set("theme", $("f-theme").value);
    if ($("f-style").value !== "content") p.set("scheme", $("f-style").value);
    if ($("f-mode").value !== "auto") p.set("mode", $("f-mode").value);
    const src = `${base}/api/now?${p}`;
    const profile = `https://www.last.fm/user/${encodeURIComponent(user)}`;
    const height = $("f-theme").value === "minimal" ? 87 : 150;
    const text = format === "html"
      ? `<a href="${profile}"><img src="${src}" alt="${user} on Last.fm" width="480" height="${height}"></a>`
      : `[![${user} on Last.fm](${src})](${profile})`;
    current = text;
    if (animate) morph(text);
    else {
      // Typing: at once, and it ends any morph in flight (a morph that was mid-way must not leave the text faded out).
      morphing++;
      pre.getAnimations().forEach((a) => a.cancel());
      pre.style.height = "";
      pre.style.overflow = "";
      pre.textContent = text;
    }
  };
  // Typing updates the snippet at once (animating every keystroke would flicker); a choice (a menu, the format
  // switch) morphs it.
  ["f-worker", "f-user"].forEach((id) => $(id).addEventListener("input", () => update()));
  ["f-theme", "f-style", "f-mode"].forEach((id) => $(id).addEventListener("change", () => update(true)));
  $("format-group").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    press($("format-group"), btn);
    format = btn.dataset.format;
    update(true);
  });

  // Copy: the icon turns into a check and the label cross-fades to "Copied", then both return.
  let reset = 0;
  const label = (text) => {
    const el = $("copy-label");
    el.classList.add("swap");
    setTimeout(() => { el.textContent = text; el.classList.remove("swap"); }, 150);
  };
  $("copy").addEventListener("click", async () => {
    clearTimeout(reset);
    try {
      await navigator.clipboard.writeText(current);
      $("copy").classList.add("done");
      label("Copied");
      reset = setTimeout(() => { $("copy").classList.remove("done"); label("Copy snippet"); }, 2000);
    } catch {
      $("copied").textContent = "Select the text and copy it";
      reset = setTimeout(() => ($("copied").textContent = ""), 2400);
    }
  });
  update();
}

wire();
start();
