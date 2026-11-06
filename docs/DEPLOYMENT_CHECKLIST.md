# Veriq — Production Deployment Checklist

> **Document Version:** 1.0.0  
> **Date:** November 2026  
> **Target Platforms:** Docker Compose, Render (Backend Engine), Vercel (Frontend Dashboard)

---

## 1. Pre-Deployment Verification Checklist

Before deploying Veriq to any production or staging environment, ensure the following gates pass:

- [ ] **Rust Workspace Release Compilation:**
  ```bash
  cargo build --manifest-path backend/Cargo.toml --workspace --release --features helios
  ```
- [ ] **Rust Test Suite:**
  ```bash
  cargo test --manifest-path backend/Cargo.toml --workspace
  ```
- [ ] **TypeScript Builds & Type-checks:**
  ```bash
  pnpm -r build
  pnpm -r test
  ```
- [ ] **Fresh Consensus Checkpoint:**
  - Check that the checkpoint in `backend/config/checkpoint.toml` (or `HELIOS_CHECKPOINT`) was finalized within the last 14 days (weak-subjectivity window).
- [ ] **Provider Capability Validation:**
  ```bash
  ./scripts/check-services.sh
  ```
  Ensure at least two independent execution providers return `eth_getProof` and EIP-1898 (`{blockHash}`) capability.

---

## 2. Backend Engine Deployment (e.g. Render / Docker)

### 2.1 Configuration & Environment
- [ ] Set `VERIQ_HOST=0.0.0.0`
- [ ] Set `PORT=8547` (or use provider-assigned `$PORT`)
- [ ] Set `VERIQ_ROOT_SOURCE=helios`
- [ ] Set `VERIQ_PROVIDERS` with $\ge 2$ production RPCs (e.g., Alchemy + PublicNode).
- [ ] Set `HELIOS_CONSENSUS_RPC` (Nimbus or Lodestar Beacon API).
- [ ] Set `DATABASE_URL` (PostgreSQL with SSL enabled, `channel_binding=require` removed).
- [ ] Set `VERIQ_ALLOWED_ORIGINS` to the exact Vercel frontend domain (e.g., `https://eth-g.vercel.app`).

### 2.2 Container Execution
Build and execute via Docker:
```bash
docker build -t veriq-server -f docker/Dockerfile.engine .
docker run -d -p 8547:8547 --env-file .env veriq-server
```

### 2.3 Health Check Verification
Verify engine initialization and consensus sync:
```bash
curl -sf http://127.0.0.1:8547/health | jq .
```
Expected output:
```json
{
  "status": "ok",
  "rootSource": "helios",
  "finalizedBlock": 12076786,
  "syncStatus": "synced"
}
```

---

## 3. Frontend Dashboard Deployment (Vercel)

### 3.1 Build & Routing Settings
- **Root Directory:** `frontend/dashboard`
- **Build Command:** `pnpm build`
- **Output Directory:** `dist`
- **Install Command:** `pnpm install`

### 3.2 Environment Variables (Vercel Project Settings)
- [ ] `VITE_ENGINE_URL`: Public HTTPS URL of the deployed Render engine (e.g., `https://veriq-cloud.onrender.com`).
- [ ] `VITE_ANON_MODE`: `nox` (or `direct` if running without mixnet).
- [ ] `VITE_CHAIN`: `sepolia` (or `mainnet`).

### 3.3 Static Header Configuration (`vercel.json`)
Ensure WebAssembly and WebRTC worker headers are active:
```json
{
  "headers": [
    {
      "source": "/(.*)",
      "headers": [
        { "key": "Cross-Origin-Opener-Policy", "value": "same-origin" },
        { "key": "Cross-Origin-Embedder-Policy", "value": "credentialless" }
      ]
    }
  ]
}
```

---

## 4. Post-Deployment Smoke Verification

1. Navigate to `https://<your-vercel-domain>/app`.
2. Inspect the footer status badge: It should transition from `Anon-RPC: connecting...` to `Anon-RPC: ready (nox)`.
3. Open the **Overview** page and execute a storage read for `DemoStorage`.
4. Open the resulting Trust Receipt drawer:
   - Status must be `verified`.
   - `rootSource` must be `helios`.
   - `transport` must be `anon-rpc (nox)` (or `direct` if toggled).
5. Open the **Attack Lab** page:
   - Ensure the live circuit-breaker triggers upon tampering and automatically fails over to honest execution.

