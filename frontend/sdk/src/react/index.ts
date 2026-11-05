/**
 * veriq-client/react — hooks and components that look exactly like the Veriq dashboard.
 * Import the styles once: `import 'veriq-client/styles.css'`.
 * @example
 * <VeriqProvider client={createVeriq()}>
 *   <VerifiedValue address="0x…" />
 * </VeriqProvider>
 */
export { VeriqProvider, useVeriqClient } from './provider'
export { useVerifiedBalance, useVerifiedStorage, useVeriqHealth, useReceipt } from './hooks'
export type { QueryState, HookOptions, ReadHookOptions } from './hooks'
export { ReceiptBadge, ReceiptCard, VerifiedValue, EngineStatus, CopyHash } from './components'
export type { ReceiptBadgeProps, ReceiptCardProps, VerifiedValueProps, EngineStatusProps, BadgeSize } from './components'
