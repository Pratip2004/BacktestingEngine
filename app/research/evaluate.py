"""Research metrics for one engine result, on top of the engine's own metrics.

The engine reports per-trade net P&L. Research needs more:
- capital: what each trade ties up (premium paid, or the defined max loss as a stand-in for hedged margin; naked
  shorts get a rough SPAN-like estimate) and whether the strategy fits the research capital
- returns on capital over **every trading day** of the period (no-trade days count as 0), so Sharpe / Sortino
  aren't flattered by skipping idle days (the engine's own Sharpe uses traded days only)
- costs split into brokerage, STT, exchange, SEBI, stamp, GST and slippage; gross before slippage
- evidence: daily t-statistic, bootstrap 95% interval of total P&L, P&L without the best 5 trades, top-day share
- distributions: monthly, weekly, by entry hour; holding time and exposure; drawdown and recovery
- checks against pre-registered criteria (gates)
"""

from __future__ import annotations

import math
from datetime import date

import numpy as np
import pandas as pd

from app.data.store import get_store
from app.strategy.margin import DEFAULT_FUT_PCT, DEFAULT_SHORT_PCT, margin_required

SESSION_MINUTES = 375


# ---------- capital ----------

def capital_required(trade: dict) -> tuple[float, str]:
    """(₹ tied up, how it was estimated) for one trade: the engine's margin if recorded, else re-estimated."""
    if trade.get("margin") is not None:
        return trade["margin"], trade.get("margin_basis", "approx_margin")
    return margin_required(trade["legs"], trade["premium"], trade["spot_entry"], *_margin_pcts())


def _margin_pcts() -> tuple[float, float]:
    try:
        cfg = get_store().settings()
        return float(cfg.get("short_margin_pct", DEFAULT_SHORT_PCT)), float(cfg.get("fut_margin_pct", DEFAULT_FUT_PCT))
    except Exception:  # tests / no store
        return DEFAULT_SHORT_PCT, DEFAULT_FUT_PCT


# ---------- costs ----------

def cost_components(trades: list[dict], brokerage: float, slippage: float, taxes: bool) -> dict:
    rates = get_store().q("SELECT effective_from, stt_sell_pct, exchange_pct, sebi_pct, stamp_buy_pct, gst_pct FROM cost_schedule ORDER BY effective_from DESC")
    out = dict(brokerage=0.0, stt=0.0, exchange=0.0, sebi=0.0, stamp=0.0, gst=0.0, slippage=0.0)
    for t in trades:
        for l in t["legs"]:
            # slippage actually applied (engine ≥ v2 records it per leg; older results: the nominal rate per fill)
            out["slippage"] += l["slip"] * l["qty"] if "slip" in l else slippage * l["qty"] * (2 if l["exit"] is not None else 1)
            fills = [(l["entry"], t["entry_at"], l["action"] == "buy")]
            if l["exit"] is not None:
                fills.append((l["exit"], l["exit_at"] or t["exit_at"], l["action"] == "sell"))
            for px, when, is_buy in fills:
                d = date.fromisoformat(when[:10])
                _, stt, exch, sebi, stamp, gst = next(r for r in rates if d >= r[0])
                turnover = px * l["qty"]
                out["brokerage"] += brokerage
                if taxes:
                    e, s = exch / 100 * turnover, sebi / 100 * turnover
                    out["exchange"] += e
                    out["sebi"] += s
                    out["stt"] += 0 if is_buy else stt / 100 * turnover
                    out["stamp"] += stamp / 100 * turnover if is_buy else 0
                    out["gst"] += gst / 100 * (brokerage + e + s)
    return {k: round(v, 2) for k, v in out.items()}


# ---------- helpers ----------

def trading_days(underlying: str, start: date, end: date) -> list[date]:
    rows = get_store().q("SELECT DISTINCT CAST(ts AS DATE) AS d FROM spot_1m WHERE underlying = ? AND CAST(ts AS DATE) BETWEEN ? AND ? ORDER BY d",
                         [underlying, start, end])
    return [r[0] for r in rows]


def _block_bootstrap(arr: np.ndarray, rng, n: int = 2000, block: int = 5) -> np.ndarray:
    """Totals of n resampled histories built from random 5-day blocks (keeps short-run dependence)."""
    k = math.ceil(len(arr) / block)
    starts = rng.integers(0, max(1, len(arr) - block + 1), size=(n, k))
    idx = (starts[:, :, None] + np.arange(block)).reshape(n, -1)[:, :len(arr)]
    return arr[np.minimum(idx, len(arr) - 1)].sum(axis=1)


def _r(x, n=2):
    return None if x is None or (isinstance(x, float) and not math.isfinite(x)) else round(float(x), n)


# ---------- main ----------

def evaluate(result: dict, capital: float = 100000) -> dict:
    trades = result["trades"]
    spec = result["params"]["spec"]
    start, end = date.fromisoformat(result["params"]["from_date"]), date.fromisoformat(result["params"]["to_date"])
    days = trading_days(spec["underlying"], start, end)
    # A trade (or a mark-to-market day) can fall on a day with futures/option candles but no index candles (e.g.
    # NIFTY spot is missing 29 Mar 2022): count it as a trading day rather than fail.
    traded = {date.fromisoformat(m["d"]) for t in trades for m in (t.get("daily_mtm") or [{"d": t["trade_day"]}])}
    days = sorted(set(days) | {d for d in traded if start <= d <= end})
    n_days = len(days)

    by_day = pd.Series(0.0, index=pd.Index(days, name="d"))
    for t in trades:  # multi-day trades by their daily mark-to-market, so drawdown / Sharpe see open losses
        for ds, p in ((m["d"], m["pnl"]) for m in t["daily_mtm"]) if t.get("daily_mtm") else [(t["trade_day"], t["net"])]:
            d = date.fromisoformat(ds)
            by_day.loc[d] = by_day.get(d, 0.0) + p
    by_day = by_day.sort_index()
    equity = capital + by_day.cumsum()
    peak = equity.cummax().clip(lower=capital)
    dd = equity - peak
    dd_pct = dd / peak * 100
    trough = dd.idxmin() if len(dd) else None
    recovered = None
    if trough is not None and dd.min() < 0:
        after = equity[equity.index > trough]
        hit = after[after >= peak.loc[trough]]
        recovered = int((pd.Index(days).get_loc(hit.index[0]) - pd.Index(days).get_loc(trough))) if len(hit) else None

    rets = by_day / capital
    mean, sd = float(rets.mean()) if n_days else 0.0, float(rets.std(ddof=1)) if n_days > 1 else 0.0
    downside = float(np.sqrt((np.minimum(rets, 0) ** 2).mean())) if n_days else 0.0
    t_stat = mean / (sd / math.sqrt(n_days)) if sd and n_days > 1 else None

    rng = np.random.default_rng(7)
    arr = by_day.to_numpy()
    boot = _block_bootstrap(arr, rng) if len(arr) else np.array([0.0])

    nets = sorted((t["net"] for t in trades), reverse=True)
    top_k = max(1, math.ceil(0.05 * len(nets)))  # the best 5% of trades
    total = sum(nets)
    gross = sum(t["gross"] for t in trades)
    costs = sum(t["costs"] for t in trades)
    sc = spec["costs"]
    comp = cost_components(trades, sc["brokerage_per_order"], sc["slippage_points"], sc["taxes"])
    gross_before_slip = gross + comp["slippage"]
    all_costs = costs + comp["slippage"]

    caps = [capital_required(t) for t in trades]
    peak_cap = max((c for c, _ in caps), default=0.0)
    cap_basis = sorted({b for _, b in caps})

    holds = [(pd.Timestamp(t["exit_at"]) - pd.Timestamp(t["entry_at"])).total_seconds() / 60 for t in trades if t["exit_at"]]
    hours: dict[str, list[float]] = {}
    for t in trades:
        hours.setdefault(t["entry_at"][11:13] + ":00", []).append(t["net"])
    weekly = by_day.groupby(lambda d: f"{d.isocalendar()[0]}-W{d.isocalendar()[1]:02d}").sum()
    monthly = by_day.groupby(lambda d: f"{d:%Y-%m}").sum()

    streak = worst = 0
    for t in trades:
        streak = streak + 1 if t["net"] <= 0 else 0
        worst = max(worst, streak)
    wins = [x for x in nets if x > 0]
    losses = [x for x in nets if x <= 0]
    top_day_share = None
    if total > 0:
        top = by_day.sort_values(ascending=False).head(max(1, n_days // 10)).sum()
        top_day_share = top / total * 100

    return {
        "capital": capital,
        "period": [start.isoformat(), end.isoformat()],
        "trading_days": n_days,
        "days_traded": int((by_day != 0).sum()),
        "trades": len(trades),
        "skipped": len(result.get("skipped") or []),
        "net_pnl": _r(total),
        "gross_pnl": _r(gross),
        "gross_before_slippage": _r(gross_before_slip),
        "costs_total": _r(all_costs),
        "cost_components": comp,
        "cost_share_of_gross": _r(all_costs / gross_before_slip * 100) if gross_before_slip > 0 else None,
        "ending_equity": _r(capital + total),
        "return_pct": _r(total / capital * 100),
        "annualized_return_pct": _r(total / capital * 252 / n_days * 100) if n_days else None,
        "max_drawdown": _r(dd.min() if len(dd) else 0),
        "max_drawdown_pct": _r(dd_pct.min() if len(dd) else 0),
        "recovery_days": recovered,
        "sharpe": _r(mean / sd * math.sqrt(252)) if sd else None,
        "sortino": _r(mean / downside * math.sqrt(252)) if downside else None,
        "t_stat": _r(t_stat),
        "boot_ci": [_r(np.percentile(boot, 2.5)), _r(np.percentile(boot, 97.5))],
        "boot_p_loss": _r(float((boot <= 0).mean()) * 100, 1),
        "profit_factor": _r(sum(wins) / -sum(losses)) if losses and sum(losses) < 0 else None,
        "win_rate": _r(len(wins) / len(nets) * 100, 1) if nets else None,
        "avg_win": _r(np.mean(wins)) if wins else None,
        "avg_loss": _r(np.mean(losses)) if losses else None,
        "expectancy": _r(total / len(nets)) if nets else None,
        "net_ex_top5": _r(total - sum(nets[:5])),
        "top_k": top_k,
        "net_ex_top_k": _r(total - sum(nets[:top_k])),
        "worst_day": _r(by_day.min()) if n_days else None,
        "worst_day_pct": _r(by_day.min() / capital * 100) if n_days else None,
        "avg_net_points": _r(np.mean([t["net"] / min(l["qty"] for l in t["legs"]) for t in trades])) if trades else None,
        "top_decile_day_share_pct": _r(top_day_share),
        "longest_losing_streak": worst,
        "avg_hold_min": _r(np.mean(holds), 1) if holds else None,
        "exposure_pct": _r(sum(holds) / (n_days * SESSION_MINUTES) * 100, 1) if n_days else None,
        "peak_capital_required": _r(peak_cap),
        "avg_capital_required": _r(np.mean([c for c, _ in caps])) if caps else None,
        "capital_basis": cap_basis,
        "fits_capital": peak_cap <= capital,
        "return_on_margin_pct": _r(total / peak_cap * 100) if peak_cap else None,
        "max_lots_by_capital": int(capital // peak_cap) if peak_cap else None,
        "weekly": {"n": len(weekly), "mean": _r(weekly.mean()), "worst": _r(weekly.min()), "best": _r(weekly.max()),
                   "pct_positive": _r((weekly > 0).mean() * 100, 1)} if len(weekly) else None,
        "monthly": {k: _r(v) for k, v in monthly.items()},
        "by_hour": {k: {"trades": len(v), "net": _r(sum(v))} for k, v in sorted(hours.items())},
        "daily": [{"d": d.isoformat(), "pnl": _r(p), "equity": _r(e), "dd": _r(x)}
                  for d, p, e, x in zip(by_day.index, by_day.to_numpy(), equity.to_numpy(), dd.to_numpy())],
    }


# ---------- gates (protocol v2, after critic CRIT-1) ----------

DEFAULT_CRITERIA = {
    "min_trades": 40,
    "min_profit_factor": 1.15,
    "min_t_stat": 2.0,
    "max_worst_day_pct": 10.0,  # tail test: no single day loses more than this share of capital
    "require_fits_capital": False,  # capital isn't a constraint (user, 26 Oct 2026); margin is reported instead
    "require_positive_ex_top": True,
}


def t_bar(criteria: dict | None, looks: int) -> float:
    """Daily t-stat a result must reach: max(min_t_stat, √(2·ln N)) with N = looks across the whole program
    (≈ the largest t-stat expected from N pure-noise strategies)."""
    c = {**DEFAULT_CRITERIA, **(criteria or {})}
    if c.get("program_bar") is False:  # a pre-registered test run once per candidate (protocol v4): the fixed bar
        return c["min_t_stat"]
    return max(c["min_t_stat"], math.sqrt(2 * math.log(looks)) if looks > 1 else 0)


def checks(ext: dict, criteria: dict, looks: int = 1) -> list[dict]:
    """Pre-registered criteria vs one period's metrics. Max drawdown at a fixed 1 lot is a sizing question, so it is
    reported (and judged at Stage C) rather than gated here."""
    c = {**DEFAULT_CRITERIA, **(criteria or {})}
    bar = t_bar(criteria, looks)
    out = [
        {"name": "Net P&L after costs > 0", "value": ext["net_pnl"], "pass": (ext["net_pnl"] or 0) > 0},
        {"name": f"Trades ≥ {c['min_trades']}", "value": ext["trades"], "pass": ext["trades"] >= c["min_trades"]},
        {"name": f"Profit factor ≥ {c['min_profit_factor']}", "value": ext["profit_factor"], "pass": (ext["profit_factor"] or 0) >= c["min_profit_factor"]},
        {"name": f"Daily t-stat ≥ {bar:.2f} ({looks} looks in the program)", "value": ext["t_stat"], "pass": (ext["t_stat"] or 0) >= bar},
        {"name": f"Worst day ≥ −{c['max_worst_day_pct']}% of capital", "value": ext.get("worst_day_pct"), "pass": (ext.get("worst_day_pct") or 0) >= -c["max_worst_day_pct"]},
    ]
    if c["require_fits_capital"]:
        out.append({"name": "1 lot fits the capital", "value": ext["peak_capital_required"], "pass": ext["fits_capital"]})
    if c["require_positive_ex_top"] and "net_ex_top_k" in ext:
        out.append({"name": f"Still profitable without the best {ext['top_k']} trades (5%)", "value": ext["net_ex_top_k"], "pass": (ext["net_ex_top_k"] or 0) > 0})
    return out


def experiment_gates(results: dict) -> list[dict]:
    """Checks across periods: both discovery halves agree in sign, and the cost stress runs stay positive."""
    def net(key):
        r = results.get(key)
        return None if not r or r.get("error") else r["ext"]["net_pnl"]
    out = []
    for ka, kb, label in (("half_a", "half_b", "Sep–Dec 2025 and Jan–Jun 2026"), ("y2025", "h1_2026", "2025 and Jan–Jun 2026")):
        a, b = net(ka), net(kb)
        if a is not None and b is not None:
            out.append({"name": f"Both discovery segments profitable ({label})", "value": [a, b], "pass": a > 0 and b > 0})
    a, b = net("test_a"), net("test_b")
    if a is not None and b is not None:
        out.append({"name": "Neither test half losing", "value": [a, b], "pass": a >= 0 and b >= 0})
    for key, label in (("stress_2x", "2× slippage"), ("stress", "2× slippage"), ("test_2x", "2× slippage (test)")):
        if net(key) is not None:
            out.append({"name": f"Still profitable at {label}", "value": net(key), "pass": net(key) > 0})
            break
    return out
