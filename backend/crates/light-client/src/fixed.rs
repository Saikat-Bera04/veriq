use alloy_primitives::B256;
use async_trait::async_trait;
use veriq_core::VeriqError;

use crate::{PinnedRoot, RootSource, RootSourceProvider};

/// A fixed root for tests and offline fixtures.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct FixedRoot {
    root: PinnedRoot,
}

impl FixedRoot {
    pub const fn new(root: PinnedRoot) -> Self {
        Self { root }
    }

    pub const fn from_parts(number: u64, hash: B256, state_root: B256) -> Self {
        Self::new(PinnedRoot::new(number, hash, state_root))
    }

    pub const fn from_parts_with_timestamp(
        number: u64,
        hash: B256,
        state_root: B256,
        timestamp: u64,
    ) -> Self {
        Self::new(PinnedRoot::with_timestamp(
            number, hash, state_root, timestamp,
        ))
    }
}

#[async_trait]
impl RootSourceProvider for FixedRoot {
    async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
        Ok(self.root)
    }

    fn source(&self) -> RootSource {
        RootSource::Fixture
    }
}
