import { useRef } from 'react'
import { motion, useReducedMotion, useScroll, useSpring, useTransform, type Variants } from 'framer-motion'
import { cn } from '@/lib/utils'
import { HERO_VIDEO } from './assets'
import { Container, EASE_OUT, Marquee, PillLink, SCROLL_SPRING } from './primitives'

// Text wordmarks in the landing's original style.
const HERO_TOOLS = [
  { name: 'Ethereum', style: { fontFamily: 'Georgia, serif', fontWeight: 700, letterSpacing: '-0.02em', fontSize: '15px' } },
  { name: 'Helios', style: { fontFamily: 'Arial, sans-serif', fontWeight: 900, letterSpacing: '0.08em', fontSize: '13px', textTransform: 'uppercase' as const } },
  { name: 'EIP-7702', style: { fontFamily: 'Arial, sans-serif', fontWeight: 800, letterSpacing: '0.04em', fontSize: '14px' } },
  { name: 'Anon-RPC', style: { fontFamily: 'Courier New, monospace', fontWeight: 700, letterSpacing: '0.06em', fontSize: '14px' } },
  { name: 'Rust', style: { fontFamily: 'Trebuchet MS, sans-serif', fontWeight: 600, letterSpacing: '0.01em', fontSize: '15px', fontStyle: 'italic' as const } },
  { name: 'viem', style: { fontFamily: 'Courier New, monospace', fontWeight: 700, letterSpacing: '0.12em', fontSize: '13px', textTransform: 'uppercase' as const } },
]

const LINES = [['Every', 'Read'], ['Verified']]
const WORD_STAGGER = 0.06
const WORD_COUNT = LINES.flat().length

const word: Variants = {
  hidden: { opacity: 0, y: 24 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { duration: 0.7, delay: 0.1 + i * WORD_STAGGER, ease: EASE_OUT } }),
}
const after = (step: number) => ({
  initial: { opacity: 0, y: 16 },
  animate: { opacity: 1, y: 0 },
  transition: { duration: 0.7, delay: 0.1 + WORD_COUNT * WORD_STAGGER + step * 0.12, ease: EASE_OUT },
})

export function Hero() {
  const wrapperRef = useRef<HTMLDivElement>(null)
  const reduce = useReducedMotion() ?? false

  // 0 -> 1 while the sticky card is pinned (wrapper top at viewport top -> wrapper bottom at viewport bottom).
  const { scrollYProgress } = useScroll({ target: wrapperRef, offset: ['start start', 'end end'] })
  const p = useSpring(scrollYProgress, SCROLL_SPRING)
  const mediaScale = useTransform(p, [0, 1], [1, 1.3])
  const radius = useTransform(p, [0, 1], [24, 40])
  const heroOpacity = useTransform(p, [0.35, 1], [1, 0])
  const heroBlur = useTransform(p, [0.35, 1], ['blur(0px)', 'blur(8px)'])
  const textY = useTransform(p, [0, 0.4], [0, -60])
  const textOpacity = useTransform(p, [0, 0.4], [1, 0])

  let wordIndex = 0
  return (
    <div ref={wrapperRef} className={cn('relative', reduce ? 'pt-[88px] pb-4' : 'h-[180vh]')}>
      <div className={cn(!reduce && 'sticky top-[88px]')}>
        <Container>
          <motion.div
            style={reduce ? { borderRadius: 24 } : { borderRadius: radius, opacity: heroOpacity, filter: heroBlur }}
            className="relative h-[calc(100svh-104px)] min-h-[520px] overflow-hidden bg-[#EBEBEB] will-change-[transform,opacity,filter]"
          >
            <motion.video
              autoPlay
              muted
              loop
              playsInline
              aria-hidden="true"
              style={reduce ? undefined : { scale: mediaScale }}
              className="absolute inset-0 h-full w-full object-cover origin-center will-change-transform"
              src={HERO_VIDEO}
            />
            <motion.div
              style={reduce ? undefined : { y: textY, opacity: textOpacity }}
              className="relative z-10 flex h-full flex-col justify-center p-6 sm:p-10 md:p-14"
            >
              <h1 className="text-black text-[52px] sm:text-6xl md:text-7xl font-medium leading-[1.02] tracking-hero max-w-xl mb-5">
                {LINES.map((line, li) => (
                  <span key={li} className="block">
                    {line.map((w) => {
                      const i = wordIndex++
                      return (
                        <motion.span key={w} custom={i} variants={word} initial="hidden" animate="visible" className="inline-block mr-[0.22em]">
                          {w}
                        </motion.span>
                      )
                    })}
                  </span>
                ))}
              </h1>

              <motion.p
                {...after(0)}
                className="text-black/70 text-[17px] md:text-[19px] max-w-[480px] mb-8 leading-relaxed"
                style={{ fontFamily: "'Inter', ui-sans-serif, system-ui, sans-serif" }}
              >
                A local proof layer for Ethereum RPC. Veriq checks every balance and storage value against a finalized state root from your own
                light client — before your app sees it.
              </motion.p>

              <motion.div {...after(1)}>
                <PillLink href="/app/attack-lab" size="lg">Try the demo</PillLink>
              </motion.div>

              <motion.div {...after(2)} className="mt-12 md:mt-16 w-full max-w-md">
                <Marquee duration={18}>
                  {HERO_TOOLS.map((tool) => (
                    <span key={tool.name} className="mx-7 shrink-0 text-black/60 whitespace-nowrap" style={tool.style}>
                      {tool.name}
                    </span>
                  ))}
                </Marquee>
              </motion.div>
            </motion.div>
          </motion.div>
        </Container>
      </div>
    </div>
  )
}
