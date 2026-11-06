//! Provider probing and circuit breaking for the Veriq engine.
//!
//! The engine (`veriq-server`) runs the read loop itself; this crate supplies the
//! startup capability probe, the per-provider circuit breaker and the attempt cap.

pub mod breaker;
pub mod probe;

/// Most providers tried for one read before the engine gives up.
pub const MAX_PROVIDER_ATTEMPTS: usize = 3;
