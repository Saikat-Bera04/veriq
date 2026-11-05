import { describe, expect, it } from 'vitest'
import { formatEth, formatReceipt, prettyReceipt, shortHash } from 'veriq-client'
import { ATTEMPTS, receiptFixture } from './helpers'

describe('formatEth', () => {
  it.each([
    [0n, '0 ETH'],
    [1n, '<0.0001 ETH'],
    [10n ** 18n, '1 ETH'],
    [1_234_500_000_000_000_000_000n, '1,234.5 ETH'],
    [421_337_000_000_000_000n, '0.4213 ETH'],
    ['0x1bc16d674ec80000', '2 ETH'],
  ])('%s -> %s', (wei, out) => {
    expect(formatEth(wei)).toBe(out)
  })

  it('respects decimals and symbol', () => {
    expect(formatEth(421_337_000_000_000_000n, { decimals: 2, symbol: false })).toBe('0.42')
  })
})

describe('shortHash', () => {
  it('middle-truncates', () => {
    expect(shortHash(`0x1234${'0'.repeat(56)}cdef`)).toBe('0x1234…cdef')
    expect(shortHash('0x12')).toBe('0x12')
  })
})

describe('receipt text', () => {
  const result = { receipt: receiptFixture(), value: 421_300_000_000_000_000n, attempts: ATTEMPTS }

  it('prettyReceipt without colour (NO_COLOR / non-TTY)', () => {
    expect(prettyReceipt(result, { color: false })).toMatchInlineSnapshot(`
      "╭─ Veriq · Trust Receipt ────────────────────────╮
      │ ● VERIFIED            0.4213 ETH               │
      │ block      #7,412,903  0x9a3f…c21e             │
      │ stateRoot  0x51be…07aa                         │
      │ root       local light client (Helios)         │
      │ provider   alchemy  ·  2 attempts  ·  184 ms   │
      │ rejected   infura-bad  INVALID_PROOF           │
      ╰────────────────────────────────────────────────╯"
    `)
  })

  it('NO_COLOR disables ANSI even when not forced', () => {
    const prev = process.env.NO_COLOR
    process.env.NO_COLOR = '1'
    expect(prettyReceipt(result)).not.toMatch(/\x1b\[/)
    if (prev === undefined) delete process.env.NO_COLOR
    else process.env.NO_COLOR = prev
  })

  it('uses 24-bit dashboard colours when enabled', () => {
    const out = prettyReceipt(result, { color: true })
    expect(out).toContain('\x1b[38;2;47;158;110m') // verified #2F9E6E
    expect(out).toContain('\x1b[38;2;194;65;91m') // error #C2415B
  })

  it('formatReceipt is plain text', () => {
    expect(formatReceipt(result).split('\n')[0]).toBe('VERIFIED  0.4213 ETH')
  })
})
