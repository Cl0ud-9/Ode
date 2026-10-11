import type { CardData, CardOptions } from "../model.ts";
import type { Palette } from "../palette.ts";
import { eqHeights, notePath } from "../shapes.ts";
import { esc, fit } from "../util.ts";
import { MONO, colorCss, copyFor, fill, motionCss, stop, stroke, wrap } from "./common.ts";

const W = 800;
const H = 250;
const FS = 24;
const CH = FS * 0.6;
const TILE = 140;
const TILE_X = 632;
const TILE_Y = 82;

/** Developer-terminal theme: a prompt, key/value rows and a bar equaliser. */
export function renderTerminal(d: CardData, palette: Palette, opts: CardOptions): string {
  const copy = copyFor(d);
  const track = d.kind === "playing" || d.kind === "idle";
  // Tracks get a cover tile on the right, so the text column stops before it.
  const textRight = track ? 604 : W - 30;
  const maxChars = Math.floor((textRight - 30 - 9 * CH) / CH);
  const prompt = `$ tidemark now --user ${d.user || "you"}`;
  const state = d.kind === "playing" ? "playing" : d.kind === "idle" ? "idle" : d.kind === "empty" ? "no data" : "offline";
  const ago = copy.ago ? ` · ${copy.ago}` : "";
  const glyph = d.kind === "playing" ? "▶" : "■";

  const row = (y: number, key: string, value: string, cls: string) =>
    `<text x="30" y="${y}" xml:space="preserve" font-family="${MONO}" font-size="${FS}"><tspan class="${fill("onVariant")}">${key.padEnd(8)}</tspan><tspan class="${cls}">${esc(fit(value, maxChars * CH, FS, true))}</tspan></text>`;

  const rows =
    d.kind === "playing" || d.kind === "idle"
      ? row(158, "title", copy.title, fill("onSurface")) +
        row(192, "artist", copy.sub, fill("primary")) +
        row(226, "album", copy.meta || "-", fill("onSurface"))
      : row(158, "status", copy.title, fill("onSurface")) + row(192, "detail", copy.sub, fill("primary")) + row(226, "hint", copy.meta, fill("onSurface"));

  const bars = eqHeights(d.seed, 12, 22);
  const eq = bars
    .map((h, i) => `<rect x="${i * 9}" y="${22 - h}" width="5" height="${h}" rx="1" style="animation-delay:-${(i * 0.17).toFixed(2)}s"/>`)
    .join("");

  const tile = d.artDataUri
    ? `<rect x="${TILE_X + 3}" y="${TILE_Y + 6}" width="${TILE}" height="${TILE}" rx="26" fill="#000" opacity=".28"/>` +
      `<image href="${d.artDataUri}" x="${TILE_X}" y="${TILE_Y}" width="${TILE}" height="${TILE}" preserveAspectRatio="xMidYMid slice" clip-path="url(#cv)"/>` +
      `<rect x="${TILE_X}" y="${TILE_Y}" width="${TILE}" height="${TILE}" rx="26" fill="none" class="${stroke("onSurface")}" stroke-width="2" opacity=".2"/>`
    : `<rect x="${TILE_X}" y="${TILE_Y}" width="${TILE}" height="${TILE}" rx="26" class="${fill("primaryContainer")}"/>` +
      `<path class="${fill("onPrimaryContainer")}" d="${notePath(TILE_X + TILE / 2 - 24, TILE_Y + TILE / 2 - 38, 1.05)}"/>`;

  const body =
    `<defs><clipPath id="card"><rect width="${W}" height="${H}" rx="28"/></clipPath><clipPath id="cv"><rect x="${TILE_X}" y="${TILE_Y}" width="${TILE}" height="${TILE}" rx="26"/></clipPath>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="${stop("bgA")}"/><stop offset="1" class="${stop("bgB")}"/></linearGradient></defs>` +
    `<g clip-path="url(#card)">` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    `<rect width="${W}" height="44" class="${fill("container")}" opacity=".75"/>` +
    `<circle cx="28" cy="22" r="7" class="${fill("outline")}"/><circle cx="50" cy="22" r="7" class="${fill("outline")}"/><circle cx="72" cy="22" r="7" class="${fill("outline")}"/>` +
    `<text x="${W - 24}" y="28" text-anchor="end" font-family="${MONO}" font-size="17" class="${fill("onVariant")}">${esc(d.user ? `~/${d.user}/tidemark` : "~/tidemark")}</text>` +
    `<text x="30" y="94" font-family="${MONO}" font-size="${FS}"><tspan class="${fill("tertiary")}">$ </tspan><tspan class="${fill("onSurface")}">tidemark now</tspan><tspan class="${fill("onVariant")}"> --user ${esc(d.user || "you")}</tspan></text>` +
    `<rect class="blink ${fill("primary")}" x="${Math.round(30 + (prompt.length + 1) * CH)}" y="75" width="${Math.round(CH * 0.8)}" height="24" rx="1"/>` +
    `<text x="30" y="126" font-family="${MONO}" font-size="18" class="${fill("primary")}">${glyph} ${esc(state + ago)}</text>` +
    rows +
    (d.kind === "playing" ? `<g class="eq ${fill("primary")}" transform="translate(${Math.round(30 + (state.length + ago.length + 4) * 18 * 0.6)} 108)">${eq}</g>` : "") +
    (track ? tile : "") +
    `</g>`;

  return wrap(W, H, esc(`${copy.pill}: ${copy.title} - ${copy.sub}`), colorCss(palette, opts) + motionCss(opts), body);
}
