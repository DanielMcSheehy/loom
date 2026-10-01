use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use loom_core::LoomEvent;
use loom_executor::Executor;
use loom_store::Store;
use parking_lot::Mutex;
use tokio::sync::broadcast;
use tokio_util::sync::CancellationToken;
use uuid::Uuid;

use crate::auth::Auth;

pub struct AppState {
    pub store: Store,
    pub executor: Executor,
    pub events: broadcast::Sender<LoomEvent>,
    pub data_dir: PathBuf,
    /// One cancellation token per in-flight run. A run's token lives here
    /// from launch until it reaches a terminal state; the orchestrator and
    /// the cancel endpoint both take this lock when they write the run's
    /// final state, so "who finished the run" is decided exactly once —
    /// whoever removes the token owns the terminal transition.
    pub cancellations: Mutex<HashMap<Uuid, CancellationToken>>,
    /// Password + session tokens; disabled when `LOOM_PASSWORD` is unset.
    pub auth: Auth,
}

pub type SharedState = Arc<AppState>;

impl AppState {
    /// State with auth disabled (the default, and what tests want).
    #[cfg(test)]
    pub fn new(store: Store, executor: Executor, data_dir: PathBuf) -> SharedState {
        Self::with_password(store, executor, data_dir, None)
    }

    /// `password`: `None`/empty disables auth; otherwise `/api/*` and `/mcp`
    /// require it (see [`crate::auth`]).
    pub fn with_password(
        store: Store,
        executor: Executor,
        data_dir: PathBuf,
        password: Option<String>,
    ) -> SharedState {
        let (events, _) = broadcast::channel(4096);
        Arc::new(AppState {
            store,
            executor,
            events,
            data_dir,
            cancellations: Mutex::new(HashMap::new()),
            auth: Auth::new(password),
        })
    }

    pub fn emit(&self, event: LoomEvent) {
        // Nobody listening is fine — the stream is best-effort telemetry.
        let _ = self.events.send(event);
    }

    /// Path of a dataset's NDJSON file.
    pub fn dataset_path(&self, name: &str) -> PathBuf {
        self.data_dir
            .join("datasets")
            .join(format!("{name}.ndjson"))
    }
}
