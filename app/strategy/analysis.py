"""Phase 4 analysis on top of the generic engine.

- replay(): minute-by-minute view of one trade from a saved run (underlying, each leg, position P&L).
- sweep(): run a spec over a grid of up to two parameters. With walk_forward, each combination is run on
  an in-sample part of the period (to choose) and the out-of-sample rest (to check), so a setting that
  only worked by luck shows up as a big in- vs out-of-sample gap.
"""

from __future__ import annotations

import copy
import itertools
from datetime import date, datetime, timedelta
from typing import Any, Callable

import pandas as pd
from fastapi import HTTPException

from app import runs
from app.data.access import future_minute_bars, option_minute_bars, spot_minute_bars
from app.data.instruments import underlying as get_underlying
from app.strategy.engine import run_strategy

MAX_COMBOS = 36
METRICS = ("net_pnl", "win_rate", "profit_factor", "sharpe", "max_drawdown", "trades")


# ---------- replay ----------

def replay(run_id: str, index: int, member: str | None = None) -> dict:
    """member: a portfolio run's member id (its own trade list)."""
    run = runs.get(run_id)
    if run["strategy"] == "portfolio":
        result = run["result"].get("member_results", {}).get(member or "")
        if not result or "trades" not in result:
            raise HTTPException(404, "No such member in this portfolio run")
    elif run["strategy"] == "custom":
        result = run["result"]
    else:
        raise HTTPException(422, "Trade replay is available for strategy-builder and portfolio runs")
    trades = result["trades"]
    if not 0 <= index < len(trades):
        raise HTTPException(404, "No such trade in this run")
    t = trades[index]
    u = get_underlying(result["params"]["spec"]["underlying"])
    entry_at = pd.Timestamp(t["entry_at"])
    exit_at = pd.Timestamp(t["exit_at"])
    # Every day the trade was held (multi-day trades list them in daily_mtm), else entry and exit day.
    days = sorted({date.fromisoformat(m["d"]) for m in t.get("daily_mtm") or []} | {entry_at.date(), exit_at.date()})
    start, end = entry_at - pd.Timedelta(minutes=20), exit_at + pd.Timedelta(minutes=20)

    def window(df: pd.DataFrame) -> pd.DataFrame:
        return df[(df["datetime"] >= start) & (df["datetime"] <= end)]

    spot = window(spot_minute_bars(u.stock_code, days))
    legs_out, closes = [], {}
    for leg in t["legs"]:
        expiry = date.fromisoformat(leg["expiry"])
        if leg["instrument"] == "FUT":
            bars = future_minute_bars(u.stock_code, expiry, days)
        else:
            bars = option_minute_bars(u.stock_code, expiry, leg["strike"], "call" if leg["instrument"] == "CE" else "put", days)
        bars = window(bars)
        closes[leg["id"]] = bars.set_index("datetime")["close"]
        legs_out.append({**leg, "series": [{"t": ts.strftime("%Y-%m-%d %H:%M"), "close": round(float(c), 2)} for ts, c in zip(bars["datetime"], bars["close"])]})

    grid = pd.DataFrame(closes).sort_index().ffill()
    pnl = []
    for ts, row in grid.iterrows():
        # Same timeline as the leg/spot charts; no P&L outside the trade.
        if ts < entry_at or ts > exit_at:
            pnl.append({"t": ts.strftime("%Y-%m-%d %H:%M"), "pnl": None})
            continue
        total = 0.0
        for leg in t["legs"]:
            side = 1 if leg["action"] == "buy" else -1
            leg_exit_at = pd.Timestamp(leg["exit_at"]) if leg["exit_at"] else exit_at
            px = leg["exit"] if ts >= leg_exit_at and leg["exit"] is not None else row.get(leg["id"])
            if px is None or pd.isna(px):
                continue
            total += side * leg["qty"] * (px - leg["entry"])
        pnl.append({"t": ts.strftime("%Y-%m-%d %H:%M"), "pnl": round(total, 2)})
    return {
        "trade": t,
        "underlying": u.name,
        "spot": [{"t": ts.strftime("%Y-%m-%d %H:%M"), "close": round(float(c), 2)} for ts, c in zip(spot["datetime"], spot["close"])],
        "legs": legs_out,
        "pnl": pnl,
    }


# ---------- sweep ----------

def _set_path(spec: dict, path: str, value: Any) -> None:
    """spec["a"]["b"][0]["c"] = value for path "a.b.0.c" (creating dicts on the way)."""
    keys = path.split(".")
    node: Any = spec
    for k in keys[:-1]:
        if isinstance(node, list):
            node = node[int(k)]
        else:
            if node.get(k) is None:
                node[k] = {}
            node = node[k]
    last = keys[-1]
    if isinstance(node, list):
        node[int(last)] = value
    else:
        node[last] = value


def _metric_row(r: dict) -> dict:
    m = r["metrics"]
    return {k: m.get(k) for k in METRICS}


def sweep(spec: dict, from_date: date, to_date: date, params: list[dict], walk_forward: bool = False,
          in_sample_pct: int = 70, progress: Callable[[int, int, str], None] = lambda *a: None) -> dict:
    """params: [{path, label, values}] (1 or 2). Returns every combination's metrics (in- and out-of-sample
    when walk_forward)."""
    if not 1 <= len(params) <= 2:
        raise HTTPException(422, "Sweep 1 or 2 parameters")
    combos = list(itertools.product(*[p["values"] for p in params]))
    if len(combos) > MAX_COMBOS:
        raise HTTPException(422, f"{len(combos)} combinations; keep it to {MAX_COMBOS} or fewer")
    if walk_forward:
        span = (to_date - from_date).days
        split = from_date + timedelta(days=max(1, int(span * in_sample_pct / 100)))
        periods = {"in": (from_date, split), "out": (split + timedelta(days=1), to_date)}
    else:
        periods = {"in": (from_date, to_date)}
    total = len(combos) * len(periods)
    done = 0
    cells = []
    for combo in combos:
        s = copy.deepcopy(spec)
        for p, v in zip(params, combo):
            _set_path(s, p["path"], v)
        cell = {"values": list(combo)}
        what = " · ".join(f"{p['label']} {v}" for p, v in zip(params, combo))
        for name, (a, b) in periods.items():
            part = "full period" if not walk_forward else "in-sample" if name == "in" else "out-of-sample"
            progress(done, total, f"{what} ({part})")
            try:
                cell[name] = _metric_row(run_strategy(s, a, b))
            except HTTPException as exc:
                cell[name] = {"error": exc.detail}
            done += 1
        cells.append(cell)
    progress(total, total, "Done")
    return {
        "params": params,
        "periods": {k: [a.isoformat(), b.isoformat()] for k, (a, b) in periods.items()},
        "walk_forward": walk_forward,
        "cells": cells,
        "generated_at": datetime.now().isoformat(timespec="seconds"),
    }
