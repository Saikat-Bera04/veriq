//! One verified read from an `eth_getProof` result: the code the engine and the browser
//! (veriq-verifier-wasm) both run, so the two can never disagree about what a proof proves.

use std::str::FromStr;

use alloy_primitives::{hex, keccak256, Address, Bytes, B256, U256};
use serde_json::Value;
use veriq_core::{Account, VeriqError};

use crate::{verify_account, verify_storage};

#[derive(Debug, Clone)]
pub struct StorageProof {
    pub key: U256,
    pub value: U256,
    pub proof: Vec<Bytes>,
}

/// An `eth_getProof` result, parsed but not yet trusted.
#[derive(Debug, Clone)]
pub struct ProofBundle {
    pub account_proof: Vec<Bytes>,
    pub account: Account,
    pub storage_proofs: Vec<StorageProof>,
}

/// What is being read from the proven account.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ReadTarget {
    Balance,
    Nonce,
    Code,
    Storage(U256),
}

/// A value that came out of the trie (never from the provider's claim).
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ProvenValue {
    Word(U256),
    Code(Bytes),
}

/// Check `bundle` against `state_root` and return the proven value for `target`.
///
/// The provider's claimed account and storage values must equal the proven ones, else the
/// proof is rejected; only the proven value is returned. `code` is the `eth_getCode` result,
/// needed for [`ReadTarget::Code`] and checked against the proven code hash.
pub fn verify_read(
    bundle: &ProofBundle,
    code: Option<Bytes>,
    address: Address,
    target: ReadTarget,
    state_root: B256,
) -> Result<ProvenValue, VeriqError> {
    let proven = verify_account(
        state_root,
        address,
        &bundle.account_proof,
        Some(bundle.account),
    )?;
    match target {
        ReadTarget::Balance => Ok(ProvenValue::Word(proven.account.balance)),
        ReadTarget::Nonce => Ok(ProvenValue::Word(U256::from(proven.account.nonce))),
        ReadTarget::Code => {
            let code = code.ok_or_else(|| VeriqError::invalid_proof("code was not fetched"))?;
            if !code_hash_matches(&code, proven.account.code_hash) {
                return Err(VeriqError::invalid_proof(
                    "code hash does not match proven account",
                ));
            }
            Ok(ProvenValue::Code(code))
        }
        ReadTarget::Storage(slot) => {
            let storage = bundle
                .storage_proofs
                .iter()
                .find(|proof| proof.key == slot)
                .ok_or_else(|| {
                    VeriqError::invalid_proof("provider omitted the requested storage slot")
                })?;
            let proven_value = verify_storage(proven.account.storage_root, slot, &storage.proof)?;
            if proven_value != storage.value {
                return Err(VeriqError::invalid_proof(
                    "claimed storage value does not match proven value",
                ));
            }
            Ok(ProvenValue::Word(proven_value))
        }
    }
}

/// `keccak256(code) == code_hash`.
pub fn code_hash_matches(code: &[u8], code_hash: B256) -> bool {
    keccak256(code) == code_hash
}

/// Parse an `eth_getProof` JSON result. Malformed input is `INVALID_PROOF`.
pub fn parse_proof_result(result: &Value) -> Result<ProofBundle, VeriqError> {
    let account_proof = parse_bytes_list(
        result
            .get("accountProof")
            .and_then(Value::as_array)
            .ok_or_else(|| VeriqError::invalid_proof("missing accountProof"))?,
    )?;

    let account = Account::new(
        parse_u64(result.get("nonce"))?,
        parse_u256(result.get("balance"))?,
        parse_b256(result.get("storageHash"))?,
        parse_b256(result.get("codeHash"))?,
    );

    let storage_proofs = result
        .get("storageProof")
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .map(parse_storage_proof)
                .collect::<Result<Vec<_>, _>>()
        })
        .transpose()?
        .unwrap_or_default();

    Ok(ProofBundle {
        account_proof,
        account,
        storage_proofs,
    })
}

fn parse_storage_proof(value: &Value) -> Result<StorageProof, VeriqError> {
    let key = parse_u256(value.get("key"))?;
    let slot_value = parse_u256(value.get("value"))?;
    let proof = parse_bytes_list(
        value
            .get("proof")
            .and_then(Value::as_array)
            .ok_or_else(|| VeriqError::invalid_proof("missing storage proof nodes"))?,
    )?;
    Ok(StorageProof {
        key,
        value: slot_value,
        proof,
    })
}

fn parse_bytes_list(values: &[Value]) -> Result<Vec<Bytes>, VeriqError> {
    values
        .iter()
        .map(|value| {
            let encoded = value
                .as_str()
                .ok_or_else(|| VeriqError::invalid_proof("proof node is not a string"))?;
            let encoded = encoded.strip_prefix("0x").unwrap_or(encoded);
            let decoded = hex::decode(encoded).map_err(|err| {
                VeriqError::invalid_proof(format!("invalid proof node hex: {err}"))
            })?;
            Ok(Bytes::from(decoded))
        })
        .collect()
}

fn parse_b256(value: Option<&Value>) -> Result<B256, VeriqError> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| VeriqError::invalid_proof("missing 32-byte value"))?;
    B256::from_str(text).map_err(|err| VeriqError::invalid_proof(format!("invalid B256: {err}")))
}

/// A JSON-RPC quantity (`0x…`) as `u64`.
pub fn parse_u64(value: Option<&Value>) -> Result<u64, VeriqError> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| VeriqError::invalid_proof("missing quantity"))?;
    let text = text.strip_prefix("0x").unwrap_or(text);
    u64::from_str_radix(text, 16)
        .map_err(|err| VeriqError::invalid_proof(format!("invalid u64: {err}")))
}

/// A JSON-RPC quantity (`0x…`, empty = 0) as `U256`.
pub fn parse_u256(value: Option<&Value>) -> Result<U256, VeriqError> {
    let text = value
        .and_then(Value::as_str)
        .ok_or_else(|| VeriqError::invalid_proof("missing quantity"))?;
    let text = text.strip_prefix("0x").unwrap_or(text);
    if text.is_empty() {
        return Ok(U256::ZERO);
    }
    U256::from_str_radix(text, 16)
        .map_err(|err| VeriqError::invalid_proof(format!("invalid U256: {err}")))
}
