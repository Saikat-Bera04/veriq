# Anon-RPC feasibility (M0)

Results of the M0 probes in [ANON_RPC_BUILD_PLAN.md](../ANON_RPC_BUILD_PLAN.md). Page:
[spikes/anon-rpc/](../spikes/anon-rpc/) (`npm install && npm run serve`, then open
`http://127.0.0.1:5180/`). Each section records date, browser, network, request, status, headers and,
on failure, the exact error.

| Probe | Verdict |
|---|---|
| M0.0 test page skeleton | **PASS** (2026-11-05) |
| M0.1 Nox to the beacon API | **FAIL** (2026-11-05, Nox rejects the beacon TLS certificate) |
| M0.2 Nox to a public RPC (`eth_getProof`) | **PASS** (2026-11-05, with retries; see finding) |
| M0.3 gzip through Nox | **PASS** (2026-11-05, origin sees gzip; browser decompresses before app) |
| M0.4 Rust verifier in WebAssembly | **PASS** (2026-11-05, 202,759-byte wasm verifies the EOA fixture and rejects a tampered proof) |

## M0.0 — Test page skeleton

**Date:** 2026-11-05 · **Browser:** Microsoft Edge (Chromium), headless, Windows · **Network:** Nox
(specifier `0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A`, Sepolia)

| Check | Result |
|---|---|
| Harness import | `@anon-rpc/browser-harness` **0.4.0** from npm (MIT), pinned in `spikes/anon-rpc/package.json`, the same package the dashboard will add. Loaded from `node_modules` with an import map, no build step. Dependency tree: `@anon-rpc/harness-core` 0.4.0, `@kpstreams/webrtc-client` 0.2.1, `@kpstreams/core` 0.2.1, `@noble/hashes` 1.8.0 |
| Import map | 7 entries. The first run failed with `Failed to resolve module specifier "@noble/hashes/crypto"` (`sha3.js` imports it by package name); adding that entry fixed it. Any missing entry fails the same way |
| Worker states | `connecting` at page load, `ready` after **8.3 s** and **6.1 s** (two runs), `failed` shown with its reason (`?fail=1`, an address with no specifier contract: `Error: short bytes32 return`). Badge is `role="status"` with the state as text |
| Run all | Runs every probe in order; `window.__m0` exposes `worker`, `readyMs`, `error`, `probes`, `done` for the browser smoke |
| Page errors | 0 (console errors, exceptions, failed loads) in both runs |
| Worker log | Nox's own `info` lines are forwarded to the page log (`boot.*`, `kps.dial.ok`, `kps.connected`, `ready`) |
| Privacy | Public, keyless endpoints only (PublicNode Sepolia, Nimbus beacon API). No API key, account address or `.env` value in the page or its log. The specifier is read once, directly, from PublicNode (the harness's bootstrap; not anonymized) |
| Static server | `serve.mjs`, loopback only, serves only files inside `spikes/anon-rpc/` (an encoded `../..` request gets 404) |

All four probe buttons are implemented and were run on 2026-11-05.

## M0.1 — Nox to the beacon API

**Run 2026-11-05: FAIL (TLS certificate rejected inside Nox).** Headless Chrome 156 on Windows, Nox
worker `ready` in 5.1 s. Every request returned the same error, after the Nox transport had connected:

```text
NoxWorkerError: Error: TLS session with 'unstable.sepolia.beacon-api.nimbus.team' failed:
invalid peer certificate: UnknownIssuer
```

| Check | Cold / warm | Status | Body bytes | Result |
|---|---|---|---|---|
| `headers/head` | 1324 / 953 ms | fail | 0 | `UnknownIssuer` |
| `finality_update` | 1149 / 812 ms | fail | 0 | `UnknownIssuer` |
| `optimistic_update` | 869 / 808 ms | fail | 0 | `UnknownIssuer` |
| `config/spec` | 4014 / 955 ms | fail | 0 | `UnknownIssuer` |
| `bootstrap` | — | skipped | — | no head root (head GET failed) |
| `updates` | — | skipped | — | no head slot |
| `preflight` (OPTIONS) | 3120 ms | fail | 0 | `UnknownIssuer` |
| `preflightGet` (+`x-m0-probe`) | 1649 ms | fail | 0 | `UnknownIssuer` |

This is not CORS and not an HTTP error: the TLS session is rejected before a request is sent. Nox
(harness 0.4.0) does not trust the certificate chain served by
`unstable.sepolia.beacon-api.nimbus.team`. The same harness reaches PublicNode over TLS in M0.2, so
the failure is specific to that beacon endpoint's chain, not to Nox TLS in general.

**Decision:** keep Helios consensus/beacon traffic direct, exactly as it is today, and anonymize only
the execution-layer reads that carry the address. The private-read proof does not require the beacon
API to go through Nox. If beacon anonymity is wanted later (S4.1), test another beacon endpoint whose
chain the harness trusts, or use a harness TLS configuration if one is exposed; do not block M1/M2 on
this. Recorded so the split is deliberate, not an omission.

Repro: `npm run serve`, open `http://127.0.0.1:5180/?autorun=1` (or click **Run all**), read
`window.__m0.probes.m01`.

## M0.2 — Nox to a public RPC (`eth_getProof`)

**Run 2026-11-05: PASS (with retries).** Headless Chrome 156 on Windows, worker `ready` in 5.1 s,
all checks 15.5 s. The probe now retries each proof call up to 4 times and records every attempt.

| Check | Attempts / latency | Result |
|---|---|---|
| chain | 1 / 1484 ms | `eth_chainId` = `0xaa36a7` |
| block | 1 / 1766 ms | finalized number `0xb82f62`, hash `0x94043e…b966` |
| finalized tag | 2 / 2195 ms | attempt 1 `-32602 window`, attempt 2 **ok**, 11-node `accountProof`, 0 `storageProof` |
| EIP-1898 `{blockHash}` | 4 / 1912 ms | 3 × `-32602 window`, attempt 4 **ok**, 11-node `accountProof` |
| exact number `"0xb82f62"` | 1 / 955 ms | **ok**, 11-node `accountProof` |

Every failure above is HTTP 200 carrying JSON-RPC `-32602 distance to target block exceeds maximum
proof window`; the transport itself worked on every call and returned headers (`content-type`,
`vary`) plus a JSON-RPC body.

**Finding — PublicNode is load-balanced across backends with different proof windows.** The same
finalized block can fail on one request and answer on the next (direct checks outside the page saw
roughly 1 success in 10 for `finalized`, then 1 in 2; here 1 in 2 and 1 in 4). A single `-32602` is
therefore not evidence that the block is outside the window. Consequences:

- The private reader must retry `eth_getProof` (bounded retries with a short backoff) on `-32602`,
  and must not cache the error as "proof unavailable". This is required behavior for M2, not just a
  probe detail.
- Alternatively, use a provider with a stable archive/proof window. PublicNode remains usable because
  a retry succeeds, but it makes the first-read latency variable.
- `eth_getProof` by exact block number was the most reliable form in this run; the SDK should keep
  number and hash forms with fallback rather than assuming hash-first always wins.

**Second fresh run (same day, `?autorun=m02`):** the finalized tag failed 4/4 and the exact number
failed 4/4, while the EIP-1898 `{blockHash}` form succeeded on attempt 4. The three calls refer to the
same finalized block, so the pass criterion is **any encoding of the finalized block**, not the tag
specifically. This is direct evidence for the fallback requirement: the SDK should try tag, hash and
number in sequence, with bounded retries, rather than pinning one form.

Verdict `pass` requires the chain id and a proof at the finalized block in at least one encoding
after retries; the individual forms are reported separately. Full response bodies are never logged,
only the compact proof shape.

Repro: `npm run serve`, open `http://127.0.0.1:5180/?autorun=1` (or click **Run all**), read
`window.__m0.probes.m02`; optional attacker repeat with `?attacker=…`.

## M0.3 — gzip through Nox

**Run 2026-11-05: PASS (origin sees gzip; the browser decompresses before app code).** Fresh worker,
Headless Chrome 156 on Windows, latest block `0xb82fd7`, all checks 15.9 s. M0.3 uses the latest block
rather than finalized: the proof-window flakiness from M0.2 would otherwise dominate, and compression
does not depend on finality.

| Check | Latency | Decoded bytes | Result |
|---|---|---|---|
| proof, browser-default `Accept-Encoding` | 2469 ms | 7986 | 11-node `accountProof` |
| proof, `Accept-Encoding: identity` | 706 ms | 7986 | 11-node `accountProof` |
| proof, `Accept-Encoding: gzip` | 2211 ms | 7986 | 11-node `accountProof` |
| echo `GET https://httpbingo.org/anything` | 1734 ms | 676 | origin saw `accept-encoding: ["gzip"]` and `x-m0-probe: ["1"]` |
| `GET https://httpbingo.org/gzip` | 1046 ms | 567 | JSON parsed as `{ "gzipped": true }` after decompression |

What this proves:

- Nox forwards a custom `Accept-Encoding: gzip`; the echo origin saw it. The same was true for an
  unrelated custom header (`x-m0-probe`), so header forwarding is not limited to `Accept-Encoding`.
- `httpbingo.org/gzip` always returns a gzip body (verified directly: even `identity` gets
  `content-encoding: gzip`). The page could parse its JSON, so the browser decompressed it before
  app code. Response compression survives the Nox + browser path.
- `content-encoding` and `content-length` are hidden from `Response.headers` by the browser fetch
  implementation, and PublicNode sends proof responses chunked (no `content-length`). The exact
  compressed-vs-decoded size of an `eth_getProof` body is therefore not observable in the page; the
  `/gzip` parse is the end-to-end evidence. `content-encoding` is not used by the app either way.

**Decision:** L7 (gzip) is allowed into Tier 3, subject to the tunnel-budget finding below. Do not
add app-level compression handling; the browser already decompresses.

### Cross-probe finding — Nox tunnel budget

A combined run that sent M0.1 (8 failed TLS requests), M0.2 (about 10 RPC calls including retries) and
M0.3 (the full retry set) ended with `NoxWorkerError: NoTunnelExitError: No exit offers TLS tunnels`
on the last M0.3 calls. A fresh page running only M0.3 passed every request. The worker's tunnel pool
is finite and does not recover instantly under a burst. For M3/M4 this means: bounded retries with
backoff, a per-page request budget, and a worker restart/recreate path when `NoTunnelExitError`
appears. Do not interpret it as an origin failure. The probe now supports `?autorun=m03` to run one
probe on a fresh worker for exactly this reason.

## M0.4 — Rust verifier in WebAssembly

**Run 2026-11-05: PASS.** A separate crate, `backend/crates/verifier-wasm` (workspace member,
`cdylib` + `rlib`), wraps the existing `veriq-verifier` without changing its API. It exposes a raw
ABI (no wasm-bindgen): `veriq_alloc`, `veriq_free` and `veriq_verify_account(ptr, len) -> u64`, where
the return packs `(output pointer << 32) | output length`. The page allocates, copies JSON in, reads
the JSON result out and frees both buffers.

Build (also `npm run build:wasm` in the spike):

```bash
rustup target add wasm32-unknown-unknown
cargo build -p veriq-verifier-wasm --target wasm32-unknown-unknown --release \
  --manifest-path backend/Cargo.toml
cp backend/target/wasm32-unknown-unknown/release/veriq_verifier_wasm.wasm spikes/anon-rpc/
```

| Check | Result |
|---|---|
| Artifact | `verifier_wasm.wasm`, **202,759 bytes** (~198 KiB), exports `memory`, `veriq_alloc`, `veriq_free`, `veriq_verify_account` |
| Instantiate in Headless Chrome 156 | **5 ms** |
| Verify `fixtures/eoa.json` | **4.8 ms**, `ok: true`, `exists: true`, nonce 13, balance `0x111b142f3a300f5` |
| Compare with fixture | nonce, balance, `storageRoot` and `codeHash` all match |
| Tampered proof (last leaf byte flipped) | rejected: `INVALID_PROOF: claimed account does not match proven account` |
| Compile blockers | none: `veriq-verifier` pulls only alloy primitives/RLP/trie; no `getrandom`, native TLS, rayon or `std::time` in the wasm graph |

**Decision:** S5 is kept (browser verifier is feasible). The raw ABI is enough for the feasibility
gate; the production wrapper can use wasm-bindgen or keep this ABI. The crate deliberately does not
inherit the workspace `unsafe_code = "forbid"` lint because the pointer handoff is the FFI boundary;
all unsafe is confined to `veriq_alloc`/`veriq_free`/`veriq_verify_account` with documented safety
contracts.

Repro: `npm run build:wasm`, then `npm run serve` and `http://127.0.0.1:5180/?autorun=m04`.

## M0 exit gate

- [x] Every probe has a section above with a pass/fail verdict and exact evidence.
- [x] Tier 1 decision written:
  - **M0.1 fails:** keep Helios beacon traffic direct; anonymize only execution-layer reads.
  - **M0.2 passes with retries:** private reads through Nox are feasible; the SDK must retry
    `eth_getProof` on PublicNode's `-32602` window error.
  - **M0.3 passes:** L7 (gzip) is allowed into Tier 3; no app-level compression handling is needed.
  - **M0.4 passes:** S5 (browser WASM verifier) is kept; M1's `veriq_verifyProof` remains the
    server-side path.
  - Nothing in M0 blocks M1–M4.
