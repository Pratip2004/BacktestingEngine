"""/portfolios: buckets of strategies backtested together (app/strategy/portfolio.py)."""

from datetime import date
from typing import Any

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app import runs
from app.options import jobs
from app.strategy import portfolio as pf

router = APIRouter(prefix="/portfolios", tags=["portfolios"])


class PortfolioIn(BaseModel):
    portfolio: dict[str, Any]


class RunIn(BaseModel):
    portfolio: dict[str, Any]
    from_date: date
    to_date: date
    portfolio_id: str | None = None


@router.post("/validate")
def validate(body: PortfolioIn):
    """{ok, errors: [{member, message}], warnings, portfolio}: each member's spec is checked with its gate applied."""
    return pf.check(body.portfolio)


@router.post("/run")
def run(body: RunIn):
    """Backtest every member over the period and combine them. Job → /options/jobs/{id}; saved as a `portfolio` run."""
    checked = pf.check(body.portfolio)
    if not checked["ok"]:
        raise HTTPException(422, "; ".join(f"{e['member'] + ': ' if e['member'] else ''}{e['message']}" for e in checked["errors"]))
    if body.to_date < body.from_date:
        raise HTTPException(422, "to_date is before from_date")
    params = {"portfolio": checked["portfolio"], "from_date": body.from_date, "to_date": body.to_date}
    if body.portfolio_id:
        params["portfolio_id"] = body.portfolio_id

    def job(progress, portfolio, from_date, to_date, portfolio_id=None):
        return pf.run_portfolio(portfolio, from_date, to_date, progress)

    summary = lambda r: {"net_pnl": r["metrics"]["net_pnl"], "trades": r["metrics"]["trades"], "win_rate": r["metrics"]["win_rate"],  # noqa: E731
                         "members": len(r["members"])}
    return {"job_id": jobs.start("portfolio", params, runs.saving("portfolio", job, summary=summary))}


@router.get("")
def list_portfolios():
    return pf.list_all()


@router.get("/{pid}")
def get_portfolio(pid: str):
    return pf.get(pid)


@router.post("")
def create_portfolio(body: PortfolioIn):
    return pf.save(body.portfolio)


@router.put("/{pid}")
def update_portfolio(pid: str, body: PortfolioIn):
    return pf.save(body.portfolio, pid)


@router.delete("/{pid}", status_code=204)
def delete_portfolio(pid: str):
    pf.delete(pid)
