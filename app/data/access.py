"""Read 1-minute candles through the local store, fetching only what's missing from Breeze.

Every backtest goes through here. A contract-day that was fetched before (ok or empty) is read
from DuckDB; anything else is downloaded (up to 2 trading days per call, ~1000 candles), written
to the store and logged. Today's candles are stored but not logged as done, because the day
isn't over and they'll be re-fetched.
"""

from datetime import date, datetime, time

import pandas as pd

from app.breeze_client import breeze, to_breeze_date
from app.data.instruments import underlying
from app.data.store import DONE, NO_EXPIRY, get_store

DAYS_PER_CALL = 2  # 1-minute candles: ~375 a day, Breeze returns up to 1000 per call
PRICE_COLS = ["open", "high", "low", "close"]


def _next_weekday(d: date) -> date:
    d = date.fromordinal(d.toordinal() + 1)
    while d.weekday() >= 5:
        d = date.fromordinal(d.toordinal() + 1)
    return d


def chunk_days(days: list[date]) -> list[list[date]]:
    """Group sorted days into calls of ≤ DAYS_PER_CALL **consecutive weekdays**. A call spans every
    day between its first and last, so [Mon, Thu] would pull four days of candles and overflow the
    1000-candle limit; such days go in separate calls."""
    chunks: list[list[date]] = []
    for d in days:
        if chunks and len(chunks[-1]) < DAYS_PER_CALL and _next_weekday(chunks[-1][-1]) == d:
            chunks[-1].append(d)
        else:
            chunks.append([d])
    return chunks


def fetch_range(kind: str, stock_or_name: str, day_from: date, day_to: date,
                expiry: date | None = None, strike: float | None = None, right: str | None = None) -> list[dict]:
    """One Breeze call for 1-minute candles of a spot index, future or option over [day_from, day_to]."""
    u = underlying(stock_or_name)
    args = dict(
        interval="1minute",
        from_date=to_breeze_date(datetime.combine(day_from, time(9, 0))),
        to_date=to_breeze_date(datetime.combine(day_to, time(15, 59))),
        stock_code=u.stock_code,
    )
    if kind == "spot":
        args |= dict(exchange_code=u.spot_exchange, product_type="cash")
    elif kind == "fut":
        args |= dict(exchange_code=u.fno_exchange, product_type="futures", right="others", strike_price="0",
                     expiry_date=to_breeze_date(datetime.combine(expiry, time(7, 0))))
    else:
        args |= dict(exchange_code=u.fno_exchange, product_type="options", right=right, strike_price=f"{strike:g}",
                     expiry_date=to_breeze_date(datetime.combine(expiry, time(7, 0))))
    return breeze.call("get_historical_data_v2", **args) or []


def store_range(kind: str, name: str, days: list[date], rows: list[dict],
                expiry: date | None = None, strike: float | None = None, right: str | None = None) -> int:
    """Write fetched rows and log each requested past day as ok (had candles) or empty."""
    st = get_store()
    if kind == "spot":
        n = st.put_spot(name, rows)
    elif kind == "fut":
        n = st.put_future(name, expiry, rows)
    else:
        n = st.put_option(name, expiry, strike, right, rows)
    per_day: dict[date, int] = {}
    for r in rows:
        d = pd.to_datetime(r["datetime"]).date()
        per_day[d] = per_day.get(d, 0) + 1
    today = date.today()
    key = {} if kind == "spot" else {"expiry": expiry}
    if kind == "opt":
        key |= {"strike": strike, "right": right}
    for d in days:
        if d < today:
            st.log_fetch(kind, name, d, "ok" if per_day.get(d) else "empty", per_day.get(d, 0), **key)
    return n


def _ensure(kind: str, name: str, days: list[date], **key) -> None:
    st = get_store()
    log_key = {} if kind == "spot" else {"expiry": key["expiry"]}
    if kind == "opt":
        log_key |= {"strike": key["strike"], "right": key["right"]}
    done = st.done_days(kind, name, days, **log_key)
    for chunk in chunk_days(sorted(d for d in days if d not in done)):
        rows = fetch_range(kind, name, chunk[0], chunk[-1], **key)
        store_range(kind, name, chunk, rows, **key)


def option_minute_bars(stock_or_name: str, expiry: date, strike: float, right: str, days: list[date]) -> pd.DataFrame:
    u = underlying(stock_or_name)
    days = sorted(set(days))
    _ensure("opt", u.name, days, expiry=expiry, strike=float(strike), right=right)
    df = get_store().option_bars(u.name, expiry, strike, right, days)
    return df[["datetime", *PRICE_COLS]].reset_index(drop=True)


def spot_minute_bars(stock_or_name: str, days: list[date]) -> pd.DataFrame:
    u = underlying(stock_or_name)
    days = sorted(set(days))
    _ensure("spot", u.name, days)
    df = get_store().spot_bars(u.name, days)
    return df[["datetime", *PRICE_COLS]].reset_index(drop=True)


def future_minute_bars(stock_or_name: str, expiry: date, days: list[date]) -> pd.DataFrame:
    u = underlying(stock_or_name)
    days = sorted(set(days))
    _ensure("fut", u.name, days, expiry=expiry)
    df = get_store().df(
        """SELECT ts AS datetime, open, high, low, close FROM fut_1m
           WHERE underlying = ? AND expiry = ? AND CAST(ts AS DATE) IN (SELECT UNNEST(?)) ORDER BY ts""",
        [u.name, expiry, days],
    )
    return df[["datetime", *PRICE_COLS]].reset_index(drop=True)


def resample(df: pd.DataFrame, minutes: int) -> pd.DataFrame:
    """1-minute candles → N-minute candles labelled by their start (09:15, 09:20, …), like Breeze's."""
    if minutes == 1 or df.empty:
        return df
    g = df.set_index("datetime").groupby(lambda ts: ts.floor(f"{minutes}min"))
    out = g.agg({"open": "first", "high": "max", "low": "min", "close": "last"})
    out.index.name = "datetime"
    return out.reset_index()


__all__ = ["option_minute_bars", "spot_minute_bars", "future_minute_bars", "resample", "fetch_range", "store_range", "DONE", "NO_EXPIRY"]
