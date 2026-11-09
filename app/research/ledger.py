"""Research ledger: every experiment, decision and the program's state, as JSON files in .data/research/.

  experiments/{id}.json  one experiment: hypothesis, spec, periods to run, pre-registered criteria, results per
                         period (linked to saved runs), audit / critic notes, verdict and next action
  events.jsonl           timeline (decisions, experiment stages, audits, agent activity), append-only
  state.json             phase, agents and their tasks, plain-English summary

Duplicate detection works on two keys:
  fingerprint(spec, period)  exact: same canonical spec (name/description ignored), dates and cost overrides →
                             the earlier result is reused instead of re-run
  economic_key(spec)         the trade itself (underlying, entry rule, legs, days) without exits / costs, so
                             exit and cost variants of one idea are grouped as a family
"""

from __future__ import annotations

import hashlib
import json
import subprocess
import threading
from datetime import datetime
from typing import Any

from fastapi import HTTPException

from app.config import BASE_DIR
from app.strategy.engine import ENGINE_VERSION
from app.strategy.spec import StrategySpec

RESEARCH_DIR = BASE_DIR / ".data" / "research"
EXP_DIR = RESEARCH_DIR / "experiments"
EVENTS = RESEARCH_DIR / "events.jsonl"
STATE = RESEARCH_DIR / "state.json"

STATUSES = ("queued", "running", "done", "failed", "blocked", "cancelled")
VERDICTS = ("pending", "rejected", "revise", "inconclusive", "advance", "promoted")
DEFAULT_STATE = {
    "phase": "Baseline",
    "phase_detail": "",
    "cycle": 1,
    "agents": [],
    "summary": "",
    "protocol": "",
    "extra_looks": 0,
}
_lock = threading.RLock()


def now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def code_rev() -> str:
    try:
        rev = subprocess.run(["git", "rev-parse", "--short", "HEAD"], cwd=BASE_DIR, capture_output=True, text=True, timeout=5).stdout.strip()
        dirty = subprocess.run(["git", "status", "--porcelain", "--", "app"], cwd=BASE_DIR, capture_output=True, text=True, timeout=5).stdout.strip()
        return f"{rev}{'+dirty' if dirty else ''}"
    except Exception:  # git missing: still record something
        return "unknown"


# ---------- keys ----------

def canonical_spec(spec: dict) -> dict:
    s = StrategySpec.model_validate(spec).model_dump(mode="json")
    s.pop("name", None)
    s.pop("description", None)
    return s


def _hash(obj: Any) -> str:
    return hashlib.sha1(json.dumps(obj, sort_keys=True, default=str).encode()).hexdigest()[:16]


def fingerprint(spec: dict, period: dict) -> str:
    s = canonical_spec(spec)
    return _hash({"spec": s, "from": period["from"], "to": period["to"], "costs": period.get("cost_overrides") or {},
                  "engine": ENGINE_VERSION})


def economic_key(spec: dict) -> str:
    s = canonical_spec(spec)
    entry = s["schedule"]["entry"]
    trade = {
        "underlying": s["underlying"],
        "entry": entry if entry["type"] == "signal" else {k: entry[k] for k in ("type", "time", "prev_day")},
        "timeframe": s["timeframe"] if entry["type"] == "signal" else None,
        "weekdays": s["schedule"]["weekdays"],
        "dte": s["schedule"]["dte"],
        "position": s["position"],
    }
    return _hash(trade)


# ---------- events & state ----------

def log_event(kind: str, text: str, actor: str = "lead", experiment_id: str | None = None) -> dict:
    ev = {"t": now(), "kind": kind, "actor": actor, "text": text, "experiment_id": experiment_id}
    with _lock:
        RESEARCH_DIR.mkdir(parents=True, exist_ok=True)
        with EVENTS.open("a") as f:
            f.write(json.dumps(ev) + "\n")
    return ev


def events(limit: int = 200, experiment_id: str | None = None) -> list[dict]:
    if not EVENTS.exists():
        return []
    rows = [json.loads(line) for line in EVENTS.read_text().splitlines() if line.strip()]
    if experiment_id:
        rows = [r for r in rows if r.get("experiment_id") == experiment_id]
    return rows[-limit:][::-1]


def get_state() -> dict:
    if not STATE.exists():
        return dict(DEFAULT_STATE)
    return {**DEFAULT_STATE, **json.loads(STATE.read_text())}


def update_state(changes: dict) -> dict:
    with _lock:
        state = get_state()
        state.update({k: v for k, v in changes.items() if k in DEFAULT_STATE and v is not None})
        state["updated_at"] = now()
        RESEARCH_DIR.mkdir(parents=True, exist_ok=True)
        STATE.write_text(json.dumps(state, indent=1))
    return state


# ---------- experiments ----------

def _path(eid: str):
    return EXP_DIR / f"{eid}.json"


def save(exp: dict) -> dict:
    with _lock:
        exp["updated_at"] = now()
        EXP_DIR.mkdir(parents=True, exist_ok=True)
        tmp = _path(exp["id"]).with_suffix(".tmp")
        tmp.write_text(json.dumps(exp, default=str))
        tmp.replace(_path(exp["id"]))
    return exp


def get(eid: str) -> dict:
    p = _path(eid)
    if not p.exists():
        raise HTTPException(404, f"Unknown experiment {eid}")
    return json.loads(p.read_text())


def all_experiments() -> list[dict]:
    if not EXP_DIR.exists():
        return []
    return sorted((json.loads(p.read_text()) for p in EXP_DIR.glob("*.json")), key=lambda e: e["id"])


def _next_id() -> str:
    ids = [int(e["id"][1:]) for e in all_experiments() if e["id"][1:].isdigit()]
    return f"E{(max(ids) + 1 if ids else 1):04d}"


def find_result(fp: str, exclude: str | None = None) -> tuple[str, dict] | None:
    """An earlier experiment's finished result for the same fingerprint → (experiment id, result)."""
    for e in all_experiments():
        if e["id"] == exclude:
            continue
        for r in (e.get("results") or {}).values():
            if r.get("fingerprint") == fp and r.get("run_id") and not r.get("error"):
                return e["id"], r
    return None


def similar(spec: dict, exclude: str | None = None) -> list[dict]:
    key = economic_key(spec)
    return [{"id": e["id"], "name": e["name"], "verdict": e.get("verdict")} for e in all_experiments()
            if e.get("economic_key") == key and e["id"] != exclude]


def create(body: dict, allow_duplicate: bool = False) -> dict:
    """New experiment from {name, family, hypothesis, mechanism, spec, periods, criteria, …}; queued to run."""
    spec = StrategySpec.model_validate(body["spec"]).model_dump(mode="json")
    periods = body.get("periods") or []
    if not periods:
        raise HTTPException(422, "An experiment needs at least one period")
    for p in periods:
        p["fingerprint"] = fingerprint(spec, p)
    with _lock:
        fps = sorted(p["fingerprint"] for p in periods)
        if not allow_duplicate:
            for e in all_experiments():
                if e.get("status") != "cancelled" and sorted(p["fingerprint"] for p in e.get("periods", [])) == fps:
                    raise HTTPException(409, f"Duplicate of {e['id']} ({e['name']}): same spec, periods and costs")
        eid = _next_id()
        exp = {
            "id": eid,
            "parent_id": body.get("parent_id"),
            "created_at": now(),
            "name": body.get("name") or spec["name"],
            "family": body.get("family", "other"),
            "version": body.get("version", 1),
            "source": body.get("source", "lead"),
            "hypothesis": body.get("hypothesis", ""),
            "mechanism": body.get("mechanism", ""),
            "novelty": body.get("novelty", ""),
            "failure_modes": body.get("failure_modes", ""),
            "stage": body.get("stage", "A"),
            "capital": body.get("capital", 100000),
            "spec": spec,
            "periods": periods,
            "criteria": body.get("criteria") or {},
            "priority": body.get("priority", 0),
            "status": "queued",
            "verdict": "pending",
            "results": {},
            "progress": None,
            "log": [],
            "audit": [],
            "critic": [],
            "next_action": body.get("next_action", ""),
            "decision_reason": "",
            "economic_key": economic_key(spec),
            "similar": similar(spec),
            "code_rev": code_rev(),
        }
        save(exp)
    log_event("experiment", f"Queued {eid} · {exp['name']}", exp["source"], eid)
    return exp


def append_log(exp: dict, msg: str) -> None:
    exp["log"].append({"t": now(), "msg": msg})
    exp["log"] = exp["log"][-200:]


def update(eid: str, changes: dict) -> dict:
    """Lead / auditor / critic updates: verdict, next action, notes, stage, priority, status, extra periods."""
    with _lock:
        exp = get(eid)
        for k in ("verdict", "next_action", "decision_reason", "stage", "priority", "name", "hypothesis", "mechanism",
                  "novelty", "failure_modes", "criteria"):
            if changes.get(k) is not None:
                exp[k] = changes[k]
        if changes.get("verdict") and changes["verdict"] not in VERDICTS:
            raise HTTPException(422, f"verdict must be one of {', '.join(VERDICTS)}")
        for kind in ("audit", "critic"):
            for note in changes.get(kind) or []:
                exp[kind].append({"t": now(), **note})
        for p in changes.get("add_periods") or []:
            if any(q["key"] == p["key"] for q in exp["periods"]):
                raise HTTPException(409, f"Period {p['key']} already exists")
            p["fingerprint"] = fingerprint(exp["spec"], p)
            exp["periods"].append(p)
            exp["status"] = "queued"
        if changes.get("status") in ("cancelled", "queued"):
            exp["status"] = changes["status"]
        if changes.get("rerun"):  # e.g. after an engine fix: archive (never delete) the old results, run again
            exp.setdefault("history", []).append({"archived_at": now(), "reason": changes.get("rerun_reason", ""),
                                                  "verdict": exp.get("verdict"), "results": exp["results"]})
            exp["results"], exp["status"], exp["verdict"] = {}, "queued", "pending"
            for p in exp["periods"]:
                p["fingerprint"] = fingerprint(exp["spec"], p)
            append_log(exp, f"Re-run requested: {changes.get('rerun_reason', '')}")
        save(exp)
    if changes.get("verdict"):
        log_event("decision", f"{eid} → {changes['verdict']}: {changes.get('decision_reason') or ''}".strip(), changes.get("actor", "lead"), eid)
    for kind in ("audit", "critic"):
        for note in changes.get(kind) or []:
            log_event(kind, note.get("finding") or note.get("note") or "", note.get("by", kind), eid)
    return exp


def recover_interrupted() -> int:
    """Experiments left 'running' by a restart go back to the queue (finished periods are kept)."""
    n = 0
    for e in all_experiments():
        if e["status"] == "running":
            e["status"] = "queued"
            e["progress"] = None
            append_log(e, "Interrupted by a server restart; re-queued (finished periods are kept)")
            save(e)
            n += 1
    if n:
        log_event("system", f"Re-queued {n} experiment(s) interrupted by a restart", "system")
    return n
