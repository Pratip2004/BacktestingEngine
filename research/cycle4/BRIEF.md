# Cycle 4 brief: regime-aware, signal-driven algos and buckets

*Shared brief for every family agent in cycle 4 (28 Oct 2026). Read `CLAUDE.md` (platform) and
`docs/HANDOVER.md` (what cycles 1–3 found) first.*

## What the owner wants
- Markets move in cycles. Find algos that each work in **some** regime. A **bucket** (portfolio) of several
  algos runs at once, each with its own entry and exit signals and a gate that says when it may trade.
- **Use signals properly to enter and exit**: TradingView-style indicators decide the entry, and an indicator
  exit (signal exit, opposite signal, ATR or underlying stop) closes it. Don't just rely on time.
- Don't trade every day: only when the conditions pass. Trades may last minutes or up to about a month.
- Options and futures. Defined risk overnight; **futures always with a stop**. No naked option shorts
  overnight.
- Sizing: **1 lot per algo**. A bucket is measured against **₹5 lakh**. There are no cross-algo rules.

## Data you can use (offline, free)
| Data | Range |
|---|---|
| NIFTY spot 1m, current-month futures (+ next month in the last 10 sessions before expiry) | 2023-01 → 2026-10-26 |
| SENSEX spot 1m; futures | spot 2023 → ; futures mid-2024 → (sparse before) |
| NIFTY / SENSEX weekly options | **sparse** (~13–20 contract-days a day, scattered strikes from earlier experiments; correction 28 Oct after agent-optswing): option ideas can't be screened offline. They run online through the ledger runner, which fetches only the contracts each trade needs (~1 call per leg-contract per 2 days) |
| Daily candles NIFTY, BSESEN, India VIX (`params.symbol: "VIX"` on 1d/1w) | 2015 → 2026-10-27 |

Monthly options aren't stored except when the monthly is one of the nearest 2 weeklies. Missing data is
treated as "no candles" and the trade is skipped. The screen summary reports `missing_data` and `skipped`;
keep them small, or the result is biased.

## Windows (pre-registered; this is the protocol)
- **Futures and spot algos:**
  - **Train** (yours) 2023-01-01 → 2024-12-31.
  - **Test** (the lead's, run once per submitted candidate) 2025-01-01 → 2026-10-26.
- **Option algos:**
  - **Train** 2025-01-01 → 2025-12-31.
  - **Test** 2026-01-01 → 2026-10-26. Be aware that cycle 3 already looked at 2026 option ideas, so this test
    isn't virgin; prefer ideas that are *different* from cycle 3's (see the HANDOVER table).
- Always run screens with `SCREEN_TRAIN_END` set to your training end. The screen refuses later dates. **Never
  look at the test window** in any other way: no reading the DuckDB for those dates, no plotting it.
- The test pass rule, per candidate (applied by the lead, all must hold):
  - net > 0
  - profit factor ≥ 1.15
  - daily t ≥ 2.0
  - still profitable at 2× slippage
  - still profitable without the best 5% of trades
  - worst day ≥ −10% of ₹5L
  - both halves of the test (2025 / 2026 for futures; Jan–May / Jun–Oct 2026 for options) not losing
- Then the lead builds **walk-forward regime playbooks** (`app/research/playbook.py`) and buckets from all
  candidates: per quarter, choose the best algo per regime using only past trades.

## How to screen
```bash
cd /root/pratip/BacktestingEngine
export PYTHONPATH=. MARKET_DB=.data/snapshots/market.duckdb BACKTEST_OFFLINE=1 SCREEN_TRAIN_END=2024-12-31  # options: 2025-12-31
.venv/bin/python <your script in your scratch dir>
```
```python
from app.research.screen import screen, screen_many, screen_portfolio
r = screen(spec_dict, "2023-01-01", "2024-12-31", agent="agent-futtrend", capital=500000)
r["summary"]  # trades, net_pnl, profit_factor, win_rate, t_stat, sharpe, max_drawdown(_pct), worst_day, net_ex_top_k, missing_data …
r["by_year"], r["by_half"], r["result"]["trades"]  # trades carry entry_at, exit_at, net, exit_reason, daily_mtm, legs
rows = screen_many([spec1, spec2, ...], start, end, agent="...")  # sequential, one process
```
- **Specs**:
  - Field definitions: `app/strategy/spec.py`.
  - Examples: `app/strategy/templates.py`, `tests/test_swing.py`, and `research/cycle2_protocol_v2.json`.
  - Indicators: built-ins listed in `spec.BUILTIN_INDICATORS`; the extended list via
    `from app.strategy.indicators import catalogue; catalogue()`.
- **Multi-day:**
  - Set `holding: {mode: "swing", max_days, exit_time, exit_before_expiry, check}`.
  - Entries on `1d`/`1w` signals happen at `entry.next_day_time` on the next day.
  - Use `exits.underlying_stop` (ATR, trailing, `target_mult`), `exits.exit_signal` and
    `exits.exit_on_opposite_signal`.
- **Regime gate:** a condition on the operand `{"ind": "regime", "tf": "1d", "params": {"model": "trend_vol"}}`.
  - Use `==` / `!=` against `{"ind": "value", "params": {"value": N}}`.
  - Codes: 1 up/calm · 2 up/volatile · 3 range/calm · 4 range/volatile · 5 down/calm · 6 down/volatile.
  - Models `trend` (1/0/−1) and `vol` (0/1) are also available.
  - Also usable as gates: VIX on 1d (`{"ind": "price", "tf": "1d", "params": {"symbol": "VIX"}}`), ADX,
    choppiness, efficiency_ratio, hv_percentile, squeeze…
- **Speed:** about 5 s per daily swing futures spec over 2 years and about 9 s for 15-minute intraday. Option
  specs are slower.
- **Memory is tight** (about 250 MB per process): run **one** python process at a time, never in parallel.

## Budget and honesty
- At most **~150 screens** per agent. Every screen is logged to `.data/research/screens.jsonl` and counts as
  a look in the multiple-testing count.
- Prefer a few economically motivated ideas with small, round parameter grids over big optimisations.
  Report how many you ran.
- A candidate should make sense: say *why* it should work, in which regime, and what would break it.
  Check that it isn't one lucky month (`by_half`, `net_ex_top_k`), that costs are realistic, and that
  `missing_data` is ~0.
- It's fine to submit nothing. Never manufacture a winner.

## Rules
- **Read-only.** Never call Breeze; never place, modify or cancel orders; don't touch account endpoints.
- **Don't edit** anything under `app/`, `client/`, `tests/`, `main.py` (the live server reloads and
  interrupts work). If the platform is missing a feature or has a bug, describe it in your final report
  with a minimal reproduction. Write scripts and scratch output only in your scratch directory.
- Don't open `.data/market.duckdb` (the server holds it); use the snapshot.

## What to hand in
Write `research/cycle4/<agent-name>.json`:
```json
{"agent": "agent-futtrend", "screens_run": 87, "notes": "what you tried, what failed, what you learned",
 "platform_issues": ["..."],
 "candidates": [
   {"name": "...", "family": "fut-trend", "instrument": "futures|options",
    "hypothesis": "...", "mechanism": "why it should make money", "failure_modes": "...",
    "regimes_expected": [1, 2], "spec": { /* the ungated StrategySpec */ },
    "gate_suggestion": { /* optional regime/indicator Condition */ },
    "train": {"summary": {...}, "by_year": {...}, "by_half": {...}, "gated_summary": {...}}}
 ]}
```
Submit **≤ 6 candidates**, each as the **ungated** spec (the playbook decides gates by itself), plus your
suggested gate and its training result. Your final message should be a short plain-English summary of the
candidates and what you learned.

---

# Round 2 (28 Oct 2026, evening): changes to the brief above

**Read this section last; it overrides the sections above where they differ.**

- **Engine 6.** Two bugs were fixed during round 1:
  - **Daily ATR stops were frozen.** The daily ATR for underlying stops used only the backtest's first day, so
    stop distances depended on the start date.
  - **Daily exit signals were late.** With `check: "1d"`, a daily exit signal waited for that day's close.

  Any number from before these fixes is stale.
- **New: intraday underlying stop.** `exits.underlying_stop` (ATR on any timeframe or points, `trail`,
  `target_mult`) now also works **intraday**. It checks every index minute and fills at the next minute's
  open. It gives a one-sided, trailing stop for intraday futures.
- **Longer futures training window: 2021-01-01 → 2024-12-31** (NIFTY spot + futures now stored from 2021).
  - Set `SCREEN_TRAIN_END=2024-12-31`.
  - Lot sizes: 75 until Jul 2021, then 50, then 25 from Apr 2024, then 75 from Nov 2024. Compare in index
    points as well as ₹.
- **Cheap long-history pre-check (strongly encouraged).** For any daily-timeframe idea, first test the rule on
  NIFTY daily candles **2012-01-01 → 2020-12-31**:
  - Read them from the snapshot: `select d, open, high, low, close from daily_1d where symbol='NIFTY'`.
  - India VIX is `symbol='INDVIX'`.
  - Use plain pandas in index points with ~3 points of round-trip cost, next-open fills, and no lookahead.
  - Only take ideas that hold there to the engine on 2021–2024.
  - Never read daily_1d rows after 2024-12-31.
  - Count each pre-check as a screen: call `app.research.screen.log_look(agent, name, "daily-precheck", start,
    end, {"net_pnl": pts, "trades": n, "t_stat": t})`.
- **Don't resubmit round-1 ideas or close variants.** Round 1 submitted, and all failed the test:
  - daily EMA20/50 (+ weekly EMA10) long/short futures trend
  - z-score(20) < −1.5 dip buy with RSI(2) > 70 exit
  - Connors RSI(2) < 10 above SMA200
  - 30m Supertrend(10,3) intraday aligned with daily EMA20, with an ±80 pt bracket or a signal exit
- **Lead's lesson from round 1:** about 20–30 trades in 2 years can't show an edge. Prefer rules that trade
  often enough, at least ~60 trades over 2021–2024. Signals that agree across several indicators (votes or
  scores) are usually more stable than one tuned threshold.
