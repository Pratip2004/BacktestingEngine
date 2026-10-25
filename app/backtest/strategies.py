"""Strategies turn a candle DataFrame into a target position series: 1 = long, 0 = flat."""

from typing import Callable

import pandas as pd

Strategy = Callable[..., pd.Series]


def sma_crossover(df: pd.DataFrame, fast: int = 20, slow: int = 50) -> pd.Series:
    """Long while the fast SMA of close is above the slow SMA."""
    fast_ma = df["close"].rolling(fast).mean()
    slow_ma = df["close"].rolling(slow).mean()
    return (fast_ma > slow_ma).astype(int)


def rsi_mean_reversion(df: pd.DataFrame, period: int = 14, oversold: float = 30, overbought: float = 70) -> pd.Series:
    """Go long when RSI drops below `oversold` and exit when it rises above `overbought`."""
    delta = df["close"].diff()
    gain = delta.clip(lower=0).ewm(alpha=1 / period, adjust=False).mean()
    loss = (-delta.clip(upper=0)).ewm(alpha=1 / period, adjust=False).mean()
    rsi = 100 - 100 / (1 + gain / loss)

    signal = pd.Series(float("nan"), index=df.index)
    signal[rsi < oversold] = 1
    signal[rsi > overbought] = 0
    return signal.ffill().fillna(0).astype(int)


STRATEGIES: dict[str, Strategy] = {
    "sma_crossover": sma_crossover,
    "rsi_mean_reversion": rsi_mean_reversion,
}
