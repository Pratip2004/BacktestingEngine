# Backtest Studio

Backtest NIFTY and SENSEX options strategies on real 1-minute market data from the **ICICI Direct Breeze API**.

- **Backtests:** ATM straddle (buy or sell, per-DTE targets and stops, previous-day or intraday entries), EMA-crossover butterfly with an interactive exit lab, and simple stock strategies.
- **Data store:** a local copy of 1-minute index, futures and options history, downloaded in the background, so backtests are fast and don't use up Breeze's daily limit.
- **Options analytics:** live option chain with OI and computed IV, and a past-expiry comparison.
- **Saved runs and PDF reports:** every backtest is saved; reopen it as you left it or download a report.

The backend is FastAPI (Python); the dashboard is React + Ant Design. The app is **read-only**: it never places, modifies or cancels orders.

---

## 1. Requirements

| | Version | Check with |
|---|---|---|
| Python | 3.10 or newer | `python3 --version` |
| Node.js | 20 or newer (with npm) | `node -v` |
| make | any | `make -v` |
| ICICI Direct account | with a **Breeze API app** (API key + secret) | |

Works on Linux, macOS and Windows via WSL.

---

## 2. Set up a Breeze API app (once)

1. Log in to the ICICI Direct API portal and create an app.
2. Set its **Redirect URL** to exactly:
   ```
   http://127.0.0.1:8000/auth/callback
   ```
   After you log in each day, ICICI sends the session token here and the app connects automatically.
3. Note the app's **API key** and **secret key**.

---

## 3. Install

```bash
git clone <this-repo> BacktestingEngine
cd BacktestingEngine
```

Create a file named `.env` in the project root:

```env
APP_NAME=BacktestingEngine
API_KEY=your-breeze-api-key
API_SECRECT_KEY=your-breeze-secret-key
```

> `API_SECRECT_KEY` is spelled that way on purpose (the app reads that exact name). `.env` is in `.gitignore`; never commit it.

Then install everything:

```bash
make install
```

This creates a Python virtual environment in `.venv`, installs the backend packages from `requirements.txt`, and installs the dashboard packages in `client/`.

---

## 4. Run

```bash
make dev
```

Starts the backend and the dashboard together. **Ctrl-C stops both.**

| What | URL |
|---|---|
| Dashboard | http://localhost:5173 |
| Backend API | http://localhost:8000 |
| API docs (interactive) | http://localhost:8000/docs |

---

## 5. Log in to Breeze (every day)

Breeze sessions expire daily, so log in once per trading day:

1. Open the dashboard → **Session** (or click the status card at the bottom of the sidebar).
2. Click **Open Breeze login** and log in with your ICICI user ID, password and OTP.
3. ICICI redirects back and the app connects. The sidebar shows **Breeze connected**.

If your Breeze app's redirect URL points somewhere else, copy the `apisession` value from the address bar after logging in and paste it on the Session page.

The token is cached in `.breeze_session`, so restarting the server the same day reconnects without logging in again.

---

## 6. First steps

1. **Download market data:** **Data store** → *Backfill planner* → choose NIFTY / SENSEX and a period → **Estimate** (shows Breeze calls and time) → **Start download**. It runs in the background within your daily call budget; you can keep working. One year of NIFTY + SENSEX takes about three weeks at the default budget, and backtests can use whatever has arrived so far.
2. **Run a backtest:** **Backtest** → **Strategies** → pick a template (or **Builder** for a blank strategy) → adjust entry, legs, exits and costs → set the period → **Run backtest**. The fixed labs (**Straddle**, **EMA butterfly**, **Stock strategy**) are still there; their exit settings update instantly.
3. **Dig into results:** click **Replay** on any trade to see it minute by minute; use **Optimize** under the results to try 1–2 settings over a grid (turn on *Walk-forward check* to test them on unseen data), then **Use it** to apply the best one. **Save** keeps the strategy in your library with versions.
4. **Compare:** **Backtest → Saved runs** → tick 2–4 runs → **Compare**.
5. **Find it again:** **Backtest → Saved runs**, or press **Ctrl+K** (⌘K on Mac) and type its name.

---

## 7. Commands

All commands run from the project root. Type `make` on its own to list them.

| Command | What it does |
|---|---|
| `make install` | Create `.venv`, install backend and dashboard packages |
| `make dev` | Run backend + dashboard together (Ctrl-C stops both) |
| `make server` | Run only the backend, auto-reloading on code changes |
| `make client` | Run only the dashboard |
| `make build` | Type-check and build the dashboard into `client/dist` |
| `make clean` | Remove Python bytecode caches and `client/dist` |
| `make clear-cache` | Delete `.cache/` (contract lists and old cached files; re-fetched when needed). Does **not** touch the data store or saved runs |

### Options

```bash
make dev PORT=8001 UI_PORT=5174   # different ports (the dashboard follows the backend port)
make server HOST=127.0.0.1        # backend reachable only from this machine
```

| Variable | Default | Meaning |
|---|---|---|
| `HOST` | `0.0.0.0` | Backend bind address. `0.0.0.0` accepts connections from your network; use `127.0.0.1` to keep the backend (and your live Breeze session) local-only |
| `PORT` | `8000` | Backend port. If you change it, update the Breeze app's redirect URL to match |
| `UI_PORT` | `5173` | Dashboard port |

### Without make

```bash
# Backend
python3 -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m uvicorn main:app --reload --host 0.0.0.0 --port 8000

# Dashboard (second terminal)
cd client
npm install
API_URL=http://localhost:8000 npm run dev -- --port 5173

# Dashboard lint / production build
npm run lint
npm run build
```

---

## 8. Configuration

### `.env`

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `API_KEY` | yes | | Breeze app API key |
| `API_SECRECT_KEY` | yes | | Breeze app secret |
| `APP_NAME` | no | `BacktestingEngine` | Title shown in the API docs |
| `BREEZE_SESSION_TOKEN` | no | | A session token to connect with at startup (normally not needed; use the Session page) |
| `FRONTEND_URL` | no | `http://localhost:5173` | Where the login redirect sends you back to |

### Dashboard → backend

The dashboard calls the backend through `/api/*`, which Vite forwards to `http://localhost:8000` (or `API_URL`, which `make client` sets from `PORT`). To open the dashboard through a tunnel or another hostname, add that host to `allowedHosts` in `client/vite.config.ts`.

### Data store settings

Set on the **Data store** page (Settings card):

| Setting | Default | Meaning |
|---|---|---|
| Daily Breeze call budget | 4,000 | Calls the background downloader may use per day (Breeze allows about 5,000) |
| Underlyings kept up to date | NIFTY, SENSEX | What the nightly update fetches |
| Strikes each side | 40 | Strikes stored around each day's opening ATM |
| Weekly expiries | 2 | Nearest weekly expiries stored per day |
| Nightly update | On, 16:15 IST | Fetches the day's data after the close, on weekdays |

---

## 9. Where things are stored

| Path | What | In git? |
|---|---|---|
| `.env` | Your Breeze keys | No |
| `.breeze_session` | Today's session token | No |
| `.data/market.duckdb` | The data store (all downloaded candles) | No |
| `.data/runs/` | Saved backtests | No |
| `.cache/` | Daily contract list from ICICI and older cached files | No |
| `logs/` | Breeze SDK request logs | No |

**Back up `.data/`** to keep your downloaded history and saved runs. The data store is a single file and can be copied while the server is stopped.

---

## 10. Project structure

```
main.py                  FastAPI app and startup
app/
  breeze_client.py       Breeze session, rate limiting, request timeouts
  config.py              Settings from .env
  routers/               HTTP endpoints (auth, market, account, options, backtest, runs, data, strategies)
  backtest/              Backtest engines (stock, EMA butterfly, straddle)
  options/               Option chain, IV / greeks, expiry calendar, background jobs
  data/                  Data store, downloader, NIFTY/SENSEX instrument rules
  strategy/              Strategy builder: spec, indicators, generic engine, templates, library, replay/sweep
  runs.py                Saved backtests
client/                  React dashboard (Vite + TypeScript + Ant Design + Tailwind)
  src/pages/             One file per page
  src/lib/               Client-side replay of exit rules, PDF report builder
docs/
  STRATEGY_BUILDER_PLAN.md   Roadmap for the visual strategy builder
CLAUDE.md                Detailed technical notes (architecture, rules, every endpoint)
Makefile                 The commands above
```

---

## 11. Troubleshooting

**`[Errno 98] Address already in use` when starting**
Another process holds the port, often a leftover server from an earlier run. Find and stop it, then run `make dev` again:
```bash
ss -ltnp | grep ':8000'     # or: lsof -i :8000
kill <pid>                  # if it doesn't exit: kill -9 <pid>
```

**`Could not set lock on file ... market.duckdb`**
Two backend processes are running; the data store allows only one. Stop the other one (see above).

**Sidebar says "Breeze logged out"**
Sessions expire daily. Log in again from the **Session** page. Right after a restart it can take a few seconds to restore the saved session.

**Login redirect shows an error or goes nowhere**
The Breeze app's redirect URL must be exactly `http://127.0.0.1:8000/auth/callback`, with the backend running on port 8000. Otherwise paste the `apisession` token on the Session page by hand.

**Downloads stopped: "Daily budget used"**
The downloader has used today's budget. It continues tomorrow, or raise the budget on the Data store page (stay under about 5,000 to leave room for normal use).

**Some days show red (failed) on the coverage calendar**
Breeze returned errors for those contracts. Click the day to see the error, then use **Retry failed** in the downloader. Very old expired contracts may not be available from Breeze at all.

**Breeze requests time out**
The app waits up to 30 seconds for each Breeze reply and then reports an error instead of hanging. If it happens often, ICICI's servers may be slow or down; try again later.

**Dashboard shows "Server offline"**
The backend isn't running or crashed. Check the terminal running `make dev` for the error.

---

## 12. More

- **[CLAUDE.md](CLAUDE.md):** full technical reference (architecture, strategy rules, data store internals, every API endpoint, Breeze SDK methods).
- **[docs/STRATEGY_BUILDER_PLAN.md](docs/STRATEGY_BUILDER_PLAN.md):** roadmap for the no-code strategy builder (phase 2 onwards).
