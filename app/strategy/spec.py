"""StrategySpec v1: the one definition every strategy is expressed in.

The visual builder produces it, the generic engine (app/strategy/engine.py) runs it, saved strategies and
runs store it. Pydantic validates structure; validate_spec() adds the semantic checks.

Shape (see docs/STRATEGY_BUILDER_PLAN.md §2):
  underlying, timeframe
  schedule:  which trade days (weekdays, DTE), entry (fixed time / previous-day time / signal), re-entry
  legs:      what to trade (buy/sell CE/PE/FUT, strike & expiry selectors, lots); directional strategies
             give separate bullish / bearish legs (bearish may mirror the bullish ones)
  exits:     how exits are checked (every minute with highs/lows, or at candle closes), on what P&L
             (gross or net of costs), combined / per-leg target & stop, trailing, per-DTE overrides,
             spot-move, signal and time exits
  risk, costs
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, Field, field_validator, model_validator

HHMM = Annotated[str, Field(pattern=r"^([01]\d|2[0-3]):[0-5]\d$")]
Timeframe = Literal["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d", "1w"]
# Session minutes per candle (a day is 375 minutes of trading). 1d / 1w candles come from the daily store.
TF_MINUTES: dict[str, int] = {"1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60, "1d": 375, "1w": 1875}
DAILY_TFS = ("1d", "1w")


# ---------- Conditions (no-code indicator logic) ----------

BUILTIN_INDICATORS = (
    "price", "ema", "sma", "rsi", "vwap", "macd", "supertrend", "bbands", "atr",
    "orb", "prev_day", "day_open", "gap_pct", "value",
    "chg_pct", "adx", "bb_width", "rv", "hv", "prev_range_pct",
    "weekday", "dte", "regime",
)


def known_indicators() -> set[str]:
    from app.strategy.indicators import REGISTRY  # extended library (TradingView-style), registered by name
    return set(BUILTIN_INDICATORS) | set(REGISTRY)


class Operand(BaseModel):
    """One side of a comparison: an indicator on a timeframe, or a plain number (ind='value').
    params.symbol (1d / 1w only): compute on another series, e.g. "VIX". The value is then
    value(shift bars ago) × mul + add, so "close > 1.01 × EMA" or "EMA now > EMA 5 bars ago" can be written."""
    ind: str
    params: dict[str, float | int | str] = Field(default_factory=dict)
    field: str | None = None  # e.g. macd: line/signal/hist; bbands: upper/mid/lower; price: open/high/low/close
    tf: Timeframe | None = None  # defaults to the strategy timeframe
    shift: int = Field(0, ge=0, le=500)  # value this many candles ago
    mul: float = 1.0
    add: float = 0.0

    @field_validator("ind")
    @classmethod
    def _known(cls, v: str):
        if v not in known_indicators():
            raise ValueError(f"unknown indicator {v!r}")
        return v

    @model_validator(mode="after")
    def _field(self):
        from app.strategy.indicators import REGISTRY
        ind = REGISTRY.get(self.ind)
        if ind is not None and self.field and ind.fields and self.field not in ind.fields:
            raise ValueError(f"{self.ind} has no field {self.field!r} (use one of {', '.join(ind.fields)})")
        return self


class Rule(BaseModel):
    left: Operand
    op: Literal[">", "<", ">=", "<=", "==", "!=", "crosses_above", "crosses_below"]
    right: Operand


class Group(BaseModel):
    """all: every condition holds · any: at least one holds; with `min`, at least `min` of the `any` conditions
    hold (a vote, e.g. 3 of 5 indicators bullish)."""
    all: list[Union["Group", Rule]] | None = None
    any: list[Union["Group", Rule]] | None = None
    min: int | None = Field(None, ge=1)

    @model_validator(mode="after")
    def _one_kind(self):
        if (self.all is None) == (self.any is None):
            raise ValueError("a condition group needs exactly one of 'all' or 'any'")
        if not (self.all or self.any):
            raise ValueError("a condition group can't be empty")
        if self.min is not None and (self.any is None or self.min > len(self.any)):
            raise ValueError("'min' (at least N of) goes with 'any' and can't exceed its number of conditions")
        return self


Condition = Union[Group, Rule]


# ---------- Schedule ----------

class Entry(BaseModel):
    """Time entries may also be directional: give bullish / bearish conditions (evaluated on the latest closed
    candle at the entry time) and the matching legs are opened. In swing mode a signal on a 1d / 1w candle
    (known at 15:30) is entered on the next trading day at `next_day_time`."""
    type: Literal["time", "signal"] = "time"
    time: HHMM = "09:20"  # time entries
    # Time entries: several entry times a day (overrides `time`). Each is tried in order, one position at a time,
    # up to schedule.max_trades_per_day; a time while a position is still open is skipped.
    times: list[HHMM] | None = Field(None, max_length=20)
    prev_day: bool = False  # time entries: enter on the previous trading day at `time`, hold overnight
    # Signal entries: conditions on the strategy timeframe; evaluated at each candle close, entered at the
    # next minute's open. A direction-neutral strategy uses `signal`; a directional one bullish/bearish.
    signal: Condition | None = None
    bullish: Condition | None = None
    bearish: Condition | None = None
    # Time entries: trade only when this condition holds on the latest closed candle at the entry time
    # (e.g. skip high-volatility days). Lets a fixed-time or overnight entry be selective.
    filter: Condition | None = None
    window_start: HHMM = "09:15"
    last_entry: HHMM = "15:00"  # no new entries after this time
    next_day_time: HHMM = "09:20"  # swing: entry time for signals known after the close


class Schedule(BaseModel):
    weekdays: list[int] | None = None  # 0 = Mon … 4 = Fri; None = every day
    dte: list[int] | None = None  # trading days to the nearest weekly expiry on the trade day; None = all
    entry: Entry = Field(default_factory=Entry)
    max_trades_per_day: int = Field(1, ge=1, le=50)
    reentry_after_stop: int = Field(0, ge=0, le=10)  # time entries: re-enter this many times after a stop


# ---------- Legs ----------

class StrikeSel(BaseModel):
    """atm_offset: ATM ± steps · points: ATM ± points (rounded to the strike step) · pct_otm: % away from
    spot, OTM for the leg's type · premium: strike whose price is closest to `value` · delta: strike whose
    |delta| is closest to `value` (0–1)."""
    by: Literal["atm_offset", "points", "pct_otm", "premium", "delta"] = "atm_offset"
    value: float = 0


class ExpirySel(BaseModel):
    """weekly n = nth weekly expiry on/after the trade day (0 = nearest); monthly n likewise.
    skip_expiry_day: on an expiry day use the next expiry instead (never trade the expiring contract).
    min_days: only expiries at least this many trading days after the entry day count (swing trades pick a
    contract that outlives the holding period, so nothing has to be rolled)."""
    by: Literal["weekly", "monthly"] = "weekly"
    n: int = Field(0, ge=0, le=3)
    skip_expiry_day: bool = False
    min_days: int = Field(0, ge=0, le=40)


class Level(BaseModel):
    """A P&L threshold. pct = % of the premium (whole position: net premium; one leg: its own premium);
    rupees = ₹ on the position; points = premium points (× quantity)."""
    unit: Literal["pct", "rupees", "points"] = "pct"
    value: float = Field(gt=0)


class LegExits(BaseModel):
    target: Level | None = None
    stop: Level | None = None


class Leg(BaseModel):
    id: str = Field(min_length=1, max_length=20)
    action: Literal["buy", "sell"]
    instrument: Literal["CE", "PE", "FUT"]
    strike: StrikeSel = Field(default_factory=StrikeSel)
    expiry: ExpirySel = Field(default_factory=ExpirySel)
    lots: int = Field(1, ge=1, le=100)  # multiplier on the strategy's base lots
    exits: LegExits | None = None  # overrides exits.per_leg for this leg


class Position(BaseModel):
    """Neutral strategies use `legs`. Directional (signal) strategies use bullish / bearish legs;
    bearish_mirror builds the bearish legs from the bullish ones (CE↔PE, offsets negated)."""
    legs: list[Leg] | None = None
    bullish: list[Leg] | None = None
    bearish: list[Leg] | None = None
    bearish_mirror: bool = False


# ---------- Exits ----------

class Trailing(BaseModel):
    activate: Level  # start trailing once P&L reaches this
    trail: Level  # then exit if P&L falls this far below its peak


class CombinedExits(BaseModel):
    target: Level | None = None
    stop: Level | None = None
    trailing: Trailing | None = None


class PerLegExits(BaseModel):
    target: Level | None = None
    stop: Level | None = None
    on_stop: Literal["keep_others", "exit_all", "others_to_cost"] = "keep_others"


class Evaluation(BaseModel):
    """intrabar: every minute using each candle's high/low (targets fill as limit orders at the level,
    stops as stop-market orders with slippage). close: at each `every` candle close, exits fill at that close."""
    mode: Literal["intrabar", "close"] = "intrabar"
    every: Timeframe = "5m"


class UnderlyingStop(BaseModel):
    """Stop on the underlying's move against the position's direction (directional trades; neutral ones: either
    way), sized in ATR of `tf` at entry (or fixed points), optionally trailing the best price since entry.
    Checked every minute on the index (intraday and multi-day); exits fill at the next minute's open, or at a
    minute that opens through the level."""
    atr_mult: float | None = Field(2.0, gt=0)
    atr_period: int = Field(14, ge=2, le=100)
    tf: Timeframe = "1d"
    points: float | None = Field(None, gt=0)  # fixed distance instead of ATR
    trail: bool = False
    target_mult: float | None = Field(None, gt=0)  # optional take-profit at this many ATRs (or × points)


class Exits(BaseModel):
    evaluation: Evaluation = Field(default_factory=Evaluation)
    pnl_basis: Literal["gross", "net"] = "gross"  # levels on P&L before costs, or after all costs
    combined: CombinedExits = Field(default_factory=CombinedExits)
    per_leg: PerLegExits | None = None
    dte_overrides: dict[int, CombinedExits] = Field(default_factory=dict)  # combined levels per DTE
    square_off: HHMM = "15:15"
    spot_move_points: float | None = Field(None, gt=0)  # exit if spot moves this far from entry
    exit_signal: Condition | None = None  # exit when this becomes true
    # Directional strategies: separate exit conditions for bullish (long) and bearish (short) trades, e.g. a vote
    # with hysteresis (enter at 4 of 5 bullish, exit long when fewer than 3 are)
    exit_bullish: Condition | None = None
    exit_bearish: Condition | None = None
    exit_on_opposite_signal: bool = False  # directional: exit when the opposite entry signal fires
    underlying_stop: UnderlyingStop | None = None


# ---------- Risk & costs ----------

class Risk(BaseModel):
    max_loss_per_day: float | None = Field(None, gt=0)  # ₹; no new entries after realised loss reaches it


class Costs(BaseModel):
    brokerage_per_order: float = Field(20.0, ge=0)
    slippage_points: float = Field(0.5, ge=0)  # options, per fill
    fut_slippage_points: float = Field(1.0, ge=0)  # futures, per fill
    taxes: bool = True


class Holding(BaseModel):
    """intraday: every position is closed by exits.square_off on its trade day (the original engine).
    swing: positions are held across days, up to max_days trading days, and closed at exit_time on the last
    day, or earlier by any exit rule. Option legs are closed exit_before_expiry trading days before their expiry
    (0 = may be held into the expiry day until exit_time). Exits are checked at each `check` candle close;
    the underlying stop is checked every minute."""
    mode: Literal["intraday", "swing"] = "intraday"
    max_days: int = Field(5, ge=1, le=30)
    exit_time: HHMM = "15:20"
    exit_before_expiry: int = Field(0, ge=0, le=10)
    check: Timeframe = "15m"


# ---------- Spec ----------

class StrategySpec(BaseModel):
    spec_version: Literal[1] = 1
    name: str = Field("Untitled strategy", min_length=1, max_length=120)
    description: str = ""
    underlying: Literal["NIFTY", "SENSEX"] = "NIFTY"
    timeframe: Timeframe = "5m"  # candles signals are evaluated on
    lots: int = Field(1, ge=1, le=100)  # base lots; each leg multiplies it
    lot_size: int | None = Field(None, ge=1)  # None = the exchange lot size on each trade date
    schedule: Schedule = Field(default_factory=Schedule)
    position: Position
    exits: Exits = Field(default_factory=Exits)
    risk: Risk = Field(default_factory=Risk)
    costs: Costs = Field(default_factory=Costs)
    holding: Holding = Field(default_factory=Holding)

    @field_validator("schedule")
    @classmethod
    def _weekdays(cls, s: Schedule):
        if s.weekdays is not None and (not s.weekdays or any(w not in range(5) for w in s.weekdays)):
            raise ValueError("weekdays must be a non-empty list of 0 (Mon) … 4 (Fri)")
        return s


Group.model_rebuild()


def mirror_leg(leg: Leg) -> Leg:
    """Bullish leg → bearish leg: CE↔PE, strike offsets flipped (FUT: buy↔sell)."""
    if leg.instrument == "FUT":
        return leg.model_copy(update={"action": "sell" if leg.action == "buy" else "buy"})
    strike = leg.strike
    if strike.by in ("atm_offset", "points"):
        strike = strike.model_copy(update={"value": -strike.value})
    return leg.model_copy(update={"instrument": "PE" if leg.instrument == "CE" else "CE", "strike": strike})


def entry_times(e: Entry) -> list[str]:
    """Time entries' "HH:MM" times for a day, sorted."""
    return sorted(e.times) if e.times else [e.time]


def legs_for(spec: StrategySpec, direction: str | None) -> list[Leg]:
    p = spec.position
    if direction == "bearish":
        if p.bearish_mirror:
            return [mirror_leg(l) for l in (p.bullish or [])]
        return p.bearish or []
    if direction == "bullish":
        return p.bullish or []
    return p.legs or []


def validate_spec(spec: StrategySpec) -> tuple[list[str], list[str]]:
    """Semantic checks on a structurally valid spec → (errors, warnings)."""
    errors, warnings = [], []
    e, p, x = spec.schedule.entry, spec.position, spec.exits
    directional = e.bullish is not None or e.bearish is not None
    if e.type == "signal" and e.signal is None and not directional:
        errors.append("Signal entry needs a condition (or bullish / bearish conditions).")
    if e.type == "time" and e.signal:
        warnings.append("The neutral signal condition is ignored for a time-based entry (use filter).")
    if directional:
        if not p.bullish and e.bullish is not None:
            errors.append("Add bullish legs (they're opened when the bullish condition is true).")
        if e.bearish is not None and not (p.bearish or (p.bearish_mirror and p.bullish)):
            errors.append("Add bearish legs, or mirror the bullish ones.")
    elif not p.legs:
        errors.append("Add at least one leg.")
    all_legs = (p.legs or []) + (p.bullish or []) + (p.bearish or [])
    for group in (p.legs or [], p.bullish or [], p.bearish or []):
        gids = [l.id for l in group]
        if len(gids) != len(set(gids)):
            errors.append("Leg names must be unique.")
            break
    if any(l.instrument == "FUT" and l.strike.by != "atm_offset" for l in all_legs):
        warnings.append("Strike selection is ignored for futures legs.")
    if any(l.strike.by == "delta" and not 0 < l.strike.value < 1 for l in all_legs):
        errors.append("Delta strike selection needs a value between 0 and 1 (e.g. 0.25).")
    if any(l.strike.by == "premium" and l.strike.value <= 0 for l in all_legs):
        errors.append("Premium strike selection needs a premium above 0.")
    if e.filter is not None and e.type != "time":
        warnings.append("The entry filter only applies to time-based entries; signal entries use their conditions.")
    if e.prev_day and e.type != "time":
        errors.append("Previous-day entries are only available for time-based entries.")
    if e.times and e.prev_day:
        errors.append("Several entry times can't be combined with a previous-day entry.")
    if e.times and len(set(e.times)) != len(e.times):
        errors.append("Entry times must be different.")
    if e.times and e.type == "time" and len(e.times) > spec.schedule.max_trades_per_day:
        warnings.append(f"{len(e.times)} entry times but at most {spec.schedule.max_trades_per_day} trade(s) a day: "
                        "raise 'max trades per day' to use them all.")
    swing = spec.holding.mode == "swing"
    if e.type == "time" and not e.prev_day and not swing and max(entry_times(e)) >= x.square_off:
        errors.append("The entry time must be before the square-off time.")
    if e.last_entry > x.square_off:
        warnings.append("Entries after the square-off time can't be traded; they're skipped.")
    if not any([x.combined.target, x.combined.stop, x.combined.trailing, x.per_leg, x.dte_overrides,
                x.spot_move_points, x.exit_signal, x.exit_bullish, x.exit_bearish, x.exit_on_opposite_signal,
                x.underlying_stop]):
        warnings.append("No target, stop or signal exit: every trade is held until the square-off time.")
    if (x.exit_bullish or x.exit_bearish) and not directional:
        warnings.append("Bullish / bearish exit conditions only apply to bullish / bearish strategies (use the exit signal).")
    if x.exit_on_opposite_signal and not directional:
        warnings.append("'Exit on opposite signal' only applies to bullish / bearish strategies.")
    if any(l.action == "sell" for l in all_legs) and not (x.combined.stop or (x.per_leg and x.per_leg.stop) or x.combined.trailing):
        warnings.append("Short legs with no stop-loss: losses aren't capped.")
    if swing:
        h = spec.holding
        if e.prev_day:
            errors.append("Previous-day entries don't apply to multi-day holding (positions are already held overnight).")
        legs_all = (p.legs or []) + (p.bullish or []) + (p.bearish or [])
        for l in legs_all:
            if l.action == "sell" and l.instrument in ("CE", "PE"):
                covered = any(o.action == "buy" and o.instrument == l.instrument for o in legs_all)
                if not covered:
                    errors.append(f"Swing trades are held overnight: short option leg {l.id} needs a protective long "
                                  f"{l.instrument} (defined risk only).")
        if any(l.instrument == "FUT" for l in legs_all) and not (x.underlying_stop or x.combined.stop or x.spot_move_points):
            errors.append("Futures held overnight need a stop (underlying stop, combined stop or spot move).")
        if any(l.expiry.min_days < h.max_days + h.exit_before_expiry for l in legs_all):
            warnings.append("Some legs may expire before max_days; they're closed early (exit_before_expiry).")
        if spec.timeframe in DAILY_TFS and e.type == "signal" and e.next_day_time >= h.exit_time:
            errors.append("next_day_time must be before the holding exit time.")
    elif spec.timeframe in DAILY_TFS and e.type == "signal":
        errors.append("Signals on 1d / 1w candles are known after the close: use holding mode 'swing'.")
    return errors, warnings
