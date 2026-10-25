// StrategySpec v1 on the client: types mirroring app/strategy/spec.py, the indicator catalog for the
// condition builder, leg presets, the plain-English summary and an illustrative payoff at expiry.

export type T_TF = "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "60m";
export type T_IndName =
  | "price" | "ema" | "sma" | "rsi" | "vwap" | "macd" | "supertrend" | "bbands" | "atr"
  | "orb" | "prev_day" | "day_open" | "gap_pct" | "value";

export type T_Operand = { ind: T_IndName; params?: Record<string, number | string>; field?: string | null; tf?: T_TF | null };
export type T_Op = ">" | "<" | ">=" | "<=" | "crosses_above" | "crosses_below";
export type T_Rule = { left: T_Operand; op: T_Op; right: T_Operand };
export type T_Group = { all?: T_Cond[]; any?: T_Cond[] };
export type T_Cond = T_Rule | T_Group;

export type T_Level = { unit: "pct" | "rupees" | "points"; value: number };
export type T_StrikeBy = "atm_offset" | "points" | "pct_otm" | "premium" | "delta";
export type T_Leg = {
  id: string;
  action: "buy" | "sell";
  instrument: "CE" | "PE" | "FUT";
  strike: { by: T_StrikeBy; value: number };
  expiry: { by: "weekly" | "monthly"; n: number; skip_expiry_day?: boolean };
  lots: number;
  exits?: { target?: T_Level | null; stop?: T_Level | null } | null;
};
export type T_Combined = { target?: T_Level | null; stop?: T_Level | null; trailing?: { activate: T_Level; trail: T_Level } | null };

export type T_Spec = {
  spec_version?: 1;
  name: string;
  description?: string;
  underlying: "NIFTY" | "SENSEX";
  timeframe: T_TF;
  lots: number;
  lot_size?: number | null;
  schedule: {
    weekdays?: number[] | null;
    dte?: number[] | null;
    entry: {
      type: "time" | "signal";
      time: string;
      prev_day?: boolean;
      signal?: T_Cond | null;
      bullish?: T_Cond | null;
      bearish?: T_Cond | null;
      window_start: string;
      last_entry: string;
    };
    max_trades_per_day: number;
    reentry_after_stop: number;
  };
  position: { legs?: T_Leg[] | null; bullish?: T_Leg[] | null; bearish?: T_Leg[] | null; bearish_mirror?: boolean };
  exits: {
    evaluation: { mode: "intrabar" | "close"; every: T_TF };
    pnl_basis: "gross" | "net";
    combined: T_Combined;
    per_leg?: { target?: T_Level | null; stop?: T_Level | null; on_stop: "keep_others" | "exit_all" | "others_to_cost" } | null;
    dte_overrides: Record<string, T_Combined>;
    square_off: string;
    spot_move_points?: number | null;
    exit_signal?: T_Cond | null;
    exit_on_opposite_signal?: boolean;
  };
  risk: { max_loss_per_day?: number | null };
  costs: { brokerage_per_order: number; slippage_points: number; taxes: boolean };
};

export type T_Template = { id: string; category: string; name: string; description: string; spec: T_Spec };

// ---------- catalog ----------

export const TIMEFRAMES: T_TF[] = ["1m", "3m", "5m", "10m", "15m", "30m", "60m"];
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
export const STEP: Record<string, number> = { NIFTY: 50, SENSEX: 100 };
export const SAMPLE_SPOT: Record<string, number> = { NIFTY: 25000, SENSEX: 82000 };

export type T_IndDef = { label: string; params: { key: string; label: string; default: number | string }[]; fields?: string[]; usesTf: boolean };
export const INDICATORS: Record<T_IndName, T_IndDef> = {
  price: { label: "Price", params: [], fields: ["close", "open", "high", "low"], usesTf: true },
  ema: { label: "EMA", params: [{ key: "period", label: "Period", default: 20 }], usesTf: true },
  sma: { label: "SMA", params: [{ key: "period", label: "Period", default: 20 }], usesTf: true },
  rsi: { label: "RSI", params: [{ key: "period", label: "Period", default: 14 }], usesTf: true },
  vwap: { label: "VWAP", params: [], usesTf: true },
  macd: { label: "MACD", params: [{ key: "fast", label: "Fast", default: 12 }, { key: "slow", label: "Slow", default: 26 }, { key: "signal", label: "Signal", default: 9 }], fields: ["line", "signal", "hist"], usesTf: true },
  supertrend: { label: "Supertrend", params: [{ key: "period", label: "Period", default: 10 }, { key: "multiplier", label: "Multiplier", default: 3 }], fields: ["value", "direction"], usesTf: true },
  bbands: { label: "Bollinger Bands", params: [{ key: "period", label: "Period", default: 20 }, { key: "std", label: "Std dev", default: 2 }], fields: ["upper", "mid", "lower"], usesTf: true },
  atr: { label: "ATR", params: [{ key: "period", label: "Period", default: 14 }], usesTf: true },
  orb: { label: "Opening range", params: [{ key: "start", label: "From", default: "09:15" }, { key: "end", label: "To", default: "09:30" }], fields: ["high", "low"], usesTf: true },
  prev_day: { label: "Previous day", params: [], fields: ["high", "low", "close"], usesTf: false },
  day_open: { label: "Day open", params: [], usesTf: false },
  gap_pct: { label: "Gap % at open", params: [], usesTf: false },
  value: { label: "Number", params: [{ key: "value", label: "Value", default: 0 }], usesTf: false },
};

export const OPS: { value: T_Op; label: string }[] = [
  { value: "crosses_above", label: "crosses above" },
  { value: "crosses_below", label: "crosses below" },
  { value: ">", label: ">" },
  { value: "<", label: "<" },
  { value: ">=", label: "≥" },
  { value: "<=", label: "≤" },
];

export const STRIKE_BY: { value: T_StrikeBy; label: string; unit: string }[] = [
  { value: "atm_offset", label: "ATM ± strikes", unit: "strikes" },
  { value: "points", label: "ATM ± points", unit: "pts" },
  { value: "pct_otm", label: "% OTM", unit: "%" },
  { value: "premium", label: "Closest premium", unit: "₹" },
  { value: "delta", label: "Closest delta", unit: "Δ" },
];

// ---------- builders ----------

export const isGroup = (c: T_Cond): c is T_Group => "all" in c || "any" in c;
export const operand = (ind: T_IndName): T_Operand => ({
  ind,
  params: Object.fromEntries(INDICATORS[ind].params.map((p) => [p.key, p.default])),
  field: INDICATORS[ind].fields?.[0] ?? null,
  tf: null,
});
export const newRule = (): T_Rule => ({ left: { ...operand("ema"), params: { period: 9 } }, op: "crosses_above", right: { ...operand("ema"), params: { period: 21 } } });

export function newLeg(existing: T_Leg[], over: Partial<T_Leg> = {}): T_Leg {
  let i = existing.length + 1;
  while (existing.some((l) => l.id === `leg${i}`)) i++;
  return { id: `leg${i}`, action: "buy", instrument: "CE", strike: { by: "atm_offset", value: 0 }, expiry: { by: "weekly", n: 0 }, lots: 1, ...over };
}

const L = (id: string, action: "buy" | "sell", instrument: "CE" | "PE" | "FUT", value = 0, lots = 1, by: T_StrikeBy = "atm_offset"): T_Leg =>
  ({ id, action, instrument, strike: { by, value }, expiry: { by: "weekly", n: 0 }, lots });

export const LEG_PRESETS: { key: string; label: string; legs: T_Leg[] }[] = [
  { key: "long_straddle", label: "Long straddle", legs: [L("ce", "buy", "CE"), L("pe", "buy", "PE")] },
  { key: "short_straddle", label: "Short straddle", legs: [L("ce", "sell", "CE"), L("pe", "sell", "PE")] },
  { key: "short_strangle", label: "Short strangle", legs: [L("ce", "sell", "CE", 4), L("pe", "sell", "PE", -4)] },
  { key: "long_strangle", label: "Long strangle", legs: [L("ce", "buy", "CE", 4), L("pe", "buy", "PE", -4)] },
  { key: "iron_condor", label: "Iron condor", legs: [L("sell_ce", "sell", "CE", 4), L("buy_ce", "buy", "CE", 8), L("sell_pe", "sell", "PE", -4), L("buy_pe", "buy", "PE", -8)] },
  { key: "iron_fly", label: "Iron fly", legs: [L("sell_ce", "sell", "CE"), L("sell_pe", "sell", "PE"), L("buy_ce", "buy", "CE", 4), L("buy_pe", "buy", "PE", -4)] },
  { key: "call_fly", label: "Call butterfly", legs: [L("lo", "buy", "CE"), L("body", "sell", "CE", 4, 2), L("hi", "buy", "CE", 8)] },
  { key: "bull_call", label: "Bull call spread", legs: [L("long", "buy", "CE"), L("short", "sell", "CE", 4)] },
  { key: "bear_put", label: "Bear put spread", legs: [L("long", "buy", "PE"), L("short", "sell", "PE", -4)] },
  { key: "long_call", label: "Long call", legs: [L("ce", "buy", "CE")] },
  { key: "long_put", label: "Long put", legs: [L("pe", "buy", "PE")] },
  { key: "long_fut", label: "Long future", legs: [{ ...L("fut", "buy", "FUT"), expiry: { by: "monthly", n: 0 } }] },
];

export const BLANK_SPEC: T_Spec = {
  name: "Untitled strategy",
  description: "",
  underlying: "NIFTY",
  timeframe: "5m",
  lots: 1,
  lot_size: null,
  schedule: {
    weekdays: null,
    dte: null,
    entry: { type: "time", time: "09:20", prev_day: false, signal: null, bullish: null, bearish: null, window_start: "09:15", last_entry: "15:00" },
    max_trades_per_day: 1,
    reentry_after_stop: 0,
  },
  position: { legs: LEG_PRESETS[1].legs, bullish: null, bearish: null, bearish_mirror: false },
  exits: {
    evaluation: { mode: "intrabar", every: "5m" },
    pnl_basis: "gross",
    combined: { target: { unit: "pct", value: 50 }, stop: { unit: "pct", value: 30 }, trailing: null },
    per_leg: null,
    dte_overrides: {},
    square_off: "15:15",
    spot_move_points: null,
    exit_signal: null,
    exit_on_opposite_signal: false,
  },
  risk: { max_loss_per_day: null },
  costs: { brokerage_per_order: 20, slippage_points: 0.5, taxes: true },
};

// Fill every optional field the server may omit, so editors can rely on them.
export function normalizeSpec(s: Partial<T_Spec>): T_Spec {
  const b = BLANK_SPEC;
  return {
    ...b,
    ...s,
    schedule: { ...b.schedule, ...s.schedule, entry: { ...b.schedule.entry, ...s.schedule?.entry } },
    position: { ...b.position, legs: null, ...s.position },
    exits: {
      ...b.exits,
      ...s.exits,
      evaluation: { ...b.exits.evaluation, ...s.exits?.evaluation },
      combined: { ...(s.exits?.combined ?? b.exits.combined) },
      dte_overrides: s.exits?.dte_overrides ?? {},
    },
    risk: { ...b.risk, ...s.risk },
    costs: { ...b.costs, ...s.costs },
  } as T_Spec;
}

export const isDirectional = (s: T_Spec) => s.schedule.entry.type === "signal" && (s.schedule.entry.bullish != null || s.schedule.entry.bearish != null);

// ---------- plain English ----------

const lv = (l: T_Level | null | undefined, sign: "+" | "−") =>
  !l ? null : l.unit === "pct" ? `${sign}${l.value}% of premium` : l.unit === "rupees" ? `${sign}₹${l.value.toLocaleString("en-IN")}` : `${sign}${l.value} pts`;

export function describeOperand(o: T_Operand, tf: T_TF): string {
  const def = INDICATORS[o.ind];
  if (o.ind === "value") return String(o.params?.value ?? 0);
  const params = def.params.map((p) => o.params?.[p.key] ?? p.default).join(", ");
  const field = def.fields && o.field && o.field !== def.fields[0] ? ` ${o.field}` : "";
  const name = o.ind === "price" ? `${o.field ?? "close"} price` : `${def.label}${params ? `(${params})` : ""}${field}`;
  return def.usesTf ? `${name} on ${o.tf ?? tf}` : name;
}

export function describeCond(c: T_Cond | null | undefined, tf: T_TF): string {
  if (!c) return "—";
  if (isGroup(c)) {
    const parts = (c.all ?? c.any ?? []).map((x) => describeCond(x, tf));
    return parts.length > 1 ? `(${parts.join(c.all ? " AND " : " OR ")})` : parts[0] ?? "—";
  }
  return `${describeOperand(c.left, tf)} ${OPS.find((o) => o.value === c.op)?.label} ${describeOperand(c.right, tf)}`;
}

export function describeLeg(l: T_Leg, spec: T_Spec): string {
  const lots = spec.lots * l.lots;
  const what = l.instrument === "FUT" ? "future" : l.instrument;
  let strike = "";
  if (l.instrument !== "FUT") {
    const v = l.strike.value;
    strike = {
      atm_offset: v === 0 ? "ATM" : `ATM${v > 0 ? "+" : "−"}${Math.abs(v)} strikes`,
      points: v === 0 ? "ATM" : `ATM${v > 0 ? "+" : "−"}${Math.abs(v)} pts`,
      pct_otm: `${v}% OTM`,
      premium: `strike nearest ₹${v} premium`,
      delta: `strike nearest ${v} delta`,
    }[l.strike.by] + " ";
  }
  const exp = `${l.expiry.n === 0 ? "nearest" : l.expiry.n === 1 ? "next" : `${l.expiry.n + 1}th`} ${l.expiry.by}`;
  return `${l.action} ${lots} lot${lots > 1 ? "s" : ""} ${strike}${what} (${exp})`;
}

export function describeSpec(s: T_Spec): string[] {
  const out: string[] = [];
  const e = s.schedule.entry;
  const days = [
    s.schedule.weekdays ? s.schedule.weekdays.map((d) => WEEKDAYS[d]).join(", ") : "every trading day",
    s.schedule.dte ? `on ${s.schedule.dte.map((d) => `${d}DTE`).join("/")} days` : "",
  ].filter(Boolean).join(" ");
  if (e.type === "time") {
    out.push(e.prev_day
      ? `Trade ${s.underlying} ${days}: enter at ${e.time} on the previous trading day and hold overnight.`
      : `Trade ${s.underlying} ${days}, entering at ${e.time}.`);
  } else if (isDirectional(s)) {
    out.push(`Trade ${s.underlying} ${days}. Between ${e.window_start} and ${e.last_entry}, at the next minute after a ${s.timeframe} candle closes:`);
    if (e.bullish) out.push(`• Bullish when ${describeCond(e.bullish, s.timeframe)}.`);
    if (e.bearish) out.push(`• Bearish when ${describeCond(e.bearish, s.timeframe)}.`);
  } else {
    out.push(`Trade ${s.underlying} ${days}. Enter between ${e.window_start} and ${e.last_entry} when ${describeCond(e.signal, s.timeframe)} (${s.timeframe} candle close).`);
  }
  const p = s.position;
  if (isDirectional(s)) {
    if (p.bullish?.length) out.push(`Bullish: ${p.bullish.map((l) => describeLeg(l, s)).join("; ")}.`);
    if (p.bearish_mirror) out.push("Bearish: the same legs mirrored (calls ↔ puts).");
    else if (p.bearish?.length) out.push(`Bearish: ${p.bearish.map((l) => describeLeg(l, s)).join("; ")}.`);
  } else if (p.legs?.length) {
    out.push(`${p.legs.map((l) => describeLeg(l, s)).join("; ")}.`.replace(/^./, (c) => c.toUpperCase()));
  }
  const x = s.exits;
  const parts = [lv(x.combined.target, "+") && `target ${lv(x.combined.target, "+")}`, lv(x.combined.stop, "−") && `stop ${lv(x.combined.stop, "−")}`].filter(Boolean);
  if (x.combined.trailing) parts.push(`trail ${lv(x.combined.trailing.trail, "−")} from the peak once ${lv(x.combined.trailing.activate, "+")}`);
  if (parts.length) out.push(`Whole position: ${parts.join(", ")} (${x.pnl_basis === "net" ? "after" : "before"} costs, ${x.evaluation.mode === "intrabar" ? "checked every minute on highs/lows" : `checked at each ${x.evaluation.every} close`}).`);
  if (x.per_leg && (x.per_leg.target || x.per_leg.stop)) {
    const leg = [lv(x.per_leg.target, "+") && `target ${lv(x.per_leg.target, "+")}`, lv(x.per_leg.stop, "−") && `stop ${lv(x.per_leg.stop, "−")}`].filter(Boolean).join(", ");
    out.push(`Each leg: ${leg} of its own premium; after a leg stop ${{ keep_others: "the other legs keep running", exit_all: "everything is closed", others_to_cost: "the other legs' stops move to cost" }[x.per_leg.on_stop]}.`);
  }
  const ov = Object.keys(x.dte_overrides ?? {});
  if (ov.length) out.push(`Different levels on ${ov.map((d) => `${d}DTE`).join(", ")}.`);
  const more = [
    x.spot_move_points ? `spot moves ${x.spot_move_points} pts` : null,
    x.exit_signal ? describeCond(x.exit_signal, s.timeframe) : null,
    x.exit_on_opposite_signal ? "the opposite signal fires" : null,
  ].filter(Boolean);
  if (more.length) out.push(`Also exit when ${more.join(", or ")}.`);
  out.push(`Square off at ${x.square_off}.${s.risk.max_loss_per_day ? ` Stop trading for the day after a ₹${s.risk.max_loss_per_day.toLocaleString("en-IN")} loss.` : ""}${s.schedule.max_trades_per_day > 1 ? ` Up to ${s.schedule.max_trades_per_day} trades a day.` : ""}${s.schedule.reentry_after_stop ? ` Re-enter up to ${s.schedule.reentry_after_stop}× after a stop.` : ""}`);
  out.push(`Costs: ₹${s.costs.brokerage_per_order}/order, ${s.costs.slippage_points} pt slippage per leg, taxes ${s.costs.taxes ? "included" : "excluded"}.`);
  return out;
}

// ---------- illustrative payoff ----------

const ncdf = (x: number) => 0.5 * (1 + erf(x / Math.SQRT2));
function erf(x: number) {
  const t = 1 / (1 + 0.3275911 * Math.abs(x));
  const y = 1 - ((((1.061405429 * t - 1.453152027) * t + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x);
  return x >= 0 ? y : -y;
}
function bs(spot: number, k: number, t: number, vol: number, call: boolean, r = 0.065) {
  const d1 = (Math.log(spot / k) + (r + (vol * vol) / 2) * t) / (vol * Math.sqrt(t));
  const d2 = d1 - vol * Math.sqrt(t);
  return call ? spot * ncdf(d1) - k * Math.exp(-r * t) * ncdf(d2) : k * Math.exp(-r * t) * ncdf(-d2) - spot * ncdf(-d1);
}

export type T_PayoffLeg = { label: string; side: number; call: boolean | null; strike: number; price: number; qty: number };

// Legs at a sample spot with Black-Scholes prices (12% IV, ~3 days to expiry) and the P&L at expiry
// across ±4%. For shape only: real fills come from market data in the backtest.
export function samplePayoff(s: T_Spec, legs: T_Leg[]) {
  const spot = SAMPLE_SPOT[s.underlying];
  const step = STEP[s.underlying];
  const atm = Math.round(spot / step) * step;
  const t = 3 / 365;
  const vol = 0.12;
  const lotSize = s.lot_size ?? (s.underlying === "NIFTY" ? 65 : 20);
  const out: T_PayoffLeg[] = legs.map((l) => {
    const call = l.instrument === "CE" ? true : l.instrument === "PE" ? false : null;
    let strike = atm;
    if (call !== null) {
      const otm = call ? 1 : -1;
      const v = l.strike.value;
      if (l.strike.by === "atm_offset") strike = atm + Math.round(v) * step;
      else if (l.strike.by === "points") strike = atm + Math.round(v / step) * step;
      else if (l.strike.by === "pct_otm") strike = Math.round((spot * (1 + (otm * v) / 100)) / step) * step;
      else {
        let best = atm, err = Infinity;
        for (let k = 0; k <= 40; k++) {
          const kk = atm + otm * k * step;
          const p = bs(spot, kk, t, vol, call);
          const metric = l.strike.by === "premium" ? p : Math.abs(ncdf((Math.log(spot / kk) + (0.065 + vol * vol / 2) * t) / (vol * Math.sqrt(t))) - (call ? 0 : 1));
          const e2 = Math.abs(metric - v);
          if (e2 < err) { err = e2; best = kk; }
        }
        strike = best;
      }
    }
    const price = call === null ? spot : bs(spot, strike, t, vol, call);
    return { label: l.id, side: l.action === "buy" ? 1 : -1, call, strike, price, qty: s.lots * l.lots * lotSize };
  });
  const points = Array.from({ length: 81 }, (_, i) => {
    const x = spot * (0.96 + (0.08 * i) / 80);
    const pnl = out.reduce((acc, l) => {
      const value = l.call === null ? x : l.call ? Math.max(0, x - l.strike) : Math.max(0, l.strike - x);
      return acc + l.side * l.qty * (value - l.price);
    }, 0);
    return { spot: Math.round(x), pnl: Math.round(pnl) };
  });
  const premium = out.reduce((a, l) => a + l.side * l.qty * l.price, 0);
  return { spot, legs: out, points, premium, maxProfit: Math.max(...points.map((p) => p.pnl)), maxLoss: Math.min(...points.map((p) => p.pnl)) };
}
