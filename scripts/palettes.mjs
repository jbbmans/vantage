import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CSS = join(dirname(fileURLToPath(import.meta.url)), '..', 'src', 'styles', 'index.css');

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

// Dress blues: navy ink on a warm paper, the frame in the coat's navy. Must match the base blocks in index.css.
const LIGHT = { canvas: [245, 244, 240], surface: [255, 255, 255], 'surface-2': [241, 240, 235], 'surface-3': [232, 231, 225], line: [224, 222, 214], 'line-strong': [200, 197, 187], ink: [11, 22, 44], 'ink-2': [50, 61, 84], 'ink-3': [86, 95, 112], rail: [12, 25, 48], 'rail-ink': [196, 205, 222], 'rail-active': [30, 48, 82], deep: [12, 25, 48], 'deep-2': [24, 42, 74] };
const DARK = { canvas: [10, 16, 28], surface: [16, 25, 42], 'surface-2': [22, 33, 54], 'surface-3': [31, 45, 70], line: [36, 50, 76], 'line-strong': [54, 72, 104], ink: [236, 239, 245], 'ink-2': [184, 194, 214], 'ink-3': [142, 154, 178], rail: [7, 13, 25], 'rail-ink': [178, 190, 212], 'rail-active': [30, 46, 76], deep: [7, 13, 25], 'deep-2': [20, 33, 56] };

const TINT = { surface: 0.014, canvas: 0.009, 'surface-2': 0.012, 'surface-3': 0.016, line: 0.016, 'line-strong': 0.02, ink: 0.042, 'ink-2': 0.034, 'ink-3': 0.03, rail: 0.06, 'rail-ink': 0.03, 'rail-active': 0.07, deep: 0.055, 'deep-2': 0.065 };

const PALETTES = {
  // The default: dress blue for action, gold for the marker and the rules, scarlet for the one global action.
  cobalt: { neutrals: null, light: { accent: [28, 78, 178], 'accent-ink': [255, 255, 255], 'accent-soft': [234, 239, 249], 'accent-2': [133, 96, 16], marker: [222, 178, 72], signal: [186, 12, 47], 'signal-ink': [255, 255, 255] }, dark: { accent: [140, 172, 255], 'accent-ink': [6, 12, 26], 'accent-soft': [28, 42, 74], 'accent-2': [226, 190, 110], marker: [230, 190, 90], signal: [190, 28, 56], 'signal-ink': [255, 255, 255] } },
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
  need(s['signal-ink'], s.signal, 4.5, 'text on the signal');
  return bad.map((b) => `${name}${dark ? ' dark' : ''}: ${b}`);
}

// The navy ground (the masthead, the top bar, the phone's tab bar) is the light theme's rail, and what sits on it takes
// the dark theme's tokens (.on-navy): its eyebrow is the dark marker, so that must read as text on either theme's rail.
function checkNavy(name, nl, nd, p) {
  const bad = [];
  for (const [ground, which] of [[nl.rail, 'light'], [nd.rail, 'dark']]) {
    const r = contrast(p.dark.marker, ground);
    if (r < 4.5) bad.push(`${name}: eyebrow on the ${which} navy ${r.toFixed(2)} < 4.5`);
    const t = contrast(nd['ink-3'], ground);
    if (t < 4.5) bad.push(`${name}: muted text on the ${which} navy ${t.toFixed(2)} < 4.5`);
  }
  return bad;
}

// Every palette has a signal: the one global action (Log activity). It is the accent unless the palette names one.
const withSignal = (s) => ({ ...s, signal: s.signal ?? s.accent, 'signal-ink': s['signal-ink'] ?? s['accent-ink'] });

const line = (vars) => Object.entries(vars).map(([k, v]) => `--${k}: ${v.join(' ')};`).join(' ');
const blocks = [];
const problems = [];
for (const [name, raw] of Object.entries(PALETTES)) {
  const p = { ...raw, light: withSignal(raw.light), dark: withSignal(raw.dark) };
  const nl = neutrals(LIGHT, p, false); const nd = neutrals(DARK, p, true);
  problems.push(...check(name, nl, p.light, false), ...check(name, nd, p.dark, true), ...checkNavy(name, nl, nd, p));
  const light = name === 'cobalt' ? p.light : { ...p.light, ...nl, 'shadow-rgb': nl.ink };
  const dark = name === 'cobalt' ? p.dark : { ...p.dark, ...nd, 'shadow-rgb': [0, 0, 0] };
  blocks.push(`  ${name === 'cobalt' ? ":root, [data-accent='cobalt']" : `[data-accent='${name}']`} { ${line(light)} }`);
  // What sits on the navy ground (.on-navy) takes the palette's dark tokens, in either theme.
  blocks.push(`  ${name === 'cobalt' ? "[data-theme='dark'][data-accent='cobalt'], [data-theme='dark']:not([data-accent]), .on-navy" : `[data-theme='dark'][data-accent='${name}'], [data-accent='${name}'] .on-navy`} { ${line(dark)} }`);
}
const css = `  /* palettes:begin (generated by scripts/palettes.mjs; edit that, not this) */\n${blocks.join('\n')}\n  /* palettes:end */`;

if (problems.length) { console.error(problems.join('\n')); process.exit(1); }
if (process.argv.includes('--write')) {
  const src = readFileSync(CSS, 'utf8');
  const re = / {2}\/\* palettes:begin[\s\S]*?palettes:end \*\//;
  if (!re.test(src)) throw new Error('no palettes block in index.css');
  writeFileSync(CSS, src.replace(re, css));
  console.log(`palettes: ${Object.keys(PALETTES).length} written, every contrast pair passes`);
} else console.log(css);

export const PALETTE_IDS = Object.keys(PALETTES);
