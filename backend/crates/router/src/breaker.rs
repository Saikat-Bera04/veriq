use std::{
    collections::HashMap,
    sync::{Mutex, MutexGuard},
    time::Duration,
};

use serde::Serialize;
use tokio::time::Instant;

const INVALID_PROOF_COOLDOWN: Duration = Duration::from_secs(5 * 60);
const TRANSPORT_COOLDOWN: Duration = Duration::from_secs(30);
const TRANSPORT_FAILURE_THRESHOLD: u32 = 3;

/// Configurable cooldown policy. The production defaults are five minutes for
/// invalid proofs and thirty seconds after three consecutive transport errors.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct BreakerConfig {
    pub invalid_proof_cooldown: Duration,
    pub transport_cooldown: Duration,
    pub transport_failure_threshold: u32,
}

impl Default for BreakerConfig {
    fn default() -> Self {
        Self {
            invalid_proof_cooldown: INVALID_PROOF_COOLDOWN,
            transport_cooldown: TRANSPORT_COOLDOWN,
            transport_failure_threshold: TRANSPORT_FAILURE_THRESHOLD,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum CooldownReason {
    InvalidProof,
    TransportFailures,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ProviderBreakerSnapshot {
    pub provider: String,
    pub consecutive_transport_failures: u32,
    pub cooldown_remaining_ms: u64,
    pub cooldown_reason: Option<CooldownReason>,
}

#[derive(Debug, Default)]
struct ProviderState {
    consecutive_transport_failures: u32,
    cooldown_until: Option<Instant>,
    cooldown_reason: Option<CooldownReason>,
}

/// Router-owned circuit breaker state. It uses Tokio's monotonic `Instant`;
/// cooldowns do not sleep or block request tasks.
pub struct CircuitBreaker {
    config: BreakerConfig,
    providers: Mutex<HashMap<String, ProviderState>>,
}

impl Default for CircuitBreaker {
    fn default() -> Self {
        Self::new(BreakerConfig::default())
    }
}

impl CircuitBreaker {
    pub fn new(config: BreakerConfig) -> Self {
        Self {
            config: BreakerConfig {
                transport_failure_threshold: config.transport_failure_threshold.max(1),
                ..config
            },
            providers: Mutex::new(HashMap::new()),
        }
    }

    /// Returns whether a provider can be selected at `now`. Passing `now`
    /// explicitly also makes expiry behavior deterministic in tests.
    pub fn is_eligible_at(&self, provider: &str, now: Instant) -> bool {
        let mut providers = self.lock();
        let state = providers.entry(provider.to_owned()).or_default();
        expire_cooldown(state, now);
        state.cooldown_until.is_none()
    }

    pub fn is_eligible(&self, provider: &str) -> bool {
        self.is_eligible_at(provider, Instant::now())
    }

    pub fn record_invalid_proof_at(&self, provider: &str, now: Instant) {
        let mut providers = self.lock();
        let state = providers.entry(provider.to_owned()).or_default();
        state.consecutive_transport_failures = 0;
        state.cooldown_until = Some(now + self.config.invalid_proof_cooldown);
        state.cooldown_reason = Some(CooldownReason::InvalidProof);
    }

    pub fn record_invalid_proof(&self, provider: &str) {
        self.record_invalid_proof_at(provider, Instant::now());
    }

    pub fn record_transport_failure_at(&self, provider: &str, now: Instant) {
        let mut providers = self.lock();
        let state = providers.entry(provider.to_owned()).or_default();
        expire_cooldown(state, now);
        if state.cooldown_until.is_some() {
            return;
        }
        state.consecutive_transport_failures =
            state.consecutive_transport_failures.saturating_add(1);
        if state.consecutive_transport_failures >= self.config.transport_failure_threshold {
            state.cooldown_until = Some(now + self.config.transport_cooldown);
            state.cooldown_reason = Some(CooldownReason::TransportFailures);
        }
    }

    pub fn record_transport_failure(&self, provider: &str) {
        self.record_transport_failure_at(provider, Instant::now());
    }

    /// A successful HTTP/RPC transport clears the consecutive transport
    /// counter, but does not erase an already-active cooldown.
    pub fn record_successful_transport_at(&self, provider: &str, now: Instant) {
        let mut providers = self.lock();
        let state = providers.entry(provider.to_owned()).or_default();
        expire_cooldown(state, now);
        state.consecutive_transport_failures = 0;
    }

    pub fn record_successful_transport(&self, provider: &str) {
        self.record_successful_transport_at(provider, Instant::now());
    }

    pub fn snapshot(&self, providers: &[String]) -> Vec<ProviderBreakerSnapshot> {
        self.snapshot_at(providers, Instant::now())
    }

    pub fn snapshot_at(&self, providers: &[String], now: Instant) -> Vec<ProviderBreakerSnapshot> {
        let mut states = self.lock();
        providers
            .iter()
            .map(|provider| {
                let state = states.entry(provider.clone()).or_default();
                expire_cooldown(state, now);
                let remaining = state
                    .cooldown_until
                    .map(|until| until.saturating_duration_since(now))
                    .unwrap_or_default();
                ProviderBreakerSnapshot {
                    provider: provider.clone(),
                    consecutive_transport_failures: state.consecutive_transport_failures,
                    cooldown_remaining_ms: remaining.as_millis().min(u128::from(u64::MAX)) as u64,
                    cooldown_reason: state.cooldown_reason,
                }
            })
            .collect()
    }

    /// Forget every provider's cooldown and failure count. Returns how many
    /// providers were cooling down. For demo builds only (see the engine's
    /// `demo` feature); production code never calls this.
    pub fn reset(&self) -> usize {
        let now = Instant::now();
        let mut states = self.lock();
        let mut cooling = 0;
        for state in states.values_mut() {
            expire_cooldown(state, now);
            if state.cooldown_until.is_some() {
                cooling += 1;
            }
        }
        states.clear();
        cooling
    }

    fn lock(&self) -> MutexGuard<'_, HashMap<String, ProviderState>> {
        self.providers
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

fn expire_cooldown(state: &mut ProviderState, now: Instant) {
    if state.cooldown_until.is_some_and(|until| until <= now) {
        state.cooldown_until = None;
        state.cooldown_reason = None;
        state.consecutive_transport_failures = 0;
    }
}

#[cfg(test)]
mod tests {
    use std::time::Duration;

    use tokio::time::Instant;

    use super::{BreakerConfig, CircuitBreaker, CooldownReason};

    fn breaker() -> CircuitBreaker {
        CircuitBreaker::new(BreakerConfig {
            invalid_proof_cooldown: Duration::from_secs(300),
            transport_cooldown: Duration::from_secs(30),
            transport_failure_threshold: 3,
        })
    }

    #[test]
    fn invalid_proof_cooldown_lasts_exactly_five_minutes_by_default() {
        let breaker = CircuitBreaker::default();
        let t0 = Instant::now();
        breaker.record_invalid_proof_at("attacker", t0);
        assert!(!breaker.is_eligible_at("attacker", t0 + Duration::from_secs(299)));
        assert!(breaker.is_eligible_at("attacker", t0 + Duration::from_secs(300)));
    }

    #[test]
    fn transport_cooldown_starts_at_the_third_failure_and_lasts_thirty_seconds() {
        let breaker = CircuitBreaker::default();
        let t0 = Instant::now();
        breaker.record_transport_failure_at("flaky", t0);
        breaker.record_transport_failure_at("flaky", t0);
        assert!(
            breaker.is_eligible_at("flaky", t0),
            "two failures do not bench"
        );
        breaker.record_transport_failure_at("flaky", t0);
        assert!(!breaker.is_eligible_at("flaky", t0 + Duration::from_secs(29)));
        assert!(breaker.is_eligible_at("flaky", t0 + Duration::from_secs(30)));
    }

    #[test]
    fn recovered_provider_is_tried_again_and_rebenched_by_a_new_failure() {
        // No separate half-open state: once the cooldown ends the provider is eligible
        // on trial. A success keeps it in use; a new invalid proof benches it again.
        let breaker = CircuitBreaker::default();
        let t0 = Instant::now();
        breaker.record_invalid_proof_at("p", t0);
        let t1 = t0 + Duration::from_secs(300);
        assert!(breaker.is_eligible_at("p", t1), "trial after the cooldown");
        breaker.record_successful_transport_at("p", t1);
        assert!(breaker.is_eligible_at("p", t1 + Duration::from_secs(1)));
        breaker.record_invalid_proof_at("p", t1 + Duration::from_secs(1));
        assert!(!breaker.is_eligible_at("p", t1 + Duration::from_secs(2)));
        assert!(breaker.is_eligible_at("p", t1 + Duration::from_secs(301)));
    }

    #[test]
    fn reset_clears_cooldowns_and_failure_counts() {
        let breaker = breaker();
        breaker.record_invalid_proof("attacker");
        breaker.record_transport_failure("flaky");
        breaker.record_transport_failure("flaky");
        assert!(!breaker.is_eligible("attacker"));

        assert_eq!(breaker.reset(), 1, "one provider was cooling down");
        assert!(breaker.is_eligible("attacker"));
        // The flaky provider's two failures are forgotten: one more does not open it.
        breaker.record_transport_failure("flaky");
        assert!(breaker.is_eligible("flaky"));
        assert_eq!(breaker.reset(), 0);
    }

    #[test]
    fn invalid_proof_triggers_cooldown() {
        let breaker = breaker();
        let now = Instant::now();
        breaker.record_invalid_proof_at("alpha", now);
        assert!(!breaker.is_eligible_at("alpha", now));

        let state = breaker.snapshot_at(&["alpha".to_owned()], now);
        assert_eq!(state[0].cooldown_reason, Some(CooldownReason::InvalidProof));
        assert_eq!(state[0].cooldown_remaining_ms, 300_000);

        breaker.record_transport_failure_at("alpha", now + Duration::from_secs(1));
        breaker.record_transport_failure_at("alpha", now + Duration::from_secs(1));
        breaker.record_transport_failure_at("alpha", now + Duration::from_secs(1));
        let state = breaker.snapshot_at(&["alpha".to_owned()], now + Duration::from_secs(1));
        assert_eq!(state[0].cooldown_reason, Some(CooldownReason::InvalidProof));
        assert_eq!(state[0].cooldown_remaining_ms, 299_000);
    }

    #[test]
    fn transport_cooldown_starts_on_third_consecutive_failure() {
        let breaker = breaker();
        let now = Instant::now();
        breaker.record_transport_failure_at("alpha", now);
        breaker.record_transport_failure_at("alpha", now);
        assert!(breaker.is_eligible_at("alpha", now));
        assert_eq!(
            breaker.snapshot(&["alpha".to_owned()])[0].consecutive_transport_failures,
            2
        );

        breaker.record_transport_failure_at("alpha", now);
        assert!(!breaker.is_eligible_at("alpha", now));
        let state = breaker.snapshot_at(&["alpha".to_owned()], now);
        assert_eq!(
            state[0].cooldown_reason,
            Some(CooldownReason::TransportFailures)
        );
        assert_eq!(state[0].cooldown_remaining_ms, 30_000);
    }

    #[test]
    fn success_resets_consecutive_transport_failures() {
        let breaker = breaker();
        let now = Instant::now();
        breaker.record_transport_failure_at("alpha", now);
        breaker.record_transport_failure_at("alpha", now);
        breaker.record_successful_transport_at("alpha", now);
        breaker.record_transport_failure_at("alpha", now);
        assert_eq!(
            breaker.snapshot(&["alpha".to_owned()])[0].consecutive_transport_failures,
            1
        );
        assert!(breaker.is_eligible_at("alpha", now));
    }

    #[test]
    fn expired_cooldown_restores_eligibility_and_resets_counter() {
        let breaker = breaker();
        let now = Instant::now();
        breaker.record_transport_failure_at("alpha", now);
        breaker.record_transport_failure_at("alpha", now);
        breaker.record_transport_failure_at("alpha", now);

        assert!(breaker.is_eligible_at("alpha", now + Duration::from_secs(31)));
        let state = breaker.snapshot(&["alpha".to_owned()]);
        assert_eq!(state[0].cooldown_remaining_ms, 0);
        assert_eq!(state[0].consecutive_transport_failures, 0);
    }
}
