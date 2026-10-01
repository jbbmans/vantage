// Writes every brand asset from the one definition in shared/brand.ts: the mark SVGs, the favicon set,
// the app icons and the social card. Rendered by the Chromium Playwright already uses, so there is no
// second toolchain. Run after changing the mark: `npm run icons`.
import { chromium } from '@playwright/test';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { BRAND, markSvg, tileSvg } from '../shared/brand.ts';

const out = (name) => new URL(`../public/${name}`, import.meta.url);
const executablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE || (existsSync('/opt/pw-browsers/chromium') ? '/opt/pw-browsers/chromium' : undefined);

const svgs = {
  'mark.svg': markSvg('primary'),
  'brand/mark-reversed.svg': markSvg('reversed'),
  'brand/mark-monochrome.svg': markSvg('monochrome'),
  // The browser tab: the reversed mark on a navy tile, as it sits in the site's navy header.
  'favicon.svg': tileSvg(),
};
for (const [name, svg] of Object.entries(svgs)) writeFileSync(out(name), svg);

const font = readFileSync(new URL('../public/fonts/geist-normal.woff2', import.meta.url)).toString('base64');
const browser = await chromium.launch({ executablePath });

async function png(html, width, height) {
  const page = await browser.newPage({ viewport: { width, height } });
  await page.setContent(`<!doctype html><html><head><style>@font-face{font-family:Geist;src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:100 900}html,body{margin:0;background:transparent}svg{display:block}</style></head><body>${html}</body></html>`);
  await page.evaluate(() => document.fonts.ready);
  const buffer = await page.screenshot({ omitBackground: true, clip: { x: 0, y: 0, width, height } });
  await page.close();
  return buffer;
}
const sized = (svg, px) => svg.replace('<svg ', `<svg width="${px}" height="${px}" `);

/** An .ico holding PNG frames, which every browser since IE 11 reads. */
function ico(frames) {
  const header = Buffer.alloc(6 + frames.length * 16);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(frames.length, 4);
  let offset = header.length;
  frames.forEach(({ size, data }, i) => {
    const at = 6 + i * 16;
    header.writeUInt8(size >= 256 ? 0 : size, at); header.writeUInt8(size >= 256 ? 0 : size, at + 1);
    header.writeUInt16LE(1, at + 4); header.writeUInt16LE(32, at + 6);
    header.writeUInt32LE(data.length, at + 8); header.writeUInt32LE(offset, at + 12);
    offset += data.length;
  });
  return Buffer.concat([header, ...frames.map((f) => f.data)]);
}

const tile = tileSvg();
// iOS and maskable icons are cropped by the platform, so they fill the square with no corners of their own.
const bleed = tileSvg({ radius: 0, scale: 0.7 });
const maskable = tileSvg({ radius: 0, scale: 0.6 });

const frames = [];
for (const size of [16, 32, 48]) frames.push({ size, data: await png(sized(tile, size), size, size) });
writeFileSync(out('favicon.ico'), ico(frames));
writeFileSync(out('icon-192.png'), await png(sized(tile, 192), 192, 192));
writeFileSync(out('icon-512.png'), await png(sized(tile, 512), 512, 512));
writeFileSync(out('apple-touch-icon.png'), await png(sized(bleed, 180), 180, 180));
writeFileSync(out('icon-maskable-512.png'), await png(sized(maskable, 512), 512, 512));
// Sits on the navy band of every email, three times its 36px display size.
writeFileSync(out('brand/email-mark.png'), await png(sized(svgs['brand/mark-reversed.svg'], 108), 108, 108));

// The social card: what a shared link shows in Messages, Teams, Slack, LinkedIn and search.
const card = `<div style="width:1200px;height:630px;box-sizing:border-box;position:relative;overflow:hidden;background:${BRAND.navy};color:#fff;font-family:Geist,system-ui,sans-serif;display:flex;align-items:center;padding:0 96px">
  <div style="display:flex;align-items:center;gap:60px">
    ${sized(svgs['brand/mark-reversed.svg'], 232)}
    <div>
      <div style="font-size:120px;font-weight:700;letter-spacing:0.06em;line-height:1">VANTAGE</div>
      <div style="margin-top:22px;font-size:34px;font-weight:500;color:#DDE9F6">Performance <span style="color:${BRAND.teal}">·</span> Productivity <span style="color:${BRAND.teal}">·</span> Readiness</div>
      <div style="margin-top:30px;font-size:26px;color:#A9C0D8;max-width:640px;line-height:1.35">Work, records and readiness for Marine Corps teams, every figure traced to its source.</div>
    </div>
  </div>
  <div style="position:absolute;left:96px;bottom:44px;font-size:22px;letter-spacing:0.08em;color:#8FA9C4">vantageusmc.com</div>
  <div style="position:absolute;left:0;right:0;bottom:0;height:12px;display:flex"><div style="flex:62;background:${BRAND.teal}"></div><div style="flex:38;background:${BRAND.cobalt}"></div></div>
</div>`;
writeFileSync(out('og.png'), await png(card, 1200, 630));

await browser.close();
console.log('Wrote the mark SVGs, favicon.svg, favicon.ico (16/32/48), app icons, email mark and og.png from shared/brand.ts.');
