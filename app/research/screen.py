"""Fast offline screening for research agents: the real engine, in your own process, on a store snapshot.

The server owns .data/market.duckdb (DuckDB allows one writer), so screens run on a read-only copy and never call
Breeze: data that isn't stored raises (HTTP 424) instead of being fetched. Several processes can share one
snapshot. Every screen is appended to .data/research/screens.jsonl, which the program look count includes
(program_looks), so screening is never free in the multiple-testing sense.

    .venv/bin/python -m app.research.screen snapshot          # refresh .data/snapshots/market.duckdb (server may run)
    MARKET_DB=.data/snapshots/market.duckdb BACKTEST_OFFLINE=1 .venv/bin/python my_screen.py

    from app.research.screen import screen, screen_portfolio
    r = screen(spec, "2023-01-01", "2026-10-26", agent="agent-trend", capital=500000)
    r["summary"], r["by_year"], r["result"]["trades"]
"""

from __future__ import annotations

import json
import os
import shutil
import sys
import threading
from datetime import date

from app.config import BASE_DIR

SNAPSHOT = BASE_DIR / ".data" / "snapshots" / "market.duckdb"
SCREEN_LOG = BASE_DIR / ".data" / "research" / "screens.jsonl"
_log_lock = threading.Lock()

SUMMARY_KEYS = ("trades", "net_pnl", "profit_factor", "win_rate", "t_stat", "sharpe", "max_drawdown",
                "max_drawdown_pct", "worst_day", "net_ex_top_k", "expectancy", "costs_total", "peak_capital_required",
                "return_on_margin_pct", "days_traded")


def snapshot() -> str:
    """Copy the live store (+ WAL) and checkpoint the copy so it opens read-only."""
    import duckdb
    src = BASE_DIR / ".data" / "market.duckdb"
    SNAPSHOT.parent.mkdir(parents=True, exist_ok=True)
    for suffix in ("", ".wal"):
        dst = SNAPSHOT.with_name(SNAPSHOT.name + suffix)
        if dst.exists():
            dst.unlink()
        s = src.with_name(src.name + suffix)
        if s.exists():
            shutil.copy2(s, dst)
    con = duckdb.connect(str(SNAPSHOT))
    con.execute("CHECKPOINT")
    con.close()
    return str(SNAPSHOT)


def _require_offline(end: str | None = None):
    from app.data import store
    if not store.OFFLINE:
        raise RuntimeError("Screens run offline: set MARKET_DB=.data/snapshots/market.duckdb BACKTEST_OFFLINE=1")
    lock = os.environ.get("SCREEN_TRAIN_END")  # agents tune on the training window only; the lead runs the test
    if lock and end and end > lock:
        raise RuntimeError(f"SCREEN_TRAIN_END={lock}: screens may not look past the training window (asked {end})")


def screen_many(specs: list[dict], start: str, end: str, agent: str = "lead", capital: float = 500000) -> list[dict]:
    """Several specs in one process (sequential: ~250 MB per process) → [{name, summary, by_year, by_half} | {name, error}]."""
    out = []
    for spec in specs:
        try:
            r = screen(spec, start, end, agent=agent, capital=capital)
            out.append({"name": spec.get("name"), "summary": r["summary"], "by_year": r["by_year"], "by_half": r["by_half"]})
        except Exception as exc:  # noqa: BLE001 — one bad spec shouldn't stop a grid
            out.append({"name": spec.get("name"), "error": f"{type(exc).__name__}: {getattr(exc, 'detail', exc)}"})
    return out


def log_look(agent: str, name: str, kind: str, start: str, end: str, summary: dict | None, error: str | None = None) -> None:
    SCREEN_LOG.parent.mkdir(parents=True, exist_ok=True)
    row = {"at": date.today().isoformat(), "agent": agent, "kind": kind, "name": name, "from": start, "to": end,
           "net": (summary or {}).get("net_pnl"), "trades": (summary or {}).get("trades"),
           "t": (summary or {}).get("t_stat"), "error": error}
    with _log_lock, open(SCREEN_LOG, "a") as f:
        f.write(json.dumps(row) + "\n")


def screen_count() -> int:
    try:
        with open(SCREEN_LOG) as f:
            return sum(1 for _ in f)
    except FileNotFoundError:
        return 0


def by_year(trades: list[dict]) -> dict[str, dict]:
    out: dict[str, dict] = {}
    for t in trades:
        y = t["trade_day"][:4]
        g = out.setdefault(y, {"trades": 0, "net": 0.0, "wins": 0})
        g["trades"] += 1
        g["net"] = round(g["net"] + t["net"], 2)
        g["wins"] += t["net"] > 0
    return out


def by_half(trades: list[dict]) -> dict[str, float]:
    out: dict[str, float] = {}
    for t in trades:
        k = f"{t['trade_day'][:4]}H{1 if int(t['trade_day'][5:7]) <= 6 else 2}"
        out[k] = round(out.get(k, 0.0) + t["net"], 2)
    return dict(sorted(out.items()))


def screen(spec: dict, start: str, end: str, agent: str = "lead", capital: float = 500000, log: bool = True) -> dict:
    """Run one spec offline → {summary, by_year, by_half, ext, result}. Errors are logged as looks too."""
    _require_offline(end)
    from fastapi import HTTPException
    from app.research.evaluate import evaluate
    from app.strategy.engine import run_strategy
    from app.data.access import OFFLINE_MISSING
    name = spec.get("name", "?")
    OFFLINE_MISSING.clear()
    try:
        result = run_strategy(spec, date.fromisoformat(start), date.fromisoformat(end))
    except HTTPException as exc:
        if log:
            log_look(agent, name, "spec", start, end, None, str(exc.detail))
        raise
    ext = evaluate(result, capital)
    summary = {k: ext.get(k) for k in SUMMARY_KEYS}
    summary["skipped"] = len(result.get("skipped") or [])
    summary["missing_data"] = len(OFFLINE_MISSING)  # contract-day chunks not in the snapshot (trades skipped)
    tried = summary["trades"] + summary["skipped"]
    if summary["missing_data"] and tried and summary["skipped"] / tried > 0.1:  # results are biased by what's stored
        summary["warning"] = (f"UNRELIABLE: {summary['skipped']} of {tried} entries skipped, {summary['missing_data']} "
                              "contract-day chunks missing from the snapshot")
    if log:
        log_look(agent, name, "spec", start, end, summary)
    return {"summary": summary, "by_year": by_year(result["trades"]), "by_half": by_half(result["trades"]),
            "ext": ext, "result": result}


def screen_portfolio(portfolio: dict, start: str, end: str, agent: str = "lead", log: bool = True) -> dict:
    """Run a PortfolioSpec offline → the run_portfolio result plus by_year / by_half per member and in total."""
    _require_offline(end)
    from app.strategy.portfolio import run_portfolio
    result = run_portfolio(portfolio, date.fromisoformat(start), date.fromisoformat(end))
    trades = result["trades"]
    out = {"metrics": result["metrics"], "by_year": by_year(trades), "by_half": by_half(trades),
           "members": {m["id"]: {"name": m["name"], "error": m.get("error"), "metrics": m.get("metrics"),
                                 "by_year": by_year((result["member_results"][m["id"]] or {}).get("trades") or [])}
                       for m in result["members"]},
           "result": result}
    if log:
        log_look(agent, portfolio.get("name", "?"), "portfolio", start, end,
                 {"net_pnl": result["metrics"].get("net_pnl"), "trades": result["metrics"].get("trades")})
    return out


if __name__ == "__main__":
    if sys.argv[1:2] == ["snapshot"]:
        print(snapshot())
    else:
        print(__doc__)
