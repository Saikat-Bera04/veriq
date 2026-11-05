import { createContext, useContext, type ReactNode } from 'react'
import type { VeriqClient } from 'veriq-client'

const VeriqContext = createContext<VeriqClient | null>(null)

/**
 * Makes a Veriq client available to the hooks and components below it.
 * @example
 * const veriq = createVeriq()
 * <VeriqProvider client={veriq}><App /></VeriqProvider>
 */
export function VeriqProvider({ client, children }: { client: VeriqClient; children?: ReactNode }) {
  return <VeriqContext.Provider value={client}>{children}</VeriqContext.Provider>
}

/**
 * The client from the nearest VeriqProvider (null if there is none).
 * @example const veriq = useVeriqClient()
 */
export function useVeriqClient(): VeriqClient | null {
  return useContext(VeriqContext)
}
