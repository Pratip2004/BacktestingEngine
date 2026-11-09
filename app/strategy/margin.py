"""Margin (money blocked) for a position: what the broker needs, not the premium.

Buying options blocks only the premium paid. Selling blocks exchange margin (SPAN + exposure), which for an
index option is ~₹1.5–2.5 lakh per lot, far more than the premium received. A hedged (defined-risk)
structure blocks roughly its maximum loss. Backtests can't ask the exchange for the SPAN margin of a
contract on a past date, so short options and futures use a share of the contract value (spot × quantity),
calibrated against Breeze's margin calculator on live contracts (GET /market/margin-check) and stored as the
settings short_margin_pct / fut_margin_pct.

legs: [{action, instrument (CE/PE/FUT), strike, entry, qty, expiry}], premium: signed (+ paid, − received).
"""

from __future__ import annotations

DEFAULT_SHORT_PCT = 13.0  # % of contract value for an uncovered short index option
DEFAULT_FUT_PCT = 12.0  # % of contract value for an index future


def _payoff(legs: list[dict], s: float) -> float:
    out = 0.0
    for l in legs:
        side = 1 if l["action"] == "buy" else -1
        if l["instrument"] == "FUT":
            value = s
        elif l["instrument"] == "CE":
            value = max(0.0, s - l["strike"])
        else:
            value = max(0.0, l["strike"] - s)
        out += side * l["qty"] * (value - l["entry"])
    return out


def margin_required(legs: list[dict], premium: float, spot: float,
                    short_pct: float = DEFAULT_SHORT_PCT, fut_pct: float = DEFAULT_FUT_PCT) -> tuple[float, str]:
    """(₹ blocked, how it was estimated): premium | max_loss | approx_margin."""
    # Option premium paid (net debit). A futures leg's entry price is its contract value, not money paid.
    if any(l["instrument"] == "FUT" for l in legs):
        premium = sum((1 if l["action"] == "buy" else -1) * l["entry"] * l["qty"] for l in legs if l["instrument"] != "FUT")
    paid = max(0.0, premium)
    shorts = [l for l in legs if l["action"] == "sell"]
    futs = [l for l in legs if l["instrument"] == "FUT"]
    if not shorts and not futs:
        return paid, "premium"
    calls = sum((1 if l["action"] == "buy" else -1) * l["qty"] for l in legs if l["instrument"] == "CE")
    puts = sum((1 if l["action"] == "buy" else -1) * l["qty"] for l in legs if l["instrument"] == "PE")
    if futs or len({l["expiry"] for l in legs}) > 1:
        fut_qty = abs(sum((1 if l["action"] == "buy" else -1) * l["qty"] for l in futs))
        naked = max(0, -calls, -puts)
        return fut_pct / 100 * spot * fut_qty + short_pct / 100 * spot * naked + paid, "approx_margin"
    if calls < 0 or puts < 0:  # unbounded on at least one side; a short straddle is margined on one side
        return short_pct / 100 * spot * max(-calls, -puts) + paid, "approx_margin"
    strikes = sorted({l["strike"] for l in legs})
    max_loss = -min(_payoff(legs, s) for s in [0.0, *strikes, strikes[-1] * 3])
    return max(max_loss, paid), "max_loss"
