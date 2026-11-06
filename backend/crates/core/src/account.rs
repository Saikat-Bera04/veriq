use alloy_primitives::{b256, B256, U256};
use serde::{Deserialize, Serialize};

/// Root hash of an empty Merkle-Patricia trie.
pub const EMPTY_ROOT_HASH: B256 =
    b256!("56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421");

/// keccak256 of empty bytes, used as the code hash of an externally-owned account.
pub const KECCAK_EMPTY: B256 =
    b256!("c5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470");

/// Ethereum account fields as committed to by the account trie.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct Account {
    pub nonce: u64,
    pub balance: U256,
    pub storage_root: B256,
    pub code_hash: B256,
}

impl Account {
    pub const fn new(nonce: u64, balance: U256, storage_root: B256, code_hash: B256) -> Self {
        Self {
            nonce,
            balance,
            storage_root,
            code_hash,
        }
    }

    /// The value returned by a valid non-membership proof.
    pub const fn empty() -> Self {
        Self {
            nonce: 0,
            balance: U256::ZERO,
            storage_root: EMPTY_ROOT_HASH,
            code_hash: KECCAK_EMPTY,
        }
    }
}

impl Default for Account {
    fn default() -> Self {
        Self::empty()
    }
}

/// An account together with the fact of whether it exists at the proven state root.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub struct ProvenAccount {
    pub account: Account,
    pub exists: bool,
}

impl ProvenAccount {
    pub const fn present(account: Account) -> Self {
        Self {
            account,
            exists: true,
        }
    }

    pub const fn absent() -> Self {
        Self {
            account: Account::empty(),
            exists: false,
        }
    }
}
