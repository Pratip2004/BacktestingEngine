"""Paper observation of watchlisted strategies: what the rules would have done since a start date, refreshed daily.

Nothing is ever ordered. Each refresh re-runs the experiment's exact spec through the engine from `since` to the
last completed session (today's candles aren't final until the nightly download has logged them), saves it as a
normal builder run (so every paper trade opens in the builder with replay), and records:
- the trades so far (one still open at the last session is marked open, valued at that close)
- the entry condition's state at the latest daily close: true/false, and for a vote (`any` + `min`) how many of
  its conditions hold, so the page can say "2 of 4, needs 3".

A bucket (saved portfolio) can be watched too: its key is "portfolio:<id>", it re-runs through run_portfolio, and
the signal readout is per member (its entry with the gate applied).

State lives in .data/research/paper.json: {"watch": [{experiment_id, since, added_at, last}]}. A background
thread refreshes every watched strategy once per weekday after the previous session's data is stored.
"""

from __future__ import annotations

import json
import logging
import threading
import time as _time
from datetime import date, datetime, timedelta

from fastapi import HTTPException

from app import runs
from app.breeze_client import breeze
from app.research import ledger

log = logging.getLogger(__name__)
FILE = ledger.RESEARCH_DIR / "paper.json"
_lock = threading.Lock()
_started = {"v": False}


def _load() -> dict:
    return json.loads(FILE.read_text()) if FILE.exists() else {"watch": []}


def _save(d: dict) -> None:
    FILE.parent.mkdir(parents=True, exist_ok=True)
    FILE.write_text(json.dumps(d, indent=1, default=str))


def watch_list() -> list[dict]:
    out = []
    for w in _load()["watch"]:
        if w["experiment_id"].startswith("portfolio:"):
            from app.strategy import portfolio as pf
            try:
                doc = pf.get(w["experiment_id"].split(":", 1)[1])
                out.append({**w, "name": doc["portfolio"]["name"], "kind": "portfolio", "portfolio_id": doc["id"]})
            except HTTPException:
                out.append({**w, "name": "(missing portfolio)", "kind": "portfolio"})
            continue
        try:
            e = ledger.get(w["experiment_id"])
            out.append({**w, "name": e["name"], "verdict": e["verdict"], "family": e["family"]})
        except HTTPException:
            out.append({**w, "name": "(missing experiment)"})
    return out


def add(eid: str, since: date) -> dict:
    if eid.startswith("portfolio:"):
        from app.strategy import portfolio as pf
        pf.get(eid.split(":", 1)[1])  # 404 if unknown
    else:
        ledger.get(eid)  # 404 if unknown
    with _lock:
        d = _load()
        d["watch"] = [w for w in d["watch"] if w["experiment_id"] != eid]
        d["watch"].append({"experiment_id": eid, "since": since.isoformat(), "added_at": ledger.now(), "last": None})
        _save(d)
    ledger.log_event("decision", f"Paper watch started for {eid} from {since} (rules only, no orders)", "lead", eid)
    return refresh(eid)


def remove(eid: str) -> None:
    with _lock:
        d = _load()
        d["watch"] = [w for w in d["watch"] if w["experiment_id"] != eid]
        _save(d)


def last_completed_session(today: date | None = None) -> date:
    d = (today or date.today()) - timedelta(days=1)
    while d.weekday() >= 5:
        d -= timedelta(days=1)
    return d


def _vote_state(spec: dict, until: date) -> dict | None:
    """Entry condition at the latest daily close ≤ until: {holds, votes, needed, of} (votes only for any+min groups)."""
    from app.data.access import spot_minute_bars
    from app.strategy.signals import Evaluator
    from app.strategy.spec import Group, StrategySpec
    s = StrategySpec.model_validate(spec)
    e = s.schedule.entry
    cond = e.signal or e.bullish or e.filter
    if cond is None:
        return None
    m1 = spot_minute_bars(s.underlying, [until])
    if m1.empty:
        return None
    ev = Evaluator(m1, s.timeframe, s.underlying)
    holds = ev.evaluate(cond).dropna()
    out = {"at": str(holds.index[-1]) if len(holds) else None, "holds": bool(holds.iloc[-1]) if len(holds) else None}
    if isinstance(cond, Group) and cond.any and cond.min:
        parts = [ev.evaluate(c).dropna() for c in cond.any]
        out |= {"votes": sum(int(bool(p.iloc[-1])) for p in parts if len(p)), "needed": cond.min, "of": len(cond.any)}
    else:  # any other shape: how many of its distinct conditions hold (e.g. a vote written as any-of-all groups)
        leaves: dict[str, object] = {}

        def walk(c):
            if isinstance(c, Group):
                for x in (c.all or c.any or []):
                    walk(x)
            else:
                leaves.setdefault(c.model_dump_json(), c)
        walk(cond)
        if len(leaves) > 1:
            states = [ev.evaluate(r).dropna() for r in leaves.values()]
            needed = None  # a K-of-N vote written longhand: an any of K-member all groups
            if cond.any and all(isinstance(g, Group) and g.all and not any(isinstance(x, Group) for x in g.all) for g in cond.any):
                needed = min(len(g.all) for g in cond.any)
            out |= {"votes": sum(int(bool(x.iloc[-1])) for x in states if len(x)), "of": len(leaves), "needed": needed,
                    "conditions": [{"rule": _describe(r), "holds": bool(x.iloc[-1]) if len(x) else None}
                                   for r, x in zip(leaves.values(), states)]}
    return out


def _describe(r) -> str:
    def op(o):
        if o.ind == "value":
            return f"{o.params.get('value')}"
        p = ",".join(f"{k}={v}" for k, v in o.params.items())
        s = f"{o.ind}{'.' + o.field if o.field else ''}({p})" if p or o.field else o.ind
        if o.shift:
            s += f"[{o.shift} ago]"
        if o.mul != 1:
            s = f"{o.mul:g}×{s}"
        return s
    return f"{op(r.left)} {r.op} {op(r.right)}"


def refresh(eid: str) -> dict:
    from app.research.evaluate import evaluate
    from app.strategy.engine import run_strategy
    with _lock:
        d = _load()
        w = next((x for x in d["watch"] if x["experiment_id"] == eid), None)
    if w is None:
        raise HTTPException(404, f"{eid} isn't on the paper watch")
    since, until = date.fromisoformat(w["since"]), last_completed_session()
    if until < since:
        state = {"updated_at": ledger.now(), "since": w["since"], "until": until.isoformat(), "trades": [], "note": "no completed session yet"}
    elif eid.startswith("portfolio:"):
        state = _refresh_portfolio(eid.split(":", 1)[1], since, until, w)
    else:
        exp = ledger.get(eid)
        result = run_strategy(exp["spec"], since, until)
        run_id = runs.save("custom", {**result["params"], "experiment_id": eid, "period": "paper"}, result,
                           {"net_pnl": result["metrics"]["net_pnl"], "trades": result["metrics"]["trades"], "win_rate": result["metrics"]["win_rate"]})
        runs.update(run_id, {"name": f"{eid} · {exp['name']} · paper since {since}"})
        ext = evaluate(result, exp.get("capital", 500000)) if result["trades"] else None
        trades = [{"entry_at": t["entry_at"], "exit_at": t["exit_at"], "direction": t.get("direction"), "net": t["net"],
                   "reason": t.get("reason"), "open": t.get("reason") == "period_end", "hold_days": t.get("hold_days"),
                   "margin": t.get("margin")} for t in result["trades"]]
        try:
            vote = _vote_state(exp["spec"], until)
        except Exception as exc:  # noqa: BLE001 — the signal readout is an extra; the paper trades still count
            vote = {"error": f"{type(exc).__name__}: {exc}"}
        state = {"updated_at": ledger.now(), "since": w["since"], "until": until.isoformat(), "run_id": run_id,
                 "net_pnl": round(sum(t["net"] for t in trades), 2), "trades": trades,
                 "open_position": next((t for t in trades if t["open"]), None), "signal": vote,
                 "max_drawdown": ext["max_drawdown"] if ext else 0.0}
    with _lock:
        d = _load()
        for x in d["watch"]:
            if x["experiment_id"] == eid:
                x["last"] = state
        _save(d)
    return state


def _refresh_portfolio(pid: str, since: date, until: date, w: dict) -> dict:
    from app.strategy import portfolio as pf
    doc = pf.get(pid)
    result = pf.run_portfolio(doc["portfolio"], since, until)
    m = result["metrics"]
    run_id = runs.save("portfolio", {**result["params"], "portfolio_id": pid, "period": "paper"}, result,
                       {"net_pnl": m["net_pnl"], "trades": m["trades"], "win_rate": m["win_rate"], "members": len(result["members"])})
    runs.update(run_id, {"name": f"{doc['portfolio']['name']} · paper since {since}"})
    trades = [{"entry_at": t["entry_at"], "exit_at": t["exit_at"], "direction": t.get("direction"), "net": t["net"],
               "reason": t.get("reason"), "open": t.get("reason") == "period_end", "hold_days": t.get("hold_days"),
               "margin": t.get("margin"), "member": t.get("member")} for t in result["trades"]]
    signals = {}
    for mem in pf.resolve(pf.PortfolioSpec.model_validate(doc["portfolio"])):
        try:
            signals[mem["id"]] = {"name": mem["name"], **(_vote_state(mem["spec"], until) or {})}
        except Exception as exc:  # noqa: BLE001
            signals[mem["id"]] = {"name": mem["name"], "error": f"{type(exc).__name__}: {exc}"}
    return {"updated_at": ledger.now(), "since": w["since"], "until": until.isoformat(), "run_id": run_id,
            "net_pnl": round(sum(t["net"] for t in trades), 2), "trades": trades,
            "open_position": next((t for t in trades if t["open"]), None), "member_signals": signals,
            "max_drawdown": m.get("max_drawdown", 0.0)}


def _loop() -> None:
    while True:
        _time.sleep(600)
        try:
            if not breeze.is_connected or date.today().weekday() >= 5 or datetime.now().hour < 9:
                continue
            due = last_completed_session().isoformat()
            for w in _load()["watch"]:
                if (w.get("last") or {}).get("until") != due:
                    log.info("paper watch: refreshing %s", w["experiment_id"])
                    refresh(w["experiment_id"])
        except Exception:  # noqa: BLE001
            log.exception("paper watch refresh")


def start() -> None:
    if _started["v"]:
        return
    _started["v"] = True
    threading.Thread(target=_loop, name="paper-watch", daemon=True).start()
