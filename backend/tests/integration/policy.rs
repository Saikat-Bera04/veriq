//! Finalized only: latest + verification=required is POLICY_UNSATISFIABLE, decided
//! before any provider is contacted. Malformed policies are INVALID_REQUEST.

use serde_json::json;
use veriq_integration_tests::*;

fn policy(block_policy: &str, verification: &str) -> serde_json::Value {
    json!({ "verification": verification, "privacy": "off", "consistency": "single", "blockPolicy": block_policy, "timeoutMs": 8000 })
}

#[tokio::test]
async fn latest_with_required_is_policy_unsatisfiable_and_nothing_is_sent() {
    let (root, address, proof, _) = eoa_fixture();
    let provider = MockProvider::start(Behaviour::Honest(proof)).await;
    let engine = start_engine(root, &[("p", &provider)], false).await;
    let address = format!("{address:#x}");

    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([address, policy("latest", "required")]),
    )
    .await;
    assert_eq!(error_code(&res), -32014, "{res}");
    assert_eq!(res["error"]["data"]["code"], "POLICY_UNSATISFIABLE");

    let res = rpc(&engine, "eth_getBalance", json!([address, "latest"])).await;
    assert_eq!(error_code(&res), -32014, "{res}");

    assert!(
        provider.methods().is_empty(),
        "no provider request: {:?}",
        provider.methods()
    );
}

#[tokio::test]
async fn finalized_policy_is_honoured_and_garbage_policy_rejected() {
    let (root, address, proof, balance) = eoa_fixture();
    let provider = MockProvider::start(Behaviour::Honest(proof)).await;
    let engine = start_engine(root, &[("p", &provider)], false).await;
    let address = format!("{address:#x}");

    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([address, policy("finalized", "required")]),
    )
    .await;
    assert_eq!(res["result"]["value"], format!("{balance:#x}"), "{res}");

    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([address, { "verification": "sometimes" }]),
    )
    .await;
    assert_eq!(error_code(&res), -32602, "{res}");
}
