//! Private transport is not built. privacy=required must fail closed with
//! PRIVACY_UNAVAILABLE and send ZERO direct requests; preferred downgrades with a warning.

use serde_json::json;
use veriq_integration_tests::*;

fn policy(privacy: &str) -> serde_json::Value {
    json!({ "verification": "required", "privacy": privacy, "consistency": "single", "blockPolicy": "finalized", "timeoutMs": 8000 })
}

#[tokio::test]
async fn privacy_required_sends_nothing() {
    let (root, address, proof, _) = eoa_fixture();
    let provider = MockProvider::start(Behaviour::Honest(proof)).await;
    let engine = start_engine(root, &[("p", &provider)], false).await;
    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{address:#x}"), policy("required")]),
    )
    .await;
    assert_eq!(error_code(&res), -32013, "{res}");
    assert_eq!(res["error"]["data"]["code"], "PRIVACY_UNAVAILABLE");
    assert!(
        provider.methods().is_empty(),
        "zero direct requests: {:?}",
        provider.methods()
    );
}

#[tokio::test]
async fn privacy_preferred_downgrades_with_a_warning() {
    let (root, address, proof, _) = eoa_fixture();
    let provider = MockProvider::start(Behaviour::Honest(proof)).await;
    let engine = start_engine(root, &[("p", &provider)], false).await;
    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{address:#x}"), policy("preferred")]),
    )
    .await;
    let warnings = res["result"]["receipt"]["warnings"]
        .as_array()
        .expect("warnings");
    assert!(
        warnings.iter().any(|w| w["code"] == "PRIVACY_DOWNGRADED"),
        "{res}"
    );
    assert_eq!(res["result"]["receipt"]["privacy"]["transport"], "direct");
}
