use std::{
    collections::BTreeMap,
    sync::{
        atomic::{AtomicUsize, Ordering},
        Arc,
    },
    time::Duration,
};

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_trie::{
    proof::ProofRetainer, HashBuilder, Nibbles, TrieAccount, EMPTY_ROOT_HASH, KECCAK_EMPTY,
};
use async_trait::async_trait;
use serde_json::json;
use veriq_core::{
    AttemptOutcome, ErrorCode, Mechanism, RootSourceKind, VerificationStatus, VeriqError,
};
use veriq_light_client::{
    cached::CachedRoot, fixed::FixedRoot, PinnedRoot, RootSource, RootSourceProvider,
};
use veriq_server::{
    engine::{Engine, RequestMeta, RECEIPT_WRITE_TIMEOUT},
    provider::{ProofBundle, ProofFetcher, ProviderConfig, StorageProof},
    rpc::dispatch,
    store::{PostgresReceiptStore, ReceiptStore, StoreError, StoredReceipt},
};

const BLOCK_NUMBER: u64 = 8_000_000;
const BLOCK_HASH: B256 = B256::repeat_byte(0x11);
const TARGET: Address = Address::repeat_byte(0x07);
const BALANCE: u64 = 1_234;
const SLOT_ZERO_VALUE: u64 = 42;
const SLOT_ONE_VALUE: u64 = 7;

struct MockProofs {
    bundle: ProofBundle,
    code: Bytes,
}

#[async_trait]
impl ProofFetcher for MockProofs {
    async fn get_proof(
        &self,
        _provider: &ProviderConfig,
        _address: Address,
        _slots: &[U256],
        _root: &PinnedRoot,
    ) -> Result<ProofBundle, veriq_core::VeriqError> {
        Ok(self.bundle.clone())
    }

    async fn get_code(
        &self,
        _provider: &ProviderConfig,
        _address: Address,
        _root: &PinnedRoot,
    ) -> Result<Bytes, veriq_core::VeriqError> {
        Ok(self.code.clone())
    }
}

fn storage_value_rlp(value: U256) -> Vec<u8> {
    let be = value.to_be_bytes::<32>();
    let first = be.iter().position(|byte| *byte != 0).unwrap_or(be.len());
    alloy_rlp::encode(&be[first..])
}

fn build_storage_trie(entries: &[(U256, U256)], target: U256) -> (B256, Vec<Bytes>) {
    let target_key = Nibbles::unpack(keccak256(target.to_be_bytes::<32>()));
    let mut sorted = BTreeMap::new();
    for (slot, value) in entries {
        sorted.insert(
            keccak256(slot.to_be_bytes::<32>()),
            storage_value_rlp(*value),
        );
    }

    let mut builder =
        HashBuilder::default().with_proof_retainer(ProofRetainer::new(vec![target_key]));
    for (hashed, value) in sorted {
        builder.add_leaf(Nibbles::unpack(hashed), &value);
    }
    let root = builder.root();
    let proof = builder
        .take_proof_nodes()
        .matching_nodes_sorted(&target_key)
        .into_iter()
        .map(|(_, node)| node)
        .collect();
    (root, proof)
}

fn build_account_trie(entries: &[(Address, TrieAccount)], target: Address) -> (B256, Vec<Bytes>) {
    let target_key = Nibbles::unpack(keccak256(target.as_slice()));
    let mut sorted = BTreeMap::new();
    for (address, account) in entries {
        sorted.insert(keccak256(address.as_slice()), alloy_rlp::encode(account));
    }

    let mut builder =
        HashBuilder::default().with_proof_retainer(ProofRetainer::new(vec![target_key]));
    for (hashed, value) in sorted {
        builder.add_leaf(Nibbles::unpack(hashed), &value);
    }
    let root = builder.root();
    let proof = builder
        .take_proof_nodes()
        .matching_nodes_sorted(&target_key)
        .into_iter()
        .map(|(_, node)| node)
        .collect();
    (root, proof)
}

fn fixture() -> (B256, ProofBundle) {
    fixture_with_code(Bytes::new())
}

fn fixture_with_code(code: Bytes) -> (B256, ProofBundle) {
    fixture_with_code_and_extra_account(code, false)
}

fn fixture_with_code_and_extra_account(code: Bytes, extra: bool) -> (B256, ProofBundle) {
    let (storage_root, storage_proof) = build_storage_trie(
        &[
            (U256::ZERO, U256::from(SLOT_ZERO_VALUE)),
            (U256::from(1), U256::from(SLOT_ONE_VALUE)),
        ],
        U256::ZERO,
    );
    let code_hash = keccak256(&code);
    let target_account = TrieAccount::new(1, U256::from(BALANCE), storage_root, code_hash);

    let last = if extra { 25 } else { 24 };
    let mut accounts: Vec<(Address, TrieAccount)> = (1u8..=last)
        .map(|byte| {
            (
                Address::repeat_byte(byte),
                TrieAccount::new(
                    0,
                    U256::from(u64::from(byte)),
                    EMPTY_ROOT_HASH,
                    KECCAK_EMPTY,
                ),
            )
        })
        .collect();
    accounts.push((TARGET, target_account));

    let (state_root, account_proof) = build_account_trie(&accounts, TARGET);
    let bundle = ProofBundle {
        account_proof,
        account: veriq_core::Account::new(1, U256::from(BALANCE), storage_root, code_hash),
        storage_proofs: vec![StorageProof {
            key: U256::ZERO,
            value: U256::from(SLOT_ZERO_VALUE),
            proof: storage_proof,
        }],
    };
    (state_root, bundle)
}

fn engine(state_root: B256, bundle: ProofBundle) -> Engine {
    engine_with_code(state_root, bundle, Bytes::new())
}

fn engine_with_code(state_root: B256, bundle: ProofBundle, code: Bytes) -> Engine {
    let root = FixedRoot::from_parts(BLOCK_NUMBER, BLOCK_HASH, state_root);
    Engine::with_fetcher(
        Arc::new(root),
        vec![ProviderConfig {
            label: "mock".to_string(),
            url: "http://127.0.0.1:1".to_string(),
            eip1898: true,
        }],
        Arc::new(MockProofs { bundle, code }),
    )
}

fn request(method: &str, params: serde_json::Value) -> RequestMeta {
    RequestMeta {
        id: "1".to_string(),
        method: method.to_string(),
        params,
    }
}

#[tokio::test]
async fn verified_balance_read_binds_receipt_to_fixture_root() {
    let (state_root, bundle) = fixture();
    let read = engine(state_root, bundle)
        .read_balance(
            request("veriq_readBalance", json!([format!("{TARGET:#x}")])),
            TARGET,
        )
        .await
        .expect("verified balance read");

    assert_eq!(read.value, U256::from(BALANCE));
    assert_eq!(
        read.receipt.verification.status,
        VerificationStatus::Verified
    );
    assert_eq!(
        read.receipt.verification.root_source,
        RootSourceKind::Fixture
    );
    assert_eq!(
        read.receipt.verification.mechanisms,
        vec![Mechanism::AccountProof]
    );
    assert_eq!(read.receipt.block.number, BLOCK_NUMBER);
    assert_eq!(read.receipt.block.hash, BLOCK_HASH);
    assert_eq!(read.receipt.block.state_root, state_root);
    assert!(read.receipt.block.finalized);
    assert_eq!(read.receipt.routing.provider_label.as_deref(), Some("mock"));
}

#[tokio::test]
async fn verified_storage_read_uses_account_then_storage_proof() {
    let (state_root, bundle) = fixture();
    let read = engine(state_root, bundle)
        .read_storage(
            request("veriq_readStorage", json!([format!("{TARGET:#x}"), "0x0"])),
            TARGET,
            U256::ZERO,
        )
        .await
        .expect("verified storage read");

    assert_eq!(read.value, U256::from(SLOT_ZERO_VALUE));
    assert_eq!(
        read.receipt.verification.status,
        VerificationStatus::Verified
    );
    assert_eq!(
        read.receipt.verification.mechanisms,
        vec![Mechanism::AccountProof, Mechanism::StorageProof]
    );
}

#[tokio::test]
async fn provider_lying_about_balance_is_rejected() {
    let (state_root, mut bundle) = fixture();
    bundle.account.balance = U256::from(BALANCE + 1);

    let err = engine(state_root, bundle)
        .read_balance(
            request("veriq_readBalance", json!([format!("{TARGET:#x}")])),
            TARGET,
        )
        .await
        .expect_err("tampered balance must be rejected");
    // Every attempted proof failed verification -> INVALID_PROOF (-32010), per the error table.
    assert_eq!(err.code(), ErrorCode::InvalidProof);
    assert!(err
        .message()
        .contains("all 1 attempted proofs failed verification"));
}

#[tokio::test]
async fn provider_lying_about_storage_value_is_rejected() {
    let (state_root, mut bundle) = fixture();
    bundle.storage_proofs[0].value = U256::from(SLOT_ZERO_VALUE + 1);

    let err = engine(state_root, bundle)
        .read_storage(
            request("veriq_readStorage", json!([format!("{TARGET:#x}"), "0x0"])),
            TARGET,
            U256::ZERO,
        )
        .await
        .expect_err("tampered storage value must be rejected");
    // Every attempted proof failed verification -> INVALID_PROOF (-32010), per the error table.
    assert_eq!(err.code(), ErrorCode::InvalidProof);
    assert!(err
        .message()
        .contains("all 1 attempted proofs failed verification"));
}

#[tokio::test]
async fn provider_omitting_requested_slot_is_rejected() {
    let (state_root, bundle) = fixture();
    let err = engine(state_root, bundle)
        .read_storage(
            request("veriq_readStorage", json!([format!("{TARGET:#x}"), "0x1"])),
            TARGET,
            U256::from(1),
        )
        .await
        .expect_err("missing requested slot must be rejected");
    // Every attempted proof failed verification -> INVALID_PROOF (-32010), per the error table.
    assert_eq!(err.code(), ErrorCode::InvalidProof);
    assert!(err
        .message()
        .contains("all 1 attempted proofs failed verification"));
}

#[tokio::test]
async fn verified_nonce_read_uses_proven_account() {
    let (state_root, bundle) = fixture();
    let read = engine(state_root, bundle)
        .read_nonce(
            request(
                "eth_getTransactionCount",
                json!([format!("{TARGET:#x}"), "finalized"]),
            ),
            TARGET,
        )
        .await
        .expect("verified nonce read");

    assert_eq!(read.value, U256::from(1));
    assert_eq!(
        read.receipt.verification.status,
        VerificationStatus::Verified
    );
    assert_eq!(
        read.receipt.verification.mechanisms,
        vec![Mechanism::AccountProof]
    );
}

#[tokio::test]
async fn verified_code_read_checks_keccak_against_account() {
    let code = Bytes::from_static(&[0x60, 0x00, 0x60, 0x00, 0xf3]);
    let (state_root, bundle) = fixture_with_code(code.clone());
    let read = engine_with_code(state_root, bundle, code.clone())
        .read_code(
            request("eth_getCode", json!([format!("{TARGET:#x}"), "finalized"])),
            TARGET,
        )
        .await
        .expect("verified code read");

    assert_eq!(read.code, code);
    assert_eq!(
        read.receipt.verification.mechanisms,
        vec![Mechanism::AccountProof, Mechanism::CodeHash]
    );
}

#[tokio::test]
async fn provider_lying_about_code_is_rejected() {
    let code = Bytes::from_static(&[0x60, 0x00, 0x60, 0x00, 0xf3]);
    let (state_root, bundle) = fixture_with_code(code);
    let err = engine_with_code(
        state_root,
        bundle,
        Bytes::from_static(&[0x60, 0x01, 0x60, 0x01, 0xf3]),
    )
    .read_code(
        request("eth_getCode", json!([format!("{TARGET:#x}"), "finalized"])),
        TARGET,
    )
    .await
    .expect_err("tampered code must be rejected");

    // Every attempted proof failed verification -> INVALID_PROOF (-32010), per the error table.
    assert_eq!(err.code(), ErrorCode::InvalidProof);
    assert!(err
        .message()
        .contains("all 1 attempted proofs failed verification"));
}

struct FailoverProofs {
    bad: ProofBundle,
    good: ProofBundle,
    code: Bytes,
}

#[async_trait]
impl ProofFetcher for FailoverProofs {
    async fn get_proof(
        &self,
        provider: &ProviderConfig,
        _address: Address,
        _slots: &[U256],
        _root: &PinnedRoot,
    ) -> Result<ProofBundle, veriq_core::VeriqError> {
        if provider.label == "attacker" {
            Ok(self.bad.clone())
        } else {
            Ok(self.good.clone())
        }
    }

    async fn get_code(
        &self,
        provider: &ProviderConfig,
        _address: Address,
        _root: &PinnedRoot,
    ) -> Result<Bytes, veriq_core::VeriqError> {
        if provider.label == "attacker" {
            Ok(Bytes::from_static(&[0xde, 0xad]))
        } else {
            Ok(self.code.clone())
        }
    }
}

fn failover_engine(root: B256, good: ProofBundle, bad: ProofBundle) -> Engine {
    Engine::with_fetcher(
        Arc::new(FixedRoot::from_parts(BLOCK_NUMBER, BLOCK_HASH, root)),
        vec![
            ProviderConfig {
                label: "attacker".to_string(),
                url: "http://127.0.0.1:1".to_string(),
                eip1898: true,
            },
            ProviderConfig {
                label: "honest".to_string(),
                url: "http://127.0.0.1:2".to_string(),
                eip1898: true,
            },
        ],
        Arc::new(FailoverProofs {
            bad,
            good,
            code: Bytes::new(),
        }),
    )
}

#[tokio::test]
async fn attacker_value_proof_and_wrong_block_all_fail_over_to_honest_value() {
    let (root, honest) = fixture();
    let (_other_root, wrong_block) = fixture_with_code_and_extra_account(Bytes::new(), true);
    assert_ne!(root, _other_root);

    let mut bad_value = honest.clone();
    bad_value.account.balance = U256::from(BALANCE + 1);

    let mut bad_proof = honest.clone();
    let last_index = bad_proof.account_proof.len() - 1;
    let mut leaf = bad_proof.account_proof[last_index].to_vec();
    let last = leaf.len() - 1;
    leaf[last] ^= 0x01;
    bad_proof.account_proof[last_index] = Bytes::from(leaf);

    let cases = [
        ("value", root, bad_value),
        ("proof", root, bad_proof),
        ("wrongblock", root, wrong_block),
    ];

    for (mode, engine_root, bad) in cases {
        let read = failover_engine(engine_root, honest.clone(), bad)
            .read_balance(
                request("veriq_readBalance", json!([format!("{TARGET:#x}")])),
                TARGET,
            )
            .await
            .unwrap_or_else(|err| panic!("{mode} should fail over: {err}"));

        assert_eq!(read.value, U256::from(BALANCE), "{mode}");
        assert_eq!(
            read.receipt.verification.status,
            VerificationStatus::Verified,
            "{mode}"
        );
        assert_eq!(
            read.receipt.routing.provider_label.as_deref(),
            Some("honest"),
            "{mode}"
        );
        assert_eq!(read.receipt.block.number, BLOCK_NUMBER, "{mode}");
        assert_eq!(read.receipt.block.hash, BLOCK_HASH, "{mode}");
        assert_eq!(read.receipt.block.state_root, root, "{mode}");

        // The receipt records every attempt, including the rejected one.
        let attempts = &read.receipt.routing.attempts;
        assert_eq!(read.receipt.routing.providers_tried, 2, "{mode}");
        assert_eq!(attempts.len(), 2, "{mode}");
        assert_eq!(attempts[0].provider, "attacker", "{mode}");
        assert_eq!(attempts[0].outcome, AttemptOutcome::InvalidProof, "{mode}");
        let reason = attempts[0].failure_reason.as_deref().unwrap_or_default();
        assert!(reason.starts_with("INVALID_PROOF"), "{mode}: {reason}");
        assert!(
            !reason.contains("http://"),
            "{mode}: reason must not leak provider URLs"
        );
        assert_eq!(attempts[1].provider, "honest", "{mode}");
        assert_eq!(attempts[1].outcome, AttemptOutcome::Success, "{mode}");
        assert_eq!(attempts[1].failure_reason, None, "{mode}");
    }
}

#[tokio::test]
async fn every_method_uses_the_same_receipt_block() {
    let code = Bytes::from_static(&[0x60, 0x00]);
    let (root, bundle) = fixture_with_code(code.clone());
    let engine = engine_with_code(root, bundle, code);

    let balance = engine
        .read_balance(
            request("veriq_readBalance", json!([format!("{TARGET:#x}")])),
            TARGET,
        )
        .await
        .expect("balance");
    let storage = engine
        .read_storage(
            request("veriq_readStorage", json!([format!("{TARGET:#x}"), "0x0"])),
            TARGET,
            U256::ZERO,
        )
        .await
        .expect("storage");
    let nonce = engine
        .read_nonce(
            request(
                "eth_getTransactionCount",
                json!([format!("{TARGET:#x}"), "finalized"]),
            ),
            TARGET,
        )
        .await
        .expect("nonce");
    let code_read = engine
        .read_code(
            request("eth_getCode", json!([format!("{TARGET:#x}"), "finalized"])),
            TARGET,
        )
        .await
        .expect("code");

    for receipt in [
        balance.receipt,
        storage.receipt,
        nonce.receipt,
        code_read.receipt,
    ] {
        assert_eq!(receipt.block.number, BLOCK_NUMBER);
        assert_eq!(receipt.block.hash, BLOCK_HASH);
        assert_eq!(receipt.block.state_root, root);
    }
}

// ------------------------------------------------------------------ latency (9L)

/// Counts provider calls. With `concurrent_code`, `get_proof` and `get_code` meet at a
/// barrier, so a code read only finishes when both calls are in flight at once.
struct CountingProofs {
    bundle: ProofBundle,
    code: Bytes,
    proof_calls: std::sync::atomic::AtomicUsize,
    barrier: Option<tokio::sync::Barrier>,
}

impl CountingProofs {
    fn new(bundle: ProofBundle, code: Bytes, concurrent_code: bool) -> Self {
        Self {
            bundle,
            code,
            proof_calls: std::sync::atomic::AtomicUsize::new(0),
            barrier: concurrent_code.then(|| tokio::sync::Barrier::new(2)),
        }
    }

    fn proof_calls(&self) -> usize {
        self.proof_calls.load(std::sync::atomic::Ordering::SeqCst)
    }
}

#[async_trait]
impl ProofFetcher for CountingProofs {
    async fn get_proof(
        &self,
        _provider: &ProviderConfig,
        _address: Address,
        _slots: &[U256],
        _root: &PinnedRoot,
    ) -> Result<ProofBundle, veriq_core::VeriqError> {
        self.proof_calls
            .fetch_add(1, std::sync::atomic::Ordering::SeqCst);
        if let Some(barrier) = &self.barrier {
            barrier.wait().await;
        }
        Ok(self.bundle.clone())
    }

    async fn get_code(
        &self,
        _provider: &ProviderConfig,
        _address: Address,
        _root: &PinnedRoot,
    ) -> Result<Bytes, veriq_core::VeriqError> {
        if let Some(barrier) = &self.barrier {
            barrier.wait().await;
        }
        Ok(self.code.clone())
    }
}

/// A root source whose pinned block (and source kind) the test controls.
struct SwitchRoot {
    root: std::sync::Mutex<PinnedRoot>,
    source: veriq_light_client::RootSource,
}

#[async_trait]
impl veriq_light_client::RootSourceProvider for SwitchRoot {
    async fn current_root(&self) -> Result<PinnedRoot, veriq_core::VeriqError> {
        Ok(*self.root.lock().unwrap())
    }

    fn source(&self) -> veriq_light_client::RootSource {
        self.source
    }
}

fn mock_provider() -> Vec<ProviderConfig> {
    vec![ProviderConfig {
        label: "mock".to_string(),
        url: "http://127.0.0.1:1".to_string(),
        eip1898: true,
    }]
}

fn cached_engine(
    state_root: B256,
    proofs: Arc<CountingProofs>,
    source: veriq_light_client::RootSource,
) -> (Engine, Arc<SwitchRoot>) {
    let root = Arc::new(SwitchRoot {
        root: std::sync::Mutex::new(PinnedRoot::new(BLOCK_NUMBER, BLOCK_HASH, state_root)),
        source,
    });
    let engine =
        Engine::with_fetcher(root.clone(), mock_provider(), proofs).with_verified_cache(true);
    (engine, root)
}

async fn read_balance(
    engine: &Engine,
) -> Result<veriq_server::engine::ReadResult, veriq_core::VeriqError> {
    engine
        .read_balance(request("eth_getBalance", json!([])), TARGET)
        .await
}

#[tokio::test]
async fn code_read_fetches_proof_and_code_concurrently() {
    let code = Bytes::from_static(&[0x60, 0x2a, 0x60, 0x00]);
    let (state_root, bundle) = fixture_with_code(code.clone());
    let proofs = Arc::new(CountingProofs::new(bundle, code.clone(), true));
    let root = FixedRoot::from_parts(BLOCK_NUMBER, BLOCK_HASH, state_root);
    let engine = Engine::with_fetcher(Arc::new(root), mock_provider(), proofs);
    // Fetching one after the other would wait forever at the barrier.
    let read = tokio::time::timeout(
        std::time::Duration::from_secs(5),
        engine.read_code(request("eth_getCode", json!([])), TARGET),
    )
    .await
    .expect("getProof and getCode run at the same time")
    .expect("verified code");
    assert_eq!(read.code, code);
    assert_eq!(
        read.receipt.verification.status,
        VerificationStatus::Verified
    );
}

#[tokio::test]
async fn verified_cache_serves_repeat_read_without_provider_call() {
    let (state_root, bundle) = fixture();
    let proofs = Arc::new(CountingProofs::new(bundle, Bytes::new(), false));
    let (engine, _) = cached_engine(
        state_root,
        proofs.clone(),
        veriq_light_client::RootSource::Fixture,
    );

    let first = read_balance(&engine).await.expect("first read");
    let second = read_balance(&engine).await.expect("cached read");

    assert_eq!(proofs.proof_calls(), 1, "second read made no provider call");
    assert_eq!(second.value, U256::from(BALANCE));
    assert_eq!(second.value, first.value);
    assert_eq!(second.receipt.block, first.receipt.block);
    assert_eq!(
        second.receipt.verification.status,
        VerificationStatus::Verified
    );
    assert!(second.receipt.routing.attempts.is_empty());
    assert!(second
        .receipt
        .warnings
        .iter()
        .any(|w| w.code == "VERIFIED_CACHE_HIT"));
    assert!(!first
        .receipt
        .warnings
        .iter()
        .any(|w| w.code == "VERIFIED_CACHE_HIT"));
}

#[tokio::test]
async fn verified_cache_is_cleared_by_a_new_finalized_block() {
    let (state_root, bundle) = fixture();
    let proofs = Arc::new(CountingProofs::new(bundle, Bytes::new(), false));
    let (engine, root) = cached_engine(
        state_root,
        proofs.clone(),
        veriq_light_client::RootSource::Fixture,
    );
    read_balance(&engine).await.expect("first read");
    *root.root.lock().unwrap() =
        PinnedRoot::new(BLOCK_NUMBER + 32, B256::repeat_byte(0x22), state_root);
    let read = read_balance(&engine).await.expect("read at the new block");
    assert_eq!(proofs.proof_calls(), 2, "new block fetched a fresh proof");
    assert_eq!(read.receipt.block.number, BLOCK_NUMBER + 32);
}

#[tokio::test]
async fn failed_verification_is_never_cached() {
    let (_, bundle) = fixture();
    let proofs = Arc::new(CountingProofs::new(bundle, Bytes::new(), false));
    // Wrong state root: every proof fails verification.
    let (engine, _) = cached_engine(
        B256::repeat_byte(0x99),
        proofs.clone(),
        veriq_light_client::RootSource::Fixture,
    );
    let err = read_balance(&engine).await.expect_err("invalid proof");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
    // The failure was not cached as an answer. (The second read gets no proof at all:
    // the circuit breaker benches the provider after an invalid proof.)
    read_balance(&engine)
        .await
        .expect_err("still an error, never a cached value");
    assert_eq!(proofs.proof_calls(), 1);
}

#[tokio::test]
async fn unverified_results_are_never_cached() {
    let (state_root, bundle) = fixture();
    let proofs = Arc::new(CountingProofs::new(bundle, Bytes::new(), false));
    let (engine, _) = cached_engine(
        state_root,
        proofs.clone(),
        veriq_light_client::RootSource::UntrustedRpc,
    );
    for _ in 0..2 {
        let read = read_balance(&engine).await.expect("dev read");
        assert_eq!(
            read.receipt.verification.status,
            VerificationStatus::Unverified
        );
    }
    assert_eq!(proofs.proof_calls(), 2);
}

#[tokio::test]
async fn verified_cache_is_off_by_default() {
    let (state_root, bundle) = fixture();
    let proofs = Arc::new(CountingProofs::new(bundle, Bytes::new(), false));
    let root = FixedRoot::from_parts(BLOCK_NUMBER, BLOCK_HASH, state_root);
    let engine = Engine::with_fetcher(Arc::new(root), mock_provider(), proofs.clone());
    for _ in 0..2 {
        read_balance(&engine).await.expect("read");
    }
    assert_eq!(proofs.proof_calls(), 2);
}

// ---- Receipt persistence ------------------------------------------------------
//
// Contract (docs/SERVICES.md, "Receipt persistence"): persistence is best-effort.
// The proof decides the answer; the store is the audit trail. A failed write is
// logged and the verified answer, with its receipt inline, is still returned.

/// A receipt store that is always down.
struct BrokenStore;

#[async_trait]
impl ReceiptStore for BrokenStore {
    async fn insert(&self, _: StoredReceipt) -> Result<(), StoreError> {
        Err(StoreError::Database)
    }
    async fn list(&self, _: usize) -> Result<Vec<StoredReceipt>, StoreError> {
        Err(StoreError::Database)
    }
    async fn get(&self, _: &str) -> Result<Option<StoredReceipt>, StoreError> {
        Err(StoreError::Database)
    }
}

fn eth_get_balance() -> serde_json::Value {
    json!({
        "jsonrpc": "2.0",
        "id": 1,
        "method": "eth_getBalance",
        "params": [format!("{TARGET:#x}"), "finalized"],
    })
}

fn get_receipt(id: &str) -> serde_json::Value {
    json!({"jsonrpc": "2.0", "id": 2, "method": "veriq_getReceipt", "params": [id]})
}

#[tokio::test]
async fn receipt_store_failure_does_not_fail_a_verified_read() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle).with_store(Arc::new(BrokenStore));

    let got = dispatch(&engine, eth_get_balance()).await;
    assert!(got.get("error").is_none(), "read failed: {got}");
    assert_eq!(got["result"], format!("{:#x}", U256::from(BALANCE)));
    // The receipt still reaches the client, inline in the top-level `veriq` member.
    assert_eq!(got["veriq"]["verification"]["status"], "verified");
    let id = got["veriq"]["identity"]["requestId"]
        .as_str()
        .expect("request id");

    // It just cannot be looked up later.
    let lookup = dispatch(&engine, get_receipt(id)).await;
    assert_eq!(lookup["error"]["message"], "receipt storage unavailable");
    assert_eq!(lookup["error"]["data"]["code"], "INTERNAL_ERROR");
}

/// A receipt store whose writes never finish (a database that accepts the connection
/// and then hangs).
struct HangingStore;

#[async_trait]
impl ReceiptStore for HangingStore {
    async fn insert(&self, _: StoredReceipt) -> Result<(), StoreError> {
        std::future::pending().await
    }
    async fn list(&self, _: usize) -> Result<Vec<StoredReceipt>, StoreError> {
        Ok(Vec::new())
    }
    async fn get(&self, _: &str) -> Result<Option<StoredReceipt>, StoreError> {
        Ok(None)
    }
}

#[tokio::test]
async fn hanging_receipt_store_delays_a_verified_read_by_at_most_the_write_timeout() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle).with_store(Arc::new(HangingStore));

    let started = std::time::Instant::now();
    let got = dispatch(&engine, eth_get_balance()).await;
    let elapsed = started.elapsed();

    assert!(got.get("error").is_none(), "read failed: {got}");
    assert_eq!(got["veriq"]["verification"]["status"], "verified");
    assert!(
        elapsed >= RECEIPT_WRITE_TIMEOUT && elapsed < RECEIPT_WRITE_TIMEOUT * 2,
        "read took {elapsed:?}"
    );
}

/// `TEST_DATABASE_URL` names a dedicated, empty PostgreSQL database. Skipped locally
/// without it; required in CI (same rule as the store's own PostgreSQL test).
fn test_database_url() -> Option<String> {
    let url = std::env::var("TEST_DATABASE_URL")
        .ok()
        .filter(|url| !url.trim().is_empty());
    if url.is_none() {
        assert!(
            std::env::var_os("CI").is_none(),
            "TEST_DATABASE_URL must be configured in CI"
        );
        eprintln!("skipping postgres restart test: TEST_DATABASE_URL not set");
    }
    url
}

#[tokio::test]
async fn postgres_receipts_survive_an_engine_restart_and_keep_the_first_record() {
    let Some(url) = test_database_url() else {
        return;
    };
    let (state_root, bundle) = fixture();

    // Engine 1 serves a standard eth_getBalance and stores its receipt.
    let first = engine(state_root, bundle.clone()).with_store(Arc::new(
        PostgresReceiptStore::connect(&url).await.expect("connect"),
    ));
    let got = dispatch(&first, eth_get_balance()).await;
    assert!(got.get("error").is_none(), "read failed: {got}");
    let id = got["veriq"]["identity"]["requestId"]
        .as_str()
        .expect("request id")
        .to_owned();

    // A second read under the same request id: still answered (best-effort store),
    // and the store refuses to replace the first record.
    let replay = first
        .read_nonce(
            RequestMeta {
                id: id.clone(),
                method: "eth_getTransactionCount".to_owned(),
                params: json!([]),
            },
            TARGET,
        )
        .await
        .expect("replayed id still answers");
    assert_eq!(replay.value, U256::from(1));
    drop(first);

    // Engine 2: a new process would build exactly this, a new pool on the same database.
    let second = engine(state_root, bundle).with_store(Arc::new(
        PostgresReceiptStore::connect(&url)
            .await
            .expect("reconnect"),
    ));
    let lookup = dispatch(&second, get_receipt(&id)).await;
    assert_eq!(lookup["result"], got["veriq"], "same receipt after restart");

    let row = second
        .store()
        .get(&id)
        .await
        .expect("get")
        .expect("persisted row");
    assert_eq!(row.method, "eth_getBalance", "first record kept");
    assert_eq!(row.value.as_deref(), Some("0x4d2"));
    assert_eq!(row.receipt.expect("receipt").block.state_root, state_root);
    let listed = second.store().list(5_000).await.expect("list");
    assert_eq!(listed.iter().filter(|r| r.id == id).count(), 1);
}

// ---- Client-fetched proofs (Anon-RPC): veriq_getRoot + veriq_verifyProof ----------------
//
// The browser fetches eth_getProof through Anon-RPC and hands the result to the engine,
// which verifies it against its own pinned root. These tests drive the JSON-RPC layer.

/// The fixture bundle in `eth_getProof` JSON form, as a provider (through Anon-RPC) returns it.
fn proof_json(bundle: &ProofBundle) -> serde_json::Value {
    let hex = |bytes: &Bytes| format!("0x{}", alloy_primitives::hex::encode(bytes));
    json!({
        "balance": format!("{:#x}", bundle.account.balance),
        "nonce": format!("{:#x}", bundle.account.nonce),
        "storageHash": format!("{:#x}", bundle.account.storage_root),
        "codeHash": format!("{:#x}", bundle.account.code_hash),
        "accountProof": bundle.account_proof.iter().map(hex).collect::<Vec<_>>(),
        "storageProof": bundle.storage_proofs.iter().map(|p| json!({
            "key": format!("{:#x}", p.key),
            "value": format!("{:#x}", p.value),
            "proof": p.proof.iter().map(hex).collect::<Vec<_>>(),
        })).collect::<Vec<_>>(),
    })
}

fn verify_request(
    input: serde_json::Value,
    policy: Option<serde_json::Value>,
) -> serde_json::Value {
    let params = match policy {
        Some(policy) => json!([input, policy]),
        None => json!([input]),
    };
    json!({"jsonrpc": "2.0", "id": 7, "method": "veriq_verifyProof", "params": params})
}

fn balance_input(proof: serde_json::Value) -> serde_json::Value {
    json!({
        "kind": "balance",
        "address": format!("{TARGET:#x}"),
        "blockHash": format!("{BLOCK_HASH:#x}"),
        "proof": proof,
        "provider": "publicnode",
        "network": "nox",
        "elapsedMs": 1234,
    })
}

#[tokio::test]
async fn get_root_names_the_block_a_client_must_fetch_at() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle);
    let got = dispatch(
        &engine,
        json!({"jsonrpc": "2.0", "id": 1, "method": "veriq_getRoot", "params": []}),
    )
    .await;
    let result = &got["result"];
    assert_eq!(result["number"], BLOCK_NUMBER);
    assert_eq!(result["hash"], format!("{BLOCK_HASH:#x}"));
    assert_eq!(result["stateRoot"], format!("{state_root:#x}"));
    assert_eq!(result["verified"], true);

    // Exactly these five fields, with these JSON types.
    let mut keys: Vec<&str> = result
        .as_object()
        .expect("object")
        .keys()
        .map(String::as_str)
        .collect();
    keys.sort_unstable();
    assert_eq!(
        keys,
        ["hash", "number", "rootSource", "stateRoot", "verified"]
    );
    assert!(result["number"].is_u64(), "number is a JSON number: {got}");
    assert!(result["rootSource"].is_string());
    for field in ["hash", "stateRoot"] {
        let hex = result[field].as_str().expect("string");
        assert!(
            hex.len() == 66 && hex.starts_with("0x"),
            "{field} is a 0x 32-byte hex string: {hex}"
        );
    }
}

/// A root source whose finalized block moves on every lookup, and that can be made to
/// fail like a light client that lost sync.
struct MovingRoot {
    state_root: B256,
    calls: AtomicUsize,
    failing: bool,
}

#[async_trait]
impl RootSourceProvider for MovingRoot {
    async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
        let call = self.calls.fetch_add(1, Ordering::SeqCst) as u8;
        if self.failing {
            return Err(VeriqError::root_unavailable(
                "light client has no finalized block",
            ));
        }
        Ok(PinnedRoot::new(
            BLOCK_NUMBER + u64::from(call),
            B256::repeat_byte(0x30 + call),
            self.state_root,
        ))
    }

    fn source(&self) -> RootSource {
        RootSource::LocalLightClient
    }
}

fn engine_with_root(root: Arc<dyn RootSourceProvider>, bundle: ProofBundle) -> Engine {
    Engine::with_fetcher(
        root,
        vec![ProviderConfig {
            label: "mock".to_string(),
            url: "http://127.0.0.1:1".to_string(),
            eip1898: true,
        }],
        Arc::new(MockProofs {
            bundle,
            code: Bytes::new(),
        }),
    )
}

fn get_root_request() -> serde_json::Value {
    json!({"jsonrpc": "2.0", "id": 1, "method": "veriq_getRoot", "params": []})
}

#[tokio::test]
async fn get_root_without_a_root_is_root_unavailable_and_names_no_block() {
    let (state_root, bundle) = fixture();
    let engine = engine_with_root(
        Arc::new(MovingRoot {
            state_root,
            calls: AtomicUsize::new(0),
            failing: true,
        }),
        bundle,
    );
    let got = dispatch(&engine, get_root_request()).await;
    assert_eq!(got["error"]["data"]["code"], "ROOT_UNAVAILABLE", "{got}");
    assert!(got.get("result").is_none(), "no block is made up: {got}");
}

#[tokio::test]
async fn two_quick_get_root_calls_return_the_same_block_and_a_proof_for_it_verifies() {
    let (state_root, bundle) = fixture();
    let source = Arc::new(MovingRoot {
        state_root,
        calls: AtomicUsize::new(0),
        failing: false,
    });
    // The same cache that main.rs puts in front of the light client.
    let cached = Arc::new(CachedRoot::new(source.clone(), Duration::from_secs(12)));
    let engine = engine_with_root(cached, bundle.clone());

    let first = dispatch(&engine, get_root_request()).await;
    let second = dispatch(&engine, get_root_request()).await;
    assert!(first.get("error").is_none(), "{first}");
    assert_eq!(first["result"], second["result"]);
    assert_eq!(source.calls.load(Ordering::SeqCst), 1, "one root lookup");

    // A proof fetched at that block verifies right away: reads use the same pinned root.
    let mut input = balance_input(proof_json(&bundle));
    input["blockHash"] = first["result"]["hash"].clone();
    let got = dispatch(&engine, verify_request(input, None)).await;
    assert!(got.get("error").is_none(), "{got}");
    assert_eq!(
        got["result"]["receipt"]["block"]["number"],
        first["result"]["number"]
    );
}

#[tokio::test]
async fn client_fetched_proof_is_verified_and_the_receipt_says_anon_rpc() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle.clone());

    let got = dispatch(
        &engine,
        verify_request(balance_input(proof_json(&bundle)), None),
    )
    .await;
    assert!(got.get("error").is_none(), "{got}");
    assert_eq!(
        got["result"]["value"],
        format!("{:#x}", U256::from(BALANCE))
    );
    let receipt = &got["result"]["receipt"];
    assert_eq!(receipt["verification"]["status"], "verified");
    assert_eq!(receipt["block"]["stateRoot"], format!("{state_root:#x}"));
    assert_eq!(receipt["privacy"]["transport"], "anon-rpc");
    assert_eq!(receipt["privacy"]["mechanism"], "nox");
    assert_eq!(
        receipt["routing"]["providerLabel"],
        "publicnode@anon-rpc:nox"
    );
    assert_eq!(receipt["routing"]["attempts"][0]["outcome"], "success");
    assert_eq!(receipt["routing"]["attempts"][0]["elapsedMs"], 1234);

    // Stored like any other read.
    let id = receipt["identity"]["requestId"].as_str().expect("id");
    let row = engine.store().get(id).await.expect("get").expect("stored");
    assert_eq!(row.method, "veriq_verifyProof");
    assert_eq!(row.value.as_deref(), Some("0x4d2"));
}

#[tokio::test]
async fn client_fetched_proof_satisfies_privacy_required() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle.clone());
    let policy = json!({"verification": "required", "privacy": "required", "consistency": "single",
                        "blockPolicy": "finalized", "timeoutMs": 8000});
    let got = dispatch(
        &engine,
        verify_request(balance_input(proof_json(&bundle)), Some(policy)),
    )
    .await;
    assert!(got.get("error").is_none(), "{got}");
    assert_eq!(got["result"]["receipt"]["privacy"]["transport"], "anon-rpc");
}

#[tokio::test]
async fn a_forged_client_proof_is_rejected_and_recorded() {
    let (state_root, mut bundle) = fixture();
    let engine = engine(state_root, bundle.clone());
    bundle.account.balance = U256::from(BALANCE + 1_000);

    let got = dispatch(
        &engine,
        verify_request(balance_input(proof_json(&bundle)), None),
    )
    .await;
    assert_eq!(got["error"]["data"]["code"], "INVALID_PROOF", "{got}");
    let rows = engine.store().list(10).await.expect("list");
    assert_eq!(
        rows[0].error.as_ref().expect("error row").data.code,
        "INVALID_PROOF"
    );
    assert_eq!(rows[0].attempts[0].outcome, AttemptOutcome::InvalidProof);
}

#[tokio::test]
async fn a_proof_for_another_block_is_refused_with_a_retry_hint() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle.clone());
    let mut input = balance_input(proof_json(&bundle));
    input["blockHash"] = json!(format!("{:#x}", B256::repeat_byte(0x22)));

    let got = dispatch(&engine, verify_request(input, None)).await;
    assert_eq!(got["error"]["code"], -32602, "{got}");
    assert!(got["error"]["message"]
        .as_str()
        .unwrap()
        .contains("veriq_getRoot"));
}

#[tokio::test]
async fn client_fetched_storage_proof_returns_the_slot_value() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle.clone());
    let mut input = balance_input(proof_json(&bundle));
    input["kind"] = json!("storage");
    input["slot"] = json!("0x0");

    let got = dispatch(&engine, verify_request(input, None)).await;
    assert!(got.get("error").is_none(), "{got}");
    assert_eq!(
        got["result"]["value"],
        format!("{:#x}", U256::from(SLOT_ZERO_VALUE))
    );
    assert_eq!(got["result"]["slot"], format!("{:#066x}", U256::ZERO));
    assert_eq!(
        got["result"]["receipt"]["verification"]["mechanisms"],
        json!(["account-proof", "storage-proof"])
    );
}

#[tokio::test]
async fn client_proof_labels_and_shape_are_validated_before_verification() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle.clone());
    let mut bad_label = balance_input(proof_json(&bundle));
    bad_label["provider"] = json!("https://rpc.example/KEY");
    let got = dispatch(&engine, verify_request(bad_label, None)).await;
    assert_eq!(got["error"]["code"], -32602);
    assert!(
        !got.to_string().contains("KEY"),
        "label is never echoed: {got}"
    );

    let mut no_proof = balance_input(json!(null));
    no_proof["proof"] = json!("not-an-object");
    let got = dispatch(&engine, verify_request(no_proof, None)).await;
    assert_eq!(got["error"]["code"], -32602);

    let mut bad_kind = balance_input(proof_json(&bundle));
    bad_kind["kind"] = json!("https://rpc.example/KIND_KEY");
    let got = dispatch(&engine, verify_request(bad_kind, None)).await;
    assert_eq!(got["error"]["code"], -32602);
    assert!(
        !got.to_string().contains("KIND_KEY"),
        "kind is never echoed: {got}"
    );
}

#[tokio::test]
async fn client_fetched_nonce_proof_returns_the_proven_nonce() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle.clone());
    let mut input = balance_input(proof_json(&bundle));
    input["kind"] = json!("nonce");

    let got = dispatch(&engine, verify_request(input, None)).await;
    assert!(got.get("error").is_none(), "{got}");
    assert_eq!(got["result"]["value"], format!("{:#x}", U256::from(1)));
    assert!(got["result"].get("slot").is_none());
}

#[tokio::test]
async fn client_fetched_code_is_checked_against_the_proven_code_hash() {
    let code = Bytes::from_static(&[0x60, 0x80, 0x60, 0x40, 0x52]);
    let (state_root, bundle) = fixture_with_code(code.clone());
    let engine = engine(state_root, bundle.clone());
    let mut input = balance_input(proof_json(&bundle));
    input["kind"] = json!("code");
    input["code"] = json!(format!("0x{}", alloy_primitives::hex::encode(&code)));

    let got = dispatch(&engine, verify_request(input.clone(), None)).await;
    assert!(got.get("error").is_none(), "{got}");
    assert_eq!(got["result"]["value"], "0x6080604052");
    assert_eq!(
        got["result"]["receipt"]["verification"]["status"],
        "verified"
    );

    // Code that does not hash to the proven codeHash is a forged answer.
    input["code"] = json!("0x6080");
    let got = dispatch(&engine, verify_request(input, None)).await;
    assert_eq!(got["error"]["data"]["code"], "INVALID_PROOF", "{got}");
}

#[tokio::test]
async fn a_code_proof_without_code_is_an_invalid_request() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle.clone());
    let mut input = balance_input(proof_json(&bundle));
    input["kind"] = json!("code");

    let got = dispatch(&engine, verify_request(input, None)).await;
    assert_eq!(got["error"]["code"], -32602, "{got}");
    assert_eq!(got["error"]["data"]["code"], "INVALID_REQUEST");
}

#[tokio::test]
async fn a_bad_storage_slot_is_refused_before_any_proof_work() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle.clone());
    for slot in [json!("0xnot-hex"), json!(true), serde_json::Value::Null] {
        let mut input = balance_input(proof_json(&bundle));
        input["kind"] = json!("storage");
        input["slot"] = slot.clone();
        let got = dispatch(&engine, verify_request(input, None)).await;
        assert_eq!(
            got["error"]["data"]["code"], "INVALID_REQUEST",
            "{slot}: {got}"
        );
    }
    // Refused while parsing: nothing reached the engine, so nothing was stored.
    assert!(engine.store().list(10).await.expect("list").is_empty());
}

#[tokio::test]
async fn compare_on_a_client_proof_warns_that_nothing_was_compared() {
    let (state_root, bundle) = fixture();
    let engine = engine(state_root, bundle.clone());
    let policy = json!({"verification": "required", "privacy": "preferred", "consistency": "compare",
                        "blockPolicy": "finalized", "timeoutMs": 8000});

    let got = dispatch(
        &engine,
        verify_request(balance_input(proof_json(&bundle)), Some(policy)),
    )
    .await;
    assert!(got.get("error").is_none(), "{got}");
    let receipt = &got["result"]["receipt"];
    let codes: Vec<&str> = receipt["warnings"]
        .as_array()
        .expect("warnings")
        .iter()
        .filter_map(|warning| warning["code"].as_str())
        .collect();
    assert!(codes.contains(&"COMPARE_UNAVAILABLE"), "{codes:?}");
    assert!(
        !codes.contains(&"PRIVACY_DOWNGRADED"),
        "the private path is not a downgrade"
    );
    assert_eq!(receipt["routing"]["comparison"], "not-run");
    assert_eq!(
        receipt["routing"]["attempts"][0]["provider"],
        "publicnode@anon-rpc:nox"
    );
}

#[tokio::test]
async fn verify_proof_without_a_root_is_root_unavailable_and_recorded() {
    let (state_root, bundle) = fixture();
    let engine = engine_with_root(
        Arc::new(MovingRoot {
            state_root,
            calls: AtomicUsize::new(0),
            failing: true,
        }),
        bundle.clone(),
    );
    let got = dispatch(
        &engine,
        verify_request(balance_input(proof_json(&bundle)), None),
    )
    .await;
    assert_eq!(got["error"]["data"]["code"], "ROOT_UNAVAILABLE", "{got}");
    let rows = engine.store().list(10).await.expect("list");
    assert_eq!(
        rows[0].error.as_ref().expect("error row").data.code,
        "ROOT_UNAVAILABLE"
    );
}
