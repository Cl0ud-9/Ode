import type { CardData, CardOptions } from "../model.ts";
import type { Palette, Role, Scheme } from "../palette.ts";
import { timeAgo } from "../util.ts";

export const ROLES: Role[] = [
  "surface", "container", "containerHigh", "onSurface", "onVariant", "outline",
  "primary", "onPrimary", "primaryContainer", "onPrimaryContainer",
  "secondaryContainer", "onSecondaryContainer", "tertiary",
];

const kebab = (s: string) => s.replace(/[A-Z]/g, (c) => "-" + c.toLowerCase());

function rules(scheme: Scheme): string {
  return ROLES.map((r) => `.f-${kebab(r)}{fill:${scheme[r]}}.s-${kebab(r)}{stroke:${scheme[r]}}`).join("");
}

/** Class names for a colour role, e.g. fill("primary") -> "f-primary". */
export const fill = (r: Role) => `f-${kebab(r)}`;
export const stroke = (r: Role) => `s-${kebab(r)}`;

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

export function wrap(w: number, h: number, title: string, css: string, body: string): string {
  return (
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" role="img" aria-label="${title}">` +
    `<title>${title}</title><style>${css}</style>${body}</svg>`
  );
}

export interface Copy {
  pill: string;
  title: string;
  sub: string;
  meta: string;
  live: boolean;
}

/** Words for each state, kept in one place so every theme says the same thing. */
export function copyFor(d: CardData): Copy {
  const handle = d.user ? `@${d.user}` : "";
  switch (d.kind) {
    case "playing":
      return { pill: "NOW PLAYING", title: d.track!.title, sub: d.track!.artist, meta: d.track!.album, live: true };
    case "idle": {
      const ago = timeAgo(d.track!.playedAt, d.now);
      return { pill: ago ? `LAST PLAYED · ${ago.toUpperCase()}` : "LAST PLAYED", title: d.track!.title, sub: d.track!.artist, meta: d.track!.album, live: false };
    }
    case "empty":
      return { pill: "QUIET FOR NOW", title: "Nothing played yet", sub: `${handle} has not scrobbled a track`.trim(), meta: "Play something and it will show up here", live: false };
    case "error":
    default:
      return { pill: "OFFLINE", title: "Taking a breather", sub: d.message ?? "Could not reach Last.fm", meta: "This card refreshes on its own", live: false };
  }
}
