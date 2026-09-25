import type { Config } from 'tailwindcss';

const token = (name: string) => `rgb(var(${name}) / <alpha-value>)`;

export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    extend: {
      colors: {
        canvas: token('--canvas'),
        surface: token('--surface'),
        'surface-2': token('--surface-2'),
        'surface-3': token('--surface-3'),
        line: token('--line'),
        'line-strong': token('--line-strong'),
        ink: token('--ink'),
        'ink-2': token('--ink-2'),
        'ink-3': token('--ink-3'),
        accent: token('--accent'),
        'accent-ink': token('--accent-ink'),
        'accent-soft': token('--accent-soft'),
        good: token('--good'),
        warn: token('--warn'),
        bad: token('--bad'),
        info: token('--info'),
        rail: token('--rail'),
        'rail-ink': token('--rail-ink'),
        'rail-active': token('--rail-active'),
        // The palette's deepest shade: tooltips, icon tiles, specimen blocks.
        deep: token('--deep'),
        'deep-2': token('--deep-2'),
        'accent-2': token('--accent-2'),
        // The rail's active marker and its glows: the palette's brightest note.
        marker: token('--marker'),
        // Summit Teal. The mark, and marks in charts. Never type — it is 2.49:1 on white.
        'brand-teal': token('--brand-teal'),
      },
      fontFamily: {
        // Inter is the brand typeface, self-hosted. The fallbacks are real faces, not a bare
        // `sans-serif`: if the woff2 fails to load the page should still be set in something with
        // Inter's proportions rather than whatever the platform picks.
        // Geist carries the interface; Inter covers glyphs Geist's subset lacks (arrows, checks).
        sans: ['Geist', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'Roboto', '"Helvetica Neue"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
        // Document surfaces only. A system serif, so a report draft costs no extra download.
        serif: ['Georgia', '"Iowan Old Style"', '"Times New Roman"', 'serif'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.04em' }],
        xs: ['11px', { lineHeight: '16px' }],
        sm: ['12px', { lineHeight: '18px' }],
        base: ['13px', { lineHeight: '20px' }],
        md: ['14px', { lineHeight: '21px' }],
        lg: ['16px', { lineHeight: '24px' }],
        xl: ['20px', { lineHeight: '26px', letterSpacing: '-0.015em' }],
        '2xl': ['25px', { lineHeight: '31px', letterSpacing: '-0.022em' }],
        '3xl': ['34px', { lineHeight: '38px', letterSpacing: '-0.028em' }],
        '4xl': ['43px', { lineHeight: '46px', letterSpacing: '-0.033em' }],
      },
      // Radii are concentric: a control inside a card is tighter than the card around it.
      borderRadius: { DEFAULT: '6px', none: '0px', sm: '5px', md: '8px', lg: '10px', xl: '14px', '2xl': '18px', '3xl': '24px', full: '9999px' },
      boxShadow: {
        // Depth is tinted with the ink and defined per theme in index.css.
        hairline: 'var(--shadow-hairline)',
        card: 'var(--shadow-card)',
        lift: 'var(--shadow-lift)',
        pop: 'var(--shadow-pop)',
        modal: 'var(--shadow-modal)',
        highlight: 'var(--highlight)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        // Safe only where nothing else owns `transform`. Radix popper content qualifies, because
        // the popper transforms a wrapper. Anything centred by a translate of its own does not:
        // an animation's transform replaces that translate outright and the element lands offset.
        // Use 'modal-in' (both axes) or 'popover-in' (horizontal only) in those cases instead.
        'scale-in': { from: { opacity: '0', transform: 'scale(.97)' }, to: { opacity: '1', transform: 'scale(1)' } },
        // The centered modal is positioned by a translate, and an animation's transform replaces it
        // outright — so its entrance has to carry that translate through every frame.
        'modal-in': { from: { opacity: '0', transform: 'translate(-50%, -50%) scale(.97)' }, to: { opacity: '1', transform: 'translate(-50%, -50%) scale(1)' } },
        // Horizontally centred but vertically anchored, like the command palette.
        'popover-in': { from: { opacity: '0', transform: 'translateX(-50%) scale(.98)' }, to: { opacity: '1', transform: 'translateX(-50%) scale(1)' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-in-left': { from: { opacity: '0', transform: 'translateX(-16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(100%)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'fade-up': 'fade-up .18s cubic-bezier(.2,0,0,1) both',
        'fade-in': 'fade-in .14s ease-out both',
        'scale-in': 'scale-in .14s cubic-bezier(.2,0,0,1) both',
        'modal-in': 'modal-in .16s cubic-bezier(.2,0,0,1) both',
        'popover-in': 'popover-in .14s cubic-bezier(.2,0,0,1) both',
        'slide-in-right': 'slide-in-right .2s cubic-bezier(.2,0,0,1) both',
        'slide-in-left': 'slide-in-left .2s cubic-bezier(.2,0,0,1) both',
        'slide-up': 'slide-up .22s cubic-bezier(.2,0,0,1) both',
      },
    },
  },
  plugins: [],
} satisfies Config;
