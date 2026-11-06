# VeriQ EIP-7702 Delegation Guard — API Reference

> **API Version:** 1.0.0  
> **Methods:** `veriq_getDelegation`, `proofroute_getDelegation`  
> **Clients:** Engine HTTP JSON-RPC, TypeScript SDK (`veriq-client`), React Hooks

---

## 1. Engine JSON-RPC API

### `veriq_getDelegation`

Performs a proof-verified scan of an Ethereum account's bytecode to detect active EIP-7702 delegation designators, verify code integrity against Helios finalized state roots, and produce a cryptographic Trust Receipt.

#### Endpoint
`POST http://127.0.0.1:8547/` (or engine bind address)

#### Headers
```http
Content-Type: application/json
```

#### Parameters

| Index | Name | Type | Required | Description |
| :--- | :--- | :--- | :--- | :--- |
| `0` | `address` | `Hex` | **Yes** | 20-byte account address (`0x` followed by 40 hex characters). |
| `1` | `policy` | `Object` | *Optional* | Request policy. Defaults to `{ verification: "required", blockPolicy: "finalized", timeoutMs: 5000 }`. |

#### Example Request
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "method": "veriq_getDelegation",
  "params": [
    "0x1242C562946C926a6d0012Acb54D9413A54A1CA4"
  ]
}
```

#### Example Response (Active Delegation)
```json
{
  "jsonrpc": "2.0",
  "id": 1,
  "result": {
    "address": "0x1242c562946c926a6d0012acb54d9413a54a1ca4",
    "status": {
      "status": "delegated",
      "delegate": "0x9876543210abcdef9876543210abcdef98765432"
    },
    "isDelegated": true,
    "delegateAddress": "0x9876543210abcdef9876543210abcdef98765432",
    "codeHash": "0x32e92c63dfb3a033f9cfb42fae9cc57be2faea1534032d184ebffb904c6e9491",
    "securityClassification": "delegation-detected",
    "blockNumber": 7412903,
    "verified": true,
    "receipt": {
      "schemaVersion": "0.1.0",
      "identity": {
        "requestId": "0194e432-8f12-0001",
        "method": "veriq_getDelegation",
        "requestBinding": "a1b2c3d4...",
        "resultBinding": "e5f6g7h8..."
      },
      "block": {
        "number": 7412903,
        "hash": "0x9a3f00000000000000000000000000000000000000000000000000000000c21e",
        "stateRoot": "0x51be1111111111111111111111111111111111111111111111111111111107aa",
        "finalized": true,
        "chainId": 11155111
      },
      "verification": {
        "status": "verified",
        "rootSource": "local-light-client",
        "verifierLocation": "local-engine",
        "mechanisms": ["account-proof", "code-hash"],
        "bootstrap": {
          "source": "helios",
          "checkpoint": null,
          "checkpointSource": null
        }
      },
      "privacy": {
        "transport": "direct",
        "mechanism": null
      },
      "routing": {
        "comparison": "not-run",
        "providersTried": 1,
        "providerLabel": "alchemy",
        "attempts": []
      },
      "freshness": {
        "observedAt": 1761000000,
        "ageSeconds": 14,
        "pinned": true
      },
      "warnings": [
        {
          "code": "EIP7702_DELEGATION_DETECTED",
          "message": "EIP-7702 delegation active: calls execute code from 0x9876543210abcdef9876543210abcdef98765432"
        }
      ]
    }
  }
}
```

#### Example Response (Normal EOA)
```json
{
  "jsonrpc": "2.0",
  "id": 2,
  "result": {
    "address": "0xd8da6bf26964af9d7eed9e03e53415d37aa96045",
    "status": {
      "status": "normal-eoa"
    },
    "isDelegated": false,
    "codeHash": "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470",
    "securityClassification": "normal-eoa",
    "blockNumber": 7412903,
    "verified": true,
    "receipt": {
      "verification": { "status": "verified" },
      "warnings": []
    }
  }
}
```

---

## 2. TypeScript SDK API (`veriq-client`)

### `veriq.getDelegation(options)`

Scans an account using the local or remote VeriQ engine.

```typescript
import { createVeriq } from 'veriq-client'

const veriq = createVeriq({ url: 'http://127.0.0.1:8547' })

const result = await veriq.getDelegation({
  address: '0x1242C562946C926a6d0012Acb54D9413A54A1CA4'
})

if (result.isDelegated) {
  console.warn(`WARNING: Account delegated to ${result.delegateAddress}`)
} else {
  console.log(`Account is normal EOA: ${result.status.status}`)
}

console.log(`Receipt verified: ${result.verified}`)
console.log(`State root: ${result.receipt.block.stateRoot}`)
```

### `privateReader.getDelegation(options)`

Fetches proof and bytecode through the **Anon-RPC mixnet** (Nox over WebRTC) and cryptographically verifies state against the local Helios light client. The RPC provider never learns the user's IP address.

```typescript
import { createVeriq, createPrivateReader } from 'veriq-client'
import { AnonRpcWorker } from '@anon-rpc/browser-harness'

const veriq = createVeriq()
const nox = new AnonRpcWorker({ address: NOX_SEPOLIA })

const privateReader = createPrivateReader(veriq, {
  fetch: nox.fetch,
  network: 'nox',
  providers: [{ label: 'publicnode', url: 'https://ethereum-sepolia-rpc.publicnode.com' }]
})

const result = await privateReader.getDelegation({
  address: '0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045'
})

console.log(`Privacy transport: ${result.receipt.privacy.transport}`) // "anon-rpc"
console.log(`Delegation status: ${result.status.status}`)
```

### Pure Offline Utilities

```typescript
import { parseDelegationDesignator, classifyAccountCode } from 'veriq-client'

// Parse raw bytecode directly
const parsed = parseDelegationDesignator('0xef01001242c562946c926a6d0012acb54d9413a54a1ca4')
console.log(parsed.isDesignator) // true
console.log(parsed.delegate)     // "0x1242c562946c926a6d0012acb54d9413a54a1ca4"

// Classify account code
const classification = classifyAccountCode('0x')
console.log(classification.status) // { status: "normal-eoa" }
```

---

## 3. Trust Receipt Warnings Reference

| Warning Code | Severity | Description |
| :--- | :--- | :--- |
| `EIP7702_DELEGATION_DETECTED` | **HIGH** | The account is actively delegated under EIP-7702. Execution will run the delegate contract's bytecode. |
| `EIP7702_DELEGATION_REVOKED` | **INFO** | The account carries designator `0xef0100 || 0x00...00` indicating previous delegation was cleared. |
| `EIP7702_INVALID_DESIGNATOR` | **HIGH** | The account bytecode begins with `0xef0100` but has an invalid byte length ($\neq 23$ bytes). |
| `INVALID_PROOF` | **CRITICAL** | Error response. Bytecode does not match the account's proven `codeHash` in the state trie. |

