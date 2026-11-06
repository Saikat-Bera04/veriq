//! fixtures/receipt-sample.json is a real receipt captured from the engine
//! (Helios root, Sepolia). frontend/sdk/test/schema.test.ts parses the same file,
//! so any drift between receipt.rs and schema.ts fails CI on one side or the other.

use veriq_core::{Receipt, VerificationStatus};

const SAMPLE: &str = include_str!("../../../../fixtures/receipt-sample.json");

#[test]
fn sample_receipt_round_trips_exactly() {
    let original: serde_json::Value = serde_json::from_str(SAMPLE).expect("valid JSON");
    let receipt: Receipt = serde_json::from_value(original.clone()).expect("matches receipt.rs");
    let reencoded = serde_json::to_value(&receipt).expect("serializes");
    assert_eq!(
        reencoded, original,
        "receipt.rs no longer produces this exact shape"
    );
    assert_eq!(receipt.verification.status, VerificationStatus::Verified);
    assert!(receipt.block.finalized);
}
