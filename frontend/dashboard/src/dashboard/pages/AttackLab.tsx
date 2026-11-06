import { useEffect, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import { Link } from 'react-router-dom'
import { Radio, ShieldCheck, TriangleAlert } from 'lucide-react'
import { VeriqError } from 'veriq-client'
import {
  ATTACKER_DISPLAY,
  plainGetBalance,
  readBalance,
  resetBreakers,
  useAttackerMode,
  useSetAttackerMode,
  type PlainOutcome,
  type ReadOutcome,
  type ResetOutcome,
} from '../lib/engine'
import { ATTACK_MODES, DEMO_ADDRESS, type AttackMode } from '../lib/mock'
import { formatEth } from '../lib/format'
import { AttemptsTimeline } from '../components/ReceiptDrawer'
import { Card, Chip, ErrorCard, HeroPanel, PrimaryButton, SampleTag, Skeleton, Stagger, cx } from '../components/ui'
import { ReceiptBadge } from 'veriq-client/react'

const MODE_INFO: Record<AttackMode, string> = {
  off: 'Forwards every request honestly.',
  value: 'Claims +1000 ETH but sends the honest proof.',
  proof: 'Claims +1000 ETH and edits the proof to match.',
  wrongblock: 'Sends a valid proof from 100 blocks ago.',
  outage: 'Answers every request with HTTP 503.',
  nonce: 'Claims one more transaction (nonce) than the proof shows.',
  code: 'Returns altered contract code; balance reads stay honest.',
}

const ADDRESS_RE = /^0x[0-9a-fA-F]{40}$/

interface Run {
  id: number
  plain: PlainOutcome
  veriq: ReadOutcome
}

function ModePills({ current, pending, onPick, disabled }: { current?: AttackMode; pending?: AttackMode; onPick: (m: AttackMode) => void; disabled: boolean }) {
  const shown = pending ?? current
  return (
    <div role="radiogroup" aria-label="Attacker mode" className="flex flex-wrap gap-2">
      {ATTACK_MODES.map((m) => {
        const active = m === shown
        return (
          <button
            key={m}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onPick(m)}
            className={cx(
              'vq-focus relative h-10 px-5 rounded-full text-sm font-medium border transition-colors',
              active
                ? m === 'off' ? 'bg-vq-black text-white border-vq-black' : 'bg-vq-err text-white border-vq-err'
                : 'bg-vq-surface text-vq-ink border-vq-border hover:border-vq-lav-300',
            )}
          >
            {m}
            {active && pending && pending !== current && <span className="sr-only"> (switching)</span>}
          </button>
        )
      })}
    </div>
  )
}

function PlainCard({ run, honest, loading }: { run: Run | null; honest: bigint | null; loading: boolean }) {
  const reduce = useReducedMotion()
  const plain = run?.plain
  const wrong = plain?.ok === true && honest !== null && plain.value !== honest
  const diff = plain?.ok && honest !== null ? plain.value - honest : 0n
  return (
    <Card className="flex flex-col min-h-[340px]">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-medium tracking-h3">Plain RPC</h2>
          <p className="text-sm text-vq-muted font-mono mt-1">eth_getBalance → {ATTACKER_DISPLAY}</p>
        </div>
        <Chip tone="warn"><TriangleAlert className="w-3.5 h-3.5" aria-hidden="true" /> unchecked</Chip>
      </div>
      <div className="flex-1 flex flex-col justify-center py-8">
        {loading ? (
          <Skeleton className="h-16 w-56" />
        ) : !plain ? (
          <p className="text-vq-faint">Whatever the provider claims shows up here.</p>
        ) : plain.ok ? (
          <motion.div
            key={run.id}
            initial={false}
            animate={wrong && !reduce ? { x: [0, -14, 12, -10, 8, -5, 3, 0] } : { x: 0 }}
            transition={{ duration: 0.6, delay: 0.15 }}
          >
            <motion.div
              className="text-5xl md:text-6xl font-medium tracking-hero tabular-nums break-words"
              initial={{ color: 'rgb(12, 12, 12)' }}
              animate={{ color: wrong ? 'rgb(194, 65, 91)' : 'rgb(12, 12, 12)' }}
              transition={{ duration: 0.3, delay: 0.15 }}
            >
              {formatEth(plain.value)} <span className="text-2xl">ETH</span>
            </motion.div>
            {wrong && (
              <p className="mt-3 text-vq-err font-medium">
                {diff > 0n ? '+' : ''}{formatEth(diff)} ETH that the proof does not back
              </p>
            )}
            {!wrong && honest !== null && <p className="mt-3 text-vq-muted">Matches the proven value this time.</p>}
          </motion.div>
        ) : (
          <motion.div key={run.id} initial={{ opacity: 0 }} animate={{ opacity: 1 }}>
            <div className="text-3xl font-medium tracking-hero text-vq-err">Request failed</div>
            <p className="mt-2 font-mono text-sm text-vq-err/80 break-words">{plain.error}</p>
            <p className="mt-2 text-sm text-vq-muted">Your app gets nothing, or worse, a cached stale number.</p>
          </motion.div>
        )}
      </div>
      <p className="text-xs text-vq-muted">No proof is requested or checked. The app believes this number.</p>
    </Card>
  )
}

function VeriqCard({ run, loading }: { run: Run | null; loading: boolean }) {
  const reduce = useReducedMotion()
  const v = run?.veriq
  return (
    <div className="relative rounded-card">
      {v?.ok && !reduce && (
        <motion.span
          key={run?.id}
          aria-hidden="true"
          className="pointer-events-none absolute inset-0 z-10 rounded-card"
          initial={{ boxShadow: '0 0 0 0 rgba(47,158,110,0)' }}
          animate={{ boxShadow: ['0 0 0 0 rgba(47,158,110,0)', '0 0 0 10px rgba(47,158,110,0.35)', '0 0 0 22px rgba(47,158,110,0)'] }}
          transition={{ duration: 1.1, delay: 0.25, ease: 'easeOut' }}
        />
      )}
      <HeroPanel className="flex flex-col min-h-[340px] h-full">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 className="text-2xl font-medium tracking-h3">Veriq</h2>
            <p className="text-sm text-white/60 font-mono mt-1">veriq_readBalance via veriq-client</p>
          </div>
          {v?.ok && <ReceiptBadge status={v.result.receipt.verification.status} />}
          {v && !v.ok && <ReceiptBadge error={v.error instanceof VeriqError ? v.error : new VeriqError(-1, v.error.message)} />}
        </div>
        <div className="flex-1 py-8">
          {loading ? (
            <Skeleton className="h-16 w-56 !bg-white/10" />
          ) : !v ? (
            <p className="text-white/50">The value the proof proves shows up here.</p>
          ) : v.ok ? (
            <motion.div key={run.id} initial={{ opacity: 0, y: 8 }} animate={{ opacity: 1, y: 0 }}>
              <div className="text-5xl md:text-6xl font-medium tracking-hero tabular-nums break-words">
                {formatEth(v.result.value)} <span className="text-2xl">ETH</span>
              </div>
              <p className="mt-3 text-white/70 flex items-center gap-2">
                <ShieldCheck className="w-4 h-4 text-vq-ok" aria-hidden="true" />
                Proven at block #{v.result.receipt.block.number.toLocaleString('en-US')} against {v.result.receipt.verification.rootSource}
              </p>
            </motion.div>
          ) : (
            <div>
              <div className="text-2xl font-medium tracking-hero text-[rgb(var(--vq-err-bg))]">
                {v.error instanceof VeriqError ? v.error.codeName : 'Engine unreachable'}
              </div>
              <p className="mt-2 text-sm text-white/70">
                {v.error instanceof VeriqError ? v.error.meaning : v.error.message}
              </p>
              <p className="mt-1 text-sm text-white/50">Fails closed: no number is better than a wrong one.</p>
            </div>
          )}
        </div>
        {v?.ok && (
          <div>
            <div className="text-sm text-white/60 mb-3">Attempts</div>
            <AttemptsTimeline attempts={v.result.attempts} dark />
            <Link
              to={`/app/feed?receipt=${encodeURIComponent(v.result.receipt.identity.requestId)}`}
              className="vq-focus inline-block mt-4 text-sm text-white/70 hover:text-white underline underline-offset-4 rounded"
            >
              Open the Trust Receipt
            </Link>
          </div>
        )}
      </HeroPanel>
    </div>
  )
}

export function AttackLabPage() {
  const mode = useAttackerMode()
  const setMode = useSetAttackerMode()
  const [address, setAddress] = useState(DEMO_ADDRESS)
  const [run, setRun] = useState<Run | null>(null)
  const [running, setRunning] = useState(false)
  // The latest breaker reset: from a mode switch, or from the Reset button.
  const [manualReset, setManualReset] = useState<ResetOutcome | null>(null)
  const [resetting, setResetting] = useState(false)
  const resetState = manualReset ?? setMode.data
  const runId = useRef(0)
  const valid = ADDRESS_RE.test(address.trim())
  const mock = mode.data?.source === 'mock'

  const go = async () => {
    if (!ADDRESS_RE.test(address.trim())) return
    setRunning(true)
    const id = ++runId.current
    const [plain, veriq] = await Promise.all([plainGetBalance(address.trim()), readBalance(address.trim(), undefined, { path: 'direct' })])
    if (id === runId.current) {
      setRun({ id, plain, veriq })
      setRunning(false)
    }
  }

  // Re-run after each mode switch, so the effect of the attack is visible immediately.
  const lastMode = useRef<AttackMode | undefined>(undefined)
  useEffect(() => {
    const m = mode.data?.data
    if (m && lastMode.current !== undefined && m !== lastMode.current && run) void go()
    lastMode.current = m
  }, [mode.data?.data])

  const shownMode = (setMode.isPending ? setMode.variables : undefined) ?? mode.data?.data
  const honest = run?.veriq.ok ? run.veriq.result.value : null

  return (
    <Stagger className="space-y-5">
      <motion.div
        role="status"
        className="flex flex-wrap items-center gap-3 rounded-card bg-vq-err-bg text-vq-err border border-vq-err/25 px-6 py-4"
      >
        <Radio className="w-5 h-5 shrink-0" aria-hidden="true" />
        <span className="font-semibold tracking-h3">
          {mode.error
            ? 'Attack Lab attacker unavailable'
            : mode.data
              ? `SIMULATION — demo attacker on ${ATTACKER_DISPLAY}`
              : 'Connecting to attacker service'}
        </span>
        {mode.error && <span className="text-sm text-vq-ink/70">No sample attack data is being substituted.</span>}
        {mock && <span className="text-sm text-vq-ink/70">Attacker not running: simulated in the browser.</span>}
        {mock && <SampleTag className="ml-auto" />}
      </motion.div>

      <Card>
        <div>
          <div className="min-w-0">
            <div className="text-sm text-vq-muted mb-3">Attacker mode</div>
            {mode.isLoading ? (
              <div className="flex gap-2">{ATTACK_MODES.map((m) => <Skeleton key={m} className="h-10 w-24 !rounded-full" />)}</div>
            ) : mode.error ? (
              <ErrorCard error={mode.error} onRetry={() => void mode.refetch()} />
            ) : (
              <ModePills
                current={mode.data?.data}
                pending={setMode.isPending ? setMode.variables : undefined}
                onPick={(m) => {
                  setManualReset(null)
                  setMode.mutate(m)
                }}
                disabled={setMode.isPending}
              />
            )}
            <p className="mt-3 text-sm text-vq-muted min-h-5" aria-live="polite">
              {shownMode && <><span className="font-mono text-vq-ink">{shownMode}</span> — {MODE_INFO[shownMode]}</>}
            </p>
            {setMode.error && <p className="mt-2 text-sm text-vq-err">Couldn't switch mode: {setMode.error.message}</p>}
            <div className="mt-3 flex flex-wrap items-center gap-3 text-sm">
              <button
                type="button"
                disabled={resetting}
                onClick={async () => {
                  setResetting(true)
                  setManualReset(await resetBreakers())
                  setResetting(false)
                }}
                className="vq-focus h-8 px-4 rounded-full border border-vq-border bg-vq-surface text-vq-ink hover:border-vq-lav-300 disabled:opacity-50"
              >
                {resetting ? 'Resetting…' : 'Reset breakers'}
              </button>
              <span role="status" className={resetState === 'unavailable' ? 'text-vq-err' : 'text-vq-muted'}>
                {resetState === 'reset' && 'Breakers reset: the next read tries the attacker again.'}
                {resetState === 'unavailable' &&
                  'Breakers not reset: this engine has no demo reset (pnpm demo builds one). After a rejected proof the attacker is skipped for 5 minutes.'}
              </span>
            </div>
          </div>
        </div>
        <form
          className="mt-6 pt-6 border-t border-vq-border flex flex-col sm:flex-row gap-3 sm:items-end"
          onSubmit={(e) => {
            e.preventDefault()
            void go()
          }}
        >
          <label className="flex-1 min-w-0 flex flex-col gap-1.5">
            <span className="text-sm text-vq-muted">Address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              spellCheck={false}
              aria-invalid={!valid}
              className={cx(
                'vq-focus h-12 rounded-full border bg-vq-surface px-5 font-mono text-sm w-full',
                valid ? 'border-vq-border' : 'border-vq-err',
              )}
            />
          </label>
          <PrimaryButton type="submit" disabled={!valid || running}>{running ? 'Reading…' : 'Read balance'}</PrimaryButton>
        </form>
        {!valid && <p className="mt-2 text-sm text-vq-err">Enter a 20-byte hex address (0x + 40 characters).</p>}
      </Card>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-5 items-stretch">
        <PlainCard run={run} honest={honest} loading={running && !run} />
        <VeriqCard run={run} loading={running && !run} />
      </div>
      <AnimatePresence>
        {run && run.plain.ok && honest !== null && run.plain.value !== honest && (
          <motion.p
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="text-center text-vq-muted"
          >
            The provider proposes; the proof decides.
          </motion.p>
        )}
      </AnimatePresence>
    </Stagger>
  )
}
