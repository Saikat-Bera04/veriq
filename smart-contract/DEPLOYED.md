# DemoStorage deployment record

## Purpose

`DemoStorage` is a minimal Sepolia contract used to demonstrate account and
storage proofs. The deployment script initializes the counter to `42` and one
configurable demo account's balance to `7`. The deployment below was checked
on-chain after broadcasting (receipts, code size, slot 0, the mapping getter).

## Storage layout

| Slot | Solidity value | Encoding |
| --- | --- | --- |
| `0` | `counter` | `uint256` value |
| `1` | `balances` mapping base | Mapping entries are stored at derived slots |

For account `A`, the `balances[A]` entry is stored at:

```text
keccak256(abi.encode(A, uint256(1)))
```

`smart-contract/test/DemoStorage.t.sol` checks these raw slots with Foundry's
`vm.load`, as well as the public getters.

## Deployment (Sepolia only)

Requirements: Foundry (`forge`) and a Sepolia RPC URL. Provide secrets through
your shell environment or a local ignored `.env` file; do not commit the file,
paste private keys into command arguments, or print them.

Required environment variables:

- `SEPOLIA_RPC_URL` — Sepolia JSON-RPC endpoint.
- `DEPLOYER_PRIVATE_KEY` — deployer private key, supplied as a decimal or `0x`-prefixed
  hexadecimal integer. It is read by the script and never logged.
- `VERIQ_DEMO_ADDRESS` — address whose mapping balance will be initialized to `7`.

From the repository root, in Bash:

```bash
export SEPOLIA_RPC_URL='https://your-sepolia-rpc.example'
export DEPLOYER_PRIVATE_KEY='0x<your-private-key>'
export VERIQ_DEMO_ADDRESS='0x<demo-address>'
cd smart-contract
forge script script/Deploy.s.sol:Deploy \
  --rpc-url "$SEPOLIA_RPC_URL" \
  --broadcast --skip-simulation
```

Use `--skip-simulation` on Sepolia. Forge's local simulator under-estimates the
contract creation (~170k gas vs ~790k from Sepolia's own `eth_estimateGas`), so a
plain `--broadcast` sends the CREATE with too little gas and it runs out (status 0),
while the follow-up calls still "succeed" against the empty address. With
`--skip-simulation` forge uses the node's gas estimates.

The script also checks `block.chainid` is Sepolia before broadcasting. Do not
add `--broadcast` to ordinary unit-test commands; `forge test` deploys only to
its local test EVM and does not invoke this script.

## Deployment result

- Contract address: `0x1242C562946C926a6d0012Acb54D9413A54A1CA4`
  ([Etherscan](https://sepolia.etherscan.io/address/0x1242C562946C926a6d0012Acb54D9413A54A1CA4))
- Deployment transaction: `0xea3b7fe118b34670ddf8da3b34b742732f21c7ce269913f2d714ed03963ef40e` (block 12,013,588)
- `setCounter(42)`: `0x2623fec3e8aaa00daf62f1ab6c2cd1ea068e6ed39cce675d923167db633676e2` (block 12,013,589)
- `setBalance(VERIQ_DEMO_ADDRESS, 7)`: `0xbd0567c9aa0434cd1928073e2d42456cfc553c788aecb9d715546dc38c944113` (block 12,013,590)
- Deployer / `VERIQ_DEMO_ADDRESS`: `0x47c6BE3F86E091a31cb3AdF176c934467E27DC56` (throwaway Sepolia account)
- Network: Sepolia (chain id 11155111), 2026-10-28, Foundry 1.5.1, solc 0.8.24
- Checked on-chain: code 372 bytes, slot `0` = `42`, `balances(VERIQ_DEMO_ADDRESS)` = `7`
- Runtime code hash: `0xf24884df144ffaaf386d4d880481ef9563ef25c6c5a440970f07b8b7cd680f1e`
- Re-verified 2026-11-01 (Foundry 1.8.7 `cast receipt` / `cast codehash`): all three transactions
  have status 1, were sent by the deployer above at blocks 12,013,588–12,013,590, and the CREATE's
  `contractAddress` is this address. The live code is byte-for-byte the runtime bytecode that
  `forge build` produces from `src/DemoStorage.sol` (solc 0.8.24, optimizer 200 runs), and
  `scripts/e2e.sh` checks that, plus the proofs below, on every run.

Two earlier attempts from the same account (CREATE `0xbfad2496…` and `0xf5cb975c…`) ran
out of gas for the reason above and left no contract.

## Using the deployed address

The address is not hard-coded anywhere. After deploying, set it once in `.env`:

```bash
VERIQ_DEMO_CONTRACT=0x1242C562946C926a6d0012Acb54D9413A54A1CA4
```

`scripts/e2e.sh` reads `VERIQ_DEMO_CONTRACT` and checks, with proofs verified against the Helios
finalized root:

- slot `0` proves to `42`;
- the mapping entry `balances[deployer]` (slot `keccak256(abi.encode(deployer, 1))`, computed by
  `scripts/lib/evm.py`) proves to `7`, through both `veriq_readStorage` and `eth_getStorageAt`;
- an unused slot proves to `0` (exclusion proof);
- `eth_getCode` returns code whose keccak256 equals the account's `codeHash`, matches a plain
  provider at the same block, and equals the compiled runtime bytecode (when Foundry is installed).

For another deployment, set `VERIQ_DEMO_BALANCE_ACCOUNT` (the mapping key, default the deployer
above) and `VERIQ_DEMO_BALANCE` (default `7`).
