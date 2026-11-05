//! Logs never contain a full address, a provider URL, an API key or a query string,
//! even when providers fail and the engine logs about them.

use std::io::Write;
use std::sync::{Arc, Mutex};

use serde_json::json;
use veriq_integration_tests::*;

#[derive(Clone, Default)]
struct Captured(Arc<Mutex<Vec<u8>>>);

impl Write for Captured {
    fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
        self.0.lock().expect("log buffer").extend_from_slice(buf);
        Ok(buf.len())
    }
    fn flush(&mut self) -> std::io::Result<()> {
        Ok(())
    }
}

#[tokio::test]
async fn logs_contain_no_address_url_or_key() {
    let captured = Captured::default();
    let writer = captured.clone();
    // Every Veriq crate at TRACE (stricter than the engine's default of info).
    // Third-party crates (reqwest/hyper) are off, as in the engine's default filter.
    let filter = veriq_server::DEFAULT_LOG_FILTER.replace("=info", "=trace");
    tracing_subscriber::fmt()
        .with_ansi(false)
        .with_env_filter(tracing_subscriber::EnvFilter::new(filter))
        .with_writer(move || writer.clone())
        .init();

    const KEY: &str = "SUPERSECRETKEY1234567890";
    let (root, address, proof, _) = eoa_fixture();
    let down =
        MockProvider::start_with_path(Behaviour::Outage, &format!("v3/{KEY}?apikey={KEY}")).await;
    let honest =
        MockProvider::start_with_path(Behaviour::Honest(proof), &format!("?apikey={KEY}")).await;
    let engine = start_engine(root, &[("down", &down), ("honest", &honest)], true).await;
    let full = format!("{address:#x}");
    let res = rpc(&engine, "veriq_readBalance", json!([full])).await;
    assert!(res.get("result").is_some(), "{res}");
    // Also a request that fails at every provider, to exercise the warn paths.
    let _ = rpc(
        &engine,
        "veriq_readBalance",
        json!(["0x00000000000000000000000000000000000000aa"]),
    )
    .await;

    let logs = String::from_utf8(captured.0.lock().expect("logs").clone()).expect("utf8");
    assert!(
        logs.contains("provider"),
        "the engine did log something: {logs}"
    );
    for forbidden in [
        KEY,
        "apikey",
        &full,
        &full[2..],
        &down.url,
        &honest.url,
        "http://",
        "127.0.0.1:",
    ] {
        assert!(
            !logs.contains(forbidden),
            "log leaked {forbidden:?}:\n{logs}"
        );
    }
}
