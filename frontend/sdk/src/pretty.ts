import { healthRows, receiptRows, type ReceiptInput, type RowTone } from './format'
import type { EngineHealth } from './types'
import type { VeriqError } from './errors'

// Dashboard palette as 24-bit ANSI. "ink" uses the terminal's own foreground so it reads on light and dark themes.
const PALETTE: Record<RowTone | 'border' | 'title', [number, number, number] | null> = {
  ink: null,
  muted: [0x5b, 0x5b, 0x66],
  lav: [0x9c, 0x95, 0xd6],
  border: [0x9c, 0x95, 0xd6],
  title: [0x6b, 0x62, 0xb5],
  ok: [0x2f, 0x9e, 0x6e],
  warn: [0xb7, 0x79, 0x1f],
  err: [0xc2, 0x41, 0x5b],
}

export interface PrettyOptions {
  /** Force colours on/off. Default: on for a TTY unless NO_COLOR is set. */
  color?: boolean
}

function env(name: string): string | undefined {
  const p = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
  return p?.env?.[name]
}

/** Colours on only for an interactive terminal without NO_COLOR. */
export function supportsColor(): boolean {
  if (env('NO_COLOR') !== undefined) return false
  if (env('FORCE_COLOR') !== undefined) return true
  const p = (globalThis as { process?: { stdout?: { isTTY?: boolean } } }).process
  return p?.stdout?.isTTY === true
}

function painter(on: boolean) {
  return (tone: keyof typeof PALETTE, text: string, bold = false): string => {
    const rgb = PALETTE[tone]
    if (!on || (!rgb && !bold)) return text
    return `${bold ? '\x1b[1m' : ''}${rgb ? `\x1b[38;2;${rgb[0]};${rgb[1]};${rgb[2]}m` : ''}${text}\x1b[0m`
  }
}

interface Line {
  plain: string
  painted: string
}

function box(title: string, lines: Line[], paint: ReturnType<typeof painter>): string {
  const width = Math.max(title.length + 6, ...lines.map((l) => l.plain.length)) + 4
  const top = `${paint('border', '╭─ ')}${paint('title', title, true)}${paint('border', ` ${'─'.repeat(width - title.length - 3)}╮`)}`
  const body = lines.map((l) => `${paint('border', '│')} ${l.painted}${' '.repeat(width - l.plain.length - 1)}${paint('border', '│')}`)
  const bottom = paint('border', `╰${'─'.repeat(width)}╯`)
  return [top, ...body, bottom].join('\n')
}

const LABEL = 11

/**
 * The receipt as a rounded box in the dashboard colours. Plain text for NO_COLOR / non-TTY.
 * @example console.log(prettyReceipt(await veriq.readBalance({ address })))
 */
export function prettyReceipt(input: ReceiptInput, opts: PrettyOptions = {}): string {
  const paint = painter(opts.color ?? supportsColor())
  const { status, value, rows } = receiptRows(input)
  const tone: RowTone = status === 'verified' ? 'ok' : status === 'unverified' ? 'warn' : 'lav'
  const head = `● ${status.toUpperCase()}`
  const gap = ' '.repeat(Math.max(2, 22 - head.length))
  const lines: Line[] = [
    { plain: `${head}${gap}${value}`, painted: `${paint(tone, head, true)}${gap}${paint('ink', value, true)}` },
    ...rows.map((r) => ({
      plain: `${r.label.padEnd(LABEL)}${r.value}`,
      painted: `${paint('muted', r.label.padEnd(LABEL))}${paint(r.tone ?? 'ink', r.value)}`,
    })),
  ]
  return box('Veriq · Trust Receipt', lines, paint)
}

/**
 * Engine, light client and provider table for `veriq health`.
 * @example console.log(prettyHealth(await veriq.health()))
 */
export function prettyHealth(health: EngineHealth, opts: PrettyOptions = {}): string {
  const paint = painter(opts.color ?? supportsColor())
  const { engine, providers } = healthRows(health)
  const lines: Line[] = engine.map((r) => ({
    plain: `${r.label.padEnd(LABEL)}${r.value}`,
    painted: `${paint('muted', r.label.padEnd(LABEL))}${paint(r.tone ?? 'ink', r.value)}`,
  }))
  const header = ['provider', 'chain', 'proof', '1898', 'breaker', 'transport']
  const widths = header.map((h, i) => Math.max(h.length, ...providers.map((p) => (p[i] ?? '').length)) + 2)
  const fmt = (cells: string[]) => cells.map((c, i) => c.padEnd(widths[i] ?? 0)).join('').trimEnd()
  if (providers.length === 0) return box('Veriq · Engine health', lines, paint)
  lines.push({ plain: '', painted: '' })
  lines.push({ plain: fmt(header), painted: paint('muted', fmt(header)) })
  for (const p of providers) {
    const plain = fmt(p)
    const bad = p[1] === 'no' || p[2] === 'no' || p[4] !== 'closed'
    lines.push({ plain, painted: paint(bad ? 'err' : 'ink', plain) })
  }
  return box('Veriq · Engine health', lines, paint)
}

/**
 * Error name, code and hint, in the error colour.
 * @example console.error(prettyError(err))
 */
export function prettyError(err: VeriqError, opts: PrettyOptions = {}): string {
  const paint = painter(opts.color ?? supportsColor())
  return `${paint('err', `✕ ${err.name} [${err.code} ${err.codeName}]`, true)}\n  ${err.message}\n  ${paint('muted', `→ ${err.hint}`)}`
}
