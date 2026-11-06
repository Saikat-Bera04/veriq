use std::collections::HashMap;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex, RwLock};
use std::time::{Duration, Instant, SystemTime, UNIX_EPOCH};

use alloy_primitives::{hex, keccak256, Address, Bytes, B256, U256};
use serde::Serialize;
use serde_json::{json, Value};
use veriq_core::{
    binding, AttemptOutcome, Block, BlockPolicy, Bootstrap, Comparison, Consistency, ErrorCode,
    Identity, Mechanism, Policy, Privacy, PrivacyPolicy, Receipt, RootSourceKind, Routing,
    RoutingAttempt, Transport, Verification, VerificationStatus, VerifierLocation, VeriqError,
    Warning,
};
use veriq_light_client::{PinnedRoot, RootSource, RootSourceProvider};
use veriq_router::breaker::{CircuitBreaker, CooldownReason};
use veriq_router::MAX_PROVIDER_ATTEMPTS;
use veriq_verifier::{verify_account, verify_storage};

use crate::provider::{parse_proof_result, ProofBundle, ProofClient, ProofFetcher, ProviderConfig};
use crate::store::{InMemoryReceiptStore, ReceiptStore, StoredError, StoredParams, StoredReceipt};

#[derive(Debug, Clone)]
pub struct RequestMeta {
    /// Unique request id; becomes `receipt.identity.requestId` and the store key.
    pub id: String,
    pub method: String,
    pub params: Value,
}

impl RequestMeta {
    /// A fresh request id: `<unix-ms hex>-<instance hex>-<counter hex>`. The counter
    /// makes ids unique within this engine; the instance tag (random, fixed for the
    /// process) keeps engines that share one receipt database from colliding, e.g.
    /// two engines started in the same millisecond, whose counters both start at 0.
    pub fn new(method: impl Into<String>, params: Value) -> Self {
        static COUNTER: AtomicU64 = AtomicU64::new(0);
        let n = COUNTER.fetch_add(1, Ordering::Relaxed);
        Self {
            id: format!("{:011x}-{:06x}-{n:06x}", now_unix_ms(), instance_tag()),
            method: method.into(),
            params,
        }
    }
}

/// 24 random bits chosen once per process.
fn instance_tag() -> u32 {
    use std::hash::{BuildHasher, Hasher};
    static TAG: std::sync::OnceLock<u32> = std::sync::OnceLock::new();
    *TAG.get_or_init(|| {
        // RandomState is seeded from the OS; mix in the pid and the time for good measure.
        let mut hasher = std::collections::hash_map::RandomState::new().build_hasher();
        hasher.write_u32(std::process::id());
        hasher.write_u64(now_unix_ms());
        (hasher.finish() & 0x00ff_ffff) as u32
    })
}

#[derive(Debug, Clone)]
pub struct ReadResult {
    pub value: U256,
    pub receipt: Receipt,
}

#[derive(Debug, Clone)]
pub struct CodeRead {
    pub code: Bytes,
    pub receipt: Receipt,
}

/// Receipt warning code: the root was cross-checked with a light client in the browser.
pub const BROWSER_LIGHT_CLIENT: &str = "BROWSER_LIGHT_CLIENT";

/// What a client-fetched proof claims to be (`veriq_verifyProof`).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProofKind {
    Balance,
    Nonce,
    Code,
    Storage(U256),
}

impl From<ProofKind> for ReadKind {
    fn from(kind: ProofKind) -> Self {
        match kind {
            ProofKind::Balance => Self::Balance,
            ProofKind::Nonce => Self::Nonce,
            ProofKind::Code => Self::Code,
            ProofKind::Storage(slot) => Self::Storage(slot),
        }
    }
}

/// A proof the client fetched itself, through Anon-RPC, at the block `veriq_getRoot` gave it.
/// The engine trusts none of it: the proof is checked against the engine's own pinned root.
#[derive(Debug, Clone)]
pub struct ClientProof {
    pub kind: ProofKind,
    pub address: Address,
    /// The block the client says it fetched at; only used to detect a root that moved.
    pub block_hash: B256,
    /// The raw `eth_getProof` result.
    pub proof: Value,
    /// `eth_getCode` result, for `ProofKind::Code`.
    pub code: Option<Bytes>,
    /// Provider label for the receipt (validated: 1-64 of letters, digits, `_`, `-`, `.`).
    pub provider: String,
    /// Anon-RPC network name for the receipt, e.g. `nox` (same character rules).
    pub network: String,
    pub elapsed_ms: u64,
    /// The finalized block a light client in the browser reported (S4.2). Optional; when
    /// present it must be exactly the engine's pinned block, else the read fails closed.
    pub browser_root: Option<BrowserRoot>,
}

/// A finalized block as seen by a light client running in the client's browser.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BrowserRoot {
    pub number: u64,
    pub hash: B256,
    pub state_root: B256,
}

#[derive(Debug, Clone)]
pub struct ClientRead {
    /// Hex: a 32-byte word for balance/nonce/storage, the bytecode for code.
    pub value: String,
    pub receipt: Receipt,
}

/// What the startup probe learned about a provider (crates/router/src/probe.rs).
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ProbeStatus {
    pub chain_ok: bool,
    pub proof_support: bool,
    pub eip1898: bool,
}

impl ProbeStatus {
    /// Routable: right chain and serves eth_getProof.
    pub const fn eligible(&self) -> bool {
        self.chain_ok && self.proof_support
    }

    /// `None` when the probe never reached the provider (no chain id): that is not
    /// a verdict, so it must not change what the engine believes about the provider.
    pub fn from_capabilities(caps: &veriq_router::probe::ProviderCapabilities) -> Option<Self> {
        caps.chain_id()?;
        Some(Self {
            chain_ok: caps.chain_ok(),
            proof_support: caps.supports_get_proof(),
            eip1898: caps.supports_block_hash(),
        })
    }
}

#[derive(Debug, Clone, Default)]
struct ProviderStats {
    ok: u64,
    failed: u64,
    last_error: Option<String>,
}

/// Per-provider health for `veriq_getProviderHealth` and `GET /health`.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderHealth {
    pub name: String,
    /// False capability booleans are fail-closed when `capability_status` is unavailable.
    pub capability_status: &'static str,
    pub chain_ok: bool,
    pub proof_support: bool,
    pub eip1898: bool,
    pub transport: Transport,
    pub breaker: BreakerHealth,
    pub success_rate: Option<f64>,
    pub last_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BreakerHealth {
    pub state: &'static str,
    /// Unix milliseconds when the cooldown ends.
    pub cooldown_until: Option<u64>,
    pub cooldown_remaining_ms: u64,
    pub reason: Option<CooldownReason>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
enum ReadKind {
    Balance,
    Nonce,
    Code,
    Storage(U256),
}

impl ReadKind {
    fn mechanisms(self) -> Vec<Mechanism> {
        match self {
            Self::Balance | Self::Nonce => vec![Mechanism::AccountProof],
            Self::Code => vec![Mechanism::AccountProof, Mechanism::CodeHash],
            Self::Storage(_) => vec![Mechanism::AccountProof, Mechanism::StorageProof],
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum ReadValue {
    Word(U256),
    Code(Bytes),
}

impl ReadValue {
    fn to_hex(&self) -> String {
        match self {
            Self::Word(value) => format!("{value:#x}"),
            Self::Code(code) => format!("0x{}", hex::encode(code)),
        }
    }

    fn size_bytes(&self) -> usize {
        match self {
            Self::Word(_) => 32,
            Self::Code(code) => code.len(),
        }
    }
}

/// Env var that turns the verified-result cache on (`1`). Off by default so the
/// attack demo and `scripts/e2e.sh` always reach the providers.
pub const VERIFIED_CACHE_ENV: &str = "VERIQ_VERIFIED_CACHE";

/// Env var: seconds between re-probes of ineligible providers (default 300, `0` = off).
pub const REPROBE_INTERVAL_ENV: &str = "VERIQ_REPROBE_SECS";
pub const DEFAULT_REPROBE_INTERVAL: Duration = Duration::from_secs(300);

/// Env var: seconds between background root refreshes (default 12, `0` = no root cache).
pub const ROOT_REFRESH_ENV: &str = "VERIQ_ROOT_REFRESH_SECS";
pub const DEFAULT_ROOT_REFRESH: Duration = Duration::from_secs(12);

/// Receipt persistence is best-effort (docs/SERVICES.md, "Receipt persistence"):
/// the proof decides the answer, the store is the audit trail. A write that has not
/// finished after this long is abandoned (its transaction rolls back) and logged, so
/// a slow or unreachable database never delays or fails a verified answer.
pub const RECEIPT_WRITE_TIMEOUT: Duration = Duration::from_secs(2);
const VERIFIED_CACHE_MAX_ENTRIES: usize = 10_000;
const VERIFIED_CACHE_MAX_BYTES: usize = 32 * 1024 * 1024;
const VERIFIED_CACHE_MAX_ENTRY_BYTES: usize = 1024 * 1024; // 1 MiB

/// Values that already passed proof verification against ONE finalized block.
///
/// A finalized block never changes, so a value proven against its state root stays
/// true for that block. Only values from a verified root source are inserted (never
/// claimed values, errors or `unverified` results), and the whole cache is dropped
/// as soon as a newer finalized block is pinned.
#[derive(Debug, Default)]
struct VerifiedCache {
    block: Option<(u64, B256)>,
    entries: HashMap<(Address, ReadKind), (ReadValue, String)>,
    bytes: usize,
}

impl VerifiedCache {
    fn get(
        &self,
        root: &PinnedRoot,
        address: Address,
        kind: ReadKind,
    ) -> Option<(ReadValue, String)> {
        if self.block != Some((root.number, root.hash)) {
            return None;
        }
        self.entries.get(&(address, kind)).cloned()
    }

    fn insert(
        &mut self,
        root: &PinnedRoot,
        address: Address,
        kind: ReadKind,
        value: ReadValue,
        label: &str,
    ) {
        match self.block {
            // A slow request pinned to an older block must not evict the newer one.
            Some((number, _)) if root.number < number => return,
            Some(block) if block == (root.number, root.hash) => {}
            _ => {
                self.entries.clear();
                self.bytes = 0;
                self.block = Some((root.number, root.hash));
            }
        }
        let size = value.size_bytes();
        if size > VERIFIED_CACHE_MAX_ENTRY_BYTES || size > VERIFIED_CACHE_MAX_BYTES {
            return;
        }
        if self.entries.len() >= VERIFIED_CACHE_MAX_ENTRIES
            || self.bytes.saturating_add(size) > VERIFIED_CACHE_MAX_BYTES
        {
            self.entries.clear();
            self.bytes = 0;
        }
        if let Some((old, _)) = self
            .entries
            .insert((address, kind), (value, label.to_owned()))
        {
            self.bytes = self.bytes.saturating_sub(old.size_bytes());
        }
        self.bytes = self.bytes.saturating_add(size);
    }
}

#[derive(Clone)]
pub struct Engine {
    root: Arc<dyn RootSourceProvider>,
    providers: Vec<ProviderConfig>,
    /// Shared by all clones so a re-probe is seen by every request.
    probes: Arc<RwLock<Vec<Option<ProbeStatus>>>>,
    proofs: Arc<dyn ProofFetcher>,
    breaker: Arc<CircuitBreaker>,
    stats: Arc<Mutex<HashMap<String, ProviderStats>>>,
    store: Arc<dyn ReceiptStore>,
    cache: Option<Arc<Mutex<VerifiedCache>>>,
}

impl Engine {
    pub fn new(root: Arc<dyn RootSourceProvider>, providers: Vec<ProviderConfig>) -> Self {
        Self::with_fetcher(root, providers, Arc::new(ProofClient::new()))
    }

    pub fn with_fetcher(
        root: Arc<dyn RootSourceProvider>,
        providers: Vec<ProviderConfig>,
        proofs: Arc<dyn ProofFetcher>,
    ) -> Self {
        let probes = Arc::new(RwLock::new(vec![None; providers.len()]));
        Self {
            root,
            providers,
            probes,
            proofs,
            breaker: Arc::new(CircuitBreaker::default()),
            stats: Arc::default(),
            store: Arc::new(InMemoryReceiptStore::new()),
            cache: None,
        }
    }

    /// Serve repeat reads at the same finalized block from already-verified values
    /// (see `VerifiedCache`). Only `consistency: single` reads use it.
    #[must_use]
    pub fn with_verified_cache(mut self, enabled: bool) -> Self {
        self.cache = enabled.then(Arc::default);
        self
    }

    /// Replace the default process-local receipt store with a shared backend.
    #[must_use]
    pub fn with_store(mut self, store: Arc<dyn ReceiptStore>) -> Self {
        self.store = store;
        self
    }

    /// Attach startup-probe results (same order as the providers). Providers on the
    /// wrong chain or without eth_getProof are never routed to. `None` means the probe
    /// could not reach the provider: it stays routable (its proofs are still verified
    /// and the circuit breaker cools it down if it keeps failing), so one transient
    /// timeout at startup cannot remove an honest provider for the engine's lifetime.
    #[must_use]
    pub fn with_probes(self, probes: Vec<Option<ProbeStatus>>) -> Self {
        {
            let mut stored = self.write_probes();
            for (index, probe) in probes.into_iter().enumerate().take(stored.len()) {
                if probe.is_some() {
                    stored[index] = probe;
                }
            }
        }
        self
    }

    /// Probe every provider marked ineligible again, and make it routable when the
    /// new probe reaches it and finds the right chain and eth_getProof. Fail closed:
    /// an unreachable or still-failing provider stays ineligible. Eligible and
    /// never-probed providers are left alone (the circuit breaker covers those).
    /// Returns how many providers became routable.
    pub async fn reprobe_ineligible(&self) -> usize {
        let ineligible: Vec<usize> = self
            .probe_snapshot()
            .iter()
            .enumerate()
            .filter(|(_, probe)| probe.is_some_and(|p| !p.eligible()))
            .map(|(index, _)| index)
            .collect();
        let mut recovered = 0;
        for index in ineligible {
            let provider = &self.providers[index];
            let caps = veriq_router::probe::probe_endpoint(&provider.label, &provider.url).await;
            let Some(status) = ProbeStatus::from_capabilities(&caps) else {
                continue;
            };
            self.write_probes()[index] = Some(status);
            if status.eligible() {
                recovered += 1;
                tracing::info!(
                    provider = %crate::logging::redact_sensitive(&provider.label),
                    "provider passed the re-probe and is routable again"
                );
            }
        }
        recovered
    }

    fn probe_snapshot(&self) -> Vec<Option<ProbeStatus>> {
        self.probes
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone()
    }

    fn write_probes(&self) -> std::sync::RwLockWriteGuard<'_, Vec<Option<ProbeStatus>>> {
        self.probes
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    /// Clear every provider's circuit-breaker state (demo builds only, via the
    /// loopback-only `POST /admin/reset-breakers`). Returns how many were cooling down.
    pub fn reset_breakers(&self) -> usize {
        self.breaker.reset()
    }

    #[cfg(test)]
    pub(crate) fn breaker_for_test(&self) -> &CircuitBreaker {
        &self.breaker
    }

    pub fn provider_count(&self) -> usize {
        self.providers.len()
    }

    pub fn bootstrap(&self) -> Bootstrap {
        self.root.bootstrap()
    }

    pub fn root_source(&self) -> RootSource {
        self.root.source()
    }

    /// The root cache's state, or `None` when the root source has no cache in front.
    pub fn root_cache_status(&self) -> Option<veriq_light_client::RootCacheStatus> {
        self.root.cache_status()
    }

    /// The light client's latest head block, for display (head lag). Never used for reads.
    pub async fn head_number(&self) -> Option<u64> {
        self.root.head_number().await
    }

    pub fn store(&self) -> &dyn ReceiptStore {
        self.store.as_ref()
    }

    pub async fn root_status(&self) -> Result<(RootSource, PinnedRoot), VeriqError> {
        let root = self.root.current_root().await?;
        Ok((self.root.source(), root))
    }

    pub fn provider_health(&self) -> Vec<ProviderHealth> {
        let names: Vec<String> = self.providers.iter().map(|p| p.label.clone()).collect();
        let snapshots = self.breaker.snapshot(&names);
        let probes = self.probe_snapshot();
        let stats = self.lock_stats();
        let now = now_unix_ms();
        self.providers
            .iter()
            .zip(&probes)
            .zip(snapshots)
            .map(|((provider, probe), snap)| {
                let s = stats.get(&provider.label).cloned().unwrap_or_default();
                let total = s.ok + s.failed;
                let open = snap.cooldown_remaining_ms > 0;
                let capability_status = if probe.is_some() {
                    "available"
                } else {
                    "unavailable"
                };
                // Unknown capabilities are not reported as success. The status field
                // distinguishes a failed/unavailable probe from a negative result.
                let probe = probe.unwrap_or(ProbeStatus {
                    chain_ok: false,
                    proof_support: false,
                    eip1898: false,
                });
                ProviderHealth {
                    name: crate::logging::redact_sensitive(&provider.label),
                    capability_status,
                    chain_ok: probe.chain_ok,
                    proof_support: probe.proof_support,
                    eip1898: probe.eip1898,
                    transport: Transport::Direct,
                    breaker: BreakerHealth {
                        state: if open { "open" } else { "closed" },
                        cooldown_until: open.then(|| now + snap.cooldown_remaining_ms),
                        cooldown_remaining_ms: snap.cooldown_remaining_ms,
                        reason: snap.cooldown_reason,
                    },
                    success_rate: (total > 0).then(|| s.ok as f64 / total as f64),
                    last_error: s.last_error,
                }
            })
            .collect()
    }

    // -------------------------------------------------------------- public reads
    // Without an explicit policy every read uses `Policy::VERIFIED_FINALIZED`.

    pub async fn read_balance(
        &self,
        request: RequestMeta,
        address: Address,
    ) -> Result<ReadResult, VeriqError> {
        self.read_balance_with(request, address, &Policy::default())
            .await
    }

    pub async fn read_balance_with(
        &self,
        request: RequestMeta,
        address: Address,
        policy: &Policy,
    ) -> Result<ReadResult, VeriqError> {
        let (value, receipt) = self
            .route(&request, policy, address, ReadKind::Balance)
            .await?;
        Ok(ReadResult {
            value: word(value),
            receipt,
        })
    }

    pub async fn read_nonce(
        &self,
        request: RequestMeta,
        address: Address,
    ) -> Result<ReadResult, VeriqError> {
        let (value, receipt) = self
            .route(&request, &Policy::default(), address, ReadKind::Nonce)
            .await?;
        Ok(ReadResult {
            value: word(value),
            receipt,
        })
    }

    pub async fn read_code(
        &self,
        request: RequestMeta,
        address: Address,
    ) -> Result<CodeRead, VeriqError> {
        let (value, receipt) = self
            .route(&request, &Policy::default(), address, ReadKind::Code)
            .await?;
        let code = match value {
            ReadValue::Code(code) => code,
            ReadValue::Word(_) => Bytes::new(),
        };
        Ok(CodeRead { code, receipt })
    }

    pub async fn read_storage(
        &self,
        request: RequestMeta,
        address: Address,
        slot: U256,
    ) -> Result<ReadResult, VeriqError> {
        self.read_storage_with(request, address, slot, &Policy::default())
            .await
    }

    pub async fn read_storage_with(
        &self,
        request: RequestMeta,
        address: Address,
        slot: U256,
        policy: &Policy,
    ) -> Result<ReadResult, VeriqError> {
        let (value, receipt) = self
            .route(&request, policy, address, ReadKind::Storage(slot))
            .await?;
        Ok(ReadResult {
            value: word(value),
            receipt,
        })
    }

    // -------------------------------------------------------------- routing

    /// One read, start to finish, recorded in the receipt store either way.
    async fn route(
        &self,
        request: &RequestMeta,
        policy: &Policy,
        address: Address,
        kind: ReadKind,
    ) -> Result<(ReadValue, Receipt), VeriqError> {
        let (result, attempts) = self.route_inner(request, policy, address, kind).await;
        self.record(request, address, kind, &result, attempts).await;
        result
    }

    /// Stores a read's receipt (or its error) in the receipt store. Best-effort: the answer,
    /// with its receipt inline, is returned whatever happens here.
    async fn record(
        &self,
        request: &RequestMeta,
        address: Address,
        kind: ReadKind,
        result: &Result<(ReadValue, Receipt), VeriqError>,
        attempts: Vec<RoutingAttempt>,
    ) {
        let slot = match kind {
            ReadKind::Storage(slot) => Some(format!("{slot:#066x}")),
            _ => None,
        };
        let stored = StoredReceipt {
            id: request.id.clone(),
            created_at: now_unix_ms(),
            method: request.method.clone(),
            params: StoredParams {
                address: Some(format!("{address:#x}")),
                slot,
            },
            value: result.as_ref().ok().map(|(v, _)| v.to_hex()),
            block_number: result.as_ref().ok().map(|(_, r)| r.block.number),
            receipt: result.as_ref().ok().map(|(_, r)| r.clone()),
            error: result.as_ref().err().map(StoredError::from),
            attempts: match result {
                Ok((_, receipt)) => receipt.routing.attempts.clone(),
                Err(_) => attempts,
            },
        };
        match tokio::time::timeout(RECEIPT_WRITE_TIMEOUT, self.store.insert(stored)).await {
            Ok(Ok(())) => {}
            // The store keeps the earlier receipt with this id (never overwritten).
            Ok(Err(crate::store::StoreError::DuplicateId)) => tracing::error!(
                request_id = %request.id,
                "receipt id already stored; the earlier receipt was kept"
            ),
            Ok(Err(err)) => tracing::error!(
                request_id = %request.id,
                error = %err,
                "receipt could not be persisted"
            ),
            Err(_) => tracing::error!(
                request_id = %request.id,
                timeout_ms = RECEIPT_WRITE_TIMEOUT.as_millis() as u64,
                "receipt could not be persisted: storage did not answer in time"
            ),
        }
    }

    // ------------------------------------------------- client-fetched proofs

    /// The finalized root this engine verifies against right now (`veriq_getRoot`). A client
    /// that fetches its own proofs (Anon-RPC) asks for exactly this block.
    pub async fn pinned_root(&self) -> Result<(PinnedRoot, RootSource), VeriqError> {
        self.pinned().await
    }

    /// Verifies a proof the client fetched through Anon-RPC (`veriq_verifyProof`). Same
    /// checks as a provider read, against the engine's own pinned root; no provider is
    /// contacted, so this read's provider traffic never came from this machine.
    pub async fn verify_client_proof(
        &self,
        request: RequestMeta,
        input: ClientProof,
        policy: &Policy,
    ) -> Result<ClientRead, VeriqError> {
        let kind = ReadKind::from(input.kind);
        let mut attempts = Vec::new();
        let result = self
            .verify_client_proof_inner(&request, &input, kind, policy, &mut attempts)
            .await;
        self.record(&request, input.address, kind, &result, attempts)
            .await;
        result.map(|(value, receipt)| ClientRead {
            value: value.to_hex(),
            receipt,
        })
    }

    async fn verify_client_proof_inner(
        &self,
        request: &RequestMeta,
        input: &ClientProof,
        kind: ReadKind,
        policy: &Policy,
        attempts: &mut Vec<RoutingAttempt>,
    ) -> Result<(ReadValue, Receipt), VeriqError> {
        // The private path satisfies privacy=required; everything else is checked as usual.
        policy.validate()?;
        if policy.block_policy == BlockPolicy::Latest {
            return Err(VeriqError::unsupported_verification(
                "this engine only serves finalized blocks",
            ));
        }
        for (what, label) in [("provider", &input.provider), ("network", &input.network)] {
            if !veriq_router::probe::valid_provider_name(label) {
                return Err(VeriqError::invalid_request(format!(
                    "{what} label must be 1-64 letters, digits, '_', '-' or '.'"
                )));
            }
        }
        let (root, source) = self.pinned().await?;
        if input.block_hash != root.hash {
            // Not an attack signal: the finalized block moved between veriq_getRoot and now.
            return Err(VeriqError::invalid_request(format!(
                "proof was fetched for block {:#x}; the pinned finalized block is now #{} {:#x}: \
                 call veriq_getRoot and fetch again",
                input.block_hash, root.number, root.hash
            )));
        }
        if let Some(browser) = &input.browser_root {
            // Two trusted roots for the read: they must be the same block, or nothing is
            // verified. Neither side is picked.
            if browser.hash != input.block_hash {
                return Err(VeriqError::invalid_request(
                    "browserRoot.hash must be the blockHash the proof was fetched at",
                ));
            }
            if browser.number != root.number || browser.state_root != root.state_root {
                return Err(VeriqError::root_mismatch(format!(
                    "the browser light client reports block #{} with state root {:#x}; the \
                     engine's light client has #{} {:#x} with state root {:#x}",
                    browser.number, browser.state_root, root.number, root.hash, root.state_root
                )));
            }
        }
        let label = format!("{}@anon-rpc:{}", input.provider, input.network);
        let started = Instant::now();
        let verified = parse_proof_result(&input.proof).and_then(|bundle| {
            Self::verify_bundle(&bundle, input.code.clone(), input.address, kind, &root)
        });
        let mut attempt = attempt_record(&label, started, verified.as_ref().err());
        attempt.elapsed_ms = input.elapsed_ms;
        attempts.push(attempt);
        let value = verified?;

        let mut warnings = Vec::new();
        if input.browser_root.is_some() {
            // Additive marker (no enum change): rootSource stays local-light-client.
            warnings.push(Warning {
                code: BROWSER_LIGHT_CLIENT.to_string(),
                message: format!(
                    "a light client in the browser, synced over {}, produced this same \
                     finalized block and state root",
                    input.network
                ),
            });
        }
        if policy.consistency == Consistency::Compare {
            warnings.push(Warning {
                code: "COMPARE_UNAVAILABLE".to_string(),
                message: "a client-fetched proof comes from one provider; nothing was compared"
                    .to_string(),
            });
        }
        let receipt = receipt(
            request,
            &root,
            source,
            kind.mechanisms(),
            &json!(value.to_hex()),
            ReceiptRouting {
                attempts: attempts.clone(),
                provider_label: &label,
                comparison: Comparison::NotRun,
            },
            &self.root.bootstrap(),
            warnings,
            Privacy {
                transport: Transport::AnonRpc,
                mechanism: Some(input.network.clone()),
            },
        );
        Ok((value, receipt))
    }

    async fn route_inner(
        &self,
        request: &RequestMeta,
        policy: &Policy,
        address: Address,
        kind: ReadKind,
    ) -> (
        Result<(ReadValue, Receipt), VeriqError>,
        Vec<RoutingAttempt>,
    ) {
        // Fail closed before any network call.
        if let Err(err) = preflight(policy) {
            return (Err(err), Vec::new());
        }
        let deadline = Instant::now() + Duration::from_millis(policy.timeout_ms);

        // Pin the root once: every attempt uses the SAME block and the SAME policy.
        let (root, source) = match self.pinned().await {
            Ok(pinned) => pinned,
            Err(err) => return (Err(err), Vec::new()),
        };

        let cacheable = policy.consistency == Consistency::Single && source.is_verified();
        if cacheable {
            if let Some((value, provider_label)) = self.cache_get(&root, address, kind) {
                tracing::debug!(cache = "hit", "read served from verified cache");
                let mut warnings = vec![Warning {
                    code: "VERIFIED_CACHE_HIT".to_string(),
                    message: "value was proven earlier against this same finalized block; \
                              no provider was contacted"
                        .to_string(),
                }];
                warnings.extend(policy_warnings(policy, Comparison::NotRun));
                let receipt = receipt(
                    request,
                    &root,
                    source,
                    kind.mechanisms(),
                    &json!(value.to_hex()),
                    ReceiptRouting {
                        attempts: Vec::new(),
                        provider_label: &provider_label,
                        comparison: Comparison::NotRun,
                    },
                    &self.root.bootstrap(),
                    warnings,
                    DIRECT,
                );
                return (Ok((value, receipt)), Vec::new());
            }
        }

        let mut attempts = Vec::new();
        let mut first: Option<(ReadValue, String)> = None;
        let mut comparison = Comparison::NotRun;
        let mut last_error: Option<VeriqError> = None;
        let mut timed_out = false;
        let mut skipped = 0usize;

        let probes = self.probe_snapshot();
        for (configured, probe) in self.providers.iter().zip(&probes) {
            if attempts.len() >= MAX_PROVIDER_ATTEMPTS {
                break;
            }
            if probe.is_some_and(|p| !p.eligible()) || !self.breaker.is_eligible(&configured.label)
            {
                skipped += 1;
                continue;
            }
            // The latest probe decides whether the blockHash form is tried.
            let with_probe;
            let provider = match probe {
                Some(p) if p.eip1898 != configured.eip1898 => {
                    with_probe = ProviderConfig {
                        eip1898: p.eip1898,
                        ..configured.clone()
                    };
                    &with_probe
                }
                _ => configured,
            };
            let Some(remaining) = deadline.checked_duration_since(Instant::now()) else {
                timed_out = true;
                break;
            };
            let started = Instant::now();
            let outcome =
                tokio::time::timeout(remaining, self.fetch_one(provider, address, kind, &root))
                    .await
                    .unwrap_or_else(|_| {
                        Err(VeriqError::provider_timeout(format!(
                            "deadline of {} ms reached",
                            policy.timeout_ms
                        )))
                    });
            match outcome {
                Ok(value) => {
                    self.breaker.record_successful_transport(&provider.label);
                    self.record_stat(&provider.label, None);
                    attempts.push(attempt_record(&provider.label, started, None));
                    match &first {
                        None => {
                            first = Some((value, provider.label.clone()));
                            if policy.consistency == Consistency::Single {
                                break;
                            }
                        }
                        Some((first_value, _)) => {
                            // Agreement is recorded as a signal; both values are already proven.
                            comparison = if *first_value == value {
                                Comparison::Agree
                            } else {
                                Comparison::Divergent
                            };
                            break;
                        }
                    }
                }
                Err(err) => {
                    if err.code() == ErrorCode::InvalidProof {
                        self.breaker.record_invalid_proof(&provider.label);
                    } else {
                        self.breaker.record_transport_failure(&provider.label);
                    }
                    if err.code() == ErrorCode::ProviderTimeout && Instant::now() >= deadline {
                        timed_out = true;
                    }
                    tracing::warn!(
                        provider = %crate::logging::redact_sensitive(&provider.label),
                        code = err.code_str(),
                        "provider attempt rejected"
                    );
                    self.record_stat(&provider.label, Some(&err));
                    attempts.push(attempt_record(&provider.label, started, Some(&err)));
                    last_error = Some(err);
                    if timed_out {
                        break;
                    }
                }
            }
        }

        let Some((value, provider_label)) = first else {
            let err = if timed_out {
                VeriqError::provider_timeout(format!(
                    "no valid proof within the {} ms deadline",
                    policy.timeout_ms
                ))
            } else if attempts.is_empty() && skipped > 0 {
                VeriqError::all_providers_failed(format!(
                    "all {skipped} providers are ineligible or cooling down"
                ))
            } else if !attempts.is_empty()
                && attempts
                    .iter()
                    .all(|a| a.outcome == AttemptOutcome::InvalidProof)
            {
                // Every proof failed verification: that is INVALID_PROOF, not a transport problem.
                VeriqError::invalid_proof(format!(
                    "all {} attempted proofs failed verification",
                    attempts.len()
                ))
            } else {
                all_providers_failed(attempts.len(), last_error.as_ref())
            };
            return (Err(err), attempts);
        };

        if cacheable {
            self.cache_insert(&root, address, kind, &value, &provider_label);
        }
        let warnings = policy_warnings(policy, comparison);
        let receipt = receipt(
            request,
            &root,
            source,
            kind.mechanisms(),
            &json!(value.to_hex()),
            ReceiptRouting {
                attempts: attempts.clone(),
                provider_label: &provider_label,
                comparison,
            },
            &self.root.bootstrap(),
            warnings,
            DIRECT,
        );
        (Ok((value, receipt)), attempts)
    }

    async fn fetch_one(
        &self,
        provider: &ProviderConfig,
        address: Address,
        kind: ReadKind,
        root: &PinnedRoot,
    ) -> Result<ReadValue, VeriqError> {
        let slots: Vec<U256> = match kind {
            ReadKind::Storage(slot) => vec![slot],
            _ => Vec::new(),
        };
        let fetch_started = Instant::now();
        // eth_getCode does not depend on the proof, so both go out at once, pinned to
        // the same block: one round-trip instead of two. Nothing is trusted until the
        // account proof verifies and keccak256(code) matches the PROVEN codeHash.
        let (bundle, code) = if kind == ReadKind::Code {
            let (bundle, code) = tokio::try_join!(
                self.proofs.get_proof(provider, address, &slots, root),
                self.proofs.get_code(provider, address, root),
            )?;
            (bundle, Some(code))
        } else {
            (
                self.proofs
                    .get_proof(provider, address, &slots, root)
                    .await?,
                None,
            )
        };
        let fetch_ms = fetch_started.elapsed().as_millis();
        let verify_started = Instant::now();
        let result = Self::verify_bundle(&bundle, code, address, kind, root);
        tracing::debug!(
            fetch_ms = u64::try_from(fetch_ms).unwrap_or(u64::MAX),
            verify_us = u64::try_from(verify_started.elapsed().as_micros()).unwrap_or(u64::MAX),
            ok = result.is_ok(),
            "provider attempt timings"
        );
        result
    }

    fn verify_bundle(
        bundle: &ProofBundle,
        code: Option<Bytes>,
        address: Address,
        kind: ReadKind,
        root: &PinnedRoot,
    ) -> Result<ReadValue, VeriqError> {
        // The provider's claimed account is checked, but only the PROVEN account is used.
        let proven = verify_account(
            root.state_root,
            address,
            &bundle.account_proof,
            Some(bundle.account),
        )?;
        match kind {
            ReadKind::Balance => Ok(ReadValue::Word(proven.account.balance)),
            ReadKind::Nonce => Ok(ReadValue::Word(U256::from(proven.account.nonce))),
            ReadKind::Code => {
                let code = code.ok_or_else(|| VeriqError::invalid_proof("code was not fetched"))?;
                if keccak256(&code) != proven.account.code_hash {
                    return Err(VeriqError::invalid_proof(
                        "code hash does not match proven account",
                    ));
                }
                Ok(ReadValue::Code(code))
            }
            ReadKind::Storage(slot) => {
                let storage = bundle
                    .storage_proofs
                    .iter()
                    .find(|proof| proof.key == slot)
                    .ok_or_else(|| {
                        VeriqError::invalid_proof("provider omitted the requested storage slot")
                    })?;
                let proven_value =
                    verify_storage(proven.account.storage_root, slot, &storage.proof)?;
                if proven_value != storage.value {
                    return Err(VeriqError::invalid_proof(
                        "claimed storage value does not match proven value",
                    ));
                }
                Ok(ReadValue::Word(proven_value))
            }
        }
    }

    fn cache_get(
        &self,
        root: &PinnedRoot,
        address: Address,
        kind: ReadKind,
    ) -> Option<(ReadValue, String)> {
        let cache = self.cache.as_ref()?;
        cache
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(root, address, kind)
    }

    fn cache_insert(
        &self,
        root: &PinnedRoot,
        address: Address,
        kind: ReadKind,
        value: &ReadValue,
        provider_label: &str,
    ) {
        if let Some(cache) = &self.cache {
            cache
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .insert(root, address, kind, value.clone(), provider_label);
        }
    }

    async fn pinned(&self) -> Result<(PinnedRoot, RootSource), VeriqError> {
        let root = self
            .root
            .current_root()
            .await
            .map_err(|err| VeriqError::root_unavailable(err.message().to_string()))?;
        Ok((root, self.root.source()))
    }

    fn record_stat(&self, provider: &str, err: Option<&VeriqError>) {
        let mut stats = self.lock_stats();
        let entry = stats.entry(provider.to_string()).or_default();
        match err {
            None => entry.ok += 1,
            Some(err) => {
                entry.failed += 1;
                entry.last_error = Some(err.code_str().to_owned());
            }
        }
    }

    fn lock_stats(&self) -> std::sync::MutexGuard<'_, HashMap<String, ProviderStats>> {
        self.stats
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

/// Policy checks that need no network: invalid or contradictory policies, and
/// guarantees this engine cannot give. Nothing is sent when these fail.
fn preflight(policy: &Policy) -> Result<(), VeriqError> {
    policy.validate()?;
    if policy.privacy == PrivacyPolicy::Required {
        return Err(VeriqError::privacy_unavailable(
            "privacy=required but no private-transport provider is configured; nothing was sent",
        ));
    }
    if policy.block_policy == BlockPolicy::Latest {
        return Err(VeriqError::unsupported_verification(
            "this engine only serves finalized blocks",
        ));
    }
    Ok(())
}

fn policy_warnings(policy: &Policy, comparison: Comparison) -> Vec<Warning> {
    let mut warnings = Vec::new();
    if policy.consistency == Consistency::Compare {
        match comparison {
            Comparison::NotRun => warnings.push(Warning {
                code: "COMPARE_UNAVAILABLE".to_string(),
                message: "no second provider answered with a valid proof".to_string(),
            }),
            Comparison::Divergent => warnings.push(Warning {
                code: "COMPARE_DIVERGENT".to_string(),
                message: "a second provider returned a different proven value at the same block; \
                          the first provider's value is returned"
                    .to_string(),
            }),
            Comparison::Agree => {}
        }
    }
    if policy.privacy == PrivacyPolicy::Preferred {
        warnings.push(Warning {
            code: "PRIVACY_DOWNGRADED".to_string(),
            message: "no private transport is available; the request was sent direct".to_string(),
        });
    }
    warnings
}

fn word(value: ReadValue) -> U256 {
    match value {
        ReadValue::Word(value) => value,
        ReadValue::Code(_) => U256::ZERO,
    }
}

fn all_providers_failed(count: usize, last: Option<&VeriqError>) -> VeriqError {
    match last {
        Some(err) => VeriqError::new(
            ErrorCode::AllProvidersFailed,
            format!(
                "all {count} providers failed; last error code: {}",
                err.code_str()
            ),
        ),
        None => {
            VeriqError::all_providers_failed(format!("no providers answered (configured {count})"))
        }
    }
}

/// Engine-fetched reads go to providers directly.
const DIRECT: Privacy = Privacy {
    transport: Transport::Direct,
    mechanism: None,
};

struct ReceiptRouting<'a> {
    attempts: Vec<RoutingAttempt>,
    provider_label: &'a str,
    comparison: Comparison,
}

#[allow(clippy::too_many_arguments)]
fn receipt(
    request: &RequestMeta,
    root: &PinnedRoot,
    source: RootSource,
    mechanisms: Vec<Mechanism>,
    result: &Value,
    routing: ReceiptRouting<'_>,
    bootstrap: &Bootstrap,
    mut warnings: Vec<Warning>,
    privacy: Privacy,
) -> Receipt {
    let status = if source.is_verified() {
        VerificationStatus::Verified
    } else {
        VerificationStatus::Unverified
    };
    if !source.is_verified() {
        warnings.push(Warning {
            code: "UNTRUSTED_ROOT_SOURCE".to_string(),
            message: "root did not come from a local light client or fixture".to_string(),
        });
    }
    // One clock read, so observedAt and ageSeconds describe the same instant.
    let observed_at = now_unix_ms() / 1000;

    Receipt {
        identity: Identity {
            request_id: request.id.clone(),
            method: request.method.clone(),
            request_binding: binding(&request.method, &request.params),
            result_binding: binding(&request.method, result),
        },
        block: Block {
            number: root.number,
            hash: root.hash,
            state_root: root.state_root,
            finalized: true,
        },
        verification: Verification {
            status,
            root_source: match source {
                RootSource::LocalLightClient => RootSourceKind::LocalLightClient,
                RootSource::Fixture => RootSourceKind::Fixture,
                RootSource::UntrustedRpc => RootSourceKind::UntrustedRpc,
                RootSource::Unavailable => RootSourceKind::UntrustedRpc,
            },
            verifier_location: VerifierLocation::LocalEngine,
            mechanisms,
            bootstrap: bootstrap.clone(),
        },
        privacy,
        routing: Routing {
            comparison: routing.comparison,
            providers_tried: u32::try_from(routing.attempts.len()).unwrap_or(u32::MAX),
            provider_label: Some(routing.provider_label.to_string()),
            attempts: routing.attempts,
        },
        freshness: veriq_core::receipt::Freshness {
            observed_at,
            age_seconds: root
                .timestamp
                .map_or(0, |ts| observed_at.saturating_sub(ts)),
            pinned: true,
        },
        warnings,
    }
}

/// One provider attempt for the receipt. Error messages are already URL-free.
fn attempt_record(provider: &str, started: Instant, err: Option<&VeriqError>) -> RoutingAttempt {
    let outcome = match err {
        None => AttemptOutcome::Success,
        Some(e) => match e.code() {
            ErrorCode::InvalidProof => AttemptOutcome::InvalidProof,
            ErrorCode::ProviderTimeout | ErrorCode::AllProvidersFailed => {
                AttemptOutcome::TransportFailure
            }
            _ => AttemptOutcome::ProviderError,
        },
    };
    RoutingAttempt {
        provider: provider.to_owned(),
        outcome,
        elapsed_ms: u64::try_from(started.elapsed().as_millis()).unwrap_or(u64::MAX),
        failure_reason: err.map(|e| format!("{}: provider attempt failed", e.code_str())),
    }
}

pub fn now_unix_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| u64::try_from(d.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or_default()
}

#[cfg(test)]
mod policy_warning_tests {
    use super::*;

    fn codes(policy: &Policy, comparison: Comparison) -> Vec<String> {
        policy_warnings(policy, comparison)
            .into_iter()
            .map(|warning| warning.code)
            .collect()
    }

    #[test]
    fn compare_mode_warns_on_divergent_and_missing_second_answer() {
        let compare = Policy {
            consistency: Consistency::Compare,
            privacy: PrivacyPolicy::Off,
            ..Policy::VERIFIED_FINALIZED
        };
        assert_eq!(
            codes(&compare, Comparison::Divergent),
            ["COMPARE_DIVERGENT"]
        );
        assert_eq!(codes(&compare, Comparison::NotRun), ["COMPARE_UNAVAILABLE"]);
        assert!(codes(&compare, Comparison::Agree).is_empty());

        let single = Policy {
            consistency: Consistency::Single,
            privacy: PrivacyPolicy::Off,
            ..Policy::VERIFIED_FINALIZED
        };
        assert!(codes(&single, Comparison::Divergent).is_empty());
    }
}

#[cfg(test)]
mod reprobe_tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use axum::{routing::post, Json, Router};
    use veriq_light_client::fixed::FixedRoot;

    use super::*;

    /// A Sepolia provider whose eth_getProof support can be switched on.
    async fn switchable_provider(serves_proofs: Arc<AtomicBool>) -> String {
        let app = Router::new().route(
            "/",
            post(move |Json(body): Json<Value>| {
                let serves_proofs = serves_proofs.clone();
                async move {
                    let result = match body["method"].as_str() {
                        Some("eth_chainId") => json!("0xaa36a7"),
                        Some("eth_getBlockByNumber") => json!({ "hash": format!("{:#x}", B256::repeat_byte(3)) }),
                        Some("eth_getProof") if serves_proofs.load(Ordering::SeqCst) => {
                            json!({ "accountProof": [] })
                        }
                        _ => {
                            return Json(json!({"jsonrpc":"2.0","id":1,"error":{"code":-32601,"message":"no"}}))
                        }
                    };
                    Json(json!({"jsonrpc":"2.0","id":1,"result":result}))
                }
            }),
        );
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
            .await
            .expect("bind");
        let addr = listener.local_addr().expect("addr");
        tokio::spawn(async move {
            let _ = axum::serve(listener, app).await;
        });
        format!("http://{addr}/")
    }

    fn engine_with(url: String) -> Engine {
        let root = FixedRoot::new(PinnedRoot::new(
            1,
            B256::repeat_byte(1),
            B256::repeat_byte(2),
        ));
        Engine::new(
            Arc::new(root),
            vec![ProviderConfig {
                label: "flaky".into(),
                url,
                eip1898: true,
            }],
        )
        .with_probes(vec![Some(ProbeStatus {
            chain_ok: true,
            proof_support: false,
            eip1898: false,
        })])
    }

    #[tokio::test]
    async fn recovered_provider_becomes_routable_without_restart() {
        let serves_proofs = Arc::new(AtomicBool::new(false));
        let engine = engine_with(switchable_provider(serves_proofs.clone()).await);
        assert!(!engine.provider_health()[0].proof_support);

        // Still failing: stays ineligible.
        assert_eq!(engine.reprobe_ineligible().await, 0);
        assert!(!engine.probe_snapshot()[0].expect("probed").eligible());

        // Recovered: the next re-probe makes it routable, for every clone of the engine.
        serves_proofs.store(true, Ordering::SeqCst);
        let clone = engine.clone();
        assert_eq!(engine.reprobe_ineligible().await, 1);
        let status = clone.probe_snapshot()[0].expect("probed");
        assert!(status.eligible());
        assert!(status.eip1898, "blockHash support is picked up too");
        assert!(clone.provider_health()[0].proof_support);
    }

    #[tokio::test]
    async fn unreachable_provider_stays_ineligible() {
        // Nothing listens on port 9 of loopback: the probe never gets a chain id.
        let engine = engine_with("http://127.0.0.1:9/".into());
        assert_eq!(engine.reprobe_ineligible().await, 0);
        let status = engine.probe_snapshot()[0].expect("still probed");
        assert!(
            !status.eligible(),
            "fail closed: an unreachable probe is not a pass"
        );
    }
}

#[cfg(test)]
mod request_id_tests {
    use super::*;

    #[test]
    fn request_ids_are_unique_valid_and_carry_one_instance_tag() {
        let ids: Vec<String> = (0..10_000)
            .map(|_| RequestMeta::new("veriq_readBalance", Value::Null).id)
            .collect();
        let unique: std::collections::HashSet<&String> = ids.iter().collect();
        assert_eq!(unique.len(), ids.len(), "no duplicates within one engine");

        let tag = format!("{:06x}", instance_tag());
        for id in &ids {
            assert!(crate::store::valid_receipt_id(id), "{id}");
            let parts: Vec<&str> = id.split('-').collect();
            assert_eq!(parts.len(), 3, "{id}");
            assert_eq!(parts[1], tag, "{id}");
        }
    }
}

#[cfg(test)]
mod breaker_tests {
    use alloy_primitives::B256;
    use veriq_light_client::fixed::FixedRoot;

    use super::*;

    fn engine(labels: &[&str]) -> Engine {
        let root = FixedRoot::new(PinnedRoot::new(
            1,
            B256::repeat_byte(1),
            B256::repeat_byte(2),
        ));
        // Nothing listens on port 9 of loopback: an attempt is a transport failure.
        let providers = labels
            .iter()
            .map(|label| ProviderConfig {
                label: (*label).to_owned(),
                url: "http://127.0.0.1:9/".to_owned(),
                eip1898: false,
            })
            .collect();
        Engine::new(Arc::new(root), providers)
    }

    fn read(
        engine: &Engine,
    ) -> impl std::future::Future<Output = Result<ReadResult, VeriqError>> + '_ {
        engine.read_balance(
            RequestMeta::new("veriq_readBalance", Value::Null),
            Address::ZERO,
        )
    }

    #[tokio::test]
    async fn every_provider_benched_is_all_providers_failed_until_reset() {
        let engine = engine(&["a", "b"]);
        engine.breaker.record_invalid_proof("a");
        engine.breaker.record_invalid_proof("b");

        let err = read(&engine).await.expect_err("nobody eligible");
        assert_eq!(err.code(), ErrorCode::AllProvidersFailed);
        assert!(err.message().contains("cooling down"), "{}", err.message());
        // Nothing was sent: no provider has a recorded attempt.
        assert!(engine
            .provider_health()
            .iter()
            .all(|p| p.last_error.is_none()));

        assert_eq!(engine.reset_breakers(), 2);
        let err = read(&engine).await.expect_err("both providers are down");
        assert_eq!(err.code(), ErrorCode::AllProvidersFailed);
        // After the reset both were tried again (and failed at transport).
        assert!(engine
            .provider_health()
            .iter()
            .all(|p| p.last_error.is_some()));
    }
}
