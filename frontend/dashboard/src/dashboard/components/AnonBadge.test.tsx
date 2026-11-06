import { describe, expect, it, vi } from 'vitest'
import { act, fireEvent, screen, waitFor } from '@testing-library/react'
import { AnonBadge, anonBadgeLabel } from './AnonBadge'
import { Shell } from './Shell'
import { AnonUnavailableError, MODE_STORAGE_KEY, getAnonMode, resetAnonForTests, startAnon, type AnonWorker } from '../lib/anon'
import { healthBody, renderPage, serve } from '../test/services'

/** A fake Nox worker; `settle` resolves or rejects its `ready` when the test says so. */
function worker() {
  let settle!: { resolve: () => void; reject: (e: unknown) => void }
  const w: AnonWorker = {
    ready: new Promise<void>((resolve, reject) => {
      settle = { resolve, reject }
    }),
    fetch: vi.fn(async () => new Response('{}')),
    close: vi.fn(),
  }
  return { w, settle: () => settle }
}

function install() {
  const made = worker()
  const factory = vi.fn(() => made.w)
  resetAnonForTests(factory)
  return { factory, worker: made.w, settle: made.settle }
}

const anonStatus = () => document.querySelector('[data-anon-state]') as HTMLElement

describe('anonBadgeLabel', () => {
  it('names every state in words', () => {
    expect(anonBadgeLabel('direct', { state: 'ready' })).toBe('Direct mode')
    expect(anonBadgeLabel('private', { state: 'idle' })).toBe('Anon-RPC: connecting…')
    expect(anonBadgeLabel('private', { state: 'connecting' })).toBe('Anon-RPC: connecting…')
    expect(anonBadgeLabel('private', { state: 'ready' })).toBe('Anon-RPC: ready (nox)')
    const error = new AnonUnavailableError('Could not join the Nox mixnet: specifier unreachable')
    expect(anonBadgeLabel('private', { state: 'failed', error })).toBe('Anon-RPC: failed — specifier unreachable')
    const long = new AnonUnavailableError(`Could not join the Nox mixnet: ${'x'.repeat(200)}`)
    expect(anonBadgeLabel('private', { state: 'failed', error: long }).length).toBeLessThan(120)
  })
})

describe('AnonBadge', () => {
  it('connecting, then ready, in a role="status" region', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    const { settle } = install()
    renderPage(<AnonBadge />)
    void startAnon()
    await waitFor(() => expect(anonStatus().textContent).toContain('Anon-RPC: connecting…'))
    expect(anonStatus().getAttribute('role')).toBe('status')
    await act(async () => {
      settle().resolve()
    })
    expect(anonStatus().textContent).toContain('Anon-RPC: ready (nox)')
    expect(anonStatus().dataset.anonState).toBe('ready')
  })

  it('failed, with the reason', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    const { settle } = install()
    renderPage(<AnonBadge />)
    const started = startAnon()
    await act(async () => {
      settle().reject(new Error('specifier unreachable'))
      await started.catch(() => {})
    })
    expect(anonStatus().textContent).toContain('Anon-RPC: failed — specifier unreachable')
    expect(anonStatus().dataset.anonState).toBe('failed')
  })

  it('the toggle switches to direct and back, keeps the worker warm, and is a keyboard-usable button', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    const { factory, worker: w, settle } = install()
    renderPage(<AnonBadge />)
    void startAnon()
    await act(async () => {
      settle().resolve()
    })

    const toggle = screen.getByRole('button', { name: 'Use direct' })
    expect(toggle.getAttribute('type')).toBe('button')
    expect(toggle.getAttribute('aria-pressed')).toBe('false')
    toggle.focus()
    expect(document.activeElement).toBe(toggle)
    fireEvent.click(toggle)

    expect(anonStatus().textContent).toContain('Direct mode')
    expect(getAnonMode()).toBe('direct')
    expect(sessionStorage.getItem(MODE_STORAGE_KEY)).toBe('direct')
    expect(w.close).not.toHaveBeenCalled() // warm

    fireEvent.click(screen.getByRole('button', { name: 'Use Anon-RPC' }))
    expect(anonStatus().textContent).toContain('Anon-RPC: ready (nox)')
    expect(factory).toHaveBeenCalledTimes(1) // the same worker, no second join
  })

  it('the choice survives a remount (sessionStorage)', () => {
    vi.stubEnv('VITE_ANON', 'on')
    install()
    const first = renderPage(<AnonBadge />)
    fireEvent.click(screen.getByRole('button', { name: 'Use direct' }))
    first.unmount()

    // A reload: the module state is gone, sessionStorage is not.
    install()
    renderPage(<AnonBadge />)
    expect(anonStatus().textContent).toContain('Direct mode')
    expect(screen.getByRole('button', { name: 'Use Anon-RPC' }).getAttribute('aria-pressed')).toBe('true')
  })

  it('a build with Anon-RPC off shows Direct mode and no toggle', () => {
    install() // VITE_ANON=off from setup.ts
    renderPage(<AnonBadge />)
    expect(anonStatus().textContent).toContain('Direct mode')
    expect(screen.queryByRole('button', { name: /Use / })).toBeNull()
  })

  it('a failed start does not break the page, and direct mode still works', async () => {
    vi.stubEnv('VITE_ANON', 'on')
    serve({ health: () => healthBody })
    const { settle } = install()
    renderPage(<Shell />)
    await act(async () => {
      settle().reject(new Error('bootstrap blocked'))
    })
    await waitFor(() => expect(anonStatus().textContent).toContain('Anon-RPC: failed — bootstrap blocked'))
    // The rest of the shell is still there.
    expect(screen.getAllByRole('link', { name: /Overview/ }).length).toBeGreaterThan(0)
    fireEvent.click(screen.getByRole('button', { name: 'Use direct' }))
    expect(anonStatus().textContent).toContain('Direct mode')
  })
})
