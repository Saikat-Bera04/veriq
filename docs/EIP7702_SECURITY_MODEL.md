# VeriQ EIP-7702 Delegation Guard — Security Model & Threat Analysis

> **Document Version:** 1.0.0  
> **Date:** November 2026  
> **Target Audience:** Security Engineers, Auditors, Ethereum Infrastructure Providers, DApp Developers  
> **Status:** Production Implementation

---

## 1. Executive Summary

EIP-7702 introduces in-protocol delegation of Externally Owned Accounts (EOAs) to smart contracts by embedding a 23-byte designator (`0xef0100 || 20-byte delegate address`) into the account's state trie `codeHash`. While this unlocks transaction batching, gas sponsorship, and session keys, it introduces an existential security risk: **silent account hijacking by malicious sweepers**.

Standard web3 applications rely on unauthenticated JSON-RPC endpoints (`eth_getCode`, `eth_getBalance`). A malicious or compromised RPC node can lie by omission—returning `0x` (empty code) when asked for account code, effectively concealing that an EOA has been delegated to an adversary's contract.

**VeriQ's Delegation Guard eliminates this attack vector completely.** By verifying account state against local Helios light-client state roots and cryptographically proving `keccak256(code) == account.codeHash`, VeriQ ensures that any RPC deception fails closed, alerts the user, and automatically trips provider circuit breakers.

---

## 2. Threat Vector Analysis

### Threat Vector 1: RPC Concealment Attack (`HideDelegation`)
* **Attacker:** Compromised RPC node, malicious infura/alchemy proxy, or man-in-the-middle proxy.
* **Mechanism:** 
  1. The user signs an EIP-7702 authorization tuple unknowingly (e.g., via a malicious permit dApp).
  2. The attacker submits a Type-4 transaction setting the EOA's code to `0xef0100 || AttackerSweeper`.
  3. When a security scanner or wallet queries `eth_getCode(userAddress, "finalized")`, the malicious RPC intercepts the call and returns `0x` (empty code).
  4. The scanner concludes the account is a normal un-delegated EOA. The victim continues depositing funds, which are immediately swept by the delegate contract.
* **VeriQ Defense:**
  - VeriQ requests both the Merkle-Patricia account proof (`eth_getProof`) and the bytecode (`eth_getCode`) concurrently.
  - The account proof is cryptographically verified against the Helios finalized state root, verifying the account's authentic `codeHash`.
  - VeriQ computes `keccak256(returned_code)`. For an attacker returning `0x`, `keccak256("") == 0xc5d24601... != account.codeHash`.
  - The engine fails closed with `INVALID_PROOF`, logs the tampering attempt, and records a Trust Receipt containing the failure.

### Threat Vector 2: The October 2026 Binance "Silent Sweeper" Exploit
* **Incident Summary:** Malicious actors induced users to sign offline EIP-7702 authorization hashes under the guise of an airdrop claim or gasless approval. Attackers subsequently broadcasted type-4 transactions pointing EOAs to a sweeper contract that transferred all incoming ERC-20 tokens directly to attacker vaults.
* **Vulnerability:** Standard block explorers and wallet balance displays only check ETH/token balances and assume EOAs have no code.
* **VeriQ Defense:**
  - VeriQ’s `veriq_getDelegation` scans the proven bytecode directly.
  - When the 23-byte prefix `0xef0100` is encountered, the status is immediately flagged as `Delegated`, extracting the exact delegate address.
  - A persistent Trust Receipt warning `EIP7702_DELEGATION_DETECTED` is affixed to the response and stored in the database for compliance and auditing.

### Threat Vector 3: Replay of Stale Pre-Delegation State
* **Attacker:** A provider serving a valid proof from a block prior to the delegation transaction.
* **VeriQ Defense:**
  - VeriQ pins reads to the **latest finalized block** validated by the local Helios light client.
  - A proof from an older or unfinalized block is rejected with `ROOT_UNAVAILABLE` or `INVALID_PROOF` unless explicitly permitted by policy.

### Threat Vector 4: Revocation Evasion (Zombie Delegations)
* **Protocol Rule:** Under EIP-7702, clearing an authorization requires an authorization targeting `0x0000000000000000000000000000000000000000`.
* **Vulnerability:** Naive parsers that check `code.len() > 0` might treat a revoked EOA (`0xef0100 || 0x00...00`) as actively delegated, locking the account out of decentralized applications.
* **VeriQ Defense:**
  - VeriQ distinguishes active delegations from cleared delegations.
  - Address `0x0000000000000000000000000000000000000000` is categorized as `DelegationStatus::Revoked`, producing warning `EIP7702_DELEGATION_REVOKED` without flagging active execution hijacking.

### Threat Vector 5: IP De-Anonymization
* **Attacker:** RPC nodes correlating wallet queries with user IP addresses to target high-net-worth EOAs.
* **VeriQ Defense:**
  - In Anon-RPC mode (Nox / WebRTC mixnet), all RPC requests are dispatched through onion-routed ephemeral peers.
  - Providers only see exit nodes, preventing wallet tracking.

---

## 3. Cryptographic Verification Pipeline

```
  [User / SDK]
       │
       │ veriq_getDelegation(targetAddress)
       ▼
┌──────────────────────────────────────────────────────────┐
│ VeriQ Core Engine                                        │
│                                                          │
│ 1. Pinned State Root from Helios Light Client            │
│    (Block: finalizedNumber, Hash: finalizedHash)         │
│                                                          │
│ 2. Concurrent Fetch via Provider / Anon-RPC:             │
│    ├─ eth_getProof(targetAddress, [], finalized)         │
│    └─ eth_getCode(targetAddress, finalized)              │
│                                                          │
│ 3. Merkle Trie Account Verification:                     │
│    verify_account(state_root, address, accountProof)     │
│    ──► Validates account.nonce, balance, codeHash        │
│                                                          │
│ 4. Code Hash Commitment Check:                           │
│    keccak256(raw_bytecode) == account.codeHash          │
│    ──► FAILS CLOSED on mismatch: Error(INVALID_PROOF)    │
│                                                          │
│ 5. EIP-7702 Designator Classification:                   │
│    classify_account_code(bytecode)                       │
│    ├─ []                      ──► NormalEoa              │
│    ├─ [0xef, 0x01, 0x00, ...] ──► Delegated(Address)     │
│    ├─ [0xef, 0x01, 0x00, 0x0] ──► Revoked                │
│    └─ other bytecode          ──► SmartContract          │
│                                                          │
│ 6. Trust Receipt Generation:                             │
│    - Status: "verified"                                  │
│    - Warnings: [EIP7702_DELEGATION_DETECTED, ...]        │
│    - Block: finalized, stateRoot, chainId                │
└──────────────────────────────────────────────────────────┘
       │
       ▼
  [Verified Delegation Result + Trust Receipt]
```

---

## 4. Security Guarantees & Invariants

1. **No Unchecked Claims:** VeriQ never reports an account status derived from plain `eth_getCode` without an accompanying Merkle state trie proof.
2. **Fail-Closed Behavior:** If a provider returns corrupted code, mismatched bytecode, or invalid proofs, VeriQ rejects the result immediately and attempts failover to the next configured provider. If all providers fail, `ALL_PROVIDERS_FAILED` is returned.
3. **Immutability of Finalized State:** Once a block is finalized by Ethereum consensus (Casper FFG), its state root is fixed. Helios provides the trust anchor without trusting any third-party JSON-RPC node.
4. **Non-Transitive Boundary:** VeriQ strictly analyzes the primary delegate address. In adherence to EIP-7702 specification, transitive delegation pointers are not followed, preventing recursive resolution vulnerabilities.

---

## 5. Security Comparison Matrix

| Security Property | Standard Web3 Wallet / RPC | Basic EIP-7702 Scanner | VeriQ Delegation Guard |
| :--- | :--- | :--- | :--- |
| **Trust Anchor** | Remote RPC Provider (Centralized) | Remote RPC Provider | **Helios Light Client (Consensus Proofs)** |
| **Tamper Resistance** | None (RPC can lie) | None (RPC can lie) | **Merkle-Patricia Trie Account Proof** |
| **Bytecode Integrity** | Trusted unverified | Trusted unverified | **`keccak256(code) == account.codeHash`** |
| **Sweeper Detection** | Fails silently | Partial (vulnerable to RPC lies) | **Deterministic & Proven** |
| **Revocation Awareness** | None | Rarely handled | **Full EIP-7702 Zero-Address Handling** |
| **Privacy Preservation** | None (IP exposed to RPC) | None | **Anon-RPC Ephemeral Routing (Nox)** |
| **Audit Trail** | None | None | **Cryptographic Trust Receipts** |

