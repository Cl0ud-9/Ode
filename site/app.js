// Ode's website. The page wears the colours of the song on the live card: it reads the card's palette from
// /api/theme and rewrites the Material role tokens; CSS fades every surface to the new colours.

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const dark = matchMedia("(prefers-color-scheme: dark)");

// A reload starts at the top (unless the address names a section): restoring the old position while fonts and cards
// are still settling would land somewhere further down the page.
if ("scrollRestoration" in history) history.scrollRestoration = "manual";
if (!location.hash) scrollTo(0, 0);

const state = { owner: null, theme: "expressive", style: "content", key: null, mood: "steady", heroOn: true };

/* ---------- Colour: palette roles -> CSS tokens ---------- */

const ROLE_VARS = {
  surface: "surface", container: "container", containerHigh: "container-high", onSurface: "on-surface", onVariant: "on-variant",
  outline: "outline", primary: "primary", onPrimary: "on-primary", primaryContainer: "primary-container",
  onPrimaryContainer: "on-primary-container", secondaryContainer: "secondary-container",
  onSecondaryContainer: "on-secondary-container", tertiary: "tertiary", tertiaryContainer: "tertiary-container", bgA: "bg-a", bgB: "bg-b",
};
const tokens = (scheme) => Object.entries(ROLE_VARS).map(([role, name]) => (scheme[role] ? `--md-${name}:${scheme[role]};` : "")).join("");

let lastPalette = null;
function paint(palette) {
  lastPalette = palette;
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

/** Swaps a card image: it dims at once (so the click is acknowledged), then shows the new card when it has loaded. */
async function swapCard(img, src) {
  if (img.getAttribute("src") === src) return;
  img.classList.add("loading");
  await preload(src);
  img.src = src;
  img.classList.remove("loading");
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
  root.classList.toggle("playing-now", playing && !!state.owner);
  $("now-chip-text").textContent = state.owner && song ? song : "";
}

/** New palette and both cards at once: used when the song or the colour style changes. */
async function refresh() {
  const theme = await fetchTheme();
  state.key = theme.key;
  await Promise.all([preload(heroUrl()), preload(lookUrl())]);
  paint(theme.palette);
  describe(theme);
  await Promise.all([swapCard($("hero-card"), heroUrl()), swapCard($("look-card"), lookUrl())]);
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
  if (boot.owner) { state.owner = boot.owner; state.key = boot.key; }
  else try {
    const t = await fetchTheme(true);
    // The owner's card when it is live; otherwise (no keys yet, or offline) the demo.
    state.owner = t.kind === "playing" || t.kind === "idle" ? t.user : null;
  } catch { state.owner = null; }
  try { await refresh(); } catch { /* the demo cards are already showing */ }
  poll();
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
const N = 144;
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
  if (reduced) { el.setAttribute("d", pathFor(from)); return; }
  let to = from, changed = performance.now(), turn = 0, last = changed;
  const TWEEN = 1400;
  const frame = (now) => {
    if (!state.heroOn) { last = now; requestAnimationFrame(frame); return; }
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
    const e = spring(k);
    el.setAttribute("d", pathFor(from.map((r, i) => r + (to[i] - r) * e), turn));
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
}

/** The tempo waves in the features grid: one sine per mood, drifting at that mood's speed. */
function tempoWaves() {
  const TEMPO = { calm: [1, "8s"], steady: [1.5, "5s"], lively: [2.2, "3.6s"], intense: [3, "2.4s"] };
  $("tempos").querySelectorAll(".tempo").forEach((row) => {
    const [amp, speed] = TEMPO[row.dataset.mood];
    let d = "M0 12";
    for (let x = 0; x <= 520; x += 4) d += `L${x} ${(12 + Math.sin((x / 40) * Math.PI * 2) * amp * 2.6).toFixed(2)}`;
    row.querySelector("path").setAttribute("d", d);
    row.style.setProperty("--t", speed);
  });
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
  links.forEach((a) => { a.addEventListener("pointerenter", () => point(a)); a.addEventListener("focus", () => point(a)); });
  nav.addEventListener("pointerleave", mark);
  nav.addEventListener("focusout", (e) => nav.contains(e.relatedTarget) || mark());
  if ("IntersectionObserver" in window) {
    const seen = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) current = links.find((l) => l.hash === `#${e.target.id}`) ?? null;
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
  const fine = matchMedia("(hover: hover) and (pointer: fine)").matches;
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
    let pending = 0;
    new ResizeObserver(() => { cancelAnimationFrame(pending); pending = requestAnimationFrame(draw); }).observe(el);
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
    el.addEventListener("pointermove", (e) => {
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
    $("look-card").classList.add("loading");
    refresh().catch(() => $("look-card").classList.remove("loading"));
  });

  const groups = [...document.querySelectorAll(".group")];
  const settle = () => groups.forEach((g) => placeIndicator(g, true));
  settle();
  document.fonts?.ready.then(settle);
  addEventListener("resize", settle);

  // Headings, panels and the marquee rise into place the first time they are seen.
  const rise = document.querySelectorAll(".head, .surface, .cell, .marquee, #faq h2, details, .wordmark");
  if (!reduced && "IntersectionObserver" in window) {
    rise.forEach((el) => el.classList.add("rise"));
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.15 });
    rise.forEach((el) => io.observe(el));
  }

  cleanLinks();
  bar();
  liquidGlass();
  pointerDetails();
  generator();
}

function generator() {
  let format = "html";
  const update = () => {
    const base = ($("f-worker").value.trim() || "https://ode.your-account.workers.dev").replace(/\/+$/, "");
    const user = $("f-user").value.trim() || "your-name";
    const p = new URLSearchParams({ user });
    if ($("f-theme").value !== "expressive") p.set("theme", $("f-theme").value);
    if ($("f-style").value !== "content") p.set("scheme", $("f-style").value);
    if ($("f-mode").value !== "auto") p.set("mode", $("f-mode").value);
    const src = `${base}/api/now?${p}`;
    const profile = `https://www.last.fm/user/${encodeURIComponent(user)}`;
    const height = $("f-theme").value === "minimal" ? 87 : 150;
    $("snippet").textContent = format === "html"
      ? `<a href="${profile}"><img src="${src}" alt="${user} on Last.fm" width="480" height="${height}"></a>`
      : `[![${user} on Last.fm](${src})](${profile})`;
  };
  ["f-worker", "f-user", "f-theme", "f-style", "f-mode"].forEach((id) => $(id).addEventListener("input", update));
  $("format-group").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    press($("format-group"), btn);
    format = btn.dataset.format;
    update();
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
      await navigator.clipboard.writeText($("snippet").textContent);
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
