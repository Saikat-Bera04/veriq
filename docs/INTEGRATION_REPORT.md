# Integration report

Veriq as one product: engine, verifier, light client, router, attacker, SDK, dashboard, contracts,
Docker and CI. All paths are relative to `Veriq/` unless they start with `.github/`.

**State checked:** branch `jiban_server` at `53977be` plus the uncommitted documentation and script fixes
listed in §5, 2026-11-01. A **clean checkout** of that state (fresh `git clone` on Windows with
`core.autocrlf=true`, the changes applied, `.env` copied from `.env.example`) was used for every command in
§2. Nothing below claims a pass that was not run on that date unless it is marked with its own date.

## 0. Branch and CI status

| Item | State |
|---|---|
| `main` | `854d6df` (merge of PR #27 from `jiban_server`) |
| `jiban_server` | `53977be`, 1 commit ahead of `main` |
| GitHub Actions | **Not confirmed.** The repository is private and the checking machine has no GitHub CLI. CI = `.github/workflows/ci.yml`: Rust (fmt, clippy ×2, Helios check, tests with a Postgres 16 service), Contracts (`forge test`), Node (`pnpm -r lint`, `test`, `build`). Every step was run locally (§1). |
| Hosted | Engine `https://veriq-cloud.onrender.com` (Helios root, no `demo` feature) and dashboard `https://eth-g.vercel.app` (its `/engine/*` is forwarded to the engine by a Vercel rewrite that lives in the Vercel project, not in this repository). Checked read-only: `/health` ok and synced, verified `eth_getBalance` / `eth_getStorageAt` / `eth_getTransactionCount` / `eth_getCode`, `/admin/reset-breakers` 404. |
| npm | `veriq-client@0.1.1` (2026-11-01) **predates** `requestWithReceipt` and the transport's nonce/code receipt handling (checked in the published tarball). The repository's SDK has them; they need the next publish. |

## 1. What ran, and how

**Live** = against Sepolia and real services on 2026-11-01. **Offline** = tests with mocks or fixtures.
**Not run** = not executed for this report.

| Check | Kind | Result |
|---|---|---|
| `cargo test --workspace` (core 6, verifier 22, light-client 11, router 14, server 43 unit + 19 `read_path`, integration 15) | offline | **130 passed**, 0 failed, 1 ignored (`live.rs`, needs `VERIQ_LIVE=1`) |
| `cargo test -p veriq-malicious-rpc --features demo` | offline | **9 passed** |
| `cargo fmt --check`; `cargo clippy -D warnings` (workspace `--all-targets`, and `-p veriq-server --features helios,demo`) | offline | clean |
| `cargo build -p veriq-server` and `--features helios` | build | both build |
| PostgreSQL tests (`TEST_DATABASE_URL` → a real Postgres 16 container) | live DB | **2 passed** (store retention/duplicates/malformed rows; receipts survive an engine restart). Without `TEST_DATABASE_URL` they skip locally; CI fails if it is missing |
| `forge test` (Foundry 1.8.7, installed with `foundryup`) | offline | **3 passed** |
| `pnpm i`, `pnpm -r build`, `pnpm -r lint` | build | pass |
| `pnpm -r test`: SDK (vitest, 8 files) / dashboard (Vitest + Testing Library + `tsc --noEmit`) | offline | **78 / 20 passed**; also 3 cold runs in a row with caches cleared |
| `./scripts/check-services.sh` | live | alchemy and publicnode OK (`eth_getProof`, EIP-1898), beacon bootstrap OK, checkpoint OK; only the optional deployment keys missing |
| `pnpm e2e` (`scripts/e2e.sh`, Helios) | live | **33 passed**, 0 failed, 0 skipped (§3) |
| `bash scripts/attack-check.sh` (Helios) | live | **24 passed**, 0 failed (§3) |
| README Quick Start 1–5 (dev mode, then Helios, `curl` reads) | live | see §2 |
| `pnpm demo` + `pnpm --filter veriq-dashboard smoke` (headless Edge) | live | see §2 |
| Dashboard browser smoke, dev mode (`VERIQ_ROOT_SOURCE=dev-untrusted`) | live | 8 pages pass: footer "Engine online · unverified (dev)", DEV MODE badge |
| Receipt store live checks (real engine binary + Postgres container) | live | receipt identical after an engine restart; with the database stopped, reads still verified in 3.6 s and lookups answer `receipt storage unavailable` |
| DemoStorage on Sepolia (`cast receipt` / `cast codehash`) | live | deployment record matches the chain (§3) |
| `docker compose --profile demo up --build` | **not run** | Last run 2026-10-27, before the move to `backend/` / `frontend/`. WSL on the checking machine has 3 GB of memory; the release Helios image build needs ≥ 4 GB |
| GitHub Actions | **not run here** | see §0 |
| Private transport (Anyone SOCKS) | **not built** | `privacy=required` fails closed with `PRIVACY_UNAVAILABLE` |

## 2. Documented commands from a clean checkout

Every command block in `README.md`, `backend/README.md`, `frontend/sdk/README.md`,
`frontend/dashboard/README.md`, `smart-contract/README.md`, `docs/SERVICES.md` and `docs/demo-script.md`
was run as written, except the ones marked otherwise. Shell scripts ran in Ubuntu WSL; `pnpm` commands ran
on Windows and in WSL.

| Command (doc) | Result |
|---|---|
| `git clone … && cd Eth-G/Veriq && cp .env.example .env` (README) | OK; scripts check out with LF (`.gitattributes`) |
| `cargo build … -p veriq-server` / `--features helios` (README) | OK |
| `pnpm i` / `pnpm -r build` (README) | OK |
| `pnpm db:generate` (README) | OK without a database |
| `pnpm db:migrate` / `db:deploy` / `db:studio` (README) | not run (need a database and, for studio, a browser) |
| Quick Start 1–3: dev mode + `curl veriq_readBalance` (README) | QUICKSTART_DEV |
| Quick Start 4–5: Helios + `curl` balance and storage (README) | QUICKSTART_HELIOS |
| `cargo build/test/fmt/clippy` (backend/README, README "Development") | OK (§1) |
| Postgres container + `TEST_DATABASE_URL=… cargo test -p veriq-server postgres` (backend/README) | OK |
| `curl -L https://foundry.paradigm.xyz \| bash && foundryup`, `forge test` (smart-contract/README) | OK |
| `./scripts/check-services.sh` (SERVICES) | OK |
| `pnpm i && pnpm -r build`, `pnpm demo` (demo-script, in WSL) | DEMO_RESULT |
| `pnpm --filter veriq-dashboard smoke` (dashboard/README) | SMOKE_RESULT |
| `pnpm e2e`, `bash ./scripts/attack-check.sh` (README) | OK (§1, §3) |
| `docker compose …` (README, demo-script) | **not run** (§1) |
| Attack Lab `curl … /mode` and `cargo run … veriq-malicious-rpc` (README) | exercised by `attack-check.sh` / `e2e.sh`, not typed by hand |

Fixed while doing this (all in §5): scripts arriving with CRLF in a Windows clone; `.env.example` defaults
that stopped a fresh `cp .env.example .env` (a placeholder `DATABASE_URL` and `VERIQ_DEMO_ADDRESS`); empty
`.env` values (`PORT=`, `VITE_ENGINE_URL=`) treated as real settings; the README clone path and a placeholder
`HELIOS_CHECKPOINT` export.

## 3. Live output (2026-11-01)

`pnpm e2e`, clean checkout, Helios root, demo build:

```text
health      PASS engine ok · root local-light-client
read        PASS balance is verified · DemoStorage PASS slot 0 proves to 42
one block   pinned block #12042479, every receipt on it:
            PASS balance · nonce · code of an EOA · absent account (exclusion proof)
            PASS contract code (372 bytes) · storage slot 0 = 42 · unused slot = 0 (exclusion proof)
            PASS balances[deployer] = 7 via veriq_readStorage and via eth_getStorageAt
            PASS nonce and contract code match a plain provider at the same block
            PASS keccak256(code) = the account's codeHash 0xf24884df… = the forge build runtime bytecode
value       plain RPC claims +1000 ETH  → PASS honest proven value, attacker invalid-proof
outage      plain RPC fails             → PASS honest proven value, attacker transport-failure
proof / wrongblock / nonce / code       → PASS honest proven value, attacker invalid-proof
            PASS all attack modes ran on one engine process (breakers reset in place)
policy      PASS latest+required → -32014 POLICY_UNSATISFIABLE
SDK CLI     PASS veriq read printed the receipt (node v22)
logs        PASS engine log has no URL and no full address
result: 33 passed, 0 failed, 0 skipped
```

`scripts/attack-check.sh`: each mode's forgery is first checked at the proxy, then through an engine with the
attacker first and an honest provider behind it (breakers reset before every read). value / proof / wrongblock /
nonce / code → attacker `invalid-proof`; outage → `transport-failure`; the honest proven value every time; every
receipt `verified` from `local-light-client`. 24 passed, 0 failed.

DemoStorage `0x1242C562946C926a6d0012Acb54D9413A54A1CA4`: the deployment and both setup transactions have
status 1 and come from the recorded deployer at blocks 12,013,588–12,013,590; the CREATE produced this address;
the live code (372 bytes, code hash `0xf24884df…0f1e`) is byte-for-byte the `forge build` output.

## 4. Seams

| Seam | State |
|---|---|
| `veriq_readBalance` / `veriq_readStorage` (+ `proofroute_*` aliases) ↔ SDK `readBalance` / `readStorage` | OK; the receipt is in `result.receipt` |
| `eth_getBalance` / `eth_getStorageAt` / `eth_getTransactionCount` / `eth_getCode` at `finalized` | OK; value in `result`, receipt in the top-level `veriq` member. The SDK reads it with `requestWithReceipt` and the viem transport (`lastReceipt`, `onReceipt`). There is no `readNonce` / `readCode`; these methods take no policy and always run under `verifiedFinalized` (SDK README, "honest limits") |
| Any other method | `UNSUPPORTED_VERIFICATION`, never forwarded; `eth_chainId` answered locally |
| `GET /health` | `lightClient` (synced, finalized, `headNumber`), `providers[]`, `rootCache`, `rootSource` (`null` without one); `degraded` + `ROOT_REFRESH_FAILING` while the cache serves the last good root |
| `GET /receipts`, `/receipts/{id}`, `veriq_getReceipt` | OK; persistence is best-effort (README "Receipt Storage"): a failed save is logged, the answer and its inline receipt are still returned, writes give up after 2 s |
| Receipt / errors / policy | `receipt.rs` = `schema.ts` (real fixture, both sides); error codes parsed from `error.rs` by an SDK test; one `Policy` type |
| Attack Lab ↔ attacker ↔ breakers | `GET/POST /mode` through the `/attacker` proxy. Each mode switch, and the **Reset breakers** button, calls the engine's demo-only `POST /admin/reset-breakers` directly on `127.0.0.1:8547` (the `/engine` proxy refuses `/admin/*`). A non-demo engine gets a visible warning; there an `INVALID_PROOF` benches the attacker for 5 minutes |
| Bind address | `127.0.0.1:8547` by default; `VERIQ_HOST` / `PORT` override it for hosting (Render). CORS allows `http://localhost:3000` only, so a hosted dashboard must reach the engine through a same-origin proxy (as Vercel does) |
| Config | `backend/config/sepolia.toml` + `checkpoint.toml`; folder = `VERIQ_CONFIG_DIR`, else `./config`, `./backend/config`, the source tree's |

## 5. Changes in this pass (uncommitted on top of `53977be`)

- **Line endings.** A Windows clone (`core.autocrlf=true`, the default there) checked out every shell script and
  both Docker entrypoints with CRLF, so `pnpm e2e`, `pnpm demo`, `attack-check.sh` and `check-services.sh` all
  stopped at `set: pipefail: invalid option name`. The repository now has `.gitattributes` forcing LF for
  `*.sh`, `*.py` and `Dockerfile*`; `Dockerfile.attacker` and `Dockerfile.dashboard`, stored with CRLF, are
  converted. A fresh clone with the attributes gets LF scripts (checked). The earlier report blamed `demo.sh`
  only; in git all scripts were LF, and the conversion happened on checkout.
- **`.env` with CRLF.** `e2e.sh`, `demo.sh` and `check-services.sh` now strip `\r` when sourcing `.env`, as
  `attack-check.sh` already did; `attack-check.sh` reports a missing `VERIQ_PROVIDERS` instead of
  `unbound variable`.
- **`.env.example`.** `DATABASE_URL` and `VERIQ_DEMO_ADDRESS` were set to placeholders, so a fresh copy made
  the engine try a database with password `<password>` (startup refused) and the scripts read the address
  `0x<sepolia-address-with-balance>`. Both are now empty (in-memory receipts; the scripts' default address).
  `VERIQ_DEMO_CONTRACT` is filled with the deployed DemoStorage, `HELIOS_CONSENSUS_RPC` with the public Nimbus
  endpoint and the second provider with keyless PublicNode, so only one URL has to be filled in. Added
  `VERIQ_HOST`, `PORT`, `VITE_ENGINE_ADMIN_URL`, `VERIQ_DEMO_BALANCE_ACCOUNT`, `VERIQ_DEMO_BALANCE`; stale paths
  fixed.
- **Empty settings.** An unfilled `PORT=` or `VERIQ_HOST=` made the engine bind `127.0.0.1:` and exit; an
  unfilled `VITE_ENGINE_URL=` (exported by `demo.sh`) gave the dashboard an empty engine URL, so it fell back
  to sample data. Empty now means "default" in the engine and the dashboard.
- **Hosted PostgreSQL.** Neon's copied URL ends in `channel_binding=require`, which SQLx does not support; the
  engine failed with "could not connect". It now names the parameter and how to fix it (test
  `channel_binding_require_is_named_without_echoing_the_url`); documented in README, SERVICES and `.env.example`.
- **Docs.** README: clone path (`cd Eth-G/Veriq`), prerequisites (Python 3, curl, Node 22 for the smoke,
  Foundry install), commented-out optional `HELIOS_CHECKPOINT`, `VERIQ_HOST` / `PORT`, the bind-address
  wording, what `attack-check.sh` really checks, the Attack Lab reset and hosted simulation, Docker marked not
  re-run, `pnpm i` in the same environment as `pnpm demo`. SDK README: nonce/code are verified, but have no
  first-class methods (see §4). SERVICES: Neon, npm `0.1.1` contents, Vercel and Render rows. demo-script:
  verified setup steps. This report: rewritten from the clean-checkout run.
- **Repository hygiene.** `scripts/lib/__pycache__/evm.cpython-312.pyc`, committed in `53977be`, is removed
  and Python bytecode is ignored.

### Earlier changes (2026-10-28 to 2026-11-01, committed)

Provider config fails fast on duplicate/invalid labels and non-HTTP(S) URLs; Attack Lab resets breakers on each
mode switch; breaker recovery tested at its exact 5-minute / 30-second boundaries. Receipt persistence is
best-effort with a 2 s write cap and a 3 s pool wait. The SDK keeps the `veriq` receipt of standard reads
(`requestWithReceipt`, transport branches for nonce and code). Footer engine status distinguishes synced / dev /
syncing / offline; the placeholder team line is removed; a browser smoke test exists. `e2e.sh` proves the
DemoStorage mapping entry and checks code against `codeHash` and the compiled bytecode; Foundry installed.
`/health` reports `headNumber`; the root cache refuses roots older than 30 minutes. Re-probing of ineligible
providers; demo-only breaker reset; duplicate receipt ids refused; `PORT` / `VERIQ_HOST` for cloud hosting
(`3402d24`, whose unused import failed clippy and was removed).

## 6. Security checklist

| Check | Result | Evidence |
|---|---|---|
| Root from Helios (or fixture) only | **PASS** | dev root refused unless `VERIQ_DEV_ALLOW_UNTRUSTED_ROOT=1`, receipts then `unverified`; live receipts `local-light-client` (§3) |
| Proven values only | **PASS** | claimed ≠ proven → `INVALID_PROOF` (`read_path`, `wrong_block`, e2e and attack-check, every mode) |
| Engine bind address | **PASS (default)** | `127.0.0.1:8547` unless `VERIQ_HOST` / `PORT` are set; another address in `sepolia.toml` refuses to start (test). Setting `VERIQ_HOST=0.0.0.0` (as on Render) makes the engine public: anyone can spend the configured provider keys, and there is no rate limit |
| `eth_chainId` answered locally | **PASS** | integration test: zero provider requests |
| Response and proof bounds | **PASS** | 2 MiB response cap; proofs ≤ 64 nodes × 1 KiB (`provider.rs`, `probe.rs`, verifier `check_proof_bounds`) |
| No secrets in repo or git history | **PASS** *(2026-10-27, not re-run)* | `.env` is git-ignored |
| Checkpoint pinned and documented | **PASS** | `backend/config/checkpoint.toml` (beaconcha.in, slot 11439072); light clients refuse checkpoints older than about 2 weeks, so its slot is from 2026-10-26, so refresh it by 2026-11-09 |
| Demo attacker and reset route excluded from normal builds | **PASS** | `publish = false`, `required-features = ["demo"]`; the hosted engine answers 404 on `/admin/reset-breakers` |
| Log redaction | **PASS** | `logs_redaction.rs` + e2e `logs` |
| Fail closed (policy, privacy, unsupported, all providers bad) | **PASS** | integration tests: nothing sent where nothing may be sent |
| Failover keeps the same block and policy | **PASS** | root pinned once per request; e2e reports the same block for every mode |

## 7. Remaining issues

| # | Issue | Suggested fix |
|---|---|---|
| 1 | GitHub Actions results not confirmed (§0) | Check the Actions tab for the next push |
| 2 | Docker Compose not re-run since the folder move | On a machine with ≥ 4 GB for Docker: `docker compose --profile demo up --build`, then open `http://localhost:3000/app` |
| 3 | `veriq-client@0.1.1` on npm lacks `requestWithReceipt` and the nonce/code transport receipts | Publish `0.1.2` from the current `frontend/sdk` (`pnpm build && npm publish`) |
| 4 | The hosted engine is public with no rate limit and the free instance sleeps after 15 minutes | Add a per-IP limit, or keep the hosted engine for read-only demos |
| 5 | The Vercel `/engine` rewrite exists only in the Vercel project settings | Commit it as `vercel.json` so a recreated project keeps working |
| 6 | Private transport (Anyone SOCKS) not built | Out of scope; `privacy=required` fails closed meanwhile |

## 8. Run the demo from a clean clone

```bash
git clone https://github.com/Detective-HQ/Eth-G.git && cd Eth-G/Veriq
cp .env.example .env                 # replace the first VERIQ_PROVIDERS URL with your keyed provider
./scripts/check-services.sh          # OK / FAIL per service, never prints keys
pnpm i && pnpm -r build              # in the environment you run the demo from (WSL on Windows)
pnpm demo                            # attacker + engine (Helios) + dashboard on http://localhost:3000/app
pnpm e2e                             # unattended check (stop pnpm demo first; it needs ports 8547/9545)
```

Refresh `backend/config/checkpoint.toml` if the check script reports a bootstrap failure (checkpoints expire
after about 2 weeks).

## 9. Private reads: browser light client (S4) and browser verifier (S5), 2026-11-06

Live checks on macOS, Headless Chrome 156, local engine (`--features helios`, in-memory receipts),
dashboard dev server, Nox on Sepolia. Not run: hosted (Vercel/Render), other browsers, p50/p95
over many reads (Tier 3 harness).

| Check | Result |
|---|---|
| Nox worker ready | 3.7–3.9 s after page load |
| Browser Helios sync over Nox (Lodestar + checkpointz + execution RPC) | 8.4 s / 9.2 s / 9.5 s (three runs) |
| Browser root vs engine root | same block, hash and state root (#12077231, #12077355) |
| Verifier `.wasm` (`veriq-client/verifier.wasm`, `wasm-release` profile) | 204,609 bytes, 77,816 gzip |
| Load + instantiate | 56 ms cold, 8–21 ms cached |
| Verify one proof in the browser | storage 0.28 ms, balance 0.21 ms (mean of 50) |
| Private read, engine up | 42 (`0x2a`), `verifierLocation: browser`, `BROWSER_LIGHT_CLIENT`, 786 ms |
| Private read, engine stopped | 42, receipt `local-…` made in the browser, `LOCAL_ONLY`, 2.1 s |
| PublicNode finalized `eth_getProof` | refused 12/12 (`4444 maximum proof window`); ethpandaops RPC answered, now first default |

Tests: `cargo test --workspace`, SDK `wasm.test.ts` (shipped .wasm, every verifier fixture) and
`private.test.ts`, dashboard `lightclient.test.ts`, `helios-fixture.test.ts`, `verifier.test.ts`.
