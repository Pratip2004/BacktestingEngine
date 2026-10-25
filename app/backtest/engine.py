"""Long-only, single-instrument, bar-by-bar backtester.

A signal computed on bar i's close is filled at bar i+1's open, so the result has no lookahead.
"""

from dataclasses import dataclass, field

import pandas as pd


@dataclass
class Trade:
    entry_time: str
    entry_price: float
    quantity: int
    exit_time: str | None = None
    exit_price: float | None = None
    pnl: float | None = None


@dataclass
class BacktestResult:
    metrics: dict
    trades: list[Trade] = field(default_factory=list)
    equity_curve: list[dict] = field(default_factory=list)


def run_backtest(
    df: pd.DataFrame,
    signal: pd.Series,
    initial_capital: float = 100_000.0,
    commission_pct: float = 0.03,
) -> BacktestResult:
    """`commission_pct` is charged on each fill's turnover, as a percentage (0.03 = 0.03%)."""
    fee = commission_pct / 100
    cash, qty = initial_capital, 0
    trades: list[Trade] = []
    equity_curve = []

    target = signal.shift(1).fillna(0).astype(int)  # trade on the bar after the signal
    first_open = df["open"].iloc[0] if len(df) else 0
    for i, bar in enumerate(df.itertuples(index=False)):
        ts = str(bar.datetime)
        if target.iloc[i] == 1 and qty == 0:
            qty = int(cash // (bar.open * (1 + fee)))
            if qty > 0:
                cash -= qty * bar.open * (1 + fee)
                trades.append(Trade(ts, bar.open, qty))
        elif target.iloc[i] == 0 and qty > 0:
            cash += qty * bar.open * (1 - fee)
            t = trades[-1]
            t.exit_time, t.exit_price = ts, bar.open
            t.pnl = round(qty * (bar.open * (1 - fee) - t.entry_price * (1 + fee)), 2)
            qty = 0
        equity_curve.append({
            "datetime": ts,
            "equity": round(cash + qty * bar.close, 2),
            "buy_and_hold": round(initial_capital * bar.close / first_open, 2),
        })

    return BacktestResult(_metrics(df, equity_curve, trades, initial_capital), trades, equity_curve)


def _metrics(df: pd.DataFrame, equity_curve: list[dict], trades: list[Trade], initial_capital: float) -> dict:
    if not equity_curve:
        return {"bars": 0}
    equity = pd.Series([e["equity"] for e in equity_curve])
    drawdown = equity / equity.cummax() - 1
    closed = [t for t in trades if t.pnl is not None]
    wins = [t for t in closed if t.pnl > 0]
    final = float(equity.iloc[-1])
    return {
        "bars": len(df),
        "initial_capital": initial_capital,
        "final_equity": round(final, 2),
        "total_return_pct": round((final / initial_capital - 1) * 100, 2),
        "buy_and_hold_return_pct": round(float(df["close"].iloc[-1] / df["open"].iloc[0] - 1) * 100, 2),
        "max_drawdown_pct": round(float(drawdown.min()) * 100, 2),
        "trades": len(trades),
        "closed_trades": len(closed),
        "win_rate_pct": round(len(wins) / len(closed) * 100, 2) if closed else None,
        "open_position": bool(trades and trades[-1].exit_time is None),
    }
