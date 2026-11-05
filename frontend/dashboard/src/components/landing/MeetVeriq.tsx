import { motion, useReducedMotion, type Variants } from 'framer-motion'
import { LAVENDER_IMAGE } from './assets'
import { Container, EASE_OUT, FadeUp, Marquee, PillLink } from './primitives'

const card: Variants = {
  hidden: { opacity: 0, y: 40 },
  visible: (i: number) => ({ opacity: 1, y: 0, transition: { duration: 0.6, delay: i * 0.08, ease: EASE_OUT } }),
}

const INFRA_BRANDS = [
  { name: 'Ethereum', style: { fontFamily: 'Times New Roman, serif', fontWeight: 400, letterSpacing: '0.02em', fontSize: '15px' } },
  { name: 'Helios', style: { fontFamily: 'Arial Black, sans-serif', fontWeight: 900, letterSpacing: '0.08em', fontSize: '15px', textTransform: 'uppercase' as const } },
  { name: 'alloy', style: { fontFamily: 'Georgia, serif', fontWeight: 600, letterSpacing: '-0.02em', fontSize: '16px' } },
  { name: 'axum', style: { fontFamily: 'Courier New, monospace', fontWeight: 700, letterSpacing: '0.12em', fontSize: '14px' } },
  { name: 'viem', style: { fontFamily: 'Helvetica, Arial, sans-serif', fontWeight: 700, letterSpacing: '-0.01em', fontSize: '15px' } },
  { name: 'Foundry', style: { fontFamily: 'Impact, sans-serif', fontWeight: 700, letterSpacing: '0.05em', fontSize: '17px' } },
  { name: 'Sepolia', style: { fontFamily: 'Verdana, sans-serif', fontWeight: 700, letterSpacing: '0.06em', fontSize: '14px', textTransform: 'uppercase' as const } },
]

const DARK_CARDS = [
  { title: 'Fails closed,\nnever guesses.', body: "If a guarantee can't be met you get a typed error, never a weaker answer." },
  { title: 'Automatic\nfailover', body: 'A lying provider is rejected, cooled down and replaced, on the same block, without you noticing.' },
]

export function MeetVeriq() {
  const reduce = useReducedMotion()
  const hover = reduce ? undefined : { y: -6, transition: { duration: 0.25, ease: EASE_OUT } }
  const inView = { initial: 'hidden', whileInView: 'visible', viewport: { once: true, amount: 0.2 } } as const

  return (
    // Slides up over the fading hero with a soft shadow.
    <section
      id="how-it-works"
      className="relative z-10 -mt-[18vh] scroll-mt-20 rounded-t-[40px] bg-[#F5F5F5] pt-16 md:pt-24 shadow-[0_-24px_60px_-24px_rgba(43,38,68,0.22)] motion-reduce:mt-0"
    >
      {/* Kept at the original 1280px width; other sections use the wide container. */}
      <Container className="max-w-[1280px] px-5 md:px-10">
        <div className="grid grid-cols-1 md:grid-cols-2 gap-8 md:gap-12 mb-10 md:mb-12 items-start">
          <FadeUp>
            <h2 className="text-black text-[40px] md:text-[56px] lg:text-[64px] font-medium leading-[1.02] tracking-hero mb-8">Meet Veriq.</h2>
            <PillLink href="#core-features">See how it works</PillLink>
          </FadeUp>
          <FadeUp delay={0.08}>
            <p className="text-black/70 text-2xl md:text-3xl leading-snug">
              Veriq turns any untrusted RPC provider into a verified one, and hands you a Trust Receipt for every answer.
            </p>
          </FadeUp>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
          <motion.article
            custom={0}
            variants={card}
            {...inView}
            whileHover={hover}
            className="group relative sm:col-span-2 overflow-hidden rounded-3xl p-7 min-h-[300px] md:min-h-[320px] flex flex-col justify-between"
          >
            <div
              role="img"
              aria-label="Lavender 3D render"
              className="absolute inset-0 bg-cover bg-center transition-transform duration-500 ease-out group-hover:scale-[1.04] motion-reduce:transition-none motion-reduce:group-hover:scale-100"
              style={{ backgroundImage: `url(${LAVENDER_IMAGE})` }}
            />
            <h3 className="relative text-black text-2xl font-medium leading-snug tracking-h3">Proofs, not promises</h3>
            <p className="relative text-black/70 text-base max-w-xs">
              Every balance and storage read is checked with a Merkle proof against a Helios-finalized state root.
            </p>
          </motion.article>

          {DARK_CARDS.map((c, i) => (
            <motion.article
              key={c.title}
              custom={i + 1}
              variants={card}
              {...inView}
              whileHover={hover}
              className="rounded-3xl p-7 min-h-[300px] md:min-h-[320px] flex flex-col justify-between bg-[#2B2644]"
            >
              <h3 className="text-white text-2xl font-medium leading-snug tracking-h3 whitespace-pre-line">{c.title}</h3>
              <p className="text-white/60 text-base">{c.body}</p>
            </motion.article>
          ))}
        </div>

        {/* Replaces the old partner strip: real open-source infrastructure only. */}
        <div className="mt-14 md:mt-20 grid grid-cols-1 md:grid-cols-4 gap-6 md:gap-8 items-center">
          <p className="text-black/70 text-base leading-relaxed md:col-span-1">Built on open infrastructure we trust.</p>
          <Marquee duration={30} className="md:col-span-3">
            {INFRA_BRANDS.map((b) => (
              <span key={b.name} className="mx-10 shrink-0 text-black/50 whitespace-nowrap" style={b.style}>
                {b.name}
              </span>
            ))}
          </Marquee>
        </div>
      </Container>
    </section>
  )
}
