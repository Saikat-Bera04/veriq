# Veriq — Production Requirements & External Dependency Specification

> **Document Version:** 1.0.0  
> **Date:** November 2026  
> **Status:** Phase E Mandatory Requirement  
> **Auditors:** DevOps Engineer, Ethereum Protocol Engineer, Principal Architect

---

## 1. Master Service & Dependency Matrix

| Service / Dependency | Purpose | Scope | Dev / Prod | Provider / Source | Env Variable(s) | Consuming Module | Permissions Needed | Validation Command |
|---|---|---|---|---|---|---|---|---|
| **Sepolia Execution RPC #1** | State reads (`eth_getProof`, `eth_getCode`) | **REQUIRED** | Dev & Prod | [Alchemy](https://alchemy.com) | `VERIQ_PROVIDERS` | `veriq-server::provider` | Public read calls (`eth_getProof`, EIP-1898) | `curl -s -X POST $URL -H 'content-type: application/json' -d '{"jsonrpc":"2.0","id":1,"method":"eth_chainId","params":[]}'` |
| **Sepolia Execution RPC #2** | Failover redundancy & circuit breaker | **REQUIRED** | Dev & Prod | [PublicNode](https://ethereum-sepolia-rpc.publicnode.com) | `VERIQ_PROVIDERS` | `veriq-server::provider` | Keyless / Public | `./scripts/check-services.sh` |
| **Sepolia Beacon API** | Light-client sync committee updates | **REQUIRED** (for verified reads) | Dev & Prod | [Nimbus Sepolia](https://unstable.sepolia.beacon-api.nimbus.team) / [Lodestar](https://lodestar-sepolia.chainsafe.io) | `HELIOS_CONSENSUS_RPC` | `veriq-light-client::helios_adapter` | HTTP GET `/eth/v1/beacon/light_client/*` | `curl -sf "$HELIOS_CONSENSUS_RPC/eth/v1/beacon/headers/head"` |
| **Weak-Subjectivity Checkpoint** | Trust root to bootstrap Helios | **REQUIRED** | Dev & Prod | [beaconcha.in](https://sepolia.beaconcha.in) / [checkpointz](https://checkpoint-sync.sepolia.ethpandaops.io) | `backend/config/checkpoint.toml` / `HELIOS_CHECKPOINT` | `veriq-light-client` | Read-only public hash | Checked at startup by `HeliosRoot::start` |
| **PostgreSQL Database** | Persistent Trust Receipt audit store | **OPTIONAL** (memory fallback exists) | Prod Recommended | Local PostgreSQL, Neon, AWS RDS | `DATABASE_URL` | `veriq-server::store` | Read/Write on `receipts` table | `psql $DATABASE_URL -c "SELECT COUNT(*) FROM receipts;"` |
| **Mainnet Execution RPCs** | Production Mainnet state reads | Optional (for Mainnet) | Prod (Mainnet) | PublicNode / DRPC / BlastAPI | `VERIQ_PROVIDERS` (`VERIQ_NETWORK=mainnet`) | `veriq-server::provider` | Public read (`eth_getProof`) | `./backend/crates/router/src/probe.rs` |
| **Mainnet Beacon API** | Mainnet consensus synchronization | Optional (for Mainnet) | Prod (Mainnet) | Lodestar Mainnet (`lodestar-mainnet.chainsafe.io`) | `HELIOS_CONSENSUS_RPC` | `veriq-light-client` | Public Beacon endpoints | `curl -sf "$URL/eth/v1/beacon/headers/head"` |
| **Nox Mixnet Relay (WebRTC)** | In-browser anonymous proxy (Sepolia) | Optional (for Anon-RPC) | Dev & Prod | Nox Network (Specifier `0x35133267...`) | `VITE_ANON_MODE=nox` | `frontend/dashboard/lib/anon.ts` | WebRTC data channel | In-browser smoke: `http://127.0.0.1:5180/?autorun=1` |
| **Vercel** | Frontend web application hosting | **REQUIRED** (for hosted UI) | Prod | [Vercel](https://vercel.com) | `VERIQ_ENGINE_URL` (rewrite) | `frontend/dashboard` | Static build deploy | `https://eth-g.vercel.app/app` |
| **Render / Container Host** | Rust engine hosting | **REQUIRED** (for hosted engine) | Prod | [Render](https://render.com) | `VERIQ_HOST=0.0.0.0`, `PORT` | `veriq-server` | Port bind permissions | `curl -sf https://veriq-cloud.onrender.com/health` |

---

## 2. In-Depth Onboarding Guides for Required Services

### 2.1 Sepolia Execution RPC: Alchemy
1. **What it does:** Provides the archive state and Merkle proof trie nodes (`eth_getProof`) for Sepolia blocks.
2. **Cost:** Free tier includes 300 million compute units/month (sufficient for production demo).
3. **Account Creation:**
   - Navigate to [https://www.alchemy.com](https://www.alchemy.com).
   - Sign up with an email or GitHub account.
4. **Obtaining Credentials:**
   - Go to the Dashboard $\to$ Click "Create App".
   - Select Chain: **Ethereum**, Network: **Sepolia**.
   - Copy the HTTPS URL: `https://eth-sepolia.g.alchemy.com/v2/<YOUR_API_KEY>`.
5. **Configuration:**
   - In `.env`, add to `VERIQ_PROVIDERS`:
     ```bash
     VERIQ_PROVIDERS="alchemy=https://eth-sepolia.g.alchemy.com/v2/<YOUR_API_KEY>,publicnode=https://ethereum-sepolia-rpc.publicnode.com"
     ```
6. **Validation:**
   ```bash
   ./scripts/check-services.sh
   ```

### 2.2 Consensus Beacon API: Nimbus / Lodestar
1. **What it does:** Supplies consensus headers and light-client bootstrap packages (`/eth/v1/beacon/light_client/updates`) so Helios can mathematically verify state roots without downloading the entire blockchain.
2. **Cost:** Free public infrastructure maintained by client teams (Nimbus, ChainSafe).
3. **Endpoint Options:**
   - Nimbus Public: `https://unstable.sepolia.beacon-api.nimbus.team` (Direct HTTP/HTTPS).
   - Lodestar Public: `https://lodestar-sepolia.chainsafe.io` (Let's Encrypt TLS; used for in-browser Helios over Nox).
4. **Configuration:**
   ```bash
   HELIOS_CONSENSUS_RPC="https://unstable.sepolia.beacon-api.nimbus.team"
   ```
5. **Validation:**
   ```bash
   curl -s -i "https://unstable.sepolia.beacon-api.nimbus.team/eth/v1/beacon/headers/head" | head -n 5
   ```

### 2.3 Weak-Subjectivity Beacon Checkpoint
1. **What it does:** Serves as the cryptographic trust anchor for the Helios light client. Under Proof-of-Stake, a light client must be initialized with a finalized block root within the weak-subjectivity period (~2 weeks).
2. **Cost:** Free public block explorer.
3. **How to Obtain:**
   - Visit [https://sepolia.beaconcha.in](https://sepolia.beaconcha.in).
   - Look at the latest Finalized Epoch $\to$ copy the Block Root (32-byte hex).
4. **Configuration:**
   - Update `backend/config/checkpoint.toml` or set:
     ```bash
     HELIOS_CHECKPOINT="0x<32-byte-root>"
     HELIOS_CHECKPOINT_SOURCE="https://sepolia.beaconcha.in"
     ```
5. **Validation:**
   - Start the engine with `VERIQ_ROOT_SOURCE=helios`; it will log `helios client synced to finalized block` within ~7 seconds.

### 2.4 Persistent Receipt Storage: PostgreSQL (Optional)
1. **What it does:** Retains an immutable audit trail of the newest 5,000 Trust Receipts across engine restarts.
2. **Cost:** Free local Docker container; or free tier on [Neon](https://neon.tech).
3. **Setup:**
   ```bash
   # Local via Docker:
   docker run -d --name veriq-pg -e POSTGRES_PASSWORD=veriqpass -e POSTGRES_DB=proofroute -p 127.0.0.1:5432:5432 postgres:16
   ```
4. **Configuration:**
   ```bash
   DATABASE_URL="postgres://postgres:veriqpass@127.0.0.1:5432/proofroute"
   ```
   *(Note for Neon/hosted Postgres: Strip `channel_binding=require` from the connection string).*
5. **Validation:**
   ```bash
   cargo test --manifest-path backend/Cargo.toml -p veriq-server postgres
   ```

