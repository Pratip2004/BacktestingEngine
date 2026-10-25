"""Built-in strategy templates: complete StrategySpecs the builder starts from.

"ATM straddle (buy/sell)" and "EMA crossover butterfly" express exactly what the dedicated Straddle and
EMA butterfly pages compute, so the generic engine is checked against them (parity tests).
"""

from copy import deepcopy

COSTS = {"brokerage_per_order": 20, "slippage_points": 0.5, "taxes": True}


def _leg(id, action, instrument, by="atm_offset", value=0, lots=1, expiry=None):
    return {"id": id, "action": action, "instrument": instrument, "strike": {"by": by, "value": value},
            "expiry": expiry or {"by": "weekly", "n": 0}, "lots": lots}


def _time_entry(at="09:20", prev_day=False):
    return {"type": "time", "time": at, "prev_day": prev_day}


def _ema(period, tf=None):
    return {"ind": "ema", "params": {"period": period}, **({"tf": tf} if tf else {})}


TEMPLATES = [
    {
        "id": "long-straddle",
        "category": "Volatility",
        "name": "ATM straddle (buy)",
        "description": "Buy the ATM call and put; profit from a big move either way. Target as % of premium, exit by square-off.",
        "spec": {
            "name": "ATM straddle (buy)", "underlying": "NIFTY", "timeframe": "1m",
            "schedule": {"entry": _time_entry("09:30")},
            "position": {"legs": [_leg("ce", "buy", "CE"), _leg("pe", "buy", "PE")]},
            "exits": {"evaluation": {"mode": "intrabar"}, "pnl_basis": "gross",
                      "combined": {"target": {"unit": "pct", "value": 50}}, "square_off": "15:15"},
            "costs": COSTS,
        },
    },
    {
        "id": "short-straddle",
        "category": "Premium selling",
        "name": "ATM straddle (sell)",
        "description": "Sell the ATM call and put to collect premium. Target = % of premium kept, combined stop-loss.",
        "spec": {
            "name": "ATM straddle (sell)", "underlying": "NIFTY", "timeframe": "1m",
            "schedule": {"entry": _time_entry("09:20")},
            "position": {"legs": [_leg("ce", "sell", "CE"), _leg("pe", "sell", "PE")]},
            "exits": {"evaluation": {"mode": "intrabar"}, "pnl_basis": "gross",
                      "combined": {"target": {"unit": "pct", "value": 50}, "stop": {"unit": "pct", "value": 30}},
                      "square_off": "15:15"},
            "costs": COSTS,
        },
    },
    {
        "id": "short-straddle-leg-sl",
        "category": "Premium selling",
        "name": "09:20 straddle, per-leg stop",
        "description": "Sell ATM CE + PE at 09:20, 25% stop on each leg; the other leg keeps running to the square-off.",
        "spec": {
            "name": "09:20 straddle, 25% per-leg stop", "underlying": "NIFTY", "timeframe": "1m",
            "schedule": {"entry": _time_entry("09:20")},
            "position": {"legs": [_leg("ce", "sell", "CE"), _leg("pe", "sell", "PE")]},
            "exits": {"evaluation": {"mode": "intrabar"}, "pnl_basis": "gross",
                      "per_leg": {"stop": {"unit": "pct", "value": 25}, "on_stop": "keep_others"},
                      "square_off": "15:15"},
            "costs": COSTS,
        },
    },
    {
        "id": "short-strangle",
        "category": "Premium selling",
        "name": "Short strangle",
        "description": "Sell an OTM call and put about 2% away from spot, with a combined stop-loss.",
        "spec": {
            "name": "Short strangle (2% OTM)", "underlying": "NIFTY", "timeframe": "1m",
            "schedule": {"entry": _time_entry("09:20")},
            "position": {"legs": [_leg("ce", "sell", "CE", "pct_otm", 2), _leg("pe", "sell", "PE", "pct_otm", 2)]},
            "exits": {"combined": {"target": {"unit": "pct", "value": 60}, "stop": {"unit": "pct", "value": 50}}, "square_off": "15:15"},
            "costs": COSTS,
        },
    },
    {
        "id": "iron-condor",
        "category": "Premium selling",
        "name": "Iron condor",
        "description": "Sell ±4-strike OTM options, buy ±8-strike wings. Capped risk on both sides.",
        "spec": {
            "name": "Iron condor", "underlying": "NIFTY", "timeframe": "1m",
            "schedule": {"entry": _time_entry("09:20")},
            "position": {"legs": [
                _leg("sell_ce", "sell", "CE", "atm_offset", 4), _leg("buy_ce", "buy", "CE", "atm_offset", 8),
                _leg("sell_pe", "sell", "PE", "atm_offset", -4), _leg("buy_pe", "buy", "PE", "atm_offset", -8)]},
            "exits": {"combined": {"target": {"unit": "pct", "value": 50}, "stop": {"unit": "pct", "value": 100}}, "square_off": "15:15"},
            "costs": COSTS,
        },
    },
    {
        "id": "iron-fly",
        "category": "Premium selling",
        "name": "Iron fly",
        "description": "Sell the ATM straddle and buy wings 4 strikes away.",
        "spec": {
            "name": "Iron fly", "underlying": "NIFTY", "timeframe": "1m",
            "schedule": {"entry": _time_entry("09:20")},
            "position": {"legs": [
                _leg("sell_ce", "sell", "CE"), _leg("sell_pe", "sell", "PE"),
                _leg("buy_ce", "buy", "CE", "atm_offset", 4), _leg("buy_pe", "buy", "PE", "atm_offset", -4)]},
            "exits": {"combined": {"target": {"unit": "pct", "value": 30}, "stop": {"unit": "pct", "value": 40}}, "square_off": "15:15"},
            "costs": COSTS,
        },
    },
    {
        "id": "ema-butterfly",
        "category": "Directional",
        "name": "EMA crossover butterfly",
        "description": "EMA 9/21 crossover on 5m: call butterfly when bullish, put butterfly when bearish. Exits at candle closes on net P&L.",
        "spec": {
            "name": "EMA 9/21 crossover butterfly", "underlying": "NIFTY", "timeframe": "5m",
            "schedule": {
                "entry": {"type": "signal", "last_entry": "15:00",
                          "bullish": {"left": _ema(9), "op": "crosses_above", "right": _ema(21)},
                          "bearish": {"left": _ema(9), "op": "crosses_below", "right": _ema(21)}},
                "max_trades_per_day": 50,
            },
            "position": {
                "bullish": [
                    _leg("body_lo", "buy", "CE", "points", 0, 1, {"by": "weekly", "n": 0, "skip_expiry_day": True}),
                    _leg("body", "sell", "CE", "points", 200, 2, {"by": "weekly", "n": 0, "skip_expiry_day": True}),
                    _leg("wing", "buy", "CE", "points", 400, 1, {"by": "weekly", "n": 0, "skip_expiry_day": True}),
                ],
                "bearish_mirror": True,
            },
            "exits": {"evaluation": {"mode": "close", "every": "5m"}, "pnl_basis": "net",
                      "combined": {"target": {"unit": "pct", "value": 50}, "stop": {"unit": "pct", "value": 30}},
                      "square_off": "15:15"},
            "costs": COSTS,
        },
    },
    {
        "id": "orb-breakout",
        "category": "Directional",
        "name": "Opening range breakout",
        "description": "Buy the ATM call when spot closes above the 09:15–09:30 high, the ATM put below the low.",
        "spec": {
            "name": "ORB breakout (09:15–09:30)", "underlying": "NIFTY", "timeframe": "5m",
            "schedule": {
                "entry": {"type": "signal", "window_start": "09:30", "last_entry": "13:30",
                          "bullish": {"left": {"ind": "price", "field": "close"}, "op": "crosses_above", "right": {"ind": "orb", "field": "high"}},
                          "bearish": {"left": {"ind": "price", "field": "close"}, "op": "crosses_below", "right": {"ind": "orb", "field": "low"}}},
                "max_trades_per_day": 1,
            },
            "position": {"bullish": [_leg("atm", "buy", "CE")], "bearish_mirror": True},
            "exits": {"combined": {"target": {"unit": "pct", "value": 40}, "stop": {"unit": "pct", "value": 25}}, "square_off": "15:15"},
            "costs": COSTS,
        },
    },
    {
        "id": "supertrend-spread",
        "category": "Directional",
        "name": "Supertrend vertical spread",
        "description": "Bull call spread when 15m Supertrend turns up, bear put spread when it turns down; exit on the opposite signal.",
        "spec": {
            "name": "Supertrend vertical spread", "underlying": "NIFTY", "timeframe": "15m",
            "schedule": {
                "entry": {"type": "signal", "window_start": "09:30", "last_entry": "14:00",
                          "bullish": {"left": {"ind": "supertrend", "field": "direction", "params": {"period": 10, "multiplier": 3}}, "op": "crosses_above", "right": {"ind": "value", "params": {"value": 0}}},
                          "bearish": {"left": {"ind": "supertrend", "field": "direction", "params": {"period": 10, "multiplier": 3}}, "op": "crosses_below", "right": {"ind": "value", "params": {"value": 0}}}},
                "max_trades_per_day": 2,
            },
            "position": {"bullish": [_leg("long", "buy", "CE"), _leg("short", "sell", "CE", "atm_offset", 4)], "bearish_mirror": True},
            "exits": {"exit_on_opposite_signal": True,
                      "combined": {"target": {"unit": "pct", "value": 80}, "stop": {"unit": "pct", "value": 50}}, "square_off": "15:15"},
            "costs": COSTS,
        },
    },
    {
        "id": "rsi-reversal",
        "category": "Directional",
        "name": "RSI reversal (long option)",
        "description": "Buy the ATM call when 15m RSI crosses up through 30, the put when it crosses down through 70. Trailing stop.",
        "spec": {
            "name": "RSI reversal", "underlying": "NIFTY", "timeframe": "15m",
            "schedule": {
                "entry": {"type": "signal", "window_start": "09:45", "last_entry": "14:00",
                          "bullish": {"left": {"ind": "rsi", "params": {"period": 14}}, "op": "crosses_above", "right": {"ind": "value", "params": {"value": 30}}},
                          "bearish": {"left": {"ind": "rsi", "params": {"period": 14}}, "op": "crosses_below", "right": {"ind": "value", "params": {"value": 70}}}},
                "max_trades_per_day": 2,
            },
            "position": {"bullish": [_leg("atm", "buy", "CE")], "bearish_mirror": True},
            "exits": {"combined": {"stop": {"unit": "pct", "value": 30},
                                   "trailing": {"activate": {"unit": "pct", "value": 30}, "trail": {"unit": "pct", "value": 15}}},
                      "square_off": "15:15"},
            "costs": COSTS,
        },
    },
]


def templates() -> list[dict]:
    return deepcopy(TEMPLATES)


def template(template_id: str) -> dict | None:
    return next((deepcopy(t) for t in TEMPLATES if t["id"] == template_id), None)
