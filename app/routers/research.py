import json
from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.data.store import get_store
from app.research import ledger, runner

router = APIRouter(prefix="/research", tags=["research"])


class PeriodIn(BaseModel):
    key: str = Field(min_length=1, max_length=40)  # e.g. is, holdout, stress_2x, h2_2025
    label: str = Field(min_length=1, max_length=80)
    role: str = "in_sample"  # in_sample · out_of_sample · holdout · historical · stress
    from_: date = Field(alias="from")
    to: date
    cost_overrides: dict[str, float] | None = None

    def out(self) -> dict:
        return {"key": self.key, "label": self.label, "role": self.role, "from": self.from_.isoformat(),
                "to": self.to.isoformat(), "cost_overrides": self.cost_overrides}


class ExperimentIn(BaseModel):
    name: str
    family: str = "other"
    spec: dict[str, Any]
    periods: list[PeriodIn] = Field(min_length=1, max_length=12)
    hypothesis: str = ""
    mechanism: str = ""
    novelty: str = ""
    failure_modes: str = ""
    criteria: dict[str, Any] | None = None
    source: str = "lead"
    parent_id: str | None = None
    version: int = 1
    stage: str = "A"
    capital: float = 100000
    priority: int = 0
    next_action: str = ""
    allow_duplicate: bool = False


class ExperimentPatch(BaseModel):
    verdict: str | None = None
    decision_reason: str | None = None
    next_action: str | None = None
    stage: str | None = None
    priority: int | None = None
    status: str | None = None  # cancelled / queued
    criteria: dict[str, Any] | None = None
    audit: list[dict[str, Any]] | None = None  # [{by, severity, finding}]
    critic: list[dict[str, Any]] | None = None  # [{by, note}]
    add_periods: list[PeriodIn] | None = None
    rerun: bool | None = None  # archive current results and run every period again
    rerun_reason: str | None = None
    actor: str = "lead"


class StatePatch(BaseModel):
    phase: str | None = None
    phase_detail: str | None = None
    cycle: int | None = None
    agents: list[dict[str, Any]] | None = None  # [{name, role, status, task}]
    summary: str | None = None
    protocol: str | None = None
    extra_looks: int | None = None


class EventIn(BaseModel):
    kind: str = "decision"
    text: str = Field(min_length=1, max_length=2000)
    actor: str = "lead"
    experiment_id: str | None = None


def _headline(e: dict) -> dict:
    """Small per-period summary for lists and the leaderboard."""
    out = {}
    for key, r in (e.get("results") or {}).items():
        if r.get("error"):
            out[key] = {"error": r["error"]}
            continue
        x = r["ext"]
        out[key] = {k: x.get(k) for k in ("trades", "net_pnl", "return_pct", "profit_factor", "sharpe", "t_stat", "max_drawdown_pct",
                                          "win_rate", "costs_total", "peak_capital_required", "fits_capital", "net_ex_top5")}
        out[key]["run_id"] = r.get("run_id")
        out[key]["passed"] = sum(1 for c in r.get("checks", []) if c["pass"])
        out[key]["checks"] = len(r.get("checks", []))
    return out


@router.get("/regimes")
def regimes(underlying: str = "NIFTY", start: date = date(2023, 1, 1), end: date | None = None, model: str = "trend_vol"):
    """Daily regime labels (known at each day's close) from app/strategy/regimes.py, plus counts per regime."""
    from fastapi import HTTPException

    from app.data.instruments import underlying as get_underlying
    from app.strategy.regimes import MODELS, label, regime_series
    from app.strategy.signals import daily_candles
    if model not in MODELS:
        raise HTTPException(422, f"model must be one of {', '.join(MODELS)}")
    end = end or date.today()
    code = get_underlying(underlying).stock_code
    daily = daily_candles(code, start, end)
    vix = daily_candles(code, start, end, symbol="INDVIX")
    codes = regime_series(daily, vix, model)
    rows = [{"d": d.isoformat(), "close": round(float(c), 2), "code": None if v != v else int(v), "label": label(model, v)}
            for d, c, v in zip(daily["date"], daily["close"], codes) if start <= d <= end]
    counts: dict[str, int] = {}
    for r in rows:
        if r["label"]:
            counts[r["label"]] = counts.get(r["label"], 0) + 1
    return {"underlying": underlying, "model": model, "labels": MODELS[model], "counts": counts, "days": rows}


@router.get("/status")
def research_status():
    exps = ledger.all_experiments()
    counts: dict[str, int] = {}
    verdicts: dict[str, int] = {}
    for e in exps:
        counts[e["status"]] = counts.get(e["status"], 0) + 1
        verdicts[e.get("verdict", "pending")] = verdicts.get(e.get("verdict", "pending"), 0) + 1
    current = next((e for e in exps if e["status"] == "running"), None)
    st = get_store()
    return {
        "state": ledger.get_state(),
        "runner": runner.status(),
        "counts": counts,
        "verdicts": verdicts,
        "experiments": len(exps),
        "families": len({e.get("economic_key") for e in exps}),
        "current": {"id": current["id"], "name": current["name"], "progress": current.get("progress")} if current else None,
        "running": [{"id": e["id"], "name": e["name"], "source": e.get("source"), "progress": e.get("progress")} for e in exps if e["status"] == "running"],
        "breeze_calls_today": st.calls_on(),
        "daily_budget": st.settings().get("daily_budget"),
        "events": ledger.events(40),
    }


@router.get("/experiments")
def list_experiments():
    return [{k: e.get(k) for k in ("id", "parent_id", "name", "family", "version", "stage", "status", "verdict", "priority", "source",
                                   "hypothesis", "next_action", "created_at", "updated_at", "progress", "economic_key")}
            | {"periods": [{k: p.get(k) for k in ("key", "label", "role", "from", "to", "cost_overrides")} for p in e["periods"]],
               "results": _headline(e)} for e in ledger.all_experiments()]


@router.get("/experiments/{eid}")
def get_experiment(eid: str):
    e = ledger.get(eid)
    e["similar"] = ledger.similar(e["spec"], exclude=eid)
    e["events"] = ledger.events(100, eid)
    return e


@router.post("/experiments")
def create_experiment(body: ExperimentIn):
    data = body.model_dump(exclude={"allow_duplicate", "periods"})
    data["periods"] = [p.out() for p in body.periods]
    exp = ledger.create(data, allow_duplicate=body.allow_duplicate)
    runner.kick()
    return exp


@router.patch("/experiments/{eid}")
def patch_experiment(eid: str, body: ExperimentPatch):
    changes = body.model_dump(exclude_none=True, exclude={"add_periods"})
    if body.add_periods:
        changes["add_periods"] = [p.out() for p in body.add_periods]
    exp = ledger.update(eid, changes)
    runner.kick()
    return exp


@router.get("/events")
def list_events(limit: int = 200, experiment_id: str | None = None):
    return ledger.events(limit, experiment_id)


@router.post("/events")
def add_event(body: EventIn):
    return ledger.log_event(body.kind, body.text, body.actor, body.experiment_id)


@router.patch("/state")
def patch_state(body: StatePatch):
    return ledger.update_state(body.model_dump(exclude_none=True))


@router.post("/runner/pause")
def pause_runner():
    return runner.pause(True)


@router.post("/runner/resume")
def resume_runner():
    return runner.pause(False)


# ---------- walk-forward regime playbooks (app/research/playbook.py, research/cycle4/playbook_run.py) ----------

PLAYBOOK_DIR = ledger.RESEARCH_DIR / "playbooks"


@router.get("/playbooks")
def list_playbooks():
    """Saved playbook runs, newest first: settings, out-of-sample summary, candidates."""
    out = []
    for f in sorted(PLAYBOOK_DIR.glob("*.json"), reverse=True):
        try:
            d = json.loads(f.read_text())
        except ValueError:
            continue
        out.append({"id": f.stem, "settings": d.get("settings"), "oos": d.get("oos"), "label": d.get("label"),
                    "candidates": d.get("candidates", []), "confirm": (d.get("confirm") or {}).get("oos")})
    return out


@router.get("/playbooks/{pid}")
def get_playbook(pid: str):
    f = PLAYBOOK_DIR / f"{pid}.json"
    if not pid.replace("-", "").isalnum() or not f.exists():
        raise HTTPException(404, "No such playbook")
    d = json.loads(f.read_text())
    d["trades"] = [{k: t.get(k) for k in ("entry_at", "exit_at", "net", "regime", "candidate", "reason", "direction")}
                   for t in d.get("trades", [])]
    return {"id": pid, **d}


# ---------- paper observation of watchlisted strategies (app/research/paper.py; never places orders) ----------

class PaperIn(BaseModel):
    experiment_id: str | None = None
    portfolio_id: str | None = None  # a saved bucket instead
    since: date


@router.get("/paper")
def paper_list():
    from app.research import paper
    return paper.watch_list()


@router.post("/paper")
def paper_add(body: PaperIn):
    from app.research import paper
    if (body.experiment_id is None) == (body.portfolio_id is None):
        raise HTTPException(422, "Give one of experiment_id or portfolio_id")
    return paper.add(body.experiment_id or f"portfolio:{body.portfolio_id}", body.since)


@router.post("/paper/{eid}/refresh")
def paper_refresh(eid: str):
    from app.research import paper
    return paper.refresh(eid)


@router.delete("/paper/{eid}", status_code=204)
def paper_remove(eid: str):
    from app.research import paper
    paper.remove(eid)
