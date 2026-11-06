//! Demo-only HTTP JSON-RPC mutation proxy.
//!
//! This tool deliberately corrupts RPC responses; it is not a provider and
//! never constructs or claims to construct a valid proof. It supports ordinary
//! single-request HTTP JSON-RPC forwarding. `eth_subscribe` and WebSocket
//! subscriptions are unsupported. JSON-RPC batches are forwarded unchanged,
//! so mutations do not apply to batch members. Other HTTP methods are forwarded
//! unchanged; attack modes mutate `eth_getProof`, and `value` / `proof` also make
//! `eth_getBalance` claim +1000 ETH (what an unchecked app would display).
//! `nonce` adds 1 to the nonce in `eth_getProof` and `eth_getTransactionCount`;
//! `code` alters the bytes `eth_getCode` returns (the proof is left honest);
//! `hidedelegation` returns empty code `0x` for `eth_getCode` while leaving the proof honest.

use std::{env, net::SocketAddr, str::FromStr, sync::Arc, time::Duration};

use alloy_primitives::U256;
use axum::{
    body::Bytes,
    extract::State,
    http::StatusCode,
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use reqwest::Client;
use serde_json::{json, Value};
use tokio::sync::RwLock;

const DEFAULT_BIND: &str = "127.0.0.1:9545";

fn eth_1000() -> U256 {
    U256::from(1_000_000_000_000_000_000_u64) * U256::from(1000_u64)
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
enum AttackMode {
    #[default]
    Off,
    Value,
    Proof,
    WrongBlock,
    Outage,
    Nonce,
    Code,
    HideDelegation,
}

impl AttackMode {
    const ALL: [&'static str; 8] = [
        "off",
        "value",
        "proof",
        "wrongblock",
        "outage",
        "nonce",
        "code",
        "hidedelegation",
    ];

    fn parse(value: &str) -> Option<Self> {
        match value {
            "off" => Some(Self::Off),
            "value" => Some(Self::Value),
            "proof" => Some(Self::Proof),
            "wrongblock" => Some(Self::WrongBlock),
            "outage" => Some(Self::Outage),
            "nonce" => Some(Self::Nonce),
            "code" => Some(Self::Code),
            "hidedelegation" => Some(Self::HideDelegation),
            _ => None,
        }
    }

    fn as_str(self) -> &'static str {
        match self {
            Self::Off => "off",
            Self::Value => "value",
            Self::Proof => "proof",
            Self::WrongBlock => "wrongblock",
            Self::Outage => "outage",
            Self::Nonce => "nonce",
            Self::Code => "code",
            Self::HideDelegation => "hidedelegation",
        }
    }
}

#[derive(Clone)]
struct AppState {
    client: Client,
    upstream: Arc<str>,
    mode: Arc<RwLock<AttackMode>>,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let bind = env::var("MALICIOUS_RPC_BIND").unwrap_or_else(|_| DEFAULT_BIND.to_owned());
    let address = validate_bind(&bind)?;
    let upstream = env::var("UPSTREAM_RPC")
        .map_err(|_| "UPSTREAM_RPC must be set to an upstream HTTP JSON-RPC URL")?;
    let upstream_url = reqwest::Url::parse(&upstream)?;
    if !matches!(upstream_url.scheme(), "http" | "https") {
        return Err("UPSTREAM_RPC must use HTTP or HTTPS".into());
    }

    let state = AppState {
        client: Client::builder().timeout(Duration::from_secs(10)).build()?,
        upstream: Arc::from(upstream),
        mode: Arc::new(RwLock::new(AttackMode::Off)),
    };
    let app = Router::new()
        .route("/mode", get(get_mode).post(set_mode))
        .route("/", post(rpc))
        .with_state(state);
    let listener = tokio::net::TcpListener::bind(address).await?;
    eprintln!("demo malicious RPC listening on {address}");
    axum::serve(listener, app).await?;
    Ok(())
}

fn validate_bind(value: &str) -> Result<SocketAddr, String> {
    let address = SocketAddr::from_str(value).map_err(|_| "invalid MALICIOUS_RPC_BIND")?;
    if !address.ip().is_loopback() {
        return Err("MALICIOUS_RPC_BIND must be a loopback address".to_owned());
    }
    Ok(address)
}

async fn get_mode(State(state): State<AppState>) -> Json<Value> {
    Json(json!({
        "mode": state.mode.read().await.as_str(),
        "available": AttackMode::ALL
    }))
}

async fn set_mode(State(state): State<AppState>, body: Bytes) -> Response {
    let parsed = serde_json::from_slice::<Value>(&body);
    let Ok(value) = parsed else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "invalid JSON"})),
        )
            .into_response();
    };
    let name = value
        .as_str()
        .or_else(|| value.get("mode").and_then(Value::as_str));
    let Some(name) = name else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "expected a mode string or {\"mode\":\"...\"}"})),
        )
            .into_response();
    };
    let Some(mode) = AttackMode::parse(name) else {
        return (
            StatusCode::BAD_REQUEST,
            Json(json!({"error": "unknown mode", "available": AttackMode::ALL})),
        )
            .into_response();
    };
    *state.mode.write().await = mode;
    Json(json!({"mode": mode.as_str()})).into_response()
}

async fn rpc(State(state): State<AppState>, body: Bytes) -> Response {
    let request: Value = match serde_json::from_slice(&body) {
        Ok(request) => request,
        Err(_) => {
            return (
                StatusCode::BAD_REQUEST,
                Json(json!({
                    "jsonrpc": "2.0",
                    "id": null,
                    "error": {"code": -32700, "message": "PARSE_ERROR"}
                })),
            )
                .into_response();
        }
    };
    let mode = *state.mode.read().await;
    if mode == AttackMode::Outage {
        return (
            StatusCode::SERVICE_UNAVAILABLE,
            Json(json!({"error": "simulated outage"})),
        )
            .into_response();
    }

    let method = request.get("method").and_then(Value::as_str);
    let mut forwarded = request.clone();
    if method == Some("eth_getProof") {
        match mode {
            AttackMode::WrongBlock => maybe_pin_older_block(&state, &mut forwarded).await,
            AttackMode::Off
            | AttackMode::Value
            | AttackMode::Proof
            | AttackMode::Outage
            | AttackMode::Nonce
            | AttackMode::Code
            | AttackMode::HideDelegation => {}
        }
    }

    match send_upstream(&state, &forwarded).await {
        Ok((status, mut response)) => {
            if status.is_success()
                && method == Some("eth_getBalance")
                && matches!(mode, AttackMode::Value | AttackMode::Proof)
            {
                alter_balance_result(&mut response);
            }
            if status.is_success() && method == Some("eth_getProof") {
                match mode {
                    AttackMode::Value => alter_balance(&mut response),
                    AttackMode::Proof => {
                        alter_balance(&mut response);
                        corrupt_proof(&mut response);
                    }
                    AttackMode::Nonce => alter_nonce(&mut response),
                    AttackMode::Off
                    | AttackMode::WrongBlock
                    | AttackMode::Outage
                    | AttackMode::Code
                    | AttackMode::HideDelegation => {}
                }
            }
            if status.is_success() {
                match (mode, method) {
                    (AttackMode::Nonce, Some("eth_getTransactionCount")) => {
                        bump_quantity_result(&mut response)
                    }
                    (AttackMode::Code, Some("eth_getCode")) => alter_code(&mut response),
                    (AttackMode::HideDelegation, Some("eth_getCode")) => {
                        hide_delegation(&mut response)
                    }
                    _ => {}
                }
            }
            (status, Json(response)).into_response()
        }
        Err(_) => (
            StatusCode::BAD_GATEWAY,
            Json(json!({
                "jsonrpc": "2.0",
                "id": request.get("id").cloned().unwrap_or(Value::Null),
                "error": {"code": -32000, "message": "UPSTREAM_FAILURE"}
            })),
        )
            .into_response(),
    }
}

async fn send_upstream(
    state: &AppState,
    request: &Value,
) -> Result<(StatusCode, Value), reqwest::Error> {
    let response = state
        .client
        .post(state.upstream.as_ref())
        .json(request)
        .send()
        .await?;
    let status =
        StatusCode::from_u16(response.status().as_u16()).unwrap_or(StatusCode::BAD_GATEWAY);
    let body = response.bytes().await?;
    let value = serde_json::from_slice(&body).unwrap_or_else(|_| {
        json!({
            "jsonrpc": "2.0",
            "id": request.get("id").cloned().unwrap_or(Value::Null),
            "error": {"code": -32000, "message": "UPSTREAM_INVALID_RESPONSE"}
        })
    });
    Ok((status, value))
}

async fn maybe_pin_older_block(state: &AppState, request: &mut Value) {
    let Some(params) = request.get("params").and_then(Value::as_array) else {
        return;
    };
    if params.len() < 3 {
        return;
    }
    let Some(current) = resolve_block_number(state, &params[2]).await else {
        return;
    };
    let Some(older) = current.checked_sub(100) else {
        return;
    };
    let older_tag = quantity(older);
    let Some(block) = rpc_result(
        state,
        json!({
            "jsonrpc": "2.0",
            "id": "veriq-wrongblock-check",
            "method": "eth_getBlockByNumber",
            "params": [older_tag, false]
        }),
    )
    .await
    else {
        return;
    };
    let older_block_exists = block
        .get("number")
        .and_then(Value::as_str)
        .and_then(parse_quantity)
        == Some(older);
    if older_block_exists {
        if let Some(params) = request.get_mut("params").and_then(Value::as_array_mut) {
            params[2] = json!(older_tag);
        }
    }
}

async fn resolve_block_number(state: &AppState, identifier: &Value) -> Option<u64> {
    if let Some(value) = identifier.as_str() {
        if let Some(number) = parse_quantity(value) {
            return Some(number);
        }
        if !matches!(value, "latest" | "finalized" | "safe" | "earliest") {
            return None;
        }
        let block = rpc_result(
            state,
            json!({
                "jsonrpc": "2.0",
                "id": "veriq-wrongblock-current",
                "method": "eth_getBlockByNumber",
                "params": [value, false]
            }),
        )
        .await?;
        return block
            .get("number")
            .and_then(Value::as_str)
            .and_then(parse_quantity);
    }
    if let Some(number) = identifier.get("blockNumber").and_then(Value::as_str) {
        return parse_quantity(number);
    }
    let hash = identifier.get("blockHash").and_then(Value::as_str)?;
    let block = rpc_result(
        state,
        json!({
            "jsonrpc": "2.0",
            "id": "veriq-wrongblock-current",
            "method": "eth_getBlockByHash",
            "params": [hash, false]
        }),
    )
    .await?;
    block
        .get("number")
        .and_then(Value::as_str)
        .and_then(parse_quantity)
}

async fn rpc_result(state: &AppState, request: Value) -> Option<Value> {
    let (status, response) = send_upstream(state, &request).await.ok()?;
    if !status.is_success() || response.get("error").is_some() {
        return None;
    }
    response.get("result").cloned()
}

fn parse_quantity(value: &str) -> Option<u64> {
    let hex = value.strip_prefix("0x")?;
    if hex.is_empty() {
        return None;
    }
    u64::from_str_radix(hex, 16).ok()
}

fn quantity(value: u64) -> String {
    format!("0x{value:x}")
}

fn alter_balance(response: &mut Value) {
    let Some(altered) = response
        .get("result")
        .and_then(|result| result.get("balance"))
        .and_then(Value::as_str)
        .and_then(|balance| U256::from_str(balance).ok())
        .and_then(|balance| balance.checked_add(eth_1000()))
    else {
        return;
    };
    if let Some(balance) = response
        .get_mut("result")
        .and_then(|result| result.get_mut("balance"))
    {
        *balance = json!(format!("0x{altered:x}"));
    }
}

/// `eth_getBalance` result + 1000 ETH: the claim a plain RPC client would trust.
fn alter_balance_result(response: &mut Value) {
    let Some(altered) = response
        .get("result")
        .and_then(Value::as_str)
        .and_then(|balance| U256::from_str(balance).ok())
        .and_then(|balance| balance.checked_add(eth_1000()))
    else {
        return;
    };
    response["result"] = json!(format!("0x{altered:x}"));
}

/// `eth_getProof` nonce + 1: the claimed account no longer matches the proven one.
fn alter_nonce(response: &mut Value) {
    let Some(nonce) = response
        .get("result")
        .and_then(|result| result.get("nonce"))
        .and_then(Value::as_str)
        .and_then(parse_quantity)
    else {
        return;
    };
    response["result"]["nonce"] = json!(quantity(nonce.saturating_add(1)));
}

/// A quantity result (`eth_getTransactionCount`) + 1: what an unchecked app would display.
fn bump_quantity_result(response: &mut Value) {
    let Some(value) = response
        .get("result")
        .and_then(Value::as_str)
        .and_then(parse_quantity)
    else {
        return;
    };
    response["result"] = json!(quantity(value.saturating_add(1)));
}

/// Different contract code: the last byte flipped, or one `STOP` byte for an account
/// without code. `keccak256(code)` then no longer matches the proven `codeHash`.
fn alter_code(response: &mut Value) {
    let Some(code) = response.get("result").and_then(Value::as_str) else {
        return;
    };
    let hex = code.strip_prefix("0x").unwrap_or(code);
    let altered = if hex.len() < 2 {
        "0x00".to_owned()
    } else {
        let (head, last) = hex.split_at(hex.len() - 2);
        let byte = u8::from_str_radix(last, 16).unwrap_or(0) ^ 0x01;
        format!("0x{head}{byte:02x}")
    };
    response["result"] = json!(altered);
}

/// Hide delegation: forces `eth_getCode` to return `"0x"` (empty code), pretending
/// that a delegated EOA has no code at all. The account's `codeHash` in `eth_getProof`
/// is left honest, so Veriq will detect the hash mismatch against keccak256("")
/// and reject the response with INVALID_PROOF.
fn hide_delegation(response: &mut Value) {
    if response.get("result").is_some() {
        response["result"] = json!("0x");
    }
}

fn corrupt_proof(response: &mut Value) {
    let Some(proof) = response
        .get_mut("result")
        .and_then(|result| result.get_mut("accountProof"))
        .and_then(Value::as_array_mut)
    else {
        return;
    };
    // A one-byte invalid RLP value, not a synthesized trie proof.
    if proof.is_empty() {
        proof.push(json!("0x01"));
    } else {
        proof[0] = json!("0x01");
    }
}

#[cfg(test)]
mod tests {
    use std::{net::SocketAddr, sync::Arc};

    use alloy_primitives::{Address, Bytes, B256, U256};
    use axum::{
        body::Body,
        extract::State,
        http::{Request, StatusCode},
        response::IntoResponse,
        routing::{get, post},
        Json, Router,
    };
    use serde_json::{json, Value};
    use tokio::{net::TcpListener, sync::Mutex};
    use tower::ServiceExt;

    use super::{eth_1000, validate_bind, AppState, AttackMode, Client};

    #[derive(Clone, Default)]
    struct MockState {
        calls: Arc<Mutex<Vec<Value>>>,
        fail: bool,
    }

    async fn mock_upstream(
        State(state): State<MockState>,
        Json(request): Json<Value>,
    ) -> impl IntoResponse {
        state.calls.lock().await.push(request.clone());
        if state.fail {
            return (
                StatusCode::INTERNAL_SERVER_ERROR,
                Json(json!({"error": "mock failure"})),
            )
                .into_response();
        }
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let result = match method {
            "eth_getBlockByNumber" => {
                let number = request
                    .get("params")
                    .and_then(Value::as_array)
                    .and_then(|params| params.first())
                    .and_then(Value::as_str)
                    .filter(|tag| tag.starts_with("0x"))
                    .unwrap_or("0x200");
                json!({"number": number, "hash": format!("0x{}", "11".repeat(32))})
            }
            "eth_getBalance" => json!("0x2a"),
            "eth_getBlockByHash" => json!({
                "number": "0x200",
                "hash": format!("0x{}", "11".repeat(32))
            }),
            "eth_getProof" => json!({
                "balance": "0x2a",
                "nonce": "0x5",
                "accountProof": ["0xf902"],
                "storageProof": []
            }),
            "eth_getTransactionCount" => json!("0x5"),
            "eth_getCode" => json!("0x6001"),
            _ => json!({"forwarded": true}),
        };
        Json(json!({"jsonrpc": "2.0", "id": id, "result": result})).into_response()
    }

    async fn test_server(app: Router) -> SocketAddr {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind test server");
        let address = listener.local_addr().expect("test server address");
        tokio::spawn(async move {
            axum::serve(listener, app).await.expect("test server");
        });
        address
    }

    fn test_state(upstream: String, mode: AttackMode) -> AppState {
        AppState {
            client: Client::new(),
            upstream: Arc::from(upstream),
            mode: Arc::new(tokio::sync::RwLock::new(mode)),
        }
    }

    fn mock_server(state: MockState) -> Router {
        Router::new()
            .route("/", post(mock_upstream))
            .with_state(state)
    }

    #[tokio::test]
    async fn all_modes_mutate_only_the_documented_proof_fields() {
        let upstream_state = MockState::default();
        let upstream_address = test_server(mock_server(upstream_state.clone())).await;
        let proxy_state = test_state(format!("http://{upstream_address}/"), AttackMode::Off);
        let app = Router::new()
            .route("/mode", get(super::get_mode).post(super::set_mode))
            .route("/", post(super::rpc))
            .with_state(proxy_state);

        let response = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "eth_getProof",
                            "params": ["0x0000000000000000000000000000000000000000", [], "0x200"]
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("response");
        let off: Value = serde_json::from_slice(
            &axum::body::to_bytes(response.into_body(), usize::MAX)
                .await
                .expect("off response"),
        )
        .expect("off JSON");
        assert_eq!(off["result"]["balance"], "0x2a");
        assert_eq!(off["result"]["accountProof"][0], "0xf902");

        let value_response = call_mode(&app, "value").await;
        let value: Value = serde_json::from_slice(
            &axum::body::to_bytes(value_response.into_body(), usize::MAX)
                .await
                .expect("value response"),
        )
        .expect("value JSON");
        let expected = U256::from(42) + eth_1000();
        assert_eq!(value["result"]["balance"], format!("0x{expected:x}"));
        assert_eq!(value["result"]["accountProof"][0], "0xf902");

        let proof_response = call_mode(&app, "proof").await;
        let proof: Value = serde_json::from_slice(
            &axum::body::to_bytes(proof_response.into_body(), usize::MAX)
                .await
                .expect("proof response"),
        )
        .expect("proof JSON");
        assert_eq!(proof["result"]["balance"], format!("0x{expected:x}"));
        assert_eq!(proof["result"]["accountProof"][0], "0x01");
        let malformed_node = Bytes::from(vec![0x01]);
        let rejection =
            veriq_verifier::verify_account(B256::ZERO, Address::ZERO, &[malformed_node], None)
                .expect_err("tampered proof must be rejected");
        assert_eq!(rejection.code_str(), "INVALID_PROOF");

        let wrong_block_response = call_mode(&app, "wrongblock").await;
        let wrong_block: Value = serde_json::from_slice(
            &axum::body::to_bytes(wrong_block_response.into_body(), usize::MAX)
                .await
                .expect("wrongblock response"),
        )
        .expect("wrongblock JSON");
        assert_eq!(wrong_block["result"]["balance"], "0x2a");
        let calls = upstream_state.calls.lock().await;
        let proof_block = calls
            .iter()
            .rev()
            .find(|request| request["method"] == "eth_getProof")
            .expect("proof request");
        assert_eq!(proof_block["params"][2], "0x19c");
        drop(calls);

        let unrelated = app
            .oneshot(
                Request::builder()
                    .uri("/")
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": 2,
                            "method": "eth_chainId",
                            "params": []
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("unrelated response");
        let unrelated: Value = serde_json::from_slice(
            &axum::body::to_bytes(unrelated.into_body(), usize::MAX)
                .await
                .expect("unrelated response body"),
        )
        .expect("unrelated JSON");
        assert_eq!(unrelated["result"]["forwarded"], true);

        let outage_app = Router::new()
            .route("/", post(super::rpc))
            .with_state(test_state(
                format!("http://{upstream_address}/"),
                AttackMode::Outage,
            ));
        let outage = call_rpc(
            &outage_app,
            r#"{"jsonrpc":"2.0","id":8,"method":"eth_chainId","params":[]}"#,
        )
        .await;
        assert_eq!(outage.status(), StatusCode::SERVICE_UNAVAILABLE);
    }

    async fn call_mode(app: &Router, mode: &str) -> axum::response::Response {
        let _ = app
            .clone()
            .oneshot(
                Request::builder()
                    .uri("/mode")
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(json!({"mode": mode}).to_string()))
                    .expect("request"),
            )
            .await
            .expect("mode response");
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(
                        json!({
                            "jsonrpc": "2.0",
                            "id": 1,
                            "method": "eth_getProof",
                            "params": ["0x0000000000000000000000000000000000000000", [], "latest"]
                        })
                        .to_string(),
                    ))
                    .expect("request"),
            )
            .await
            .expect("proxy response")
    }

    async fn call_rpc(app: &Router, body: &str) -> axum::response::Response {
        app.clone()
            .oneshot(
                Request::builder()
                    .uri("/")
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(body.to_owned()))
                    .expect("request"),
            )
            .await
            .expect("proxy response")
    }

    #[tokio::test]
    async fn value_and_proof_modes_inflate_eth_get_balance() {
        let upstream = test_server(mock_server(MockState::default())).await;
        for (mode, expected) in [
            (AttackMode::Off, U256::from(0x2a)),
            (AttackMode::Value, U256::from(0x2a) + eth_1000()),
            (AttackMode::Proof, U256::from(0x2a) + eth_1000()),
        ] {
            let app = Router::new()
                .route("/", post(super::rpc))
                .with_state(test_state(format!("http://{upstream}/"), mode));
            let response = call_rpc(
                &app,
                r#"{"jsonrpc":"2.0","id":1,"method":"eth_getBalance","params":["0x0000000000000000000000000000000000000000","finalized"]}"#,
            )
            .await;
            let body: Value = serde_json::from_slice(
                &axum::body::to_bytes(response.into_body(), usize::MAX)
                    .await
                    .expect("body"),
            )
            .expect("json");
            let claimed =
                <U256 as std::str::FromStr>::from_str(body["result"].as_str().expect("result"))
                    .expect("hex");
            assert_eq!(claimed, expected, "{mode:?}");
        }
    }

    #[tokio::test]
    async fn nonce_and_code_modes_forge_only_their_claims() {
        let upstream = test_server(mock_server(MockState::default())).await;
        let rpc = |method: &str| {
            format!(
                r#"{{"jsonrpc":"2.0","id":1,"method":"{method}","params":["0x0000000000000000000000000000000000000000","finalized"]}}"#
            )
        };
        let proof = r#"{"jsonrpc":"2.0","id":1,"method":"eth_getProof","params":["0x0000000000000000000000000000000000000000",[],"finalized"]}"#;
        // (mode, eth_getProof nonce, eth_getTransactionCount, eth_getCode)
        for (mode, nonce, count, code) in [
            (AttackMode::Off, "0x5", "0x5", "0x6001"),
            (AttackMode::Nonce, "0x6", "0x6", "0x6001"),
            (AttackMode::Code, "0x5", "0x5", "0x6000"),
        ] {
            let app = Router::new()
                .route("/", post(super::rpc))
                .with_state(test_state(format!("http://{upstream}/"), mode));
            let read = |body: String| {
                let app = app.clone();
                async move {
                    let response = call_rpc(&app, &body).await;
                    serde_json::from_slice::<Value>(
                        &axum::body::to_bytes(response.into_body(), usize::MAX)
                            .await
                            .expect("body"),
                    )
                    .expect("json")
                }
            };
            let got = read(proof.to_owned()).await;
            assert_eq!(got["result"]["nonce"], nonce, "{mode:?}");
            assert_eq!(
                got["result"]["balance"], "0x2a",
                "{mode:?} leaves the balance"
            );
            assert_eq!(
                got["result"]["accountProof"][0], "0xf902",
                "{mode:?} leaves the proof"
            );
            assert_eq!(
                read(rpc("eth_getTransactionCount")).await["result"],
                count,
                "{mode:?}"
            );
            assert_eq!(read(rpc("eth_getCode")).await["result"], code, "{mode:?}");
        }
    }

    #[test]
    fn code_mode_gives_codeless_accounts_code() {
        let mut empty = json!({"result": "0x"});
        super::alter_code(&mut empty);
        assert_eq!(empty["result"], "0x00");
    }

    #[test]
    fn hidedelegation_clears_eth_get_code() {
        let mut delegated = json!({"result": "0xef01001242c562946c926a6d0012acb54d9413a54a1ca4"});
        super::hide_delegation(&mut delegated);
        assert_eq!(delegated["result"], "0x");
    }

    #[tokio::test]
    async fn hidedelegation_returns_empty_code_and_leaves_proof() {
        let upstream = test_server(mock_server(MockState::default())).await;
        let app = Router::new()
            .route("/", post(super::rpc))
            .with_state(test_state(
                format!("http://{upstream}/"),
                AttackMode::HideDelegation,
            ));
        let read = |body: String| {
            let app = app.clone();
            async move {
                let response = call_rpc(&app, &body).await;
                serde_json::from_slice::<Value>(
                    &axum::body::to_bytes(response.into_body(), usize::MAX)
                        .await
                        .expect("body"),
                )
                .expect("json")
            }
        };
        let proof = r#"{"jsonrpc":"2.0","id":1,"method":"eth_getProof","params":["0x0000000000000000000000000000000000000000",[],"finalized"]}"#;
        let got_proof = read(proof.to_owned()).await;
        assert_eq!(got_proof["result"]["balance"], "0x2a");
        assert_eq!(got_proof["result"]["accountProof"][0], "0xf902");

        let code_req = r#"{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x0000000000000000000000000000000000000000","finalized"]}"#;
        let got_code = read(code_req.to_owned()).await;
        assert_eq!(got_code["result"], "0x");
    }

    #[tokio::test]
    async fn rejects_malformed_input_mode_and_non_loopback_bind() {
        assert!(validate_bind("127.0.0.1:9545").is_ok());
        assert!(validate_bind("[::1]:9545").is_ok());
        assert!(validate_bind("0.0.0.0:9545").is_err());
        assert!(validate_bind("192.0.2.1:9545").is_err());

        let app = Router::new()
            .route("/mode", get(super::get_mode).post(super::set_mode))
            .route("/", post(super::rpc))
            .with_state(test_state(
                "http://127.0.0.1:1/".to_owned(),
                AttackMode::Off,
            ));
        let malformed = call_rpc(&app, "{").await;
        assert_eq!(malformed.status(), StatusCode::BAD_REQUEST);

        let bad_mode = app
            .oneshot(
                Request::builder()
                    .uri("/mode")
                    .method("POST")
                    .header("content-type", "application/json")
                    .body(Body::from(r#"{"mode":"forged"}"#))
                    .expect("mode request"),
            )
            .await
            .expect("mode response");
        assert_eq!(bad_mode.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn wrongblock_forwards_original_when_older_block_is_unavailable() {
        let upstream_state = MockState::default();
        let upstream_address = test_server(mock_server(upstream_state.clone())).await;
        let app = Router::new()
            .route("/", post(super::rpc))
            .with_state(test_state(
                format!("http://{upstream_address}/"),
                AttackMode::WrongBlock,
            ));
        let response = call_rpc(
            &app,
            r#"{"jsonrpc":"2.0","id":9,"method":"eth_getProof","params":["0x0000000000000000000000000000000000000000",[],"0x20"]}"#,
        )
        .await;
        assert_eq!(response.status(), StatusCode::OK);
        let calls = upstream_state.calls.lock().await;
        let proof_request = calls
            .iter()
            .find(|request| request["method"] == "eth_getProof")
            .expect("proof request");
        assert_eq!(proof_request["params"][2], "0x20");
    }

    #[tokio::test]
    async fn upstream_transport_failure_returns_gateway_error() {
        let app = Router::new()
            .route("/", post(super::rpc))
            .with_state(test_state(
                "http://127.0.0.1:1/".to_owned(),
                AttackMode::Off,
            ));
        let response = call_rpc(
            &app,
            r#"{"jsonrpc":"2.0","id":3,"method":"eth_chainId","params":[]}"#,
        )
        .await;
        assert_eq!(response.status(), StatusCode::BAD_GATEWAY);
    }

    #[tokio::test]
    async fn upstream_http_failure_is_forwarded_as_failure() {
        let upstream_address = test_server(mock_server(MockState {
            fail: true,
            ..Default::default()
        }))
        .await;
        let app = Router::new()
            .route("/", post(super::rpc))
            .with_state(test_state(
                format!("http://{upstream_address}/"),
                AttackMode::Off,
            ));
        let response = call_rpc(
            &app,
            r#"{"jsonrpc":"2.0","id":3,"method":"eth_chainId","params":[]}"#,
        )
        .await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
    }

    #[tokio::test]
    async fn outage_mode_returns_service_unavailable() {
        let app = Router::new()
            .route("/", post(super::rpc))
            .with_state(test_state(
                "http://127.0.0.1:1/".to_owned(),
                AttackMode::Outage,
            ));
        let response = call_rpc(&app, r#"{"jsonrpc":"2.0","id":4,"method":"eth_chainId"}"#).await;
        assert_eq!(response.status(), StatusCode::SERVICE_UNAVAILABLE);
    }
}
