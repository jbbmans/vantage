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

/** The four parts on a 120-unit square, bottom to top. The mark's bounding box is centred on (60, 60). */
export const MARK_PATHS = {
  v: 'M7 34h28l25 43 25-43h28L60 118 7 34Z',
  peak: 'M60 2 90 32 74 48 60 34 46 48 30 32 60 2Z',
  facet: 'M60 33 82 58 60 90 38 58 60 33Z',
  sight: 'M60 43 72 58 60 78 48 58 60 43Z',
} as const;

export type MarkVariant = 'primary' | 'reversed' | 'monochrome';

/** Fills for each surface. Reversed is for navy and other dark grounds: the V knocks out to white and the facet takes the ground. */
export const MARK_FILLS: Record<MarkVariant, Record<keyof typeof MARK_PATHS, string>> = {
  primary: { v: BRAND.navy, peak: BRAND.teal, facet: BRAND.white, sight: BRAND.cobalt },
  reversed: { v: BRAND.white, peak: BRAND.teal, facet: BRAND.navy, sight: BRAND.cobalt },
  monochrome: { v: BRAND.navy, peak: BRAND.navy, facet: BRAND.white, sight: BRAND.navy },
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
