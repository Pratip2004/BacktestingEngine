"""Expiry dates.

Upcoming expiries come from ICICI's SecurityMaster (authoritative, includes holiday shifts).
Past expiries aren't listed anywhere in Breeze, so they're generated from each underlying's dated
weekday rule (app/data/instruments.py) and snapped back to the nearest actual trading day using the
underlying's daily candles.
"""

import csv
import io
import logging
from datetime import date, datetime, timedelta
from functools import lru_cache
from zipfile import ZipFile

import requests
from breeze_connect import config as breeze_config

from app.config import BASE_DIR
from app.data.instruments import underlying

log = logging.getLogger(__name__)

CACHE_DIR = BASE_DIR / ".cache"

MASTER_FILES = ("FONSEScripMaster.txt", "FOBSEScripMaster.txt")


def _security_master(file: str = "FONSEScripMaster.txt") -> str:
    """An F&O contract list from today's SecurityMaster.zip (NSE or BSE), downloaded once a day."""
    CACHE_DIR.mkdir(exist_ok=True)
    stem = file.removesuffix(".txt")
    path = CACHE_DIR / f"{stem}_{date.today():%Y%m%d}.txt"
    if not path.exists():
        resp = requests.get(breeze_config.SECURITY_MASTER_URL, timeout=120)
        resp.raise_for_status()
        with ZipFile(io.BytesIO(resp.content)) as z:
            for name in MASTER_FILES:  # one download serves both exchanges
                old_stem = name.removesuffix(".txt")
                for old in CACHE_DIR.glob(f"{old_stem}_*.txt"):
                    old.unlink()
                (CACHE_DIR / f"{old_stem}_{date.today():%Y%m%d}.txt").write_bytes(z.read(name))
    return path.read_text()


@lru_cache(maxsize=8)
def _upcoming(stock_code: str, day: date) -> tuple[date, ...]:
    u = underlying(stock_code)
    expiries = set()
    for row in csv.DictReader(io.StringIO(_security_master(u.master_file))):
        if row["InstrumentName"] == u.option_instrument and row["ShortName"] == u.stock_code:
            expiries.add(datetime.strptime(row["ExpiryDate"], "%d-%b-%Y").date())
    return tuple(sorted(e for e in expiries if e >= day))


def upcoming_expiries(stock_code: str = "NIFTY") -> list[date]:
    return list(_upcoming(stock_code, date.today()))


def expiry_weekday(d: date, stock_code: str = "NIFTY") -> int:
    return underlying(stock_code).expiry_weekday(d)


def past_expiry_candidates(count: int, kind: str = "weekly", before: date | None = None) -> list[date]:
    """Nominal expiry dates (before holiday shifts), newest first, strictly before `before`."""
    before = before or date.today()
    out: list[date] = []
    d = before - timedelta(days=1)
    while len(out) < count:
        if d.weekday() == expiry_weekday(d):
            # Monthly = the last expiry weekday of the month.
            if kind == "weekly" or (d + timedelta(days=7)).month != d.month:
                out.append(d)
        d -= timedelta(days=1)
    return out


def weekly_expiries_between(start: date, end: date, trading_days: list[date], stock_code: str = "NIFTY") -> list[date]:
    """Actual weekly expiries in [start, end]. Past ones are snapped to trading days; from today on,
    SecurityMaster dates are used (they already include holiday shifts), falling back to the nominal rule."""
    today = date.today()
    out = set()
    d = start
    while d <= end:
        if d.weekday() == expiry_weekday(d, stock_code) and d < today:
            # Beyond the loaded candles there's nothing to snap against; positions get closed at the
            # end of the data before then anyway, so the nominal date is enough.
            if trading_days and d > trading_days[-1]:
                out.add(d)
            elif snapped := snap_to_trading_day(d, trading_days):
                out.add(snapped)
        d += timedelta(days=1)
    if end >= today:
        try:
            future = [e for e in upcoming_expiries(stock_code) if e <= end]
        except Exception:
            log.warning("SecurityMaster unavailable, using nominal future expiries")
            future = [today + timedelta(days=i) for i in range((end - today).days + 1)
                      if (today + timedelta(days=i)).weekday() == expiry_weekday(today + timedelta(days=i), stock_code)]
        out.update(future)
    return sorted(out)


def snap_to_trading_day(d: date, trading_days: list[date]) -> date | None:
    """Expiry on a holiday moves to the previous trading day."""
    prior = [t for t in trading_days if t <= d]
    if not prior or (d - prior[-1]).days > 5:
        return None
    return prior[-1]
