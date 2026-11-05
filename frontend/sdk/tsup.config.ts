import { defineConfig } from 'tsup'

export default defineConfig([
  {
    entry: { index: 'src/index.ts', 'react/index': 'src/react/index.ts' },
    format: ['esm', 'cjs'],
    dts: true,
    target: 'es2020',
    treeshake: true,
    minify: true,
    // Error subclasses rely on their class names (e.name === 'InvalidProofError').
    esbuildOptions(options) {
      options.keepNames = true
    },
    sourcemap: true,
    clean: true,
    // The React entry imports the core by package name and keeps it external, so the core
    // isn't duplicated and `instanceof VeriqError` works across both entries.
    external: ['react', 'react-dom', 'viem', 'zod', 'veriq-client'],
  },
  {
    entry: { 'bin/veriq': 'bin/veriq.ts' },
    format: ['esm'],
    target: 'node18',
    platform: 'node',
    banner: { js: '#!/usr/bin/env node' },
    noExternal: [/^(?!zod$).*/],
    external: ['zod'],
    clean: false,
  },
])
