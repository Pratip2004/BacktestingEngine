"""Walk-forward regime playbook: does "trade the algo that suits the current market cycle" work out of sample?

Every candidate strategy is run ungated over the whole period, and each trade is tagged with the regime known
before it was entered (the previous session's close label, app/strategy/regimes.py). Then, quarter by quarter:

  1. train on every trade that had *closed* before the quarter starts (expanding window, nothing from the future)
  2. for each regime, choose the candidate(s) whose training trades in that regime qualify (enough trades,
     positive total, mean per trade with a t-stat above `min_t`, profit factor above `min_pf`), best score first,
     up to `per_regime`; a regime with none qualifying is "stand aside"
  3. in the quarter, take each chosen candidate's trades entered in the regime it was chosen for

The stitched test quarters are the out-of-sample answer. Baselines over the same test window: each candidate
always on, all candidates always on, and each candidate gated on its best *in-hindsight* regimes (an upper bound
the walk-forward is not allowed to see).

Approximation: candidates hold one position at a time, so an ungated trade in a skipped regime can block one a
gated version would have taken. confirm() reruns the chosen mapping as real regime-gated portfolios, one per test
quarter, through the engine to check that this doesn't matter.

Trades are the engine's trade dicts (entry_at, trade_day, net, daily_mtm, exit_at); a candidate is
{"id", "name", "trades", "spec"?}.
"""

from __future__ import annotations

import math
from datetime import date, timedelta

import numpy as np

REGIME_OPERAND = {"ind": "regime", "tf": "1d"}


def regime_before_day(underlying: str, start: date, end: date, model: str = "trend_vol") -> dict[str, int]:
    """{"YYYY-MM-DD": code known before that day's open (the previous session's close label)}."""
    from app.data.instruments import underlying as get_underlying
    from app.strategy.regimes import regime_series
    from app.strategy.signals import daily_candles
    code = get_underlying(underlying).stock_code
    daily = daily_candles(code, start - timedelta(days=10), end)
    codes = regime_series(daily, daily_candles(code, start - timedelta(days=10), end, symbol="INDVIX"), model)
    out, prev = {}, None
    for d, v in zip(daily["date"], codes):
        if prev is not None:
            out[d.isoformat()] = prev
        prev = None if v != v else int(v)
    return out


def quarters(start: date, end: date) -> list[tuple[date, date]]:
    out, y, q = [], start.year, (start.month - 1) // 3
    while True:
        a = date(y, q * 3 + 1, 1)
        b = (date(y + (q == 3), (q * 3 + 3) % 12 + 1, 1)) - timedelta(days=1)
        if a > end:
            return out
        out.append((max(a, start), min(b, end)))
        y, q = (y + 1, 0) if q == 3 else (y, q + 1)


def _stats(nets: list[float]) -> dict:
    n = len(nets)
    total = float(sum(nets))
    mean = total / n if n else 0.0
    sd = float(np.std(nets, ddof=1)) if n > 1 else 0.0
    wins, losses = sum(x for x in nets if x > 0), -sum(x for x in nets if x <= 0)
    return {"trades": n, "net": round(total, 2), "mean": round(mean, 2),
            "t": round(mean / (sd / math.sqrt(n)), 2) if sd and n > 1 else None,
            "pf": round(wins / losses, 2) if losses > 0 else None,
            "win_rate": round(sum(1 for x in nets if x > 0) / n * 100, 1) if n else None}


def _qualifies(s: dict, min_trades: int, min_t: float, min_pf: float) -> bool:
    pf_ok = s["pf"] is None or s["pf"] >= min_pf  # None with a positive total = no losing trade
    return s["trades"] >= min_trades and s["net"] > 0 and (s["t"] or 0) >= min_t and pf_ok


def _exit_day(t: dict) -> str:
    return (t.get("exit_at") or t["entry_at"])[:10]


def tag(candidates: list[dict], regime: dict[str, int]) -> None:
    for c in candidates:
        for t in c["trades"]:
            t["regime"] = regime.get(t["entry_at"][:10])


def walk_forward(candidates: list[dict], regime: dict[str, int], test_start: date, end: date,
                 min_trades: int = 8, min_t: float = 1.0, min_pf: float = 1.2, per_regime: int = 1,
                 score: str = "t") -> dict:
    """Quarterly expanding-window selection per regime → {quarters: [...], trades, oos, baselines, final}."""
    tag(candidates, regime)
    codes = sorted({v for v in regime.values() if v is not None})
    folds, stitched = [], []
    for a, b in quarters(test_start, end):
        choice: dict[int, list[dict]] = {}
        for code in codes:
            ranked = []
            for c in candidates:
                tr = [t["net"] for t in c["trades"] if t.get("regime") == code and _exit_day(t) < a.isoformat()]
                s = _stats(tr)
                if _qualifies(s, min_trades, min_t, min_pf):
                    ranked.append((s[score] or 0, c["id"], s))
            ranked.sort(key=lambda x: -x[0])
            choice[code] = [{"id": cid, "train": s} for _, cid, s in ranked[:per_regime]]
        q_trades = []
        for code, picks in choice.items():
            for p in picks:
                c = next(c for c in candidates if c["id"] == p["id"])
                q_trades += [{**t, "candidate": c["id"]} for t in c["trades"]
                             if t.get("regime") == code and a.isoformat() <= t["entry_at"][:10] <= b.isoformat()]
        q_trades.sort(key=lambda t: t["entry_at"])
        stitched += q_trades
        days = [d for d in regime if a.isoformat() <= d <= b.isoformat()]
        folds.append({"from": a.isoformat(), "to": b.isoformat(),
                      "choice": {str(k): [p["id"] for p in v] for k, v in choice.items()},
                      "train": {str(k): v for k, v in choice.items() if v},
                      "regime_days": {str(k): sum(1 for d in days if regime[d] == k) for k in codes},
                      "test": _stats([t["net"] for t in q_trades])})

    window = (test_start.isoformat(), end.isoformat())
    def in_window(t): return window[0] <= t["entry_at"][:10] <= window[1]
    baselines = {c["id"]: _stats([t["net"] for t in c["trades"] if in_window(t)]) for c in candidates}
    baselines["all_on"] = _stats([t["net"] for c in candidates for t in c["trades"] if in_window(t)])
    hindsight = {}
    for c in candidates:  # best regimes chosen with the test window's own results (not allowed in the walk-forward)
        good = [code for code in codes if _stats([t["net"] for t in c["trades"] if in_window(t) and t.get("regime") == code])["net"] > 0]
        hindsight[c["id"]] = {"regimes": good, **_stats([t["net"] for t in c["trades"] if in_window(t) and t.get("regime") in good])}
    final = {}  # the mapping a live playbook would use from tomorrow: trained on everything
    for code in codes:
        ranked = []
        for c in candidates:
            s = _stats([t["net"] for t in c["trades"] if t.get("regime") == code])
            if _qualifies(s, min_trades, min_t, min_pf):
                ranked.append((s[score] or 0, c["id"], s))
        ranked.sort(key=lambda x: -x[0])
        final[str(code)] = [{"id": cid, **s} for _, cid, s in ranked[:per_regime]]
    by_regime = {}
    for t in stitched:
        by_regime.setdefault(str(t.get("regime")), []).append(t["net"])
    return {"settings": {"test_start": test_start.isoformat(), "end": end.isoformat(), "min_trades": min_trades,
                         "min_t": min_t, "min_pf": min_pf, "per_regime": per_regime, "score": score},
            "quarters": folds, "oos": {**_stats([t["net"] for t in stitched]),
                                       "by_quarter_positive": sum(1 for f in folds if f["test"]["net"] > 0),
                                       "quarters": len(folds),
                                       "by_regime": {k: _stats(v) for k, v in sorted(by_regime.items())},
                                       "by_year": _by_year(stitched)},
            "baselines": baselines, "hindsight": hindsight, "final": final, "trades": stitched}


def _by_year(trades: list[dict]) -> dict:
    out: dict[str, list[float]] = {}
    for t in trades:
        out.setdefault(t["entry_at"][:4], []).append(t["net"])
    return {k: _stats(v) for k, v in sorted(out.items())}


def gate_for(codes: list[int], model: str = "trend_vol") -> dict | None:
    """Condition: regime (known before the entry) is one of `codes`."""
    rules = [{"left": {**REGIME_OPERAND, "params": {"model": model}}, "op": "==", "right": {"ind": "value", "params": {"value": c}}}
             for c in codes]
    if not rules:
        return None
    return rules[0] if len(rules) == 1 else {"any": rules}


def portfolio_for(choice: dict[str, list[str]], candidates: list[dict], name: str, capital: float = 500000,
                  model: str = "trend_vol") -> dict | None:
    """A PortfolioSpec trading each chosen candidate only in the regimes it was chosen for."""
    regimes_by_cand: dict[str, list[int]] = {}
    for code, ids in choice.items():
        for cid in ids:
            regimes_by_cand.setdefault(cid, []).append(int(code))
    members = []
    for c in candidates:
        if c["id"] in regimes_by_cand and c.get("spec"):
            members.append({"id": c["id"][:24], "name": c.get("name"), "spec": c["spec"],
                            "gate": gate_for(sorted(regimes_by_cand[c["id"]]), model)})
    if not members:
        return None
    return {"name": name, "capital": capital, "members": members}


def confirm(result: dict, candidates: list[dict], run_portfolio, capital: float = 500000) -> dict:
    """Rerun each test quarter's mapping as a real gated portfolio through the engine → stitched stats."""
    from datetime import date as _d
    nets, per_q = [], []
    for f in result["quarters"]:
        p = portfolio_for(f["choice"], candidates, f"playbook {f['from']}", capital)
        if p is None:
            per_q.append({"from": f["from"], "trades": 0, "net": 0.0})
            continue
        r = run_portfolio(p, _d.fromisoformat(f["from"]), _d.fromisoformat(f["to"]))
        q = [t["net"] for t in r["trades"]]
        nets += q
        per_q.append({"from": f["from"], **_stats(q), "approx": f["test"]["net"]})
    return {"oos": _stats(nets), "quarters": per_q}
