"""Market regimes ("cycles") from daily candles, for regime-gated strategies and the playbook.

A regime is known at a day's close and used from the next decision on (operands align by close time). The rules
use textbook thresholds fixed in advance (ADX 20, 50-day average and its 10-day slope, VIX vs its own past year),
not values tuned on the backtest period, so the regime labels themselves can't be overfitted.

Models (operand {"ind": "regime", "params": {"model": ...}, "tf": "1d"}; compare with == / !=):
  trend_vol  6 codes = trend × volatility:
             1 up / calm · 2 up / volatile · 3 range / calm · 4 range / volatile · 5 down / calm · 6 down / volatile
  trend      1 up · 0 range · −1 down
  vol        0 calm · 1 volatile
Trend: up = close > SMA50, SMA50 rising over 10 days, ADX(14) ≥ 20; down = the mirror; otherwise range.
Volatility: volatile = India VIX above its 60th percentile of the previous 252 sessions (no VIX → 20-day realised
volatility vs its own past year, same rule).
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from app.strategy.indicators import true_range, wilder

ADX_TREND = 20.0
SMA_PERIOD = 50
SLOPE_DAYS = 10
VOL_PCTL = 0.60
VOL_LOOKBACK = 252

MODELS = {
    "trend_vol": {1: "Uptrend · calm", 2: "Uptrend · volatile", 3: "Range · calm", 4: "Range · volatile",
                  5: "Downtrend · calm", 6: "Downtrend · volatile"},
    "trend": {1: "Uptrend", 0: "Range", -1: "Downtrend"},
    "vol": {0: "Calm", 1: "Volatile"},
}


def adx(b: pd.DataFrame, period: int = 14) -> pd.Series:
    up, down = b["high"].diff(), -b["low"].diff()
    plus = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=b.index)
    minus = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=b.index)
    atr = wilder(true_range(b), period)
    pdi, mdi = 100 * wilder(plus, period) / atr, 100 * wilder(minus, period) / atr
    dx = (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan) * 100
    return wilder(dx.fillna(0), period)


def _past_pctl(s: pd.Series, lookback: int) -> pd.Series:
    """Share of the previous `lookback` values below today's (0–1); NaN until 60 values exist."""
    arr = s.to_numpy(dtype=float)
    out = np.full(len(arr), np.nan)
    for i in range(len(arr)):
        past = arr[max(0, i - lookback):i]
        past = past[~np.isnan(past)]
        if len(past) >= 60 and not np.isnan(arr[i]):
            out[i] = (past < arr[i]).mean()
    return pd.Series(out, index=s.index)


def trend_state(daily: pd.DataFrame) -> pd.Series:
    sma = daily["close"].rolling(SMA_PERIOD).mean()
    rising, falling = sma > sma.shift(SLOPE_DAYS), sma < sma.shift(SLOPE_DAYS)
    strong = adx(daily) >= ADX_TREND
    up = (daily["close"] > sma) & rising & strong
    down = (daily["close"] < sma) & falling & strong
    out = pd.Series(np.where(up, 1.0, np.where(down, -1.0, 0.0)), index=daily.index)
    return out.where(sma.shift(SLOPE_DAYS).notna())


def vol_state(daily: pd.DataFrame, vix: pd.DataFrame | None) -> pd.Series:
    if vix is not None and len(vix):
        v = pd.Series(vix["close"].to_numpy(dtype=float), index=pd.Index(vix["date"]))
        level = v.reindex(pd.Index(daily["date"])).ffill()
    else:
        level = pd.Series((daily["close"].pct_change().rolling(20).std() * np.sqrt(252)).to_numpy(), index=pd.Index(daily["date"]))
    pct = _past_pctl(level, VOL_LOOKBACK)
    return pd.Series(np.where(pct.isna(), np.nan, (pct >= VOL_PCTL).astype(float)), index=daily.index)


def regime_series(daily: pd.DataFrame, vix: pd.DataFrame | None, model: str = "trend_vol") -> pd.Series:
    """Regime code per daily candle (aligned to `daily`), NaN during warm-up."""
    if model not in MODELS:
        raise ValueError(f"Unknown regime model {model!r}; use one of {', '.join(MODELS)}")
    t, v = trend_state(daily), vol_state(daily, vix)
    if model == "trend":
        return t
    if model == "vol":
        return v
    code = np.where(t == 1, 1.0, np.where(t == 0, 3.0, 5.0)) + v.to_numpy()
    return pd.Series(np.where(t.isna() | v.isna(), np.nan, code), index=daily.index)


def label(model: str, code: float | None) -> str | None:
    if code is None or (isinstance(code, float) and np.isnan(code)):
        return None
    return MODELS[model].get(int(code))
