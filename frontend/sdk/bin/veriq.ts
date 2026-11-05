/**
 * veriq — tiny CLI for the Veriq engine. No dependencies; argv parsed by hand.
 *
 *   veriq read 0xADDRESS [--slot 0x0] [--json]
 *   veriq health [--json]
 *   flags: --url <engine url>  --policy verifiedFinalized|verifiedCompare|devUnverified
 */
import { createVeriq, isVeriqError, prettyError, prettyHealth, prettyReceipt, presets, type PresetName } from '../src/index'

const HELP = `Usage:
  veriq read <address> [--slot 0x..] [--json]   Verified balance (or storage slot) with its receipt
  veriq health [--json]                         Engine, light client and providers

Flags:
  --url <url>        Engine URL (default http://127.0.0.1:8547)
  --policy <name>    verifiedFinalized (default) | verifiedCompare | devUnverified
  --json             Machine-readable output
  -h, --help         Show this help`

interface Args {
  cmd?: string
  positional: string[]
  flags: Record<string, string | true>
}

function parse(argv: string[]): Args {
  const out: Args = { positional: [], flags: {} }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? ''
    if (a === '-h') out.flags.help = true
    else if (a.startsWith('--')) {
      const [k, v] = a.slice(2).split('=', 2)
      const next = argv[i + 1]
      if (v !== undefined) out.flags[k ?? ''] = v
      else if (k !== 'json' && k !== 'help' && next !== undefined && !next.startsWith('--')) {
        out.flags[k ?? ''] = next
        i++
      } else out.flags[k ?? ''] = true
    } else if (!out.cmd) out.cmd = a
    else out.positional.push(a)
  }
  return out
}

const json = (v: unknown) => JSON.stringify(v, (_k, x: unknown) => (typeof x === 'bigint' ? x.toString() : x), 2)

async function main(): Promise<number> {
  const args = parse(process.argv.slice(2))
  if (args.flags.help || !args.cmd) {
    console.log(HELP)
    return args.cmd ? 0 : 1
  }
  const policyName = typeof args.flags.policy === 'string' ? args.flags.policy : 'verifiedFinalized'
  if (!(policyName in presets)) {
    console.error(`Unknown policy "${policyName}". Use one of: ${Object.keys(presets).join(', ')}`)
    return 1
  }
  const veriq = createVeriq({
    ...(typeof args.flags.url === 'string' ? { url: args.flags.url } : {}),
    policy: presets[policyName as PresetName],
  })

  if (args.cmd === 'read') {
    const address = args.positional[0]
    if (!address) {
      console.error('Missing address. Usage: veriq read <address> [--slot 0x..]')
      return 1
    }
    const slot = typeof args.flags.slot === 'string' ? args.flags.slot : undefined
    const result = slot ? await veriq.readStorage({ address, slot }) : await veriq.readBalance({ address })
    console.log(args.flags.json ? json(result) : prettyReceipt(result))
    return 0
  }
  if (args.cmd === 'health') {
    const health = await veriq.health()
    console.log(args.flags.json ? json(health) : prettyHealth(health))
    return 0
  }
  console.error(`Unknown command "${args.cmd}".\n\n${HELP}`)
  return 1
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    if (isVeriqError(err)) console.error(prettyError(err, { color: process.stderr.isTTY === true && process.env.NO_COLOR === undefined }))
    else console.error(err instanceof Error ? err.message : String(err))
    process.exit(1)
  },
)
