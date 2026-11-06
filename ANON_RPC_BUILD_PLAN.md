# Anon-RPC Private Reads — expanded build plan

Source roadmap: the Tier 1 / Tier 2 / Tier 3 list pasted on 2026-11-05. This file expands every line
into concrete work you can pick up and finish: files to touch, functions to add, tests to write, and
what "done" means. Keep it open next to `PROGRESS.md`; tick lines here and mirror the status there.

**Legend:** `[ ]` todo · `[~]` already written, needs review · `[x]` done
**Rule:** no line is done until its test/command passes and the receipt shape is still backwards
compatible.

---

## 0. What already exists (checked 2026-11-05, branch `jiban_server`)

### Rust engine (M1 — written, unreviewed, uncommitted)

| Piece | Where | State |
|---|---|---|
| `Transport::AnonRpc` (serialises as `anon-rpc`) | `backend/crates/core/src/receipt.rs` | `[~]` |
| `ProofKind`, `ClientProof`, `ClientRead` | `backend/crates/server/src/engine.rs` | `[~]` |
| `Engine::pinned_root()` | `backend/crates/server/src/engine.rs` | `[~]` |
| `Engine::verify_client_proof()` + `record()` split | `backend/crates/server/src/engine.rs` | `[~]` |
| Shared `parse_proof_result()` | `backend/crates/server/src/provider.rs` | `[~]` |
| `veriq_getRoot` / `veriq_verifyProof` dispatch | `backend/crates/server/src/rpc.rs` | `[~]` |
| `clientProofTransports: ["anon-rpc"]` in capabilities | `backend/crates/server/src/rpc.rs` | `[~]` |
| 7 JSON-RPC tests | `backend/crates/server/tests/read_path.rs` (from line ~918) | `[~]` |

### SDK (M2 — partly written, no tests)

| Piece | Where | State |
|---|---|---|
| `getRoot()` / `verifyProof()` | `frontend/sdk/src/client.ts` | `[~]` |
| `RootInfoSchema`, `anon-rpc` in transport enum | `frontend/sdk/src/schema.ts` | `[~]` |
| `createPrivateReader()` | `frontend/sdk/src/private.ts` | `[~]` untested |
| Public exports | `frontend/sdk/src/index.ts` | `[~]` |

### Not started

Dashboard integration, `@anon-rpc/browser-harness`, hosted bootstrap, attack lab, probes, default-private
SDK, browser Helios, browser WASM verifier, mainnet Tor/Nym, docs/pitch, all latency work.

### Commands that must stay green

```bash
cd Veriq/backend
cargo test -p veriq-server read_path
cargo test --workspace
cargo fmt --all -- --check
cargo clippy --workspace --all-targets -- -D warnings

cd Veriq/frontend/sdk
pnpm test
pnpm lint
pnpm build

cd Veriq/frontend/dashboard
pnpm test
pnpm lint
pnpm build
```

---

## 1. Environment and configuration (add before M3)

Add to `Veriq/.env.example` (never commit real values):

```bash
# ── Anon-RPC private reads (dashboard + SDK) ──────────────────────────────────
# nox | direct. direct is the explicit opt-out switch.
VITE_ANON_MODE=nox
# Network name recorded in every private receipt (1-64 of [A-Za-z0-9_.-]).
VITE_ANON_NETWORK=nox
# Public Sepolia providers the browser asks through Nox. label=url, comma separated.
# PublicNode is keyless and already used by the engine.
VITE_ANON_PROVIDERS=publicnode=https://ethereum-sepolia-rpc.publicnode.com
# Where the Anon-RPC bootstrap iframe is served (M4.1). Empty = same-origin default.
VITE_ANON_BOOTSTRAP_URL=
```

Engine-side additions only if needed by M4.2:

- `VERIQ_HOST=0.0.0.0` already exists.
- CORS currently hard-codes `http://localhost:3000` (`backend/crates/server/src/http.rs:17`). Add
  `VERIQ_ALLOWED_ORIGINS` (comma separated) and keep localhost as the default. Test both allowed and
  rejected origins.

**Acceptance for §1:** no secret in the repo; an empty variable behaves like unset (the existing
`||` convention in `frontend/dashboard/src/dashboard/lib/engine.ts:28`).

---

# Tier 1 — Major (needed to qualify)

## M0 — Feasibility tests (test page only, no project code)

Create a throwaway page under `Veriq/spikes/anon-rpc/` (outside the workspace members, like
`spikes/helios-spike`). It must be runnable with a static file server and must not import dashboard or
SDK code. Record every result in `Veriq/docs/ANON_RPC_FEASIBILITY.md` with date, browser, network,
request, status, headers, and the exact failure if it fails.

### M0.0 — Test page skeleton

- [x] `spikes/anon-rpc/index.html` — one button per probe, a `<pre id="log">` output, no build step.
- [x] Import the harness exactly as it will be imported in the dashboard
      (`@anon-rpc/browser-harness`, local `pnpm link` or a pinned CDN URL — decide from the package
      README).
- [x] Show worker status events (`connecting`, `ready`, `failed`) on the page.
- [x] Button "run all" so the browser smoke can trigger everything.
- [x] No keys, no addresses, no private data in the page or the log.

### M0.1 — Nox to the beacon API (GET to Nimbus)

- [x] Use the same consensus base already in `.env.example`: `HELIOS_CONSENSUS_RPC`
      (`https://unstable.sepolia.beacon-api.nimbus.team`).
- [x] Through `AnonRpcWorker.fetch`, `GET /eth/v1/beacon/headers/head`; log status, `content-type`,
      and whether `data.header.message.slot` parses.
- [x] Repeat with the Helios endpoints actually used by the adapter: at minimum
      `/eth/v1/beacon/light_client/bootstrap/{block_root}` or the path Helios calls (grep
      `backend/crates/light-client/src/helios_adapter.rs` and the Helios crate for the exact path).
- [x] Record whether CORS preflight (`OPTIONS`) is required and what the response says.
- [x] Record latency: first request after worker start vs warm request.

**Result 2026-11-05: FAIL.** Nox rejects the Nimbus TLS chain before HTTP:
`invalid peer certificate: UnknownIssuer` on every endpoint (cold 0.9–4.0 s, warm 0.8–1.0 s).
Fallback chosen: keep Helios beacon traffic direct and anonymize only execution reads. See
`docs/ANON_RPC_FEASIBILITY.md#m01`.

**Done when:** the beacon GET returns 200 through Nox **or** the log proves it is blocked (CORS,
method filter, TLS, worker error), with the exact error and a proposed fallback (e.g. keep beacon
traffic direct in S4.1 and only proxy execution reads).

### M0.2 — Nox to a public attacker URL

- [x] Point the harness at a public JSON-RPC URL (PublicNode Sepolia) and send
      `eth_getProof` with a known address and `[]` slots at `"finalized"`.
- [x] Send the same request with `{ "blockHash": "0x…" }` (EIP-1898) and with a hex block number.
- [x] Log status, `access-control-allow-origin`, whether the response is JSON-RPC, and the result
      shape (`accountProof` array length).
- [x] Repeat with the demo attacker URL once S1.1 exists; until then use any public URL.

**Result 2026-11-05: PASS with retries.** `eth_chainId` and the finalized block answered every time;
proof calls hit PublicNode's `-32602 maximum proof window` on some backends and succeeded on retry
(finalized tag 1/2 attempts, block hash 1/4, exact number 1/1 in one run; in a second fresh run the
tag and number failed 4/4 and the hash form succeeded on attempt 4). The SDK must retry `eth_getProof`
on `-32602` and try tag, hash and number, not pin one form. See
`docs/ANON_RPC_FEASIBILITY.md#m02`.

**Done when:** a POST with `content-type: application/json` reaches a public URL through Nox and the
JSON-RPC result comes back, **or** the failure is documented.

### M0.3 — Does gzip pass through Nox?

- [x] Request the same proof with `Accept-Encoding: gzip` and without it.
- [x] Log `content-encoding`, `content-length`, and the number of bytes the page actually receives
      (`(await res.arrayBuffer()).byteLength`).
- [x] If the harness/browser hides the encoding, fetch through the worker to a URL that reports
      request headers, and log what the origin sees.
- [x] Compare response body size compressed vs uncompressed for a real `eth_getProof` (usually the
      biggest payload).

**Result 2026-11-05: PASS (origin sees gzip; browser decompresses before app).** The echo origin saw
`accept-encoding: ["gzip"]`; `httpbingo.org/gzip` parsed as JSON only after decompression. Proof
responses are chunked and the browser hides `content-encoding`/`content-length`, so the compressed
byte count for `eth_getProof` itself is not observable. L7 is allowed into Tier 3. A combined run
also exposed `NoTunnelExitError` under a burst; see the tunnel-budget finding in
`docs/ANON_RPC_FEASIBILITY.md#cross-probe-finding--nox-tunnel-budget`.

**Done when:** the doc states one of: "gzip survives end to end", "origin sees gzip but browser
decompresses before the app", or "Nox does not pass gzip". Only L7 is allowed into Tier 3 if this
passes.

### M0.4 — Does the Rust verifier compile to WebAssembly?

- [x] `rustup target add wasm32-unknown-unknown`.
- [x] Add a **separate** crate (e.g. `backend/crates/verifier-wasm`) that depends on
      `veriq-verifier` and exposes one function: `verify_account(root, address, proof) -> value`
      (and later storage). Do not modify the existing verifier API.
- [x] Build with `wasm-pack build --target web --release` (or `cargo build --target
      wasm32-unknown-unknown` if wasm-pack is unavailable).
- [x] Fix the usual blockers: `getrandom` (use `wasm-bindgen`/`js` feature), `std::time` in
      dependencies, `rayon`, and any `openssl`/native TLS in the dependency graph. `veriq-verifier`
      should only pull alloy primitives/RLP/trie; confirm with `cargo tree -p veriq-verifier`.
- [x] Instantiate the `.wasm` in the M0 test page, verify one fixture, and compare the result with
      the Rust CLI/test.
- [x] Record artifact size, instantiate time, and verify time in the browser (V8/Chromium).

**Result 2026-11-05: PASS.** `backend/crates/verifier-wasm` (raw alloc/call/free ABI, no
wasm-bindgen) built with `cargo build --target wasm32-unknown-unknown --release`. Artifact 202,759
bytes; browser instantiate 5 ms, verify 4.8 ms; `fixtures/eoa.json` matched and a tampered leaf was
rejected. No dependency blockers. S5 is kept. See `docs/ANON_RPC_FEASIBILITY.md#m04`.

**Done when:** the browser verifies the fixture in WASM **or** the exact blocking dependency is named
with a workaround estimate. This result gates S5; if it fails, S5 is cut and M1 (`veriq_verifyProof`)
remains the verifier.

### M0 exit gate

- [x] `docs/ANON_RPC_FEASIBILITY.md` has one section per probe with a pass/fail verdict.
- [x] Tier 1 start/stop decision written: if M0.1 fails, S4.1/S4.2 change; if M0.4 fails, S5 is cut;
      if M0.3 fails, L7 is cut. Nothing else blocks M1–M4.

**Decision 2026-11-05:** M0.1 fails (Nox rejects the Nimbus TLS chain) → keep beacon traffic direct
and anonymize only execution reads. M0.2 passes with retries → keep Nox for private reads and add
`-32602` retries in the SDK. M0.3 passes → L7 is allowed into Tier 3. M0.4 passes → S5 is kept.
Nothing blocks M1–M4.

---

## M1 — Engine accepts browser-fetched proofs (`[~]` review + harden)

### M1.0 — Review the uncommitted diff before adding anything

- [ ] Read the full diff of `receipt.rs`, `engine.rs`, `provider.rs`, `rpc.rs`, `read_path.rs`.
- [ ] Confirm `record()` is called exactly once per read and that `route()` behaviour is unchanged
      (same store rows, same errors, same receipt fields).
- [ ] Confirm no provider URL or API key can reach a receipt/log through `provider` or `network`
      (`valid_provider_name` is applied to both).
- [ ] Confirm `verify_client_proof` never calls a provider: grep the call path for `ProofClient` /
      `fetch_proof`; only `self.pinned()` (root source) is allowed.
- [ ] Confirm the new enum variant is additive: old receipts/schemas still parse (`anon-rpc` is the
      only new value; `direct` remains the default).
- [ ] Run `cargo test -p veriq-server read_path` and the whole workspace before changing code.
- [ ] Commit the reviewed M1 diff as its own commit (do not mix with M2/M3).

### M1.1 — `veriq_getRoot`: which block to fetch

- [ ] Result shape is exactly `{ number, hash, stateRoot, rootSource, verified }`
      (`rpc.rs:131`, SDK `RootInfoSchema`).
- [ ] `number` is a JSON number (not a hex string) and `hash`/`stateRoot` are `0x` 32-byte strings.
- [ ] Fail closed when no root is available: `ROOT_UNAVAILABLE`, no fabricated block.
- [ ] Root source is the same cached `pinned()` the read path uses, so a fetch at this root verifies
      immediately afterwards.
- [ ] Add a test: root unavailable → typed error, and the engine still does not contact providers.
- [ ] Add a test: two calls in quick succession return the same block (cache window).

### M1.2 — `veriq_verifyProof`: check the proof, save the receipt

- [ ] Inputs handled: `balance`, `nonce`, `storage` (+ `slot`), `code` (+ `code`).
- [ ] Address/slot/kind/blockHash validation happens before any proof work; bad input is
      `INVALID_REQUEST` and never echoes a URL.
- [ ] `blockHash` must equal the engine's current pinned hash. A moved root is a **retryable**
      `INVALID_REQUEST` whose message tells the client to call `veriq_getRoot` (already written).
- [ ] Verification reuses the provider path: `parse_proof_result` → `verify_bundle` → account /
      storage / code-hash checks; size bounds still apply (64 nodes, 1 KiB node, 2 MiB body).
- [ ] `privacy: required` is satisfied by this path (transport `anon-rpc`).
- [ ] `consistency: compare` adds `COMPARE_UNAVAILABLE` (only one provider was asked).
- [ ] Receipt: `verification.status`, block, mechanisms, routing attempt, `elapsedMs` from the client,
      `privacy.transport = anon-rpc`, `privacy.mechanism = network`, provider label
      `label@anon-rpc:network`.
- [ ] Receipt is stored and retrievable by id, exactly like an engine read.
- [ ] Add missing tests: nonce, code (with `code` present), code with `code` missing → error, storage
      with a bad slot, `privacy: required`, `consistency: compare` warning, `ROOT_UNAVAILABLE`.

### M1.3 — Receipt transport `anon-rpc` with a network name

- [ ] Rust enum serialises/deserialises as `anon-rpc`; add a serde round-trip test.
- [ ] SDK `TransportKindSchema` accepts `anon-rpc`; dashboard shows it without a TS error.
- [ ] `privacy.mechanism` is the network name only (`nox`), never a URL.
- [ ] `routing.providerLabel` is `provider@anon-rpc:network`; `attempts[].provider` uses the same
      label so the receipt drawer timeline is readable.
- [ ] Old receipts without the new enum still parse in the SDK (regression test with a stored fixture).

### M1.4 — Tests (7 written)

Current tests (all in `backend/crates/server/tests/read_path.rs`):

1. `get_root_names_the_block_a_client_must_fetch_at`
2. `client_fetched_proof_is_verified_and_the_receipt_says_anon_rpc`
3. `client_fetched_proof_satisfies_privacy_required`
4. `a_forged_client_proof_is_rejected_and_recorded`
5. `a_proof_for_another_block_is_refused_with_a_retry_hint`
6. `client_fetched_storage_proof_returns_the_slot_value`
7. `client_proof_labels_and_shape_are_validated_before_verification`

- [ ] Run them: `cargo test -p veriq-server read_path`.
- [ ] Add the tests listed in M1.1/M1.2.
- [ ] Add a test proving an existing `veriq_readBalance` / `eth_getBalance` path still produces
      `transport: direct` and the same receipt fields (guard against M1 changing existing reads).
- [ ] Add a serialization test that `Transport::AnonRpc` ↔ `"anon-rpc"`.

**M1 done when:** all M1 tests pass, the existing suite is unchanged and green, and the M1 diff is
committed separately.

---

## M2 — SDK private reader (`[~]` partly written, untested)

### M2.0 — Review `private.ts` before writing tests

- [ ] Confirm `client.getRoot()` and `client.verifyProof()` exist in the built SDK source used by
      the workspace (`conditions: ['source']`).
- [ ] Confirm the reader never sends the provider URL to the engine (only `provider.label`).
- [ ] Confirm no key/URL is thrown in an error message. Provider errors currently carry the upstream
      message; sanitise or truncate it if it can contain the URL.
- [ ] Fix root-retry bookkeeping: `rootRetried` is global today; make it per-read with a small budget
      (e.g. at most 2 root refreshes) and reset when moving to the next provider.
- [ ] Make the exact-block fallback symmetric: `eth_getProof` falls back from `blockHash` to number on
      `-32602`; `eth_getCode` currently always uses a number. Try `blockHash` first, then number, and
      remember which form the provider rejected for the rest of the read.
- [ ] Treat `-32000` / "unknown block" as a retryable exact-block error too, not only `-32602`.
- [ ] Keep the request `id` echo check optional but present (a provider returning a different id is
      suspicious; at least log it in tests).

### M2.1 — `getRoot()` / `verifyProof()` on the client

- [ ] `getRoot()` validates the response with Zod and returns `RootInfo`.
- [ ] `verifyProof(input, policy)` validates the receipt with `ReadResultSchema` and returns
      `VerifiedResult<Hex>` (`verified` mirrors `receipt.verification.status`).
- [ ] Input is not mutated; `elapsedMs` is optional; `slot` is only sent for storage.
- [ ] Test: response missing `stateRoot` → Zod error; RPC error → typed `VeriqError`.
- [ ] Test: `verified: false` receipt is surfaced, never silently treated as true.

### M2.2 — `createPrivateReader()`

- [ ] `readBalance`, `readStorage`, `readNonce`, `readCode` all work.
- [ ] Provider list is tried in order; transport failure → next provider; `INVALID_PROOF` → next
      provider; engine unreachable / policy error / root unavailable → stop and throw (not a provider
      problem).
- [ ] `privacy.mechanism` is the configured network; `receipt.privacy.transport === 'anon-rpc'`.
- [ ] Storage value is normalised to a 32-byte `0x` word; balance/nonce to `bigint`; code stays `Hex`.
- [ ] Add a `providers` validation: non-empty, labels unique, URLs `https:` by default (allow
      `http://127.0.0.1` only for tests), no trailing slash surprises.

### M2.3 — Exact-block fallback, retry when the root moves

- [ ] `eth_getProof` at `{ blockHash }`; on `-32602`/unknown-block retry at the exact number.
- [ ] `eth_getCode` at `{ blockHash }`; same fallback.
- [ ] On the engine's "call veriq_getRoot and fetch again" error: re-fetch root, retry the **same**
      provider once; if the root moved again, give up with a clear error.
- [ ] Never verify at a different block than the engine's pinned root.
- [ ] Test: first `getProof` returns `-32602` → second call uses the hex number.
- [ ] Test: first `verifyProof` returns the moved-root error → `getRoot` is called again and the
      provider is retried.
- [ ] Test: root moves on every attempt → fails after the budget, no infinite loop.

### M2.4 — Tests with a fake Anon-RPC fetch

Create `frontend/sdk/test/private.test.ts`. Use a fake fetch that records
`{ url, method, body }` and returns canned JSON-RPC responses; no network.

- [ ] balance success: one `eth_getProof` with `[]` slots, verify `provider`, `network`, `elapsedMs`.
- [ ] storage success: slots `["0x…"]`, value normalised.
- [ ] nonce success: `bigint`.
- [ ] code success: `eth_getProof` + `eth_getCode`, code forwarded.
- [ ] provider 1 transport error → provider 2 answers, receipt provider is provider 2.
- [ ] provider 1 invalid proof → provider 2 answers.
- [ ] provider 1 `-32602` → number fallback, same provider.
- [ ] moved root → retry same provider once.
- [ ] all providers fail → `AllProvidersFailedError` with a hint, no provider URL in the message.
- [ ] `fetch` is never called with a non-provider URL; the engine RPC (`rpcCall`) is never made with
      the provider URL.
- [ ] timeout: a never-resolving fetch rejects after `timeoutMs` (use fake timers).
- [ ] exact same blockHash is sent to the provider as returned by `getRoot()`.

**M2 done when:** `pnpm --filter veriq-client test` passes with the new file, lint and build pass, and
the reader is exported from the package root.

---

## M3 — Dashboard private by default (live on Sepolia)

Work in `frontend/dashboard`. Keep the direct engine path available as an explicit switch.

### M3.1 — Add `@anon-rpc/browser-harness`; start the Nox worker at page load

- [ ] Add the dependency to `frontend/dashboard/package.json` (`pnpm add @anon-rpc/browser-harness`),
      pinned to the version proven in M0.
- [ ] If the harness is browser-only, add it to `optimizeDeps`/`ssr.noExternal` only if Vite needs it;
      keep the bundle out of the landing page if possible (lazy import on `/app`).
- [ ] New `src/dashboard/lib/anon.ts`:
      - singleton `AnonRpc` wrapper around `AnonRpcWorker` (one worker per tab, L1);
      - `getAnonStatus(): 'idle' | 'connecting' | 'ready' | 'failed'`;
      - `startAnon()` idempotent, called from `DashboardApp`/`main.tsx` at page load;
      - `getPrivateReader()` returns `createPrivateReader(veriq, { fetch: worker.fetch, network,
        providers })`, memoised;
      - provider list parsed from `VITE_ANON_PROVIDERS` with PublicNode as the default;
      - worker start failure is captured with its message, never thrown at module import.
- [ ] Start the worker **before** the first read (page load, not on click).
- [ ] Do not start a second worker when React StrictMode mounts twice; the singleton owns it.
- [ ] Test: `startAnon()` twice → one worker; status transitions idle → connecting → ready.
- [ ] Test: a failed start becomes `failed`, and a read reports a typed error instead of hanging.

### M3.2 — Reads (Overview, Policy, Developers) use the private reader

- [ ] Add a private branch in `src/dashboard/lib/engine.ts`:
      - `readBalance(address, policy)` → `privateReader.readBalance` when anon mode is on;
      - `readStorage(address, slot)` → `privateReader.readStorage`;
      - keep the existing mock fallback only when the engine itself is unreachable; never fall back
        from private to direct silently.
- [ ] Overview: `useDemoContractStorage` goes through the private reader; the card label shows the
      transport/network.
- [ ] Policy: `readBalance` in `PolicyPage` goes through the private reader; the attempts timeline shows
      `publicnode@anon-rpc:nox`.
- [ ] Developers: add the `createPrivateReader` snippet and the `veriq_getRoot` /
      `veriq_verifyProof` method names to the docs shown on the page.
- [ ] Do not route `GET /health`, receipts, provider health or the Attack Lab through the private
      reader (those are engine/admin calls; S1 handles the Attack Lab reads separately).
- [ ] Test: with anon on and a fake harness, Overview/Policy call the private reader and never call
      `veriq.readBalance` directly.
- [ ] Test: with anon off, the existing direct path is used and the old tests pass unchanged.

### M3.3 — Status badge: connecting, ready, failed, plus the direct-mode switch

- [ ] New `AnonStatus` component (or extend the Shell footer) showing:
      `Anon-RPC: connecting…`, `Anon-RPC: ready (nox)`, `Anon-RPC: failed — <reason>`, and
      `Direct mode` when the switch is off.
- [ ] Toggle "Private reads" on/off; persist in `sessionStorage` (existing `readSession`/`writeSession`
      helpers in `Shell.tsx`).
- [ ] When switching to direct, close/stop the worker only if the harness supports it; otherwise keep
      it warm but stop using it (L1).
- [ ] The badge must be accessible: `role="status"`, text not colour-only, keyboard-operable toggle.
- [ ] Test: each status renders; toggle flips the read path; status survives a remount within the tab.
- [ ] Test: anon failure does not break the page; the toggle offers direct mode.

### M3.4 — Receipt drawer shows "Transport: anon-rpc (nox)"

- [ ] SDK `ReceiptCard` already prints `privacy.transport` (`src/react/components.tsx`). Extend to
      `anon-rpc (nox)` when `privacy.mechanism` is present; keep `direct` unchanged.
- [ ] Dashboard drawer forwards the receipt unchanged; no dashboard-only formatting.
- [ ] Test (SDK): receipt with `mechanism: "nox"` renders `anon-rpc (nox)`.
- [ ] Test (dashboard): opening an anon receipt shows the string; a direct receipt still shows
      `direct`.

### M3.5 — Tests and the browser smoke test in anon mode

- [ ] Unit tests from M3.1–M3.4.
- [ ] Add `--anon` to `frontend/dashboard/scripts/smoke.mjs`:
      - wait for `Anon-RPC: ready`;
      - run Overview storage read and Policy balance read;
      - assert a receipt shows `Transport: anon-rpc (nox)`;
      - assert the engine receipt `routing.attempts[].provider` is `…@anon-rpc:nox`;
      - assert no direct provider probe/read was added by the dashboard (engine `/health` unchanged,
        or receipt transport is `anon-rpc`);
      - leave `--mode live` working unchanged.
- [ ] Add an anon failure path: block the bootstrap URL (DevTools request interception or a query
      flag) and assert the badge says `failed` and the direct toggle works.
- [ ] Keep the smoke runnable in CI without a real Nox? If not, document it as a manual live check.

**M3 done when:** `pnpm --filter veriq-dashboard test`, `lint`, `build` pass; `pnpm smoke --
--anon` passes against a live Sepolia engine; default dashboard mode is private.

---

## M4 — Hosted setup (private reads end to end on the hosted site)

### M4.1 — Vercel serves the Anon-RPC files (the bootstrap iframe page)

- [ ] Find the exact static files the harness needs (from M0): worker JS, wasm, bootstrap HTML.
- [ ] Copy them into `frontend/dashboard/public/` at a stable path, e.g.
      `public/anon-rpc/bootstrap.html` (or `public/anon-rpc/` for the whole harness build).
- [ ] Vite copies `public/` into `dist/`; confirm with `pnpm build` and inspect `dist/anon-rpc/*`.
- [ ] Add headers in `frontend/dashboard/vercel.json` if needed:
      `Cross-Origin-Opener-Policy`, `Cross-Origin-Embedder-Policy`, correct `Content-Type` for
      `.wasm` (`application/wasm`), and long cache for hashed assets.
- [ ] Point `VITE_ANON_BOOTSTRAP_URL` at the deployed URL; the default should be same-origin
      (`/anon-rpc/bootstrap.html`).
- [ ] Rewrite rules must not capture `/anon-rpc/*` into `index.html`; add an exception before the
      catch-all rewrite in `frontend/dashboard/vercel.json`.
- [ ] Test on a Vercel preview deployment: bootstrap loads, worker reaches `ready`, one private read
      verifies.
- [ ] Test the production URL after merge; record the URL and date in `docs/INTEGRATION_REPORT.md`.

### M4.2 — Render engine answers `veriq_getRoot` / `veriq_verifyProof`

- [ ] Deploy the reviewed M1 engine to Render (`veriq-cloud.onrender.com`), built with
      `--features helios` and no `demo` feature.
- [ ] Set `VERIQ_ALLOWED_ORIGINS` to the Vercel origin (plus localhost), not `*`.
- [ ] Confirm `POST /` answers `veriq_getRoot` and `veriq_verifyProof` with `curl` from outside:
      - getRoot returns a finalized Sepolia block with `verified: true`;
      - a deliberately wrong `blockHash` returns `-32602` with the `veriq_getRoot` hint;
      - `veriq_getCapabilities` includes `clientProofTransports: ["anon-rpc"]`.
- [ ] Confirm the methods are present in the deployed binary (not just the repo): version/commit line
      in `/health` or the deploy log.
- [ ] Keep `veriq_readBalance` and `/health` behaviour unchanged.
- [ ] Add a Render healthcheck path and startup assertion so a failed Helios sync does not serve
      fake `verified: true`.

**M4 done when:** the hosted dashboard reads privately through Nox and the hosted engine verifies the
proofs; no provider key is in the browser.

---

# Tier 2 — Sub-major (full match)

## S1 — Attack Lab through Anon-RPC (all 6 modes)

Current modes (from `src/dashboard/lib/mock.ts` and `scripts/smoke.mjs`): `off`, `value`, `proof`,
`wrongblock`, `outage`, `nonce`, `code` (7 names; "6 modes" excludes `off`).

### S1.1 — Host the demo attacker publicly (Render), forwarding to keyless PublicNode

- [ ] Containerize `backend/crates/malicious-rpc` with `--features demo` and an
      `UPSTREAM_RPC=https://ethereum-sepolia-rpc.publicnode.com` default.
- [ ] Render web service + healthcheck (`GET /mode` or `/health`); no auth for the demo, but bound to
      the intended origins if possible.
- [ ] The admin routes (`POST /mode`, `POST /admin/reset-breakers`) stay reachable only from the demo
      (document that they are public on the hosted demo attacker, or gate them with a secret).
- [ ] `GET /mode` returns `{ mode, available }`; `POST /mode` accepts the same mode names.
- [ ] Confirm CORS for the Vercel origin and for Nox exit nodes.
- [ ] Test with `curl` from a clean machine: mode switch, honest read, tampered read.

### S1.2 — The Attack Lab's private reads go through Nox to that attacker

- [ ] Add the hosted attacker URL as a private provider (`VITE_ANON_ATTACKER_URL`), labeled
      `attacker`.
- [ ] The Attack Lab "verified read" uses `createPrivateReader` when anon mode is on; the plain
      `eth_getBalance` also goes through the worker (it is the "unprotected" comparison, but still
      private).
- [ ] Mode switch / breaker reset remain direct admin calls (they are not reads; keep them off the
      mixnet to avoid ~8 s per click). Document this.
- [ ] Receipt timeline shows `attacker@anon-rpc:nox` for each attempt; the honest fallback provider is
      the next private provider label.
- [ ] All modes still rejected correctly through the mixnet:
      `value`, `proof`, `wrongblock`, `nonce` → `INVALID_PROOF`; `outage` → transport error;
      `code` → honest balance (per the existing smoke expectation).
- [ ] Test with a fake harness (unit) and live (`smoke --anon --attacks`).
- [ ] Extend `smoke.mjs` attack mode checks to assert the attacker label includes `anon-rpc:nox`.

**S1 done when:** the 6 modes run through Nox end to end and the smoke test passes in anon mode.

## S2 — Provider probes through Anon-RPC (no direct probes in private mode)

### S2.1 — The browser checks provider support (Sepolia + `eth_getProof`) via Nox

- [ ] Add `probeProvider(url)` in `anon.ts`: through `worker.fetch`, call `eth_chainId` and
      `eth_getProof` at `"finalized"` (or at the engine root), with a short timeout.
- [ ] Compare `eth_chainId` with `0xaa36a7`; require `accountProof` to be an array.
- [ ] Probe each configured private provider on worker ready; remember `{ chainOk, proofSupport,
      eip1898, transport: 'anon-rpc' }`.
- [ ] Show probe results in the Providers page when anon mode is on (read-only, labeled
      `via anon-rpc`). Do not merge them into the engine's `/health` data.
- [ ] No direct fetch to provider URLs in private mode: add a test that `fetch` is called only with a
      provider URL through the worker, and a grep/test in `smoke.mjs` (Performance/Network log) that no
      request goes directly to publicnode.
- [ ] If all private providers fail the probe, the status badge is `failed`; reads fail closed, never
      fall back to direct.
- [ ] Test: one provider wrong chain → marked ineligible; one without `eth_getProof` → ineligible;
      honest one → used.

**S2 done when:** in private mode, the browser issues zero direct provider requests; the Providers page
shows the private probe result.

## S3 — SDK private by default

### S3.1 — `createVeriq({ anon })` routes all reads through the private reader

- [ ] Add `anon?: AnonOptions` to `VeriqOptions`:
      `{ fetch, network, providers, timeoutMs?, bootstrapUrl? }`.
- [ ] When `anon` is set, `readBalance`, `readStorage`, `readNonce`, `readCode` delegate to
      `createPrivateReader`; `getRoot`/`verifyProof` stay engine calls.
- [ ] Expose `veriq.private` (the reader) and `veriq.anonStatus`.
- [ ] `health`, `receipts`, `capabilities`, `providerHealth`, `getReceiptRecord` stay engine-only.
- [ ] Fail closed: if anon is configured but the reader cannot start, reads throw; no silent direct
      fallback.
- [ ] TypeScript: `AnonOptions` requires `fetch` and `providers`; `network` defaults to `'nox'`.
- [ ] Test: anon set → no direct `veriq_readBalance` call; anon unset → existing behaviour.
- [ ] Test: `readStorage` policy passes through; errors keep their codes.

### S3.2 — The viem transport uses private reads when `anon` is set

- [ ] In `transport.ts`, `eth_getBalance`, `eth_getStorageAt`, `eth_getTransactionCount`,
      `eth_getCode` call the private reader instead of `requestWithReceipt`.
- [ ] Non-verified methods still go to the engine (or are rejected as today).
- [ ] `lastReceipt` is updated from the private result.
- [ ] Test: `createPublicClient({ transport: veriq.transport() })` with anon calls the fake fetch and
      returns the proven value; no direct engine read method is called.
- [ ] Test: failed private read surfaces a typed viem error / receipt, not sample data.

**S3 done when:** one option (`createVeriq({ anon })`) makes all reads private in both the SDK and viem.

## S4 — Light client in the browser (root from browser Helios, synced over Nox)

### S4.1 — Helios in-browser build, traffic through Nox

- [x] Consume the Helios browser artifact: `@a16z/helios@0.12.0`, the npm build of the exact commit
      the engine pins (`2af9b41…`). Pinned in `frontend/dashboard/package.json`.
- [x] Route Helios consensus and execution traffic through Nox: Helios gets
      `https://consensus.helios.invalid` / `https://execution.helios.invalid`; `createHeliosFetch`
      (`src/dashboard/lib/lightclient.ts`) sends only those through `AnonRpcWorker.fetch`. **No
      split:** M0.1 failed only because Nimbus serves a non-public certificate; Lodestar Sepolia
      passes through Nox (re-run 2026-11-06, `docs/ANON_RPC_FEASIBILITY.md#s4--helios-in-the-browser-over-nox`).
- [x] Outside the main bundle: dynamic `import('@a16z/helios')` after the Nox worker is ready
      (own 4.45 MB chunk, 1.7 MB gzip); started from `Shell` next to `startAnon()`.
- [x] Persistence: the checkpoint Helios reached (`helios_getCurrentCheckpoint`) is saved in
      localStorage (`veriq.browserHelios.v1`) and reused on a reload within 5 min. **Bootstrap
      source changed:** Lodestar serves bootstraps only for the *current* finalized checkpoint, so
      the pinned checkpoint cannot be used; each start reads it from checkpointz (ethpandaops)
      through Nox and needs every healthy upstream to agree. `veriq_getRoot` cannot bootstrap
      Helios (it is an execution block, not a beacon root), so it is the cross-check instead.
- [x] Status `off | idle | waiting | syncing | synced | failed` with finalized number/hash, sync
      time and checkpoint, shown on the Light Client page (`BrowserLightClientCard`).
- [x] Fixture test: `fixtures/browser-helios/sepolia-12076786.json.gz` (recorded through Nox)
      replayed into the real wasm (`helios-fixture.test.ts`): reaches the recorded root; a forged
      sync-committee signature and a wrong-slot bootstrap are rejected.
- [x] Sync time in the browser: 8.4 s after Nox ready (3.7 s), 2026-11-06, Headless Chrome 156.

### S4.2 — The root comes from browser Helios instead of the engine

- [x] `createPrivateReader(..., { lightClient })` (SDK): when browser Helios is synced, its finalized
      block is the one fetched; `veriq_getRoot` is the cross-check, and the fallback while it is
      not synced/failed/stale (>30 min).
- [x] Same number, different hash or state root → `RootMismatchError` (`ROOT_MISMATCH`, -32017), no
      provider asked. Different numbers (one light client a few seconds behind at an epoch
      boundary) → wait, bounded by `alignTimeoutMs` (30 s), then `ROOT_UNAVAILABLE`. Never picks.
- [x] The engine checks again: `veriq_verifyProof` accepts `browserRoot` and refuses with
      `ROOT_MISMATCH` unless it is exactly its pinned block. `rootSource` stays the engine's;
      the receipt gets a `BROWSER_LIGHT_CLIENT` warning (additive, no enum change).
- [x] Tests: engine (`read_path.rs`, 5 new), SDK (`private.test.ts`, 9 new), dashboard
      (`lightclient.test.ts`, 14).

**S4 status (2026-11-06):** the root is produced in the browser and synced over Nox, and the
engine's root must match it. The engine still verifies the proof against its own root (S5 moves
verification into the browser).

## S5 — Verifier in the browser

### S5.1 — Compile the verifier to WebAssembly (from M0.4)

- [ ] Promote the M0 spike to `backend/crates/verifier-wasm` with a small, stable API:
      `verify_account`, `verify_storage`, `code_hash_matches`.
- [ ] Ship the `.wasm` inside the SDK or as a dashboard static asset; lazy-load it.
- [ ] Keep the same size bounds in WASM.
- [ ] Test against all existing verifier fixtures (valid, tampered balance, tampered proof, wrong
      slot, wrong root, absent account, zero slot).
- [ ] Record artifact size, load time, verify time; publish in `docs/INTEGRATION_REPORT.md`.

### S5.2 — The browser checks proofs itself; the receipt says "verified in the browser"

- [ ] Private reader verifies the proof with WASM before calling the engine; only a proof that passes
      locally is sent to `veriq_verifyProof` for the trusted receipt (defence in depth).
- [ ] New privacy/verification marker: `verification.verifierLocation = "browser"` (enum already has
      it in the SDK/Rust). Make sure the engine accepts it for client proofs and the receipt says so.
- [ ] If the engine is unavailable, the browser can still show the locally verified value with a
      clearly labelled "local only, no engine receipt" state (optional; decide before building).
- [ ] Test: a forged proof is rejected in the browser before any engine call; a valid proof gets a
      receipt with `verifierLocation: "browser"`.
- [ ] Test: WASM load failure → fail closed, or fall back to engine verification with an explicit
      warning (choose one and test it).

**S5 done when:** private mode needs no engine to check the proof and the receipt says the browser
verified it.

## S6 — Mainnet

### S6.1 — Mainnet config: chain ID, Helios checkpoint

- [ ] Add `backend/config/mainnet.toml` (chain id `0x1`, execution/consensus defaults, no secrets).
- [ ] Add a mainnet checkpoint to `checkpoint.toml` (source documented, different from the consensus
      RPC) and a `mainnet` example in `.env.example`.
- [ ] `config.rs` must accept either network without weakening the Sepolia guard (no mixed
      chain/root).
- [ ] Receipts record the mainnet chain id and block; SDK types accept it.
- [ ] Tests: mainnet config loads; wrong-chain provider is rejected; fixture root still works.

### S6.2 — Tor/Nym on mainnet, Nox on Sepolia

- [ ] Add a transport abstraction so the SDK/dashboard can select `nox` (Sepolia) or `tor`/`nym`
      (mainnet) without changing the reader.
- [ ] Implement the mainnet private fetch (Tor SOCKS via a local proxy or a Nym client; decide from
      available tooling) and document setup.
- [ ] Network selector follows the chain: Sepolia → Nox, mainnet → Tor/Nym; no silent fallback.
- [ ] Receipt `privacy.mechanism` is the selected network (`nox`, `tor`, `nym`).
- [ ] Test: wrong transport for chain → typed error; selected transport used for every provider call.
- [ ] Live mainnet check with one balance and one storage proof, if an endpoint is available.

**S6 done when:** mainnet reads go through Tor or Nym and Sepolia remains on Nox.

## S7 — Docs and pitch

### S7.1 — README "Private reads (Anon-RPC)"

- [ ] One section: the problem (provider sees your IP), the flow
      `getRoot → Nox → eth_getProof → verifyProof → receipt`, the trust boundary (engine never contacts
      the provider), the fallback switch, and the measured numbers.
- [ ] Include the receipt fields (`transport: anon-rpc`, `mechanism: nox`, provider label).
- [ ] Include the exact commands to run it locally.
- [ ] State limitations: mixnet latency, finality delay, browser CORS, worker start time.

### S7.2 — Demo script

- [ ] Update `docs/demo-script.md`: start the dashboard in anon mode, show the badge, run a read, open
      the receipt, show `Transport: anon-rpc (nox)`, switch to direct, show the difference.
- [ ] Include the Attack Lab through Nox (S1) and the offline/failure path (stop the network → badge
      failed, direct switch still works).
- [ ] Timings for each step, no dead air; a recovery line if Nox is slow.

### S7.3 — `future.md` Part C

- [ ] Add "Part C: Private reads (Anon-RPC)" summarising the architecture, what shipped, what was
      measured, and what is left. Link this file.
- [ ] Keep Part A (current project) and Part B (Delegation Guard) intact.

### S7.4 — Integration report

- [ ] Add the anon matrix: local/hosted, Nox ready/failed, all read kinds, 6 attack modes, direct
      switch, receipts, browser smoke.
- [ ] Record the commit, date, browser, worker start time, per-read latency (p50/p95), and the
      before/after numbers from L8.
- [ ] Explicitly list anything not run (do not claim a pass without a date).

**S7 done when:** a new reader can follow the README, reproduce the demo, and see measured numbers that
match the code.

---

# Tier 3 — Latency (last; only after Tier 1 + agreed Tier 2)

Add a small benchmark harness before changing anything: `scripts/bench-anon.mjs` (or a dashboard debug
page) that records per-read `getRoot`, provider fetch, verify RPC, and total time; p50/p95 over N reads.
Every L line below must publish before/after numbers from the same harness.

### L1 — Start Nox at page load and keep one worker

- [ ] Worker singleton created when `/app` loads (M3.1), not on the first click.
- [ ] No second worker under React StrictMode/HMR (dispose on unload if the harness supports it).
- [ ] Measure: time from navigation to `ready`, and time from click to first read.
- [ ] **Target:** first-read wait hides most of the ~8 s worker start.

### L2 — Keep connections warm (cheap request every ~20 s)

- [ ] While the tab is visible, send a tiny request (`eth_chainId`) through the worker every ~20 s.
- [ ] Pause when `document.hidden`; resume on visibility.
- [ ] Do not log every keepalive.
- [ ] Measure: cold vs warm provider latency.
- [ ] **Target:** about −1 s per read.

### L3 — One proof for many values (`balance`, `nonce`, slots together)

- [ ] Add a batch read to the private reader that calls `eth_getProof` once with all storage slots.
- [ ] Verify balance + nonce + all slots from that one proof; return a combined result.
- [ ] Keep single-value APIs as wrappers over the batch where practical.
- [ ] Test: one provider request for balance+nonce+2 slots; values match single reads.
- [ ] **Target:** 3–4 trips become 1.

### L4 — Batch `eth_getProof` + `eth_getCode`

- [ ] JSON-RPC batch (`[{getProof}, {getCode}]`) or parallel calls through the worker, whichever the
      mixnet handles better.
- [ ] Same exact block for both.
- [ ] Test: one round trip for a code read; code hash still verified.
- [ ] **Target:** 2 trips become 1.

### L5 — Cache proven values per finalized block

- [ ] Cache key: `(chainId, blockHash, address, kind, slot)`; value + receipt + timestamp.
- [ ] Only cache `status === 'verified'` at a finalized block; evict on block change or a small LRU.
- [ ] The cached receipt keeps its original block; mark it `VERIFIED_CACHE_HIT` (warning or reuse the
      existing engine warning convention).
- [ ] Never cache errors, unverified values, or proofs from a different root.
- [ ] Test: same block → no provider call, same value; new block → provider called.
- [ ] **Target:** repeat reads take 0 s (no network).

### L6 — Race two providers, keep the first proof that verifies

- [ ] Fire the same `eth_getProof` at two private providers; verify each; keep the first valid.
- [ ] Abort the loser if the fetch supports `AbortSignal`; otherwise ignore its result.
- [ ] Bounded: never more than 2 in flight; honour `timeoutMs`.
- [ ] Test with fake timers: slow provider A, fast provider B → B wins; A with a bad proof → B's value.
- [ ] **Target:** fewer slow outliers.

### L7 — gzip (only if M0.3 passes it through)

- [ ] Send `Accept-Encoding: gzip` on provider calls; confirm the origin compresses.
- [ ] Log compressed/uncompressed sizes.
- [ ] Keep it conditional on M0.3; do not spend time if the mixnet strips it.
- [ ] **Target:** smaller replies.

### L8 — Measure before and after, publish

- [ ] Run the harness before each L line and after; keep the raw numbers in
      `docs/ANON_RPC_LATENCY.md`.
- [ ] Report p50/p95 for: worker start, getRoot, provider fetch, verify, total; per read kind.
- [ ] Publish a simple table in README and the integration report.
- [ ] **Target:** evidence for judging, not a claim.

---

# Suggested build order (one branch per row)

1. **M1 review + commit** — do this first, it is the foundation and already written.
2. **M2 + SDK tests** — unblocks the dashboard and hosted setup.
3. **M0 test page** — run in parallel; its results decide S4/S5/L7.
4. **M3 dashboard** — after M2; start Nox at page load (L1) from the beginning.
5. **M4 hosted** — after M3 works locally.
6. **S7 docs skeleton** — keep it alive as each line lands.
7. **S1 / S2 / S3** — in that order; S1 depends on M4 (hosted attacker).
8. **S4 / S5 / S6** — only if M0 says they are feasible; otherwise cut with a written reason.
9. **Tier 3 L lines** — last, one at a time, with before/after numbers.

# Cross-cutting checks (run before every merge)

- [ ] `cargo test --workspace`, `cargo fmt --check`, `cargo clippy -D warnings`.
- [ ] `pnpm -r lint`, `pnpm -r test`, `pnpm -r build`.
- [ ] The receipt shape is still backwards compatible; an old stored receipt parses.
- [ ] No provider URL, API key, IP, or address leaks into logs, receipts, or error messages.
- [ ] Private mode never silently falls back to direct.
- [ ] Existing `veriq_readBalance` / `eth_getBalance` receipts still say `transport: direct`.
- [ ] Every "Done when" claim is backed by a command output or a dated live check.

# Risks / decisions to take early

| Risk | Where it bites | Mitigation |
|---|---|---|
| Harness API differs from the assumptions in `private.ts` | M3.1, M4.1 | M0.0 pins the exact version and records its API |
| Beacon API blocks browser/Nox requests | M0.1, S4 | Keep beacon direct and only proxy execution reads; document the split |
| Nox start > 8 s and first paint is slow | M3.1, L1 | Start at page load, keep the singleton, show `connecting` |
| Public providers reject CORS or high volume | M2/M3 | Probe in S2.1; keep an alternate provider list; fail closed |
| Render CORS blocks the Vercel origin | M4.2 | `VERIQ_ALLOWED_ORIGINS` + a CORS test |
| WASM verifier cannot be built | S5 | Cut S5, keep engine verification (M1) and say so in docs |
| Mixnet adds seconds per read | all private reads | Publish p50/p95, keep direct switch, do L1/L2/L5 |
| Receipt shape churn breaks old receipts | M1.3, S5.2 | Additive enum/fields only; fixture tests; SDK defaults |

# Definition of done for the whole plan

- Tier 1 complete: private reads work locally and on the hosted site, with the direct switch and a
  receipt that says `Transport: anon-rpc (nox)`.
- Tier 2: attacks, probes, SDK default, browser root/verifier, mainnet and docs match the code.
- Tier 3: the measured before/after table exists and the improvements are reproducible.
