// Replays ATM straddle days client-side under the lab's rules, so every control updates instantly.
//
// Rules (as agreed with the user):
// - Side: buy (long) or sell (short) 1 ATM CE + 1 ATM PE at one of the loaded entry times: "HH:MM" on
//   the trade day, or "D-1 HH:MM" on the previous trading day (held overnight), at that minute's open
//   ± slippage per leg.
// - Days: only trade days whose DTE (trading days to expiry, 0 = expiry day) is in `dtes`.
// - Levels: one set for every day, or per DTE (e.g. 0DTE target 50%, 1DTE 20%).
//   Buy:  target = multiple of premium (limit sell); no stop-loss.
//   Sell: target = % of premium kept (limit buy-back at (1 − %) × premium); combined stop-loss =
//         % above premium (stop-market at (1 + %) × premium, + slippage). A minute touching both
//         counts as the stop (conservative).
//   Limit orders fill at the level, or at the minute's open if it gaps through (e.g. overnight).
//   Intraminute extremes: high = max(CE.high + PE.low, CE.low + PE.high), low = min(CE.low + PE.high,
//   CE.high + PE.low), because a call's high coincides with a put's low.
// - Otherwise both legs are closed at the square-off minute's open on the trade day (∓ slippage).
// Costs use the dated rates in lib/fees.ts (mirroring the backend cost_schedule). They're linear in turnover apart from the flat
// per-order brokerage, so they can be computed on the combined straddle value.

import { optionCosts, straddleMargin } from "./fees";

export type T_StraddlePath = { t: string[]; ce_open: number[]; pe_open: number[]; hi: number[]; lo: number[] };

export type T_StraddleEntry = {
  spot: number;
  atm: number;
  ce_entry: number;
  pe_entry: number;
  entry_at: string; // "YYYY-MM-DD HH:MM"
  path: T_StraddlePath; // minutes from entry to the trade day's close, t as "YYYY-MM-DD HH:MM"
};

export type T_StraddleDay = {
  date: string; // trade day (the day the position is exited)
  expiry: string;
  dte: number;
  entries: Record<string, T_StraddleEntry>; // keyed by entry spec, e.g. "09:30", "D-1 15:25"
};

export type T_StraddleParams = {
  lots: number;
  lot_size: number;
  brokerage_per_order: number;
  slippage_points: number;
  taxes: boolean;
  short_margin_pct?: number; // margin for a short straddle, % of spot × qty (default DEFAULT_SHORT_MARGIN_PCT)
};

export type T_Side = "buy" | "sell";

// Exit levels for one side.
//   buy:  target = multiple of premium paid (1.5 = sell when the straddle is worth 1.5×); no stop.
//   sell: target = % of premium kept (50 = buy back at half the premium collected);
//         stop = % above premium collected (30 = buy back if the straddle rises to 1.3×).
export type T_Levels = { target: number | null; stop: number | null };

export type T_StraddleRules = {
  side: T_Side;
  entry: string;
  dtes: number[] | null; // null = every day
  squareOff: string; // "HH:MM" on the trade day
  levels: Record<T_Side, T_Levels>; // used for every day…
  perDte: boolean; // …unless per-day levels are on
  dteLevels: Record<T_Side, Record<string, T_Levels>>; // keyed by DTE
};

export const DEFAULT_LEVELS: Record<T_Side, T_Levels> = { buy: { target: 1.5, stop: null }, sell: { target: 50, stop: 30 } };

export const defaultRules = (entry: string): T_StraddleRules => ({
  side: "buy",
  entry,
  dtes: null,
  squareOff: "15:15",
  levels: { buy: { ...DEFAULT_LEVELS.buy }, sell: { ...DEFAULT_LEVELS.sell } },
  perDte: false,
  dteLevels: { buy: {}, sell: {} },
});

// Views saved before sell mode / per-day levels had { entry, dtes, targetX, squareOff }.
export function upgradeRules(saved: Record<string, unknown> | null, entry: string): T_StraddleRules {
  const base = defaultRules(entry);
  if (!saved) return base;
  if ("levels" in saved) return { ...base, ...(saved as Partial<T_StraddleRules>) };
  const { targetX, ...rest } = saved as { targetX?: number | null };
  return { ...base, ...(rest as Partial<T_StraddleRules>), levels: { ...base.levels, buy: { target: targetX ?? 1.5, stop: null } } };
}

export const levelsFor = (rules: T_StraddleRules, dte: number): T_Levels =>
  (rules.perDte && rules.dteLevels[rules.side][String(dte)]) || rules.levels[rules.side];

export type T_ExitReason = "target" | "stop" | "time";

export type T_StraddleTrade = Omit<T_StraddleEntry, "path"> & {
  date: string;
  expiry: string;
  dte: number;
  entry: string;
  side: T_Side;
  overnight: boolean;
  levels: T_Levels;
  premium: number; // per unit, CE + PE after slippage (paid when buying, collected when selling)
  capital: number; // premium × qty (paid when buying, received when selling)
  margin: number; // money blocked: the premium when buying, exchange margin (≈ % of spot × qty) when selling
  exit_at: string;
  exit_reason: T_ExitReason;
  exit_value: number; // per unit straddle value at exit (received when buying, paid when selling)
  costs: number;
  pnl: number;
  pnl_pct: number; // of premium
  pnl_margin_pct: number; // of margin blocked
  max_x: number; // highest value before square-off ÷ premium
  min_x: number; // lowest value before square-off ÷ premium
};

export type T_StraddleMetrics = {
  trades: number;
  wins: number;
  win_rate: number | null;
  net_pnl: number;
  avg_pnl: number | null;
  profit_factor: number | null;
  max_drawdown: number;
  best: number | null;
  worst: number | null;
  targets: number;
  stops: number;
  time_exits: number;
  avg_capital: number | null;
  avg_margin: number | null;
  peak_margin: number | null;
  return_on_margin_pct: number | null; // net P&L ÷ peak margin
};

export const isOvernight = (entry: string) => entry.startsWith("D-1 ");
export const entryLabel = (entry: string) => (isOvernight(entry) ? `Prev day ${entry.slice(4)}` : `${entry}`);
export const formatLevel = (side: T_Side, kind: "target" | "stop", v: number | null) =>
  v === null ? "off" : side === "buy" ? `${v}×` : kind === "target" ? `${v}%` : `+${v}%`;

// Costs for `orders` orders on `turnover` rupees of premium, buying or selling, at the rates of `day`.
function costs(p: T_StraddleParams, day: string, turnover: number, isBuy: boolean, orders: number) {
  return optionCosts(day, turnover, isBuy, orders, p.brokerage_per_order, p.taxes);
}

export function simulateStraddle(days: T_StraddleDay[], rules: T_StraddleRules, p: T_StraddleParams) {
  const qty = p.lots * p.lot_size;
  const slip = p.slippage_points;
  const sell = rules.side === "sell";
  const trades: T_StraddleTrade[] = [];

  for (const d of days) {
    if (rules.dtes && !rules.dtes.includes(d.dte)) continue;
    const e = d.entries[rules.entry];
    if (!e) continue;
    const { t, hi, lo, ce_open, pe_open } = e.path;
    const squareOffAt = `${d.date} ${rules.squareOff}`;
    if (e.entry_at >= squareOffAt) continue; // entry at or after the square-off: nothing to trade

    const lv = levelsFor(rules, d.dte);
    // Market orders on both legs: pay up when buying, give up when selling.
    const premium = e.ce_entry + e.pe_entry + (sell ? -2 : 2) * slip;
    let end = t.findIndex((m) => m >= squareOffAt);
    if (end === -1) end = t.length - 1;

    let exitIdx = end;
    let exitValue = 0;
    let reason: T_ExitReason = "time";
    let maxV = -Infinity;
    let minV = Infinity;

    if (!sell) {
      // Long: limit sell at the target multiple; no stop.
      const target = lv.target === null ? Infinity : lv.target * premium;
      for (let i = 0; i < end; i++) {
        maxV = Math.max(maxV, hi[i]);
        minV = Math.min(minV, lo[i]);
        if (reason !== "time") continue;
        const open = ce_open[i] + pe_open[i];
        if (open >= target || hi[i] >= target) {
          reason = "target";
          exitIdx = i;
          exitValue = Math.max(target, open); // a resting limit order fills at the open if it gaps through
        }
      }
    } else {
      // Short: limit buy-back at (1 − target%) × premium; stop-market at (1 + stop%) × premium.
      // If one minute touches both, assume the stop came first (conservative).
      const target = lv.target === null ? -Infinity : (1 - lv.target / 100) * premium;
      const stop = lv.stop === null ? Infinity : (1 + lv.stop / 100) * premium;
      for (let i = 0; i < end; i++) {
        maxV = Math.max(maxV, hi[i]);
        minV = Math.min(minV, lo[i]);
        if (reason !== "time") continue;
        const open = ce_open[i] + pe_open[i];
        if (open >= stop || hi[i] >= stop) {
          reason = "stop";
          exitIdx = i;
          exitValue = Math.max(stop, open) + 2 * slip; // stop-market: fills at the trigger (or a gapped open) plus slippage
        } else if (open <= target || lo[i] <= target) {
          reason = "target";
          exitIdx = i;
          exitValue = Math.min(target, open); // resting limit buy fills at the open if it gaps through
        }
      }
    }
    if (end === 0) maxV = minV = ce_open[0] + pe_open[0];
    if (reason === "time") exitValue = ce_open[exitIdx] + pe_open[exitIdx] + (sell ? 2 : -2) * slip;

    const fees = sell
      ? costs(p, e.entry_at, premium * qty, false, 2) + costs(p, t[exitIdx], exitValue * qty, true, 2)
      : costs(p, e.entry_at, premium * qty, true, 2) + costs(p, t[exitIdx], exitValue * qty, false, 2);
    const pnl = (sell ? premium - exitValue : exitValue - premium) * qty - fees;
    const { spot, atm, ce_entry, pe_entry, entry_at } = e;
    const margin = straddleMargin(sell, premium * qty, spot, qty, p.short_margin_pct);
    trades.push({
      spot,
      atm,
      ce_entry,
      pe_entry,
      entry_at,
      date: d.date,
      expiry: d.expiry,
      dte: d.dte,
      entry: rules.entry,
      side: rules.side,
      overnight: isOvernight(rules.entry),
      levels: lv,
      premium,
      capital: premium * qty,
      margin,
      exit_at: t[exitIdx],
      exit_reason: reason,
      exit_value: exitValue,
      costs: fees,
      pnl,
      pnl_pct: (pnl / (premium * qty)) * 100,
      pnl_margin_pct: margin ? (pnl / margin) * 100 : 0,
      max_x: maxV / premium,
      min_x: minV / premium,
    });
  }
  return { trades, metrics: straddleMetrics(trades) };
}

export function straddleMetrics(trades: T_StraddleTrade[]): T_StraddleMetrics {
  const pnls = trades.map((t) => t.pnl);
  const sum = (a: number[]) => a.reduce((s, x) => s + x, 0);
  const wins = pnls.filter((x) => x > 0);
  const losses = pnls.filter((x) => x <= 0);
  let cum = 0, peak = 0, dd = 0;
  for (const x of pnls) {
    cum += x;
    peak = Math.max(peak, cum);
    dd = Math.min(dd, cum - peak);
  }
  return {
    trades: trades.length,
    wins: wins.length,
    win_rate: trades.length ? (wins.length / trades.length) * 100 : null,
    net_pnl: sum(pnls),
    avg_pnl: trades.length ? sum(pnls) / trades.length : null,
    profit_factor: losses.length && sum(losses) < 0 ? sum(wins) / -sum(losses) : null,
    max_drawdown: dd,
    best: pnls.length ? Math.max(...pnls) : null,
    worst: pnls.length ? Math.min(...pnls) : null,
    targets: trades.filter((t) => t.exit_reason === "target").length,
    stops: trades.filter((t) => t.exit_reason === "stop").length,
    time_exits: trades.filter((t) => t.exit_reason === "time").length,
    avg_capital: trades.length ? sum(trades.map((t) => t.capital)) / trades.length : null,
    avg_margin: trades.length ? sum(trades.map((t) => t.margin)) / trades.length : null,
    peak_margin: trades.length ? Math.max(...trades.map((t) => t.margin)) : null,
    return_on_margin_pct: trades.length && Math.max(...trades.map((t) => t.margin)) > 0
      ? (sum(pnls) / Math.max(...trades.map((t) => t.margin))) * 100
      : null,
  };
}

export const TARGET_STEPS: Record<T_Side, number[]> = {
  buy: Array.from({ length: 40 }, (_, i) => +(1.05 + i * 0.05).toFixed(2)), // 1.05× … 3.00×
  sell: Array.from({ length: 19 }, (_, i) => 5 + i * 5), // keep 5% … 95%
};
export const STOP_STEPS: (number | null)[] = [10, 20, 30, 40, 50, 75, 100, 150, null];

// One level for every selected day, overriding per-day levels (for sweeps and maps).
const withLevels = (rules: T_StraddleRules, lv: T_Levels): T_StraddleRules => ({
  ...rules,
  perDte: false,
  levels: { ...rules.levels, [rules.side]: lv },
});

// Net P&L and hit rate for every target under the other current rules ("which target?"). The sell
// side keeps the current stop. Per-day levels are replaced by the swept target on every day.
export function sweepTargets(days: T_StraddleDay[], rules: T_StraddleRules, p: T_StraddleParams) {
  const stop = rules.levels[rules.side].stop;
  return TARGET_STEPS[rules.side].map((target) => {
    const { trades, metrics } = simulateStraddle(days, withLevels(rules, { target, stop }), p);
    return { target, net_pnl: metrics.net_pnl, win_rate: metrics.win_rate, hit_rate: trades.length ? (metrics.targets / trades.length) * 100 : 0 };
  });
}

// Sell side: net P&L for every target × stop pair (rows = stops, columns = targets).
export function sellMap(days: T_StraddleDay[], rules: T_StraddleRules, p: T_StraddleParams) {
  const targets = TARGET_STEPS.sell.filter((x) => x % 10 === 0 || x === 5 || x === 95);
  return {
    targets,
    rows: STOP_STEPS.map((stop) => ({
      stop,
      cells: targets.map((target) => ({ target, stop, ...simulateStraddle(days, withLevels({ ...rules, side: "sell" }, { target, stop }), p).metrics })),
    })),
  };
}

// The target with the best net P&L on each DTE (keeping that DTE's stop), for "apply best per day".
export function bestTargetPerDte(days: T_StraddleDay[], rules: T_StraddleRules, p: T_StraddleParams) {
  const dtes = [...new Set(days.map((d) => d.dte))].sort((a, b) => a - b);
  return dtes.map((dte) => {
    const stop = levelsFor(rules, dte).stop;
    const only = { ...rules, dtes: [dte] };
    const best = TARGET_STEPS[rules.side]
      .map((target) => ({ target, net: simulateStraddle(days, withLevels(only, { target, stop }), p).metrics.net_pnl }))
      .reduce((b, x) => (x.net > b.net ? x : b));
    return { dte, ...best };
  });
}

// Every loaded entry time under the other current rules.
export const compareEntries = (days: T_StraddleDay[], rules: T_StraddleRules, entries: string[], p: T_StraddleParams) =>
  entries.map((entry) => ({ entry, ...simulateStraddle(days, { ...rules, entry }, p).metrics }));

// Every DTE on its own under the other current rules (independent of the DTE filter).
export function compareDtes(days: T_StraddleDay[], rules: T_StraddleRules, p: T_StraddleParams) {
  const dtes = [...new Set(days.map((d) => d.dte))].sort((a, b) => a - b);
  return dtes.map((dte) => ({ dte, ...simulateStraddle(days, { ...rules, dtes: [dte] }, p).metrics }));
}

// Straddle runs saved before multiple entry times existed had one `path` per day and an `entry_time`
// param; convert them so they open in the current lab.
type T_LegacyDay = { date: string; expiry: string; dte: number; spot: number; atm: number; ce_entry: number; pe_entry: number; entry_minute: string; path: { t: string[] } & Omit<T_StraddlePath, "t"> };

export function normalizeStraddleDays(days: unknown[], params: { entry_time?: string; entry_times?: string[] }): { days: T_StraddleDay[]; entries: string[] } {
  if (!days.length || "entries" in (days[0] as object)) {
    return { days: days as T_StraddleDay[], entries: params.entry_times ?? [] };
  }
  const key = params.entry_time ?? "09:30";
  return {
    entries: [key],
    days: (days as T_LegacyDay[]).map((d) => ({
      date: d.date,
      expiry: d.expiry,
      dte: d.dte,
      entries: {
        [key]: {
          spot: d.spot,
          atm: d.atm,
          ce_entry: d.ce_entry,
          pe_entry: d.pe_entry,
          entry_at: `${d.date} ${d.entry_minute}`,
          path: { ...d.path, t: d.path.t.map((m) => `${d.date} ${m}`) },
        },
      },
    })),
  };
}
