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
        'accent-2': token('--accent-2'),
      },
      fontFamily: {
        sans: ['Geist', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"JetBrains Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['10px', { lineHeight: '14px', letterSpacing: '0.08em' }],
        xs: ['11px', { lineHeight: '16px' }],
        sm: ['12px', { lineHeight: '18px' }],
        base: ['13px', { lineHeight: '19px' }],
        md: ['14px', { lineHeight: '21px' }],
        lg: ['16px', { lineHeight: '23px' }],
        xl: ['20px', { lineHeight: '24px', letterSpacing: '-0.02em' }],
        '2xl': ['26px', { lineHeight: '29px', letterSpacing: '-0.025em' }],
        '3xl': ['34px', { lineHeight: '36px', letterSpacing: '-0.03em' }],
        '4xl': ['46px', { lineHeight: '46px', letterSpacing: '-0.035em' }],
      },
      // Every corner is 90 degrees. The keys stay so existing `rounded-*` classes still compile.
      borderRadius: { DEFAULT: '0px', none: '0px', sm: '0px', md: '0px', lg: '0px', xl: '0px', '2xl': '0px', '3xl': '0px', full: '0px' },
      boxShadow: {
        card: 'none',
        pop: '0 2px 0 0 rgb(var(--line-strong) / .12), 0 0 0 1px rgb(var(--line-strong) / .28)',
        modal: '0 0 0 1px rgb(var(--line-strong) / .4), 0 24px 0 -12px rgb(var(--line-strong) / .06)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(2px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-in-left': { from: { opacity: '0', transform: 'translateX(-16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(100%)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'fade-up': 'fade-up .14s linear both',
        'fade-in': 'fade-in .1s linear both',
        'scale-in': 'scale-in .1s linear both',
        'slide-in-right': 'slide-in-right .14s cubic-bezier(.2,0,0,1) both',
        'slide-in-left': 'slide-in-left .14s cubic-bezier(.2,0,0,1) both',
        'slide-up': 'slide-up .16s cubic-bezier(.2,0,0,1) both',
      },
    },
  },
  plugins: [],
} satisfies Config;
