import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACCENTS, DEFAULT_ACCENT } from '../../shared/constants.ts';

// The colour tokens are the design system's (src/styles/index.css). A token is a bare "r g b" triple, and each accent
// repaints the canvas and the two surfaces under it, so a status colour has to read on every palette, not only on white.
const CSS = readFileSync(new URL('../../src/styles/index.css', import.meta.url), 'utf8');
type Rgb = [number, number, number];
type Palette = Record<string, Rgb>;

function tokens(body: string): Palette {
  return Object.fromEntries([...body.matchAll(/--([\w-]+):\s*(\d+) (\d+) (\d+)/g)].map((m) => [m[1], [+m[2], +m[3], +m[4]] as Rgb]));
}
// A rule may name more selectors after this one (the dark tokens also serve what stands on the navy frame, `.on-navy`).
function rule(selector: RegExp): Palette {
  const m = CSS.match(new RegExp(`^\\s*${selector.source}(?:\\s*,[^{]*)?\\s*\\{([^}]*)\\}`, 'm'));
  assert.ok(m, `index.css has a rule for ${selector.source}`);
  return tokens(m[1]);
}

const linear = (c: number) => { const s = c / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
const luminance = ([r, g, b]: Rgb) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
/** The WCAG contrast ratio of two opaque colours. */
const contrast = (a: Rgb, b: Rgb) => { const [x, y] = [luminance(a), luminance(b)]; return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05); };
/** A colour at an opacity over a background, as a tinted badge fill is painted. */
const over = (fg: Rgb, bg: Rgb, alpha: number) => fg.map((c, i) => Math.round(c * alpha + bg[i] * (1 - alpha))) as Rgb;

/** Every accent's canvas, surface and surface-2 in one theme, falling back to the theme's own where an accent keeps them. */
function grounds(theme: 'light' | 'dark') {
  const base = theme === 'light' ? rule(/:root, \[data-theme='light'\]/) : rule(/\[data-theme='dark'\]/);
  return ACCENTS.map(({ id }) => {
    const own = id === 'cobalt' ? {} : theme === 'light'
      ? rule(new RegExp(`\\[data-accent='${id}'\\]`))
      : rule(new RegExp(`\\[data-theme='dark'\\]\\[data-accent='${id}'\\]`));
    const palette = { ...base, ...own };
    return { id, palette, grounds: (['canvas', 'surface', 'surface-2'] as const).map((name) => ({ name, rgb: palette[name] })) };
  });
}

for (const theme of ['light', 'dark'] as const) {
  test(`warn reads at 4.5:1 as text and as a warn badge on every ${theme} palette`, () => {
    for (const { id, palette, grounds: under } of grounds(theme)) {
      const warn = palette.warn;
      assert.ok(warn, `${theme} ${id} has a warn colour`);
      for (const { name, rgb } of under) {
        assert.ok(rgb, `${theme} ${id} has ${name}`);
        const text = contrast(warn, rgb);
        // A Badge in the warn tone is bg-warn/10 text-warn, so its text sits on warn at a tenth over the ground.
        const badge = contrast(warn, over(warn, rgb, 0.1));
        assert.ok(text >= 4.5, `${theme} ${id}: warn on ${name} is ${text.toFixed(2)}:1`);
        assert.ok(badge >= 4.5, `${theme} ${id}: a warn badge on ${name} is ${badge.toFixed(2)}:1`);
      }
    }
  });
}

test('every page starts in the accent Settings shows as the default', () => {
  for (const page of ['index.html', 'console.html', 'admin.html']) {
    const html = readFileSync(new URL(`../../${page}`, import.meta.url), 'utf8');
    const accent = html.match(/<html\b[^>]*\bdata-accent="([\w-]+)"/)?.[1];
    assert.equal(accent, DEFAULT_ACCENT, `${page} draws its first frame in ${accent}, but an account that never chose is on ${DEFAULT_ACCENT}`);
  }
});
