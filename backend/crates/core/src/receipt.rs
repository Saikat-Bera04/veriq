use alloy_primitives::{keccak256, B256};
use serde::{Deserialize, Serialize};
use serde_json::Value;

/// The complete Trust Receipt attached to every engine response.
///
/// This shape is locked. Any change must be made in both
/// `backend/crates/core/src/receipt.rs` and `frontend/sdk/src/schema.ts`.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Receipt {
    pub identity: Identity,
    pub block: Block,
    pub verification: Verification,
    pub privacy: Privacy,
    pub routing: Routing,
    pub freshness: Freshness,
    #[serde(default)]
    pub warnings: Vec<Warning>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Identity {
    pub request_id: String,
    pub method: String,
    pub request_binding: String,
    pub result_binding: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Block {
    pub number: u64,
    pub hash: B256,
    pub state_root: B256,
    pub finalized: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Verification {
    pub status: VerificationStatus,
    pub root_source: RootSourceKind,
    pub verifier_location: VerifierLocation,
    pub mechanisms: Vec<Mechanism>,
    pub bootstrap: Bootstrap,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerificationStatus {
    Verified,
    Unverified,
    Unsupported,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RootSourceKind {
    LocalLightClient,
    Fixture,
    UntrustedRpc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerifierLocation {
    LocalEngine,
    RemoteEngine,
    Browser,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Mechanism {
    AccountProof,
    StorageProof,
    CodeHash,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Bootstrap {
    pub source: Option<String>,
    pub checkpoint: Option<String>,
    pub checkpoint_source: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Privacy {
    pub transport: Transport,
    pub mechanism: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Transport {
    Direct,
    Ohttp,
    AnyoneSocks,
    /// The client fetched the proof itself through an Anon-RPC network (e.g. Nox) and
    /// handed it to the engine; the engine contacted no provider for this read.
    AnonRpc,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Routing {
    pub comparison: Comparison,
    pub providers_tried: u32,
    pub provider_label: Option<String>,
    #[serde(default)]
    pub attempts: Vec<RoutingAttempt>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RoutingAttempt {
    pub provider: String,
    pub outcome: AttemptOutcome,
    pub elapsed_ms: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub failure_reason: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum AttemptOutcome {
    Success,
    TransportFailure,
    ProviderError,
    InvalidProof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Comparison {
    NotRun,
    Agree,
    Divergent,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Freshness {
    pub observed_at: u64,
    pub age_seconds: u64,
    pub pinned: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Warning {
    pub code: String,
    pub message: String,
}

/// keccak256(method || canonical-json) as lowercase hex, without `0x`.
pub fn binding(method: &str, value: &Value) -> String {
    let canonical = canonical_json(value);
    let input = format!("{method}{canonical}");
    let hash: B256 = keccak256(input.as_bytes());
    hex_lower(hash.as_slice())
}

fn canonical_json(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut entries: Vec<_> = map.iter().collect();
            entries.sort_by_key(|(key, _)| *key);
            let inner = entries
                .into_iter()
                .map(|(key, value)| {
                    format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap_or_default(),
                        canonical_json(value)
                    )
                })
                .collect::<Vec<_>>()
                .join(",");
            format!("{{{inner}}}")
        }
        Value::Array(items) => {
            let inner = items
                .iter()
                .map(canonical_json)
                .collect::<Vec<_>>()
                .join(",");
            format!("[{inner}]")
        }
        other => serde_json::to_string(other).unwrap_or_default(),
    }
}

fn hex_lower(bytes: &[u8]) -> String {
    const HEX: &[u8; 16] = b"0123456789abcdef";
    let mut out = String::with_capacity(bytes.len() * 2);
    for &byte in bytes {
        out.push(HEX[(byte >> 4) as usize] as char);
        out.push(HEX[(byte & 0x0f) as usize] as char);
    }
    out
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::{AttemptOutcome, Comparison, Routing, RoutingAttempt};

    #[test]
    fn routing_attempts_remain_backward_compatible_and_use_sdk_casing() {
        let legacy: Routing = serde_json::from_value(json!({
            "comparison": "not-run",
            "providersTried": 1,
            "providerLabel": "alpha"
        }))
        .expect("legacy routing receipt deserializes");
        assert!(legacy.attempts.is_empty());

        let routing = Routing {
            comparison: Comparison::Agree,
            providers_tried: 1,
            provider_label: Some("alpha".to_owned()),
            attempts: vec![RoutingAttempt {
                provider: "alpha".to_owned(),
                outcome: AttemptOutcome::Success,
                elapsed_ms: 12,
                failure_reason: None,
            }],
        };
        let encoded = serde_json::to_value(routing).expect("routing serializes");
        assert_eq!(encoded["comparison"], "agree");
        assert_eq!(encoded["attempts"][0]["elapsedMs"], 12);
        assert_eq!(encoded["attempts"][0]["provider"], "alpha");
        assert_eq!(encoded["attempts"][0]["outcome"], "success");
    }
}
