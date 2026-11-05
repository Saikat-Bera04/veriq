// @vitest-environment happy-dom
import { act, cleanup, fireEvent, render, renderHook, screen, waitFor } from '@testing-library/react'
import { afterEach, describe, expect, it, vi } from 'vitest'
import type { ReactNode } from 'react'
import { createVeriq, errorFromRpc } from 'veriq-client'
import { EngineStatus, ReceiptBadge, ReceiptCard, VerifiedValue, VeriqProvider, useVeriqHealth } from 'veriq-client/react'
import { ADDRESS, ATTEMPTS, happyEngine, healthFixture, mockEngine, receiptFixture } from './helpers'

afterEach(() => {
  cleanup()
  vi.useRealTimers()
})

const wrap = (fetch: typeof globalThis.fetch) => {
  const client = createVeriq({ fetch })
  return ({ children }: { children?: ReactNode }) => <VeriqProvider client={client}>{children}</VeriqProvider>
}

describe('ReceiptBadge', () => {
  it.each([
    ['verified', 'vq-badge--verified', 'Verified'],
    ['unverified', 'vq-badge--unverified', 'Unverified'],
    ['unsupported', 'vq-badge--unsupported', 'Unsupported'],
  ] as const)('%s uses %s', (status, cls, label) => {
    render(<ReceiptBadge status={status} data-testid="b" />)
    const el = screen.getByTestId('b')
    expect(el.className).toContain(cls)
    expect(el.textContent).toBe(label)
  })

  it('error variant shows the code name', () => {
    render(<ReceiptBadge error={errorFromRpc({ code: -32010, message: 'x' })} data-testid="b" />)
    expect(screen.getByTestId('b').className).toContain('vq-badge--error')
    expect(screen.getByTestId('b').textContent).toBe('INVALID_PROOF')
  })
})

describe('VerifiedValue', () => {
  it('shows a skeleton, then the proven value with a verified badge, and opens the receipt', async () => {
    const { fetch } = mockEngine(happyEngine)
    const { container } = render(<VerifiedValue address={ADDRESS} />, { wrapper: wrap(fetch) })
    expect(container.querySelector('.vq-skeleton')).not.toBeNull()
    await screen.findByText('2 ETH')
    expect(container.querySelector('.vq-badge--verified')).not.toBeNull()
    fireEvent.click(screen.getByRole('button', { expanded: false }))
    expect(screen.getByRole('dialog', { name: 'Trust receipt' })).toBeTruthy()
    expect(screen.getByText('infura-bad')).toBeTruthy()
  })

  it('shows the error name and hint on failure', async () => {
    const { fetch } = mockEngine(() => ({ error: { code: -32011, message: 'not synced' } }))
    render(<VerifiedValue address={`0x${'2'.repeat(40)}`} />, { wrapper: wrap(fetch) })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('RootUnavailableError')
    expect(alert.textContent).toContain("The light client hasn't synced a finalized root yet.")
  })
})

describe('ReceiptCard', () => {
  it('renders sections, rejected attempts in the error style, and the download pill', () => {
    const { container } = render(<ReceiptCard receipt={receiptFixture()} value={2n * 10n ** 18n} attempts={ATTEMPTS} />)
    expect(screen.getByText('2 ETH')).toBeTruthy()
    expect(container.querySelectorAll('.vq-attempt--rejected')).toHaveLength(1)
    expect(screen.getByText('local light client (Helios)')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Download receipt.json/ })).toBeTruthy()
  })
})

describe('EngineStatus', () => {
  it('controlled: online, offline and dev mode', () => {
    const { rerender } = render(<EngineStatus health={healthFixture()} />)
    expect(screen.getByRole('status').textContent).toBe('Engine online · 127.0.0.1:8547')
    rerender(<EngineStatus health={healthFixture({ rootSource: 'untrusted-rpc' })} />)
    expect(screen.getByText('DEV MODE — unverified')).toBeTruthy()
    rerender(<EngineStatus health={null} />)
    expect(screen.getByRole('status').textContent).toBe('Engine offline')
  })
})

describe('useVeriqHealth', () => {
  it('polls on the refresh interval', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const { fetch, mock } = mockEngine(happyEngine)
    const { result } = renderHook(() => useVeriqHealth({ refreshInterval: 1000 }), { wrapper: wrap(fetch) })
    await waitFor(() => expect(result.current.data?.lightClient.synced).toBe(true))
    const before = mock.mock.calls.length
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000)
    })
    expect(mock.mock.calls.length).toBeGreaterThanOrEqual(before + 3)
  })
})
