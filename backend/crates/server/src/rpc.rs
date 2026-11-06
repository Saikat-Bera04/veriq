use std::str::FromStr;

use alloy_primitives::{Address, Bytes, B256, U256};
use serde_json::{json, Value};
use veriq_core::{Policy, VeriqError};

use crate::engine::{BrowserRoot, ClientProof, ClientVerifier, Engine, ProofKind, RequestMeta};
use crate::store::valid_receipt_id;

pub const READ_BALANCE: &str = "veriq_readBalance";
pub const READ_STORAGE: &str = "veriq_readStorage";
pub const GET_RECEIPT: &str = "veriq_getReceipt";
pub const GET_PROVIDER_HEALTH: &str = "veriq_getProviderHealth";
pub const GET_CAPABILITIES: &str = "veriq_getCapabilities";
/// The finalized block this engine verifies against; a client fetching its own proofs
/// (Anon-RPC) asks providers for exactly this block.
pub const GET_ROOT: &str = "veriq_getRoot";
/// Verify an `eth_getProof` result the client fetched itself (through Anon-RPC).
pub const VERIFY_PROOF: &str = "veriq_verifyProof";
pub const PROOFROUTE_READ_BALANCE: &str = "proofroute_readBalance";
pub const PROOFROUTE_READ_STORAGE: &str = "proofroute_readStorage";
pub const PROOFROUTE_GET_RECEIPT: &str = "proofroute_getReceipt";
pub const PROOFROUTE_GET_PROVIDER_HEALTH: &str = "proofroute_getProviderHealth";
pub const PROOFROUTE_GET_CAPABILITIES: &str = "proofroute_getCapabilities";

/// Sepolia, answered locally and never forwarded.
/// Sepolia's `eth_chainId` (the default network). The engine answers with its own network's id.
pub const CHAIN_ID_HEX: &str = "0xaa36a7";

/// Methods answered with a proof-checked value at the pinned finalized block.
pub const VERIFIED_METHODS: [&str; 8] = [
    READ_BALANCE,
    READ_STORAGE,
    PROOFROUTE_READ_BALANCE,
    PROOFROUTE_READ_STORAGE,
    "eth_getBalance",
    "eth_getStorageAt",
    "eth_getTransactionCount",
    "eth_getCode",
];

pub async fn dispatch(engine: &Engine, request: Value) -> Value {
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let method = match request.get("method").and_then(Value::as_str) {
        Some(method) => method.to_string(),
        None => {
            return error_response(&id, &VeriqError::invalid_request("missing method"));
        }
    };
    let params = request.get("params").cloned().unwrap_or_else(|| json!([]));
    // A fresh id per request: the JSON-RPC id is client-chosen and not unique.
    let meta = RequestMeta::new(method.clone(), params.clone());

    match method.as_str() {
        READ_BALANCE | PROOFROUTE_READ_BALANCE => {
            let (address, policy) = match (
                parse_address_param(&params, 0),
                parse_policy_param(&params, 1),
            ) {
                (Ok(address), Ok(policy)) => (address, policy),
                (Err(err), _) | (_, Err(err)) => return error_response(&id, &err),
            };
            match engine.read_balance_with(meta, address, &policy).await {
                Ok(read) => success_response(
                    &id,
                    json!({
                        "value": format!("{:#x}", read.value),
                        "receipt": read.receipt,
                    }),
                    None,
                ),
                Err(err) => error_response(&id, &err),
            }
        }
        READ_STORAGE | PROOFROUTE_READ_STORAGE => {
            let parsed = parse_address_param(&params, 0).and_then(|address| {
                let slot = parse_slot_param(&params, 1)?;
                let policy = parse_policy_param(&params, 2)?;
                Ok((address, slot, policy))
            });
            let (address, slot, policy) = match parsed {
                Ok(parsed) => parsed,
                Err(err) => return error_response(&id, &err),
            };
            match engine.read_storage_with(meta, address, slot, &policy).await {
                Ok(read) => success_response(
                    &id,
                    json!({
                        "value": format!("{:#x}", read.value),
                        "slot": format!("{slot:#066x}"),
                        "receipt": read.receipt,
                    }),
                    None,
                ),
                Err(err) => error_response(&id, &err),
            }
        }
        GET_RECEIPT | PROOFROUTE_GET_RECEIPT => {
            let Some(receipt_id) = params
                .as_array()
                .and_then(|values| values.first())
                .and_then(Value::as_str)
            else {
                return error_response(&id, &VeriqError::invalid_request("receipt id missing"));
            };
            if !valid_receipt_id(receipt_id) {
                return error_response(&id, &VeriqError::invalid_request("invalid receipt id"));
            }
            match engine.store().get(receipt_id).await {
                Ok(Some(row)) => match row.receipt {
                    Some(receipt) => success_response(&id, json!(receipt), None),
                    None => error_response(
                        &id,
                        &VeriqError::invalid_request(
                            "that request failed and has no receipt; see GET /receipts/{id}",
                        ),
                    ),
                },
                Ok(None) => error_response(&id, &VeriqError::invalid_request("unknown receipt id")),
                Err(_) => error_response(
                    &id,
                    &VeriqError::internal_error("receipt storage unavailable"),
                ),
            }
        }
        GET_PROVIDER_HEALTH | PROOFROUTE_GET_PROVIDER_HEALTH => {
            success_response(&id, json!(engine.provider_health()), None)
        }
        GET_CAPABILITIES | PROOFROUTE_GET_CAPABILITIES => {
            success_response(&id, capabilities(), None)
        }
        GET_ROOT => match engine.pinned_root().await {
            Ok((root, source)) => success_response(
                &id,
                json!({
                    "number": root.number,
                    "hash": format!("{:#x}", root.hash),
                    "stateRoot": format!("{:#x}", root.state_root),
                    "rootSource": source.as_str(),
                    "verified": source.is_verified(),
                    // S6: the client checks it is talking to an engine on the chain it reads.
                    "chainId": engine.network().chain_id(),
                }),
                None,
            ),
            Err(err) => error_response(&id, &err),
        },
        VERIFY_PROOF => {
            let (input, policy) =
                match (parse_client_proof(&params), parse_policy_param(&params, 1)) {
                    (Ok(input), Ok(policy)) => (input, policy),
                    (Err(err), _) | (_, Err(err)) => return error_response(&id, &err),
                };
            let slot = match input.kind {
                ProofKind::Storage(slot) => Some(format!("{slot:#066x}")),
                _ => None,
            };
            match engine.verify_client_proof(meta, input, &policy).await {
                Ok(read) => {
                    let mut result = json!({"value": read.value, "receipt": read.receipt});
                    if let Some(slot) = slot {
                        result["slot"] = json!(slot);
                    }
                    success_response(&id, result, None)
                }
                Err(err) => error_response(&id, &err),
            }
        }
        "eth_chainId" => success_response(&id, json!(engine.network().chain_id_hex()), None),
        "eth_getBalance" => {
            if let Err(err) = require_finalized(&params, 1) {
                return error_response(&id, &err);
            }
            let address = match parse_address_param(&params, 0) {
                Ok(address) => address,
                Err(err) => return error_response(&id, &err),
            };
            match engine.read_balance(meta, address).await {
                Ok(read) => {
                    success_response(&id, json!(format!("{:#x}", read.value)), Some(read.receipt))
                }
                Err(err) => error_response(&id, &err),
            }
        }
        "eth_getTransactionCount" => {
            if let Err(err) = require_finalized(&params, 1) {
                return error_response(&id, &err);
            }
            let address = match parse_address_param(&params, 0) {
                Ok(address) => address,
                Err(err) => return error_response(&id, &err),
            };
            match engine.read_nonce(meta, address).await {
                Ok(read) => {
                    success_response(&id, json!(format!("{:#x}", read.value)), Some(read.receipt))
                }
                Err(err) => error_response(&id, &err),
            }
        }
        "eth_getCode" => {
            if let Err(err) = require_finalized(&params, 1) {
                return error_response(&id, &err);
            }
            let address = match parse_address_param(&params, 0) {
                Ok(address) => address,
                Err(err) => return error_response(&id, &err),
            };
            match engine.read_code(meta, address).await {
                Ok(read) => success_response(
                    &id,
                    json!(format!("0x{}", alloy_primitives::hex::encode(&read.code))),
                    Some(read.receipt),
                ),
                Err(err) => error_response(&id, &err),
            }
        }
        "eth_getStorageAt" => {
            if let Err(err) = require_finalized(&params, 2) {
                return error_response(&id, &err);
            }
            let address = match parse_address_param(&params, 0) {
                Ok(address) => address,
                Err(err) => return error_response(&id, &err),
            };
            let slot = match parse_slot_param(&params, 1) {
                Ok(slot) => slot,
                Err(err) => return error_response(&id, &err),
            };
            match engine.read_storage(meta, address, slot).await {
                Ok(read) => {
                    success_response(&id, json!(format!("{:#x}", read.value)), Some(read.receipt))
                }
                Err(err) => error_response(&id, &err),
            }
        }
        // Fail closed: the engine never forwards a method it cannot prove.
        _ => error_response(
            &id,
            &VeriqError::unsupported_verification(format!("{method} cannot be verified")),
        ),
    }
}

/// veriq_getCapabilities
pub fn capabilities() -> Value {
    json!({
        "methods": [
            READ_BALANCE, READ_STORAGE, GET_RECEIPT, GET_PROVIDER_HEALTH, GET_CAPABILITIES,
            PROOFROUTE_READ_BALANCE, PROOFROUTE_READ_STORAGE,
            PROOFROUTE_GET_RECEIPT, PROOFROUTE_GET_PROVIDER_HEALTH,
            PROOFROUTE_GET_CAPABILITIES,
            "eth_chainId", "eth_getBalance", "eth_getStorageAt", "eth_getTransactionCount", "eth_getCode",
            GET_ROOT, VERIFY_PROOF,
        ],
        "verifiedMethods": VERIFIED_METHODS,
        "blockPolicies": ["finalized"],
        // The engine has no private transport of its own; a client can fetch proofs through
        // Anon-RPC and have them verified with veriq_verifyProof.
        "privacy": false,
        "clientProofTransports": ["anon-rpc"],
    })
}

/// `veriq_verifyProof` params[0]: `{ kind, address, slot?, blockHash, proof, code?, provider,
/// network, elapsedMs?, browserRoot?, verifier? }`.
fn parse_client_proof(params: &Value) -> Result<ClientProof, VeriqError> {
    let input = params
        .as_array()
        .and_then(|params| params.first())
        .and_then(Value::as_object)
        .ok_or_else(|| {
            VeriqError::invalid_request("veriq_verifyProof needs an object parameter")
        })?;
    let text = |key: &str| {
        input
            .get(key)
            .and_then(Value::as_str)
            .ok_or_else(|| VeriqError::invalid_request(format!("{key} missing")))
    };
    let address = Address::from_str(text("address")?)
        .map_err(|err| VeriqError::invalid_request(format!("invalid address: {err}")))?;
    let kind = match text("kind")? {
        "balance" => ProofKind::Balance,
        "nonce" => ProofKind::Nonce,
        "code" => ProofKind::Code,
        "storage" => {
            let slot = parse_slot_param(
                &json!([input.get("slot").cloned().unwrap_or(Value::Null)]),
                0,
            )?;
            ProofKind::Storage(slot)
        }
        // The client's value is not echoed: it could be a URL or a key.
        _ => {
            return Err(VeriqError::invalid_request(
                "kind must be balance, nonce, code or storage",
            ))
        }
    };
    let block_hash = B256::from_str(text("blockHash")?)
        .map_err(|err| VeriqError::invalid_request(format!("invalid blockHash: {err}")))?;
    let proof = input
        .get("proof")
        .filter(|proof| proof.is_object())
        .cloned()
        .ok_or_else(|| VeriqError::invalid_request("proof (an eth_getProof result) missing"))?;
    let code = match (kind, input.get("code").and_then(Value::as_str)) {
        (ProofKind::Code, Some(code)) => Some(
            Bytes::from_str(code)
                .map_err(|err| VeriqError::invalid_request(format!("invalid code: {err}")))?,
        ),
        (ProofKind::Code, None) => {
            return Err(VeriqError::invalid_request(
                "code (the eth_getCode result) missing",
            ))
        }
        _ => None,
    };
    Ok(ClientProof {
        kind,
        address,
        block_hash,
        proof,
        code,
        provider: text("provider")?.to_owned(),
        network: text("network")?.to_owned(),
        elapsed_ms: input.get("elapsedMs").and_then(Value::as_u64).unwrap_or(0),
        browser_root: parse_browser_root(input.get("browserRoot"))?,
        client_verifier: match input.get("verifier").and_then(|v| {
            if v.is_null() {
                None
            } else {
                Some(v)
            }
        }) {
            None => ClientVerifier::None,
            Some(value) => match value.as_str() {
                Some("browser") => ClientVerifier::Browser,
                Some("unavailable") => ClientVerifier::Unavailable,
                _ => {
                    return Err(VeriqError::invalid_request(
                        "verifier must be \"browser\" or \"unavailable\"",
                    ))
                }
            },
        },
    })
}

/// Optional `browserRoot: { number, hash, stateRoot }` (S4.2). `null` or absent: none.
fn parse_browser_root(value: Option<&Value>) -> Result<Option<BrowserRoot>, VeriqError> {
    let Some(value) = value.filter(|value| !value.is_null()) else {
        return Ok(None);
    };
    let bad = || VeriqError::invalid_request("browserRoot must be { number, hash, stateRoot }");
    let root = value.as_object().ok_or_else(bad)?;
    let word = |key: &str| {
        root.get(key)
            .and_then(Value::as_str)
            .and_then(|text| B256::from_str(text).ok())
            .ok_or_else(bad)
    };
    Ok(Some(BrowserRoot {
        number: root.get("number").and_then(Value::as_u64).ok_or_else(bad)?,
        hash: word("hash")?,
        state_root: word("stateRoot")?,
    }))
}

fn success_response(id: &Value, result: Value, receipt: Option<veriq_core::Receipt>) -> Value {
    let mut response = json!({"jsonrpc": "2.0", "id": id, "result": result});
    if let Some(receipt) = receipt {
        response["veriq"] = json!(receipt);
    }
    response
}

fn error_response(id: &Value, err: &VeriqError) -> Value {
    json!({
        "jsonrpc": "2.0",
        "id": id,
        "error": {
            "code": err.code_number(),
            "message": err.message(),
            "data": { "code": err.code_str() },
        }
    })
}

fn parse_address_param(params: &Value, index: usize) -> Result<Address, VeriqError> {
    let text = params
        .as_array()
        .and_then(|params| params.get(index))
        .and_then(Value::as_str)
        .ok_or_else(|| VeriqError::invalid_request("address parameter missing"))?;
    Address::from_str(text)
        .map_err(|err| VeriqError::invalid_request(format!("invalid address: {err}")))
}

/// Optional policy object (`veriq-client` sends one); absent or null means verifiedFinalized.
fn parse_policy_param(params: &Value, index: usize) -> Result<Policy, VeriqError> {
    match params.as_array().and_then(|params| params.get(index)) {
        None | Some(Value::Null) => Ok(Policy::default()),
        Some(value) => serde_json::from_value(value.clone())
            .map_err(|err| VeriqError::invalid_request(format!("invalid policy: {err}"))),
    }
}

fn parse_slot_param(params: &Value, index: usize) -> Result<U256, VeriqError> {
    let value = params
        .as_array()
        .and_then(|params| params.get(index))
        .ok_or_else(|| VeriqError::invalid_request("slot parameter missing"))?;

    match value {
        Value::String(text) => {
            let text = text.strip_prefix("0x").unwrap_or(text);
            if text.is_empty() {
                return Ok(U256::ZERO);
            }
            U256::from_str_radix(text, 16)
                .map_err(|err| VeriqError::invalid_request(format!("invalid slot: {err}")))
        }
        Value::Number(number) => number
            .as_u64()
            .map(U256::from)
            .ok_or_else(|| VeriqError::invalid_request("invalid slot number")),
        _ => Err(VeriqError::invalid_request(
            "slot must be a hex string or number",
        )),
    }
}

fn require_finalized(params: &Value, index: usize) -> Result<(), VeriqError> {
    let tag = params
        .as_array()
        .and_then(|params| params.get(index))
        .and_then(Value::as_str)
        .ok_or_else(|| VeriqError::policy_unsatisfiable("a finalized block tag is required"))?;

    if tag == "finalized" {
        Ok(())
    } else {
        Err(VeriqError::policy_unsatisfiable(format!(
            "strict mode only serves finalized reads, got block tag {tag}"
        )))
    }
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use alloy_primitives::B256;
    use serde_json::json;
    use veriq_light_client::{fixed::FixedRoot, PinnedRoot};

    use super::*;
    use crate::{
        engine::Engine,
        store::{InMemoryReceiptStore, ReceiptStore, StoredParams, StoredReceipt},
    };

    fn test_engine(store: Arc<dyn ReceiptStore>) -> Engine {
        Engine::new(
            Arc::new(FixedRoot::new(PinnedRoot::new(
                1,
                B256::repeat_byte(1),
                B256::repeat_byte(2),
            ))),
            Vec::new(),
        )
        .with_store(store)
    }

    #[tokio::test]
    async fn proofroute_rpc_aliases_share_store_health_and_capabilities() {
        let store = Arc::new(InMemoryReceiptStore::new());
        let receipt: veriq_core::Receipt =
            serde_json::from_str(include_str!("../../../../fixtures/receipt-sample.json"))
                .expect("receipt fixture");
        let id = receipt.identity.request_id.clone();
        store
            .insert(StoredReceipt {
                id: id.clone(),
                created_at: 100,
                method: "veriq_readBalance".to_owned(),
                params: StoredParams {
                    address: None,
                    slot: None,
                },
                value: Some("0x1".to_owned()),
                block_number: Some(receipt.block.number),
                receipt: Some(receipt),
                error: None,
                attempts: Vec::new(),
            })
            .await
            .expect("insert");
        let engine = test_engine(store);

        let got = dispatch(
            &engine,
            json!({
                "jsonrpc": "2.0",
                "id": "client-id",
                "method": PROOFROUTE_GET_RECEIPT,
                "params": [id],
            }),
        )
        .await;
        assert_eq!(got["id"], "client-id");
        assert_eq!(got["result"]["identity"]["requestId"], id);
        assert!(got.get("error").is_none());

        let health = dispatch(
            &engine,
            json!({"jsonrpc":"2.0", "id":7, "method":PROOFROUTE_GET_PROVIDER_HEALTH}),
        )
        .await;
        assert_eq!(health["id"], 7);
        assert_eq!(health["result"], json!([]));

        let capabilities = dispatch(
            &engine,
            json!({"jsonrpc":"2.0", "id":8, "method":PROOFROUTE_GET_CAPABILITIES}),
        )
        .await;
        assert_eq!(capabilities["id"], 8);
        assert!(capabilities["result"]["methods"]
            .as_array()
            .expect("methods")
            .contains(&json!(PROOFROUTE_GET_RECEIPT)));
    }

    #[tokio::test]
    async fn proofroute_read_aliases_reach_the_verified_read_path() {
        // No providers configured: a routed read fails as ALL_PROVIDERS_FAILED, while an
        // unknown method would fail as UNSUPPORTED_VERIFICATION.
        let engine = test_engine(Arc::new(InMemoryReceiptStore::new()));
        let address = "0x0000000000000000000000000000000000000007";
        for (method, params) in [
            (READ_BALANCE, json!([address])),
            (PROOFROUTE_READ_BALANCE, json!([address])),
            (READ_STORAGE, json!([address, "0x0"])),
            (PROOFROUTE_READ_STORAGE, json!([address, "0x0"])),
        ] {
            let res = dispatch(
                &engine,
                json!({"jsonrpc":"2.0", "id":1, "method":method, "params":params}),
            )
            .await;
            assert_eq!(
                res["error"]["data"]["code"], "ALL_PROVIDERS_FAILED",
                "{method} must route like veriq_*: {res}"
            );
        }
        // Same parameter checks as the veriq_* names.
        let res = dispatch(
            &engine,
            json!({"jsonrpc":"2.0", "id":2, "method":PROOFROUTE_READ_STORAGE, "params":[address]}),
        )
        .await;
        assert_eq!(res["error"]["data"]["code"], "INVALID_REQUEST", "{res}");

        let methods = capabilities()["methods"].clone();
        let verified = capabilities()["verifiedMethods"].clone();
        for alias in [PROOFROUTE_READ_BALANCE, PROOFROUTE_READ_STORAGE] {
            assert!(methods.as_array().unwrap().contains(&json!(alias)));
            assert!(verified.as_array().unwrap().contains(&json!(alias)));
        }
    }

    #[tokio::test]
    async fn proofroute_get_receipt_uses_typed_errors_for_invalid_and_missing_ids() {
        let engine = test_engine(Arc::new(InMemoryReceiptStore::new()));
        for (request_id, expected) in [
            (json!("bad/id"), "INVALID_REQUEST"),
            (json!("missing-id"), "INVALID_REQUEST"),
        ] {
            let response = dispatch(
                &engine,
                json!({
                    "jsonrpc": "2.0",
                    "id": 42,
                    "method": PROOFROUTE_GET_RECEIPT,
                    "params": [request_id],
                }),
            )
            .await;
            assert_eq!(response["id"], 42);
            assert_eq!(response["error"]["data"]["code"], expected);
        }
    }

    #[test]
    fn only_finalized_tag_is_accepted() {
        require_finalized(&serde_json::json!(["0x0", "finalized"]), 1).expect("finalized");
        for tag in ["latest", "safe", "pending", "earliest"] {
            let err = require_finalized(&serde_json::json!(["0x0", tag]), 1)
                .expect_err("non-finalized tag");
            assert_eq!(err.code(), veriq_core::ErrorCode::PolicyUnsatisfiable);
        }
        let err = require_finalized(&serde_json::json!(["0x0"]), 1).expect_err("missing tag");
        assert_eq!(err.code(), veriq_core::ErrorCode::PolicyUnsatisfiable);
    }

    #[test]
    fn policy_param_defaults_and_rejects_garbage() {
        assert_eq!(
            parse_policy_param(&json!(["0x0"]), 1).expect("absent"),
            Policy::default()
        );
        assert_eq!(
            parse_policy_param(&json!(["0x0", null]), 1).expect("null"),
            Policy::default()
        );
        let err = parse_policy_param(&json!(["0x0", {"verification": "maybe"}]), 1)
            .expect_err("garbage policy");
        assert_eq!(err.code(), veriq_core::ErrorCode::InvalidRequest);
    }
}
