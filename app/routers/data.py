from datetime import date, timedelta
from typing import Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.breeze_client import breeze
from app.data.ingest import plan_backfill, worker
from app.data.instruments import UNDERLYINGS
from app.data.store import get_store

router = APIRouter(prefix="/data", tags=["data store"])

Underlying = Literal["NIFTY", "SENSEX"]


@router.get("/status")
def status():
    """Store size and coverage summary, downloader state and queue, settings."""
    st = get_store()
    return {"store": st.stats(), "worker": worker.status(), "settings": st.settings(),
            "underlyings": {k: {"strike_step": u.strike_step, "fno_exchange": u.fno_exchange} for k, u in UNDERLYINGS.items()}}


@router.get("/coverage")
def coverage(underlying: Underlying, start: date | None = None, end: date | None = None):
    """Per day: spot / futures status and option contract-days ok, empty, failed, pending."""
    end = end or date.today()
    start = start or end - timedelta(days=370)
    return {"underlying": underlying, "start": start.isoformat(), "end": end.isoformat(),
            "days": get_store().coverage(underlying, start, end)}


@router.get("/day")
def day_detail(underlying: Underlying, day: date):
    """Every contract logged or queued for one day."""
    st = get_store()
    logged = st.df(
        """SELECT kind, expiry, strike, opt_right, status, n_rows, error FROM fetch_log
           WHERE underlying = ? AND day = ? ORDER BY kind, expiry, strike, opt_right""", [underlying, day])
    pending = st.q(
        """SELECT COUNT(*) FROM ingest_queue WHERE underlying = ? AND status IN ('pending','running') AND ? BETWEEN day_from AND day_to""",
        [underlying, day])[0][0]
    rows = [
        {"kind": r.kind, "expiry": None if r.kind == "spot" else str(r.expiry)[:10],
         "strike": None if r.kind != "opt" else float(r.strike), "right": None if r.kind != "opt" else r.opt_right,
         "status": r.status, "rows": int(r.n_rows), "error": r.error}
        for r in logged.itertuples()
    ]
    return {"underlying": underlying, "day": day.isoformat(), "contracts": rows, "pending": int(pending)}


class BackfillIn(BaseModel):
    underlyings: list[Underlying] = Field(min_length=1)
    start: date
    end: date
    band: int | None = Field(None, ge=1, le=100, description="Strikes each side of the opening ATM")
    expiries_ahead: int | None = Field(None, ge=1, le=4)
    include_monthly: bool | None = None
    include_futures: bool = True
    dry_run: bool = True


@router.post("/backfill")
def backfill(body: BackfillIn):
    """Plan (dry_run) or queue a download. Needs a Breeze session (daily candles locate the strikes)."""
    if body.end < body.start:
        raise HTTPException(422, "end is before start")
    if not breeze.is_connected:
        raise HTTPException(401, "Log in to Breeze first: planning needs each day's open to choose strikes")
    return plan_backfill(body.underlyings, body.start, body.end, body.band, body.expiries_ahead,
                         body.include_monthly, body.include_futures, dry_run=body.dry_run)


class SettingsIn(BaseModel):
    daily_budget: int | None = Field(None, ge=0, le=5000)
    underlyings: list[Underlying] | None = None
    strike_band: int | None = Field(None, ge=1, le=100)
    expiries_ahead: int | None = Field(None, ge=1, le=4)
    include_monthly: bool | None = None
    nightly_enabled: bool | None = None
    nightly_time: str | None = Field(None, pattern=r"^([01]\d|2[0-3]):[0-5]\d$")


@router.patch("/settings")
def update_settings(body: SettingsIn):
    settings = get_store().update_settings(body.model_dump(exclude_none=True))
    worker.wake()
    return settings


@router.post("/worker/{action}")
def worker_action(action: Literal["pause", "resume"]):
    get_store().update_settings({"worker_paused": action == "pause"})
    worker.wake()
    return worker.status()


@router.post("/queue/retry-failed")
def retry_failed():
    st = get_store()
    n = st.q("SELECT COUNT(*) FROM ingest_queue WHERE status = 'failed'")[0][0]
    st.q("UPDATE ingest_queue SET status = 'pending', attempts = 0, error = NULL WHERE status = 'failed'")
    worker.wake()
    return {"requeued": int(n)}


@router.delete("/queue")
def clear_queue(job_id: str | None = None):
    """Cancel pending downloads (of one job, or all). Finished data stays."""
    st = get_store()
    where, params = ("status = 'pending'" + (" AND job_id = ?" if job_id else "")), ([job_id] if job_id else [])
    n = st.q(f"SELECT COUNT(*) FROM ingest_queue WHERE {where}", params)[0][0]
    st.q(f"DELETE FROM ingest_queue WHERE {where}", params)
    return {"cancelled": int(n)}
