import { describe, expect, it } from 'vitest'
import { fireEvent, screen } from '@testing-library/react'
import { DelegationGuardPage } from './DelegationGuard'
import { renderPage, serve, RECEIPT } from '../test/services'

const DELEGATE = '0x1242c562946c926a6d0012acb54d9413a54a1ca4'

describe('DelegationGuardPage', () => {
  it('renders hero title and preset buttons', () => {
    renderPage(<DelegationGuardPage />)
    expect(screen.getByText('Delegation Guard')).toBeTruthy()
    expect(screen.getByText('Target Wallet Address')).toBeTruthy()
    expect(screen.getByText('Delegated EOA (Demo)')).toBeTruthy()
    expect(screen.getByText('Normal EOA')).toBeTruthy()
    expect(screen.getByText('Revoked Account')).toBeTruthy()
  })

  it('verifies a delegated account and displays active delegation status and target address', async () => {
    const delegationReceipt = {
      ...RECEIPT,
      warnings: [
        {
          code: 'EIP7702_DELEGATION_DETECTED',
          message: `EIP-7702 delegation active: calls execute code from ${DELEGATE}`,
        },
      ],
    }

    serve({
      engineRpc: (method, _params) => {
        if (method === 'veriq_getDelegation') {
          return {
            result: {
              address: '0x1242C562946C926a6d0012Acb54D9413A54A1CA4',
              status: { status: 'delegated', delegate: DELEGATE },
              isDelegated: true,
              delegateAddress: DELEGATE,
              codeHash: '0x32e92c63dfb3a033f9cfb42fae9cc57be2faea1534032d184ebffb904c6e9491',
              delegateCodeHash: '0x1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
              securityClassification: 'delegation-detected',
              blockNumber: 7412903,
              verified: true,
              receipt: delegationReceipt,
            },
          }
        }
        return { error: { code: -32601, message: 'Method not found' } }
      },
    })

    renderPage(<DelegationGuardPage />)

    const scanButton = screen.getByRole('button', { name: /Verify Delegation/i })
    fireEvent.click(scanButton)

    expect(await screen.findByText('Active EIP-7702 Delegation')).toBeTruthy()
    expect(screen.getByText('Active Delegation Target')).toBeTruthy()
    expect(screen.getByText(DELEGATE)).toBeTruthy()
    expect(screen.getByText('Proven Code Hash')).toBeTruthy()
    expect(screen.getByText('EIP7702_DELEGATION_DETECTED')).toBeTruthy()
  })

  it('verifies a normal EOA and displays standard keypair status', async () => {
    serve({
      engineRpc: (method, _params) => {
        if (method === 'veriq_getDelegation') {
          return {
            result: {
              address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045',
              status: { status: 'normal-eoa' },
              isDelegated: false,
              delegateAddress: null,
              codeHash: '0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470',
              delegateCodeHash: null,
              securityClassification: 'normal-eoa',
              blockNumber: 7412903,
              verified: true,
              receipt: RECEIPT,
            },
          }
        }
        return { error: { code: -32601, message: 'Method not found' } }
      },
    })

    renderPage(<DelegationGuardPage />)

    const normalPreset = screen.getByRole('button', { name: 'Normal EOA' })
    fireEvent.click(normalPreset)

    expect(await screen.findByText('Standard EOA (No Code)')).toBeTruthy()
    expect(screen.queryByText('Active Delegation Target')).toBeNull()
  })
})

