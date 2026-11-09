"""Extended indicator library: causality for every registered indicator and field, sane values, end-to-end use."""

import numpy as np
import pandas as pd
import pytest

from app.strategy.indicators import REGISTRY, catalogue
from app.strategy.signals import Evaluator, _daily, _daily_from_candles, indicator, lookback_minutes, resample
from app.strategy.spec import Operand, Rule

DAYS = 40


def minutes(days=DAYS, seed=1):
    rng = np.random.default_rng(seed)
    out, price = [], 24000.0
    for d in pd.bdate_range("2026-03-02", periods=days):
        for m in range(375):
            o = price
            price *= 1 + rng.normal(0, 0.0005)
            out.append({"datetime": d + pd.Timedelta(minutes=9 * 60 + 15 + m), "open": o,
                        "high": max(o, price) + rng.uniform(0, 3), "low": min(o, price) - rng.uniform(0, 3),
                        "close": price, "volume": float(rng.integers(100, 1000))})
    return pd.DataFrame(out)


def day_candles(n=420, seed=2):
    """1d candles shaped like signals.daily_candles()."""
    rng = np.random.default_rng(seed)
    days = pd.bdate_range("2025-01-01", periods=n)
    close = 24000 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    opn = np.r_[24000, close[:-1]] * (1 + rng.normal(0, 0.002, n))
    b = pd.DataFrame({"open": opn, "high": np.maximum(opn, close) * (1 + rng.uniform(0, 0.01, n)),
                      "low": np.minimum(opn, close) * (1 - rng.uniform(0, 0.01, n)), "close": close,
                      "volume": rng.integers(1e5, 1e6, n).astype(float)},
                     index=pd.DatetimeIndex(days + pd.Timedelta(minutes=555), name="start"))
    b["close_time"] = days + pd.Timedelta(minutes=930)
    b["date"] = days.date
    return b


def cases():
    """(name, field, params): every indicator × (default field + each field), plus a few non-default params."""
    out = []
    for name, ind in REGISTRY.items():
        for f in (None, *ind.fields):
            out.append((name, f, {}))
    out += [("ma_distance", None, {"kind": "sma"}), ("highest", None, {"source": "close"}),
            ("lowest", None, {"source": "hl2"}), ("wma", None, {"source": "ohlc4"})]
    return out


def ids(c):
    return f"{c[0]}:{c[1] or '-'}{':' + str(c[2]) if c[2] else ''}"


def calc(name, f, params, b, daily):
    return REGISTRY[name].fn(b, dict(params), f, daily).to_numpy(dtype=float)


def shock(df, mask, seed=3):
    """Multiply OHLC of the masked rows by a random factor around 1.1 (high a bit more, low a bit less, so
    ratio-type indicators change too) and change their volume."""
    out = df.copy()
    rng = np.random.default_rng(seed)
    n = int(mask.sum())
    k, wide = 1.1 + rng.uniform(-0.05, 0.05, n), rng.uniform(0, 0.003, n)
    for c, x in (("open", k), ("close", k), ("high", k * (1 + wide)), ("low", k * (1 - wide))):
        out.loc[mask, c] = out.loc[mask, c].to_numpy() * x
    out.loc[mask, "volume"] = out.loc[mask, "volume"].to_numpy() * 3 + 7
    return out


M1 = minutes()
B15 = resample(M1, "15m")
DAILY = _daily(M1)
D1 = day_candles()


def _intraday_ks():
    """Rows k to cut after: mid-session of day 30 (so the shock also changes *today's* daily H/L/C, which
    previous-day levels must ignore), the day's last candle, and the next day's first candle."""
    day30 = B15.index[B15["date"] == B15["date"].unique()[30]]
    day31 = B15.index[B15["date"] == B15["date"].unique()[31]]
    return [B15.index.get_loc(day30[11]), B15.index.get_loc(day30[-1]), B15.index.get_loc(day31[0])]


@pytest.mark.parametrize("case", cases(), ids=ids)
def test_no_lookahead_intraday(case):
    name, f, params = case
    base = calc(name, f, params, B15, DAILY)
    for k in _intraday_ks():
        # every 1-minute bar inside a candle after k changes; candles ≤ k keep their minutes
        later = M1["datetime"] >= B15["close_time"].iloc[k]
        m1 = shock(M1, later)
        b = resample(m1, "15m")
        assert (b.iloc[: k + 1][["open", "high", "low", "close"]].to_numpy() == B15.iloc[: k + 1][["open", "high", "low", "close"]].to_numpy()).all()
        got = calc(name, f, params, b, _daily(m1))
        assert np.isfinite(base[: k + 1]).any(), f"{name} never defined before row {k}: test would be trivial"
        assert np.allclose(base[: k + 1], got[: k + 1], equal_nan=True), f"{name}.{f} at k={k} uses later candles"
        assert not np.allclose(base, got, equal_nan=True), f"{name}.{f}: the shock never reaches it"


@pytest.mark.parametrize("case", cases(), ids=ids)
def test_no_lookahead_daily_candles(case):
    name, f, params = case
    base = calc(name, f, params, D1, _daily_from_candles(D1))
    k = 360
    later = np.arange(len(D1)) > k
    b = shock(D1, later)
    got = calc(name, f, params, b, _daily_from_candles(b))
    assert np.isfinite(base[: k + 1]).any(), name
    assert np.allclose(base[: k + 1], got[: k + 1], equal_nan=True), f"{name}.{f} uses later daily candles"
    assert not np.allclose(base, got, equal_nan=True), f"{name}.{f}: the shock never reaches it"


def op(name, field=None, **params):
    return indicator(B15, Operand(ind=name, field=field, params=params), DAILY)


def test_wma_and_linreg_known_values():
    b = pd.DataFrame({"close": [1.0, 2, 3, 4, 5]})
    w = REGISTRY["wma"].fn(b, {"period": 3}, None, None)
    assert np.isnan(w.iloc[1]) and w.iloc[-1] == pytest.approx((3 * 1 + 4 * 2 + 5 * 3) / 6)
    lin = pd.DataFrame({"close": np.arange(20) * 2.5 + 7})
    assert REGISTRY["linreg"].fn(lin, {"period": 5}, "value", None).iloc[-1] == pytest.approx(lin["close"].iloc[-1])
    assert REGISTRY["linreg"].fn(lin, {"period": 5}, "slope", None).iloc[-1] == pytest.approx(2.5)


@pytest.mark.parametrize("name,field,lo,hi", [
    ("williams_r", None, -100, 0), ("stoch", "k", 0, 100), ("stoch", "d", 0, 100), ("stoch_rsi", "k", 0, 100),
    ("stoch_rsi", "d", 0, 100), ("choppiness", None, 0, 100), ("aroon", "up", 0, 100), ("aroon", "down", 0, 100),
    ("ultimate", None, 0, 100), ("cmo", None, -100, 100), ("efficiency_ratio", None, 0, 1),
    ("percent_rank", None, 0, 100), ("hv_percentile", None, 0, 100), ("squeeze", "on", 0, 1),
])
def test_ranges(name, field, lo, hi):
    v = op(name, field).dropna()
    assert len(v) > 100
    assert ((v >= lo - 1e-9) & (v <= hi + 1e-9)).all(), name


def test_definitions():
    b = B15
    ha_o, ha_c = op("heikin_ashi", "open"), op("heikin_ashi", "close")
    assert np.allclose(ha_c, (b["open"] + b["high"] + b["low"] + b["close"]) / 4)
    assert ha_o.iloc[0] == pytest.approx((b["open"].iloc[0] + b["close"].iloc[0]) / 2)
    assert ha_o.iloc[5] == pytest.approx((ha_o.iloc[4] + ha_c.iloc[4]) / 2)
    assert (op("heikin_ashi", "high") >= op("heikin_ashi", "low")).all()

    # classic pivots / camarilla / CPR on a day from the previous day's H/L/C
    day = b["date"].unique()[10]
    row = b.index[b["date"] == day][3]
    prev = DAILY.loc[b["date"].unique()[9]]
    H, L, C = prev["high"], prev["low"], prev["close"]
    P = (H + L + C) / 3
    assert op("pivots").loc[row] == pytest.approx(P)
    assert op("pivots", "r1").loc[row] == pytest.approx(2 * P - L)
    assert op("pivots", "s2").loc[row] == pytest.approx(P - (H - L))
    assert op("pivots", "r3").loc[row] == pytest.approx(H + 2 * (P - L))
    assert op("camarilla", "r4").loc[row] == pytest.approx(C + 1.1 * (H - L) / 2)
    assert op("camarilla", "s3").loc[row] == pytest.approx(C - 1.1 * (H - L) / 4)
    assert op("cpr", "tc").loc[row] >= op("cpr", "bc").loc[row]
    assert [op("cpr", "bc").loc[row], op("cpr", "tc").loc[row]] == pytest.approx(sorted([(H + L) / 2, 2 * P - (H + L) / 2]))
    assert np.isnan(op("pivots").iloc[0])  # first day has no previous day

    # causal DPO, Ichimoku leads as plotted now, Donchian, oscillators by definition
    sma = b["close"].rolling(21).mean()
    assert np.allclose(op("dpo"), b["close"].shift(11) - sma, equal_nan=True)
    t, k = op("ichimoku", "tenkan"), op("ichimoku", "kijun")
    assert op("ichimoku", "span_a").iloc[200] == pytest.approx((t.iloc[175] + k.iloc[175]) / 2)
    assert op("donchian", "upper").iloc[100] == b["high"].iloc[81:101].max()
    assert np.allclose(op("williams_r") + 100, op("stoch", "k"), equal_nan=True)
    assert np.allclose(op("aroon", "osc"), op("aroon", "up") - op("aroon", "down"), equal_nan=True)
    ppo = op("ppo"), op("ppo", "signal"), op("ppo", "hist")
    assert np.allclose(ppo[0] - ppo[1], ppo[2])
    kama = op("kama").dropna()
    assert kama.between(b["close"].min(), b["close"].max()).all()


def test_psar_follows_a_trend():
    n = 60
    up = pd.DataFrame({"open": np.arange(n) + 100.0, "close": np.arange(n) + 100.5})
    up["high"], up["low"] = up["close"] + 0.2, up["open"] - 0.2
    sar = REGISTRY["psar"].fn(up, {}, "value", None)
    assert (REGISTRY["psar"].fn(up, {}, "direction", None).iloc[1:] == 1).all()
    assert (sar.iloc[1:] < up["low"].iloc[1:]).all()
    down = up[::-1].reset_index(drop=True)
    down[["open", "close"]] = down[["close", "open"]].to_numpy()
    assert (REGISTRY["psar"].fn(down, {}, "direction", None).iloc[2:] == -1).all()


def test_unknown_field_raises():
    with pytest.raises(ValueError):
        op("stoch", "x")


@pytest.mark.parametrize("name", sorted(REGISTRY))
def test_usable_in_rules(name):
    ev = Evaluator(M1, "15m")
    for f in (None, *REGISTRY[name].fields):
        left = Operand(ind=name, field=f, tf="5m")
        rule = Rule(left=left, op=">", right=Operand(ind="value", params={"value": -1e18}))
        out = ev.evaluate(rule)
        assert len(out) == len(ev.base) and out.iloc[-1], f"{name}.{f} undefined at the end"
        assert lookback_minutes(rule, "15m") > 0


def test_catalogue_lists_everything():
    cat = {c["name"]: c for c in catalogue()}
    assert set(cat) == set(REGISTRY)
    assert len(cat) >= 44
    for c in cat.values():
        assert c["description"] and c["category"] in {"Moving averages", "Oscillators", "Trend", "Regime", "Levels", "Volatility"}
