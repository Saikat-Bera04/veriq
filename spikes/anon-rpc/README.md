# Anon-RPC feasibility page (M0)

Throwaway page for the M0 probes in [ANON_RPC_BUILD_PLAN.md](../../ANON_RPC_BUILD_PLAN.md). It is not part
of the pnpm workspace and imports no dashboard or SDK code. Results go in
[docs/ANON_RPC_FEASIBILITY.md](../../docs/ANON_RPC_FEASIBILITY.md).

```bash
cd spikes/anon-rpc
npm install          # @anon-rpc/browser-harness 0.4.0, pinned
npm run serve        # http://127.0.0.1:5180/
```

Open the page in Chrome or Edge. The worker starts at page load and shows `connecting`, `ready` or
`failed`; `?fail=1` points it at an address with no specifier contract to check the failed state;
`?autorun=1` clicks **Run all** once the worker is ready (used for headless runs). **Run all** runs
every probe in order; the browser smoke reads the results from `window.__m0` (`worker`, `readyMs`,
`error`, `probes`, `done`).

- **Harness import:** the same npm package the dashboard will use, mapped from `node_modules` with an
  import map (`index.html`, 7 entries: the harness, `harness-core`, the two `@kpstreams` packages and two
  `@noble/hashes` subpaths), so there is no build step. If the harness's dependencies change, update the
  import map; a missing entry shows as `Failed to resolve module specifier` in the console.
- **Bootstrap:** the specifier contract is read once, directly, from PublicNode (not anonymized; the
  harness needs it to find the worker code). Everything after that goes through Nox.
- **Privacy:** public, keyless endpoints only. No API keys, account addresses or `.env` values in the
  page or its log. M0.2 uses the all-zero address, which is not an account.

## What M0.1 does

Every request goes through `worker.fetch` (Nox). The page records status, bytes, content-type,
`access-control-allow-origin`, JSON shape and cold/warm latency; it never prints a full beacon body.

| Check | Endpoint |
|---|---|
| `headers/head` | `/eth/v1/beacon/headers/head` |
| `finality_update` | `/eth/v1/beacon/light_client/finality_update` |
| `optimistic_update` | `/eth/v1/beacon/light_client/optimistic_update` |
| `config/spec` | `/eth/v1/config/spec` |
| `bootstrap` | `/eth/v1/beacon/light_client/bootstrap/0x{head root}` |
| `updates` | `/eth/v1/beacon/light_client/updates?start_period={head period}&count=1` |
| `preflight` | `OPTIONS` on `headers/head` |
| `preflightGet` | `GET` + `x-m0-probe: 1` (forces a CORS preflight) |

`status` is `pass` when `headers/head` returns a slot and the other Helios endpoints used by the
adapter also answer; `partial` when only some of them do; `fail` when the head GET fails.

## What M0.2 does

Every call is a JSON-RPC POST through Nox to PublicNode Sepolia:

| Check | Call |
|---|---|
| chain | `eth_chainId` (must be `0xaa36a7`) |
| block | `eth_getBlockByNumber("finalized", false)` |
| finalized tag | `eth_getProof(0x000…0, [], "finalized")` |
| EIP-1898 | `eth_getProof(0x000…0, [], { blockHash })` |
| exact number | `eth_getProof(0x000…0, [], "0x…")` |

For each call it records status, `access-control-allow-origin`, latency, JSON-RPC error (code and
message) and a compact proof shape (`accountProof` length, `storageProof` length, balance, nonce,
hashes). Proof calls are retried up to 4 times because PublicNode is load-balanced across backends
with different proof windows; every attempt is recorded. `pass` requires the chain id and a proof at
the finalized block in at least one form (tag, EIP-1898 hash or exact number) after retries.

Optional hosted attacker (for the S1.1 repeat):

```text
http://127.0.0.1:5180/?attacker=https%3A%2F%2Fyour-attacker.onrender.com
```

That adds `checks.attacker` with the same chain and proof calls.

## What M0.3 does

It requests the same latest-block `eth_getProof` with the browser default, `Accept-Encoding: identity`
and `Accept-Encoding: gzip`, then asks two echo endpoints through Nox:

- `https://httpbingo.org/anything` with `x-m0-probe: 1` and `accept-encoding: gzip` — records what
  request headers the origin actually sees.
- `https://httpbingo.org/gzip` — if its JSON parses, the browser decompressed a gzip response.

Run it on a fresh worker (`?autorun=m03`) if a previous long run ended with `NoTunnelExitError`.

## What M0.4 does

The page loads `verifier_wasm.wasm` (built from `backend/crates/verifier-wasm`) and
`fixtures/eoa.json`, verifies the account proof through the raw ABI, compares the proven account with
the fixture, then flips the last leaf byte and expects rejection.

```bash
npm run build:wasm   # cargo build for wasm32-unknown-unknown + copy the artifact here
```

The ABI is `veriq_alloc`, `veriq_free`, `veriq_verify_account(ptr, len) -> (ptr << 32) | len`; no
wasm-bindgen. `?autorun=m04` runs only this probe.

## Result shape

`window.__m0` is `{ worker, readyMs, error, probes, done }`. `probes.m01` and `probes.m02` contain the
checks above; the browser smoke can poll `done` after clicking **Run all**.

## S4 probe: Helios in the browser over Nox (`helios.html`)

`http://127.0.0.1:5180/helios.html?checkpoint=0x…` runs the pinned Helios browser build
(`@a16z/helios` 0.12.0) with every request it makes sent through Nox: Lodestar Sepolia for the
beacon API, PublicNode for execution. The checkpoint must be the **current** finalized beacon block
root (Lodestar serves no older bootstraps), from another source than the beacon API, e.g.:

```bash
curl -s https://checkpoint-sync.sepolia.ethpandaops.io/checkpointz/v1/status \
  | python3 -c 'import sys,json;u=json.load(sys.stdin)["data"]["upstreams"];print({v["finality"]["finalized"]["root"] for v in u.values() if v["healthy"]})'
```

`?record=1` keeps every response in `window.__s4.recorded` (that is how
`fixtures/browser-helios/*.json.gz` was made); `?beacon=https://…` tries another beacon API. The
index page also takes `?beacon=` for the M0.1 probe. Results: `docs/ANON_RPC_FEASIBILITY.md#s4--helios-in-the-browser-over-nox`.

## S6 probe: Nym mixFetch on mainnet (`nym.html`)

`http://127.0.0.1:5180/nym.html` sets up a Nym tunnel (`@nymproject/mix-fetch` 3.0.1, pinned) and
sends `eth_chainId` / `eth_getProof` (finalized and block hash) to three keyless mainnet RPCs,
plus the mainnet beacon light-client API and beaconcha.in checkpointz, all through Nym. Results in
`window.__s6`; written up in `docs/ANON_RPC_FEASIBILITY.md#s6--nym-mixfetch-on-mainnet`. Each page
load gets a new tunnel, and tunnels vary: re-run if one never becomes ready.
