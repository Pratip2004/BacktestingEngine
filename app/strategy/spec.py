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
Timeframe = Literal["1m", "3m", "5m", "10m", "15m", "30m", "60m"]
TF_MINUTES: dict[str, int] = {"1m": 1, "3m": 3, "5m": 5, "10m": 10, "15m": 15, "30m": 30, "60m": 60}


# ---------- Conditions (no-code indicator logic) ----------

IndicatorName = Literal[
    "price", "ema", "sma", "rsi", "vwap", "macd", "supertrend", "bbands", "atr",
    "orb", "prev_day", "day_open", "gap_pct", "value",
]


class Operand(BaseModel):
    """One side of a comparison: an indicator on a timeframe, or a plain number (ind='value')."""
    ind: IndicatorName
    params: dict[str, float | int | str] = Field(default_factory=dict)
    field: str | None = None  # e.g. macd: line/signal/hist; bbands: upper/mid/lower; price: open/high/low/close
    tf: Timeframe | None = None  # defaults to the strategy timeframe


class Rule(BaseModel):
    left: Operand
    op: Literal[">", "<", ">=", "<=", "crosses_above", "crosses_below"]
    right: Operand


class Group(BaseModel):
    all: list[Union["Group", Rule]] | None = None
    any: list[Union["Group", Rule]] | None = None

    @model_validator(mode="after")
    def _one_kind(self):
        if (self.all is None) == (self.any is None):
            raise ValueError("a condition group needs exactly one of 'all' or 'any'")
        if not (self.all or self.any):
            raise ValueError("a condition group can't be empty")
        return self


Condition = Union[Group, Rule]


# ---------- Schedule ----------

class Entry(BaseModel):
    type: Literal["time", "signal"] = "time"
    time: HHMM = "09:20"  # time entries
    prev_day: bool = False  # time entries: enter on the previous trading day at `time`, hold overnight
    # Signal entries: conditions on the strategy timeframe; evaluated at each candle close, entered at the
    # next minute's open. A direction-neutral strategy uses `signal`; a directional one bullish/bearish.
    signal: Condition | None = None
    bullish: Condition | None = None
    bearish: Condition | None = None
    window_start: HHMM = "09:15"
    last_entry: HHMM = "15:00"  # no new entries after this time


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
    skip_expiry_day: on an expiry day use the next expiry instead (never trade the expiring contract)."""
    by: Literal["weekly", "monthly"] = "weekly"
    n: int = Field(0, ge=0, le=3)
    skip_expiry_day: bool = False


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


class Exits(BaseModel):
    evaluation: Evaluation = Field(default_factory=Evaluation)
    pnl_basis: Literal["gross", "net"] = "gross"  # levels on P&L before costs, or after all costs
    combined: CombinedExits = Field(default_factory=CombinedExits)
    per_leg: PerLegExits | None = None
    dte_overrides: dict[int, CombinedExits] = Field(default_factory=dict)  # combined levels per DTE
    square_off: HHMM = "15:15"
    spot_move_points: float | None = Field(None, gt=0)  # exit if spot moves this far from entry
    exit_signal: Condition | None = None  # exit when this becomes true
    exit_on_opposite_signal: bool = False  # directional: exit when the opposite entry signal fires


# ---------- Risk & costs ----------

class Risk(BaseModel):
    max_loss_per_day: float | None = Field(None, gt=0)  # ₹; no new entries after realised loss reaches it


class Costs(BaseModel):
    brokerage_per_order: float = Field(20.0, ge=0)
    slippage_points: float = Field(0.5, ge=0)
    taxes: bool = True


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
    directional = e.type == "signal" and (e.bullish is not None or e.bearish is not None)
    if e.type == "signal" and e.signal is None and not directional:
        errors.append("Signal entry needs a condition (or bullish / bearish conditions).")
    if e.type == "time" and (e.signal or e.bullish or e.bearish):
        warnings.append("Entry conditions are ignored for a time-based entry.")
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
    if e.prev_day and e.type != "time":
        errors.append("Previous-day entries are only available for time-based entries.")
    if e.type == "time" and not e.prev_day and e.time >= x.square_off:
        errors.append("The entry time must be before the square-off time.")
    if e.last_entry > x.square_off:
        warnings.append("Entries after the square-off time can't be traded; they're skipped.")
    if not any([x.combined.target, x.combined.stop, x.combined.trailing, x.per_leg, x.dte_overrides,
                x.spot_move_points, x.exit_signal, x.exit_on_opposite_signal]):
        warnings.append("No target, stop or signal exit: every trade is held until the square-off time.")
    if x.exit_on_opposite_signal and not directional:
        warnings.append("'Exit on opposite signal' only applies to bullish / bearish strategies.")
    if any(l.action == "sell" for l in all_legs) and not (x.combined.stop or (x.per_leg and x.per_leg.stop) or x.combined.trailing):
        warnings.append("Short legs with no stop-loss: losses aren't capped.")
    return errors, warnings
