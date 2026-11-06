# EIP-7702 Delegation Guard — Protocol Research & Specification

> **Document Version:** 1.0.0  
> **Date:** November 2026  
> **Protocol Reference:** [EIP-7702: Set EOA account code](https://eips.ethereum.org/EIPS/eip-7702) (Ethereum Pectra Upgrade)  
> **Target Audience:** Core Protocol Engineers, Security Researchers, Cryptographic Developers

---

## 1. Protocol Background & Motivation

EIP-7702 was introduced in Ethereum's Prague/Electra (Pectra) hard fork to bring smart contract capabilities (batching, sponsorship, session keys) to standard Externally Owned Accounts (EOAs) without requiring them to migrate their assets or change their public addresses.

### 1.1 The Delegation Mechanism
Under EIP-7702, an EOA can authorize the temporary or permanent installation of code at its address.
When an EOA is delegated:
1. The execution layer observes a 23-byte **delegation designator** at the EOA's code location:
   $$\text{code} = \mathtt{0xef0100} \,\|\, \text{delegate\_address}_{20}$$
2. The account's code hash committed to the state trie becomes:
   $$\text{codeHash} = \text{keccak256}(\mathtt{0xef0100} \,\|\, \text{delegate\_address}_{20})$$
3. During transaction execution, any call to the EOA executes the bytecode located at `delegate_address` in the context of the EOA (identical to `DELEGATECALL`).

---

## 2. Technical Anatomy of EIP-7702

### 2.1 The Delegation Designator
* **Prefix:** `0xef0100` (3 bytes, hex `[0xef, 0x01, 0x00]`). The leading `0xef` byte prevents standard EVM execution from misinterpreting legacy initialization bytecode.
* **Target Address:** 20 bytes representing the account or contract to which execution is delegated.
* **Total Length:** Strictly **23 bytes** (46 hexadecimal characters + `0x` prefix).

### 2.2 Account Code Classifications
The state of an account must be partitioned into the following mutually exclusive categories:

1. **Normal EOA (`NormalEoa`):**
   - Bytecode is empty (`0x`, length 0).
   - Account state trie `codeHash` is equal to `KECCAK_EMPTY` (`0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470`).
2. **Active Delegated EOA (`Delegated`):**
   - Bytecode length is exactly 23 bytes.
   - Prefix equals `0xef0100`.
   - Delegate address $\neq \mathtt{0x0000000000000000000000000000000000000000}$.
   - Account state trie `codeHash` equals $\text{keccak256}(\text{designator})$.
3. **Revoked / Cleared Delegation (`Revoked`):**
   - Per EIP-7702 specification, submitting an authorization tuple designating the zero address (`0x0000...0000`) clears the account's delegation.
   - If an account's bytecode is explicitly set to `0xef01000000000000000000000000000000000000000000`, the delegation is treated as revoked/cleared (not an active target).
4. **Standard Smart Contract (`Contract`):**
   - Bytecode length $> 0$.
   - Bytecode does not match the 23-byte `0xef0100` designator structure.
5. **Malformed Designator (`InvalidDesignator`):**
   - Code begins with `0xef0100` but length $\neq 23$ bytes, or contains corrupted trailing bytes.

### 2.3 Non-Transitivity (No Delegation Chains)
EIP-7702 explicitly enforces that delegation pointers **are not followed transitively**:
> *If a delegated account points to another account that is also delegated, execution terminates or does not evaluate the second delegation.*

Therefore, Veriq only analyzes and proves the direct delegate target.

---

## 3. Threat Model: The Silent Sweeper Exploit

### 3.1 The October 2026 Binance Hot-Wallet Incident
On October 29, 2026, a major exchange hot wallet ("Binance 14") suffered a draining incident resulting in losses estimated over \$5B across chains.
- **Attack Vector:** The attacker obtained or brute-forced pre-signed EIP-7702 authorization tuples. A Type-4 transaction was broadcast containing 50 authorizations with sequential nonces.
- **The Vulnerability:** Once the authorization landed, the wallet's code was silently set to the attacker's sweeper contract.
- **Why Standard RPCs Failed:**
  - The wallet's native ETH balance remained identical.
  - Centralized RPC providers returned cached or unverified `eth_getCode` responses.
  - The delegation persisted for nearly 4 hours undetected before being revoked on-chain.

### 3.2 Veriq's Cryptographic Protection
Veriq solves this through **authenticated state proofs**:
1. It queries `eth_getProof` for the wallet at a finalized block.
2. The state root is authenticated by the local **Helios light client**.
3. It proves the account's `codeHash` in the Merkle-Patricia trie.
4. It queries `eth_getCode` and computes $\text{keccak256}(\text{code}) == \text{codeHash}$.
5. A malicious RPC attempting to return `0x` (hiding the delegation) is caught immediately:
   $$\text{keccak256}(\mathtt{0x}) = \text{KECCAK\_EMPTY} \neq \text{codeHash}$$
   The proof verification fails, triggering `INVALID_PROOF`, tripping the circuit breaker, and alerting the user.

---

## 4. Verification Flow Architecture

```
                    ┌──────────────────────────────────────────────┐
                    │               Ethereum Network               │
                    └───────┬──────────────────────────────┬───────┘
                            │ Finality Update              │ eth_getProof + eth_getCode
                            ▼                              ▼
                 ┌─────────────────────────────────────────────────────┐
                 │                 Helios Light Client                 │
                 │              (Consensus State Root)                 │
                 └──────────────────────┬──────────────────────────────┘
                                        │
                                        ▼
                 ┌─────────────────────────────────────────────────────┐
                 │             Merkle Proof Verification               │
                 │   1. Validate accountProof against stateRoot        │
                 │   2. Extract trie account.codeHash                  │
                 │   3. Compute keccak256(code) == account.codeHash    │
                 └──────────────────────┬──────────────────────────────┘
                                        │
                                        ▼
                 ┌─────────────────────────────────────────────────────┐
                 │              EIP-7702 Code Classifier               │
                 │                                                     │
                 │   code == [] ?           ──► Normal EOA             │
                 │   code == 0xef0100..0 ?  ──► Revoked / Cleared      │
                 │   code == 0xef0100..addr?──► Active Delegation      │
                 │   other code             ──► Smart Contract         │
                 └──────────────────────┬──────────────────────────────┘
                                        │
                                        ▼
                 ┌─────────────────────────────────────────────────────┐
                 │           Delegate Target Verification              │
                 │   (Optional: Fetch & prove delegate contract code)  │
                 └──────────────────────┬──────────────────────────────┘
                                        │
                                        ▼
                 ┌─────────────────────────────────────────────────────┐
                 │               Trust Receipt Generation              │
                 │   Identity, Block, CodeHash, Delegation, Warnings   │
                 └─────────────────────────────────────────────────────┘
```

