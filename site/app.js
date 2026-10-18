// Ode's website. The page wears the colours of the song on the live card: it reads the card's palette from
// /api/theme and rewrites the Material role tokens; CSS fades every surface to the new colours.

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const dark = matchMedia("(prefers-color-scheme: dark)");

const state = { owner: null, theme: "expressive", style: "content", key: null };

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
  const roles = ["primary", "primaryContainer", "secondaryContainer", "tertiary", "tertiaryContainer"];
  [...$("swatches").children].forEach((el, i) => (el.style.backgroundColor = scheme[roles[i]]));
}
dark.addEventListener("change", () => lastPalette && paint(lastPalette));

/* ---------- The live card ---------- */

const cardParams = (theme) => {
  const p = new URLSearchParams(state.owner ? { user: state.owner } : { demo: "playing" });
  p.set("corners", "clear");
  if (theme && theme !== "expressive") p.set("theme", theme);
  if (state.style !== "content") p.set("scheme", state.style);
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

const MOOD_PACE = { calm: "70s", steady: "48s", lively: "34s", intense: "24s" };

function describe(t) {
  const playing = t.kind === "playing";
  $("live").classList.toggle("playing", playing && !!state.owner);
  const song = t.title ? `${t.title} · ${t.artist}` : "";
  if (!state.owner) { $("live-label").textContent = "Demo"; $("live-song").textContent = "deploy yours for the real thing"; }
  else if (playing) { $("live-label").textContent = "Live"; $("live-song").textContent = song; }
  else if (t.kind === "idle") { $("live-label").textContent = "Last played"; $("live-song").textContent = song; }
  else { $("live-label").textContent = "Quiet"; $("live-song").textContent = ""; }
  $("hero-card").alt = t.title ? `${playing ? "Now playing" : "Last played"}: ${t.title} by ${t.artist}` : "A now-playing card";
  document.documentElement.style.setProperty("--marquee", MOOD_PACE[playing ? t.mood ?? "steady" : "steady"] ?? "48s");
}

/** New palette and both cards at once: used when the song or the colour style changes. */
async function refresh() {
  const [theme] = await Promise.all([fetchTheme(), preload(heroUrl()), preload(lookUrl())]);
  state.key = theme.key;
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
  try {
    const t = await fetchTheme(true);
    // The owner's card when it is live; otherwise (no keys yet, or offline) the demo.
    state.owner = t.kind === "playing" || t.kind === "idle" ? t.user : null;
  } catch { state.owner = null; }
  try { await refresh(); } catch { /* the demo cards are already showing */ }
  poll();
}

/* ---------- Page details ---------- */

/** The Material "cookie" behind the hero card: a circle with nine soft scallops. */
function cookiePath(lobes = 9, depth = 0.07, n = 144) {
  const pts = Array.from({ length: n }, (_, i) => {
    const a = (i / n) * Math.PI * 2;
    const r = 50 * (1 + depth * Math.cos(lobes * a));
    return [Math.cos(a) * r, Math.sin(a) * r];
  });
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const f = (x) => x.toFixed(2);
  const start = mid(pts[n - 1], pts[0]);
  let d = `M${f(start[0])} ${f(start[1])}`;
  for (let i = 0; i < n; i++) { const p = pts[i], m = mid(p, pts[(i + 1) % n]); d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`; }
  return d + "Z";
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

function wire() {
  $("cookie").setAttribute("d", cookiePath());
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
  const rise = document.querySelectorAll(".head, .surface, .marquee, #faq h2, details, .wordmark");
  if (!reduced && "IntersectionObserver" in window) {
    rise.forEach((el) => el.classList.add("rise"));
    const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.15 });
    rise.forEach((el) => io.observe(el));
  }

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
