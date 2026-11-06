import { useState } from 'react'
import { Link } from 'react-router-dom'
import {
  AlertCircle,
  AlertTriangle,
  CheckCircle2,
  Copy,
  ExternalLink,
  FileCode,
  RefreshCw,
  Search,
  ShieldAlert,
  ShieldCheck,
} from 'lucide-react'
import { VeriqError, verifiedFinalized } from 'veriq-client'
import { ReceiptBadge } from 'veriq-client/react'
import { readDelegation, type DelegationOutcome } from '../lib/engine'
import { DEMO_ADDRESS } from '../lib/mock'
import { transportLabel } from '../lib/anon'
import { Card, CardTitle, HeroPanel, PrimaryButton, SampleTag } from '../components/ui'

const PRESETS = [
  {
    label: 'Delegated EOA (Demo)',
    address: '0x1242C562946C926a6d0012Acb54D9413A54A1CA4',
    hint: 'Account with active EIP-7702 delegation designator',
  },
  {
    label: 'Normal EOA',
    address: DEMO_ADDRESS,
    hint: 'Standard EOA without code',
  },
  {
    label: 'Revoked Account',
    address: '0x0000000000000000000000000000000000000007',
    hint: 'Cleared delegation (0xef0100 + zero address)',
  },
]

export function DelegationGuardPage() {
  const [address, setAddress] = useState(PRESETS[0].address)
  const [outcome, setOutcome] = useState<DelegationOutcome | null>(null)
  const [running, setRunning] = useState(false)
  const [copied, setCopied] = useState(false)

  const scan = async (targetAddress = address) => {
    setRunning(true)
    try {
      const res = await readDelegation(targetAddress.trim(), verifiedFinalized)
      setOutcome(res)
    } finally {
      setRunning(false)
    }
  }

  const copyText = (text: string) => {
    navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="space-y-8 max-w-6xl mx-auto">
      <HeroPanel>
        <div className="flex flex-col md:flex-row md:items-center justify-between gap-6">
          <div className="space-y-2">
            <div className="flex items-center gap-2">
              <span className="inline-flex items-center gap-1.5 px-2.5 py-0.5 rounded-full text-xs font-medium bg-amber-500/10 text-amber-500 border border-amber-500/20">
                <ShieldAlert className="w-3.5 h-3.5" />
                EIP-7702 Security
              </span>
              <span className="text-xs text-white/50">Pectra Specification</span>
            </div>
            <h1 className="text-3xl md:text-4xl font-medium tracking-tight text-white">
              Delegation Guard
            </h1>
            <p className="text-sm md:text-base text-white/70 max-w-2xl">
              Inspect any Ethereum wallet for EIP-7702 batch delegation designators (<code className="text-white bg-white/10 px-1 py-0.5 rounded text-xs">0xef0100 || address</code>). Verified cryptographically against Helios light-client state roots so malicious RPCs cannot conceal swept or delegated EOAs.
            </p>
          </div>
        </div>
      </HeroPanel>

      {/* Input Card */}
      <Card>
        <div className="space-y-4">
          <div className="flex flex-col md:flex-row md:items-center justify-between gap-2">
            <label htmlFor="address-input" className="text-sm font-medium text-vq-ink">
              Target Wallet Address
            </label>
            <div className="flex flex-wrap items-center gap-2">
              <span className="text-xs text-vq-muted">Presets:</span>
              {PRESETS.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    setAddress(p.address)
                    scan(p.address)
                  }}
                  className="text-xs px-2 py-1 rounded bg-vq-surface border border-vq-border text-vq-ink hover:bg-vq-lav-100 transition-colors"
                  title={p.hint}
                >
                  {p.label}
                </button>
              ))}
            </div>
          </div>

          <div className="flex flex-col sm:flex-row gap-3">
            <div className="relative flex-1">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-vq-muted" />
              <input
                id="address-input"
                type="text"
                value={address}
                onChange={(e) => setAddress(e.target.value)}
                placeholder="0x..."
                className="vq-focus w-full pl-10 pr-4 py-2.5 rounded-lg border border-vq-border bg-vq-surface text-sm font-mono text-vq-ink placeholder:text-vq-muted"
              />
            </div>
            <PrimaryButton
              onClick={() => scan()}
              disabled={running || !address.trim()}
              className="sm:w-auto"
            >
              {running ? (
                <>
                  <RefreshCw className="w-4 h-4 animate-spin mr-2" />
                  Verifying Proof…
                </>
              ) : (
                <>
                  <ShieldCheck className="w-4 h-4 mr-2" />
                  Verify Delegation
                </>
              )}
            </PrimaryButton>
          </div>
        </div>
      </Card>

      {/* Results View */}
      {running ? (
        <Card>
          <div className="space-y-4 py-8 text-center">
            <RefreshCw className="w-8 h-8 animate-spin mx-auto text-vq-muted" />
            <p className="text-sm text-vq-muted">
              Pinning finalized block root & fetching account trie proof through Anon-RPC…
            </p>
          </div>
        </Card>
      ) : outcome ? (
        <DelegationDetail outcome={outcome} onCopy={copyText} copied={copied} />
      ) : null}

      {/* Protocol Background & Threat Model Card */}
      <Card>
        <CardTitle>Why Light-Client Verification is Essential for EIP-7702</CardTitle>
        <div className="mt-4 grid md:grid-cols-3 gap-6 text-sm text-vq-muted">
          <div className="space-y-2 p-4 rounded-xl bg-vq-surface-subtle border border-vq-border">
            <div className="flex items-center gap-2 font-medium text-vq-ink">
              <AlertTriangle className="w-4 h-4 text-amber-500" />
              Sweeper Risk (October 2026 Incident)
            </div>
            <p>
              Users unknowingly sign off-chain EIP-7702 authorization digests authorizing delegate contracts. The delegate can sweep all incoming funds or front-run operations under the user’s identity.
            </p>
          </div>
          <div className="space-y-2 p-4 rounded-xl bg-vq-surface-subtle border border-vq-border">
            <div className="flex items-center gap-2 font-medium text-vq-ink">
              <ShieldAlert className="w-4 h-4 text-rose-500" />
              Malicious RPC Concealment
            </div>
            <p>
              A compromised node serving standard <code className="text-xs bg-vq-surface px-1 py-0.5 rounded">eth_getCode</code> can reply with empty code <code className="text-xs bg-vq-surface px-1 py-0.5 rounded">0x</code>, tricking users and wallets into believing the account is an uncompromised normal EOA.
            </p>
          </div>
          <div className="space-y-2 p-4 rounded-xl bg-vq-surface-subtle border border-vq-border">
            <div className="flex items-center gap-2 font-medium text-vq-ink">
              <CheckCircle2 className="w-4 h-4 text-emerald-500" />
              VeriQ Cryptographic Guarantee
            </div>
            <p>
              VeriQ verifies the Merkle trie proof against the local Helios light client root, and enforces that <code className="text-xs bg-vq-surface px-1 py-0.5 rounded">keccak256(code) == account.codeHash</code>. Any lie immediately fails closed.
            </p>
          </div>
        </div>
      </Card>
    </div>
  )
}

function DelegationDetail({
  outcome,
  onCopy,
  copied,
}: {
  outcome: DelegationOutcome
  onCopy: (text: string) => void
  copied: boolean
}) {
  if (!outcome.ok) {
    const e = outcome.error
    const typed = e instanceof VeriqError
    return (
      <Card className="border-rose-500/20 bg-rose-500/[0.02]">
        <div className="space-y-3">
          <div className="flex items-center gap-2 text-rose-600 font-medium">
            <AlertCircle className="w-5 h-5" />
            Verification Failed / Error
          </div>
          <p className="text-sm text-vq-muted">
            {typed ? e.meaning : e.message}
          </p>
          <div className="text-xs font-mono bg-vq-surface p-3 rounded-lg border border-vq-border overflow-x-auto">
            {e.message}
          </div>
        </div>
      </Card>
    )
  }

  const { result, source } = outcome
  const { isDelegated, delegateAddress, codeHash, securityClassification, receipt } = result

  // Classification styling
  const isRevoked = securityClassification === 'delegation-revoked'
  const isNormal = securityClassification === 'normal-eoa'

  return (
    <Card className="space-y-6">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4 pb-6 border-b border-vq-border">
        <div className="space-y-1">
          <div className="flex items-center gap-2">
            <span className="text-xs font-medium uppercase tracking-wider text-vq-muted">
              Account Status
            </span>
            {source === 'mock' && <SampleTag />}
          </div>
          <div className="flex items-center gap-3">
            {isDelegated ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold bg-amber-500/10 text-amber-600 border border-amber-500/30">
                <ShieldAlert className="w-4 h-4" />
                Active EIP-7702 Delegation
              </span>
            ) : isRevoked ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold bg-slate-500/10 text-slate-600 border border-slate-500/30">
                <AlertCircle className="w-4 h-4" />
                Delegation Cleared / Revoked
              </span>
            ) : isNormal ? (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold bg-emerald-500/10 text-emerald-600 border border-emerald-500/30">
                <CheckCircle2 className="w-4 h-4" />
                Standard EOA (No Code)
              </span>
            ) : (
              <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full text-sm font-semibold bg-blue-500/10 text-blue-600 border border-blue-500/30">
                <FileCode className="w-4 h-4" />
                Deployed Smart Contract
              </span>
            )}
            <ReceiptBadge status={receipt.verification.status} size="md" />
          </div>
        </div>

        <Link
          to={`/app/feed?receipt=${encodeURIComponent(receipt.identity.requestId)}`}
          className="vq-focus inline-flex items-center gap-1.5 text-xs font-medium text-vq-muted hover:text-vq-ink bg-vq-surface px-3 py-2 rounded-lg border border-vq-border transition-colors self-start sm:self-auto"
        >
          View Trust Receipt
          <ExternalLink className="w-3.5 h-3.5" />
        </Link>
      </div>

      {/* Delegate Info Banner if Delegated */}
      {isDelegated && delegateAddress && (
        <div className="p-4 rounded-xl bg-amber-500/5 border border-amber-500/20 space-y-3">
          <div className="flex items-center gap-2 text-sm font-medium text-amber-700 dark:text-amber-400">
            <AlertTriangle className="w-4 h-4 shrink-0" />
            Active Delegation Target
          </div>
          <p className="text-xs text-vq-muted leading-relaxed">
            All calls and transactions directed to this account will execute the bytecode of the delegate address below via EIP-7702 runtime delegation.
          </p>
          <div className="flex items-center justify-between gap-3 p-3 rounded-lg bg-vq-surface border border-vq-border font-mono text-sm">
            <span className="truncate text-vq-ink">{delegateAddress}</span>
            <button
              type="button"
              onClick={() => onCopy(delegateAddress)}
              className="p-1.5 hover:bg-vq-surface-subtle rounded text-vq-muted hover:text-vq-ink transition-colors"
              title={copied ? "Copied!" : "Copy delegate address"}
            >
              {copied ? <CheckCircle2 className="w-4 h-4 text-emerald-500" /> : <Copy className="w-4 h-4" />}
            </button>
          </div>
        </div>
      )}

      {/* Grid of Verified Properties */}
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4 text-sm">
        <div className="p-4 rounded-xl bg-vq-surface border border-vq-border space-y-1.5">
          <span className="text-xs text-vq-muted uppercase tracking-wider">Account Address</span>
          <div className="font-mono text-xs text-vq-ink break-all">{result.address}</div>
        </div>

        <div className="p-4 rounded-xl bg-vq-surface border border-vq-border space-y-1.5">
          <span className="text-xs text-vq-muted uppercase tracking-wider">Proven Code Hash</span>
          <div className="font-mono text-xs text-vq-ink break-all">{codeHash}</div>
        </div>

        <div className="p-4 rounded-xl bg-vq-surface border border-vq-border space-y-1.5">
          <span className="text-xs text-vq-muted uppercase tracking-wider">Verified Block</span>
          <div className="text-vq-ink font-medium">
            #{receipt.block.number.toLocaleString()} ·{' '}
            <span className="text-emerald-600 font-normal">Finalized</span>
          </div>
        </div>

        <div className="p-4 rounded-xl bg-vq-surface border border-vq-border space-y-1.5">
          <span className="text-xs text-vq-muted uppercase tracking-wider">Privacy & Transport</span>
          <div className="text-vq-ink font-medium">
            {transportLabel(receipt.privacy)} ·{' '}
            <span className="text-vq-muted font-normal">{receipt.verification.rootSource}</span>
          </div>
        </div>
      </div>

      {/* Warnings List from Receipt */}
      {receipt.warnings.length > 0 && (
        <div className="space-y-2 pt-2">
          <span className="text-xs font-medium uppercase tracking-wider text-vq-muted">
            Trust Receipt Warnings
          </span>
          <div className="space-y-2">
            {receipt.warnings.map((w) => (
              <div
                key={w.code}
                className="flex items-start gap-2.5 p-3 rounded-lg bg-amber-500/10 text-amber-800 dark:text-amber-300 text-xs border border-amber-500/20"
              >
                <AlertTriangle className="w-4 h-4 shrink-0 mt-0.5" />
                <div>
                  <span className="font-mono font-semibold">{w.code}</span>: {w.message}
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </Card>
  )
}
