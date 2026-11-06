//! Network tests against the real providers in VERIQ_PROVIDERS. Skipped in CI:
//!   VERIQ_LIVE=1 cargo test -p veriq-integration-tests --test live -- --ignored

use veriq_router::probe::probe_providers;

#[tokio::test]
#[ignore = "network: run with VERIQ_LIVE=1 and --ignored"]
async fn configured_providers_are_on_sepolia_and_serve_proofs() {
    if std::env::var("VERIQ_LIVE").as_deref() != Ok("1") {
        eprintln!("skipped: set VERIQ_LIVE=1");
        return;
    }
    let spec = std::env::var("VERIQ_PROVIDERS").expect("VERIQ_PROVIDERS");
    let caps = probe_providers(&spec).await;
    assert!(!caps.is_empty(), "no providers parsed");
    for cap in &caps {
        eprintln!(
            "{}: chain_ok={} getProof={} eip1898={}",
            cap.name(),
            cap.chain_ok(),
            cap.supports_get_proof(),
            cap.supports_block_hash()
        );
        assert!(cap.chain_ok(), "{} is not on Sepolia", cap.name());
    }
    assert!(
        caps.iter().any(|c| c.eligible()),
        "no provider serves eth_getProof"
    );
}
