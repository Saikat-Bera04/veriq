import { createPublicClient } from 'viem'
import { sepolia } from 'viem/chains'
import { createVeriq } from 'veriq-client'

const veriq = createVeriq()

export const transport = veriq.transport({
  onReceipt: (receipt) => console.log('proven at block', receipt.block.number),
})

export const client = createPublicClient({ chain: sepolia, transport })

export async function main(address: `0x${string}` = '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045') {
  // Only "finalized" can be proven; viem defaults to "latest", so pass it explicitly.
  const balance = await client.getBalance({ address, blockTag: 'finalized' })
  console.log(balance, transport.lastReceipt?.verification.status)
  return balance
}

if (import.meta.url === `file://${process.argv[1]}`) void main()
