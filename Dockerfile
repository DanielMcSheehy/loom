# ── build the console ────────────────────────────────────────────────────
FROM node:22-bookworm-slim AS console
WORKDIR /build
COPY console/package.json console/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY console/ ./
RUN npm run build

# ── build the server ─────────────────────────────────────────────────────
# Pinned to bookworm to match the runtime (glibc 2.36). Floating `*-slim`
# tags drifted: rust:1-slim moved to trixie (glibc 2.41) while
# node:22-slim is still bookworm (2.36), producing
# `GLIBC_2.39 not found` at startup.
FROM rust:1-bookworm AS server
WORKDIR /build
COPY Cargo.toml Cargo.lock ./
COPY crates/ crates/
RUN cargo build --release -p loom-server

# ── runtime: rust binary + python + node workers ─────────────────────────
FROM node:22-bookworm-slim
RUN apt-get update \
  && apt-get install -y --no-install-recommends python3 python3-venv ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
# Copied BEFORE the pip install on purpose: BuildKit runs independent stages
# in parallel, and the Rust stage (polars + thin LTO) needs several GB of RAM.
# Depending on its output makes the pip step wait for it, so the two heavy
# steps never overlap on small build hosts (Coolify builds died mid-pip with
# exit 255 when they did).
COPY --from=server /build/target/release/loom-server /usr/local/bin/loom-server
# Scientific Python for task/function handlers. Debian's system Python is
# externally managed (PEP 668), so packages live in a venv that workers use
# via LOOM_PYTHON_BIN. Single-threaded BLAS/OpenMP: many workers run in
# parallel, so per-worker thread pools would oversubscribe the CPUs.
RUN python3 -m venv /opt/loom-py \
  && /opt/loom-py/bin/pip install --no-cache-dir numpy pandas scipy scikit-learn
COPY --from=console /build/dist /app/console/dist
ENV LOOM_PORT=7420 \
    LOOM_DATA_DIR=/data \
    LOOM_CONSOLE_DIST=/app/console/dist \
    LOOM_PYTHON_BIN=/opt/loom-py/bin/python3 \
    OMP_NUM_THREADS=1 \
    OPENBLAS_NUM_THREADS=1 \
    MKL_NUM_THREADS=1
VOLUME /data
EXPOSE 7420
CMD ["loom-server"]
