from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app import runs

router = APIRouter(prefix="/runs", tags=["saved backtests"])


class RunUpdate(BaseModel):
    name: str | None = Field(None, min_length=1, max_length=200)
    view: dict[str, Any] | None = None  # the strategy page's interactive settings (e.g. target / stop)
    summary: dict[str, Any] | None = None  # headline metrics under those settings, for the list


@router.get("")
def list_runs():
    """Saved backtests, newest first (metadata only)."""
    return runs.list_runs()


@router.get("/{run_id}")
def get_run(run_id: str):
    """One saved backtest, including the full result for the strategy page to render."""
    return runs.get(run_id)


@router.patch("/{run_id}")
def update_run(run_id: str, body: RunUpdate):
    return runs.update(run_id, body.model_dump())


@router.delete("/{run_id}", status_code=204)
def delete_run(run_id: str):
    runs.delete(run_id)
