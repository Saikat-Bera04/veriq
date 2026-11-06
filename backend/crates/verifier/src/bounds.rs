use alloy_primitives::Bytes;
use veriq_core::VeriqError;

/// Maximum number of nodes accepted in one account proof or one storage proof.
pub const MAX_PROOF_NODES: usize = 64;
/// Maximum size of a single RLP-encoded proof node.
pub const MAX_NODE_BYTES: usize = 1024;
/// Maximum size of the complete eth_getProof response body.
pub const MAX_RESPONSE_BYTES: usize = 2 * 1024 * 1024;

/// Reject oversized or over-long proofs before any decoding or hashing.
pub fn check_proof_bounds(nodes: &[Bytes]) -> Result<(), VeriqError> {
    if nodes.len() > MAX_PROOF_NODES {
        return Err(VeriqError::invalid_proof(format!(
            "proof has {} nodes, limit is {MAX_PROOF_NODES}",
            nodes.len()
        )));
    }
    for (index, node) in nodes.iter().enumerate() {
        if node.len() > MAX_NODE_BYTES {
            return Err(VeriqError::invalid_proof(format!(
                "proof node {index} is {} bytes, limit is {MAX_NODE_BYTES}",
                node.len()
            )));
        }
    }
    Ok(())
}

/// Reject a response body that exceeds the hard cap. Call this before buffering.
pub fn check_response_size(len: usize) -> Result<(), VeriqError> {
    if len > MAX_RESPONSE_BYTES {
        return Err(VeriqError::invalid_proof(format!(
            "proof response is {len} bytes, limit is {MAX_RESPONSE_BYTES}"
        )));
    }
    Ok(())
}
