# BacktestingEngine

A FastAPI service that pulls market data from the **ICICI Direct Breeze API** (`breeze-connect` Python SDK) and runs strategy backtests on it. It is **read-only**: it never places, modifies or cancels orders.

## Running

`make install` once, then `make dev` (backend :8000 + dashboard :5173, Ctrl-C stops both). `make server` / `make client` run them separately; `make` lists all targets. `HOST`, `PORT`, `UI_PORT` override defaults (backend binds 127.0.0.1 so the Breeze session isn't exposed on the network).

Manually:
```bash
source .venv/bin/activate
pip install -r requirements.txt
uvicorn main:app --reload          # or: python main.py
```

API docs: http://localhost:8000/docs

Dashboard (second terminal):
```bash
cd client && npm install && npm run dev   # http://localhost:5173
```

## Frontend (`client/`)

React 19 + Vite + TypeScript + **Ant Design v5** + Tailwind v4 + React Query + Recharts. SaaS look: Inter (`@fontsource-variable/inter`), indigo `#4F46E5` primary, slate palette, dark sidebar (`#0B1220`); theme tokens in `main.tsx`.

- **Shell (`App.tsx`)**: dark grouped sidebar (Research: Research lab, Overview, Backtest, Options analytics · Data: Data store, Market data · Account: Account, Session) with a Breeze/call-budget card at the bottom; header with a ⌘K / Ctrl+K **command palette** (`components/CommandPalette.tsx`: pages, actions, saved runs) and a New backtest button.

- Vite proxies `/api/*` → `http://localhost:8000/*` (prefix stripped), so the backend needs no CORS. See `client/vite.config.ts`.
- antd's CSS-in-JS goes into the `antd` cascade layer (`<StyleProvider layer>` in `main.tsx`, layer order in `index.css`), so Tailwind utilities override antd while Tailwind's preflight doesn't. `@ant-design/v5-patch-for-react-19` is imported first for React 19 compatibility.
- `src/api/client.ts`: axios instance, TS types for every endpoint, React Query hooks, `errorMessage()` for FastAPI errors.
- `src/components/`: shared pieces. `SectionCard`, `PageTitle`, `StatCard`, `BreezeData` (renders any Breeze list/object as a table or descriptions), `InstrumentFields` (+ `toApiParams()` for dayjs → ISO params), `ConnectionGate` (prompts login when there's no session).
- `src/pages/`: one file per page with private sub-components.

| Route | Page | Backend calls |
|---|---|---|
| `/research` | Research lab: phase, runner (pause/resume), team, now-running progress, candidate leaderboard, all experiments, detail drawer (`?exp=`: hypothesis, criteria, per-period stats, checks, equity/drawdown, cost waterfall, monthly, by hour, audit/critic notes, spec), timeline, protocol | `/research/*` |
| `/` | Overview: getting-started checklist (login → download data → first backtest), KPIs, quick-start tiles, recent runs | `/auth/status`, `/data/status`, `/runs` |
| `/data` | Data store: stats, downloader (state, jobs, pause/resume, retry failed, cancel), backfill planner (estimate calls/ETA, start), 12-month coverage calendar per underlying with per-day contract drawer, settings | `/data/*` |
| `/backtest` | Hub with tabs (`BacktestHub.tsx`, nested routes): `/backtest/strategies`, `/backtest/builder`, `/backtest/portfolio`, `/backtest/straddle`, `/backtest/ema-butterfly`, `/backtest/stock`, `/backtest/saved` (`/backtest/compare` highlights Saved runs). `/backtest` → `/backtest/strategies` (or `/backtest/stock` when it has `?run=`). Old `/straddle`, `/option-strategy`, `/runs` redirect with their query string. Breadcrumb `backtestCrumb` in `lib/nav.ts` | – |
| `/backtest/strategies` | Saved strategies (open, delete) + templates gallery by category | `/strategies`, `/strategies/templates` |
| `/backtest/builder` | Visual builder (`?template=`, `?strategy=`, `?run=`; priority strategy > run > template > blank): 5 steps (Basics, Entry, Legs, Exits, Costs) in `components/builder/`, side panel with plain-English summary, payoff, checks, period + data check + run; save / save as new (versioned). Results (`StrategyResults`) with per-trade Replay drawer, then Optimize (`SweepPanel`: 1–2 parameters, ≤36 combinations, optional walk-forward, heatmaps, "Use it" applies the best cell) | `/strategies/*`, `/options/jobs/{id}` |
| `/backtest/portfolio` | Strategy portfolio (`?portfolio=`, `?run=`): bucket of up to 12 algos (saved strategy or template, × lots, on/off), each with a gate (Always / market regime checkboxes / indicator conditions via `ConditionBuilder`, daily tf). Results (`components/portfolio/PortfolioResults`): Portfolio tab (KPIs incl. return/DD % of capital, peak open positions & combined margin; equity total + per algo with drawdown; algos table; P&L by regime × algo; daily P&L correlation; monthly matrix; all trades with Algo column and replay) plus one tab per algo with its full `StrategyResults` | `/portfolios/*`, `/options/jobs/{id}` |
| `/backtest/saved` | Saved runs: every saved run (filter by strategy, search, rename inline, open, download PDF, delete), per-strategy counts and combined net P&L. Select 2–4 → Compare | `/runs` |
| `/backtest/compare?ids=` | Compare 2–4 runs: metrics table (builder runs full metrics, others their summary), equity overlay for builder runs | `/runs/{id}` |
| `/backtest/stock` | Strategy form (params from `/backtest/strategies`), metrics, equity vs buy & hold chart, trades | `POST /backtest` |
| `/backtest/ema-butterfly` | EMA crossover butterfly: config (range, timeframe, EMAs, wing, lots, costs) loads candidate trades. The exit lab has target / stop-loss sliders (% of premium), square-off and last-entry times, live stats, a clickable target × stop heatmap, a best/worst scatter, equity, signals chart and trades with legs | `POST /backtest/options-butterfly`, `/options/jobs/{id}` |
| `/backtest/straddle` | ATM straddle: option buy / sell, period (with presets), entry times to load (previous-day and same-day minutes), lots, costs. The lab has Buy/Sell switch, entry-time switch, DTE day filter chips, exit levels same-for-all or per DTE (buy target ×; sell target % kept + stop-loss %, with best-per-day suggestions), exit time, live stats, sell target × stop map, entry-time and DTE comparison tables (clickable), "which target?" charts, daily P&L, equity and trades | `POST /backtest/straddle`, `/options/jobs/{id}` |
| `/options` | Live chain tab (expiry select, ±3/5/8/10, auto-refresh, CE/PE chain table, OI / change-in-OI / IV smile charts). Expiry comparison tab (job + progress, summary table, ATM IV / PCR / straddle trends, strike × expiry heatmap, per-expiry drill-down with ATM OI build-up) | `/options/*` |
| `/market` | Tabs: Historical (chart + table), Quotes, Option chain, Names | `/market/*` |
| `/account` | Funds, demat holdings, positions | `/account/*` |
| `/session` | Login link, apisession form, customer details | `/auth/login-url`, `/auth/session` |

UI conventions: light mode only, Zinc text palette set in `ConfigProvider`, antd `Typography` for text, Tailwind for layout. Settings-shaped pages use `max-w-4xl mx-auto px-4 py-8 space-y-6`; overview-shaped ones use `padding: 24`. Chart colors: categorical slot 1 `#2a78d6` (strategy/price/calls), slot 2 `#eb6834` (buy & hold/puts), 2px lines, recessive grid. Heatmaps use the single-hue blue sequential ramp. Set `API_URL` to point the Vite proxy at a backend other than :8000.

### `.env`

| Variable | Required | Purpose |
|---|---|---|
| `APP_NAME` | no | FastAPI title |
| `API_KEY` | yes | Breeze app API key |
| `API_SECRECT_KEY` | yes | Breeze app secret (the misspelling is intentional, it matches the existing `.env`) |
| `BREEZE_SESSION_TOKEN` | no | Today's `apisession` token, used to connect at startup |

Never commit `.env` or `.breeze_session` (both are in `.gitignore`). Never log or print the API key or secret.

## Breeze authentication (daily)

Breeze sessions expire every day, so login cannot be fully automated.

1. `GET /auth/login-url` returns `https://api.icicidirect.com/apiuser/login?api_key=<url-encoded key>`.
2. Open it in a browser and log in with ICICI credentials + OTP.
3. ICICI sends the token to the **redirect URL registered on the Breeze app**. Set it to `http://127.0.0.1:8000/auth/callback`.
   - `/auth/callback` accepts the token as `?apisession=` (GET) or as an `apisession` / `API_Session` form field (POST), connects, then 303-redirects to `FRONTEND_URL/session?connected=1` (or `?error=...`). `FRONTEND_URL` defaults to `http://localhost:5173`.
   - Otherwise copy the token and `POST /auth/session {"session_token": "..."}`.
4. The server calls `generate_session(api_secret, session_token)` and caches the token in `.breeze_session`. On restart, `BreezeManager.try_restore()` retries the token from `.env`, then the cached one.

## Project layout

```
main.py                     FastAPI app, lifespan restores the Breeze session, GET /
app/config.py               pydantic-settings Settings loaded from .env
app/breeze_client.py        BreezeManager singleton `breeze`: login URL, connect, unwrap responses,
                            historical_df() (chunked get_historical_data_v2 → pandas DataFrame)
app/routers/auth.py         /auth/*
app/routers/market.py       /market/*  (historical, quotes, option chain, names)
app/routers/account.py      /account/* (funds, holdings, positions; read-only)
app/routers/backtest.py     /backtest, /backtest/strategies
app/backtest/strategies.py  strategy functions: df -> position series (1 long / 0 flat)
app/backtest/options_engine.py  butterfly_candidates(): EMA-crossover call/put butterfly candidates + per-candle P&L paths
app/backtest/straddle_engine.py straddle_days(): per-day ATM straddle minute paths for each entry time (incl. previous-day)
app/backtest/engine.py      run_backtest(): long-only, fills at next bar's open, metrics;
                            equity_curve rows carry equity + buy_and_hold
app/options/greeks.py       Black-Scholes price, delta, implied_vol (bisection). Breeze returns no IV.
app/options/expiries.py     upcoming expiries (SecurityMaster), past expiry candidates by NSE weekday rule
app/options/service.py      live_chain(), expiry_snapshot(), expiry_comparison(); same T_Chain shape for both
app/options/jobs.py         in-memory background jobs with progress (lost on restart)
app/runs.py                 saved backtests in .data/runs/ ({id}.meta.json + {id}.result.json); runs.saving() wraps job fns
app/routers/runs.py         /runs/*
app/data/instruments.py     NIFTY / SENSEX config: ICICI codes, exchanges, strike step, dated expiry weekday + lot size rules
app/data/store.py           DuckDB store (.data/market.duckdb): spot_1m, fut_1m, opt_1m, fetch_log, ingest_queue, settings, calls, lot_sizes, cost_schedule
app/data/access.py          option_minute_bars / spot_minute_bars: read the store, fetch only missing contract-days; resample
app/data/daily.py           daily_bars(): daily candles (NIFTY, BSESEN, INDVIX = India VIX) in daily_1d, long history for 1d/1w indicators
app/data/ingest.py          backfill planner (include_options=False → spot + futures only), background worker (budget, retries), nightly job, import of old JSON caches
app/routers/data.py         /data/*
app/strategy/spec.py        StrategySpec v1 (Pydantic): schedule, position/legs, exits, risk, costs; validate_spec() → errors, warnings
app/strategy/indicators.py  extended indicator REGISTRY (TradingView-style; @register name/lookback/fields), GET /strategies/indicators
app/strategy/margin.py      margin_required(): money blocked per trade (premium for buys, max loss for hedged, % of spot × qty for shorts/futures; settings short_margin_pct / fut_margin_pct)
app/strategy/regimes.py     market regime models (trend_vol / trend / vol) from daily candles + VIX, fixed textbook thresholds
app/strategy/signals.py     indicators (EMA/SMA/RSI/VWAP/MACD/Supertrend/BBands/ATR/ORB/prev-day/gap…) on 09:15-anchored candles, no lookahead; signal_times()
app/strategy/engine.py      generic engine run_strategy(spec, from, to): intrabar (up/down scenarios) or candle-close exits, per-leg + combined + trailing, re-entry, day risk, DatedCosts
app/strategy/templates.py   10 templates (straddles, strangle, condor, iron fly, EMA butterfly, ORB, Supertrend spread, RSI)
app/strategy/library.py     saved strategies in .data/strategies/{id}.json with versions
app/strategy/swing.py       SwingEngine(Engine): multi-day holding (holding.mode swing): entries by time / intraday signal / 1d-1w signal (next day at next_day_time), exits at holding.check closes across days, underlying stop every minute (gap-aware), max_days / exit_before_expiry / period end, per-trade daily_mtm
app/strategy/portfolio.py   PortfolioSpec (members: strategy_id or inline spec, lots, gate, enabled), gated_spec() ANDs a gate into entries, run_portfolio() runs members and combines them (daily MTM, equity, correlation, monthly, by regime, concurrency); saved portfolios in .data/portfolios/
app/routers/portfolios.py   /portfolios/*
app/strategy/analysis.py    replay() one trade minute by minute (portfolio runs: ?member=; multi-day trades: every day held); sweep() 1–2 parameter grid, optional walk-forward
app/routers/strategies.py   /strategies/*
app/routers/options.py      /options/*
app/research/ledger.py      research ledger in .data/research/ (experiments/{id}.json, events.jsonl, state.json); fingerprint / economic_key duplicate detection
app/research/evaluate.py    research metrics (capital/margin, all-day Sharpe, cost split, block bootstrap, top-5% / worst-day tests) and gates
app/research/runner.py      background thread: runs queued experiments period by period via run_strategy, saves each as a `custom` run
app/research/screen.py      offline screening on a store snapshot (agents), screens.jsonl look log
app/research/playbook.py    walk-forward regime playbook (quarterly best algo per regime, confirm via gated portfolios)
app/research/cli.py         `python -m app.research.cli queue research/<file>.json | status | show E0001` (talks to the running server)
app/routers/research.py     /research/*
research/                   experiment definitions per cycle (JSON, queued with the CLI)
tests/                      pytest (`.venv/bin/python -m pytest tests`); store access is faked, so they run while the server holds the DB
client/                     React dashboard (see Frontend below)
```

## Our HTTP endpoints

| Method | Path | Breeze method used | Notes |
|---|---|---|---|
| GET | `/` | – | Health check plus `breeze_connected` |
| GET | `/auth/login-url` | – | Builds the login URL |
| GET | `/auth/callback?apisession=` | `generate_session`, `get_customer_details` | Redirect target |
| POST | `/auth/session` | `generate_session`, `get_customer_details` | Manual token entry |
| GET | `/auth/status` | – | Session state |
| GET | `/market/historical` | `get_historical_data_v2` | Chunked past 1000 candles |
| GET | `/market/quotes` | `get_quotes` | |
| GET | `/market/option-chain` | `get_option_chain_quotes` | |
| GET | `/market/names` | `get_names` | Symbol → ICICI stock code |
| GET | `/account/funds` | `get_funds` | |
| GET | `/account/holdings` | `get_demat_holdings` | |
| GET | `/account/positions` | `get_portfolio_positions` | |
| GET | `/options/expiries?stock_code=NIFTY` | – (SecurityMaster zip) | Upcoming expiries, cached daily in `.cache/` |
| GET | `/options/chain?expiry=&strikes=5&rate=6.5` | `get_option_chain_quotes` (call + put), `get_quotes` fallback for spot | Live ATM ± N chain with computed IV/delta, PCR, max pain, OI walls |
| POST | `/options/expiry-comparison` | `get_historical_data_v2` (cash spot + one call per strike/right/expiry) | Background job → `{job_id}` |
| GET | `/options/jobs/{job_id}` | – | Job status / progress / result |
| POST | `/backtest/options-butterfly` | `get_historical_data_v2` (NIFTY intraday + each leg's intraday candles) | Butterfly candidates for the exit lab, background job → `{job_id}`, poll `/options/jobs/{id}` |
| POST | `/backtest/straddle` | `get_historical_data_v2` (NIFTY daily + 1-minute, ATM CE/PE 1-minute per entry time per day) | Per-day straddle paths for the straddle lab, background job → `{job_id}` |
| GET | `/runs` | – | Saved backtests (metadata), newest first |
| GET | `/runs/{id}` | – | One saved backtest incl. full result |
| PATCH | `/runs/{id}` | – | Update `name`, `view` (UI exit settings) or `summary` |
| DELETE | `/runs/{id}` | – | Delete a saved backtest |
| GET | `/data/status` | – | Store stats, downloader state/queue/jobs, settings |
| GET | `/data/coverage?underlying=&start=&end=` | – | Per-day spot/futures status and option contract-days ok/empty/failed/pending |
| GET | `/data/day?underlying=&day=` | – | Every contract logged for a day |
| POST | `/data/backfill` | `get_historical_data_v2` (1day for planning) | Plan (`dry_run`) or queue a download; returns calls + ETA |
| PATCH | `/data/settings` | – | Budget, underlyings, strike band, expiries, nightly job |
| POST | `/data/worker/{pause,resume}`, `/data/queue/retry-failed`; DELETE `/data/queue` | – | Downloader control |
| GET | `/strategies/templates` | – | Builder templates |
| POST | `/strategies/validate` | – | `{spec}` → `{ok, errors[{path,message}], warnings, spec}` |
| GET | `/strategies/data-check?underlying=&from_date=&to_date=` | – | Weekdays vs spot/option days already stored |
| POST | `/strategies/run` | via the store (`get_historical_data_v2` for missing contract-days) | `{spec, from_date, to_date, strategy_id?}` → job; result saved as a `custom` run |
| POST | `/strategies/sweep` | same | `{spec, from_date, to_date, params[{path,label,values}], walk_forward, in_sample_pct}` → job (≤36 combinations) |
| GET | `/strategies/replay/{run_id}/{index}` | same | Trade replay: underlying, leg closes, position P&L on one timeline |
| GET/POST | `/strategies`; GET/PUT/DELETE `/strategies/{id}` | – | Saved strategy library (PUT adds a version) |
| GET | `/market/margin-check?underlying=&lots=` | `get_quotes`, `margin_calculator` (places nothing) | Live ATM short straddle: Breeze margin vs the backtest estimate; `implied_pct` to calibrate `short_margin_pct` |
| GET | `/strategies/indicators` | – | Built-in + extended indicator catalogue |
| POST | `/portfolios/validate` | – | `{portfolio}` → `{ok, errors[{member,message}], warnings, portfolio}` (each member checked with its gate applied) |
| POST | `/portfolios/run` | via the engine | `{portfolio, from_date, to_date, portfolio_id?}` → job; result saved as a `portfolio` run |
| GET/POST | `/portfolios`; GET/PUT/DELETE `/portfolios/{id}` | – | Saved portfolios |
| GET | `/research/regimes?underlying=&start=&end=&model=` | `get_historical_data_v2` 1day (cached) | Daily regime labels + counts |
| GET | `/research/status` | – | Phase, agents, runner, counts, current progress, calls today, recent events |
| GET | `/research/playbooks`, `/research/playbooks/{id}` | – | Saved walk-forward regime playbook runs |
| GET/POST | `/research/experiments`; GET/PATCH `/research/experiments/{id}` | via the engine | Create (409 on exact duplicate), list, detail; PATCH verdict / notes / `add_periods` / `rerun` (archives old results) |
| GET/POST | `/research/events`; PATCH `/research/state`; POST `/research/runner/{pause,resume}` | – | Timeline, program state, runner control |
| GET | `/backtest/strategies` | – | Lists strategies + default params |
| POST | `/backtest` | `get_historical_data_v2` | Runs a strategy over fetched candles |

Example backtest body:
```json
{"stock_code": "RELIND", "exchange_code": "NSE", "interval": "1day",
 "from_date": "2023-01-01T00:00:00", "to_date": "2024-12-31T00:00:00",
 "strategy": "sma_crossover", "params": {"fast": 20, "slow": 50},
 "initial_capital": 100000, "commission_pct": 0.03}
```

### Options analytics: how it works
- **Live chain**: two `get_option_chain_quotes` calls (right=call, put) return the whole expiry; ATM = strike nearest `spot_price`; the window is ATM ± N listed strikes. Max pain uses the full chain's OI. T = time to expiry day 15:30.
- **Past expiries**: expired contracts aren't in the live chain, so each leg comes from `get_historical_data_v2` (1day, 30-day window ending on expiry, includes `open_interest`). Expired-contract candles are cached forever in `.cache/options/` (one JSON per expiry/strike/right).
- **Expiry dates**: NIFTY weekly/monthly expiry is Tuesday from 2 Sep 2025, Thursday before. Candidates are generated by that rule, then snapped back to the previous trading day using NIFTY daily candles (handles holidays). Monthly = last expiry weekday of the month.
- **Snapshot**: close of the trading day `days_before_expiry` before expiry. Spot = NIFTY close that day, ATM = spot rounded to the strike step (`STRIKE_STEP`, NIFTY 50). With 0 days, IV is undefined (T = 0).
- **Cost**: count × (2·strikes+1) × 2 calls (≈220 for 10 × ±5). `BreezeManager.call` throttles all Breeze calls to ≈92/min (`MIN_CALL_INTERVAL`), so the first run takes ~2.5 min; reruns are instant from cache.
- IV uses a configurable risk-free rate (default 6.5%) and no dividend yield.

### EMA crossover butterfly (`app/backtest/options_engine.py`, `client/src/lib/flySim.ts`, page `/backtest/ema-butterfly`)
The user's strategy, as agreed. **Entry is fixed; exits are chosen interactively in the exit lab.**
- **Signal** on NIFTY `5minute` candles (configurable 1m/5m/30m): EMA 9 crossing above EMA 21 → bullish; below → bearish. Confirmed at a bar's close, entered at the **next bar's open, same day only** (a cross on the day's last bar is dropped), using each leg's own candle.
- **Bullish**: long call butterfly: buy 1 ATM CE, sell 2 ATM+200 CE, buy 1 ATM+400 CE. **Bearish**: the put mirror (ATM, ATM−200, ATM−400 PE). ATM = spot at the entry bar's open rounded to 50. `wing` and `lots` are configurable.
- **Expiry**: nearest weekly strictly after the entry day. Past expiries come from `weekly_expiries_between()` (weekday rule + holiday snap); upcoming ones from SecurityMaster.
- **Exit (user's rules)**: capital = **premium paid** (net debit × qty, after slippage). Target / stop-loss are % of that, on **net** P&L (after slippage and all costs), checked at **every candle close**, and the exit fills at that close. Otherwise **square off the same day** (default 15:15 = close of the last candle ending by then). **One position at a time**: crossovers while a trade is open are ignored. Optional "no new entries after" time (default 15:00).
- **How it's split**: the backend (`butterfly_candidates`) returns every crossover as a candidate with `path` = net P&L "if closed at this candle's close" for each candle to the day's end, plus leg closes. `simulate()` in `flySim.ts` replays exits client-side, so sliders, the target × stop heatmap (`sweep()`), the best/worst (MFE/MAE) scatter, equity and trades update instantly with no new Breeze calls.
- **Costs**: ₹20/order brokerage, 0.5 pt slippage per leg per side, plus STT 0.1% on sell premium, NSE 0.03503%, SEBI ₹10/cr, stamp 0.003% on buys, GST 18% on (brokerage + exchange + SEBI). Lot size 65. Round-trip costs alone are ≈14% of a typical ~₹2.5–3K premium, so stops tighter than that trigger almost immediately.
- **Data**: leg candles are cached per contract per day in `.cache/options_intraday/`. About 3 Breeze calls per crossover on the first run. `historical_df` sizes intraday chunks in trading days (`INTRADAY_BARS_PER_DAY`). If a leg has no candle on the entry day, or the fly prices at a credit, the crossover is listed in `skipped`.

### ATM straddle, buy or sell (`app/backtest/straddle_engine.py`, `client/src/lib/straddleSim.ts`, page `/backtest/straddle`)
The user's second strategy, as agreed (buy side first, then a sell side on the same data):
- **Entry times** (several loaded per run, switched instantly in the lab): `"HH:MM"` on the trade day (09:15–14:59) or `"D-1 HH:MM"` on the previous trading day (15:00–15:59), held overnight. The previous-day window covers both the old close (15:15–15:30) and closing-auction-session timings (15:30–15:40). Whether a minute actually traded is decided by the data: no NIFTY or option candle at that minute → that day/entry goes to `skipped`. At the entry minute buy 1 ATM CE + 1 ATM PE (ATM = NIFTY 1-minute open at that minute, rounded to 50) at each leg's 1-minute open + slippage.
- **Expiry**: nearest weekly on or after the **trade day** (the exit day), so a previous-evening entry on expiry day uses the next weekly. **DTE** = trading days from the trade day to expiry (0 = expiry day; weekdays stand in past the loaded candles).
- **Side** (chosen in the config form as `side`, which is recorded in params and is the side the lab opens on; switchable in the lab afterwards; same loaded data for both): **buy** (long) or **sell** (short) 1 ATM CE + 1 ATM PE at the entry minute's open, ± slippage per leg.
- **Lab rules** (`T_StraddleRules`: `side`, `entry`, `dtes` (null = all), `squareOff`, `levels[side]`, `perDte`, `dteLevels[side][dte]`): only days whose DTE is selected are traded. Exit levels are one set for all days or **per DTE** (`levelsFor()`), e.g. sell 0DTE target 50% / SL 40%, 1DTE 20% / 25%.
  - **Buy**: target = multiple of premium paid, a limit sell, filled at the target or at a minute's open that gaps through it. **No stop-loss.**
  - **Sell**: target = **% of premium kept**: a limit buy-back at (1 − %) × premium collected, filled at the level or at a gapped open. **Combined stop-loss** = % above premium: a stop-market at (1 + %) × premium, filled at the trigger (or gapped open) **+ slippage**. If one minute touches both, the **stop counts first** (conservative).
  - Intraminute high = `max(CE.high + PE.low, CE.low + PE.high)`, low = `min(CE.low + PE.high, CE.high + PE.low)`. Otherwise close at the `squareOff` minute's open on the trade day ∓ slippage. An entry at or after the square-off is skipped.
  - Helpers: `sweepTargets()` (one target for all selected days; sell keeps its stop), `sellMap()` (sell target × stop net P&L), `bestTargetPerDte()` ("use best for every day"), `compareEntries()`, `compareDtes()`. `upgradeRules()` converts views saved before sell / per-day levels (`targetX`).
- **Split**: the backend returns per trade day `entries[spec]` = {spot, atm, ce/pe entry, `entry_at`, minute `path` (`t` as "YYYY-MM-DD HH:MM", `ce_open`, `pe_open`, `hi`, `lo`) from entry to the trade day's close}. Client-side: `simulateStraddle()`, `sweepTargets()`, `compareEntries()`, `compareDtes()`. Costs are mirrored in TS. `normalizeStraddleDays()` converts runs saved in the old single-entry format.
- **Data**: underlying 1-minute candles cached per day in `.cache/spot_intraday/`; legs (1-minute) per contract per day in `.cache/options_intraday/`. About 2 Breeze calls per entry time per day on the first run (fewer when strikes repeat), plus 1 per 2 days for NIFTY 1-minute.

### Local data store (phase 1 of the roadmap)
- **What**: 1-minute candles for index spot (`spot_1m`), current-month futures (`fut_1m`) and options (`opt_1m`) of **NIFTY** (NSE/NFO, step 50) and **SENSEX** (ICICI code `BSESEN`, BSE/BFO, step 100, lot 20, Thursday expiry) in one DuckDB file, `.data/market.duckdb` (gitignored). All access goes through one connection with a lock (DuckDB is single-writer; API, worker and backtests share the process).
- **fetch_log** records every contract-day ever requested as `ok`, `empty` (a real answer, never retried) or `failed`. Spot/futures rows use sentinels (`expiry 1970-01-01`, `strike 0`, `right '-'`). Today's candles are stored but not logged (the day isn't over).
- **Reads** (`app/data/access.py`): `option_minute_bars` / `spot_minute_bars` read the store and fetch only missing days. A call covers ≤ 2 **consecutive weekdays** (`chunk_days`), because a call spans every day between its ends and Breeze caps at 1000 candles. `options_engine.leg_bars` resamples 1-minute to 5/30-minute (start-labelled, like Breeze). The straddle and butterfly engines now use this; the old `.cache/options_intraday` and `.cache/spot_intraday` JSON caches are imported once at startup (`import_json_caches`, 1-minute files only) and no longer written.
- **Downloader** (`app/data/ingest.py`): `plan_backfill` uses each day's open (daily candles) to pick strikes ATM ± `strike_band` (default 40) for the nearest `expiries_ahead` (2) weeklies (+ monthly optional) and the current-month future. It skips stored/queued contract-days, groups consecutive weekdays into one call, and returns calls + ETA. The worker thread works `ingest_queue` by priority, waits while logged out / paused / over `daily_budget` (default 4,000; every Breeze call is counted via `breeze.on_call`), and retries a failure 3× before marking it failed. The nightly job (default 16:15 IST, weekdays) queues today's data at high priority. Tasks left `running` at shutdown are re-queued at startup.
- **Dated rules** in `instruments.py` (seeded into `lot_sizes`): NIFTY expiry Thursday → Tuesday from 1 Sep 2025; SENSEX Friday → Tuesday (1 Jan 2025) → Thursday (1 Sep 2025); lot sizes NIFTY 25 → 75 (20 Nov 2024) → 65 (30 Dec 2025, verify against the circular), SENSEX 10 → 20. `cost_schedule` holds STT 0.0625% → 0.1% from 1 Oct 2024 → 0.15% from 1 Apr 2026 (Budget 2026-27). Phase 2's engine will read these tables.

### Saved backtests and PDF reports
- **Saving**: every backtest is saved automatically. `POST /backtest` saves synchronously; the butterfly and straddle jobs are wrapped with `runs.saving(...)`. Results carry `run_id`, and the page puts `?run=<id>` in the URL. Opening `?run=<id>` loads the saved result and refills the config form from its params. The interactive exit settings (`view`) and the headline metrics under them (`summary`) are PATCHed back (debounced) as they change, so a run reopens as left and the Backtests list shows current numbers. Storage is `.data/runs/` (gitignored; `make clear-cache` doesn't touch it).
- **PDF**: `ReportScope` (components) wraps a result with a "Download PDF" bar; `lib/report.ts` captures each **outermost `[data-report-section]`** (every `SectionCard`, plus stat grids / two-up chart rows marked explicitly) with html-to-image and lays them out on A4 with jsPDF. A section that doesn't fit starts a new page; taller ones are sliced. Sections that scroll sideways are widened during capture so wide tables are complete. While capturing, `usePrintMode()` is true, so tables drop pagination and print every row. Interactive controls aren't sections; their values go in the report heading (`reportInfo()` per page: strategy title, period, settings). Built-in PDF fonts lack ₹, → and −, so heading text goes through `pdfText()`. `?pdf=1` (used by the list's download button) auto-downloads once the page renders.

### Research program (`app/research/`, page `/research`)
An autonomous research loop on top of the generic engine. Experiments (hypothesis, mechanism, spec, periods, pre-registered criteria) live in `.data/research/experiments/`; the runner thread works the queue one period at a time (restart-safe: finished periods are kept, `running` → `queued` at startup), saves every period as a `custom` run linked by `experiment_id`, and computes `evaluate()` metrics + `checks()` / `experiment_gates()`. A period's fingerprint (canonical spec + dates + cost overrides + `ENGINE_VERSION`) is reused across experiments; bump `ENGINE_VERSION` in `engine.py` whenever a change can alter results. Verdicts are set by the lead (PATCH), never automatically. The protocol (discovery Sep 2025–Jun 2026 in two halves, gates, locked holdout 1 Jul–26 Oct 2026) is in `state.protocol`. Editing any `.py` file reloads the dev server and interrupts the running period (it is re-queued).

### Spec extensions, multi-day engine, portfolios (27 Oct 2026; see docs/HANDOVER.md)
- Timeframes `1d` / `1w` (daily store, 3 years of warm-up); operands take `shift`, `mul`, `add`, and `params.symbol` (e.g. `VIX`) on 1d/1w; ops `==` / `!=`; operands `weekday`, `dte`, `regime` (`params.model`).
- Time entries may be directional (bullish / bearish conditions read on the latest closed candle at the entry time) and gated by `entry.filter`.
- **Margin**: every engine trade carries `margin`, `margin_basis`, `pct_margin` (net ÷ margin); metrics `avg_margin`, `peak_margin`, `return_on_margin_pct`. Selling an option blocks exchange margin (~₹1.5–2.5L/lot), not the premium; `capital`/`pct` stay premium-based (used by % target/stop levels). The straddle lab mirrors it in `client/src/lib/fees.ts` (also dated option rates; the butterfly engine uses `DatedCosts` too).
- `ExpirySel.min_days`; `Costs.fut_slippage_points`; futures use `fut_cost_schedule` (STT 0.05% from 1 Apr 2026). Cost and lot-size rows are code-defined and rewritten at startup.
- **Multi-day (swing)**: `holding` (mode `swing`, max_days, exit_time, exit_before_expiry, check) runs on `app/strategy/swing.py`. Exits are checked at `holding.check` candle closes on every day held (`exits.evaluation` / `square_off` don't apply); `exits.underlying_stop` (ATR or points, trailing, ATR target) every index minute, filled at the next minute's open or at a gapped open. Signals on 1d/1w candles (entries and exits) act the next trading day at `entry.next_day_time`, never at the close that produced them. One position at a time per spec. Validation: defined risk overnight, futures need a stop; underlying stop is rejected on intraday specs.
- Swing trades carry `daily_mtm` (P&L per day held, sums to net) and `hold_days`; `_metrics` / `daily_pnl()` use it, so drawdown and Sharpe are on daily mark-to-market. Results also carry `daily`.
- **Several trades a day**: signal entries (up to `max_trades_per_day`), and time entries with `entry.times` (several fixed times; one position at a time; not with prev_day).
- Time-entry `filter` / directional conditions read the latest closed candle at or before the entry, which may be the previous session's (engine 4), so early entries can be gated on daily regime / VIX.
- `ENGINE_VERSION = 4`: monthly expiry by nominal month (`_monthly`: a holiday-shifted weekly like 30 Apr 2025 isn't April's monthly), and the filter timing above.
- **Indicator library** (`app/strategy/indicators.py`): 44 TradingView-style indicators (moving averages, oscillators, trend, regime, levels), each causal and covered by a future-perturbation test (`tests/test_indicator_library.py`); `Operand.field` is validated against the registry.
- **Portfolios** (`app/strategy/portfolio.py`, page `/backtest/portfolio`): several algos backtested together, each gated (gate ANDed into its entry conditions, no lookahead). Members run independently; no cross-member rules yet (e.g. a portfolio-wide daily loss limit).

### Cycle 4 additions (28 Oct 2026; see docs/HANDOVER.md §9)
- **Offline screening** (`app/research/screen.py`): agents run the real engine in their own process on a read-only store copy. `python -m app.research.screen snapshot` refreshes `.data/snapshots/market.duckdb`; then run with `PYTHONPATH=. MARKET_DB=.data/snapshots/market.duckdb BACKTEST_OFFLINE=1 [SCREEN_TRAIN_END=YYYY-MM-DD]`. `BACKTEST_OFFLINE=1` never calls Breeze or imports the SDK (it downloads its master file on import); missing data reads as no candles and is counted (`summary.missing_data`, `warning` when > 10% of entries are skipped). `SCREEN_TRAIN_END` refuses later dates. Every screen appends to `.data/research/screens.jsonl`, which `program_looks()` counts. One process ≈ 250 MB: run screens sequentially.
- **The engine calendar** comes from the daily store (`daily_bars`), not a Breeze call per run.
- **Walk-forward regime playbook** (`app/research/playbook.py`, `research/cycle4/playbook_run.py`, `GET /research/playbooks[/{id}]`, Research lab section "Regime playbook"): quarterly expanding-window choice of the best candidate per `trend_vol` regime from trades closed before the quarter; stitched out-of-sample result, baselines, hindsight bound, and `confirm()` re-runs the choices as real regime-gated portfolios.
- **Spec**: `Group.min` (with `any`: at least N of the conditions, a vote); `exits.exit_bullish` / `exits.exit_bearish` (separate exits for long / short trades); `exits.underlying_stop` now also intraday (first index minute through the level → next minute's open).
- **Engine 6**: daily ATR for underlying stops covers the whole period (was frozen at the first day); swing signal exits act at their own time (a daily exit at `next_day_time`), not at the next `holding.check`. `evaluate()` uses daily mark-to-market and tolerates trades on days without index candles.
- **Margin**: futures legs aren't counted as premium paid (margin ≈ 12% of contract value).
- **Data**: NIFTY spot + futures 2021-01 → now (current month + next month in the last 10 sessions before expiry, `NEXT_FUT_DAYS`); SENSEX futures sparse before mid-2024; options are only what earlier runs fetched (sparse). NIFTY lot 75 before 30 Jul 2021 (date approximate).
- **Paper watch** (`app/research/paper.py`, `GET/POST /research/paper`, `POST /research/paper/{id}/refresh`, `DELETE /research/paper/{id}`, Research lab section "Paper watch"): watchlisted experiments or saved buckets (`portfolio_id`) are re-run every weekday from a start date to the last completed session (thread started by the research runner), saved as runs, with the entry condition's state at the last close (vote count per condition; per member for buckets). Never orders. State in `.data/research/paper.json`.
- **History**: NIFTY spot + futures now from 2015 (lot 25 → 75 from the Nov 2015 series, approximate). Option backfill NIFTY ATM ± 10, nearest 2 weeklies, 2025 → Oct 2026 is queued (~19.8k calls, ~4–5 days of budget).
- **Experiments**: `criteria.program_bar: false` uses the fixed `min_t_stat` (a pre-registered test run once) instead of √(2 ln N); gates read `test_a`/`test_b` and `test_2x`; the leaderboard reads `is`/`pooled`/`train`, `holdout`/`test`, `stress`/`stress_2x`/`test_2x`. `research/cycle4/queue_tests.py <hand-in.json> [--train-from=2021-01-01]` queues an agent's candidates with the protocol-v4 periods.

### Adding a strategy
Add a function `fn(df, **params) -> pd.Series` (values 1/0, same index as `df`) to `app/backtest/strategies.py` and register it in `STRATEGIES`. Keyword defaults show up in `/backtest/strategies`. The engine shifts signals by one bar, so strategies may use the current bar's close.

## Breeze API conventions

- **Client**: `BreezeConnect(api_key=...)`, then `generate_session(api_secret=..., session_token=...)`.
- **Response envelope**: `{"Success": <data>, "Status": 200, "Error": None}`. `BreezeManager.unwrap()` returns `Success` or raises HTTP 502. Numbers often arrive as strings.
- **Dates**: ISO-8601 strings in the form `"2024-01-01T07:00:00.000Z"` (`to_breeze_date()`).
- **Stock codes** are ICICI codes, not NSE symbols: `RELIND` for RELIANCE, `NIFTY` for NIFTY 50, `CNXBAN` for BANKNIFTY, `ICIBAN` for ICICIBANK. Use `get_names` to look them up.
- **exchange_code**: `NSE`, `BSE` (cash); `NFO`, `BFO` (F&O); `MCX`, `NDX` (commodity / currency).
- **product_type**: `cash`, `futures`, `options`, `margin`, `mtf`, `btst` (history/quotes use the first three).
- **right**: `call`, `put`, `others`. **strike_price**: string, e.g. `"22000"`.
- **action**: `buy` / `sell`. **order_type**: `market`, `limit`, `stoploss`. **validity**: `day`, `ioc`, `vtc`.
- **Rate limits** (per ICICI docs): about 100 calls/minute and 5000/day. Historical v2 returns at most **1000 candles per call**.
- **Historical intervals**: v1 `1minute`, `5minute`, `30minute`, `1day`; v2 also `1second`.
  Candle fields: `datetime, stock_code, exchange_code, open, high, low, close, volume` (+ `open_interest`, `expiry_date`, `right`, `strike_price` for F&O).

## Full Breeze SDK method reference (breeze-connect 1.0.69)

✅ = used by this app. Everything else is available on `breeze.client` but not wired up.

### Session & customer
| Method | Description |
|---|---|
| ✅ `generate_session(api_secret, session_token)` | Authenticates the client with the daily `apisession` token |
| ✅ `get_customer_details(api_session)` | Customer profile, segments enabled, session token details |

### Market data
| Method | Description |
|---|---|
| `get_historical_data(interval, from_date, to_date, stock_code, exchange_code, product_type, expiry_date, right, strike_price)` | v1 OHLCV candles (1minute / 5minute / 30minute / 1day) |
| ✅ `get_historical_data_v2(...)` (same args) | v2 OHLCV, adds `1second`, max 1000 candles per call, faster |
| ✅ `get_quotes(stock_code, exchange_code, expiry_date, product_type, right, strike_price)` | Live LTP, OHLC, best bid/ask, volume |
| ✅ `get_option_chain_quotes(stock_code, exchange_code, expiry_date, product_type, right, strike_price)` | Option chain / futures quotes for an expiry. Live/upcoming expiries only; no IV or greeks. Fields: `strike_price, right, ltp, open_interest, chnge_oi, total_quantity_traded, best_bid_price, best_offer_price, spot_price, ltp_percent_change` |
| ✅ `get_names(exchange_code, stock_code)` | Maps exchange symbol ↔ ICICI stock code / token (needs session) |
| `get_stock_script_list()` | Downloads the SecurityMaster zip and builds symbol↔token maps |
| `get_stock_token_value(exchange_code, stock_code, product_type, expiry_date, strike_price, right, ...)` | Resolves the streaming token for an instrument |
| `get_data_from_stock_token_value(input_stock_token)` | Reverse lookup from token to instrument |
| `get_contract_name(underlying, product_type, expiry_date, strike_price, option_type)` | Builds a contract name string |

### Streaming (WebSocket)
| Method | Description |
|---|---|
| `ws_connect()` | Opens the socket.io market-data connection |
| `subscribe_feeds(stock_token / exchange_code+stock_code+..., interval, get_exchange_quotes, get_market_depth, get_order_notification)` | Subscribes to ticks, depth, OHLC bars (`1second`, `1minute`, `5minute`, `30minute`) or order updates |
| `unsubscribe_feeds(...)` | Unsubscribes the same |
| `on_ticks = callback` | Attribute: assign a function to receive ticks |
| `ws_disconnect()` / `ws_disconnect_ohlc()` | Closes the tick / OHLC stream |

### Funds & margin
| Method | Description |
|---|---|
| ✅ `get_funds()` | Bank balance, allocated / blocked funds per segment |
| `set_funds(transaction_type, amount, segment)` | Allocates (`credit`) or releases (`debit`) funds to a segment ⚠️ changes account state |
| `get_margin(exchange_code)` | Margin summary for a segment |
| `add_margin(product_type, stock_code, exchange_code, settlement_id, add_amount, margin_amount, ...)` | Adds margin to a position ⚠️ |
| `margin_calculator(lists, exchange_code)` | Required margin for a basket of legs |
| `limit_calculator(...)` | Computes the allowed limit price for options orders |

### Portfolio
| Method | Description |
|---|---|
| ✅ `get_demat_holdings()` | Demat holdings |
| `get_portfolio_holdings(exchange_code, from_date, to_date, stock_code, portfolio_type)` | Holdings with P&L, including F&O |
| ✅ `get_portfolio_positions()` | Open intraday / F&O positions |

### Orders ⚠️ (place real trades, not used)
| Method | Description |
|---|---|
| `place_order(stock_code, exchange_code, product, action, order_type, stoploss, quantity, price, validity, validity_date, disclosed_quantity, expiry_date, right, strike_price, user_remark, ...)` | Places an order |
| `modify_order(order_id, exchange_code, order_type, stoploss, quantity, price, validity, disclosed_quantity, validity_date)` | Modifies an open order |
| `cancel_order(exchange_code, order_id)` | Cancels an order |
| `square_off(...)` | Squares off a position |
| `preview_order(...)` | Brokerage and charges preview, places nothing |
| `aggressive_limit_order_placement(...)` | Limit order priced near market |
| `get_order_list(exchange_code, from_date, to_date)` | Order book |
| `get_order_detail(exchange_code, order_id)` | One order's status/history |
| `get_trade_list(from_date, to_date, exchange_code, product_type, action, stock_code)` | Executed trades |
| `get_trade_detail(exchange_code, order_id)` | Fills for an order |

### GTT (Good-Till-Triggered) ⚠️
| Method | Description |
|---|---|
| `gtt_single_leg_place_order / _modify_order / _cancel_order` | Single trigger GTT |
| `gtt_three_leg_place_order / _modify_order / _cancel_order` | OCO GTT (fresh order + target + stoploss) |
| `gtt_order_book(exchange_code, from_date, to_date)` | Lists GTT orders |

## Roadmap

`docs/STRATEGY_BUILDER_PLAN.md`: plan for the generic, visual-builder backtesting platform (StrategySpec, local data store, generic engine, builder UX, phases 1–6). Decisions: visual builder only, index options + futures (NIFTY + SENSEX first), single user, paper trading later, 1 year history, ±40 strikes, light UI with dark sidebar. **Done:** phase 0 (Backtest hub), phase 1 (data store, downloader, Data page), SaaS shell, phase 2 (StrategySpec v1 + generic engine; parity with the straddle and butterfly engines verified to the paisa), phase 3 (visual builder, templates, library), phase 4 core (trade replay, sweep + walk-forward, compare runs). **Next:** phase 4 extras (monthly calendar, robustness score), phase 5 (adjustments, delta/IV conditions, margin), phase 6 (paper trading).

## Guidelines for changes

- Keep the app read-only unless the user explicitly asks for order placement. Gate any ⚠️ method behind an explicit opt-in.
- **Never call Breeze on the event loop.** Breeze calls block; use plain `def` endpoints (FastAPI threadpool), `run_in_threadpool` inside `async def`, or a thread (startup `try_restore` runs in one). The SDK's `requests` is wrapped with a default timeout (`BREEZE_TIMEOUT`, 10 s connect / 30 s read) in `breeze_client.py`, so a silent Breeze raises instead of hanging forever (a hang once froze the server and left an orphan holding port 8000).
- Go through `breeze.call(method, **kwargs)` so errors are unwrapped consistently. Use `breeze.historical_df()` for candles.
- Backtests must avoid lookahead: signals act on the next bar.
- Use `.venv`; pin new dependencies in `requirements.txt`.
- Fills are floored at one tick (`TICK`); combined intrabar exits interpolate every leg inside its own candle (`fill_to`), and combined targets pay slippage. Muhurat sessions (`SPECIAL_SESSIONS`) aren't trading days.
- New backtest pages: save via `runs`, read `?run=`, wrap results in `ReportScope` with a `reportInfo()` heading, and mark report sections.
