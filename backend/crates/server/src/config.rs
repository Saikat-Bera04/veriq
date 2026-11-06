//! Non-secret configuration from `config/<network>.toml` and its pinned checkpoint file
//! (`config/checkpoint.toml` for Sepolia, `config/checkpoint-mainnet.toml` for mainnet).
//!
//! One source of truth: the files hold the pinned values, env vars override them, and startup
//! fails if a file contradicts what the engine is doing: another chain than `VERIQ_NETWORK`, a
//! checkpoint pinned for another network, or a bind address other than 127.0.0.1:8547. One
//! engine serves one network; chain and root are never mixed.

use std::path::{Path, PathBuf};

use serde::Deserialize;
use veriq_core::{config::ENGINE_ADDR, Network};

pub const SEPOLIA_CHAIN_ID: u64 = 11_155_111;

#[derive(Debug, Clone, Deserialize)]
pub struct NetworkConfig {
    pub chain_id: u64,
    pub engine_addr: String,
    /// Optional; when present it must name the network the file is for.
    #[serde(default)]
    pub name: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CheckpointConfig {
    pub checkpoint: String,
    pub checkpoint_source: String,
    /// Which network the checkpoint is a beacon block root of. Must match the engine's.
    #[serde(default)]
    pub network: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct FileConfig {
    pub network: Option<NetworkConfig>,
    pub checkpoint: Option<CheckpointConfig>,
}

/// `VERIQ_NETWORK`: `sepolia` (default, also when empty) or `mainnet`. Anything else is an error.
pub fn network_from_env() -> Result<Network, String> {
    match std::env::var(veriq_core::config::env::NETWORK) {
        Ok(text) if !text.trim().is_empty() => Network::parse(&text)
            .ok_or_else(|| "VERIQ_NETWORK must be sepolia or mainnet".to_owned()),
        _ => Ok(Network::Sepolia),
    }
}

/// `VERIQ_CONFIG_DIR`, else `./config` (run from `backend/`), else `./backend/config`
/// (run from `Veriq/`), else the source tree's `backend/config`, found from where
/// this crate was built, so a dev build works from any folder (e.g. the repo root).
pub fn config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("VERIQ_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    let source_tree = Path::new(env!("CARGO_MANIFEST_DIR")).join("../../config");
    [
        PathBuf::from("config"),
        PathBuf::from("backend/config"),
        source_tree,
    ]
    .into_iter()
    .find(|dir| dir.is_dir())
    .unwrap_or_else(|| PathBuf::from("config"))
}

fn read<T: for<'de> Deserialize<'de>>(path: &Path) -> Result<Option<T>, String> {
    match std::fs::read_to_string(path) {
        Ok(text) => toml::from_str(&text)
            .map(Some)
            .map_err(|err| format!("{}: {err}", path.display())),
        Err(err) if err.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(err) => Err(format!("{}: {err}", path.display())),
    }
}

/// Load and check both files for `network`. Missing files are fine (env vars then carry
/// everything).
pub fn load(dir: &Path, network: Network) -> Result<FileConfig, String> {
    let file = format!("{}.toml", network.name());
    let net: Option<NetworkConfig> = read(&dir.join(&file))?;
    if let Some(net) = &net {
        if net.chain_id != network.chain_id() {
            return Err(format!(
                "config/{file} chain_id={} but VERIQ_NETWORK={} is chain {}",
                net.chain_id,
                network.name(),
                network.chain_id()
            ));
        }
        if let Some(name) = &net.name {
            if Network::parse(name) != Some(network) {
                return Err(format!(
                    "config/{file} name={name} but VERIQ_NETWORK={}",
                    network.name()
                ));
            }
        }
        if net.engine_addr != ENGINE_ADDR {
            return Err(format!(
                "config/{file} engine_addr={} but the engine only binds {ENGINE_ADDR}",
                net.engine_addr
            ));
        }
    }
    let checkpoint_file = network.checkpoint_file();
    let checkpoint: Option<CheckpointConfig> = read(&dir.join(checkpoint_file))?;
    if let Some(cp) = &checkpoint {
        // A checkpoint is a beacon block root of one chain; another chain's would never sync,
        // or (worse) sync a light client to the wrong chain.
        let named = cp.network.as_deref().map(Network::parse);
        match named {
            Some(Some(n)) if n == network => {}
            Some(_) => {
                return Err(format!(
                    "config/{checkpoint_file} is pinned for network={} but VERIQ_NETWORK={}",
                    cp.network.as_deref().unwrap_or_default(),
                    network.name()
                ))
            }
            None if network != Network::Sepolia => {
                return Err(format!(
                    "config/{checkpoint_file} must say network = \"{}\"",
                    network.name()
                ))
            }
            None => {}
        }
    }
    Ok(FileConfig {
        network: net,
        checkpoint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_config() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../config")
    }

    fn temp_dir(tag: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("veriq-config-test-{tag}-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        dir
    }

    #[test]
    fn committed_config_files_load_and_agree_with_the_code() {
        let cfg = load(&repo_config(), Network::Sepolia).expect("config/ loads");
        let network = cfg.network.expect("sepolia.toml present");
        assert_eq!(network.chain_id, SEPOLIA_CHAIN_ID);
        assert_eq!(network.engine_addr, ENGINE_ADDR);
        let checkpoint = cfg.checkpoint.expect("checkpoint.toml present");
        assert!(checkpoint.checkpoint.starts_with("0x") && checkpoint.checkpoint.len() == 66);
        assert!(!checkpoint.checkpoint_source.is_empty());
    }

    #[test]
    fn committed_mainnet_config_loads_with_its_own_checkpoint() {
        let cfg = load(&repo_config(), Network::Mainnet).expect("mainnet config loads");
        let network = cfg.network.expect("mainnet.toml present");
        assert_eq!(network.chain_id, 1);
        assert_eq!(network.engine_addr, ENGINE_ADDR);
        let checkpoint = cfg.checkpoint.expect("checkpoint-mainnet.toml present");
        assert_eq!(checkpoint.network.as_deref(), Some("mainnet"));
        assert!(checkpoint.checkpoint.starts_with("0x") && checkpoint.checkpoint.len() == 66);
        // Not the Sepolia checkpoint, and from a named source.
        let sepolia = load(&repo_config(), Network::Sepolia)
            .expect("sepolia")
            .checkpoint
            .expect("sepolia checkpoint");
        assert_ne!(checkpoint.checkpoint, sepolia.checkpoint);
        assert!(!checkpoint.checkpoint_source.is_empty());
    }

    #[test]
    fn non_loopback_bind_in_config_is_refused() {
        let dir = temp_dir("bind");
        std::fs::write(
            dir.join("sepolia.toml"),
            "chain_id = 11155111\nengine_addr = \"0.0.0.0:8547\"\n",
        )
        .expect("write");
        let err = load(&dir, Network::Sepolia).expect_err("0.0.0.0 must be refused");
        assert!(err.contains("only binds 127.0.0.1:8547"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_config_file_for_another_chain_is_refused() {
        let dir = temp_dir("chain");
        std::fs::write(
            dir.join("mainnet.toml"),
            "chain_id = 11155111\nengine_addr = \"127.0.0.1:8547\"\n",
        )
        .expect("write");
        let err = load(&dir, Network::Mainnet).expect_err("sepolia chain id in mainnet.toml");
        assert!(err.contains("VERIQ_NETWORK=mainnet is chain 1"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn a_checkpoint_pinned_for_another_network_is_refused() {
        let dir = temp_dir("checkpoint");
        std::fs::write(
            dir.join("checkpoint-mainnet.toml"),
            "network = \"sepolia\"\ncheckpoint = \"0x01\"\ncheckpoint_source = \"x\"\n",
        )
        .expect("write");
        let err = load(&dir, Network::Mainnet).expect_err("sepolia checkpoint for mainnet");
        assert!(err.contains("pinned for network=sepolia"), "{err}");

        std::fs::write(
            dir.join("checkpoint-mainnet.toml"),
            "checkpoint = \"0x01\"\ncheckpoint_source = \"x\"\n",
        )
        .expect("write");
        let err = load(&dir, Network::Mainnet).expect_err("unnamed mainnet checkpoint");
        assert!(err.contains("must say network"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
