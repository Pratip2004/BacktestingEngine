"""ATM straddle buying, one trade per day, for the straddle lab.

Rules (as agreed with the user):
- Entry at one of several `entry_times`, loaded together so the UI can switch between them instantly:
    "HH:MM"      on the trade day (e.g. 09:15–10:00), or
    "D-1 HH:MM"  on the previous trading day near the close (15:15–15:30, or 15:30–15:40 with the
                 closing auction session); held overnight into the trade day.
  At the entry minute buy 1 ATM CE + 1 ATM PE (ATM = NIFTY at that minute rounded to the strike step)
  at each leg's 1-minute open + slippage, in the nearest weekly expiry on or after the **trade day**
  (an expiry-day evening entry can't use the contract expiring that afternoon). If no candle trades at
  the chosen minute on a given day (e.g. no session at 15:35), that day is skipped for that entry.
- Target and square-off are chosen interactively (client/src/lib/straddleSim.ts): the target is a
  multiple of the premium, filled as a limit order; square-off is a time on the trade day. No stop-loss.
- DTE = trading days from the trade day to expiry (0 = expiry day); the UI filters days by it.

So this module returns, per trade day and per entry time, the straddle's minute path from entry to the
trade day's close. Intraminute extremes: a call's high and a put's low happen together (NIFTY at the
minute's high), and vice versa, so the straddle's best value in a minute is
max(CE.high + PE.low, CE.low + PE.high) and its worst min(CE.low + PE.high, CE.high + PE.low).
"""

import logging
import re
from datetime import date, datetime, time, timedelta
from typing import Callable

import pandas as pd
from fastapi import HTTPException

from app.backtest.options_engine import STRIKE_STEP, leg_bars
from app.breeze_client import breeze
from app.data.access import spot_minute_bars
from app.options.expiries import weekly_expiries_between

log = logging.getLogger(__name__)

LEG_INTERVAL = "1minute"
ENTRY_RE = re.compile(r"^(D-1 )?([01]\d|2[0-3]):[0-5]\d$")


def parse_entry(spec: str) -> tuple[bool, time]:
    """'09:30' → (False, 09:30); 'D-1 15:25' → (True, 15:25)."""
    if not ENTRY_RE.match(spec):
        raise HTTPException(422, f"Bad entry time {spec!r}: use 'HH:MM' or 'D-1 HH:MM'")
    prev = spec.startswith("D-1 ")
    return prev, time.fromisoformat(spec[-5:])


def _trading_days_to(d: date, expiry: date, trading_days: list[date]) -> int:
    """Trading days from d to expiry (0 = expiry day). Past the loaded candles, weekdays stand in."""
    known = sum(1 for t in trading_days if d < t <= expiry)
    beyond = trading_days[-1] if trading_days[-1] > d else d
    extra = sum(1 for i in range(1, (expiry - beyond).days + 1) if (beyond + timedelta(days=i)).weekday() < 5)
    return known + extra


def _first_open_at(bars: pd.DataFrame, ts: pd.Timestamp, col: str = "open") -> tuple[pd.Timestamp, float] | None:
    """The first candle at or after ts on ts's own day."""
    i = bars["datetime"].searchsorted(ts, side="left")
    if i < len(bars) and bars["datetime"].iloc[i].date() == ts.date():
        return bars["datetime"].iloc[i], float(bars[col].iloc[i])
    return None


def straddle_days(
    from_date: date,
    to_date: date,
    stock_code: str = "NIFTY",
    side: str = "buy",  # only recorded: the lab opens on this side; buy and sell use the same paths
    entry_times: list[str] = ("09:30",),
    lots: int = 1,
    lot_size: int = 65,
    brokerage_per_order: float = 20.0,
    slippage_points: float = 0.5,
    taxes: bool = True,
    progress: Callable[[int, int, str], None] = lambda d, t, m: None,
) -> dict:
    specs = {s: parse_entry(s) for s in dict.fromkeys(entry_times)}
    step = STRIKE_STEP.get(stock_code, 50)

    # Trading days (with a few before the range, so the first day has a previous day for D-1 entries).
    daily = breeze.historical_df(
        stock_code, "NSE", "1day",
        datetime.combine(from_date - timedelta(days=10), time(0)), datetime.combine(to_date, time(23, 59)),
    )
    if daily.empty:
        raise HTTPException(404, f"No candles for {stock_code} in this range")
    trading_days = sorted(daily["datetime"].dt.date.unique())
    trade_days = [d for d in trading_days if from_date <= d <= to_date]
    prev_of = {d: trading_days[i - 1] for i, d in enumerate(trading_days) if i > 0}
    needs_prev = any(prev for prev, _ in specs.values())
    expiries = weekly_expiries_between(from_date, to_date + timedelta(days=14), trading_days, stock_code)

    days, skipped = [], []
    for n, d in enumerate(trade_days):
        progress(n, len(trade_days), f"{d:%d %b %Y} · {len(days)} days loaded")
        expiry = next((e for e in expiries if e >= d), None)
        prev = prev_of.get(d)
        if expiry is None:
            skipped.append({"date": d.isoformat(), "entry": "all", "reason": "No weekly expiry found"})
            continue
        spot = spot_minute_bars(stock_code, [prev, d] if needs_prev and prev else [d])

        entries = {}
        for key, (is_prev, t) in specs.items():
            entry_day = prev if is_prev else d
            if entry_day is None:
                skipped.append({"date": d.isoformat(), "entry": key, "reason": "No previous trading day loaded"})
                continue
            ts = pd.Timestamp(datetime.combine(entry_day, t))
            at = _first_open_at(spot, ts)
            if at is None:
                skipped.append({"date": d.isoformat(), "entry": key, "reason": f"NIFTY didn't trade at {t:%H:%M} on {entry_day:%d %b}"})
                continue
            atm = round(at[1] / step) * step
            legs_days = [entry_day, d] if is_prev else [d]
            ce = leg_bars(stock_code, expiry, atm, "call", LEG_INTERVAL, legs_days)
            pe = leg_bars(stock_code, expiry, atm, "put", LEG_INTERVAL, legs_days)
            ce_at, pe_at = _first_open_at(ce, ts), _first_open_at(pe, ts)
            if ce_at is None or pe_at is None:
                skipped.append({"date": d.isoformat(), "entry": key, "reason": f"No {atm:g} CE/PE trade at or after {t:%H:%M} on {entry_day:%d %b}"})
                continue

            # Align the legs minute by minute from the entry to the trade day's close; an illiquid
            # minute carries the last traded candle forward.
            start = max(ce_at[0], pe_at[0])
            both = (ce.set_index("datetime").join(pe.set_index("datetime"), how="outer", lsuffix="_ce", rsuffix="_pe")
                    .sort_index().ffill().dropna())
            both = both[(both.index >= start) & (both.index.date <= d)]
            if both.empty or both.index[-1].date() != d:
                skipped.append({"date": d.isoformat(), "entry": key, "reason": f"No {atm:g} CE/PE data on {d:%d %b}"})
                continue
            entries[key] = {
                "spot": round(at[1], 2),
                "atm": atm,
                "ce_entry": round(ce_at[1], 2),
                "pe_entry": round(pe_at[1], 2),
                "entry_at": start.strftime("%Y-%m-%d %H:%M"),
                "path": {
                    "t": [x.strftime("%Y-%m-%d %H:%M") for x in both.index],
                    "ce_open": both["open_ce"].round(2).tolist(),
                    "pe_open": both["open_pe"].round(2).tolist(),
                    "hi": [round(max(r.high_ce + r.low_pe, r.low_ce + r.high_pe), 2) for r in both.itertuples()],
                    "lo": [round(min(r.low_ce + r.high_pe, r.high_ce + r.low_pe), 2) for r in both.itertuples()],
                },
            }
        if entries:
            days.append({"date": d.isoformat(), "expiry": expiry.isoformat(),
                         "dte": _trading_days_to(d, expiry, trading_days), "entries": entries})
    progress(len(trade_days), len(trade_days), f"Done · {len(days)} days")

    return {
        "params": {"stock_code": stock_code, "side": side, "entry_times": list(specs), "lots": lots, "lot_size": lot_size,
                   "brokerage_per_order": brokerage_per_order, "slippage_points": slippage_points, "taxes": taxes,
                   "from_date": from_date.isoformat(), "to_date": to_date.isoformat()},
        "days": days,
        "skipped": skipped,
    }
