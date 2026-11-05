# Third-party services and keys

Everything Veriq talks to, taken from what the code actually calls. Check what you have
configured, without printing any key, with:

```bash
./scripts/check-services.sh
```

`.env.example` lists exactly these variables.

## What the demo cannot run without

| Need | Without it |
|---|---|
| **≥ 1 Sepolia execution RPC that serves `eth_getProof`** (`VERIQ_PROVIDERS`) | No reads at all. **≥ 2 independent ones** are needed to show failover (an attacker plus one honest provider is enough for the attack lab). |
| **A Sepolia beacon API with the light-client routes** (`HELIOS_CONSENSUS_RPC`) | The engine can still run in dev mode, but every receipt is `unverified` (root from a provider). The point of Veriq, a verified read, needs this. |
| **A trusted checkpoint** (`backend/config/checkpoint.toml`, or `HELIOS_CHECKPOINT`) | Helios cannot bootstrap. One is committed; replace it if it ages out (see below). |

Everything else is optional.

## Services

| Service | What Veriq uses it for | Required? | Env var(s) | Where to get it | Free tier OK? | Notes |
|---|---|---|---|---|---|---|
| **Sepolia execution RPC providers** | `eth_getProof` (account + storage proofs), `eth_getCode`, and the startup probe (`eth_chainId`, `eth_getBlockByNumber("finalized")`, `eth_getProof` by tag and by `{blockHash}`) | **Required**, ≥ 2 independent | `VERIQ_PROVIDERS="name=url,name=url"` | Alchemy, Infura, Chainstack, Ankr, QuickNode, or your own node | Alchemy free tier: yes, verified by the probe (`eth_getProof` + EIP-1898 OK). Others: run the check script. | The probe excludes wrong-chain and no-`eth_getProof` providers at startup. **PublicNode** serves `eth_getProof` with EIP-1898 on Sepolia (check of 2026-10-31; it did not on 2026-10-27, so run the check script). **QuickNode's Discover plan** rejects `eth_getProof` at finalized blocks with HTTP 413 (DECISIONS.md). EIP-1898 (`{blockHash}`) is preferred so every attempt pins the exact block; without it the engine uses the block number. URLs are never logged. |
| **Sepolia beacon (consensus) API with light-client routes** | Helios bootstraps from `/eth/v1/beacon/light_client/bootstrap/{checkpoint}` and follows finality updates to authenticate the finalized state root | **Required** for verified receipts | `HELIOS_CONSENSUS_RPC` | Public: `unstable.sepolia.beacon-api.nimbus.team` (used for the recorded run); or a beacon provider that exposes the light-client API | Public endpoint: yes | Must be a **different party** from the checkpoint source. Engine builds need `--features helios` (Docker does this). |
| **Trusted checkpoint** (finalized beacon block root) | Helios' starting point: the only thing Veriq trusts besides Helios itself | **Required** | `backend/config/checkpoint.toml` (committed), `HELIOS_CHECKPOINT` + `HELIOS_CHECKPOINT_SOURCE` to override | A beacon explorer such as beaconcha.in (the recorded value), or a checkpoint-sync provider. **Not** the same source as `HELIOS_CONSENSUS_RPC`. | n/a | The committed checkpoint bootstraps today. Light clients refuse checkpoints older than the weak-subjectivity period (about 2 weeks on Sepolia), so refresh it before a demo if the check script reports a bootstrap failure. |
| **PostgreSQL** | Persistent Trust Receipt storage, newest 5,000 rows | Optional (without it: in-memory, 500, lost on restart); required by Docker Compose | `DATABASE_URL`; Docker also needs `POSTGRES_PASSWORD` | Local PostgreSQL or the included Docker Compose service | Local | Rust runtime uses SQLx; Prisma ORM 7 manages the checked-in schema/migrations and provides Studio. The engine still creates its `receipts` table/index on startup. Use a dedicated test DB for `TEST_DATABASE_URL`; never put credentials in logs or source control. Hosted PostgreSQL (e.g. Neon) works; remove `channel_binding=require` from the copied URL (SQLx does not support it, and the engine refuses to start with it). A `DATABASE_URL` that is set but unreachable stops the engine at startup. |
| Helios execution RPC | Execution data Helios checks against the consensus header | Optional | `EXEC_RPC` | Any of your providers | yes | Defaults to the first `VERIQ_PROVIDERS` URL. Also used by the fixture capture tool. |
| Attacker upstream | The demo attacker forwards to an honest node before tampering | Demo only | `UPSTREAM_RPC` | One of your providers | yes | Defaults to `EXEC_RPC`, then the first provider. |
| Sepolia faucet + throwaway deployer key | Deploy your own `DemoStorage` (counter = 42) for the storage-proof demo. One is already deployed at `0x1242C562946C926a6d0012Acb54D9413A54A1CA4`: set `VERIQ_DEMO_CONTRACT` to it and skip this | Optional (demo extra) | `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY`, `VERIQ_DEMO_ADDRESS`, then `VERIQ_DEMO_CONTRACT` | Any Sepolia faucet (e.g. Alchemy, Google Cloud, PoW faucets) | yes | Use a **fresh key that has never held real funds**. Never commit it. See `smart-contract/DEPLOYED.md`. |
| Etherscan API | Verify the deployed contract's source | Optional | `ETHERSCAN_API_KEY` (read by `forge --verify`) | etherscan.io account | yes | Not needed for the demo. |
| Anyone network SOCKS client | Private transport (`privacy=required`) | **Not built** | — | — | — | Private transport is not implemented: `privacy=required` fails closed with `PRIVACY_UNAVAILABLE` and sends nothing; `preferred` sends direct with a `PRIVACY_DOWNGRADED` warning. No SOCKS client is needed. |
| CDN media (CloudFront, images.higgs.ai) | Landing page videos and images | Runtime, no key | — | — | — | The landing loads them from third-party CDNs; the page degrades to blank media offline. |
| Google Fonts | Inter font on the landing | Runtime, no key | — | — | — | TT Norms Pro is self-hosted in `public/fonts`. |
| npm | Publishing `veriq-client` | Optional | `NPM_TOKEN` (CI secret only) | npmjs.com | yes | Published by hand: `0.1.0` and `0.1.1` (2026-11-01). `0.1.1` predates `requestWithReceipt` and the `eth_getTransactionCount` / `eth_getCode` receipt handling in the viem transport (checked in the published tarball); those need the next publish. CI publishing is not wired up. |
| Vercel (or any static host) | Hosting the landing page and dashboard | Optional | — | vercel.com | yes | `https://eth-g.vercel.app` forwards `/engine/*` to the hosted engine below (a rewrite set in the Vercel project, not in this repository). Without a demo attacker there, the Attack Lab simulates it in the browser (*Sample data*). |
| Render (or any container host) | A hosted engine | Optional | `VERIQ_HOST=0.0.0.0` (Render sets `PORT`), plus the engine variables above | render.com | Free instance sleeps after 15 min idle; the first read after that waits for a cold start and a Helios sync | `https://veriq-cloud.onrender.com`, Helios root, no `demo` feature (no reset route). Public: it answers anyone, with your provider keys and no rate limit. |
| GitHub Actions | CI (`.github/workflows/ci.yml`) | Optional | none — CI is offline | — | yes | No secrets needed. |
| Docker | `docker compose --profile demo up` | Optional | — | Docker Desktop / Engine | yes | Give Docker ≥ 4 GB RAM; the release Helios build is memory-hungry. |

## Receipt persistence

Persistence is **best-effort**: the proof decides the answer, and the store is the audit trail. If a
receipt cannot be saved (database down, or no answer within 2 s, `RECEIPT_WRITE_TIMEOUT`), the engine logs
`receipt could not be persisted` with the request id and still returns the verified value **with its
receipt inline**. Only the later lookup is affected: `veriq_getReceipt` / `GET /receipts/:id` answer
`receipt storage unavailable` (`INTERNAL_ERROR`) while the database is down, and that receipt is not in
the feed afterwards. Keep the receipt you were given if you need it later. Lookups give up after 3 s
instead of waiting the pool's default 30 s.

Tested against a real PostgreSQL 16 (`TEST_DATABASE_URL`, see `backend/README.md`): retention, duplicate ids
(the first record is kept), a receipt surviving an engine restart, a store that is down, and one that hangs.
Point `TEST_DATABASE_URL` at a dedicated database: the store test empties the `receipts` table.

## Status of this checkout's `.env` (`./scripts/check-services.sh`, 2026-11-01)

| Item | Status |
|---|---|
| alchemy (Sepolia) | **OK** — chainId, `eth_getProof`, EIP-1898 |
| publicnode (Sepolia) | **OK** — chainId, `eth_getProof`, EIP-1898 |
| Independent proof-capable providers | **2** — enough for failover between honest providers |
| Beacon API (Nimbus) | **OK** — bootstraps from the pinned checkpoint |
| Checkpoint | OK |
| `EXEC_RPC` | OK |
| `VERIQ_DEMO_CONTRACT` | **OK** — set to the deployed DemoStorage (see `smart-contract/DEPLOYED.md`) |
| `SEPOLIA_RPC_URL`, `DEPLOYER_PRIVATE_KEY` | Missing — only needed to deploy another DemoStorage |
| `ETHERSCAN_API_KEY` | Missing (optional) |

Everything the demo needs is configured. Re-run the check script before a demo: provider capabilities
change, and the checkpoint ages out after about 2 weeks.
