# Judging Q&A

**What does "verified" mean exactly?**
The value was proven by a Merkle-Patricia proof (`eth_getProof`) that chains to the state root of a
**finalized** Sepolia block, and that root came from Veriq's own Helios light client, bootstrapped
from a pinned checkpoint (`backend/config/checkpoint.toml`). The provider that sent the proof never supplies
the root.

**Why not just use two RPC providers and compare?**
Agreement isn't proof: two providers can be wrong together. Veriq records `consistency=compare` as a
signal (`agree` / `divergent`) but only the proof decides.

**What happens when a provider lies?**
Its proof doesn't verify, so its attempt is recorded as `INVALID_PROOF` in the receipt, it is cooled
down for 5 minutes, and the engine retries the **same block with the same policy** at the next provider.
If every proof fails, you get `INVALID_PROOF (-32010)`, never a value.

**Why only finalized blocks?**
A finalized root can't be reorged and Helios can authenticate it. `latest` + `verification=required`
returns `POLICY_UNSATISFIABLE (-32014)` instead of pretending.

**Which methods are verified?**
`eth_getBalance`, `eth_getStorageAt`, `eth_getTransactionCount`, `eth_getCode` (code hash checked) and
`veriq_readBalance` / `veriq_readStorage` (plus their `proofroute_*` aliases). Everything else returns `UNSUPPORTED_VERIFICATION (-32012)`
and is never forwarded. `eth_chainId` is answered locally.

**Is it private?**
No, and it says so. With direct transport providers see the address and your IP. Private transport is
not built: `privacy=required` fails closed with `PRIVACY_UNAVAILABLE (-32013)` and sends nothing.

**What do you trust?**
The pinned checkpoint, Helios, and your own machine. Not providers, not their proofs, not their
block numbers, not their agreement.

**Is the dev mode a back door?**
Dev mode (root from a provider) only starts with `VERIQ_DEV_ALLOW_UNTRUSTED_ROOT=1`, and every receipt
then says `unverified` with an `UNTRUSTED_ROOT_SOURCE` warning. The dashboard shows an amber DEV MODE pill.

**How is it tested?**
Unit tests, real-Sepolia proof fixtures with tamper tests, integration tests that run the real engine over
HTTP against mock providers (outage, wrong block, wrong chain, unsupported method, policy, privacy, log
redaction), Foundry tests for the demo contract, SDK tests including a contract test against a real
engine receipt, dashboard behavioural tests (Vitest + Testing Library), and `scripts/e2e.sh` against live
Sepolia. Counts and the latest live run are in [INTEGRATION_REPORT.md](INTEGRATION_REPORT.md).
