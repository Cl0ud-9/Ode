import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("the icon", () => {
  const icon = readFileSync("site/icon.svg", "utf8");

  it("keeps Font Awesome's attribution, as CC BY 4.0 requires", () => {
    expect(icon).toMatch(/Font Awesome Free .* CC BY 4\.0/);
    expect(readFileSync("NOTICE", "utf8")).toContain("CC BY 4.0");
  });

  it("is the website's favicon and the same artwork as its logo", () => {
    const html = readFileSync("site/index.html", "utf8");
    expect(html).toContain('<link rel="icon" type="image/svg+xml" href="/icon.svg">');
    const path = icon.match(/<path d="([^"]+)"/)![1]!;
    expect(html).toContain(`<path d="${path}"/>`);
  });
});
