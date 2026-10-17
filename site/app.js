// Ode's website. The page wears the colours of the song on the live card: it reads the card's palette from
// /api/theme, rewrites the Material role tokens, and re-colours with a View Transition when the song changes.

const $ = (id) => document.getElementById(id);
const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
const dark = matchMedia("(prefers-color-scheme: dark)");

const state = { owner: null, theme: "expressive", style: "content", key: null, mood: "steady", kind: "playing" };

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
  document.querySelector('meta[name="theme-color"]').setAttribute("content", scheme.primary);
  const roles = ["primary", "primaryContainer", "secondaryContainer", "tertiaryContainer", "container"];
  [...$("swatches").children].forEach((el, i) => (el.style.background = scheme[roles[i]]));
}
dark.addEventListener("change", () => lastPalette && paint(lastPalette));

/**
 * Runs a change inside a View Transition when the browser has them, so colours and cards cross-fade. A browser may
 * abort a transition (a hidden tab, a busy frame); the change is applied regardless and nothing is left unhandled.
 */
async function transition(change) {
  if (!document.startViewTransition || reduced) return change();
  let done = false;
  const apply = () => { done = true; change(); };
  // Never wait on it for long: if the browser has not run the change within 1.5 s (no frames painted, or the
  // transition aborted), apply it directly. Applying it twice is harmless.
  const finished = document.startViewTransition(apply).finished.catch(() => undefined);
  await Promise.race([finished, new Promise((r) => setTimeout(r, 1500))]);
  if (!done) change();
}

/* ---------- The live card ---------- */

const params = (extra = {}) => {
  const p = new URLSearchParams(state.owner ? { user: state.owner } : { demo: "playing" });
  p.set("corners", "clear");
  if (state.style !== "content") p.set("scheme", state.style);
  for (const [k, v] of Object.entries(extra)) if (v && v !== "expressive") p.set(k, v);
  return p;
};
const heroUrl = () => `/api/now?${params()}`;
const lookUrl = () => `/api/now?${params({ theme: state.theme })}`;

/** Loads an image off-screen first, so swapping it in never shows a blank frame. */
const preload = (src) => new Promise((done) => { const img = new Image(); img.onload = img.onerror = () => done(src); img.src = src; });

/** The card's palette and song: the owner's when they are live, otherwise the demo's (`probe` asks for the owner). */
async function fetchTheme(probe = false) {
  const p = new URLSearchParams(probe ? {} : state.owner ? { user: state.owner } : { demo: "playing" });
  if (state.style !== "content") p.set("scheme", state.style);
  const res = await fetch(`/api/theme?${p}`, { cache: "no-store" });
  if (!res.ok) throw new Error(String(res.status));
  return res.json();
}

const MOOD = { calm: { beat: "1.8s", hold: 9000, drift: "34s" }, steady: { beat: "1.1s", hold: 6000, drift: "22s" }, lively: { beat: "0.8s", hold: 4200, drift: "16s" }, intense: { beat: "0.55s", hold: 2800, drift: "11s" } };

function describe(t) {
  const chip = $("live-chip");
  const playing = t.kind === "playing";
  chip.classList.toggle("idle", !playing);
  const song = t.title ? `${t.title} · ${t.artist}` : "";
  $("live-text").textContent = !state.owner ? "A demo card. Deploy yours for the real thing." : playing ? `Now playing on @${t.user}: ${song}` : t.kind === "idle" ? `Last played on @${t.user}: ${song}` : `@${t.user} is quiet right now`;
  $("now-line").textContent = t.title ? `This page is wearing the colours of “${t.title}”.` : "This page takes its colours from the song on the card.";
  $("hero-card").alt = t.title ? `${playing ? "Now playing" : "Last played"}: ${t.title} by ${t.artist}` : "A now-playing card";
  state.mood = playing ? t.mood ?? "steady" : "steady";
  const m = MOOD[state.mood] ?? MOOD.steady;
  document.documentElement.style.setProperty("--beat", m.beat);
  document.documentElement.style.setProperty("--drift", m.drift);
}

/** Fetches the palette and cards for the current choices, then swaps everything in at once. */
async function refresh() {
  const theme = await fetchTheme();
  const [hero, look] = await Promise.all([preload(heroUrl()), preload(lookUrl())]);
  state.key = theme.key;
  state.kind = theme.kind;
  await transition(() => {
    paint(theme.palette);
    $("hero-card").src = hero;
    $("look-card").src = look;
    describe(theme);
  });
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
    // Use the owner's card when it is live; otherwise (no keys yet, or offline) the demo looks better.
    state.owner = t.kind === "playing" || t.kind === "idle" ? t.user : null;
  } catch { state.owner = null; }
  try { await refresh(); } catch { /* the demo images are already showing */ }
  poll();
}

/* ---------- Material shapes that morph ---------- */

const SHAPES = {
  cookie: (t) => 1 + 0.07 * Math.cos(9 * t),
  clover: (t) => 1 + 0.16 * Math.cos(4 * t),
  flower: (t) => 1 + 0.09 * Math.cos(8 * t),
  burst: (t) => 1 + 0.12 * Math.cos(12 * t),
  soft: (t) => 1 + 0.05 * Math.cos(6 * t),
  circle: () => 1,
};
const N = 144;
const radii = (name) => Array.from({ length: N }, (_, i) => SHAPES[name]((i / N) * Math.PI * 2));

/** A smooth closed path through the points (midpoint quadratic smoothing), radius 50 around the origin. */
function pathFor(r, turn = 0) {
  const pts = r.map((k, i) => { const a = (i / N) * Math.PI * 2 + turn; return [Math.cos(a) * 50 * k, Math.sin(a) * 50 * k]; });
  const mid = (p, q) => [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2];
  const f = (n) => n.toFixed(2);
  let start = mid(pts[N - 1], pts[0]);
  let d = `M${f(start[0])} ${f(start[1])}`;
  for (let i = 0; i < N; i++) { const p = pts[i], m = mid(p, pts[(i + 1) % N]); d += `Q${f(p[0])} ${f(p[1])} ${f(m[0])} ${f(m[1])}`; }
  return d + "Z";
}

/** A Material Expressive spring: overshoots a little, then settles. */
const spring = (t) => 1 - Math.exp(-6 * t) * Math.cos(7.5 * t);

function morpher(el, order, offset, spin) {
  let from = radii(order[offset % order.length]);
  let to = from;
  let started = performance.now();
  let index = offset;
  let turn = 0;
  let last = performance.now();
  const frame = (now) => {
    const dt = now - last; last = now;
    turn += spin * dt * (state.mood === "intense" ? 2.2 : state.mood === "lively" ? 1.5 : state.mood === "calm" ? 0.6 : 1);
    const hold = (MOOD[state.mood] ?? MOOD.steady).hold;
    if (now - started > hold) { from = to; index++; to = radii(order[index % order.length]); started = now; }
    const p = Math.min(1, (now - started) / 1400);
    const k = spring(p);
    el.setAttribute("d", pathFor(from.map((r, i) => r + (to[i] - r) * k), turn));
    requestAnimationFrame(frame);
  };
  if (reduced) { el.setAttribute("d", pathFor(from)); return; }
  to = radii(order[(offset + 1) % order.length]);
  requestAnimationFrame(frame);
}

/* ---------- The rest of the page ---------- */

function wire() {
  morpher($("morph-front"), ["cookie", "clover", "flower", "burst", "soft"], 0, 0.00012);
  morpher($("morph-back"), ["flower", "soft", "cookie", "clover", "burst"], 2, -0.00008);
  document.querySelectorAll(".tile .shape").forEach((svg) => svg.querySelector("path").setAttribute("d", pathFor(radii(svg.dataset.shape))));

  // The wavy line under "How it works".
  let d = "M4 14";
  for (let x = 4; x <= 996; x += 4) d += `L${x} ${(14 + 8 * Math.sin((x / 1000) * Math.PI * 2 * 9)).toFixed(1)}`;
  $("timeline-path").setAttribute("d", d);

  const choose = (group, attr, key) => group.addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    group.querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    state[key] = btn.dataset[attr];
    refresh().catch(() => undefined);
  });
  choose($("theme-group"), "theme", "theme");
  choose($("style-group"), "style", "style");

  // Reveal sections as they scroll into view.
  const io = new IntersectionObserver((entries) => entries.forEach((e) => e.isIntersecting && (e.target.classList.add("in"), io.unobserve(e.target))), { threshold: 0.12 });
  document.querySelectorAll(".reveal").forEach((el) => io.observe(el));

  generator();
}

function generator() {
  const fields = ["f-worker", "f-user", "f-theme", "f-style", "f-mode"].map($);
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
  fields.forEach((f) => f.addEventListener("input", update));
  $("format-group").addEventListener("click", (e) => {
    const btn = e.target.closest("button");
    if (!btn) return;
    $("format-group").querySelectorAll("button").forEach((b) => b.setAttribute("aria-pressed", String(b === btn)));
    format = btn.dataset.format;
    update();
  });
  $("copy").addEventListener("click", async () => {
    try { await navigator.clipboard.writeText($("snippet").textContent); $("copied").textContent = "Copied"; }
    catch { $("copied").textContent = "Select the text and copy it"; }
    $("copied").classList.add("show");
    setTimeout(() => $("copied").classList.remove("show"), 1800);
  });
  update();
}

wire();
start();
