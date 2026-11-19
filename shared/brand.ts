/**
 * The Vantage mark, defined once. The in-app logo (src/components/Logo.tsx) draws these paths, and
 * scripts/icons.mjs writes every SVG, favicon, app icon and the social card from them, so the tab icon
 * cannot drift from the logo on the page again. Change the mark here, then run `npm run icons`.
 */

export const BRAND = {
  navy: '#0B2D5B',
  cobalt: '#2563EB',
  teal: '#14B8A6',
  white: '#FFFFFF',
} as const;

/** Two broad strokes separated by a diagonal cut that stays visible at favicon size. */
export const MARK_PATHS = {
  v: 'M4 14H32L73 85L60 108Z',
  rise: 'M65 56L89 14H117L79 81Z',
} as const;

export type MarkVariant = 'primary' | 'reversed' | 'monochrome';

/** Fills for light, dark and single-ink surfaces. The gap always shows the ground. */
export const MARK_FILLS: Record<MarkVariant, Record<keyof typeof MARK_PATHS, string>> = {
  primary: { v: BRAND.navy, rise: BRAND.teal },
  reversed: { v: BRAND.white, rise: BRAND.teal },
  monochrome: { v: BRAND.navy, rise: BRAND.navy },
};

const paths = (variant: MarkVariant, indent = '  ') =>
  (Object.keys(MARK_PATHS) as Array<keyof typeof MARK_PATHS>)
    .map((part) => `${indent}<path fill="${MARK_FILLS[variant][part]}" d="${MARK_PATHS[part]}"/>`)
    .join('\n');

/** The bare mark as a standalone SVG document. */
export function markSvg(variant: MarkVariant, title = 'Vantage'): string {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="${title}">\n${paths(variant)}\n</svg>\n`;
}

/**
 * The reversed mark on a navy tile: the favicon and app icon. `scale` sets how much of the tile the mark
 * fills; `radius` 0 gives a full-bleed square for platforms that apply their own mask (iOS, maskable icons).
 */
export function tileSvg({ scale = 0.76, radius = 26 }: { scale?: number; radius?: number } = {}): string {
  return [
    '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 120" role="img" aria-label="Vantage">',
    `  <rect width="120" height="120"${radius ? ` rx="${radius}"` : ''} fill="${BRAND.navy}"/>`,
    `  <g transform="translate(60 60) scale(${scale}) translate(-60 -60)">`,
    paths('reversed', '    '),
    '  </g>',
    '</svg>',
    '',
  ].join('\n');
}
