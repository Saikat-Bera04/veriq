// Prints min+gzip sizes of the built entries (zod/viem/react are external).
import { readFileSync, copyFileSync, mkdirSync } from 'node:fs'
import { gzipSync } from 'node:zlib'

mkdirSync('dist', { recursive: true })
copyFileSync('src/react/styles.css', 'dist/styles.css')

const LIMIT = 15 * 1024
let failed = false
for (const [label, file] of [['core', 'dist/index.js'], ['react', 'dist/react/index.js'], ['styles.css', 'dist/styles.css']]) {
  const raw = readFileSync(file)
  const gz = gzipSync(raw, { level: 9 }).length
  const over = label === 'core' && gz > LIMIT
  failed ||= over
  console.log(`${label.padEnd(11)} ${(raw.length / 1024).toFixed(1).padStart(6)} kB min  ${(gz / 1024).toFixed(1).padStart(5)} kB gzip${over ? '  OVER 15 kB LIMIT' : ''}`)
}
if (failed) process.exit(1)
