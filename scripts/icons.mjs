import { chromium } from '@playwright/test';
import { readFileSync } from 'node:fs';
const svg = readFileSync('public/mark.svg', 'utf8');
const font = readFileSync('public/fonts/geist-normal.woff2').toString('base64');
const fontFace = `@font-face{font-family:'Geist';src:url(data:font/woff2;base64,${font}) format('woff2');font-weight:300 800}`;
const browser = await chromium.launch({ executablePath: '/opt/pw-browsers/chromium' });
async function shot(html, w, h, out, scale = 1) {
  const page = await browser.newPage({ viewport: { width: w, height: h }, deviceScaleFactor: scale });
  await page.setContent(`<!doctype html><html><head><style>${fontFace}html,body{margin:0;background:transparent}</style></head><body>${html}</body></html>`);
  await page.screenshot({ path: out, omitBackground: true, clip: { x: 0, y: 0, width: w, height: h } });
  await page.close();
}
const mark = (size, pad = 0) => `<div style="width:${size}px;height:${size}px;display:flex;align-items:center;justify-content:center"><div style="width:${size - pad * 2}px;height:${size - pad * 2}px">${svg.replace('<svg ', `<svg width="${size - pad * 2}" height="${size - pad * 2}" `)}</div></div>`;
await shot(mark(512), 512, 512, 'public/icon-512.png');
await shot(mark(192), 192, 192, 'public/icon-192.png');
await shot(mark(180), 180, 180, 'public/apple-touch-icon.png');
await shot(`<div style="width:512px;height:512px;background:#0B2D5B;display:flex;align-items:center;justify-content:center">${mark(512, 72)}</div>`, 512, 512, 'public/icon-maskable-512.png');
// preview sheet for review: large, small sizes, on light and dark
const sheet = `<div style="display:flex;gap:40px;align-items:flex-end;padding:40px;background:#F5F8FC;font-family:Geist,system-ui,sans-serif">${mark(256)}${mark(96)}${mark(48)}${mark(32)}${mark(16)}<div style="background:#0B2D5B;padding:24px;display:flex;gap:24px;align-items:flex-end;border-radius:8px">${mark(96)}${mark(32)}</div></div>`;
if (process.argv[2]) await shot(sheet, 1000, 340, process.argv[2]);
// social card: flat brand colors, no gradients
const og = `<div style="width:1200px;height:630px;background:#0B2D5B;display:flex;align-items:center;padding:0 96px;box-sizing:border-box;font-family:Geist,system-ui,sans-serif;color:#fff;position:relative;overflow:hidden"><div style="position:absolute;right:0;top:0;width:26px;height:100%;background:#14B8A6"></div><div style="position:absolute;right:26px;top:0;width:12px;height:100%;background:#2563EB"></div><div style="display:flex;align-items:center;gap:56px">${mark(220)}<div><div style="font-size:112px;font-weight:700;letter-spacing:0.08em;line-height:1">VANTAGE</div><div style="margin-top:18px;font-size:31px;color:#DDE9F6;letter-spacing:0.02em">Performance · Productivity · Readiness</div><div style="margin-top:40px;font-size:22px;color:#9DB6CF;letter-spacing:0.12em;text-transform:uppercase">Higher insight. Greater impact.</div></div></div></div>`;
await shot(og, 1200, 630, 'public/og.png');
await browser.close();
console.log('icons written');
