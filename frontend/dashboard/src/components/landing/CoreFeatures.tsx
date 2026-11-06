import { useEffect, useState, type ReactNode } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Bug, Check, Code, Lock, Radio, Receipt, Route, ShieldAlert, ShieldCheck } from 'lucide-react'
import { BentoGrid, BentoGridItem } from '@/components/ui/bento-grid'
import { cn } from '@/lib/utils'
import { Container, Section, SectionHeading } from './primitives'

const Skeleton = ({ children, className }: { children?: ReactNode; className?: string }) => (
  <div
    aria-hidden="true"
    className={cn(
      'flex h-full min-h-[6rem] w-full flex-1 items-center justify-center overflow-hidden rounded-xl bg-gradient-to-br from-vq-lav-100 to-vq-lav-300/60 p-4',
      className,
    )}
  >
    {children}
  </div>
)

/** Loops a counter from 0..n-1 every `ms`; frozen at the final step for reduced motion. */
function useStep(n: number, ms: number): number {
  const reduce = useReducedMotion()
  const [step, setStep] = useState(reduce ? n - 1 : 0)
  useEffect(() => {
    if (reduce) return
    const t = setInterval(() => setStep((s) => (s + 1) % n), ms)
    return () => clearInterval(t)
  }, [n, ms, reduce])
  return reduce ? n - 1 : step
}

// 1. Proof path: nodes light up one by one, the last ticks green.
function ProofPath() {
  const step = useStep(6, 700)
  return (
    <div className="flex items-center">
      {[0, 1, 2, 3].map((i) => {
        const lit = step > i
        const last = i === 3
        return (
          <div key={i} className="flex items-center">
            {i > 0 && (
              <div className="relative h-0.5 w-8 sm:w-12 bg-white/70 overflow-hidden rounded-full">
                <motion.div className="absolute inset-0 bg-vq-lav-700 origin-left" animate={{ scaleX: lit ? 1 : 0 }} transition={{ duration: 0.4 }} />
              </div>
            )}
            <motion.div
              className={cn(
                'flex h-9 w-9 items-center justify-center rounded-xl border text-[10px] font-mono',
                last && lit ? 'border-vq-ok bg-vq-ok text-white' : lit ? 'border-vq-lav-700 bg-white text-vq-lav-700' : 'border-white bg-white/60 text-vq-faint',
              )}
              animate={{ scale: lit && step === i + 1 ? 1.12 : 1 }}
              transition={{ duration: 0.3 }}
            >
              {last && lit ? <Check size={16} strokeWidth={3} /> : i === 0 ? 'root' : `n${i}`}
            </motion.div>
          </div>
        )
      })}
    </div>
  )
}

// 2. Light client: pulsing dot + finalized counter ticking up.
function FinalizedCounter() {
  const reduce = useReducedMotion()
  const [n, setN] = useState(7_412_903)
  useEffect(() => {
    if (reduce) return
    const t = setInterval(() => setN((v) => v + 1), 2400)
    return () => clearInterval(t)
  }, [reduce])
  return (
    <div className="flex items-center gap-3 rounded-full bg-white px-4 py-2.5 shadow-sm">
      <span className="relative flex h-2.5 w-2.5">
        <span className="absolute inset-0 rounded-full bg-vq-live opacity-60 motion-safe:animate-ping" />
        <span className="relative h-2.5 w-2.5 rounded-full bg-vq-live" />
      </span>
      <span className="text-sm text-vq-muted">Finalized</span>
      <span className="relative inline-flex overflow-hidden font-mono text-sm font-semibold text-vq-ink tabular-nums">
        <AnimatePresence mode="popLayout" initial={false}>
          <motion.span key={n} initial={{ y: '100%', opacity: 0 }} animate={{ y: 0, opacity: 1 }} exit={{ y: '-100%', opacity: 0 }} transition={{ duration: 0.35 }}>
            #{n.toLocaleString('en-US')}
          </motion.span>
        </AnimatePresence>
      </span>
    </div>
  )
}

// 3. Trust receipt card.
function MiniReceipt() {
  return (
    <motion.div
      className="w-full max-w-[240px] rounded-2xl bg-white p-4 shadow-sm"
      whileHover={{ rotate: -1.5, y: -2 }}
    >
      <div className="flex items-center justify-between">
        <span className="text-[11px] font-semibold uppercase tracking-wider text-vq-faint">Trust receipt</span>
        <span className="inline-flex items-center gap-1 rounded-full bg-vq-ok-bg px-2 py-0.5 text-[11px] font-medium text-vq-ok">
          <ShieldCheck size={12} /> verified
        </span>
      </div>
      <dl className="mt-3 space-y-1.5 font-mono text-[11px]">
        <div className="flex justify-between"><dt className="text-vq-faint">block</dt><dd className="text-vq-ink">#7,412,903</dd></div>
        <div className="flex justify-between"><dt className="text-vq-faint">stateRoot</dt><dd className="text-vq-ink">0x9a3f…c21e</dd></div>
        <div className="flex justify-between"><dt className="text-vq-faint">provider</dt><dd className="text-vq-ink">honest</dd></div>
      </dl>
    </motion.div>
  )
}

// 4. Failover: first provider crossed out, arrow, next ticks green.
function Failover() {
  const step = useStep(4, 900)
  const pill = 'rounded-full px-4 py-2 text-xs font-medium font-mono transition-colors duration-300'
  return (
    <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-3">
      <span className={cn(pill, step >= 1 ? 'bg-vq-err-bg text-vq-err line-through' : 'bg-white text-vq-ink')}>provider-a</span>
      <motion.span className="text-vq-lav-700" animate={{ x: step >= 2 ? [0, 4, 0] : 0, opacity: step >= 2 ? 1 : 0.3 }} transition={{ duration: 0.4 }}>→</motion.span>
      <span className={cn(pill, 'inline-flex items-center gap-1.5', step >= 3 ? 'bg-vq-ok-bg text-vq-ok' : 'bg-white text-vq-ink')}>
        provider-b {step >= 3 && <Check size={14} strokeWidth={3} />}
      </span>
      <span className={cn(pill, 'hidden sm:inline bg-white/60 text-vq-faint')}>provider-c</span>
      <span className="basis-full text-center text-[11px] text-vq-lav-700 mt-1">INVALID_PROOF → cooldown 5 min → same block, next provider</span>
    </div>
  )
}

// 5. Blocks: last two not final yet.
function Blocks() {
  return (
    <div className="flex items-end gap-2">
      {[0, 1, 2, 3, 4, 5].map((i) => {
        const final = i < 4
        return (
          <motion.div
            key={i}
            className={cn('flex h-10 w-10 sm:h-11 sm:w-11 items-center justify-center rounded-lg', final ? 'bg-vq-lav-700' : 'border-2 border-dashed border-vq-lav-500 bg-white/40')}
            initial={{ opacity: 0, y: 8 }}
            whileInView={{ opacity: final ? 1 : 0.55, y: 0 }}
            viewport={{ once: true }}
            transition={{ delay: i * 0.06 }}
          >
            {final && i === 3 && <Lock size={16} className="text-white" />}
          </motion.div>
        )
      })}
    </div>
  )
}

// 6. Code snippet.
function Snippet() {
  return (
    <pre className="w-full max-w-[360px] overflow-hidden rounded-xl bg-white p-4 font-mono text-[11px] leading-relaxed text-vq-ink shadow-sm">
      <span className="text-vq-lav-700">const</span> client = createPublicClient({'{'}
      {'\n'}  transport: <span className="text-vq-lav-700">custom</span>(veriq.transport()),
      {'\n'}{'}'})
    </pre>
  )
}

// 7. Attack lab: struck-out lie vs proven value.
function LieVsProof() {
  return (
    <div className="flex w-full flex-col sm:flex-row items-stretch justify-center gap-3">
      <div className="flex-1 max-w-[220px] rounded-2xl bg-white p-4 shadow-sm">
        <div className="text-[11px] text-vq-faint">Plain RPC · unchecked</div>
        <div className="mt-1 text-2xl font-medium tracking-h3 text-vq-err line-through decoration-2">1,000.42 ETH</div>
      </div>
      <div className="flex-1 max-w-[220px] rounded-2xl bg-white p-4 shadow-sm ring-2 ring-vq-ok/30">
        <div className="flex items-center gap-1 text-[11px] text-vq-ok"><ShieldCheck size={12} /> Veriq · verified</div>
        <div className="mt-1 text-2xl font-medium tracking-h3 text-vq-ok">0.42 ETH</div>
      </div>
    </div>
  )
}

const iconCls = 'h-5 w-5 text-vq-lav-700'

const items = [
  {
    title: 'Merkle-proof verification',
    description: 'Every balance and storage value is checked against the account and storage tries before it reaches your app.',
    header: <Skeleton><ProofPath /></Skeleton>,
    icon: <ShieldCheck className={iconCls} />,
  },
  {
    title: 'Your own light client',
    description: 'Helios syncs Ethereum consensus on your machine, so the state root comes from you, not the provider.',
    header: <Skeleton><FinalizedCounter /></Skeleton>,
    icon: <Radio className={iconCls} />,
  },
  {
    title: 'Trust Receipts',
    description: 'Each answer carries the block, state root, provider and proof method, downloadable as JSON.',
    header: <Skeleton><MiniReceipt /></Skeleton>,
    icon: <Receipt className={iconCls} />,
  },
  {
    title: 'Fail-closed routing with automatic failover',
    description:
      'A provider lies or goes down? Veriq rejects the proof, cools that provider down and retries the same block elsewhere. If no guarantee is possible you get a typed error, never a guess.',
    header: <Skeleton><Failover /></Skeleton>,
    icon: <Route className={iconCls} />,
  },
  {
    title: 'Finalized blocks only',
    description: "Reads pin to finalized blocks that can't be reorged, so a proof stays true.",
    header: <Skeleton><Blocks /></Skeleton>,
    icon: <Lock className={iconCls} />,
  },
  {
    title: 'Drop-in viem transport',
    description: (
      <>
        One line in your app: <code className="font-mono text-[13px] text-vq-ink">createPublicClient({'{'} transport: custom(veriq.transport()) {'}'})</code>.
      </>
    ),
    header: <Skeleton><Snippet /></Skeleton>,
    icon: <Code className={iconCls} />,
  },
  {
    title: 'Anon-RPC Private Mixnet',
    description: 'Reads route through Nox on Sepolia and Nym on Mainnet. Providers see the mixnet exit, never your IP address or wallet relationship.',
    header: <Skeleton><Lock className="w-10 h-10 text-vq-lav-700" /></Skeleton>,
    icon: <Radio className={iconCls} />,
  },
  {
    title: 'EIP-7702 Delegation Guard',
    description: 'Cryptographically detects 0xef0100 delegation designators to protect accounts from hidden sweeper traps and unauthorized code delegation.',
    header: <Skeleton><ShieldAlert className="w-10 h-10 text-amber-600" /></Skeleton>,
    icon: <ShieldAlert className={iconCls} />,
  },
  {
    title: 'Attack lab built in',
    description: 'Switch a demo RPC into lie mode: plain RPC shows +1,000 ETH while Veriq returns the honest value and logs the rejected proof.',
    header: <Skeleton><LieVsProof /></Skeleton>,
    icon: <Bug className={iconCls} />,
  },
]

export function CoreFeatures() {
  return (
    <Section id="core-features">
      <Container className="max-w-[1280px] px-5 md:px-10">
        <SectionHeading
          eyebrow="Core features"
          title={<>Everything between your app and the chain, verified.</>}
          body="Veriq sits on localhost, checks every answer against Ethereum's own state, and shows its work."
          className="mb-10 md:mb-12 max-w-[900px]"
        />
        <BentoGrid>
          {items.map((item, i) => (
            <BentoGridItem
              key={item.title}
              index={i}
              title={item.title}
              description={item.description}
              header={item.header}
              icon={item.icon}
              className={i === 3 || i === 6 ? 'md:col-span-2' : ''}
            />
          ))}
        </BentoGrid>
      </Container>
    </Section>
  )
}
