# Veriq — Module Connection Matrix & Integration Audit

> **Document Version:** 1.0.0  
> **Date:** November 2026  
> **Status:** Phase B Delivery  
> **Auditors:** Principal Software Architect, Senior Rust Engineer, TypeScript SDK Engineer, Security Engineer

---

## 1. Overview & Verification Scope

This matrix audits every architectural connection between Veriq's sub-systems:
1. **Rust Backend Inter-Crate Connections:** Core models, verifier, router, light-client, server, and storage.
2. **SDK & Browser Integration:** Engine JSON-RPC, in-browser WebAssembly verifier, in-browser Helios client, and Nox/WebRTC worker.
3. **Dashboard Web Application:** UI routing, real-time metrics, Attack Lab simulation, and live receipt drawer.
4. **Database & Audit Trail:** Prisma schema, PostgreSQL connection pooling, serialization, and ring buffer retention.

---

## 2. Comprehensive Module Connection Matrix

| # | Source Module | Destination Module | API / Function | Data Format | Authentication / Security | Error Handling | Test Coverage | Current Status |
|---|---|---|---|---|---|---|---|---|
| **1** | `veriq-server::engine` | `veriq-core` | `Policy`, `Receipt`, `ProvenAccount` | Rust structs / Serde JSON | In-process type safety | Compiler enforced | `crates/core/tests/receipt_sample.rs` | **`IMPLEMENTED`** |
| **2** | `veriq-server::rpc` | `veriq-server::engine` | `Engine::route`, `Engine::verify_client_proof` | JSON-RPC 2.0 (`Value`) | CORS loopback check (`localhost:3000`) | Standard error codes (`-32010` to `-32017`) | `server/tests/read_path.rs` (45 tests) | **`IMPLEMENTED`** |
| **3** | `veriq-server::engine` | `veriq-light-client` | `CachedRoot::current_root` | `PinnedRoot` (`B256`, `u64`) | In-process weak-subjectivity checkpoint | `ROOT_UNAVAILABLE (-32011)` fail-closed | `light-client/tests/cached_root.rs` (6 tests) | **`IMPLEMENTED`** |
| **4** | `veriq-server::engine` | `veriq-router` | `CircuitBreaker::record_invalid_proof`, `record_transport_failure` | Internal state enum | URL masked, zero log leakage | 300s / 30s automatic cooldown | `router/src/breaker.rs` (8 tests) | **`IMPLEMENTED`** |
| **5** | `veriq-server::engine` | `veriq-verifier` | `verify_account`, `verify_storage` | RLP-encoded bytes, `alloy-trie` nodes | Hard bounds (64 nodes, 1KB/node, 2MB body) | `INVALID_PROOF (-32010)` on mismatch | `verifier/tests/tests.rs` (16 tests) | **`IMPLEMENTED`** |
| **6** | `veriq-server::engine` | `veriq-server::store` | `ReceiptStore::save_receipt`, `get_receipt` | `StoredReceipt` / JSONB | Async non-blocking (capped at 2s) | Degrades to in-memory ring buffer (500 rows) | `server/src/store.rs` & `read_path.rs` | **`IMPLEMENTED`** |
| **7** | `frontend/sdk` (`client.ts`) | `veriq-server` (`rpc.rs`) | HTTP POST `veriq_readBalance`, `veriq_readStorage` | JSON-RPC 2.0 over HTTP | Optional HTTP headers / CORS | `VeriqError` subclasses | `frontend/sdk/test/client.test.ts` (19 tests) | **`IMPLEMENTED`** |
| **8** | `frontend/sdk` (`transport.ts`) | `frontend/sdk` (`client.ts`) | `createTransport()` (Viem adapter) | Viem EIP-1193 request format | Wrapped Viem transport | Surfaces `requestWithReceipt` | `frontend/sdk/test/transport.test.ts` (7 tests) | **`IMPLEMENTED`** |
| **9** | `frontend/sdk` (`private.ts`) | `spikes/anon-rpc` / Nox | `worker.fetch(provider.url)` | JSON-RPC 2.0 over WebRTC mixnet | No client IP or address visible to RPC | Bounded retries on `-32602` proof-window | `frontend/sdk/test/private.test.ts` (46 tests) | **`IMPLEMENTED`** |
| **10** | `frontend/sdk` (`private.ts`) | `veriq-server` (`rpc.rs`) | `veriq_getRoot`, `veriq_verifyProof` | JSON-RPC 2.0 | Request/result binding `keccak256` | `ROOT_MISMATCH (-32017)` if consensus drifts | `frontend/sdk/test/private.test.ts` | **`IMPLEMENTED`** |
| **11** | `frontend/sdk` (`wasm.ts`) | `veriq-verifier-wasm` | `loadVerifier()`, `verifyRead()` | Linear memory byte pointer `(ptr << 32) \| len` | Memory bounds checking; safe alloc/free | Returns `{ ok: false, code: 'INVALID_PROOF' }` | `frontend/sdk/test/wasm.test.ts` (8 tests) | **`IMPLEMENTED`** |
| **12** | `frontend/sdk` (`private.ts`) | `frontend/sdk` (`wasm.ts`) | In-browser client proof validation | Internal JS objects | Local memory FFI | Rejects invalid proofs before hitting engine | `frontend/sdk/test/private.test.ts` | **`IMPLEMENTED`** |
| **13** | `frontend/dashboard` | `frontend/sdk` | `createVeriq()`, `createPrivateReader()` | TypeScript module import | Pre-bundled ESM/CJS assets | Typed errors caught by React Error Boundary | `dashboard/lib/engine.test.ts` (15 tests) | **`IMPLEMENTED`** |
| **14** | `frontend/dashboard` (`anon.ts`) | `@anon-rpc/browser-harness` | Singleton `AnonRpcWorker` | WebRTC data channel | Keyless public RPC endpoints | Status: `connecting` $\to$ `ready` $\to$ `failed` | `dashboard/lib/anon.test.tsx` (9 tests) | **`IMPLEMENTED`** |
| **15** | `frontend/dashboard` (`lightclient.ts`) | `@a16z/helios` | Browser WebAssembly consensus sync | Consensus SSZ / JSON | Proxy via Nox (`.invalid` host interception) | Dynamic checkpointz bootstrap fallback | `dashboard/lib/lightclient.test.ts` (14 tests) | **`IMPLEMENTED`** |
| **16** | `frontend/dashboard` (`AttackLab.tsx`) | `veriq-malicious-rpc` | POST `127.0.0.1:9545/attack` | JSON `{ "mode": "value" }` | Loopback admin interface | Displays live detection & circuit break | `dashboard/pages/AttackLab.test.tsx` (7 tests) | **`IMPLEMENTED`** |
| **17** | `backend/database` | PostgreSQL 16 | SQLx connection pool (`DATABASE_URL`) | PostgreSQL binary protocol | Parameterized queries (no SQL injection) | Non-blocking write timeout (2s cap) | `server/src/store.rs` PostgreSQL unit tests | **`IMPLEMENTED`** |

---

## 3. Detailed Verification of Critical Sub-Systems

### 3.1 Rust Backend: Verifier $\leftrightarrow$ Consensus Light Client
- **Requirement:** The state root used to verify Merkle proofs must originate strictly from the Helios light client or pinned test fixtures; untrusted execution providers must never supply the root.
- **Verification Result:** In [`engine.rs`](file:///Applications/Development/veriq/backend/crates/server/src/engine.rs#L318), the engine reads `self.root_source.current_root().await?`. The resulting `PinnedRoot` (`hash` and `state_root`) is passed directly into [`verify_account`](file:///Applications/Development/veriq/backend/crates/verifier/src/lib.rs#L18) and [`verify_storage`](file:///Applications/Development/veriq/backend/crates/verifier/src/lib.rs#L72). If a provider attempts to return a proof claiming a different state root, the trie verification immediately fails with `INVALID_PROOF`.

### 3.2 SDK $\leftrightarrow$ Browser WebAssembly Verifier
- **Requirement:** The browser must be capable of verifying proofs locally before dispatching to the engine or when operating in local-only offline mode.
- **Verification Result:** In [`wasm.ts`](file:///Applications/Development/veriq/frontend/sdk/src/wasm.ts), `loadVerifier()` initializes `veriq_verifier.wasm` (~198 KiB) using `WebAssembly.instantiate`. Memory is allocated via `veriq_alloc` and deallocated via `veriq_free`. In [`private.ts`](file:///Applications/Development/veriq/frontend/sdk/src/private.ts#L431), every private read checks `verifier.verifyRead()`. A lying provider is caught locally in **~4.8 ms** without ever sending a request to the engine.

### 3.3 Dashboard $\leftrightarrow$ Mixnet Worker Lifecycle
- **Requirement:** The Nox worker must be maintained as a single persistent session per tab to prevent WebRTC tunnel re-negotiation overhead (~6-8s).
- **Verification Result:** In [`anon.ts`](file:///Applications/Development/veriq/frontend/dashboard/src/dashboard/lib/anon.ts), `startAnon()` stores the running instance in a module-level singleton `workerPromise`. React StrictMode double-mounting is guarded against re-initialization.

### 3.4 Circuit Breaker $\leftrightarrow$ Failover Execution
- **Requirement:** When a provider serves forged balances or broken proof bytes, it must be cooled down and the read must fail over to an honest provider.
- **Verification Result:** Verified in `veriq-router` unit tests and `tests/integration/wrong_block.rs`. The invalid provider enters a 5-minute cooldown (`INVALID_PROOF_COOLDOWN`). The engine's read loop advances to provider #2, which answers honestly at the same pinned block.

