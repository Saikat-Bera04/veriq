// @vitest-environment happy-dom
// Every README example lives in examples/ and runs here against a mocked engine.
import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { happyEngine, mockEngine } from './helpers'

let engine: ReturnType<typeof mockEngine>
beforeEach(() => {
  engine = mockEngine(happyEngine)
  vi.stubGlobal('fetch', engine.fetch)
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('examples', () => {
  it('read-balance.ts prints the value and "verified"', async () => {
    const log = vi.spyOn(console, 'log').mockImplementation(() => {})
    const { main } = await import('../examples/read-balance')
    await main()
    expect(log).toHaveBeenCalledWith(2_000_000_000_000_000_000n, 'verified')
  })

  it('viem-transport.ts reads through viem and keeps the receipt', async () => {
    vi.spyOn(console, 'log').mockImplementation(() => {})
    const { main, transport } = await import('../examples/viem-transport')
    expect(await main()).toBe(2_000_000_000_000_000_000n)
    expect(transport.lastReceipt?.verification.status).toBe('verified')
  })

  it('react-wallet.tsx renders the verified balance', async () => {
    const { WalletCard } = await import('../examples/react-wallet')
    render(<WalletCard address="0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045" />)
    expect(await screen.findByText('2 ETH')).toBeTruthy()
  })
})
