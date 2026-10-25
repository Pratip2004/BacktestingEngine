"""Saved backtest runs, stored as JSON files so every backtest can be reopened from the dashboard.

Each run is two files in .data/runs/:
  {id}.meta.json    small: strategy, name, params, view (the UI's exit settings), summary metrics
  {id}.result.json  large: the raw result the strategy page renders (candidates, day paths, trades…)
Listing only reads the meta files, so it stays fast however big the results get.
"""

import json
import threading
import uuid
from datetime import datetime
from typing import Any, Callable

from fastapi import HTTPException

from app.config import BASE_DIR

RUNS_DIR = BASE_DIR / ".data" / "runs"
STRATEGY_NAMES = {
    "stock": "Stock strategy backtest",
    "butterfly": "EMA crossover butterfly",
    "straddle": "Intraday ATM straddle",
}
_lock = threading.Lock()


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _meta_path(run_id: str):
    return RUNS_DIR / f"{run_id}.meta.json"


def _result_path(run_id: str):
    return RUNS_DIR / f"{run_id}.result.json"


def _default_name(strategy: str, params: dict) -> str:
    period = f"{str(params.get('from_date', ''))[:10]} → {str(params.get('to_date', ''))[:10]}"
    if strategy == "stock":
        return f"{params.get('strategy', 'strategy')} on {params.get('stock_code', '')} · {period}"
    return f"{STRATEGY_NAMES[strategy]} · {period}"


def save(strategy: str, params: dict, result: Any, summary: dict | None = None) -> str:
    run_id = uuid.uuid4().hex[:12]
    meta = {
        "id": run_id,
        "strategy": strategy,
        "strategy_name": STRATEGY_NAMES[strategy],
        "name": _default_name(strategy, params),
        "created_at": _now(),
        "updated_at": _now(),
        "params": json.loads(json.dumps(params, default=str)),
        "view": None,
        "summary": summary,
    }
    with _lock:
        RUNS_DIR.mkdir(parents=True, exist_ok=True)
        _result_path(run_id).write_text(json.dumps(result, default=str))
        _meta_path(run_id).write_text(json.dumps(meta))
    return run_id


def saving(strategy: str, fn: Callable[..., dict]) -> Callable[..., dict]:
    """Wrap a job function so its result is saved as a run; the job result gains `run_id`."""
    def run(progress, **params):
        result = fn(progress=progress, **params)
        result["run_id"] = save(strategy, params, result)
        return result
    return run


def list_runs() -> list[dict]:
    if not RUNS_DIR.exists():
        return []
    metas = [json.loads(p.read_text()) for p in RUNS_DIR.glob("*.meta.json")]
    return sorted(metas, key=lambda m: m["created_at"], reverse=True)


def get(run_id: str) -> dict:
    meta = _meta_path(run_id)
    if not meta.exists():
        raise HTTPException(404, "Saved backtest not found")
    return {**json.loads(meta.read_text()), "result": json.loads(_result_path(run_id).read_text())}


def update(run_id: str, changes: dict) -> dict:
    with _lock:
        path = _meta_path(run_id)
        if not path.exists():
            raise HTTPException(404, "Saved backtest not found")
        meta = json.loads(path.read_text())
        meta.update({k: v for k, v in changes.items() if v is not None}, updated_at=_now())
        path.write_text(json.dumps(meta))
    return meta


def delete(run_id: str) -> None:
    with _lock:
        if not _meta_path(run_id).exists():
            raise HTTPException(404, "Saved backtest not found")
        _meta_path(run_id).unlink()
        _result_path(run_id).unlink(missing_ok=True)
