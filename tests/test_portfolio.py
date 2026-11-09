"""Portfolios: gates are ANDed into each member's entry, members combine by daily P&L, concurrency and
correlation are measured across members."""

from datetime import date

import pytest

import app.strategy.portfolio as pf

LEGS = {"legs": [{"id": "ce", "action": "buy", "instrument": "CE"}]}
GATE = {"left": {"ind": "regime", "params": {"model": "trend_vol"}, "tf": "1d"}, "op": "==", "right": {"ind": "value", "params": {"value": 1}}}


def trade(day, entry, exit_, net, margin=10000, mtm=None):
    t = {"trade_day": day, "weekday": 0, "direction": None, "dte": 0, "entry_at": f"{day} {entry}", "exit_at": exit_,
         "net": net, "gross": net + 50, "costs": 50, "capital": 5000, "margin": margin, "reason": "time",
         "stale_fills": 0, "legs": [{}]}
    if mtm:
        t["daily_mtm"] = mtm
    return t


def test_gate_goes_into_time_filter_and_each_signal():
    time_spec = {"schedule": {"entry": {"type": "time", "filter": {"left": {"ind": "rsi"}, "op": "<", "right": {"ind": "value"}}}}}
    out = pf.gated_spec(time_spec, GATE)
    assert out["schedule"]["entry"]["filter"]["all"][1] == GATE
    sig = {"schedule": {"entry": {"type": "signal", "bullish": {"left": {"ind": "rsi"}, "op": ">", "right": {"ind": "value"}},
                                  "bearish": None}}}
    out = pf.gated_spec(sig, GATE)
    assert out["schedule"]["entry"]["bullish"]["all"][1] == GATE and out["schedule"]["entry"]["bearish"] is None
    assert "all" not in str(sig)  # the original isn't modified


def test_resolve_applies_lots_and_skips_disabled():
    p = pf.PortfolioSpec.model_validate({"members": [
        {"id": "a", "spec": {"position": LEGS, "lots": 2}, "lots": 3, "gate": GATE},
        {"id": "b", "spec": {"position": LEGS}, "enabled": False}]})
    ms = pf.resolve(p)
    assert [m["id"] for m in ms] == ["a"] and ms[0]["spec"]["lots"] == 6
    assert ms[0]["spec"]["schedule"]["entry"]["filter"]["left"]["ind"] == "regime"


def test_member_needs_one_source():
    with pytest.raises(Exception):
        pf.PortfolioSpec.model_validate({"members": [{"id": "a"}]})
    with pytest.raises(Exception):
        pf.PortfolioSpec.model_validate({"members": [{"id": "a", "spec": {"position": LEGS}}, {"id": "a", "spec": {"position": LEGS}}]})


def test_concurrency_counts_overlaps():
    ts = [trade("2026-05-04", "09:20", "2026-05-06 15:20", 0, 100),
          trade("2026-05-05", "10:00", "2026-05-05 11:00", 0, 50),
          trade("2026-05-05", "11:00", "2026-05-05 12:00", 0, 70)]  # starts the minute the second one exits
    assert pf._concurrency(ts) == (2, 170)


def test_run_combines_members_by_day(monkeypatch):
    fake = {
        "trend": [trade("2026-05-04", "09:20", "2026-05-06 15:20", 300,
                        mtm=[{"d": "2026-05-04", "pnl": -200}, {"d": "2026-05-05", "pnl": 100}, {"d": "2026-05-06", "pnl": 400}])],
        "range": [trade("2026-05-05", "09:30", "2026-05-05 15:00", -100), trade("2026-05-07", "09:30", "2026-05-07 15:00", 250)],
    }

    def run_strategy(spec, a, b, progress):
        trades = fake[spec["name"]]
        return {"trades": trades, "metrics": pf._metrics(trades, 5), "trade_days": 5}

    monkeypatch.setattr(pf, "run_strategy", run_strategy)
    monkeypatch.setattr(pf, "_regimes", lambda *a: {"2026-05-04": 1, "2026-05-05": 3, "2026-05-07": 3})
    import app.research.evaluate as ev
    monkeypatch.setattr(ev, "trading_days", lambda u, a, b: [date(2026, 5, d) for d in range(4, 9)])
    out = pf.run_portfolio({"capital": 100000, "members": [
        {"id": "trend", "spec": {"name": "trend", "position": LEGS}},
        {"id": "range", "spec": {"name": "range", "position": LEGS}}]}, date(2026, 5, 4), date(2026, 5, 8))
    m = out["metrics"]
    assert m["net_pnl"] == 450 and m["trades"] == 3
    assert [d["pnl"] for d in out["daily"]] == [-200, 0, 400, 250]  # 5 May: +100 trend, −100 range
    assert m["max_drawdown"] == -200 and m["return_pct"] == 0.45
    assert out["equity"][-1] == {"d": "2026-05-07", "total": 450, "trend": 300, "range": 150}
    assert m["peak_open_positions"] == 2
    assert {x["id"]: x["contribution_pct"] for x in out["members"]} == {"trend": 66.7, "range": 33.3}
    assert out["by_regime"]["trades"]["3"]["range"]["trades"] == 2
    assert out["correlation"]["trend"]["trend"] == 1.0
    assert out["monthly"]["2026-05"] == {"trend": 300, "range": 150}


def test_member_error_doesnt_sink_the_portfolio(monkeypatch):
    from fastapi import HTTPException

    def run_strategy(spec, a, b, progress):
        if spec["name"] == "bad":
            raise HTTPException(404, "No data")
        t = [trade("2026-05-04", "09:20", "2026-05-04 15:00", 100)]
        return {"trades": t, "metrics": pf._metrics(t, 1), "trade_days": 1}

    monkeypatch.setattr(pf, "run_strategy", run_strategy)
    monkeypatch.setattr(pf, "_regimes", lambda *a: None)
    out = pf.run_portfolio({"members": [{"id": "ok", "spec": {"name": "ok", "position": LEGS}},
                                        {"id": "bad", "spec": {"name": "bad", "position": LEGS}}]}, date(2026, 5, 4), date(2026, 5, 4))
    assert out["metrics"]["net_pnl"] == 100
    assert next(x for x in out["members"] if x["id"] == "bad")["error"] == "No data"
