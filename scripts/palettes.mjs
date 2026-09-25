/**
 * The colour palettes, generated and checked.
 *
 *   node scripts/palettes.mjs            print the CSS and the contrast report
 *   node scripts/palettes.mjs --write    rewrite the palettes block in src/styles/index.css
 *
 * A palette is everything the colour setting changes: a signal colour family (--accent, its ink, its
 * soft fill, --accent-2), the rail's active marker and glows (--marker), and a family of neutrals in
 * its hue (page, cards, fills, lines, text, rail, deep panels, shadow tint).
 *
 * The neutrals are not picked by eye. Each keeps Cobalt's lightness role for role, carried to the
 * palette's hue in OKLCH with a little chroma, so a palette changes the colour of every surface
 * without changing how any of them reads. Every contrast pair a component relies on is checked, in
 * light and dark, and the script refuses to write a palette that fails one.
 */

import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'index.css');

/* ── colour maths ────────────────────────────────────────────────────────────────────────────── */

const toLin = (c) => { c /= 255; return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4; };
const fromLin = (c) => { const v = c <= 0.0031308 ? 12.92 * c : 1.055 * c ** (1 / 2.4) - 0.055; return Math.round(Math.min(1, Math.max(0, v)) * 255); };
function oklch([r, g, b]) {
  const [R, G, B] = [r, g, b].map(toLin);
  const l = Math.cbrt(0.4122214708 * R + 0.5363325363 * G + 0.0514459929 * B);
  const m = Math.cbrt(0.2119034982 * R + 0.6806995451 * G + 0.1073969566 * B);
  const s = Math.cbrt(0.0883024619 * R + 0.2817188376 * G + 0.6299787005 * B);
  const L = 0.2104542553 * l + 0.793617785 * m - 0.0040720468 * s;
  const a = 1.9779984951 * l - 2.428592205 * m + 0.4505937099 * s;
  const bb = 0.0259040371 * l + 0.7827717662 * m - 0.808675766 * s;
  return [L, Math.hypot(a, bb)];
}
function rgb(L, C, h) {
  for (let c = C; c >= 0; c -= 0.002) { // the most colour that stays in gamut
    const a = c * Math.cos((h * Math.PI) / 180); const b = c * Math.sin((h * Math.PI) / 180);
    const l = (L + 0.3963377774 * a + 0.2158037573 * b) ** 3; const m = (L - 0.1055613458 * a - 0.0638541728 * b) ** 3; const s = (L - 0.0894841775 * a - 1.291485548 * b) ** 3;
    const R = 4.0767416621 * l - 3.3077115913 * m + 0.2309699292 * s; const G = -1.2684380046 * l + 2.6097574011 * m - 0.3413193965 * s; const B = -0.0041960863 * l - 0.7034186147 * m + 1.707614701 * s;
    if ([R, G, B].every((x) => x >= -0.0005 && x <= 1.0005)) return [R, G, B].map(fromLin);
  }
  return [0, 0, 0];
}
const lum = ([r, g, b]) => 0.2126 * toLin(r) + 0.7152 * toLin(g) + 0.0722 * toLin(b);
const contrast = (x, y) => { const [a, b] = [lum(x), lum(y)].sort((p, q) => q - p); return (a + 0.05) / (b + 0.05); };

/* ── Cobalt's neutrals: the roles every palette keeps ─────────────────────────────────────────── */

const LIGHT = { canvas: [246, 247, 249], surface: [255, 255, 255], 'surface-2': [243, 245, 248], 'surface-3': [233, 237, 243], line: [227, 232, 239], 'line-strong': [206, 214, 225], ink: [10, 27, 51], 'ink-2': [58, 76, 101], 'ink-3': [92, 108, 130], rail: [8, 22, 42], 'rail-ink': [190, 205, 226], 'rail-active': [18, 40, 70], deep: [10, 27, 51], 'deep-2': [18, 41, 74] };
const DARK = { canvas: [11, 19, 32], surface: [17, 28, 46], 'surface-2': [23, 37, 59], 'surface-3': [32, 49, 76], line: [37, 55, 82], 'line-strong': [53, 74, 105], ink: [234, 240, 248], 'ink-2': [180, 196, 218], 'ink-3': [140, 158, 184], rail: [9, 17, 30], 'rail-ink': [176, 192, 216], 'rail-active': [36, 58, 92], deep: [9, 17, 30], 'deep-2': [21, 36, 60] };

/** How much of its hue each role carries, at most enough to read as the palette, never enough to tire. */
const TINT = { surface: 0.014, canvas: 0.009, 'surface-2': 0.012, 'surface-3': 0.016, line: 0.016, 'line-strong': 0.02, ink: 0.042, 'ink-2': 0.034, 'ink-3': 0.03, rail: 0.06, 'rail-ink': 0.03, 'rail-active': 0.07, deep: 0.055, 'deep-2': 0.065 };

/* ── the palettes ─────────────────────────────────────────────────────────────────────────────── */

// hue: the neutrals' hue; tint: how strongly they take it (0 = grey); light/dark: the signal family.
// marker: the rail's active marker and its glow, bright enough to read on the rail.
const PALETTES = {
  cobalt: { neutrals: null, light: { accent: [37, 99, 235], 'accent-ink': [255, 255, 255], 'accent-soft': [236, 242, 254], 'accent-2': [15, 118, 110], marker: [20, 184, 166] }, dark: { accent: [122, 162, 255], 'accent-ink': [6, 13, 24], 'accent-soft': [26, 45, 78], 'accent-2': [79, 209, 192], marker: [45, 212, 191] } },
  ocean: { hue: 222, tint: 1.25, light: { accent: [3, 105, 161], 'accent-ink': [255, 255, 255], 'accent-soft': [228, 243, 250], 'accent-2': [15, 118, 110], marker: [34, 211, 238] }, dark: { accent: [125, 200, 240], 'accent-ink': [3, 22, 30], 'accent-soft': [12, 52, 66], 'accent-2': [79, 209, 192], marker: [103, 232, 249] } },
  teal: { hue: 188, tint: 1.1, light: { accent: [15, 118, 110], 'accent-ink': [255, 255, 255], 'accent-soft': [228, 246, 243], 'accent-2': [30, 90, 200], marker: [45, 212, 191] }, dark: { accent: [94, 234, 212], 'accent-ink': [4, 30, 27], 'accent-soft': [12, 56, 52], 'accent-2': [147, 197, 253], marker: [94, 234, 212] } },
  forest: { hue: 155, tint: 1.05, light: { accent: [21, 122, 58], 'accent-ink': [255, 255, 255], 'accent-soft': [231, 245, 236], 'accent-2': [15, 108, 110], marker: [52, 211, 153] }, dark: { accent: [110, 231, 183], 'accent-ink': [4, 32, 20], 'accent-soft': [16, 56, 38], 'accent-2': [94, 234, 212], marker: [52, 211, 153] } },
  olive: { hue: 128, tint: 0.85, light: { accent: [56, 94, 56], 'accent-ink': [255, 255, 255], 'accent-soft': [233, 243, 233], 'accent-2': [146, 91, 4], marker: [163, 205, 112] }, dark: { accent: [141, 200, 141], 'accent-ink': [10, 32, 10], 'accent-soft': [28, 54, 30], 'accent-2': [225, 182, 110], marker: [163, 211, 120] } },
  coyote: { hue: 62, tint: 0.8, light: { accent: [133, 88, 40], 'accent-ink': [255, 255, 255], 'accent-soft': [247, 239, 229], 'accent-2': [15, 108, 100], marker: [214, 178, 128] }, dark: { accent: [226, 190, 142], 'accent-ink': [40, 24, 8], 'accent-soft': [60, 44, 26], 'accent-2': [125, 211, 196], marker: [214, 178, 128] } },
  desert: { hue: 82, tint: 0.85, light: { accent: [128, 92, 10], 'accent-ink': [255, 255, 255], 'accent-soft': [249, 242, 222], 'accent-2': [29, 78, 216], marker: [232, 200, 125] }, dark: { accent: [234, 205, 138], 'accent-ink': [42, 30, 4], 'accent-soft': [62, 50, 22], 'accent-2': [147, 197, 253], marker: [240, 210, 140] } },
  ember: { hue: 55, tint: 0.95, light: { accent: [175, 72, 12], 'accent-ink': [255, 255, 255], 'accent-soft': [253, 238, 228], 'accent-2': [146, 91, 4], marker: [251, 160, 60] }, dark: { accent: [255, 162, 106], 'accent-ink': [44, 16, 2], 'accent-soft': [66, 34, 18], 'accent-2': [225, 182, 110], marker: [251, 170, 80] } },
  scarlet: { hue: 22, tint: 1.05, light: { accent: [182, 26, 26], 'accent-ink': [255, 255, 255], 'accent-soft': [253, 235, 234], 'accent-2': [146, 91, 4], marker: [245, 196, 60] }, dark: { accent: [255, 138, 138], 'accent-ink': [46, 8, 8], 'accent-soft': [62, 27, 27], 'accent-2': [225, 182, 110], marker: [250, 204, 72] } },
  rose: { hue: 355, tint: 1.0, light: { accent: [190, 24, 93], 'accent-ink': [255, 255, 255], 'accent-soft': [253, 234, 243], 'accent-2': [109, 40, 217], marker: [251, 113, 133] }, dark: { accent: [249, 168, 212], 'accent-ink': [48, 6, 26], 'accent-soft': [70, 22, 44], 'accent-2': [196, 181, 253], marker: [251, 113, 133] } },
  violet: { hue: 295, tint: 1.1, light: { accent: [109, 40, 217], 'accent-ink': [255, 255, 255], 'accent-soft': [241, 236, 254], 'accent-2': [15, 118, 110], marker: [167, 139, 250] }, dark: { accent: [196, 181, 253], 'accent-ink': [26, 10, 56], 'accent-soft': [44, 32, 82], 'accent-2': [94, 234, 212], marker: [167, 139, 250] } },
  steel: { hue: 250, tint: 0.3, light: { accent: [60, 78, 102], 'accent-ink': [255, 255, 255], 'accent-soft': [236, 240, 246], 'accent-2': [90, 103, 125], marker: [148, 163, 184] }, dark: { accent: [165, 187, 214], 'accent-ink': [14, 26, 42], 'accent-soft': [36, 52, 72], 'accent-2': [143, 160, 182], marker: [180, 195, 215] } },
};

function neutrals(base, p, dark) {
  if (!p.hue && p.hue !== 0) return { ...base };
  const out = {};
  for (const [role, value] of Object.entries(base)) {
    if (role === 'surface' && !dark) { out[role] = value; continue; } // cards stay white in light
    const [L] = oklch(value);
    out[role] = rgb(L, TINT[role] * p.tint * (dark ? 1.35 : 1), p.hue);
  }
  return out;
}

function check(name, n, s, dark) {
  const bad = [];
  const need = (x, y, min, what) => { const r = contrast(x, y); if (r < min) bad.push(`${what} ${r.toFixed(2)} < ${min}`); };
  need(n.ink, n.surface, dark ? 12 : 14, 'ink on cards');
  need(n['ink-2'], n.surface, 7, 'secondary text on cards');
  for (const f of ['canvas', 'surface-2', 'surface-3']) need(n['ink-3'], n[f], f === 'surface-3' ? 4.0 : 4.5, `muted text on ${f}`);
  need(n['rail-ink'], n.rail, 7, 'rail text');
  need(s.accent, n.surface, 4.5, 'accent text on cards');
  need(s['accent-ink'], s.accent, 4.5, 'text on the accent');
  need(s.accent, s['accent-soft'], 4.3, 'accent text on its soft fill');
  need(s['accent-2'], n.surface, 4.5, 'accent-2 text on cards');
  need(s.marker, n.rail, 3, 'marker on the rail');
  return bad.map((b) => `${name}${dark ? ' dark' : ''}: ${b}`);
}

const line = (vars) => Object.entries(vars).map(([k, v]) => `--${k}: ${v.join(' ')};`).join(' ');
const blocks = [];
const problems = [];
for (const [name, p] of Object.entries(PALETTES)) {
  const nl = neutrals(LIGHT, p, false); const nd = neutrals(DARK, p, true);
  problems.push(...check(name, nl, p.light, false), ...check(name, nd, p.dark, true));
  const light = name === 'cobalt' ? p.light : { ...p.light, ...nl, 'shadow-rgb': nl.ink };
  const dark = name === 'cobalt' ? p.dark : { ...p.dark, ...nd, 'shadow-rgb': [0, 0, 0] };
  blocks.push(`  ${name === 'cobalt' ? ":root, [data-accent='cobalt']" : `[data-accent='${name}']`} { ${line(light)} }`);
  blocks.push(`  ${name === 'cobalt' ? "[data-theme='dark'][data-accent='cobalt'], [data-theme='dark']:not([data-accent])" : `[data-theme='dark'][data-accent='${name}']`} { ${line(dark)} }`);
}
const css = `  /* palettes:begin — generated by scripts/palettes.mjs; edit that, not this */\n${blocks.join('\n')}\n  /* palettes:end */`;

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
if (process.argv.includes('--write')) {
  const src = readFileSync(CSS, 'utf8');
  const re = / {2}\/\* palettes:begin[\s\S]*?palettes:end \*\//;
  if (!re.test(src)) throw new Error('no palettes block in index.css');
  writeFileSync(CSS, src.replace(re, css));
  console.log(`palettes: ${Object.keys(PALETTES).length} written, every contrast pair passes`);
} else console.log(css);

export const PALETTE_IDS = Object.keys(PALETTES);
