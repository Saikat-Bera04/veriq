# Veriq backend

The Rust workspace: the engine (`veriq-server`), the proof verifier, the light-client root sources, the
provider probe and circuit breaker, and the demo attacker. Overview and API: [../README.md](../README.md).

## Crates

| Crate | Folder | What it does |
|---|---|---|
| `veriq-core` | `crates/core` | Shared types: `Policy`, `Receipt`, error codes, env-var names, `ENGINE_ADDR` |
| `veriq-verifier` | `crates/verifier` | Account and storage Merkle-Patricia proof checks against a state root, with size bounds |
| `veriq-light-client` | `crates/light-client` | Root sources: Helios (feature `helios`), fixture, dev RPC; `CachedRoot` |
| `veriq-router` | `crates/router` | Startup provider probe, circuit breaker, `MAX_PROVIDER_ATTEMPTS` |
| `veriq-server` | `crates/server` | The engine: JSON-RPC + HTTP on `127.0.0.1:8547`, read loop, receipt store, config |
| `veriq-malicious-rpc` | `crates/malicious-rpc` | Demo attacker proxy on `127.0.0.1:9545` (only with `--features demo`) |
| integration tests | `tests/integration` | The real engine over HTTP against mock providers |

Also here: `config/` (Sepolia settings and the pinned Helios checkpoint) and `database/` (Prisma schema
and migrations for the PostgreSQL receipt store).

## Build, test, run

From this folder (or add `--manifest-path backend/Cargo.toml` from `Veriq/`):

```bash
cargo build --workspace
cargo test --workspace                                   # unit + integration tests
cargo test -p veriq-malicious-rpc --features demo        # attacker tests
cargo fmt --check && cargo clippy --workspace --all-targets -- -D warnings

# the engine, verified (needs HELIOS_CONSENSUS_RPC and VERIQ_PROVIDERS, see ../.env.example)
VERIQ_ROOT_SOURCE=helios cargo run -p veriq-server --features helios
```

On WSL with the repository on a Windows drive, set `CARGO_TARGET_DIR` to a folder in the Linux home
(e.g. `$HOME/veriq-target`) and `OPENSSL_NO_VENDOR=1` for the Helios build.

## Cargo features

| Crate | Feature | Adds |
|---|---|---|
| `veriq-server` | `helios` | The Helios light client as root source (`VERIQ_ROOT_SOURCE=helios`) |
| `veriq-server` | `demo` | Loopback-only `POST /admin/reset-breakers` for the attack lab (`pnpm demo` builds with it) |
| `veriq-malicious-rpc` | `demo` | The attacker binary itself; never part of a normal build |

## PostgreSQL tests

Two tests use `TEST_DATABASE_URL` (a dedicated, empty database; the store test truncates the table, so
never point it at a real one):

- `postgres_store_persists_orders_and_retains_newest_records` (server unit test): order, 5,000-row
  retention, duplicate id keeps the first record, malformed rows, reconnect.
- `postgres_receipts_survive_an_engine_restart_and_keep_the_first_record` (`tests/read_path.rs`): an engine
  serves `eth_getBalance`, a second engine on a new pool returns the identical receipt.

Without the variable both are skipped locally; CI runs them against a Postgres 16 service and fails if it
is missing. A throwaway database:

```bash
docker run -d --name veriq-testpg -e POSTGRES_PASSWORD=veriqtest -e POSTGRES_DB=veriq_test -p 127.0.0.1:55432:5432 postgres:16
TEST_DATABASE_URL=postgres://postgres:veriqtest@127.0.0.1:55432/veriq_test cargo test -p veriq-server postgres
```

Receipt persistence is best-effort, with writes capped at 2 s (see "Receipt persistence" in
`docs/SERVICES.md`); `read_path.rs` also covers a store that is down and one that hangs.
