from datetime import date, timedelta

from app.research.playbook import gate_for, quarters, walk_forward


def _trade(d: date, net: float) -> dict:
    s = d.isoformat()
    return {"entry_at": f"{s} 09:20:00", "exit_at": f"{s} 15:20:00", "trade_day": s, "net": net}


def _days(a: date, b: date):
    d = a
    while d <= b:
        if d.weekday() < 5:
            yield d
        d += timedelta(days=1)


def test_quarters_cover_the_range():
    q = quarters(date(2024, 2, 10), date(2024, 12, 31))
    assert q[0] == (date(2024, 2, 10), date(2024, 3, 31)) and q[-1] == (date(2024, 10, 1), date(2024, 12, 31)) and len(q) == 4


def test_walk_forward_picks_per_regime_from_the_past_only():
    days = list(_days(date(2023, 1, 2), date(2024, 12, 31)))
    regime = {d.isoformat(): (1 if d.month % 2 else 3) for d in days}  # alternate regimes by month
    # A wins in regime 1, loses in 3; B the reverse. In 2024-Q3 the pattern breaks for A (a future the
    # selection mustn't see: A is still chosen for regime 1 in Q3 because Q3's results aren't known yet).
    a = [_trade(d, (100 if regime[d.isoformat()] == 1 else -100) * (-1 if date(2024, 7, 1) <= d <= date(2024, 9, 30) else 1) + (d.day % 3 - 1))
         for d in days]
    b = [_trade(d, (100 if regime[d.isoformat()] == 3 else -100) + (d.day % 3 - 1)) for d in days]
    res = walk_forward([{"id": "A", "trades": a}, {"id": "B", "trades": b}], regime, date(2024, 1, 1), date(2024, 12, 31))
    q3 = next(f for f in res["quarters"] if f["from"] == "2024-07-01")
    assert q3["choice"] == {"1": ["A"], "3": ["B"]}
    assert q3["test"]["net"] < res["quarters"][0]["test"]["net"]  # A's break shows up out of sample
    assert all(t["regime"] == (1 if t["candidate"] == "A" else 3) for t in res["trades"])


def test_gate_for_many_codes():
    g = gate_for([1, 3])
    assert "any" in g and g["any"][1]["right"]["params"]["value"] == 3
