/** @type {import('tailwindcss').Config} */
const ch = (v) => `rgb(var(${v}) / <alpha-value>)`;

export default {
  darkMode: ['class', '[data-theme="dark"]'],
  content: ['./index.html', './src/**/*.{js,jsx}'],
  theme: {
    extend: {
      colors: {
        ink: ch('--ink'),
        panel: ch('--panel'),
        'panel-2': ch('--panel-2'),
        rule: ch('--rule'),
        'rule-strong': ch('--rule-strong'),
        text: ch('--text'),
        'text-2': ch('--text-2'),
        'text-3': ch('--text-3'),
        signal: ch('--signal'),
        'signal-ink': ch('--signal-ink'),
        ledger: ch('--ledger'),
        redline: ch('--redline'),
        info: ch('--info'),
      },
      fontFamily: {
        ui: ['Inter Tight', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        // Dense by design. This is a ledger, not a landing page.
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.06em' }],
        xs: ['11px', { lineHeight: '16px' }],
        sm: ['12px', { lineHeight: '18px' }],
        base: ['13px', { lineHeight: '20px' }],
        md: ['14px', { lineHeight: '21px' }],
        lg: ['16px', { lineHeight: '24px' }],
        xl: ['20px', { lineHeight: '26px', letterSpacing: '-0.01em' }],
        '2xl': ['26px', { lineHeight: '30px', letterSpacing: '-0.02em' }],
        '3xl': ['34px', { lineHeight: '36px', letterSpacing: '-0.03em' }],
        '4xl': ['46px', { lineHeight: '46px', letterSpacing: '-0.035em' }],
      },
      borderRadius: { DEFAULT: '3px', sm: '2px', md: '4px', lg: '6px' },
      spacing: { rail: '196px', tape: '46px' },
      keyframes: {
        // These animate the independent `translate` and `scale` properties rather
        // than `transform`. Radix positions dialogs, popovers, and tooltips with
        // `transform`, so animating that property would clobber their placement
        // once the animation settles.
        'fade-up': { from: { opacity: 0, translate: '0 3px' }, to: { opacity: 1, translate: '0 0' } },
        'scale-in': { from: { opacity: 0, scale: '0.985' }, to: { opacity: 1, scale: '1' } },
        blink: { '0%,49%': { opacity: 1 }, '50%,100%': { opacity: 0.25 } },
      },
      animation: {
        'fade-up': 'fade-up .18s ease-out both',
        'scale-in': 'scale-in .14s ease-out both',
        blink: 'blink 1.6s steps(1) infinite',
      },
    },
  },
  plugins: [],
};
