//! Harness for Veriq's integration tests: a real engine HTTP server on an ephemeral
//! loopback port, mock JSON-RPC providers that record every request, and proofs from
//! either the captured Sepolia fixtures or freshly built tries. No network.

use std::collections::BTreeMap;
use std::path::PathBuf;
use std::str::FromStr;
use std::sync::{Arc, Mutex};

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_trie::{
    proof::ProofRetainer, HashBuilder, Nibbles, TrieAccount, EMPTY_ROOT_HASH, KECCAK_EMPTY,
};
use axum::{extract::State, http::StatusCode, routing::post, Json, Router};
use serde_json::{json, Value};
use veriq_light_client::{fixed::FixedRoot, PinnedRoot};
use veriq_router::probe::probe_providers;
use veriq_server::{
    engine::{Engine, ProbeStatus},
    http::app,
    provider::ProviderConfig,
};

/// How a mock provider answers.
#[derive(Debug, Clone)]
pub enum Behaviour {
    /// Sepolia, serves this eth_getProof result for every request.
    Honest(Value),
    /// Every request gets HTTP 503.
    Outage,
    /// Answers eth_chainId with another chain.
    WrongChain(u64),
}

struct MockState {
    behaviour: Mutex<Behaviour>,
    log: Mutex<Vec<String>>,
}

/// A JSON-RPC provider on 127.0.0.1:<random>. Records every method it is asked for.
pub struct MockProvider {
    pub url: String,
    state: Arc<MockState>,
}

impl MockProvider {
    pub async fn start(behaviour: Behaviour) -> Self {
        Self::start_with_path(behaviour, "").await
    }

    /// `suffix` is appended to the URL, e.g. "?apikey=…" to test redaction.
    pub async fn start_with_path(behaviour: Behaviour, suffix: &str) -> Self {
        let state = Arc::new(MockState {
            behaviour: Mutex::new(behaviour),
            log: Mutex::new(Vec::new()),
        });
        let router = Router::new()
            .route("/", post(mock_rpc))
            .with_state(state.clone());
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock");
        let addr = listener.local_addr().expect("mock addr");
        tokio::spawn(async move {
            axum::serve(listener, router).await.ok();
        });
        Self {
            url: format!("http://{addr}/{suffix}"),
            state,
        }
    }

    /// Change how the provider answers from now on (e.g. recover from an outage).
    pub fn set(&self, behaviour: Behaviour) {
        *self.state.behaviour.lock().expect("behaviour") = behaviour;
    }

    /// Methods received, in order.
    pub fn methods(&self) -> Vec<String> {
        self.state.log.lock().expect("log").clone()
    }

    pub fn count(&self, method: &str) -> usize {
        self.methods().iter().filter(|m| *m == method).count()
    }
}

async fn mock_rpc(
    State(state): State<Arc<MockState>>,
    Json(request): Json<Value>,
) -> Result<Json<Value>, StatusCode> {
    let method = request["method"].as_str().unwrap_or_default().to_string();
    state.log.lock().expect("log").push(method.clone());
    let id = request["id"].clone();
    let ok = |result: Value| {
        Ok(Json(
            json!({ "jsonrpc": "2.0", "id": id, "result": result }),
        ))
    };
    let behaviour = state.behaviour.lock().expect("behaviour").clone();
    match &behaviour {
        Behaviour::Outage => Err(StatusCode::SERVICE_UNAVAILABLE),
        Behaviour::WrongChain(chain) => match method.as_str() {
            "eth_chainId" => ok(json!(format!("{chain:#x}"))),
            _ => Err(StatusCode::BAD_REQUEST),
        },
        Behaviour::Honest(proof) => match method.as_str() {
            "eth_chainId" => ok(json!("0xaa36a7")),
            "eth_getBlockByNumber" => {
                ok(json!({ "number": "0x1", "hash": format!("{:#x}", B256::repeat_byte(0x11)) }))
            }
            "eth_getProof" => ok(proof.clone()),
            _ => Err(StatusCode::BAD_REQUEST),
        },
    }
}

/// Start the engine on 127.0.0.1:<random> with a fixed (test) root.
/// `probe = true` runs the real startup probe from veriq-router against the providers.
pub async fn start_engine(
    root: PinnedRoot,
    providers: &[(&str, &MockProvider)],
    probe: bool,
) -> String {
    let spec = providers
        .iter()
        .map(|(label, p)| format!("{label}={}", p.url))
        .collect::<Vec<_>>()
        .join(",");
    let configs = ProviderConfig::parse_many(&spec).expect("provider spec");
    let mut engine = Engine::new(Arc::new(FixedRoot::new(root)), configs.clone());
    if probe {
        let caps = probe_providers(&spec).await;
        let probes = configs
            .iter()
            .map(|c| {
                // Same mapping as main.rs: unreachable at probe time -> unprobed.
                let cap = caps.iter().find(|cap| cap.name() == c.label)?;
                cap.chain_id()?;
                Some(ProbeStatus {
                    chain_ok: cap.chain_ok(),
                    proof_support: cap.supports_get_proof(),
                    eip1898: cap.supports_block_hash(),
                })
            })
            .collect();
        engine = engine.with_probes(probes);
    }
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .expect("bind engine");
    let addr = listener.local_addr().expect("engine addr");
    tokio::spawn(async move {
        axum::serve(listener, app(engine)).await.ok();
    });
    format!("http://{addr}")
}

/// One JSON-RPC call to the engine; returns the whole response object.
pub async fn rpc(engine: &str, method: &str, params: Value) -> Value {
    reqwest::Client::new()
        .post(engine)
        .json(&json!({ "jsonrpc": "2.0", "id": 1, "method": method, "params": params }))
        .send()
        .await
        .expect("engine reachable")
        .json()
        .await
        .expect("engine JSON")
}

pub async fn get(engine: &str, path: &str) -> Value {
    reqwest::get(format!("{engine}{path}"))
        .await
        .expect("engine reachable")
        .json()
        .await
        .expect("engine JSON")
}

pub fn error_code(response: &Value) -> i64 {
    response["error"]["code"]
        .as_i64()
        .unwrap_or_else(|| panic!("expected an error, got {response}"))
}

// ------------------------------------------------------------------ fixtures

/// The captured Sepolia EOA fixture: (pinned root, address, eth_getProof result, proven balance).
pub fn eoa_fixture() -> (PinnedRoot, Address, Value, U256) {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../../fixtures/eoa.json");
    let fixture: Value =
        serde_json::from_str(&std::fs::read_to_string(&path).expect("read eoa.json"))
            .expect("parse");
    let block = &fixture["block"];
    let root = PinnedRoot::new(
        block["number"].as_u64().expect("number"),
        B256::from_str(block["hash"].as_str().expect("hash")).expect("hash"),
        B256::from_str(block["stateRoot"].as_str().expect("stateRoot")).expect("root"),
    );
    let address =
        Address::from_str(fixture["address"].as_str().expect("address")).expect("address");
    let proof = fixture["proof"].clone();
    let balance = U256::from_str(proof["balance"].as_str().expect("balance")).expect("balance");
    (root, address, proof, balance)
}

fn account(balance: u64) -> TrieAccount {
    TrieAccount {
        nonce: 1,
        balance: U256::from(balance),
        storage_root: EMPTY_ROOT_HASH,
        code_hash: KECCAK_EMPTY,
    }
}

fn account_proof(entries: &[(Address, TrieAccount)], target: Address) -> (B256, Vec<Bytes>) {
    let target_key = Nibbles::unpack(keccak256(target.as_slice()));
    let mut sorted = BTreeMap::new();
    for (address, account) in entries {
        sorted.insert(keccak256(address.as_slice()), alloy_rlp::encode(account));
    }
    let mut builder =
        HashBuilder::default().with_proof_retainer(ProofRetainer::new(vec![target_key]));
    for (hashed, value) in sorted {
        builder.add_leaf(Nibbles::unpack(hashed), &value);
    }
    let root = builder.root();
    let proof = builder
        .take_proof_nodes()
        .matching_nodes_sorted(&target_key)
        .into_iter()
        .map(|(_, node)| node)
        .collect();
    (root, proof)
}

fn proof_json(address: Address, account: &TrieAccount, nodes: &[Bytes]) -> Value {
    json!({
        "address": format!("{address:#x}"),
        "balance": format!("{:#x}", account.balance),
        "nonce": format!("{:#x}", account.nonce),
        "codeHash": format!("{:#x}", account.code_hash),
        "storageHash": format!("{:#x}", account.storage_root),
        "accountProof": nodes.iter().map(|n| format!("{n}")).collect::<Vec<_>>(),
        "storageProof": [],
    })
}

/// Two states of the same account: the pinned block N (2 ETH-ish) and an older block
/// N-100 (1 ETH-ish). Each proof is valid, but only against its own state root.
pub struct TwoBlocks {
    pub address: Address,
    pub current: PinnedRoot,
    pub current_proof: Value,
    pub current_balance: U256,
    pub old_proof: Value,
}

pub fn two_blocks() -> TwoBlocks {
    let address = Address::repeat_byte(0xaa);
    let other = Address::repeat_byte(0xbb);
    let (now, old) = (account(2_000), account(1_000));
    let (current_root, current_nodes) =
        account_proof(&[(address, now), (other, account(5))], address);
    let (_old_root, old_nodes) = account_proof(&[(address, old), (other, account(5))], address);
    TwoBlocks {
        address,
        current: PinnedRoot::new(1_000_100, B256::repeat_byte(0x01), current_root),
        current_proof: proof_json(address, &now, &current_nodes),
        current_balance: now.balance,
        old_proof: proof_json(address, &old, &old_nodes),
    }
}
