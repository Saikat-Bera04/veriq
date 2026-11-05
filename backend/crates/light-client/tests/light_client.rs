use std::sync::Mutex;

use alloy_primitives::{B256, U256};
use veriq_core::config::env;
use veriq_core::ErrorCode;
use veriq_light_client::{
    fixed::FixedRoot, untrusted_rpc::UntrustedRpcRoot, PinnedRoot, RootCache, RootSource,
    RootSourceProvider,
};

static ENV_LOCK: Mutex<()> = Mutex::new(());

fn pinned() -> PinnedRoot {
    PinnedRoot::new(
        1_234_567,
        B256::from(U256::from(0xabc).to_be_bytes::<32>()),
        B256::from(U256::from(0xdef).to_be_bytes::<32>()),
    )
}

#[tokio::test]
async fn fixed_root_returns_fixture_root() {
    let source = FixedRoot::new(pinned());
    assert_eq!(source.current_root().await.expect("fixed root"), pinned());
    assert_eq!(source.source(), RootSource::Fixture);
    assert!(source.source().is_verified());
}

#[tokio::test]
async fn root_cache_updates_and_reports_status() {
    let cache = RootCache::new();
    assert!(!cache.status().await.synced);

    cache.update(pinned()).await;
    let status = cache.status().await;
    assert!(status.synced);
    assert_eq!(status.finalized_number, Some(1_234_567));
    assert_eq!(cache.get().await, Some(pinned()));
    assert!(cache.age_seconds().await.is_some());
}

#[tokio::test]
async fn root_cache_subscription_sees_updates() {
    let cache = RootCache::new();
    let rx = cache.subscribe();
    assert!(rx.borrow().is_none());

    cache.update(pinned()).await;
    assert_eq!(
        rx.borrow().as_ref().map(|(root, _, _)| *root),
        Some(pinned())
    );
}

#[test]
fn untrusted_root_refuses_without_dev_flag() {
    let _guard = ENV_LOCK.lock().expect("env lock");
    std::env::remove_var(env::DEV_ALLOW_UNTRUSTED_ROOT);

    let err = UntrustedRpcRoot::new("http://127.0.0.1:8545").expect_err("must refuse");
    assert_eq!(err.code(), ErrorCode::UnsupportedVerification);
}

#[test]
fn untrusted_root_is_always_unverified() {
    let _guard = ENV_LOCK.lock().expect("env lock");
    std::env::set_var(env::DEV_ALLOW_UNTRUSTED_ROOT, "1");
    let source =
        UntrustedRpcRoot::new("http://127.0.0.1:8545").expect("dev flag allows construction");
    std::env::remove_var(env::DEV_ALLOW_UNTRUSTED_ROOT);

    assert_eq!(source.source(), RootSource::UntrustedRpc);
    assert!(!source.source().is_verified());
}
