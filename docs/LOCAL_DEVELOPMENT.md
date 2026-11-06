# Veriq — Local Development & Testing Guide

> **Developer Quickstart**  
> Setup, build, test, and run the complete Veriq stack on local machines.

---

## 1. Prerequisites

Ensure the following tools are installed:
- **Rust Toolchain:** Version `1.85+` (`rustup update stable`).
- **WebAssembly Target:**
  ```bash
  rustup target add wasm32-unknown-unknown
  ```
- **Node.js & Package Manager:** Node `v20+` and `pnpm` (`npm install -g pnpm@10`).
- **PostgreSQL:** (Optional) Postgres 16 for local persistent receipt testing.
- **Foundry:** (Optional) `foundryup` for smart contract testing.

---

## 2. Environment Setup

Copy `.env.example` to `.env`:
```bash
cp .env.example .env
```

At minimum, set your execution RPC in `.env`:
```bash
VERIQ_PROVIDERS="alchemy=https://eth-sepolia.g.alchemy.com/v2/<YOUR_KEY>,publicnode=https://ethereum-sepolia-rpc.publicnode.com"
HELIOS_CONSENSUS_RPC="https://unstable.sepolia.beacon-api.nimbus.team"
```

Validate external connectivity:
```bash
./scripts/check-services.sh
```

---

## 3. One-Command Complete Demo

To launch the entire Veriq demo locally (Attacker Proxy on `:9545`, Veriq Engine on `:8547`, and Dashboard on `:3000`):

```bash
pnpm demo
```

Once running:
- **Web Dashboard:** [http://localhost:3000/app](http://localhost:3000/app)
- **Attack Lab Playground:** [http://localhost:3000/app/attack-lab](http://localhost:3000/app/attack-lab)
- **Engine Health Endpoint:** [http://127.0.0.1:8547/health](http://127.0.0.1:8547/health)
- **Attacker Control:** [http://127.0.0.1:9545/mode](http://127.0.0.1:9545/mode)

---

## 4. Building and Testing

### 4.1 Rust Engine Workspace
```bash
# Check compilation across all targets
cargo check --manifest-path backend/Cargo.toml --workspace --all-targets --all-features

# Formatting and clippy linting
cargo fmt --manifest-path backend/Cargo.toml --all -- --check
cargo clippy --manifest-path backend/Cargo.toml --workspace --all-targets --all-features -- -D warnings

# Execute test suite
cargo test --manifest-path backend/Cargo.toml --workspace
```

### 4.2 TypeScript SDK & Dashboard
```bash
# Install workspace dependencies
pnpm install

# Test TypeScript SDK
pnpm --filter veriq-client test

# Test Dashboard React Application
pnpm --filter veriq-dashboard test

# Build all packages
pnpm -r build
```

### 4.3 Automated Attack Validation
To automatically drive all 6 malicious RPC modes and verify that the engine catches every forgery and fails over:
```bash
./scripts/attack-check.sh
```

### 4.4 Live Sepolia End-to-End Verification
To execute a live end-to-end read test against Sepolia:
```bash
./scripts/e2e.sh
```

