import inspect
from dataclasses import asdict
from datetime import date, datetime, time
from typing import Any, Literal

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field, field_validator

from app.backtest.engine import run_backtest
from app.backtest.options_engine import butterfly_candidates
from app.backtest.straddle_engine import parse_entry, straddle_days
from app import runs
from app.options import jobs
from app.backtest.strategies import STRATEGIES
from app.breeze_client import breeze
from app.routers.market import Exchange, Interval, ProductType, Right

router = APIRouter(prefix="/backtest", tags=["backtest"])


class BacktestIn(BaseModel):
    stock_code: str = Field(..., examples=["RELIND"])
    exchange_code: Exchange = "NSE"
    interval: Interval = "1day"
    from_date: datetime
    to_date: datetime
    product_type: ProductType = "cash"
    expiry_date: datetime | None = None
    right: Right = ""
    strike_price: str = ""
    strategy: str = "sma_crossover"
    params: dict[str, Any] = Field(default_factory=dict, examples=[{"fast": 20, "slow": 50}])
    initial_capital: float = 100_000.0
    commission_pct: float = 0.03
    include_equity_curve: bool = False


class ButterflyIn(BaseModel):
    from_date: date
    to_date: date
    stock_code: str = "NIFTY"
    interval: Literal["1minute", "5minute", "30minute"] = "5minute"
    fast: int = Field(9, ge=2, le=200)
    slow: int = Field(21, ge=3, le=400)
    wing: int = Field(200, ge=50, le=2000, description="Points between strikes: ATM, ATM±wing, ATM±2·wing")
    lots: int = Field(1, ge=1, le=50, description="Lots per wing; the body is 2× this")
    lot_size: int = Field(65, ge=1)
    brokerage_per_order: float = 20.0
    slippage_points: float = 0.5
    taxes: bool = True


@router.post("/options-butterfly")
def options_butterfly(body: ButterflyIn):
    """Candidate trades (with per-candle P&L paths) for every EMA crossover, for the exit lab.
    Runs as a job: poll /options/jobs/{job_id}. Exits are applied client-side."""
    if body.fast >= body.slow:
        raise HTTPException(422, "fast EMA must be shorter than slow EMA")
    if body.to_date < body.from_date:
        raise HTTPException(422, "to_date is before from_date")
    return {"job_id": jobs.start("options-butterfly", body.model_dump(), runs.saving("butterfly", butterfly_candidates))}


class StraddleIn(BaseModel):
    from_date: date
    to_date: date
    stock_code: str = "NIFTY"
    side: Literal["buy", "sell"] = Field("buy", description="Side the lab opens on (switchable there; the data is the same)")
    entry_times: list[str] = Field(
        ["D-1 15:25", "09:20", "09:30"], min_length=1, max_length=12,
        description="Entry times to load: 'HH:MM' on the trade day (09:15–14:59) or 'D-1 HH:MM' the previous day (15:00–15:59)",
    )

    @field_validator("entry_times")
    @classmethod
    def _check_entries(cls, v: list[str]) -> list[str]:
        for spec in v:
            try:
                prev, t = parse_entry(spec)
            except HTTPException as exc:
                raise ValueError(exc.detail) from None
            if prev and not time(15, 0) <= t <= time(15, 59):
                raise ValueError(f"{spec}: previous-day entries must be between 15:00 and 15:59")
            if not prev and not time(9, 15) <= t <= time(14, 59):
                raise ValueError(f"{spec}: same-day entries must be between 09:15 and 14:59")
        return v
    lots: int = Field(1, ge=1, le=50)
    lot_size: int = Field(65, ge=1)
    brokerage_per_order: float = 20.0
    slippage_points: float = 0.5
    taxes: bool = True


@router.post("/straddle")
def straddle(body: StraddleIn):
    """Per-day ATM straddle paths (1-minute) for the straddle lab. Runs as a job: poll /options/jobs/{job_id}.
    Target and square-off are applied client-side."""
    if body.to_date < body.from_date:
        raise HTTPException(422, "to_date is before from_date")
    return {"job_id": jobs.start("straddle", body.model_dump(), runs.saving("straddle", straddle_days))}


@router.get("/strategies")
def strategies():
    """Available strategies and their parameters with defaults."""
    return {
        name: {
            "description": inspect.getdoc(fn),
            "params": {p.name: p.default for p in list(inspect.signature(fn).parameters.values())[1:]},
        }
        for name, fn in STRATEGIES.items()
    }


@router.post("")
def backtest(body: BacktestIn):
    strategy = STRATEGIES.get(body.strategy)
    if strategy is None:
        raise HTTPException(422, f"Unknown strategy. Choose from {list(STRATEGIES)}")

    df = breeze.historical_df(
        body.stock_code, body.exchange_code, body.interval, body.from_date, body.to_date,
        body.product_type, body.expiry_date, body.right, body.strike_price,
    )
    if df.empty:
        raise HTTPException(404, "No historical data returned for that range")

    try:
        signal = strategy(df, **body.params)
    except TypeError as exc:
        raise HTTPException(422, f"Bad strategy params: {exc}") from exc

    result = run_backtest(df, signal, body.initial_capital, body.commission_pct)
    out = {"metrics": result.metrics, "trades": [asdict(t) for t in result.trades]}
    if body.include_equity_curve:
        out["equity_curve"] = result.equity_curve
    m = result.metrics
    out["run_id"] = runs.save("stock", body.model_dump(), out, summary={
        "net_pnl": round(m.get("final_equity", 0) - m.get("initial_capital", 0), 2) if m.get("bars") else None,
        "return_pct": m.get("total_return_pct"), "trades": m.get("trades"), "win_rate": m.get("win_rate_pct"),
    })
    return out
