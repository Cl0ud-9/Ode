const { Resvg } = require("C:/Users/tonpe/AppData/Local/Temp/ode-work/node_modules/@resvg/resvg-js");
const fs = require("fs");
for (const f of fs.readdirSync(__dirname).filter(f => /^v-.\.svg$/.test(f))) {
  const png = new Resvg(fs.readFileSync(f, "utf8"), { fitTo: { mode: "width", value: 1200 }, font: { loadSystemFonts: true } }).render().asPng();
  fs.writeFileSync(f.replace(".svg", ".png"), png);
}
console.log("rendered");
