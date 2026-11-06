/// Environment variable names shared by the engine and light-client.
pub mod env {
    pub const PROVIDERS: &str = "VERIQ_PROVIDERS";
    pub const ROOT_SOURCE: &str = "VERIQ_ROOT_SOURCE";
    pub const DEV_ALLOW_UNTRUSTED_ROOT: &str = "VERIQ_DEV_ALLOW_UNTRUSTED_ROOT";
    /// Dev mode only: the RPC whose finalized block is the (untrusted) root. Default: the
    /// first provider. Test scripts point it at the honest upstream so a demo attacker
    /// listed first is never also the root.
    pub const DEV_ROOT_RPC: &str = "VERIQ_DEV_ROOT_RPC";
    pub const HELIOS_CONSENSUS_RPC: &str = "HELIOS_CONSENSUS_RPC";
    pub const HELIOS_CHECKPOINT: &str = "HELIOS_CHECKPOINT";
    pub const HELIOS_CHECKPOINT_SOURCE: &str = "HELIOS_CHECKPOINT_SOURCE";
    /// Which network HELIOS_CHECKPOINT belongs to; required when VERIQ_NETWORK is not sepolia.
    pub const HELIOS_CHECKPOINT_NETWORK: &str = "HELIOS_CHECKPOINT_NETWORK";
    pub const HELIOS_DATA_DIR: &str = "HELIOS_DATA_DIR";
    pub const EXEC_RPC: &str = "EXEC_RPC";
    /// `sepolia` (default) or `mainnet`: the one chain this engine process serves.
    pub const NETWORK: &str = "VERIQ_NETWORK";
}

pub const ENGINE_ADDR: &str = "127.0.0.1:8547";

/// The chain an engine serves. One engine process serves one network; its config file,
/// checkpoint file, providers and light client must all be for that network.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Default)]
pub enum Network {
    #[default]
    Sepolia,
    Mainnet,
}

impl Network {
    pub const fn chain_id(self) -> u64 {
        match self {
            Self::Sepolia => 11_155_111,
            Self::Mainnet => 1,
        }
    }

    /// `eth_chainId` form, e.g. `0xaa36a7`.
    pub fn chain_id_hex(self) -> String {
        format!("{:#x}", self.chain_id())
    }

    /// Lowercase name, also the config file stem (`config/<name>.toml`).
    pub const fn name(self) -> &'static str {
        match self {
            Self::Sepolia => "sepolia",
            Self::Mainnet => "mainnet",
        }
    }

    /// The pinned checkpoint file for this network.
    pub const fn checkpoint_file(self) -> &'static str {
        match self {
            Self::Sepolia => "checkpoint.toml",
            Self::Mainnet => "checkpoint-mainnet.toml",
        }
    }

    /// `sepolia` / `mainnet` (case-insensitive); anything else is `None`.
    pub fn parse(text: &str) -> Option<Self> {
        match text.trim().to_ascii_lowercase().as_str() {
            "sepolia" => Some(Self::Sepolia),
            "mainnet" => Some(Self::Mainnet),
            _ => None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::Network;

    #[test]
    fn networks_have_their_chain_ids_and_files() {
        assert_eq!(Network::Sepolia.chain_id(), 11_155_111);
        assert_eq!(Network::Sepolia.chain_id_hex(), "0xaa36a7");
        assert_eq!(Network::Mainnet.chain_id_hex(), "0x1");
        assert_eq!(Network::parse(" Mainnet "), Some(Network::Mainnet));
        assert_eq!(Network::parse("holesky"), None);
        assert_eq!(Network::default(), Network::Sepolia);
        assert_eq!(
            Network::Mainnet.checkpoint_file(),
            "checkpoint-mainnet.toml"
        );
    }
}
