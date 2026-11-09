"""Queue cycle-4 candidates (an agent's hand-in file) as ledger experiments with the pre-registered periods.

    .venv/bin/python research/cycle4/queue_tests.py research/cycle4/agent-futtrend.json [--dry-run] [--train-from=2021-01-01]

Futures/spot candidates: train 2023–2024, test 2025-01-01 → 2026-10-26 (+ halves 2025 / 2026, + 2× slippage).
Option candidates: train 2025, test Jan–Oct 2026 (+ halves Jan–May / Jun–Oct, + 2× slippage). The server's runner
runs them through the engine (stored data: ~0 Breeze calls) and the Research lab shows them.
"""

import json
import sys
import urllib.error
import urllib.request

API = "http://localhost:8000"
CRITERIA = {"min_trades": 20, "min_profit_factor": 1.15, "min_t_stat": 2.0, "program_bar": False,
            "max_worst_day_pct": 10.0, "require_positive_ex_top": True}
WINDOWS = {
    "futures": [("train", "Train · 2023–2024", "in_sample", "2023-01-01", "2024-12-31"),
                ("test", "Test · Jan 2025 – Oct 2026", "out_of_sample", "2025-01-01", "2026-10-26"),
                ("test_a", "Test half A · 2025", "out_of_sample", "2025-01-01", "2025-12-31"),
                ("test_b", "Test half B · Jan–Oct 2026", "out_of_sample", "2026-01-01", "2026-10-26")],
    "options": [("train", "Train · 2025", "in_sample", "2025-01-01", "2025-12-31"),
                ("test", "Test · Jan–Oct 2026", "out_of_sample", "2026-01-01", "2026-10-26"),
                ("test_a", "Test half A · Jan–May 2026", "out_of_sample", "2026-01-01", "2026-05-31"),
                ("test_b", "Test half B · Jun–Oct 2026", "out_of_sample", "2026-06-01", "2026-10-26")],
}


def periods(instrument: str, train_from: str | None = None) -> list[dict]:
    w = WINDOWS["options" if instrument == "options" else "futures"]
    out = [{"key": k, "label": label, "role": role, "from": a, "to": b} for k, label, role, a, b in w]
    if train_from and instrument != "options":  # round 2: futures train from 2021
        out[0] = {**out[0], "from": train_from, "label": f"Train · {train_from[:4]}–2024"}
    test = next(p for p in out if p["key"] == "test")
    out.append({**test, "key": "test_2x", "label": test["label"] + ", 2× slippage", "role": "stress",
                "cost_overrides": {"slippage_points": 1.0, "fut_slippage_points": 2.0}})
    return out


def main(path: str, dry: bool, train_from: str | None = None) -> None:
    sub = json.load(open(path))
    for c in sub.get("candidates", []):
        body = {"name": c["name"], "family": c.get("family", "cycle4"), "source": sub.get("agent", "agent"),
                "stage": "cycle4", "capital": 500000, "priority": 5, "hypothesis": c.get("hypothesis", ""),
                "mechanism": c.get("mechanism", ""), "failure_modes": c.get("failure_modes", ""),
                "novelty": f"regimes expected {c.get('regimes_expected')}; gate suggestion: {json.dumps(c.get('gate_suggestion'))}",
                "spec": c["spec"], "periods": periods(c.get("instrument", "futures"), train_from), "criteria": CRITERIA,
                "next_action": "Test once (protocol v4); then walk-forward playbook / buckets"}
        if dry:
            print("would queue", c["name"], [p["key"] for p in body["periods"]])
            continue
        req = urllib.request.Request(f"{API}/research/experiments", data=json.dumps(body).encode(),
                                     headers={"Content-Type": "application/json"})
        try:
            print("queued", json.load(urllib.request.urlopen(req))["id"], c["name"])
        except urllib.error.HTTPError as exc:
            print("failed", c["name"], exc.code, exc.read().decode()[:300])


if __name__ == "__main__":
    tf = next((a.split("=", 1)[1] for a in sys.argv if a.startswith("--train-from=")), None)
    main(sys.argv[1], "--dry-run" in sys.argv, tf)
