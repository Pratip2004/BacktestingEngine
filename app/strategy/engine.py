"""Generic backtest engine: runs any StrategySpec over a date range.

Per trade day:
1. Entry events: a fixed time (optionally the previous trading day, held overnight) or the close of every
   candle where an entry condition is true (entered at the next minute's open). One position at a time;
   max trades per day, re-entry after a stop, daily loss limit.
2. Open: ATM from the underlying's 1-minute open at the entry minute; each leg's strike and expiry from its
   selectors; fills at each leg's first 1-minute open at/after the entry minute ± slippage.
3. Manage until exit, in one of two modes (exits.evaluation):
   - intrabar: every minute. Combined P&L extremes come from two scenarios (underlying at the minute's high:
     calls high / puts low / futures high; and at its low), so a call's high is never paired with a put's
     high. Targets fill as limit orders (at the level, or a better gapped open); stops as stop-market orders
     (at the level or a worse gapped open, plus slippage). A stop and target in the same minute → stop first.
   - close: at each `every`-minute candle close; exits fill at that close ∓ slippage.
   Per-leg exits, trailing stops, per-DTE combined overrides, spot-move, signal and opposite-signal exits.
4. Otherwise square off at the square-off minute's open (intrabar) or the close of the last candle ending
   by then (close mode).

Data comes from the local store (app/data/access.py), which fetches anything missing from Breeze.
"""

from __future__ import annotations

import math
from dataclasses import dataclass, field
from datetime import date, datetime, time, timedelta
from typing import Callable

import numpy as np
import pandas as pd
from fastapi import HTTPException

from app.backtest.straddle_engine import _trading_days_to
from app.breeze_client import breeze
from app.data.access import future_minute_bars, option_minute_bars, spot_minute_bars
from app.data.daily import daily_bars
from app.data.ingest import _monthly
from app.data.instruments import SPECIAL_SESSIONS
from app.data.instruments import underlying as get_underlying
from app.data.store import get_store
from app.options.expiries import weekly_expiries_between
from app.options.greeks import bs_delta, implied_vol
from app.strategy.signals import Evaluator, lookback_minutes, signal_times
from app.strategy.margin import DEFAULT_FUT_PCT, DEFAULT_SHORT_PCT, margin_required
from app.strategy.spec import DAILY_TFS, TF_MINUTES, CombinedExits, Operand, Leg, Level, StrategySpec, entry_times, legs_for, validate_spec

RISK_FREE = 0.065
MAX_STRIKE_SEARCH = 40  # strikes scanned outward from ATM for premium / delta selection
SESSION_END = time(15, 30)
TICK = 0.05  # an option can't fill below one tick, however far slippage pushes it
# Bumped whenever a change can alter results; research results from another version aren't reused.
ENGINE_VERSION = 6  # 4: monthly expiry by nominal month (holiday-shifted weeklies) · 5: swing signal exits act at their time, not the next check · 6: daily ATR for underlying stops over the whole period


# ---------- costs (rates by date) ----------

class DatedCosts:
    """Order costs with the statutory rates that applied on each date: options from store.cost_schedule,
    futures from store.fut_cost_schedule. Futures fills also have their own slippage."""

    def __init__(self, brokerage: float, slippage: float, taxes: bool, fut_slippage: float | None = None):
        self.brokerage, self.slippage, self.taxes = brokerage, slippage, taxes
        self.fut_slippage = slippage if fut_slippage is None else fut_slippage
        cols = "effective_from, stt_sell_pct, exchange_pct, sebi_pct, stamp_buy_pct, gst_pct"
        self._rates = get_store().q(f"SELECT {cols} FROM cost_schedule ORDER BY effective_from DESC")
        self._fut_rates = get_store().q(f"SELECT {cols} FROM fut_cost_schedule ORDER BY effective_from DESC") or self._rates

    def _rate(self, d: date, fut: bool = False):
        return next(r for r in (self._fut_rates if fut else self._rates) if d >= r[0])

    def slip(self, leg: "LegState | Leg") -> float:
        spec = getattr(leg, "spec", leg)
        return self.fut_slippage if spec.instrument == "FUT" else self.slippage

    def order(self, price: float, qty: float, is_buy: bool, d: date, fut: bool = False) -> float:
        if not self.taxes:
            return self.brokerage
        _, stt, exch, sebi, stamp, gst = self._rate(d, fut)
        turnover = price * qty
        exchange, sebi_fee = exch / 100 * turnover, sebi / 100 * turnover
        return (self.brokerage + (0 if is_buy else stt / 100 * turnover) + exchange + sebi_fee
                + (stamp / 100 * turnover if is_buy else 0) + gst / 100 * (self.brokerage + exchange + sebi_fee))


def _fut(leg) -> bool:
    return getattr(leg, "spec", leg).instrument == "FUT"


# ---------- position state ----------

@dataclass
class LegState:
    spec: Leg
    side: int  # +1 long, −1 short
    strike: float | None
    expiry: date
    qty: int
    bars: pd.DataFrame
    entry: float = 0.0  # fill incl. slippage
    entry_at: pd.Timestamp | None = None
    exit: float | None = None
    exit_at: pd.Timestamp | None = None
    reason: str | None = None
    stop_px: float | None = None
    target_px: float | None = None
    slip_pts: float = 0.0  # slippage actually paid on entry + exit, per unit

    @property
    def open(self) -> bool:
        return self.exit is None

    def pnl(self, price: float) -> float:
        return self.side * self.qty * (price - self.entry)

    def label(self) -> str:
        if self.spec.instrument == "FUT":
            return f"FUT {self.expiry:%d %b}"
        return f"{self.strike:g} {self.spec.instrument} {self.expiry:%d %b}"


@dataclass
class Trade:
    trade_day: date
    direction: str | None
    dte: int
    entry_at: pd.Timestamp
    spot_entry: float
    atm: float
    legs: list[LegState]
    premium: float  # ₹, signed: + paid (debit), − received (credit)
    entry_cost: float
    exit_at: pd.Timestamp | None = None
    reason: str = "time"
    exit_cost: float = 0.0
    mfe: float = -math.inf
    mae: float = math.inf
    stale_fills: int = 0
    notes: list[str] = field(default_factory=list)
    margin_pcts: tuple[float, float] = (DEFAULT_SHORT_PCT, DEFAULT_FUT_PCT)
    daily_mtm: list[dict] | None = None  # swing: [{d, pnl}] per trading day held, sums to net

    @property
    def capital(self) -> float:
        return abs(self.premium)

    @property
    def gross(self) -> float:
        return sum(l.pnl(l.exit) for l in self.legs if l.exit is not None)

    @property
    def net(self) -> float:
        return self.gross - self.entry_cost - self.exit_cost

    def to_json(self) -> dict:
        legs = [
            {
                "id": l.spec.id, "action": l.spec.action, "instrument": l.spec.instrument, "strike": l.strike,
                "expiry": l.expiry.isoformat(), "label": l.label(), "qty": l.qty, "entry": round(l.entry, 2),
                "exit": round(l.exit, 2) if l.exit is not None else None,
                "exit_at": l.exit_at.strftime("%Y-%m-%d %H:%M") if l.exit_at is not None else None,
                "reason": l.reason, "pnl": round(l.pnl(l.exit), 2) if l.exit is not None else None,
                "slip": round(l.slip_pts, 2),
            }
            for l in self.legs
        ]
        margin, basis = margin_required(legs, self.premium, self.spot_entry, *self.margin_pcts)
        extra = {} if self.daily_mtm is None else {"daily_mtm": self.daily_mtm, "hold_days": len(self.daily_mtm)}
        return {
            "trade_day": self.trade_day.isoformat(),
            "weekday": self.trade_day.weekday(),
            "direction": self.direction,
            "dte": self.dte,
            "entry_at": self.entry_at.strftime("%Y-%m-%d %H:%M"),
            "exit_at": self.exit_at.strftime("%Y-%m-%d %H:%M") if self.exit_at is not None else None,
            "spot_entry": round(self.spot_entry, 2),
            "atm": self.atm,
            "premium": round(self.premium, 2),
            "capital": round(self.capital, 2),
            "gross": round(self.gross, 2),
            "costs": round(self.entry_cost + self.exit_cost, 2),
            "net": round(self.net, 2),
            "pct": round(self.net / self.capital * 100, 2) if self.capital else None,  # of premium
            "margin": round(margin, 2),  # money blocked: premium (buys), max loss (hedged), approx SPAN (shorts, futures)
            "margin_basis": basis,
            "pct_margin": round(self.net / margin * 100, 2) if margin else None,
            "reason": self.reason,
            "mfe": round(self.mfe, 2) if math.isfinite(self.mfe) else None,
            "mae": round(self.mae, 2) if math.isfinite(self.mae) else None,
            "stale_fills": self.stale_fills,
            "legs": legs,
            **extra,
        }


# ---------- helpers ----------

def _known_true(series: pd.Series, ts: pd.Timestamp) -> bool:
    """Value of a condition series (indexed by candle close) on the latest close at/before ts. Before the day's first
    candle has closed that's the previous session's last candle, so an early entry can still be gated on e.g. a
    daily regime or VIX (engine 4; before, such an entry never traded)."""
    known = series[series.index <= ts]
    return not known.empty and bool(known.iloc[-1])

def _first_at(bars: pd.DataFrame, ts: pd.Timestamp, col: str = "open") -> tuple[pd.Timestamp, float] | None:
    """First candle at or after ts on ts's own day."""
    i = bars["datetime"].searchsorted(ts, side="left")
    if i < len(bars) and bars["datetime"].iloc[i].date() == ts.date():
        return bars["datetime"].iloc[i], float(bars[col].iloc[i])
    return None


def _last_close_before(bars: pd.DataFrame, ts: pd.Timestamp) -> float | None:
    """Close of the last candle that started before ts (i.e. finished by ts)."""
    i = bars["datetime"].searchsorted(ts, side="left") - 1
    return float(bars["close"].iloc[i]) if i >= 0 else None


def _level(lv: Level | None, capital: float, unit_qty: float) -> float | None:
    """A Level → ₹ of P&L."""
    if lv is None:
        return None
    if lv.unit == "pct":
        return lv.value / 100 * capital
    if lv.unit == "rupees":
        return lv.value
    return lv.value * unit_qty  # points × quantity of one strategy unit


def _scenario_price(leg: LegState, row: dict, scenario: str) -> float:
    """Leg price when the underlying is at the minute's high ("up") or low ("down")."""
    o, h, l = row[f"{leg.spec.id}_o"], row[f"{leg.spec.id}_h"], row[f"{leg.spec.id}_l"]
    if scenario == "open":
        return o
    rises = leg.spec.instrument in ("CE", "FUT")
    return (h if rises else l) if scenario == "up" else (l if rises else h)


# ---------- engine ----------

class Engine:
    def __init__(self, spec: StrategySpec, start: date, end: date, progress: Callable[[int, int, str], None]):
        self.spec, self.start, self.end, self.progress = spec, start, end, progress
        self.u = get_underlying(spec.underlying)
        self.costs = DatedCosts(spec.costs.brokerage_per_order, spec.costs.slippage_points, spec.costs.taxes,
                                spec.costs.fut_slippage_points)
        self.skipped: list[dict] = []
        self._spot: dict[date, pd.DataFrame] = {}
        cfg = get_store().settings()
        self.margin_pcts = (float(cfg.get("short_margin_pct", DEFAULT_SHORT_PCT)), float(cfg.get("fut_margin_pct", DEFAULT_FUT_PCT)))

    # ----- calendar -----

    def _calendar(self):
        # From the daily store (one Breeze call per ~1000 days, cached), so runs and offline screens don't spend a
        # call each. Loaded past `end` so an expiry just after it is still snapped to a trading day. Muhurat
        # sessions (an hour in the evening) appear in daily candles but aren't trading days: no expiries, no trades.
        daily = daily_bars(self.u.stock_code, self.start - timedelta(days=40), self.end + timedelta(days=14))
        if daily.empty:
            raise HTTPException(404, f"No daily candles for {self.u.name} in this range")
        self.trading_days = sorted(d for d in pd.to_datetime(daily["d"]).dt.date.unique() if d not in SPECIAL_SESSIONS)
        self.weekly = weekly_expiries_between(self.start - timedelta(days=7), self.end + timedelta(days=100), self.trading_days, self.u.stock_code)
        self.monthly = _monthly(self.weekly, self.u.stock_code)
        sched = self.spec.schedule
        days = []
        for d in self.trading_days:
            if not self.start <= d <= self.end:
                continue
            if sched.weekdays is not None and d.weekday() not in sched.weekdays:
                continue
            nearest = next((e for e in self.weekly if e >= d), None)
            dte = _trading_days_to(d, nearest, self.trading_days) if nearest else 99
            if sched.dte is not None and dte not in sched.dte:
                continue
            days.append((d, dte))
        self.trade_days = days
        self.dte_by_day = {}
        for d in self.trading_days:
            nearest = next((e for e in self.weekly if e >= d), None)
            self.dte_by_day[d] = _trading_days_to(d, nearest, self.trading_days) if nearest else 99

    def _prev_trading_day(self, d: date) -> date | None:
        i = self.trading_days.index(d)
        return self.trading_days[i - 1] if i > 0 else None

    def _signal_end(self) -> date:
        """Last day signals are needed for (intraday: the last trade day)."""
        return self.trade_days[-1][0]

    # ----- signals -----

    def _signals(self):
        e, x = self.spec.schedule.entry, self.spec.exits
        conds = {"signal": e.signal, "bullish": e.bullish, "bearish": e.bearish} if e.type == "signal" else {}
        entry_filter = e.filter if e.type == "time" else None
        time_dir = {"bullish": e.bullish, "bearish": e.bearish} if e.type == "time" else {}
        dir_exits = {"bullish": x.exit_bullish, "bearish": x.exit_bearish}
        need = (any(conds.values()) or x.exit_signal is not None or entry_filter is not None or any(time_dir.values())
                or any(dir_exits.values()))
        self.entry_signals: dict[date, list[tuple[pd.Timestamp, str]]] = {}  # on trade days only
        self.all_entry_signals: list[tuple[pd.Timestamp, str]] = []  # every day (swing: entered the next day)
        self.exit_signals: list[pd.Timestamp] = []
        self.dir_exit_signals: dict[str, list[pd.Timestamp]] = {"bullish": [], "bearish": []}
        self.opposite: dict[str, list[pd.Timestamp]] = {"bullish": [], "bearish": []}
        self.entry_filter: pd.Series | None = None
        self.time_direction: dict[str, pd.Series] = {}
        if not need or not self.trade_days:
            return
        tf = self.spec.timeframe
        lb = max(lookback_minutes(c, tf) for c in [*conds.values(), *time_dir.values(), x.exit_signal, entry_filter, *dir_exits.values()])
        warm_days = max(5, math.ceil(lb / 375) + 2)
        first, last = self.trade_days[0][0], self._signal_end()
        i0 = max(0, self.trading_days.index(first) - warm_days)
        days = [d for d in self.trading_days[i0:] if d <= last]
        m1 = spot_minute_bars(self.u.stock_code, days)
        self.signal_m1 = m1
        if m1.empty:
            raise HTTPException(404, f"No 1-minute {self.u.name} candles for the signal calculation")
        trade_set = {d for d, _ in self.trade_days}
        ctx = {"dte": self.dte_by_day}
        ev = Evaluator(m1, tf, self.u.stock_code, ctx)
        if entry_filter is not None:
            # True/False at each candle close; a time entry reads the latest close at or before it (no lookahead)
            self.entry_filter = ev.evaluate(entry_filter).sort_index()
        for label, cond in time_dir.items():
            if cond is not None:
                self.time_direction[label] = ev.evaluate(cond).sort_index()
        for t, label in signal_times(m1, tf, conds, set(days), self.u.stock_code, ctx):
            self.all_entry_signals.append((t, label))
            if t.date() in trade_set:
                self.entry_signals.setdefault(t.date(), []).append((t, label))
            if label in self.opposite:
                self.opposite[label].append(t)
        if x.exit_signal is not None:
            self.exit_signals = [t for t, _ in signal_times(m1, tf, {"exit": x.exit_signal}, set(days), self.u.stock_code, ctx)]
        for label, cond in dir_exits.items():
            if cond is not None:
                self.dir_exit_signals[label] = [t for t, _ in signal_times(m1, tf, {"exit": cond}, set(days), self.u.stock_code, ctx)]

    # ----- data -----

    def spot(self, d: date) -> pd.DataFrame:
        if d not in self._spot:
            self._spot[d] = spot_minute_bars(self.u.stock_code, [d])
        return self._spot[d]

    def _expiry(self, leg: Leg, trade_day: date) -> date | None:
        sel = leg.expiry
        pool = self.monthly if (sel.by == "monthly" or leg.instrument == "FUT") else self.weekly
        cands = [e for e in pool if (e > trade_day if sel.skip_expiry_day else e >= trade_day)]
        if sel.min_days:
            cands = [e for e in cands if _trading_days_to(trade_day, e, self.trading_days) >= sel.min_days]
        return cands[sel.n] if len(cands) > sel.n else None

    def _bars(self, leg: Leg, expiry: date, strike: float | None, days: list[date]) -> pd.DataFrame:
        if leg.instrument == "FUT":
            return future_minute_bars(self.u.stock_code, expiry, days)
        return option_minute_bars(self.u.stock_code, expiry, strike, "call" if leg.instrument == "CE" else "put", days)

    def _strike(self, leg: Leg, spot: float, atm: float, expiry: date, ts: pd.Timestamp, days: list[date]) -> float | None:
        step, sel = self.u.strike_step, leg.strike
        if leg.instrument == "FUT":
            return None
        if sel.by == "atm_offset":
            return atm + round(sel.value) * step
        if sel.by == "points":
            return atm + round(sel.value / step) * step
        otm = 1 if leg.instrument == "CE" else -1
        if sel.by == "pct_otm":
            return self.u.atm(spot * (1 + otm * sel.value / 100))
        # premium / delta: scan outward from ATM in the OTM direction, pick the closest match
        t_years = max((datetime.combine(expiry, SESSION_END) - ts.to_pydatetime()).total_seconds(), 60) / (365 * 86400)
        best, best_err = None, math.inf
        for k in range(0, MAX_STRIKE_SEARCH + 1):
            strike = atm + otm * k * step
            at = _first_at(self._bars(leg, expiry, strike, days), ts)
            if at is None:
                continue
            price = at[1]
            if sel.by == "premium":
                err = abs(price - sel.value)
            else:
                iv = implied_vol(price, spot, strike, t_years, RISK_FREE, leg.instrument == "CE")
                if iv is None:
                    continue
                err = abs(abs(bs_delta(spot, strike, t_years, RISK_FREE, iv, leg.instrument == "CE")) - sel.value)
            if err < best_err:
                best, best_err = strike, err
            elif best is not None and err > best_err * 1.5:
                break  # moving away from the target
        return best

    # ----- open -----

    def _open(self, trade_day: date, dte: int, ts: pd.Timestamp, direction: str | None) -> Trade | None:
        spec = self.spec
        entry_day = ts.date()
        legs_spec = legs_for(spec, direction)
        at = _first_at(self.spot(entry_day), ts)
        if at is None:
            self.skipped.append({"time": str(ts), "reason": f"{self.u.name} didn't trade at {ts:%H:%M} on {entry_day:%d %b}"})
            return None
        spot = at[1]
        atm = self.u.atm(spot)
        lot_size = spec.lot_size or self.u.lot_size(trade_day)
        days = sorted({entry_day, trade_day})
        legs: list[LegState] = []
        for l in legs_spec:
            expiry = self._expiry(l, trade_day)
            if expiry is None:
                self.skipped.append({"time": str(ts), "reason": f"No {l.expiry.by} expiry for leg {l.id}"})
                return None
            strike = self._strike(l, spot, atm, expiry, ts, days)
            if l.instrument != "FUT" and strike is None:
                self.skipped.append({"time": str(ts), "reason": f"No strike matched leg {l.id}"})
                return None
            bars = self._bars(l, expiry, strike, days)
            fill = _first_at(bars, ts)
            if fill is None:
                name = f"{strike:g} {l.instrument}" if strike is not None else "FUT"
                self.skipped.append({"time": str(ts), "reason": f"No {name} ({expiry:%d %b}) trade at or after {ts:%H:%M} on {entry_day:%d %b}"})
                return None
            side = 1 if l.action == "buy" else -1
            leg = LegState(l, side, strike, expiry, spec.lots * l.lots * lot_size, bars)
            leg.entry = max(TICK, fill[1] + side * self.costs.slip(l))
            leg.slip_pts = abs(leg.entry - fill[1])
            leg.entry_at = fill[0]
            legs.append(leg)
        premium = sum(l.side * l.qty * l.entry for l in legs)
        entry_cost = sum(self.costs.order(l.entry, l.qty, l.side > 0, entry_day, _fut(l)) for l in legs)
        trade = Trade(trade_day, direction, dte, max(l.entry_at for l in legs), spot, atm, legs, premium, entry_cost)
        trade.stale_fills = sum(1 for l in legs if l.entry_at > ts)
        trade.margin_pcts = self.margin_pcts
        return trade

    def _levels(self, trade: Trade, lot_size_unit: float):
        x = self.spec.exits
        combined: CombinedExits = x.dte_overrides.get(trade.dte, x.combined)
        cap = trade.capital
        target = _level(combined.target, cap, lot_size_unit)
        stop = _level(combined.stop, cap, lot_size_unit)
        trail = None
        if combined.trailing:
            trail = (_level(combined.trailing.activate, cap, lot_size_unit), _level(combined.trailing.trail, cap, lot_size_unit))
        # per-leg levels → leg price levels
        for leg in trade.legs:
            ex = leg.spec.exits or (x.per_leg if x.per_leg else None)
            if ex is None:
                continue
            for kind in ("target", "stop"):
                lv = getattr(ex, kind)
                if lv is None:
                    continue
                per_unit = lv.value / 100 * leg.entry if lv.unit == "pct" else (lv.value / leg.qty if lv.unit == "rupees" else lv.value)
                favourable = kind == "target"
                # long: target above / stop below entry; short: the reverse
                sign = leg.side if favourable else -leg.side
                setattr(leg, f"{kind}_px", leg.entry + sign * per_unit)
        return target, stop, trail

    # ----- run -----

    def _time_events(self, entry_day: date) -> list[tuple[pd.Timestamp, str | None]]:
        """(time, direction) for each of the day's entry times whose filter / directional conditions hold."""
        events = []
        for hhmm in entry_times(self.spec.schedule.entry):
            ts0 = pd.Timestamp(datetime.combine(entry_day, time.fromisoformat(hhmm)))
            if self.entry_filter is not None and not _known_true(self.entry_filter, ts0):
                continue  # filter false (or no candle closed yet that day): no trade
            direction = None
            if self.time_direction:
                hits = [lbl for lbl, ser in self.time_direction.items() if _known_true(ser, ts0)]
                if len(hits) != 1:
                    continue  # neither (or both) directional conditions true: no trade
                direction = hits[0]
            events.append((ts0, direction))
        return events

    def run(self) -> dict:
        self._calendar()
        self._signals()
        spec, sched, e = self.spec, self.spec.schedule, self.spec.schedule.entry
        trades: list[Trade] = []
        n = len(self.trade_days)
        for k, (d, dte) in enumerate(self.trade_days):
            self.progress(k, n, f"{d:%d %b %Y} · {len(trades)} trades")
            if e.type == "time":
                entry_day = self._prev_trading_day(d) if e.prev_day else d
                if entry_day is None:
                    continue
                events = self._time_events(entry_day)
            else:
                events = [(t, None if label == "signal" else label) for t, label in self.entry_signals.get(d, [])
                          if e.window_start <= t.strftime("%H:%M") <= e.last_entry]
            free_at: pd.Timestamp | None = None
            taken, day_pnl, reentries = 0, 0.0, sched.reentry_after_stop
            i = 0
            while i < len(events):
                ts, direction = events[i]
                i += 1
                if free_at is not None and ts < free_at:
                    continue
                if taken >= sched.max_trades_per_day:
                    break
                if spec.risk.max_loss_per_day and day_pnl <= -spec.risk.max_loss_per_day:
                    break
                trade = self._open(d, dte, ts, direction)
                if trade is None:
                    continue
                if not self._manage(trade):
                    continue
                trades.append(trade)
                taken += 1
                day_pnl += trade.net
                # An intrabar exit happens inside minute exit_at, after that minute's open: the next entry waits a minute.
                free_at = trade.exit_at + pd.Timedelta(minutes=1 if spec.exits.evaluation.mode == "intrabar" else 0)
                if e.type == "time" and trade.reason in ("stop", "trail") and reentries > 0 \
                        and trade.exit_at.strftime("%H:%M") < e.last_entry and trade.exit_at.date() == d:
                    reentries -= 1
                    events.insert(i, (trade.exit_at + pd.Timedelta(minutes=1), direction))
        self.progress(n, n, f"Done · {len(trades)} trades")
        return {"trades": [t.to_json() for t in trades], "skipped": self.skipped}

    # ----- manage an open position -----

    def _manage(self, trade: Trade) -> bool:
        lot_unit = (self.spec.lot_size or self.u.lot_size(trade.trade_day)) * self.spec.lots
        target, stop, trail = self._levels(trade, lot_unit)
        if self.spec.exits.evaluation.mode == "close":
            return self._manage_close(trade, target, stop, trail)
        return self._manage_intrabar(trade, target, stop, trail)

    # ----- underlying (index) stop: ATR or points, optional trailing / target (swing: every hold day) -----

    def _atr_at(self, ts: pd.Timestamp, tf: str, period: int) -> float | None:
        key = (tf, period)
        cache = self.__dict__.setdefault("_atr_cache", {})
        if key not in cache:
            if tf in DAILY_TFS:
                # Daily candles come from the daily store; m1 only sets their range, so it must span the whole
                # period (bug until engine 6: only the first day, so every trade reused the period-start ATR).
                last = max(d for d in self.trading_days if d <= self._signal_end())
                m1 = pd.concat([self.spot(self.trade_days[0][0]), self.spot(last)], ignore_index=True)
            else:
                warm = math.ceil(5 * period * TF_MINUTES[tf] / 375) + 2
                i0 = max(0, self.trading_days.index(self.trade_days[0][0]) - warm)
                m1 = spot_minute_bars(self.u.stock_code, [d for d in self.trading_days[i0:] if d <= self._signal_end()])
            ev = Evaluator(m1, tf, self.u.stock_code)
            cache[key] = ev.operand(Operand(ind="atr", params={"period": period})).dropna().sort_index()
        s = cache[key]
        s = s[s.index <= ts]
        return float(s.iloc[-1]) if len(s) else None

    def _direction(self, trade: Trade) -> int:
        if trade.direction in ("bullish", "bearish"):
            return 1 if trade.direction == "bullish" else -1
        fut = sum(l.side for l in trade.legs if l.spec.instrument == "FUT")
        return int(np.sign(fut))  # neutral option positions: a band either way

    def _underlying_levels(self, trade: Trade) -> tuple[float, float | None] | None:
        us = self.spec.exits.underlying_stop
        if us is None:
            return None
        if us.points:
            dist = us.points
        else:
            atr = self._atr_at(trade.entry_at, us.tf, us.atr_period)
            if atr is None or not atr > 0:
                trade.notes.append("no ATR at entry: underlying stop off")
                return None
            dist = (us.atr_mult or 2.0) * atr
        return dist, (us.target_mult * dist if us.target_mult else None)

    def _underlying_hit(self, trade: Trade, d: date, start: pd.Timestamp, end: pd.Timestamp, levels, best: float):
        """First index minute on day d (start ≤ minute < end) that breaks the stop / reaches the target →
        ((fill time, reason, gapped), best price since entry)."""
        dist, tgt = levels
        s = self.spot(d)
        s = s[(s["datetime"] >= start) & (s["datetime"] < end)]
        if s.empty:
            return None, best
        sign, entry, trail = self._direction(trade), trade.spot_entry, self.spec.exits.underlying_stop.trail
        op, hi, lo = (s[c].to_numpy(dtype=float) for c in ("open", "high", "low"))
        if sign == 0:
            stop_hit = (hi >= entry + dist) | (lo <= entry - dist)
            gap = (op >= entry + dist) | (op <= entry - dist)
            tgt_hit = np.zeros(len(s), dtype=bool)
            new_best = best
        else:
            fav, adv = (hi, lo) if sign > 0 else (-lo, -hi)  # in the trade's direction: + is favourable
            o, e = sign * op, sign * entry
            best_before = np.maximum.accumulate(np.concatenate([[sign * best], fav]))[:-1]
            stop_lvl = (best_before if trail else e) - dist
            stop_hit, gap = adv <= stop_lvl, o <= stop_lvl
            tgt_hit = fav >= e + tgt if tgt else np.zeros(len(s), dtype=bool)
            gap = gap | (tgt_hit & (o >= e + (tgt or 0)))
            new_best = sign * max(sign * best, float(fav.max()))
        hit = np.flatnonzero(stop_hit | tgt_hit)
        if not len(hit):
            return None, new_best
        i = int(hit[0])
        reason = "underlying_stop" if stop_hit[i] else "underlying_target"
        times = s["datetime"].tolist()
        if gap[i]:
            return (times[i], reason, True), new_best
        nxt = times[i + 1] if i + 1 < len(times) else times[i] + pd.Timedelta(minutes=1)
        return (nxt, reason, False), new_best

    def _exit_triggers(self, trade: Trade) -> list[tuple[pd.Timestamp, str]]:
        """Signal-based exits after entry, as (time, reason). Intraday, the underlying stop / target is one too: the
        first index minute that breaks it, filled at the next minute's open (or at a minute that opens through it)."""
        out = [(t, "signal") for t in self.exit_signals if t > trade.entry_at]
        if trade.direction in ("bullish", "bearish"):
            out += [(t, "signal") for t in getattr(self, "dir_exit_signals", {}).get(trade.direction, []) if t > trade.entry_at]
        if self.spec.exits.exit_on_opposite_signal and trade.direction in ("bullish", "bearish"):
            other = "bearish" if trade.direction == "bullish" else "bullish"
            out += [(t, "opposite_signal") for t in self.opposite[other] if t > trade.entry_at]
        if self.spec.exits.underlying_stop and self.spec.holding.mode != "swing":
            levels = self._underlying_levels(trade)
            if levels:
                d = trade.trade_day
                sq = pd.Timestamp(datetime.combine(d, time.fromisoformat(self.spec.exits.square_off)))
                hit, _ = self._underlying_hit(trade, d, trade.entry_at, sq, levels, trade.spot_entry)
                if hit:
                    out.append((hit[0], hit[1]))
        return sorted(out)

    def _close_all(self, trade: Trade, prices: dict[str, float], when: pd.Timestamp, reason: str, slip: bool = True):
        for leg in trade.legs:
            if leg.open:
                px = max(TICK, prices[leg.spec.id] - (leg.side * self.costs.slip(leg) if slip else 0))
                leg.slip_pts += abs(px - prices[leg.spec.id])
                leg.exit, leg.exit_at, leg.reason = px, when, reason
                trade.exit_cost += self.costs.order(px, leg.qty, leg.side < 0, when.date(), _fut(leg))
        trade.exit_at, trade.reason = when, reason

    def _manage_intrabar(self, trade: Trade, target, stop, trail) -> bool:
        legs, d = trade.legs, trade.trade_day
        square_off = pd.Timestamp(datetime.combine(d, time.fromisoformat(self.spec.exits.square_off)))
        if trade.entry_at >= square_off:
            return False
        frames = []
        for leg in legs:
            b = leg.bars.set_index("datetime")[["open", "high", "low", "close"]]
            frames.append(b.add_prefix(f"{leg.spec.id}_").rename(columns=lambda c: c.replace("open", "o").replace("high", "h").replace("low", "l").replace("close", "c")))
        grid = pd.concat(frames, axis=1).sort_index()
        for leg in legs:  # a minute a leg didn't trade: flat at its last close (no stale highs/lows or opens)
            c = f"{leg.spec.id}_c"
            grid[c] = grid[c].ffill()
            for col in ("o", "h", "l"):
                grid[f"{leg.spec.id}_{col}"] = grid[f"{leg.spec.id}_{col}"].fillna(grid[c])
        grid = grid.dropna()
        grid = grid[(grid.index >= trade.entry_at) & (grid.index.date <= d)]
        if grid.empty or grid.index[-1].date() != d:
            self.skipped.append({"time": str(trade.entry_at), "reason": f"No leg data on {d:%d %b}"})
            return False
        times = list(grid.index)
        end = next((j for j, t in enumerate(times) if t >= square_off), len(times) - 1)
        rows = grid.to_dict("records")
        basis_net = self.spec.exits.pnl_basis == "net"
        triggers = self._exit_triggers(trade)
        spot_lim = self.spec.exits.spot_move_points
        spot_df = self.spot(d).set_index("datetime") if spot_lim else None
        peak, trailing_on = -math.inf, False
        realized = 0.0

        def exit_costs(prices: dict[str, float]) -> float:
            return sum(self.costs.order(prices[l.spec.id], l.qty, l.side < 0, d, _fut(l)) for l in legs if l.open)

        def pnl_at(prices: dict[str, float]) -> float:
            gross = realized + sum(l.pnl(prices[l.spec.id]) for l in legs if l.open)
            if basis_net:
                return gross - trade.entry_cost - trade.exit_cost - exit_costs(prices)
            return gross

        def fill_to(level: float, scen: dict[str, float], start: dict[str, float]) -> dict[str, float]:
            """Exit prices at which the position's P&L reaches `level` on the way from the minute's open to the
            scenario extreme. Every open leg moves the same fraction λ along its own open → extreme path, so each
            exit price stays inside that leg's own candle."""
            open_ids = [l.spec.id for l in legs if l.open]

            def path(lam: float) -> dict[str, float]:
                return {**scen, **{i: start[i] + lam * (scen[i] - start[i]) for i in open_ids}}

            lo, hi = 0.0, 1.0  # P&L hasn't reached the level at the open (λ = 0) and has at the extreme (λ = 1)
            above_at_open = pnl_at(path(0.0)) > level
            for _ in range(40):
                mid = (lo + hi) / 2
                if (pnl_at(path(mid)) > level) == above_at_open:
                    lo = mid
                else:
                    hi = mid
            return path(hi)

        for j in range(end):
            row, t = rows[j], times[j]
            px = {k: {l.spec.id: _scenario_price(l, row, k) for l in legs} for k in ("open", "up", "down")}

            # per-leg exits
            for leg in legs:
                if not leg.open or (leg.stop_px is None and leg.target_px is None):
                    continue
                o, h, lo = row[f"{leg.spec.id}_o"], row[f"{leg.spec.id}_h"], row[f"{leg.spec.id}_l"]
                worst, best = (lo, h) if leg.side > 0 else (h, lo)
                hit = None
                if leg.stop_px is not None and (leg.side * (worst - leg.stop_px) <= 0):
                    gap = leg.side * (o - leg.stop_px) <= 0
                    hit = ("leg_stop", max(TICK, (o if gap else leg.stop_px) - leg.side * self.costs.slip(leg)))
                elif leg.target_px is not None and (leg.side * (best - leg.target_px) >= 0):
                    gap = leg.side * (o - leg.target_px) >= 0
                    hit = ("leg_target", o if gap else leg.target_px)
                if hit:
                    leg.exit, leg.exit_at, leg.reason = hit[1], t, hit[0]
                    if hit[0] == "leg_stop":
                        leg.slip_pts += abs((o if gap else leg.stop_px) - hit[1])
                    realized += leg.pnl(leg.exit)
                    trade.exit_cost += self.costs.order(leg.exit, leg.qty, leg.side < 0, d, _fut(leg))
                    if hit[0] == "leg_stop":
                        on = (self.spec.exits.per_leg.on_stop if self.spec.exits.per_leg else "keep_others")
                        if on == "exit_all":
                            self._close_all(trade, {l.spec.id: row[f"{l.spec.id}_c"] for l in legs}, t, "leg_stop")
                        elif on == "others_to_cost":
                            for other in legs:
                                if other.open:
                                    other.stop_px = other.entry
            if not any(l.open for l in legs):
                trade.exit_at = t
                trade.reason = trade.reason if trade.reason != "time" else next(l.reason for l in legs if l.exit_at == t)
                return True

            p_open, p_up, p_dn = pnl_at(px["open"]), pnl_at(px["up"]), pnl_at(px["down"])
            worst, best = min(p_up, p_dn, p_open), max(p_up, p_dn, p_open)
            worst_scen = px["up"] if p_up <= p_dn else px["down"]
            best_scen = px["up"] if p_up >= p_dn else px["down"]
            trade.mfe, trade.mae = max(trade.mfe, best), min(trade.mae, worst)

            if stop is not None and worst <= -stop:
                level_px = px["open"] if p_open <= -stop else fill_to(-stop, worst_scen, px["open"])
                self._close_all(trade, level_px, t, "stop")
                return True
            if trail and trailing_on and worst <= peak - trail[1]:
                level = peak - trail[1]
                level_px = px["open"] if p_open <= level else fill_to(level, worst_scen, px["open"])
                self._close_all(trade, level_px, t, "trail")
                return True
            if target is not None and best >= target:
                level_px = px["open"] if p_open >= target else fill_to(target, best_scen, px["open"])
                # A combined target can't rest as one limit order: it triggers market orders, which pay slippage.
                self._close_all(trade, level_px, t, "target")
                return True
            if trail:
                peak = max(peak, best)
                trailing_on = trailing_on or peak >= trail[0]

            # signal / spot-move exits: act at the next minute's open
            nxt = times[j + 1] if j + 1 < len(times) else None
            if nxt is not None and nxt < times[end]:
                fired = next((r for tt, r in triggers if t < tt <= nxt), None)
                if fired is None and spot_lim and t in spot_df.index:
                    s = spot_df.loc[t]
                    if abs(s["high"] - trade.spot_entry) >= spot_lim or abs(s["low"] - trade.spot_entry) >= spot_lim:
                        fired = "spot_move"
                if fired:
                    nrow = rows[j + 1]
                    self._close_all(trade, {l.spec.id: nrow[f"{l.spec.id}_o"] for l in legs}, nxt, fired)
                    return True

        row, t = rows[end], times[end]
        self._close_all(trade, {l.spec.id: row[f"{l.spec.id}_o"] for l in legs}, t, "time")
        return True

    def _manage_close(self, trade: Trade, target, stop, trail) -> bool:
        legs, d = trade.legs, trade.trade_day
        every = TF_MINUTES[self.spec.exits.evaluation.every]
        sq = self.spec.exits.square_off
        # Candles of `every` minutes (anchored at 09:15) from the one containing the entry to the day's end.
        open_min = 9 * 60 + 15
        ent = trade.entry_at
        mins = max(0, ent.hour * 60 + ent.minute - open_min) // every * every + open_min
        start = pd.Timestamp(datetime.combine(d, time(mins // 60, mins % 60))) if ent.date() == d else pd.Timestamp(datetime.combine(d, time(9, 15)))
        checks = []
        t = start
        day_end = pd.Timestamp(datetime.combine(d, SESSION_END))
        while t + pd.Timedelta(minutes=every) <= day_end + pd.Timedelta(minutes=every):
            close_at = t + pd.Timedelta(minutes=every)
            if close_at.strftime("%H:%M") > sq or t >= day_end:
                break
            checks.append(close_at)
            t = close_at
        # Only candles where the underlying traded count (matches the spot candle grid).
        spot_times = set(self.spot(d)["datetime"])
        checks = [c for c in checks if any((c - pd.Timedelta(minutes=k)) in spot_times for k in range(1, every + 1))]
        if not checks:
            return False
        basis_net = self.spec.exits.pnl_basis == "net"
        triggers = self._exit_triggers(trade)
        spot_lim = self.spec.exits.spot_move_points
        peak, trailing_on, realized = -math.inf, False, 0.0
        last = None
        for c in checks:
            closes = {l.spec.id: (_last_close_before(l.bars, c) or l.entry) for l in legs}
            exits = {l.spec.id: max(TICK, closes[l.spec.id] - l.side * self.costs.slip(l)) for l in legs}
            # per-leg
            for leg in legs:
                if not leg.open:
                    continue
                x = exits[leg.spec.id]
                hit = None
                if leg.stop_px is not None and leg.side * (closes[leg.spec.id] - leg.stop_px) <= 0:
                    hit = "leg_stop"
                elif leg.target_px is not None and leg.side * (closes[leg.spec.id] - leg.target_px) >= 0:
                    hit = "leg_target"
                if hit:
                    leg.exit, leg.exit_at, leg.reason = x, c, hit
                    leg.slip_pts += abs(x - closes[leg.spec.id])
                    realized += leg.pnl(x)
                    trade.exit_cost += self.costs.order(x, leg.qty, leg.side < 0, d, _fut(leg))
                    on = self.spec.exits.per_leg.on_stop if self.spec.exits.per_leg else "keep_others"
                    if hit == "leg_stop" and on == "exit_all":
                        self._close_all(trade, closes, c, "leg_stop")
                    elif hit == "leg_stop" and on == "others_to_cost":
                        for other in legs:
                            if other.open:
                                other.stop_px = other.entry
            if not any(l.open for l in legs):
                trade.exit_at, trade.reason = c, next(l.reason for l in legs if l.exit_at == c)
                return True
            gross = realized + sum(l.pnl(exits[l.spec.id]) for l in legs if l.open)
            ecost = sum(self.costs.order(exits[l.spec.id], l.qty, l.side < 0, d, _fut(l)) for l in legs if l.open)
            pnl = gross - trade.entry_cost - trade.exit_cost - ecost if basis_net else gross
            trade.mfe, trade.mae = max(trade.mfe, pnl), min(trade.mae, pnl)
            reason = None
            if target is not None and pnl >= target:
                reason = "target"
            elif stop is not None and pnl <= -stop:
                reason = "stop"
            elif trail and trailing_on and pnl <= peak - trail[1]:
                reason = "trail"
            elif any(trade.entry_at < tt <= c for tt, _ in triggers):
                reason = next(r for tt, r in triggers if trade.entry_at < tt <= c)
            elif spot_lim:
                s = self.spot(d)
                window = s[(s["datetime"] >= trade.entry_at) & (s["datetime"] < c)]
                if not window.empty and (window["high"].max() - trade.spot_entry >= spot_lim or trade.spot_entry - window["low"].min() >= spot_lim):
                    reason = "spot_move"
            if trail:
                peak = max(peak, pnl)
                trailing_on = trailing_on or peak >= trail[0]
            last = (c, closes)
            if reason:
                self._close_all(trade, closes, c, reason)
                return True
        c, closes = last
        self._close_all(trade, closes, c, "time")
        return True


# ---------- results ----------

def daily_pnl(trades: list[dict]) -> dict[str, float]:
    """Net P&L per trading day ("YYYY-MM-DD"): multi-day trades by their daily mark-to-market, others on their
    trade day."""
    by_day: dict[str, float] = {}
    for t in trades:
        for d, p in ((m["d"], m["pnl"]) for m in t["daily_mtm"]) if t.get("daily_mtm") else [(t["trade_day"], t["net"])]:
            by_day[d] = by_day.get(d, 0.0) + p
    return dict(sorted(by_day.items()))


def _metrics(trades: list[dict], n_days: int | None = None) -> dict:
    """n_days: trading days in the period; days without a trade count as 0 in Sharpe / Sortino.
    With multi-day trades, drawdown is measured on daily mark-to-market (open losses count)."""
    pnls = [t["net"] for t in trades]
    wins = [p for p in pnls if p > 0]
    losses = [p for p in pnls if p <= 0]
    cum = peak = dd = 0.0
    streak = worst_streak = 0
    for p in pnls:
        cum += p
        peak = max(peak, cum)
        dd = min(dd, cum - peak)
        streak = streak + 1 if p <= 0 else 0
        worst_streak = max(worst_streak, streak)
    by_day = daily_pnl(trades)
    if any(t.get("daily_mtm") for t in trades):
        cum = peak = dd = 0.0
        for p in by_day.values():
            cum += p
            peak = max(peak, cum)
            dd = min(dd, cum - peak)
    daily = list(by_day.values()) + [0.0] * max(0, (n_days or 0) - len(by_day))
    mean = sum(daily) / len(daily) if daily else 0
    sd = (sum((x - mean) ** 2 for x in daily) / (len(daily) - 1)) ** 0.5 if len(daily) > 1 else 0
    down = [x for x in daily if x < 0]
    dsd = (sum(x * x for x in down) / len(daily)) ** 0.5 if down else 0
    reasons: dict[str, int] = {}
    for t in trades:
        reasons[t["reason"]] = reasons.get(t["reason"], 0) + 1
    return {
        "trades": len(trades),
        "days_traded": len({t["trade_day"] for t in trades}),
        "days_in_market": len(by_day),
        "wins": len(wins),
        "win_rate": round(len(wins) / len(trades) * 100, 2) if trades else None,
        "net_pnl": round(sum(pnls), 2),
        "gross_pnl": round(sum(t["gross"] for t in trades), 2),
        "costs": round(sum(t["costs"] for t in trades), 2),
        "avg_trade": round(sum(pnls) / len(pnls), 2) if pnls else None,
        "avg_win": round(sum(wins) / len(wins), 2) if wins else None,
        "avg_loss": round(sum(losses) / len(losses), 2) if losses else None,
        "profit_factor": round(sum(wins) / -sum(losses), 2) if losses and sum(losses) < 0 else None,
        "max_drawdown": round(dd, 2),
        "best": max(pnls) if pnls else None,
        "worst": min(pnls) if pnls else None,
        "longest_losing_streak": worst_streak,
        "sharpe": round(mean / sd * math.sqrt(252), 2) if sd else None,
        "sortino": round(mean / dsd * math.sqrt(252), 2) if dsd else None,
        "avg_capital": round(sum(t["capital"] for t in trades) / len(trades), 2) if trades else None,  # premium
        "avg_margin": round(sum(t["margin"] for t in trades) / len(trades), 2) if trades else None,
        "peak_margin": round(max(t["margin"] for t in trades), 2) if trades else None,
        "return_on_margin_pct": round(sum(pnls) / max(t["margin"] for t in trades) * 100, 2) if trades and max(t["margin"] for t in trades) else None,
        "stale_fill_pct": round(sum(t["stale_fills"] for t in trades) / max(1, sum(len(t["legs"]) for t in trades)) * 100, 2),
        "exit_reasons": reasons,
    }


def _breakdowns(trades: list[dict]) -> dict:
    def group(key):
        out: dict = {}
        for t in trades:
            g = out.setdefault(t[key] if not callable(key) else key(t), [])
            g.append(t)
        return out

    def summary(ts):
        net = [t["net"] for t in ts]
        return {"trades": len(ts), "net_pnl": round(sum(net), 2), "win_rate": round(sum(1 for x in net if x > 0) / len(net) * 100, 1)}

    months: dict[str, list] = {}
    for t in trades:
        months.setdefault(t["trade_day"][:7], []).append(t)
    return {
        "by_dte": {k: summary(v) for k, v in sorted(group("dte").items())},
        "by_weekday": {k: summary(v) for k, v in sorted(group("weekday").items())},
        "by_reason": {k: summary(v) for k, v in group("reason").items()},
        "by_direction": {k or "neutral": summary(v) for k, v in group("direction").items()},
        "monthly": {k: summary(v) for k, v in sorted(months.items())},
    }


def run_strategy(spec: dict, from_date: date, to_date: date, progress: Callable[[int, int, str], None] = lambda *a: None) -> dict:
    s = StrategySpec.model_validate(spec)
    errors, _ = validate_spec(s)
    if errors:
        raise HTTPException(422, " ".join(errors))
    if s.holding.mode == "swing":
        from app.strategy.swing import SwingEngine
        eng = SwingEngine(s, from_date, to_date, progress)
    else:
        eng = Engine(s, from_date, to_date, progress)
    out = eng.run()
    trades = out["trades"]
    cum, equity = 0.0, []
    for t in trades:
        cum += t["net"]
        equity.append({"t": t["exit_at"], "equity": round(cum, 2)})
    return {
        "params": {"spec": s.model_dump(mode="json"), "from_date": from_date.isoformat(), "to_date": to_date.isoformat()},
        "metrics": _metrics(trades, sum(1 for d in eng.trading_days if from_date <= d <= to_date)),
        "breakdowns": _breakdowns(trades),
        "equity": equity,
        "daily": [{"d": d, "pnl": round(p, 2)} for d, p in daily_pnl(trades).items()],
        "trades": trades,
        "skipped": out["skipped"],
        "trade_days": len(eng.trade_days),
        "engine_version": ENGINE_VERSION,
    }
