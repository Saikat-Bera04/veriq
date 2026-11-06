//! A provider answering with a valid proof from another block (N-100) is rejected
//! with INVALID_PROOF: the proof does not chain to the pinned root of block N.

use serde_json::json;
use veriq_integration_tests::*;

#[tokio::test]
async fn wrong_block_proof_is_rejected_and_honest_value_returned() {
    let blocks = two_blocks();
    let attacker = MockProvider::start(Behaviour::Honest(blocks.old_proof.clone())).await;
    let honest = MockProvider::start(Behaviour::Honest(blocks.current_proof.clone())).await;
    let engine = start_engine(
        blocks.current,
        &[("attacker", &attacker), ("honest", &honest)],
        false,
    )
    .await;

    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{:#x}", blocks.address)]),
    )
    .await;
    assert_eq!(
        res["result"]["value"],
        format!("{:#x}", blocks.current_balance),
        "{res}"
    );
    let receipt = &res["result"]["receipt"];
    assert_eq!(receipt["block"]["number"], blocks.current.number);
    assert_eq!(
        receipt["block"]["stateRoot"],
        format!("{:#x}", blocks.current.state_root)
    );
    let attempts = receipt["routing"]["attempts"].as_array().expect("attempts");
    assert_eq!(attempts[0]["provider"], "attacker");
    assert_eq!(attempts[0]["outcome"], "invalid-proof");
    assert_eq!(attempts[1]["outcome"], "success");
}

#[tokio::test]
async fn only_wrong_block_proofs_is_invalid_proof_and_attacker_cools_down() {
    let blocks = two_blocks();
    let attacker = MockProvider::start(Behaviour::Honest(blocks.old_proof.clone())).await;
    let engine = start_engine(blocks.current, &[("attacker", &attacker)], false).await;
    let address = format!("{:#x}", blocks.address);

    let res = rpc(&engine, "veriq_readBalance", json!([address])).await;
    assert_eq!(
        error_code(&res),
        -32010,
        "every proof failed verification: {res}"
    );
    assert_eq!(res["error"]["data"]["code"], "INVALID_PROOF");

    // INVALID_PROOF opens the breaker: the next read does not contact the attacker.
    let before = attacker.count("eth_getProof");
    let res = rpc(&engine, "veriq_readBalance", json!([address])).await;
    assert_eq!(error_code(&res), -32016, "{res}");
    assert_eq!(
        attacker.count("eth_getProof"),
        before,
        "cooling-down provider was not called"
    );
    let health = get(&engine, "/health").await;
    assert_eq!(health["providers"][0]["breaker"]["state"], "open");
    assert_eq!(health["providers"][0]["breaker"]["reason"], "invalid-proof");
}
