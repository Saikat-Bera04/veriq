use std::path::PathBuf;
use std::time::{SystemTime, UNIX_EPOCH};

use alloy::{eips::BlockId, primitives::B256};
use async_trait::async_trait;
use helios_ethereum::{config::networks::Network, EthereumClient, EthereumClientBuilder};
use veriq_core::{Bootstrap, VeriqError};

use crate::{PinnedRoot, RootSource, RootSourceProvider, MAX_FINALIZED_AGE_SECONDS};

/// Configuration for the local Helios light client.
#[derive(Debug, Clone)]
pub struct HeliosConfig {
    pub execution_rpc: String,
    pub consensus_rpc: String,
    pub checkpoint: B256,
    pub checkpoint_source: String,
    pub data_dir: PathBuf,
}

/// A trusted finalized-root source backed by a locally syncing Helios client.
///
/// Construction does not perform network I/O; the Helios sync task starts immediately
/// and `current_root` fails closed until a finalized execution block is available.
pub struct HeliosRoot {
    client: EthereumClient,
    checkpoint: B256,
    checkpoint_source: String,
}

impl HeliosRoot {
    pub fn start(config: HeliosConfig) -> Result<Self, VeriqError> {
        let checkpoint = config.checkpoint;
        let checkpoint_source = config.checkpoint_source.clone();
        let client = EthereumClientBuilder::new()
            .network(Network::Sepolia)
            .consensus_rpc(&config.consensus_rpc)
            .map_err(|_| unavailable("invalid consensus RPC"))?
            .execution_rpc(&config.execution_rpc)
            .map_err(|_| unavailable("invalid execution RPC"))?
            .checkpoint(config.checkpoint)
            .data_dir(config.data_dir)
            .with_file_db()
            .build()
            .map_err(|_| unavailable("client build failed"))?;
        Ok(Self {
            client,
            checkpoint,
            checkpoint_source,
        })
    }
}

#[async_trait]
impl RootSourceProvider for HeliosRoot {
    async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
        let block = self
            .client
            .get_block(BlockId::finalized(), false)
            .await
            .map_err(|_| unavailable("finalized block unavailable"))?
            .ok_or_else(|| unavailable("finalized block not found"))?;

        let now = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        if now.saturating_sub(block.header.timestamp) > MAX_FINALIZED_AGE_SECONDS {
            return Err(unavailable("finalized block is stale"));
        }

        Ok(PinnedRoot::with_timestamp(
            block.header.number,
            block.header.hash,
            block.header.state_root,
            block.header.timestamp,
        ))
    }

    fn source(&self) -> RootSource {
        RootSource::LocalLightClient
    }

    /// Helios' latest head (sync-committee signed, not finalized). Display only.
    async fn head_number(&self) -> Option<u64> {
        self.client
            .get_block(BlockId::latest(), false)
            .await
            .ok()
            .flatten()
            .map(|block| block.header.number)
    }

    fn bootstrap(&self) -> Bootstrap {
        Bootstrap {
            source: Some("helios".to_string()),
            checkpoint: Some(format!("{:#x}", self.checkpoint)),
            checkpoint_source: Some(self.checkpoint_source.clone()),
        }
    }
}

fn unavailable(context: &str) -> VeriqError {
    VeriqError::root_unavailable(format!("helios: {context}"))
}
