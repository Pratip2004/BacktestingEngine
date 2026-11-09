"""Background runner for the research ledger.

One thread works queued experiments in priority order, one period at a time, through the generic engine
(run_strategy). Each finished period is saved as a normal builder run (so it opens in the builder with replay)
and written back to the experiment at once, so a restart only repeats the period that was in flight. A period
whose fingerprint already has a result (same spec, dates and costs) reuses it instead of running again.
Waits while Breeze is logged out (the engine fetches missing candles) or the runner is paused.
"""

from __future__ import annotations

import copy
import logging
import threading
import time as _time
from datetime import date

from fastapi import HTTPException

from app import runs
from app.breeze_client import breeze
from app.data.access import HARD_DAILY_CAP
from app.data.store import get_store
from app.research import ledger
from app.research.evaluate import checks, evaluate, experiment_gates
from app.strategy.engine import run_strategy

log = logging.getLogger(__name__)

WORKERS = 3  # experiments run in parallel; Breeze calls are still throttled globally and the store is one lock
_state = {"paused": False, "started": False}
_slots: dict[str, dict] = {}  # worker thread name → {"current", "message"}
_wake = threading.Event()
_claim = threading.Lock()


def _slot() -> dict:
    return _slots.setdefault(threading.current_thread().name, {"current": None, "message": "idle"})


def status() -> dict:
    busy = [w for w in _slots.values() if w["current"]]
    return {
        "paused": _state["paused"],
        "current": busy[0]["current"] if busy else None,
        "message": " · ".join(w["message"] for w in busy) if busy else next((w["message"] for w in _slots.values()), "idle"),
        "workers": [{"name": k, **v} for k, v in sorted(_slots.items())],
    }


def pause(paused: bool) -> dict:
    _state["paused"] = paused
    ledger.log_event("system", "Research runner paused" if paused else "Research runner resumed", "lead")
    _wake.set()
    return status()


def kick() -> None:
    _wake.set()


def program_looks() -> int:
    """Strategies looked at so far across the whole program: experiments that ran (or are running) plus looks
    recorded outside the ledger (state.extra_looks: dashboard runs before it existed, manual screens) plus offline
    engine screens (.data/research/screens.jsonl, app/research/screen.py)."""
    from app.research.screen import screen_count
    ran = sum(1 for e in ledger.all_experiments() if e.get("results") or e.get("history") or e["status"] == "running")
    return max(1, ran + int(ledger.get_state().get("extra_looks") or 0) + screen_count())


def _apply_costs(spec: dict, overrides: dict | None) -> dict:
    if not overrides:
        return spec
    s = copy.deepcopy(spec)
    s["costs"] = {**s["costs"], **overrides}
    return s


def _summary(result: dict) -> dict:
    m = result["metrics"]
    return {"net_pnl": m["net_pnl"], "trades": m["trades"], "win_rate": m["win_rate"]}


def _run_period(exp: dict, period: dict) -> dict:
    fp = period["fingerprint"]
    reused = ledger.find_result(fp, exclude=exp["id"])
    if reused:
        src, r = reused
        ledger.append_log(exp, f"{period['key']}: identical run already in {src}; reused run {r['run_id']}")
        return {**r, "reused_from": src}
    spec = _apply_costs(exp["spec"], period.get("cost_overrides"))
    last_save = [0.0]

    def progress(done: int, total: int, message: str):
        exp["progress"] = {"period": period["key"], "stage": "executing", "done": done, "total": total, "message": message}
        _slot()["message"] = f"{exp['id']} {period['key']}: {message}"
        if _time.time() - last_save[0] > 2:
            last_save[0] = _time.time()
            ledger.save(exp)

    exp["progress"] = {"period": period["key"], "stage": "preparing data", "done": 0, "total": 0, "message": "Loading calendar and signals"}
    ledger.save(exp)
    result = run_strategy(spec, date.fromisoformat(period["from"]), date.fromisoformat(period["to"]), progress)
    exp["progress"] = {"period": period["key"], "stage": "evaluating", "done": 0, "total": 0, "message": "Computing metrics"}
    ledger.save(exp)
    params = {**result["params"], "experiment_id": exp["id"], "period": period["key"]}
    run_id = runs.save("custom", params, result, _summary(result))
    runs.update(run_id, {"name": f"{exp['id']} · {exp['name']} · {period['label']}"})
    ext = evaluate(result, exp.get("capital", 100000))
    return {"fingerprint": fp, "engine_version": result.get("engine_version"), "run_id": run_id, "metrics": result["metrics"], "breakdowns": result["breakdowns"], "ext": ext,
            "skipped_sample": (result.get("skipped") or [])[:20], "finished_at": ledger.now()}


def _work(exp: dict) -> None:
    exp["status"] = "running"
    ledger.append_log(exp, "Started")
    ledger.save(exp)
    ledger.log_event("experiment", f"Running {exp['id']} · {exp['name']}", "runner", exp["id"])
    looks = program_looks()
    for period in exp["periods"]:
        if period["key"] in exp["results"] and not exp["results"][period["key"]].get("error"):
            continue
        _slot()["current"] = {"id": exp["id"], "period": period["key"]}
        try:
            r = _run_period(exp, period)
            r["checks"] = checks(r["ext"], exp.get("criteria"), looks)
            r["looks"] = looks
            exp["results"][period["key"]] = r
            e = r["ext"]
            ledger.append_log(exp, f"{period['label']}: {e['trades']} trades, net ₹{e['net_pnl']:,.0f}, PF {e['profit_factor']}, max DD {e['max_drawdown_pct']}%")
        except HTTPException as exc:
            exp["results"][period["key"]] = {"fingerprint": period["fingerprint"], "error": str(exc.detail)}
            ledger.append_log(exp, f"{period['label']}: failed: {exc.detail}")
        except Exception as exc:  # keep the runner alive; record the failure on the experiment
            log.exception("research period failed")
            exp["results"][period["key"]] = {"fingerprint": period["fingerprint"], "error": f"{type(exc).__name__}: {exc}"}
            ledger.append_log(exp, f"{period['label']}: failed: {type(exc).__name__}: {exc}")
        exp["progress"] = None
        ledger.save(exp)
        if _state["paused"] or not breeze.is_connected:
            break
    exp["gates"] = experiment_gates(exp["results"])
    done = all(p["key"] in exp["results"] for p in exp["periods"])
    if done:
        failed = [k for k, r in exp["results"].items() if r.get("error")]
        exp["status"] = "failed" if failed and len(failed) == len(exp["results"]) else "done"
        ledger.append_log(exp, "Finished" + (f" with errors in {', '.join(failed)}" if failed else ""))
        ledger.log_event("experiment", f"{exp['id']} finished" + (f" (errors: {', '.join(failed)})" if failed else ""), "runner", exp["id"])
    else:
        exp["status"] = "queued"
    ledger.save(exp)


def _claim_next() -> dict | None:
    """Highest-priority queued experiment, marked running before another worker can take it."""
    with _claim:
        queued = [e for e in ledger.all_experiments() if e["status"] == "queued"]
        queued.sort(key=lambda e: (-e.get("priority", 0), e["id"]))
        if not queued:
            return None
        exp = queued[0]
        exp["status"] = "running"
        ledger.save(exp)
        return exp


def _loop() -> None:
    slot = _slot()
    while True:
        _wake.wait(5)
        try:
            if _state["paused"]:
                slot.update(current=None, message="paused")
                continue
            if not breeze.is_connected:
                slot["message"] = "waiting for a Breeze session (log in on the Session page)"
                continue
            # if get_store().calls_on() >= HARD_DAILY_CAP:
            #     slot["message"] = f"Breeze daily call cap ({HARD_DAILY_CAP}) reached; waiting for tomorrow"
            #     continue
            exp = _claim_next()
            if exp is None:
                slot.update(current=None, message="idle")
                _wake.clear()
                continue
            _work(exp)
            slot.update(current=None, message="idle")
        except Exception:
            log.exception("research runner loop")
            _time.sleep(5)


def start() -> None:
    if _state["started"]:
        return
    _state["started"] = True
    ledger.recover_interrupted()
    from app.research import paper
    paper.start()  # daily refresh of paper-watched strategies
    for i in range(WORKERS):
        threading.Thread(target=_loop, name=f"research-{i + 1}", daemon=True).start()
