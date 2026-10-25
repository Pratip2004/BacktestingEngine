"""Background ingestion: fill the local store from Breeze without blocking anything.

- plan_backfill(): for each underlying and trading day in a range, queue the index spot candles, the
  current-month future, and options of the nearest N weekly expiries (+ monthly) for strikes
  ATM ± band around that day's open. Already-fetched or already-queued contract-days are skipped,
  and consecutive weekdays of the same contract share one call. Returns call counts and an ETA.
- Worker: one daemon thread working ingest_queue (highest priority first), respecting the shared
  rate limiter (BreezeManager.call) and a daily call budget; retries a failed call up to 3 times.
  Waits while you're not logged in, while paused, or once the day's budget is used.
- Nightly: after the close (default 16:15 IST, weekdays) queues today's data for every configured
  underlying at high priority.
- import_json_caches(): one-time import of candles downloaded before the store existed.
"""

import json
import logging
import re
import threading
import time as time_mod
import uuid
from collections import defaultdict
from datetime import date, datetime, time, timedelta
from zoneinfo import ZoneInfo

from app.breeze_client import breeze
from app.data.access import chunk_days, fetch_range, store_range
from app.data.instruments import underlying
from app.data.store import NO_EXPIRY, NO_RIGHT, NO_STRIKE, get_store
from app.options.expiries import CACHE_DIR, weekly_expiries_between

log = logging.getLogger(__name__)

IST = ZoneInfo("Asia/Kolkata")
MAX_ATTEMPTS = 3
CALLS_PER_MINUTE = 92


# ---------- planning ----------

def _monthly(expiries: list[date]) -> list[date]:
    """The last expiry of each month = the monthly contract (futures and monthly options)."""
    last: dict[tuple[int, int], date] = {}
    for e in expiries:
        last[(e.year, e.month)] = max(last.get((e.year, e.month), e), e)
    return sorted(last.values())


def plan_backfill(underlyings: list[str], start: date, end: date, band: int | None = None,
                  expiries_ahead: int | None = None, include_monthly: bool | None = None,
                  include_futures: bool = True, priority: int = 0, dry_run: bool = True, label: str = "") -> dict:
    st = get_store()
    cfg = st.settings()
    band = cfg["strike_band"] if band is None else band
    expiries_ahead = cfg["expiries_ahead"] if expiries_ahead is None else expiries_ahead
    include_monthly = cfg["include_monthly"] if include_monthly is None else include_monthly
    end = min(end, date.today())

    job_id = uuid.uuid4().hex[:10]
    summary: dict = {"job_id": None if dry_run else job_id, "underlyings": {}, "calls": 0}
    rows_to_insert: list[tuple] = []

    for name in underlyings:
        u = underlying(name)
        daily = breeze.historical_df(u.stock_code, u.spot_exchange, "1day",
                                     datetime.combine(start, time(0)), datetime.combine(end, time(23, 59)))
        if daily.empty:
            summary["underlyings"][u.name] = {"error": "No daily candles from Breeze for this range"}
            continue
        daily["day"] = daily["datetime"].dt.date
        opens = dict(zip(daily["day"], daily["open"]))
        days = sorted(d for d in opens if start <= d <= end)
        weekly = weekly_expiries_between(start, end + timedelta(days=45), days, u.stock_code)
        monthly = _monthly(weekly)

        # Every contract-day this range needs.
        needed: dict[tuple, list[date]] = defaultdict(list)  # (kind, expiry, strike, right) -> days
        for d in days:
            needed[("spot", NO_EXPIRY, NO_STRIKE, NO_RIGHT)].append(d)
            month_exp = next((e for e in monthly if e >= d), None)
            if include_futures and month_exp:
                needed[("fut", month_exp, NO_STRIKE, NO_RIGHT)].append(d)
            exps = [e for e in weekly if e >= d][:expiries_ahead]
            if include_monthly and month_exp and month_exp not in exps:
                exps.append(month_exp)
            atm = u.atm(opens[d])
            for e in exps:
                for k in range(-band, band + 1):
                    for right in ("call", "put"):
                        needed[("opt", e, atm + k * u.strike_step, right)].append(d)

        # Drop what's already stored or queued.
        done = set(st.q(
            "SELECT kind, expiry, strike, opt_right, day FROM fetch_log WHERE underlying = ? AND status IN ('ok','empty') AND day BETWEEN ? AND ?",
            [u.name, start, end]))
        queued = set()
        for kind, e, k, r, a, b in st.q(
            "SELECT kind, expiry, strike, opt_right, day_from, day_to FROM ingest_queue WHERE underlying = ? AND status IN ('pending','running')",
            [u.name]):
            d = a
            while d <= b:
                queued.add((kind, e, k, r, d))
                d += timedelta(days=1)

        calls = contract_days = skipped = 0
        by_kind = defaultdict(int)
        for (kind, e, k, r), ds in needed.items():
            todo = [d for d in ds if (kind, e, float(k), r, d) not in done and (kind, e, float(k), r, d) not in queued]
            skipped += len(ds) - len(todo)
            contract_days += len(todo)
            for chunk in chunk_days(sorted(todo)):
                calls += 1
                by_kind[kind] += 1
                rows_to_insert.append((job_id, kind, u.name, e, float(k), r, chunk[0], chunk[-1], priority))
        summary["underlyings"][u.name] = {
            "trading_days": len(days), "contract_days": contract_days, "already_have": skipped,
            "calls": calls, "calls_by_kind": dict(by_kind), "first_day": days[0].isoformat() if days else None,
            "last_day": days[-1].isoformat() if days else None,
        }
        summary["calls"] += calls

    budget = max(1, st.settings()["daily_budget"])
    summary["eta"] = {
        "days_at_budget": round(summary["calls"] / budget, 1),
        "hours_at_full_speed": round(summary["calls"] / CALLS_PER_MINUTE / 60, 1),
    }
    if not dry_run and rows_to_insert:
        now = datetime.now()
        st.q("INSERT INTO ingest_jobs VALUES (?, ?, ?, ?)",
             [job_id, label or f"{', '.join(underlyings)} {start} → {end}",
              json.dumps({"underlyings": underlyings, "start": str(start), "end": str(end), "band": band,
                          "expiries_ahead": expiries_ahead, "include_monthly": include_monthly}), now])
        with st._lock:
            st._con.executemany(
                """INSERT INTO ingest_queue (job_id, kind, underlying, expiry, strike, opt_right, day_from, day_to, priority,
                   status, attempts, error, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', 0, NULL, ?, ?)""",
                [row + (now, now) for row in rows_to_insert])
        worker.wake()
    return summary


# ---------- worker ----------

class Worker:
    def __init__(self):
        self.state = "starting"
        self.current: str | None = None
        self.last_error: str | None = None
        self.done_this_session = 0
        self._event = threading.Event()
        self._thread: threading.Thread | None = None

    def start(self):
        if self._thread and self._thread.is_alive():
            return
        self._thread = threading.Thread(target=self._loop, name="ingest-worker", daemon=True)
        self._thread.start()

    def wake(self):
        self._event.set()

    def _sleep(self, seconds: float):
        self._event.wait(seconds)
        self._event.clear()

    def _loop(self):
        st = get_store()
        while True:
            try:
                cfg = st.settings()
                if cfg["worker_paused"]:
                    self.state, self.current = "paused", None
                    self._sleep(5)
                    continue
                if not breeze.is_connected:
                    self.state, self.current = "waiting_for_login", None
                    self._sleep(10)
                    continue
                if st.calls_on() >= cfg["daily_budget"]:
                    self.state, self.current = "budget_used", None
                    self._sleep(60)
                    continue
                task = st.q(
                    """SELECT id, kind, underlying, expiry, strike, opt_right, day_from, day_to, attempts FROM ingest_queue
                       WHERE status = 'pending' ORDER BY priority DESC, id LIMIT 1""")
                if not task:
                    self.state, self.current = "idle", None
                    self._sleep(15)
                    continue
                self._run(*task[0])
            except Exception as exc:  # never let the thread die
                log.exception("ingest worker error")
                self.last_error = f"{type(exc).__name__}: {exc}"
                self._sleep(10)

    def _run(self, task_id, kind, name, expiry, strike, right, day_from, day_to, attempts):
        st = get_store()
        self.state = "downloading"
        what = name if kind == "spot" else f"{name} {expiry:%d %b} {'FUT' if kind == 'fut' else f'{strike:g} {right.upper()}'}"
        self.current = f"{what} · {day_from:%d %b %Y}" + ("" if day_from == day_to else f" – {day_to:%d %b}")
        st.q("UPDATE ingest_queue SET status = 'running', updated_at = now() WHERE id = ?", [task_id])
        days = [day_from] if day_from == day_to else [d for d in (day_from + timedelta(days=i) for i in range((day_to - day_from).days + 1)) if d.weekday() < 5]
        key = {} if kind == "spot" else {"expiry": expiry}
        if kind == "opt":
            key |= {"strike": strike, "right": right}
        try:
            rows = fetch_range(kind, name, day_from, day_to, **key)
            store_range(kind, name, days, rows, **key)
            st.q("UPDATE ingest_queue SET status = 'done', attempts = ?, updated_at = now() WHERE id = ?", [attempts + 1, task_id])
            self.done_this_session += 1
        except Exception as exc:
            msg = getattr(exc, "detail", None) or f"{type(exc).__name__}: {exc}"
            self.last_error = f"{what}: {msg}"
            final = attempts + 1 >= MAX_ATTEMPTS
            st.q("UPDATE ingest_queue SET status = ?, attempts = ?, error = ?, updated_at = now() WHERE id = ?",
                 ["failed" if final else "pending", attempts + 1, str(msg)[:500], task_id])
            if final:
                log_key = {} if kind == "spot" else {"expiry": expiry}
                if kind == "opt":
                    log_key |= {"strike": strike, "right": right}
                for d in days:
                    st.log_fetch(kind, name, d, "failed", 0, str(msg)[:500], **log_key)

    def status(self) -> dict:
        st = get_store()
        counts = dict(st.q("SELECT status, COUNT(*) FROM ingest_queue GROUP BY status"))
        jobs = st.df(
            """SELECT j.job_id, j.label, j.created_at,
                      COUNT(*) AS total,
                      SUM(CASE WHEN q.status = 'done' THEN 1 ELSE 0 END) AS done,
                      SUM(CASE WHEN q.status = 'failed' THEN 1 ELSE 0 END) AS failed
               FROM ingest_jobs j JOIN ingest_queue q USING (job_id)
               GROUP BY j.job_id, j.label, j.created_at ORDER BY j.created_at DESC LIMIT 10""")
        cfg = st.settings()
        return {
            "state": self.state,
            "current": self.current,
            "last_error": self.last_error,
            "done_this_session": self.done_this_session,
            "queue": {s: int(counts.get(s, 0)) for s in ("pending", "running", "done", "failed")},
            "calls_today": st.calls_on(),
            "daily_budget": cfg["daily_budget"],
            "jobs": [
                {"job_id": r.job_id, "label": r.label, "created_at": str(r.created_at)[:19], "total": int(r.total),
                 "done": int(r.done), "failed": int(r.failed)}
                for r in jobs.itertuples()
            ],
        }


worker = Worker()


# ---------- nightly ----------

def _nightly_loop():
    st = get_store()
    while True:
        try:
            cfg = st.settings()
            now = datetime.now(IST)
            last = st.q("SELECT value FROM settings WHERE key = 'last_nightly'")
            ran_today = bool(last) and json.loads(last[0][0]) == now.date().isoformat()
            if (cfg["nightly_enabled"] and now.weekday() < 5 and not ran_today
                    and now.strftime("%H:%M") >= cfg["nightly_time"] and breeze.is_connected):
                plan_backfill(cfg["underlyings"], now.date(), now.date(), priority=10, dry_run=False, label=f"Nightly {now:%d %b %Y}")
                st.q("INSERT OR REPLACE INTO settings VALUES ('last_nightly', ?)", [json.dumps(now.date().isoformat())])
        except Exception:
            log.exception("nightly ingest failed")
        time_mod.sleep(60)


# ---------- import of pre-store caches ----------

OPT_FILE = re.compile(r"^(?P<stock>\w+?)_(?P<exp>\d{8})_(?P<strike>[\d.]+)_(?P<right>call|put)_1minute_(?P<day>\d{8})\.json$")
SPOT_FILE = re.compile(r"^(?P<stock>\w+?)_1minute_(?P<day>\d{8})\.json$")


def import_json_caches() -> dict:
    """Load candles downloaded before the store existed (.cache/options_intraday, .cache/spot_intraday)."""
    st = get_store()
    if st.q("SELECT 1 FROM settings WHERE key = 'imported_json_cache'"):
        return {"skipped": True}
    today = date.today()
    n_opt = n_spot = 0
    for f in (CACHE_DIR / "options_intraday").glob("*_1minute_*.json"):
        m = OPT_FILE.match(f.name)
        if not m:
            continue
        try:
            u = underlying(m["stock"])
        except KeyError:
            continue
        exp, day = datetime.strptime(m["exp"], "%Y%m%d").date(), datetime.strptime(m["day"], "%Y%m%d").date()
        if day >= today:
            continue
        rows = json.loads(f.read_text())
        st.put_option(u.name, exp, float(m["strike"]), m["right"], rows)
        st.log_fetch("opt", u.name, day, "ok" if rows else "empty", len(rows), expiry=exp, strike=float(m["strike"]), right=m["right"])
        n_opt += 1
    for f in (CACHE_DIR / "spot_intraday").glob("*_1minute_*.json"):
        m = SPOT_FILE.match(f.name)
        if not m:
            continue
        try:
            u = underlying(m["stock"])
        except KeyError:
            continue
        day = datetime.strptime(m["day"], "%Y%m%d").date()
        if day >= today:
            continue
        rows = json.loads(f.read_text())
        st.put_spot(u.name, rows)
        st.log_fetch("spot", u.name, day, "ok" if rows else "empty", len(rows))
        n_spot += 1
    st.q("INSERT OR REPLACE INTO settings VALUES ('imported_json_cache', ?)", [json.dumps({"options": n_opt, "spot": n_spot})])
    log.info("Imported %d option and %d spot cache files into the store", n_opt, n_spot)
    return {"options": n_opt, "spot": n_spot}


def start_background():
    """Called from the app's startup: import old caches, start the worker and the nightly job."""
    st = get_store()
    breeze.on_call = lambda: st.add_calls(1)
    # Tasks that were mid-download when the server stopped go back in the queue.
    st.q("UPDATE ingest_queue SET status = 'pending' WHERE status = 'running'")

    def boot():
        try:
            import_json_caches()
        except Exception:
            log.exception("cache import failed")
        worker.start()
        threading.Thread(target=_nightly_loop, name="ingest-nightly", daemon=True).start()

    threading.Thread(target=boot, name="ingest-boot", daemon=True).start()
