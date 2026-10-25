"""In-memory background jobs for long Breeze batches (e.g. a 220-call expiry comparison)."""

import threading
import uuid
from datetime import datetime
from typing import Any, Callable

from fastapi import HTTPException

_jobs: dict[str, dict[str, Any]] = {}
_lock = threading.Lock()


def start(kind: str, params: dict, fn: Callable[..., Any]) -> str:
    """Run fn(progress=..., **params) in a thread. An identical job that's still running is reused."""
    with _lock:
        for jid, job in _jobs.items():
            if job["kind"] == kind and job["params"] == params and job["status"] == "running":
                return jid
        jid = uuid.uuid4().hex[:12]
        job = {"id": jid, "kind": kind, "params": params, "status": "running", "done": 0, "total": 0,
               "message": "Starting", "result": None, "error": None, "created": datetime.now().isoformat()}
        _jobs[jid] = job

    def progress(done: int, total: int, message: str):
        job.update(done=done, total=total, message=message)

    def run():
        try:
            job["result"] = fn(progress=progress, **params)
            job["status"] = "done"
        except HTTPException as exc:
            job.update(status="error", error=exc.detail)
        except Exception as exc:  # surface anything to the UI rather than leaving the job "running"
            job.update(status="error", error=f"{type(exc).__name__}: {exc}")

    threading.Thread(target=run, daemon=True).start()
    return jid


def get(jid: str) -> dict:
    job = _jobs.get(jid)
    if not job:
        raise HTTPException(404, "Unknown job (jobs are lost when the server restarts)")
    return job
