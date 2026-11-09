"""Regime model and daily candles: labels behave on clear trends, and are causal."""

import numpy as np
import pandas as pd

from app.strategy.regimes import regime_series, trend_state


def daily(closes, start="2023-01-02"):
    d = pd.bdate_range(start, periods=len(closes))
    c = np.asarray(closes, dtype=float)
    return pd.DataFrame({"open": c, "high": c * 1.004, "low": c * 0.996, "close": c, "volume": 0.0,
                         "date": d.date}, index=d)


def test_trend_labels_up_and_down():
    up = daily(np.linspace(15000, 22000, 300))
    down = daily(np.linspace(22000, 15000, 300))
    assert trend_state(up).iloc[-1] == 1
    assert trend_state(down).iloc[-1] == -1


def test_regime_is_causal():
    rng = np.random.default_rng(3)
    closes = 20000 * np.exp(np.cumsum(rng.normal(0, 0.01, 400)))
    base = daily(closes)
    vix = daily(15 + rng.normal(0, 2, 400))
    a = regime_series(base, vix)
    later = closes.copy()
    later[300:] *= 1.3  # change the future
    b = regime_series(daily(later), vix)
    assert np.allclose(a.iloc[:300].to_numpy(), b.iloc[:300].to_numpy(), equal_nan=True)
    assert set(a.dropna().unique()) <= {1, 2, 3, 4, 5, 6}
