//! A provider on the wrong chain is excluded by the startup probe and never asked
//! for a proof.

use serde_json::json;
use veriq_integration_tests::*;

#[tokio::test]
async fn wrong_chain_provider_is_excluded_at_probe() {
    let (root, address, proof, balance) = eoa_fixture();
    let mainnet = MockProvider::start(Behaviour::WrongChain(1)).await;
    let honest = MockProvider::start(Behaviour::Honest(proof)).await;
    let engine = start_engine(root, &[("mainnet", &mainnet), ("honest", &honest)], true).await;

    let health = get(&engine, "/health").await;
    assert_eq!(health["providers"][0]["name"], "mainnet");
    assert_eq!(health["providers"][0]["chainOk"], false);
    assert_eq!(health["providers"][1]["chainOk"], true);
    assert_eq!(health["providers"][1]["proofSupport"], true);

    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{address:#x}")]),
    )
    .await;
    assert_eq!(res["result"]["value"], format!("{balance:#x}"), "{res}");
    assert_eq!(
        res["result"]["receipt"]["routing"]["attempts"]
            .as_array()
            .map(Vec::len),
        Some(1)
    );
    assert_eq!(
        mainnet.methods(),
        vec!["eth_chainId"],
        "probed once, never asked for a proof"
    );
}

#[tokio::test]
async fn only_wrong_chain_providers_fail_closed_without_proof_requests() {
    let (root, address, _, _) = eoa_fixture();
    let mainnet = MockProvider::start(Behaviour::WrongChain(1)).await;
    let engine = start_engine(root, &[("mainnet", &mainnet)], true).await;
    let res = rpc(
        &engine,
        "veriq_readBalance",
        json!([format!("{address:#x}")]),
    )
    .await;
    assert_eq!(error_code(&res), -32016, "{res}");
    assert_eq!(mainnet.count("eth_getProof"), 0);
}
