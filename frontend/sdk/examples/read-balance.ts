import { createVeriq, isVeriqError } from 'veriq-client'

export const veriq = createVeriq()

export async function main(address = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045') {
  const { value, verified } = await veriq.readBalance({ address })
  console.log(value, verified ? 'verified' : 'NOT verified')
}

// Run directly: npx tsx examples/read-balance.ts
if (import.meta.url === `file://${process.argv[1]}`) {
  main().catch((e: unknown) => console.error(isVeriqError(e) ? e.toString() : e))
}
