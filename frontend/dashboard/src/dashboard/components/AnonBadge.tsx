import { EyeOff, Radio } from 'lucide-react'
import { anonNetwork, isAnonAvailable, setAnonMode, useAnonMode, useAnonStatus, type AnonMode, type AnonStatus } from '../lib/anon'
import { Chip } from './ui'

const MAX_REASON = 80

/** The badge text: the state is in words, never only in the dot's colour. */
export function anonBadgeLabel(mode: AnonMode, status: AnonStatus): string {
  if (mode === 'direct') return 'Direct mode'
  if (status.state === 'ready') return `Anon-RPC: ready (${anonNetwork()})`
  if (status.state === 'failed') {
    const reason = (status.error?.message ?? 'unknown error').replace(/^(Could not join the Nox mixnet|Could not start private reads over [^:]+): /, '')
    return `Anon-RPC: failed — ${reason.length > MAX_REASON ? `${reason.slice(0, MAX_REASON)}…` : reason}`
  }
  return 'Anon-RPC: connecting…' // idle only for the instant before startAnon runs
}

/** Read-path badge and private/direct switch, in the dashboard header. */
export function AnonBadge() {
  const mode = useAnonMode()
  const status = useAnonStatus()
  const label = anonBadgeLabel(mode, status)
  const tone = mode === 'direct' ? 'neutral' : status.state === 'ready' ? 'ok' : status.state === 'failed' ? 'err' : 'lav'
  const dot = mode === 'direct' ? 'off' : status.state === 'ready' ? 'live' : status.state === 'failed' ? 'err' : 'warn'
  const next: AnonMode = mode === 'direct' ? 'private' : 'direct'
  return (
    <div className="flex items-center gap-2">
      <span role="status" aria-live="polite" data-anon-state={mode === 'direct' ? 'direct' : status.state}>
        <Chip tone={tone} dot={dot} title={status.error?.message}>
          {mode === 'direct' ? <EyeOff className="w-3.5 h-3.5" aria-hidden="true" /> : <Radio className="w-3.5 h-3.5" aria-hidden="true" />}
          {label}
        </Chip>
      </span>
      {isAnonAvailable() && (
        <button
          type="button"
          className="vq-focus text-sm text-vq-muted hover:text-vq-ink underline underline-offset-4 rounded px-1"
          aria-pressed={mode === 'direct'}
          onClick={() => setAnonMode(next)}
        >
          {mode === 'direct' ? 'Use Anon-RPC' : 'Use direct'}
        </button>
      )}
    </div>
  )
}
