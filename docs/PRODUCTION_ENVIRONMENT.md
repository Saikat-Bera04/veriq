# VeriQ Production Environment & Secrets Reference

> **Document Version:** 1.0.0  
> **Date:** November 2026  
> **Target Audience:** DevOps Engineers, Cloud Infrastructure Engineers, Security Auditors  
> **Status:** Production Standard

---

## 1. Environment Architecture & Secret Segregation

VeriQ strictly enforces the **Principle of Least Privilege** and clean boundaries between client-side bundles and server-side execution:

1. **Client-Side Environment (`frontend/dashboard` on Vercel):**
   - Bundled with Vite at build time.
   - Any variable prefixed with `VITE_` is statically embedded into public JavaScript and readable by any browser user.
   - **SECURITY RULE:** Never place database credentials, private keys, or paid API keys inside `VITE_` variables.

2. **Server-Side Environment (`backend/crates/server` on Render / Cloud Container):**
   - Injected securely into the Axum process via cloud platform secrets or environment settings.
   - All connection strings, RPC API keys, and internal URLs remain strictly server-side.
   - Log output automatically redacts provider API keys and sensitive URLs.

---

## 2. Complete Environment Variable Catalog

| Variable Name | Consuming Service | Required? | Is Secret? | Target Platform | Description & Purpose | Example Placeholder | How to Obtain / Configure |
| :--- | :--- | :--- | :--- | :--- | :--- | :--- | :--- |
| `VERIQ_ENV` | Backend (`veriq-server`) | **Required** | No | Render / Server | Sets operational mode (`production` or `development`). When set to `production`, insecure root sources (`dev-untrusted`, `fixture`) are strictly blocked. | `production` | Set explicitly in cloud dashboard. |
| `VERIQ_NETWORK` | Backend (`veriq-server`) | **Required** | No | Render / Server | Ethereum chain selection (`sepolia` or `mainnet`). Determines light client specs, chain ID, and checkpoint files. | `sepolia` | Set to `sepolia` (default) or `mainnet`. |
| `VERIQ_HOST` | Backend (`veriq-server`) | Optional | No | Render / Server | Network interface to bind. Defaults to `0.0.0.0` when `PORT` or `RENDER` is detected, or `127.0.0.1` locally. | `0.0.0.0` | Set to `0.0.0.0` in Docker / cloud environments. |
| `PORT` | Backend (`veriq-server`) | Optional | No | Render / Server | Port number the Axum HTTP server listens on. Render automatically supplies this dynamically. | `8547` (or `10000`) | Automatically assigned by hosting provider. |
| `DATABASE_URL` | Backend (`veriq-server`) | **Required** | **YES** | Render / Server | PostgreSQL connection string used for persistent Trust Receipt storage and auditing. | `postgresql://veriq:PASS@dpg-xxx:5432/proofroute?sslmode=require` | Copied from Render PostgreSQL or managed DB dashboard. Must include `sslmode=require`. |
| `VERIQ_ROOT_SOURCE` | Backend (`veriq-server`) | **Required** | No | Render / Server | Trusted consensus root source. **Must be `helios` in production.** | `helios` | Set explicitly to `helios`. |
| `HELIOS_CONSENSUS_RPC` | Backend (`veriq-server`) | **Required** | No | Render / Server | Beacon chain HTTP REST API endpoint for the Helios light client to fetch finalized consensus headers. | `https://lodestar-sepolia.chainsafe.io` | Public Lodestar or Nimbus endpoints, or Infura/QuickNode Beacon API. |
| `HELIOS_DATA_DIR` | Backend (`veriq-server`) | Optional | No | Render / Server | Filesystem path for storing light client checkpoints and sync cache. | `/data/helios` | Map to a persistent disk in Render blueprint. |
| `VERIQ_PROVIDERS` | Backend (`veriq-server`) | **Required** | **YES** | Render / Server | Comma-separated `label=url` pairs for Ethereum execution RPC nodes. At least 2 providers required for failover. | `publicnode=https://...,alchemy=https://.../v2/KEY` | Provider accounts from Alchemy, Infura, QuickNode, or public endpoints. |
| `VERIQ_ALLOWED_ORIGINS` | Backend (`veriq-server`) | **Required** | No | Render / Server | Comma-separated list of allowed frontend origins for CORS header validation. | `https://veriq.vercel.app,https://veriq-dashboard.vercel.app` | Enter your production Vercel domains. |
| `VERIQ_VERIFIED_CACHE` | Backend (`veriq-server`) | Optional | No | Render / Server | Enables verified state caching for identical reads against the same finalized block (`1` = enabled, `0` = disabled). | `1` | Set to `1` in production for high throughput. |
| `VERIQ_CONFIG_DIR` | Backend (`veriq-server`) | Optional | No | Render / Server | Directory containing network checkpoints and config TOML files. Defaults to `./config`. | `./config` | Maintained in Docker container image. |
| `RUST_LOG` | Backend (`veriq-server`) | Optional | No | Render / Server | Structured logging filter for `tracing-subscriber`. | `info,veriq_server=info` | Configure logging verbosity. |
| `VITE_ENGINE_URL` | Frontend (`dashboard`) | **Required** | No | Vercel | Base URL for the VeriQ backend. In Vercel, set to `/engine` to leverage same-origin proxy rewrites. | `/engine` (or `https://veriq-cloud.onrender.com`) | Enter `/engine` or backend HTTPS URL. |
| `VITE_ANON` | Frontend (`dashboard`) | Optional | No | Vercel | Enables Nox / WebRTC mixnet anonymization for browser-initiated RPC calls. | `on` | Set to `on` (default) or `off`. |
| `VITE_BROWSER_VERIFIER`| Frontend (`dashboard`) | Optional | No | Vercel | Enables browser-side WebAssembly Merkle trie proof cross-verification. | `on` | Set to `on` (default). |
| `VITE_BROWSER_HELIOS` | Frontend (`dashboard`) | Optional | No | Vercel | Enables in-browser Helios consensus light client synchronization over Nox. | `on` | Set to `on` for client-side trust anchoring. |
| `VITE_DEMO_CONTRACT_ADDRESS` | Frontend (`dashboard`) | Optional | No | Vercel | Address for contract storage demonstration on Sepolia. | `0x1242C562946C926a6d0012Acb54D9413A54A1CA4` | Deployed demo storage contract address. |

---

## 3. Database Connection Configuration & Driver Caveats

### Connection String Formatting
The backend uses **SQLx** with `tokio-rustls`. For cloud-hosted PostgreSQL instances (Render, Neon, Supabase, AWS RDS):
- Always append `?sslmode=require` to enforce TLS.
- **Neon Specific Warning:** Neon's default connection string includes `channel_binding=require`. SQLx does not support SASL channel binding. Remove `channel_binding=require` from your connection string before providing it to `DATABASE_URL` (SSL encryption remains fully enforced by `sslmode=require`).

### Connection Pool Sizing
In `backend/crates/server/src/store.rs`, connection pool options are optimized for cloud compute:
* `max_connections(8)`: Prevents exhausting connection limits on managed PostgreSQL free and starter tiers.
* `acquire_timeout(Duration::from_secs(3))`: Fails fast rather than blocking user queries.
* Startup retries with backoff handle waking sleeping database servers (such as Neon scale-to-zero compute) automatically.

---

## 4. Beacon Consensus RPC Recommendations

The Helios light client requires an HTTP Beacon API endpoint that provides `eth/v1/beacon/light_client/*` endpoints:

1. **Sepolia:**
   - **Lodestar (Recommended):** `https://lodestar-sepolia.chainsafe.io` (Provides optimal compatibility and reliable CORS).
   - **Nimbus:** `https://unstable.sepolia.beacon-api.nimbus.team`
2. **Mainnet:**
   - **Lodestar:** `https://lodestar-mainnet.chainsafe.io`
   - **QuickNode / Infura:** Premium Beacon endpoints.

---

## 5. Security & Secret Protection Checklist

- [x] No `VITE_` variable contains private keys, passwords, or API secrets.
- [x] Production server blocks `dev-untrusted` root sources when `VERIQ_ENV=production`.
- [x] CORS restricts access to explicitly whitelisted frontend domains.
- [x] Database credentials pass over encrypted TLS connections.
- [x] Server logs automatically redact URLs and API keys through `veriq_server::logging::redact_sensitive`.
- [x] Demo attack endpoints (`/admin/reset-breakers`) require loopback caller IP addresses and are disabled in standard release builds.

