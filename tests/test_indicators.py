"""New indicators: sane values and no use of the current day's data in day-level ones."""

import numpy as np
import pandas as pd

from app.strategy.signals import Evaluator, _daily, indicator, resample
from app.strategy.spec import Operand


def minutes(days=30, seed=0):
    rng = np.random.default_rng(seed)
    out = []
    price = 24000.0
    for d in pd.bdate_range("2026-03-02", periods=days):
        for m in range(375):
            o = price
            price *= 1 + rng.normal(0, 0.0004)
            out.append({"datetime": d + pd.Timedelta(minutes=9 * 60 + 15 + m), "open": o, "high": max(o, price) + 1,
                        "low": min(o, price) - 1, "close": price})
    return pd.DataFrame(out)


def test_ranges_and_definitions():
    m1 = minutes()
    b, daily = resample(m1, "15m"), _daily(m1)
    adx = indicator(b, Operand(ind="adx"), daily).dropna()
    assert ((adx >= 0) & (adx <= 100)).all()
    bw = indicator(b, Operand(ind="bb_width"), daily).dropna()
    assert (bw > 0).all()
    chg = indicator(b, Operand(ind="chg_pct"), daily)
    first = b.index[b["date"] == b["date"].iloc[-1]][0]
    prev_close = daily["close"].iloc[-2]
    assert chg.loc[first] == (b.loc[first, "close"] - prev_close) / prev_close * 100


def test_daily_indicators_use_only_past_days():
    m1 = minutes()
    shocked = m1.copy()
    last = shocked["datetime"].dt.date == shocked["datetime"].dt.date.iloc[-1]
    shocked.loc[last, ["open", "high", "low", "close"]] *= 1.10  # today's prices change a lot
    for ind in ("hv", "prev_range_pct"):
        a = indicator(resample(m1, "15m"), Operand(ind=ind), _daily(m1))
        b = indicator(resample(shocked, "15m"), Operand(ind=ind), _daily(shocked))
        assert np.allclose(a.to_numpy(), b.to_numpy(), equal_nan=True), ind


def test_filter_condition_evaluates():
    m1 = minutes()
    ev = Evaluator(m1, "15m")
    cond = {"left": {"ind": "hv", "params": {"period": 10}}, "op": "<", "right": {"ind": "value", "params": {"value": 1000}}}
    from app.strategy.spec import Rule
    out = ev.evaluate(Rule.model_validate(cond))
    assert out.iloc[-1]  # defined after warm-up and true for a huge threshold


def test_weekly_candles_close_at_week_end(monkeypatch):
    import app.data.daily as dd
    from app.strategy.signals import daily_candles
    days = pd.bdate_range("2026-03-02", periods=10)
    fake = pd.DataFrame({"d": days.date, "open": range(10), "high": range(1, 11), "low": range(10),
                         "close": range(10), "volume": 0.0})
    monkeypatch.setattr(dd, "daily_bars", lambda name, a, b: fake)
    w = daily_candles("NIFTY", days[0].date(), days[-1].date(), "1w")
    assert len(w) == 2
    assert str(w["close_time"].iloc[0]) == "2026-03-06 15:30:00"  # known only after Friday's close
    assert w["close"].iloc[0] == 4 and w["high"].iloc[0] == 5


def test_vote_group_counts_conditions():
    import pandas as pd
    from app.strategy.spec import Group
    from app.strategy.signals import Evaluator
    t = pd.date_range("2025-01-06 09:15", periods=60, freq="1min")
    m1 = pd.DataFrame({"datetime": t, "open": range(60), "high": range(1, 61), "low": range(60), "close": range(1, 61)})
    ev = Evaluator(m1, "5m")
    above = lambda v: {"left": {"ind": "price"}, "op": ">", "right": {"ind": "value", "params": {"value": v}}}
    g = Group.model_validate({"any": [above(10), above(20), above(30)], "min": 2})
    out = ev.evaluate(g)
    closes = ev.base["close"]
    assert list(out) == list((closes > 20))  # at least 2 of (>10, >20, >30) ⇔ > 20
