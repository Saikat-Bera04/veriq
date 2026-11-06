import { useState } from 'react'
import { BookOpen, Check, Copy } from 'lucide-react'
import { ERROR_CODES, ERROR_HINTS, ERROR_MEANINGS, type EngineErrorName } from 'veriq-client'
import { Card, CardTitle, HeroPanel, PrimaryLink, Stagger } from '../components/ui'

const DOCS_URL = 'https://github.com/Saikat-Bera04/veriq#readme'

const SNIPPETS: { title: string; lang: string; code: string }[] = [
  { title: 'Install', lang: 'bash', code: 'pnpm add veriq-client' },
  {
    title: 'Create a client',
    lang: 'ts',
    code: `import { createVeriq, verifiedFinalized } from 'veriq-client'

const veriq = createVeriq({
  url: 'http://127.0.0.1:8547',
  policy: verifiedFinalized,
})`,
  },
  {
    title: 'Read a balance',
    lang: 'ts',
    code: `const { value, receipt } = await veriq.readBalance({ address: '0x…' })

console.log(value)                         // 2000000000000000000n
console.log(receipt.verification.status)   // 'verified'
console.log(receipt.block.number)          // the finalized block it was proven at`,
  },
  {
    title: 'Use it as a viem transport',
    lang: 'ts',
    code: `import { createPublicClient, custom } from 'viem'
import { sepolia } from 'viem/chains'

const client = createPublicClient({
  chain: sepolia,
  transport: custom(veriq.transport()),
})

const balance = await client.getBalance({ address: '0x…', blockTag: 'finalized' })`,
  },
  {
    title: 'EIP-7702 Delegation Guard',
    lang: 'ts',
    code: `// Verify EIP-7702 delegation status against light-client state root
const result = await veriq.getDelegation({ address: '0x…' })

if (result.isDelegated) {
  console.warn('Delegation active!', result.delegateAddress)
  console.log('Delegate code hash:', result.delegateCodeHash)
} else if (result.securityClassification === 'delegation-revoked') {
  console.log('Delegation cleared (0xef0100 + zero address)')
} else {
  console.log('Standard un-delegated EOA')
}`,
  },
  {
    title: 'Private reads through Anon-RPC (Nox)',
    lang: 'ts',
    code: `import { AnonRpcWorker } from '@anon-rpc/browser-harness'
import { createPrivateReader } from 'veriq-client'

const nox = new AnonRpcWorker({ address: NOX_SEPOLIA, preExisting: { rpcProvider } })
const reader = createPrivateReader(veriq, {
  fetch: nox.fetch,   // providers see the mixnet's exit, not you
  network: 'nox',
  providers: [{ label: 'publicnode', url: 'https://ethereum-sepolia-rpc.publicnode.com' }],
})

// readBalance · readNonce · readStorage · readCode
const { value, receipt } = await reader.readBalance({ address: '0x…' })
receipt.privacy           // { transport: 'anon-rpc', mechanism: 'nox' }
receipt.routing.providerLabel // 'publicnode@anon-rpc:nox'`,
  },
]

function CodeBlock({ title, code }: { title: string; code: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Card padded={false} className="overflow-hidden">
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <h2 className="font-medium tracking-h3 text-lg">{title}</h2>
        <button
          type="button"
          aria-label={`Copy ${title} code`}
          onClick={() => void navigator.clipboard?.writeText(code).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1200)
          })}
          className="vq-focus inline-flex items-center gap-1.5 text-xs font-medium px-3 py-1.5 rounded-full border border-vq-border hover:bg-vq-lav-100"
        >
          {copied ? <Check className="w-3.5 h-3.5 text-vq-ok" aria-hidden="true" /> : <Copy className="w-3.5 h-3.5" aria-hidden="true" />}
          {copied ? 'Copied' : 'Copy'}
        </button>
      </div>
      <pre className="mx-3 mb-3 rounded-inner bg-vq-aubergine text-white/90 text-[13px] leading-relaxed font-mono p-5 overflow-x-auto">
        <code>{code}</code>
      </pre>
    </Card>
  )
}

export function DevelopersPage() {
  const errors = Object.entries(ERROR_CODES) as [EngineErrorName, number][]
  return (
    <Stagger className="space-y-5">
      <HeroPanel image>
        <div className="text-white/60 text-sm">Quick start</div>
        <h2 className="mt-2 text-3xl md:text-5xl font-medium tracking-hero leading-tight max-w-xl">Three lines to a verified read.</h2>
        <p className="mt-3 text-white/70 max-w-lg">
          Every result is parsed with Zod. A receipt that doesn't match the schema is an error, not a silent pass.
        </p>
        <div className="mt-6">
          <PrimaryLink href={DOCS_URL} invert>Read the docs</PrimaryLink>
        </div>
      </HeroPanel>
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-5">
        {SNIPPETS.map((s) => <CodeBlock key={s.title} title={s.title} code={s.code} />)}
      </div>
      <Card>
        <CardTitle aside={<a href={DOCS_URL} className="vq-focus inline-flex items-center gap-1.5 text-sm text-vq-muted hover:text-vq-ink rounded"><BookOpen className="w-4 h-4" aria-hidden="true" /> Docs</a>}>
          Error codes
        </CardTitle>
        <div className="divide-y divide-vq-border">
          {errors.map(([name, code]) => (
            <div key={name} className="grid grid-cols-[72px_1fr] md:grid-cols-[88px_260px_1fr] gap-x-4 gap-y-1 py-3.5 items-baseline">
              <span className="font-mono text-sm text-vq-err">{code}</span>
              <span className="font-mono text-sm font-medium break-all">{name}</span>
              <span className="col-start-2 md:col-start-3 text-sm text-vq-muted">
                {ERROR_MEANINGS[name]} <span className="text-vq-lav-700">{ERROR_HINTS[name]}</span>
              </span>
            </div>
          ))}
        </div>
      </Card>
    </Stagger>
  )
}
