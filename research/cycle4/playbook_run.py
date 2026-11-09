"""Lead's walk-forward regime playbook over every cycle-4 candidate (offline, on the store snapshot).

    PYTHONPATH=. MARKET_DB=.data/snapshots/market.duckdb BACKTEST_OFFLINE=1 \
      .venv/bin/python research/cycle4/playbook_run.py [--per-regime 1] [--min-t 1.0] [--confirm]

Runs each candidate ungated over its whole window (futures 2015-01 → 2026-10, options 2025-01 → 2026-10), then the
quarterly walk-forward from 2025 Q1 (choices use only trades closed before each quarter), and optionally confirms the
chosen mappings as real regime-gated portfolios through the engine. Writes .data/research/playbooks/<stamp>.json.
"""

import argparse
import glob
import json
from datetime import date, datetime

from app.config import BASE_DIR
from app.research.playbook import confirm, regime_before_day, walk_forward
from app.research.screen import screen
from app.strategy.portfolio import run_portfolio

WINDOW = {"futures": ("2015-01-01", "2026-10-26"), "options": ("2025-01-01", "2026-10-26")}


def load_candidates() -> list[dict]:
    out = []
    for path in sorted(glob.glob(str(BASE_DIR / "research" / "cycle4" / "agent-*.json"))):
        sub = json.load(open(path))
        for i, c in enumerate(sub.get("candidates", [])):
            out.append({"id": f"{sub['agent'].removeprefix('agent-')}-{i + 1}", "name": c["name"], "spec": c["spec"],
                        "instrument": c.get("instrument", "futures"), "agent": sub["agent"]})
    return out


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--per-regime", type=int, default=1)
    ap.add_argument("--min-t", type=float, default=1.0)
    ap.add_argument("--min-trades", type=int, default=8)
    ap.add_argument("--test-start", default="2025-01-01")
    ap.add_argument("--confirm", action="store_true")
    ap.add_argument("--only", default="", help="comma-separated candidate ids")
    a = ap.parse_args()
    cands = load_candidates()
    if a.only:
        cands = [c for c in cands if c["id"] in a.only.split(",")]
    for c in cands:
        start, end = WINDOW["options" if c["instrument"] == "options" else "futures"]
        r = screen(c["spec"], start, end, agent="lead-playbook")
        c["trades"] = r["result"]["trades"]
        print(f"{c['id']:<14} {c['name'][:50]:<50} trades {r['summary']['trades']:>4} net {r['summary']['net_pnl']:>12,.0f} "
              f"missing {r['summary']['missing_data']}", flush=True)
    regime = regime_before_day("NIFTY", date(2015, 1, 1), date(2026, 10, 26))
    res = walk_forward(cands, regime, date.fromisoformat(a.test_start), date(2026, 10, 26),
                       min_trades=a.min_trades, min_t=a.min_t, per_regime=a.per_regime)
    if a.confirm:
        res["confirm"] = confirm(res, cands, run_portfolio)
    print(json.dumps({k: res[k] for k in ("settings", "oos", "final")}, indent=1))
    for f in res["quarters"]:
        print(f["from"], f["choice"], f["test"])
    print("baselines", json.dumps(res["baselines"]))
    if a.confirm:
        print("confirm", json.dumps(res["confirm"]))
    out = BASE_DIR / ".data" / "research" / "playbooks"
    out.mkdir(parents=True, exist_ok=True)
    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    res["candidates"] = [{k: c[k] for k in ("id", "name", "agent", "instrument")} for c in cands]
    (out / f"{stamp}.json").write_text(json.dumps(res, default=str))
    print("saved", out / f"{stamp}.json")


if __name__ == "__main__":
    main()
