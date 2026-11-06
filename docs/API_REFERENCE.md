# Veriq — Engine JSON-RPC & HTTP API Reference

> **Base Address:** `http://127.0.0.1:8547` (Default Local Engine)  
> **Protocols:** JSON-RPC 2.0 over HTTP POST (`/`), REST GET (`/health`, `/receipts/:id`)

---

## 1. Verified JSON-RPC Methods

All verified read methods validate an EIP-1186 Merkle-Patricia proof against the engine's internal, light-client-authenticated finalized state root.

### 1.1 `veriq_readBalance`
Reads and proves the native Ether balance of an account.

* **Request:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "method": "veriq_readBalance",
    "params": [
      "0x1242C562946C926a6d0012Acb54D9413A54A1CA4",
      {
        "verification": "required",
        "blockPolicy": "finalized"
      }
    ]
  }
  ```
* **Success Response:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 1,
    "result": {
      "value": "0x1bc16d674ec80000",
      "receipt": {
        "identity": { "requestId": "018e...-abc-000001", "method": "veriq_readBalance", ... },
        "block": { "number": 12076786, "hash": "0x04fc...", "stateRoot": "0x88c4...", "finalized": true },
        "verification": { "status": "verified", "rootSource": "helios", ... }
      }
    }
  }
  ```

---

### 1.2 `veriq_readStorage`
Reads and proves a 32-byte storage slot for a contract address.

* **Request:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "method": "veriq_readStorage",
    "params": [
      "0x1242C562946C926a6d0012Acb54D9413A54A1CA4",
      "0x0000000000000000000000000000000000000000000000000000000000000000",
      { "verification": "required" }
    ]
  }
  ```
* **Success Response:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 2,
    "result": {
      "value": "0x000000000000000000000000000000000000000000000000000000000000002a",
      "receipt": { ... }
    }
  }
  ```

---

### 1.3 Standard Ethereum RPC Aliases
Veriq acts as a drop-in replacement for standard Ethereum execution methods:
* **`eth_getBalance(address, blockTag)`**: Intercepted; returns hex balance quantity.
* **`eth_getStorageAt(address, slot, blockTag)`**: Intercepted; returns 32-byte hex storage word.
* **`eth_getCode(address, blockTag)`**: Intercepted; verifies contract bytecode against the account's proven `codeHash`.
* **`eth_getTransactionCount(address, blockTag)`**: Intercepted; returns account nonce.
* **`eth_chainId()`**: Answered locally (`0xaa36a7` for Sepolia, `0x1` for Mainnet). Never forwarded.

---

### 1.4 Client Proof Handshake (Anon-RPC)

#### `veriq_getRoot`
Used by clients fetching their own proofs through privacy networks to learn the exact block height and state root to query.
* **Request:**
  ```json
  { "jsonrpc": "2.0", "id": 3, "method": "veriq_getRoot", "params": [] }
  ```
* **Response:**
  ```json
  {
    "jsonrpc": "2.0",
    "id": 3,
    "result": {
      "number": 12076786,
      "hash": "0x04fc...0688",
      "stateRoot": "0x88c4...92e0",
      "rootSource": "helios",
      "verified": true
    }
  }
  ```

#### `veriq_verifyProof`
Submits client-fetched proofs to the engine for Trust Receipt generation.
* **Params:** `{ kind, address, slot?, blockHash, proof, code?, provider, network, elapsedMs }`.
* **Receipt Output:** Emits receipt with `privacy.transport = "anon-rpc"` and `privacy.mechanism = "nox"`.

---

## 2. Standard HTTP Endpoints

### 2.1 `GET /health`
Returns runtime status, consensus synchronization state, and provider capability summary.

### 2.2 `GET /receipts/:id`
Retrieves a stored Trust Receipt by its unique `requestId`.

---

## 3. Error Codes Reference

| Error Code | Constant String | Description |
|---|---|---|
| `-32010` | `INVALID_PROOF` | The Merkle trie proof failed verification or claimed value differs from proven value. |
| `-32011` | `ROOT_UNAVAILABLE` | Helios light client is syncing or unable to authenticate the finalized root. |
| `-32012` | `UNSUPPORTED_VERIFICATION` | The requested method cannot be cryptographically proven. |
| `-32013` | `PRIVACY_UNAVAILABLE` | `privacy: required` requested, but no private transport (Nox/Tor) is active. |
| `-32014` | `POLICY_UNSATISFIABLE` | Request specified `verification: required` with a non-finalized block tag (`latest`). |
| `-32015` | `PROVIDER_TIMEOUT` | Upstream execution provider exceeded request deadline. |
| `-32016` | `ALL_PROVIDERS_FAILED` | All configured providers failed, timed out, or returned invalid proofs. |
| `-32017` | `ROOT_MISMATCH` | In-browser light client and engine disagreed on the finalized state root. |

