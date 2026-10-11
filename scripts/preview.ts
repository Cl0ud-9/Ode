// Renders every demo card to preview/*.svg and *.png (via resvg) for eyeballing.
import { mkdirSync, writeFileSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
import { renderCard } from "../src/card.ts";
import { DEMOS, demoCard } from "../src/demo.ts";
import { THEMES } from "../src/model.ts";

const out = "preview";
mkdirSync(out, { recursive: true });
const now = Math.floor(Date.now() / 1000);
const only = process.argv[2];

for (const theme of THEMES) {
  for (const mode of ["dark", "light"] as const) {
    for (const demo of DEMOS) {
      if (only && !`${theme}-${mode}-${demo}`.includes(only)) continue;
      const { data, seed } = demoCard(demo, now);
      const svg = renderCard(data, seed, { theme, mode, still: false });
      const name = `${out}/${theme}-${mode}-${demo}`;
      writeFileSync(`${name}.svg`, svg);
      const png = new Resvg(svg, { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true } }).render().asPng();
      writeFileSync(`${name}.png`, png);
    }
  }
}
console.log("done");
