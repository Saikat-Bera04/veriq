import { createVeriq } from 'veriq-client'
import { EngineStatus, VerifiedValue, VeriqProvider } from 'veriq-client/react'
import 'veriq-client/styles.css'

const veriq = createVeriq()

/** A wallet balance card: the proven value, its badge, and the full receipt on click. */
export function WalletCard({ address }: { address: string }) {
  return (
    <VeriqProvider client={veriq}>
      <div style={{ display: 'grid', gap: 16, padding: 24, borderRadius: 24, background: '#fff', border: '1px solid #E6E4EE' }}>
        <EngineStatus />
        <span style={{ color: '#6F6F6C', fontSize: 14 }}>Balance</span>
        <VerifiedValue address={address} />
      </div>
    </VeriqProvider>
  )
}
