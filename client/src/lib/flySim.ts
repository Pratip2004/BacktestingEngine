// Replays EMA-crossover butterfly candidates under exit rules, entirely client-side, so the exit
// lab can recompute instantly as sliders move.
//
// Rules (as agreed with the user):
// - One position at a time: a crossover while a trade is open is ignored.
// - Capital = premium paid (net debit × qty). Target / stop-loss are % of that capital, on net P&L
//   (after slippage and costs), checked at every candle close; the exit fills at that close.
// - Otherwise square off at the close of the last candle ending at or before `squareOff`.
// - No entries after `lastEntry` (entry candle's open time).

export type T_PathPoint = { t: string; pnl: number; px: number[] };

export type T_FlyCandidate = {
  entry_time: string;
  direction: "bullish" | "bearish";
  expiry: string;
  spot_entry: number;
  atm: number;
  legs: { strike: number; right: "call" | "put"; lots: number; entry: number }[];
  net_debit: number;
  capital: number;
  entry_cost: number;
  path: T_PathPoint[];
};

export type T_ExitRules = {
  targetPct: number | null; // null = no target
  stopPct: number | null; // null = no stop-loss
  squareOff: string; // "HH:mm"
  lastEntry: string; // "HH:mm"
};

export type T_ExitReason = "target" | "stop" | "time";

export type T_SimTrade = T_FlyCandidate & {
  exit_time: string; // actual time of the exit (candle close)
  exit_reason: T_ExitReason;
  exit_px: number[];
  pnl: number;
  pnl_pct: number;
  bars_held: number;
  mfe_pct: number; // best net P&L % available before square-off (ignoring target/stop)
  mae_pct: number; // worst net P&L % before square-off
};

export type T_SimMetrics = {
  trades: number;
  wins: number;
  win_rate: number | null;
  net_pnl: number;
  avg_pnl_pct: number | null;
  avg_win: number | null;
  avg_loss: number | null;
  profit_factor: number | null;
  max_drawdown: number;
  best: number | null;
  worst: number | null;
  by_reason: Record<T_ExitReason, number>;
  avg_capital: number | null;
};

const hhmm = (s: string) => s.slice(11, 16);

// "2026-08-03 11:40:00" + 5 min → "2026-08-03 11:45:00" (candle start → candle close).
function addMinutes(t: string, minutes: number): string {
  const [d, time] = t.split(" ");
  const [h, m] = time.split(":").map(Number);
  const total = h * 60 + m + minutes;
  return `${d} ${String(Math.floor(total / 60)).padStart(2, "0")}:${String(total % 60).padStart(2, "0")}:00`;
}

export function simulate(candidates: T_FlyCandidate[], rules: T_ExitRules, intervalMin: number) {
  const trades: T_SimTrade[] = [];
  let freeAt = ""; // a new entry must open at or after the last exit's close time

  for (const c of candidates) {
    if (c.entry_time < freeAt || hhmm(c.entry_time) > rules.lastEntry) continue;
    // Candles that have closed by the square-off time.
    const window = c.path.filter((p) => hhmm(addMinutes(p.t, intervalMin)) <= rules.squareOff);
    if (!window.length) continue;

    let exitIdx = window.length - 1;
    let reason: T_ExitReason = "time";
    let mfe = -Infinity;
    let mae = Infinity;
    for (let i = 0; i < window.length; i++) {
      const pct = (window[i].pnl / c.capital) * 100;
      mfe = Math.max(mfe, pct);
      mae = Math.min(mae, pct);
      if (reason !== "time") continue;
      if (rules.targetPct !== null && pct >= rules.targetPct) {
        reason = "target";
        exitIdx = i;
      } else if (rules.stopPct !== null && pct <= -rules.stopPct) {
        reason = "stop";
        exitIdx = i;
      }
    }

    const exit = window[exitIdx];
    const exitTime = addMinutes(exit.t, intervalMin);
    trades.push({
      ...c,
      exit_time: exitTime,
      exit_reason: reason,
      exit_px: exit.px,
      pnl: exit.pnl,
      pnl_pct: (exit.pnl / c.capital) * 100,
      bars_held: exitIdx + 1,
      mfe_pct: mfe,
      mae_pct: mae,
    });
    freeAt = exitTime;
  }
  return { trades, metrics: metricsOf(trades) };
}

export function metricsOf(trades: T_SimTrade[]): T_SimMetrics {
  const pnls = trades.map((t) => t.pnl);
  const wins = pnls.filter((p) => p > 0);
  const losses = pnls.filter((p) => p <= 0);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  let peak = 0;
  let cum = 0;
  let maxDd = 0;
  for (const p of pnls) {
    cum += p;
    peak = Math.max(peak, cum);
    maxDd = Math.min(maxDd, cum - peak);
  }
  const by_reason: Record<T_ExitReason, number> = { target: 0, stop: 0, time: 0 };
  trades.forEach((t) => by_reason[t.exit_reason]++);
  return {
    trades: trades.length,
    wins: wins.length,
    win_rate: trades.length ? (wins.length / trades.length) * 100 : null,
    net_pnl: sum(pnls),
    avg_pnl_pct: trades.length ? sum(trades.map((t) => t.pnl_pct)) / trades.length : null,
    avg_win: wins.length ? sum(wins) / wins.length : null,
    avg_loss: losses.length ? sum(losses) / losses.length : null,
    profit_factor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
    max_drawdown: maxDd,
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
    by_reason,
    avg_capital: trades.length ? sum(trades.map((t) => t.capital)) / trades.length : null,
  };
}

// Net P&L (and friends) for every target × stop combination, for the heatmap.
export const GRID_TARGETS: (number | null)[] = [10, 20, 30, 40, 50, 60, 75, 100, 125, 150, 200, null];
export const GRID_STOPS: (number | null)[] = [10, 20, 30, 40, 50, 60, 75, 100, null];

export function sweep(candidates: T_FlyCandidate[], base: Omit<T_ExitRules, "targetPct" | "stopPct">, intervalMin: number) {
  return GRID_STOPS.map((stopPct) =>
    GRID_TARGETS.map((targetPct) => ({ targetPct, stopPct, ...simulate(candidates, { ...base, targetPct, stopPct }, intervalMin).metrics })),
  );
}
