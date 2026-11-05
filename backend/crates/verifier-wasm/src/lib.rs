//! Raw WebAssembly ABI for the Veriq verifier (M0.4 feasibility).
//!
//! The page sends a JSON request through a small allocate/call/free handoff. The ABI is
//! deliberately dependency-free (no wasm-bindgen): one exported function returns a packed
//! `(pointer << 32) | length` into the wasm linear memory, and JS copies the bytes out.
//!
//! Input:
//! ```json
//! { "root": "0x…", "address": "0x…", "proof": ["0x…"], "claimed": { "nonce": 1,
//!   "balance": "0x…", "storageHash": "0x…", "codeHash": "0x…" } }
//! ```
//! `claimed` is optional; when present it must equal the proven account.
//!
//! Output:
//! ```json
//! { "ok": true, "exists": true, "account": { … }, "error": null }
//! ```

use std::str::FromStr;

use alloy_primitives::{hex, Address, Bytes, B256, U256};
use serde::{Deserialize, Serialize};
use veriq_core::Account;
use veriq_verifier::verify_account;

#[derive(Deserialize)]
struct VerifyRequest {
    root: String,
    address: String,
    proof: Vec<String>,
    #[serde(default)]
    claimed: Option<ClaimedAccount>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClaimedAccount {
    nonce: u64,
    balance: String,
    storage_hash: String,
    code_hash: String,
}

#[derive(Serialize)]
struct VerifyResponse {
    ok: bool,
    exists: bool,
    account: Option<Account>,
    error: Option<String>,
}

fn parse_quantity(text: &str) -> Result<U256, String> {
    let text = text.trim();
    let text = text.strip_prefix("0x").unwrap_or(text);
    if text.is_empty() {
        return Ok(U256::ZERO);
    }
    U256::from_str_radix(text, 16).map_err(|err| format!("invalid quantity: {err}"))
}

fn parse_root(text: &str) -> Result<B256, String> {
    B256::from_str(text).map_err(|err| format!("invalid root: {err}"))
}

fn parse_hash(text: &str) -> Result<B256, String> {
    B256::from_str(text).map_err(|err| format!("invalid hash: {err}"))
}

fn parse_address(text: &str) -> Result<Address, String> {
    Address::from_str(text).map_err(|err| format!("invalid address: {err}"))
}

fn parse_nodes(proof: &[String]) -> Result<Vec<Bytes>, String> {
    proof
        .iter()
        .map(|node| {
            let text = node.strip_prefix("0x").unwrap_or(node);
            hex::decode(text)
                .map(Bytes::from)
                .map_err(|err| format!("invalid proof node: {err}"))
        })
        .collect()
}

fn verify(input: &[u8]) -> Result<VerifyResponse, String> {
    let request: VerifyRequest =
        serde_json::from_slice(input).map_err(|err| format!("invalid input: {err}"))?;
    let claimed = match request.claimed {
        Some(claimed) => Some(Account::new(
            claimed.nonce,
            parse_quantity(&claimed.balance)?,
            parse_hash(&claimed.storage_hash)?,
            parse_hash(&claimed.code_hash)?,
        )),
        None => None,
    };
    let proven = verify_account(
        parse_root(&request.root)?,
        parse_address(&request.address)?,
        &parse_nodes(&request.proof)?,
        claimed,
    )
    .map_err(|err| format!("{}: {}", err.code_str(), err.message()))?;
    Ok(VerifyResponse {
        ok: true,
        exists: proven.exists,
        account: Some(proven.account),
        error: None,
    })
}

fn verify_to_json(input: &[u8]) -> Vec<u8> {
    let response = match verify(input) {
        Ok(response) => response,
        Err(error) => VerifyResponse {
            ok: false,
            exists: false,
            account: None,
            error: Some(error),
        },
    };
    serde_json::to_vec(&response).unwrap_or_else(|_| {
        br#"{"ok":false,"exists":false,"account":null,"error":"serialise failed"}"#.to_vec()
    })
}

/// Allocate `len` zeroed bytes for the caller. Free with [`veriq_free`].
#[no_mangle]
pub extern "C" fn veriq_alloc(len: usize) -> *mut u8 {
    let boxed = vec![0u8; len].into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

/// Free a buffer from [`veriq_alloc`] or returned by [`veriq_verify_account`].
///
/// # Safety
/// `ptr` and `len` must come from one of those two functions and be freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn veriq_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let slice = std::ptr::slice_from_raw_parts_mut(ptr, len);
    drop(Box::from_raw(slice));
}

/// Verify one account proof. Returns `(pointer << 32) | length` for the JSON response.
///
/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn veriq_verify_account(ptr: *const u8, len: usize) -> u64 {
    let input = std::slice::from_raw_parts(ptr, len);
    let boxed = verify_to_json(input).into_boxed_slice();
    let out_len = boxed.len() as u32;
    let out_ptr = Box::into_raw(boxed) as *mut u8 as u32;
    (u64::from(out_ptr) << 32) | u64::from(out_len)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn eoa_fixture_verifies_through_the_json_abi() {
        let text = include_str!("../../../../fixtures/eoa.json");
        let fixture: serde_json::Value = serde_json::from_str(text).expect("fixture");
        let result = &fixture["proof"];
        let request = serde_json::json!({
            "root": fixture["block"]["stateRoot"],
            "address": fixture["address"],
            "proof": result["accountProof"],
            "claimed": {
                "nonce": u64::from_str_radix(result["nonce"].as_str().unwrap().trim_start_matches("0x"), 16).unwrap(),
                "balance": result["balance"],
                "storageHash": result["storageHash"],
                "codeHash": result["codeHash"],
            },
        });
        let response = verify(serde_json::to_string(&request).unwrap().as_bytes()).expect("verify");
        assert!(response.ok);
        assert!(response.exists);
        let account = response.account.expect("account");
        assert_eq!(
            account.storage_root.to_string().to_lowercase(),
            result["storageHash"].as_str().unwrap().to_lowercase()
        );
        assert_eq!(
            account.code_hash.to_string().to_lowercase(),
            result["codeHash"].as_str().unwrap().to_lowercase()
        );
    }
}
