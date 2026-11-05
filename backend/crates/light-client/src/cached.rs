//! A root source served from a `RootCache` that a background task keeps fresh.

use std::{
    sync::{
        atomic::{AtomicU32, AtomicU64, Ordering},
        Arc,
    },
    time::{Duration, SystemTime, UNIX_EPOCH},
};

use async_trait::async_trait;
use veriq_core::{Bootstrap, VeriqError};

use crate::{
    PinnedRoot, RootCache, RootCacheStatus, RootSource, RootSourceProvider,
    MAX_FINALIZED_AGE_SECONDS,
};

/// Wraps a root source (Helios, fixture, dev RPC) with a shared `RootCache`.
///
/// Reads use the cached root while it is at most `max_age` old, so reads within the
/// same finalized root reuse it. An older or missing entry is fetched from the source
/// directly; if that fails the read fails. A stale cached root is never served, and a
/// root whose block is older than `MAX_FINALIZED_AGE_SECONDS` is never cached or served.
/// Failed refreshes are counted so `/health` can report a degraded light client while
/// the last good root is still within `max_age`.
pub struct CachedRoot {
    inner: Arc<dyn RootSourceProvider>,
    cache: RootCache,
    refresh_every: Duration,
    max_age: Duration,
    consecutive_failures: AtomicU32,
    /// Unix seconds of the latest failed refresh; 0 = never.
    last_failure_unix: AtomicU64,
}

impl CachedRoot {
    /// `max_age` is three refresh intervals, so one or two missed refreshes do not
    /// send every read to the source.
    pub fn new(inner: Arc<dyn RootSourceProvider>, refresh_every: Duration) -> Self {
        Self {
            inner,
            cache: RootCache::new(),
            refresh_every,
            max_age: refresh_every.saturating_mul(3),
            consecutive_failures: AtomicU32::new(0),
            last_failure_unix: AtomicU64::new(0),
        }
    }

    pub const fn refresh_every(&self) -> Duration {
        self.refresh_every
    }

    /// Fetch the root from the source and store it. The background task calls this
    /// every `refresh_every`; reads call it when the cached root is too old.
    pub async fn refresh(&self) -> Result<PinnedRoot, VeriqError> {
        let fetched = self.inner.current_root().await.and_then(|root| {
            if is_stale(&root) {
                Err(VeriqError::root_unavailable("finalized root is stale"))
            } else {
                Ok(root)
            }
        });
        match fetched {
            Ok(root) => {
                self.cache.update(root).await;
                self.consecutive_failures.store(0, Ordering::Relaxed);
                Ok(root)
            }
            Err(err) => {
                self.consecutive_failures.fetch_add(1, Ordering::Relaxed);
                self.last_failure_unix.store(now_unix(), Ordering::Relaxed);
                Err(err)
            }
        }
    }

    fn fresh(&self) -> Option<PinnedRoot> {
        self.cache
            .entry()
            .filter(|(entry, age)| *age <= self.max_age && !is_stale(&entry.root))
            .map(|(entry, _)| entry.root)
    }
}

/// The root's block is older than `MAX_FINALIZED_AGE_SECONDS`. Roots without a
/// timestamp (fixtures) are never stale.
fn is_stale(root: &PinnedRoot) -> bool {
    root.timestamp
        .is_some_and(|ts| now_unix().saturating_sub(ts) > MAX_FINALIZED_AGE_SECONDS)
}

fn now_unix() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs()
}

#[async_trait]
impl RootSourceProvider for CachedRoot {
    async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
        match self.fresh() {
            Some(root) => Ok(root),
            None => self.refresh().await,
        }
    }

    fn source(&self) -> RootSource {
        self.inner.source()
    }

    fn bootstrap(&self) -> Bootstrap {
        self.inner.bootstrap()
    }

    fn cache_status(&self) -> Option<RootCacheStatus> {
        let last_failure = self.last_failure_unix.load(Ordering::Relaxed);
        Some(RootCacheStatus {
            entry: self.cache.entry().map(|(entry, _)| entry),
            refresh_every_seconds: self.refresh_every.as_secs(),
            max_age_seconds: self.max_age.as_secs(),
            consecutive_failures: self.consecutive_failures.load(Ordering::Relaxed),
            last_failure_unix: (last_failure > 0).then_some(last_failure),
        })
    }

    async fn head_number(&self) -> Option<u64> {
        self.inner.head_number().await
    }
}
