# Veriq

> Read Ethereum state from untrusted RPC providers — and prove every answer.

Veriq is a local engine (`127.0.0.1:8547`) that answers Ethereum JSON-RPC reads on Sepolia. It fetches
`eth_getProof` from untrusted providers and verifies the Merkle proof against a **finalized state root from
its own Helios light client**, returning the proven value with a Trust Receipt.

**The project lives in [`Veriq/`](Veriq/)** — start with [`Veriq/README.md`](Veriq/README.md).

```bash
cd Veriq
cp .env.example .env          # fill in providers + Helios; see docs/SERVICES.md
pnpm install
pnpm demo                     # engine + demo attacker + dashboard on http://localhost:3000/app
```

- Backend (Rust engine): [`Veriq/backend`](Veriq/backend/README.md)
- SDK: [`Veriq/frontend/sdk`](Veriq/frontend/sdk/README.md) (`veriq-client`)
- Dashboard: [`Veriq/frontend/dashboard`](Veriq/frontend/dashboard/README.md)
- Demo contract: [`Veriq/smart-contract`](Veriq/smart-contract/README.md)
- Decisions: [`Veriq/DECISIONS.md`](Veriq/DECISIONS.md)
- Services and API keys: [`Veriq/docs/SERVICES.md`](Veriq/docs/SERVICES.md)
- Integration status: [`Veriq/docs/INTEGRATION_REPORT.md`](Veriq/docs/INTEGRATION_REPORT.md)
