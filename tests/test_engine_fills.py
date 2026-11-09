"""Intrabar exits on synthetic candles: fills stay inside each leg's own candle; missing minutes don't create
ghost highs/lows (audit AUD-1 findings 2, 3 and 11)."""

from datetime import date

import pandas as pd
import pytest

from app.strategy.engine import TICK, Engine, LegState, Trade
from app.strategy.spec import StrategySpec, legs_for

DAY = date(2026, 5, 4)


def bars(rows):
    """rows: [(HH:MM, o, h, l, c)]"""
    return pd.DataFrame([{"datetime": pd.Timestamp(f"{DAY} {t}"), "open": o, "high": h, "low": lo, "close": c} for t, o, h, lo, c in rows])


def engine(exits):
    spec = StrategySpec.model_validate({"name": "t", "lot_size": 65, "position": {"legs": [
        {"id": "ce", "action": "sell", "instrument": "CE"}, {"id": "pe", "action": "sell", "instrument": "PE"}]},
        "exits": {"square_off": "09:25", **exits}, "costs": {"brokerage_per_order": 0, "slippage_points": 0.5, "taxes": False}})
    eng = Engine(spec, DAY, DAY, lambda *a: None)
    eng.exit_signals, eng.opposite = [], {"bullish": [], "bearish": []}  # normally set by _signals()
    return eng, spec


def trade(eng, spec, ce, pe):
    legs = [LegState(l, -1, 24000, DAY, 65, b) for l, b in zip(legs_for(spec, None), (ce, pe))]
    for leg in legs:
        leg.entry, leg.slip_pts = float(leg.bars["open"].iloc[0]) - 0.5, 0.5
        leg.entry_at = leg.bars["datetime"].iloc[0]
    premium = sum(l.side * l.qty * l.entry for l in legs)
    return Trade(DAY, None, 0, legs[0].entry_at, 24000, 24000, legs, premium, 0.0)


def test_combined_stop_fills_inside_each_legs_candle(fake_store):
    fake_store()
    eng, spec = engine({"combined": {"stop": {"unit": "pct", "value": 20}}})
    # Short straddle collects ~199.5; 20% stop ≈ ₹2593. At 09:21 CE spikes 100 → 160, PE drops 100 → 80.
    ce = bars([("09:20", 100, 101, 99, 100), ("09:21", 100, 160, 99, 150), ("09:22", 150, 151, 149, 150), ("09:25", 150, 150, 150, 150)])
    pe = bars([("09:20", 100, 101, 99, 100), ("09:21", 100, 101, 80, 85), ("09:22", 85, 86, 84, 85), ("09:25", 85, 85, 85, 85)])
    t = trade(eng, spec, ce, pe)
    assert eng._manage(t) and t.reason == "stop"
    for leg, b in zip(t.legs, (ce, pe)):
        row = b[b["datetime"] == leg.exit_at].iloc[0]
        raw = leg.exit - leg.slip_pts  # short: bought back at price + slippage
        assert row["low"] - 1e-6 <= raw <= row["high"] + 1e-6
    assert t.gross == pytest.approx(-0.2 * abs(t.premium) - 2 * 0.5 * 65, abs=1)  # stop level, then slippage


def test_combined_target_pays_slippage(fake_store):
    fake_store()
    eng, spec = engine({"combined": {"target": {"unit": "pct", "value": 5}}})
    ce = bars([("09:20", 100, 101, 99, 100), ("09:21", 100, 100, 80, 85), ("09:25", 85, 85, 85, 85)])
    pe = bars([("09:20", 100, 101, 99, 100), ("09:21", 100, 100, 90, 92), ("09:25", 92, 92, 92, 92)])
    t = trade(eng, spec, ce, pe)
    assert eng._manage(t) and t.reason == "target"
    assert all(l.slip_pts == pytest.approx(1.0) for l in t.legs)  # 0.5 in, 0.5 out
    assert t.gross == pytest.approx(0.05 * abs(t.premium) - 2 * 0.5 * 65, abs=1)


def test_missing_minute_has_no_ghost_extremes(fake_store):
    fake_store()
    eng, spec = engine({"combined": {"stop": {"unit": "pct", "value": 20}}})
    # CE's 09:20 candle has a high of 125; it then doesn't trade at 09:21–09:22. The old forward-fill repeated that
    # high next to PE's new candles and could stop the trade on prices that never coexisted.
    ce = bars([("09:20", 100, 125, 99, 100), ("09:25", 100, 100, 100, 100)])
    pe = bars([("09:20", 100, 101, 99, 100), ("09:21", 100, 101, 99, 100), ("09:22", 100, 101, 99, 100), ("09:25", 100, 100, 100, 100)])
    t = trade(eng, spec, ce, pe)
    assert eng._manage(t)
    assert t.reason == "time"


def test_fills_never_below_a_tick(fake_store):
    fake_store()
    eng, spec = engine({})
    ce = bars([("09:20", 0.3, 0.3, 0.3, 0.3), ("09:25", 0.3, 0.3, 0.3, 0.3)])
    pe = bars([("09:20", 0.3, 0.3, 0.3, 0.3), ("09:25", 0.3, 0.3, 0.3, 0.3)])
    t = trade(eng, spec, ce, pe)
    for leg in t.legs:
        leg.side = 1  # long legs: exit = 0.3 − 0.5 would be negative
    assert eng._manage(t)
    assert all(l.exit >= TICK for l in t.legs)
