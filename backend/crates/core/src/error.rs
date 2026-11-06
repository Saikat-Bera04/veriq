use std::fmt;

/// Stable JSON-RPC error codes used by the engine.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum ErrorCode {
    InvalidProof,
    RootUnavailable,
    UnsupportedVerification,
    PrivacyUnavailable,
    PolicyUnsatisfiable,
    ProviderTimeout,
    AllProvidersFailed,
    InvalidRequest,
    InternalError,
}

impl ErrorCode {
    pub const fn code(self) -> i32 {
        match self {
            Self::InvalidProof => -32010,
            Self::RootUnavailable => -32011,
            Self::UnsupportedVerification => -32012,
            Self::PrivacyUnavailable => -32013,
            Self::PolicyUnsatisfiable => -32014,
            Self::ProviderTimeout => -32015,
            Self::AllProvidersFailed => -32016,
            Self::InvalidRequest => -32602,
            Self::InternalError => -32603,
        }
    }

    pub const fn as_str(self) -> &'static str {
        match self {
            Self::InvalidProof => "INVALID_PROOF",
            Self::RootUnavailable => "ROOT_UNAVAILABLE",
            Self::UnsupportedVerification => "UNSUPPORTED_VERIFICATION",
            Self::PrivacyUnavailable => "PRIVACY_UNAVAILABLE",
            Self::PolicyUnsatisfiable => "POLICY_UNSATISFIABLE",
            Self::ProviderTimeout => "PROVIDER_TIMEOUT",
            Self::AllProvidersFailed => "ALL_PROVIDERS_FAILED",
            Self::InvalidRequest => "INVALID_REQUEST",
            Self::InternalError => "INTERNAL_ERROR",
        }
    }
}

impl fmt::Display for ErrorCode {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

/// Typed, fail-closed error. A weaker answer is never substituted for a failed guarantee.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct VeriqError {
    code: ErrorCode,
    message: String,
}

impl VeriqError {
    pub fn new(code: ErrorCode, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid_proof(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidProof, message)
    }

    pub fn root_unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::RootUnavailable, message)
    }

    pub fn unsupported_verification(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::UnsupportedVerification, message)
    }

    pub fn privacy_unavailable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PrivacyUnavailable, message)
    }

    pub fn policy_unsatisfiable(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::PolicyUnsatisfiable, message)
    }

    pub fn provider_timeout(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::ProviderTimeout, message)
    }

    pub fn all_providers_failed(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::AllProvidersFailed, message)
    }

    pub fn invalid_request(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InvalidRequest, message)
    }

    pub fn internal_error(message: impl Into<String>) -> Self {
        Self::new(ErrorCode::InternalError, message)
    }

    pub const fn code(&self) -> ErrorCode {
        self.code
    }

    pub const fn code_number(&self) -> i32 {
        self.code.code()
    }

    pub const fn code_str(&self) -> &'static str {
        self.code.as_str()
    }

    pub fn message(&self) -> &str {
        &self.message
    }
}

impl fmt::Display for VeriqError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{} ({}): {}", self.code, self.code.code(), self.message)
    }
}

impl std::error::Error for VeriqError {}
