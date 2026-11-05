use std::{fs, path::PathBuf, str::FromStr};

use alloy_primitives::{hex, Address, Bytes, B256, U256};
use serde_json::Value;
use veriq_core::Account;
use veriq_verifier::{verify_account, verify_storage};

fn fixture_path(name: &str) -> PathBuf {
    PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../../fixtures")
        .join(name)
}

fn load_fixture(name: &str) -> Value {
    let path = fixture_path(name);
    let text =
        fs::read_to_string(&path).unwrap_or_else(|err| panic!("read {}: {err}", path.display()));
    serde_json::from_str(&text).unwrap_or_else(|err| panic!("parse {}: {err}", path.display()))
}

fn state_root(fixture: &Value) -> B256 {
    B256::from_str(
        fixture["block"]["stateRoot"]
            .as_str()
            .expect("fixture block.stateRoot"),
    )
    .expect("valid state root")
}

fn address(fixture: &Value) -> Address {
    Address::from_str(fixture["address"].as_str().expect("fixture address")).expect("valid address")
}

fn proof(fixture: &Value) -> Value {
    fixture["proof"].clone()
}

fn bytes_nodes(value: &Value) -> Vec<Bytes> {
    value
        .as_array()
        .expect("proof node list")
        .iter()
        .map(|node| {
            let text = node.as_str().expect("proof node string");
            let text = text.strip_prefix("0x").unwrap_or(text);
            Bytes::from(hex::decode(text).expect("proof node hex"))
        })
        .collect()
}

fn claimed_account(result: &Value) -> Account {
    Account::new(
        parse_u64(&result["nonce"]),
        parse_u256(&result["balance"]),
        B256::from_str(result["storageHash"].as_str().expect("storageHash")).expect("storageHash"),
        B256::from_str(result["codeHash"].as_str().expect("codeHash")).expect("codeHash"),
    )
}

fn parse_u64(value: &Value) -> u64 {
    let text = value.as_str().expect("quantity");
    let text = text.strip_prefix("0x").unwrap_or(text);
    u64::from_str_radix(text, 16).expect("u64 hex")
}

fn parse_u256(value: &Value) -> U256 {
    let text = value.as_str().expect("quantity");
    let text = text.strip_prefix("0x").unwrap_or(text);
    if text.is_empty() {
        U256::ZERO
    } else {
        U256::from_str_radix(text, 16).expect("U256 hex")
    }
}

#[test]
fn eoa_fixture_verifies() {
    let fixture = load_fixture("eoa.json");
    let result = proof(&fixture);
    let proven = verify_account(
        state_root(&fixture),
        address(&fixture),
        &bytes_nodes(&result["accountProof"]),
        Some(claimed_account(&result)),
    )
    .expect("eoa fixture verifies");
    assert!(proven.exists);
}

#[test]
fn contract_fixture_verifies() {
    let fixture = load_fixture("contract.json");
    let result = proof(&fixture);
    let proven = verify_account(
        state_root(&fixture),
        address(&fixture),
        &bytes_nodes(&result["accountProof"]),
        Some(claimed_account(&result)),
    )
    .expect("contract fixture verifies");
    assert!(proven.exists);
}

#[test]
fn absent_account_fixture_verifies_exclusion() {
    let fixture = load_fixture("absent-account.json");
    let result = proof(&fixture);
    let proven = verify_account(
        state_root(&fixture),
        address(&fixture),
        &bytes_nodes(&result["accountProof"]),
        Some(claimed_account(&result)),
    )
    .expect("absent account exclusion proof verifies");
    assert!(!proven.exists);
}

#[test]
fn storage_fixture_verifies_slot_zero_and_mapping() {
    let fixture = load_fixture("storage-slot.json");
    let result = proof(&fixture);
    let proven = verify_account(
        state_root(&fixture),
        address(&fixture),
        &bytes_nodes(&result["accountProof"]),
        Some(claimed_account(&result)),
    )
    .expect("account proof verifies");

    let slots = result["storageProof"].as_array().expect("storageProof");
    assert!(!slots.is_empty());
    for item in slots {
        let slot = parse_u256(&item["key"]);
        let claimed = parse_u256(&item["value"]);
        let value = verify_storage(
            proven.account.storage_root,
            slot,
            &bytes_nodes(&item["proof"]),
        )
        .expect("storage proof verifies");
        assert_eq!(value, claimed);
    }
}

#[test]
fn eoa_fixture_rejects_flipped_proof_and_changed_balance() {
    let fixture = load_fixture("eoa.json");
    let result = proof(&fixture);

    let mut nodes = bytes_nodes(&result["accountProof"]);
    let last = nodes.len() - 1;
    let mut leaf = nodes[last].to_vec();
    let byte = leaf.len() - 1;
    leaf[byte] ^= 0x01;
    nodes[last] = Bytes::from(leaf);
    let err = verify_account(state_root(&fixture), address(&fixture), &nodes, None)
        .expect_err("flipped fixture proof must fail");
    assert_eq!(err.code(), veriq_core::ErrorCode::InvalidProof);

    let mut claimed = claimed_account(&result);
    claimed.balance += U256::from(1);
    let err = verify_account(
        state_root(&fixture),
        address(&fixture),
        &bytes_nodes(&result["accountProof"]),
        Some(claimed),
    )
    .expect_err("changed fixture balance must fail");
    assert_eq!(err.code(), veriq_core::ErrorCode::InvalidProof);
}

#[test]
fn storage_fixture_rejects_wrong_slot_and_wrong_root() {
    let fixture = load_fixture("storage-slot.json");
    let result = proof(&fixture);
    let proven = verify_account(
        state_root(&fixture),
        address(&fixture),
        &bytes_nodes(&result["accountProof"]),
        Some(claimed_account(&result)),
    )
    .expect("account proof verifies");
    let storage = &result["storageProof"][0];
    let slot = parse_u256(&storage["key"]);
    let nodes = bytes_nodes(&storage["proof"]);

    let err = verify_storage(proven.account.storage_root, slot + U256::from(1), &nodes)
        .expect_err("wrong slot must fail");
    assert_eq!(err.code(), veriq_core::ErrorCode::InvalidProof);

    let err = verify_storage(B256::repeat_byte(0x42), slot, &nodes)
        .expect_err("wrong storage root must fail");
    assert_eq!(err.code(), veriq_core::ErrorCode::InvalidProof);
}
