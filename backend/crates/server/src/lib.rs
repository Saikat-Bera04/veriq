/// Default log filter: every Veriq crate at info (probe and routing warnings included),
/// third-party crates off. Override with RUST_LOG.
pub const DEFAULT_LOG_FILTER: &str =
    "veriq_server=info,veriq_router=info,veriq_light_client=info,veriq_verifier=info";

pub mod config;
pub mod engine;
pub mod http;
pub mod logging;
pub mod provider;
pub mod rpc;
pub mod store;
