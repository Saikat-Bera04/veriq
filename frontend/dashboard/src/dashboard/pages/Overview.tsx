import { useMemo } from 'react'
import { Link } from 'react-router-dom'
import { ArrowUpRight, Gauge, Layers, Server, ShieldAlert, ShieldX } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import type { ReceiptRecord } from 'veriq-client'
import { errorNameForCode } from 'veriq-client'
import {
  DEMO_CONTRACT_ADDRESS,
  DEMO_CONTRACT_SLOT,
  useDemoContractStorage,
  useHealth,
  useReceipts,
} from '../lib/engine'
import { transportLabel } from '../lib/anon'
import { formatNumber, median, timeAgo } from '../lib/format'
import { ReadsChart } from '../components/ReadsChart'
import { Card, CardTitle, EmptyState, ErrorCard, HeroPanel, PrimaryLink, SampleTag, Skeleton, Stagger, useNow } from '../components/ui'

const DAY = 24 * 60 * 60_000

function Kpi({ label, value, sub, Icon, loading }: { label: string; value: string; sub?: string; Icon: LucideIcon; loading: boolean }) {
  return (
    <Card className="flex flex-col gap-4 !p-6">
      <div className="flex items-center justify-between">
        <span className="text-sm text-vq-muted">{label}</span>
        <span className="w-9 h-9 rounded-full bg-vq-lav-100 text-vq-lav-700 flex items-center justify-center">
          <Icon className="w-4 h-4" aria-hidden="true" />
        </span>
      </div>
      {loading ? (
        <Skeleton className="h-9 w-24" />
      ) : (
        <div>
          <div className="text-3xl font-medium tracking-hero tabular-nums">{value}</div>
          {sub && <div className="text-sm text-vq-muted mt-1">{sub}</div>}
        </div>
      )}
    </Card>
  )
}

interface Rejection {
  record: ReceiptRecord
  provider: string
  reason: string
  detail?: string | null
}

function rejectionsOf(records: ReceiptRecord[]): Rejection[] {
  const out: Rejection[] = []
  for (const r of records) {
    if (r.error) {
      out.push({ record: r, provider: 'engine', reason: errorNameForCode(r.error.code) ?? `code ${r.error.code}`, detail: r.error.message })
    }
    for (const a of r.attempts) {
      if (a.outcome === 'ok') continue
      const wrongBlock = a.reason?.toLowerCase().includes('wrong block')
      out.push({ record: r, provider: a.provider, reason: wrongBlock ? `${a.outcome} · wrong block` : a.outcome, detail: a.reason })
    }
  }
  return out
}

export function OverviewPage() {
  const now = useNow(5000)
  const health = useHealth()
  const receipts = useReceipts()
  const contractStorage = useDemoContractStorage()
  const mock = health.data?.source === 'mock'
  const storageOutcome = contractStorage.data
  const storageResult = storageOutcome?.ok ? storageOutcome.result : null
  const storageVerified = storageResult?.verified === true
  const storageValue = storageVerified ? BigInt(storageResult.value).toString(10) : null

  const stats = useMemo(() => {
    const records = (receipts.data?.data ?? []).filter((r) => r.createdAt >= now - DAY)
    const verified = records.filter((r) => r.receipt?.verification.status === 'verified').length
    const attempts = records.flatMap((r) => r.attempts)
    const invalid = attempts.filter((a) => a.outcome === 'INVALID_PROOF').length
    const otherFailures = attempts.filter((a) => a.outcome !== 'ok' && a.outcome !== 'INVALID_PROOF').length
    const latency = median(records.filter((r) => r.receipt).map((r) => r.attempts.reduce((s, a) => s + a.elapsedMs, 0)))
    return { records, verified, invalid, otherFailures, latency, pct: records.length ? (verified / records.length) * 100 : 0 }
  }, [receipts.data, now])

  const rejections = useMemo(() => rejectionsOf(receipts.data?.data ?? []).slice(0, 6), [receipts.data])

  const h = health.data?.data
  const providersOk = h?.providers.filter((p) => p.chainOk && p.proofSupport && p.breaker.state === 'closed').length ?? 0
  const fin = h?.lightClient.finalizedNumber
  const head = h?.lightClient.headNumber
  const lag = fin != null && head != null ? head - fin : null
  const loading = receipts.isLoading || health.isLoading

  if (receipts.error) {
    return <ErrorCard title="Couldn't load receipts" error={receipts.error} onRetry={() => void receipts.refetch()} />
  }

  return (
    <Stagger className="grid grid-cols-1 xl:grid-cols-3 gap-4 md:gap-5">
      <HeroPanel image className="xl:col-span-3 min-h-[260px] flex flex-col">
        <div className="flex items-center gap-2 text-white/60 text-sm">
          Last 24 hours {mock && <SampleTag className="!bg-white/10 !text-white" />}
        </div>
        <h2 className="mt-3 text-3xl md:text-5xl font-medium tracking-hero leading-tight">Every read verified</h2>
        <div className="mt-auto pt-8 flex flex-wrap items-end gap-x-10 gap-y-4">
          <div>
            {loading ? <Skeleton className="h-16 w-40 !bg-white/10" /> : (
              <div className="text-6xl md:text-7xl font-medium tracking-hero tabular-nums leading-none">{formatNumber(stats.verified)}</div>
            )}
            <div className="text-white/60 mt-2">verified reads</div>
          </div>
          <div>
            <div className="text-3xl font-medium tracking-hero tabular-nums">{loading ? '—' : `${stats.pct.toFixed(1)}%`}</div>
            <div className="text-white/60 mt-1">of {formatNumber(stats.records.length)} reads proven</div>
          </div>
        </div>
      </HeroPanel>

      <div className="xl:col-span-3 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 md:gap-5">
        <Kpi Icon={ShieldX} label="Proofs rejected" loading={loading} value={formatNumber(stats.invalid)} sub={stats.otherFailures ? `+ ${stats.otherFailures} transport failures` : 'INVALID_PROOF, 24h'} />
        <Kpi Icon={Server} label="Providers healthy" loading={loading} value={h ? `${providersOk}/${h.providers.length}` : '—'} sub="chain ok, proofs, breaker closed" />
        <Kpi
          Icon={Layers}
          label="Finalized block"
          loading={loading}
          value={fin != null ? `#${formatNumber(fin)}` : '—'}
          sub={lag != null ? `${lag} blocks (~${((lag * 12) / 60).toFixed(1)} min) behind head` : 'head lag unknown'}
        />
        <Kpi Icon={Gauge} label="Median latency" loading={loading} value={stats.latency != null ? `${stats.latency} ms` : '—'} sub="all attempts, per read" />
      </div>

      <Card className="xl:col-span-3">
        <CardTitle
          aside={
            <button
              type="button"
              onClick={() => void contractStorage.refetch()}
              disabled={contractStorage.isFetching}
              className="vq-focus rounded-full border border-vq-border px-4 py-2 text-sm text-vq-ink hover:border-vq-lav-300 disabled:opacity-50"
            >
              {contractStorage.isFetching ? 'Reading…' : 'Read again'}
            </button>
          }
        >
          Deployed contract storage
        </CardTitle>
        <div className="grid gap-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.4fr)] md:items-center">
          <div className="min-w-0">
            <div className="text-sm text-vq-muted">DemoStorage.counter · storage slot {DEMO_CONTRACT_SLOT}</div>
            <code className="mt-2 block break-all text-sm text-vq-ink">{DEMO_CONTRACT_ADDRESS}</code>
          </div>
          <div className="min-w-0 border-t border-vq-border pt-5 md:border-l md:border-t-0 md:pl-6 md:pt-0">
            {contractStorage.isLoading ? (
              <Skeleton className="h-12 w-40" />
            ) : storageVerified && storageResult ? (
              <div role="status" aria-live="polite">
                <div className="text-3xl font-medium tabular-nums tracking-hero">{storageValue}</div>
                <div className="mt-1 text-sm text-vq-muted">
                  Verified storage value · block #{formatNumber(storageResult.receipt.block.number)}
                </div>
                <div className="mt-1 text-sm text-vq-muted" data-testid="storage-transport">
                  Fetched via {transportLabel(storageResult.receipt.privacy)}
                </div>
                <Link
                  to={`/app/feed?receipt=${encodeURIComponent(storageResult.receipt.identity.requestId)}`}
                  className="vq-focus mt-2 inline-flex items-center gap-1 rounded text-sm text-vq-muted underline underline-offset-4 hover:text-vq-ink"
                >
                  Open proof receipt <ArrowUpRight className="h-3.5 w-3.5" aria-hidden="true" />
                </Link>
              </div>
            ) : storageOutcome && !storageOutcome.ok ? (
              <p role="alert" className="text-sm text-vq-err">
                No contract value shown. Verified storage read failed: {storageOutcome.error.message}
              </p>
            ) : storageResult ? (
              <p role="alert" className="text-sm text-vq-err">
                No contract value shown. The engine did not verify this storage proof.
              </p>
            ) : (
              <p role="status" className="text-sm text-vq-muted">
                Waiting for a live verified storage read. Sample data is never used for this contract.
              </p>
            )}
          </div>
        </div>
      </Card>

      <Card className="xl:col-span-3">
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-semibold bg-amber-500/10 text-amber-600 border border-amber-500/30">
                <ShieldAlert className="w-3.5 h-3.5" />
                EIP-7702 Guard
              </span>
              <span className="text-xs text-vq-muted">Pectra Delegation Security</span>
            </div>
            <h3 className="text-lg font-medium text-vq-ink">
              Live Wallet Delegation Inspection
            </h3>
            <p className="text-sm text-vq-muted max-w-2xl">
              Detect active delegation designators (<code className="text-xs font-mono bg-vq-surface px-1 py-0.5 rounded border border-vq-border">0xef0100 || address</code>) with state proof verification. Stop malicious RPCs from hiding swept EOAs or hijacked smart wallets.
            </p>
          </div>
          <Link
            to="/app/delegation-guard"
            className="vq-focus inline-flex items-center justify-center gap-2 px-5 py-2.5 rounded-full bg-vq-black text-white text-sm font-medium hover:bg-black/80 transition-colors shrink-0"
          >
            Launch Guard <ArrowUpRight className="w-4 h-4" />
          </Link>
        </div>
      </Card>

      <Card className="xl:col-span-2">
        <CardTitle>Reads per 5 minutes</CardTitle>
        {loading ? <Skeleton className="h-60 w-full" /> : stats.records.length === 0 ? (
          <EmptyState title="No reads yet" body="Send a veriq_readBalance to the engine and it shows up here." />
        ) : (
          <ReadsChart records={stats.records} now={now} />
        )}
      </Card>

      <Card>
        <CardTitle aside={<Link to="/app/feed" className="vq-focus text-sm text-vq-muted hover:text-vq-ink rounded">Live feed →</Link>}>
          Latest rejections
        </CardTitle>
        {loading ? (
          <div className="space-y-3">{[0, 1, 2].map((i) => <Skeleton key={i} className="h-14 w-full" />)}</div>
        ) : rejections.length === 0 ? (
          <EmptyState title="Nothing rejected" body="Every provider has told the truth so far. Try the attack lab." action={<PrimaryLink href="/app/attack-lab">Attack lab</PrimaryLink>} />
        ) : (
          <ul className="divide-y divide-vq-border -my-2">
            {rejections.map((rj, i) => (
              <li key={`${rj.record.id}-${i}`}>
                <Link
                  to={`/app/feed?receipt=${encodeURIComponent(rj.record.id)}`}
                  className="vq-focus group flex items-center gap-3 py-3 rounded-lg"
                >
                  <span className="w-2 h-2 rounded-full bg-vq-err shrink-0" aria-hidden="true" />
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-baseline gap-x-2">
                      <span className="font-medium">{rj.provider}</span>
                      <span className="font-mono text-xs text-vq-err">{rj.reason}</span>
                    </div>
                    {rj.detail && <div className="text-xs text-vq-muted truncate">{rj.detail}</div>}
                  </div>
                  <span className="text-xs text-vq-muted whitespace-nowrap">{timeAgo(rj.record.createdAt, now)}</span>
                  <ArrowUpRight className="w-4 h-4 text-vq-faint group-hover:text-vq-ink" aria-label="Open receipt" />
                </Link>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </Stagger>
  )
}
