from datetime import date, datetime, time
from typing import Literal

from fastapi import APIRouter, HTTPException

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


def _numbers(obj, prefix: str = "") -> dict[str, float]:
    """Every numeric-looking field in a (nested) Breeze response, by dotted path."""
    out: dict[str, float] = {}
    if isinstance(obj, dict):
        for k, v in obj.items():
            out |= _numbers(v, f"{prefix}{k}.")
    elif isinstance(obj, list):
        for i, v in enumerate(obj):
            out |= _numbers(v, f"{prefix}{i}.")
    else:
        try:
            out[prefix.rstrip(".")] = float(obj)
        except (TypeError, ValueError):
            pass
    return out


@router.get("/margin-check")
def margin_check(underlying: str = "NIFTY", lots: int = 1):
    """Exchange margin for a live ATM short straddle (Breeze margin_calculator, places nothing) vs the backtest
    estimate (settings short_margin_pct × spot × qty). Use implied_pct to calibrate:
    PATCH /data/settings {"short_margin_pct": ...}. Live contracts only: past contracts can't be margined."""
    from app.data.instruments import underlying as get_underlying
    from app.data.store import get_store
    from app.options.expiries import upcoming_expiries
    u = get_underlying(underlying)
    expiry = next((e for e in upcoming_expiries(u.stock_code) if e >= date.today()), None)
    if expiry is None:
        raise HTTPException(502, "No upcoming expiry found in SecurityMaster")
    quote = breeze.call("get_quotes", stock_code=u.stock_code, exchange_code=u.spot_exchange, product_type="cash")
    spot = float(quote[0]["ltp"])
    strike = u.atm(spot)
    qty = lots * u.lot_size(date.today())
    breeze_expiry = datetime.combine(expiry, time(6, 0)).strftime("%Y-%m-%dT06:00:00.000Z")
    legs = []
    for right in ("call", "put"):
        q = breeze.call("get_quotes", stock_code=u.stock_code, exchange_code=u.fno_exchange, product_type="options",
                        expiry_date=breeze_expiry, right=right, strike_price=f"{strike:g}")
        ltp = float(q[0]["ltp"])
        legs.append({"strike_price": f"{strike:g}", "quantity": str(qty), "right": right, "product": "options",
                     "action": "sell", "price": f"{ltp:.2f}", "expiry_date": expiry.strftime("%d-%b-%Y"),
                     "stock_code": u.stock_code, "cover_order_flow": "N", "fresh_order_type": "N",
                     "cover_limit_rate": "0", "cover_sltp_price": "0", "fresh_limit_rate": "0", "open_quantity": "0"})
    resp = breeze.call("margin_calculator", lists=legs, exchange_code=u.fno_exchange)
    nums = _numbers(resp)
    total_keys = [k for k in nums if "margin" in k.lower() and ("total" in k.lower() or "span" in k.lower() or "required" in k.lower())]
    actual = max((nums[k] for k in total_keys), default=None)
    pct = float(get_store().settings().get("short_margin_pct", 13.0))
    estimate = pct / 100 * spot * qty
    return {
        "underlying": u.name, "expiry": expiry.isoformat(), "spot": spot, "strike": strike, "qty": qty,
        "premium_received": round(sum(float(l["price"]) for l in legs) * qty, 2),
        "estimate": round(estimate, 2), "estimate_pct": pct,
        "breeze_margin": actual, "breeze_margin_field": next((k for k in total_keys if nums[k] == actual), None),
        "implied_pct": round(actual / (spot * qty) * 100, 2) if actual else None,
        "breeze_response": resp,
    }
