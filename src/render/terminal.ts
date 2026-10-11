import type { CardData, CardOptions } from "../model.ts";
import type { Palette } from "../palette.ts";
import { eqHeights } from "../shapes.ts";
import { esc, fit } from "../util.ts";
import { MONO, colorCss, copyFor, fill, motionCss, wrap } from "./common.ts";

const W = 800;
const H = 240;
const FS = 20;
const CH = FS * 0.6;

/** Developer-terminal theme: a prompt, key/value rows and a bar equaliser. */
export function renderTerminal(d: CardData, palette: Palette, opts: CardOptions): string {
  const copy = copyFor(d);
  const maxChars = Math.floor((W - 60 - 9 * CH) / CH);
  const state = d.kind === "playing" ? "playing" : d.kind === "idle" ? "idle" : d.kind === "empty" ? "no data" : "offline";
  const glyph = d.kind === "playing" ? "▶" : "■";

  const row = (y: number, key: string, value: string, cls: string) =>
    `<text x="30" y="${y}" xml:space="preserve" font-family="${MONO}" font-size="${FS}"><tspan class="${fill("onVariant")}">${key.padEnd(8)}</tspan><tspan class="${cls}">${esc(fit(value, maxChars * CH, FS, true))}</tspan></text>`;

  const rows =
    d.kind === "playing" || d.kind === "idle"
      ? row(124, "title", copy.title, fill("onSurface")) +
        row(152, "artist", copy.sub, fill("primary")) +
        row(180, "album", copy.meta || "-", fill("onSurface"))
      : row(124, "status", copy.title, fill("onSurface")) + row(152, "detail", copy.sub, fill("primary")) + row(180, "hint", copy.meta, fill("onSurface"));

  const bars = eqHeights(d.seed, 16, 26);
  const eq = bars
    .map((h, i) => `<rect x="${i * 9}" y="${26 - h}" width="5" height="${h}" rx="1" style="animation-delay:-${(i * 0.17).toFixed(2)}s"/>`)
    .join("");

  const body =
    `<defs><clipPath id="card"><rect width="${W}" height="${H}" rx="18"/></clipPath></defs>` +
    `<g clip-path="url(#card)">` +
    `<rect width="${W}" height="${H}" class="${fill("surface")}"/>` +
    `<rect width="${W}" height="40" class="${fill("container")}"/>` +
    `<circle cx="26" cy="20" r="6" class="${fill("outline")}"/><circle cx="46" cy="20" r="6" class="${fill("outline")}"/><circle cx="66" cy="20" r="6" class="${fill("outline")}"/>` +
    `<text x="${W - 24}" y="26" text-anchor="end" font-family="${MONO}" font-size="14" class="${fill("onVariant")}">${esc(d.user ? `~/${d.user}/tidemark` : "~/tidemark")}</text>` +
    `<text x="30" y="82" font-family="${MONO}" font-size="${FS}"><tspan class="${fill("tertiary")}">$ </tspan><tspan class="${fill("onSurface")}">tidemark now</tspan><tspan class="${fill("onVariant")}"> --user ${esc(d.user || "you")}</tspan></text>` +
    `<text x="30" y="104" font-family="${MONO}" font-size="14" class="${fill("primary")}">${glyph} ${esc(state)}${d.kind === "idle" ? ` · ${esc(copy.pill.replace("LAST PLAYED · ", "").toLowerCase())}` : ""}</text>` +
    rows +
    `<g class="eq ${fill("primary")}" transform="translate(30 198)" opacity="${d.kind === "playing" ? 1 : 0.35}">${eq}</g>` +
    `<rect class="blink ${fill("primary")}" x="${30 + 16 * 9 + 8}" y="198" width="11" height="26" rx="1"/>` +
    `</g>`;

  return wrap(W, H, esc(`${copy.pill}: ${copy.title} - ${copy.sub}`), colorCss(palette, opts) + motionCss(opts), body);
}
