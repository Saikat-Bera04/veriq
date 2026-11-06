use std::{
    collections::HashSet,
    sync::{Arc, Mutex},
    time::Duration,
};

use alloy_primitives::{hex, Address, Bytes, U256};
use serde_json::{json, Value};
use veriq_core::{ErrorCode, VeriqError};
use veriq_light_client::PinnedRoot;
use veriq_verifier::bounds;

#[derive(Debug, Clone)]
pub struct ProviderConfig {
    pub label: String,
    pub url: String,
    pub eip1898: bool,
}

impl ProviderConfig {
    /// Parse `label=url,label=url` (the provider label is never a secret). Fails fast on
    /// anything the startup probe would skip: a missing `=`, an invalid label (the probe's
    /// rule: 1–64 of letters, digits, `_`, `-`, `.`), a URL that is not http(s) with a host,
    /// or a duplicate label (circuit breakers and stats are keyed by label, so two providers
    /// with one label would share a cooldown). Errors name the label, never the URL.
    pub fn parse_many(input: &str) -> Result<Vec<Self>, VeriqError> {
        let mut providers: Vec<Self> = Vec::new();
        for entry in input.split(',') {
            let entry = entry.trim();
            if entry.is_empty() {
                continue;
            }
            let (label, url) = entry
                .split_once('=')
                .ok_or_else(|| VeriqError::invalid_request("provider must be label=url"))?;
            let label = label.trim();
            let url = url.trim();
            if label.is_empty() || url.is_empty() {
                return Err(VeriqError::invalid_request("provider must be label=url"));
            }
            if !veriq_router::probe::valid_provider_name(label) {
                return Err(VeriqError::invalid_request(
                    "provider label must be 1-64 letters, digits, '_', '-' or '.'",
                ));
            }
            if !veriq_router::probe::valid_endpoint(url) {
                return Err(VeriqError::invalid_request(format!(
                    "provider {label}: URL must be http(s) with a host"
                )));
            }
            if providers.iter().any(|existing| existing.label == label) {
                return Err(VeriqError::invalid_request(format!(
                    "provider label {label} is used twice; labels must be unique"
                )));
            }
            providers.push(Self {
                label: label.to_string(),
                url: url.to_string(),
                eip1898: true,
            });
        }
        if providers.is_empty() {
            return Err(VeriqError::invalid_request("no providers configured"));
        }
        Ok(providers)
    }
}

// The eth_getProof parser and bundle types live in veriq-verifier, shared with the browser
// verifier (veriq-verifier-wasm).
pub use veriq_verifier::read::{parse_proof_result, ProofBundle, StorageProof};

#[async_trait::async_trait]
pub trait ProofFetcher: Send + Sync {
    async fn get_proof(
        &self,
        provider: &ProviderConfig,
        address: Address,
        slots: &[U256],
        root: &PinnedRoot,
    ) -> Result<ProofBundle, VeriqError>;

    async fn get_code(
        &self,
        _provider: &ProviderConfig,
        _address: Address,
        _root: &PinnedRoot,
    ) -> Result<Bytes, VeriqError> {
        Err(VeriqError::unsupported_verification(
            "code fetch is not implemented by this fetcher",
        ))
    }
}

#[derive(Debug, Clone)]
pub struct ProofClient {
    client: reqwest::Client,
    /// Providers whose blockHash (EIP-1898) request failed while the block-number form
    /// of the SAME pinned block worked. They get the number form directly afterwards,
    /// saving one round-trip per request. The proof is verified either way.
    block_hash_rejected: Arc<Mutex<HashSet<String>>>,
}

impl Default for ProofClient {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl ProofFetcher for ProofClient {
    async fn get_proof(
        &self,
        provider: &ProviderConfig,
        address: Address,
        slots: &[U256],
        root: &PinnedRoot,
    ) -> Result<ProofBundle, VeriqError> {
        self.fetch_proof(provider, address, slots, root).await
    }

    async fn get_code(
        &self,
        provider: &ProviderConfig,
        address: Address,
        root: &PinnedRoot,
    ) -> Result<Bytes, VeriqError> {
        self.fetch_code(provider, address, root).await
    }
}

impl ProofClient {
    pub fn new() -> Self {
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .unwrap_or_else(|_| reqwest::Client::new());
        Self {
            client,
            block_hash_rejected: Arc::default(),
        }
    }

    fn use_block_hash(&self, provider: &ProviderConfig) -> bool {
        provider.eip1898 && !self.lock_rejected().contains(&provider.label)
    }

    fn lock_rejected(&self) -> std::sync::MutexGuard<'_, HashSet<String>> {
        self.block_hash_rejected
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Send `make_body(block_param)` with each block form in order. A provider is
    /// remembered as not supporting blockHash only when it rejected that form as
    /// invalid params (-32602) and the number form then worked; a timeout or other
    /// transient failure on the blockHash attempt does not downgrade it.
    async fn rpc_pinned(
        &self,
        provider: &ProviderConfig,
        root: &PinnedRoot,
        make_body: impl Fn(Value) -> Value,
    ) -> Result<Value, VeriqError> {
        let use_hash = self.use_block_hash(provider);
        let mut hash_form_rejected = false;
        let mut last_error = None;
        for (index, block_param) in block_params(use_hash, root).into_iter().enumerate() {
            match self.rpc(&provider.url, &make_body(block_param)).await {
                Ok(result) => {
                    if hash_form_rejected {
                        self.lock_rejected().insert(provider.label.clone());
                    }
                    return Ok(result);
                }
                Err(err) => {
                    if use_hash && index == 0 {
                        hash_form_rejected = err.code() == ErrorCode::InvalidRequest;
                    }
                    last_error = Some(err);
                }
            }
        }
        Err(last_error
            .unwrap_or_else(|| VeriqError::provider_timeout("provider returned no result")))
    }

    /// Fetch `eth_getProof` pinned to the final root. The same block is used for every
    /// attempt; a blockHash form is tried first when the provider supports EIP-1898.
    pub async fn fetch_proof(
        &self,
        provider: &ProviderConfig,
        address: Address,
        slots: &[U256],
        root: &PinnedRoot,
    ) -> Result<ProofBundle, VeriqError> {
        let slot_params: Vec<String> = slots.iter().map(|slot| format!("{slot:#066x}")).collect();
        let result = self
            .rpc_pinned(provider, root, |block_param| {
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_getProof",
                    "params": [format!("{address:#x}"), slot_params, block_param],
                })
            })
            .await?;
        parse_proof_result(&result)
    }

    /// Fetch `eth_getCode` pinned to the same finalized block as the account proof.
    pub async fn fetch_code(
        &self,
        provider: &ProviderConfig,
        address: Address,
        root: &PinnedRoot,
    ) -> Result<Bytes, VeriqError> {
        let result = self
            .rpc_pinned(provider, root, |block_param| {
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "method": "eth_getCode",
                    "params": [format!("{address:#x}"), block_param],
                })
            })
            .await?;
        let encoded = result
            .as_str()
            .ok_or_else(|| VeriqError::invalid_proof("provider returned non-string code"))?;
        let encoded = encoded.strip_prefix("0x").unwrap_or(encoded);
        let decoded = hex::decode(encoded)
            .map_err(|err| VeriqError::invalid_proof(format!("invalid code hex: {err}")))?;
        Ok(Bytes::from(decoded))
    }

    async fn rpc(&self, url: &str, body: &Value) -> Result<Value, VeriqError> {
        let response = self
            .client
            .post(url)
            .json(body)
            .send()
            .await
            .map_err(|_| VeriqError::provider_timeout("provider request failed"))?;

        if !response.status().is_success() {
            return Err(VeriqError::provider_timeout(format!(
                "provider returned HTTP {}",
                response.status()
            )));
        }

        let body = read_body_limited(response).await?;
        let value: Value = serde_json::from_slice(&body)
            .map_err(|_| VeriqError::invalid_proof("provider returned invalid JSON"))?;

        if let Some(error) = value.get("error") {
            let code = error.get("code").and_then(serde_json::Value::as_i64);
            let message = error.to_string();
            // An error reply is the provider declining to answer (internal error, rate
            // limit, parse error, ...), not a forged proof. It is a transport failure:
            // INVALID_PROOF, and its long breaker cooldown, is only for data that fails checks.
            return Err(match code {
                Some(-32602) => {
                    VeriqError::invalid_request(format!("provider RPC error: {message}"))
                }
                _ => VeriqError::provider_timeout(format!("provider RPC error: {message}")),
            });
        }
        value
            .get("result")
            .cloned()
            .ok_or_else(|| VeriqError::invalid_proof("provider response has no result"))
    }
}

fn block_params(eip1898: bool, root: &PinnedRoot) -> Vec<Value> {
    let number = json!(format!("0x{:x}", root.number));
    if eip1898 {
        vec![
            json!({"blockHash": format!("{:#x}", root.hash), "requireCanonical": true}),
            number,
        ]
    } else {
        vec![number]
    }
}

async fn read_body_limited(mut response: reqwest::Response) -> Result<Vec<u8>, VeriqError> {
    if let Some(length) = response.content_length() {
        let length = usize::try_from(length)
            .map_err(|_| VeriqError::invalid_proof("provider response too large"))?;
        bounds::check_response_size(length)?;
    }

    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| VeriqError::provider_timeout("provider response body failed"))?
    {
        let new_len = body.len().saturating_add(chunk.len());
        bounds::check_response_size(new_len)?;
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

/// Parses an `eth_getProof` result. Shared by provider fetches and client-supplied proofs
/// (`veriq_verifyProof`); nothing here is trusted until the verifier checks it.
#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::B256;
    use veriq_verifier::read::{parse_u256, parse_u64};

    #[test]
    fn parses_provider_list() {
        let providers =
            ProviderConfig::parse_many("a=https://one.example,b=https://two.example").unwrap();
        assert_eq!(providers.len(), 2);
        assert_eq!(providers[0].label, "a");
        assert_eq!(providers[1].url, "https://two.example");
    }

    #[test]
    fn rejects_bad_provider_list() {
        assert!(ProviderConfig::parse_many("https://one.example").is_err());
        assert!(ProviderConfig::parse_many("").is_err());
    }

    #[test]
    fn rejects_duplicate_and_invalid_provider_config_without_leaking_urls() {
        for (spec, expect) in [
            (
                "a=https://one.example,a=https://two.example/key",
                "used twice",
            ),
            ("bad label=https://one.example", "provider label must be"),
            ("a=ftp://one.example/secret", "http(s)"),
            ("a=not a url", "http(s)"),
            ("a=https://", "http(s)"),
        ] {
            let err = ProviderConfig::parse_many(spec).expect_err(spec);
            assert_eq!(err.code_str(), "INVALID_REQUEST", "{spec}");
            assert!(err.message().contains(expect), "{spec}: {}", err.message());
            assert!(
                !err.message().contains("example"),
                "URL leaked: {}",
                err.message()
            );
        }
        // Labels may use letters, digits, '_', '-' and '.'.
        let ok = ProviderConfig::parse_many(
            "alchemy_1=https://a.example,node-2.b=http://127.0.0.1:8545",
        )
        .expect("valid");
        assert_eq!(ok.len(), 2);
    }

    #[test]
    fn parses_quantities() {
        assert_eq!(parse_u256(Some(&json!("0x0"))).unwrap(), U256::ZERO);
        assert_eq!(parse_u256(Some(&json!("0x2a"))).unwrap(), U256::from(42));
        assert_eq!(parse_u64(Some(&json!("0x10"))).unwrap(), 16);
    }

    #[test]
    fn malformed_proof_json_is_a_typed_error() {
        for result in [
            json!({}),
            json!({"accountProof": "not-an-array"}),
            json!({"accountProof": [1]}),
            json!({"accountProof": ["zz"], "nonce": "0x0"}),
            json!({
                "accountProof": [],
                "nonce": "0x0",
                "balance": "0x1",
                "storageHash": "0x00",
                "codeHash": null
            }),
            json!({
                "accountProof": [],
                "nonce": "0x0",
                "balance": "0x1",
                "storageHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
                "codeHash": "0x0000000000000000000000000000000000000000000000000000000000000000",
                "storageProof": [{"key": "0x0", "value": "0x1", "proof": [false]}]
            }),
        ] {
            let err = parse_proof_result(&result).expect_err("malformed proof result");
            assert_eq!(err.code(), veriq_core::ErrorCode::InvalidProof);
        }
    }

    fn gzip(data: &[u8]) -> Vec<u8> {
        use std::io::Write;
        let mut encoder = flate2::write::GzEncoder::new(Vec::new(), flate2::Compression::best());
        encoder.write_all(data).expect("gzip write");
        encoder.finish().expect("gzip finish")
    }

    /// Serve one fixed gzip-encoded JSON body on 127.0.0.1 and return its URL.
    async fn gzip_server(json_body: Vec<u8>) -> String {
        use axum::{http::header, routing::post, Router};
        let compressed = gzip(&json_body);
        let app = Router::new().route(
            "/",
            post(move || {
                let compressed = compressed.clone();
                async move {
                    (
                        [
                            (header::CONTENT_ENCODING, "gzip"),
                            (header::CONTENT_TYPE, "application/json"),
                        ],
                        compressed,
                    )
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}/")
    }

    fn pinned_root() -> PinnedRoot {
        PinnedRoot::new(1, B256::repeat_byte(1), B256::repeat_byte(2))
    }

    #[tokio::test]
    async fn provider_rejecting_block_hash_costs_one_round_trip_after_the_first() {
        use axum::{routing::post, Json, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};

        let calls = Arc::new(AtomicUsize::new(0));
        let counter = calls.clone();
        let app = Router::new().route(
            "/",
            post(move |Json(body): Json<Value>| {
                let counter = counter.clone();
                async move {
                    counter.fetch_add(1, Ordering::SeqCst);
                    let block = &body["params"][1];
                    if block.is_object() {
                        Json(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32602,"message":"no blockHash"}}))
                    } else {
                        assert_eq!(block, "0x1", "same pinned block number");
                        Json(json!({"jsonrpc":"2.0","id":1,"result":"0x6001"}))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let provider = ProviderConfig {
            label: "no-hash".into(),
            url: format!("http://{addr}/"),
            eip1898: true,
        };
        let client = ProofClient::new();
        for _ in 0..3 {
            let code = client
                .fetch_code(&provider, Address::ZERO, &pinned_root())
                .await
                .expect("number form works");
            assert_eq!(code, Bytes::from(vec![0x60, 0x01]));
        }
        // First request: blockHash (rejected) + number. Later requests: number only.
        assert_eq!(calls.load(Ordering::SeqCst), 4);
    }

    #[tokio::test]
    async fn transient_block_hash_failure_does_not_downgrade_provider() {
        use axum::{routing::post, Json, Router};
        use std::sync::atomic::{AtomicUsize, Ordering};

        // The blockHash form fails once with a transient upstream error, then works.
        let hash_calls = Arc::new(AtomicUsize::new(0));
        let counter = hash_calls.clone();
        let app = Router::new().route(
            "/",
            post(move |Json(body): Json<Value>| {
                let counter = counter.clone();
                async move {
                    if body["params"][1].is_object()
                        && counter.fetch_add(1, Ordering::SeqCst) == 0
                    {
                        Json(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32603,"message":"busy"}}))
                    } else {
                        Json(json!({"jsonrpc":"2.0","id":1,"result":"0x6001"}))
                    }
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        let provider = ProviderConfig {
            label: "flaky-hash".into(),
            url: format!("http://{addr}/"),
            eip1898: true,
        };
        let client = ProofClient::new();
        for _ in 0..3 {
            client
                .fetch_code(&provider, Address::ZERO, &pinned_root())
                .await
                .expect("falls back, then hash form works");
        }
        // blockHash was tried on every request, not dropped after the first blip.
        assert_eq!(hash_calls.load(Ordering::SeqCst), 3);
        assert!(client.use_block_hash(&provider));
    }

    #[tokio::test]
    async fn upstream_rpc_errors_are_transport_failures_not_invalid_proofs() {
        for code in [-32603, -32700, -32000, -32005, -39999] {
            let body = format!(
                r#"{{"jsonrpc":"2.0","id":1,"error":{{"code":{code},"message":"upstream hiccup"}}}}"#
            );
            let provider = ProviderConfig {
                label: "flaky".into(),
                url: gzip_server(body.into_bytes()).await,
                eip1898: false,
            };
            let err = ProofClient::new()
                .fetch_code(&provider, Address::ZERO, &pinned_root())
                .await
                .expect_err("error reply");
            assert_eq!(err.code_str(), "PROVIDER_TIMEOUT", "code {code}");
        }
    }

    #[tokio::test]
    async fn gzip_provider_response_is_decoded() {
        let url = gzip_server(br#"{"jsonrpc":"2.0","id":1,"result":"0x6001"}"#.to_vec()).await;
        let provider = ProviderConfig {
            label: "gz".into(),
            url,
            eip1898: false,
        };
        let code = ProofClient::new()
            .fetch_code(&provider, Address::ZERO, &pinned_root())
            .await
            .expect("gzip body decodes");
        assert_eq!(code, Bytes::from(vec![0x60, 0x01]));
    }

    #[tokio::test]
    async fn gzip_bomb_is_rejected_by_decompressed_size() {
        // ~3 MiB of JSON that gzips to a few KiB: the 2 MiB cap must count unzipped bytes.
        let mut json_body = br#"{"jsonrpc":"2.0","id":1,"result":"0x"#.to_vec();
        json_body.extend(std::iter::repeat_n(b'0', 3 * 1024 * 1024));
        json_body.extend_from_slice(br#""}"#);
        assert!(gzip(&json_body).len() < bounds::MAX_RESPONSE_BYTES);

        let url = gzip_server(json_body).await;
        let provider = ProviderConfig {
            label: "bomb".into(),
            url,
            eip1898: false,
        };
        let err = ProofClient::new()
            .fetch_code(&provider, Address::ZERO, &pinned_root())
            .await
            .expect_err("decompressed body over 2 MiB");
        assert_eq!(err.code(), veriq_core::ErrorCode::InvalidProof);
    }
}
