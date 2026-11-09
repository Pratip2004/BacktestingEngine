"""Research CLI: talks to the running server (it owns the DuckDB lock), so experiments run in its runner.

  python -m app.research.cli queue research/cycle1.json   # queue every experiment in the file
  python -m app.research.cli status                        # runner, counts, current experiment
  python -m app.research.cli show E0001                    # one experiment's results per period

Set API (default http://127.0.0.1:8000) to point at another server.
"""

import json
import os
import sys
import urllib.error
import urllib.request

API = os.environ.get("API", "http://127.0.0.1:8000")


def call(method: str, path: str, body: dict | None = None):
    req = urllib.request.Request(API + path, method=method, data=json.dumps(body).encode() if body is not None else None,
                                 headers={"Content-Type": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=60) as r:
            return json.loads(r.read() or "null")
    except urllib.error.HTTPError as exc:
        return {"error": exc.code, "detail": json.loads(exc.read() or "{}").get("detail")}


def main(argv: list[str]) -> None:
    cmd = argv[0] if argv else "status"
    if cmd == "queue":
        data = json.loads(open(argv[1]).read())
        defaults = data.get("defaults", {})
        for exp in data["experiments"]:
            body = {**defaults, **exp}
            r = call("POST", "/research/experiments", body)
            print(r.get("id") or r, body["name"])
    elif cmd == "status":
        s = call("GET", "/research/status")
        print(json.dumps({k: s[k] for k in ("runner", "counts", "verdicts", "current", "breeze_calls_today")}, indent=1))
    elif cmd == "show":
        e = call("GET", f"/research/experiments/{argv[1]}")
        print(e["id"], e["name"], e["status"], e["verdict"])
        for k, r in e["results"].items():
            if r.get("error"):
                print(" ", k, "ERROR", r["error"])
                continue
            x = r["ext"]
            print(f"  {k:10} trades {x['trades']:4}  net ₹{x['net_pnl']:>10,.0f}  PF {x['profit_factor']}  t {x['t_stat']}  "
                  f"sharpe {x['sharpe']}  DD {x['max_drawdown_pct']}%  costs ₹{x['costs_total']:,.0f}  ex-top5 ₹{x['net_ex_top5']:,.0f}  "
                  f"checks {sum(c['pass'] for c in r['checks'])}/{len(r['checks'])}")
    else:
        print(__doc__)


if __name__ == "__main__":
    main(sys.argv[1:])
