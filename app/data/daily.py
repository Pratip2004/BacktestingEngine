"""Daily candles (index spot, India VIX) through the local store, for indicators on 1d / 1w timeframes.

One Breeze call covers ~1000 trading days, so long warm-ups (200-day averages, 1-year percentiles) are cheap.
daily_fetched remembers the covered range per symbol; only the missing ends are fetched. Today's candle is
never stored (the day isn't over).
"""

from datetime import date, datetime, time, timedelta

import pandas as pd

from app.breeze_client import breeze
from app.data.store import OFFLINE, get_store

# Symbols a 1d/1w operand may use (params.symbol): ICICI code → exchange
DAILY_SYMBOLS = {"NIFTY": "NSE", "BSESEN": "BSE", "INDVIX": "NSE"}
ALIASES = {"SENSEX": "BSESEN", "VIX": "INDVIX", "INDIAVIX": "INDVIX"}
EARLIEST = date(2010, 1, 1)


def symbol_code(name: str) -> str:
    code = ALIASES.get(name.upper(), name.upper())
    if code not in DAILY_SYMBOLS:
        raise ValueError(f"Daily data isn't available for {name!r}; use one of {', '.join(DAILY_SYMBOLS)} (or VIX)")
    return code


def _fetch(code: str, a: date, b: date) -> None:
    df = breeze.historical_df(code, DAILY_SYMBOLS[code], "1day", datetime.combine(a, time(0)), datetime.combine(b, time(23, 59)))
    if df.empty:
        return
    st = get_store()
    rows = df.assign(d=df["datetime"].dt.date)
    rows = rows[rows["d"] < date.today()]
    for col in ("open", "high", "low", "close", "volume"):
        rows[col] = pd.to_numeric(rows.get(col, 0), errors="coerce").fillna(0.0)
    with st._lock:
        st._con.register("tmp_daily", rows[["d", "open", "high", "low", "close", "volume"]])
        st._con.execute("INSERT OR REPLACE INTO daily_1d SELECT ?, d, open, high, low, close, volume FROM tmp_daily", [code])
        st._con.unregister("tmp_daily")


def daily_bars(name: str, start: date, end: date) -> pd.DataFrame:
    """Daily candles (d, open, high, low, close, volume) for start..end, fetching what isn't stored."""
    code = symbol_code(name)
    st = get_store()
    start, end = max(start, EARLIEST), min(end, date.today() - timedelta(days=1))
    have = st.q("SELECT d_from, d_to FROM daily_fetched WHERE symbol = ?", [code])
    lo, hi = have[0] if have else (None, None)
    if OFFLINE and lo is not None:  # use what's stored
        start, end = max(start, lo), min(end, hi)
    elif lo is None or start < lo or end > hi:
        new_lo, new_hi = min(start, lo or start), max(end, hi or end)
        if lo is None:
            _fetch(code, new_lo, new_hi)
        else:
            if new_lo < lo:
                _fetch(code, new_lo, lo)
            if new_hi > hi:
                _fetch(code, hi, new_hi)
        st.q("INSERT OR REPLACE INTO daily_fetched VALUES (?, ?, ?)", [code, new_lo, new_hi])
    return st.df("SELECT d, open, high, low, close, volume FROM daily_1d WHERE symbol = ? AND d BETWEEN ? AND ? ORDER BY d",
                 [code, start, end])
