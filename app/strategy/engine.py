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

import pandas as pd
from fastapi import HTTPException

from app.backtest.straddle_engine import _trading_days_to
from app.breeze_client import breeze
from app.data.access import future_minute_bars, option_minute_bars, spot_minute_bars
from app.data.ingest import _monthly
from app.data.instruments import underlying as get_underlying
from app.data.store import get_store
from app.options.expiries import weekly_expiries_between
from app.options.greeks import bs_delta, implied_vol
from app.strategy.signals import lookback_minutes, signal_times
from app.strategy.spec import TF_MINUTES, CombinedExits, Leg, Level, StrategySpec, legs_for, validate_spec

RISK_FREE = 0.065
MAX_STRIKE_SEARCH = 40  # strikes scanned outward from ATM for premium / delta selection
SESSION_END = time(15, 30)


# ---------- costs (rates by date) ----------

class DatedCosts:
    """Order costs with the statutory rates that applied on each date (store.cost_schedule)."""

    def __init__(self, brokerage: float, slippage: float, taxes: bool):
        self.brokerage, self.slippage, self.taxes = brokerage, slippage, taxes
        rows = get_store().q("SELECT effective_from, stt_sell_pct, exchange_pct, sebi_pct, stamp_buy_pct, gst_pct FROM cost_schedule ORDER BY effective_from DESC")
        self._rates = rows

    def _rate(self, d: date):
        return next(r for r in self._rates if d >= r[0])

    def order(self, price: float, qty: float, is_buy: bool, d: date) -> float:
        if not self.taxes:
            return self.brokerage
        _, stt, exch, sebi, stamp, gst = self._rate(d)
        turnover = price * qty
        exchange, sebi_fee = exch / 100 * turnover, sebi / 100 * turnover
        return (self.brokerage + (0 if is_buy else stt / 100 * turnover) + exchange + sebi_fee
                + (stamp / 100 * turnover if is_buy else 0) + gst / 100 * (self.brokerage + exchange + sebi_fee))


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
            "pct": round(self.net / self.capital * 100, 2) if self.capital else None,
            "reason": self.reason,
            "mfe": round(self.mfe, 2) if math.isfinite(self.mfe) else None,
            "mae": round(self.mae, 2) if math.isfinite(self.mae) else None,
            "stale_fills": self.stale_fills,
            "legs": [
                {
                    "id": l.spec.id, "action": l.spec.action, "instrument": l.spec.instrument, "strike": l.strike,
                    "expiry": l.expiry.isoformat(), "label": l.label(), "qty": l.qty, "entry": round(l.entry, 2),
                    "exit": round(l.exit, 2) if l.exit is not None else None,
                    "exit_at": l.exit_at.strftime("%Y-%m-%d %H:%M") if l.exit_at is not None else None,
                    "reason": l.reason, "pnl": round(l.pnl(l.exit), 2) if l.exit is not None else None,
                }
                for l in self.legs
            ],
        }


# ---------- helpers ----------

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
        self.costs = DatedCosts(spec.costs.brokerage_per_order, spec.costs.slippage_points, spec.costs.taxes)
        self.skipped: list[dict] = []
        self._spot: dict[date, pd.DataFrame] = {}

    # ----- calendar -----

    def _calendar(self):
        daily = breeze.historical_df(self.u.stock_code, self.u.spot_exchange, "1day",
                                     datetime.combine(self.start - timedelta(days=40), time(0)),
                                     datetime.combine(self.end, time(23, 59)))
        if daily.empty:
            raise HTTPException(404, f"No daily candles for {self.u.name} in this range")
        self.trading_days = sorted(daily["datetime"].dt.date.unique())
        self.weekly = weekly_expiries_between(self.start - timedelta(days=7), self.end + timedelta(days=100), self.trading_days, self.u.stock_code)
        self.monthly = _monthly(self.weekly)
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

    def _prev_trading_day(self, d: date) -> date | None:
        i = self.trading_days.index(d)
        return self.trading_days[i - 1] if i > 0 else None

    # ----- signals -----

    def _signals(self):
        e, x = self.spec.schedule.entry, self.spec.exits
        conds = {"signal": e.signal, "bullish": e.bullish, "bearish": e.bearish} if e.type == "signal" else {}
        need = any(conds.values()) or x.exit_signal is not None
        self.entry_signals: dict[date, list[tuple[pd.Timestamp, str]]] = {}
        self.exit_signals: list[pd.Timestamp] = []
        self.opposite: dict[str, list[pd.Timestamp]] = {"bullish": [], "bearish": []}
        if not need or not self.trade_days:
            return
        tf = self.spec.timeframe
        lb = max(lookback_minutes(c, tf) for c in [*conds.values(), x.exit_signal])
        warm_days = max(5, math.ceil(lb / 375) + 2)
        first, last = self.trade_days[0][0], self.trade_days[-1][0]
        i0 = max(0, self.trading_days.index(first) - warm_days)
        days = [d for d in self.trading_days[i0:] if d <= last]
        m1 = spot_minute_bars(self.u.stock_code, days)
        if m1.empty:
            raise HTTPException(404, f"No 1-minute {self.u.name} candles for the signal calculation")
        trade_set = {d for d, _ in self.trade_days}
        for t, label in signal_times(m1, tf, conds, trade_set):
            self.entry_signals.setdefault(t.date(), []).append((t, label))
            if label in self.opposite:
                self.opposite[label].append(t)
        if x.exit_signal is not None:
            self.exit_signals = [t for t, _ in signal_times(m1, tf, {"exit": x.exit_signal}, set(days))]

    # ----- data -----

    def spot(self, d: date) -> pd.DataFrame:
        if d not in self._spot:
            self._spot[d] = spot_minute_bars(self.u.stock_code, [d])
        return self._spot[d]

    def _expiry(self, leg: Leg, trade_day: date) -> date | None:
        sel = leg.expiry
        pool = self.monthly if (sel.by == "monthly" or leg.instrument == "FUT") else self.weekly
        cands = [e for e in pool if (e > trade_day if sel.skip_expiry_day else e >= trade_day)]
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
            leg.entry = fill[1] + side * self.costs.slippage
            leg.entry_at = fill[0]
            legs.append(leg)
        premium = sum(l.side * l.qty * l.entry for l in legs)
        entry_cost = sum(self.costs.order(l.entry, l.qty, l.side > 0, entry_day) for l in legs)
        trade = Trade(trade_day, direction, dte, max(l.entry_at for l in legs), spot, atm, legs, premium, entry_cost)
        trade.stale_fills = sum(1 for l in legs if l.entry_at > ts)
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
                events = [(pd.Timestamp(datetime.combine(entry_day, time.fromisoformat(e.time))), None)]
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
                free_at = trade.exit_at
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

    def _exit_triggers(self, trade: Trade) -> list[tuple[pd.Timestamp, str]]:
        """Signal-based exits after entry, as (time, reason)."""
        out = [(t, "signal") for t in self.exit_signals if t > trade.entry_at]
        if self.spec.exits.exit_on_opposite_signal and trade.direction in ("bullish", "bearish"):
            other = "bearish" if trade.direction == "bullish" else "bullish"
            out += [(t, "opposite_signal") for t in self.opposite[other] if t > trade.entry_at]
        return sorted(out)

    def _close_all(self, trade: Trade, prices: dict[str, float], when: pd.Timestamp, reason: str, slip: bool = True):
        for leg in trade.legs:
            if leg.open:
                px = prices[leg.spec.id] - (leg.side * self.costs.slippage if slip else 0)
                leg.exit, leg.exit_at, leg.reason = px, when, reason
                trade.exit_cost += self.costs.order(px, leg.qty, leg.side < 0, when.date())
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
        grid = pd.concat(frames, axis=1).sort_index().ffill().dropna()
        grid = grid[(grid.index >= trade.entry_at) & (grid.index.date <= d)]
        if grid.empty or grid.index[-1].date() != d:
            self.skipped.append({"time": str(trade.entry_at), "reason": f"No leg data on {d:%d %b}"})
            return False
        times = list(grid.index)
        end = next((j for j, t in enumerate(times) if t >= square_off), len(times) - 1)
        rows = grid.to_dict("records")
        basis_net = self.spec.exits.pnl_basis == "net"
        slip = self.costs.slippage
        triggers = self._exit_triggers(trade)
        spot_lim = self.spec.exits.spot_move_points
        spot_df = self.spot(d).set_index("datetime") if spot_lim else None
        peak, trailing_on = -math.inf, False
        realized = 0.0

        def exit_costs(prices: dict[str, float]) -> float:
            return sum(self.costs.order(prices[l.spec.id], l.qty, l.side < 0, d) for l in legs if l.open)

        def pnl_at(prices: dict[str, float]) -> float:
            gross = realized + sum(l.pnl(prices[l.spec.id]) for l in legs if l.open)
            if basis_net:
                return gross - trade.entry_cost - trade.exit_cost - exit_costs(prices)
            return gross

        def fill_to(level: float, scen: dict[str, float]) -> dict[str, float]:
            """Exit prices for open legs whose combined gross P&L equals `level` (same-side positions are
            scaled exactly; mixed positions keep the scenario prices, shifted on the first open leg)."""
            open_legs = [l for l in legs if l.open]
            target_gross = level if not basis_net else level + trade.entry_cost + trade.exit_cost + exit_costs(scen)
            need = target_gross - realized  # P&L the open legs must contribute
            if len({l.side for l in open_legs}) == 1:
                s = open_legs[0].side
                entry_val = sum(l.qty * l.entry for l in open_legs)
                scen_val = sum(l.qty * scen[l.spec.id] for l in open_legs)
                want_val = entry_val + s * need
                k = want_val / scen_val if scen_val else 1.0
                return {**scen, **{l.spec.id: scen[l.spec.id] * k for l in open_legs}}
            out = dict(scen)
            first = open_legs[0]
            others = sum(l.pnl(scen[l.spec.id]) for l in open_legs[1:])
            out[first.spec.id] = first.entry + (need - others) / (first.side * first.qty)
            return out

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
                    hit = ("leg_stop", (o if gap else leg.stop_px) - leg.side * slip)
                elif leg.target_px is not None and (leg.side * (best - leg.target_px) >= 0):
                    gap = leg.side * (o - leg.target_px) >= 0
                    hit = ("leg_target", o if gap else leg.target_px)
                if hit:
                    leg.exit, leg.exit_at, leg.reason = hit[1], t, hit[0]
                    realized += leg.pnl(leg.exit)
                    trade.exit_cost += self.costs.order(leg.exit, leg.qty, leg.side < 0, d)
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
                level_px = px["open"] if p_open <= -stop else fill_to(-stop, worst_scen)
                self._close_all(trade, level_px, t, "stop")
                return True
            if trail and trailing_on and worst <= peak - trail[1]:
                level = peak - trail[1]
                level_px = px["open"] if p_open <= level else fill_to(level, worst_scen)
                self._close_all(trade, level_px, t, "trail")
                return True
            if target is not None and best >= target:
                level_px = px["open"] if p_open >= target else fill_to(target, best_scen)
                self._close_all(trade, level_px, t, "target", slip=False)
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
            exits = {l.spec.id: closes[l.spec.id] - l.side * self.costs.slippage for l in legs}
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
                    realized += leg.pnl(x)
                    trade.exit_cost += self.costs.order(x, leg.qty, leg.side < 0, d)
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
            ecost = sum(self.costs.order(exits[l.spec.id], l.qty, l.side < 0, d) for l in legs if l.open)
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

def _metrics(trades: list[dict]) -> dict:
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
    by_day: dict[str, float] = {}
    for t in trades:
        by_day[t["trade_day"]] = by_day.get(t["trade_day"], 0) + t["net"]
    daily = list(by_day.values())
    mean = sum(daily) / len(daily) if daily else 0
    sd = (sum((x - mean) ** 2 for x in daily) / (len(daily) - 1)) ** 0.5 if len(daily) > 1 else 0
    down = [x for x in daily if x < 0]
    dsd = (sum(x * x for x in down) / len(daily)) ** 0.5 if down else 0
    reasons: dict[str, int] = {}
    for t in trades:
        reasons[t["reason"]] = reasons.get(t["reason"], 0) + 1
    return {
        "trades": len(trades),
        "days_traded": len(by_day),
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
        "avg_capital": round(sum(t["capital"] for t in trades) / len(trades), 2) if trades else None,
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
    eng = Engine(s, from_date, to_date, progress)
    out = eng.run()
    trades = out["trades"]
    cum, equity = 0.0, []
    for t in trades:
        cum += t["net"]
        equity.append({"t": t["exit_at"], "equity": round(cum, 2)})
    return {
        "params": {"spec": s.model_dump(mode="json"), "from_date": from_date.isoformat(), "to_date": to_date.isoformat()},
        "metrics": _metrics(trades),
        "breakdowns": _breakdowns(trades),
        "equity": equity,
        "trades": trades,
        "skipped": out["skipped"],
        "trade_days": len(eng.trade_days),
    }
