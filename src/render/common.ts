import type { CardData, CardOptions } from "../model.ts";
import type { Palette, Role, Scheme } from "../palette.ts";
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
export function motionCss(opts: CardOptions, fastPx = 160, slowPx = 400): string {
  if (opts.still) return "";
  return (
    `@keyframes eq{0%,100%{transform:scaleY(.3)}50%{transform:scaleY(1)}}` +
    `@keyframes drift{to{transform:translateX(${-fastPx}px)}}` +
    `@keyframes drift-slow{to{transform:translateX(${-slowPx}px)}}` +
    `@keyframes spin{to{transform:rotate(360deg)}}` +
    `@keyframes blink{50%{opacity:0}}` +
    `.eq rect{transform-box:fill-box;transform-origin:50% 100%;animation:eq 1.15s ease-in-out infinite}` +
    `.drift{animation:drift 5s linear infinite}.drift-slow{animation:drift-slow 14s linear infinite}` +
    `.spin{animation:spin 48s linear infinite}.spin-rev{animation:spin 64s linear infinite reverse}` +
    `.blink{animation:blink 1.1s steps(1) infinite}` +
    `@media (prefers-reduced-motion:reduce){.eq rect,.drift,.drift-slow,.spin,.spin-rev,.blink{animation:none}}`
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
      return { pill: ago ? `PLAYED ${ago.toUpperCase()}` : "LAST PLAYED", ago, title: d.track!.title, sub: d.track!.artist, meta: albumLine(d.track!.album, d.track!.title), live: false };
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
