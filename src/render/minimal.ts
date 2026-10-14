import type { CardData, CardOptions } from "../model.ts";
import type { Palette } from "../palette.ts";
import { eqHeights, notePath, scallopPath } from "../shapes.ts";
import { esc, fit } from "../util.ts";
import { SANS, colorCss, copyFor, cornerFill, fill, motionCss, progressIndicator, stop, wrap } from "./common.ts";

const W = 800;
const H = 145; // 480 px wide shows it at exactly 87 px tall: a fractional height left a 1 px gap at each side
const WAVELENGTH = 32;

/** Compact single-row card for people who want something small. */
export function renderMinimal(d: CardData, palette: Palette, opts: CardOptions): string {
  const copy = copyFor(d);
  const live = copy.live;
  const cx = 72;
  const cy = 72;
  const textX = 148;
  const textW = W - textX - 130;

  const cookie = scallopPath(cx, cy, 50, 9, 0.045);
  const art = d.artDataUri
    ? `<clipPath id="cv"><path d="${cookie}"/></clipPath>` +
      `<image href="${d.artDataUri}" x="${cx - 54}" y="${cy - 54}" width="108" height="108" preserveAspectRatio="xMidYMid slice" clip-path="url(#cv)"/>`
    : `<path class="${fill("primaryContainer")}" d="${cookie}"/><path class="${fill("onPrimaryContainer")}" d="${notePath(cx - 16, cy - 25, 0.7)}"/>`;

  const bars = eqHeights(d.seed, 4, 24);
  const eq = bars
    .map((h, i) => `<rect x="${i * 11}" y="${24 - h}" width="6" height="${h}" rx="3" style="animation-delay:-${(i * 0.29).toFixed(2)}s"/>`)
    .join("");

  const sub = copy.sub + (copy.meta && live ? ` · ${copy.meta}` : "");
  const progress = progressIndicator(d, opts, { x0: textX, x1: textX + textW, y: 129, stroke: 4.5, amp: 3.5, wavelength: WAVELENGTH, gap: 6, driftS: 4 });
  const body =
    `<defs><clipPath id="card"><rect width="${W}" height="${H}" rx="36"/></clipPath><linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="${stop("bgA")}"/><stop offset="1" class="${stop("bgB")}"/></linearGradient>` +
    `</defs>` +
    `<g clip-path="url(#card)">` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    art +
    `<text x="${textX}" y="40" font-family="${SANS}" font-size="18" font-weight="700" letter-spacing="1.5" class="${fill("primary")}">${esc(copy.pill)}</text>` +
    `<text x="${textX}" y="80" font-family="${SANS}" font-size="36" font-weight="800" class="${fill("onSurface")}">${esc(fit(copy.title, textW, 36, false, true))}</text>` +
    `<text x="${textX}" y="108" font-family="${SANS}" font-size="25" class="${fill("onVariant")}">${esc(fit(sub, textW, 25))}</text>` +
    progress.svg +
    (live ? `<g class="eq ${fill("primary")}" transform="translate(${W - 100} ${H / 2 - 12})">${eq}</g>` : "") +
    `</g>`;

  const corners = cornerFill(W, H, 36, opts);
  return wrap(W, H, esc(`${copy.pill}: ${copy.title} - ${copy.sub}`), colorCss(palette, opts) + motionCss(opts) + progress.css + corners.css, corners.svg + body);
}
