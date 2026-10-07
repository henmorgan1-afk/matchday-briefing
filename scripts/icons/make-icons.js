// Rebuilds the app icons in frontend/icons/ from icon-master.svg and favicon.svg (SPEC.md Revision 12).
//
// Usage: node scripts/icons/make-icons.js
//
// Renders with Playwright's Chromium (a one-off `npx playwright install chromium`). The "?" in the
// master artwork is set in the self-hosted Source Serif 4 italic 600 from frontend/fonts/, embedded as
// a data URL. Every network request is blocked, so no other font can sneak in.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HERE = __dirname;
const OUT_DIR = path.join(HERE, '..', '..', 'frontend', 'icons');
const FONT_FILE = path.join(HERE, '..', '..', 'frontend', 'fonts', 'source-serif-4-latin-600-italic.woff2');
const FONT_CHECK = 'italic 600 36px "Source Serif 4"';

const master = fs.readFileSync(path.join(HERE, 'icon-master.svg'), 'utf8');
const favicon = fs.readFileSync(path.join(HERE, 'favicon.svg'), 'utf8');

// The maskable icon: the cream square still fills the image, and the art shrinks to 80% around the
// centre, so a round crop on Android cuts nothing off.
const ART_OPEN = '<g id="art">';
if (!master.includes(ART_OPEN)) throw new Error(`icon-master.svg has no ${ART_OPEN}`);
const maskable = master.replace(ART_OPEN, '<g id="art" transform="translate(10 10) scale(0.8)">');

const OUTPUTS = [
  { file: 'icon-192.png', svg: master, size: 192 },
  { file: 'icon-512.png', svg: master, size: 512 },
  { file: 'icon-maskable-512.png', svg: maskable, size: 512 },
  { file: 'apple-touch-icon.png', svg: master, size: 180 },
  { file: 'favicon-32.png', svg: favicon, size: 32 },
];

function pageHtml(svg, size) {
  const font = fs.readFileSync(FONT_FILE).toString('base64');
  const sized = svg.replace('<svg ', `<svg width="${size}" height="${size}" `);
  return `<!doctype html><html><head><meta charset="utf-8"><style>
@font-face {
  font-family: "Source Serif 4";
  font-style: italic;
  font-weight: 600;
  src: url("data:font/woff2;base64,${font}") format("woff2");
}
html, body { margin: 0; padding: 0; background: #F2EADB; }
svg { display: block; }
</style></head><body>${sized}</body></html>`;
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const browser = await chromium.launch({ headless: true });
  try {
    for (const { file, svg, size } of OUTPUTS) {
      const page = await browser.newPage({ viewport: { width: size, height: size }, deviceScaleFactor: 1 });
      await page.route('**/*', (route) => route.abort());
      await page.setContent(pageHtml(svg, size));
      const fontOk = await page.evaluate(async (spec) => {
        await document.fonts.load(spec, '?');
        await document.fonts.ready;
        return document.fonts.check(spec, '?');
      }, FONT_CHECK);
      if (!fontOk) throw new Error(`${file}: Source Serif 4 italic 600 did not load`);
      await page.screenshot({ path: path.join(OUT_DIR, file), omitBackground: false });
      await page.close();
      console.log(`  ${file} ${size}x${size}`);
    }
    fs.writeFileSync(path.join(OUT_DIR, 'favicon.svg'), favicon);
    console.log('  favicon.svg (copy of scripts/icons/favicon.svg)');
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(`make-icons: ${err.message}`);
  process.exit(1);
});
