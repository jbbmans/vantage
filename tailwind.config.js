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
        attention: ch('--attention'),
      },
      fontFamily: {
        ui: ['Inter', 'Aptos', 'system-ui', '-apple-system', 'Segoe UI', 'sans-serif'],
        mono: ['IBM Plex Mono', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '15px', letterSpacing: '0.02em' }],
        xs: ['12px', { lineHeight: '17px' }],
        sm: ['13px', { lineHeight: '19px' }],
        base: ['14px', { lineHeight: '21px' }],
        md: ['15px', { lineHeight: '22px' }],
        lg: ['18px', { lineHeight: '26px' }],
        xl: ['24px', { lineHeight: '30px', letterSpacing: '-0.02em' }],
        '2xl': ['30px', { lineHeight: '35px', letterSpacing: '-0.025em' }],
        '3xl': ['40px', { lineHeight: '43px', letterSpacing: '-0.035em' }],
        '4xl': ['54px', { lineHeight: '56px', letterSpacing: '-0.045em' }],
      },
      borderRadius: { DEFAULT: '8px', sm: '6px', md: '10px', lg: '14px' },
      spacing: { rail: '98px', tape: '46px' },
      keyframes: {
        // These animate the independent `translate` and `scale` properties rather
        // than `transform`. Radix positions dialogs, popovers, and tooltips with
        // `transform`, so animating that property would clobber their placement
        // once the animation settles.
        'fade-up': { from: { opacity: 0, translate: '0 3px' }, to: { opacity: 1, translate: '0 0' } },
        'scale-in': { from: { opacity: 0, scale: '0.985' }, to: { opacity: 1, scale: '1' } },
        'page-enter': { from: { opacity: 0, translate: '0 7px' }, to: { opacity: 1, translate: '0 0' } },
        'slide-in-left': { from: { opacity: 0, translate: '-18px 0' }, to: { opacity: 1, translate: '0 0' } },
        'slide-in-right': { from: { opacity: 0, translate: '18px 0' }, to: { opacity: 1, translate: '0 0' } },
        'fade-in': { from: { opacity: 0 }, to: { opacity: 1 } },
        blink: { '0%,49%': { opacity: 1 }, '50%,100%': { opacity: 0.25 } },
      },
      animation: {
        'fade-up': 'fade-up .18s ease-out both',
        'scale-in': 'scale-in .14s ease-out both',
        'page-enter': 'page-enter .24s cubic-bezier(.22,.8,.32,1) both',
        'slide-in-left': 'slide-in-left .2s cubic-bezier(.22,.8,.32,1) both',
        'slide-in-right': 'slide-in-right .2s cubic-bezier(.22,.8,.32,1) both',
        'fade-in': 'fade-in .16s ease-out both',
        blink: 'blink 1.6s steps(1) infinite',
      },
    },
  },
  plugins: [],
};
