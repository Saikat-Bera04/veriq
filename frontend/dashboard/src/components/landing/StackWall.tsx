import type { CSSProperties } from 'react'
import type { IconType } from 'react-icons'
import { motion } from 'framer-motion'
import {
  SiDocker,
  SiEthereum,
  SiFramer,
  SiGithub,
  SiNodedotjs,
  SiPnpm,
  SiReact,
  SiRust,
  SiSolidity,
  SiPostgresql,
  SiTailwindcss,
  SiTypescript,
  SiVite,
  SiZod,
} from 'react-icons/si'
import { cn } from '@/lib/utils'
import { DOCS_URL } from './assets'
import { Container, EASE_OUT, FadeUp, Marquee, PillLink, Section } from './primitives'

type Logo =
  | { name: string; Icon: IconType; color: string }
  | { name: string; wordmark: CSSProperties }

// Tools this repo actually uses. The dashboard is built with Vite (not Next.js), so Vite is shown.
const LOGOS: Logo[] = [
  { name: 'Ethereum', Icon: SiEthereum, color: '#3C3C3D' },
  { name: 'Rust', Icon: SiRust, color: '#000000' },
  { name: 'viem', wordmark: { fontFamily: 'Courier New, monospace', fontWeight: 700, letterSpacing: '0.08em', textTransform: 'uppercase' } },
  { name: 'TypeScript', Icon: SiTypescript, color: '#3178C6' },
  { name: 'Helios', wordmark: { fontFamily: 'Arial Black, Arial, sans-serif', fontWeight: 900, letterSpacing: '0.06em', textTransform: 'uppercase' } },
  { name: 'React', Icon: SiReact, color: '#087EA4' },
  { name: 'Tailwind CSS', Icon: SiTailwindcss, color: '#06B6D4' },
  { name: 'alloy', wordmark: { fontFamily: 'Georgia, serif', fontWeight: 600, letterSpacing: '-0.02em' } },
  { name: 'Docker', Icon: SiDocker, color: '#2496ED' },
  { name: 'GitHub', Icon: SiGithub, color: '#181717' },
  { name: 'axum', wordmark: { fontFamily: 'Courier New, monospace', fontWeight: 700, letterSpacing: '0.1em' } },
  { name: 'Node.js', Icon: SiNodedotjs, color: '#5FA04E' },
  { name: 'pnpm', Icon: SiPnpm, color: '#F69220' },
  { name: 'Foundry', wordmark: { fontFamily: 'Impact, sans-serif', fontWeight: 700, letterSpacing: '0.04em' } },
  { name: 'PostgreSQL', Icon: SiPostgresql, color: '#4169E1' },
  { name: 'Solidity', Icon: SiSolidity, color: '#363636' },
  { name: 'Sepolia', wordmark: { fontFamily: 'Verdana, sans-serif', fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase' } },
  { name: 'Zod', Icon: SiZod, color: '#3E67B1' },
  { name: 'Vite', Icon: SiVite, color: '#646CFF' },
  { name: 'Framer', Icon: SiFramer, color: '#0055FF' },
]

type Tile = Logo | null // null = empty rhythm tile

// Each row: 9 logos, an empty tile after every 2 or 3.
function buildRow(r: number): Tile[] {
  const out: Tile[] = []
  const gaps = r % 2 === 0 ? [2, 3] : [3, 2]
  let since = 0
  let g = 0
  for (let k = 0; k < 9; k++) {
    out.push(LOGOS[(r * 5 + k) % LOGOS.length])
    if (++since === gaps[g % 2]) {
      out.push(null)
      since = 0
      g++
    }
  }
  return out
}

const ROWS = [
  { tiles: buildRow(0), duration: 40, reverse: false },
  { tiles: buildRow(1), duration: 55, reverse: true },
  { tiles: buildRow(2), duration: 45, reverse: false },
  { tiles: buildRow(3), duration: 60, reverse: true },
]

const tileBox = 'mr-[10px] md:mr-[14px] h-[72px] w-[72px] md:h-28 md:w-28 shrink-0 rounded-2xl md:rounded-3xl'

function LogoTile({ tile }: { tile: Tile }) {
  if (!tile) return <div aria-hidden="true" className={cn(tileBox, 'border border-white/[0.06] bg-white/[0.04]')} />
  return (
    <div
      title={tile.name}
      className={cn(
        tileBox,
        'group/tile relative flex items-center justify-center bg-vq-tile transition-transform duration-300 ease-out hover:scale-[1.06] motion-reduce:transition-none',
      )}
    >
      {'Icon' in tile ? (
        <tile.Icon aria-label={tile.name} role="img" className="h-[55%] w-[55%] transition-transform duration-300 group-hover/tile:-translate-y-1.5" style={{ color: tile.color }} />
      ) : (
        <span
          className="text-[12px] md:text-[17px] text-vq-ink transition-transform duration-300 group-hover/tile:-translate-y-1.5"
          style={tile.wordmark}
        >
          {tile.name}
        </span>
      )}
      <span className="pointer-events-none absolute bottom-1.5 md:bottom-2.5 rounded-full bg-vq-aubergine-deep px-2 py-0.5 text-[9px] md:text-[10px] font-medium text-white opacity-0 transition-opacity duration-200 group-hover/tile:opacity-100">
        {tile.name}
      </span>
    </div>
  )
}

export function StackWall() {
  return (
    <Section id="stack" className="pb-16 md:pb-24">
      <Container>
        <div className="overflow-hidden rounded-[32px] bg-vq-aubergine-deep py-20 md:py-28">
          <FadeUp className="mx-auto max-w-[1000px] px-6 text-center">
            <span className="mb-5 block text-sm text-vq-lav-500">Works with your stack</span>
            <h2 className="text-[34px] sm:text-[40px] md:text-[52px] font-medium leading-[1.05] tracking-hero">
              <span className="text-white">Stop trusting whatever your RPC says.</span>{' '}
              <span className="text-white/55">Plug Veriq into the stack you already ship with. Every read comes back proven, with a receipt.</span>
            </h2>
          </FadeUp>

          <div className="mt-12 md:mt-16 space-y-[10px] md:space-y-[14px]" role="list" aria-label="Tools Veriq works with">
            {ROWS.map((row, r) => (
              <motion.div
                key={r}
                role="listitem"
                initial={{ opacity: 0, x: r % 2 === 0 ? -80 : 80 }}
                whileInView={{ opacity: 1, x: 0 }}
                viewport={{ once: true, amount: 0.3 }}
                transition={{ duration: 0.8, delay: r * 0.06, ease: EASE_OUT }}
              >
                {/* Odd rows are shifted by half a tile so the wall looks staggered. */}
                <Marquee duration={row.duration} reverse={row.reverse} className={cn(r % 2 === 1 && '-ml-[41px] md:-ml-[63px]')}>
                  {row.tiles.map((t, k) => <LogoTile key={k} tile={t} />)}
                </Marquee>
              </motion.div>
            ))}
          </div>

          <div className="mt-12 md:mt-16 flex justify-center">
            <PillLink href={DOCS_URL} light>Read the docs</PillLink>
          </div>
        </div>
      </Container>
    </Section>
  )
}
