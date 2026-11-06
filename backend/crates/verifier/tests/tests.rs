use std::collections::BTreeMap;

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_trie::{
    proof::ProofRetainer, HashBuilder, Nibbles, TrieAccount, EMPTY_ROOT_HASH, KECCAK_EMPTY,
};
use veriq_core::{Account, ErrorCode};
use veriq_verifier::{bounds, verify_account, verify_storage};

fn account(nonce: u64, balance: u64) -> TrieAccount {
    TrieAccount::new(nonce, U256::from(balance), EMPTY_ROOT_HASH, KECCAK_EMPTY)
}

fn address(byte: u8) -> Address {
    Address::repeat_byte(byte)
}

fn key(address: Address) -> B256 {
    keccak256(address.as_slice())
}

fn build_account_trie(entries: &[(Address, TrieAccount)], target: Address) -> (B256, Vec<Bytes>) {
    let target_key = Nibbles::unpack(key(target));
    let mut sorted = BTreeMap::new();
    for (addr, acct) in entries {
        sorted.insert(key(*addr), alloy_rlp::encode(acct));
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

fn many_accounts() -> Vec<(Address, TrieAccount)> {
    (1u8..=24)
        .map(|byte| {
            (
                address(byte),
                account(u64::from(byte), 1000 + u64::from(byte)),
            )
        })
        .collect()
}

#[test]
fn valid_account_proof_returns_proven_value() {
    let target = address(7);
    let (root, proof) = build_account_trie(&many_accounts(), target);
    let proven = verify_account(root, target, &proof, None).expect("valid proof");
    assert!(proven.exists);
    assert_eq!(proven.account.balance, U256::from(1007));
    assert_eq!(proven.account.nonce, 7);

    let claimed = Account::new(
        proven.account.nonce,
        proven.account.balance,
        proven.account.storage_root,
        proven.account.code_hash,
    );
    let again = verify_account(root, target, &proof, Some(claimed)).expect("claimed matches");
    assert_eq!(again, proven);
}

#[test]
fn valid_storage_proof_returns_proven_value() {
    let (root, proof) = build_storage_trie(&[(U256::from(0), U256::from(42))], U256::from(0));
    let value = verify_storage(root, U256::from(0), &proof).expect("valid storage proof");
    assert_eq!(value, U256::from(42));
}

#[test]
fn absent_account_needs_valid_exclusion_proof() {
    let target = address(200);
    let (root, proof) = build_account_trie(&many_accounts(), target);
    let proven = verify_account(root, target, &proof, None).expect("valid exclusion proof");
    assert!(!proven.exists);
    assert_eq!(proven.account, Account::empty());

    let err = verify_account(root, target, &proof, Some(account_value(1, 1)))
        .expect_err("claimed account contradicts exclusion");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

#[test]
fn zero_slot_needs_valid_exclusion_proof() {
    let (root, proof) = build_storage_trie(&[(U256::from(1), U256::from(7))], U256::ZERO);
    let value = verify_storage(root, U256::ZERO, &proof).expect("valid exclusion proof");
    assert_eq!(value, U256::ZERO);
}

#[test]
fn flipped_byte_in_middle_node_is_rejected() {
    let target = address(7);
    let (root, proof) = build_account_trie(&many_accounts(), target);
    assert!(proof.len() >= 2, "test requires a multi-node proof");

    let mut nodes = proof.clone();
    let mut middle = nodes[1].to_vec();
    let last = middle.len() - 1;
    middle[last] ^= 0x01;
    nodes[1] = Bytes::from(middle);

    let err = verify_account(root, target, &nodes, None).expect_err("tampered middle node");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

#[test]
fn flipped_byte_in_leaf_is_rejected() {
    let target = address(7);
    let (root, proof) = build_account_trie(&many_accounts(), target);
    let mut nodes = proof.clone();
    let last_index = nodes.len() - 1;
    let mut leaf = nodes[last_index].to_vec();
    let last = leaf.len() - 1;
    leaf[last] ^= 0x01;
    nodes[last_index] = Bytes::from(leaf);

    let err = verify_account(root, target, &nodes, None).expect_err("tampered leaf");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

#[test]
fn wrong_state_root_is_rejected() {
    let target = address(7);
    let (root, proof) = build_account_trie(&many_accounts(), target);
    let wrong_root = B256::from([0x42; 32]);
    assert_ne!(root, wrong_root);

    let err = verify_account(wrong_root, target, &proof, None).expect_err("wrong root");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

#[test]
fn wrong_address_is_rejected() {
    let target = address(7);
    let (root, proof) = build_account_trie(&many_accounts(), target);

    let err = verify_account(root, address(8), &proof, None).expect_err("wrong address");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

#[test]
fn changed_claimed_balance_is_rejected() {
    let target = address(7);
    let (root, proof) = build_account_trie(&many_accounts(), target);
    let claimed = account_value(7, 1008);

    let err =
        verify_account(root, target, &proof, Some(claimed)).expect_err("wrong claimed balance");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

#[test]
fn truncated_proof_is_rejected() {
    let target = address(7);
    let (root, proof) = build_account_trie(&many_accounts(), target);
    assert!(proof.len() >= 2, "test requires a multi-node proof");
    let truncated = &proof[..proof.len() - 1];

    let err = verify_account(root, target, truncated, None).expect_err("truncated proof");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

#[test]
fn extra_appended_node_is_rejected() {
    let target = address(7);
    let (root, mut proof) = build_account_trie(&many_accounts(), target);
    proof.push(Bytes::from_static(&[0x80]));

    let err = verify_account(root, target, &proof, None).expect_err("extra node");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

#[test]
fn oversized_node_is_rejected_before_verification() {
    let target = address(7);
    let (root, _) = build_account_trie(&many_accounts(), target);
    let oversized = vec![Bytes::from(vec![0u8; bounds::MAX_NODE_BYTES + 1])];

    let err = verify_account(root, target, &oversized, None).expect_err("oversized node");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

fn account_value(nonce: u64, balance: u64) -> Account {
    Account::new(nonce, U256::from(balance), EMPTY_ROOT_HASH, KECCAK_EMPTY)
}

#[test]
fn proof_with_too_many_nodes_is_rejected() {
    let nodes = vec![Bytes::new(); bounds::MAX_PROOF_NODES + 1];
    let err = bounds::check_proof_bounds(&nodes).expect_err("65 nodes");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
    assert!(err.message().contains("limit is 64"));
}

#[test]
fn proof_at_node_and_size_limits_passes() {
    let nodes = vec![Bytes::from(vec![0u8; bounds::MAX_NODE_BYTES]); bounds::MAX_PROOF_NODES];
    bounds::check_proof_bounds(&nodes).expect("64 nodes of 1 KiB are allowed");
}

#[test]
fn oversized_proof_node_is_rejected() {
    let nodes = vec![Bytes::from(vec![0u8; bounds::MAX_NODE_BYTES + 1])];
    let err = bounds::check_proof_bounds(&nodes).expect_err("1025-byte node");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}

#[test]
fn response_body_limit_is_enforced_at_the_boundary() {
    assert!(bounds::check_response_size(bounds::MAX_RESPONSE_BYTES).is_ok());
    let err =
        bounds::check_response_size(bounds::MAX_RESPONSE_BYTES + 1).expect_err("2 MiB + 1 byte");
    assert_eq!(err.code(), ErrorCode::InvalidProof);
}
