export const WEI_PER_ETH = 10n ** 18n

export function toBigInt(value: string | bigint | null | undefined): bigint | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'bigint') return value
  try {
    return BigInt(value)
  } catch {
    return null
  }
}

/** Wei -> "1,002.5" ETH string, trimmed to at most `digits` decimals. */
export function formatEth(value: string | bigint | null | undefined, digits = 4): string {
  const wei = toBigInt(value)
  if (wei === null) return '—'
  const neg = wei < 0n
  const abs = neg ? -wei : wei
  const whole = abs / WEI_PER_ETH
  const frac = abs % WEI_PER_ETH
  let fracStr = frac.toString().padStart(18, '0').slice(0, digits).replace(/0+$/, '')
  if (fracStr === '' ) fracStr = '0'
  return `${neg ? '-' : ''}${whole.toLocaleString('en-US')}.${fracStr}`
}

export function truncateMiddle(value: string, head = 6, tail = 4): string {
  if (value.length <= head + tail + 1) return value
  return `${value.slice(0, head)}…${value.slice(-tail)}`
}

export function formatTime(ms: number): string {
  return new Date(ms).toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', second: '2-digit' })
}

export function timeAgo(ms: number, now = Date.now()): string {
  const s = Math.max(0, Math.round((now - ms) / 1000))
  if (s < 5) return 'just now'
  if (s < 60) return `${s}s ago`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ago`
  const h = Math.floor(m / 60)
  if (h < 24) return `${h}h ago`
  return `${Math.floor(h / 24)}d ago`
}

export function formatCountdown(msLeft: number): string {
  const s = Math.max(0, Math.ceil(msLeft / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

export function formatNumber(n: number): string {
  return n.toLocaleString('en-US')
}

export function methodLabel(method: string): string {
  return method.replace(/^veriq_/, '').replace(/^eth_/, 'eth_')
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2)
}
