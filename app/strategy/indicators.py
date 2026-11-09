"""Extended indicator library (TradingView-style), registered by name for StrategySpec operands.

Every indicator is a function (b, params, field, daily) -> pd.Series aligned to the candles `b`:
  b      candles of one timeframe, indexed by candle start, columns open/high/low/close/volume, close_time, date
  params the operand's params (period, std, …); field selects one output of a multi-output indicator
  daily  daily candles from the same 1-minute data (open/high/low/close, prev_high/prev_low/prev_close by date)
A value at row i may use only rows ≤ i (the candle is closed when its value is read), so no lookahead.
Index candles have no volume (0), so volume-weighted indicators aren't offered for the index itself.

register() records the function, a warm-up estimate in candles, its fields and a one-line description;
the catalogue is served by GET /strategies/indicators for the builder.
"""

from __future__ import annotations

from dataclasses import dataclass, field as dc_field
import math
from typing import Callable

import numpy as np
import pandas as pd

Fn = Callable[[pd.DataFrame, dict, "str | None", pd.DataFrame], pd.Series]


@dataclass
class Indicator:
    name: str
    fn: Fn
    lookback: Callable[[dict], int]  # candles needed to settle
    fields: tuple[str, ...] = ()
    params: dict = dc_field(default_factory=dict)  # defaults, shown in the builder
    description: str = ""
    category: str = "Other"


REGISTRY: dict[str, Indicator] = {}


def register(name: str, *, lookback: Callable[[dict], int], fields: tuple[str, ...] = (), params: dict | None = None,
             description: str = "", category: str = "Other"):
    defaults = params or {}

    def deco(fn: Fn) -> Fn:
        # the operand's params over the registered defaults, so functions can read p["period"] directly
        call = lambda b, p, f, daily: fn(b, {**defaults, **(p or {})}, f, daily)  # noqa: E731
        REGISTRY[name] = Indicator(name, call, lambda p: int(lookback({**defaults, **(p or {})})), fields, defaults,
                                   description, category)
        return fn
    return deco


def catalogue() -> list[dict]:
    return [{"name": i.name, "fields": list(i.fields), "params": i.params, "description": i.description, "category": i.category}
            for i in sorted(REGISTRY.values(), key=lambda i: (i.category, i.name))]


def p_int(params: dict, key: str, default: int) -> int:
    return int(params.get(key, default))


def p_float(params: dict, key: str, default: float) -> float:
    return float(params.get(key, default))


def wilder(s: pd.Series, period: int) -> pd.Series:
    return s.ewm(alpha=1 / period, adjust=False).mean()


def true_range(b: pd.DataFrame) -> pd.Series:
    prev = b["close"].shift(1)
    return pd.concat([b["high"] - b["low"], (b["high"] - prev).abs(), (b["low"] - prev).abs()], axis=1).max(axis=1)


def source(b: pd.DataFrame, p: dict, default: str = "close") -> pd.Series:
    """params.source: a column (open/high/low/close/volume) or hl2 / hlc3 / ohlc4."""
    src = str(p.get("source", default))
    if src == "hl2":
        return (b["high"] + b["low"]) / 2
    if src == "hlc3":
        return (b["high"] + b["low"] + b["close"]) / 3
    if src == "ohlc4":
        return (b["open"] + b["high"] + b["low"] + b["close"]) / 4
    return b[src].astype(float)


def pick(out: dict[str, pd.Series], f: str | None, default: str) -> pd.Series:
    """One output of a multi-output indicator; field None → `default`."""
    key = f or default
    if key not in out:
        raise ValueError(f"unknown field {key!r} (one of {', '.join(out)})")
    return out[key]


def ema(s: pd.Series, n: int) -> pd.Series:
    return s.ewm(span=n, adjust=False).mean()


def wsum(s: pd.Series, w: np.ndarray) -> pd.Series:
    """Rolling dot product with weights `w` (oldest first); NaN until the window is full or holds a NaN."""
    x, n = s.to_numpy(dtype=float), len(w)
    out = np.full(len(x), np.nan)
    if len(x) >= n:
        out[n - 1:] = np.lib.stride_tricks.sliding_window_view(x, n) @ w
    return pd.Series(out, index=s.index)


def wma(s: pd.Series, n: int) -> pd.Series:
    w = np.arange(1, n + 1, dtype=float)
    return wsum(s, w / w.sum())


def roc(s: pd.Series, n: int) -> pd.Series:
    return (s / s.shift(n) - 1) * 100


def rsi(s: pd.Series, n: int) -> pd.Series:
    delta = s.diff()
    gain, loss = wilder(delta.clip(lower=0), n), wilder(-delta.clip(upper=0), n)
    out = 100 - 100 / (1 + gain / loss.replace(0, np.nan))
    return out.where(loss != 0, np.where(gain > 0, 100.0, 50.0)).where(gain.notna())


def stoch_of(s: pd.Series, hi: pd.Series, lo: pd.Series, n: int) -> pd.Series:
    """100 × (s − lowest lo) / (highest hi − lowest lo) over n; a flat range gives 50."""
    hh, ll = hi.rolling(n).max(), lo.rolling(n).min()
    rng = hh - ll
    return (100 * (s - ll) / rng.replace(0, np.nan)).where(rng != 0, 50.0).where(rng.notna())


def linreg(s: pd.Series, n: int) -> tuple[pd.Series, pd.Series]:
    """Least-squares line through the last n values: (value at the latest bar, slope per bar)."""
    x = np.arange(n, dtype=float)
    sx, sxx = x.sum(), (x * x).sum()
    sy, sxy = s.rolling(n).sum(), wsum(s, x)
    slope = (n * sxy - sx * sy) / (n * sxx - sx * sx) if n > 1 else sy * 0
    return (sy - slope * sx) / n + slope * (n - 1), slope


def pct_rank(s: pd.Series, n: int) -> pd.Series:
    """% of the previous n values ≤ the current one (TradingView ta.percentrank)."""
    count = sum((s.shift(k) <= s).astype(float) for k in range(1, n + 1))
    return (count / n * 100).where(s.rolling(n + 1).count() == n + 1)


def prev_day(b: pd.DataFrame, daily: pd.DataFrame) -> tuple[pd.Series, pd.Series, pd.Series]:
    """Previous day's high, low, close on each candle (known before the day starts)."""
    return tuple(b["date"].map(daily[c]).astype(float) for c in ("prev_high", "prev_low", "prev_close"))


# ---------- indicators ----------

@register("atr_pct", lookback=lambda p: 5 * p_int(p, "period", 14), params={"period": 14},
          description="Average true range as % of close", category="Volatility")
def atr_pct(b, p, f, daily):
    return wilder(true_range(b), p_int(p, "period", 14)) / b["close"] * 100


def _n(p: dict, key: str = "period") -> int:
    return int(p[key])


# Moving averages

MA = "Moving averages"


@register("wma", lookback=lambda p: _n(p), params={"period": 9, "source": "close"},
          description="Weighted moving average (linear weights, newest heaviest)", category=MA)
def ind_wma(b, p, f, daily):
    return wma(source(b, p), _n(p))


@register("hma", lookback=lambda p: _n(p) + int(math.sqrt(_n(p))), params={"period": 9, "source": "close"},
          description="Hull moving average: WMA(2·WMA(n/2) − WMA(n), √n)", category=MA)
def ind_hma(b, p, f, daily):
    n, src = _n(p), source(b, p)
    return wma(2 * wma(src, max(n // 2, 1)) - wma(src, n), max(int(math.sqrt(n)), 1))


@register("dema", lookback=lambda p: 5 * _n(p), params={"period": 9, "source": "close"},
          description="Double EMA: 2·EMA − EMA(EMA)", category=MA)
def ind_dema(b, p, f, daily):
    e1 = ema(source(b, p), _n(p))
    return 2 * e1 - ema(e1, _n(p))


@register("tema", lookback=lambda p: 5 * _n(p), params={"period": 9, "source": "close"},
          description="Triple EMA: 3·EMA − 3·EMA² + EMA³", category=MA)
def ind_tema(b, p, f, daily):
    e1 = ema(source(b, p), _n(p))
    e2 = ema(e1, _n(p))
    return 3 * e1 - 3 * e2 + ema(e2, _n(p))


@register("kama", lookback=lambda p: _n(p) + 5 * _n(p, "slow"), params={"period": 10, "fast": 2, "slow": 30, "source": "close"},
          description="Kaufman adaptive MA: speed follows the efficiency ratio", category=MA)
def ind_kama(b, p, f, daily):
    n, src = _n(p), source(b, p)
    fast, slow = 2 / (_n(p, "fast") + 1), 2 / (_n(p, "slow") + 1)
    er = (src - src.shift(n)).abs() / src.diff().abs().rolling(n).sum()
    sc = ((er.fillna(0) * (fast - slow) + slow) ** 2).where(er.notna() | (src.diff().abs().rolling(n).sum() == 0))
    x, c = src.to_numpy(dtype=float), sc.to_numpy(dtype=float)
    out = np.full(len(x), np.nan)
    for i in range(len(x)):
        if np.isnan(c[i]):
            continue
        prev = out[i - 1] if i and not np.isnan(out[i - 1]) else x[i]
        out[i] = prev + c[i] * (x[i] - prev)
    return pd.Series(out, index=b.index)


@register("zlema", lookback=lambda p: 5 * _n(p), params={"period": 9, "source": "close"},
          description="Zero-lag EMA: EMA of src + (src − src[(n−1)/2])", category=MA)
def ind_zlema(b, p, f, daily):
    n, src = _n(p), source(b, p)
    return ema(src + (src - src.shift((n - 1) // 2)), n)


@register("alma", lookback=lambda p: _n(p), params={"period": 9, "offset": 0.85, "sigma": 6, "source": "close"},
          description="Arnaud Legoux MA: Gaussian weights centred at offset", category=MA)
def ind_alma(b, p, f, daily):
    n = _n(p)
    m, s = float(p["offset"]) * (n - 1), n / float(p["sigma"])
    w = np.exp(-((np.arange(n) - m) ** 2) / (2 * s * s))
    return wsum(source(b, p), w / w.sum())


# Oscillators

OSC = "Oscillators"


@register("stoch", lookback=lambda p: _n(p) + _n(p, "smooth_k") + _n(p, "smooth_d"), fields=("k", "d"),
          params={"period": 14, "smooth_k": 1, "smooth_d": 3}, description="Stochastic %K / %D (0–100)", category=OSC)
def ind_stoch(b, p, f, daily):
    k = stoch_of(b["close"], b["high"], b["low"], _n(p)).rolling(_n(p, "smooth_k")).mean()
    return pick({"k": k, "d": k.rolling(_n(p, "smooth_d")).mean()}, f, "k")


@register("stoch_rsi", lookback=lambda p: 5 * _n(p, "rsi_period") + _n(p) + _n(p, "smooth_k") + _n(p, "smooth_d"),
          fields=("k", "d"), params={"rsi_period": 14, "period": 14, "smooth_k": 3, "smooth_d": 3, "source": "close"},
          description="Stochastic of RSI, %K / %D (0–100)", category=OSC)
def ind_stoch_rsi(b, p, f, daily):
    r = rsi(source(b, p), _n(p, "rsi_period"))
    k = stoch_of(r, r, r, _n(p)).rolling(_n(p, "smooth_k")).mean()
    return pick({"k": k, "d": k.rolling(_n(p, "smooth_d")).mean()}, f, "k")


@register("cci", lookback=lambda p: _n(p) + 1, params={"period": 20, "source": "hlc3"},
          description="Commodity channel index: (src − SMA) / (0.015 × mean deviation)", category=OSC)
def ind_cci(b, p, f, daily):
    n, src = _n(p), source(b, p, "hlc3")
    ma = src.rolling(n).mean()
    md = sum((src.shift(k) - ma).abs() for k in range(n)) / n
    return (src - ma) / (0.015 * md.replace(0, np.nan))


@register("williams_r", lookback=lambda p: _n(p), params={"period": 14},
          description="Williams %R (−100 to 0)", category=OSC)
def ind_williams_r(b, p, f, daily):
    return stoch_of(b["close"], b["high"], b["low"], _n(p)) - 100


@register("roc", lookback=lambda p: _n(p) + 1, params={"period": 9, "source": "close"},
          description="Rate of change over n candles, %", category=OSC)
def ind_roc(b, p, f, daily):
    return roc(source(b, p), _n(p))


@register("cmo", lookback=lambda p: _n(p) + 1, params={"period": 9, "source": "close"},
          description="Chande momentum oscillator (−100 to 100)", category=OSC)
def ind_cmo(b, p, f, daily):
    d = source(b, p).diff()
    up, down = d.clip(lower=0).rolling(_n(p)).sum(), (-d.clip(upper=0)).rolling(_n(p)).sum()
    return (100 * (up - down) / (up + down).replace(0, np.nan)).where((up + down) != 0, 0.0).where(up.notna())


@register("tsi", lookback=lambda p: 5 * (_n(p, "long") + _n(p, "short") + _n(p, "signal")), fields=("tsi", "signal"),
          params={"long": 25, "short": 13, "signal": 13, "source": "close"},
          description="True strength index (double-smoothed momentum, ×100) and its EMA signal", category=OSC)
def ind_tsi(b, p, f, daily):
    pc = source(b, p).diff()
    num = ema(ema(pc, _n(p, "long")), _n(p, "short"))
    den = ema(ema(pc.abs(), _n(p, "long")), _n(p, "short"))
    line = 100 * num / den.replace(0, np.nan)
    return pick({"tsi": line, "signal": ema(line, _n(p, "signal"))}, f, "tsi")


@register("ultimate", lookback=lambda p: _n(p, "slow") + 1, params={"fast": 7, "mid": 14, "slow": 28},
          description="Ultimate oscillator: weighted buying pressure over 3 windows (0–100)", category=OSC)
def ind_ultimate(b, p, f, daily):
    pc = b["close"].shift(1)
    lo, hi = pd.concat([b["low"], pc], axis=1).min(axis=1), pd.concat([b["high"], pc], axis=1).max(axis=1)
    bp, tr = b["close"] - lo, hi - lo
    avg = lambda n: bp.rolling(n).sum() / tr.rolling(n).sum().replace(0, np.nan)  # noqa: E731
    return 100 * (4 * avg(_n(p, "fast")) + 2 * avg(_n(p, "mid")) + avg(_n(p, "slow"))) / 7


@register("awesome", lookback=lambda p: _n(p, "slow"), params={"fast": 5, "slow": 34},
          description="Awesome oscillator: SMA(hl2, 5) − SMA(hl2, 34)", category=OSC)
def ind_awesome(b, p, f, daily):
    hl2 = (b["high"] + b["low"]) / 2
    return hl2.rolling(_n(p, "fast")).mean() - hl2.rolling(_n(p, "slow")).mean()


@register("ppo", lookback=lambda p: 5 * _n(p, "slow") + _n(p, "signal"), fields=("line", "signal", "hist"),
          params={"fast": 12, "slow": 26, "signal": 9, "source": "close"},
          description="Percentage price oscillator: (EMA fast − EMA slow) / EMA slow, %", category=OSC)
def ind_ppo(b, p, f, daily):
    src = source(b, p)
    slow = ema(src, _n(p, "slow"))
    line = (ema(src, _n(p, "fast")) - slow) / slow * 100
    sig = ema(line, _n(p, "signal"))
    return pick({"line": line, "signal": sig, "hist": line - sig}, f, "line")


@register("dpo", lookback=lambda p: _n(p) + 1, params={"period": 21},
          description="Detrended price oscillator, causal: close n/2+1 candles ago − SMA ending now", category=OSC)
def ind_dpo(b, p, f, daily):
    n = _n(p)
    return b["close"].shift(n // 2 + 1) - b["close"].rolling(n).mean()


@register("trix", lookback=lambda p: 15 * _n(p), params={"period": 18},
          description="TRIX: 10000 × 1-candle change of the triple EMA of log(close)", category=OSC)
def ind_trix(b, p, f, daily):
    n = _n(p)
    return 10000 * ema(ema(ema(np.log(b["close"]), n), n), n).diff()


@register("coppock", lookback=lambda p: max(_n(p, "long"), _n(p, "short")) + _n(p) + 1,
          params={"period": 10, "long": 14, "short": 11, "source": "close"},
          description="Coppock curve: WMA of ROC(long) + ROC(short)", category=OSC)
def ind_coppock(b, p, f, daily):
    src = source(b, p)
    return wma(roc(src, _n(p, "long")) + roc(src, _n(p, "short")), _n(p))


# Trend

TREND = "Trend"


def _mid(b: pd.DataFrame, n: int) -> pd.Series:
    return (b["high"].rolling(n).max() + b["low"].rolling(n).min()) / 2


@register("donchian", lookback=lambda p: _n(p), fields=("upper", "mid", "lower"), params={"period": 20},
          description="Donchian channel: highest high / lowest low over n", category=TREND)
def ind_donchian(b, p, f, daily):
    hi, lo = b["high"].rolling(_n(p)).max(), b["low"].rolling(_n(p)).min()
    return pick({"upper": hi, "mid": (hi + lo) / 2, "lower": lo}, f, "mid")


@register("keltner", lookback=lambda p: 5 * max(_n(p), _n(p, "atr_period")), fields=("upper", "mid", "lower"),
          params={"period": 20, "atr_period": 10, "multiplier": 2, "source": "close"},
          description="Keltner channel: EMA ± multiplier × ATR", category=TREND)
def ind_keltner(b, p, f, daily):
    mid = ema(source(b, p), _n(p))
    band = float(p["multiplier"]) * wilder(true_range(b), _n(p, "atr_period"))
    return pick({"upper": mid + band, "mid": mid, "lower": mid - band}, f, "mid")


@register("ichimoku", lookback=lambda p: _n(p, "span_b") + _n(p, "displacement"), fields=("tenkan", "kijun", "span_a", "span_b"),
          params={"tenkan": 9, "kijun": 26, "span_b": 52, "displacement": 26},
          description="Ichimoku (no Chikou): conversion, base, and the cloud as plotted at this candle", category=TREND)
def ind_ichimoku(b, p, f, daily):
    tenkan, kijun = _mid(b, _n(p, "tenkan")), _mid(b, _n(p, "kijun"))
    lag = max(_n(p, "displacement") - 1, 0)  # TradingView plots the leads displacement − 1 candles ahead
    return pick({"tenkan": tenkan, "kijun": kijun, "span_a": ((tenkan + kijun) / 2).shift(lag),
                 "span_b": _mid(b, _n(p, "span_b")).shift(lag)}, f, "tenkan")


@register("psar", lookback=lambda p: 50, fields=("value", "direction"), params={"start": 0.02, "increment": 0.02, "max": 0.2},
          description="Parabolic SAR (value) and trend direction (1 up / −1 down)", category=TREND)
def ind_psar(b, p, f, daily):
    start, inc, cap = float(p["start"]), float(p["increment"]), float(p["max"])
    h, lo, c = (b[k].to_numpy(dtype=float) for k in ("high", "low", "close"))
    sar, dirn = np.full(len(b), np.nan), np.full(len(b), np.nan)
    below, ext, acc, res = True, 0.0, start, 0.0
    for i in range(1, len(b)):  # TradingView ta.sar
        first = False
        if i == 1:
            below = c[1] > c[0]
            ext, res, acc, first = (h[1], lo[0], start, True) if below else (lo[1], h[0], start, True)
        res = res + acc * (ext - res)
        if below and res > lo[i]:
            first, below, res, ext, acc = True, False, max(h[i], ext), lo[i], start
        elif not below and res < h[i]:
            first, below, res, ext, acc = True, True, min(lo[i], ext), h[i], start
        if not first:
            if below and h[i] > ext:
                ext, acc = h[i], min(acc + inc, cap)
            elif not below and lo[i] < ext:
                ext, acc = lo[i], min(acc + inc, cap)
        if below:
            res = min(res, lo[i - 1], lo[i - 2]) if i > 1 else min(res, lo[i - 1])
        else:
            res = max(res, h[i - 1], h[i - 2]) if i > 1 else max(res, h[i - 1])
        sar[i], dirn[i] = res, 1.0 if below else -1.0
    return pick({"value": pd.Series(sar, index=b.index), "direction": pd.Series(dirn, index=b.index)}, f, "value")


def _bars_since_extreme(s: pd.Series, n: int, highest: bool) -> pd.Series:
    """Candles since the highest (lowest) value within the last n+1 candles; the most recent one wins ties."""
    best, since = s.copy(), pd.Series(0.0, index=s.index)
    for k in range(1, n + 1):
        v = s.shift(k)
        better = (v > best) if highest else (v < best)
        best, since = best.where(~better, v), since.where(~better, float(k))
    return since.where(s.rolling(n + 1).count() == n + 1)


@register("aroon", lookback=lambda p: _n(p) + 1, fields=("up", "down", "osc"), params={"period": 14},
          description="Aroon up / down (0–100) and oscillator (up − down)", category=TREND)
def ind_aroon(b, p, f, daily):
    n = _n(p)
    up = 100 * (n - _bars_since_extreme(b["high"], n, True)) / n
    down = 100 * (n - _bars_since_extreme(b["low"], n, False)) / n
    return pick({"up": up, "down": down, "osc": up - down}, f, "osc")


@register("vortex", lookback=lambda p: _n(p) + 1, fields=("plus", "minus"), params={"period": 14},
          description="Vortex indicator VI+ / VI−", category=TREND)
def ind_vortex(b, p, f, daily):
    n = _n(p)
    tr = true_range(b).where(b["close"].shift(1).notna()).rolling(n).sum()
    vp = (b["high"] - b["low"].shift(1)).abs().rolling(n).sum()
    vm = (b["low"] - b["high"].shift(1)).abs().rolling(n).sum()
    return pick({"plus": vp / tr, "minus": vm / tr}, f, "plus")


@register("linreg", lookback=lambda p: _n(p), fields=("value", "slope"), params={"period": 100, "source": "close"},
          description="Linear regression over n candles: value at this candle and slope per candle", category=TREND)
def ind_linreg(b, p, f, daily):
    value, slope = linreg(source(b, p), _n(p))
    return pick({"value": value, "slope": slope}, f, "value")


@register("heikin_ashi", lookback=lambda p: 20, fields=("open", "high", "low", "close"),
          description="Heikin-Ashi candle", category=TREND)
def ind_heikin_ashi(b, p, f, daily):
    close = (b["open"] + b["high"] + b["low"] + b["close"]) / 4
    seed = close.shift(1)
    seed.iloc[:1] = (b["open"].iloc[:1] + b["close"].iloc[:1]) / 2
    opn = seed.ewm(alpha=0.5, adjust=False).mean()  # (previous HA open + previous HA close) / 2
    high = pd.concat([b["high"], opn, close], axis=1).max(axis=1)
    low = pd.concat([b["low"], opn, close], axis=1).min(axis=1)
    return pick({"open": opn, "high": high, "low": low, "close": close}, f, "close")


@register("highest", lookback=lambda p: _n(p), params={"period": 20, "source": "high"},
          description="Highest value of source over n candles", category=TREND)
def ind_highest(b, p, f, daily):
    return source(b, p, "high").rolling(_n(p)).max()


@register("lowest", lookback=lambda p: _n(p), params={"period": 20, "source": "low"},
          description="Lowest value of source over n candles", category=TREND)
def ind_lowest(b, p, f, daily):
    return source(b, p, "low").rolling(_n(p)).min()


@register("ema_slope", lookback=lambda p: 5 * _n(p) + _n(p, "bars"), params={"period": 20, "bars": 5, "source": "close"},
          description="% change of the EMA over the last `bars` candles", category=TREND)
def ind_ema_slope(b, p, f, daily):
    e = ema(source(b, p), _n(p))
    return (e / e.shift(_n(p, "bars")) - 1) * 100


@register("ma_distance", lookback=lambda p: 5 * _n(p), params={"period": 20, "kind": "ema"},
          description="% distance of close from its EMA or SMA (kind)", category=TREND)
def ind_ma_distance(b, p, f, daily):
    c = b["close"]
    kind = str(p["kind"]).lower()
    if kind not in ("ema", "sma"):
        raise ValueError(f"ma_distance kind must be ema or sma, not {kind!r}")
    ma = ema(c, _n(p)) if kind == "ema" else c.rolling(_n(p)).mean()
    return (c - ma) / ma * 100


# Regime

REG = "Regime"


@register("choppiness", lookback=lambda p: _n(p) + 1, params={"period": 14},
          description="Choppiness index: 100 = sideways, low = trending (0–100)", category=REG)
def ind_choppiness(b, p, f, daily):
    n = _n(p)
    rng = b["high"].rolling(n).max() - b["low"].rolling(n).min()
    return 100 * np.log10(true_range(b).rolling(n).sum() / rng.replace(0, np.nan)) / math.log10(n)


@register("efficiency_ratio", lookback=lambda p: _n(p) + 1, params={"period": 10, "source": "close"},
          description="Kaufman efficiency ratio: net move / path length (0–1)", category=REG)
def ind_efficiency_ratio(b, p, f, daily):
    src, n = source(b, p), _n(p)
    path = src.diff().abs().rolling(n).sum()
    return ((src - src.shift(n)).abs() / path.replace(0, np.nan)).where(path != 0, 0.0).where(path.notna())


@register("pct_b", lookback=lambda p: _n(p), params={"period": 20, "std": 2, "source": "close"},
          description="Bollinger %B: position within the bands (0 = lower, 1 = upper)", category=REG)
def ind_pct_b(b, p, f, daily):
    src, n = source(b, p), _n(p)
    mid, sd = src.rolling(n).mean(), src.rolling(n).std(ddof=0)
    lower, width = mid - float(p["std"]) * sd, 2 * float(p["std"]) * sd
    return (src - lower) / width.replace(0, np.nan)


@register("squeeze", lookback=lambda p: 2 * _n(p), fields=("on", "momentum"),
          params={"period": 20, "bb_mult": 2, "kc_mult": 1.5},
          description="TTM squeeze: on = Bollinger inside Keltner (1/0); momentum = linreg of close vs channel mid",
          category=REG)
def ind_squeeze(b, p, f, daily):
    n, c = _n(p), b["close"]
    mid, sd = c.rolling(n).mean(), c.rolling(n).std(ddof=0)
    kc = float(p["kc_mult"]) * true_range(b).rolling(n).mean()
    bb = float(p["bb_mult"]) * sd
    on = (bb < kc).astype(float).where(kc.notna() & sd.notna())
    mom, _ = linreg(c - (_mid(b, n) + mid) / 2, n)
    return pick({"on": on, "momentum": mom}, f, "on")


@register("hv_percentile", lookback=lambda p: _n(p) + _n(p, "lookback") + 2, params={"period": 20, "lookback": 252},
          description="Percentile of close-to-close volatility (n) vs its own previous `lookback` candles (0–100)",
          category=REG)
def ind_hv_percentile(b, p, f, daily):
    hv = np.log(b["close"]).diff().rolling(_n(p)).std()
    return pct_rank(hv, _n(p, "lookback"))


@register("percent_rank", lookback=lambda p: _n(p) + 1, params={"period": 100, "source": "close"},
          description="% of the previous n candles at or below this one (0–100)", category=REG)
def ind_percent_rank(b, p, f, daily):
    return pct_rank(source(b, p), _n(p))


@register("zscore", lookback=lambda p: _n(p), params={"period": 20, "source": "close"},
          description="Z-score of source vs its n-candle mean and std", category=REG)
def ind_zscore(b, p, f, daily):
    src, n = source(b, p), _n(p)
    return (src - src.rolling(n).mean()) / src.rolling(n).std(ddof=0).replace(0, np.nan)


@register("range_pct", lookback=lambda p: _n(p), params={"period": 14},
          description="Average candle range (high − low) as % of close over n candles", category=REG)
def ind_range_pct(b, p, f, daily):
    return ((b["high"] - b["low"]) / b["close"] * 100).rolling(_n(p)).mean()


# Levels (from the previous day's high / low / close)

LEV = "Levels"


@register("pivots", lookback=lambda p: 2, fields=("p", "r1", "r2", "r3", "s1", "s2", "s3"),
          description="Classic floor pivots from the previous day", category=LEV)
def ind_pivots(b, p, f, daily):
    h, lo, c = prev_day(b, daily)
    pp = (h + lo + c) / 3
    return pick({"p": pp, "r1": 2 * pp - lo, "r2": pp + (h - lo), "r3": h + 2 * (pp - lo),
                 "s1": 2 * pp - h, "s2": pp - (h - lo), "s3": lo - 2 * (h - pp)}, f, "p")


@register("camarilla", lookback=lambda p: 2, fields=("r1", "r2", "r3", "r4", "s1", "s2", "s3", "s4"),
          description="Camarilla levels from the previous day", category=LEV)
def ind_camarilla(b, p, f, daily):
    h, lo, c = prev_day(b, daily)
    rng = (h - lo) * 1.1
    out = {}
    for k, div in ((1, 12), (2, 6), (3, 4), (4, 2)):
        out[f"r{k}"], out[f"s{k}"] = c + rng / div, c - rng / div
    return pick(out, f, "r3")


@register("cpr", lookback=lambda p: 2, fields=("pivot", "bc", "tc", "width_pct"),
          description="Central pivot range from the previous day (tc ≥ bc) and its width as % of pivot", category=LEV)
def ind_cpr(b, p, f, daily):
    h, lo, c = prev_day(b, daily)
    pivot, mid = (h + lo + c) / 3, (h + lo) / 2
    other = 2 * pivot - mid
    tc, bc = np.maximum(mid, other), np.minimum(mid, other)
    return pick({"pivot": pivot, "bc": bc, "tc": tc, "width_pct": (tc - bc) / pivot * 100}, f, "pivot")


__all__ = ["REGISTRY", "register", "catalogue", "Indicator", "wilder", "true_range", "p_int", "p_float", "np"]
