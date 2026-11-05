//! Receipt storage shared by HTTP and JSON-RPC handlers.
//!
//! PostgreSQL stores only the shaped `StoredReceipt`, never the original request
//! body, provider URLs, credentials, or transport metadata. All backend operations
//! are async; the engine can await them without holding a synchronous DB lock across
//! unrelated work.

use async_trait::async_trait;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sqlx::{postgres::PgPoolOptions, PgPool, Row};
use veriq_core::{Receipt, RoutingAttempt, VeriqError};

use crate::logging::redact_for_storage;

pub const MEMORY_CAPACITY: usize = 500;
pub const POSTGRES_CAPACITY: usize = 5_000;
pub const DATABASE_URL_ENV: &str = "DATABASE_URL";
/// Startup connection attempts (3 s each, 2 s apart): about 20 s for a sleeping database.
pub const STARTUP_CONNECT_ATTEMPTS: u32 = 5;
const STARTUP_RETRY_DELAY: std::time::Duration = std::time::Duration::from_secs(2);
// A transaction-scoped lock serializes insert+trim so concurrent requests cannot
// both delete the same oldest row and leave the table above its retention limit.
const RETENTION_LOCK_ID: i64 = 0x5645_5249_5152_4543;

/// Request ids are URL path components and SQL parameters, never SQL fragments.
pub fn valid_receipt_id(id: &str) -> bool {
    !id.is_empty()
        && id.len() <= 128
        && id
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'-' | b'_'))
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredParams {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub address: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub slot: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredError {
    pub code: i32,
    pub message: String,
    pub data: StoredErrorData,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StoredErrorData {
    pub code: String,
}

impl From<&VeriqError> for StoredError {
    fn from(err: &VeriqError) -> Self {
        Self {
            code: err.code_number(),
            // Provider responses are untrusted. Keep useful safe text, while removing
            // URL material, IP literals, and named secrets before storage.
            message: redact_for_storage(err.message()),
            data: StoredErrorData {
                code: err.code_str().to_owned(),
            },
        }
    }
}

/// One row in the shape consumed by the SDK's `ReceiptRecordSchema`.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct StoredReceipt {
    pub id: String,
    /// Unix milliseconds.
    pub created_at: u64,
    pub method: String,
    pub params: StoredParams,
    pub value: Option<String>,
    pub block_number: Option<u64>,
    pub receipt: Option<Receipt>,
    pub error: Option<StoredError>,
    pub attempts: Vec<RoutingAttempt>,
}

/// Shared asynchronous interface for the in-memory and durable receipt stores.
#[async_trait]
pub trait ReceiptStore: Send + Sync {
    async fn insert(&self, row: StoredReceipt) -> Result<(), StoreError>;
    async fn list(&self, limit: usize) -> Result<Vec<StoredReceipt>, StoreError>;
    async fn get(&self, id: &str) -> Result<Option<StoredReceipt>, StoreError>;
}

/// An intentionally opaque error: SQL and stored JSON details may contain untrusted
/// values, so callers only receive a stable, safe message.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum StoreError {
    Database,
    MalformedStoredReceipt,
    /// A receipt with this id is already stored. Receipts are an audit trail, so
    /// both stores keep the first record and refuse the later one (never replace).
    DuplicateId,
}

impl std::fmt::Display for StoreError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Database => f.write_str("receipt storage unavailable"),
            Self::MalformedStoredReceipt => f.write_str("stored receipt is malformed"),
            Self::DuplicateId => f.write_str("a receipt with this id is already stored"),
        }
    }
}

impl std::error::Error for StoreError {}

#[derive(Debug, Default)]
pub struct InMemoryReceiptStore {
    rows: std::sync::Mutex<std::collections::VecDeque<StoredReceipt>>,
}

impl InMemoryReceiptStore {
    pub fn new() -> Self {
        Self::default()
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, std::collections::VecDeque<StoredReceipt>> {
        self.rows
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }
}

#[async_trait]
impl ReceiptStore for InMemoryReceiptStore {
    async fn insert(&self, row: StoredReceipt) -> Result<(), StoreError> {
        let row = sanitize_row(row)?;
        let mut rows = self.lock();
        if rows.iter().any(|stored| stored.id == row.id) {
            return Err(StoreError::DuplicateId);
        }
        rows.push_front(row);
        rows.truncate(MEMORY_CAPACITY);
        Ok(())
    }

    /// Newest first.
    async fn list(&self, limit: usize) -> Result<Vec<StoredReceipt>, StoreError> {
        Ok(self
            .lock()
            .iter()
            .take(limit.min(MEMORY_CAPACITY))
            .cloned()
            .collect())
    }

    async fn get(&self, id: &str) -> Result<Option<StoredReceipt>, StoreError> {
        Ok(self.lock().iter().find(|row| row.id == id).cloned())
    }
}

/// PostgreSQL-backed store. `connect` creates the table/index if needed and returns a
/// pool shared by HTTP, JSON-RPC, and engine operations.
pub struct PostgresReceiptStore {
    pool: PgPool,
}

/// A `DATABASE_URL` problem the engine can name before trying to connect. Never includes
/// the URL itself (it carries the password).
pub fn database_url_problem(database_url: &str) -> Option<&'static str> {
    let query = database_url.split_once('?').map_or("", |(_, query)| query);
    let requires_channel_binding = query.split('&').any(|pair| {
        pair.split_once('=')
            .is_some_and(|(key, value)| key == "channel_binding" && value == "require")
    });
    requires_channel_binding.then_some(
        "DATABASE_URL has channel_binding=require, which the engine's PostgreSQL driver (SQLx) \
         does not support; remove that parameter (sslmode=require still encrypts the connection). \
         Neon's copied connection strings include it.",
    )
}

impl PostgresReceiptStore {
    pub async fn connect(database_url: &str) -> Result<Self, StoreError> {
        Self::connect_with_retries(database_url, STARTUP_CONNECT_ATTEMPTS, STARTUP_RETRY_DELAY)
            .await
    }

    /// Startup only: a hosted database that was asleep (Neon's free tier suspends idle
    /// compute) can take longer than one 3 s acquire to wake, so the first connection is
    /// retried. Once running, lookups still fail fast.
    async fn connect_with_retries(
        database_url: &str,
        attempts: u32,
        delay: std::time::Duration,
    ) -> Result<Self, StoreError> {
        let options = PgPoolOptions::new()
            .max_connections(8)
            // sqlx waits 30 s for a connection by default. Lookups (GET /receipts,
            // veriq_getReceipt) should fail fast with "receipt storage unavailable"
            // instead; reads are bounded separately by engine::RECEIPT_WRITE_TIMEOUT.
            .acquire_timeout(std::time::Duration::from_secs(3));
        let mut attempt = 1;
        let pool = loop {
            match options.clone().connect(database_url).await {
                Ok(pool) => break pool,
                Err(_) if attempt < attempts => {
                    // No error text: it can echo the URL.
                    tracing::warn!(attempt, attempts, "PostgreSQL not reachable yet; retrying");
                    tokio::time::sleep(delay).await;
                    attempt += 1;
                }
                Err(_) => return Err(StoreError::Database),
            }
        };
        sqlx::query(
            "CREATE TABLE IF NOT EXISTS receipts (
                sequence BIGSERIAL PRIMARY KEY,
                request_id TEXT NOT NULL UNIQUE,
                method TEXT NOT NULL,
                status TEXT NOT NULL,
                block_number BIGINT,
                created_at BIGINT NOT NULL,
                receipt_json JSONB NOT NULL
            )",
        )
        .execute(&pool)
        .await
        .map_err(|_| StoreError::Database)?;
        sqlx::query(
            "CREATE INDEX IF NOT EXISTS receipts_created_at
             ON receipts(created_at DESC, sequence DESC)",
        )
        .execute(&pool)
        .await
        .map_err(|_| StoreError::Database)?;
        Ok(Self { pool })
    }

    pub async fn connect_from_env() -> Result<Self, StoreError> {
        let database_url = std::env::var(DATABASE_URL_ENV).map_err(|_| StoreError::Database)?;
        Self::connect(&database_url).await
    }

    fn decode_row(value: Value) -> Result<StoredReceipt, StoreError> {
        let safe = redact_json(value);
        serde_json::from_value(safe).map_err(|_| StoreError::MalformedStoredReceipt)
    }
}

#[async_trait]
impl ReceiptStore for PostgresReceiptStore {
    async fn insert(&self, row: StoredReceipt) -> Result<(), StoreError> {
        let row = sanitize_row(row)?;
        let receipt_json =
            serde_json::to_value(&row).map_err(|_| StoreError::MalformedStoredReceipt)?;
        let status = stored_status(&row);
        let block_number = row
            .block_number
            .map(i64::try_from)
            .transpose()
            .map_err(|_| StoreError::Database)?;
        let created_at = i64::try_from(row.created_at).map_err(|_| StoreError::Database)?;

        let mut transaction = self.pool.begin().await.map_err(|_| StoreError::Database)?;
        sqlx::query("SELECT pg_advisory_xact_lock($1)")
            .bind(RETENTION_LOCK_ID)
            .execute(&mut *transaction)
            .await
            .map_err(|_| StoreError::Database)?;
        // Same rule as the memory store: an existing id keeps its first record.
        let inserted = sqlx::query(
            "INSERT INTO receipts
                (request_id, method, status, block_number, created_at, receipt_json)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT (request_id) DO NOTHING",
        )
        .bind(&row.id)
        .bind(&row.method)
        .bind(status)
        .bind(block_number)
        .bind(created_at)
        .bind(receipt_json)
        .execute(&mut *transaction)
        .await
        .map_err(|_| StoreError::Database)?;
        if inserted.rows_affected() == 0 {
            // Dropping the transaction rolls it back; nothing was written.
            return Err(StoreError::DuplicateId);
        }

        sqlx::query(
            "DELETE FROM receipts
             WHERE sequence NOT IN (
                SELECT sequence FROM receipts
                ORDER BY sequence DESC LIMIT $1
             )",
        )
        .bind(i64::try_from(POSTGRES_CAPACITY).expect("capacity fits in i64"))
        .execute(&mut *transaction)
        .await
        .map_err(|_| StoreError::Database)?;
        transaction.commit().await.map_err(|_| StoreError::Database)
    }

    async fn list(&self, limit: usize) -> Result<Vec<StoredReceipt>, StoreError> {
        let limit = i64::try_from(limit.min(POSTGRES_CAPACITY)).unwrap_or(i64::MAX);
        let rows = sqlx::query(
            "SELECT receipt_json FROM receipts
             ORDER BY sequence DESC LIMIT $1",
        )
        .bind(limit)
        .fetch_all(&self.pool)
        .await
        .map_err(|_| StoreError::Database)?;
        rows.into_iter()
            .map(|row| {
                Self::decode_row(
                    row.try_get("receipt_json")
                        .map_err(|_| StoreError::Database)?,
                )
            })
            .collect()
    }

    async fn get(&self, id: &str) -> Result<Option<StoredReceipt>, StoreError> {
        let value = sqlx::query_scalar::<_, Value>(
            "SELECT receipt_json FROM receipts WHERE request_id = $1",
        )
        .bind(id)
        .fetch_optional(&self.pool)
        .await
        .map_err(|_| StoreError::Database)?;
        value.map(Self::decode_row).transpose()
    }
}

fn stored_status(row: &StoredReceipt) -> &'static str {
    if row.error.is_some() {
        "error"
    } else if let Some(receipt) = &row.receipt {
        match receipt.verification.status {
            veriq_core::VerificationStatus::Verified => "verified",
            veriq_core::VerificationStatus::Unverified => "unverified",
            veriq_core::VerificationStatus::Unsupported => "unsupported",
        }
    } else {
        "success"
    }
}

/// Sanitize all strings which can originate in provider/configuration errors before
/// they enter either backend. Request bodies and provider URLs are not represented in
/// `StoredReceipt` at all.
fn sanitize_row(mut row: StoredReceipt) -> Result<StoredReceipt, StoreError> {
    row.id = redact_for_storage(&row.id);
    row.method = redact_for_storage(&row.method);
    if let Some(address) = row.params.address.as_mut() {
        *address = redact_for_storage(address);
    }
    if let Some(slot) = row.params.slot.as_mut() {
        *slot = redact_for_storage(slot);
    }
    if let Some(value) = row.value.as_mut() {
        *value = redact_for_storage(value);
    }
    if let Some(error) = row.error.as_mut() {
        error.message = redact_for_storage(&error.message);
        error.data.code = redact_for_storage(&error.data.code);
    }
    for attempt in &mut row.attempts {
        attempt.provider = redact_for_storage(&attempt.provider);
        if let Some(reason) = attempt.failure_reason.as_mut() {
            *reason = redact_for_storage(reason);
        }
    }
    if let Some(receipt) = row.receipt.take() {
        let value =
            serde_json::to_value(receipt).map_err(|_| StoreError::MalformedStoredReceipt)?;
        let safe = redact_json(value);
        row.receipt =
            Some(serde_json::from_value(safe).map_err(|_| StoreError::MalformedStoredReceipt)?);
    }
    Ok(row)
}

fn redact_json(value: Value) -> Value {
    match value {
        Value::String(text) => Value::String(redact_for_storage(&text)),
        Value::Array(values) => Value::Array(values.into_iter().map(redact_json).collect()),
        Value::Object(values) => Value::Object(
            values
                .into_iter()
                .map(|(key, value)| (redact_for_storage(&key), redact_json(value)))
                .collect(),
        ),
        other => other,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str) -> StoredReceipt {
        StoredReceipt {
            id: id.to_owned(),
            created_at: 0,
            method: "veriq_readBalance".to_owned(),
            params: StoredParams {
                address: None,
                slot: None,
            },
            value: None,
            block_number: None,
            receipt: None,
            error: None,
            attempts: Vec::new(),
        }
    }

    /// Two rows with one id and different contents, to tell them apart.
    fn first_and_second(id: &str) -> (StoredReceipt, StoredReceipt) {
        let mut first = row(id);
        first.value = Some("0x1".to_owned());
        first.created_at = 100;
        let mut second = row(id);
        second.value = Some("0x2".to_owned());
        second.created_at = 200;
        (first, second)
    }

    /// The shared rule: a duplicate id is refused and the first record stays.
    async fn assert_duplicate_keeps_first(store: &dyn ReceiptStore, id: &str) {
        let (first, second) = first_and_second(id);
        store.insert(first).await.expect("first insert");
        assert!(matches!(
            store.insert(second).await,
            Err(StoreError::DuplicateId)
        ));
        let stored = store.get(id).await.expect("get").expect("stored");
        assert_eq!(stored.value.as_deref(), Some("0x1"), "first record kept");
        assert_eq!(stored.created_at, 100);
        let listed: Vec<_> = store
            .list(usize::MAX)
            .await
            .expect("list")
            .into_iter()
            .filter(|row| row.id == id)
            .collect();
        assert_eq!(listed.len(), 1, "exactly one row for the id");
        assert_eq!(listed[0].value.as_deref(), Some("0x1"));
    }

    #[tokio::test]
    async fn memory_store_refuses_duplicate_ids_and_keeps_the_first() {
        let store = InMemoryReceiptStore::new();
        store.insert(row("other")).await.expect("insert");
        assert_duplicate_keeps_first(&store, "dup-1").await;
        // Repeating the attempt changes nothing.
        let (_, second) = first_and_second("dup-1");
        assert!(matches!(
            store.insert(second).await,
            Err(StoreError::DuplicateId)
        ));
        assert_eq!(store.list(usize::MAX).await.expect("list").len(), 2);
    }

    #[tokio::test]
    async fn memory_store_orders_caps_and_returns_none_for_missing_ids() {
        let store = InMemoryReceiptStore::new();
        for i in 0..(MEMORY_CAPACITY + 10) {
            store.insert(row(&i.to_string())).await.expect("insert");
        }
        let rows = store.list(usize::MAX).await.expect("list");
        assert_eq!(rows.len(), MEMORY_CAPACITY);
        assert_eq!(rows[0].id, (MEMORY_CAPACITY + 9).to_string());
        assert!(store.get("0").await.expect("get").is_none());
        assert!(store.get("not-present").await.expect("get").is_none());
        assert!(store
            .get(&(MEMORY_CAPACITY + 9).to_string())
            .await
            .expect("get")
            .is_some());
    }

    #[tokio::test]
    async fn memory_store_preserves_receipt_addresses_without_persisting_raw_ip_or_url() {
        let store = InMemoryReceiptStore::new();
        let mut row = row("safe-id");
        row.params.address = Some("0x1234567890abcdef1234567890abcdef12345678".to_owned());
        row.error = Some(StoredError {
            code: -1,
            message: "https://rpc.example/v3/APIKEY?token=SECRET from 198.51.100.4".to_owned(),
            data: StoredErrorData {
                code: "PROVIDER_ERROR".to_owned(),
            },
        });
        store.insert(row).await.expect("insert");
        let saved = store.get("safe-id").await.expect("get").expect("saved");
        assert_eq!(
            saved.params.address.as_deref(),
            Some("0x1234567890abcdef1234567890abcdef12345678")
        );
        let message = &saved.error.expect("error").message;
        assert!(!message.contains("APIKEY"));
        assert!(!message.contains("SECRET"));
        assert!(!message.contains("198.51.100.4"));
        assert!(!message.contains("https://"));
    }

    /// Integration test against a dedicated PostgreSQL database:
    /// `TEST_DATABASE_URL=postgres://... cargo test -p veriq-server postgres_store`.
    /// Skipped locally without `TEST_DATABASE_URL`; required in CI (`CI` is set there).
    #[tokio::test]
    async fn postgres_store_persists_orders_and_retains_newest_records() {
        let Some(database_url) = std::env::var("TEST_DATABASE_URL")
            .ok()
            .filter(|url| !url.trim().is_empty())
        else {
            assert!(
                std::env::var_os("CI").is_none(),
                "TEST_DATABASE_URL must be configured in CI"
            );
            eprintln!("skipping postgres_store test: TEST_DATABASE_URL not set");
            return;
        };
        let store = PostgresReceiptStore::connect(&database_url)
            .await
            .expect("connect to test database");
        sqlx::query("TRUNCATE TABLE receipts RESTART IDENTITY")
            .execute(&store.pool)
            .await
            .expect("clear dedicated test table");

        assert_duplicate_keeps_first(&store, "dup-pg").await;
        sqlx::query("TRUNCATE TABLE receipts RESTART IDENTITY")
            .execute(&store.pool)
            .await
            .expect("clear dedicated test table");

        for i in 0..(POSTGRES_CAPACITY + 10) {
            store
                .insert(row(&format!("test-{i}")))
                .await
                .expect("insert");
        }
        let rows = store.list(usize::MAX).await.expect("list");
        assert_eq!(rows.len(), POSTGRES_CAPACITY);
        assert_eq!(rows[0].id, format!("test-{}", POSTGRES_CAPACITY + 9));
        assert!(store.get("test-0").await.expect("get").is_none());
        assert!(store.get("missing-id").await.expect("get").is_none());
        sqlx::query(
            "INSERT INTO receipts
                (request_id, method, status, block_number, created_at, receipt_json)
             VALUES ($1, $2, $3, $4, $5, $6)",
        )
        .bind("malformed-json")
        .bind("test_method")
        .bind("error")
        .bind(Option::<i64>::None)
        .bind(0_i64)
        .bind(serde_json::json!("not-a-receipt-row"))
        .execute(&store.pool)
        .await
        .expect("insert malformed shape");
        assert!(matches!(
            store.get("malformed-json").await,
            Err(StoreError::MalformedStoredReceipt)
        ));

        drop(store);
        let reopened = PostgresReceiptStore::connect(&database_url)
            .await
            .expect("reopen");
        assert_eq!(
            reopened
                .get(&format!("test-{}", POSTGRES_CAPACITY + 9))
                .await
                .expect("get")
                .expect("persisted")
                .id,
            format!("test-{}", POSTGRES_CAPACITY + 9)
        );
        // Leave the dedicated table empty: the malformed row above would otherwise
        // make every later list() on this database fail.
        sqlx::query("TRUNCATE TABLE receipts RESTART IDENTITY")
            .execute(&reopened.pool)
            .await
            .expect("clear dedicated test table");
    }

    #[tokio::test]
    async fn startup_connect_retries_then_gives_up_with_an_opaque_error() {
        // Nothing listens on port 1: every attempt is refused at once.
        let started = std::time::Instant::now();
        let result = PostgresReceiptStore::connect_with_retries(
            "postgres://veriq:secret@127.0.0.1:1/veriq",
            3,
            std::time::Duration::from_millis(200),
        )
        .await;
        assert!(matches!(result, Err(StoreError::Database)));
        // Two waits between three attempts.
        assert!(started.elapsed() >= std::time::Duration::from_millis(400));
    }

    #[test]
    fn channel_binding_require_is_named_without_echoing_the_url() {
        let neon =
            "postgresql://owner:s3cret@ep-x.neon.tech/db?sslmode=require&channel_binding=require";
        let problem = database_url_problem(neon).expect("named");
        assert!(problem.contains("channel_binding=require"));
        assert!(!problem.contains("s3cret") && !problem.contains("neon.tech/db"));
        assert!(database_url_problem("postgresql://u:p@h/db?channel_binding=require").is_some());
        for fine in [
            "postgresql://u:p@h/db?sslmode=require",
            "postgresql://u:p@h/db?sslmode=require&channel_binding=prefer",
            "postgres://u:p@localhost:5432/veriq",
        ] {
            assert!(database_url_problem(fine).is_none(), "{fine}");
        }
    }

    #[test]
    fn store_errors_are_opaque_and_stored_rows_are_sanitized() {
        let error = StoredError::from(&VeriqError::invalid_proof(
            "https://rpc.example/v3/KEY?token=SECRET from 192.0.2.1",
        ));
        assert!(!error.message.contains("SECRET"));
        assert!(!error.message.contains("192.0.2.1"));
        assert!(!error.message.contains("https://"));
        assert_eq!(
            StoreError::Database.to_string(),
            "receipt storage unavailable"
        );
        assert_eq!(
            StoreError::MalformedStoredReceipt.to_string(),
            "stored receipt is malformed"
        );
    }
}
