# Anon-RPC feasibility (M0)

Results of the M0 probes in [ANON_RPC_BUILD_PLAN.md](../ANON_RPC_BUILD_PLAN.md). Page:
[spikes/anon-rpc/](../spikes/anon-rpc/) (`npm install && npm run serve`, then open
`http://127.0.0.1:5180/`). Each section records date, browser, network, request, status, headers and,
on failure, the exact error.

| Probe | Verdict |
|---|---|
| M0.0 test page skeleton | **PASS** (2026-11-05) |
| M0.1 Nox to the beacon API | **FAIL** on Nimbus (2026-11-05, TLS certificate); **PASS** on Lodestar Sepolia (2026-11-06, re-run for S4) |
| M0.2 Nox to a public RPC (`eth_getProof`) | **PASS** (2026-11-05, with retries; see finding) |
| M0.3 gzip through Nox | **PASS** (2026-11-05, origin sees gzip; browser decompresses before app) |
| M0.4 Rust verifier in WebAssembly | **PASS** (2026-11-05, 202,759-byte wasm verifies the EOA fixture and rejects a tampered proof) |
| S4 Helios in the browser, synced over Nox | **PASS** (2026-11-06, Lodestar + PublicNode through Nox; see [S4](#s4--helios-in-the-browser-over-nox)) |
| S6 Nym `mixFetch` on mainnet | **PASS, flaky** (2026-11-06, see [S6](#s6--nym-mixfetch-on-mainnet)) |

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

## M0.1 re-run (2026-11-06) — the Nimbus certificate, and Lodestar through Nox

**Why M0.1 failed:** `unstable.sepolia.beacon-api.nimbus.team` serves a *Cloudflare Origin CA*
certificate, which no public trust store includes. It is not Nox-specific: plain `curl` over
HTTPS fails the same way (2026-11-06). The engine's `.env` reaches Nimbus over `http://`, which
works because Helios checks every signature itself.

**Lodestar Sepolia (`lodestar-sepolia.chainsafe.io`, ChainSafe):** Let's Encrypt certificate,
`access-control-allow-origin: *`, all Helios light-client endpoints. Run through Nox with the M0
page and its new `?beacon=` option, `index.html?autorun=m01&beacon=https://lodestar-sepolia.chainsafe.io`
(Headless Chrome 156, macOS, worker ready 3.3 s):

| Check | Cold / warm | Status | Bytes |
|---|---|---|---|
| `headers/head` | 3050 / 1808 ms | 200 | 670 |
| `finality_update` | 3998 / 1014 ms | 200 | 3,478 |
| `optimistic_update` | 830 / 1567 ms | 200 | 1,645 |
| `config/spec` | 786 / 1003 ms | 200 | 8,843 (`CONFIG_NAME=sepolia`) |
| `bootstrap/{head root}` | 1615 ms | 200 | 53,874 |
| `updates?count=1` | 1587 ms | 200 | 56,137 |

**Finding — Lodestar serves a bootstrap only for the current finalized checkpoint.** Older
roots (one epoch old, a day old, the engine's pinned 2026-10-26 checkpoint) answer HTTP 500
`syncCommitteeWitness not available`. A pinned checkpoint therefore cannot bootstrap browser
Helios; each start reads the current finalized checkpoint from **checkpointz**
(`checkpoint-sync.sepolia.ethpandaops.io`, a different operator than the beacon API) through Nox,
and needs every healthy upstream to agree. checkpointz and Lodestar reported the same root
(`0x37a2…ed65`, then `0xa826…869e`) in every check.

PublicNode's beacon API has no light-client endpoints (404/400); `sepolia.lightclientdata.org`
answered 503.

## S4 — Helios in the browser over Nox

**Run 2026-11-06: PASS.** Page `spikes/anon-rpc/helios.html?checkpoint=0x…` (Headless Chrome 156,
macOS). `@a16z/helios@0.12.0` is the npm build of the exact Helios commit the engine pins
(`gitHead 2af9b41…`), one self-contained ES module with the wasm inlined (4.45 MB, 1.7 MB gzip).

Routing: Helios calls the global `fetch`. It is configured with `https://consensus.helios.invalid`
and `https://execution.helios.invalid`; a fetch wrapper sends only those two hosts through
`AnonRpcWorker.fetch` to Lodestar and PublicNode. `.invalid` never resolves, so nothing can leak
direct. One fix was needed: reqwest (wasm) parses `response.url` and panics on the empty URL of a
constructed `Response` (`Error: url parse`); the wrapper sets it.

| Step | Result |
|---|---|
| Nox worker ready | 3.7 s after page load |
| Helios module load (dynamic import) | 29 ms (already cached) |
| Sync (bootstrap → updates → finality update → 2 × `eth_getBlockByHash`) | **8.4 s** |
| Requests, all through Nox | bootstrap 2.9 s (53,874 B), updates 2.1 s (56,137 B), finality 0.8 s, execution 2.1 s / 2.2 s (137 / 276 kB) |
| Finalized block | #12076786 `0x04fc…0688`, state root `0x88c4…92e0` |
| Cross-check | PublicNode direct: same number, hash and state root |

The five responses are kept as `fixtures/browser-helios/sepolia-12076786.json.gz` (170 kB).
`frontend/dashboard/src/dashboard/lib/helios-fixture.test.ts` replays them into the same Helios
wasm under Node: it syncs to the recorded block in ~0.5 s, and rejects a finality update with one
flipped signature byte (`invalid sync committee signature`) and a bootstrap for another slot. The
replay also passes with the clock 30 days later, so the fixture does not age out.

**Decision:** S4 is kept with no traffic split: beacon and execution requests of browser Helios
both go through Nox. The engine's root is the cross-check (S4.2), not the bootstrap.

## S6 — Nym mixFetch on mainnet

Page `spikes/anon-rpc/nym.html` (Headless Chrome 156, macOS), `@nymproject/mix-fetch@3.0.1` (the
smolmix backend; a single ESM module, 18.2 MB / 6.4 MB gzip with the wasm and worker inlined;
browser-only, no Node build yet). Exits are Nym IPRs, so browser CORS does not apply.

**Run 1, 2026-11-06 ~15:30Z: PASS.** Tunnel ready 9.6 s (module load 0.2 s).

| Check | Through Nym |
|---|---|
| `eth_chainId` (first request to each host) | PublicNode 7.3 s, dRPC 15.8 s, BlastAPI 8.3 s: all `0x1` |
| `eth_getProof` at `finalized` | PublicNode 4.4 s, dRPC 1.6 s, BlastAPI 2.5 s |
| `eth_getProof` at `{ blockHash }` | PublicNode 1.9 s, dRPC 1.0 s, BlastAPI 1.3 s |
| Beacon `light_client/finality_update` | Lodestar mainnet 7.2 s, PublicNode beacon 8.4 s |
| checkpointz `sync-mainnet.beaconcha.in` | 8.2 s, 3 upstreams |
| Warm `eth_getProof` | 1.4 s |

**Reliability finding (later runs, ~16:00Z):** of three fresh tunnels, one never became ready
(`operation timed out`), one became ready but timed out every request after 24 s, and one worked
as above. Like Nox's tunnel budget, the dashboard needs a "recreate the tunnel after repeated
timeouts" path before Nym is demo-safe; until then a failed tunnel shows as failed reads (never a
direct read).

Keyless mainnet providers checked directly for finalized `eth_getProof`: PublicNode, dRPC,
BlastAPI OK; Cloudflare `-32046`; Ankr needs a key; 1rpc / LlamaRPC no JSON answer. Mainnet beacon
APIs with light-client endpoints and current bootstraps: Lodestar, PublicNode
(`lightclientdata.org` 503).

**Decision:** mainnet private reads in the browser go through Nym. Tor stays an allowed network
name for mainnet (bring your own fetch from Node); the dashboard reports it as unavailable.
