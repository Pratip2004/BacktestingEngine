"""Strategy portfolios ("buckets"): several algorithms backtested together, each with its own entry / exit rules
and an optional gate that decides when that algorithm may take trades at all.

Markets move in cycles, so no single algorithm wins every month. A portfolio holds a few, each gated on the
conditions it suits (e.g. a trend-following futures algo only while the daily regime is "uptrend", an iron condor
only while VIX is calm), and reports them together and one by one.

PortfolioSpec:
  members  1–12 algorithms: a saved strategy (strategy_id, its latest version) or an inline spec, a lots
           multiplier, an optional gate (a Condition, like any entry condition), enabled
  capital  ₹ the portfolio is measured against (returns and drawdown %)

How a gate works: it's ANDed into the member's entry (time entries: entry.filter; signal entries: each of
signal / bullish / bearish), so it's evaluated exactly like the member's own conditions: on candles closed before
the entry, no lookahead. A gate only stops new entries; positions already open exit by their own rules.

Members run independently through the engine (intraday or swing); the portfolio is the sum of their trades, with
daily P&L from each trade's daily mark-to-market. There are no cross-member rules yet (e.g. a portfolio-wide daily
loss limit): with them, one member's trades would change another's.
"""

from __future__ import annotations

import copy
import json
import threading
import uuid
from datetime import date, datetime
from typing import Any, Callable

import numpy as np
from fastapi import HTTPException
from pydantic import BaseModel, Field, ValidationError, model_validator

from app.config import BASE_DIR
from app.strategy import library
from app.strategy.engine import _breakdowns, _metrics, daily_pnl, run_strategy
from app.strategy.spec import Condition, StrategySpec, validate_spec

DIR = BASE_DIR / ".data" / "portfolios"
MAX_MEMBERS = 12
_lock = threading.Lock()


# ---------- spec ----------

class Member(BaseModel):
    id: str = Field(min_length=1, max_length=24)
    name: str | None = Field(None, max_length=120)
    strategy_id: str | None = None  # a saved strategy (latest version when the portfolio runs)
    spec: dict[str, Any] | None = None  # or an inline StrategySpec
    lots: int = Field(1, ge=1, le=50)  # multiplier on the strategy's own lots
    gate: Condition | None = None  # the member only enters while this holds
    enabled: bool = True

    @model_validator(mode="after")
    def _source(self):
        if (self.strategy_id is None) == (self.spec is None):
            raise ValueError("a member needs exactly one of strategy_id or spec")
        return self


class PortfolioSpec(BaseModel):
    name: str = Field("Untitled portfolio", min_length=1, max_length=120)
    description: str = ""
    capital: float = Field(500000, gt=0)
    members: list[Member] = Field(min_length=1, max_length=MAX_MEMBERS)

    @model_validator(mode="after")
    def _unique(self):
        ids = [m.id for m in self.members]
        if len(ids) != len(set(ids)):
            raise ValueError("member ids must be unique")
        return self


def gated_spec(spec: dict, gate: dict | None) -> dict:
    """The member's spec with its gate ANDed into every entry condition."""
    s = copy.deepcopy(spec)
    if not gate:
        return s
    e = s.setdefault("schedule", {}).setdefault("entry", {})
    if e.get("type", "time") == "time":
        e["filter"] = {"all": [e["filter"], gate]} if e.get("filter") else gate
    else:
        for k in ("signal", "bullish", "bearish"):
            if e.get(k):
                e[k] = {"all": [e[k], gate]}
    return s


def resolve(p: PortfolioSpec) -> list[dict]:
    """Enabled members → [{id, name, lots, gate, base_spec, spec (gated, lots applied)}]."""
    out = []
    for m in p.members:
        if not m.enabled:
            continue
        base = library.get(m.strategy_id)["spec"] if m.strategy_id else m.spec
        base = StrategySpec.model_validate(base).model_dump(mode="json")
        spec = gated_spec(base, m.gate.model_dump(mode="json", exclude_none=True) if m.gate else None)
        spec["lots"] = min(100, base["lots"] * m.lots)
        out.append({"id": m.id, "name": m.name or base["name"], "lots": m.lots, "strategy_id": m.strategy_id,
                    "gate": m.gate.model_dump(mode="json", exclude_none=True) if m.gate else None,
                    "base_spec": base, "spec": spec})
    if not out:
        raise HTTPException(422, "Enable at least one member")
    return out


def check(body: dict) -> dict:
    """{ok, errors: [{member, message}], warnings: [{member, message}], portfolio}"""
    try:
        p = PortfolioSpec.model_validate(body)
    except ValidationError as exc:
        return {"ok": False, "warnings": [], "portfolio": None, "errors": [
            {"member": None, "message": f"{'.'.join(str(x) for x in e['loc'])}: {e['msg'].removeprefix('Value error, ')}"}
            for e in exc.errors()]}
    errors, warnings = [], []
    try:
        members = resolve(p)
    except HTTPException as exc:
        return {"ok": False, "warnings": [], "portfolio": None, "errors": [{"member": None, "message": str(exc.detail)}]}
    for m in members:
        try:
            errs, warns = validate_spec(StrategySpec.model_validate(m["spec"]))
        except ValidationError as exc:
            errs, warns = [e["msg"] for e in exc.errors()], []
        errors += [{"member": m["id"], "message": x} for x in errs]
        warnings += [{"member": m["id"], "message": x} for x in warns]
    for m in p.members:  # store inline specs with every default filled in, like saved strategies
        if m.spec is not None:
            try:
                m.spec = StrategySpec.model_validate(m.spec).model_dump(mode="json")
            except ValidationError:
                pass
    if len({m["spec"]["underlying"] for m in members}) > 1:
        warnings.append({"member": None, "message": "Members trade different underlyings; P&L is still added up."})
    return {"ok": not errors, "errors": errors, "warnings": warnings, "portfolio": p.model_dump(mode="json")}


# ---------- run ----------

def _corr(series: dict[str, list[float]]) -> dict:
    ids = list(series)
    mat = np.array([series[i] for i in ids]) if ids else np.zeros((0, 0))
    out = {}
    for a_i, a in enumerate(ids):
        for b_i, b in enumerate(ids):
            x, y = mat[a_i], mat[b_i]
            ok = x.std() > 0 and y.std() > 0
            out.setdefault(a, {})[b] = round(float(np.corrcoef(x, y)[0, 1]), 2) if ok else None
    return out


def _concurrency(trades: list[dict]) -> tuple[int, float]:
    """Most positions open at once and the most margin blocked at once, across members."""
    events = []
    for t in trades:
        events.append((t["entry_at"], 1, t.get("margin") or 0.0))
        events.append((t["exit_at"] or t["entry_at"], -1, -(t.get("margin") or 0.0)))
    open_n = peak_n = 0
    margin = peak_m = 0.0
    for _, dn, dm in sorted(events, key=lambda e: (e[0], e[1])):  # exits before entries at the same minute
        open_n += dn
        margin += dm
        peak_n, peak_m = max(peak_n, open_n), max(peak_m, margin)
    return peak_n, round(peak_m, 2)


def _regimes(underlying: str, start: date, end: date) -> dict[str, int] | None:
    """trend_vol regime code known before each day's open (the previous close's label), or None if unavailable."""
    try:
        from app.data.instruments import underlying as get_underlying
        from app.strategy.regimes import regime_series
        from app.strategy.signals import daily_candles
        code = get_underlying(underlying).stock_code
        daily = daily_candles(code, start, end)
        codes = regime_series(daily, daily_candles(code, start, end, symbol="INDVIX"), "trend_vol")
        out, prev = {}, None
        for d, v in zip(daily["date"], codes):
            if prev is not None:
                out[d.isoformat()] = prev
            prev = None if v != v else int(v)
        return out
    except Exception:  # noqa: BLE001 — regime labels are a report extra; no daily data (logged out) shouldn't fail the run
        return None


def _summary(trades: list[dict]) -> dict:
    net = [t["net"] for t in trades]
    return {"trades": len(net), "net_pnl": round(sum(net), 2),
            "win_rate": round(sum(1 for x in net if x > 0) / len(net) * 100, 1) if net else None}


def run_portfolio(portfolio: dict, from_date: date, to_date: date, progress: Callable[[int, int, str], None] = lambda *a: None) -> dict:
    checked = check(portfolio)
    if not checked["ok"]:
        raise HTTPException(422, "; ".join(f"{e['member'] + ': ' if e['member'] else ''}{e['message']}" for e in checked["errors"]))
    p = PortfolioSpec.model_validate(checked["portfolio"])
    members = resolve(p)
    n = len(members)
    results = []
    for i, m in enumerate(members):
        def sub(k, total, msg, i=i, name=m["name"]):
            progress(i * 100 + (k * 100 // max(total, 1)), n * 100, f"{i + 1}/{n} {name}: {msg}")
        try:
            r = run_strategy(m["spec"], from_date, to_date, sub)
        except HTTPException as exc:
            r = {"error": str(exc.detail)}
        results.append({**{k: m[k] for k in ("id", "name", "lots", "strategy_id", "gate", "base_spec")}, "result": r})
    progress(n * 100, n * 100, "Combining")

    ok = [r for r in results if "error" not in r["result"]]
    trades = sorted(([{**t, "member": r["id"]} for r in ok for t in r["result"]["trades"]]), key=lambda t: t["entry_at"])
    days_all = sorted({d for r in ok for d in daily_pnl(r["result"]["trades"])})
    per_member_daily = {r["id"]: daily_pnl(r["result"]["trades"]) for r in ok}
    total_daily = daily_pnl(trades)
    cum, peak, dd, equity = 0.0, 0.0, 0.0, []
    member_cum = {r["id"]: 0.0 for r in ok}
    for d in days_all:
        cum += total_daily.get(d, 0.0)
        peak, dd = max(peak, cum), min(dd, cum - peak)
        row = {"d": d, "total": round(cum, 2)}
        for mid, daily in per_member_daily.items():
            member_cum[mid] += daily.get(d, 0.0)
            row[mid] = round(member_cum[mid], 2)
        equity.append(row)
    n_days = max((r["result"].get("trade_days", 0) for r in ok), default=0)
    from app.research.evaluate import trading_days
    try:
        n_days = len(trading_days(members[0]["spec"]["underlying"], from_date, to_date))
    except Exception:  # noqa: BLE001
        pass
    metrics = _metrics(trades, n_days)
    metrics["max_drawdown"] = round(dd, 2)  # always on daily mark-to-market for a portfolio
    peak_open, peak_margin = _concurrency(trades)
    metrics.update({"capital": p.capital, "return_pct": round(metrics["net_pnl"] / p.capital * 100, 2),
                    "max_drawdown_pct": round(dd / p.capital * 100, 2), "peak_open_positions": peak_open,
                    "peak_combined_margin": peak_margin})

    # Share of the members' combined |P&L| (signed), so it stays meaningful when the total is near zero.
    abs_total = sum(abs(r["result"]["metrics"]["net_pnl"]) for r in ok)
    members_out = []
    for r in results:
        res = r["result"]
        if "error" in res:
            members_out.append({**{k: r[k] for k in ("id", "name", "lots", "gate")}, "error": res["error"]})
            continue
        mm = res["metrics"]
        members_out.append({
            **{k: r[k] for k in ("id", "name", "lots", "gate")},
            "underlying": r["base_spec"]["underlying"], "holding": r["base_spec"].get("holding", {}).get("mode", "intraday"),
            "metrics": {k: mm.get(k) for k in ("trades", "net_pnl", "win_rate", "profit_factor", "max_drawdown", "sharpe",
                                                "days_traded", "days_in_market", "avg_trade", "peak_margin")},
            "contribution_pct": round(mm["net_pnl"] / abs_total * 100, 1) if abs_total else None,
            "in_market_pct": round(mm.get("days_in_market", 0) / n_days * 100, 1) if n_days else None,
        })

    # Correlation of daily P&L (days nobody traded don't count; a member's idle day is 0).
    corr = _corr({mid: [daily.get(d, 0.0) for d in days_all] for mid, daily in per_member_daily.items()}) if len(ok) > 1 else {}
    monthly: dict[str, dict[str, float]] = {}
    for t in trades:
        for d, pnl in ((m["d"], m["pnl"]) for m in t["daily_mtm"]) if t.get("daily_mtm") else [(t["trade_day"], t["net"])]:
            row = monthly.setdefault(d[:7], {})
            row[t["member"]] = round(row.get(t["member"], 0.0) + pnl, 2)
    regimes = _regimes(members[0]["spec"]["underlying"], from_date, to_date)
    by_regime = None
    if regimes:
        by_regime = {}
        for t in trades:
            code = regimes.get(t["entry_at"][:10])
            key = str(code) if code is not None else "unknown"
            by_regime.setdefault(key, {}).setdefault(t["member"], []).append(t)
        by_regime = {k: {mid: _summary(ts) for mid, ts in v.items()} for k, v in sorted(by_regime.items())}
        days_by_regime: dict[str, int] = {}
        for d, c in regimes.items():
            if from_date.isoformat() <= d <= to_date.isoformat():
                days_by_regime[str(c)] = days_by_regime.get(str(c), 0) + 1
        by_regime = {"trades": by_regime, "days": days_by_regime}

    return {
        "params": {"portfolio": p.model_dump(mode="json"), "from_date": from_date.isoformat(), "to_date": to_date.isoformat()},
        "metrics": metrics,
        "breakdowns": {**_breakdowns(trades), "by_member": {m["id"]: _summary([t for t in trades if t["member"] == m["id"]]) for m in members}},
        "members": members_out,
        "member_results": {r["id"]: r["result"] for r in results},
        "equity": equity,
        "daily": [{"d": d, "pnl": round(total_daily.get(d, 0.0), 2)} for d in days_all],
        "correlation": corr,
        "monthly": dict(sorted(monthly.items())),
        "by_regime": by_regime,
        "trades": trades,
        "trading_days": n_days,
    }


# ---------- saved portfolios (.data/portfolios/{id}.json) ----------

def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _path(pid: str):
    return DIR / f"{pid}.json"


def list_all() -> list[dict]:
    if not DIR.exists():
        return []
    docs = [json.loads(p.read_text()) for p in DIR.glob("*.json")]
    return sorted(({"id": d["id"], "name": d["portfolio"]["name"], "members": len(d["portfolio"]["members"]),
                    "created_at": d["created_at"], "updated_at": d["updated_at"]} for d in docs),
                  key=lambda m: m["updated_at"], reverse=True)


def get(pid: str) -> dict:
    if not _path(pid).exists():
        raise HTTPException(404, "Portfolio not found")
    return json.loads(_path(pid).read_text())


def save(portfolio: dict, pid: str | None = None) -> dict:
    p = PortfolioSpec.model_validate(portfolio).model_dump(mode="json")
    with _lock:
        DIR.mkdir(parents=True, exist_ok=True)
        if pid:
            doc = get(pid)
            doc.update(portfolio=p, updated_at=_now())
        else:
            doc = {"id": uuid.uuid4().hex[:12], "portfolio": p, "created_at": _now(), "updated_at": _now()}
        _path(doc["id"]).write_text(json.dumps(doc))
    return doc


def delete(pid: str) -> None:
    with _lock:
        if not _path(pid).exists():
            raise HTTPException(404, "Portfolio not found")
        _path(pid).unlink()
