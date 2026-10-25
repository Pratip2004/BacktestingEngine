"""Black-Scholes pricing and implied volatility. Breeze doesn't return IV, so it's derived from LTP."""

import math

SQRT2 = math.sqrt(2)


def _ncdf(x: float) -> float:
    return 0.5 * (1 + math.erf(x / SQRT2))


def bs_price(spot: float, strike: float, t: float, r: float, vol: float, is_call: bool) -> float:
    if t <= 0 or vol <= 0:
        return max(0.0, spot - strike) if is_call else max(0.0, strike - spot)
    d1 = (math.log(spot / strike) + (r + vol * vol / 2) * t) / (vol * math.sqrt(t))
    d2 = d1 - vol * math.sqrt(t)
    if is_call:
        return spot * _ncdf(d1) - strike * math.exp(-r * t) * _ncdf(d2)
    return strike * math.exp(-r * t) * _ncdf(-d2) - spot * _ncdf(-d1)


def bs_delta(spot: float, strike: float, t: float, r: float, vol: float, is_call: bool) -> float | None:
    if t <= 0 or not vol:
        return None
    d1 = (math.log(spot / strike) + (r + vol * vol / 2) * t) / (vol * math.sqrt(t))
    return _ncdf(d1) if is_call else _ncdf(d1) - 1


def implied_vol(price: float, spot: float, strike: float, t: float, r: float, is_call: bool) -> float | None:
    """Annualised IV as a fraction (0.12 = 12%), by bisection. None when no vol fits the price."""
    if not price or price <= 0 or not spot or t <= 0:
        return None
    intrinsic = max(0.0, spot - strike * math.exp(-r * t)) if is_call else max(0.0, strike * math.exp(-r * t) - spot)
    if price <= intrinsic:
        return None
    lo, hi = 1e-4, 5.0
    if bs_price(spot, strike, t, r, hi, is_call) < price:
        return None
    for _ in range(100):
        mid = (lo + hi) / 2
        if bs_price(spot, strike, t, r, mid, is_call) > price:
            hi = mid
        else:
            lo = mid
        if hi - lo < 1e-6:
            break
    return (lo + hi) / 2
