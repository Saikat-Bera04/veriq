# Veriq dashboard

Vite + React + Tailwind app: the landing page at `/` and the dashboard at `/app`. It talks to the engine
through [`veriq-client`](../sdk/README.md). Overview of Veriq: [../../README.md](../../README.md).

## Run

```bash
pnpm --filter veriq-dashboard dev       # http://localhost:3000/app
pnpm --filter veriq-dashboard test      # tsc --noEmit + Vitest
pnpm --filter veriq-dashboard build
```

`pnpm demo` from `Veriq/` starts the engine, the demo attacker and this app together.

## Where it gets data

Same-origin proxies (`vite.config.ts`, dev and preview), so the browser needs no CORS:

| Path | Goes to | Override |
|---|---|---|
| `/engine/*` | the engine, `http://127.0.0.1:8547` | `VERIQ_ENGINE_URL` (proxy target) or `VITE_ENGINE_URL` (skip the proxy) |
| `/attacker/*` | the demo attacker, `http://127.0.0.1:9545` | `VERIQ_ATTACKER_URL` or `VITE_ATTACKER_URL` |

The proxy never forwards `/engine/admin/*` (the engine's demo-only admin routes).

The Overview reads `DemoStorage.counter` through the SDK's verified `veriq_readStorage` request.
It uses the deployed Sepolia address by default; set `VITE_DEMO_CONTRACT_ADDRESS` at build time to
read a different deployment. A failed or unverified storage read never displays a substitute value.

The engine may use labelled sample data when it is unreachable. The Attack Lab is different: browser
simulation is only enabled in development. No hosted attacker service is currently deployed, so
production reports it as unavailable instead of showing simulated modes. `VITE_ATTACKER_URL` selects
a remote service, but the existing attacker binds to loopback and has a shared mutable mode; do not
expose it directly as a public RPC or give it unrestricted upstream credentials. A hosted version
needs a separately designed access-controlled deployment. All service calls are in
`src/dashboard/lib/engine.ts`.

## Pages (`src/dashboard/pages`)

Overview, Feed (with the receipt drawer), Attack lab, Providers, Light client, Policy, Developers.

## Tests

Vitest + Testing Library + happy-dom, with the engine and attacker replaced by a fetch stub
(`src/dashboard/test/services.tsx`):

| File | Covers |
|---|---|
| `lib/engine.test.ts` | live/mock fallback tagging; typed engine errors stay errors |
| `pages/AttackLab.test.tsx` | mode changes, failed switches, lie vs proven value, outage, simulated attacker |
| `pages/Overview.test.tsx` | deployed contract storage read, receipt link, and fail-closed rendering |
| `components/ReceiptDrawer.test.tsx` | drawer renders the real `fixtures/receipt-sample.json`; Escape closes |
| `pages/Policy.test.tsx` | `POLICY_UNSATISFIABLE` shown as a typed error, then a verified read |
| `components/footerStatus.test.ts` | footer engine chip: Helios synced, dev mode is "online · unverified", syncing is online, only no answer is offline |

### Browser smoke against a real engine

`scripts/smoke.mjs` opens `/` and every `/app` page in headless Edge/Chrome (no extra dependencies;
Node ≥ 22). It fails on console errors, on sample data (engine not reached) and on TODO text.

```bash
pnpm demo                                   # engine (Helios) + attacker + dashboard
pnpm --filter veriq-dashboard smoke         # live: footer "Helios synced", numeric head lag,
                                            # and all six attack modes played in the Attack Lab
# engine started with VERIQ_ROOT_SOURCE=dev-untrusted VERIQ_DEV_ALLOW_UNTRUSTED_ROOT=1:
pnpm --filter veriq-dashboard smoke -- --mode dev   # footer "Engine online · unverified (dev)", DEV MODE badge
pnpm --filter veriq-dashboard smoke -- --base https://your-host --no-attacks
```

Set `BROWSER_BIN` if the browser is not in a standard location.
