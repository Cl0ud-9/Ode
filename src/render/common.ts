import type { CardData, CardOptions } from "../model.ts";
import type { Palette, Role, Scheme } from "../palette.ts";
import { progressWave } from "../shapes.ts";
import { timeAgo } from "../util.ts";

export const ROLES: Role[] = [
  "surface", "container", "containerHigh", "onSurface", "onVariant", "outline",
  "primary", "onPrimary", "primaryContainer", "onPrimaryContainer",
  "secondaryContainer", "onSecondaryContainer", "tertiary", "tertiaryContainer", "bgA", "bgB",
];

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

function rules(scheme: Scheme): string {
  return ROLES.map((r) => `.f-${kebab(r)}{fill:${scheme[r]}}.s-${kebab(r)}{stroke:${scheme[r]}}.t-${kebab(r)}{stop-color:${scheme[r]}}`).join("");
}

/** Class names for a colour role, e.g. fill("primary") -> "f-primary". */
export const fill = (r: Role) => `f-${kebab(r)}`;
export const stroke = (r: Role) => `s-${kebab(r)}`;
/** Gradient stop colour class, e.g. stop("bgA") -> "t-bg-a". */
export const stop = (r: Role) => `t-${kebab(r)}`;

export function colorCss(p: Palette, opts: CardOptions): string {
  if (opts.mode === "light") return rules(p.light);
  if (opts.mode === "dark") return rules(p.dark);
  return `${rules(p.light)}@media (prefers-color-scheme:dark){${rules(p.dark)}}`;
}

export const SANS = "'Google Sans Flex','Google Sans','Product Sans','Segoe UI',system-ui,-apple-system,Roboto,'Helvetica Neue',Arial,sans-serif";
export const MONO = "'JetBrains Mono','Cascadia Code','SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace";

/** Shared keyframes; omitted entirely when `still` so the image is a clean static frame. */
export function motionCss(opts: CardOptions): string {
  if (opts.still) return "";
  return (
    `@keyframes eq{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}` +
    `@keyframes spin{to{transform:rotate(360deg)}}` +
    `@keyframes blink{50%{opacity:0}}` +
    `.eq rect{transform-box:fill-box;transform-origin:50% 100%;animation:eq 1.15s ease-in-out infinite}` +
    `.spin{animation:spin 48s linear infinite}.spin-rev{animation:spin 64s linear infinite reverse}` +
    `.blink{animation:blink 1.1s steps(1) infinite}` +
    `@media (prefers-reduced-motion:reduce){.eq rect,.spin,.spin-rev,.blink{animation:none}}`
  );
}

/** Rendered width in CSS pixels. Cards are drawn on a larger canvas and shown at this size, so they sit comfortably beside badges. */
export const DISPLAY_W = 480;

export function wrap(w: number, h: number, title: string, css: string, body: string): string {
  const dw = DISPLAY_W;
  const dh = Math.round((h * DISPLAY_W) / w);
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${dw}" height="${dh}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}">` +
    `<title>${title}</title><style>${css}</style>${body}</svg>`
  );
}

export interface Copy {
  pill: string;
  /** "3 h ago" for last-played cards, otherwise empty. */
  ago: string;
  title: string;
  sub: string;
  meta: string;
  live: boolean;
}

/** Words for each state, kept in one place so every theme says the same thing. */
export function copyFor(d: CardData): Copy {
  switch (d.kind) {
    case "playing":
      return { pill: "NOW PLAYING", ago: "", title: d.track!.title, sub: d.track!.artist, meta: albumLine(d.track!.album, d.track!.title), live: true };
    case "idle": {
      const ago = timeAgo(d.track!.playedAt, d.now);
      return { pill: ago && ago !== "a while ago" ? `PLAYED ${ago.toUpperCase()}` : "LAST PLAYED", ago, title: d.track!.title, sub: d.track!.artist, meta: albumLine(d.track!.album, d.track!.title), live: false };
    }
    case "empty":
      return { pill: "QUIET FOR NOW", ago: "", title: "All quiet", sub: "No scrobbles yet", meta: "Play a song to light this up", live: false };
    case "error":
    default:
      return { pill: "OFFLINE", ago: "", title: "Taking a breather", sub: d.message ?? "Could not reach Last.fm", meta: "This card refreshes on its own", live: false };
  }
}

const plain = (s: string) => s.toLowerCase().replace(/\s*-\s*(single|ep)$/, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();

/** The album line, or nothing when it only repeats the title ("Song" on "Song - Single"). */
export function albumLine(album: string, title: string): string {
  const a = album.trim();
  return a && plain(a) !== plain(title) ? a : "";
}

export interface IndicatorSpec {
  /** The column the indicator spans, round caps included. */
  x0: number;
  x1: number;
  y: number;
  stroke: number;
  amp: number;
  wavelength: number;
  /** Space between the active part and the track, cap to cap (M3: 4dp). */
  gap: number;
  /** Seconds for the wave to travel one wavelength. */
  driftS: number;
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * Material 3 Expressive wavy progress indicator, drawn the way the spec draws it: a wavy active part with a round
 * head, a gap, a flat track, and a stop dot at the end of the track.
 *
 *  - Playing with a known length: the active part grows in real time (a CSS animation over the rest of the song),
 *    so an open page keeps moving without reloading.
 *  - Playing, length unknown: the wave spans the whole column (no made-up progress, no stop dot).
 *  - Not playing: the flat track with its stop dot.
 *
 * The wave is drawn as a dash of a longer sine. Shifting the sine one wavelength left while moving the dash the
 * same distance along it makes the crests travel while both ends stay put, with no mask or fade needed.
 */
export function progressIndicator(d: CardData, opts: CardOptions, s: IndicatorSpec): { svg: string; css: string } {
  const r = s.stroke / 2;
  const a = s.x0 + r;
  const b = s.x1 - r;
  const len = b - a;
  const line = (cls: string, extra = "") =>
    `<path d="M${n1(b)} ${s.y}L${n1(a)} ${s.y}" fill="none" class="${cls}" stroke-width="${s.stroke}" stroke-linecap="round"${extra}/>`;
  const dot = `<circle cx="${n1(b)}" cy="${s.y}" r="${n1(r)}" class="${fill("primary")}"/>`;

  if (d.kind !== "playing") return { svg: line(stroke("primaryContainer")) + dot, css: "" };

  const wave = progressWave(a, b, s.y, s.amp, s.wavelength);
  const slide = s.wavelength * wave.perX;
  const p = d.progress;
  const frac = p ? Math.min(1, p.elapsed / p.duration) : 1;
  const head = a + len * frac;
  const dash = (x: number) => `${n1(wave.perX * (x - a))} 9999`;
  // The track starts one gap (cap to cap) after the head; past that point there is no track left, only the dot.
  const trackFrom = (h: number) => Math.max(0, b - h - s.gap - s.stroke);

  const remaining = p ? Math.max(0, p.duration - p.elapsed) : 0;
  const grows = !!p && !opts.still && remaining >= 1;
  // The drift and the dash compensation must move in lockstep or the ends would wobble, so both are SMIL animations
  // on the same timeline (two CSS animations can run on different threads). Reduced motion pins both with
  // !important, which outranks SMIL; the progress itself (a CSS animation) still advances.
  let css = opts.still ? "" : `@media (prefers-reduced-motion:reduce){.pw{transform:none!important}.pa{stroke-dashoffset:0!important}}`;
  if (grows) {
    const t0 = trackFrom(head);
    // When the track runs out, measured in seconds from now (it shrinks to nothing before the song ends).
    const emptyAt = ((b - s.gap - s.stroke - a) / len) * p.duration - p.elapsed;
    const pct = Math.min(100, Math.max(0, (emptyAt / remaining) * 100));
    css +=
      `@keyframes pgrow{from{stroke-dasharray:${dash(head)}}to{stroke-dasharray:${dash(b)}}}` +
      `@keyframes pshrink{from{stroke-dasharray:${n1(t0)} 9999}${n1(pct)}%,to{stroke-dasharray:0 9999}}` +
      `.pa{animation:pgrow ${n1(remaining)}s linear forwards}.pt{animation:pshrink ${n1(remaining)}s linear forwards}`;
  }

  const moving = !opts.still;
  const active =
    `<g class="pw">` +
    (moving ? `<animateTransform attributeName="transform" type="translate" from="0 0" to="${-s.wavelength} 0" dur="${s.driftS}s" repeatCount="indefinite"/>` : "") +
    `<path d="${wave.d}" fill="none" class="pa ${stroke("primary")}" stroke-width="${s.stroke}" stroke-linecap="round" stroke-dasharray="${dash(head)}">` +
    (moving ? `<animate attributeName="stroke-dashoffset" from="0" to="${n1(-slide)}" dur="${s.driftS}s" repeatCount="indefinite"/>` : "") +
    `</path></g>`;
  if (!p) return { svg: active, css };
  const t0 = trackFrom(head);
  return { svg: line(`pt ${stroke("primaryContainer")}`, ` stroke-dasharray="${n1(t0)} 9999"`) + dot + active, css };
}

/** GitHub's page colours (default light and dark themes). */
const GITHUB_CANVAS = { light: "#ffffff", dark: "#0d1117" } as const;

/**
 * Paints the area outside the card's rounded corners in GitHub's page colour. Left transparent, those corners show
 * whatever GitHub draws behind an image, and signed-in GitHub draws a lighter box (#151b23), which appeared as pale
 * wedges at each corner. The fill reaches 1px under the card so no hairline seam can show between them.
 * Follows the card's colour mode; ?corners=clear leaves them transparent for pages with their own background.
 */
export function cornerFill(w: number, h: number, rx: number, opts: CardOptions): { svg: string; css: string } {
  if (opts.clearCorners) return { svg: "", css: "" };
  const i = 1;
  const r = rx - i;
  const inner = `M${i + r} ${i}H${w - i - r}A${r} ${r} 0 0 1 ${w - i} ${i + r}V${h - i - r}A${r} ${r} 0 0 1 ${w - i - r} ${h - i}H${i + r}A${r} ${r} 0 0 1 ${i} ${h - i - r}V${i + r}A${r} ${r} 0 0 1 ${i + r} ${i}Z`;
  const svg = `<path class="gh-canvas" fill-rule="evenodd" d="M0 0H${w}V${h}H0Z${inner}"/>`;
  const rule = (c: string) => `.gh-canvas{fill:${c}}`;
  const css =
    opts.mode === "light" ? rule(GITHUB_CANVAS.light)
    : opts.mode === "dark" ? rule(GITHUB_CANVAS.dark)
    : `${rule(GITHUB_CANVAS.light)}@media (prefers-color-scheme:dark){${rule(GITHUB_CANVAS.dark)}}`;
  return { svg, css };
}
