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
    pub const HELIOS_DATA_DIR: &str = "HELIOS_DATA_DIR";
    pub const EXEC_RPC: &str = "EXEC_RPC";
}

pub const ENGINE_ADDR: &str = "127.0.0.1:8547";
