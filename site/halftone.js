// The footer wordmark, printed in halftone dots. The word is set enormous and cropped by the bottom edge; each dot is
// sized by how much of the letter covers its cell, so the type keeps its edges at any size. The pointer parts the
// dots on springs, and they warm as they are pushed off their place; a click sends a shock ring through the word. The
// ink and warm colours are the stage's --ink and --warm, which are the page's own tokens, so the dots follow the song.
//
// A plain-JavaScript port of "Halftone Wordmark Footer" (21st.dev). Changes for Ode: no React; the effect is the word
// alone, on a transparent canvas, with the grain on the ink only; the word fits the stage's height as well as its
// width and sits at its left edge; colours follow the page's palette; the pointer glides, drags the dots it passes
// and swells them as it nears; and it is built to stay at full frame rate:
//
//   - The word is built in small slices, between frames, into a spare canvas that is swapped in whole, so building it
//     (on first scroll, long before the footer is reached) never makes a frame late, and a resize never blanks it.
//
//   - The word at rest is painted once into a still layer (grain included). A frame copies only the rectangle around
//     the dots that are moving from that layer, then draws those few dots on top; the rest of the word is never
//     touched, so the cost follows the pointer, not the size of the word.
//   - Dots that are at rest and out of reach are skipped, and the physics allocates nothing.
//   - Displaced dots are drawn in a handful of colour bands, one fill per band, not one fill per dot.
//   - The loop sleeps once the dots are still, even under a resting pointer.

/** Dot radius for a cell coverage in [0, 1]: area-true, so tone stays even. */
export function dotRadius(coverage, gap) {
  const c = coverage < 0 ? 0 : coverage > 1 ? 1 : coverage;
  return Math.sqrt(c) * gap * 0.56;
}

/** One step of a dot's spring home, plus the push from a pointer at (px, py) within radius r. The pointer's own motion
    (pvx, pvy, px per frame) drags the dots it passes, so a fast sweep throws them. Writes [x, y, vx, vy] into `out`. */
function stepInto(out, x, y, vx, vy, hx, hy, px, py, r, pvx, pvy) {
  const dx = x - px, dy = y - py, d2 = dx * dx + dy * dy;
  if (r > 0 && d2 < r * r) {
    const d = Math.sqrt(d2) + 0.001, t = 1 - d / r, f = t * 3.6;
    vx += (dx / d) * f + pvx * t * 0.22;
    vy += (dy / d) * f + pvy * t * 0.22;
  }
  vx = (vx + (hx - x) * 0.055) * 0.88;
  vy = (vy + (hy - y) * 0.055) * 0.88;
  out[0] = x + vx;
  out[1] = y + vy;
  out[2] = vx;
  out[3] = vy;
}

/** The same step, returning a new array: [x, y, vx, vy]. */
export function step(x, y, vx, vy, hx, hy, px, py, r, pvx = 0, pvy = 0) {
  const out = [0, 0, 0, 0];
  stepInto(out, x, y, vx, vy, hx, hy, px, py, r, pvx, pvy);
  return out;
}

/** How warm a dot is drawn: 0 at home, 1 once it is `span` px or more away. */
export const warmth = (x, y, hx, hy, span) => (span > 0 ? Math.min(1, Math.hypot(x - hx, y - hy) / span) : 0);

/** The font size that sets the word inside a w × h stage: as wide as the stage, unless the part above the crop would
    then stand taller than `fill` of its height. `measured` and `capAt100` are the word's width and cap height at 100px. */
export function fitSize(measured, capAt100, w, h, crop, fill = 0.9) {
  if (!(measured > 0) || !(capAt100 > 0)) return 0;
  return Math.min((w / measured) * 100, ((h * fill) / (capAt100 * (1 - crop))) * 100);
}

const WARM_SPAN = 40, RING_MS = 800;
/** How far a click's ring travels (CSS px). Past it nothing is pushed, so a click moves a few thousand dots, not all of them. */
const RING_REACH = 520;
/** Displaced dots are drawn in this many colour bands between ink and warm. */
const BANDS = 14;
/** How far from a live dot anything is drawn for it: its swelled self, or a diagonal neighbour redrawn after its erase
    (about 10 px), plus soft edges. A dirty rectangle is padded by this. */
const PAD = 11;

/** Starts the halftone wordmark in `stage` (a positioned element holding `canvas`). Returns `{ ready, stop }`: `ready`
    resolves once the word is on the canvas. */
export function halftone({ stage, canvas, word, font = '"Google Sans Flex"', crop = 0, reduced = false }) {
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ready: Promise.resolve(), stop: () => {} };
  // The word at rest, painted once. A frame copies a rectangle of it and draws the moving dots on top.
  let still = document.createElement("canvas");
  let sctx = still.getContext("2d");
  let w = 0, h = 0, dpr = 1, raf = 0, visible = true, awake = true, alive = true;
  // The pointer's target, where it is drawn (eased, so it glides) and how fast it is going, in px per frame.
  let tx = -1e5, ty = -1e5, px = -1e5, py = -1e5, pvx = 0, pvy = 0, ring = { x: 0, y: 0, t: -1 }, reach = 90;
  // Per dot: x, y, vx, vy, home x, home y, radius. `resting` dots are at home and out of the pointer's reach; the
  // others are listed in `live`. `band` is the colour band a live dot was drawn in this frame, `bloom` its swell.
  let dots = new Float32Array(0), count = 0, grainTile = null;
  let resting = new Uint8Array(0), live = new Int32Array(0), liveCount = 0, band = new Uint8Array(0), bloom = new Float32Array(0);
  // The dots by grid cell (-1 where there is none), to find a dot's neighbours; `seen` marks the ones already redrawn.
  let grid = new Int32Array(0), seen = new Int32Array(0), cols = 0, rowsN = 0, cell = 5, stamp = 0;
  let dirty = null; // the device-pixel rectangle drawn last frame, to be repainted from the still layer
  let ink = [0, 0, 0], warm = [0, 0, 0], from = null, fadeAt = 0, shades = [];
  const out = [0, 0, 0, 0];

  // Any CSS colour (tokens are hex, rgb or color-mix) as [r, g, b], read back through a 1×1 canvas.
  const probe = document.createElement("canvas").getContext("2d", { willReadFrequently: true });
  const rgb = (css) => {
    probe.clearRect(0, 0, 1, 1);
    probe.fillStyle = "#000";
    probe.fillStyle = css;
    probe.fillRect(0, 0, 1, 1);
    return [...probe.getImageData(0, 0, 1, 1).data.slice(0, 3)];
  };
  const tokens = () => {
    const st = getComputedStyle(stage);
    return [rgb(st.getPropertyValue("--ink").trim() || st.color), rgb(st.getPropertyValue("--warm").trim() || st.color)];
  };
  const mix = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
  const css = (c) => `rgb(${Math.round(c[0])},${Math.round(c[1])},${Math.round(c[2])})`;
  const makeShades = (a, b) => {
    shades = Array.from({ length: BANDS }, (_, i) => css(mix(a, b, i / (BANDS - 1))));
  };
  // A new palette eases in over the same 600 ms as the rest of the page's colour.
  const recolor = () => {
    const [i, k] = tokens();
    if (i.join() === ink.join() && k.join() === warm.join()) return;
    from = reduced || !count ? null : { ink, warm };
    fadeAt = performance.now();
    ink = i;
    warm = k;
    if (!from) { makeShades(ink, warm); paintStill(); blitAll(); }
    wake();
  };
  [ink, warm] = tokens();
  makeShades(ink, warm);

  /** Lets the browser draw a frame (or handle input) before the next slice of work. */
  const slice = () => new Promise((done) => setTimeout(done, 0));

  /**
   * Paints the whole word at rest, with its grain, into `c` (a context at scale `D`). Given a build id it works in
   * slices and gives up as soon as a newer build starts; without one it runs straight through (a colour fade repaints
   * each frame, and must not wait).
   */
  const paintInto = async (c, list, n, W, H, D, id) => {
    c.setTransform(D, 0, 0, D, 0, 0);
    c.clearRect(0, 0, W, H);
    c.fillStyle = shades[0];
    const STEP = 1800; // dots per fill: a few milliseconds
    for (let from0 = 0; from0 < n; from0 += STEP) {
      c.beginPath();
      for (let i = from0, end = Math.min(n, from0 + STEP); i < end; i++) {
        const j = i * 7, r = list[j + 6];
        c.moveTo(list[j + 4] + r, list[j + 5]);
        c.arc(list[j + 4], list[j + 5], r, 0, Math.PI * 2);
      }
      c.fill();
      if (id !== undefined && from0 + STEP < n) {
        await slice();
        if (id !== building) return false;
      }
    }
    // A fixed tile of print grain, laid over the ink only, once.
    if (grainTile) {
      c.globalAlpha = 0.07;
      c.globalCompositeOperation = "source-atop";
      c.fillStyle = c.createPattern(grainTile, "repeat");
      c.fillRect(0, 0, W, H);
      c.globalAlpha = 1;
      c.globalCompositeOperation = "source-over";
    }
    return true;
  };
  const paintStill = () => paintInto(sctx, dots, count, w, h, dpr);
  const blitAll = () => {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(still, 0, 0);
    dirty = null;
  };

  /**
   * Sets the word, makes its dots and paints it, in slices; then swaps everything in at once. A newer layout (a resize)
   * cancels one in progress. Resolves when the word is on the canvas.
   */
  let building = 0;
  const layout = async () => {
    const id = ++building;
    const rect = stage.getBoundingClientRect();
    const W = Math.max(1, Math.round(rect.width)), H = Math.max(1, Math.round(rect.height));
    const D = Math.min(devicePixelRatio || 1, 2);

    // The word, set once on a 1× mask, as wide as the stage and cropped by its bottom edge.
    const mask = document.createElement("canvas");
    mask.width = W;
    mask.height = H;
    const m = mask.getContext("2d", { willReadFrequently: true });
    const set = (size) => {
      m.font = `800 ${size}px ${font}, system-ui, sans-serif`;
      if ("fontStretch" in m) m.fontStretch = "expanded";
      if ("letterSpacing" in m) m.letterSpacing = `${(-0.04 * size).toFixed(2)}px`;
      return m.measureText(word);
    };
    // Fitted and placed by the letters' ink, not their advance, so the word sits flush with the stage's left edge.
    const inkWidth = (b) => (b.actualBoundingBoxLeft ?? 0) + (b.actualBoundingBoxRight ?? b.width) || b.width;
    const at100 = set(100);
    const size = fitSize(inkWidth(at100), at100.actualBoundingBoxAscent || 72, W * 0.97, H, crop, 1);
    const box = set(size);
    const cap = box.actualBoundingBoxAscent || size * 0.72;
    m.fillStyle = "#000";
    m.textBaseline = "alphabetic";
    m.fillText(word, box.actualBoundingBoxLeft ?? 0, H - 2 + cap * crop);
    const img = m.getImageData(0, 0, W, H).data;
    await slice();
    if (id !== building) return;

    // Each cell's coverage is the mean alpha of a 3×3 sample; nearly empty cells get no dot. A finer screen on
    // phones, where the word is small. Sampled a few rows at a time.
    const gap = W < 640 ? 3 : 5;
    const nCols = Math.ceil(W / gap), rows = Math.ceil(H / gap), list = [], cellOf = new Int32Array(nCols * rows).fill(-1);
    for (let gy = 0; gy < rows; gy++) {
      for (let gx = 0; gx < nCols; gx++) {
        let sum = 0;
        for (let sy = 0; sy < 3; sy++) {
          for (let sx = 0; sx < 3; sx++) {
            const x = Math.min(W - 1, Math.floor(gx * gap + ((sx + 0.5) * gap) / 3));
            const y = Math.min(H - 1, Math.floor(gy * gap + ((sy + 0.5) * gap) / 3));
            sum += img[(y * W + x) * 4 + 3];
          }
        }
        const cov = sum / (9 * 255);
        if (cov < 0.06) continue;
        const hx = gx * gap + gap / 2, hy = gy * gap + gap / 2;
        cellOf[gy * nCols + gx] = list.length / 7;
        list.push(hx, hy, 0, 0, hx, hy, dotRadius(cov, gap));
      }
      if (gy % 24 === 23) {
        await slice();
        if (id !== building) return;
      }
    }
    const list32 = new Float32Array(list), n = list.length / 7;

    if (!grainTile) {
      grainTile = document.createElement("canvas");
      grainTile.width = grainTile.height = 256;
      const g = grainTile.getContext("2d"), tile = g.createImageData(256, 256);
      for (let i = 0; i < tile.data.length; i += 4) {
        tile.data[i] = tile.data[i + 1] = tile.data[i + 2] = Math.random() < 0.5 ? 0 : 255;
        tile.data[i + 3] = Math.random() < 0.5 ? 0 : 255;
      }
      g.putImageData(tile, 0, 0);
    }
    // Paint into a spare canvas, in slices, then swap it in whole.
    const next = document.createElement("canvas");
    next.width = Math.round(W * D);
    next.height = Math.round(H * D);
    const nctx = next.getContext("2d");
    const colour = shades[0];
    await slice();
    if (id !== building) return;
    if (!(await paintInto(nctx, list32, n, W, H, D, id))) return;

    w = W; h = H; dpr = D;
    still = next; sctx = nctx;
    dots = list32; count = n;
    resting = new Uint8Array(n).fill(1);
    live = new Int32Array(n);
    band = new Uint8Array(n);
    bloom = new Float32Array(n);
    grid = cellOf; seen = new Int32Array(n); cols = nCols; rowsN = rows; cell = gap;
    liveCount = 0;
    // The push scales with the word, so a big word is not a tiny nudge.
    reach = Math.min(110, Math.max(60, H * 0.27));
    canvas.width = next.width;
    canvas.height = next.height;
    // If the palette moved while this was being built, paint once more in the colour it is now.
    if (shades[0] !== colour) paintStill();
    blitAll();
  };

  const draw = (now) => {
    // A palette change repaints the still layer for each frame of its fade (rare, and over in 600 ms).
    let repaint = false;
    if (from) {
      let f = Math.min(1, (now - fadeAt) / 600);
      f = 1 - (1 - f) ** 3;
      makeShades(mix(from.ink, ink, f), mix(from.warm, warm, f));
      paintStill();
      repaint = true;
      if (f >= 1) from = null;
    }

    const r = reduced ? 0 : reach;
    const ringAge = ring.t < 0 ? 1e9 : now - ring.t, ringR = ringAge * 0.9;
    const ringOn = ringAge < RING_MS && ringR < RING_REACH;
    const pointerIn = tx > -1e4;
    let moving = false;
    if (pointerIn) {
      if (px < -1e4) { px = tx; py = ty; pvx = pvy = 0; }
      else {
        const nx = px + (tx - px) * 0.4, ny = py + (ty - py) * 0.4;
        pvx = Math.max(-40, Math.min(40, nx - px));
        pvy = Math.max(-40, Math.min(40, ny - py));
        px = nx;
        py = ny;
        if (Math.abs(tx - px) + Math.abs(ty - py) > 0.3) moving = true;
      }
    } else { px = py = -1e5; pvx = pvy = 0; }

    if (!reduced) {
      // Wake the resting dots the pointer or the ring has reached.
      if (pointerIn || ringOn) {
        const r2 = r * r;
        for (let i = 0; i < count; i++) {
          if (!resting[i]) continue;
          const j = i * 7, hx = dots[j + 4], hy = dots[j + 5];
          let hit = false;
          if (pointerIn) {
            const dx = hx - px, dy = hy - py;
            hit = dx * dx + dy * dy < r2;
          }
          if (!hit && ringOn) {
            const dx = hx - ring.x, dy = hy - ring.y;
            hit = ringR < RING_REACH && Math.abs(Math.sqrt(dx * dx + dy * dy) - ringR) < 22;
          }
          if (hit) { resting[i] = 0; live[liveCount++] = i; }
        }
      }

      // Move the live dots; the ones that have come home go back to rest.
      let kept = 0;
      for (let n = 0; n < liveCount; n++) {
        const i = live[n], j = i * 7, hx = dots[j + 4], hy = dots[j + 5];
        let vx = dots[j + 2], vy = dots[j + 3];
        if (ringOn) {
          const dx = hx - ring.x, dy = hy - ring.y, d = Math.sqrt(dx * dx + dy * dy) + 0.001;
          const bandK = 1 - Math.min(1, Math.abs(d - ringR) / 22);
          if (bandK > 0 && ringR < RING_REACH) {
            const f = bandK * 4.4 * (1 - ringAge / RING_MS) * (1 - ringR / RING_REACH);
            vx += (dx / d) * f;
            vy += (dy / d) * f;
          }
        }
        stepInto(out, dots[j], dots[j + 1], vx, vy, hx, hy, px, py, r, pvx, pvy);
        let x = out[0], y = out[1];
        vx = out[2];
        vy = out[3];
        const speed = Math.abs(vx) + Math.abs(vy), off = Math.abs(x - hx) + Math.abs(y - hy);
        if (speed < 0.05 && off < 0.15) {
          x = hx; y = hy; vx = vy = 0;
          resting[i] = 1;
        } else {
          live[kept++] = i;
          // Still, but held off its place by a resting pointer: no need to keep drawing.
          if (speed > 0.05 || !pointerIn) moving = true;
        }
        dots[j] = x; dots[j + 1] = y; dots[j + 2] = vx; dots[j + 3] = vy;
      }
      liveCount = kept;
    }

    // The rectangle to repaint: everywhere a live dot is or has its home, and everywhere one was drawn last frame.
    let x0 = 1e9, y0 = 1e9, x1 = -1e9, y1 = -1e9;
    const grow = (x, y) => { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; };
    for (let n = 0; n < liveCount; n++) {
      const i = live[n], j = i * 7, x = dots[j], y = dots[j + 1], hx = dots[j + 4], hy = dots[j + 5];
      grow(x, y);
      grow(hx, hy);
      // Which colour band, and how far it has swelled (both from how near the pointer is, and how far it is displaced).
      const k = Math.min(1, warmth(x, y, hx, hy, WARM_SPAN) + (Math.abs(dots[j + 2]) + Math.abs(dots[j + 3])) * 0.05);
      band[i] = Math.round(k * (BANDS - 1));
      const dx = x - px, dy = y - py;
      bloom[i] = r > 0 && px > -1e4 ? Math.max(0, 1 - Math.sqrt(dx * dx + dy * dy) / r) : 0;
    }

    if (repaint) blitAll();
    if (liveCount || dirty) {
      let X0 = Math.floor((x0 - PAD) * dpr), Y0 = Math.floor((y0 - PAD) * dpr), X1 = Math.ceil((x1 + PAD) * dpr), Y1 = Math.ceil((y1 + PAD) * dpr);
      if (!liveCount) { X0 = Y0 = 1e9; X1 = Y1 = -1e9; }
      if (dirty) { X0 = Math.min(X0, dirty[0]); Y0 = Math.min(Y0, dirty[1]); X1 = Math.max(X1, dirty[2]); Y1 = Math.max(Y1, dirty[3]); }
      X0 = Math.max(0, X0); Y0 = Math.max(0, Y0); X1 = Math.min(canvas.width, X1); Y1 = Math.min(canvas.height, Y1);
      if (X1 > X0 && Y1 > Y0) {
        // Put the still word back over that rectangle, 1:1 (no resampling), then lift the live dots off it.
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.clearRect(X0, Y0, X1 - X0, Y1 - Y0);
        ctx.drawImage(still, X0, Y0, X1 - X0, Y1 - Y0, X0, Y0, X1 - X0, Y1 - Y0);
        if (liveCount) {
          ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
          ctx.globalCompositeOperation = "destination-out";
          ctx.beginPath();
          for (let n = 0; n < liveCount; n++) {
            const j = live[n] * 7, rr = dots[j + 6] + 0.7;
            ctx.moveTo(dots[j + 4] + rr, dots[j + 5]);
            ctx.arc(dots[j + 4], dots[j + 5], rr, 0, Math.PI * 2);
          }
          ctx.fill();
          ctx.globalCompositeOperation = "source-over";
          // The erase is a little bigger than the dot (to take its soft edge too), and neighbouring dots overlap, so it
          // bit a thin crescent out of any resting neighbour; along the edge of the moving region those crescents
          // joined up into a dark line. Each resting neighbour is drawn again, whole.
          stamp++;
          ctx.fillStyle = shades[0];
          ctx.beginPath();
          let again = false;
          for (let n = 0; n < liveCount; n++) {
            const j = live[n] * 7, gx0 = Math.floor(dots[j + 4] / cell), gy0 = Math.floor(dots[j + 5] / cell);
            for (let dy = -1; dy <= 1; dy++) {
              for (let dx = -1; dx <= 1; dx++) {
                const gx = gx0 + dx, gy = gy0 + dy;
                if ((dx === 0 && dy === 0) || gx < 0 || gy < 0 || gx >= cols || gy >= rowsN) continue;
                const k = grid[gy * cols + gx];
                if (k < 0 || !resting[k] || seen[k] === stamp) continue;
                seen[k] = stamp;
                const q = k * 7, rr = dots[q + 6];
                ctx.moveTo(dots[q + 4] + rr, dots[q + 5]);
                ctx.arc(dots[q + 4], dots[q + 5], rr, 0, Math.PI * 2);
                again = true;
              }
            }
          }
          if (again) ctx.fill();
          // One fill per colour band.
          for (let b = 0; b < BANDS; b++) {
            let any = false;
            for (let n = 0; n < liveCount; n++) {
              const i = live[n];
              if (band[i] !== b) continue;
              if (!any) { ctx.fillStyle = shades[b]; ctx.beginPath(); any = true; }
              const j = i * 7, rr = dots[j + 6] * (1 + bloom[i] * bloom[i] * 0.7);
              ctx.moveTo(dots[j] + rr, dots[j + 1]);
              ctx.arc(dots[j], dots[j + 1], rr, 0, Math.PI * 2);
            }
            if (any) ctx.fill();
          }
        }
        dirty = liveCount ? [X0, Y0, X1, Y1] : null;
      }
    }
    awake = moving || ringOn || !!from;
  };

  const loop = (now) => {
    raf = 0;
    if (!visible || !alive) return;
    draw(now);
    if (awake) raf = requestAnimationFrame(loop);
  };
  function wake() {
    awake = true;
    if (!raf && visible && alive) raf = requestAnimationFrame(loop);
  }

  const local = (e) => {
    const b = canvas.getBoundingClientRect();
    return [e.clientX - b.left, e.clientY - b.top];
  };
  const onMove = (e) => { [tx, ty] = local(e); wake(); };
  const onLeave = () => { tx = ty = -1e5; wake(); };
  const onUp = (e) => e.pointerType !== "mouse" && onLeave();
  const onDown = (e) => {
    if (e.target.closest("a, button")) return;
    const [x, y] = local(e);
    ring = { x, y, t: performance.now() };
    if (e.pointerType !== "mouse") [tx, ty] = [x, y];
    wake();
  };

  const ready = layout();

  const target = stage.closest("footer") ?? stage;
  if (!reduced) {
    target.addEventListener("pointermove", onMove);
    target.addEventListener("pointerleave", onLeave);
    target.addEventListener("pointercancel", onLeave);
    target.addEventListener("pointerup", onUp);
    target.addEventListener("pointerdown", onDown);
  }
  const r0 = stage.getBoundingClientRect();
  let size = `${Math.round(r0.width)}x${Math.round(r0.height)}`;
  const ro = new ResizeObserver(() => {
    const r = stage.getBoundingClientRect(), next = `${Math.round(r.width)}x${Math.round(r.height)}`;
    if (next === size) return;
    size = next;
    layout().then(wake);
  });
  ro.observe(stage);
  // Only paused while off screen: nothing else needs to know when it is in view.
  const io = new IntersectionObserver((entries) => {
    visible = entries.at(-1)?.isIntersecting ?? true;
    if (visible) wake();
  });
  io.observe(stage);
  // The palette is rewritten by the live card, and the light and dark tokens swap with the system.
  const mo = new MutationObserver(recolor);
  const palette = document.getElementById("palette");
  if (palette) mo.observe(palette, { childList: true, characterData: true, subtree: true });
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  scheme.addEventListener("change", recolor);

  const stop = () => {
    alive = false;
    building++;
    cancelAnimationFrame(raf);
    ro.disconnect();
    io.disconnect();
    mo.disconnect();
    scheme.removeEventListener("change", recolor);
    target.removeEventListener("pointermove", onMove);
    target.removeEventListener("pointerleave", onLeave);
    target.removeEventListener("pointercancel", onLeave);
    target.removeEventListener("pointerup", onUp);
    target.removeEventListener("pointerdown", onDown);
  };
  return { ready, stop };
}
