// Standard Tailwind pattern for opacity-capable CSS-variable colors:
// `rgb(var(--x-rgb) / <alpha-value>)` lets Tailwind substitute the alpha
// from a `/NN` modifier (bg-brand/20, text-danger/10, …) against a color
// that's actually resolved at runtime by data-theme. Every `--x-rgb`
// companion variable is defined in src/index.css right alongside its hex
// counterpart.
function withOpacity(variableName) {
  return ({ opacityValue }) =>
    opacityValue === undefined
      ? `rgb(var(${variableName}))`
      : `rgb(var(${variableName}) / ${opacityValue})`
}

/** @type {import('tailwindcss').Config} */
export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    // `lg` overridden from Tailwind's 1024px default to 980px to match the
    // JS `useMediaQuery('(min-width: 980px)')` breakpoint used everywhere
    // (see src/hooks/useMediaQuery.ts) — kept in sync so a `lg:` utility
    // class and a same-page `isDesktop` JS branch never flip at different
    // widths. 980px specifically because that's the virtual viewport width
    // Chrome/Safari mobile use for "Request Desktop Site" (they ignore the
    // page's own <meta viewport> and substitute their own ~980px one), so
    // switching to desktop-site mode on a phone/tablet now reliably lands
    // above this threshold instead of silently staying on the mobile layout.
    screens: {
      sm: '640px',
      md: '768px',
      lg: '980px',
      xl: '1280px',
      '2xl': '1536px',
    },
    extend: {
      colors: {
        // ── Live design tokens — resolve through CSS vars in src/index.css,
        // which switch value between the light/dark palettes via
        // `data-theme` on <html> (see src/store/themeStore.ts). Never
        // hardcode a hex here — the exact hex values live only in
        // index.css's two `:root[data-theme=...]` blocks.
        bg:             withOpacity('--bg-rgb'),
        surface:        withOpacity('--surface-rgb'),
        card:           withOpacity('--card-rgb'),
        border:         withOpacity('--border-rgb'),
        brand:          withOpacity('--brand-rgb'),
        header:         withOpacity('--header-rgb'),
        'header-text':    withOpacity('--header-text-rgb'),
        'header-subtext': withOpacity('--header-subtext-rgb'),
        accent:         withOpacity('--accent-rgb'),
        'accent-text':  withOpacity('--accent-text-rgb'),
        success:        withOpacity('--success-rgb'),
        warning:        withOpacity('--warning-rgb'),
        danger:         withOpacity('--danger-rgb'),
        link:           withOpacity('--link-rgb'),
        'text-primary':   withOpacity('--text-primary-rgb'),
        'text-secondary': withOpacity('--text-secondary-rgb'),
        'text-muted':     withOpacity('--text-muted-rgb'),
        avatar: {
          1: withOpacity('--avatar-1-rgb'),
          2: withOpacity('--avatar-2-rgb'),
          3: withOpacity('--avatar-3-rgb'),
          4: withOpacity('--avatar-4-rgb'),
        },
        usdc: {
          // Already carries its own baked-in alpha per the design spec
          // (#0C447C33 in dark mode) — not opacity-modifier-capable, and
          // shouldn't be; left as a plain var reference.
          bg:   'var(--usdc-bg)',
          icon: withOpacity('--usdc-icon-rgb'),
        },
        // ── Legacy aliases ─────────────────────────────────────────────
        // The pre-redesign palette (navy/blue) named as Tailwind tokens
        // that dozens of not-yet-migrated screens still reference
        // (bg-navy-700, text-brand-blue, bg-arc-green, etc). Pointing
        // these at the SAME live tokens above means every screen already
        // looks correct in both themes the moment index.css/this file
        // land, even before that screen gets its own redesign pass.
        // Deleted once nothing references them anymore (final audit phase).
        muted: withOpacity('--text-secondary-rgb'),
        navy: {
          950: withOpacity('--bg-rgb'),
          900: withOpacity('--surface-rgb'),
          800: withOpacity('--card-rgb'),
          700: withOpacity('--surface-rgb'),
        },
        'brand-blue':   withOpacity('--brand-rgb'), // legacy `text-brand-blue` / `bg-brand-blue`
        arc: {
          green:  withOpacity('--success-rgb'),
          amber:  withOpacity('--warning-rgb'),
          red:    withOpacity('--danger-rgb'),
          blue:   withOpacity('--brand-rgb'),
        },
        eurc:   withOpacity('--usdc-icon-rgb'),
        cirbtc: '#F7931A',
      },
      fontFamily: {
        sans: ['-apple-system', 'SF Pro Display', 'Inter', 'system-ui', 'sans-serif'],
      },
      borderRadius: {
        '2xl': '1rem',
        '3xl': '1.5rem',
        '4xl': '2rem',
      },
      backgroundImage: {
        'gradient-radial': 'radial-gradient(var(--tw-gradient-stops))',
        // Flat brand fill — kept as a Tailwind utility name for any
        // not-yet-migrated screen that still references it, but no longer
        // an actual gradient per the "no gradients/glow" design spec.
        'brand-gradient':  'linear-gradient(135deg, var(--brand) 0%, var(--brand) 100%)',
      },
      animation: {
        'slide-up': 'slideUp 0.28s ease',
        'fade-in':  'fadeIn 0.22s ease',
        'spin':     'spin 0.8s linear infinite',
        'shimmer':  'shimmer 1.6s infinite',
      },
      keyframes: {
        slideUp: {
          from: { transform: 'translateY(60px)', opacity: '0' },
          to:   { transform: 'translateY(0)',    opacity: '1' },
        },
        fadeIn: {
          from: { opacity: '0', transform: 'translateY(8px)' },
          to:   { opacity: '1', transform: 'translateY(0)' },
        },
        shimmer: {
          '100%': { transform: 'translateX(100%)' },
        },
      },
      boxShadow: {
        // Soft elevation scale — no glow anywhere per design spec.
        'elevation-1': 'var(--shadow-1)',
        'elevation-2': 'var(--shadow-2)',
        'elevation-3': 'var(--shadow-3)',
        // Legacy names some not-yet-migrated screens still reference —
        // aliased to the same soft elevation, not an actual glow.
        'glow-blue':   'var(--shadow-2)',
        'glow-purple': 'var(--shadow-2)',
        'card':        'var(--shadow-1)',
      },
    },
  },
  plugins: [],
}
