use std::{env, net::SocketAddr, str::FromStr, sync::Arc, time::Duration};

use alloy_primitives::B256;
use async_trait::async_trait;
use veriq_core::config::env as names;
use veriq_core::{Network, VeriqError};
#[cfg(feature = "helios")]
use veriq_light_client::helios_adapter::{HeliosConfig, HeliosRoot};
use veriq_light_client::{
    cached::CachedRoot, fixed::FixedRoot, untrusted_rpc::UntrustedRpcRoot, PinnedRoot, RootSource,
    RootSourceProvider,
};
use veriq_router::probe::probe_providers_for;
use veriq_server::{
    config::{self, FileConfig},
    engine::{
        Engine, ProbeStatus, DEFAULT_REPROBE_INTERVAL, DEFAULT_ROOT_REFRESH, REPROBE_INTERVAL_ENV,
        ROOT_REFRESH_ENV, VERIFIED_CACHE_ENV,
    },
    http::app,
    provider::ProviderConfig,
    store::{InMemoryReceiptStore, PostgresReceiptStore, ReceiptStore, DATABASE_URL_ENV},
};

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    let _ = dotenvy::dotenv();

    tracing_subscriber::fmt()
        .with_env_filter(
            tracing_subscriber::EnvFilter::try_from_default_env()
                .unwrap_or_else(|_| veriq_server::DEFAULT_LOG_FILTER.into()),
        )
        .init();

    // One engine, one chain (S6): VERIQ_NETWORK picks the config and checkpoint files, the
    // probe's expected chain id, the light client's network and the chain id in receipts.
    let network = config::network_from_env()?;
    let config_dir = config::config_dir();
    if !config_dir.is_dir() {
        tracing::warn!(
            dir = %config_dir.display(),
            "config folder not found; network and checkpoint files are not loaded (set VERIQ_CONFIG_DIR)"
        );
    }
    let file_config = config::load(&config_dir, network)?;
    if let Some(cp) = &file_config.checkpoint {
        tracing::info!(
            checkpoint_source = %veriq_server::logging::redact_sensitive(&cp.checkpoint_source),
            file = network.checkpoint_file(),
            "pinned checkpoint loaded"
        );
    }
    tracing::info!(
        network = network.name(),
        chain_id = network.chain_id(),
        "network selected"
    );

    let providers_input = env::var(names::PROVIDERS)
        .map_err(|_| "VERIQ_PROVIDERS is required (label=url,label=url)")?;
    let providers = ProviderConfig::parse_many(&providers_input)?;
    // Postgres when DATABASE_URL is set (receipts survive restart). Without it, keep
    // the newest receipts in memory so local runs and scripts work without a database.
    // A DATABASE_URL that is set but unreachable is a config error: refuse to start.
    let receipt_store: Arc<dyn ReceiptStore> = match env::var(DATABASE_URL_ENV)
        .ok()
        .filter(|url| !url.trim().is_empty())
    {
        Some(database_url) => Arc::new({
            if let Some(problem) = veriq_server::store::database_url_problem(&database_url) {
                return Err(problem.into());
            }
            PostgresReceiptStore::connect(&database_url)
                .await
                .map_err(|_| "could not connect to PostgreSQL or initialize receipt storage")?
        }),
        None => {
            tracing::warn!("DATABASE_URL not set; receipts are kept in memory and lost on restart");
            Arc::new(InMemoryReceiptStore::new())
        }
    };

    let root = cache_root(select_root(&providers, &file_config, network)?)?;
    tracing::info!(
        providers = providers.len(),
        root_source = root.source().as_str(),
        "starting Veriq engine"
    );

    // Startup probe (crates/router): right chain, eth_getProof, EIP-1898 blockHash.
    // Ineligible providers stay listed in /health but are never routed to.
    let probed = probe_providers_for(&providers_input, network.chain_id()).await;
    // A provider the probe could not reach (no chain id) is left unprobed, not excluded.
    let probes: Vec<Option<ProbeStatus>> = providers
        .iter()
        .map(|provider| {
            let caps = probed.iter().find(|caps| caps.name() == provider.label)?;
            ProbeStatus::from_capabilities(caps)
        })
        .collect();
    let eligible = probes
        .iter()
        .filter(|p| p.is_none_or(|p| p.eligible()))
        .count();
    if eligible == 0 {
        tracing::warn!("no provider passed the startup probe; reads will fail closed");
    }

    // Off by default so the attack demo and scripts always reach the providers.
    let verified_cache = env::var(VERIFIED_CACHE_ENV).as_deref() == Ok("1");
    if verified_cache {
        tracing::info!(
            "verified-result cache on: repeat reads at the same finalized block skip providers"
        );
    }
    let engine = Engine::new(root, providers)
        .with_network(network)
        .with_probes(probes)
        .with_store(receipt_store)
        .with_verified_cache(verified_cache);
    spawn_reprobe(&engine)?;
    // Empty values (an unfilled line in .env) mean the default, like a missing variable.
    let setting = |name: &str| env::var(name).ok().filter(|value| !value.trim().is_empty());
    let host = setting("VERIQ_HOST").unwrap_or_else(|| {
        if env::var("PORT").is_ok() || env::var("RENDER").is_ok() {
            "0.0.0.0".into()
        } else {
            "127.0.0.1".into()
        }
    });
    let port = setting("PORT").unwrap_or_else(|| "8547".into());
    let bind_str = format!("{host}:{port}");
    let addr = SocketAddr::from_str(&bind_str)?;
    let listener = tokio::net::TcpListener::bind(addr).await?;
    tracing::info!(%addr, "server listening");
    // Peer addresses are needed by the demo-only reset endpoint's loopback check.
    axum::serve(
        listener,
        app(engine).into_make_service_with_connect_info::<SocketAddr>(),
    )
    .with_graceful_shutdown(shutdown_signal())
    .await?;
    tracing::info!("server shutdown complete");
    Ok(())
}

async fn shutdown_signal() {
    let ctrl_c = async {
        tokio::signal::ctrl_c()
            .await
            .expect("failed to install Ctrl+C handler");
    };

    #[cfg(unix)]
    let terminate = async {
        tokio::signal::unix::signal(tokio::signal::unix::SignalKind::terminate())
            .expect("failed to install SIGTERM handler")
            .recv()
            .await;
    };

    #[cfg(not(unix))]
    let terminate = std::future::pending::<()>();

    tokio::select! {
        _ = ctrl_c => {
            tracing::info!("Ctrl+C signal received, starting graceful shutdown");
        },
        _ = terminate => {
            tracing::info!("SIGTERM signal received, starting graceful shutdown");
        },
    }
}

/// Put a `RootCache` in front of the root source and keep it fresh in the background,
/// every `VERIQ_ROOT_REFRESH_SECS` (default 12, one Sepolia slot; `0` = no cache, every
/// read asks the source). Reads reuse the cached root while it is at most three
/// intervals old; an older root is fetched again, never served.
fn cache_root(
    source: Arc<dyn RootSourceProvider>,
) -> Result<Arc<dyn RootSourceProvider>, Box<dyn std::error::Error>> {
    let every = match env::var(ROOT_REFRESH_ENV) {
        Ok(text) if !text.trim().is_empty() => Duration::from_secs(
            text.trim()
                .parse()
                .map_err(|_| format!("{ROOT_REFRESH_ENV} must be a whole number of seconds"))?,
        ),
        _ => DEFAULT_ROOT_REFRESH,
    };
    if every.is_zero() {
        tracing::info!("root cache off: every read asks the root source");
        return Ok(source);
    }
    let cached = Arc::new(CachedRoot::new(source, every));
    let refresher = cached.clone();
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(refresher.refresh_every());
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        let mut available = None;
        loop {
            ticks.tick().await;
            let now = refresher.refresh().await.is_ok();
            // Log changes only, so a light client that is still syncing is not a warning
            // every few seconds.
            if available != Some(now) {
                if now {
                    tracing::info!("root cache refreshed; finalized root available");
                } else {
                    tracing::warn!("root cache refresh failed; finalized root unavailable");
                }
                available = Some(now);
            }
        }
    });
    Ok(cached)
}

/// Re-probe providers the startup probe marked ineligible, every `VERIQ_REPROBE_SECS`
/// (default 300; `0` turns it off), so a recovered provider is routed to again
/// without a restart.
fn spawn_reprobe(engine: &Engine) -> Result<(), Box<dyn std::error::Error>> {
    let interval = match env::var(REPROBE_INTERVAL_ENV) {
        Ok(text) if !text.trim().is_empty() => Duration::from_secs(
            text.trim()
                .parse()
                .map_err(|_| format!("{REPROBE_INTERVAL_ENV} must be a whole number of seconds"))?,
        ),
        _ => DEFAULT_REPROBE_INTERVAL,
    };
    if interval.is_zero() {
        tracing::info!("re-probing of ineligible providers is off");
        return Ok(());
    }
    let engine = engine.clone();
    tokio::spawn(async move {
        let mut ticks = tokio::time::interval(interval);
        ticks.set_missed_tick_behavior(tokio::time::MissedTickBehavior::Delay);
        ticks.tick().await; // the first tick fires at once; the startup probe just ran
        loop {
            ticks.tick().await;
            engine.reprobe_ineligible().await;
        }
    });
    Ok(())
}

fn select_root(
    providers: &[ProviderConfig],
    file_config: &FileConfig,
    network: Network,
) -> Result<Arc<dyn RootSourceProvider>, Box<dyn std::error::Error>> {
    let root_source_var = env::var(names::ROOT_SOURCE);
    let is_prod = env::var("VERIQ_ENV").as_deref() == Ok("production")
        || env::var("ENVIRONMENT").as_deref() == Ok("production")
        || env::var("NODE_ENV").as_deref() == Ok("production");
    if is_prod && matches!(root_source_var.as_deref(), Ok("dev-untrusted" | "fixture")) {
        return Err(
            "dev-untrusted and fixture root sources are strictly prohibited in production; set VERIQ_ROOT_SOURCE=helios"
                .into(),
        );
    }

    match root_source_var.as_deref() {
        Ok("fixture") => Ok(Arc::new(fixture_root()?)),
        Ok("dev-untrusted") => {
            // Dev only: the root comes from a provider, so receipts are `unverified`.
            if env::var(names::DEV_ALLOW_UNTRUSTED_ROOT).as_deref() != Ok("1") {
                return Err(
                    "VERIQ_ROOT_SOURCE=dev-untrusted requires VERIQ_DEV_ALLOW_UNTRUSTED_ROOT=1"
                        .into(),
                );
            }
            tracing::warn!("DEV MODE: untrusted root source; receipts will be unverified");
            let url = match env::var(names::DEV_ROOT_RPC)
                .ok()
                .filter(|url| !url.trim().is_empty())
            {
                Some(url) if veriq_router::probe::valid_endpoint(&url) => {
                    tracing::info!("dev root from VERIQ_DEV_ROOT_RPC");
                    url
                }
                // Never echo the value: it may carry an API key.
                Some(_) => {
                    return Err("VERIQ_DEV_ROOT_RPC must be an http(s) URL with a host".into())
                }
                None => providers
                    .first()
                    .ok_or("dev-untrusted root source requires at least one provider")?
                    .url
                    .clone(),
            };
            Ok(Arc::new(UntrustedRpcRoot::new(url)?))
        }
        Ok("helios") => {
            #[cfg(feature = "helios")]
            {
                let config = helios_config(providers, file_config, network)?;
                let root = HeliosRoot::start(config)?;
                tracing::info!("helios root source started; waiting for finalized sync");
                Ok(Arc::new(root))
            }
            #[cfg(not(feature = "helios"))]
            {
                let _ = (file_config, network);
                tracing::error!("VERIQ_ROOT_SOURCE=helios requires --features helios");
                Ok(Arc::new(UnavailableRoot::new(
                    "helios root source requires building with --features helios",
                )))
            }
        }
        Ok(_) => Err("unknown VERIQ_ROOT_SOURCE; use helios|fixture|dev-untrusted".into()),
        Err(_) => {
            tracing::warn!("no root source configured; verified reads will fail closed");
            Ok(Arc::new(UnavailableRoot::new(
                "no trusted root source configured",
            )))
        }
    }
}

#[cfg(feature = "helios")]
fn helios_config(
    providers: &[ProviderConfig],
    file_config: &FileConfig,
    network: Network,
) -> Result<HeliosConfig, Box<dyn std::error::Error>> {
    let execution_rpc = env::var(names::EXEC_RPC)
        .ok()
        .filter(|url| !url.trim().is_empty())
        .unwrap_or_else(|| providers[0].url.clone());
    let consensus_rpc = env::var(names::HELIOS_CONSENSUS_RPC)
        .map_err(|_| "HELIOS_CONSENSUS_RPC is required for VERIQ_ROOT_SOURCE=helios")?;
    // Env overrides the network's checkpoint file; one of the two must provide the checkpoint.
    let file_cp = file_config.checkpoint.as_ref();
    // A HELIOS_CHECKPOINT in .env is a beacon block root of one chain. Off Sepolia it must say
    // which (HELIOS_CHECKPOINT_NETWORK), so a Sepolia root is never handed to mainnet Helios.
    let env_cp = env::var(names::HELIOS_CHECKPOINT)
        .ok()
        .filter(|v| !v.trim().is_empty());
    if env_cp.is_some() && network != Network::Sepolia {
        let named = env::var(names::HELIOS_CHECKPOINT_NETWORK).unwrap_or_default();
        if Network::parse(&named) != Some(network) {
            return Err(format!(
                "HELIOS_CHECKPOINT is set but VERIQ_NETWORK={}: set HELIOS_CHECKPOINT_NETWORK={} \
                 to confirm it is a {} root, or leave HELIOS_CHECKPOINT empty to use config/{}",
                network.name(),
                network.name(),
                network.name(),
                network.checkpoint_file()
            )
            .into());
        }
    }
    let checkpoint = B256::from_str(
        &env_cp
            .or_else(|| file_cp.map(|cp| cp.checkpoint.clone()))
            .ok_or("HELIOS_CHECKPOINT (or the network's checkpoint file) is required for helios")?,
    )?;
    // The OS temp folder: /tmp on Linux and macOS, %TEMP% on Windows. One folder per network:
    // Helios stores its newest checkpoint there, which must never be read by another chain.
    // An empty HELIOS_DATA_DIR (an unfilled .env line) means the default, not the current folder.
    let data_dir = env::var(names::HELIOS_DATA_DIR)
        .ok()
        .filter(|dir| !dir.trim().is_empty())
        .unwrap_or_else(|| {
            let folder = match network {
                Network::Sepolia => "veriq-helios".to_owned(),
                other => format!("veriq-helios-{}", other.name()),
            };
            env::temp_dir().join(folder).to_string_lossy().into_owned()
        });
    let checkpoint_source = env::var(names::HELIOS_CHECKPOINT_SOURCE)
        .ok()
        .filter(|v| !v.trim().is_empty())
        .or_else(|| file_cp.map(|cp| cp.checkpoint_source.clone()))
        .unwrap_or_else(|| "unspecified".to_string());
    if consensus_rpc.trim().is_empty() {
        return Err("HELIOS_CONSENSUS_RPC must not be empty".into());
    }
    Ok(HeliosConfig {
        network,
        execution_rpc,
        consensus_rpc,
        checkpoint,
        checkpoint_source,
        data_dir: data_dir.into(),
    })
}

fn fixture_root() -> Result<FixedRoot, Box<dyn std::error::Error>> {
    let number = fixture_var("VERIQ_FIXTURE_NUMBER")?
        .parse::<u64>()
        .map_err(|_| "VERIQ_FIXTURE_NUMBER must be a decimal block number")?;
    let hash = B256::from_str(&fixture_var("VERIQ_FIXTURE_HASH")?)
        .map_err(|_| "VERIQ_FIXTURE_HASH must be a 0x-prefixed 32-byte hex block hash")?;
    let state_root = B256::from_str(&fixture_var("VERIQ_FIXTURE_STATE_ROOT")?)
        .map_err(|_| "VERIQ_FIXTURE_STATE_ROOT must be a 0x-prefixed 32-byte hex state root")?;
    Ok(FixedRoot::new(PinnedRoot::new(number, hash, state_root)))
}

/// A required fixture variable, with an error that names it.
fn fixture_var(name: &str) -> Result<String, String> {
    env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("{name} is required for VERIQ_ROOT_SOURCE=fixture"))
}

#[derive(Debug)]
struct UnavailableRoot {
    reason: String,
}

impl UnavailableRoot {
    fn new(reason: impl Into<String>) -> Self {
        Self {
            reason: reason.into(),
        }
    }
}

#[async_trait]
impl RootSourceProvider for UnavailableRoot {
    async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
        Err(VeriqError::root_unavailable(self.reason.clone()))
    }

    fn source(&self) -> RootSource {
        RootSource::Unavailable
    }

    fn bootstrap(&self) -> veriq_core::Bootstrap {
        veriq_core::Bootstrap {
            source: Some("none".to_string()),
            ..veriq_core::Bootstrap::default()
        }
    }
}
