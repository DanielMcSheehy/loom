mod auth;
mod connectors;
mod data;
mod error;
mod mcp;
mod orchestrator;
mod routes;
mod scheduler;
mod state;

use std::net::SocketAddr;
use std::path::PathBuf;

use loom_executor::Executor;
use loom_store::Store;
use tower_http::services::{ServeDir, ServeFile};
use tracing::info;
use tracing_subscriber::EnvFilter;

#[tokio::main]
async fn main() -> anyhow::Result<()> {
    tracing_subscriber::fmt()
        .with_env_filter(
            EnvFilter::try_from_default_env().unwrap_or_else(|_| EnvFilter::new("info")),
        )
        .init();

    let port: u16 = env_or("LOOM_PORT", "7420").parse()?;
    let data_dir = PathBuf::from(env_or("LOOM_DATA_DIR", "./data"));
    let console_dist = PathBuf::from(env_or("LOOM_CONSOLE_DIST", "./console/dist"));

    std::fs::create_dir_all(&data_dir)?;
    // Workers inherit this and reach back into the platform (loom.query()
    // etc.) — set before the executor exists so every worker sees it.
    if std::env::var("LOOM_API_URL").is_err() {
        std::env::set_var("LOOM_API_URL", format!("http://127.0.0.1:{port}"));
    }
    // Optional password auth. Workers get the credential as LOOM_API_TOKEN
    // so the in-task `loom` bindings keep working when auth is on.
    let password = std::env::var("LOOM_PASSWORD")
        .ok()
        .filter(|p| !p.is_empty());
    if let Some(password) = &password {
        std::env::set_var("LOOM_API_TOKEN", password);
    }
    let store = Store::open(data_dir.join("loom.db"))?;
    let executor = Executor::new()?;
    let state = state::AppState::with_password(store, executor, data_dir, password);
    if state.auth.enabled() {
        info!("password auth enabled (LOOM_PASSWORD); published notebooks stay readable");
    } else {
        info!("LOOM_PASSWORD not set — the API is open to anyone who can reach this port");
    }

    scheduler::spawn(state.clone());

    let mut app = routes::app(state);

    // Serve the built console when present (docker / production).
    if console_dist.join("index.html").exists() {
        info!("serving console from {}", console_dist.display());
        let spa =
            ServeDir::new(&console_dist).fallback(ServeFile::new(console_dist.join("index.html")));
        app = app.fallback_service(spa);
    }

    let listener = tokio::net::TcpListener::bind(("0.0.0.0", port)).await?;
    info!("loom-server listening on http://0.0.0.0:{port}");
    // Connect-info gives the login rate limiter the peer address.
    axum::serve(
        listener,
        app.into_make_service_with_connect_info::<SocketAddr>(),
    )
    .await?;
    Ok(())
}

fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}
