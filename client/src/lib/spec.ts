// StrategySpec v1 on the client: types mirroring app/strategy/spec.py, the indicator catalog for the
// condition builder, leg presets, the plain-English summary and an illustrative payoff at expiry.

export type T_TF = "1m" | "3m" | "5m" | "10m" | "15m" | "30m" | "60m" | "1d" | "1w";
export type T_BuiltinInd =
  | "price" | "ema" | "sma" | "rsi" | "vwap" | "macd" | "supertrend" | "bbands" | "atr"
  | "orb" | "prev_day" | "day_open" | "gap_pct" | "value"
  | "chg_pct" | "adx" | "bb_width" | "rv" | "hv" | "prev_range_pct"
  | "weekday" | "dte" | "regime";
// Built-ins are typed; the extended library (GET /strategies/indicators) adds names at runtime.
export type T_IndName = T_BuiltinInd | (string & {});

// value = indicator(shift candles ago) × mul + add. params.symbol (e.g. "VIX") reads another series' daily candles.
export type T_Operand = {
  ind: T_IndName;
  params?: Record<string, number | string>;
  field?: string | null;
  tf?: T_TF | null;
  shift?: number;
  mul?: number;
  add?: number;
};
export type T_Op = ">" | "<" | ">=" | "<=" | "==" | "!=" | "crosses_above" | "crosses_below";
export type T_Rule = { left: T_Operand; op: T_Op; right: T_Operand };
export type T_Group = { all?: T_Cond[]; any?: T_Cond[]; min?: number }; // any + min: at least `min` of them (a vote)
export type T_Cond = T_Rule | T_Group;

export type T_Level = { unit: "pct" | "rupees" | "points"; value: number };
export type T_StrikeBy = "atm_offset" | "points" | "pct_otm" | "premium" | "delta";
export type T_Leg = {
  id: string;
  action: "buy" | "sell";
  instrument: "CE" | "PE" | "FUT";
  strike: { by: T_StrikeBy; value: number };
  expiry: { by: "weekly" | "monthly"; n: number; skip_expiry_day?: boolean; min_days?: number };
  lots: number;
  exits?: { target?: T_Level | null; stop?: T_Level | null } | null;
};
export type T_Combined = { target?: T_Level | null; stop?: T_Level | null; trailing?: { activate: T_Level; trail: T_Level } | null };

// Stop on the underlying's move against the position (ATR of `tf` at entry, or fixed points), optionally trailing.
export type T_UnderlyingStop = {
  atr_mult: number | null;
  atr_period: number;
  tf: T_TF;
  points: number | null;
  trail: boolean;
  target_mult: number | null;
};

// intraday: closed by exits.square_off on the trade day. swing: held across days (up to max_days), closed at
// exit_time on the last day, option legs exit_before_expiry trading days before expiry, exits checked each `check` close.
export type T_Holding = { mode: "intraday" | "swing"; max_days: number; exit_time: string; exit_before_expiry: number; check: T_TF };

export type T_Entry = {
  type: "time" | "signal";
  time: string;
  times?: string[] | null; // time entries: several a day (overrides `time`)
  prev_day?: boolean;
  signal?: T_Cond | null;
  bullish?: T_Cond | null;
  bearish?: T_Cond | null;
  filter?: T_Cond | null; // time entries: trade only when this holds
  window_start: string;
  last_entry: string;
  next_day_time?: string; // swing: entry time for signals on 1d / 1w candles (known after the close)
};

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
    entry: T_Entry;
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
    exit_bullish?: T_Cond | null; // directional: exit condition for bullish (long) trades
    exit_bearish?: T_Cond | null; // … and for bearish (short) trades
    exit_on_opposite_signal?: boolean;
    underlying_stop?: T_UnderlyingStop | null;
  };
  risk: { max_loss_per_day?: number | null };
  costs: { brokerage_per_order: number; slippage_points: number; fut_slippage_points?: number; taxes: boolean };
  holding?: T_Holding;
};

export type T_Template = { id: string; category: string; name: string; description: string; spec: T_Spec };

// GET /strategies/indicators
export type T_ExtIndicator = { name: string; fields: string[]; params: Record<string, number | string>; description: string; category: string };
export type T_IndicatorCatalogue = { builtin: string[]; extended: T_ExtIndicator[] };

// ---------- catalog ----------

export const TIMEFRAMES: T_TF[] = ["1m", "3m", "5m", "10m", "15m", "30m", "60m", "1d", "1w"];
export const INTRADAY_TFS: T_TF[] = ["1m", "3m", "5m", "10m", "15m", "30m", "60m"];
export const DAILY_TFS: T_TF[] = ["1d", "1w"];
export const isDailyTf = (tf: T_TF | null | undefined) => !!tf && DAILY_TFS.includes(tf);
export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri"];
export const STEP: Record<string, number> = { NIFTY: 50, SENSEX: 100 };
export const SAMPLE_SPOT: Record<string, number> = { NIFTY: 25000, SENSEX: 82000 };

export type T_ParamDef = { key: string; label: string; default: number | string; options?: { value: string; label: string }[] };
export type T_IndDef = {
  label: string;
  params: T_ParamDef[];
  fields?: string[];
  usesTf: boolean;
  group: string; // Select group
  description?: string;
  // Categorical values: the number it's compared with is picked from these labels.
  values?: (o: T_Operand) => { value: number; label: string }[];
};

export const REGIME_MODELS = [
  { value: "trend_vol", label: "Trend × volatility" },
  { value: "trend", label: "Trend" },
  { value: "vol", label: "Volatility" },
];
// app/strategy/regimes.py MODELS
export const REGIME_LABELS: Record<string, { value: number; label: string }[]> = {
  trend_vol: [
    { value: 1, label: "Uptrend · calm" }, { value: 2, label: "Uptrend · volatile" }, { value: 3, label: "Range · calm" },
    { value: 4, label: "Range · volatile" }, { value: 5, label: "Downtrend · calm" }, { value: 6, label: "Downtrend · volatile" },
  ],
  trend: [{ value: 1, label: "Uptrend" }, { value: 0, label: "Range" }, { value: -1, label: "Downtrend" }],
  vol: [{ value: 0, label: "Calm" }, { value: 1, label: "Volatile" }],
};

const P = (key: string, label: string, def: number | string): T_ParamDef => ({ key, label, default: def });
export const INDICATORS: Record<T_BuiltinInd, T_IndDef> = {
  price: { label: "Price", params: [], fields: ["close", "open", "high", "low"], usesTf: true, group: "Price & levels" },
  ema: { label: "EMA", params: [P("period", "Period", 20)], usesTf: true, group: "Trend" },
  sma: { label: "SMA", params: [P("period", "Period", 20)], usesTf: true, group: "Trend" },
  rsi: { label: "RSI", params: [P("period", "Period", 14)], usesTf: true, group: "Momentum" },
  vwap: { label: "VWAP", params: [], usesTf: true, group: "Price & levels" },
  macd: { label: "MACD", params: [P("fast", "Fast", 12), P("slow", "Slow", 26), P("signal", "Signal", 9)], fields: ["line", "signal", "hist"], usesTf: true, group: "Momentum" },
  supertrend: { label: "Supertrend", params: [P("period", "Period", 10), P("multiplier", "Multiplier", 3)], fields: ["value", "direction"], usesTf: true, group: "Trend" },
  bbands: { label: "Bollinger Bands", params: [P("period", "Period", 20), P("std", "Std dev", 2)], fields: ["upper", "mid", "lower"], usesTf: true, group: "Volatility" },
  atr: { label: "ATR", params: [P("period", "Period", 14)], usesTf: true, group: "Volatility" },
  adx: { label: "ADX", params: [P("period", "Period", 14)], fields: ["adx", "plus", "minus"], usesTf: true, group: "Trend", description: "Trend strength (adx) and +DI / −DI" },
  bb_width: { label: "BB width %", params: [P("period", "Period", 20), P("std", "Std dev", 2)], usesTf: true, group: "Volatility", description: "(upper − lower) / middle band, %" },
  rv: { label: "Realised vol %", params: [P("period", "Period", 20)], usesTf: true, group: "Volatility", description: "Std dev of this timeframe's returns over N candles, scaled to one day, %" },
  hv: { label: "Historical vol % (daily)", params: [P("period", "Days", 20)], usesTf: false, group: "Volatility", description: "Annualised volatility of daily closes over the N days before today, %" },
  orb: { label: "Opening range", params: [P("start", "From", "09:15"), P("end", "To", "09:30")], fields: ["high", "low"], usesTf: true, group: "Price & levels" },
  prev_day: { label: "Previous day", params: [], fields: ["high", "low", "close"], usesTf: false, group: "Price & levels" },
  day_open: { label: "Day open", params: [], usesTf: false, group: "Price & levels" },
  gap_pct: { label: "Gap % at open", params: [], usesTf: false, group: "Price & levels" },
  chg_pct: { label: "% change today", params: [], fields: ["prev_close", "open"], usesTf: true, group: "Price & levels", description: "% change of the close from the previous close or today's open" },
  prev_range_pct: { label: "Prev. day range %", params: [], usesTf: false, group: "Volatility", description: "Previous day's high − low as % of its close" },
  weekday: { label: "Weekday", params: [], usesTf: false, group: "Calendar & regime", values: () => WEEKDAYS.map((label, value) => ({ value, label })) },
  dte: { label: "Days to expiry", params: [], usesTf: false, group: "Calendar & regime", description: "Trading days to the nearest weekly expiry (0 = expiry day)" },
  regime: {
    label: "Market regime",
    params: [{ key: "model", label: "Model", default: "trend_vol", options: REGIME_MODELS }],
    usesTf: false,
    group: "Calendar & regime",
    description: "Rule-based daily regime (SMA50 trend + ADX, India VIX percentile), known at the previous close",
    values: (o) => REGIME_LABELS[String(o.params?.model ?? "trend_vol")] ?? REGIME_LABELS.trend_vol,
  },
  value: { label: "Number", params: [P("value", "Value", 0)], usesTf: false, group: "Number" },
};
export const BUILTIN_GROUPS = ["Price & levels", "Trend", "Momentum", "Volatility", "Calendar & regime", "Number"];

const titleCase = (n: string) => n.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bPct\b/, "%");

// Definition of any indicator: built-in, from the extended catalogue, or (catalogue not loaded / unknown) a
// generic one built from the operand's own params so nothing is lost.
export function indDef(name: string, cat?: T_IndicatorCatalogue | null, o?: T_Operand): T_IndDef {
  if (name in INDICATORS) return INDICATORS[name as T_BuiltinInd];
  const ext = cat?.extended.find((x) => x.name === name);
  if (ext) {
    return {
      label: titleCase(ext.name),
      params: Object.entries(ext.params).map(([k, v]) => P(k, titleCase(k), v)),
      fields: ext.fields.length ? ext.fields : undefined,
      usesTf: true,
      group: ext.category,
      description: ext.description,
    };
  }
  return {
    label: titleCase(name),
    params: Object.entries(o?.params ?? {}).filter(([k]) => k !== "symbol").map(([k, v]) => P(k, titleCase(k), v)),
    fields: o?.field ? [o.field] : undefined,
    usesTf: true,
    group: "Library",
  };
}

export const OPS: { value: T_Op; label: string }[] = [
  { value: "crosses_above", label: "crosses above" },
  { value: "crosses_below", label: "crosses below" },
  { value: ">", label: ">" },
  { value: "<", label: "<" },
  { value: ">=", label: "≥" },
  { value: "<=", label: "≤" },
  { value: "==", label: "=" },
  { value: "!=", label: "≠" },
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
export const operand = (ind: T_IndName, cat?: T_IndicatorCatalogue | null): T_Operand => {
  const def = indDef(ind, cat);
  return { ind, params: Object.fromEntries(def.params.map((p) => [p.key, p.default])), field: def.fields?.[0] ?? null, tf: null };
};
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
    entry: {
      type: "time", time: "09:20", times: null, prev_day: false, signal: null, bullish: null, bearish: null, filter: null,
      window_start: "09:15", last_entry: "15:00", next_day_time: "09:20",
    },
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
    underlying_stop: null,
  },
  risk: { max_loss_per_day: null },
  costs: { brokerage_per_order: 20, slippage_points: 0.5, fut_slippage_points: 1, taxes: true },
  holding: { mode: "intraday", max_days: 5, exit_time: "15:20", exit_before_expiry: 0, check: "15m" },
};

export const DEFAULT_HOLDING: T_Holding = BLANK_SPEC.holding!;
export const DEFAULT_UNDERLYING_STOP: T_UnderlyingStop = { atr_mult: 2, atr_period: 14, tf: "1d", points: null, trail: false, target_mult: null };

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
    holding: { ...DEFAULT_HOLDING, ...s.holding },
  } as T_Spec;
}

// Directional = bullish / bearish conditions pick the legs (signal entries, or time entries read at the entry time).
export const isDirectional = (s: T_Spec) => s.schedule.entry.bullish != null || s.schedule.entry.bearish != null;
export const isSwing = (s: T_Spec) => s.holding?.mode === "swing";
export const entryTimes = (e: T_Entry) => (e.times?.length ? [...e.times].sort() : [e.time]);

// ---------- plain English ----------

const lv = (l: T_Level | null | undefined, sign: "+" | "−") =>
  !l ? null : l.unit === "pct" ? `${sign}${l.value}% of premium` : l.unit === "rupees" ? `${sign}₹${l.value.toLocaleString("en-IN")}` : `${sign}${l.value} pts`;

const num = (n: number) => String(+n.toFixed(4));

export function describeOperand(o: T_Operand, tf: T_TF): string {
  const def = indDef(o.ind, null, o);
  if (o.ind === "value") return String(o.params?.value ?? 0);
  const params = def.params.filter((p) => !p.options).map((p) => o.params?.[p.key] ?? p.default).join(", ");
  const field = def.fields && o.field && o.field !== def.fields[0] ? ` ${o.field}` : "";
  const symbol = o.params?.symbol ? `${o.params.symbol === "VIX" || o.params.symbol === "INDVIX" ? "India VIX" : o.params.symbol} ` : "";
  let name: string;
  if (o.ind === "price") name = `${symbol}${o.field ?? "close"}${symbol ? "" : " price"}`;
  else if (o.ind === "regime") name = `${REGIME_MODELS.find((m) => m.value === (o.params?.model ?? "trend_vol"))?.label ?? o.params?.model} regime`;
  else name = `${symbol}${def.label}${params ? `(${params})` : ""}${field}`;
  const otf = o.tf ?? tf;
  if (def.usesTf || o.params?.symbol) name += ` on ${o.params?.symbol && !isDailyTf(otf) ? "1d" : otf}`;
  if (o.shift) name += ` ${o.shift} candle${o.shift > 1 ? "s" : ""} ago`;
  if (o.mul != null && o.mul !== 1) name = `${num(o.mul)} × ${name}`;
  if (o.add) name += ` ${o.add > 0 ? "+" : "−"} ${num(Math.abs(o.add))}`;
  return name;
}

// The number a categorical operand (weekday, regime) is compared with, as its label.
function describeValue(left: T_Operand, right: T_Operand, tf: T_TF): string {
  const values = right.ind === "value" ? indDef(left.ind).values?.(left) : undefined;
  const v = Number(right.params?.value ?? 0);
  return values?.find((x) => x.value === v)?.label ?? describeOperand(right, tf);
}

export function describeCond(c: T_Cond | null | undefined, tf: T_TF): string {
  if (!c) return "—";
  if (isGroup(c)) {
    const parts = (c.all ?? c.any ?? []).map((x) => describeCond(x, tf));
    if (c.any && c.min) return `at least ${c.min} of (${parts.join("; ")})`;
    return parts.length > 1 ? `(${parts.join(c.all ? " AND " : " OR ")})` : parts[0] ?? "—";
  }
  const cat = indDef(c.left.ind).values ? (c.op === "==" ? "is" : c.op === "!=" ? "is not" : null) : null;
  return `${describeOperand(c.left, tf)} ${cat ?? OPS.find((o) => o.value === c.op)?.label} ${describeValue(c.left, c.right, tf)}`;
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
  const minDays = l.expiry.min_days ? `, at least ${l.expiry.min_days} trading days out` : "";
  return `${l.action} ${lots} lot${lots > 1 ? "s" : ""} ${strike}${what} (${exp}${minDays})`;
}

const lvUnderlying = (u: T_UnderlyingStop) => {
  const dist = u.points ? `${u.points} pts` : `${u.atr_mult ?? 2}× ATR(${u.atr_period}) on ${u.tf}`;
  const target = u.target_mult ? `; take profit at ${u.points ? `${num(u.target_mult * u.points)} pts` : `${u.target_mult}× ATR`}` : "";
  return `${u.trail ? "Trailing stop" : "Stop"} on ${dist} of index move against the trade${u.trail ? " (from the best price since entry)" : ""}${target}`;
};

export function describeSpec(s: T_Spec): string[] {
  const out: string[] = [];
  const e = s.schedule.entry;
  const swing = isSwing(s);
  const h = s.holding ?? DEFAULT_HOLDING;
  const days = [
    s.schedule.weekdays ? s.schedule.weekdays.map((d) => WEEKDAYS[d]).join(", ") : "every trading day",
    s.schedule.dte ? `on ${s.schedule.dte.map((d) => `${d}DTE`).join("/")} days` : "",
  ].filter(Boolean).join(" ");
  const directional = isDirectional(s);
  if (e.type === "time") {
    const times = entryTimes(e);
    if (e.prev_day) out.push(`Trade ${s.underlying} ${days}: enter at ${e.time} on the previous trading day and hold overnight.`);
    else if (times.length > 1) out.push(`Trade ${s.underlying} ${days}, trying an entry at ${times.join(", ")} (one position at a time; a time is skipped while a trade is open).`);
    else out.push(`Trade ${s.underlying} ${days}, entering at ${times[0]}.`);
    if (e.filter) out.push(`Only when ${describeCond(e.filter, s.timeframe)} (latest closed candle at the entry time).`);
    if (directional) {
      out.push("At the entry time, on the latest closed candle:");
      if (e.bullish) out.push(`• Bullish legs when ${describeCond(e.bullish, s.timeframe)}.`);
      if (e.bearish) out.push(`• Bearish legs when ${describeCond(e.bearish, s.timeframe)}.`);
      out.push("No trade when neither holds.");
    }
  } else {
    const when = swing && isDailyTf(s.timeframe)
      ? `After each ${s.timeframe} candle closes (15:30), entering at ${e.next_day_time ?? "09:20"} on the next trading day`
      : `Between ${e.window_start} and ${e.last_entry}, at the next minute after a ${s.timeframe} candle closes`;
    if (directional) {
      out.push(`Trade ${s.underlying} ${days}. ${when}:`);
      if (e.bullish) out.push(`• Bullish when ${describeCond(e.bullish, s.timeframe)}.`);
      if (e.bearish) out.push(`• Bearish when ${describeCond(e.bearish, s.timeframe)}.`);
    } else {
      out.push(`Trade ${s.underlying} ${days}. ${when}, enter when ${describeCond(e.signal, s.timeframe)}.`);
    }
  }
  const p = s.position;
  if (directional) {
    if (p.bullish?.length) out.push(`Bullish: ${p.bullish.map((l) => describeLeg(l, s)).join("; ")}.`);
    if (p.bearish_mirror) out.push("Bearish: the same legs mirrored (calls ↔ puts).");
    else if (p.bearish?.length) out.push(`Bearish: ${p.bearish.map((l) => describeLeg(l, s)).join("; ")}.`);
  } else if (p.legs?.length) {
    out.push(`${p.legs.map((l) => describeLeg(l, s)).join("; ")}.`.replace(/^./, (c) => c.toUpperCase()));
  }
  if (swing) {
    out.push(`Multi-day: hold up to ${h.max_days} trading day${h.max_days > 1 ? "s" : ""}, closing at ${h.exit_time} on the last day${h.exit_before_expiry ? `; option legs close ${h.exit_before_expiry} trading day${h.exit_before_expiry > 1 ? "s" : ""} before their expiry` : "; option legs may be held into expiry day"}. Exits checked at each ${h.check} close.`);
  }
  const x = s.exits;
  const parts = [lv(x.combined.target, "+") && `target ${lv(x.combined.target, "+")}`, lv(x.combined.stop, "−") && `stop ${lv(x.combined.stop, "−")}`].filter(Boolean);
  if (x.combined.trailing) parts.push(`trail ${lv(x.combined.trailing.trail, "−")} from the peak once ${lv(x.combined.trailing.activate, "+")}`);
  const checked = swing ? `checked at each ${h.check} close` : x.evaluation.mode === "intrabar" ? "checked every minute on highs/lows" : `checked at each ${x.evaluation.every} close`;
  if (parts.length) out.push(`Whole position: ${parts.join(", ")} (${x.pnl_basis === "net" ? "after" : "before"} costs, ${checked}).`);
  if (x.per_leg && (x.per_leg.target || x.per_leg.stop)) {
    const leg = [lv(x.per_leg.target, "+") && `target ${lv(x.per_leg.target, "+")}`, lv(x.per_leg.stop, "−") && `stop ${lv(x.per_leg.stop, "−")}`].filter(Boolean).join(", ");
    out.push(`Each leg: ${leg} of its own premium; after a leg stop ${{ keep_others: "the other legs keep running", exit_all: "everything is closed", others_to_cost: "the other legs' stops move to cost" }[x.per_leg.on_stop]}.`);
  }
  const ov = Object.keys(x.dte_overrides ?? {});
  if (ov.length) out.push(`Different levels on ${ov.map((d) => `${d}DTE`).join(", ")}.`);
  if (x.underlying_stop) out.push(`${lvUnderlying(x.underlying_stop)}, checked every minute.`);
  const more = [
    x.spot_move_points ? `spot moves ${x.spot_move_points} pts` : null,
    x.exit_signal ? describeCond(x.exit_signal, s.timeframe) : null,
    x.exit_bullish ? `longs: ${describeCond(x.exit_bullish, s.timeframe)}` : null,
    x.exit_bearish ? `shorts: ${describeCond(x.exit_bearish, s.timeframe)}` : null,
    x.exit_on_opposite_signal ? "the opposite signal fires" : null,
  ].filter(Boolean);
  if (more.length) out.push(`Also exit when ${more.join(", or ")}.`);
  const nTimes = e.type === "time" ? entryTimes(e).length : 1;
  out.push(`${swing ? "" : `Square off at ${x.square_off}.`}${s.risk.max_loss_per_day ? ` Stop trading for the day after a ₹${s.risk.max_loss_per_day.toLocaleString("en-IN")} loss.` : ""}${s.schedule.max_trades_per_day > 1 ? ` Up to ${s.schedule.max_trades_per_day} trades a day.` : ""}${s.schedule.reentry_after_stop ? ` Re-enter up to ${s.schedule.reentry_after_stop}× after a stop.` : ""}${nTimes > s.schedule.max_trades_per_day ? ` Only the first ${s.schedule.max_trades_per_day} of the ${nTimes} entry times can trade (max trades a day).` : ""}`.trim());
  const fut = [...(p.legs ?? []), ...(p.bullish ?? []), ...(p.bearish ?? [])].some((l) => l.instrument === "FUT");
  out.push(`Costs: ₹${s.costs.brokerage_per_order}/order, ${s.costs.slippage_points} pt slippage per option leg${fut ? `, ${s.costs.fut_slippage_points ?? 1} pt per futures fill` : ""}, taxes ${s.costs.taxes ? "included" : "excluded"}.`);
  return out.filter(Boolean);
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
