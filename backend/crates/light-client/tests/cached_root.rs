use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc,
};
use std::time::Duration;

use alloy_primitives::B256;
use async_trait::async_trait;
use veriq_core::{ErrorCode, VeriqError};
use veriq_light_client::{cached::CachedRoot, PinnedRoot, RootSource, RootSourceProvider};

/// Counts lookups and can be made to fail, like Helios losing sync.
struct CountingRoot {
    calls: AtomicUsize,
    failing: AtomicBool,
}

#[async_trait]
impl RootSourceProvider for CountingRoot {
    async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) as u64;
        if self.failing.load(Ordering::SeqCst) {
            return Err(VeriqError::root_unavailable("finalized block unavailable"));
        }
        Ok(PinnedRoot::new(
            100 + call,
            B256::repeat_byte(1),
            B256::repeat_byte(2),
        ))
    }

    fn source(&self) -> RootSource {
        RootSource::LocalLightClient
    }
}

fn counting() -> Arc<CountingRoot> {
    Arc::new(CountingRoot {
        calls: AtomicUsize::new(0),
        failing: AtomicBool::new(false),
    })
}

#[tokio::test]
async fn reads_within_the_cache_window_reuse_one_root() {
    let source = counting();
    let cached = CachedRoot::new(source.clone(), Duration::from_secs(12));
    assert!(cached.cache_status().expect("cache").entry.is_none());

    let first = cached.current_root().await.expect("root");
    for _ in 0..20 {
        assert_eq!(cached.current_root().await.expect("root"), first);
    }
    assert_eq!(
        source.calls.load(Ordering::SeqCst),
        1,
        "one lookup for 21 reads"
    );

    let status = cached.cache_status().expect("cache");
    let entry = status.entry.expect("entry");
    assert_eq!(entry.root, first);
    assert!(entry.last_update_unix > 0);
    assert_eq!(
        (status.refresh_every_seconds, status.max_age_seconds),
        (12, 36)
    );
    assert_eq!(cached.source(), RootSource::LocalLightClient);
}

#[tokio::test]
async fn refresh_replaces_the_cached_root() {
    let source = counting();
    let cached = CachedRoot::new(source.clone(), Duration::from_secs(12));
    let first = cached.current_root().await.expect("root");
    let newer = cached.refresh().await.expect("refresh");
    assert_ne!(first, newer);
    assert_eq!(cached.current_root().await.expect("root"), newer);
    assert_eq!(source.calls.load(Ordering::SeqCst), 2);
}

#[tokio::test]
async fn expired_root_is_fetched_again_and_never_served_when_the_source_fails() {
    let source = counting();
    // 10 ms refresh -> 30 ms max age.
    let cached = CachedRoot::new(source.clone(), Duration::from_millis(10));
    cached.current_root().await.expect("root");
    tokio::time::sleep(Duration::from_millis(50)).await;

    // Expired: fetched from the source again.
    cached.current_root().await.expect("root");
    assert_eq!(source.calls.load(Ordering::SeqCst), 2);

    // Expired and the source is down: the read fails instead of using the old root.
    tokio::time::sleep(Duration::from_millis(50)).await;
    source.failing.store(true, Ordering::SeqCst);
    let err = cached.current_root().await.expect_err("fail closed");
    assert_eq!(err.code(), ErrorCode::RootUnavailable);
}

/// A light client whose finalized block is `age` seconds old, with a head 64 blocks ahead.
struct AgedRoot {
    age: u64,
}

#[async_trait]
impl RootSourceProvider for AgedRoot {
    async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .expect("clock")
            .as_secs();
        Ok(PinnedRoot::with_timestamp(
            500,
            B256::repeat_byte(5),
            B256::repeat_byte(6),
            now - self.age,
        ))
    }

    fn source(&self) -> RootSource {
        RootSource::LocalLightClient
    }

    async fn head_number(&self) -> Option<u64> {
        Some(564)
    }
}

#[tokio::test]
async fn stale_root_fails_closed_and_is_never_cached() {
    let stale = CachedRoot::new(
        Arc::new(AgedRoot {
            age: veriq_light_client::MAX_FINALIZED_AGE_SECONDS + 60,
        }),
        Duration::from_secs(12),
    );
    let err = stale.current_root().await.expect_err("stale root");
    assert_eq!(err.code(), ErrorCode::RootUnavailable);
    let status = stale.cache_status().expect("cache");
    assert!(status.entry.is_none(), "a stale root is never stored");
    assert_eq!(status.consecutive_failures, 1);
    assert!(status.last_failure_unix.is_some());

    let recent = CachedRoot::new(Arc::new(AgedRoot { age: 60 }), Duration::from_secs(12));
    assert_eq!(recent.current_root().await.expect("fresh root").number, 500);
}

#[tokio::test]
async fn failed_refresh_keeps_serving_the_last_good_root_and_is_reported() {
    let source = counting();
    let cached = CachedRoot::new(source.clone(), Duration::from_secs(12));
    let good = cached.refresh().await.expect("first refresh");

    source.failing.store(true, Ordering::SeqCst);
    cached.refresh().await.expect_err("refresh fails");
    cached.refresh().await.expect_err("refresh fails again");
    // Still within the cache window: the last good root is served, not a new one.
    assert_eq!(cached.current_root().await.expect("last good root"), good);
    let status = cached.cache_status().expect("cache");
    assert_eq!(status.consecutive_failures, 2);
    assert!(status.last_failure_unix.is_some());
    assert_eq!(status.entry.expect("entry").root, good);

    // Recovery clears the failure count.
    source.failing.store(false, Ordering::SeqCst);
    cached.refresh().await.expect("recovered");
    assert_eq!(
        cached.cache_status().expect("cache").consecutive_failures,
        0
    );
}

#[tokio::test]
async fn head_number_comes_from_the_source() {
    let cached = CachedRoot::new(Arc::new(AgedRoot { age: 60 }), Duration::from_secs(12));
    assert_eq!(cached.head_number().await, Some(564));
    assert_eq!(
        CachedRoot::new(counting(), Duration::from_secs(12))
            .head_number()
            .await,
        None
    );
}
