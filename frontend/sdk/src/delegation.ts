import type { Address, Hex } from './types'

/** The 3-byte EIP-7702 delegation prefix `0xef0100`. */
export const EIP7702_PREFIX = '0xef0100'

/** Total byte length of a valid EIP-7702 delegation designator: 3 prefix + 20 address = 23 bytes. */
export const DESIGNATOR_BYTE_LENGTH = 23

/** Total length in hex chars including '0x' prefix: 2 + 46 = 48 chars. */
export const DESIGNATOR_HEX_LENGTH = 48

export const ZERO_ADDRESS: Address = '0x0000000000000000000000000000000000000000'

export type DelegationCodeStatus =
  | { status: 'normal-eoa' }
  | { status: 'delegated'; delegate: Address }
  | { status: 'contract' }
  | { status: 'revoked' }
  | { status: 'invalid-designator' }

export interface ParsedDesignator {
  isDesignator: boolean
  delegate: Address | null
  isRevoked: boolean
  isMalformed: boolean
}

/**
 * Parse an EIP-7702 delegation designator from hex-encoded bytecode.
 *
 * Rules:
 * - Empty code (`0x` or `""`) is not a designator.
 * - Bytecode starting with `0xef0100`:
 *   - Exactly 23 bytes (48 hex chars including `0x`): valid designator.
 *     If delegate is 0x00..00, it is a revoked/cleared delegation.
 *   - Any other length: malformed designator.
 * - Any other non-empty bytecode: not a designator (standard contract code).
 */
export function parseDelegationDesignator(code: string): ParsedDesignator {
  const lower = code.toLowerCase()
  const norm = (lower.startsWith('0x') ? lower : `0x${lower}`) as Hex
  if (norm === '0x' || norm.length <= 2) {
    return { isDesignator: false, delegate: null, isRevoked: false, isMalformed: false }
  }

  if (!norm.startsWith(EIP7702_PREFIX)) {
    return { isDesignator: false, delegate: null, isRevoked: false, isMalformed: false }
  }

  // Starts with 0xef0100
  if (norm.length !== DESIGNATOR_HEX_LENGTH) {
    return { isDesignator: false, delegate: null, isRevoked: false, isMalformed: true }
  }

  const delegate = `0x${norm.slice(8)}` as Address
  const isRevoked = delegate === ZERO_ADDRESS

  return {
    isDesignator: !isRevoked,
    delegate: isRevoked ? null : delegate,
    isRevoked,
    isMalformed: false,
  }
}

/**
 * Classify account code according to EIP-7702.
 */
export function classifyAccountCode(code: string): {
  status: DelegationCodeStatus
  isDelegated: boolean
  delegateAddress: Address | null
} {
  const parsed = parseDelegationDesignator(code)

  if (parsed.isMalformed) {
    return {
      status: { status: 'invalid-designator' },
      isDelegated: false,
      delegateAddress: null,
    }
  }

  if (parsed.isRevoked) {
    return {
      status: { status: 'revoked' },
      isDelegated: false,
      delegateAddress: null,
    }
  }

  if (parsed.isDesignator && parsed.delegate) {
    return {
      status: { status: 'delegated', delegate: parsed.delegate },
      isDelegated: true,
      delegateAddress: parsed.delegate,
    }
  }

  const norm = code.startsWith('0x') ? code : `0x${code}`
  if (norm === '0x' || norm.length <= 2) {
    return {
      status: { status: 'normal-eoa' },
      isDelegated: false,
      delegateAddress: null,
    }
  }

  return {
    status: { status: 'contract' },
    isDelegated: false,
    delegateAddress: null,
  }
}
