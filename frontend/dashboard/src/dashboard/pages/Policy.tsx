import { useState } from 'react'
import { Link } from 'react-router-dom'
import { VeriqError, verifiedFinalized, type Policy } from 'veriq-client'
import { readBalance, type ReadOutcome } from '../lib/engine'
import { DEMO_ADDRESS } from '../lib/mock'
import { formatEth } from '../lib/format'
import { AttemptsTimeline } from '../components/ReceiptDrawer'
import { Card, CardTitle, Chip, HeroPanel, PrimaryButton, SampleTag, Segmented, Skeleton, Stagger, cx } from '../components/ui'
import { ReceiptBadge } from 'veriq-client/react'

const same = (a: Policy, b: Policy) => (Object.keys(a) as (keyof Policy)[]).every((k) => a[k] === b[k])

function Result({ outcome }: { outcome: ReadOutcome }) {
  if (!outcome.ok) {
    const e = outcome.error
    const typed = e instanceof VeriqError
    return (
      <div role="alert">
        <div className="flex flex-wrap items-center gap-2">
          <ReceiptBadge size="lg" error={typed ? e : new VeriqError(-1, e.message)} />
          {typed && <span className="font-mono text-white/70">{e.code}</span>}
          {outcome.source === 'mock' && <SampleTag className="!bg-white/10 !text-white" />}
        </div>
        <p className="mt-5 text-xl md:text-2xl font-medium tracking-h3 leading-snug">
          {typed ? e.meaning : 'The engine could not be reached.'}
        </p>
        <p className="mt-2 text-sm font-mono text-white/60 break-words">engine: {e.message}</p>
        <p className="mt-4 text-sm text-white/60">Typed error, no value. Veriq never swaps in a weaker answer.</p>
      </div>
    )
  }
  const { value, receipt, attempts } = outcome.result
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <ReceiptBadge status={receipt.verification.status} size="lg" />
        {outcome.source === 'mock' && <SampleTag className="!bg-white/10 !text-white" />}
      </div>
      <div className="mt-5 text-5xl font-medium tracking-hero tabular-nums break-words">
        {formatEth(value)} <span className="text-2xl">ETH</span>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <Chip tone="dark">block #{receipt.block.number.toLocaleString('en-US')} {receipt.block.finalized ? '· finalized' : '· not finalized'}</Chip>
        <Chip tone="dark">{receipt.verification.rootSource}</Chip>
        <Chip tone="dark">comparison: {receipt.routing.comparison}</Chip>
      </div>
      {receipt.warnings.length > 0 && (
        <ul className="mt-4 space-y-1 text-sm">
          {receipt.warnings.map((w) => (
            <li key={w.code} className="text-[rgb(var(--vq-warn-bg))]"><span className="font-mono text-xs">{w.code}</span> — {w.message}</li>
          ))}
        </ul>
      )}
      <div className="mt-6">
        <div className="text-sm text-white/60 mb-3">Attempts</div>
        <AttemptsTimeline attempts={attempts} dark />
      </div>
      <Link
        to={`/app/feed?receipt=${encodeURIComponent(receipt.identity.requestId)}`}
        className="vq-focus inline-block mt-4 text-sm text-white/70 hover:text-white underline underline-offset-4 rounded"
      >
        Open the full Trust Receipt
      </Link>
    </div>
  )
}

export function PolicyPage() {
  const [policy, setPolicy] = useState<Policy>(verifiedFinalized)
  const [address, setAddress] = useState(DEMO_ADDRESS)
  const [outcome, setOutcome] = useState<ReadOutcome | null>(null)
  const [running, setRunning] = useState(false)
  const set = <K extends keyof Policy>(k: K) => (v: Policy[K]) => setPolicy((p) => ({ ...p, [k]: v }))
  const preset = same(policy, verifiedFinalized)

  const run = async () => {
    setRunning(true)
    // No client-side validation: contradictory policies go to the engine, which answers POLICY_UNSATISFIABLE.
    setOutcome(await readBalance(address.trim(), policy))
    setRunning(false)
  }

  return (
    <Stagger className="grid grid-cols-1 xl:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] gap-5">
      <Card>
        <CardTitle
          aside={
            <button
              type="button"
              aria-pressed={preset}
              onClick={() => setPolicy(verifiedFinalized)}
              className={cx(
                'vq-focus h-8 px-4 rounded-full text-sm font-medium border transition-colors',
                preset ? 'bg-vq-lav-100 border-vq-lav-300 text-vq-lav-700' : 'bg-vq-surface border-vq-border text-vq-muted hover:text-vq-ink',
              )}
            >
              verifiedFinalized
            </button>
          }
        >
          Policy
        </CardTitle>
        <form
          className="space-y-6"
          onSubmit={(e) => {
            e.preventDefault()
            void run()
          }}
        >
          <Segmented name="verification" label="Verification" options={['required', 'preferred', 'disabled'] as const} value={policy.verification} onChange={set('verification')} />
          <Segmented name="privacy" label="Privacy" options={['required', 'preferred', 'off'] as const} value={policy.privacy} onChange={set('privacy')} />
          <Segmented name="consistency" label="Consistency" options={['single', 'compare'] as const} value={policy.consistency} onChange={set('consistency')} />
          <Segmented name="blockPolicy" label="Block policy" options={['finalized', 'latest'] as const} value={policy.blockPolicy} onChange={set('blockPolicy')} />
          <label className="block">
            <span className="flex justify-between text-sm text-vq-muted mb-2">
              <span>Timeout (one deadline for all attempts)</span>
              <span className="font-mono text-vq-ink">{(policy.timeoutMs / 1000).toFixed(1)} s</span>
            </span>
            <input
              type="range"
              min={1000}
              max={15000}
              step={500}
              value={policy.timeoutMs}
              onChange={(e) => set('timeoutMs')(Number(e.target.value))}
              className="vq-focus w-full accent-[rgb(var(--vq-lavender-700))]"
            />
          </label>
          <label className="flex flex-col gap-1.5">
            <span className="text-sm text-vq-muted">Address</span>
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              spellCheck={false}
              className="vq-focus h-12 rounded-full border border-vq-border bg-vq-surface px-5 font-mono text-sm w-full"
            />
          </label>
          <PrimaryButton type="submit" disabled={running}>{running ? 'Reading…' : 'Run'}</PrimaryButton>
        </form>
      </Card>

      <div className="space-y-5 min-w-0">
        <HeroPanel className="min-h-[360px]">
          {running ? (
            <div className="space-y-4">
              <Skeleton className="h-10 w-40 !bg-white/10" />
              <Skeleton className="h-14 w-64 !bg-white/10" />
              <Skeleton className="h-32 w-full !bg-white/10" />
            </div>
          ) : outcome ? (
            <Result outcome={outcome} />
          ) : (
            <div>
              <div className="text-white/60 text-sm">Result</div>
              <p className="mt-3 text-2xl md:text-3xl font-medium tracking-hero leading-snug max-w-md">
                Pick a policy and run a read. You get a receipt, or a typed error. Never a guess.
              </p>
            </div>
          )}
        </HeroPanel>
        <Card>
          <CardTitle>Sent to the engine</CardTitle>
          <pre className="text-xs font-mono bg-vq-bg border border-vq-border rounded-xl p-4 overflow-auto">
            {JSON.stringify({ method: 'veriq_readBalance', params: [address.trim(), policy] }, null, 2)}
          </pre>
        </Card>
      </div>
    </Stagger>
  )
}
