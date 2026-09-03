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
      },
      fontFamily: {
        sans: ['"Inter Tight"', 'Inter', 'ui-sans-serif', 'system-ui', '-apple-system', '"Segoe UI"', 'sans-serif'],
        mono: ['"IBM Plex Mono"', 'ui-monospace', 'SFMono-Regular', 'Menlo', 'monospace'],
      },
      fontSize: {
        '2xs': ['11px', { lineHeight: '15px', letterSpacing: '0.02em' }],
        xs: ['12px', { lineHeight: '17px' }],
        sm: ['13px', { lineHeight: '19px' }],
        base: ['14px', { lineHeight: '21px' }],
        md: ['15px', { lineHeight: '23px' }],
        lg: ['17px', { lineHeight: '25px' }],
        xl: ['22px', { lineHeight: '28px', letterSpacing: '-0.015em' }],
        '2xl': ['28px', { lineHeight: '33px', letterSpacing: '-0.02em' }],
        '3xl': ['36px', { lineHeight: '40px', letterSpacing: '-0.03em' }],
        '4xl': ['48px', { lineHeight: '50px', letterSpacing: '-0.04em' }],
      },
      borderRadius: { DEFAULT: '8px', sm: '6px', md: '10px', lg: '14px', xl: '20px' },
      boxShadow: {
        card: 'var(--shadow-card)',
        pop: 'var(--shadow-pop)',
        modal: 'var(--shadow-modal)',
      },
      keyframes: {
        'fade-up': { from: { opacity: '0', transform: 'translateY(4px)' }, to: { opacity: '1', transform: 'translateY(0)' } },
        'fade-in': { from: { opacity: '0' }, to: { opacity: '1' } },
        'scale-in': { from: { opacity: '0', transform: 'scale(.98)' }, to: { opacity: '1', transform: 'scale(1)' } },
        'slide-in-right': { from: { opacity: '0', transform: 'translateX(16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-in-left': { from: { opacity: '0', transform: 'translateX(-16px)' }, to: { opacity: '1', transform: 'translateX(0)' } },
        'slide-up': { from: { opacity: '0', transform: 'translateY(100%)' }, to: { opacity: '1', transform: 'translateY(0)' } },
      },
      animation: {
        'fade-up': 'fade-up .2s ease-out both',
        'fade-in': 'fade-in .15s ease-out both',
        'scale-in': 'scale-in .14s ease-out both',
        'slide-in-right': 'slide-in-right .22s cubic-bezier(.22,.8,.32,1) both',
        'slide-in-left': 'slide-in-left .22s cubic-bezier(.22,.8,.32,1) both',
        'slide-up': 'slide-up .22s cubic-bezier(.22,.8,.32,1) both',
      },
    },
  },
  plugins: [],
} satisfies Config;
