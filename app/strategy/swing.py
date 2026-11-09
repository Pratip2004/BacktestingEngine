"""Multi-day (swing) engine: positions held across trading days, for specs with holding.mode == "swing".

validate_spec() makes overnight positions defined-risk (short options covered) and gives futures a stop. The
intraday Engine's calendar, signals, strike / expiry selection, fills and dated costs are reused unchanged; only
the entry loop and position management are new, so the verified intraday engine stays as it is.

Entries (one position at a time; schedule.max_trades_per_day caps entries per entry day; weekdays / dte filter
the entry day; risk.max_loss_per_day blocks entries once trades closed that day lost that much):
  time    each eligible day at entry.time / entry.times, with entry.filter and bullish / bearish conditions
  signal  intraday timeframe: at the candle close where the condition is true, filled at the next minute's open
          (window_start … last_entry); 1d / 1w timeframe: known after the close, entered on the next trading
          day at entry.next_day_time
Exits, every day of the hold:
  at each holding.check candle close (fills at that close ∓ slippage): combined target / stop / trailing (per-DTE
  overrides by the entry day's DTE), per-leg target / stop, exit signal, opposite signal, spot move
  underlying stop (exits.underlying_stop) on every index minute: fills at the next minute's open, or at the
  minute's own open when it gaps through the level (e.g. an overnight gap)
  time: holding.exit_time on the last day = the earliest of entry day + max_days − 1, the nearest leg expiry
  − exit_before_expiry trading days, and the backtest's last day (reason "period_end")
exits.evaluation and exits.square_off don't apply. Each trade carries daily_mtm (P&L per trading day held, marked
at each day's last close; entry costs on the entry day, exit costs on the exit day; sums to net), so drawdown and
Sharpe see losses carried overnight.
"""

from __future__ import annotations

import math
from datetime import date, datetime, time

import pandas as pd

from app.strategy.engine import SESSION_END, TICK, Engine, Trade, _first_at, _fut, _last_close_before
from app.strategy.spec import DAILY_TFS, TF_MINUTES

SESSION_OPEN = time(9, 15)


def _at(d: date, hhmm: str | time) -> pd.Timestamp:
    return pd.Timestamp(datetime.combine(d, time.fromisoformat(hhmm) if isinstance(hhmm, str) else hhmm))


class SwingEngine(Engine):
    def _signal_end(self) -> date:
        return max(d for d in self.trading_days if d <= self.end)

    def _next_trading_day(self, d: date) -> date | None:
        i = self.trading_days.index(d)
        return self.trading_days[i + 1] if i + 1 < len(self.trading_days) else None

    # ----- entries -----

    def _entry_events(self) -> list[tuple[pd.Timestamp, date, int, str | None]]:
        """(entry time, entry day, DTE, direction), chronological."""
        e = self.spec.schedule.entry
        dte_of = dict(self.trade_days)
        out = []
        if e.type == "time":
            for d, dte in self.trade_days:
                out += [(ts, d, dte, direction) for ts, direction in self._time_events(d)]
        else:
            daily = self.spec.timeframe in DAILY_TFS
            for t, label in self.all_entry_signals:
                direction = None if label == "signal" else label
                if daily:
                    d = self._next_trading_day(t.date())
                    ts = _at(d, e.next_day_time) if d else None
                else:
                    d, ts = t.date(), t
                    if not e.window_start <= t.strftime("%H:%M") <= e.last_entry:
                        continue
                if d in dte_of:
                    out.append((ts, d, dte_of[d], direction))
        return sorted(out, key=lambda x: x[0])

    def run(self) -> dict:
        self._calendar()
        self._signals()
        sched, risk = self.spec.schedule, self.spec.risk
        events = self._entry_events()
        trades: list[Trade] = []
        free_at: pd.Timestamp | None = None
        taken: dict[date, int] = {}
        closed_pnl: dict[date, float] = {}
        n = len(events)
        for k, (ts, d, dte, direction) in enumerate(events):
            if k % 10 == 0:
                self.progress(k, n, f"{d:%d %b %Y} · {len(trades)} trades")
            if free_at is not None and ts < free_at:
                continue
            if taken.get(d, 0) >= sched.max_trades_per_day:
                continue
            if risk.max_loss_per_day and closed_pnl.get(d, 0.0) <= -risk.max_loss_per_day:
                continue
            trade = self._open(d, dte, ts, direction)
            if trade is None or not self._manage_swing(trade):
                continue
            trades.append(trade)
            taken[d] = taken.get(d, 0) + 1
            closed_pnl[trade.exit_at.date()] = closed_pnl.get(trade.exit_at.date(), 0.0) + trade.net
            free_at = trade.exit_at
        self.progress(n, n, f"Done · {len(trades)} trades")
        return {"trades": [t.to_json() for t in trades], "skipped": self.skipped}

    def _exit_triggers(self, trade: Trade) -> list[tuple[pd.Timestamp, str]]:
        """A signal on a 1d / 1w candle is known at 15:30, after the last price it's computed from: act on it the
        next trading day at entry.next_day_time, like an entry (never at the close that produced it)."""
        out = super()._exit_triggers(trade)
        if self.spec.timeframe not in DAILY_TFS:
            return out
        at = self.spec.schedule.entry.next_day_time
        moved = [(_at(nxt, at), r) for t, r in out if (nxt := self._next_trading_day(t.date()))]
        return sorted((t, r) for t, r in moved if t > trade.entry_at)

    # ----- hold window -----

    def _last_day(self, trade: Trade) -> tuple[date | None, str]:
        """Last day the position may be held, and the exit reason if it's still open then."""
        h, td = self.spec.holding, self.trading_days
        i0 = td.index(trade.entry_at.date())
        last, reason = td[min(i0 + h.max_days - 1, len(td) - 1)], "time"
        expiry = min(l.expiry for l in trade.legs)
        j = next((i for i, d in enumerate(td) if d >= expiry), len(td) - 1)  # expiry snapped to a trading day
        by_expiry = td[j - h.exit_before_expiry] if j - h.exit_before_expiry >= 0 else None
        if by_expiry is None or by_expiry < trade.entry_at.date():
            return None, "expiry"
        if by_expiry < last:
            last, reason = by_expiry, "expiry"
        end = self._signal_end()
        if end < last:
            last, reason = end, "period_end"
        return last, reason

    def _load(self, trade: Trade, hold: list[date], d: date, loaded: set[date]) -> None:
        """Leg candles for day d (and the next hold day, one Breeze call covers two), fetched as the hold goes on,
        so a trade that exits on day 2 of 20 doesn't download 20 days."""
        if d in loaded:
            return
        i = hold.index(d)
        chunk = [x for x in hold[i:i + 2] if x not in loaded]
        for leg in trade.legs:
            more = self._bars(leg.spec, leg.expiry, leg.strike, chunk)
            leg.bars = (pd.concat([leg.bars, more]).drop_duplicates("datetime").sort_values("datetime").reset_index(drop=True)
                        if len(more) else leg.bars)
        loaded.update(chunk)

    def _checks(self, d: date, start: pd.Timestamp, end: pd.Timestamp) -> list[pd.Timestamp]:
        """Closes of holding.check candles (anchored at 09:15) after `start` and by `end`, where the index traded;
        plus `end` itself on the last day (exit_time)."""
        every = TF_MINUTES[self.spec.holding.check]
        if every >= 375:
            out = [_at(d, SESSION_END)]
        else:
            out, t = [], _at(d, SESSION_OPEN)
            while t + pd.Timedelta(minutes=every) <= _at(d, SESSION_END):
                t += pd.Timedelta(minutes=every)
                out.append(t)
        spot_times = set(self.spot(d)["datetime"])
        step = min(every, 375)
        out = [c for c in out if start < c <= end and any((c - pd.Timedelta(minutes=k)) in spot_times for k in range(1, step + 1))]
        if not out or out[-1] < end:
            out.append(end)
        return out

    # ----- underlying stop -----

    # ----- manage -----

    def _manage_swing(self, trade: Trade) -> bool:
        x, h = self.spec.exits, self.spec.holding
        entry_day = trade.entry_at.date()
        last, end_reason = self._last_day(trade)
        if last is None:
            self.skipped.append({"time": str(trade.entry_at), "reason": f"Expiry too close to hold ({entry_day:%d %b})"})
            return False
        if last == entry_day and trade.entry_at >= _at(last, h.exit_time):
            self.skipped.append({"time": str(trade.entry_at), "reason": "Entry at or after the holding exit time"})
            return False
        lot_unit = (self.spec.lot_size or self.u.lot_size(trade.trade_day)) * self.spec.lots
        target, stop, trail = self._levels(trade, lot_unit)
        legs = trade.legs
        hold = [d for d in self.trading_days if entry_day <= d <= last]
        loaded = {entry_day}
        basis_net = x.pnl_basis == "net"
        triggers = self._exit_triggers(trade)
        us_levels = self._underlying_levels(trade)
        best_spot = trade.spot_entry
        peak, trailing_on, realized = -math.inf, False, 0.0
        marks: list[tuple[date, float]] = []  # cumulative net P&L at each day's close
        on_stop = x.per_leg.on_stop if x.per_leg else "keep_others"

        def finish(when: pd.Timestamp, prices: dict[str, float], reason: str) -> bool:
            self._close_all(trade, prices, when, reason)
            self._daily_mtm(trade, marks)
            return True

        for d in hold:
            self._load(trade, hold, d, loaded)
            day_start = trade.entry_at if d == entry_day else _at(d, SESSION_OPEN)
            day_end = _at(d, h.exit_time) if d == last else _at(d, SESSION_END)
            us_hit = None
            if us_levels:
                us_hit, best_spot = self._underlying_hit(trade, d, day_start, day_end, us_levels, best_spot)
            # Signal exits are also checked at the moment they act (a daily signal at next_day_time), not only at
            # holding.check closes, so check "1d" doesn't delay a morning exit to that day's close.
            checks = sorted(set(self._checks(d, day_start, day_end)) | {tt for tt, _ in triggers if day_start < tt <= day_end})
            for c in checks:
                if us_hit and us_hit[0] < c:
                    break
                closes = {l.spec.id: (_last_close_before(l.bars, c) or l.entry) for l in legs}
                exits = {l.spec.id: max(TICK, closes[l.spec.id] - l.side * self.costs.slip(l)) for l in legs}
                for leg in legs:  # per-leg levels
                    if not leg.open:
                        continue
                    hit = None
                    if leg.stop_px is not None and leg.side * (closes[leg.spec.id] - leg.stop_px) <= 0:
                        hit = "leg_stop"
                    elif leg.target_px is not None and leg.side * (closes[leg.spec.id] - leg.target_px) >= 0:
                        hit = "leg_target"
                    if hit:
                        px = exits[leg.spec.id]
                        leg.exit, leg.exit_at, leg.reason = px, c, hit
                        leg.slip_pts += abs(px - closes[leg.spec.id])
                        realized += leg.pnl(px)
                        trade.exit_cost += self.costs.order(px, leg.qty, leg.side < 0, d, _fut(leg))
                        if hit == "leg_stop" and on_stop == "exit_all":
                            return finish(c, closes, "leg_stop")
                        if hit == "leg_stop" and on_stop == "others_to_cost":
                            for other in legs:
                                if other.open:
                                    other.stop_px = other.entry
                if not any(l.open for l in legs):
                    trade.exit_at, trade.reason = c, next(l.reason for l in legs if l.exit_at == c)
                    self._daily_mtm(trade, marks)
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
                elif x.spot_move_points:
                    s = self.spot(d)
                    w = s[(s["datetime"] >= day_start) & (s["datetime"] < c)]
                    if not w.empty and max(w["high"].max() - trade.spot_entry, trade.spot_entry - w["low"].min()) >= x.spot_move_points:
                        reason = "spot_move"
                if trail:
                    peak = max(peak, pnl)
                    trailing_on = trailing_on or peak >= trail[0]
                if reason:
                    return finish(c, closes, reason)
                if d == last and c >= day_end:
                    return finish(c, closes, end_reason)
            if us_hit:
                when, reason, gapped = us_hit
                prices = {}
                for l in legs:
                    at = _first_at(l.bars, when)
                    prices[l.spec.id] = at[1] if at else (_last_close_before(l.bars, when) or l.entry)
                return finish(when, prices, reason)
            # still open at the day's close: mark to market
            eod = _at(d, SESSION_END)
            closes = {l.spec.id: (_last_close_before(l.bars, eod) or l.entry) for l in legs}
            marks.append((d, realized + sum(l.pnl(closes[l.spec.id]) for l in legs if l.open) - trade.entry_cost - trade.exit_cost))
        # Every hold day processed without an exit (shouldn't happen: the last day ends with a check at exit_time).
        eod = _at(hold[-1], h.exit_time)
        return finish(eod, {l.spec.id: (_last_close_before(l.bars, eod) or l.entry) for l in legs}, end_reason)

    def _daily_mtm(self, trade: Trade, marks: list[tuple[date, float]]) -> None:
        """Per-day P&L from the end-of-day marks; the exit day takes the rest, so the days sum to net."""
        out, prev = [], 0.0
        for d, cum in marks:
            out.append({"d": d.isoformat(), "pnl": round(cum - prev, 2)})
            prev = cum
        out.append({"d": trade.exit_at.date().isoformat(), "pnl": round(trade.net - prev, 2)})
        trade.daily_mtm = out
