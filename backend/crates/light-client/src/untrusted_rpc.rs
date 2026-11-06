use std::str::FromStr;
use std::time::Duration;

use alloy_primitives::B256;
use async_trait::async_trait;
use serde::Deserialize;
use serde_json::json;
use veriq_core::config::env;
use veriq_core::{ErrorCode, VeriqError};

use crate::{PinnedRoot, RootSource, RootSourceProvider};

/// Dev-only root source that reads the `finalized` block header from an RPC.
///
/// This must never be used to mark a receipt `verified`. Construction is refused
/// unless `VERIQ_DEV_ALLOW_UNTRUSTED_ROOT=1` is set.
#[derive(Debug, Clone)]
pub struct UntrustedRpcRoot {
    url: String,
    client: reqwest::Client,
}

impl UntrustedRpcRoot {
    pub fn new(url: impl Into<String>) -> Result<Self, VeriqError> {
        if !dev_flag_enabled() {
            return Err(VeriqError::unsupported_verification(
                "untrusted root source requires VERIQ_DEV_ALLOW_UNTRUSTED_ROOT=1",
            ));
        }
        let client = reqwest::Client::builder()
            .timeout(Duration::from_secs(10))
            .build()
            .map_err(|_| {
                VeriqError::new(
                    ErrorCode::RootUnavailable,
                    "could not build root RPC client",
                )
            })?;
        Ok(Self {
            url: url.into(),
            client,
        })
    }
}

fn dev_flag_enabled() -> bool {
    std::env::var(env::DEV_ALLOW_UNTRUSTED_ROOT).as_deref() == Ok("1")
}

#[async_trait]
impl RootSourceProvider for UntrustedRpcRoot {
    async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
        let body = json!({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "eth_getBlockByNumber",
            "params": ["finalized", false],
        });
        let response = self
            .client
            .post(&self.url)
            .json(&body)
            .send()
            .await
            .map_err(|_| VeriqError::root_unavailable("root RPC request failed"))?;
        if !response.status().is_success() {
            return Err(VeriqError::root_unavailable(format!(
                "root RPC returned HTTP {}",
                response.status()
            )));
        }
        let value: serde_json::Value = read_json_limited(response).await?;

        if value.get("error").is_some() {
            return Err(VeriqError::root_unavailable("root RPC returned an error"));
        }
        let result = value
            .get("result")
            .filter(|result| !result.is_null())
            .ok_or_else(|| VeriqError::root_unavailable("finalized block not available"))?;

        let block: RpcBlock = serde_json::from_value(result.clone()).map_err(|_| {
            VeriqError::root_unavailable("root RPC returned an invalid block header")
        })?;
        let timestamp = block.timestamp.unwrap_or_default();
        Ok(PinnedRoot::with_timestamp(
            block.number,
            block.hash,
            block.state_root,
            timestamp,
        ))
    }

    fn source(&self) -> RootSource {
        RootSource::UntrustedRpc
    }
}

const MAX_ROOT_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

async fn read_json_limited(
    mut response: reqwest::Response,
) -> Result<serde_json::Value, VeriqError> {
    if let Some(length) = response.content_length() {
        let length = usize::try_from(length)
            .map_err(|_| VeriqError::root_unavailable("root RPC response too large"))?;
        if length > MAX_ROOT_RESPONSE_BYTES {
            return Err(VeriqError::root_unavailable("root RPC response too large"));
        }
    }
    let mut body = Vec::new();
    while let Some(chunk) = response
        .chunk()
        .await
        .map_err(|_| VeriqError::root_unavailable("root RPC response body failed"))?
    {
        if body.len().saturating_add(chunk.len()) > MAX_ROOT_RESPONSE_BYTES {
            return Err(VeriqError::root_unavailable("root RPC response too large"));
        }
        body.extend_from_slice(&chunk);
    }
    serde_json::from_slice(&body)
        .map_err(|_| VeriqError::root_unavailable("root RPC returned invalid JSON"))
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct RpcBlock {
    #[serde(deserialize_with = "deserialize_u64")]
    number: u64,
    #[serde(deserialize_with = "deserialize_b256")]
    hash: B256,
    #[serde(deserialize_with = "deserialize_b256")]
    state_root: B256,
    #[serde(default, deserialize_with = "deserialize_u64_opt")]
    timestamp: Option<u64>,
}

fn deserialize_u64<'de, D>(deserializer: D) -> Result<u64, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    let value = value.strip_prefix("0x").unwrap_or(&value);
    u64::from_str_radix(value, 16).map_err(serde::de::Error::custom)
}

fn deserialize_u64_opt<'de, D>(deserializer: D) -> Result<Option<u64>, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let Some(value) = Option::<String>::deserialize(deserializer)? else {
        return Ok(None);
    };
    let value = value.strip_prefix("0x").unwrap_or(&value);
    if value.is_empty() {
        return Ok(Some(0));
    }
    u64::from_str_radix(value, 16)
        .map(Some)
        .map_err(serde::de::Error::custom)
}

fn deserialize_b256<'de, D>(deserializer: D) -> Result<B256, D::Error>
where
    D: serde::Deserializer<'de>,
{
    let value = String::deserialize(deserializer)?;
    B256::from_str(&value).map_err(serde::de::Error::custom)
}
