import { useMemo } from 'react'
import { TriangleAlert } from 'lucide-react'
import { useHealth, useReceipts } from '../lib/engine'
import { formatNumber, timeAgo } from '../lib/format'
import { Card, CardTitle, Chip, EmptyState, ErrorCard, Hash, HeroPanel, Label, SampleTag, Skeleton, Stagger, TickingNumber, useNow } from '../components/ui'

export function FinalizedExplainer() {
  return (
    <Card className="bg-vq-lav-100/60 border-vq-lav-300/60">
      <h2 className="text-xl font-medium tracking-h3">Why finalized?</h2>
      <p className="mt-2 text-vq-muted leading-relaxed">
        Finalized blocks trail the head by about two epochs (~12.8 min) but can't be reorged, so a proof against them stays true.
      </p>
    </Card>
  )
}

export function LightClientPage() {
  const health = useHealth()
  const receipts = useReceipts()
  const now = useNow(1000)
  const h = health.data?.data
  const lc = h?.lightClient

  // Last 20 finalized blocks seen in receipts, plus the current one from /health.
  const blocks = useMemo(() => {
    const map = new Map<number, string>()
    if (lc?.finalizedNumber != null && lc.finalizedHash) map.set(lc.finalizedNumber, lc.finalizedHash)
    for (const r of receipts.data?.data ?? []) {
      if (r.receipt?.block.finalized) map.set(r.receipt.block.number, r.receipt.block.hash)
    }
    return [...map.entries()].sort((a, b) => b[0] - a[0]).slice(0, 20)
  }, [receipts.data, lc?.finalizedNumber, lc?.finalizedHash])

  if (health.isLoading) {
    return (
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Skeleton className="h-64 lg:col-span-2 !rounded-card" />
        <Skeleton className="h-64 !rounded-card" />
      </div>
    )
  }
  if (health.error || !h || !lc) return <ErrorCard title="Couldn't load light-client status" error={health.error ?? 'No status'} onRetry={() => void health.refetch()} />

  const dev = h.devMode || h.rootSource === 'untrusted-rpc'
  const lag = lc.finalizedNumber != null && lc.headNumber != null ? lc.headNumber - lc.finalizedNumber : null
  const updatedMs = lc.lastUpdateUnix != null ? lc.lastUpdateUnix * 1000 : null

  return (
    <Stagger className="space-y-5">
      {dev && (
        <div role="alert" className="flex items-start gap-3 rounded-card bg-vq-warn-bg text-vq-warn border-2 border-vq-warn/40 px-6 py-5">
          <TriangleAlert className="w-6 h-6 shrink-0" aria-hidden="true" />
          <div>
            <div className="text-xl font-semibold tracking-h3">DEV MODE — receipts are unverified</div>
            <p className="text-vq-ink/70 text-sm mt-1">The state root comes from an RPC provider, not the light client. Never use this outside local development.</p>
          </div>
        </div>
      )}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <HeroPanel image className="lg:col-span-2">
          <div className="flex flex-wrap items-center gap-2">
            <Chip tone="dark" dot={lc.synced ? 'live' : 'off'}>{lc.synced ? 'Synced' : 'Not synced'}</Chip>
            <Chip tone="dark">{h.rootSource ?? 'No root source'}</Chip>
            {health.data?.source === 'mock' && <SampleTag className="!bg-white/10 !text-white" />}
          </div>
          <div className="mt-8 text-white/60 text-sm">Finalized block</div>
          <div className="text-5xl md:text-7xl font-medium tracking-hero leading-none mt-2">
            {lc.finalizedNumber != null ? <TickingNumber value={`#${formatNumber(lc.finalizedNumber)}`} /> : '—'}
          </div>
          {lc.finalizedHash && (
            <div className="mt-4 [&_button]:text-white/80 [&_button:hover]:bg-white/10">
              <Hash value={lc.finalizedHash} head={12} tail={10} />
            </div>
          )}
        </HeroPanel>
        <Card className="flex flex-col gap-5">
          <div>
            <Label>Head lag</Label>
            <div className="text-3xl font-medium tracking-hero mt-1 tabular-nums">{lag != null ? `${lag} blocks` : '—'}</div>
            <div className="text-sm text-vq-muted">{lag != null ? `≈ ${((lag * 12) / 60).toFixed(1)} min behind head` : 'Head number not reported'}</div>
          </div>
          <div>
            <Label>Last update</Label>
            <div className="font-medium mt-1">{updatedMs ? timeAgo(updatedMs, now) : '—'}</div>
            {lc.lagSeconds != null && <div className="text-sm text-vq-muted">root age {lc.lagSeconds}s</div>}
          </div>
          <div>
            <Label>Checkpoint root</Label>
            <div className="mt-1">{lc.checkpoint ? <Hash value={lc.checkpoint} head={10} tail={8} /> : '—'}</div>
            <div className="text-sm text-vq-muted mt-1 break-words">{lc.checkpointSource ?? 'source not reported'}</div>
          </div>
        </Card>
      </div>
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-5">
        <Card className="lg:col-span-2">
          <CardTitle>Last 20 finalized blocks</CardTitle>
          {blocks.length === 0 ? (
            <EmptyState title="No finalized blocks yet" body="The light client hasn't reported a finalized block." />
          ) : (
            <ol className="relative">
              {blocks.map(([n, hash], i) => (
                <li key={n} className="flex items-center gap-4 py-2">
                  <span className="relative flex flex-col items-center self-stretch w-3" aria-hidden="true">
                    <span className={i === 0 ? 'w-3 h-3 rounded-full bg-vq-lav-700 ring-4 ring-vq-lav-100 mt-1.5' : 'w-2 h-2 rounded-full bg-vq-lav-300 mt-2'} />
                    {i < blocks.length - 1 && <span className="flex-1 w-px bg-vq-border" />}
                  </span>
                  <span className="font-mono text-sm w-28 shrink-0">#{formatNumber(n)}</span>
                  <span className="min-w-0 truncate"><Hash value={hash} head={10} tail={6} /></span>
                  {i === 0 && <Chip tone="lav" className="ml-auto hidden sm:inline-flex">latest</Chip>}
                </li>
              ))}
            </ol>
          )}
        </Card>
        <FinalizedExplainer />
      </div>
    </Stagger>
  )
}
