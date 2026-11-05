# DemoStorage

A minimal Sepolia contract for the storage-proof demo: slot `0` holds a counter (`42`) and slot `1` is the
base of a `balances` mapping. Veriq reads slot `0` with a storage proof and checks it against its own
light-client root (`veriq_readStorage(address, "0x0")` → `42`).

**Deployed:** `0x1242C562946C926a6d0012Acb54D9413A54A1CA4` on Sepolia. Transactions, checks and how to deploy
another one: [DEPLOYED.md](DEPLOYED.md).

| Path | What |
|---|---|
| `src/DemoStorage.sol` | the contract |
| `test/DemoStorage.t.sol` | storage layout checks with `vm.load` |
| `script/Deploy.s.sol` | deployment script (refuses any chain but Sepolia) |

Install Foundry once (Linux, macOS or WSL), then run the tests:

```bash
curl -L https://foundry.paradigm.xyz | bash && foundryup
forge test                  # or, from Veriq/: pnpm contracts:test
```

Set `VERIQ_DEMO_CONTRACT` to the address above in `Veriq/.env`. `scripts/e2e.sh` then proves slot `0`
(= 42), the `balances[deployer]` mapping entry (= 7) and the contract code (against its `codeHash` and
the `forge build` output) on Sepolia; see `DEPLOYED.md`.
