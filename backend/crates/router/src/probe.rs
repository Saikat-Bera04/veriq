use std::time::Duration;

use alloy_primitives::B256;
use serde_json::{json, Value};
use tokio::time::timeout;

pub const SEPOLIA_CHAIN_ID: u64 = 11_155_111;
pub const PROBE_TIMEOUT: Duration = Duration::from_secs(5);

const PROBE_ADDRESS: &str = "0x0000000000000000000000000000000000000000";

/// Startup probe results for an execution provider.
///
/// The endpoint is intentionally not included in `Debug` or any logging
/// implementation: provider URLs commonly contain API keys.
#[derive(Clone)]
pub struct ProviderCapabilities {
    name: String,
    endpoint: String,
    chain_id: Option<u64>,
    chain_ok: bool,
    supports_get_proof: bool,
    supports_block_hash: bool,
    failure_reason: Option<&'static str>,
}

impl ProviderCapabilities {
    pub fn name(&self) -> &str {
        &self.name
    }

    /// The RPC endpoint is for request dispatch only; do not log it.
    pub fn endpoint(&self) -> &str {
        &self.endpoint
    }

    pub const fn chain_id(&self) -> Option<u64> {
        self.chain_id
    }

    pub const fn chain_ok(&self) -> bool {
        self.chain_ok
    }

    pub const fn supports_get_proof(&self) -> bool {
        self.supports_get_proof
    }

    pub const fn supports_block_hash(&self) -> bool {
        self.supports_block_hash
    }

    /// A provider can be routed to only when it is on Sepolia and serves proofs.
    pub const fn eligible(&self) -> bool {
        self.chain_ok && self.supports_get_proof
    }

    pub const fn failure_reason(&self) -> Option<&'static str> {
        self.failure_reason
    }
}

/// Parse `name=url,name=url`. Invalid entries are skipped without echoing their
/// contents, because those contents can include API keys.
pub fn parse_provider_list(spec: &str) -> Vec<(String, String)> {
    let mut providers = Vec::new();
    let mut names = std::collections::HashSet::new();

    for entry in spec
        .split(',')
        .map(str::trim)
        .filter(|entry| !entry.is_empty())
    {
        let Some((name, endpoint)) = entry.split_once('=') else {
            tracing::warn!(
                reason = "missing name or URL",
                "provider config entry skipped"
            );
            continue;
        };
        let name = name.trim();
        let endpoint = endpoint.trim();
        if !valid_provider_name(name) {
            tracing::warn!(
                reason = "invalid provider name",
                "provider config entry skipped"
            );
            continue;
        }
        if endpoint.is_empty() {
            tracing::warn!(reason = "missing URL", "provider skipped");
            continue;
        }
        if !names.insert(name.to_owned()) {
            tracing::warn!(reason = "duplicate provider name", "provider skipped");
            continue;
        }
        providers.push((name.to_owned(), endpoint.to_owned()));
    }

    providers
}

pub async fn probe_providers(spec: &str) -> Vec<ProviderCapabilities> {
    probe_providers_for(spec, SEPOLIA_CHAIN_ID).await
}

/// Startup probe for an engine on `chain_id`: a provider on any other chain is "wrong chain"
/// and never routed to.
pub async fn probe_providers_for(spec: &str, chain_id: u64) -> Vec<ProviderCapabilities> {
    let client = reqwest::Client::new();
    let mut providers = Vec::new();

    for (name, endpoint) in parse_provider_list(spec) {
        let provider = probe_provider(name, endpoint, &client, PROBE_TIMEOUT, chain_id).await;
        if let Some(reason) = provider.failure_reason {
            tracing::warn!(
                reason,
                chain_ok = provider.chain_ok,
                supports_get_proof = provider.supports_get_proof,
                supports_block_hash = provider.supports_block_hash,
                "provider probe incomplete"
            );
        } else {
            tracing::info!(
                chain_ok = provider.chain_ok,
                supports_get_proof = provider.supports_get_proof,
                supports_block_hash = provider.supports_block_hash,
                eligible = provider.eligible(),
                "provider probe complete"
            );
        }
        providers.push(provider);
    }

    providers
}

/// Probe one provider again (same checks and timeouts as the startup probe).
/// Used to re-check providers the startup probe marked ineligible.
pub async fn probe_endpoint(name: &str, endpoint: &str) -> ProviderCapabilities {
    probe_endpoint_for(name, endpoint, SEPOLIA_CHAIN_ID).await
}

/// [`probe_endpoint`] for an engine on `chain_id`.
pub async fn probe_endpoint_for(name: &str, endpoint: &str, chain_id: u64) -> ProviderCapabilities {
    probe_provider(
        name.to_owned(),
        endpoint.to_owned(),
        &reqwest::Client::new(),
        PROBE_TIMEOUT,
        chain_id,
    )
    .await
}

async fn probe_provider(
    name: String,
    endpoint: String,
    client: &reqwest::Client,
    operation_timeout: Duration,
    expected_chain_id: u64,
) -> ProviderCapabilities {
    let mut capabilities = ProviderCapabilities {
        name,
        endpoint,
        chain_id: None,
        chain_ok: false,
        supports_get_proof: false,
        supports_block_hash: false,
        failure_reason: None,
    };

    if !valid_endpoint(&capabilities.endpoint) {
        capabilities.failure_reason = Some("invalid provider URL");
        return capabilities;
    }

    let chain_result = rpc_call(
        client,
        &capabilities.endpoint,
        "eth_chainId",
        json!([]),
        operation_timeout,
    )
    .await;
    let chain_id = match chain_result.and_then(parse_chain_id) {
        Ok(chain_id) => chain_id,
        Err(reason) => {
            capabilities.failure_reason = Some(reason);
            return capabilities;
        }
    };
    capabilities.chain_id = Some(chain_id);
    capabilities.chain_ok = chain_id == expected_chain_id;
    if !capabilities.chain_ok {
        capabilities.failure_reason = Some("wrong chain");
        return capabilities;
    }

    // A valid finalized header supplies the hash used in the independent
    // EIP-1898 probe below. Each RPC operation has its own five-second budget.
    let finalized_block = rpc_call(
        client,
        &capabilities.endpoint,
        "eth_getBlockByNumber",
        json!(["finalized", false]),
        operation_timeout,
    )
    .await;
    let block_hash = finalized_block
        .ok()
        .and_then(|block| block.get("hash").and_then(Value::as_str).map(str::to_owned))
        .filter(|hash| hash.parse::<B256>().is_ok());

    let finalized_proof = rpc_call(
        client,
        &capabilities.endpoint,
        "eth_getProof",
        json!([PROBE_ADDRESS, [], "finalized"]),
        operation_timeout,
    )
    .await;
    capabilities.supports_get_proof = finalized_proof.as_ref().is_ok_and(is_get_proof_result);

    if let Some(block_hash) = block_hash {
        let hash_proof = rpc_call(
            client,
            &capabilities.endpoint,
            "eth_getProof",
            json!([
                PROBE_ADDRESS,
                [],
                { "blockHash": block_hash, "requireCanonical": true }
            ]),
            operation_timeout,
        )
        .await;
        capabilities.supports_block_hash = hash_proof.as_ref().is_ok_and(is_get_proof_result);
    }

    if !capabilities.supports_get_proof {
        capabilities.failure_reason = Some("eth_getProof at finalized block unsupported");
    } else if !capabilities.supports_block_hash {
        capabilities.failure_reason = Some("EIP-1898 block-hash parameter unsupported");
    }

    capabilities
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ProbeError {
    Timeout,
    RequestFailed,
    InvalidResponse,
    RpcError,
}

impl ProbeError {
    const fn reason(self) -> &'static str {
        match self {
            Self::Timeout => "probe timed out",
            Self::RequestFailed => "probe request failed",
            Self::InvalidResponse => "invalid probe response",
            Self::RpcError => "provider rejected probe method",
        }
    }
}

async fn rpc_call(
    client: &reqwest::Client,
    endpoint: &str,
    method: &str,
    params: Value,
    operation_timeout: Duration,
) -> Result<Value, &'static str> {
    let request = async {
        let response = client
            .post(endpoint)
            .json(&json!({
                "jsonrpc": "2.0",
                "id": 1,
                "method": method,
                "params": params
            }))
            .send()
            .await
            .map_err(|_| ProbeError::RequestFailed)?;
        if !response.status().is_success() {
            return Err(ProbeError::RequestFailed);
        }
        let body = read_body_limited(response)
            .await
            .map_err(|_| ProbeError::InvalidResponse)?;
        let body: Value = serde_json::from_slice(&body).map_err(|_| ProbeError::InvalidResponse)?;
        if body.get("error").is_some() {
            return Err(ProbeError::RpcError);
        }
        body.get("result")
            .filter(|result| !result.is_null())
            .cloned()
            .ok_or(ProbeError::InvalidResponse)
    };

    match timeout(operation_timeout, request).await {
        Ok(Ok(result)) => Ok(result),
        Ok(Err(error)) => Err(error.reason()),
        Err(_) => Err(ProbeError::Timeout.reason()),
    }
}

fn parse_chain_id(value: Value) -> Result<u64, &'static str> {
    let Some(value) = value.as_str() else {
        return Err("invalid chain ID response");
    };
    let Some(hex) = value.strip_prefix("0x") else {
        return Err("invalid chain ID response");
    };
    u64::from_str_radix(hex, 16).map_err(|_| "invalid chain ID response")
}

fn is_get_proof_result(value: &Value) -> bool {
    value
        .as_object()
        .and_then(|object| object.get("accountProof"))
        .is_some_and(Value::is_array)
}

/// A provider name: 1–64 of letters, digits, `_`, `-`, `.` (it appears in logs and receipts).
pub fn valid_provider_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'_' | b'-' | b'.'))
}

/// An `http` or `https` URL with a host.
pub fn valid_endpoint(endpoint: &str) -> bool {
    reqwest::Url::parse(endpoint)
        .map(|url| matches!(url.scheme(), "http" | "https") && url.host_str().is_some())
        .unwrap_or(false)
}

/// Read an untrusted provider body, stopping as soon as it passes the 2 MiB cap.
/// reqwest yields decompressed chunks, so the cap counts unzipped bytes and a small
/// gzip/brotli body cannot expand past it.
async fn read_body_limited(mut response: reqwest::Response) -> Result<Vec<u8>, ()> {
    let max = veriq_verifier::bounds::MAX_RESPONSE_BYTES;
    if response
        .content_length()
        .is_some_and(|length| length > max as u64)
    {
        return Err(());
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.map_err(|_| ())? {
        if body.len().saturating_add(chunk.len()) > max {
            return Err(());
        }
        body.extend_from_slice(&chunk);
    }
    Ok(body)
}

#[cfg(test)]
mod tests {
    use serde_json::{json, Value};
    use tokio::{
        io::{AsyncReadExt, AsyncWriteExt},
        net::{TcpListener, TcpStream},
        task::JoinHandle,
    };

    use super::{parse_provider_list, probe_provider, ProviderCapabilities, SEPOLIA_CHAIN_ID};

    #[derive(Clone, Copy)]
    enum MockKind {
        WrongChain,
        NoGetProof,
        NoBlockHash,
        Timeout,
    }

    struct MockRpc {
        endpoint: String,
        task: JoinHandle<()>,
    }

    impl Drop for MockRpc {
        fn drop(&mut self) {
            self.task.abort();
        }
    }

    async fn mock_rpc(kind: MockKind) -> MockRpc {
        let listener = TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind mock RPC");
        let address = listener.local_addr().expect("mock address");
        let task = tokio::spawn(async move {
            loop {
                let Ok((stream, _)) = listener.accept().await else {
                    break;
                };
                tokio::spawn(handle_request(stream, kind));
            }
        });
        MockRpc {
            endpoint: format!("http://{address}"),
            task,
        }
    }

    async fn handle_request(mut stream: TcpStream, kind: MockKind) {
        let Some(body) = read_http_body(&mut stream).await else {
            return;
        };
        let Ok(request) = serde_json::from_slice::<Value>(&body) else {
            return;
        };
        let method = request.get("method").and_then(Value::as_str).unwrap_or("");
        let params = request.get("params").cloned().unwrap_or(Value::Null);
        if matches!(kind, MockKind::Timeout) && method == "eth_chainId" {
            tokio::time::sleep(std::time::Duration::from_millis(300)).await;
        }
        let response = match method {
            "eth_chainId" => json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": if matches!(kind, MockKind::WrongChain) { "0x1" } else { "0xaa36a7" }
            }),
            "eth_getBlockByNumber" => json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": {
                    "hash": format!("0x{}", "11".repeat(32)),
                    "number": "0x123",
                    "stateRoot": format!("0x{}", "22".repeat(32))
                }
            }),
            "eth_getProof" if matches!(kind, MockKind::NoGetProof) => json!({
                "jsonrpc": "2.0",
                "id": 1,
                "error": { "code": -32601, "message": "method unavailable" }
            }),
            "eth_getProof"
                if matches!(kind, MockKind::NoBlockHash)
                    && params.get(2).is_some_and(Value::is_object) =>
            {
                json!({
                    "jsonrpc": "2.0",
                    "id": 1,
                    "error": { "code": -32602, "message": "unsupported block identifier" }
                })
            }
            "eth_getProof" => json!({
                "jsonrpc": "2.0",
                "id": 1,
                "result": { "accountProof": [] }
            }),
            _ => json!({
                "jsonrpc": "2.0",
                "id": 1,
                "error": { "code": -32601, "message": "unknown method" }
            }),
        };

        let payload = serde_json::to_vec(&response).expect("serialize mock response");
        let header = format!(
            "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
            payload.len()
        );
        let _ = stream.write_all(header.as_bytes()).await;
        let _ = stream.write_all(&payload).await;
    }

    async fn read_http_body(stream: &mut TcpStream) -> Option<Vec<u8>> {
        let mut bytes = Vec::new();
        let mut chunk = [0_u8; 1024];
        let header_end = loop {
            let count = stream.read(&mut chunk).await.ok()?;
            if count == 0 {
                return None;
            }
            bytes.extend_from_slice(&chunk[..count]);
            if let Some(index) = bytes.windows(4).position(|window| window == b"\r\n\r\n") {
                break index + 4;
            }
            if bytes.len() > 16 * 1024 {
                return None;
            }
        };
        let headers = std::str::from_utf8(&bytes[..header_end]).ok()?;
        let content_length = headers.lines().find_map(|line| {
            let (name, value) = line.split_once(':')?;
            name.eq_ignore_ascii_case("content-length")
                .then(|| value.trim().parse::<usize>().ok())
                .flatten()
        })?;
        while bytes.len().saturating_sub(header_end) < content_length {
            let count = stream.read(&mut chunk).await.ok()?;
            if count == 0 {
                return None;
            }
            bytes.extend_from_slice(&chunk[..count]);
        }
        Some(bytes[header_end..header_end + content_length].to_vec())
    }

    async fn probe(mock: &MockRpc, timeout: std::time::Duration) -> ProviderCapabilities {
        let client = reqwest::Client::new();
        probe_provider(
            "mock".to_owned(),
            mock.endpoint.clone(),
            &client,
            timeout,
            SEPOLIA_CHAIN_ID,
        )
        .await
    }

    #[test]
    fn parses_name_url_pairs_without_logging_endpoints() {
        let parsed = parse_provider_list(
            "good=https://example.test/key?token=secret, bad name=https://bad.test,missing",
        );
        assert_eq!(
            parsed,
            vec![(
                "good".to_owned(),
                "https://example.test/key?token=secret".to_owned()
            )]
        );
    }

    #[tokio::test]
    async fn excludes_wrong_chain_provider() {
        let mock = mock_rpc(MockKind::WrongChain).await;
        let capabilities = probe(&mock, std::time::Duration::from_secs(1)).await;
        assert_eq!(capabilities.chain_id(), Some(1));
        assert!(!capabilities.chain_ok());
        assert!(!capabilities.eligible());
        assert_eq!(capabilities.failure_reason(), Some("wrong chain"));
    }

    #[tokio::test]
    async fn a_mainnet_engine_excludes_a_sepolia_provider_and_accepts_a_mainnet_one() {
        let client = reqwest::Client::new();
        let timeout = std::time::Duration::from_secs(1);
        // This mock answers eth_chainId 0xaa36a7 (Sepolia).
        let sepolia = mock_rpc(MockKind::NoBlockHash).await;
        let caps = probe_provider(
            "s".to_owned(),
            sepolia.endpoint.clone(),
            &client,
            timeout,
            1,
        )
        .await;
        assert_eq!(caps.chain_id(), Some(SEPOLIA_CHAIN_ID));
        assert!(!caps.eligible());
        assert_eq!(caps.failure_reason(), Some("wrong chain"));
        // This one answers 0x1: wrong for Sepolia, right for mainnet.
        let mainnet = mock_rpc(MockKind::WrongChain).await;
        let caps = probe_provider(
            "m".to_owned(),
            mainnet.endpoint.clone(),
            &client,
            timeout,
            1,
        )
        .await;
        assert!(caps.chain_ok(), "{:?}", caps.failure_reason());
    }

    #[tokio::test]
    async fn marks_provider_without_get_proof_ineligible() {
        let mock = mock_rpc(MockKind::NoGetProof).await;
        let capabilities = probe(&mock, std::time::Duration::from_secs(1)).await;
        assert!(capabilities.chain_ok());
        assert!(!capabilities.supports_get_proof());
        assert!(!capabilities.eligible());
    }

    #[tokio::test]
    async fn keeps_block_number_fallback_when_hash_parameter_is_unsupported() {
        let mock = mock_rpc(MockKind::NoBlockHash).await;
        let capabilities = probe(&mock, std::time::Duration::from_secs(1)).await;
        assert!(capabilities.chain_ok());
        assert!(capabilities.supports_get_proof());
        assert!(!capabilities.supports_block_hash());
        assert!(capabilities.eligible());
    }

    #[tokio::test]
    async fn times_out_probe_operation_and_excludes_provider() {
        let mock = mock_rpc(MockKind::Timeout).await;
        let capabilities = probe(&mock, std::time::Duration::from_millis(50)).await;
        assert!(!capabilities.eligible());
        assert_eq!(capabilities.failure_reason(), Some("probe timed out"));
    }

    #[tokio::test]
    async fn successful_provider_is_eligible() {
        let mock = mock_rpc(MockKind::NoBlockHash).await;
        let capabilities = probe(&mock, std::time::Duration::from_secs(1)).await;
        assert_eq!(capabilities.chain_id(), Some(SEPOLIA_CHAIN_ID));
        assert!(capabilities.eligible());
    }
}
