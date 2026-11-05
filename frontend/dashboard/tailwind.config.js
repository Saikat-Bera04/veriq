/** @type {import('tailwindcss').Config} */
const vq = (name) => `rgb(var(--vq-${name}) / <alpha-value>)`

export default {
  content: [
    "./index.html",
    "./src/**/*.{js,ts,jsx,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        background: '#F5F5F5',
        // Dashboard tokens (src/styles/veriq-tokens.css)
        vq: {
          bg: vq('bg'),
          surface: vq('surface'),
          ink: vq('ink'),
          black: vq('black'),
          muted: vq('muted'),
          faint: vq('faint'),
          border: vq('border'),
          mist: vq('mist'),
          'lav-100': vq('lavender-100'),
          'lav-300': vq('lavender-300'),
          'lav-500': vq('lavender-500'),
          'lav-700': vq('lavender-700'),
          aubergine: vq('aubergine'),
          'aubergine-deep': vq('aubergine-deep'),
          tile: vq('tile'),
          ok: vq('ok'),
          'ok-bg': vq('ok-bg'),
          warn: vq('warn'),
          'warn-bg': vq('warn-bg'),
          err: vq('err'),
          'err-bg': vq('err-bg'),
          live: vq('live'),
        },
      },
      fontFamily: {
        sans: ['"TT Norms Pro"', 'Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        body: ['Inter', 'ui-sans-serif', 'system-ui', 'sans-serif'],
        mono: ['ui-monospace', '"SF Mono"', 'SFMono-Regular', 'Menlo', 'Consolas', 'monospace'],
      },
      borderRadius: {
        card: 'var(--vq-radius-card)',
        inner: 'var(--vq-radius-inner)',
      },
      boxShadow: {
        card: 'var(--vq-shadow-card)',
        pop: 'var(--vq-shadow-pop)',
      },
      letterSpacing: {
        hero: 'var(--vq-tracking-hero)',
        h2: 'var(--vq-tracking-h2)',
        h3: 'var(--vq-tracking-h3)',
      },
    },
  },
  plugins: [],
}
