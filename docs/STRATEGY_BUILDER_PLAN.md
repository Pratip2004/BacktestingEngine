# Strategy Builder: plan for a fully dynamic backtesting platform

**Goal:** you can build **any** options or futures strategy on Indian index derivatives in the UI, with or without indicators, and backtest it. That covers straddles, strangles, spreads, condors, butterflies, ratio and calendar spreads, naked legs, and indicator-driven directional trades. No code, and the same strategy definition can later run as **paper trading**.

**Decisions this plan is built on** (from your answers, 25 Oct 2026):

| Decision | Choice |
|---|---|
| How strategies are defined | **Visual builder only** (forms and blocks, no code) |
| What can be traded | **Index options + futures**: NIFTY, BANKNIFTY, FINNIFTY, SENSEX (cash indices for signals) |
| Users | **Single user** (you), one Breeze account, runs locally / self-hosted, no login system |
| Going live | **Paper trading later**: same strategy definition, simulated fills on live data. Real orders stay out of scope |

---

## 1. Where we are today, and what has to change

Today there are three **hard-coded** strategies, each with its own engine and page:

| Today | Limitation |
|---|---|
| Stock strategy (`engine.py`) | Long-only, one instrument, two fixed indicators |
| EMA butterfly (`options_engine.py` + `flySim.ts`) | One entry rule, one leg structure, NIFTY only |
| ATM straddle (`straddle_engine.py` + `straddleSim.ts`) | ATM only, CE+PE only, NIFTY only |

What they already do well, and what we keep:
- **No lookahead:** signals at a bar's close, fills at the next bar's open.
- **Leg-level option data:** real 1-minute candles per contract, not modelled prices.
- **Realistic costs:** STT, exchange charges, SEBI fee, stamp duty, GST and slippage.
- **Instant re-runs:** the "lab" pattern (load once, change exits instantly).
- **Saved runs and PDF reports.**
- **Per-DTE rules, overnight entries, buy/sell sides.**

**The change:** replace "one engine per strategy" with **one generic engine** that executes a **strategy definition** (a JSON document the visual builder produces). Today's three strategies become **templates**, i.e. pre-filled definitions, and must give the same results as today's engines (parity tests).

The other big change is **data**. A dynamic strategy can ask for any strike, expiry or underlying at any minute. Fetching each contract from Breeze when a backtest needs it (what we do now) doesn't scale: the limit is about 100 calls a minute and 5,000 a day. So the platform needs its own **local market data store**, filled in the background.

---

## 2. The strategy definition (the heart of the system)

Everything the builder shows maps to one versioned JSON document, the **StrategySpec**. The engine runs it, the UI edits it, saved runs pin the exact version, and paper trading will run the same document.

### 2.1 Building blocks

**A. Underlying and timing**
- Underlying: NIFTY / BANKNIFTY / FINNIFTY / SENSEX.
- Signal timeframe(s): 1m, 3m, 5m, 15m, 30m, 1h, 1d. Several are allowed (multi-timeframe conditions).
- Execution granularity: always 1-minute option candles.

**B. When to trade (schedule)**
- Days:
  - weekdays
  - **DTE filter** (0DTE, 1DTE …, as today)
  - expiry-day only / skip expiry day
  - exclude dates (budget day, results, holidays), for example via a "skip event days" list
- Entry trigger, one of:
  - **Time-based:** a fixed time (09:20), the previous day's close (15:25, held overnight, as today), or every N minutes in a window.
  - **Signal-based:** a condition tree (see C) evaluated on candle close, inside an entry window (e.g. 09:20–14:30).
  - **Both:** a signal, but only after 09:30.
- Re-entry:
  - max trades per day
  - cooldown after exit
  - re-enter after stop-loss: yes or no, and how many times
  - re-enter in the same direction only, or either direction

**C. Conditions (no-code indicator logic)**
Rows of the form `[indicator(params) on timeframe] [operator] [indicator / value]`, grouped with AND / OR. Examples:
- `EMA(9) on 5m crosses above EMA(21) on 5m`
- `RSI(14) on 15m < 30`
- `Close on 5m > Supertrend(10, 3) on 5m`
- `Spot breaks above Opening Range High(09:15–09:30)`
- `Gap at open > +0.5%`
- `India VIX < 14` (when VIX data is available)
- `ATM IV percentile (20d) > 60`
- `PCR (OI) > 1.2`

Operators: `>`, `<`, `>=`, `<=`, `crosses above`, `crosses below`, `is rising / falling for N bars`, `between`.

Indicator library (phase 2 set):
- **Moving averages:** SMA, EMA, WMA, VWAP
- **Momentum:** RSI, MACD (line/signal/histogram), Stochastic
- **Volatility:** Bollinger Bands, ATR, Supertrend, Donchian
- **Price levels:** Opening range high/low, previous day high/low/close, pivot points (CPR)
- **Session values:** day open, gap %
- **Options-derived** (from the store): ATM IV, IV rank/percentile, PCR, max pain, OI change at strike

A signal can carry a **direction**. For example, a bullish trigger opens one set of legs and a bearish trigger opens another, as in the EMA butterfly.

**D. Position (legs)**
A table where each leg has:
- **Action:** buy / sell.
- **Instrument:** CE / PE / FUT.
- **Strike selector**, one of:
  - ATM ± N strikes
  - ATM ± points (e.g. +200)
  - % OTM
  - **closest premium** to ₹X (e.g. "the CE nearest ₹50")
  - **closest delta** to 0.25
  - straddle-width based (ATM ± straddle premium)
- **Expiry selector:**
  - current / next weekly (where weeklies exist)
  - current / next month
  - "first expiry with DTE ≥ N"
  - The expiring contract is never used after its expiry time (handled today).
- **Lots:** a ratio per leg, e.g. 1 : 2 : 1.
- Per-leg **exit overrides** (see E).

**Templates** insert the legs for you: long/short straddle, strangle, iron condor, iron fly, call/put butterfly, bull/bear call/put spreads, ratio spreads, calendar, jade lizard, naked CE/PE, long/short futures, plus "futures + hedge". You can then edit any leg.

**E. Exits and risk**
- **Combined exits** (whole position) and **per-leg exits**, each with:
  - target and stop-loss in **% of premium / points / ₹ / multiple of premium**
  - **trailing stop:** after +X, trail by Y; or "lock ₹A once ₹B is reached"
  - **underlying-based** exits: spot moves ±N points / %, or spot crosses an indicator
  - **signal exits:** the opposite signal, or any condition tree
  - **time exits:** square-off time, max holding minutes, exit N minutes before expiry
- **Per-DTE overrides** for any level (as today: 0DTE target 50%, 1DTE 20% …).
- **Day-level risk:** max loss per day / max profit per day (stop trading for the day), max trades.
- **After a per-leg stop-loss**, either:
  - close everything
  - keep the other legs
  - move the other legs' stop to cost
  - re-enter the stopped leg at the new ATM

**F. Adjustments (later phase)**
- Roll the tested side to a new strike when spot moves N points.
- Convert a straddle to an iron fly by buying wings when the loss reaches X.
- Shift a strangle when one leg's premium doubles.

Each adjustment is "**when** [condition] **do** [action on legs]".

**G. Sizing and costs**
- **Lots:** fixed lots, or lots from capital (e.g. "risk ≤ 1% of capital using the stop-loss distance").
- **Costs:** a date-aware cost table. STT on option sells was 0.0625% before Oct 2024 and 0.1% after; brokerage is yours to set.
- **Fill model:** next-candle open (default), candle close, or VWAP. Limit vs stop-market semantics as today (limits fill at the level or at a gapped open; stops fill with slippage). Slippage in points, %, or a spread model by moneyness/DTE.

### 2.2 Example definitions

A classic **09:20 short straddle with 25% per-leg stop-loss**:

```json
{
  "spec_version": 1,
  "name": "09:20 short straddle, 25% SL per leg",
  "underlying": "NIFTY",
  "schedule": { "days": { "dte": [0, 1, 2, 3, 4] }, "entry": { "type": "time", "at": "09:20" }, "max_trades_per_day": 1 },
  "legs": [
    { "id": "ce", "action": "sell", "instrument": "CE", "strike": { "by": "atm_offset", "steps": 0 }, "expiry": { "by": "weekly", "n": 0 }, "lots": 1 },
    { "id": "pe", "action": "sell", "instrument": "PE", "strike": { "by": "atm_offset", "steps": 0 }, "expiry": { "by": "weekly", "n": 0 }, "lots": 1 }
  ],
  "exits": {
    "per_leg": { "stop": { "pct_of_premium": 25 }, "on_stop": "keep_other_legs" },
    "combined": { "target": { "pct_of_premium": 50 } },
    "time": { "square_off": "15:15" }
  },
  "costs": { "brokerage_per_order": 20, "slippage": { "points": 0.5 }, "taxes": "nse_options_by_date" }
}
```

Today's **EMA butterfly** expressed as a template:

```json
{
  "name": "EMA 9/21 crossover butterfly",
  "underlying": "NIFTY",
  "schedule": {
    "entry": {
      "type": "signal",
      "window": ["09:20", "15:00"],
      "bullish": { "all": [{ "left": "EMA(9)@5m", "op": "crosses_above", "right": "EMA(21)@5m" }] },
      "bearish": { "all": [{ "left": "EMA(9)@5m", "op": "crosses_below", "right": "EMA(21)@5m" }] }
    },
    "one_position_at_a_time": true
  },
  "legs_by_direction": {
    "bullish": [
      { "action": "buy", "instrument": "CE", "strike": { "by": "atm_points", "points": 0 }, "lots": 1 },
      { "action": "sell", "instrument": "CE", "strike": { "by": "atm_points", "points": 200 }, "lots": 2 },
      { "action": "buy", "instrument": "CE", "strike": { "by": "atm_points", "points": 400 }, "lots": 1 }
    ],
    "bearish": "mirror_with_PE"
  },
  "exits": { "combined": { "target": { "pct_of_premium": 50 }, "stop": { "pct_of_premium": 30 } }, "time": { "square_off": "15:15" } }
}
```

### 2.3 Rules the spec enforces
- **Validation in both places:** the backend (Pydantic) and the builder (instant messages, e.g. "weekly expiry doesn't exist for BANKNIFTY after Nov 2024").
- **Plain-English summary**, generated from the spec and shown live in the builder, e.g. *"Every trading day at 09:20, sell 1 ATM CE and 1 ATM PE of the current NIFTY weekly. Stop each leg at +25% of its premium; take the whole position off at 50% of total premium or at 15:15."* It's the best guard against a mis-built strategy.
- **Versioning:** editing a saved strategy creates a new version. Every run records the exact spec and version it used, so old results stay reproducible.

---

## 3. Data foundation (local market data store)

### 3.1 What we store

| Dataset | Granularity | Source |
|---|---|---|
| Index spot (NIFTY, BANKNIFTY, FINNIFTY, SENSEX, India VIX) | 1-minute + daily | Breeze `get_historical_data_v2` (cash) |
| Index futures (current / next / far month) | 1-minute + OI | Breeze (`futures`) |
| Index options, strikes within a band around spot (default ±10% or ±40 strikes), every listed expiry in the window | 1-minute OHLC + volume + OI | Breeze (`options`) |
| Contract master: every contract seen, expiry date, strike, lot size, tick size | daily snapshot | ICICI SecurityMaster (already downloaded daily) |
| **Expiry calendar** (actual dates incl. holiday shifts) | per expiry | derived from the master + traded data |
| **Lot-size history** | dated | master snapshots + a manual table for history (NIFTY 25 → 75 → 65 …) |
| **Cost schedule** (STT, exchange charges, stamp, GST) | dated | manual table (changes are rare and dated) |

**Storage:** one **DuckDB** database file (`.data/market.duckdb`; embedded, no server, columnar). *As built:* a single DuckDB file instead of Parquet partitions, because it gives primary-key upserts and one-file backups; Parquet export stays possible. Rough size: 1 year of NIFTY at ±40 strikes for two weekly expiries is about 15M rows, around 0.5 GB compressed. All four indices for 3 years is a few GB, which a laptop handles.

### 3.2 Getting the data in (Breeze limits make this the long pole)
- **Background ingestion worker** with a persistent queue:
  - "download contract X for day D", resumable, retried
  - shares the existing rate limiter (≈92 calls/min) and a **daily budget** (default 4,000 of the 5,000 calls/day, leaving room for your live use)
- **Nightly incremental job** after market close: today's data for all configured underlyings. That's a few hundred calls.
- **Backfill planner:** you choose underlyings, history depth and strike band. It shows the **call count and ETA** before starting.
  - Example: NIFTY, 1 year, ±40 strikes, 2 weeklies is about 164 contract-days per trading day. At 4,000 calls/day that's ≈ **10 days** of background downloading.
  - All four indices for 2 years ≈ 2–3 months.
- **Lazy fill:** if a backtest needs a contract that isn't stored, it's fetched on demand (today's behaviour) and saved, so nothing blocks on a full backfill.
- **Coverage map** in the UI: a calendar heatmap per underlying showing which days and strike bands are complete. Before every run there's a **data check**: "this backtest needs 312 contract-days; 290 are stored, 22 will be fetched (~15 s)".
- **Optional, decision for you:** a paid historical data vendor (NSE-licensed 1-minute F&O history) could load 3+ years in hours instead of months. The store is source-agnostic, so this can be added at any time.

### 3.3 Correctness traps the data layer must handle
- **Expired contracts:**
  - **To verify in phase 1:** how far back Breeze serves expired option candles.
  - The plan assumes about 3 years and will measure it per underlying.
- **Weekly expiry rules changed:**
  - From **20 Nov 2024**, SEBI allows one weekly index expiry per exchange: **NIFTY** on NSE and **SENSEX** on BSE. **BANKNIFTY and FINNIFTY weeklies were discontinued**, leaving monthly only.
  - The expiry selector must use the **actual expiries that existed on each date**, never a rule.
- **Expiry weekday changes:** NIFTY moved Thursday → **Tuesday** from Sep 2025, plus holiday shifts. These come from data, not rules.
- **Lot sizes change over time.** P&L must use the lot size valid on the trade date.
- **Illiquid strikes:** missing minutes are carried forward, as today, but each fill is **flagged with how stale its price was**. The report shows "% of fills on stale prices" so you can trust or distrust a result.
- **Market sessions:** the CAS / closing-session timing changes, special Muhurat sessions, and half days.
- **Timezones and candle labels:** decide once (candle start time, IST) and test it.

---

## 4. The generic engine

### 4.1 How a backtest runs
1. **Resolve the calendar.** Trading days in the range, filtered by the schedule (weekdays, DTE, excluded dates).
2. **Signals (vectorised).** Load underlying candles, compute every indicator the spec uses on each timeframe, and evaluate condition trees. A value is only usable **after its candle closes**: the higher-timeframe candle containing 10:12 is the one that closed at 10:00 (or 10:10), never the forming one. This is the main lookahead guard and gets dedicated tests.
3. **Event loop per day (minute clock).** A small state machine per position: `flat → entering → open → (adjusting) → exiting → flat`.
   - **Entry:** resolve each leg's contract from the chain snapshot at that minute (ATM, premium-closest and delta-closest all need the chain), then fill per the fill model.
   - **Each minute:** update leg and combined P&L using intraminute extremes (as the straddle lab does), check exits in a defined priority (stop before target within the same minute, conservative), then trailing stops, adjustments and re-entries.
   - **Day risk limits.**
4. **Results:**
   - trades with legs, fills and stale-flags
   - minute-level equity for the day and daily equity
   - margin estimate
   - metrics

**Greeks and IV** come from the existing Black-Scholes code (`greeks.py`). They're needed for delta-based strike selection, IV conditions and the payoff/greeks panel.

**Margin** is shown as an estimate. Breeze's `margin_calculator` only prices today's market, so for history we use an approximate SPAN-like model with hedge benefit. It's clearly labelled approximate, and it's used for return-on-margin and capital-based sizing.

### 4.2 Speed
- Days are independent unless positions carry overnight, so they run **in parallel** (process pool). Overnight positions chain days in order.
- Columnar reads from DuckDB, with only the contracts a day needs.
- **Target:** one year of a 1-minute, 4-leg intraday strategy in **under 30 seconds** on a laptop, once data is local.

### 4.3 Instant tuning (generalising today's labs)
Parameters can be marked **"tunable"** in the builder: target %, stop %, square-off time, DTE filter, entry time from a preset list, and so on.
- **Exit-only tunables** (target, stop, trailing, square-off, DTE filter) keep today's approach. The engine stores each trade's minute path once, and the browser replays exits instantly.
- **Entry or leg tunables** (entry time, strike offset, indicator period) need re-simulation. These run as a **server-side sweep**, a grid over up to 2–3 parameters with progress, cached.
- **Optimiser views:**
  - 2-parameter heatmaps (as today)
  - best value per DTE (as today)
  - **walk-forward validation:** optimise on months 1–6, test on months 7–9, roll forward; report in-sample vs out-of-sample
  - a **"robustness" score**, so you don't pick a lucky cell

---

## 5. UX: how it looks and feels

### 5.1 Navigation
- **Home / Backtest** (done now): tabs for Stock strategy, EMA butterfly, Straddle, Saved runs.
- **Later:** the tabs become:

| Tab | What's in it |
|---|---|
| **Strategies** | your saved strategies plus a **templates gallery** |
| **Builder** | create or edit |
| **Runs** | saved runs, with compare |
| **Data** | coverage and downloads |

  The current Straddle and EMA butterfly pages are kept until their templates reach parity, then retired.

### 5.2 The builder

```
┌ Strategy: 09:20 short straddle ───────────────────────── [Save] [Run backtest ▸] ┐
│ ① Underlying & days   ② Entry   ③ Legs   ④ Exits & risk   ⑤ Costs & sizing        │
├──────────────────────────────────────────────────────┬───────────────────────────┤
│ ③ Legs                                  [+ Template ▾]│ In plain English          │
│ ┌────┬──────┬──────┬───────────────┬──────────┬────┐  │ Every day at 09:20, sell  │
│ │    │ B/S  │ Type │ Strike        │ Expiry   │Lots│  │ 1 ATM CE and 1 ATM PE of  │
│ │ ⋮⋮ │ Sell │ CE   │ ATM ± 0 steps │ Weekly 0 │ 1  │  │ the current NIFTY weekly… │
│ │ ⋮⋮ │ Sell │ PE   │ ATM ± 0 steps │ Weekly 0 │ 1  │  ├───────────────────────────┤
│ └────┴──────┴──────┴───────────────┴──────────┴────┘  │ Payoff at entry (sample)  │
│                                                       │   ╲      ╱   max profit ₹  │
│                                                       │    ╲____╱    breakevens    │
│                                                       ├───────────────────────────┤
│                                                       │ ⚠ 0 issues · data: 98% ✓  │
└──────────────────────────────────────────────────────┴───────────────────────────┘
```

- **Left:** a 5-step editor (stepper). Every field has sensible defaults, and templates fill everything in.
- **Right, always visible:**
  1. a **plain-English summary**
  2. a **payoff diagram** at entry for a sample day (at expiry and today, with greeks)
  3. **validation and data coverage**
- **Condition editor:** rows of `[indicator ▾][params][timeframe ▾] [operator ▾] [indicator/value]`, AND / OR groups, drag to reorder. A small **signal preview chart** shows where the conditions were true over the last few weeks, before any backtest runs.
- **Leg editor:** strike-selector dropdowns that explain themselves ("Closest premium to ₹50 at entry"), with live examples ("on 21 Oct 09:20 this was the 25,350 CE @ ₹48.6").

### 5.3 Results (one layout for every strategy)
- **Headline stats:** net P&L, return on margin (estimated), win rate, profit factor, max drawdown (₹ and %), expectancy, Sharpe/Sortino (daily), longest losing streak, % stale fills.
- **Charts:** equity and drawdown, a **monthly returns calendar**, daily P&L, P&L by weekday / DTE / entry time, MFE/MAE scatter.
- **Trade list:** leg detail, plus **trade replay**. Click a trade to see spot, each leg's premium and position P&L minute by minute, with entry, exits and adjustments marked.
- **Tuning panel:** tunable sliders (instant where possible), heatmaps, walk-forward.
- **Compare runs:** pick 2–4 saved runs to see equity curves overlaid and a metrics table side by side.
- **PDF report** (exists), extended with the strategy's plain-English summary and spec.

### 5.4 Paper trading (later phase)
- **Runs on live data:** the same StrategySpec runs forward on live 1-minute bars from the Breeze websocket (`subscribe_feeds`, OHLC stream).
- **Paper fills:** a paper broker fills orders with the same fill and cost model.
- **What you see:** a live positions panel, an orders and events log, end-of-day reports, and alerts (browser / Telegram).
- **No real orders.** The app stays read-only, as it is today.

---

## 6. Roadmap

Sizes are rough effort for one developer, working with me: S ≈ 2–4 days, M ≈ 1–2 weeks, L ≈ 2–4 weeks.

| Phase | What you get | Size | Done when |
|---|---|---|---|
| **0. Navigation** ✅ | Strategies under Home / Backtest with tabs; old links redirect | S | Done (25 Oct) |
| **1. Data foundation** ✅ (25 Oct; NIFTY + SENSEX, 1 year, ±40 strikes, SaaS shell) | DuckDB store; ingestion worker with queue, daily budget, nightly job; backfill planner with ETA; coverage map; contract master, expiry calendar, lot-size and cost tables; existing engines read through the store | L | NIFTY 1 year stored; coverage map correct; a straddle backtest runs from local data with zero Breeze calls; Breeze history depth measured and documented |
| **2. Spec v1 + generic engine** ✅ (25 Oct; parity with straddle + butterfly engines to the paisa) | StrategySpec v1 (sections 2.1 A–E, G); generic engine with time and signal entries, legs with all strike/expiry selectors, combined and per-leg exits, trailing, per-DTE overrides, day risk, re-entry; indicator library | L | Straddle and EMA-butterfly templates **match today's engines to the rupee** on the same data; lookahead and fill unit tests pass; 1 year intraday < 30 s |
| **3. Visual builder** ✅ (25 Oct; 10 templates, versioned library) | 5-step builder, templates gallery, plain-English summary, payoff diagram, validation, signal preview, data check before run, strategy versioning | L | You can build the 09:20 straddle, an iron condor, an EMA-signal futures trade and an ORB strangle without help |
| **4. Results v2 + tuning** 🟡 (trade replay, 1–2 parameter sweep with heatmaps, walk-forward, compare runs done; monthly calendar, robustness score, extended PDF to do) | Unified results page, trade replay, monthly calendar, compare runs, tunables (instant replay + server sweeps), heatmaps, walk-forward, robustness score, extended PDF | M–L | Tuning a target/stop is instant; a 2-parameter sweep of 1 year finishes in minutes; walk-forward report available |
| **5. Advanced** | Adjustments (roll, convert, hedge), delta/IV-based selection and conditions, capital-based sizing, margin estimates, multi-underlying | M–L | An adjustment-based strategy (e.g. straddle → iron fly on loss) backtests correctly |
| **6. Paper trading** | Live runner on Breeze websocket, paper broker, positions dashboard, alerts, daily reports | M | A strategy runs a full week on paper with fills matching the backtest model |

**Order rationale:** data first, because every later phase depends on fast local data; then the engine, using today's strategies as the correctness benchmark; then the builder on top of a proven engine.

---

## 7. Quality and testing
- **Parity tests:** the new engine must reproduce today's straddle and butterfly results exactly on the same data. This is the main regression net while we generalise.
- **Golden scenarios:** small hand-built days with known answers (gap through a stop, stop and target in the same minute, overnight hold, expiry-day roll, missing minutes).
- **Lookahead guards:** tests that shift future candles and assert that no signal or fill changes.
- **Data tests:** coverage completeness, lot size per date, expiry existence per date, cost table per date.
- **Performance benchmarks** in CI for the < 30 s target.
- **Every result shows its assumptions:** fill model, slippage, cost table version, data coverage and % stale fills appear on the results page and in the PDF.

---

## 8. Risks and how we handle them

| Risk | Mitigation |
|---|---|
| Breeze history is shallow or slow (5,000 calls/day) | Background backfill with ETA, lazy fill, daily budget; optional data vendor |
| Results look great but are overfit | Walk-forward, robustness score, in- vs out-of-sample shown side by side, warnings on single-cell optima |
| Wrong contract or expiry on old dates (rule changes) | Expiry/contract lookups only from stored data, never from rules; dated lot-size and cost tables |
| Illiquid strikes give fake fills | Stale-price flags per fill; option to skip trades with stale legs; spread-based slippage |
| Builder too complex | Templates first, plain-English summary, sensible defaults, progressive disclosure (advanced options hidden until needed) |
| Engine generalisation breaks existing strategies | Parity tests before retiring old pages |

---

## 9. Decisions still open (for you)
1. **History depth** to keep locally: 1, 2 or 3 years (drives backfill time).
2. **Strike band:** ±10% / ±40 strikes default. Wider costs more calls; narrower can't price far OTM wings on volatile days.
3. **Paid data vendor:** yes or no (speeds up phase 1 a lot; adds cost).
4. **First templates** to ship in phase 3 (suggested: long/short straddle, strangle, iron condor, iron fly, EMA butterfly, ORB breakout, vertical spreads).
5. **Margin model:** an approximate built-in model, or show margin only for recent dates via Breeze's calculator.
6. **Alerts channel** for paper trading: browser only, or Telegram too.
