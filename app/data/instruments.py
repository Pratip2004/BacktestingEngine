"""Index underlyings the platform trades: ICICI codes, exchanges, strike steps, and dated rules.

Rules that changed over time are stored as (effective_from, value) pairs, newest first, so a backtest
on an old date uses the rule that applied then:
- weekly expiry weekday (NIFTY moved Thursday → Tuesday on 1 Sep 2025; SENSEX Friday → Tuesday → Thursday)
- lot size (exchange revisions)

Past expiries are generated from the weekday rule and snapped to real trading days (holidays) in
app/options/expiries.py; upcoming ones come from ICICI's SecurityMaster.
"""

from dataclasses import dataclass
from datetime import date

MON, TUE, WED, THU, FRI = 0, 1, 2, 3, 4


@dataclass(frozen=True)
class Underlying:
    name: str  # what the UI shows / the store keys by
    stock_code: str  # ICICI Breeze code
    spot_exchange: str  # where the index itself trades (for spot candles)
    fno_exchange: str  # where its futures & options trade
    strike_step: int
    master_file: str  # file inside SecurityMaster.zip listing its F&O contracts
    option_instrument: str  # InstrumentName of its options in that file
    expiry_weekdays: tuple[tuple[date, int], ...]  # (effective_from, weekday), newest first
    # (effective_from, lot size), newest first. Exchange revisions; verify against circulars when
    # backtesting across a change. Editable later via the data store's lot_sizes table.
    lot_sizes: tuple[tuple[date, int], ...]

    def expiry_weekday(self, d: date) -> int:
        return next(w for since, w in self.expiry_weekdays if d >= since)

    def lot_size(self, d: date) -> int:
        return next(n for since, n in self.lot_sizes if d >= since)

    def atm(self, spot: float) -> float:
        return round(spot / self.strike_step) * self.strike_step


UNDERLYINGS: dict[str, Underlying] = {
    "NIFTY": Underlying(
        name="NIFTY",
        stock_code="NIFTY",
        spot_exchange="NSE",
        fno_exchange="NFO",
        strike_step=50,
        master_file="FONSEScripMaster.txt",
        option_instrument="OPTIDX",
        expiry_weekdays=((date(2025, 9, 1), TUE), (date(2000, 1, 1), THU)),
        lot_sizes=((date(2025, 12, 30), 65), (date(2024, 11, 20), 75), (date(2000, 1, 1), 25)),
    ),
    "SENSEX": Underlying(
        name="SENSEX",
        stock_code="BSESEN",
        spot_exchange="BSE",
        fno_exchange="BFO",
        strike_step=100,
        master_file="FOBSEScripMaster.txt",
        option_instrument="OPTIND",
        expiry_weekdays=((date(2025, 9, 1), THU), (date(2025, 1, 1), TUE), (date(2000, 1, 1), FRI)),
        lot_sizes=((date(2024, 11, 20), 20), (date(2000, 1, 1), 10)),
    ),
}

_BY_CODE = {u.stock_code: u for u in UNDERLYINGS.values()}


def underlying(name_or_code: str) -> Underlying:
    """Look up by UI name ("SENSEX") or ICICI code ("BSESEN")."""
    u = UNDERLYINGS.get(name_or_code) or _BY_CODE.get(name_or_code)
    if u is None:
        raise KeyError(f"Unknown underlying {name_or_code!r}; known: {', '.join(UNDERLYINGS)}")
    return u
