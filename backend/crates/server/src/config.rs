//! Non-secret configuration from `config/sepolia.toml` and `config/checkpoint.toml`.
//!
//! One source of truth: the files hold the pinned Sepolia values, env vars override
//! them, and startup fails if a file contradicts what the engine is compiled to do
//! (another chain, or a bind address other than 127.0.0.1:8547).

use std::path::{Path, PathBuf};

use serde::Deserialize;
use veriq_core::config::ENGINE_ADDR;

pub const SEPOLIA_CHAIN_ID: u64 = 11_155_111;

#[derive(Debug, Clone, Deserialize)]
pub struct NetworkConfig {
    pub chain_id: u64,
    pub engine_addr: String,
}

#[derive(Debug, Clone, Deserialize)]
pub struct CheckpointConfig {
    pub checkpoint: String,
    pub checkpoint_source: String,
}

#[derive(Debug, Clone, Default)]
pub struct FileConfig {
    pub network: Option<NetworkConfig>,
    pub checkpoint: Option<CheckpointConfig>,
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

/// Load and check both files. Missing files are fine (env vars then carry everything).
pub fn load(dir: &Path) -> Result<FileConfig, String> {
    let network: Option<NetworkConfig> = read(&dir.join("sepolia.toml"))?;
    if let Some(network) = &network {
        if network.chain_id != SEPOLIA_CHAIN_ID {
            return Err(format!(
                "config/sepolia.toml chain_id={} but this engine only serves Sepolia ({SEPOLIA_CHAIN_ID})",
                network.chain_id
            ));
        }
        if network.engine_addr != ENGINE_ADDR {
            return Err(format!(
                "config/sepolia.toml engine_addr={} but the engine only binds {ENGINE_ADDR}",
                network.engine_addr
            ));
        }
    }
    let checkpoint = read(&dir.join("checkpoint.toml"))?;
    Ok(FileConfig {
        network,
        checkpoint,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn repo_config() -> PathBuf {
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../config")
    }

    #[test]
    fn committed_config_files_load_and_agree_with_the_code() {
        let cfg = load(&repo_config()).expect("config/ loads");
        let network = cfg.network.expect("sepolia.toml present");
        assert_eq!(network.chain_id, SEPOLIA_CHAIN_ID);
        assert_eq!(network.engine_addr, ENGINE_ADDR);
        let checkpoint = cfg.checkpoint.expect("checkpoint.toml present");
        assert!(checkpoint.checkpoint.starts_with("0x") && checkpoint.checkpoint.len() == 66);
        assert!(!checkpoint.checkpoint_source.is_empty());
    }

    #[test]
    fn non_loopback_bind_in_config_is_refused() {
        let dir = std::env::temp_dir().join(format!("veriq-config-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).expect("temp dir");
        std::fs::write(
            dir.join("sepolia.toml"),
            "chain_id = 11155111\nengine_addr = \"0.0.0.0:8547\"\n",
        )
        .expect("write");
        let err = load(&dir).expect_err("0.0.0.0 must be refused");
        assert!(err.contains("only binds 127.0.0.1:8547"), "{err}");
        std::fs::remove_dir_all(&dir).ok();
    }
}
