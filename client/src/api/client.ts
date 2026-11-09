import axios, { AxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { T_FlyCandidate } from "../lib/flySim";
import type { T_StraddleDay, T_StraddleParams } from "../lib/straddleSim";
import type { T_Cond, T_IndicatorCatalogue, T_Spec, T_Template } from "../lib/spec";

export const api = axios.create({ baseURL: "/api" });

// FastAPI errors come back as {detail: string | validation-error[]}.
export function errorMessage(err: unknown): string {
  if (err instanceof AxiosError) {
    const detail = err.response?.data?.detail;
    if (typeof detail === "string") return detail;
    if (Array.isArray(detail)) return detail.map((d) => `${d.loc?.slice(1).join(".")}: ${d.msg}`).join("; ");
    return err.message;
  }
  return String(err);
}

// ---------- Types ----------

export type T_Exchange = "NSE" | "BSE" | "NFO" | "BFO" | "MCX" | "NDX";
export type T_Interval = "1second" | "1minute" | "5minute" | "30minute" | "1day";
export type T_ProductType = "cash" | "futures" | "options";
export type T_Right = "call" | "put" | "others" | "";

export type T_Health = { message: string; breeze_connected: boolean };
export type T_AuthStatus = { connected: boolean; connected_at: string | null; login_url: string | null };

export type T_Candle = {
  datetime: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  open_interest?: number;
  [key: string]: unknown;
};

export type T_InstrumentParams = {
  stock_code: string;
  exchange_code: T_Exchange;
  product_type?: T_ProductType;
  expiry_date?: string;
  right?: T_Right;
  strike_price?: string;
};

export type T_HistoricalParams = T_InstrumentParams & {
  interval: T_Interval;
  from_date: string;
  to_date: string;
};

export type T_Strategy = { description: string | null; params: Record<string, number> };

export type T_BacktestRequest = T_HistoricalParams & {
  strategy: string;
  params: Record<string, number>;
  initial_capital: number;
  commission_pct: number;
  include_equity_curve: boolean;
};

export type T_Trade = {
  entry_time: string;
  entry_price: number;
  quantity: number;
  exit_time: string | null;
  exit_price: number | null;
  pnl: number | null;
};

export type T_BacktestMetrics = {
  bars: number;
  initial_capital: number;
  final_equity: number;
  total_return_pct: number;
  buy_and_hold_return_pct: number;
  max_drawdown_pct: number;
  trades: number;
  closed_trades: number;
  win_rate_pct: number | null;
  open_position: boolean;
};

export type T_EquityPoint = { datetime: string; equity: number; buy_and_hold: number };

export type T_BacktestResult = {
  metrics: T_BacktestMetrics;
  trades: T_Trade[];
  equity_curve?: T_EquityPoint[];
  run_id?: string; // the saved run this result was stored as
};

// ---------- Options ----------

export type T_OptionLeg = {
  ltp: number | null;
  oi: number | null;
  chg_oi: number | null;
  volume: number | null;
  iv: number | null; // percent
  delta: number | null;
  bid?: number | null;
  ask?: number | null;
  ltp_chg_pct?: number | null;
  oi_history?: { date: string; oi: number | null; close: number | null }[];
};

export type T_ChainRow = { strike: number; offset: number; call: T_OptionLeg; put: T_OptionLeg };

export type T_ChainSummary = {
  spot: number;
  atm: number;
  call_oi: number;
  put_oi: number;
  pcr_oi: number | null;
  atm_iv: number | null;
  atm_straddle: number | null;
  max_pain: number | null;
  call_wall: number | null;
  put_wall: number | null;
};

export type T_Chain = {
  stock_code: string;
  expiry: string;
  as_of: string;
  days_to_expiry: number;
  source: "live" | "historical";
  summary: T_ChainSummary;
  rows: T_ChainRow[];
};

export type T_ComparisonRequest = {
  stock_code: string;
  count: number;
  kind: "weekly" | "monthly";
  strikes: number;
  days_before_expiry: number;
  rate: number;
};

export type T_Comparison = {
  stock_code: string;
  kind: string;
  days_before_expiry: number;
  strikes_around: number;
  expiries: T_Chain[];
  skipped: { expiry: string; reason: string }[];
};

export type T_Job<T> = {
  id: string;
  status: "running" | "done" | "error";
  done: number;
  total: number;
  message: string;
  result: T | null;
  error: string | null;
};

// Breeze payloads vary by endpoint and segment; render them generically.
export type T_BreezeData = Record<string, unknown> | Record<string, unknown>[] | null;

// ---------- Hooks ----------

const get = <T,>(url: string, params?: object) => api.get<T>(url, { params }).then((r) => r.data);

export const useHealth = () =>
  useQuery({ queryKey: ["health"], queryFn: () => get<T_Health>("/"), refetchInterval: 15_000 });

export const useAuthStatus = () =>
  useQuery({ queryKey: ["auth-status"], queryFn: () => get<T_AuthStatus>("/auth/status"), refetchInterval: 15_000 });

export const useLoginUrl = () =>
  useQuery({ queryKey: ["login-url"], queryFn: () => get<{ login_url: string }>("/auth/login-url") });

export function useSetSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (session_token: string) =>
      api.post<{ connected: boolean; customer: T_BreezeData }>("/auth/session", { session_token }).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries(),
  });
}

// Account queries only run when connected, otherwise they'd just return 401s.
export const useFunds = (enabled: boolean) =>
  useQuery({ queryKey: ["funds"], queryFn: () => get<T_BreezeData>("/account/funds"), enabled });

export const useHoldings = (enabled: boolean) =>
  useQuery({ queryKey: ["holdings"], queryFn: () => get<T_BreezeData>("/account/holdings"), enabled });

export const usePositions = (enabled: boolean) =>
  useQuery({ queryKey: ["positions"], queryFn: () => get<T_BreezeData>("/account/positions"), enabled });

export const useStrategies = () =>
  useQuery({ queryKey: ["strategies"], queryFn: () => get<Record<string, T_Strategy>>("/backtest/strategies") });

export const useHistorical = () =>
  useMutation({
    mutationFn: (p: T_HistoricalParams) => get<{ count: number; candles: T_Candle[] }>("/market/historical", p),
  });

export const useQuotes = () =>
  useMutation({ mutationFn: (p: T_InstrumentParams) => get<T_BreezeData>("/market/quotes", p) });

export const useOptionChain = () =>
  useMutation({ mutationFn: (p: T_InstrumentParams) => get<T_BreezeData>("/market/option-chain", p) });

export const useNames = () =>
  useMutation({
    mutationFn: (p: { stock_code: string; exchange_code: T_Exchange }) => get<T_BreezeData>("/market/names", p),
  });

export const useExpiries = (stock_code = "NIFTY") =>
  useQuery({
    queryKey: ["expiries", stock_code],
    queryFn: () => get<{ stock_code: string; upcoming: string[] }>("/options/expiries", { stock_code }),
    staleTime: 60 * 60_000,
  });

export const useOptionChainLive = (
  p: { expiry?: string; stock_code: string; strikes: number; rate: number },
  opts: { enabled: boolean; refetchInterval: number | false },
) =>
  useQuery({
    queryKey: ["option-chain-live", p],
    queryFn: () => get<T_Chain>("/options/chain", p),
    enabled: opts.enabled && !!p.expiry,
    refetchInterval: opts.refetchInterval,
    placeholderData: (prev) => prev,
  });

export const useStartComparison = () =>
  useMutation({
    mutationFn: (body: T_ComparisonRequest) =>
      api.post<{ job_id: string }>("/options/expiry-comparison", body).then((r) => r.data),
  });

// Polls every 1.5s while the job runs, then stops.
export const useJob = <T,>(jobId: string | null) =>
  useQuery({
    queryKey: ["job", jobId],
    queryFn: () => get<T_Job<T>>(`/options/jobs/${jobId}`),
    enabled: !!jobId,
    refetchInterval: (q) => (q.state.data?.status === "running" || !q.state.data ? 1500 : false),
  });

// ---------- Option butterfly backtest ----------

export type T_ButterflyRequest = {
  from_date: string;
  to_date: string;
  stock_code: string;
  interval: "1minute" | "5minute" | "30minute";
  fast: number;
  slow: number;
  wing: number;
  lots: number;
  lot_size: number;
  brokerage_per_order: number;
  slippage_points: number;
  taxes: boolean;
};

// Candidate trades with per-candle P&L paths; exits are replayed client-side (src/lib/flySim.ts).
export type T_ButterflyResult = {
  params: T_ButterflyRequest;
  candidates: T_FlyCandidate[];
  skipped: { time: string; reason: string }[];
  run_id?: string; // the saved run this result was stored as
  price: { datetime: string; close: number; ema_fast: number; ema_slow: number }[];
};

// ---------- Strategy builder ----------

export type T_SavedStrategyMeta = {
  id: string; name: string; underlying: string; version: number; created_at: string; updated_at: string;
  template: string | null; entry: "time" | "signal"; legs: number;
};
export type T_SavedStrategy = { id: string; version: number; created_at: string; updated_at: string; template: string | null; spec: T_Spec; versions: { version: number; saved_at: string }[] };
export type T_SpecCheck = { ok: boolean; errors: { path: string; message: string }[]; warnings: string[]; spec: T_Spec | null };

export type T_EngineLeg = {
  id: string; action: "buy" | "sell"; instrument: "CE" | "PE" | "FUT"; strike: number | null; expiry: string; label: string;
  qty: number; entry: number; exit: number | null; exit_at: string | null; reason: string | null; pnl: number | null;
};
export type T_EngineTrade = {
  trade_day: string; weekday: number; direction: string | null; dte: number; entry_at: string; exit_at: string | null;
  spot_entry: number; atm: number; premium: number; capital: number; gross: number; costs: number; net: number;
  pct: number | null; reason: string; mfe: number | null; mae: number | null; stale_fills: number; legs: T_EngineLeg[];
  // Money blocked (absent on runs saved before margins were recorded): premium (buys), max loss (hedged), approx SPAN (shorts, futures)
  margin?: number; margin_basis?: "premium" | "max_loss" | "approx_margin"; pct_margin?: number | null;
  // Multi-day (swing) trades: P&L per trading day held (sums to net)
  daily_mtm?: { d: string; pnl: number }[]; hold_days?: number;
};
export type T_Breakdown = Record<string, { trades: number; net_pnl: number; win_rate: number }>;
export type T_EngineMetrics = {
  trades: number; days_traded: number; wins: number; win_rate: number | null; net_pnl: number; gross_pnl: number; costs: number;
  avg_trade: number | null; avg_win: number | null; avg_loss: number | null; profit_factor: number | null; max_drawdown: number;
  best: number | null; worst: number | null; longest_losing_streak: number; sharpe: number | null; sortino: number | null;
  avg_capital: number | null; stale_fill_pct: number; exit_reasons: Record<string, number>;
  avg_margin?: number | null; peak_margin?: number | null; return_on_margin_pct?: number | null;
  days_in_market?: number; // trading days with an open position (multi-day trades span several)
};
export type T_EngineResult = {
  params: { spec: T_Spec; from_date: string; to_date: string; strategy_id?: string };
  metrics: T_EngineMetrics;
  breakdowns: { by_dte: T_Breakdown; by_weekday: T_Breakdown; by_reason: T_Breakdown; by_direction: T_Breakdown; monthly: T_Breakdown };
  equity: { t: string; equity: number }[];
  daily?: { d: string; pnl: number }[]; // net P&L per day, multi-day trades marked to market (newer runs)
  trades: T_EngineTrade[];
  skipped: { time: string; reason: string }[];
  trade_days: number;
  run_id?: string;
};

export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: () => get<T_Template[]>("/strategies/templates"), staleTime: Infinity });
// Built-in + extended indicator names for the condition builder (GET /strategies/indicators).
export const useIndicatorCatalogue = () =>
  useQuery({ queryKey: ["indicator-catalogue"], queryFn: () => get<T_IndicatorCatalogue>("/strategies/indicators"), staleTime: Infinity });
export const useSavedStrategies = () => useQuery({ queryKey: ["strategies"], queryFn: () => get<T_SavedStrategyMeta[]>("/strategies") });
export const useSavedStrategy = (id: string | null) =>
  useQuery({ queryKey: ["strategy", id], queryFn: () => get<T_SavedStrategy>(`/strategies/${id}`), enabled: !!id });

export function useSaveStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, spec, template }: { id?: string | null; spec: T_Spec; template?: string | null }) =>
      (id ? api.put<T_SavedStrategy>(`/strategies/${id}`, { spec }) : api.post<T_SavedStrategy>("/strategies", { spec, template })).then((r) => r.data),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ["strategies"] });
      qc.setQueryData(["strategy", doc.id], doc);
    },
  });
}

export function useDeleteStrategy() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/strategies/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["strategies"] }),
  });
}

export const useValidateSpec = () =>
  useMutation({ mutationFn: (spec: T_Spec) => api.post<T_SpecCheck>("/strategies/validate", { spec }).then((r) => r.data) });

export const useDataCheck = (underlying: string, from: string, to: string) =>
  useQuery({
    queryKey: ["data-check", underlying, from, to],
    queryFn: () => get<{ weekdays: number; spot_days: number; option_days: number }>("/strategies/data-check", { underlying, from_date: from, to_date: to }),
    enabled: !!from && !!to,
  });

export const useRunStrategy = () =>
  useMutation({
    mutationFn: (body: { spec: T_Spec; from_date: string; to_date: string; strategy_id?: string | null }) =>
      api.post<{ job_id: string }>("/strategies/run", body).then((r) => r.data),
  });

// ---------- Analysis (phase 4) ----------

export type T_Replay = {
  trade: T_EngineTrade;
  underlying: string;
  spot: { t: string; close: number }[];
  legs: (T_EngineLeg & { series: { t: string; close: number }[] })[];
  pnl: { t: string; pnl: number | null }[];
};
export type T_SweepParam = { path: string; label: string; values: (number | string)[] };
export type T_SweepMetrics = { net_pnl: number; win_rate: number | null; profit_factor: number | null; sharpe: number | null; max_drawdown: number; trades: number; error?: string };
export type T_SweepResult = {
  params: T_SweepParam[];
  periods: { in: [string, string]; out?: [string, string] };
  walk_forward: boolean;
  cells: { values: (number | string)[]; in: T_SweepMetrics; out?: T_SweepMetrics }[];
};

export const useReplay = (runId: string | null, index: number | null, member?: string | null) =>
  useQuery({
    queryKey: ["replay", runId, index, member ?? null],
    queryFn: () => get<T_Replay>(`/strategies/replay/${runId}/${index}`, member ? { member } : undefined),
    enabled: !!runId && index !== null,
    staleTime: Infinity,
  });

export const useStartSweep = () =>
  useMutation({
    mutationFn: (body: { spec: T_Spec; from_date: string; to_date: string; params: T_SweepParam[]; walk_forward: boolean; in_sample_pct?: number }) =>
      api.post<{ job_id: string }>("/strategies/sweep", body).then((r) => r.data),
  });

// ---------- Local data store ----------

export type T_DataUnderlying = "NIFTY" | "SENSEX";

export type T_DataSettings = {
  daily_budget: number;
  underlyings: T_DataUnderlying[];
  strike_band: number;
  expiries_ahead: number;
  include_monthly: boolean;
  nightly_enabled: boolean;
  nightly_time: string;
  short_margin_pct?: number; // margin for an uncovered short index option, % of contract value
  fut_margin_pct?: number;
  worker_paused: boolean;
};

export type T_WorkerState = "starting" | "waiting_for_login" | "paused" | "budget_used" | "idle" | "downloading";

export type T_DataStatus = {
  store: {
    rows: { spot_1m: number; fut_1m: number; opt_1m: number };
    size_mb: number;
    underlyings: Record<string, { days: number; first_day: string; last_day: string; contract_days: number }>;
  };
  worker: {
    state: T_WorkerState;
    current: string | null;
    last_error: string | null;
    done_this_session: number;
    queue: { pending: number; running: number; done: number; failed: number };
    calls_today: number;
    daily_budget: number;
    jobs: { job_id: string; label: string; created_at: string; total: number; done: number; failed: number }[];
  };
  settings: T_DataSettings;
};

export type T_CoverageDay = {
  date: string;
  spot: string | null;
  fut: string | null;
  opt: { ok: number; empty: number; failed: number; pending: number };
};

export type T_DayDetail = {
  underlying: string;
  day: string;
  pending: number;
  contracts: { kind: "spot" | "fut" | "opt"; expiry: string | null; strike: number | null; right: string | null; status: string; rows: number; error: string | null }[];
};

export type T_BackfillRequest = {
  underlyings: T_DataUnderlying[];
  start: string;
  end: string;
  band?: number;
  expiries_ahead?: number;
  include_monthly?: boolean;
  include_futures?: boolean;
  dry_run: boolean;
};

export type T_BackfillPlan = {
  job_id: string | null;
  calls: number;
  eta: { days_at_budget: number; hours_at_full_speed: number };
  underlyings: Record<string, {
    trading_days?: number; contract_days?: number; already_have?: number; calls?: number;
    calls_by_kind?: Record<string, number>; first_day?: string | null; last_day?: string | null; error?: string;
  }>;
};

// Polls faster while downloading, so progress moves.
export const useDataStatus = () =>
  useQuery({
    queryKey: ["data-status"],
    queryFn: () => get<T_DataStatus>("/data/status"),
    refetchInterval: (q) => (q.state.data?.worker.state === "downloading" ? 2000 : 10000),
  });

export const useCoverage = (underlying: T_DataUnderlying, start: string, end: string) =>
  useQuery({
    queryKey: ["data-coverage", underlying, start, end],
    queryFn: () => get<{ days: T_CoverageDay[] }>("/data/coverage", { underlying, start, end }),
    refetchInterval: 15000,
  });

export const useDayDetail = (underlying: T_DataUnderlying, day: string | null) =>
  useQuery({
    queryKey: ["data-day", underlying, day],
    queryFn: () => get<T_DayDetail>("/data/day", { underlying, day }),
    enabled: !!day,
  });

export function useBackfill() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (body: T_BackfillRequest) => api.post<T_BackfillPlan>("/data/backfill", body).then((r) => r.data),
    onSuccess: (_, body) => {
      if (!body.dry_run) qc.invalidateQueries({ queryKey: ["data-status"] });
    },
  });
}

export function useDataAction() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (action: { kind: "pause" | "resume" | "retry" | "clear"; job_id?: string }) => {
      if (action.kind === "retry") return api.post("/data/queue/retry-failed").then((r) => r.data);
      if (action.kind === "clear") return api.delete("/data/queue", { params: { job_id: action.job_id } }).then((r) => r.data);
      return api.post(`/data/worker/${action.kind}`).then((r) => r.data);
    },
    onSuccess: () => qc.invalidateQueries({ queryKey: ["data-status"] }),
  });
}

export function useUpdateDataSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (changes: Partial<T_DataSettings>) => api.patch<T_DataSettings>("/data/settings", changes).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["data-status"] }),
  });
}

// ---------- Saved backtests ----------

export type T_RunStrategy = "stock" | "butterfly" | "straddle" | "custom" | "portfolio";

export type T_RunSummary = { net_pnl: number | null; trades: number | null; win_rate: number | null; [k: string]: unknown };

export type T_RunMeta = {
  id: string;
  strategy: T_RunStrategy;
  strategy_name: string;
  name: string;
  created_at: string;
  updated_at: string;
  params: Record<string, unknown>;
  view: Record<string, unknown> | null;
  summary: T_RunSummary | null;
};

export type T_Run<R> = T_RunMeta & { result: R };

export const useRuns = () => useQuery({ queryKey: ["runs"], queryFn: () => get<T_RunMeta[]>("/runs") });

export const useRun = <R,>(id: string | null) =>
  useQuery({ queryKey: ["run", id], queryFn: () => get<T_Run<R>>(`/runs/${id}`), enabled: !!id, staleTime: Infinity });

export function useUpdateRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, ...changes }: { id: string; name?: string; view?: object; summary?: T_RunSummary }) =>
      api.patch<T_RunMeta>(`/runs/${id}`, changes).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  });
}

export function useDeleteRun() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/runs/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["runs"] }),
  });
}

// ---------- Intraday straddle backtest ----------

export type T_StraddleRequest = T_StraddleParams & {
  from_date: string;
  to_date: string;
  stock_code: string;
  entry_times: string[]; // "HH:MM" (trade day) or "D-1 HH:MM" (previous day)
  side?: "buy" | "sell"; // side the lab opens on (runs saved before this default to buy)
  entry_time?: string; // runs saved before multiple entry times
};

// Per-day straddle paths; target and square-off are replayed client-side (src/lib/straddleSim.ts).
export type T_StraddleResult = {
  params: T_StraddleRequest;
  days: T_StraddleDay[];
  skipped: { date: string; entry?: string; reason: string }[];
  run_id?: string; // the saved run this result was stored as
};

export const useStartStraddle = () =>
  useMutation({
    mutationFn: (body: T_StraddleRequest) => api.post<{ job_id: string }>("/backtest/straddle", body).then((r) => r.data),
  });

export const useStartButterfly = () =>
  useMutation({
    mutationFn: (body: T_ButterflyRequest) =>
      api.post<{ job_id: string }>("/backtest/options-butterfly", body).then((r) => r.data),
  });

export const useBacktest = () =>
  useMutation({
    mutationFn: (body: T_BacktestRequest) => api.post<T_BacktestResult>("/backtest", body).then((r) => r.data),
  });

// ---------- Research lab ----------

export type T_ExperimentStatus = "queued" | "running" | "done" | "failed" | "blocked" | "cancelled";
export type T_Verdict = "pending" | "rejected" | "revise" | "inconclusive" | "advance" | "promoted";
export type T_ResearchEventKind = "decision" | "experiment" | "audit" | "critic" | "agent" | "system";

export type T_ResearchProgress = { period: string; stage: string; done: number; total: number; message: string };
export type T_ResearchEvent = { t: string; kind: T_ResearchEventKind; actor: string; text: string; experiment_id: string | null };
export type T_ResearchAgent = { name: string; role: string; status: string; task: string };

export type T_ResearchStatus = {
  state: {
    phase: string;
    phase_detail: string;
    cycle: number;
    agents: T_ResearchAgent[];
    summary: string;
    protocol: string;
    updated_at: string;
  };
  runner: { paused: boolean; current: { id: string; period: string } | null; message: string };
  counts: Partial<Record<T_ExperimentStatus, number>>;
  verdicts: Partial<Record<T_Verdict, number>>;
  experiments: number;
  families: number;
  current: { id: string; name: string; progress: T_ResearchProgress | null } | null;
  running: { id: string; name: string; source: string | null; progress: T_ResearchProgress | null }[];
  breeze_calls_today: number;
  daily_budget: number | null;
  events: T_ResearchEvent[];
};

export type T_ResearchPeriod = {
  key: string; // is · stress · holdout · h2_2025 …
  label: string;
  role: string; // in_sample · out_of_sample · holdout · historical · stress
  from: string;
  to: string;
  cost_overrides: Record<string, number> | null;
  fingerprint?: string;
};

// Per-period headline in the experiments list.
export type T_ResearchHeadline =
  | {
      trades: number; net_pnl: number | null; return_pct: number | null; profit_factor: number | null; sharpe: number | null;
      t_stat: number | null; max_drawdown_pct: number | null; win_rate: number | null; costs_total: number | null;
      peak_capital_required: number | null; fits_capital: boolean; net_ex_top5: number | null; run_id: string | null;
      passed: number; checks: number; error?: undefined;
    }
  | { error: string };

export type T_ExperimentMeta = {
  id: string;
  parent_id: string | null;
  name: string;
  family: string;
  version: number;
  stage: string;
  status: T_ExperimentStatus;
  verdict: T_Verdict;
  priority: number;
  source: string;
  hypothesis: string;
  next_action: string;
  created_at: string;
  updated_at: string;
  progress: T_ResearchProgress | null;
  economic_key: string;
  periods: T_ResearchPeriod[];
  results: Record<string, T_ResearchHeadline>;
};

// Research metrics on top of the engine's (app/research/evaluate.py).
export type T_ResearchExt = {
  capital: number;
  trading_days: number; days_traded: number; trades: number; skipped: number;
  net_pnl: number | null; gross_pnl: number | null; gross_before_slippage: number | null; costs_total: number | null;
  cost_components: { brokerage: number; stt: number; exchange: number; sebi: number; stamp: number; gst: number; slippage: number };
  cost_share_of_gross: number | null;
  return_pct: number | null; annualized_return_pct: number | null;
  max_drawdown: number | null; max_drawdown_pct: number | null; recovery_days: number | null;
  sharpe: number | null; sortino: number | null; t_stat: number | null;
  boot_ci: [number | null, number | null]; boot_p_loss: number | null;
  profit_factor: number | null; win_rate: number | null; avg_win: number | null; avg_loss: number | null; expectancy: number | null;
  net_ex_top5: number | null; top_decile_day_share_pct: number | null; longest_losing_streak: number;
  avg_hold_min: number | null; exposure_pct: number | null;
  peak_capital_required: number | null; avg_capital_required: number | null; capital_basis: string[]; fits_capital: boolean;
  max_lots_by_capital: number | null;
  weekly: { n: number; mean: number | null; worst: number | null; best: number | null; pct_positive: number | null } | null;
  monthly: Record<string, number | null>;
  by_hour: Record<string, { trades: number; net: number | null }>;
  daily: { d: string; pnl: number | null; equity: number | null; dd: number | null }[];
};

export type T_ResearchCheck = { name: string; value: number | boolean | null; pass: boolean };

export type T_ResearchResult = {
  run_id?: string;
  fingerprint?: string;
  reused_from?: string;
  metrics?: T_EngineMetrics;
  breakdowns?: T_EngineResult["breakdowns"];
  ext?: T_ResearchExt;
  checks?: T_ResearchCheck[];
  finished_at?: string;
  error?: string;
};

export type T_Experiment = Omit<T_ExperimentMeta, "results"> & {
  spec: T_Spec;
  mechanism: string;
  novelty: string;
  failure_modes: string;
  criteria: Record<string, unknown> | null;
  capital: number;
  decision_reason: string;
  log: { t: string; msg: string }[];
  audit: { t: string; by: string; severity: string; finding: string }[];
  critic: { t: string; by: string; note: string }[];
  similar: { id: string; name: string; verdict: T_Verdict }[];
  events: T_ResearchEvent[];
  code_rev: string;
  results: Record<string, T_ResearchResult>;
};

export const useResearchStatus = () =>
  useQuery({ queryKey: ["research-status"], queryFn: () => get<T_ResearchStatus>("/research/status"), refetchInterval: 5000 });

export const useExperiments = () =>
  useQuery({ queryKey: ["research-experiments"], queryFn: () => get<T_ExperimentMeta[]>("/research/experiments"), refetchInterval: 10000 });

// Polls while open: a running experiment fills in period by period.
export const useExperiment = (id: string | null) =>
  useQuery({
    queryKey: ["research-experiment", id],
    queryFn: () => get<T_Experiment>(`/research/experiments/${id}`),
    enabled: !!id,
    refetchInterval: (q) => (q.state.data?.status === "running" || q.state.data?.status === "queued" ? 5000 : 30000),
  });

export function useResearchRunner() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (kind: "pause" | "resume") => api.post(`/research/runner/${kind}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["research-status"] }),
  });
}

// ---------- Walk-forward regime playbooks (app/research/playbook.py) ----------

export type T_PbStats = { trades: number; net: number; mean: number; t: number | null; pf: number | null; win_rate: number | null };
export type T_PlaybookMeta = {
  id: string;
  label?: string | null;
  settings: { test_start: string; end: string; min_trades: number; min_t: number; min_pf: number; per_regime: number; score: string };
  oos: T_PbStats & { by_quarter_positive: number; quarters: number; by_regime: Record<string, T_PbStats>; by_year: Record<string, T_PbStats> };
  candidates: { id: string; name: string; agent: string; instrument: string }[];
  confirm: T_PbStats | null;
};
export type T_Playbook = T_PlaybookMeta & {
  quarters: { from: string; to: string; choice: Record<string, string[]>; regime_days: Record<string, number>; test: T_PbStats }[];
  baselines: Record<string, T_PbStats>;
  hindsight: Record<string, T_PbStats & { regimes: number[] }>;
  final: Record<string, (T_PbStats & { id: string })[]>;
  confirm?: { oos: T_PbStats; quarters: (Partial<T_PbStats> & { from: string; approx?: number })[] };
};

export const usePlaybooks = () =>
  useQuery({ queryKey: ["research-playbooks"], queryFn: () => get<T_PlaybookMeta[]>("/research/playbooks"), refetchInterval: 30000 });
export const usePlaybook = (id: string | null) =>
  useQuery({ queryKey: ["research-playbook", id], queryFn: () => get<T_Playbook>(`/research/playbooks/${id}`), enabled: !!id });

// ---------- Paper watch (app/research/paper.py: rules re-run daily from a start date; never orders) ----------

export type T_PaperTrade = { entry_at: string; exit_at: string | null; direction: string | null; net: number; reason: string | null; open: boolean; hold_days?: number | null; margin?: number | null; member?: string };
export type T_PaperSignal = { at: string | null; holds: boolean | null; votes?: number; of?: number; needed?: number | null; conditions?: { rule: string; holds: boolean | null }[]; error?: string };
export type T_PaperState = {
  updated_at: string;
  since: string;
  until: string;
  run_id?: string;
  net_pnl?: number;
  trades: T_PaperTrade[];
  open_position?: T_PaperTrade | null;
  max_drawdown?: number;
  note?: string;
  signal?: T_PaperSignal | null;
  member_signals?: Record<string, T_PaperSignal & { name: string }>; // buckets: each member's entry with its gate
};
export type T_PaperWatch = {
  experiment_id: string; // or "portfolio:<id>" for a bucket
  kind?: "portfolio";
  portfolio_id?: string;
  since: string;
  added_at: string;
  name: string;
  verdict?: T_Verdict;
  family?: string;
  last: T_PaperState | null;
};

export const usePaperWatch = () =>
  useQuery({ queryKey: ["research-paper"], queryFn: () => get<T_PaperWatch[]>("/research/paper"), refetchInterval: 60000 });

export function usePaperRefresh() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (eid: string) => api.post(`/research/paper/${eid}/refresh`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["research-paper"] }),
  });
}

// ---------- Strategy portfolios (buckets of algos, app/strategy/portfolio.py) ----------

export type T_PortfolioMember = {
  id: string;
  name?: string | null;
  strategy_id?: string | null; // a saved strategy (latest version) …
  spec?: T_Spec | null; // … or an inline spec
  lots: number; // multiplier on the strategy's own lots
  gate?: T_Cond | null; // the algo only enters while this holds
  enabled: boolean;
};
export type T_Portfolio = { name: string; description?: string; capital: number; members: T_PortfolioMember[] };
export type T_SavedPortfolioMeta = { id: string; name: string; members: number; created_at: string; updated_at: string };
export type T_SavedPortfolio = { id: string; portfolio: T_Portfolio; created_at: string; updated_at: string };
export type T_PortfolioCheck = {
  ok: boolean;
  errors: { member: string | null; message: string }[];
  warnings: { member: string | null; message: string }[];
  portfolio: T_Portfolio | null;
};
export type T_PortfolioMemberSummary = {
  id: string; name: string; lots: number; gate: T_Cond | null; error?: string;
  underlying?: string; holding?: "intraday" | "swing";
  metrics?: { trades: number; net_pnl: number; win_rate: number | null; profit_factor: number | null; max_drawdown: number;
    sharpe: number | null; days_traded: number; days_in_market?: number; avg_trade: number | null; peak_margin?: number | null };
  contribution_pct?: number | null; // signed share of the members' combined |P&L|
  in_market_pct?: number | null;
};
export type T_PortfolioResult = {
  params: { portfolio: T_Portfolio; from_date: string; to_date: string; portfolio_id?: string };
  metrics: T_EngineMetrics & {
    capital: number; return_pct: number; max_drawdown_pct: number; peak_open_positions: number; peak_combined_margin: number;
  };
  breakdowns: T_EngineResult["breakdowns"] & { by_member: T_Breakdown };
  members: T_PortfolioMemberSummary[];
  member_results: Record<string, T_EngineResult | { error: string }>;
  equity: ({ d: string; total: number } & Record<string, number | string>)[]; // cumulative, total and per member
  daily: { d: string; pnl: number }[];
  correlation: Record<string, Record<string, number | null>>;
  monthly: Record<string, Record<string, number>>;
  by_regime: { trades: Record<string, Record<string, { trades: number; net_pnl: number; win_rate: number | null }>>; days: Record<string, number> } | null;
  trades: (T_EngineTrade & { member: string })[];
  trading_days: number;
  run_id?: string;
};

export const useSavedPortfolios = () => useQuery({ queryKey: ["portfolios"], queryFn: () => get<T_SavedPortfolioMeta[]>("/portfolios") });
export const useSavedPortfolio = (id: string | null) =>
  useQuery({ queryKey: ["portfolio", id], queryFn: () => get<T_SavedPortfolio>(`/portfolios/${id}`), enabled: !!id });

export function useSavePortfolio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: ({ id, portfolio }: { id?: string | null; portfolio: T_Portfolio }) =>
      (id ? api.put<T_SavedPortfolio>(`/portfolios/${id}`, { portfolio }) : api.post<T_SavedPortfolio>("/portfolios", { portfolio })).then((r) => r.data),
    onSuccess: (doc) => {
      qc.invalidateQueries({ queryKey: ["portfolios"] });
      qc.setQueryData(["portfolio", doc.id], doc);
    },
  });
}

export function useDeletePortfolio() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => api.delete(`/portfolios/${id}`),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["portfolios"] }),
  });
}

export const useValidatePortfolio = () =>
  useMutation({ mutationFn: (portfolio: T_Portfolio) => api.post<T_PortfolioCheck>("/portfolios/validate", { portfolio }).then((r) => r.data) });

export const useRunPortfolio = () =>
  useMutation({
    mutationFn: (body: { portfolio: T_Portfolio; from_date: string; to_date: string; portfolio_id?: string | null }) =>
      api.post<{ job_id: string }>("/portfolios/run", body).then((r) => r.data),
  });
