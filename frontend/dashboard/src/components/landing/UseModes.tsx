import { useRef, useState } from 'react'
import { ArrowRight } from 'lucide-react'
import {
  motion,
  useMotionValueEvent,
  useReducedMotion,
  useScroll,
  useSpring,
  useTransform,
  type MotionValue,
} from 'framer-motion'
import { cn } from '@/lib/utils'
import { DOCS_URL, FOOTER_POSTER, HERO_VIDEO, LAVENDER_IMAGE, USE_MODES_VIDEO } from './assets'
import { Container, SCROLL_SPRING, Section, SectionHeading, focusRing } from './primitives'

interface Mode {
  title: string
  body: string
  media: { kind: 'video' | 'image'; src: string; alt: string }
}

// Existing landing media only, alternated across the deck.
const MODES: Mode[] = [
  { title: 'Wallets & EIP-7702', body: 'Show users balances you can prove. Cryptographically detect and warn on malicious EIP-7702 delegation sweepers.', media: { kind: 'video', src: USE_MODES_VIDEO, alt: '' } },
  { title: 'Private dApps', body: 'Read contract storage through Anon-RPC mixnets and get a verifiable Trust Receipt with every value without leaking IP.', media: { kind: 'image', src: LAVENDER_IMAGE, alt: 'Lavender 3D render' } },
  { title: 'Bots & keepers', body: "Act only on finalized, proven state; a bad RPC can't trick your bot into a trade.", media: { kind: 'video', src: HERO_VIDEO, alt: '' } },
  { title: 'Dashboards', body: 'Every number on screen carries the block, state root and provider that served it.', media: { kind: 'image', src: FOOTER_POSTER, alt: 'Lavender meadow at dusk' } },
]
const N = MODES.length
const STEP = 28 // px each later card stops below the previous one

function DeckCard({ mode, i, progress, reduce }: { mode: Mode; i: number; progress: MotionValue<number>; reduce: boolean }) {
  const cardRef = useRef<HTMLDivElement>(null)
  const dark = i % 2 === 1
  const last = i === N - 1

  // Covered cards shrink, darken and tilt slightly as the next card lands.
  const scale = useTransform(progress, [i / N, 1], [1, 1 - (N - 1 - i) * 0.05])
  const coverRange = [i / (N - 1), (i + 1) / (N - 1)]
  const overlay = useTransform(progress, coverRange, [0, last ? 0 : 0.35])
  const rotate = useTransform(progress, coverRange, [0, last ? 0 : i % 2 === 0 ? -1 : 1])

  // Image parallax as the card enters.
  const { scrollYProgress: enter } = useScroll({ target: cardRef, offset: ['start end', 'start start'] })
  const mediaScale = useSpring(useTransform(enter, [0, 1], [1.2, 1]), SCROLL_SPRING)

  return (
    // Each card is sticky in the deck; the gap below it equals the 80vh / 90vh scroll per card,
    // so the next card slides up and stops STEP px lower, and the full stack forms before release.
    <motion.article
      ref={cardRef}
      style={reduce ? undefined : { top: `calc(110px + ${i * STEP}px)`, scale, rotate, transformOrigin: 'top center' }}
      className={cn(
        !reduce && 'sticky',
        !reduce && !last && 'mb-[max(40px,calc(80vh-420px))] md:mb-[max(40px,calc(90vh-520px))]',
        reduce && 'relative mb-4',
        'flex h-[420px] md:h-[520px] flex-col overflow-hidden rounded-3xl p-4 md:p-5 shadow-[0_24px_60px_-28px_rgba(43,38,68,0.45)] will-change-transform',
        dark ? 'bg-vq-aubergine text-white' : 'bg-vq-lav-100 text-vq-black',
      )}
    >
        <div className="relative min-h-0 flex-1 overflow-hidden rounded-2xl bg-vq-lav-300/40">
          {mode.media.kind === 'video' ? (
            <motion.video
              autoPlay
              muted
              loop
              playsInline
              aria-hidden="true"
              src={mode.media.src}
              style={reduce ? undefined : { scale: mediaScale }}
              className="absolute inset-0 h-full w-full object-cover"
            />
          ) : (
            <motion.div
              role="img"
              aria-label={mode.media.alt}
              style={{ backgroundImage: `url(${mode.media.src})`, ...(reduce ? {} : { scale: mediaScale }) }}
              className="absolute inset-0 bg-cover bg-center"
            />
          )}
          <span className={cn('absolute left-4 top-4 rounded-full px-3 py-1 text-xs font-medium backdrop-blur', dark ? 'bg-black/30 text-white' : 'bg-white/70 text-vq-ink')}>
            0{i + 1}
          </span>
        </div>
        <div className="flex flex-col gap-4 px-2 pt-5 pb-2 md:flex-row md:items-end md:justify-between md:gap-8 md:px-3">
          <div>
            <h3 className="text-[32px] md:text-[44px] font-medium leading-[1.02] tracking-hero">{mode.title}</h3>
            <p className={cn('mt-2 max-w-md text-base md:text-[17px] leading-relaxed', dark ? 'text-white/65' : 'text-vq-muted')}>{mode.body}</p>
          </div>
          <a href={DOCS_URL} target="_blank" rel="noopener noreferrer" className={cn('group inline-flex shrink-0 items-center gap-3 rounded-full', focusRing)}>
            <span className={cn('flex h-10 w-10 items-center justify-center rounded-full transition-colors', dark ? 'bg-white text-black' : 'bg-black text-white')}>
              <ArrowRight className="h-4 w-4 transition-transform group-hover:translate-x-0.5" aria-hidden="true" />
            </span>
            <span className="text-base font-medium">Read the docs</span>
          </a>
        </div>
        {!reduce && !last && (
          <motion.div aria-hidden="true" style={{ opacity: overlay }} className="pointer-events-none absolute inset-0 rounded-3xl bg-black" />
        )}
    </motion.article>
  )
}

export function UseModes() {
  const deckRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion() ?? false
  const { scrollYProgress } = useScroll({ target: deckRef, offset: ['start start', 'end end'] })
  const progress = useSpring(scrollYProgress, SCROLL_SPRING)
  const [active, setActive] = useState(0)
  useMotionValueEvent(scrollYProgress, 'change', (v) => setActive(Math.min(N - 1, Math.max(0, Math.floor(v * (N - 1) + 0.15)))))

  return (
    <Section id="use-modes">
      <Container className="max-w-[1280px] px-5 md:px-10 grid grid-cols-1 gap-10 md:grid-cols-12 md:gap-10">
        <div className="md:col-span-5 md:sticky md:top-[120px] self-start">
          <SectionHeading
            eyebrow="Veriq in Practice"
            title="Use modes"
            body="Veriq powers verified reads for wallets, dApps, bots and dashboards that can't afford to trust a single RPC."
          />
          <ol className="mt-10 hidden md:block space-y-1" aria-label="Use modes">
            {MODES.map((m, i) => {
              const on = i === active
              return (
                <li key={m.title} aria-current={on ? 'step' : undefined} className="flex items-center gap-4 py-2">
                  <span className="relative flex h-3 w-3 items-center justify-center">
                    <motion.span
                      className="absolute inset-0 rounded-full bg-vq-lav-700"
                      initial={false}
                      animate={{ scale: on ? 1 : 0.5, opacity: on ? 1 : 0.35 }}
                      transition={{ type: 'spring', stiffness: 400, damping: 30 }}
                    />
                  </span>
                  <span className={cn('text-lg font-medium tracking-h3 transition-colors duration-300', on ? 'text-vq-black' : 'text-vq-faint')}>{m.title}</span>
                </li>
              )
            })}
          </ol>
        </div>
        <div ref={deckRef} className="relative md:col-span-7">
          {MODES.map((m, i) => (
            <DeckCard key={m.title} mode={m} i={i} progress={progress} reduce={reduce} />
          ))}
        </div>
      </Container>
    </Section>
  )
}
