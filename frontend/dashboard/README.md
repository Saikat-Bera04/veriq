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

Overview, Feed (with the receipt drawer), Delegation guard, Attack lab, Providers, Light client, Policy, Developers.

## Tests

Vitest + Testing Library + happy-dom, with the engine and attacker replaced by a fetch stub
(`src/dashboard/test/services.tsx`):

| File | Covers |
|---|---|
| `lib/engine.test.ts` | live/mock fallback tagging; typed engine errors stay errors |
| `pages/AttackLab.test.tsx` | mode changes, failed switches, lie vs proven value, outage, simulated attacker |
| `pages/Overview.test.tsx` | deployed contract storage read, receipt link, and fail-closed rendering |
| `pages/DelegationGuard.test.tsx` | EIP-7702 delegation detection, address inspection, Trust Receipt warnings |
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
pnpm --filter veriq-dashboard smoke -- --anon        # also: private reads through Nox (below)
```

Set `BROWSER_BIN` if the browser is not in a standard location.

Without `--anon` the page checks run in **Direct mode**, as before Anon-RPC. With `--anon` the app keeps
its default (private reads through Nox) and the smoke also checks, in order:

1. the header badge reaches `Anon-RPC: ready (nox)` after `/app` loads (up to 180 s, `--anon-ready-ms`);
2. Overview reads the demo storage slot through Nox (`Fetched via anon-rpc · nox`), and its receipt
   drawer shows `Transport anon-rpc (nox)` and a `provider@anon-rpc:nox` attempt; the stored receipt
   from `/engine/receipts/:id` has `privacy.transport = anon-rpc` (skipped if that route is not reachable);
3. Policy runs a balance read through Nox, with `provider@anon-rpc:nox` in the timeline;
4. with the PublicNode bootstrap request blocked, the badge shows `Anon-RPC: failed — …` and
   **Use direct** still reads the slot (`Fetched via direct`).

**`--anon` needs the real thing.** It joins the live Nox mixnet on Sepolia (specifier
`0x35133267A8F7EC35046a83DCA0f4Ca8A6e1b7A9A`), reads the specifier once from PublicNode, and fetches proofs
from PublicNode through Nox, so it needs internet access, a running engine with a live (Helios) root, and
a browser that allows WebRTC. There is no offline version: the unit tests cover the same paths with a fake
worker (`src/dashboard/lib/anon.test.tsx`, `components/AnonBadge.test.tsx`, `lib/engine.test.ts`).

### Read path: private by default

`/app` starts the Nox worker on load (`lib/anon.ts`, one worker per page). Balance and storage reads on
Overview and Policy go through `createPrivateReader`; the header badge shows `Anon-RPC: connecting…`,
`ready (nox)`, `failed — reason` or `Direct mode`, and **Use direct** / **Use Anon-RPC** switches the path
for this tab (kept in sessionStorage; going direct keeps the worker warm). A failed join never falls back to
a direct read on its own. `/health`, receipts, provider health and the Attack Lab always go direct: the Attack
Lab needs the engine's own provider routing so that its attacker is tried. Build-time switches:
`VITE_ANON=off` (no worker, no toggle) and `VITE_ANON_PROVIDERS="label=https://url,…"` (default PublicNode).
