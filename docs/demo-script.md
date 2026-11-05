# Demo script (about 4 minutes)

**Setup, before the demo** (from `Veriq/`; on Windows in Ubuntu WSL): `cp .env.example .env`, put your
provider URL in `VERIQ_PROVIDERS` (see [SERVICES.md](SERVICES.md)), check it with
`./scripts/check-services.sh`, then install, build and start everything:

```bash
pnpm i && pnpm -r build           # once, in the same environment as pnpm demo
pnpm demo                         # attacker + engine (Helios, demo build) + dashboard
```

`docker compose --profile demo up --build` is the containerised alternative; it has not been re-run since
the repository moved to `backend/` and `frontend/` ([status](INTEGRATION_REPORT.md)), so rehearse with
`pnpm demo`. The hosted dashboard (`https://eth-g.vercel.app`) has no demo attacker: its Attack Lab is
simulated in the browser and tagged *Sample data*, so run the attack part locally.

Wait for "Engine online · 127.0.0.1:8547" in the dashboard sidebar. Optionally run
`pnpm e2e` beforehand. It runs every check below unattended (stop `pnpm demo` first; it needs the ports);
`pnpm e2e:dev` runs the same checks without Helios (receipts `unverified`).

## 1. The problem (landing, 30 s)

Open `http://localhost:3000`. "Every Read Verified": an RPC provider can return any balance and
your app can't tell. Scroll to **Meet Veriq** and **Core features**: Merkle proof, own light client,
Trust Receipt, fail closed.

## 2. A verified read (Overview + Light client, 45 s)

- `/app/light-client`: **Synced**, finalized block from the local Helios light client, and the
  checkpoint it bootstrapped from (beaconcha.in). "Finalized blocks can't be reorged."
- `/app/developers`: copy the 3-line SDK snippet, or in a terminal:
  `node frontend/sdk/dist/bin/veriq.js read 0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045`. The
  receipt box: `VERIFIED`, block, state root, `local light client (Helios)`.

## 3. The attack (Attack lab, 90 s): the centrepiece

`/app/attack-lab` (rose banner: SIMULATION, demo attacker on 127.0.0.1:9545).

1. Mode **value**, then **Read balance**. Left, plain RPC: the attacker's number, **+1,000 ETH**, shakes
   red, "unchecked". Right, Veriq: the honest **proven** value, **Verified**, attempts list shows
   `attacker INVALID_PROOF` then the honest provider `ok`. "The provider proposes; the proof decides."
2. Click **Open the Trust Receipt**: block, state root, attempts, bindings, Download receipt.json.
3. `/app/providers`: the attacker's breaker is **open**, with the 5-minute cooldown counting down.

(Modes `proof`, `wrongblock` and `outage` behave the same way: honest value, same block. The
attacker stays cooled down for 5 minutes after an `INVALID_PROOF`, so a second mode would be routed
straight to the honest provider and show nothing. **The Attack Lab resets the breakers itself on every mode
switch** (it says "Breakers reset: the next read tries the attacker again."); the **Reset breakers** button does
the same before a second read in one mode. By hand: `curl -X POST http://127.0.0.1:8547/admin/reset-breakers`.
The endpoint exists only in demo builds (`pnpm demo` builds the engine with `--features demo`) and
answers loopback callers only; it is not forwarded by the dashboard's `/engine` proxy. In the Docker
setup (engine built without `demo`) or any other build, restart the engine instead to show each mode fresh.)

## 4. Fail closed (Policy, 30 s)

`/app/policy`: set **Block policy = latest** and click **Run**. Result: `POLICY_UNSATISFIABLE (-32014)`
with its explanation. "Veriq never gives you a weaker answer; it gives you a typed error."
Click the `verifiedFinalized` preset and run again to get a verified receipt.

## 5. Close (15 s)

`/app/feed`: every read, including the rejected attempts, with its receipt.
