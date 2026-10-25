from datetime import date
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.options import jobs
from app.options.expiries import upcoming_expiries
from app.options.service import expiry_comparison, live_chain

router = APIRouter(prefix="/options", tags=["options"])


@router.get("/expiries")
def expiries(stock_code: str = "NIFTY"):
    """Upcoming option expiries from ICICI's SecurityMaster (refreshed daily). Works without login."""
    try:
        upcoming = upcoming_expiries(stock_code)
    except Exception as exc:
        raise HTTPException(502, f"Could not load SecurityMaster: {exc}") from exc
    return {"stock_code": stock_code, "upcoming": [d.isoformat() for d in upcoming]}


@router.get("/chain")
def chain(
    expiry: date,
    stock_code: str = "NIFTY",
    strikes: int = Query(5, ge=1, le=25, description="Strikes on each side of ATM"),
    rate: float = Query(6.5, description="Risk-free rate % used for IV"),
):
    """Live chain, ATM ± strikes, with LTP, OI, change in OI, volume and computed IV/delta."""
    return live_chain(stock_code, expiry, strikes, rate / 100)


class ComparisonIn(BaseModel):
    stock_code: str = "NIFTY"
    count: int = Field(10, ge=1, le=26, description="Number of past expiries")
    kind: Literal["weekly", "monthly"] = "weekly"
    strikes: int = Field(5, ge=1, le=10, description="Strikes on each side of ATM")
    days_before_expiry: int = Field(1, ge=0, le=15, description="Snapshot this many trading days before expiry (0 = expiry day; IV is undefined then)")
    rate: float = Field(6.5, description="Risk-free rate % used for IV")


@router.post("/expiry-comparison")
def start_comparison(body: ComparisonIn):
    """Starts a background job (≈ count × (2·strikes+1) × 2 Breeze calls, cached after the first run)."""
    params = {"stock_code": body.stock_code, "count": body.count, "kind": body.kind,
              "strikes_around": body.strikes, "days_before": body.days_before_expiry, "rate": body.rate / 100}
    return {"job_id": jobs.start("expiry-comparison", params, expiry_comparison)}


@router.get("/jobs/{job_id}")
def job(job_id: str):
    return jobs.get(job_id)
