from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, ValidationError

from app import runs
from app.data.instruments import UNDERLYINGS
from app.data.store import get_store
from app.options import jobs
from app.strategy import library
from app.strategy.analysis import replay, sweep
from app.strategy.engine import run_strategy
from app.strategy.spec import StrategySpec, validate_spec
from app.strategy.templates import templates

router = APIRouter(prefix="/strategies", tags=["strategy builder"])


def _check(spec: dict) -> dict:
    """Structural (Pydantic) + semantic validation → {ok, errors: [{path, message}], warnings, spec}."""
    try:
        s = StrategySpec.model_validate(spec)
    except ValidationError as exc:
        return {"ok": False, "warnings": [], "spec": None, "errors": [
            {"path": ".".join(str(p) for p in e["loc"]), "message": e["msg"].removeprefix("Value error, ")} for e in exc.errors()]}
    errors, warnings = validate_spec(s)
    return {"ok": not errors, "errors": [{"path": "", "message": m} for m in errors], "warnings": warnings,
            "spec": s.model_dump(mode="json")}


class SpecIn(BaseModel):
    spec: dict[str, Any]
    template: str | None = None


class RunIn(BaseModel):
    spec: dict[str, Any]
    from_date: date
    to_date: date
    strategy_id: str | None = None


@router.get("/templates")
def list_templates():
    return templates()


@router.get("/indicators")
def list_indicators():
    """Extended indicator catalogue (built-ins are documented in app/strategy/spec.py BUILTIN_INDICATORS)."""
    from app.strategy.indicators import catalogue
    from app.strategy.spec import BUILTIN_INDICATORS
    return {"builtin": list(BUILTIN_INDICATORS), "extended": catalogue()}


@router.post("/validate")
def validate(body: SpecIn):
    return _check(body.spec)


@router.get("/data-check")
def data_check(underlying: str, from_date: date, to_date: date):
    """How much of a period is already in the local store (the rest is fetched from Breeze while running)."""
    if underlying not in UNDERLYINGS:
        raise HTTPException(422, f"Unknown underlying {underlying}")
    st = get_store()
    spot_days, opt_days = st.q(
        """SELECT COUNT(DISTINCT CASE WHEN kind = 'spot' THEN day END), COUNT(DISTINCT CASE WHEN kind = 'opt' THEN day END)
           FROM fetch_log WHERE underlying = ? AND day BETWEEN ? AND ? AND status IN ('ok','empty')""",
        [underlying, from_date, to_date])[0]
    weekdays = len(st.weekdays(from_date, min(to_date, date.today())))
    return {"underlying": underlying, "weekdays": weekdays, "spot_days": int(spot_days), "option_days": int(opt_days)}


@router.post("/run")
def run(body: RunIn):
    """Backtest a spec over a period. Runs as a job (poll /options/jobs/{job_id}); the result is saved as a run."""
    checked = _check(body.spec)
    if not checked["ok"]:
        raise HTTPException(422, "; ".join(e["message"] if not e["path"] else f"{e['path']}: {e['message']}" for e in checked["errors"]))
    if body.to_date < body.from_date:
        raise HTTPException(422, "to_date is before from_date")
    params = {"spec": checked["spec"], "from_date": body.from_date, "to_date": body.to_date}
    if body.strategy_id:
        params["strategy_id"] = body.strategy_id

    def job(progress, spec, from_date, to_date, strategy_id=None):
        return run_strategy(spec, from_date, to_date, progress)

    summary = lambda r: {"net_pnl": r["metrics"]["net_pnl"], "trades": r["metrics"]["trades"], "win_rate": r["metrics"]["win_rate"]}  # noqa: E731
    return {"job_id": jobs.start("strategy", params, runs.saving("custom", job, summary=summary))}


class SweepParam(BaseModel):
    path: str = Field(min_length=1, max_length=200)  # dotted path into the spec, e.g. exits.combined.target.value
    label: str = Field(min_length=1, max_length=60)
    values: list[Any] = Field(min_length=1, max_length=12)


class SweepIn(BaseModel):
    spec: dict[str, Any]
    from_date: date
    to_date: date
    params: list[SweepParam] = Field(min_length=1, max_length=2)
    walk_forward: bool = False
    in_sample_pct: int = Field(70, ge=30, le=90)


@router.post("/sweep")
def start_sweep(body: SweepIn):
    """Run the spec for every combination of 1–2 parameters (optionally walk-forward). Job → /options/jobs/{id}."""
    checked = _check(body.spec)
    if not checked["ok"]:
        raise HTTPException(422, "; ".join(e["message"] for e in checked["errors"]))
    if body.walk_forward and (body.to_date - body.from_date).days < 20:
        raise HTTPException(422, "Walk-forward needs a period of at least 3 weeks")
    params = {"spec": checked["spec"], "from_date": body.from_date, "to_date": body.to_date,
              "params": [p.model_dump() for p in body.params], "walk_forward": body.walk_forward, "in_sample_pct": body.in_sample_pct}
    return {"job_id": jobs.start("sweep", params, sweep)}


@router.get("/replay/{run_id}/{index}")
def trade_replay(run_id: str, index: int, member: str | None = None):
    """Minute-by-minute underlying, legs and position P&L for one trade of a builder run (or a portfolio member's)."""
    return replay(run_id, index, member)


@router.get("")
def list_strategies():
    return library.list_all()


@router.get("/{sid}")
def get_strategy(sid: str):
    return library.get(sid)


@router.post("")
def create_strategy(body: SpecIn):
    checked = _check(body.spec)
    if checked["spec"] is None:
        raise HTTPException(422, "; ".join(f"{e['path']}: {e['message']}" for e in checked["errors"]))
    return library.create(checked["spec"], body.template)


@router.put("/{sid}")
def update_strategy(sid: str, body: SpecIn):
    checked = _check(body.spec)
    if checked["spec"] is None:
        raise HTTPException(422, "; ".join(f"{e['path']}: {e['message']}" for e in checked["errors"]))
    return library.update(sid, checked["spec"])


@router.delete("/{sid}", status_code=204)
def delete_strategy(sid: str):
    library.delete(sid)
