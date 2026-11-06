pub mod bounds;

use alloy_primitives::{keccak256, Address, Bytes, B256, U256};
use alloy_rlp::{decode_exact, Decodable, Header};
use alloy_trie::{
    nodes::{RlpNode, TrieNode},
    proof::verify_proof,
    Nibbles, TrieAccount,
};
use veriq_core::{Account, ProvenAccount, VeriqError, EMPTY_ROOT_HASH, KECCAK_EMPTY};

/// Verify an account proof against a trusted state root.
///
/// The returned value always comes from the trie, never from `claimed`. When `claimed`
/// is supplied it must equal the proven value, otherwise the proof is rejected.
pub fn verify_account(
    state_root: B256,
    address: Address,
    account_proof: &[Bytes],
    claimed: Option<Account>,
) -> Result<ProvenAccount, VeriqError> {
    bounds::check_proof_bounds(account_proof)?;

    let key = account_key(address);
    let proven_value = extract_proof_value(&key, account_proof)?;

    match proven_value {
        Some(rlp) => {
            let trie_account: TrieAccount = decode_exact(&rlp)
                .map_err(|err| VeriqError::invalid_proof(format!("invalid account RLP: {err}")))?;
            let proven = Account::new(
                trie_account.nonce,
                trie_account.balance,
                trie_account.storage_root,
                trie_account.code_hash,
            );
            if let Some(claimed) = claimed {
                if claimed != proven {
                    return Err(VeriqError::invalid_proof(
                        "claimed account does not match proven account",
                    ));
                }
            }
            verify_proof(state_root, key, Some(rlp), account_proof.iter())
                .map_err(|err| VeriqError::invalid_proof(format!("account proof: {err}")))?;
            Ok(ProvenAccount::present(proven))
        }
        None => {
            if let Some(claimed) = claimed {
                let empty_like = claimed.nonce == 0
                    && claimed.balance.is_zero()
                    && (claimed.storage_root == B256::ZERO
                        || claimed.storage_root == EMPTY_ROOT_HASH)
                    && (claimed.code_hash == B256::ZERO || claimed.code_hash == KECCAK_EMPTY);
                if !empty_like {
                    return Err(VeriqError::invalid_proof(
                        "claimed account does not match proven non-membership",
                    ));
                }
            }
            verify_proof(state_root, key, None, account_proof.iter()).map_err(|err| {
                VeriqError::invalid_proof(format!("account exclusion proof: {err}"))
            })?;
            Ok(ProvenAccount::absent())
        }
    }
}

/// Verify a storage slot proof against the proven storage root.
///
/// A zero value is returned only when the proof is a valid non-membership proof.
pub fn verify_storage(
    storage_root: B256,
    slot: U256,
    storage_proof: &[Bytes],
) -> Result<U256, VeriqError> {
    bounds::check_proof_bounds(storage_proof)?;

    let key = storage_key(slot);
    let value = extract_proof_value(&key, storage_proof)?;

    match value {
        Some(rlp) => {
            let decoded = decode_storage_value(&rlp)?;
            verify_proof(storage_root, key, Some(rlp), storage_proof.iter())
                .map_err(|err| VeriqError::invalid_proof(format!("storage proof: {err}")))?;
            Ok(decoded)
        }
        None => {
            verify_proof(storage_root, key, None, storage_proof.iter()).map_err(|err| {
                VeriqError::invalid_proof(format!("storage exclusion proof: {err}"))
            })?;
            Ok(U256::ZERO)
        }
    }
}

pub fn account_key(address: Address) -> Nibbles {
    Nibbles::unpack(keccak256(address.as_slice()))
}

pub fn storage_key(slot: U256) -> Nibbles {
    Nibbles::unpack(keccak256(slot.to_be_bytes::<32>()))
}

/// Walk the proof to find the leaf value for `key`. The result is untrusted until
/// `alloy_trie::proof::verify_proof` validates the path against the root.
///
/// Nodes are read in array order on purpose: EIP-1186 (`eth_getProof`) defines the
/// proof as the nodes from the root down the key's path, and `verify_proof` itself
/// requires that order (each node must hash to the reference in the one before it).
/// Looking children up by hash here would not make an unordered proof pass.
fn extract_proof_value(key: &Nibbles, proof: &[Bytes]) -> Result<Option<Vec<u8>>, VeriqError> {
    if proof.is_empty() {
        return Ok(None);
    }

    let mut path = Nibbles::new();
    let mut index = 0usize;
    let mut node = decode_node(proof, index)?;
    let mut iterations = 0usize;

    loop {
        iterations += 1;
        if iterations > 128 {
            return Err(VeriqError::invalid_proof("proof too deep"));
        }
        match node {
            TrieNode::EmptyRoot => return Ok(None),
            TrieNode::Leaf(leaf) => {
                path.extend(&leaf.key);
                return Ok(if path == *key { Some(leaf.value) } else { None });
            }
            TrieNode::Extension(extension) => {
                path.extend(&extension.key);
                if !key.starts_with(&path) {
                    return Ok(None);
                }
                node = follow_child(&extension.child, proof, &mut index)?;
            }
            TrieNode::Branch(branch) => {
                let Some(nibble) = key.get(path.len()) else {
                    return Ok(None);
                };
                path.push(nibble);
                let branch_ref = branch.as_ref();
                let Some(child) = branch_ref
                    .children()
                    .find_map(|(index, child)| (index == nibble).then_some(child).flatten())
                else {
                    return Ok(None);
                };
                node = follow_child(child, proof, &mut index)?;
            }
        }
    }
}

fn follow_child(
    child: &RlpNode,
    proof: &[Bytes],
    index: &mut usize,
) -> Result<TrieNode, VeriqError> {
    if child.is_hash() {
        *index += 1;
        decode_node(proof, *index)
    } else {
        let mut raw = child.as_slice();
        TrieNode::decode(&mut raw)
            .map_err(|err| VeriqError::invalid_proof(format!("invalid in-place node: {err}")))
    }
}

fn decode_node(proof: &[Bytes], index: usize) -> Result<TrieNode, VeriqError> {
    let bytes = proof
        .get(index)
        .ok_or_else(|| VeriqError::invalid_proof("truncated proof"))?;
    TrieNode::decode(&mut &bytes[..])
        .map_err(|err| VeriqError::invalid_proof(format!("invalid proof node: {err}")))
}

fn decode_storage_value(rlp: &[u8]) -> Result<U256, VeriqError> {
    let mut buf = rlp;
    let data = Header::decode_bytes(&mut buf, false)
        .map_err(|err| VeriqError::invalid_proof(format!("invalid storage RLP: {err}")))?;
    if !buf.is_empty() {
        return Err(VeriqError::invalid_proof("trailing bytes in storage value"));
    }
    if data.len() > 32 {
        return Err(VeriqError::invalid_proof(
            "storage value wider than 32 bytes",
        ));
    }
    Ok(U256::from_be_slice(data))
}
