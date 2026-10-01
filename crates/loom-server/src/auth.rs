//! Optional password auth (`LOOM_PASSWORD`).
//!
//! Unset/empty ⇒ auth is disabled and every request passes untouched. Set ⇒
//! every `/api/*` route and `/mcp` needs one of:
//!
//!   1. `Authorization: Bearer <password>` — SDKs, curl, MCP clients, workers;
//!   2. the `loom_session` cookie minted by `POST /api/auth/login` — the console;
//!   3. `?token=<password>` — `GET` SSE routes only (EventSource can't set headers).
//!
//! Open regardless: `/api/healthz`, `/api/auth/*`, and *reads* of published
//! notebooks (`GET /api/notebooks/{id}` when `public`, `GET
//! /api/notebooks?public=1`). Publishing never grants execution — every other
//! route answers 401 `{"error":"unauthorized"}` to an anonymous caller, and a
//! private notebook is indistinguishable from a missing one.

use std::collections::HashMap;
use std::convert::Infallible;
use std::net::{IpAddr, SocketAddr};
use std::time::{Duration, Instant};

use axum::extract::{ConnectInfo, FromRequestParts, Query, Request, State};
use axum::http::header::{AUTHORIZATION, COOKIE, RETRY_AFTER, SET_COOKIE, WWW_AUTHENTICATE};
use axum::http::request::Parts;
use axum::http::{HeaderMap, Method, StatusCode, Uri};
use axum::middleware::Next;
use axum::response::{IntoResponse, Response};
use axum::Json;
use parking_lot::Mutex;
use serde::Deserialize;
use serde_json::json;
use sha2::{Digest, Sha256};
use subtle::ConstantTimeEq;
use uuid::Uuid;

use crate::state::SharedState;

pub const SESSION_COOKIE: &str = "loom_session";
const SESSION_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);
/// Sessions are in-memory only; cap them so logins can't grow the map forever.
const MAX_SESSIONS: usize = 4096;
/// Failed logins per client: a burst of `LOGIN_BURST`, then one attempt per
/// `LOGIN_REFILL`.
const LOGIN_BURST: f64 = 5.0;
const LOGIN_REFILL: Duration = Duration::from_secs(2);
const MAX_TRACKED_CLIENTS: usize = 10_000;

struct Bucket {
    tokens: f64,
    last: Instant,
}

pub struct Auth {
    password: Option<String>,
    /// Session token → expiry. Tokens die with the process.
    sessions: Mutex<HashMap<String, Instant>>,
    /// Failed-login token bucket per client address.
    login_buckets: Mutex<HashMap<Option<IpAddr>, Bucket>>,
}

impl Auth {
    /// `None` or an empty password disables auth entirely.
    pub fn new(password: Option<String>) -> Self {
        Auth {
            password: password.filter(|p| !p.is_empty()),
            sessions: Mutex::new(HashMap::new()),
            login_buckets: Mutex::new(HashMap::new()),
        }
    }

    pub fn enabled(&self) -> bool {
        self.password.is_some()
    }

    /// Constant-time password check: both sides are hashed first so neither
    /// the content nor the length of the password leaks through timing.
    fn password_matches(&self, candidate: &str) -> bool {
        let Some(password) = &self.password else {
            return false;
        };
        let a = Sha256::digest(password.as_bytes());
        let b = Sha256::digest(candidate.as_bytes());
        a.as_slice().ct_eq(b.as_slice()).into()
    }

    fn mint_session(&self) -> String {
        // Two v4 UUIDs: 244 bits from the OS CSPRNG.
        let token = format!("{}{}", Uuid::new_v4().simple(), Uuid::new_v4().simple());
        let now = Instant::now();
        let mut sessions = self.sessions.lock();
        sessions.retain(|_, expires| *expires > now);
        if sessions.len() >= MAX_SESSIONS {
            if let Some(oldest) = sessions
                .iter()
                .min_by_key(|(_, expires)| **expires)
                .map(|(t, _)| t.clone())
            {
                sessions.remove(&oldest);
            }
        }
        sessions.insert(token.clone(), now + SESSION_TTL);
        token
    }

    fn session_valid(&self, token: &str) -> bool {
        matches!(self.sessions.lock().get(token), Some(expires) if *expires > Instant::now())
    }

    fn revoke_session(&self, token: &str) {
        self.sessions.lock().remove(token);
    }

    /// Bearer header or session cookie. (The SSE `?token=` form is handled
    /// by the guard, which knows the route.)
    fn credential_ok(&self, headers: &HeaderMap) -> bool {
        if let Some(candidate) = bearer_token(headers) {
            if self.password_matches(candidate) {
                return true;
            }
        }
        session_cookie(headers).is_some_and(|t| self.session_valid(t))
    }

    /// Take one login attempt from the client's bucket; `Err(retry_after)`
    /// when it is empty.
    fn take_login_attempt(&self, client: Option<IpAddr>) -> Result<(), Duration> {
        let now = Instant::now();
        let mut buckets = self.login_buckets.lock();
        if buckets.len() >= MAX_TRACKED_CLIENTS {
            // Full buckets carry no information; drop them.
            buckets.retain(|_, b| refilled(b, now) < LOGIN_BURST);
        }
        let bucket = buckets.entry(client).or_insert(Bucket {
            tokens: LOGIN_BURST,
            last: now,
        });
        bucket.tokens = refilled(bucket, now);
        bucket.last = now;
        if bucket.tokens < 1.0 {
            let wait = LOGIN_REFILL.mul_f64(1.0 - bucket.tokens);
            return Err(wait);
        }
        bucket.tokens -= 1.0;
        Ok(())
    }

    /// A successful login doesn't count against the client.
    fn refund_login_attempt(&self, client: Option<IpAddr>) {
        if let Some(bucket) = self.login_buckets.lock().get_mut(&client) {
            bucket.tokens = (bucket.tokens + 1.0).min(LOGIN_BURST);
        }
    }
}

fn refilled(bucket: &Bucket, now: Instant) -> f64 {
    let gained = now.duration_since(bucket.last).as_secs_f64() / LOGIN_REFILL.as_secs_f64();
    (bucket.tokens + gained).min(LOGIN_BURST)
}

fn bearer_token(headers: &HeaderMap) -> Option<&str> {
    let value = headers.get(AUTHORIZATION)?.to_str().ok()?;
    let (scheme, token) = value.split_once(' ')?;
    scheme.eq_ignore_ascii_case("bearer").then(|| token.trim())
}

fn session_cookie(headers: &HeaderMap) -> Option<&str> {
    headers
        .get_all(COOKIE)
        .iter()
        .filter_map(|v| v.to_str().ok())
        .flat_map(|v| v.split(';'))
        .find_map(|pair| {
            let (name, value) = pair.trim().split_once('=')?;
            (name == SESSION_COOKIE).then_some(value)
        })
}

fn query_param(uri: &Uri, key: &str) -> Option<String> {
    Query::<HashMap<String, String>>::try_from_uri(uri)
        .ok()
        .and_then(|Query(mut q)| q.remove(key))
}

/// `?public=1` / `?public=true` on the notebook list.
pub fn public_only(uri: &Uri) -> bool {
    matches!(
        query_param(uri, "public").as_deref(),
        Some("1") | Some("true")
    )
}

/// SSE routes: the only places `?token=` is honoured.
fn is_sse_route(path: &str) -> bool {
    path == "/api/events"
        || path
            .strip_prefix("/api/runs/")
            .and_then(|rest| rest.strip_suffix("/events"))
            .is_some_and(|id| !id.is_empty() && !id.contains('/'))
}

/// Anonymous reads of published notebooks. Anything that isn't provably a
/// read of a public notebook is refused the same way, so a private id and a
/// nonexistent id look identical from outside.
fn is_public_notebook_read(state: &SharedState, method: &Method, uri: &Uri) -> bool {
    if method != Method::GET && method != Method::HEAD {
        return false;
    }
    match uri.path().strip_prefix("/api/notebooks") {
        Some("") => public_only(uri),
        Some(rest) => rest
            .strip_prefix('/')
            .and_then(|id| Uuid::parse_str(id).ok())
            .and_then(|id| state.store.get_notebook(id).ok())
            .is_some_and(|nb| nb.public),
        None => false,
    }
}

fn unauthorized() -> Response {
    (
        StatusCode::UNAUTHORIZED,
        [(WWW_AUTHENTICATE, "Bearer")],
        Json(json!({ "error": "unauthorized" })),
    )
        .into_response()
}

/// Middleware over the whole app: enforces auth on `/api/*` and `/mcp`.
/// Everything else (the static console) is always served — the SPA handles
/// login itself.
pub async fn guard(State(state): State<SharedState>, req: Request, next: Next) -> Response {
    let auth = &state.auth;
    if !auth.enabled() {
        return next.run(req).await;
    }
    let path = req.uri().path();
    let protected = path == "/mcp" || path == "/api" || path.starts_with("/api/");
    let open = path == "/api/healthz" || path.starts_with("/api/auth/");
    if !protected || open {
        return next.run(req).await;
    }
    if auth.credential_ok(req.headers()) {
        return next.run(req).await;
    }
    if req.method() == Method::GET
        && is_sse_route(path)
        && query_param(req.uri(), "token").is_some_and(|t| auth.password_matches(&t))
    {
        return next.run(req).await;
    }
    if is_public_notebook_read(&state, req.method(), req.uri()) {
        return next.run(req).await;
    }
    unauthorized()
}

// ── /api/auth/* ──────────────────────────────────────────────────────────

/// Peer address when the server was started with connect-info (always, in
/// `main`); `None` under in-process test routers.
pub struct ClientIp(Option<IpAddr>);

impl<S: Send + Sync> FromRequestParts<S> for ClientIp {
    type Rejection = Infallible;

    async fn from_request_parts(parts: &mut Parts, _: &S) -> Result<Self, Self::Rejection> {
        Ok(ClientIp(
            parts
                .extensions
                .get::<ConnectInfo<SocketAddr>>()
                .map(|c| c.0.ip()),
        ))
    }
}

#[derive(Deserialize)]
pub struct LoginBody {
    #[serde(default)]
    password: String,
}

fn cookie_header(headers: &HeaderMap, value: &str, max_age: u64) -> String {
    // Behind a TLS-terminating proxy the cookie must not travel over http.
    let https = headers
        .get("x-forwarded-proto")
        .and_then(|v| v.to_str().ok())
        .is_some_and(|v| v.eq_ignore_ascii_case("https"));
    format!(
        "{SESSION_COOKIE}={value}; Path=/; Max-Age={max_age}; HttpOnly; SameSite=Lax{}",
        if https { "; Secure" } else { "" }
    )
}

pub async fn login(
    State(state): State<SharedState>,
    ClientIp(client): ClientIp,
    headers: HeaderMap,
    Json(body): Json<LoginBody>,
) -> Response {
    let auth = &state.auth;
    if !auth.enabled() {
        return Json(json!({ "ok": true })).into_response();
    }
    if let Err(wait) = auth.take_login_attempt(client) {
        let secs = wait.as_secs_f64().ceil().max(1.0) as u64;
        return (
            StatusCode::TOO_MANY_REQUESTS,
            [(RETRY_AFTER, secs.to_string())],
            Json(json!({ "error": format!("too many login attempts — retry in {secs}s") })),
        )
            .into_response();
    }
    if !auth.password_matches(&body.password) {
        return (
            StatusCode::UNAUTHORIZED,
            Json(json!({ "error": "invalid password" })),
        )
            .into_response();
    }
    auth.refund_login_attempt(client);
    let token = auth.mint_session();
    (
        [(
            SET_COOKIE,
            cookie_header(&headers, &token, SESSION_TTL.as_secs()),
        )],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

pub async fn logout(State(state): State<SharedState>, headers: HeaderMap) -> Response {
    if let Some(token) = session_cookie(&headers) {
        state.auth.revoke_session(token);
    }
    (
        [(SET_COOKIE, cookie_header(&headers, "", 0))],
        Json(json!({ "ok": true })),
    )
        .into_response()
}

/// Always open. `authenticated` is true whenever the caller has full access —
/// including when auth is disabled.
pub async fn status(
    State(state): State<SharedState>,
    headers: HeaderMap,
) -> Json<serde_json::Value> {
    let auth = &state.auth;
    Json(json!({
        "enabled": auth.enabled(),
        "authenticated": !auth.enabled() || auth.credential_ok(&headers),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_password_disables_auth() {
        assert!(!Auth::new(None).enabled());
        assert!(!Auth::new(Some(String::new())).enabled());
        assert!(Auth::new(Some("hunter2".into())).enabled());
    }

    #[test]
    fn password_check_is_exact() {
        let auth = Auth::new(Some("hunter2".into()));
        assert!(auth.password_matches("hunter2"));
        assert!(!auth.password_matches("hunter"));
        assert!(!auth.password_matches("hunter22"));
        assert!(!auth.password_matches(""));
        assert!(!Auth::new(None).password_matches(""));
    }

    #[test]
    fn cookie_is_found_among_others() {
        let mut headers = HeaderMap::new();
        headers.insert(
            COOKIE,
            "theme=dark; loom_session=abc123; x=y".parse().unwrap(),
        );
        assert_eq!(session_cookie(&headers), Some("abc123"));
        headers.insert(COOKIE, "not_loom_session=abc".parse().unwrap());
        assert_eq!(session_cookie(&headers), None);
    }

    #[test]
    fn sse_routes_are_the_only_token_routes() {
        assert!(is_sse_route("/api/events"));
        assert!(is_sse_route("/api/runs/abc/events"));
        assert!(!is_sse_route("/api/runs/abc"));
        assert!(!is_sse_route("/api/runs//events"));
        assert!(!is_sse_route("/api/runs/a/b/events"));
        assert!(!is_sse_route("/api/execute"));
    }

    #[test]
    fn failed_logins_drain_the_bucket_per_client() {
        let auth = Auth::new(Some("pw".into()));
        let a = Some("10.0.0.1".parse().unwrap());
        let b = Some("10.0.0.2".parse().unwrap());
        for _ in 0..LOGIN_BURST as usize {
            assert!(auth.take_login_attempt(a).is_ok());
        }
        let wait = auth.take_login_attempt(a).unwrap_err();
        assert!(wait <= LOGIN_REFILL);
        assert!(
            auth.take_login_attempt(b).is_ok(),
            "other clients unaffected"
        );
        auth.refund_login_attempt(a);
        assert!(
            auth.take_login_attempt(a).is_ok(),
            "refund restores an attempt"
        );
    }

    #[test]
    fn sessions_are_revocable() {
        let auth = Auth::new(Some("pw".into()));
        let token = auth.mint_session();
        assert_eq!(token.len(), 64);
        assert!(auth.session_valid(&token));
        auth.revoke_session(&token);
        assert!(!auth.session_valid(&token));
    }
}
