import type { CardData, CardOptions } from "../model.ts";
import type { Palette } from "../palette.ts";
import { eqHeights, notePath, scallopPath, wavePath, waveSpec } from "../shapes.ts";
import { esc, fit } from "../util.ts";
import { SANS, colorCss, copyFor, fill, motionCss, stroke, wrap } from "./common.ts";

const W = 800;
const H = 130;

/** Compact single-row card for people who want something small. */
export function renderMinimal(d: CardData, palette: Palette, opts: CardOptions): string {
  const copy = copyFor(d);
  const live = copy.live;
  const cx = 65;
  const cy = 65;
  const textX = 140;
  const textW = W - textX - 150;
  const spec = waveSpec(d.seed, 120);

  const art = d.artDataUri
    ? `<clipPath id="cv"><path d="${scallopPath(cx, cy, 44, 8, 0.04)}"/></clipPath>` +
      `<image href="${d.artDataUri}" x="${cx - 48}" y="${cy - 48}" width="96" height="96" preserveAspectRatio="xMidYMid slice" clip-path="url(#cv)"/>`
    : `<path class="${fill("primary")}" d="${scallopPath(cx, cy, 44, 8, 0.04)}"/><path class="${fill("onPrimary")}" d="${notePath(cx - 14, cy - 22, 0.62)}"/>`;

  const bars = eqHeights(d.seed, 4, 22);
  const eq = bars
    .map((h, i) => `<rect x="${i * 10}" y="${22 - h}" width="6" height="${h}" rx="3" style="animation-delay:-${(i * 0.29).toFixed(2)}s"/>`)
    .join("");

  const body =
    `<defs><clipPath id="card"><rect width="${W}" height="${H}" rx="32"/></clipPath><clipPath id="col"><rect x="${textX}" y="92" width="${textW}" height="30"/></clipPath></defs>` +
    `<g clip-path="url(#card)">` +
    `<rect width="${W}" height="${H}" class="${fill("container")}"/>` +
    art +
    `<text x="${textX}" y="52" font-family="${SANS}" font-size="12.5" font-weight="700" letter-spacing="1.3" class="${fill("primary")}">${esc(copy.pill)}</text>` +
    `<text x="${textX}" y="82" font-family="${SANS}" font-size="28" font-weight="800" class="${fill("onSurface")}">${esc(fit(copy.title, textW, 28))}</text>` +
    `<text x="${textX}" y="106" font-family="${SANS}" font-size="19" class="${fill("onVariant")}">${esc(fit(copy.sub + (copy.meta && live ? ` · ${copy.meta}` : ""), textW, 19))}</text>` +
    `<g clip-path="url(#col)"><g class="${live ? "drift" : ""}"><path d="${wavePath(spec, textX, textX + textW, 118, live ? 5 : 1.5)}" fill="none" class="${live ? stroke("primary") : stroke("outline")}" stroke-width="3.5" stroke-linecap="round"/></g></g>` +
    `<g class="eq ${fill("primary")}" transform="translate(${W - 100} ${H / 2 - 11})" opacity="${live ? 1 : 0.35}">${eq}</g>` +
    `</g>`;

  return wrap(W, H, esc(`${copy.pill}: ${copy.title} - ${copy.sub}`), colorCss(palette, opts) + motionCss(opts, 120, 400), body);
}
