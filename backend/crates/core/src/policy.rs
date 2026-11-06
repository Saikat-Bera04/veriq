use serde::{Deserialize, Serialize};

use crate::VeriqError;

/// Longest accepted overall deadline for one request.
pub const MAX_TIMEOUT_MS: u64 = 120_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum VerificationPolicy {
    Required,
    Preferred,
    Disabled,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum BlockPolicy {
    Finalized,
    Latest,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PrivacyPolicy {
    Required,
    Preferred,
    Off,
}

/// Single provider, or two providers at the same block with the agreement recorded.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Consistency {
    Single,
    Compare,
}

/// The request policy. One type for the whole workspace; mirrored by
/// `frontend/sdk/src/schema.ts` (`PolicySchema`). It never changes between
/// failover attempts.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Policy {
    pub verification: VerificationPolicy,
    pub privacy: PrivacyPolicy,
    pub consistency: Consistency,
    pub block_policy: BlockPolicy,
    pub timeout_ms: u64,
}

impl Policy {
    /// `verifiedFinalized`: only proven answers at finalized blocks, 8 s deadline.
    pub const VERIFIED_FINALIZED: Self = Self {
        verification: VerificationPolicy::Required,
        privacy: PrivacyPolicy::Off,
        consistency: Consistency::Single,
        block_policy: BlockPolicy::Finalized,
        timeout_ms: 8_000,
    };

    /// Reject contradictory or malformed policies before any network call.
    ///
    /// `latest` + `required` is unsatisfiable: a verified value needs a root the
    /// light client has authenticated, and only finalized roots qualify.
    pub fn validate(&self) -> Result<(), VeriqError> {
        if self.timeout_ms == 0 || self.timeout_ms > MAX_TIMEOUT_MS {
            return Err(VeriqError::invalid_request(format!(
                "timeoutMs must be between 1 and {MAX_TIMEOUT_MS}"
            )));
        }
        if self.block_policy == BlockPolicy::Latest
            && self.verification == VerificationPolicy::Required
        {
            return Err(VeriqError::policy_unsatisfiable(
                "blockPolicy=latest cannot satisfy verification=required; use finalized",
            ));
        }
        Ok(())
    }
}

impl Default for Policy {
    fn default() -> Self {
        Self::VERIFIED_FINALIZED
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::ErrorCode;
    use serde_json::json;

    #[test]
    fn default_is_verified_finalized_and_valid() {
        assert_eq!(Policy::default(), Policy::VERIFIED_FINALIZED);
        Policy::default()
            .validate()
            .expect("default policy is valid");
    }

    #[test]
    fn latest_with_required_is_policy_unsatisfiable() {
        let policy = Policy {
            block_policy: BlockPolicy::Latest,
            ..Policy::default()
        };
        assert_eq!(
            policy.validate().expect_err("unsatisfiable").code(),
            ErrorCode::PolicyUnsatisfiable
        );
    }

    #[test]
    fn zero_or_huge_timeout_is_invalid_request() {
        for timeout_ms in [0, MAX_TIMEOUT_MS + 1] {
            let policy = Policy {
                timeout_ms,
                ..Policy::default()
            };
            assert_eq!(
                policy.validate().expect_err("bad timeout").code(),
                ErrorCode::InvalidRequest
            );
        }
    }

    #[test]
    fn serializes_with_sdk_field_names() {
        let encoded = serde_json::to_value(Policy::default()).expect("serialize");
        assert_eq!(
            encoded,
            json!({
                "verification": "required",
                "privacy": "off",
                "consistency": "single",
                "blockPolicy": "finalized",
                "timeoutMs": 8000
            })
        );
        let unknown = serde_json::from_value::<Policy>(json!({
            "verification": "required", "privacy": "off", "consistency": "single",
            "blockPolicy": "finalized", "timeoutMs": 8000, "extra": true
        }));
        assert!(unknown.is_err(), "unknown policy fields are rejected");
    }
}
