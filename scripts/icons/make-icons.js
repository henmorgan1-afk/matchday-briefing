// Rebuilds the app icons in frontend/icons/ from icon-master.svg and favicon.svg (SPEC.md Revision 12,
// artwork replaced in the amber terminal Revision 16).
//
// Usage: node scripts/icons/make-icons.js
//
// Renders with Playwright's Chromium (a one-off `npx playwright install chromium`). The "?" in the
// master artwork is set in the self-hosted VT323 from frontend/fonts/, embedded as a data URL. Every
// network request is blocked, so no other font can sneak in.

const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const HERE = __dirname;
const OUT_DIR = path.join(HERE, '..', '..', 'frontend', 'icons');
const FONT_FILE = path.join(HERE, '..', '..', 'frontend', 'fonts', 'vt323-latin-400-normal.woff2');
const FONT_CHECK = '400 40px "VT323"';

const master = fs.readFileSync(path.join(HERE, 'icon-master.svg'), 'utf8');
const favicon = fs.readFileSync(path.join(HERE, 'favicon.svg'), 'utf8');

// The maskable icon: the dark square still fills the image, and the art shrinks to 80% around the
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
  font-family: "VT323";
  font-style: normal;
  font-weight: 400;
  src: url("data:font/woff2;base64,${font}") format("woff2");
}
html, body { margin: 0; padding: 0; background: #0B0806; }
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
      // check() alone can pass for a face that failed to load, so the face's own status must be "loaded".
      const fontOk = await page.evaluate(async (spec) => {
        await document.fonts.load(spec, '?').catch(() => {});
        await document.fonts.ready;
        const face = [...document.fonts].find((f) => f.family.replace(/"/g, '') === 'VT323');
        return Boolean(face && face.status === 'loaded' && document.fonts.check(spec, '?'));
      }, FONT_CHECK);
      if (!fontOk) throw new Error(`${file}: VT323 did not load`);
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
