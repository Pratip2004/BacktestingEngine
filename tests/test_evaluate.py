from datetime import date

import pytest

from app.research.evaluate import capital_required, checks, cost_components, evaluate


def leg(action, inst, strike, entry, qty=65, exit=None, expiry="2026-05-05"):
    return {"action": action, "instrument": inst, "strike": strike, "entry": entry, "qty": qty, "exit": exit,
            "exit_at": None, "expiry": expiry}


def test_long_straddle_capital_is_premium():
    t = {"legs": [leg("buy", "CE", 24000, 100), leg("buy", "PE", 24000, 90)], "premium": 190 * 65, "spot_entry": 24010}
    assert capital_required(t) == (190 * 65, "premium")


def test_iron_fly_capital_is_max_loss():
    # sell 24000 straddle for 200, buy 23600 / 24400 wings for 30 + 30: credit 140, width 400 → max loss 260 pts
    legs = [leg("sell", "CE", 24000, 100), leg("sell", "PE", 24000, 100), leg("buy", "CE", 24400, 30), leg("buy", "PE", 23600, 30)]
    t = {"legs": legs, "premium": -140 * 65, "spot_entry": 24000}
    cap, basis = capital_required(t)
    assert basis == "max_loss"
    assert cap == pytest.approx(260 * 65)


def test_naked_short_is_flagged_approx():
    t = {"legs": [leg("sell", "CE", 24000, 100)], "premium": -6500, "spot_entry": 24000}
    cap, basis = capital_required(t)
    assert basis == "approx_margin" and cap > 100000


def test_cost_components_sum_to_engine_costs(fake_store):
    fake_store()
    from app.strategy.engine import DatedCosts
    c = DatedCosts(20, 0.5, True)
    l = {**leg("sell", "CE", 24000, 100.0, exit=80.0), "exit_at": "2026-05-04 15:15"}
    t = {"legs": [l], "entry_at": "2026-05-04 09:20", "exit_at": "2026-05-04 15:15"}
    comp = cost_components([t], 20, 0.5, True)
    engine_costs = c.order(100, 65, False, date(2026, 5, 4)) + c.order(80, 65, True, date(2026, 5, 4))
    assert sum(v for k, v in comp.items() if k != "slippage") == pytest.approx(engine_costs, abs=0.05)
    assert comp["slippage"] == pytest.approx(2 * 0.5 * 65)


def _result(trades, start, end):
    return {"trades": trades, "skipped": [], "params": {"from_date": start.isoformat(), "to_date": end.isoformat(),
            "spec": {"underlying": "NIFTY", "costs": {"brokerage_per_order": 20, "slippage_points": 0.5, "taxes": True}}}}


def _trade(day, net):
    return {"trade_day": day, "entry_at": f"{day} 09:20", "exit_at": f"{day} 15:15", "net": net, "gross": net + 100,
            "costs": 100, "premium": 10000, "spot_entry": 24000,
            "legs": [{**leg("buy", "CE", 24000, 100, exit=101), "exit_at": f"{day} 15:15"}]}


def test_sharpe_counts_idle_days(fake_store, weekdays):
    days = weekdays(date(2026, 5, 4), date(2026, 5, 29))  # 20 weekdays, trade on 2 of them
    fake_store(days)
    ext = evaluate(_result([_trade("2026-05-04", 1000), _trade("2026-05-05", 500)], days[0], days[-1]), 100000)
    assert ext["trading_days"] == 20 and ext["days_traded"] == 2
    assert ext["net_pnl"] == 1500 and ext["return_pct"] == 1.5
    assert len(ext["daily"]) == 20
    assert ext["max_drawdown"] == 0
    # traded-days-only Sharpe would be enormous; over all 20 days it's finite and modest
    assert 0 < ext["sharpe"] < 10


def test_drawdown_and_ex_top5(fake_store, weekdays):
    days = weekdays(date(2026, 5, 4), date(2026, 5, 15))
    fake_store(days)
    pnls = [3000, -1000, -2000, 500, 400, 300, 200, 100, -50, 50]
    trades = [_trade(d.isoformat(), p) for d, p in zip(days, pnls)]
    ext = evaluate(_result(trades, days[0], days[-1]), 100000)
    assert ext["max_drawdown"] == -3000
    assert ext["net_ex_top5"] == pytest.approx(sum(pnls) - (3000 + 500 + 400 + 300 + 200))
    assert ext["top_k"] == 1 and ext["net_ex_top_k"] == pytest.approx(sum(pnls) - 3000)
    assert ext["worst_day"] == -2000 and ext["worst_day_pct"] == -2.0
    assert ext["longest_losing_streak"] == 2


def test_t_stat_bar_rises_with_program_looks():
    ext = {"net_pnl": 1, "trades": 100, "profit_factor": 2, "t_stat": 2.1, "worst_day_pct": -5, "fits_capital": True,
           "peak_capital_required": 1, "net_ex_top_k": 1, "top_k": 5}
    assert all(c["pass"] for c in checks(ext, {}, 1))
    t_check = next(c for c in checks(ext, {}, 50) if "t-stat" in c["name"])
    assert not t_check["pass"]  # √(2 ln 50) ≈ 2.80


def test_block_bootstrap_shape():
    import numpy as np
    from app.research.evaluate import _block_bootstrap
    out = _block_bootstrap(np.arange(12, dtype=float), np.random.default_rng(1), n=50)
    assert out.shape == (50,)


def test_experiment_gates_need_both_halves_positive():
    from app.research.evaluate import experiment_gates
    r = lambda n: {"ext": {"net_pnl": n}}  # noqa: E731
    g = experiment_gates({"half_a": r(100), "half_b": r(-5), "stress_2x": r(10)})
    assert [x["pass"] for x in g] == [False, True]


def test_short_straddle_margin_is_far_above_premium():
    from app.strategy.margin import margin_required
    legs = [leg("sell", "CE", 24000, 156.85, qty=75), leg("sell", "PE", 24000, 150, qty=75)]
    m, basis = margin_required(legs, -(156.85 + 150) * 75, 24000)
    assert basis == "approx_margin"
    assert m == pytest.approx(0.13 * 24000 * 75)  # ≈ ₹2.34 lakh, vs ₹23k premium received
    assert m > 10 * (156.85 + 150) * 75 / 2


def test_margin_parser_finds_nested_numbers():
    from app.routers.market import _numbers
    nums = _numbers({"margin_calulation": [{"span_margin_required": "180000.5", "x": "n/a"}], "total": 2})
    assert nums == {"margin_calulation.0.span_margin_required": 180000.5, "total": 2.0}


def test_futures_margin_is_a_share_of_contract_value_not_notional():
    from app.strategy.margin import margin_required
    legs = [{"action": "buy", "instrument": "FUT", "strike": 0, "entry": 25000.0, "qty": 65, "expiry": "2026-10-27"}]
    m, basis = margin_required(legs, 25000.0 * 65, 25000)
    assert basis == "approx_margin" and round(m) == round(0.12 * 25000 * 65)
    # a protective put bought with the future adds its premium
    legs.append({"action": "buy", "instrument": "PE", "strike": 24500, "entry": 100.0, "qty": 65, "expiry": "2026-10-27"})
    m2, _ = margin_required(legs, 25000.0 * 65 + 100 * 65, 25000)
    assert round(m2) == round(0.12 * 25000 * 65 + 100 * 65)
