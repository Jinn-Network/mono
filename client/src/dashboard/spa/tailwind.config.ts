import type { Config } from 'tailwindcss';
import animate from 'tailwindcss-animate';

const config: Config = {
  darkMode: 'class',
  content: ['./index.html', './src/**/*.{ts,tsx}'],
  theme: {
    container: {
      center: true,
      padding: '2rem',
      screens: { '2xl': '1400px' },
    },
    extend: {
      // shadcn primitives reach for `bg-background`, `text-foreground`,
      // `border-border` etc. These map straight to CSS variables that
      // globals.css aliases to our existing brand tokens (`--bg`,
      // `--fg`, `--border`, …). Brand stays canonical; shadcn becomes a
      // pure consumer of our tokens.
      colors: {
        border: 'var(--border)',
        input: 'var(--input)',
        ring: 'var(--ring)',
        background: 'var(--background)',
        foreground: 'var(--foreground)',
        // Brand-only tones with no shadcn equivalent. Exposed as tailwind
        // utilities (e.g. `bg-sunken`, `text-dim`, `border-wane`,
        // `text-vow`) so JSX never needs raw `var(--*)` references.
        sunken: 'var(--bg-sunken)',
        elevated: 'var(--bg-elevated)',
        dim: 'var(--fg-dim)',
        wane: 'var(--wane)',
        vow: 'var(--vow-green)',
        gold: 'var(--accent-gold)',
        card: {
          DEFAULT: 'var(--card)',
          foreground: 'var(--card-foreground)',
        },
        popover: {
          DEFAULT: 'var(--popover)',
          foreground: 'var(--popover-foreground)',
        },
        primary: {
          DEFAULT: 'var(--primary)',
          foreground: 'var(--primary-foreground)',
        },
        secondary: {
          DEFAULT: 'var(--secondary)',
          foreground: 'var(--secondary-foreground)',
        },
        muted: {
          DEFAULT: 'var(--muted)',
          foreground: 'var(--muted-foreground)',
        },
        accent: {
          DEFAULT: 'var(--accent)',
          foreground: 'var(--accent-foreground)',
        },
        destructive: {
          DEFAULT: 'var(--destructive)',
          foreground: 'var(--destructive-foreground)',
        },
      },
      borderRadius: {
        lg: 'var(--radius-3)',
        md: 'var(--radius-2)',
        sm: 'var(--radius-1)',
      },
      fontFamily: {
        mono: ['var(--mono)'],
        serif: ['var(--serif)'],
      },
      keyframes: {
        'accordion-down': {
          from: { height: '0' },
          to: { height: 'var(--radix-accordion-content-height)' },
        },
        'accordion-up': {
          from: { height: 'var(--radix-accordion-content-height)' },
          to: { height: '0' },
        },
      },
      animation: {
        'accordion-down': 'accordion-down 0.2s ease-out',
        'accordion-up': 'accordion-up 0.2s ease-out',
      },
    },
  },
  plugins: [animate],
};
export default config;
