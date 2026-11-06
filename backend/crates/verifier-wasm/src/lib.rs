//! The Veriq verifier as WebAssembly, for the browser (S5).
//!
//! The browser checks a proof with exactly the code the engine runs: `veriq_verify_read` calls
//! `veriq_verifier::read::verify_read`, the function behind the engine's own provider reads and
//! `veriq_verifyProof`. The same size bounds apply (64 nodes, 1 KiB per node, 2 MiB per body).
//!
//! The ABI is dependency-free (no wasm-bindgen). The caller allocates with [`veriq_alloc`],
//! copies a JSON request in, calls one function, and gets `(pointer << 32) | length` of a JSON
//! response back, which it frees with [`veriq_free`]. Every response has `ok`; on failure it has
//! `code` (an engine error name, e.g. `INVALID_PROOF`) and `error`.
//!
//! | Export | Request | Response |
//! |---|---|---|
//! | `veriq_verify_read` | `{ stateRoot, address, kind, slot?, proof, code? }`, `proof` an `eth_getProof` result, `kind` balance/nonce/storage/code | `{ ok, value }`: a `0x` quantity, or the code |
//! | `veriq_verify_account` | `{ root, address, proof: [node], claimed? }` | `{ ok, exists, account }` |
//! | `veriq_verify_storage` | `{ storageRoot, slot, proof: [node] }` | `{ ok, value }` |
//! | `veriq_code_hash_matches` | `{ code, codeHash }` | `{ ok, matches }` |
//! | `veriq_binding` | `{ method, value }` | `{ ok, binding }`: the engine's receipt binding (keccak256 of method + canonical JSON) |
//! | `veriq_abi_version` | — | `2` |

use std::str::FromStr;

use alloy_primitives::{hex, Address, Bytes, B256, U256};
use serde::Deserialize;
use serde_json::{json, Value};
use veriq_core::{binding, Account, VeriqError};
use veriq_verifier::{
    bounds::MAX_RESPONSE_BYTES,
    read::{code_hash_matches, parse_proof_result, verify_read, ProvenValue, ReadTarget},
    verify_account, verify_storage,
};

/// Bumped when a request or response shape changes. 1 was the M0 spike (verify_account only).
pub const ABI_VERSION: u32 = 2;
/// A request carries one eth_getProof body and, for code reads, one eth_getCode body; each is
/// capped at MAX_RESPONSE_BYTES by the engine, so the request is capped at twice that.
pub const MAX_REQUEST_BYTES: usize = 2 * MAX_RESPONSE_BYTES;

type Outcome = Result<Value, VeriqError>;

fn invalid(message: impl Into<String>) -> VeriqError {
    VeriqError::invalid_request(message)
}

fn parse_hash(text: &str, what: &str) -> Result<B256, VeriqError> {
    B256::from_str(text).map_err(|err| invalid(format!("invalid {what}: {err}")))
}

fn parse_address(text: &str) -> Result<Address, VeriqError> {
    Address::from_str(text).map_err(|err| invalid(format!("invalid address: {err}")))
}

fn parse_quantity(text: &str, what: &str) -> Result<U256, VeriqError> {
    let digits = text.trim().strip_prefix("0x").unwrap_or(text.trim());
    if digits.is_empty() {
        return Ok(U256::ZERO);
    }
    if digits.len() > 64 {
        return Err(invalid(format!("invalid {what}: more than 32 bytes")));
    }
    U256::from_str_radix(digits, 16).map_err(|err| invalid(format!("invalid {what}: {err}")))
}

fn parse_bytes(text: &str, what: &str) -> Result<Bytes, VeriqError> {
    let digits = text.strip_prefix("0x").unwrap_or(text);
    hex::decode(digits)
        .map(Bytes::from)
        .map_err(|err| VeriqError::invalid_proof(format!("invalid {what} hex: {err}")))
}

fn parse_nodes(proof: &[String]) -> Result<Vec<Bytes>, VeriqError> {
    proof
        .iter()
        .map(|node| parse_bytes(node, "proof node"))
        .collect()
}

fn request<T: for<'de> Deserialize<'de>>(input: &[u8]) -> Result<T, VeriqError> {
    if input.len() > MAX_REQUEST_BYTES {
        return Err(VeriqError::invalid_proof(format!(
            "request is {} bytes, limit is {MAX_REQUEST_BYTES}",
            input.len()
        )));
    }
    serde_json::from_slice(input).map_err(|err| invalid(format!("invalid request: {err}")))
}

// ---- veriq_verify_read --------------------------------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReadRequest {
    state_root: String,
    address: String,
    kind: String,
    #[serde(default)]
    slot: Option<String>,
    proof: Value,
    #[serde(default)]
    code: Option<String>,
}

/// One read, checked exactly as the engine checks it. The value is formatted like the
/// engine's `veriq_verifyProof` result: a `0x` quantity for words, the bytecode for code.
pub fn verify_read_json(input: &[u8]) -> Outcome {
    let req: ReadRequest = request(input)?;
    let state_root = parse_hash(&req.state_root, "stateRoot")?;
    let address = parse_address(&req.address)?;
    let target = match req.kind.as_str() {
        "balance" => ReadTarget::Balance,
        "nonce" => ReadTarget::Nonce,
        "code" => ReadTarget::Code,
        "storage" => {
            let slot = req
                .slot
                .as_deref()
                .ok_or_else(|| invalid("a storage read needs a slot"))?;
            ReadTarget::Storage(parse_quantity(slot, "slot")?)
        }
        _ => return Err(invalid("kind must be balance, nonce, code or storage")),
    };
    let code = match (target, req.code.as_deref()) {
        (ReadTarget::Code, Some(code)) => Some(parse_bytes(code, "code")?),
        (ReadTarget::Code, None) => return Err(invalid("code (the eth_getCode result) missing")),
        _ => None,
    };
    let bundle = parse_proof_result(&req.proof)?;
    let value = match verify_read(&bundle, code, address, target, state_root)? {
        ProvenValue::Word(value) => format!("{value:#x}"),
        ProvenValue::Code(code) => format!("0x{}", hex::encode(code)),
    };
    Ok(json!({ "ok": true, "value": value }))
}

// ---- veriq_verify_account (M0 shape, kept) --------------------------------------------------

#[derive(Deserialize)]
struct AccountRequest {
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

pub fn verify_account_json(input: &[u8]) -> Outcome {
    let req: AccountRequest = request(input)?;
    let claimed = match req.claimed {
        Some(c) => Some(Account::new(
            c.nonce,
            parse_quantity(&c.balance, "balance")?,
            parse_hash(&c.storage_hash, "storageHash")?,
            parse_hash(&c.code_hash, "codeHash")?,
        )),
        None => None,
    };
    let proven = verify_account(
        parse_hash(&req.root, "root")?,
        parse_address(&req.address)?,
        &parse_nodes(&req.proof)?,
        claimed,
    )?;
    Ok(json!({ "ok": true, "exists": proven.exists, "account": proven.account }))
}

// ---- veriq_verify_storage / veriq_code_hash_matches ---------------------------------------------

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct StorageRequest {
    storage_root: String,
    slot: String,
    proof: Vec<String>,
}

pub fn verify_storage_json(input: &[u8]) -> Outcome {
    let req: StorageRequest = request(input)?;
    let value = verify_storage(
        parse_hash(&req.storage_root, "storageRoot")?,
        parse_quantity(&req.slot, "slot")?,
        &parse_nodes(&req.proof)?,
    )?;
    Ok(json!({ "ok": true, "value": format!("{value:#x}") }))
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CodeHashRequest {
    code: String,
    code_hash: String,
}

pub fn code_hash_matches_json(input: &[u8]) -> Outcome {
    let req: CodeHashRequest = request(input)?;
    let matches = code_hash_matches(
        &parse_bytes(&req.code, "code")?,
        parse_hash(&req.code_hash, "codeHash")?,
    );
    Ok(json!({ "ok": true, "matches": matches }))
}

#[derive(Deserialize)]
struct BindingRequest {
    method: String,
    value: Value,
}

/// The receipt binding exactly as the engine computes it, for receipts made in the browser.
pub fn binding_json(input: &[u8]) -> Outcome {
    let req: BindingRequest = request(input)?;
    Ok(json!({ "ok": true, "binding": binding(&req.method, &req.value) }))
}

// ---- ABI ----------------------------------------------------------------------------------------

fn respond(outcome: Outcome) -> Vec<u8> {
    let value = outcome.unwrap_or_else(
        |err| json!({ "ok": false, "code": err.code_str(), "error": err.message() }),
    );
    serde_json::to_vec(&value).unwrap_or_else(|_| {
        br#"{"ok":false,"code":"INTERNAL_ERROR","error":"serialise failed"}"#.to_vec()
    })
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
unsafe fn call(ptr: *const u8, len: usize, f: fn(&[u8]) -> Outcome) -> u64 {
    let input = if len == 0 {
        &[][..]
    } else {
        std::slice::from_raw_parts(ptr, len)
    };
    let boxed = respond(f(input)).into_boxed_slice();
    let out_len = boxed.len() as u32;
    let out_ptr = Box::into_raw(boxed) as *mut u8 as u32;
    (u64::from(out_ptr) << 32) | u64::from(out_len)
}

/// Allocate `len` zeroed bytes for the caller. Free with [`veriq_free`].
#[no_mangle]
pub extern "C" fn veriq_alloc(len: usize) -> *mut u8 {
    let boxed = vec![0u8; len].into_boxed_slice();
    Box::into_raw(boxed) as *mut u8
}

/// Free a buffer from [`veriq_alloc`] or one returned by a `veriq_verify_*` call.
///
/// # Safety
/// `ptr` and `len` must come from one of those and be freed exactly once.
#[no_mangle]
pub unsafe extern "C" fn veriq_free(ptr: *mut u8, len: usize) {
    if ptr.is_null() {
        return;
    }
    let slice = std::ptr::slice_from_raw_parts_mut(ptr, len);
    drop(Box::from_raw(slice));
}

#[no_mangle]
pub extern "C" fn veriq_abi_version() -> u32 {
    ABI_VERSION
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn veriq_verify_read(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, verify_read_json)
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn veriq_verify_account(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, verify_account_json)
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn veriq_verify_storage(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, verify_storage_json)
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn veriq_code_hash_matches(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, code_hash_matches_json)
}

/// # Safety
/// `ptr` must point to `len` readable bytes.
#[no_mangle]
pub unsafe extern "C" fn veriq_binding(ptr: *const u8, len: usize) -> u64 {
    call(ptr, len, binding_json)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixture(name: &str) -> Value {
        let path = format!("{}/../../../fixtures/{name}", env!("CARGO_MANIFEST_DIR"));
        serde_json::from_str(&std::fs::read_to_string(path).expect("fixture")).expect("json")
    }

    fn read(fixture: &Value, kind: &str, slot: Option<&str>, code: Option<&Value>) -> Value {
        let mut req = json!({
            "stateRoot": fixture["block"]["stateRoot"],
            "address": fixture["address"],
            "kind": kind,
            "proof": fixture["proof"],
        });
        if let Some(slot) = slot {
            req["slot"] = json!(slot);
        }
        if let Some(code) = code {
            req["code"] = code.clone();
        }
        respond_value(verify_read_json(req.to_string().as_bytes()))
    }

    fn respond_value(outcome: Outcome) -> Value {
        serde_json::from_slice(&respond(outcome)).expect("response json")
    }

    fn ok_value(response: &Value) -> &str {
        assert_eq!(response["ok"], true, "{response}");
        response["value"].as_str().expect("value")
    }

    fn rejected(response: &Value, code: &str) {
        assert_eq!(response["ok"], false, "{response}");
        assert_eq!(response["code"], code, "{response}");
    }

    #[test]
    fn eoa_balance_and_nonce_are_the_proven_values() {
        let f = fixture("eoa.json");
        assert_eq!(
            ok_value(&read(&f, "balance", None, None)),
            f["proof"]["balance"].as_str().unwrap()
        );
        assert_eq!(ok_value(&read(&f, "nonce", None, None)), "0xd");
    }

    #[test]
    fn storage_slots_are_proven() {
        let f = fixture("storage-slot.json");
        for p in f["proof"]["storageProof"].as_array().unwrap() {
            let value = ok_value(&read(&f, "storage", p["key"].as_str(), None)).to_owned();
            assert_eq!(
                U256::from_str(&value).unwrap(),
                U256::from_str(p["value"].as_str().unwrap()).unwrap()
            );
        }
    }

    #[test]
    fn demo_contract_slot_zero_is_42_and_an_unwritten_slot_is_zero_by_exclusion() {
        let f = fixture("demo-storage.json");
        assert_eq!(ok_value(&read(&f, "storage", Some("0x0"), None)), "0x2a");
        assert_eq!(ok_value(&read(&f, "storage", Some("0x7"), None)), "0x0");
    }

    #[test]
    fn code_is_returned_only_when_it_matches_the_proven_code_hash() {
        let f = fixture("demo-storage.json");
        let code = &f["code"];
        assert_eq!(
            ok_value(&read(&f, "code", None, Some(code))),
            code.as_str().unwrap()
        );
        rejected(
            &read(&f, "code", None, Some(&json!("0x6080"))),
            "INVALID_PROOF",
        );
        rejected(&read(&f, "code", None, None), "INVALID_REQUEST");
    }

    #[test]
    fn absent_account_is_zero_only_with_its_exclusion_proof() {
        let f = fixture("absent-account.json");
        assert_eq!(ok_value(&read(&f, "balance", None, None)), "0x0");
        assert_eq!(ok_value(&read(&f, "nonce", None, None)), "0x0");
    }

    #[test]
    fn a_tampered_claimed_balance_is_rejected() {
        let mut f = fixture("eoa.json");
        f["proof"]["balance"] = json!("0x1");
        rejected(&read(&f, "balance", None, None), "INVALID_PROOF");
    }

    #[test]
    fn a_tampered_claimed_storage_value_is_rejected() {
        let mut f = fixture("demo-storage.json");
        f["proof"]["storageProof"][0]["value"] = json!("0x2b");
        rejected(&read(&f, "storage", Some("0x0"), None), "INVALID_PROOF");
    }

    #[test]
    fn a_flipped_byte_in_a_proof_node_is_rejected() {
        let mut f = fixture("eoa.json");
        let last = f["proof"]["accountProof"].as_array().unwrap().len() - 1;
        let node = f["proof"]["accountProof"][last]
            .as_str()
            .unwrap()
            .to_owned();
        let flipped = format!(
            "{}{}",
            &node[..node.len() - 2],
            if node.ends_with("00") { "01" } else { "00" }
        );
        f["proof"]["accountProof"][last] = json!(flipped);
        rejected(&read(&f, "balance", None, None), "INVALID_PROOF");
    }

    #[test]
    fn a_wrong_state_root_is_rejected() {
        let mut f = fixture("eoa.json");
        f["block"]["stateRoot"] = json!(format!("{:#x}", B256::repeat_byte(0x11)));
        rejected(&read(&f, "balance", None, None), "INVALID_PROOF");
    }

    #[test]
    fn a_slot_the_proof_does_not_cover_is_rejected() {
        let f = fixture("storage-slot.json");
        rejected(&read(&f, "storage", Some("0x5"), None), "INVALID_PROOF");
        rejected(&read(&f, "storage", None, None), "INVALID_REQUEST");
    }

    #[test]
    fn oversized_nodes_and_requests_are_rejected_before_verification() {
        let mut f = fixture("eoa.json");
        f["proof"]["accountProof"][0] = json!(format!("0x{}", "ab".repeat(1025)));
        rejected(&read(&f, "balance", None, None), "INVALID_PROOF");
        let big = vec![b' '; MAX_REQUEST_BYTES + 1];
        rejected(&respond_value(verify_read_json(&big)), "INVALID_PROOF");
    }

    #[test]
    fn bad_requests_are_invalid_request() {
        rejected(
            &respond_value(verify_read_json(b"not json")),
            "INVALID_REQUEST",
        );
        let f = fixture("eoa.json");
        rejected(&read(&f, "logs", None, None), "INVALID_REQUEST");
    }

    #[test]
    fn binding_is_the_engine_binding() {
        let value = json!({"address": "0x01", "kind": "balance"});
        let response = respond_value(binding_json(
            json!({ "method": "veriq_verifyProof", "value": value })
                .to_string()
                .as_bytes(),
        ));
        assert_eq!(response["binding"], binding("veriq_verifyProof", &value));
    }

    #[test]
    fn single_checks_match_the_combined_read() {
        let f = fixture("demo-storage.json");
        let account = respond_value(verify_account_json(
            json!({ "root": f["block"]["stateRoot"], "address": f["address"], "proof": f["proof"]["accountProof"] })
                .to_string()
                .as_bytes(),
        ));
        assert_eq!(account["ok"], true, "{account}");
        assert_eq!(account["exists"], true);
        let storage = respond_value(verify_storage_json(
            json!({ "storageRoot": f["proof"]["storageHash"], "slot": "0x0", "proof": f["proof"]["storageProof"][0]["proof"] })
                .to_string()
                .as_bytes(),
        ));
        assert_eq!(ok_value(&storage), "0x2a");
        let code = respond_value(code_hash_matches_json(
            json!({ "code": f["code"], "codeHash": f["proof"]["codeHash"] })
                .to_string()
                .as_bytes(),
        ));
        assert_eq!(code["matches"], true);
    }
}
