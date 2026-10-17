import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { ICON_DATA_URI, ICON_PATH, ICON_SVG } from "../src/icon.ts";
import { landingPage } from "../src/landing.ts";

describe("the icon", () => {
  it("is the same artwork in the README file and in the code", () => {
    const file = readFileSync("assets/icon.svg", "utf8");
    expect(file).toContain(`d="${ICON_PATH}"`);
  });

  it("keeps Font Awesome's attribution, as CC BY 4.0 requires", () => {
    const file = readFileSync("assets/icon.svg", "utf8");
    for (const svg of [file, ICON_SVG]) expect(svg).toMatch(/Font Awesome Free .* CC BY 4\.0/);
    expect(readFileSync("NOTICE", "utf8")).toContain("CC BY 4.0");
  });

  it("is the website's favicon and sits beside its name", () => {
    const html = landingPage();
    expect(html).toContain(`<link rel="icon" type="image/svg+xml" href="${ICON_DATA_URI}">`);
    expect(html).toContain(`<svg class="mark"`);
  });
});
