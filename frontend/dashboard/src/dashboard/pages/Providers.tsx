import { Check, X } from 'lucide-react'
import type { ProviderHealth } from 'veriq-client'
import { useHealth } from '../lib/engine'
import { formatCountdown } from '../lib/format'
import { Card, Chip, EmptyState, ErrorCard, HeroPanel, SampleTag, Skeleton, Stagger, cx, useNow } from '../components/ui'

function Capability({ ok, label }: { ok: boolean; label: string }) {
  return (
    <li className="flex items-center justify-between py-2 border-b border-vq-border last:border-0 text-sm">
      <span className="text-vq-muted">{label}</span>
      <span className={cx('inline-flex items-center gap-1 font-medium', ok ? 'text-vq-ok' : 'text-vq-err')}>
        {ok ? <Check className="w-4 h-4" aria-hidden="true" /> : <X className="w-4 h-4" aria-hidden="true" />}
        {ok ? 'Yes' : 'No'}
      </span>
    </li>
  )
}

function Breaker({ p, now }: { p: ProviderHealth; now: number }) {
  const left = p.breaker.cooldownUntil != null ? p.breaker.cooldownUntil - now : 0
  if (p.breaker.state === 'closed') return <Chip tone="ok" dot="live">Breaker closed</Chip>
  if (p.breaker.state === 'half-open') return <Chip tone="warn" dot="warn">Half-open · probing</Chip>
  return (
    <Chip tone="err" dot="err" title={p.breaker.reason ?? undefined}>
      Cooling down {left > 0 ? <span className="font-mono tabular-nums">{formatCountdown(left)}</span> : 'ending'}
    </Chip>
  )
}

function ProviderCard({ p, now }: { p: ProviderHealth; now: number }) {
  const rate = p.successRate ?? null
  const eligible = p.chainOk && p.proofSupport && p.breaker.state === 'closed'
  return (
    <Card className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-2xl font-medium tracking-h3">{p.name}</h2>
          <div className={cx('text-sm mt-0.5', eligible ? 'text-vq-muted' : 'text-vq-err')}>{eligible ? 'Eligible for routing' : 'Not eligible'}</div>
        </div>
        <Chip tone={p.transport === 'anyone-socks' ? 'lav' : 'neutral'}>{p.transport}</Chip>
      </div>
      <div className="flex"><Breaker p={p} now={now} /></div>
      <ul>
        <Capability ok={p.chainOk} label="Chain ok (11155111)" />
        <Capability ok={p.proofSupport} label="eth_getProof" />
        <Capability ok={p.eip1898} label="EIP-1898 blockHash" />
      </ul>
      <div>
        <div className="flex justify-between text-sm mb-2">
          <span className="text-vq-muted">Success rate</span>
          <span className="font-medium tabular-nums">{rate != null ? `${(rate * 100).toFixed(1)}%` : '—'}</span>
        </div>
        <div className="h-2 rounded-full bg-vq-lav-100 overflow-hidden" role="meter" aria-valuemin={0} aria-valuemax={100} aria-valuenow={rate != null ? Math.round(rate * 100) : undefined} aria-label={`${p.name} success rate`}>
          <div className={cx('h-full rounded-full', rate != null && rate < 0.9 ? 'bg-vq-err' : 'bg-vq-lav-500')} style={{ width: `${(rate ?? 0) * 100}%` }} />
        </div>
      </div>
      <div className="text-sm">
        <div className="text-vq-muted mb-1">Last error</div>
        {p.lastError ? <p className="font-mono text-xs text-vq-err break-words">{p.lastError}</p> : <p className="text-vq-faint">None</p>}
      </div>
    </Card>
  )
}

export function ProvidersPage() {
  const health = useHealth()
  const now = useNow(1000)
  if (health.isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-5">
        {[0, 1, 2, 3].map((i) => <Skeleton key={i} className="h-80 !rounded-card" />)}
      </div>
    )
  }
  if (health.error) return <ErrorCard title="Couldn't load provider health" error={health.error} onRetry={() => void health.refetch()} />
  const providers = health.data?.data.providers ?? []
  const configured = Math.max(providers.length, health.data?.data.providerCount ?? 0)
  const eligible = providers.filter((p) => p.chainOk && p.proofSupport && p.breaker.state === 'closed').length
  const cooling = providers.filter((p) => p.breaker.state !== 'closed').length

  return (
    <Stagger className="space-y-5">
      <HeroPanel>
        <div className="flex flex-wrap items-end justify-between gap-6">
          <div>
            <div className="text-white/60 text-sm flex items-center gap-2">Routable right now {health.data?.source === 'mock' && <SampleTag className="!bg-white/10 !text-white" />}</div>
            <div className="mt-2 text-6xl font-medium tracking-hero tabular-nums">{providers.length ? eligible : '—'}<span className="text-white/40">/{configured}</span></div>
            <div className="text-white/60 mt-1">providers eligible for verified reads</div>
          </div>
          <p className="text-white/70 max-w-sm text-sm leading-relaxed">
            A provider that sends a bad proof cools down for 5 minutes. Three transport failures in a row: 30 seconds. {cooling > 0 && <span className="text-white">{cooling} cooling down now.</span>}
          </p>
        </div>
      </HeroPanel>
      {providers.length === 0 ? (
        <Card>
          {(health.data?.data.providerCount ?? 0) > 0 ? (
            <EmptyState
              title={`${health.data?.data.providerCount} providers configured`}
              body="This engine reports a provider count but not per-provider health (breakers, capabilities) yet."
            />
          ) : (
            <EmptyState title="No providers configured" body="Set VERIQ_PROVIDERS=name=url,name=url and restart the engine." />
          )}
        </Card>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 2xl:grid-cols-3 gap-5">
          {providers.map((p) => <ProviderCard key={p.name} p={p} now={now} />)}
        </div>
      )}
    </Stagger>
  )
}
