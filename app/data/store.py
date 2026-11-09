"""Local market data store (DuckDB, one file: .data/market.duckdb).

Holds 1-minute candles for index spot, futures and options, plus bookkeeping:
- fetch_log: every contract-day ever requested from Breeze and its outcome (ok / empty / failed),
  so nothing is fetched twice and the Data page can show coverage. "empty" is a real answer
  (the contract didn't trade or wasn't listed that day) and is never retried.
- ingest_queue: persistent download queue worked by app/data/ingest.py (survives restarts).
- settings, calls (Breeze calls per day, for the daily budget), lot_sizes, cost_schedule.

All access goes through one connection guarded by a lock: DuckDB allows a single writer process,
and the API, the ingestion worker and the backtests all live in this process.
"""

import json
import os
import threading
from datetime import date, datetime, timedelta
from typing import Any, Iterable

import duckdb
import pandas as pd

from app.config import BASE_DIR
from app.data.instruments import UNDERLYINGS

DB_PATH = BASE_DIR / ".data" / "market.duckdb"
# Research screens run the engine in their own processes on a copy of the store (DuckDB allows one writer, which
# is the server): MARKET_DB points at the copy, BACKTEST_OFFLINE=1 forbids Breeze calls (missing data → error).
if os.environ.get("MARKET_DB"):
    from pathlib import Path
    DB_PATH = Path(os.environ["MARKET_DB"])
OFFLINE = os.environ.get("BACKTEST_OFFLINE") == "1"

# Spot and futures rows in fetch_log use these in place of option fields (primary keys can't hold NULL).
NO_EXPIRY = date(1970, 1, 1)
NO_STRIKE = 0.0
NO_RIGHT = "-"
DONE = ("ok", "empty")

SCHEMA = """
CREATE TABLE IF NOT EXISTS spot_1m (
    underlying VARCHAR, ts TIMESTAMP, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE,
    PRIMARY KEY (underlying, ts));
CREATE TABLE IF NOT EXISTS fut_1m (
    underlying VARCHAR, expiry DATE, ts TIMESTAMP, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE,
    volume DOUBLE, oi DOUBLE, PRIMARY KEY (underlying, expiry, ts));
CREATE TABLE IF NOT EXISTS opt_1m (
    underlying VARCHAR, expiry DATE, strike DOUBLE, opt_right VARCHAR, ts TIMESTAMP, open DOUBLE,
    high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE, oi DOUBLE,
    PRIMARY KEY (underlying, expiry, strike, opt_right, ts));
CREATE TABLE IF NOT EXISTS fetch_log (
    kind VARCHAR, underlying VARCHAR, expiry DATE, strike DOUBLE, opt_right VARCHAR, day DATE,
    status VARCHAR, n_rows INTEGER, error VARCHAR, fetched_at TIMESTAMP,
    PRIMARY KEY (kind, underlying, expiry, strike, opt_right, day));
CREATE SEQUENCE IF NOT EXISTS ingest_seq;
CREATE TABLE IF NOT EXISTS ingest_queue (
    id BIGINT PRIMARY KEY DEFAULT nextval('ingest_seq'), job_id VARCHAR, kind VARCHAR, underlying VARCHAR,
    expiry DATE, strike DOUBLE, opt_right VARCHAR, day_from DATE, day_to DATE, priority INTEGER,
    status VARCHAR, attempts INTEGER, error VARCHAR, created_at TIMESTAMP, updated_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS ingest_jobs (
    job_id VARCHAR PRIMARY KEY, label VARCHAR, params JSON, created_at TIMESTAMP);
CREATE TABLE IF NOT EXISTS settings (key VARCHAR PRIMARY KEY, value JSON);
CREATE TABLE IF NOT EXISTS calls (day DATE PRIMARY KEY, n INTEGER);
CREATE TABLE IF NOT EXISTS lot_sizes (underlying VARCHAR, effective_from DATE, lot_size INTEGER, PRIMARY KEY (underlying, effective_from));
CREATE TABLE IF NOT EXISTS daily_1d (
    symbol VARCHAR, d DATE, open DOUBLE, high DOUBLE, low DOUBLE, close DOUBLE, volume DOUBLE, PRIMARY KEY (symbol, d));
CREATE TABLE IF NOT EXISTS daily_fetched (symbol VARCHAR PRIMARY KEY, d_from DATE, d_to DATE);
CREATE TABLE IF NOT EXISTS fut_cost_schedule (
    effective_from DATE PRIMARY KEY, stt_sell_pct DOUBLE, exchange_pct DOUBLE, sebi_pct DOUBLE,
    stamp_buy_pct DOUBLE, gst_pct DOUBLE);
CREATE TABLE IF NOT EXISTS cost_schedule (
    effective_from DATE PRIMARY KEY, stt_sell_pct DOUBLE, exchange_pct DOUBLE, sebi_pct DOUBLE,
    stamp_buy_pct DOUBLE, gst_pct DOUBLE);
"""

DEFAULT_SETTINGS = {
    "daily_budget": 4000,  # Breeze calls/day the background worker may use (limit is ~5000)
    "underlyings": ["NIFTY", "SENSEX"],
    "strike_band": 40,  # strikes each side of the day's opening ATM
    "expiries_ahead": 2,  # nearest N weekly expiries per day
    "include_monthly": False,
    "nightly_enabled": True,
    "nightly_time": "16:15",  # IST, after the close
    "worker_paused": False,
    "short_margin_pct": 13.0,  # margin for an uncovered short index option, % of contract value (calibrate: /market/margin-check)
    "fut_margin_pct": 12.0,  # margin for an index future, % of contract value
}

# Options costs by date (% of premium turnover): STT on sells 0.05% → 0.0625% (1 Apr 2023) → 0.1% (1 Oct 2024)
# → 0.15% (1 Apr 2026, Budget 2026-27); NSE exchange charge ≈0.05% → 0.03503% (1 Oct 2024, SEBI true-to-label).
# These rows are code-defined and rewritten at startup (INSERT OR REPLACE).
DEFAULT_COSTS = [
    (date(2026, 4, 1), 0.15, 0.03503, 0.0001, 0.003, 18.0),
    (date(2024, 10, 1), 0.1, 0.03503, 0.0001, 0.003, 18.0),
    (date(2023, 4, 1), 0.0625, 0.0495, 0.0001, 0.003, 18.0),
    (date(2000, 1, 1), 0.05, 0.0495, 0.0001, 0.003, 18.0),
]
# Index futures (% of contract turnover): STT on sells 0.01% → 0.0125% (1 Apr 2023) → 0.02% (1 Oct 2024)
# → 0.05% (1 Apr 2026); NSE exchange 0.0019% → 0.00173% (1 Oct 2024); stamp 0.002% on buys.
DEFAULT_FUT_COSTS = [
    (date(2026, 4, 1), 0.05, 0.00173, 0.0001, 0.002, 18.0),
    (date(2024, 10, 1), 0.02, 0.00173, 0.0001, 0.002, 18.0),
    (date(2023, 4, 1), 0.0125, 0.0019, 0.0001, 0.002, 18.0),
    (date(2000, 1, 1), 0.01, 0.0019, 0.0001, 0.002, 18.0),
]


class Store:
    def __init__(self, path=DB_PATH):
        path.parent.mkdir(parents=True, exist_ok=True)
        self.path = path
        self._lock = threading.RLock()
        if OFFLINE:  # a shared read-only snapshot: many screening processes open it at once
            self._con = duckdb.connect(str(path), read_only=True)
            return
        self._con = duckdb.connect(str(path))
        with self._lock:
            self._con.execute(SCHEMA)
            self._seed()

    # ---------- low level ----------

    def q(self, sql: str, params: Iterable[Any] = ()) -> list[tuple]:
        with self._lock:
            return self._con.execute(sql, list(params)).fetchall()

    def df(self, sql: str, params: Iterable[Any] = ()) -> pd.DataFrame:
        with self._lock:
            return self._con.execute(sql, list(params)).df()

    def _seed(self):
        for key, value in DEFAULT_SETTINGS.items():
            self._con.execute("INSERT OR IGNORE INTO settings VALUES (?, ?)", [key, json.dumps(value)])
        for u in UNDERLYINGS.values():
            self._con.execute("DELETE FROM lot_sizes WHERE underlying = ?", [u.name])
            for since, lot in u.lot_sizes:
                self._con.execute("INSERT INTO lot_sizes VALUES (?, ?, ?)", [u.name, since, lot])
        for table, rows in (("cost_schedule", DEFAULT_COSTS), ("fut_cost_schedule", DEFAULT_FUT_COSTS)):
            self._con.execute(f"DELETE FROM {table}")
            for row in rows:
                self._con.execute(f"INSERT INTO {table} VALUES (?, ?, ?, ?, ?, ?)", list(row))

    # ---------- settings & budget ----------

    def settings(self) -> dict:
        return {k: json.loads(v) for k, v in self.q("SELECT key, value FROM settings")}

    def update_settings(self, changes: dict) -> dict:
        for key, value in changes.items():
            if key in DEFAULT_SETTINGS:
                self.q("INSERT OR REPLACE INTO settings VALUES (?, ?)", [key, json.dumps(value)])
        return self.settings()

    def add_calls(self, n: int = 1, day: date | None = None):
        day = day or date.today()
        self.q("INSERT INTO calls VALUES (?, ?) ON CONFLICT (day) DO UPDATE SET n = n + excluded.n", [day, n])

    def calls_on(self, day: date | None = None) -> int:
        rows = self.q("SELECT n FROM calls WHERE day = ?", [day or date.today()])
        return rows[0][0] if rows else 0

    # ---------- candles ----------

    @staticmethod
    def _frame(rows: list[dict]) -> pd.DataFrame:
        df = pd.DataFrame(rows)
        df["ts"] = pd.to_datetime(df["datetime"])
        for col in ("open", "high", "low", "close", "volume", "open_interest"):
            df[col] = pd.to_numeric(df[col], errors="coerce") if col in df else float("nan")
        return df.dropna(subset=["open", "close"]).drop_duplicates("ts")

    def put_spot(self, underlying: str, rows: list[dict]) -> int:
        if not rows:
            return 0
        df = self._frame(rows)
        df.insert(0, "underlying", underlying)
        with self._lock:
            self._con.register("incoming", df[["underlying", "ts", "open", "high", "low", "close", "volume"]])
            self._con.execute("INSERT OR REPLACE INTO spot_1m SELECT * FROM incoming")
            self._con.unregister("incoming")
        return len(df)

    def put_option(self, underlying: str, expiry: date, strike: float, right: str, rows: list[dict]) -> int:
        if not rows:
            return 0
        df = self._frame(rows)
        df = df.assign(underlying=underlying, expiry=pd.Timestamp(expiry).date(), strike=float(strike), opt_right=right)
        cols = ["underlying", "expiry", "strike", "opt_right", "ts", "open", "high", "low", "close", "volume", "open_interest"]
        with self._lock:
            self._con.register("incoming", df[cols])
            self._con.execute("INSERT OR REPLACE INTO opt_1m SELECT * FROM incoming")
            self._con.unregister("incoming")
        return len(df)

    def put_future(self, underlying: str, expiry: date, rows: list[dict]) -> int:
        if not rows:
            return 0
        df = self._frame(rows).assign(underlying=underlying, expiry=pd.Timestamp(expiry).date())
        cols = ["underlying", "expiry", "ts", "open", "high", "low", "close", "volume", "open_interest"]
        with self._lock:
            self._con.register("incoming", df[cols])
            self._con.execute("INSERT OR REPLACE INTO fut_1m SELECT * FROM incoming")
            self._con.unregister("incoming")
        return len(df)

    def option_bars(self, underlying: str, expiry: date, strike: float, right: str, days: list[date]) -> pd.DataFrame:
        return self.df(
            """SELECT ts AS datetime, open, high, low, close, volume, oi FROM opt_1m
               WHERE underlying = ? AND expiry = ? AND strike = ? AND opt_right = ? AND CAST(ts AS DATE) IN (SELECT UNNEST(?))
               ORDER BY ts""",
            [underlying, expiry, float(strike), right, list(days)],
        )

    def spot_bars(self, underlying: str, days: list[date]) -> pd.DataFrame:
        return self.df(
            """SELECT ts AS datetime, open, high, low, close, volume FROM spot_1m
               WHERE underlying = ? AND CAST(ts AS DATE) IN (SELECT UNNEST(?)) ORDER BY ts""",
            [underlying, list(days)],
        )

    # ---------- fetch log ----------

    def log_fetch(self, kind: str, underlying: str, day: date, status: str, n_rows: int = 0, error: str | None = None,
                  expiry: date = NO_EXPIRY, strike: float = NO_STRIKE, right: str = NO_RIGHT):
        self.q(
            "INSERT OR REPLACE INTO fetch_log VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            [kind, underlying, expiry, float(strike), right, day, status, n_rows, error, datetime.now()],
        )

    def done_days(self, kind: str, underlying: str, days: list[date], expiry: date = NO_EXPIRY,
                  strike: float = NO_STRIKE, right: str = NO_RIGHT) -> set[date]:
        """Days already fetched for this contract (ok or empty), so they're read locally."""
        rows = self.q(
            """SELECT day FROM fetch_log WHERE kind = ? AND underlying = ? AND expiry = ? AND strike = ? AND opt_right = ?
               AND status IN ('ok', 'empty') AND day IN (SELECT UNNEST(?))""",
            [kind, underlying, expiry, float(strike), right, list(days)],
        )
        return {r[0] for r in rows}

    # ---------- reporting ----------

    def stats(self) -> dict:
        counts = {t: self.q(f"SELECT COUNT(*) FROM {t}")[0][0] for t in ("spot_1m", "fut_1m", "opt_1m")}
        per = self.df(
            """SELECT underlying, COUNT(DISTINCT day) AS days, MIN(day) AS first_day, MAX(day) AS last_day,
                      SUM(CASE WHEN kind = 'opt' AND status IN ('ok','empty') THEN 1 ELSE 0 END) AS contract_days
               FROM fetch_log WHERE status IN ('ok', 'empty') GROUP BY underlying"""
        )
        return {
            "rows": counts,
            "size_mb": round(self.path.stat().st_size / 1e6, 1) if self.path.exists() else 0,
            "underlyings": {
                r.underlying: {"days": int(r.days), "first_day": str(r.first_day)[:10], "last_day": str(r.last_day)[:10],
                               "contract_days": int(r.contract_days)}
                for r in per.itertuples()
            },
        }

    def coverage(self, underlying: str, start: date, end: date) -> list[dict]:
        """Per day: spot / futures status and option contract-days ok, empty, failed, pending."""
        logged = self.df(
            """SELECT day, kind, status, COUNT(*) AS n FROM fetch_log
               WHERE underlying = ? AND day BETWEEN ? AND ? GROUP BY day, kind, status""",
            [underlying, start, end],
        )
        pending = self.df(
            """SELECT d.day, q.kind, COUNT(*) AS n
               FROM ingest_queue q, LATERAL (SELECT UNNEST(generate_series(q.day_from, q.day_to, INTERVAL 1 DAY))::DATE AS day) d
               WHERE q.underlying = ? AND q.status IN ('pending', 'running') AND d.day BETWEEN ? AND ?
               GROUP BY d.day, q.kind""",
            [underlying, start, end],
        )
        days: dict[date, dict] = {}

        def row(d):
            return days.setdefault(d, {"date": d.isoformat(), "spot": None, "fut": None,
                                       "opt": {"ok": 0, "empty": 0, "failed": 0, "pending": 0}})

        for r in logged.itertuples():
            d = row(r.day.date() if hasattr(r.day, "date") else r.day)
            if r.kind == "opt":
                d["opt"][r.status] = d["opt"].get(r.status, 0) + int(r.n)
            else:
                d[r.kind] = r.status
        for r in pending.itertuples():
            d = row(r.day.date() if hasattr(r.day, "date") else r.day)
            if r.kind == "opt":
                d["opt"]["pending"] += int(r.n)
            elif d[r.kind] is None:
                d[r.kind] = "pending"
        return [days[k] for k in sorted(days)]

    # Weekends never trade; used by coverage views to skip them.
    @staticmethod
    def weekdays(start: date, end: date) -> list[date]:
        return [start + timedelta(days=i) for i in range((end - start).days + 1) if (start + timedelta(days=i)).weekday() < 5]


_store: Store | None = None
_store_lock = threading.Lock()


def get_store() -> Store:
    global _store
    with _store_lock:
        if _store is None:
            _store = Store()
        return _store
