"""Indicators and condition evaluation for StrategySpec entries and exits.

All indicators are computed on underlying candles of their own timeframe, built from 1-minute candles
anchored at the 09:15 open (so 10m candles are 09:15, 09:25, …; 60m are 09:15, 10:15, …). A value is
known only once its candle has **closed**: every series here is indexed by candle close time, and a
condition on several timeframes uses each one's latest closed value (no lookahead).
"""

from __future__ import annotations

import math
from dataclasses import dataclass
from datetime import date

import numpy as np
import pandas as pd

from app.strategy.indicators import REGISTRY
from app.strategy.spec import DAILY_TFS, TF_MINUTES, Condition, Group, Operand, Rule

SESSION_OPEN_MIN = 9 * 60 + 15
SESSION_CLOSE_MIN = 15 * 60 + 30


# ---------- candles ----------

def resample(m1: pd.DataFrame, tf: str) -> pd.DataFrame:
    """1-minute candles (datetime, open, high, low, close[, volume]) → `tf` candles, one session at a time,
    indexed by candle start; adds `close_time` and `date`."""
    minutes = TF_MINUTES[tf]
    # Only the continuous session (09:15–15:29 candles): the store also holds pre-open (09:08–09:14) and
    # post-close (15:30–15:39) prints, which would leak into the first candle / form a synthetic last one.
    mod = m1["datetime"].dt.hour * 60 + m1["datetime"].dt.minute
    df = m1[(mod >= SESSION_OPEN_MIN) & (mod < SESSION_CLOSE_MIN)].copy()
    if "volume" not in df:
        df["volume"] = 0.0
    ts = df["datetime"]
    since_open = (ts.dt.hour * 60 + ts.dt.minute - SESSION_OPEN_MIN).clip(lower=0)
    bucket = ts.dt.normalize() + pd.to_timedelta(SESSION_OPEN_MIN + since_open // minutes * minutes, unit="min")
    out = df.groupby(bucket).agg(open=("open", "first"), high=("high", "max"), low=("low", "min"),
                                 close=("close", "last"), volume=("volume", "sum"))
    out.index.name = "start"
    out["close_time"] = out.index + pd.Timedelta(minutes=minutes)
    out["date"] = out.index.date
    return out


# ---------- indicators ----------

def _wilder(s: pd.Series, period: int) -> pd.Series:
    return s.ewm(alpha=1 / period, adjust=False).mean()


def _true_range(b: pd.DataFrame) -> pd.Series:
    prev = b["close"].shift(1)
    return pd.concat([b["high"] - b["low"], (b["high"] - prev).abs(), (b["low"] - prev).abs()], axis=1).max(axis=1)


def _daily(m1: pd.DataFrame) -> pd.DataFrame:
    d = m1.assign(date=m1["datetime"].dt.date).groupby("date").agg(
        open=("open", "first"), high=("high", "max"), low=("low", "min"), close=("close", "last"))
    d["prev_high"], d["prev_low"], d["prev_close"] = d["high"].shift(1), d["low"].shift(1), d["close"].shift(1)
    return d


def indicator(b: pd.DataFrame, op: Operand, daily: pd.DataFrame) -> pd.Series:
    """Series aligned to candles `b` (start-indexed). NaN where not yet defined."""
    p, f = op.params, op.field
    n = lambda k, default: int(p.get(k, default))  # noqa: E731
    src = b[str(p.get("source", "close"))] if op.ind in ("ema", "sma", "rsi", "bbands", "bb_width") else b["close"]

    if op.ind == "value":
        return pd.Series(float(p.get("value", 0)), index=b.index)
    if op.ind == "price":
        return b[f or "close"]
    if op.ind == "ema":
        return src.ewm(span=n("period", 20), adjust=False).mean()
    if op.ind == "sma":
        return src.rolling(n("period", 20)).mean()
    if op.ind == "rsi":
        delta = src.diff()
        gain, loss = _wilder(delta.clip(lower=0), n("period", 14)), _wilder(-delta.clip(upper=0), n("period", 14))
        rsi = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
        return rsi.where(loss != 0, np.where(gain > 0, 100.0, 50.0)).where(gain.notna())  # no losses → 100, flat → 50
    if op.ind == "atr":
        return _wilder(_true_range(b), n("period", 14))
    if op.ind == "macd":
        line = b["close"].ewm(span=n("fast", 12), adjust=False).mean() - b["close"].ewm(span=n("slow", 26), adjust=False).mean()
        signal = line.ewm(span=n("signal", 9), adjust=False).mean()
        return {"signal": signal, "hist": line - signal}.get(f or "line", line)
    if op.ind == "bbands":
        period, k = n("period", 20), float(p.get("std", 2))
        mid, sd = src.rolling(period).mean(), src.rolling(period).std(ddof=0)
        return {"upper": mid + k * sd, "lower": mid - k * sd}.get(f or "mid", mid)
    if op.ind == "supertrend":
        return _supertrend(b, n("period", 10), float(p.get("multiplier", 3)), f or "value")
    if op.ind == "vwap":
        tp = (b["high"] + b["low"] + b["close"]) / 3
        vol = b["volume"].fillna(0)
        by_day = b["date"]
        cum_v = vol.groupby(by_day).cumsum()
        vwap = (tp * vol).groupby(by_day).cumsum() / cum_v.replace(0, np.nan)
        # Indices have no volume: fall back to the session's average typical price (TWAP).
        twap = tp.groupby(by_day).cumsum() / tp.groupby(by_day).cumcount().add(1)
        return vwap.fillna(twap)
    if op.ind == "orb":
        start, end = str(p.get("start", "09:15")), str(p.get("end", "09:30"))
        hhmm = b.index.strftime("%H:%M")
        in_range = (hhmm >= start) & (hhmm < end)
        hi = b["high"].where(in_range).groupby(b["date"]).transform("max")
        lo = b["low"].where(in_range).groupby(b["date"]).transform("min")
        known = b["close_time"].dt.strftime("%H:%M") >= end  # the range is only known once it's over
        return (lo if f == "low" else hi).where(known)
    if op.ind == "prev_day":
        col = {"high": "prev_high", "low": "prev_low", "close": "prev_close"}[f or "close"]
        return b["date"].map(daily[col]).astype(float)
    if op.ind == "day_open":
        return b["date"].map(daily["open"]).astype(float)
    if op.ind == "chg_pct":  # % change of the close from the previous close (field prev_close) or today's open (open)
        base = b["date"].map(daily["open"] if f == "open" else daily["prev_close"]).astype(float)
        return (b["close"] - base) / base * 100
    if op.ind == "adx":
        period = n("period", 14)
        up, down = b["high"].diff(), -b["low"].diff()
        plus = pd.Series(np.where((up > down) & (up > 0), up, 0.0), index=b.index)
        minus = pd.Series(np.where((down > up) & (down > 0), down, 0.0), index=b.index)
        atr = _wilder(_true_range(b), period)
        pdi, mdi = 100 * _wilder(plus, period) / atr, 100 * _wilder(minus, period) / atr
        dx = (pdi - mdi).abs() / (pdi + mdi).replace(0, np.nan) * 100
        return {"plus": pdi, "minus": mdi}.get(f or "adx", _wilder(dx.fillna(0), period))
    if op.ind == "bb_width":  # (upper − lower) / middle, %
        period, k = n("period", 20), float(p.get("std", 2))
        mid, sd = src.rolling(period).mean(), src.rolling(period).std(ddof=0)
        return 2 * k * sd / mid * 100
    if op.ind == "rv":  # realised volatility of this timeframe's closes over `period` candles, scaled to one day, %
        per_day = float(b.groupby("date").size().median() or 1)
        return b["close"].pct_change().rolling(n("period", 20)).std() * math.sqrt(per_day) * 100
    if op.ind == "hv":  # annualised volatility of daily closes over the `period` days before today, %
        hv = daily["close"].pct_change().rolling(n("period", 20)).std().shift(1) * math.sqrt(252) * 100
        return b["date"].map(hv).astype(float)
    if op.ind == "prev_range_pct":  # previous day's high − low as % of its close
        rng = (daily["prev_high"] - daily["prev_low"]) / daily["prev_close"] * 100
        return b["date"].map(rng).astype(float)
    if op.ind == "gap_pct":
        return ((daily["open"] - daily["prev_close"]) / daily["prev_close"] * 100).reindex(b["date"]).set_axis(b.index)
    if op.ind in REGISTRY:
        return REGISTRY[op.ind].fn(b, dict(p), f, daily)
    raise ValueError(f"Unknown indicator {op.ind}")


def _supertrend(b: pd.DataFrame, period: int, mult: float, field: str) -> pd.Series:
    atr = _wilder(_true_range(b), period)
    hl2 = (b["high"] + b["low"]) / 2
    upper, lower = (hl2 + mult * atr).to_numpy(), (hl2 - mult * atr).to_numpy()
    close = b["close"].to_numpy()
    st, direction = np.full(len(b), np.nan), np.ones(len(b))
    fu, fl = upper.copy(), lower.copy()
    for i in range(1, len(b)):
        fu[i] = upper[i] if (upper[i] < fu[i - 1] or close[i - 1] > fu[i - 1]) else fu[i - 1]
        fl[i] = lower[i] if (lower[i] > fl[i - 1] or close[i - 1] < fl[i - 1]) else fl[i - 1]
        if direction[i - 1] == 1:
            direction[i] = -1 if close[i] < fl[i] else 1
        else:
            direction[i] = 1 if close[i] > fu[i] else -1
        st[i] = fl[i] if direction[i] == 1 else fu[i]
    if field == "direction":
        return pd.Series(direction, index=b.index)
    return pd.Series(st, index=b.index)


# ---------- lookback (warm-up) ----------

def lookback_minutes(cond: Condition | None, default_tf: str) -> int:
    """How much history (minutes) the indicators in a condition need to settle."""
    if cond is None:
        return 0
    if isinstance(cond, Group):
        return max(lookback_minutes(c, default_tf) for c in (cond.all or cond.any or []))
    out = 0
    for op in (cond.left, cond.right):
        if (op.tf or default_tf) in DAILY_TFS or op.params.get("symbol") or op.ind == "regime":
            continue  # daily candles come from the daily store with their own warm-up
        tf = TF_MINUTES[op.tf or default_tf]
        p = op.params
        if op.ind in REGISTRY:
            out = max(out, (REGISTRY[op.ind].lookback(dict(p)) + op.shift) * tf)
            continue
        bars = {
            "ema": 5 * int(p.get("period", 20)),
            "macd": 5 * int(p.get("slow", 26)) + int(p.get("signal", 9)),
            "rsi": 5 * int(p.get("period", 14)),
            "atr": 5 * int(p.get("period", 14)),
            "supertrend": 5 * int(p.get("period", 10)),
            "sma": int(p.get("period", 20)),
            "bbands": int(p.get("period", 20)),
            "bb_width": int(p.get("period", 20)),
            "adx": 5 * int(p.get("period", 14)),
            "rv": int(p.get("period", 20)) + 1,
        }.get(op.ind, 2)
        if op.ind == "hv":
            out = max(out, (int(p.get("period", 20)) + 2) * 375)
            continue
        out = max(out, bars * tf)
    return out


# ---------- evaluation ----------

def daily_candles(underlying: str | None, first: date, last: date, tf: str = "1d", symbol: str | None = None) -> pd.DataFrame:
    """1d / 1w candles from the daily store (long history for warm-up), shaped like resample() output:
    indexed by the first session's 09:15, close_time = the candle's last session at 15:30 (known after the close)."""
    from app.data.daily import daily_bars
    name = symbol or underlying
    if name is None:
        raise ValueError("1d / 1w operands need an underlying")
    d = daily_bars(name, first - pd.Timedelta(days=1100).to_pytimedelta(), last)
    if d.empty:
        return pd.DataFrame(columns=["open", "high", "low", "close", "volume", "close_time", "date"])
    d = d.assign(d=pd.to_datetime(d["d"]))
    if tf == "1w":
        week = d["d"].dt.to_period("W-SUN")
        g = d.groupby(week)
        d = pd.DataFrame({"d": g["d"].first(), "last": g["d"].last(), "open": g["open"].first(), "high": g["high"].max(),
                          "low": g["low"].min(), "close": g["close"].last(), "volume": g["volume"].sum()}).reset_index(drop=True)
    else:
        d["last"] = d["d"]
    out = pd.DataFrame({c: d[c].to_numpy(dtype=float) for c in ("open", "high", "low", "close", "volume")},
                       index=pd.DatetimeIndex(d["d"] + pd.Timedelta(minutes=SESSION_OPEN_MIN), name="start"))
    out["close_time"] = (d["last"] + pd.Timedelta(minutes=SESSION_CLOSE_MIN)).to_numpy()
    out["date"] = d["last"].dt.date.to_numpy()
    return out


def _daily_from_candles(b: pd.DataFrame) -> pd.DataFrame:
    """The `daily` frame indicators expect, from daily candles (prev_* = previous candle)."""
    d = b.set_index("date")[["open", "high", "low", "close"]].copy()
    d["prev_high"], d["prev_low"], d["prev_close"] = d["high"].shift(1), d["low"].shift(1), d["close"].shift(1)
    return d


@dataclass
class Evaluator:
    """Evaluates conditions on candles of `tf`, indexed by close time. Intraday timeframes come from the 1-minute
    candles; 1d / 1w (and any operand with params.symbol, e.g. VIX) from the daily store, with years of warm-up."""
    m1: pd.DataFrame
    tf: str
    underlying: str | None = None
    context: dict | None = None  # extras for special operands: {"dte": {date: int}}

    def __post_init__(self):
        self._bars: dict[tuple, pd.DataFrame] = {}
        self._cache: dict[str, pd.Series] = {}
        self.daily = _daily(self.m1) if len(self.m1) else pd.DataFrame()
        if len(self.m1):
            self.first, self.last = self.m1["datetime"].iloc[0].date(), self.m1["datetime"].iloc[-1].date()
        self.base = self.bars(self.tf)

    def bars(self, tf: str, symbol: str | None = None) -> pd.DataFrame:
        key = (tf, symbol)
        if key not in self._bars:
            if tf in DAILY_TFS or symbol:
                self._bars[key] = daily_candles(self.underlying, self.first, self.last, "1w" if tf == "1w" else "1d", symbol)
            else:
                self._bars[key] = resample(self.m1, tf)
        return self._bars[key]

    def _raw(self, op: Operand, b: pd.DataFrame, tf: str) -> pd.Series:
        if op.ind == "weekday":
            return pd.Series([float(d.weekday()) for d in b["date"]], index=b.index)
        if op.ind == "dte":
            dte = (self.context or {}).get("dte", {})
            return pd.Series([float(dte.get(d, np.nan)) for d in b["date"]], index=b.index)
        if op.ind == "regime":
            from app.strategy.regimes import regime_series
            daily = self.bars("1d")
            vix = self.bars("1d", "INDVIX")
            codes = regime_series(daily, vix, str(op.params.get("model", "trend_vol")))  # by date, known at that close
            known = pd.Series(codes.to_numpy(dtype=float), index=pd.to_datetime(daily["close_time"]).to_numpy())
            return pd.Series(pd.merge_asof(pd.DataFrame({"t": b["close_time"].to_numpy()}),
                                           pd.DataFrame({"t": known.index, "v": known.to_numpy()}), on="t",
                                           direction="backward")["v"].to_numpy(), index=b.index)
        daily = _daily_from_candles(b) if (tf in DAILY_TFS or op.params.get("symbol")) else self.daily
        return indicator(b, op, daily)

    def operand(self, op: Operand) -> pd.Series:
        """Operand on the base timeframe's close times, from its own timeframe's latest *closed* candle."""
        key = op.model_dump_json()
        if key in self._cache:
            return self._cache[key]
        tf = op.tf or self.tf
        symbol = op.params.get("symbol")
        b = self.bars(tf, str(symbol) if symbol else None)
        raw = self._raw(op, b, tf)
        if op.shift:
            raw = raw.shift(op.shift)
        raw = raw * op.mul + op.add
        values = pd.Series(raw.to_numpy(dtype=float), index=pd.DatetimeIndex(b["close_time"].to_numpy()))
        if (tf, symbol) != (self.tf, None):
            values = values.sort_index()
            aligned = pd.merge_asof(
                pd.DataFrame({"t": pd.DatetimeIndex(self.base["close_time"].to_numpy())}),
                pd.DataFrame({"t": values.index, "v": values.to_numpy()}),
                on="t", direction="backward",
            )["v"].to_numpy()
            values = pd.Series(aligned, index=pd.DatetimeIndex(self.base["close_time"].to_numpy()))
        self._cache[key] = values
        return values

    def evaluate(self, cond: Condition) -> pd.Series:
        """Boolean series on base close times."""
        if isinstance(cond, Group):
            parts = [self.evaluate(c) for c in (cond.all or cond.any)]
            if cond.any and cond.min:  # vote: at least `min` of the conditions
                return sum(p.astype(int) for p in parts) >= cond.min
            out = parts[0]
            for p in parts[1:]:
                out = (out & p) if cond.all else (out | p)
            return out
        return self._rule(cond)

    def _rule(self, r: Rule) -> pd.Series:
        left, right = self.operand(r.left), self.operand(r.right)
        valid = left.notna() & right.notna()
        if r.op in ("crosses_above", "crosses_below"):
            above = (left > right) & valid
            prev = above.shift(1, fill_value=bool(above.iloc[0]) if len(above) else False)
            prev_valid = valid.shift(1, fill_value=False)
            if r.op == "crosses_above":
                return above & ~prev & prev_valid
            return ~above & prev & valid
        cmp = {">": left > right, "<": left < right, ">=": left >= right, "<=": left <= right,
               "==": (left - right).abs() < 1e-9, "!=": (left - right).abs() >= 1e-9}[r.op]
        return cmp & valid


def signal_times(m1: pd.DataFrame, tf: str, conditions: dict[str, Condition | None], days: set[date],
                 underlying: str | None = None, context: dict | None = None) -> list[tuple[pd.Timestamp, str]]:
    """(time the condition became known = candle close, label) for every candle on `days` where a condition
    is true, sorted. labels are the dict keys (e.g. "signal", "bullish", "bearish")."""
    ev = Evaluator(m1, tf, underlying, context)
    out = []
    in_days = np.array([d in days for d in ev.base["date"]])
    for label, cond in conditions.items():
        if cond is None:
            continue
        hits = ev.evaluate(cond).to_numpy() & in_days
        for t in ev.base["close_time"].to_numpy()[hits]:
            out.append((pd.Timestamp(t), label))
    return sorted(out)


__all__ = ["resample", "indicator", "Evaluator", "signal_times", "lookback_minutes", "math"]
