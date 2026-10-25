from datetime import datetime
from typing import Literal

from fastapi import APIRouter

from app.breeze_client import breeze, to_breeze_date

router = APIRouter(prefix="/market", tags=["market data"])

Exchange = Literal["NSE", "BSE", "NFO", "BFO", "MCX", "NDX"]
Interval = Literal["1second", "1minute", "5minute", "30minute", "1day"]
ProductType = Literal["cash", "futures", "options"]
Right = Literal["call", "put", "others", ""]


@router.get("/historical")
def historical(
    stock_code: str,
    from_date: datetime,
    to_date: datetime,
    exchange_code: Exchange = "NSE",
    interval: Interval = "1day",
    product_type: ProductType = "cash",
    expiry_date: datetime | None = None,
    right: Right = "",
    strike_price: str = "",
):
    """OHLCV candles from get_historical_data_v2. Use the ICICI stock code (e.g. RELIND, not RELIANCE). See /market/names."""
    df = breeze.historical_df(
        stock_code, exchange_code, interval, from_date, to_date, product_type, expiry_date, right, strike_price
    )
    df["datetime"] = df["datetime"].astype(str)
    return {"count": len(df), "candles": df.to_dict(orient="records")}


@router.get("/quotes")
def quotes(
    stock_code: str,
    exchange_code: Exchange = "NSE",
    product_type: ProductType = "cash",
    expiry_date: datetime | None = None,
    right: Right = "",
    strike_price: str = "",
):
    return breeze.call(
        "get_quotes",
        stock_code=stock_code,
        exchange_code=exchange_code,
        product_type=product_type,
        expiry_date=to_breeze_date(expiry_date) if expiry_date else "",
        right=right,
        strike_price=strike_price,
    )


@router.get("/option-chain")
def option_chain(
    stock_code: str,
    expiry_date: datetime,
    exchange_code: Literal["NFO", "BFO"] = "NFO",
    product_type: Literal["futures", "options"] = "options",
    right: Right = "",
    strike_price: str = "",
):
    """Breeze needs at least one of right / strike_price for options."""
    return breeze.call(
        "get_option_chain_quotes",
        stock_code=stock_code,
        exchange_code=exchange_code,
        product_type=product_type,
        expiry_date=to_breeze_date(expiry_date),
        right=right,
        strike_price=strike_price,
    )


@router.get("/names")
def names(stock_code: str, exchange_code: Exchange = "NSE"):
    """Map an exchange symbol (e.g. RELIANCE) to the ICICI stock code (e.g. RELIND). Needs an active session."""
    return breeze.client.get_names(exchange_code=exchange_code, stock_code=stock_code)
