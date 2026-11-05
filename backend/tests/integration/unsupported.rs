//! Methods Veriq cannot prove are refused with UNSUPPORTED_VERIFICATION and never
//! forwarded; eth_chainId is answered locally.

use serde_json::json;
use veriq_integration_tests::*;

#[tokio::test]
async fn unprovable_methods_are_unsupported_and_never_forwarded() {
    let (root, _, proof, _) = eoa_fixture();
    let provider = MockProvider::start(Behaviour::Honest(proof)).await;
    let engine = start_engine(root, &[("p", &provider)], false).await;

    for (method, params) in [
        (
            "eth_call",
            json!([{ "to": "0x0000000000000000000000000000000000000000" }, "finalized"]),
        ),
        ("eth_sendRawTransaction", json!(["0x00"])),
        ("eth_blockNumber", json!([])),
        ("debug_traceTransaction", json!(["0x00"])),
    ] {
        let res = rpc(&engine, method, params).await;
        assert_eq!(error_code(&res), -32012, "{method}: {res}");
        assert_eq!(res["error"]["data"]["code"], "UNSUPPORTED_VERIFICATION");
    }
    assert!(
        provider.methods().is_empty(),
        "nothing was forwarded: {:?}",
        provider.methods()
    );
}

#[tokio::test]
async fn chain_id_is_answered_locally() {
    let (root, _, proof, _) = eoa_fixture();
    let provider = MockProvider::start(Behaviour::Honest(proof)).await;
    let engine = start_engine(root, &[("p", &provider)], false).await;
    let res = rpc(&engine, "eth_chainId", json!([])).await;
    assert_eq!(res["result"], "0xaa36a7");
    assert!(provider.methods().is_empty());
}
