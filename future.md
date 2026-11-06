# Veriq: how it works today, and what we build next

Planning doc for Veriq architecture and Delegation Guard (EIP-7702).
Written 2026-10-31 against branch `jiban_server` (`3519c87`, which includes provider re-probing, plus the
uncommitted root-cache change).

Part A describes the project as it runs now, with the file for each step.
Part B is the plan for the next feature: **Delegation Guard**, proof-backed detection of EIP-7702
delegations, prompted by the Binance hot-wallet hack of 29 October 2026.

---

# Part A: The current project

## A1. What Veriq is, in one paragraph

Veriq is a local Ethereum read engine. An app asks it for a balance, nonce, code or storage slot. Veriq
fetches the answer from ordinary RPC providers (Alchemy, publicnode, …), but **does not trust them**: every
answer comes with a Merkle proof, and Veriq checks that proof against a finalized state root it gets from
its own light client (Helios). If the proof doesn't match, the answer is rejected and the next provider is
tried. Every answer comes back with a **receipt** saying which block it was proven at, which providers
were tried, and what happened to each.

## A2. Pieces and where they live

All paths are relative to `Veriq/`.

| Piece | Folder | What it does |
|---|---|---|
| core | `backend/crates/core` | Shared types: `Policy`, `Receipt`, error codes (`error.rs`), env-var names, `ENGINE_ADDR` |
| verifier | `backend/crates/verifier` | Checks account and storage proofs against a state root; enforces size limits |
| light-client | `backend/crates/light-client` | Root sources: Helios (`helios_adapter.rs`), fixture, dev RPC; `CachedRoot` (`cached.rs`) |
| router | `backend/crates/router` | Startup provider probe (`probe.rs`), circuit breaker (`breaker.rs`), `MAX_PROVIDER_ATTEMPTS = 3` |
| server (engine) | `backend/crates/server` | JSON-RPC + HTTP (`rpc.rs`, `http.rs`), read loop (`engine.rs`), provider client (`provider.rs`), receipt store (`store.rs`), config (`config.rs`), startup (`main.rs`) |
| malicious-rpc | `backend/crates/malicious-rpc` | Demo attacker provider; lies on purpose (only with `--features demo`) |
| integration tests | `backend/tests/integration` | Real engine over HTTP against mock providers |
| database | `backend/database` | Prisma schema/migrations for the PostgreSQL receipt store |
| SDK | `frontend/sdk` | `@veriq/sdk`: TypeScript client, Zod schemas, React hooks, viem transport, `veriq` CLI |
| dashboard | `frontend/dashboard` | Vite app: landing page + `/app` (Overview, Feed, Attack Lab, Providers, Light Client, Policy, Developers) |
| contracts | `smart-contract` | `DemoStorage` (slot 0 = 42), deployed on Sepolia at `0x1242C562946C926a6d0012Acb54D9413A54A1CA4` |
| config | `backend/config` | `sepolia.toml` (network, bind address), `checkpoint.toml` (pinned Helios checkpoint) |
| scripts | `scripts` | `e2e.sh` (live check), `demo.sh`, `attack-check.sh`, `check-services.sh` |

## A3. Startup flow (`backend/crates/server/src/main.rs`)

```text
 1. Logging            tracing, filtered to Veriq crates (lib.rs DEFAULT_LOG_FILTER)
 2. Config folder      VERIQ_CONFIG_DIR, else ./config, else ./backend/config, else the source tree's
                       backend/config (config.rs); warns if none is found
 3. Config files       sepolia.toml (must say Sepolia and 127.0.0.1:8547, else refuse to start)
                       checkpoint.toml (Helios checkpoint + where it came from)
 4. Providers          VERIQ_PROVIDERS = "name=url,name=url"
 5. Receipt store      DATABASE_URL set -> PostgreSQL (keeps newest 5,000); else memory (keeps 500)
 6. Root source        VERIQ_ROOT_SOURCE:
                         helios         -> start Helios (needs --features helios)
                         fixture        -> fixed root from a fixture file (tests/demos)
                         dev-untrusted  -> root from an RPC; refused unless VERIQ_DEV_ALLOW_UNTRUSTED_ROOT=1,
                                           receipts then say "unverified"
                         (unset)        -> "unavailable": every verified read fails closed
 7. Root cache         wraps the root source in CachedRoot; background refresh every
                       VERIQ_ROOT_REFRESH_SECS (default 12)
 8. Startup probe      each provider: right chain? eth_getProof? EIP-1898 blockHash form?
                       (router probe.rs, 5 s per call)
 9. Engine             Engine::new(root, providers).with_probes(..).with_store(..).with_verified_cache(..)
10. Re-probe task      every VERIQ_REPROBE_SECS (default 300): re-probe providers marked ineligible
11. Listen             127.0.0.1:8547 only; CORS allows http://localhost:3000 only
```

## A4. The read flow (`veriq_readBalance` as the example)

```text
 app / SDK / dashboard
        │  POST 127.0.0.1:8547  {"method":"veriq_readBalance","params":[address, policy?]}
        ▼
 rpc.rs dispatch ──► parse address + policy (default: verifiedFinalized)
        │            unknown method -> UNSUPPORTED_VERIFICATION (never forwarded)
        ▼
 engine.rs route()
   1. policy check     verification=required + block=latest -> POLICY_UNSATISFIABLE, nothing sent
   2. pin the root     CachedRoot: cached finalized root if ≤ 36 s old, else ask Helios;
                       no root -> ROOT_UNAVAILABLE. The SAME root is used for every attempt below.
   3. verified cache   optional (VERIQ_VERIFIED_CACHE=1, single mode only): same block + address -> reuse
   4. provider loop    providers in config order, at most 3 attempts, within one overall deadline (timeoutMs)
        for each provider:
          skip if probe says ineligible, or the circuit breaker has it cooling down
          provider.rs ProofClient:
            eth_getProof(address, slots, {blockHash, requireCanonical})   EIP-1898, exact block
              └─ rejected with -32602? -> retry with the block number; remember "number only"
            (code reads also send eth_getCode at the same block, in parallel)
            response capped at 2 MiB (counted after decompression)
          verifier:
            proof ≤ 64 nodes × 1 KiB
            verify_account(stateRoot, address, accountProof) -> the PROVEN account
            claimed balance/nonce must equal the proven one, else INVALID_PROOF
            storage: verify_storage(storageRoot, slot, storageProof), found by slot
            code:    keccak256(code) must equal the proven codeHash
          outcome:
            ok              -> breaker success; stop (single) or ask one more (compare)
            INVALID_PROOF   -> breaker opens for 5 min on that provider
            transport/RPC   -> counts toward 3 failures -> 30 s cooldown
   5. compare mode     second proven value differs -> COMPARE_DIVERGENT warning;
                       no second answer -> COMPARE_UNAVAILABLE warning
   6. receipt          block (number, hash, stateRoot, finalized), verification (status, rootSource,
                       mechanisms), routing (every attempt + outcome), freshness, privacy, warnings,
                       request/result bindings
   7. store            receipt saved (memory or PostgreSQL); readable via /receipts and veriq_getReceipt
        ▼
 response   {"result": {...value, receipt}}  or  {"error": {code, message, data.code}}
```

Same path for `veriq_readStorage`, the `proofroute_*` aliases, and the finalized-only `eth_getBalance`,
`eth_getTransactionCount`, `eth_getCode`, `eth_getStorageAt`. `eth_chainId` is answered locally.

## A5. Error codes a caller can see (`backend/crates/core/src/error.rs`)

| Code | Name | When |
|---:|---|---|
| -32602 | `INVALID_REQUEST` | bad address/slot/policy, unknown receipt id |
| -32010 | `INVALID_PROOF` | every answer failed proof checks |
| -32011 | `ROOT_UNAVAILABLE` | no finalized root (Helios not synced, stale, or no root source) |
| -32012 | `UNSUPPORTED_VERIFICATION` | method Veriq can't verify |
| -32013 | `PRIVACY_UNAVAILABLE` | `privacy: required` (private transport is not built) |
| -32014 | `POLICY_UNSATISFIABLE` | e.g. `verification: required` with `block: latest` |
| -32015 | `PROVIDER_TIMEOUT` | deadline hit / transport failure |
| -32016 | `ALL_PROVIDERS_FAILED` | no provider gave a usable answer |
| -32603 | `INTERNAL_ERROR` | unexpected engine failure |

## A6. Background work while the engine runs

| Task | Every | What |
|---|---|---|
| Root refresh | 12 s (`VERIQ_ROOT_REFRESH_SECS`) | asks the root source for the finalized root, stores it in `RootCache`; logs only on available ↔ unavailable changes |
| Re-probe | 300 s (`VERIQ_REPROBE_SECS`) | re-probes providers marked ineligible; routable again only if the probe reaches them and they pass |
| Breaker cooldowns | — | time-based; a cooled-down provider is retried after 5 min (invalid proof) or 30 s (transport) |

## A7. Health and status (`GET /health`)

`status` ok/degraded, `rootSource` (`local-light-client` / `fixture` / `untrusted-rpc` / `null`), finalized
block number and hash, `lightClient` (synced, `lagSeconds` = root-cache age, `lastUpdateUnix`, checkpoint),
`rootCache` (age, last update, refresh interval, max age), `providers[]` (probe results, breaker state,
cooldown, success rate, last error). Also `veriq_getProviderHealth` and `veriq_getCapabilities` over JSON-RPC.

## A8. The attack demo

`malicious-rpc` sits in front of a real provider on `127.0.0.1:9545` and is listed **first** in
`VERIQ_PROVIDERS`, so every read hits it first. Its mode is set with `POST /mode`:

| Mode | The lie | What Veriq does |
|---|---|---|
| `off` | none | verified answer from the attacker |
| `value` | inflates the balance (+1000 ETH) | claimed ≠ proven → `INVALID_PROOF`, fails over to an honest provider |
| `proof` | corrupts proof nodes | proof fails → `INVALID_PROOF`, fails over |
| `wrongblock` | answers for a different block | proof doesn't match the pinned root → `INVALID_PROOF`, fails over |
| `outage` | HTTP errors | transport failure, fails over |

The Attack Lab page drives these modes and shows the plain-RPC answer next to Veriq's. After an
`INVALID_PROOF` the attacker is benched for 5 minutes. Demo builds (`pnpm demo`, `--features demo`) add a
loopback-only `POST /admin/reset-breakers` to show each mode fresh; the e2e script restarts the engine per mode.

## A9. Running it

```bash
cd Veriq
cp .env.example .env        # VERIQ_PROVIDERS, HELIOS_CONSENSUS_RPC, VERIQ_DEMO_CONTRACT=0x1242…1CA4
./scripts/check-services.sh # checks each service, never prints keys

# engine only (WSL/Linux)
cd backend
export OPENSSL_NO_VENDOR=1 CARGO_TARGET_DIR=$HOME/veriq-target
VERIQ_ROOT_SOURCE=helios cargo run -p veriq-server --features helios

# everything
pnpm install && pnpm demo   # attacker + engine (Helios) + dashboard -> http://localhost:3000/app
pnpm e2e                    # live check on Sepolia (stop the demo first: ports 8547/9545)
```

**Known local problem:** commit `38c7eee` converted most files to Windows (CRLF) line endings, so the
`.sh` scripts fail in bash with `set: pipefail: invalid option name`. Fix before merging: `.gitattributes`
with `* text=auto eol=lf` + `git add --renormalize .`. Until then: `sed -i 's/\r$//' scripts/*.sh`.

## A10. Test status (2026-10-30/31)

Rust 125 tests (core 6, verifier 22, light-client 11, router 11, server 56, integration 15 + 1 live,
malicious-rpc 7), SDK 75, dashboard 14 (+ type-check, build), `forge test` 3, live e2e 9/10 (the one failure is a
missing Node.js inside WSL). Details: `docs/INTEGRATION_REPORT.md`.

---

# Part B: Next feature: Delegation Guard (EIP-7702)

## B1. Why now

On **29 October 2026, ~20:21 UTC**, a Binance hot wallet on Ethereum ("Binance 14" on Etherscan) was
drained. The attacker sent one type-4 transaction with **50 EIP-7702 authorizations**, all signed with the
wallet's key, each with a different nonce; one matched. The wallet was now delegated to an attacker
"sweeper" contract, which emptied it about 3 minutes later (≈167,464 ETH + ≈1.6B USDT on Ethereum; Binance
reports ≈$6.3B across all chains). **The delegation stayed in place for nearly 4 hours** before Binance
revoked it. Blockaid's view: EIP-7702 didn't cause the hack (the keys/signing systems were compromised) but
it amplified it. Attribution so far: TRM Labs and Chainalysis point to North Korea's TraderTraitor.

Sources (read 2026-10-31): Cointelegraph "EIP-7702 didn't cause Binance hack, but may have amplified
losses"; CryptoNinjas (Blockaid analysis); FinanceFeeds. Figures differ between sources ($5.5B–$6.4B total;
$2.5B–$3B frozen). Re-check before quoting numbers in the pitch.

## B2. The weak point we target

Since Pectra (May 2025), one signature turns a normal wallet (EOA) into a delegated smart account:

- **Silent:** the address and balance look the same; behaviour now belongs to someone else's contract.
- **Persistent:** stays until revoked.
- **Invisible without trusting someone:** wallets, exchanges and monitors check `eth_getCode` on an RPC
  provider. A compromised or malicious provider can answer `0x` ("no code, all fine").

**Veriq's angle:** answer "is this wallet delegated, and to whom?" with a proof checked against our own
light client, so a lying provider cannot hide a delegation (or invent one).

## B3. How a delegation shows up on-chain (the technical basis)

- A delegated EOA's code is exactly **23 bytes**: `0xef0100` followed by the 20-byte delegate address
  (the EIP-7702 "delegation designator").
- The account's `codeHash` in the state trie is `keccak256(0xef0100 ‖ delegate)`.
- Not delegated: `codeHash` is `KECCAK_EMPTY` (empty code). A real contract: any other code.
- Revoking = delegating to the zero address, which clears the code back to empty.

Veriq **already** proves code: `ReadKind::Code` fetches `eth_getProof` + `eth_getCode` at the pinned block
and requires `keccak256(code) == proven codeHash` (`engine.rs`, mechanisms `AccountProof` + `CodeHash`).
So the delegate address comes out of a value that is already proven. The new work is parsing, the API, the
watch list, the UI and the demo.

```text
                     ┌───────────── proven against Helios state root ─────────────┐
 address ──► eth_getProof ──► account { nonce, balance, storageRoot, codeHash }    │
          └► eth_getCode  ──► code ──► keccak256(code) == codeHash ? ──────────────┘
                                         │ yes
                                         ▼
                       code empty?            -> NOT DELEGATED (EOA)
                       code = ef0100 ‖ addr?  -> DELEGATED to addr
                       other code             -> CONTRACT (not an EOA)
```

## B4. What we build, in phases

### Phase 1: `veriq_getDelegation` (engine + RPC): ~0.5 day

- **Engine** (`engine.rs`): `read_delegation(meta, address) -> DelegationRead` built on `read_code`:
  - parse the proven code into `Delegation { NotDelegated, DelegatedTo(Address), Contract }`;
  - keep the receipt from the code read (`mechanisms: accountProof, codeHash`).
- **Core** (`backend/crates/core`): a small `delegation` module with
  `parse_designator(code: &[u8]) -> Option<Address>` (exactly 23 bytes and the `ef0100` prefix; anything
  else is `None`) + unit tests (empty, valid, wrong prefix, 22/24 bytes, zero address).
- **RPC** (`rpc.rs`): `veriq_getDelegation(address, policy?)` (+ `proofroute_getDelegation` alias);
  listed in `methods` and `verifiedMethods` of `veriq_getCapabilities`. Result:

  ```json
  {
    "address": "0x…",
    "status": "delegated",            // "not-delegated" | "delegated" | "contract"
    "delegate": "0x…",                // null unless delegated
    "codeHash": "0x…",
    "block": { "number": 12028370, "hash": "0x…" },
    "receipt": { … }                  // same receipt format as every other read
  }
  ```
- **Tests**: a `read_path`-style test per status with mock proofs; a test that a provider returning `0x`
  code for a delegated account is rejected (`INVALID_PROOF`: hash doesn't match the proven `codeHash`).
- **Live check**: delegate a throwaway Sepolia EOA with `cast send --auth` (Foundry supports EIP-7702), read
  it through Veriq, then revoke and read again.

### Phase 2: attacker mode `hidedelegation` (demo): ~0.5 day

- `malicious-rpc`: new mode that answers `eth_getCode` with `0x` and rewrites `codeHash` in `eth_getProof`
  to `KECCAK_EMPTY`, so a plain client sees "not delegated".
- Veriq: the rewritten account fails the proof against the light-client root → `INVALID_PROOF` → fails
  over → honest provider → **"delegated to 0x…"**.
- Attack Lab: add the mode with a side-by-side "plain RPC says: clean / Veriq proves: delegated to 0x…".
- `e2e.sh`: a `delegation` step against the throwaway delegated EOA (skips if `VERIQ_DEMO_DELEGATED` is unset).

### Phase 3: watch list + alerts: ~1 day

- **Engine**: `VERIQ_WATCH = "name=0xaddr,name=0xaddr"` (and/or `POST /watch` on loopback). A background
  task re-checks every watched address each time the cached finalized root changes (it already refreshes
  every 12 s).
- **Store**: last known status per address; on a change (`not-delegated → delegated`, delegate changed,
  revoked) record an **alert** with both receipts (before/after block).
- **HTTP**: `GET /watch` (current status of each address), `GET /alerts?limit=` (newest first). Optional
  webhook `VERIQ_ALERT_WEBHOOK` (POST JSON, never includes provider URLs).
- **Optional flag list**: a small, local list of known sweeper/drainer delegate addresses; status
  "delegated to a known drainer" when matched. Keep it a plain file; no external service.

### Phase 4: SDK + dashboard: ~1 day

- **SDK** (`frontend/sdk`): `veriq.getDelegation(address)`, Zod schema, `useDelegation` React hook,
  `veriq delegation <address>` CLI command; contract test against a real engine response.
- **Dashboard**: new page **Delegation Guard**:
  - lookup box (address → status, delegate, block, receipt drawer);
  - watch-list table (address, status, delegate, last checked block, since when);
  - alerts timeline;
  - the Binance case as a short explainer card (with sources).

### Phase 5: pre-transaction check (stretch)

`veriq.assertNotDelegated(address)` / `policy.requireNotDelegated`: an SDK guard an app calls before
sending funds to, or asking a user to sign for, an address. Fails with a typed error if the proven state
says the account is delegated to an unexpected contract.

## B5. Acceptance (definition of done)

1. `veriq_getDelegation` returns the correct status for an EOA, a delegated EOA and a contract on Sepolia,
   each with a verified receipt at a finalized block.
2. A provider that hides the delegation (code `0x`, or a forged `codeHash`) is rejected with `INVALID_PROOF`
   and the honest provider's answer is returned. Covered by a test and by the `hidedelegation` demo mode.
3. A watched address that gets delegated produces an alert within one root refresh after the delegation is
   finalized.
4. All existing tests still pass; new code has unit + integration tests; `/health` and receipts unchanged
   for existing methods.

## B6. Limits we must say out loud (judges will ask)

- **It does not prevent the theft.** Binance's own keys signed the authorization; no read tool stops that.
- **Finality delay.** Veriq trusts only finalized blocks (~13 min behind head). The Binance drain took ~3
  minutes, so Delegation Guard would **not** have stopped that drain. It **would** have flagged, with proof,
  the delegation that stayed live for ~4 hours, and it protects anyone checking an address before sending.
- **Faster, weaker signal (optional):** a "latest block, unverified" early warning could be shown next to the
  verified status, clearly labelled as unproven, then confirmed at finality.
- **Only Ethereum.** EIP-7702 is Ethereum-only; the BTC/XRP/Solana parts of the Binance theft are out of scope.

**Pitch line:** *"Proof-backed EIP-7702 delegation detection: a lying or compromised RPC cannot hide that a
wallet now belongs to someone else's contract."*

## B7. Other future work (from `docs/INTEGRATION_REPORT.md` §7)

| Item | Why | Size |
|---|---|---|
| Line-ending fix (`.gitattributes` + renormalize) | scripts broken on Linux/macOS since `38c7eee` | 10 min, do first |
| Confirm GitHub Actions on `jiban_server` | not visible from this machine | 5 min |
| Re-check Docker compose + 8 dashboard pages after the folder move | not re-verified since `7064c77` | small |
| Fill the footer `TEAM` names | placeholder | tiny |
| Private transport (Anyone SOCKS) | `privacy=required` fails closed today | out of scope |

## B8. Suggested order

1. Line-ending fix → merge `jiban_server` into `main` (after the Actions run is green).
2. Delegation Guard Phase 1 + 2 (the core claim and the demo), about a day.
3. Phase 4 page + SDK, then Phase 3 watch list if time allows.
4. Update `docs/INTEGRATION_REPORT.md`, `docs/demo-script.md` and `docs/judging-qa.md` with the new feature.

---

# Part C: Private reads through Anon-RPC (Nox)

The detailed, line-by-line build plan lives in [`ANON_RPC_BUILD_PLAN.md`](ANON_RPC_BUILD_PLAN.md).
It expands the Tier 1 / Tier 2 / Tier 3 roadmap into files, functions, tests and acceptance checks.

**The idea.** A browser fetches `eth_getProof` itself through a mixnet (Nox on Sepolia), then hands
the raw proof to the engine. The engine checks it against its own Helios-finalized root and returns
a normal receipt with `privacy.transport = "anon-rpc"` and `privacy.mechanism = "nox"`. The engine
never contacts the provider for that read, so the provider sees the mixnet exit, not the user's IP.
The answer is still bound to the same finalized root as every other Veriq read.

**The flow.**

```text
browser ──veriq_getRoot──► engine        (which finalized block to fetch)
browser ──eth_getProof───► Nox ──► provider
browser ──veriq_verifyProof(proof, blockHash, provider, network)──► engine
                                      └─ verify against its own root, save receipt
browser ◄── value + receipt (transport anon-rpc, mechanism nox)
```

**What is already written (2026-11-05).**

- Rust: `Transport::AnonRpc`, `ClientProof`, `Engine::pinned_root`, `Engine::verify_client_proof`,
  `veriq_getRoot`, `veriq_verifyProof`, `clientProofTransports: ["anon-rpc"]`, 7 JSON-RPC tests.
- SDK: `getRoot()`, `verifyProof()`, `createPrivateReader()` (untested), `anon-rpc` in the receipt
  schema.
- Not started: dashboard integration, `@anon-rpc/browser-harness`, hosted bootstrap, Attack Lab,
  private probes, default-private SDK, browser Helios, browser WASM verifier, mainnet Tor/Nym,
  docs/pitch, all latency work.

**Order.** Review and commit M1 → M2 + SDK tests → M0 feasibility page → M3 dashboard → M4 hosting →
S1–S3 → S4–S6 (only if M0 says feasible) → S7 docs → Tier 3 latency with before/after numbers.

**Cut lines.** If M0.4 fails, cut S5 (keep engine verification). If M0.1 fails, keep beacon traffic
direct and still send execution reads through Nox. If M0.3 fails, cut L7. Write the reason in the
integration report; do not claim a pass that was not measured.
