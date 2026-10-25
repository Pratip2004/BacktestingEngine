"""Option chain views built on Breeze.

- live_chain(): today's chain for an upcoming expiry (get_option_chain_quotes), ATM ± N strikes.
- expiry_snapshot(): an expired contract set reconstructed from daily candles (get_historical_data_v2),
  taken N trading days before expiry, ATM ± N strikes.

Both return the same shape so the UI renders them with one component. IV and delta are computed
with Black-Scholes, since Breeze doesn't provide greeks.
"""

import json
import logging
from datetime import date, datetime, time, timedelta
from typing import Callable

import pandas as pd
from fastapi import HTTPException

from app.breeze_client import breeze, to_breeze_date
from app.options.expiries import CACHE_DIR, past_expiry_candidates, snap_to_trading_day
from app.options.greeks import bs_delta, implied_vol

log = logging.getLogger(__name__)

OPTIONS_CACHE = CACHE_DIR / "options"
STRIKE_STEP = {"NIFTY": 50, "CNXBAN": 100, "NIFFIN": 50, "NIFSEL": 25}
MARKET_CLOSE = time(15, 30)
HISTORY_WINDOW_DAYS = 30  # candles fetched per expired contract, ending on expiry day


def _num(rec: dict, *keys: str) -> float | None:
    for k in keys:
        v = rec.get(k)
        if v not in (None, ""):
            try:
                return float(v)
            except (TypeError, ValueError):
                pass
    return None


def _expiry_param(d: date) -> str:
    return to_breeze_date(datetime.combine(d, time(7, 0)))


def _leg(price, oi, chg_oi, volume, spot, strike, t, r, is_call, **extra) -> dict:
    iv = implied_vol(price, spot, strike, t, r, is_call) if price else None
    return {
        "ltp": price,
        "oi": oi,
        "chg_oi": chg_oi,
        "volume": volume,
        "iv": round(iv * 100, 2) if iv else None,
        "delta": round(d, 3) if iv and (d := bs_delta(spot, strike, t, r, iv, is_call)) is not None else None,
        **extra,
    }


def _summary(rows: list[dict], spot: float, atm: float, full_oi: dict[float, tuple[float, float]] | None = None) -> dict:
    """Totals for the shown strikes, plus max pain over `full_oi` (strike → (call OI, put OI)) when given."""
    call_oi = sum(r["call"]["oi"] or 0 for r in rows)
    put_oi = sum(r["put"]["oi"] or 0 for r in rows)
    atm_row = next((r for r in rows if r["strike"] == atm), None)
    atm_ivs = [x for x in (atm_row["call"]["iv"], atm_row["put"]["iv"]) if x] if atm_row else []
    straddle = (atm_row["call"]["ltp"] or 0) + (atm_row["put"]["ltp"] or 0) if atm_row else None

    oi_map = full_oi or {r["strike"]: (r["call"]["oi"] or 0, r["put"]["oi"] or 0) for r in rows}
    max_pain = None
    if oi_map:
        def pain(s: float) -> float:
            return sum(c * max(0, s - k) + p * max(0, k - s) for k, (c, p) in oi_map.items())
        max_pain = min(oi_map, key=pain)

    def wall(side: str) -> float | None:
        best = max(rows, key=lambda r: r[side]["oi"] or 0, default=None)
        return best["strike"] if best and best[side]["oi"] else None

    return {
        "spot": round(spot, 2),
        "atm": atm,
        "call_oi": call_oi,
        "put_oi": put_oi,
        "pcr_oi": round(put_oi / call_oi, 3) if call_oi else None,
        "atm_iv": round(sum(atm_ivs) / len(atm_ivs), 2) if atm_ivs else None,
        "atm_straddle": round(straddle, 2) if straddle else None,
        "max_pain": max_pain,
        "call_wall": wall("call"),  # strike with the most call OI (resistance)
        "put_wall": wall("put"),  # strike with the most put OI (support)
    }


# ---------- Live chain ----------

def live_chain(stock_code: str, expiry: date, strikes_around: int = 5, rate: float = 0.065) -> dict:
    legs: dict[tuple[float, bool], dict] = {}
    for right in ("call", "put"):
        records = breeze.call(
            "get_option_chain_quotes",
            stock_code=stock_code,
            exchange_code="NFO",
            product_type="options",
            expiry_date=_expiry_param(expiry),
            right=right,
            strike_price="",
        ) or []
        for rec in records:
            strike = _num(rec, "strike_price")
            if strike is not None:
                legs[(strike, right == "call")] = rec
    if not legs:
        raise HTTPException(404, f"No option chain for {stock_code} {expiry}")

    spot = next((s for rec in legs.values() if (s := _num(rec, "spot_price"))), None)
    if not spot:
        quote = breeze.call("get_quotes", stock_code=stock_code, exchange_code="NSE", product_type="cash")
        spot = _num(quote[0], "ltp") if quote else None
    if not spot:
        raise HTTPException(502, "Could not determine the underlying spot price")

    now = datetime.now()
    t = max((datetime.combine(expiry, MARKET_CLOSE) - now).total_seconds(), 0) / (365 * 86400)

    strikes = sorted({k for k, _ in legs})
    atm = min(strikes, key=lambda k: abs(k - spot))
    i = strikes.index(atm)
    shown = strikes[max(0, i - strikes_around): i + strikes_around + 1]

    def leg(strike: float, is_call: bool) -> dict:
        rec = legs.get((strike, is_call), {})
        return _leg(
            _num(rec, "ltp"), _num(rec, "open_interest"), _num(rec, "chnge_oi", "change_oi"),
            _num(rec, "total_quantity_traded", "volume"), spot, strike, t, rate, is_call,
            bid=_num(rec, "best_bid_price"), ask=_num(rec, "best_offer_price"),
            ltp_chg_pct=_num(rec, "ltp_percent_change"),
        )

    rows = [{"strike": k, "offset": j - (i - max(0, i - strikes_around)), "call": leg(k, True), "put": leg(k, False)}
            for j, k in enumerate(shown)]
    full_oi = {k: (_num(legs.get((k, True), {}), "open_interest") or 0, _num(legs.get((k, False), {}), "open_interest") or 0)
               for k in strikes}
    return {
        "stock_code": stock_code,
        "expiry": expiry.isoformat(),
        "as_of": now.isoformat(timespec="seconds"),
        "days_to_expiry": round(t * 365, 2),
        "source": "live",
        "summary": _summary(rows, spot, atm, full_oi),
        "rows": rows,
    }


# ---------- Expired contracts ----------

def _option_candles(stock_code: str, expiry: date, strike: float, right: str) -> list[dict]:
    """Daily candles for one expired contract. Cached on disk forever, since history doesn't change."""
    key = OPTIONS_CACHE / f"{stock_code}_{expiry:%Y%m%d}_{strike:g}_{right}.json"
    if key.exists():
        return json.loads(key.read_text())
    rows = breeze.call(
        "get_historical_data_v2",
        interval="1day",
        from_date=to_breeze_date(datetime.combine(expiry - timedelta(days=HISTORY_WINDOW_DAYS), time(0, 0))),
        to_date=to_breeze_date(datetime.combine(expiry, time(23, 59, 59))),
        stock_code=stock_code,
        exchange_code="NFO",
        product_type="options",
        expiry_date=_expiry_param(expiry),
        right=right,
        strike_price=f"{strike:g}",
    ) or []
    if expiry < date.today():
        OPTIONS_CACHE.mkdir(parents=True, exist_ok=True)
        key.write_text(json.dumps(rows))
    return rows


def expiry_snapshot(
    stock_code: str,
    expiry: date,
    spot_df: pd.DataFrame,
    days_before: int = 1,
    strikes_around: int = 5,
    rate: float = 0.065,
    on_leg: Callable[[], None] = lambda: None,
) -> dict:
    """The chain as it stood at the close `days_before` trading days before `expiry` (already a trading day)."""
    trading_days = list(spot_df["date"])
    idx = trading_days.index(expiry)
    snap_day = trading_days[max(0, idx - days_before)]
    spot = float(spot_df.loc[spot_df["date"] == snap_day, "close"].iloc[0])
    step = STRIKE_STEP.get(stock_code, 50)
    atm = round(spot / step) * step
    t = (expiry - snap_day).days / 365

    def leg(strike: float, is_call: bool) -> dict:
        candles = _option_candles(stock_code, expiry, strike, "call" if is_call else "put")
        on_leg()
        by_day = {pd.to_datetime(c["datetime"]).date(): c for c in candles}
        cur = by_day.get(snap_day, {})
        prev_days = [d for d in by_day if d < snap_day]
        prev = by_day[max(prev_days)] if prev_days else {}
        oi, prev_oi = _num(cur, "open_interest"), _num(prev, "open_interest")
        return _leg(
            _num(cur, "close"), oi, oi - prev_oi if oi is not None and prev_oi is not None else None,
            _num(cur, "volume"), spot, strike, t, rate, is_call,
            # OI path through the life of the contract, for the trend chart.
            oi_history=[{"date": d.isoformat(), "oi": _num(c, "open_interest"), "close": _num(c, "close")}
                        for d, c in sorted(by_day.items())],
        )

    rows = []
    for off in range(-strikes_around, strikes_around + 1):
        k = atm + off * step
        rows.append({"strike": k, "offset": off, "call": leg(k, True), "put": leg(k, False)})
    return {
        "stock_code": stock_code,
        "expiry": expiry.isoformat(),
        "as_of": snap_day.isoformat(),
        "days_to_expiry": (expiry - snap_day).days,
        "source": "historical",
        "summary": _summary(rows, spot, atm),
        "rows": rows,
    }


def expiry_comparison(
    stock_code: str = "NIFTY",
    count: int = 10,
    kind: str = "weekly",
    strikes_around: int = 5,
    days_before: int = 1,
    rate: float = 0.065,
    progress: Callable[[int, int, str], None] = lambda done, total, msg: None,
) -> dict:
    candidates = past_expiry_candidates(count, kind)
    spot_df = breeze.historical_df(
        stock_code, "NSE", "1day",
        datetime.combine(candidates[-1] - timedelta(days=HISTORY_WINDOW_DAYS + 10), time(0)),
        datetime.combine(date.today(), time(23, 59)),
    )
    if spot_df.empty:
        raise HTTPException(502, f"No daily candles for {stock_code} to anchor expiries")
    spot_df["date"] = spot_df["datetime"].dt.date
    trading_days = list(spot_df["date"])

    expiries = [e for c in candidates if (e := snap_to_trading_day(c, trading_days))]
    total = len(expiries) * (2 * strikes_around + 1) * 2
    done = 0

    def tick(msg: str):
        nonlocal done
        done += 1
        progress(done, total, msg)

    snapshots, skipped = [], []
    for e in expiries:
        try:
            snapshots.append(expiry_snapshot(
                stock_code, e, spot_df, days_before, strikes_around, rate,
                on_leg=lambda e=e: tick(f"Expiry {e:%d %b %Y}"),
            ))
        except HTTPException as exc:
            log.warning("Skipping expiry %s: %s", e, exc.detail)
            skipped.append({"expiry": e.isoformat(), "reason": exc.detail})
    return {
        "stock_code": stock_code,
        "kind": kind,
        "days_before_expiry": days_before,
        "strikes_around": strikes_around,
        "expiries": snapshots,
        "skipped": skipped,
    }
