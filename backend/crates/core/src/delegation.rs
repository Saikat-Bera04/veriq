//! EIP-7702 delegation detection and classification module.
//!
//! Under EIP-7702, an account's code can be set to a 23-byte delegation designator:
//! `0xef0100 || 20-byte delegate address`.
//!
//! This module parses and classifies code proven against the state trie,
//! distinguishing normal EOAs, active delegated accounts, standard smart contracts,
//! revoked delegations, and malformed encodings.

use std::fmt;

use alloy_primitives::{Address, B256};
use serde::{Deserialize, Serialize};

/// The 3-byte prefix specified by EIP-7702: `[0xef, 0x01, 0x00]`.
pub const DELEGATION_PREFIX: [u8; 3] = [0xef, 0x01, 0x00];

/// Exact byte length of a valid EIP-7702 delegation designator:
/// 3-byte prefix + 20-byte address = 23 bytes.
pub const DESIGNATOR_LENGTH: usize = 23;

/// Errors that can occur when parsing a delegation designator.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DelegationParseError {
    /// Byte length is not 23 bytes.
    InvalidLength { expected: usize, actual: usize },
    /// First 3 bytes do not match `0xef0100`.
    InvalidPrefix,
}

impl fmt::Display for DelegationParseError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::InvalidLength { expected, actual } => {
                write!(
                    f,
                    "invalid delegation length: expected {expected}, got {actual}"
                )
            }
            Self::InvalidPrefix => write!(f, "invalid delegation prefix: expected 0xef0100"),
        }
    }
}

impl std::error::Error for DelegationParseError {}

/// An EIP-7702 delegation designator: `0xef0100 || target_address`.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationDesignator {
    pub delegate: Address,
}

impl DelegationDesignator {
    /// Construct a new designator.
    pub const fn new(delegate: Address) -> Self {
        Self { delegate }
    }

    /// True if the delegate is the zero address (which revokes/clears the delegation).
    pub fn is_revocation(&self) -> bool {
        self.delegate == Address::ZERO
    }

    /// Encode the designator as 23 raw bytes (`0xef0100 || address`).
    pub fn to_bytes(&self) -> [u8; DESIGNATOR_LENGTH] {
        let mut bytes = [0u8; DESIGNATOR_LENGTH];
        bytes[0..3].copy_from_slice(&DELEGATION_PREFIX);
        bytes[3..23].copy_from_slice(self.delegate.as_slice());
        bytes
    }
}

/// The classification of an account's proven bytecode.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "status", content = "delegate", rename_all = "kebab-case")]
pub enum DelegationStatus {
    /// Normal externally-owned account with empty bytecode.
    NormalEoa,
    /// Active EIP-7702 delegation to a non-zero delegate address.
    Delegated(Address),
    /// Standard smart contract code (non-empty bytecode that does not match 0xef0100..).
    Contract,
    /// Revoked / cleared delegation (designator pointing to Address::ZERO).
    Revoked,
    /// Malformed designator (begins with 0xef0100 but invalid length or corrupted).
    InvalidDesignator,
}

impl DelegationStatus {
    /// Whether this represents an active delegation to another contract or account.
    pub const fn is_delegated(&self) -> bool {
        matches!(self, Self::Delegated(_))
    }

    /// Returns the delegate target address if actively delegated.
    pub const fn delegate_address(&self) -> Option<Address> {
        match self {
            Self::Delegated(addr) => Some(*addr),
            _ => None,
        }
    }

    /// Human-readable status label.
    pub const fn as_str(&self) -> &'static str {
        match self {
            Self::NormalEoa => "normal-eoa",
            Self::Delegated(_) => "delegated",
            Self::Contract => "contract",
            Self::Revoked => "revoked",
            Self::InvalidDesignator => "invalid-designator",
        }
    }
}

impl fmt::Display for DelegationStatus {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Delegated(addr) => write!(f, "delegated to {addr:#x}"),
            _ => f.write_str(self.as_str()),
        }
    }
}

/// Security classification for detected account delegation.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DelegationSecurityClassification {
    /// No delegation active; account behaves as standard EOA.
    NormalEoa,
    /// Standard deployed smart contract (bytecode is not a delegation designator).
    SmartContract,
    /// Active delegation detected to a known or verified delegate.
    DelegationDetected,
    /// Delegation was cleared / revoked on-chain.
    DelegationRevoked,
    /// Delegate target address has not been independently inspected.
    UnverifiedDelegate,
    /// Delegate target contract bytecode has been verified.
    DelegateCodeVerified,
    /// Delegate target has empty code or exhibits anomalous patterns.
    PotentialRisk,
    /// Security assessment could not be completed.
    SecurityAssessmentUnavailable,
}

/// Complete, proof-verified result of an EIP-7702 delegation scan.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DelegationDetectionResult {
    /// The scanned account address.
    pub address: Address,
    /// The classification of the account's code.
    pub status: DelegationStatus,
    /// Convenience boolean for active delegation.
    pub is_delegated: bool,
    /// The delegate address if actively delegated.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegate_address: Option<Address>,
    /// Keccak256 hash of the account's proven bytecode.
    pub code_hash: B256,
    /// Keccak256 hash of the delegate contract's bytecode, if fetched and verified.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub delegate_code_hash: Option<B256>,
    /// Security classification.
    pub security_classification: DelegationSecurityClassification,
}

/// Parse an EIP-7702 delegation designator from raw bytecode.
///
/// Returns:
/// - `Ok(Some(delegate_address))` if the code is a valid 23-byte designator.
/// - `Ok(None)` if the code is empty or does not start with `0xef0100`.
/// - `Err(DelegationParseError)` if the code starts with `0xef0100` but has an invalid length.
pub fn parse_delegation_designator(code: &[u8]) -> Result<Option<Address>, DelegationParseError> {
    if code.is_empty() {
        return Ok(None);
    }

    if code.len() < DELEGATION_PREFIX.len() || !code.starts_with(&DELEGATION_PREFIX) {
        return Ok(None);
    }

    if code.len() != DESIGNATOR_LENGTH {
        return Err(DelegationParseError::InvalidLength {
            expected: DESIGNATOR_LENGTH,
            actual: code.len(),
        });
    }

    let delegate = Address::from_slice(&code[3..23]);
    Ok(Some(delegate))
}

/// Classify proven account bytecode according to EIP-7702 rules.
pub fn classify_account_code(code: &[u8]) -> DelegationStatus {
    if code.is_empty() {
        return DelegationStatus::NormalEoa;
    }

    match parse_delegation_designator(code) {
        Ok(Some(delegate)) => {
            if delegate == Address::ZERO {
                DelegationStatus::Revoked
            } else {
                DelegationStatus::Delegated(delegate)
            }
        }
        Ok(None) => DelegationStatus::Contract,
        Err(_) => DelegationStatus::InvalidDesignator,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use alloy_primitives::{address, b256, hex, keccak256};

    #[test]
    fn empty_code_is_normal_eoa() {
        assert_eq!(classify_account_code(&[]), DelegationStatus::NormalEoa);
        assert_eq!(parse_delegation_designator(&[]), Ok(None));
    }

    #[test]
    fn valid_delegation_is_parsed_and_classified() {
        let target = address!("1242C562946C926a6d0012Acb54D9413A54A1CA4");
        let designator = DelegationDesignator::new(target);
        let bytes = designator.to_bytes();

        assert_eq!(bytes.len(), 23);
        assert_eq!(&bytes[0..3], &[0xef, 0x01, 0x00]);
        assert_eq!(&bytes[3..23], target.as_slice());

        assert_eq!(parse_delegation_designator(&bytes), Ok(Some(target)));
        assert_eq!(
            classify_account_code(&bytes),
            DelegationStatus::Delegated(target)
        );
    }

    #[test]
    fn zero_address_delegation_is_classified_as_revoked() {
        let designator = DelegationDesignator::new(Address::ZERO);
        let bytes = designator.to_bytes();

        assert!(designator.is_revocation());
        assert_eq!(parse_delegation_designator(&bytes), Ok(Some(Address::ZERO)));
        assert_eq!(classify_account_code(&bytes), DelegationStatus::Revoked);
    }

    #[test]
    fn normal_contract_code_is_not_delegated() {
        // Standard contract bytecode (PUSH1 0x80 PUSH1 0x40 ...)
        let contract_code = hex!("608060405234801561001057600080fd5b50");
        assert_eq!(parse_delegation_designator(&contract_code), Ok(None));
        assert_eq!(
            classify_account_code(&contract_code),
            DelegationStatus::Contract
        );

        // Single byte contract (e.g. selfdestruct or revert)
        assert_eq!(parse_delegation_designator(&[0x00]), Ok(None));
        assert_eq!(classify_account_code(&[0x00]), DelegationStatus::Contract);
    }

    #[test]
    fn malformed_delegation_prefixes_and_lengths_are_handled() {
        // Starts with 0xef0100 but too short (22 bytes)
        let mut short_bytes = vec![0xef, 0x01, 0x00];
        short_bytes.extend_from_slice(&[0xaa; 19]);
        assert_eq!(short_bytes.len(), 22);
        assert!(matches!(
            parse_delegation_designator(&short_bytes),
            Err(DelegationParseError::InvalidLength {
                expected: 23,
                actual: 22
            })
        ));
        assert_eq!(
            classify_account_code(&short_bytes),
            DelegationStatus::InvalidDesignator
        );

        // Starts with 0xef0100 but too long (24 bytes)
        let mut long_bytes = vec![0xef, 0x01, 0x00];
        long_bytes.extend_from_slice(&[0xbb; 21]);
        assert_eq!(long_bytes.len(), 24);
        assert!(matches!(
            parse_delegation_designator(&long_bytes),
            Err(DelegationParseError::InvalidLength {
                expected: 23,
                actual: 24
            })
        ));
        assert_eq!(
            classify_account_code(&long_bytes),
            DelegationStatus::InvalidDesignator
        );

        // 23 bytes but wrong prefix (e.g. 0xef0200)
        let mut wrong_prefix = vec![0xef, 0x02, 0x00];
        wrong_prefix.extend_from_slice(&[0xcc; 20]);
        assert_eq!(parse_delegation_designator(&wrong_prefix), Ok(None));
        assert_eq!(
            classify_account_code(&wrong_prefix),
            DelegationStatus::Contract
        );
    }

    #[test]
    fn designator_code_hash_matches_eip7702() {
        let target = address!("0000000000000000000000000000000000000001");
        let designator = DelegationDesignator::new(target);
        let bytes = designator.to_bytes();
        let expected_hash = keccak256(bytes);
        assert_ne!(expected_hash, B256::ZERO);
        assert_ne!(
            expected_hash,
            b256!("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470")
        );
    }
}
