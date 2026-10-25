import axios, { AxiosError } from "axios";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import type { T_FlyCandidate } from "../lib/flySim";
import type { T_StraddleDay, T_StraddleParams } from "../lib/straddleSim";
import type { T_Spec, T_Template } from "../lib/spec";

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
};
export type T_Breakdown = Record<string, { trades: number; net_pnl: number; win_rate: number }>;
export type T_EngineMetrics = {
  trades: number; days_traded: number; wins: number; win_rate: number | null; net_pnl: number; gross_pnl: number; costs: number;
  avg_trade: number | null; avg_win: number | null; avg_loss: number | null; profit_factor: number | null; max_drawdown: number;
  best: number | null; worst: number | null; longest_losing_streak: number; sharpe: number | null; sortino: number | null;
  avg_capital: number | null; stale_fill_pct: number; exit_reasons: Record<string, number>;
};
export type T_EngineResult = {
  params: { spec: T_Spec; from_date: string; to_date: string; strategy_id?: string };
  metrics: T_EngineMetrics;
  breakdowns: { by_dte: T_Breakdown; by_weekday: T_Breakdown; by_reason: T_Breakdown; by_direction: T_Breakdown; monthly: T_Breakdown };
  equity: { t: string; equity: number }[];
  trades: T_EngineTrade[];
  skipped: { time: string; reason: string }[];
  trade_days: number;
  run_id?: string;
};

export const useTemplates = () => useQuery({ queryKey: ["templates"], queryFn: () => get<T_Template[]>("/strategies/templates"), staleTime: Infinity });
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

export const useReplay = (runId: string | null, index: number | null) =>
  useQuery({
    queryKey: ["replay", runId, index],
    queryFn: () => get<T_Replay>(`/strategies/replay/${runId}/${index}`),
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

export type T_RunStrategy = "stock" | "butterfly" | "straddle" | "custom";

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
