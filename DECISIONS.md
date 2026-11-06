# Veriq — Decisions

## Helios light client

| Field | Value |
|---|---|
| Crate | `helios-ethereum` |
| Pinned commit | `2af9b41887e069144ee56cd710f3ddca195473f8` |
| Network | Sepolia |
| Bootstrap checkpoint | `0x5e6d1963c8d096f71ce4bc9da07c75ca169c0821ce549fcebc5397d693d1155a` |
| Checkpoint source | beaconcha.in (beacon explorer, independent of the consensus RPC) |
| Consensus RPC | Nimbus public Sepolia beacon API (`unstable.sepolia.beacon-api.nimbus.team`) |
| Execution RPCs | Two independent providers; both matched the same finalized block |
| Finalized block | `11996907` |
| Finalized block hash | `0xb6116417eb4628dd8682d85fff67ee45e1fa3e72f1569e5a92892f07a29e99d3` |
| Finalized state root | `0x320f1a724626c7f4e3f0aff7bfc4a0a85123a32d0d1325d2dbd62e81c0f23a4b` |
| Initial sync | 7.24 s |
| Cross-check | Both execution providers returned the same hash and state root |
| Sync observed | 2026-10-26, ~7.2 s to first finalized root |
| Live receipt bootstrap | `{source:"helios", checkpoint, checkpointSource:"beaconcha.in"}` |
| Fixture block | Same finalized block `11996907`; proofs captured from `EXEC_RPC` and cross-checked |
| Second provider | PublicNode Sepolia (QuickNode Discover plan rejects `eth_getProof` for finalized blocks with HTTP 413, so it is not in `VERIQ_PROVIDERS`) |
| Helios data dir | `/tmp/veriq-helios-live` for the live engine run |

## Verification policy

| Field | Value |
|---|---|
| Block policy | `finalized` only |
| Non-finalized tag (`latest`, `safe`, `pending`, `earliest`, numeric) | `POLICY_UNSATISFIABLE` (locked spec; 9A prompt mentioned `UNSUPPORTED_VERIFICATION`, policy wins) |
| Absent account / zero slot | `0` only after a valid exclusion proof |
| Claimed value ≠ proven value | `INVALID_PROOF`; provider attempt fails over, never returned as verified |

## Root cache

| Field | Value |
|---|---|
| L3 | `RootCache` backed by one `tokio::sync::watch` channel with `subscribe()` |
| Live freshness | Root read fresh from Helios per request; no stale cache |

## Project

| Date | Decision | Context / Rationale |
|------|----------|---------------------|
| 2026-10-26 | Workspace & CI Setup (Part 1) | Established unified 6-crate Cargo workspace (`veriq-core`, `veriq-verifier`, `veriq-light-client`, `veriq-router`, `veriq-server`, `veriq-malicious-rpc`), configured shared workspace dependencies and lint levels (`forbid unsafe`, `clippy::all warn`). Configured parallel GitHub Actions CI workflow for Rust (`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`) and PNPM (`pnpm -r test`, `pnpm -r build`) with action caching. Ensured fail-closed `.gitignore` rules for keys, secrets, and SQLite stores. |
| 2026-10-26 | Renamed to Veriq | Project mechanically renamed from ProofRoute to Veriq across crates, RPC methods, SDK, and configuration. |
| 2026-10-26 | Workspace & CI Setup (Part 1) | Established unified 6-crate Cargo workspace (`veriq-core`, `veriq-verifier`, `veriq-light-client`, `veriq-router`, `veriq-server`, `veriq-malicious-rpc`), configured shared workspace dependencies and lint levels (`forbid unsafe`, `clippy::all warn`). Configured parallel GitHub Actions CI workflow for Rust (`cargo fmt --check`, `cargo clippy --workspace --all-targets -- -D warnings`, `cargo test --workspace`) and PNPM (`pnpm -r test`, `pnpm -r build`) with action caching. Ensured fail-closed `.gitignore` rules for keys, secrets, and SQLite stores. |
| 2026-10-27 | Integration (branch `integration`) | One `Policy` type in veriq-core; the engine routes all reads through one path using veriq-router's probe and circuit breaker; receipt store + `/receipts`; dashboard stays on Vite (a Next.js migration would rewrite the landing); `spikes/helios-spike` removed after its findings were recorded in the Helios table above. See `docs/INTEGRATION_REPORT.md`. |
