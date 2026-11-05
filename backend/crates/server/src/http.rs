use axum::{
    extract::{rejection::QueryRejection, Path, Query, State},
    http::{header, HeaderValue, Method, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use serde::Deserialize;
use serde_json::{json, Value};
use tower_http::cors::CorsLayer;
use veriq_core::config::ENGINE_ADDR;
use veriq_light_client::RootSource;

use crate::{engine::Engine, rpc, store::valid_receipt_id};

/// The only browser origin allowed to call the engine directly (the dashboard dev server).
pub const ALLOWED_ORIGIN: &str = "http://localhost:3000";
pub const DEFAULT_RECEIPT_LIMIT: usize = 50;
/// Receipt listing is bounded to 500 rows per response.
pub const MAX_RECEIPT_LIMIT: usize = 500;

pub fn app(engine: Engine) -> Router {
    let cors = CorsLayer::new()
        .allow_origin(HeaderValue::from_static(ALLOWED_ORIGIN))
        .allow_methods([Method::GET, Method::POST])
        .allow_headers([header::CONTENT_TYPE]);
    let router = Router::new()
        .route("/", post(rpc_handler))
        .route("/health", get(health))
        .route("/receipts", get(list_receipts))
        .route("/receipts/{id}", get(get_receipt));
    // Demo builds only: lets the attack lab show each mode fresh without a restart.
    #[cfg(feature = "demo")]
    let router = router.route(RESET_BREAKERS_PATH, post(reset_breakers));
    router.layer(cors).with_state(engine)
}

/// `POST` here clears every provider's circuit breaker. Only routed with the `demo`
/// feature; normal builds answer 404.
pub const RESET_BREAKERS_PATH: &str = "/admin/reset-breakers";

/// Loopback callers only. The engine already listens on 127.0.0.1; this re-checks the
/// peer address, and refuses when it is unknown (fail closed).
#[cfg_attr(not(feature = "demo"), allow(dead_code))]
async fn reset_breakers(State(engine): State<Engine>, request: axum::extract::Request) -> Response {
    let peer = request
        .extensions()
        .get::<axum::extract::ConnectInfo<std::net::SocketAddr>>()
        .map(|info| info.0.ip());
    if !peer.is_some_and(|ip| ip.is_loopback()) {
        return (
            StatusCode::FORBIDDEN,
            Json(json!({"error": {"code": "FORBIDDEN", "message": "loopback callers only"}})),
        )
            .into_response();
    }
    let reset = engine.reset_breakers();
    tracing::warn!(cooling_down = reset, "demo: circuit breakers reset");
    Json(json!({"reset": true, "wereCoolingDown": reset})).into_response()
}

async fn rpc_handler(State(engine): State<Engine>, body: String) -> Json<Value> {
    let request: Value = match serde_json::from_str(&body) {
        Ok(request) => request,
        Err(err) => {
            return Json(json!({
                "jsonrpc": "2.0",
                "id": null,
                "error": {
                    "code": -32602,
                    "message": format!("invalid JSON request: {err}"),
                    "data": { "code": "INVALID_REQUEST" },
                }
            }));
        }
    };
    Json(rpc::dispatch(&engine, request).await)
}

/// Health values distinguish a configured light client from a trusted fixture or an
/// untrusted RPC. A root is only called synchronized when the configured local light
/// client actually supplied it. `lagSeconds` / `lastUpdateUnix` are the root cache's
/// age and last refresh (seconds since the engine last got a finalized root); they stay
/// null without a cache or before the first root, never a fabricated zero. `headNumber` is
/// the light client's latest head, reported only when it is at or above the finalized block.
/// When refreshes are failing but the last good root is still served, the status is
/// `degraded` with `ROOT_REFRESH_FAILING`; the root (and its receipts) stay those of the
/// light client, and a root past its age limit is not served at all.
async fn health(State(engine): State<Engine>) -> Json<Value> {
    let providers = engine.provider_health();
    let provider_count = providers.len();
    let bootstrap = engine.bootstrap();
    let configured_source = engine.root_source();
    // Look the root up first: on an empty or expired cache this fills it, so the cache
    // fields below describe the root this response reports.
    let root_status = engine.root_status().await;
    let cache = engine.root_cache_status();
    let root_cache = root_cache_json(cache);
    let (cache_age, cache_updated) = cache
        .and_then(|cache| cache.entry)
        .map(|entry| (entry.age_seconds, entry.last_update_unix))
        .unzip();

    if bootstrap.source.as_deref() == Some("none") {
        return Json(json!({
            "status": "degraded",
            "ok": false,
            "bind": ENGINE_ADDR,
            "chainId": 11_155_111,
            "rootSource": null,
            "devMode": false,
            "synced": false,
            "finalizedNumber": null,
            "finalizedHash": null,
            "stateRoot": null,
            "lagSeconds": null,
            "bootstrap": bootstrap,
            "lightClient": {
                "available": false,
                "synced": false,
                "finalizedNumber": null,
                "finalizedHash": null,
                "lagSeconds": null,
            },
            "rootCache": root_cache,
            "providers": providers,
            "providerCount": provider_count,
            "error": {
                "code": "ROOT_UNAVAILABLE",
                "message": "finalized root unavailable",
            },
        }));
    }

    match root_status {
        Ok((source, root)) => {
            let light_client_available = source == RootSource::LocalLightClient;
            let finalized_number = light_client_available.then_some(root.number);
            let finalized_hash = light_client_available.then(|| format!("{:#x}", root.hash));
            let state_root = light_client_available.then(|| format!("{:#x}", root.state_root));
            let lag = cache_age.filter(|_| light_client_available);
            let last_update = cache_updated.filter(|_| light_client_available);
            let head_number = if light_client_available {
                engine
                    .head_number()
                    .await
                    .filter(|head| *head >= root.number)
            } else {
                None
            };
            let refresh_failing = cache.is_some_and(|cache| cache.consecutive_failures > 0);
            let synced = light_client_available && !refresh_failing;
            let error = refresh_failing.then(|| {
                json!({
                    "code": "ROOT_REFRESH_FAILING",
                    "message": format!(
                        "light-client refresh failing; serving the last good finalized root ({}s old)",
                        cache_age.unwrap_or_default()
                    ),
                })
            });
            let light_client = json!({
                "available": light_client_available,
                "synced": synced,
                "finalizedNumber": finalized_number,
                "finalizedHash": finalized_hash,
                "stateRoot": state_root,
                "headNumber": head_number,
                "lagSeconds": lag,
                "lastUpdateUnix": last_update,
                "checkpoint": bootstrap.checkpoint,
                "checkpointSource": bootstrap.checkpoint_source,
            });
            Json(json!({
                "status": if refresh_failing { "degraded" } else { "ok" },
                "ok": !refresh_failing,
                "bind": ENGINE_ADDR,
                "chainId": 11_155_111,
                "rootSource": root_source_value(source),
                "devMode": source == RootSource::UntrustedRpc,
                "synced": synced,
                "finalizedNumber": finalized_number,
                "finalizedHash": finalized_hash,
                "stateRoot": state_root,
                "headNumber": head_number,
                "lagSeconds": lag,
                "bootstrap": bootstrap,
                "lightClient": light_client,
                "rootCache": root_cache,
                "providers": providers,
                "providerCount": provider_count,
                "error": error,
            }))
        }
        Err(err) => {
            let light_client_available = configured_source == RootSource::LocalLightClient;
            let root_source = root_source_value(configured_source);
            Json(json!({
                "status": "degraded",
                "ok": false,
                "bind": ENGINE_ADDR,
                "chainId": 11_155_111,
                "rootSource": root_source,
                "devMode": configured_source == RootSource::UntrustedRpc,
                "synced": false,
                "finalizedNumber": null,
                "finalizedHash": null,
                "stateRoot": null,
                // Time since the last good root, if there ever was one.
                "lagSeconds": cache_age.filter(|_| light_client_available),
                "bootstrap": bootstrap,
                "lightClient": {
                    "available": light_client_available,
                    "synced": false,
                    "finalizedNumber": null,
                    "finalizedHash": null,
                    "lagSeconds": cache_age.filter(|_| light_client_available),
                    "lastUpdateUnix": cache_updated.filter(|_| light_client_available),
                },
                "rootCache": root_cache,
                "providers": providers,
                "providerCount": provider_count,
                "error": {
                    "code": err.code_str(),
                    "message": "finalized root unavailable",
                },
            }))
        }
    }
}

/// `rootCache` for /health: `null` when the root source has no cache in front.
fn root_cache_json(cache: Option<veriq_light_client::RootCacheStatus>) -> Value {
    let Some(cache) = cache else {
        return Value::Null;
    };
    json!({
        "ageSeconds": cache.entry.map(|entry| entry.age_seconds),
        "lastUpdateUnix": cache.entry.map(|entry| entry.last_update_unix),
        "finalizedNumber": cache.entry.map(|entry| entry.root.number),
        "refreshEverySeconds": cache.refresh_every_seconds,
        "maxAgeSeconds": cache.max_age_seconds,
        "consecutiveFailures": cache.consecutive_failures,
        "lastFailureUnix": cache.last_failure_unix,
    })
}

/// `rootSource` for /health. No root source is `null`, never the string "none":
/// the SDK schema only accepts a known source name or null.
fn root_source_value(source: RootSource) -> Option<&'static str> {
    (source != RootSource::Unavailable).then(|| source.as_str())
}

#[derive(Debug, Deserialize)]
struct ListQuery {
    limit: Option<String>,
}

/// GET /receipts?limit=N — newest first, default 50, maximum 500.
async fn list_receipts(
    State(engine): State<Engine>,
    query: Result<Query<ListQuery>, QueryRejection>,
) -> Response {
    let query = match query {
        Ok(Query(query)) => query,
        Err(_) => {
            return error_response(
                StatusCode::BAD_REQUEST,
                "INVALID_LIMIT",
                "limit must be an integer between 1 and 500",
            )
        }
    };
    let limit = match query.limit {
        None => DEFAULT_RECEIPT_LIMIT,
        Some(text) => match text.parse::<usize>() {
            Ok(limit) if (1..=MAX_RECEIPT_LIMIT).contains(&limit) => limit,
            _ => {
                return error_response(
                    StatusCode::BAD_REQUEST,
                    "INVALID_LIMIT",
                    "limit must be an integer between 1 and 500",
                )
            }
        },
    };

    match engine.store().list(limit).await {
        Ok(receipts) => Json(json!({ "receipts": receipts })).into_response(),
        Err(_) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "receipt storage unavailable",
        ),
    }
}

/// GET /receipts/{id}
async fn get_receipt(State(engine): State<Engine>, Path(id): Path<String>) -> Response {
    if !valid_receipt_id(&id) {
        return error_response(
            StatusCode::BAD_REQUEST,
            "INVALID_RECEIPT_ID",
            "receipt id is malformed",
        );
    }
    match engine.store().get(&id).await {
        Ok(Some(row)) => Json(json!(row)).into_response(),
        Ok(None) => error_response(StatusCode::NOT_FOUND, "NOT_FOUND", "unknown receipt id"),
        Err(_) => error_response(
            StatusCode::INTERNAL_SERVER_ERROR,
            "INTERNAL_ERROR",
            "receipt storage unavailable",
        ),
    }
}

fn error_response(status: StatusCode, code: &str, message: &str) -> Response {
    (
        status,
        Json(json!({
            "error": {
                "code": code,
                "message": message,
            }
        })),
    )
        .into_response()
}

#[cfg(test)]
mod tests {
    use std::sync::Arc;

    use async_trait::async_trait;
    use axum::{
        body::{to_bytes, Body},
        http::{
            header::{ACCESS_CONTROL_ALLOW_ORIGIN, ACCESS_CONTROL_REQUEST_METHOD, ORIGIN},
            Request,
        },
    };
    use tower::ServiceExt;
    use veriq_core::{Bootstrap, VeriqError};
    use veriq_light_client::{fixed::FixedRoot, PinnedRoot, RootSource, RootSourceProvider};

    use super::*;
    use crate::provider::ProviderConfig;
    use crate::store::{
        InMemoryReceiptStore, ReceiptStore, StoreError, StoredParams, StoredReceipt,
    };

    fn receipt_row(id: &str) -> StoredReceipt {
        StoredReceipt {
            id: id.to_owned(),
            created_at: 100,
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

    async fn response(
        router: Router,
        method: Method,
        uri: &str,
        origin: Option<&str>,
    ) -> axum::http::Response<Body> {
        let mut request = Request::builder().method(method).uri(uri);
        if let Some(origin) = origin {
            request = request.header(ORIGIN, origin);
        }
        if uri == "/health" {
            request = request.header(ACCESS_CONTROL_REQUEST_METHOD, "GET");
        }
        router
            .oneshot(request.body(Body::empty()).expect("request"))
            .await
            .expect("response")
    }

    async fn response_json(response: axum::http::Response<Body>) -> Value {
        let bytes = to_bytes(response.into_body(), usize::MAX)
            .await
            .expect("body");
        serde_json::from_slice(&bytes).expect("JSON response")
    }

    fn engine_with_store(store: Arc<dyn ReceiptStore>) -> Engine {
        Engine::new(
            Arc::new(FixedRoot::new(PinnedRoot::new(
                10,
                alloy_primitives::B256::repeat_byte(1),
                alloy_primitives::B256::repeat_byte(2),
            ))),
            Vec::new(),
        )
        .with_store(store)
    }

    #[tokio::test]
    async fn receipts_endpoints_return_consistent_shapes_and_statuses() {
        let store = Arc::new(InMemoryReceiptStore::new());
        store
            .insert(receipt_row("receipt-1"))
            .await
            .expect("insert");
        let router = app(engine_with_store(store));

        let list = response(router.clone(), Method::GET, "/receipts", None).await;
        assert_eq!(list.status(), StatusCode::OK);
        let list_json = response_json(list).await;
        assert_eq!(list_json["receipts"].as_array().expect("receipts").len(), 1);
        assert_eq!(list_json["receipts"][0]["id"], "receipt-1");

        let found = response(router.clone(), Method::GET, "/receipts/receipt-1", None).await;
        assert_eq!(found.status(), StatusCode::OK);
        assert_eq!(response_json(found).await["id"], "receipt-1");

        let missing = response(
            router.clone(),
            Method::GET,
            "/receipts/does-not-exist",
            None,
        )
        .await;
        assert_eq!(missing.status(), StatusCode::NOT_FOUND);
        assert_eq!(response_json(missing).await["error"]["code"], "NOT_FOUND");

        let invalid_id = response(router, Method::GET, "/receipts/%2e%2e%2fsecrets", None).await;
        assert_eq!(invalid_id.status(), StatusCode::BAD_REQUEST);
    }

    #[tokio::test]
    async fn limits_are_defaulted_and_invalid_values_are_json_400s() {
        let router = app(engine_with_store(Arc::new(InMemoryReceiptStore::new())));
        for uri in [
            "/receipts?limit=nope",
            "/receipts?limit=0",
            "/receipts?limit=501",
            "/receipts?limit=-1",
        ] {
            let response = response(router.clone(), Method::GET, uri, None).await;
            assert_eq!(response.status(), StatusCode::BAD_REQUEST, "{uri}");
            assert_eq!(
                response_json(response).await["error"]["code"],
                "INVALID_LIMIT",
                "{uri}"
            );
        }
        let max = response(
            router.clone(),
            Method::GET,
            &format!("/receipts?limit={MAX_RECEIPT_LIMIT}"),
            None,
        )
        .await;
        assert_eq!(max.status(), StatusCode::OK);
    }

    #[tokio::test]
    async fn cors_allows_only_the_dashboard_origin() {
        let router = app(engine_with_store(Arc::new(InMemoryReceiptStore::new())));
        let allowed = response(
            router.clone(),
            Method::OPTIONS,
            "/health",
            Some(ALLOWED_ORIGIN),
        )
        .await;
        assert_eq!(
            allowed.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static(ALLOWED_ORIGIN))
        );

        let denied = response(
            router,
            Method::OPTIONS,
            "/health",
            Some("http://evil.example"),
        )
        .await;
        assert_ne!(
            denied.headers().get(ACCESS_CONTROL_ALLOW_ORIGIN),
            Some(&HeaderValue::from_static("http://evil.example"))
        );
    }

    #[tokio::test]
    async fn fixture_root_is_not_misreported_as_a_synced_light_client() {
        let engine = Engine::new(
            Arc::new(FixedRoot::new(PinnedRoot::new(
                10,
                alloy_primitives::B256::repeat_byte(1),
                alloy_primitives::B256::repeat_byte(2),
            ))),
            vec![ProviderConfig {
                label: "rpc-a".to_owned(),
                url: "https://provider.example/api?token=not-logged".to_owned(),
                eip1898: true,
            }],
        )
        .with_store(Arc::new(InMemoryReceiptStore::new()));
        let router = app(engine);
        let response = response(router, Method::GET, "/health", None).await;
        let health = response_json(response).await;
        assert_eq!(health["lightClient"]["available"], false);
        assert_eq!(health["lightClient"]["synced"], false);
        assert!(health["lightClient"]["finalizedNumber"].is_null());
        assert!(health["lightClient"]["lagSeconds"].is_null());
        assert_eq!(health["providers"][0]["capabilityStatus"], "unavailable");
        assert_eq!(health["providers"][0]["chainOk"], false);
        assert_eq!(health["providers"][0]["proofSupport"], false);
        assert_eq!(health["providers"][0]["breaker"]["cooldownRemainingMs"], 0);
    }

    struct MissingLocalRoot;

    #[async_trait]
    impl RootSourceProvider for MissingLocalRoot {
        async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
            Err(VeriqError::root_unavailable(
                "secret URL https://example.invalid?token=private",
            ))
        }

        fn source(&self) -> RootSource {
            RootSource::LocalLightClient
        }

        fn bootstrap(&self) -> Bootstrap {
            Bootstrap::default()
        }
    }

    #[tokio::test]
    async fn unavailable_local_root_is_unsynced_and_error_is_sanitized() {
        let engine = Engine::new(Arc::new(MissingLocalRoot), Vec::new());
        let router = app(engine);
        let response = response(router, Method::GET, "/health", None).await;
        let health = response_json(response).await;
        assert_eq!(health["lightClient"]["available"], true);
        assert_eq!(health["lightClient"]["synced"], false);
        assert!(health["finalizedNumber"].is_null());
        assert_eq!(health["error"]["message"], "finalized root unavailable");
        assert!(!health.to_string().contains("private"));
    }

    struct LocalRoot;

    #[async_trait]
    impl RootSourceProvider for LocalRoot {
        async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
            Ok(PinnedRoot::new(
                77,
                alloy_primitives::B256::repeat_byte(7),
                alloy_primitives::B256::repeat_byte(8),
            ))
        }

        fn source(&self) -> RootSource {
            RootSource::LocalLightClient
        }

        async fn head_number(&self) -> Option<u64> {
            Some(80)
        }
    }

    #[tokio::test]
    async fn health_reports_root_cache_age_and_last_update() {
        // Empty cache: the /health lookup itself fills it, and the response reports it.
        let cached = Arc::new(veriq_light_client::cached::CachedRoot::new(
            Arc::new(LocalRoot),
            std::time::Duration::from_secs(12),
        ));
        let cached_response = response(
            app(Engine::new(cached, Vec::new())),
            Method::GET,
            "/health",
            None,
        )
        .await;
        let health = response_json(cached_response).await;
        assert_eq!(health["status"], "ok");
        let cache = &health["rootCache"];
        assert_eq!(cache["finalizedNumber"], 77);
        assert!(cache["ageSeconds"].as_u64().is_some(), "{health}");
        assert!(cache["lastUpdateUnix"].as_u64().is_some_and(|t| t > 0));
        assert_eq!(cache["refreshEverySeconds"], 12);
        assert_eq!(cache["maxAgeSeconds"], 36);
        // After a successful light-client update both fields are set (not null).
        assert!(
            health["lightClient"]["lagSeconds"].as_u64().is_some(),
            "{health}"
        );
        assert!(health["lightClient"]["lastUpdateUnix"]
            .as_u64()
            .is_some_and(|t| t > 0));
        assert_eq!(health["lightClient"]["lagSeconds"], cache["ageSeconds"]);
        assert_eq!(health["lagSeconds"], cache["ageSeconds"]);
        // The light client's head, at or above the finalized block: head lag = 3 blocks.
        assert_eq!(health["lightClient"]["headNumber"], 80);
        assert_eq!(health["headNumber"], 80);
        assert_eq!(health["lightClient"]["finalizedNumber"], 77);
        assert_eq!(cache["consecutiveFailures"], 0);
        assert_eq!(
            health["lightClient"]["lastUpdateUnix"],
            cache["lastUpdateUnix"]
        );

        // Without a cache in front, there is no age to report.
        let plain = response(
            app(Engine::new(Arc::new(LocalRoot), Vec::new())),
            Method::GET,
            "/health",
            None,
        )
        .await;
        let plain = response_json(plain).await;
        assert!(plain["rootCache"].is_null());
        assert!(plain["lightClient"]["lagSeconds"].is_null());
    }

    async fn reset_from(router: Router, peer: Option<&str>) -> axum::http::Response<Body> {
        let mut request = Request::builder()
            .method(Method::POST)
            .uri(RESET_BREAKERS_PATH)
            .body(Body::empty())
            .expect("request");
        if let Some(peer) = peer {
            let addr: std::net::SocketAddr = peer.parse().expect("socket address");
            request
                .extensions_mut()
                .insert(axum::extract::ConnectInfo(addr));
        }
        router.oneshot(request).await.expect("response")
    }

    #[tokio::test]
    async fn reset_breakers_only_answers_loopback_callers() {
        let engine = engine_with_store(Arc::new(InMemoryReceiptStore::new()));
        engine.breaker_for_test().record_invalid_proof("attacker");
        assert!(!engine.breaker_for_test().is_eligible("attacker"));
        // Routed explicitly so the handler is tested in every build, not only `demo`.
        let router = || {
            Router::new()
                .route(RESET_BREAKERS_PATH, post(reset_breakers))
                .with_state(engine.clone())
        };

        for peer in [Some("192.168.1.20:5000"), Some("[2001:db8::1]:5000"), None] {
            let res = reset_from(router(), peer).await;
            assert_eq!(res.status(), StatusCode::FORBIDDEN, "{peer:?}");
            assert!(!engine.breaker_for_test().is_eligible("attacker"));
        }

        let res = reset_from(router(), Some("127.0.0.1:5000")).await;
        assert_eq!(res.status(), StatusCode::OK);
        assert_eq!(response_json(res).await["wereCoolingDown"], 1);
        assert!(engine.breaker_for_test().is_eligible("attacker"));
        let res = reset_from(router(), Some("[::1]:5000")).await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    #[cfg(not(feature = "demo"))]
    #[tokio::test]
    async fn reset_breakers_route_is_absent_outside_demo_builds() {
        let router = app(engine_with_store(Arc::new(InMemoryReceiptStore::new())));
        let res = reset_from(router, Some("127.0.0.1:5000")).await;
        assert_eq!(res.status(), StatusCode::NOT_FOUND);
    }

    #[cfg(feature = "demo")]
    #[tokio::test]
    async fn reset_breakers_route_exists_in_demo_builds() {
        let router = app(engine_with_store(Arc::new(InMemoryReceiptStore::new())));
        let res = reset_from(router, Some("127.0.0.1:5000")).await;
        assert_eq!(res.status(), StatusCode::OK);
    }

    /// A light client that synced once and then lost its root.
    struct FlakyLocalRoot {
        failing: std::sync::atomic::AtomicBool,
    }

    #[async_trait]
    impl RootSourceProvider for FlakyLocalRoot {
        async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
            if self.failing.load(std::sync::atomic::Ordering::SeqCst) {
                return Err(VeriqError::root_unavailable("finalized block unavailable"));
            }
            LocalRoot.current_root().await
        }

        fn source(&self) -> RootSource {
            RootSource::LocalLightClient
        }
    }

    #[tokio::test]
    async fn failing_refresh_is_degraded_but_keeps_the_last_good_light_client_root() {
        let source = Arc::new(FlakyLocalRoot {
            failing: std::sync::atomic::AtomicBool::new(false),
        });
        let cached = Arc::new(veriq_light_client::cached::CachedRoot::new(
            source.clone(),
            std::time::Duration::from_secs(12),
        ));
        cached.refresh().await.expect("first update");
        source
            .failing
            .store(true, std::sync::atomic::Ordering::SeqCst);
        cached
            .refresh()
            .await
            .expect_err("background refresh fails");

        let engine = Engine::new(cached, Vec::new());
        // Reads still pin the last good light-client root (within the cache window).
        let (root_source, root) = engine.root_status().await.expect("last good root");
        assert_eq!(root_source, RootSource::LocalLightClient);
        assert_eq!(root.number, 77);

        let health = response_json(response(app(engine), Method::GET, "/health", None).await).await;
        assert_eq!(health["status"], "degraded", "{health}");
        assert_eq!(health["ok"], false);
        assert_eq!(health["error"]["code"], "ROOT_REFRESH_FAILING");
        assert_eq!(health["rootSource"], "local-light-client");
        assert_eq!(health["finalizedNumber"], 77);
        assert_eq!(health["synced"], false);
        assert_eq!(health["lightClient"]["synced"], false);
        assert_eq!(health["rootCache"]["consecutiveFailures"], 1);
        assert!(health["rootCache"]["lastFailureUnix"].as_u64().is_some());
    }

    #[tokio::test]
    async fn degraded_health_still_reports_age_of_last_good_root() {
        let source = Arc::new(FlakyLocalRoot {
            failing: std::sync::atomic::AtomicBool::new(false),
        });
        // 10 ms refresh -> the cached root expires after 30 ms.
        let cached = Arc::new(veriq_light_client::cached::CachedRoot::new(
            source.clone(),
            std::time::Duration::from_millis(10),
        ));
        cached.refresh().await.expect("first update");
        tokio::time::sleep(std::time::Duration::from_millis(50)).await;
        source
            .failing
            .store(true, std::sync::atomic::Ordering::SeqCst);

        let degraded = response(
            app(Engine::new(cached, Vec::new())),
            Method::GET,
            "/health",
            None,
        )
        .await;
        let health = response_json(degraded).await;
        assert_eq!(health["status"], "degraded", "{health}");
        assert_eq!(health["lightClient"]["synced"], false);
        // The dashboard can still show how stale the last good root is.
        assert!(
            health["lightClient"]["lagSeconds"].as_u64().is_some(),
            "{health}"
        );
        assert!(health["lightClient"]["lastUpdateUnix"]
            .as_u64()
            .is_some_and(|t| t > 0));
        assert_eq!(health["lagSeconds"], health["lightClient"]["lagSeconds"]);
        assert_eq!(health["rootCache"]["finalizedNumber"], 77);
    }

    struct NoRootSource {
        bootstrap: Bootstrap,
    }

    #[async_trait]
    impl RootSourceProvider for NoRootSource {
        async fn current_root(&self) -> Result<PinnedRoot, VeriqError> {
            Err(VeriqError::root_unavailable("no root source"))
        }

        fn source(&self) -> RootSource {
            RootSource::Unavailable
        }

        fn bootstrap(&self) -> Bootstrap {
            self.bootstrap.clone()
        }
    }

    #[tokio::test]
    async fn missing_root_source_is_null_not_none_string() {
        // Both degraded paths: bootstrap marked "none" (early return) and an
        // unavailable source whose root lookup fails.
        for bootstrap in [
            Bootstrap {
                source: Some("none".to_owned()),
                ..Bootstrap::default()
            },
            Bootstrap::default(),
        ] {
            let engine = Engine::new(Arc::new(NoRootSource { bootstrap }), Vec::new());
            let response = response(app(engine), Method::GET, "/health", None).await;
            let health = response_json(response).await;
            assert_eq!(health["status"], "degraded");
            assert!(health["rootSource"].is_null(), "{health}");
        }
    }

    struct FailingStore;

    #[async_trait]
    impl ReceiptStore for FailingStore {
        async fn insert(&self, _: StoredReceipt) -> Result<(), StoreError> {
            Err(StoreError::Database)
        }

        async fn list(&self, _: usize) -> Result<Vec<StoredReceipt>, StoreError> {
            Err(StoreError::Database)
        }

        async fn get(&self, _: &str) -> Result<Option<StoredReceipt>, StoreError> {
            Err(StoreError::Database)
        }
    }

    #[tokio::test]
    async fn storage_failures_return_safe_500_json() {
        let router = app(engine_with_store(Arc::new(FailingStore)));
        let response = response(router, Method::GET, "/receipts", None).await;
        assert_eq!(response.status(), StatusCode::INTERNAL_SERVER_ERROR);
        let body = response_json(response).await;
        assert_eq!(body["error"]["code"], "INTERNAL_ERROR");
        assert_eq!(body["error"]["message"], "receipt storage unavailable");
    }
}
