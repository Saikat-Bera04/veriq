pub mod cached;
pub mod fixed;
pub mod untrusted_rpc;

#[cfg(feature = "helios")]
pub mod helios_adapter;

use std::time::{Instant, SystemTime, UNIX_EPOCH};

use alloy_primitives::B256;
use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;
use veriq_core::{Bootstrap, VeriqError};

/// A finalized execution-layer block selected by a trusted root source.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PinnedRoot {
    pub number: u64,
    pub hash: B256,
    pub state_root: B256,
    #[serde(default)]
    pub timestamp: Option<u64>,
}

impl PinnedRoot {
    pub const fn new(number: u64, hash: B256, state_root: B256) -> Self {
        Self {
            number,
            hash,
            state_root,
            timestamp: None,
        }
    }

    pub const fn with_timestamp(number: u64, hash: B256, state_root: B256, timestamp: u64) -> Self {
        Self {
            number,
            hash,
            state_root,
            timestamp: Some(timestamp),
        }
    }
}

/// Where the trusted root came from.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RootSource {
    LocalLightClient,
    Fixture,
    UntrustedRpc,
    Unavailable,
}

impl RootSource {
    pub const fn is_verified(self) -> bool {
        matches!(self, Self::LocalLightClient | Self::Fixture)
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::LocalLightClient => "local-light-client",
            Self::Fixture => "fixture",
            Self::UntrustedRpc => "untrusted-rpc",
            Self::Unavailable => "none",
        }
    }
}

/// A source of the finalized state root. Implementations must never fall back to an
/// untrusted root.
#[async_trait]
pub trait RootSourceProvider: Send + Sync {
    async fn current_root(&self) -> Result<PinnedRoot, VeriqError>;
    fn source(&self) -> RootSource;

    /// Bootstrap metadata recorded in the receipt. Sources that trust an external
    /// checkpoint override this with the checkpoint and its provenance.
    fn bootstrap(&self) -> Bootstrap {
        Bootstrap {
            source: Some(self.source().as_str().to_string()),
            ..Bootstrap::default()
        }
    }

    /// The root cache in front of this source, if any (see `cached::CachedRoot`).
    fn cache_status(&self) -> Option<RootCacheStatus> {
        None
    }

    /// The latest (not yet finalized) head block number, when the source tracks one.
    /// Only for display (head lag): reads are always pinned to the finalized root.
    async fn head_number(&self) -> Option<u64> {
        None
    }
}

/// A finalized root whose block is older than this is stale: it is never served.
pub const MAX_FINALIZED_AGE_SECONDS: u64 = 30 * 60;

/// What a `RootCache` holds right now, for `/health`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootCacheStatus {
    /// The cached root and how long ago it was stored; `None` before the first update.
    pub entry: Option<RootCacheEntry>,
    /// How often the background task refreshes the cache.
    pub refresh_every_seconds: u64,
    /// Reads use the cached root only while it is at most this old.
    pub max_age_seconds: u64,
    /// Refreshes that failed since the last successful one (0 = the last refresh worked).
    pub consecutive_failures: u32,
    /// When the most recent failed refresh happened.
    pub last_failure_unix: Option<u64>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct RootCacheEntry {
    pub root: PinnedRoot,
    pub age_seconds: u64,
    pub last_update_unix: u64,
}

/// Shared, asynchronously refreshed root cache.
///
/// Backed by a single `watch` channel so readers never take two locks and can
/// observe a new finalized root immediately via `subscribe`.
#[derive(Debug, Clone)]
pub struct RootCache {
    tx: watch::Sender<Option<(PinnedRoot, Instant, u64)>>,
}

impl Default for RootCache {
    fn default() -> Self {
        Self::new()
    }
}

impl RootCache {
    pub fn new() -> Self {
        let (tx, _rx) = watch::channel(None);
        Self { tx }
    }

    pub async fn update(&self, root: PinnedRoot) {
        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        self.tx.send_replace(Some((root, Instant::now(), now)));
    }

    pub async fn get(&self) -> Option<PinnedRoot> {
        self.tx.borrow().as_ref().map(|(root, _, _)| *root)
    }

    /// The current entry with its age, without awaiting.
    pub fn entry(&self) -> Option<(RootCacheEntry, std::time::Duration)> {
        self.tx.borrow().as_ref().map(|(root, at, unix)| {
            let age = at.elapsed();
            (
                RootCacheEntry {
                    root: *root,
                    age_seconds: age.as_secs(),
                    last_update_unix: *unix,
                },
                age,
            )
        })
    }

    pub async fn age_seconds(&self) -> Option<u64> {
        self.tx
            .borrow()
            .as_ref()
            .map(|(_, at, _)| at.elapsed().as_secs())
    }

    /// Observe future root updates. The current value is available immediately.
    pub fn subscribe(&self) -> watch::Receiver<Option<(PinnedRoot, Instant, u64)>> {
        self.tx.subscribe()
    }

    pub async fn status(&self) -> LightClientStatus {
        let state = *self.tx.borrow();
        let root = state.map(|(root, _, _)| root);
        LightClientStatus {
            synced: root.is_some(),
            finalized_number: root.map(|root| root.number),
            finalized_hash: root.map(|root| root.hash),
            lag_seconds: state.map(|(_, at, _)| at.elapsed().as_secs()),
            last_update_unix: state.map(|(_, _, ts)| ts),
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct LightClientStatus {
    pub synced: bool,
    pub finalized_number: Option<u64>,
    pub finalized_hash: Option<B256>,
    pub lag_seconds: Option<u64>,
    pub last_update_unix: Option<u64>,
}
