"""EMA-crossover option butterfly: candidate trades for the exit lab.

Entry (fixed): fast EMA crossing above slow EMA on the underlying = bullish, below = bearish. The cross
is confirmed at a bar's close and entered at the next bar's open, same day only, using each leg's
own candle.
  bullish → long call butterfly: buy ATM CE, sell 2× ATM+wing CE, buy ATM+2·wing CE
  bearish → long put butterfly:  buy ATM PE, sell 2× ATM−wing PE, buy ATM−2·wing PE
in the nearest weekly expiry strictly after the entry day.

Exit (chosen interactively in the UI): target / stop-loss as % of the premium paid, checked at every
candle close, or a same-day square-off time. To make that interactive, this module doesn't pick exits.
For every crossover it returns a candidate trade with its net P&L "if closed at this candle's close"
for each candle until the end of the day. The client replays those paths for any target / stop /
square-off / last-entry combination, enforcing one position at a time.

Leg candles come from the local data store (app/data/access.py), which fetches
missing contract-days from Breeze.
"""

import logging
import math
from dataclasses import dataclass
from datetime import date, datetime, time, timedelta
from typing import Callable

import pandas as pd
from fastapi import HTTPException

from app.breeze_client import breeze
from app.data.access import option_minute_bars, resample
from app.options.expiries import weekly_expiries_between

log = logging.getLogger(__name__)

STRIKE_STEP = {"NIFTY": 50, "CNXBAN": 100}
INTERVAL_MINUTES = {"1minute": 1, "5minute": 5, "30minute": 30}
BARS_PER_DAY = {k: math.ceil(375 / m) + 1 for k, m in INTERVAL_MINUTES.items()}
MAX_CANDLES = 1000
MAX_CHART_POINTS = 3000
PRICE_COLS = ["open", "high", "low", "close"]


@dataclass
class Costs:
    brokerage_per_order: float = 20.0
    slippage_points: float = 0.5
    taxes: bool = True  # STT, exchange charges, SEBI fee, stamp duty, GST

    def order_cost(self, price: float, qty: int, is_buy: bool) -> float:
        turnover = price * qty
        brokerage = self.brokerage_per_order
        if not self.taxes:
            return brokerage
        stt = 0 if is_buy else 0.001 * turnover  # 0.1% on option sell premium
        exchange = 0.0003503 * turnover  # NSE options transaction charge
        sebi = 0.000001 * turnover
        stamp = 0.00003 * turnover if is_buy else 0
        gst = 0.18 * (brokerage + exchange + sebi)
        return brokerage + stt + exchange + sebi + stamp + gst


# ---------- Data ----------

def leg_bars(stock: str, expiry: date, strike: float, right: str, interval: str, days: list[date]) -> pd.DataFrame:
    """Candles for one contract over `days` at `interval`, from the local store (1-minute, fetched from
    Breeze only for days not stored yet) and resampled when a coarser interval is asked for."""
    bars = option_minute_bars(stock, expiry, strike, right, days)
    return resample(bars, INTERVAL_MINUTES[interval])


def _open_at(bars: pd.DataFrame, ts: pd.Timestamp) -> float | None:
    """Open of the first leg candle at or after ts on the same day (illiquid strikes may skip bars)."""
    i = bars["datetime"].searchsorted(ts, side="left")
    return float(bars["open"].iloc[i]) if i < len(bars) and bars["datetime"].iloc[i].date() == ts.date() else None


def _close_at(bars: pd.DataFrame, ts: pd.Timestamp) -> float | None:
    """Close of the last leg candle at or before ts."""
    i = bars["datetime"].searchsorted(ts, side="right") - 1
    return float(bars["close"].iloc[i]) if i >= 0 else None


def _thin(rows: list[dict]) -> list[dict]:
    """Keep charts responsive: at most MAX_CHART_POINTS evenly spaced rows (always keeping the last)."""
    if len(rows) <= MAX_CHART_POINTS:
        return rows
    stride = math.ceil(len(rows) / MAX_CHART_POINTS)
    return rows[::stride] + ([rows[-1]] if (len(rows) - 1) % stride else [])


# ---------- Candidates ----------

def butterfly_candidates(
    from_date: date,
    to_date: date,
    stock_code: str = "NIFTY",
    interval: str = "5minute",
    fast: int = 9,
    slow: int = 21,
    wing: int = 200,
    lots: int = 1,
    lot_size: int = 65,
    brokerage_per_order: float = 20.0,
    slippage_points: float = 0.5,
    taxes: bool = True,
    progress: Callable[[int, int, str], None] = lambda d, t, m: None,
) -> dict:
    if interval not in INTERVAL_MINUTES:
        raise HTTPException(422, f"interval must be one of {list(INTERVAL_MINUTES)}")
    costs = Costs(brokerage_per_order, slippage_points, taxes)
    step = STRIKE_STEP.get(stock_code, 50)
    if wing % step:
        raise HTTPException(422, f"wing must be a multiple of the strike step ({step})")

    # Underlying candles, with a warm-up so the EMAs are settled on the first tested bar.
    warmup_days = max(7, math.ceil(slow * INTERVAL_MINUTES[interval] / 375) * 2 + 3)
    spot = breeze.historical_df(
        stock_code, "NSE", interval,
        datetime.combine(from_date - timedelta(days=warmup_days), time(0)),
        datetime.combine(to_date, time(23, 59)),
    )
    if spot.empty:
        raise HTTPException(404, f"No {interval} candles for {stock_code}")
    spot["ema_fast"] = spot["close"].ewm(span=fast, adjust=False).mean()
    spot["ema_slow"] = spot["close"].ewm(span=slow, adjust=False).mean()
    above = spot["ema_fast"] > spot["ema_slow"]
    spot["signal"] = 0
    spot.loc[above & ~above.shift(1, fill_value=above.iloc[0]), "signal"] = 1
    spot.loc[~above & above.shift(1, fill_value=above.iloc[0]), "signal"] = -1
    spot["date"] = spot["datetime"].dt.date
    spot = spot[spot["date"] >= from_date].reset_index(drop=True)
    if spot.empty:
        raise HTTPException(404, "No candles in the selected range")

    trading_days = sorted(spot["date"].unique())
    expiries = weekly_expiries_between(from_date, to_date + timedelta(days=14), trading_days, stock_code)

    # Crossovers whose next bar is on the same day: that bar's open is the entry.
    entries = [i + 1 for i in spot.index[spot["signal"] != 0] if i + 1 < len(spot) and spot.at[i + 1, "date"] == spot.at[i, "date"]]
    day_bars = {d: g.index.tolist() for d, g in spot.groupby("date")}

    candidates, skipped = [], []
    for n, i in enumerate(entries):
        progress(n, len(entries), f"Signal {n + 1}/{len(entries)} · {spot.at[i, 'datetime']:%d %b %H:%M}")
        bar = spot.loc[i]
        ts, d = bar["datetime"], bar["date"]
        direction = int(spot.at[i - 1, "signal"])
        expiry = next((e for e in expiries if e > d), None)
        if expiry is None:
            skipped.append({"time": str(ts), "reason": "No weekly expiry after this date"})
            continue

        atm = round(bar["open"] / step) * step
        right = "call" if direction > 0 else "put"
        sgn = 1 if direction > 0 else -1
        legs = [(atm, lots), (atm + sgn * wing, -2 * lots), (atm + sgn * 2 * wing, lots)]

        frames, entry_px = [], []
        for strike, q in legs:
            bars = leg_bars(stock_code, expiry, strike, right, interval, [d])
            px = _open_at(bars, ts)
            if px is None:
                break
            frames.append(bars)
            entry_px.append(px + costs.slippage_points * (1 if q > 0 else -1))
        if len(entry_px) < 3:
            skipped.append({"time": str(ts), "reason": f"No {right.upper()} price for a leg ({expiry:%d %b})"})
            continue

        net_debit = sum(q * px for (_, q), px in zip(legs, entry_px))  # points × lots, after slippage
        capital = net_debit * lot_size
        if capital <= 0:
            skipped.append({"time": str(ts), "reason": "Butterfly priced at a credit; premium-based % undefined"})
            continue
        entry_cost = sum(costs.order_cost(px, abs(q) * lot_size, q > 0) for (_, q), px in zip(legs, entry_px))

        # Net P&L if closed at each candle close from the entry bar to the day's last bar.
        path = []
        for j in day_bars[d]:
            if j < i:
                continue
            t = spot.at[j, "datetime"]
            closes = [(_close_at(f, t) or e) for f, e in zip(frames, entry_px)]
            exits = [c - costs.slippage_points * (1 if q > 0 else -1) for (_, q), c in zip(legs, closes)]
            gross = sum(q * lot_size * (x - e) for (_, q), x, e in zip(legs, exits, entry_px))
            exit_cost = sum(costs.order_cost(x, abs(q) * lot_size, q < 0) for (_, q), x in zip(legs, exits))
            path.append({"t": str(t), "pnl": round(gross - entry_cost - exit_cost, 2), "px": [round(c, 2) for c in closes]})

        candidates.append({
            "entry_time": str(ts),
            "direction": "bullish" if direction > 0 else "bearish",
            "expiry": expiry.isoformat(),
            "spot_entry": round(float(bar["open"]), 2),
            "atm": atm,
            "legs": [{"strike": s, "right": right, "lots": q, "entry": round(px, 2)} for (s, q), px in zip(legs, entry_px)],
            "net_debit": round(net_debit / lots, 2),  # per butterfly, in points
            "capital": round(capital, 2),
            "entry_cost": round(entry_cost, 2),
            "path": path,
        })
    progress(len(entries), len(entries), f"Done · {len(candidates)} candidate trades")

    return {
        "params": {"stock_code": stock_code, "interval": interval, "fast": fast, "slow": slow, "wing": wing,
                   "lots": lots, "lot_size": lot_size, "brokerage_per_order": brokerage_per_order,
                   "slippage_points": slippage_points, "taxes": taxes,
                   "from_date": from_date.isoformat(), "to_date": to_date.isoformat()},
        "candidates": candidates,
        "skipped": skipped,
        "price": _thin([{"datetime": str(r.datetime), "close": round(r.close, 2), "ema_fast": round(r.ema_fast, 2),
                         "ema_slow": round(r.ema_slow, 2)} for r in spot.itertuples(index=False)]),
    }
