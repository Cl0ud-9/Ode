import type { CardData, CardOptions } from "../model.ts";
import type { Palette } from "../palette.ts";
import { blobPath, eqHeights, notePath, scallopPath, waveBand, wavePath, waveSpec } from "../shapes.ts";
import { esc, fit, textEm } from "../util.ts";
import { SANS, colorCss, copyFor, fill, motionCss, stroke, wrap } from "./common.ts";

const W = 800;
const H = 280;
const CX = 150;
const CY = 140;
const COL_X = 290;
const COL_W = 470;

/** Material 3 Expressive-style card: scalloped cover, tonal blobs, a track-seeded wave. */
export function renderExpressive(d: CardData, palette: Palette, opts: CardOptions): string {
  const copy = copyFor(d);
  const live = copy.live;
  const wl = 160;
  const spec = waveSpec(d.seed, wl);
  const bandSpec = waveSpec(d.seed + 7, 400);

  const pillText = copy.pill;
  const pillTextW = textEm(pillText) * 15 + pillText.length * 1.4;
  const pillW = Math.min(COL_W - 150, Math.round(20 + 44 + pillTextW + 22));
  const pillLabel = fit(pillText, pillW - 76, 15);

  const bars = eqHeights(d.seed, 4, 18);
  const eq = bars
    .map((h, i) => `<rect x="${i * 9}" y="${18 - h}" width="5" height="${h}" rx="2.5" style="animation-delay:-${(i * 0.31).toFixed(2)}s"${live ? "" : ' opacity=".55"'}/>`)
    .join("");

  const title = fit(copy.title, COL_W, 38);
  const sub = fit(copy.sub, COL_W, 24);
  const meta = fit(copy.meta, COL_W, 18);

  const art = d.artDataUri
    ? `<clipPath id="cv"><path d="${scallopPath(CX, CY, 100, 8, 0.045)}"/></clipPath>` +
      `<image href="${d.artDataUri}" x="${CX - 108}" y="${CY - 108}" width="216" height="216" preserveAspectRatio="xMidYMid slice" clip-path="url(#cv)"/>`
    : `<path class="${fill("primary")}" d="${scallopPath(CX, CY, 100, 8, 0.045)}"/>` +
      `<path class="${fill("onPrimary")}" d="${notePath(CX - 24, CY - 36, 1.05)}"/>`;

  const handle = d.user ? `@${esc(d.user)}` : "";
  const waveAmp = live ? 11 : 4;
  const waveClass = live ? "drift" : "";
  const waveStroke = live ? stroke("primary") : stroke("outline");

  const body =
    `<defs>` +
    `<clipPath id="card"><rect width="${W}" height="${H}" rx="44"/></clipPath>` +
    `<clipPath id="col"><rect x="${COL_X - 8}" y="200" width="${COL_W + 16}" height="70"/></clipPath>` +
    `</defs>` +
    `<g clip-path="url(#card)">` +
    `<rect width="${W}" height="${H}" class="${fill("container")}"/>` +
    `<path d="${blobPath(120, 170, 190, d.seed, 0.3)}" class="${fill("secondaryContainer")}" opacity=".55"/>` +
    `<path d="${blobPath(730, 10, 150, d.seed + 3, 0.35)}" class="${fill("primaryContainer")}" opacity=".7"/>` +
    `<g class="drift-slow"><path d="${waveBand(bandSpec, 0, W, 262, 9, H + 4)}" class="${fill("containerHigh")}"/></g>` +
    `<g class="spin" style="transform-origin:${CX}px ${CY}px"><path d="${scallopPath(CX, CY, 122, 9, 0.05)}" class="${fill("primaryContainer")}"/></g>` +
    `<g class="spin-rev" style="transform-origin:${CX}px ${CY}px"><path d="${scallopPath(CX, CY, 113, 7, 0.04, 1)}" class="${fill("primary")}" opacity=".35"/></g>` +
    art +
    `<g transform="translate(${COL_X} 38)">` +
    `<rect width="${pillW}" height="36" rx="18" class="${fill("primaryContainer")}"/>` +
    `<g class="eq ${fill("onPrimaryContainer")}" transform="translate(18 9)">${eq}</g>` +
    `<text x="64" y="24" font-family="${SANS}" font-size="15" font-weight="700" letter-spacing="1.4" class="${fill("onPrimaryContainer")}">${esc(pillLabel)}</text>` +
    `</g>` +
    (handle
      ? `<text x="${COL_X + COL_W}" y="62" text-anchor="end" font-family="${SANS}" font-size="17" class="${fill("onVariant")}">${handle}</text>`
      : "") +
    `<text x="${COL_X}" y="132" font-family="${SANS}" font-size="38" font-weight="800" class="${fill("onSurface")}">${esc(title)}</text>` +
    `<text x="${COL_X}" y="171" font-family="${SANS}" font-size="24" font-weight="600" class="${fill("primary")}">${esc(sub)}</text>` +
    (meta ? `<text x="${COL_X}" y="199" font-family="${SANS}" font-size="18" class="${fill("onVariant")}">${esc(meta)}</text>` : "") +
    `<g clip-path="url(#col)"><g class="${waveClass}"><path d="${wavePath(spec, COL_X, COL_X + COL_W, 232, waveAmp)}" fill="none" class="${waveStroke}" stroke-width="6" stroke-linecap="round"/></g></g>` +
    `</g>`;

  const css = colorCss(palette, opts) + motionCss(opts, wl, 400);
  return wrap(W, H, esc(`${copy.pill}: ${copy.title} - ${copy.sub}`), css, body);
}
