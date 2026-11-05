//! A provider that is down is recorded as a transport failure and the engine fails
//! over to the next provider at the SAME block, returning the proven value.

use serde_json::json;
use veriq_integration_tests::*;

#[tokio::test]
async fn outage_fails_over_to_honest_provider_at_the_same_block() {
    let (root, address, proof, balance) = eoa_fixture();
    let down = MockProvider::start(Behaviour::Outage).await;
    let honest = MockProvider::start(Behaviour::Honest(proof)).await;
    let engine = start_engine(root, &[("down", &down), ("honest", &honest)], false).await;

    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{address:#x}")]),
    )
    .await;
    let result = &res["result"];
    assert_eq!(result["value"], format!("{balance:#x}"), "{res}");
    let receipt = &result["receipt"];
    assert_eq!(receipt["verification"]["status"], "verified");
    assert_eq!(receipt["block"]["number"], root.number, "same pinned block");
    assert_eq!(receipt["routing"]["providerLabel"], "honest");
    let attempts = receipt["routing"]["attempts"].as_array().expect("attempts");
    assert_eq!(attempts[0]["provider"], "down");
    assert_eq!(attempts[0]["outcome"], "transport-failure");
    assert_eq!(attempts[1]["provider"], "honest");
    assert_eq!(attempts[1]["outcome"], "success");
    assert!(
        down.count("eth_getProof") >= 1,
        "the down provider was really tried"
    );
}

#[tokio::test]
async fn every_provider_down_is_all_providers_failed() {
    let (root, address, _, _) = eoa_fixture();
    let a = MockProvider::start(Behaviour::Outage).await;
    let b = MockProvider::start(Behaviour::Outage).await;
    let engine = start_engine(root, &[("a", &a), ("b", &b)], false).await;
    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{address:#x}")]),
    )
    .await;
    assert_eq!(error_code(&res), -32016, "{res}");
    // The failure is stored too, with its attempts.
    let rows = get(&engine, "/receipts?limit=1").await;
    assert_eq!(rows["receipts"][0]["error"]["code"], -32016);
    assert_eq!(
        rows["receipts"][0]["attempts"].as_array().map(Vec::len),
        Some(2)
    );
}

#[tokio::test]
async fn provider_down_at_startup_is_not_excluded_forever() {
    // Regression: a single probe timeout used to remove an honest provider for good.
    let (root, address, proof, balance) = eoa_fixture();
    let flaky = MockProvider::start(Behaviour::Outage).await;
    let engine = start_engine(root, &[("flaky", &flaky)], true).await;

    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{address:#x}")]),
    )
    .await;
    assert_eq!(error_code(&res), -32016, "still down: {res}");

    flaky.set(Behaviour::Honest(proof));
    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{address:#x}")]),
    )
    .await;
    assert_eq!(
        res["result"]["value"],
        format!("{balance:#x}"),
        "recovered provider is used: {res}"
    );
}

/// Compare mode asks two providers at the same pinned block and records agreement.
/// (Two VALID proofs against one root always prove the same value, so "divergent" can't
/// come from honest proofs; the agree/divergent logic itself is unit-tested in
/// crates/router/src/compare.rs.)
#[tokio::test]
async fn compare_mode_asks_two_providers_and_records_agreement() {
    let (root, address, proof, balance) = eoa_fixture();
    let a = MockProvider::start(Behaviour::Honest(proof.clone())).await;
    let b = MockProvider::start(Behaviour::Honest(proof)).await;
    let engine = start_engine(root, &[("a", &a), ("b", &b)], false).await;

    let policy = json!({
        "verification": "required",
        "privacy": "off",
        "consistency": "compare",
        "blockPolicy": "finalized",
        "timeoutMs": 5000
    });
    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{address:#x}"), policy]),
    )
    .await;
    let result = &res["result"];
    assert_eq!(result["value"], format!("{balance:#x}"), "{res}");
    let receipt = &result["receipt"];
    assert_eq!(receipt["verification"]["status"], "verified");
    assert_eq!(receipt["routing"]["comparison"], "agree", "{res}");
    assert_eq!(receipt["block"]["number"], root.number, "same pinned block");
    assert_eq!(a.count("eth_getProof"), 1, "first provider asked once");
    assert_eq!(b.count("eth_getProof"), 1, "second provider asked once");
}
