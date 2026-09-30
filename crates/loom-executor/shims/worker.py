"""Loom Python worker shim.

Reads JSON job requests from stdin, one per line:
    {"entry": "/path/to/job.py", "params": {...}, "inputs": {...}}

For each job it loads the module at `entry`, calls `handler(params, inputs)`,
and writes JSON-lines events to stdout:
    {"type": "log",    "line": "..."}          -- every print() from the handler
    {"type": "result", "value": <json>}        -- on success
    {"type": "error",  "message": "...", "trace": "..."}  -- on failure

The loop then waits for the next job, so a warm worker can serve many tasks
(the executor's worker pool relies on this); EOF on stdin ends the process.
"""
import importlib.util
import io
import json
import math
import os
import sys
import traceback

# Make the in-task platform bindings importable: `import loom`.
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

REAL_STDOUT = sys.stdout


def emit(obj):
    REAL_STDOUT.write(json.dumps(obj) + "\n")
    REAL_STDOUT.flush()


def _default(o):
    """Lower common scientific types (numpy, pandas) to plain JSON values."""
    to_dict = getattr(o, "to_dict", None)
    if callable(to_dict) and hasattr(o, "columns"):  # pandas DataFrame → rows
        return to_dict(orient="records")
    for attr in ("tolist", "item"):  # numpy arrays/scalars, pandas Series/Index
        fn = getattr(o, attr, None)
        if callable(fn):
            return fn()
    isoformat = getattr(o, "isoformat", None)  # datetime/date/Timestamp
    if callable(isoformat):
        return isoformat()
    if isinstance(o, (set, frozenset, tuple)):
        return list(o)
    raise TypeError(f"Object of type {type(o).__name__} is not JSON serializable")


def _finite(v):
    """NaN/±Infinity are not JSON; they become null."""
    if isinstance(v, float):
        return v if math.isfinite(v) else None
    if isinstance(v, dict):
        return {k: _finite(x) for k, x in v.items()}
    if isinstance(v, list):
        return [_finite(x) for x in v]
    return v


def emit_result(value):
    try:
        line = json.dumps({"type": "result", "value": value}, default=_default, allow_nan=False)
    except ValueError:  # non-finite float somewhere: round-trip once, then scrub
        plain = json.loads(json.dumps(value, default=_default))
        line = json.dumps({"type": "result", "value": _finite(plain)}, allow_nan=False)
    REAL_STDOUT.write(line + "\n")
    REAL_STDOUT.flush()


class LogStream(io.TextIOBase):
    """Turns handler print() output into streamed log events."""

    def __init__(self):
        self._buf = ""

    def write(self, s):
        self._buf += s
        while "\n" in self._buf:
            line, self._buf = self._buf.split("\n", 1)
            if line.strip():
                emit({"type": "log", "line": line})
        return len(s)

    def flush(self):
        if self._buf.strip():
            emit({"type": "log", "line": self._buf})
        self._buf = ""


def run_job(req):
    spec = importlib.util.spec_from_file_location("loom_job", req["entry"])
    module = importlib.util.module_from_spec(spec)

    log_stream = LogStream()
    sys.stdout = log_stream
    try:
        spec.loader.exec_module(module)
        handler = getattr(module, "handler", None)
        if handler is None:
            raise RuntimeError("job must define `def handler(params, inputs)`")
        result = handler(req.get("params") or {}, req.get("inputs") or {})
        log_stream.flush()
        emit_result(result)
    except Exception as exc:  # noqa: BLE001 - report everything to the orchestrator
        log_stream.flush()
        emit({"type": "error", "message": str(exc), "trace": traceback.format_exc()})
    finally:
        sys.stdout = REAL_STDOUT


def main():
    for line in sys.stdin:
        line = line.strip()
        if line:
            run_job(json.loads(line))


if __name__ == "__main__":
    main()
