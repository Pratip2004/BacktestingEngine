from fastapi import APIRouter

from app.breeze_client import breeze

router = APIRouter(prefix="/account", tags=["account (read-only)"])


@router.get("/funds")
def funds():
    return breeze.call("get_funds")


@router.get("/holdings")
def holdings():
    return breeze.call("get_demat_holdings")


@router.get("/positions")
def positions():
    return breeze.call("get_portfolio_positions")
