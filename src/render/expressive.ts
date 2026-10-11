import type { CardData, CardOptions } from "../model.ts";
import type { Palette } from "../palette.ts";
import { blobPath, eqHeights, notePath, scallopPath, sineWavePath } from "../shapes.ts";
import { esc, fit, textEm, wrapLines } from "../util.ts";
import { SANS, colorCss, copyFor, fill, motionCss, stop, stroke, wrap } from "./common.ts";

const W = 800;
const H = 250;
const CX = 136;
const CY = 125;
const COL_X = 272;
const COL_W = 490;
/** Wavelength of the M3-style wavy line; the drift animation moves it by exactly one period. */
const WAVELENGTH = 44;

/** Material 3 Expressive-style card: cookie-shaped cover, tonal blobs and a wavy line that flattens when idle. */
export function renderExpressive(d: CardData, palette: Palette, opts: CardOptions): string {
  const copy = copyFor(d);
  const live = copy.live;

  const PILL_PX = 20;
  const pillText = copy.pill;
  const pillTextW = textEm(pillText, false, true) * PILL_PX + pillText.length * 1.6;
  // The animated bars only belong on a playing card; without them the pill is shorter and the name has room.
  const pillIcon = live ? 52 : 0;
  const pillW = Math.min(COL_W, Math.round(22 + pillIcon + pillTextW + 24));
  const pillLabel = fit(pillText, pillW - 46 - pillIcon, PILL_PX, false, true);

  const bars = eqHeights(d.seed, 4, 22);
  const eq = bars
    .map((h, i) => `<rect x="${i * 11}" y="${22 - h}" width="6" height="${h}" rx="3" style="animation-delay:-${(i * 0.31).toFixed(2)}s"${live ? "" : ' opacity=".55"'}/>`)
    .join("");

  // One line when it fits (shrinking a little first); otherwise two lines and a slightly tighter stack below.
  const TITLE_W = COL_W - 8;
  let titlePx = 40;
  while (titlePx > 34 && textEm(copy.title, false, true) * titlePx > TITLE_W) titlePx -= 1;
  const fitsOne = textEm(copy.title, false, true) * titlePx <= TITLE_W;
  const titleLines = fitsOne ? [copy.title] : wrapLines(copy.title, TITLE_W, titlePx, 2, true);
  const two = titleLines.length > 1;
  const hasMeta = copy.meta !== "";
  const lift = hasMeta ? 0 : 14; // with no album line, centre the stack between the pill and the wave
  const titleYs = (two ? [104, 140] : [132]).map((y) => y + lift);
  const subY = (two ? 173 : 170) + lift;
  const subPx = two ? 28 : 30;
  const metaY = two ? 202 : 200;
  const metaPx = two ? 22 : 24;
  const sub = fit(copy.sub, COL_W, subPx, false, true);
  const meta = fit(copy.meta, COL_W - 32, metaPx);

  const cookie = scallopPath(CX, CY, 92, 9, 0.045);
  const art = d.artDataUri
    ? `<clipPath id="cv"><path d="${cookie}"/></clipPath>` +
      `<image href="${d.artDataUri}" x="${CX - 100}" y="${CY - 100}" width="200" height="200" preserveAspectRatio="xMidYMid slice" clip-path="url(#cv)"/>`
    : `<path class="${fill("primaryContainer")}" d="${cookie}"/>` +
      `<path class="${fill("onPrimaryContainer")}" d="${notePath(CX - 22, CY - 34, 1)}"/>`;

  // The viewer's name, top right, when it fits beside the pill.
  // Prefer 24px; step down to 20px for a long name before giving up on showing it.
  const handleText = d.user ? `@${d.user}` : "";
  const handleRoom = COL_W - pillW - 20;
  const HANDLE_PX = [24, 22, 20].find((px) => textEm(handleText) * px <= handleRoom) ?? 0;
  const handle = handleText && HANDLE_PX ? esc(handleText) : "";
  const waveY = 228;
  const wave = sineWavePath(COL_X, COL_X + COL_W, waveY, live ? 7 : 0, WAVELENGTH);

  const body =
    `<defs>` +
    `<clipPath id="card"><rect width="${W}" height="${H}" rx="48"/></clipPath>` +
    `<linearGradient id="bg" x1="0" y1="0" x2="1" y2="1"><stop offset="0" class="${stop("bgA")}"/><stop offset="1" class="${stop("bgB")}"/></linearGradient>` +
    `<radialGradient id="glow"><stop offset="0" class="${stop("primary")}" stop-opacity=".5"/><stop offset=".6" class="${stop("primary")}" stop-opacity=".14"/><stop offset="1" class="${stop("primary")}" stop-opacity="0"/></radialGradient>` +
    `<linearGradient id="fade" gradientUnits="userSpaceOnUse" x1="${COL_X}" y1="0" x2="${COL_X + COL_W}" y2="0"><stop offset="0" stop-color="#fff" stop-opacity="0"/><stop offset=".09" stop-color="#fff"/><stop offset=".91" stop-color="#fff"/><stop offset="1" stop-color="#fff" stop-opacity="0"/></linearGradient>` +
    `<mask id="col" maskUnits="userSpaceOnUse" x="${COL_X}" y="${waveY - 24}" width="${COL_W}" height="48"><rect x="${COL_X}" y="${waveY - 24}" width="${COL_W}" height="48" fill="url(#fade)"/></mask>` +
    `</defs>` +
    `<g clip-path="url(#card)">` +
    `<rect width="${W}" height="${H}" fill="url(#bg)"/>` +
    `<circle cx="${CX}" cy="${CY}" r="230" fill="url(#glow)"/>` +
    `<path d="${blobPath(745, 10, 130, d.seed + 3, 0.35)}" class="${fill("tertiaryContainer")}" opacity=".55"/>` +
    `<path d="${blobPath(70, 245, 110, d.seed, 0.3)}" class="${fill("secondaryContainer")}" opacity=".5"/>` +
    `<g class="spin" style="transform-origin:${CX}px ${CY}px"><path d="${scallopPath(CX, CY, 113, 9, 0.05)}" class="${fill("primaryContainer")}"/></g>` +
    `<g class="spin-rev" style="transform-origin:${CX}px ${CY}px"><path d="${scallopPath(CX, CY, 104, 7, 0.04, 1)}" class="${fill("primary")}" opacity=".3"/></g>` +
    `<path d="${scallopPath(CX + 3, CY + 7, 92, 9, 0.045)}" fill="#000" opacity=".28"/>` +
    art +
    `<path d="${cookie}" fill="none" class="${stroke("onSurface")}" stroke-width="2.5" opacity=".22"/>` +
    `<g transform="translate(${COL_X} 26)">` +
    `<rect width="${pillW}" height="44" rx="22" class="${fill("primaryContainer")}"/>` +
    (live ? `<g class="eq ${fill("onPrimaryContainer")}" transform="translate(22 11)">${eq}</g>` : "") +
    `<text x="${22 + pillIcon}" y="29" font-family="${SANS}" font-size="${PILL_PX}" font-weight="700" letter-spacing="1.6" class="${fill("onPrimaryContainer")}">${esc(pillLabel)}</text>` +
    `</g>` +
    (handle
      ? `<text x="${COL_X + COL_W}" y="56" text-anchor="end" font-family="${SANS}" font-size="${HANDLE_PX}" font-weight="500" class="${fill("onVariant")}">${handle}</text>`
      : "") +
    titleLines
      .map((l, i) => `<text x="${COL_X}" y="${titleYs[i]}" font-family="${SANS}" font-size="${titlePx}" font-weight="800" class="${fill("onSurface")}">${esc(l)}</text>`)
      .join("") +
    `<text x="${COL_X}" y="${subY}" font-family="${SANS}" font-size="${subPx}" font-weight="700" class="${fill("primary")}">${esc(sub)}</text>` +
    (meta
      ? `<circle cx="${COL_X + 10}" cy="${metaY - 8}" r="10" fill="none" class="${stroke("onVariant")}" stroke-width="2.5"/><circle cx="${COL_X + 10}" cy="${metaY - 8}" r="2.8" class="${fill("onVariant")}"/>` +
        `<text x="${COL_X + 30}" y="${metaY}" font-family="${SANS}" font-size="${metaPx}" class="${fill("onVariant")}">${esc(meta)}</text>`
      : "") +
    `<g${live ? ' mask="url(#col)"' : ""}>` +
    `<g class="${live ? "drift" : ""}"><path d="${wave}" fill="none" class="${live ? stroke("primary") : stroke("outline")}" stroke-width="7" stroke-linecap="round"/></g></g>` +
    `</g>`;

  const css = colorCss(palette, opts) + motionCss(opts, WAVELENGTH, 400);
  return wrap(W, H, esc(`${copy.pill}: ${copy.title} - ${copy.sub}`), css, body);
}
