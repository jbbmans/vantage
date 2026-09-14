# Vantage Brand System — 2026

## Brand direction

Vantage should feel like a modern enterprise operating system: disciplined, clear, reliable, and forward-looking. The product may be used in a military environment, but the interface should not look like a recruiting poster or a tactical game. Inside the application, information architecture and decision support come before decoration.

**Brand line:** Performance · Productivity · Readiness  
**Primary message:** Higher insight. Greater impact.  
**Supporting message:** Turn possibility into progress.

## Logo

The primary mark is the flat geometric Vantage `V` in `public/mark.svg`.

- Deep Navy forms the structural V.
- Summit Teal forms the upper forward chevron.
- Cobalt Blue forms the central focal point.
- White negative space separates the three parts.
- The mark must remain flat color. Do not apply gradients, bevels, chrome, glow, or 3D effects.
- Use `public/brand/mark-reversed.svg` on Deep Navy and other dark surfaces.
- Use `public/brand/mark-monochrome.svg` when only one ink color is available.

## Core palette

| Token | Hex | Role |
| --- | --- | --- |
| Deep Navy | `#0B2D5B` | primary brand, navigation, trust, authority |
| Cobalt Blue | `#2563EB` | primary action, selected state, data emphasis |
| Summit Teal | `#14B8A6` | secondary brand accent, progress, positive momentum |
| Glacier | `#EAF0F6` | quiet background and supporting surface |
| Canvas | `#F5F8FC` | application background |
| White | `#FFFFFF` | primary surface |

Semantic success, warning, and error colors remain separate from the brand colors so status is never confused with decoration.

## Typography

The application continues to use Geist for interface text and JetBrains Mono only where tabular or technical data benefits from fixed-width alignment.

- Page titles: sentence case, bold, compact tracking.
- Section labels: short, small uppercase eyebrow treatment.
- UI labels: sentence case; avoid shouting in all caps.
- Numeric metrics: tabular figures.

## Product UI principles

1. **Corporate, not decorative.** White surfaces, thin borders, compact radii, restrained shadows.
2. **Navy navigation.** The navigation rail is Deep Navy, with Cobalt Blue for the active destination and Teal used sparingly as a directional accent.
3. **One primary action.** Cobalt is the strongest action color on a page. Secondary controls remain neutral.
4. **Flat color.** Do not introduce gradients into the logo or core product chrome.
5. **Data first.** Charts, tables, deadlines, money, readiness, and outcomes should visually dominate over illustrations.
6. **Dense but calm.** Prefer aligned grids and clear hierarchy over large empty marketing-style panels inside the authenticated product.
7. **Same identity everywhere.** Login, app shell, mobile shell, generated icons, social cards, reports, and presentation exports should use the same mark and palette.

## Implementation

`src/styles/brand-2026.css` is the brand override layer. It intentionally loads after `src/styles/index.css` so the existing component API and page code continue to work while the visual identity is refreshed globally.

When changing the primary mark, regenerate raster assets with:

```bash
npm run icons
```

This rebuilds the PWA icons, Apple touch icon, maskable icon, and social card from `public/mark.svg`.
