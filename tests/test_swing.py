"""Swing (multi-day) engine on synthetic candles: hold across days, overnight gap through an underlying stop,
exit before expiry, futures costs, daily mark-to-market summing to net."""

from datetime import date

import pandas as pd
import pytest

from app.strategy.engine import DatedCosts, LegState, Trade
from app.strategy.spec import StrategySpec, legs_for
from app.strategy.swing import SwingEngine

DAYS = [date(2026, 5, 4), date(2026, 5, 5), date(2026, 5, 6), date(2026, 5, 7), date(2026, 5, 8)]


def minutes(d: date, start: float, end: float, gap_open: float | None = None) -> pd.DataFrame:
    """375 one-minute candles moving linearly from start to end (optionally opening at gap_open)."""
    rows, n = [], 375
    for i in range(n):
        o = start + (end - start) * i / n
        c = start + (end - start) * (i + 1) / n
        if i == 0 and gap_open is not None:
            o = gap_open
        rows.append({"datetime": pd.Timestamp(f"{d} 09:15") + pd.Timedelta(minutes=i), "open": o,
                     "high": max(o, c) + 0.5, "low": min(o, c) - 0.5, "close": c})
    return pd.DataFrame(rows)


def engine(spec: dict, spot: dict[date, pd.DataFrame], legs: dict[tuple, dict[date, pd.DataFrame]]):
    s = StrategySpec.model_validate({"name": "t", "lot_size": 65, "costs": {"brokerage_per_order": 20, "slippage_points": 0.5,
                                                                            "fut_slippage_points": 1, "taxes": True}, **spec})
    eng = SwingEngine(s, DAYS[0], DAYS[-1], lambda *a: None)
    eng.trading_days, eng.trade_days = DAYS, [(d, 0) for d in DAYS]
    eng.exit_signals, eng.opposite = [], {"bullish": [], "bearish": []}
    eng._spot = dict(spot)
    eng._bars = lambda leg, expiry, strike, days: pd.concat(  # noqa: E731
        [legs[leg.id][d] for d in days if d in legs[leg.id]] or [pd.DataFrame(columns=["datetime", "open", "high", "low", "close"])],
        ignore_index=True)
    return eng, s


def open_trade(eng, s, entry_px: dict[str, float], direction=None, expiry=DAYS[-1]):
    legs = []
    for l in legs_for(s, direction):
        side = 1 if l.action == "buy" else -1
        leg = LegState(l, side, None if l.instrument == "FUT" else 24000, expiry, 65, eng._bars(l, expiry, None, [DAYS[0]]))
        leg.entry = entry_px[l.id] + side * eng.costs.slip(l)
        leg.slip_pts, leg.entry_at = abs(leg.entry - entry_px[l.id]), pd.Timestamp(f"{DAYS[0]} 09:20")
        legs.append(leg)
    premium = sum(l.side * l.qty * l.entry for l in legs)
    cost = sum(eng.costs.order(l.entry, l.qty, l.side > 0, DAYS[0], l.spec.instrument == "FUT") for l in legs)
    return Trade(DAYS[0], direction, 0, pd.Timestamp(f"{DAYS[0]} 09:20"), 24000, 24000, legs, premium, cost)


FUT = {"position": {"legs": [{"id": "fut", "action": "buy", "instrument": "FUT", "expiry": {"by": "monthly"}}]}}


def test_held_to_max_days_with_daily_mtm(fake_store):
    fake_store()
    spot = {d: minutes(d, 24000 + 10 * i, 24010 + 10 * i) for i, d in enumerate(DAYS)}
    fut = {"fut": {d: minutes(d, 24050 + 10 * i, 24060 + 10 * i) for i, d in enumerate(DAYS)}}
    eng, s = engine({**FUT, "holding": {"mode": "swing", "max_days": 3, "exit_time": "15:00", "check": "30m"},
                     "exits": {"spot_move_points": 5000}}, spot, fut)
    t = open_trade(eng, s, {"fut": 24050})
    assert eng._manage_swing(t)
    assert t.reason == "time" and t.exit_at == pd.Timestamp(f"{DAYS[2]} 15:00")
    assert [m["d"] for m in t.daily_mtm] == [d.isoformat() for d in DAYS[:3]]
    assert sum(m["pnl"] for m in t.daily_mtm) == pytest.approx(t.net, abs=0.05)
    # Futures legs pay futures slippage (1 point) and futures rates.
    leg = t.legs[0]
    assert leg.slip_pts == pytest.approx(2.0)
    assert t.exit_cost == pytest.approx(DatedCosts(20, 0.5, True, 1).order(leg.exit, 65, False, DAYS[2], fut=True))


def test_overnight_gap_fills_underlying_stop_at_the_open(fake_store):
    fake_store()
    spot = {DAYS[0]: minutes(DAYS[0], 24000, 24000), DAYS[1]: minutes(DAYS[1], 23700, 23650, gap_open=23700)}
    fut = {"fut": {DAYS[0]: minutes(DAYS[0], 24050, 24050), DAYS[1]: minutes(DAYS[1], 23750, 23700, gap_open=23750)}}
    eng, s = engine({**FUT, "holding": {"mode": "swing", "max_days": 5},
                     "exits": {"underlying_stop": {"points": 100, "atr_mult": None}}}, spot, fut)
    t = open_trade(eng, s, {"fut": 24050})
    assert eng._manage_swing(t)
    assert t.reason == "underlying_stop"
    assert t.exit_at == pd.Timestamp(f"{DAYS[1]} 09:15")  # the gapped open, not 100 points below entry
    assert t.legs[0].exit == pytest.approx(23750 - 1)  # leg's open minus futures slippage
    assert len(t.daily_mtm) == 2 and sum(m["pnl"] for m in t.daily_mtm) == pytest.approx(t.net, abs=0.05)


def test_intraday_underlying_stop_fills_next_minute(fake_store):
    fake_store()
    spot = {DAYS[0]: minutes(DAYS[0], 24000, 23800)}
    fut = {"fut": {DAYS[0]: minutes(DAYS[0], 24050, 23850)}}
    eng, s = engine({**FUT, "holding": {"mode": "swing", "max_days": 5, "check": "1d"},
                     "exits": {"underlying_stop": {"points": 100, "atr_mult": None}}}, spot, fut)
    t = open_trade(eng, s, {"fut": 24050})
    assert eng._manage_swing(t) and t.reason == "underlying_stop"
    m = spot[DAYS[0]]
    first = m[(m["datetime"] >= t.entry_at) & (m["low"] <= 23900)]["datetime"].iloc[0]
    assert t.exit_at == first + pd.Timedelta(minutes=1)


def test_trailing_underlying_stop_follows_the_best_price(fake_store):
    fake_store()
    spot = {DAYS[0]: minutes(DAYS[0], 24000, 24300), DAYS[1]: minutes(DAYS[1], 24300, 24100)}
    fut = {"fut": {d: m.assign(**{c: m[c] + 50 for c in ("open", "high", "low", "close")}) for d, m in spot.items()}}
    eng, s = engine({**FUT, "holding": {"mode": "swing", "max_days": 5, "check": "1d"},
                     "exits": {"underlying_stop": {"points": 100, "atr_mult": None, "trail": True}}}, spot, fut)
    t = open_trade(eng, s, {"fut": 24050})
    assert eng._manage_swing(t) and t.reason == "underlying_stop"
    assert t.exit_at.date() == DAYS[1] and t.net > 0  # trailed up from 24000 to ~24200: exits with a profit


def test_option_spread_closed_before_expiry(fake_store):
    fake_store()
    spot = {d: minutes(d, 24000, 24000) for d in DAYS}
    legs = {"long": {d: minutes(d, 120 - 5 * i, 115 - 5 * i) for i, d in enumerate(DAYS)},
            "short": {d: minutes(d, 60 - 3 * i, 57 - 3 * i) for i, d in enumerate(DAYS)}}
    eng, s = engine({"position": {"legs": [{"id": "long", "action": "buy", "instrument": "CE"},
                                           {"id": "short", "action": "sell", "instrument": "CE", "strike": {"by": "atm_offset", "value": 4}}]},
                     "holding": {"mode": "swing", "max_days": 10, "exit_before_expiry": 1, "exit_time": "15:10"}}, spot, legs)
    t = open_trade(eng, s, {"long": 120, "short": 60}, expiry=DAYS[3])
    assert eng._manage_swing(t)
    assert t.reason == "expiry" and t.exit_at == pd.Timestamp(f"{DAYS[2]} 15:10")  # one trading day before expiry


def test_combined_stop_across_days(fake_store):
    fake_store()
    spot = {d: minutes(d, 24000, 24000) for d in DAYS}
    legs = {"long": {d: minutes(d, 100 - 20 * i, 80 - 20 * i) for i, d in enumerate(DAYS)},
            "short": {d: minutes(d, 50 - 5 * i, 45 - 5 * i) for i, d in enumerate(DAYS)}}
    eng, s = engine({"position": {"legs": [{"id": "long", "action": "buy", "instrument": "CE"},
                                           {"id": "short", "action": "sell", "instrument": "CE", "strike": {"by": "atm_offset", "value": 4}}]},
                     "holding": {"mode": "swing", "max_days": 5, "check": "60m"},
                     "exits": {"combined": {"stop": {"unit": "pct", "value": 50}}}}, spot, legs)
    t = open_trade(eng, s, {"long": 100, "short": 50})
    assert eng._manage_swing(t) and t.reason == "stop"
    assert t.exit_at.date() > DAYS[0]  # survived day 1, stopped later
    assert t.gross <= -0.5 * abs(t.premium)


def test_validation_rules():
    from app.strategy.spec import validate_spec
    naked = StrategySpec.model_validate({"position": {"legs": [{"id": "ce", "action": "sell", "instrument": "CE"}]},
                                         "holding": {"mode": "swing"}})
    assert any("protective" in e for e in validate_spec(naked)[0])
    fut = StrategySpec.model_validate({**FUT, "holding": {"mode": "swing"}})
    assert any("need a stop" in e for e in validate_spec(fut)[0])
    times = StrategySpec.model_validate({"position": {"legs": [{"id": "ce", "action": "buy", "instrument": "CE"}]},
                                         "schedule": {"entry": {"times": ["09:20", "11:00"]}, "max_trades_per_day": 1}})
    errs, warns = validate_spec(times)
    assert not errs and any("2 entry times" in w for w in warns)


def test_daily_exit_signal_acts_next_morning(fake_store):
    fake_store()
    spot = {d: minutes(d, 24000, 24000) for d in DAYS}
    fut = {"fut": {d: minutes(d, 24050 + 10 * i, 24060 + 10 * i) for i, d in enumerate(DAYS)}}
    eng, s = engine({**FUT, "timeframe": "1d", "holding": {"mode": "swing", "max_days": 5},
                     "schedule": {"entry": {"type": "signal", "next_day_time": "09:20", "signal": {
                         "left": {"ind": "price"}, "op": ">", "right": {"ind": "value", "params": {"value": 0}}}}},
                     "exits": {"spot_move_points": 5000, "exit_signal": {"left": {"ind": "price"}, "op": ">",
                                                                         "right": {"ind": "value", "params": {"value": 0}}}}}, spot, fut)
    eng.exit_signals = [pd.Timestamp(f"{DAYS[1]} 15:30")]  # known after day 2's close
    t = open_trade(eng, s, {"fut": 24050})
    assert eng._manage_swing(t) and t.reason == "signal"
    assert t.exit_at.date() == DAYS[2] and t.exit_at.strftime("%H:%M") >= "09:20"


def test_monthly_expiry_ignores_holiday_shifted_weekly():
    from app.data.ingest import _monthly
    weekly = [date(2025, 4, 17), date(2025, 4, 24), date(2025, 4, 30), date(2025, 5, 8), date(2025, 5, 29)]
    assert _monthly(weekly) == [date(2025, 4, 24), date(2025, 5, 29)]  # 30 Apr is the 1 May weekly, moved for a holiday


def test_daily_exit_signal_acts_next_morning_with_daily_checks(fake_store):
    """check "1d" mustn't push a daily-signal exit (acting at next_day_time) to that day's close."""
    fake_store()
    spot = {d: minutes(d, 24000, 24000) for d in DAYS}
    fut = {d: minutes(d, 24000 + 100 * i, 24100 + 100 * i) for i, d in enumerate(DAYS)}
    spec = {**FUT, "timeframe": "1d", "holding": {"mode": "swing", "max_days": 5, "check": "1d"},
            "exits": {"spot_move_points": 5000}}
    eng, s = engine(spec, spot, {"fut": fut})
    trade = open_trade(eng, s, {"fut": 24000})
    eng._exit_triggers = lambda t: [(pd.Timestamp(f"{DAYS[2]} 09:20"), "signal")]
    eng._manage_swing(trade)
    assert trade.reason == "signal" and trade.exit_at == pd.Timestamp(f"{DAYS[2]} 09:20")


def test_daily_atr_for_stops_covers_the_whole_period(monkeypatch):
    """Daily ATR must be computed up to each trade, not frozen at the period's first day (bug until engine 6)."""
    import app.strategy.engine as eng_mod
    seen = {}

    class FakeEval:
        def __init__(self, m1, tf, underlying):
            seen["days"] = sorted({t.date() for t in m1["datetime"]})

        def operand(self, op):
            return pd.Series([100.0], index=[pd.Timestamp(f"{DAYS[-1]} 15:30")])

    monkeypatch.setattr(eng_mod, "Evaluator", FakeEval)
    e = SwingEngine.__new__(SwingEngine)
    e.trading_days, e.trade_days = DAYS, [(d, 0) for d in DAYS]
    e.spot = lambda d: minutes(d, 24000, 24000)
    e._signal_end = lambda: DAYS[-1]
    e.u = type("U", (), {"stock_code": "NIFTY"})()
    e._atr_at(pd.Timestamp(f"{DAYS[-1]} 15:31"), "1d", 14)
    assert seen["days"][0] == DAYS[0] and seen["days"][-1] == DAYS[-1]
