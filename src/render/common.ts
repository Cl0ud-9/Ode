import type { CardData, CardOptions } from "../model.ts";
import type { Palette, Role, Scheme } from "../palette.ts";
import { travellingWave } from "../shapes.ts";
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

export interface WaveSpec {
  /** The column the wave spans, round caps included. */
  x0: number;
  x1: number;
  y: number;
  stroke: number;
  amp: number;
  wavelength: number;
  /** Seconds for the wave to travel one wavelength. */
  driftS: number;
}

const n1 = (v: number) => (Math.round(v * 10) / 10).toString();

/**
 * The Material 3 Expressive wavy line, drawn only while a song plays: it spans the whole column and travels.
 * It is deliberately not a progress bar. Last.fm reports no playback position, and progress estimated from when a
 * song was first noticed was wrong for long songs, repeats and songs noticed late (it looked finished at once).
 * When nothing plays there is no line at all: a flat line read as an empty, broken progress bar.
 *
 * The wave is a dash along a longer sine, so both ends are round caps. Shifting the sine one wavelength left while
 * moving the dash the same distance along it makes the crests travel while the ends stay put; both moves are SMIL
 * animations on one timeline so they cannot drift apart. Reduced motion pins them (!important outranks SMIL).
 */
export function liveWave(d: CardData, opts: CardOptions, s: WaveSpec): { svg: string; css: string } {
  if (d.kind !== "playing") return { svg: "", css: "" };
  const r = s.stroke / 2;
  const a = s.x0 + r;
  const b = s.x1 - r;
  const wave = travellingWave(a, b, s.y, s.amp, s.wavelength);
  const moving = !opts.still;
  const svg =
    `<g class="pw">` +
    (moving ? `<animateTransform attributeName="transform" type="translate" from="0 0" to="${-s.wavelength} 0" dur="${s.driftS}s" repeatCount="indefinite"/>` : "") +
    `<path d="${wave.d}" fill="none" class="pa ${stroke("primary")}" stroke-width="${s.stroke}" stroke-linecap="round" stroke-dasharray="${n1(wave.perX * (b - a))} 9999">` +
    (moving ? `<animate attributeName="stroke-dashoffset" from="0" to="${n1(-s.wavelength * wave.perX)}" dur="${s.driftS}s" repeatCount="indefinite"/>` : "") +
    `</path></g>`;
  const css = moving ? `@media (prefers-reduced-motion:reduce){.pw{transform:none!important}.pa{stroke-dashoffset:0!important}}` : "";
  return { svg, css };
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
