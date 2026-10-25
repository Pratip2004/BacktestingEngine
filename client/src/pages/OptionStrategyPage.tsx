import { useDeferredValue, useEffect, useMemo, useState } from "react";
import { useSearchParams } from "react-router-dom";
import {
  Alert,
  Button,
  DatePicker,
  Divider,
  Empty,
  Form,
  InputNumber,
  Progress,
  Segmented,
  Select,
  Slider,
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip as AntTooltip,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import {
  CartesianGrid,
  ComposedChart,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Scatter,
  ScatterChart,
  Tooltip,
  XAxis,
  YAxis,
  ZAxis,
} from "recharts";
import {
  errorMessage,
  useJob,
  useRun,
  useStartButterfly,
  useUpdateRun,
  type T_ButterflyRequest,
  type T_ButterflyResult,
} from "../api/client";
import { GRID_STOPS, GRID_TARGETS, simulate, sweep, type T_ExitRules, type T_SimTrade } from "../lib/flySim";
import PageTitle from "../components/PageTitle";
import { backtestCrumb } from "../lib/nav";
import SectionCard from "../components/SectionCard";
import StatCard from "../components/StatCard";
import ConnectionGate from "../components/ConnectionGate";
import ReportScope, { usePrintMode } from "../components/ReportScope";
import type { T_ReportInfo } from "../lib/report";

const { Text } = Typography;

// ---------- Types ----------

type T_FormValues = Omit<T_ButterflyRequest, "from_date" | "to_date" | "stock_code"> & { range: [Dayjs, Dayjs] };
type T_HeatMetric = "net_pnl" | "win_rate" | "profit_factor";

// ---------- Constants ----------

// Categorical slots 1–3: NIFTY / equity, fast EMA, slow EMA. Wins, losses and direction use status colours plus shape.
const SERIES = { close: "#2a78d6", ema_fast: "#eb6834", ema_slow: "#1baf7a" };
const GOOD = "#22C55E";
const BAD = "#EF4444";
const GRID = "#F4F4F5";
const AXIS = "#A1A1AA";
const MUTED = "#71717A";
const mono = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" };

// Diverging blue (gain) ↔ red (loss) around a neutral gray midpoint.
const DIV_POS = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];
const DIV_NEG = ["#fadcdc", "#f5b5b4", "#ee8b8a", "#e34948", "#c23736", "#962827"];
const DIV_MID = "#f0efec";

const INTERVALS = [
  { value: "1minute", label: "1m" },
  { value: "5minute", label: "5m" },
  { value: "30minute", label: "30m" },
];
const INTERVAL_MIN: Record<string, number> = { "1minute": 1, "5minute": 5, "30minute": 30 };

const timeOptions = (from: string, to: string, step: number) => {
  const out = [];
  for (let m = toMin(from); m <= toMin(to); m += step) out.push({ value: fromMin(m), label: fromMin(m) });
  return out;
};
const SQUARE_OFF_TIMES = timeOptions("12:00", "15:25", 5);
const LAST_ENTRY_TIMES = timeOptions("09:30", "15:20", 5);

const HEAT_METRICS = [
  { value: "net_pnl", label: "Net P&L" },
  { value: "win_rate", label: "Win rate" },
  { value: "profit_factor", label: "Profit factor" },
];

// ---------- Helpers ----------

function toMin(hhmm: string) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}
function fromMin(m: number) {
  return `${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`;
}

const inr = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "–" : `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: digits })}`;
const signedInr = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${inr(n)}`);
const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`);
const ts = (d: string | null) => (d ? dayjs(d).format("D MMM HH:mm") : "–");
const legendText = (value: string) => <span style={{ color: MUTED }}>{value}</span>;

function diverging(v: number | null, center: number, maxAbs: number) {
  if (v === null || !isFinite(v) || maxAbs === 0) return { background: "#FAFAFA", color: AXIS };
  const x = Math.max(-1, Math.min(1, (v - center) / maxAbs));
  if (Math.abs(x) < 0.04) return { background: DIV_MID, color: "#18181B" };
  const ramp = x > 0 ? DIV_POS : DIV_NEG;
  const i = Math.min(ramp.length - 1, Math.floor(Math.abs(x) * ramp.length));
  return { background: ramp[i], color: i >= 3 ? "#FFFFFF" : "#18181B" };
}

function Pnl({ value }: { value: number | null }) {
  if (value === null) return <>–</>;
  return <Text type={value > 0 ? "success" : value < 0 ? "danger" : undefined}>{signedInr(value)}</Text>;
}

const REASON_TAG: Record<string, { color: string; label: string }> = {
  target: { color: "success", label: "Target" },
  stop: { color: "error", label: "Stop-loss" },
  time: { color: "default", label: "Time" },
};

// ---------- Config ----------

function LegsPreview({ wing, lots, fast, slow }: { wing: number; lots: number; fast: number; slow: number }) {
  const rows = [
    { up: true, side: `${fast} EMA crosses above ${slow}`, legs: [`Buy ${lots} ATM CE`, `Sell ${2 * lots} ATM+${wing} CE`, `Buy ${lots} ATM+${2 * wing} CE`] },
    { up: false, side: `${fast} EMA crosses below ${slow}`, legs: [`Buy ${lots} ATM PE`, `Sell ${2 * lots} ATM−${wing} PE`, `Buy ${lots} ATM−${2 * wing} PE`] },
  ];
  return (
    <div className="space-y-2">
      {rows.map((r) => (
        <div key={r.side} className="rounded-lg border border-zinc-200 p-3">
          <div className="flex items-center gap-2 mb-1">
            <Text style={{ color: r.up ? GOOD : BAD }}>{r.up ? "▲" : "▼"}</Text>
            <Text className="text-xs font-medium">{r.side}</Text>
          </div>
          <Text type="secondary" className="text-xs block" style={mono}>
            {r.legs.join(" · ")}
          </Text>
        </div>
      ))}
    </div>
  );
}

function ConfigForm({ onRun, running, initial }: { onRun: (b: T_ButterflyRequest) => void; running: boolean; initial?: T_ButterflyRequest }) {
  const [form] = Form.useForm<T_FormValues>();
  const wing = Form.useWatch("wing", form) ?? 200;
  const lots = Form.useWatch("lots", form) ?? 1;
  const fast = Form.useWatch("fast", form) ?? 9;
  const slow = Form.useWatch("slow", form) ?? 21;

  return (
    <Form<T_FormValues>
      form={form}
      layout="vertical"
      initialValues={
        initial
          ? { ...initial, range: [dayjs(initial.from_date), dayjs(initial.to_date)] }
          : {
              range: [dayjs().subtract(1, "month"), dayjs().subtract(1, "day")],
              interval: "5minute",
              fast: 9,
              slow: 21,
              wing: 200,
              lots: 1,
              lot_size: 65,
              brokerage_per_order: 20,
              slippage_points: 0.5,
              taxes: true,
            }
      }
      onFinish={({ range, ...v }) =>
        onRun({ ...v, stock_code: "NIFTY", from_date: range[0].format("YYYY-MM-DD"), to_date: range[1].format("YYYY-MM-DD") })
      }
    >
      <Form.Item name="range" label="Date range" rules={[{ required: true }]} extra="The first run fetches 3 option contracts per crossover from Breeze. Reruns use the cache.">
        <DatePicker.RangePicker className="w-full" disabledDate={(d) => d.isAfter(dayjs(), "day")} />
      </Form.Item>
      <Form.Item name="interval" label="Candle timeframe" extra="Also the exit-check frequency.">
        <Segmented block options={INTERVALS} />
      </Form.Item>
      <div className="grid grid-cols-2 gap-x-3">
        <Form.Item name="fast" label="Fast EMA">
          <InputNumber min={2} max={200} className="!w-full" />
        </Form.Item>
        <Form.Item name="slow" label="Slow EMA" dependencies={["fast"]}
          rules={[({ getFieldValue }) => ({ validator: (_, v) => (v > getFieldValue("fast") ? Promise.resolve() : Promise.reject(new Error("Must be > fast"))) })]}>
          <InputNumber min={3} max={400} className="!w-full" />
        </Form.Item>
      </div>

      <Divider className="my-4" />

      <div className="grid grid-cols-2 gap-x-3">
        <Form.Item name="wing" label="Wing (points)" extra="Multiple of 50">
          <InputNumber min={50} max={2000} step={50} className="!w-full" />
        </Form.Item>
        <Form.Item name="lots" label="Lots per wing" extra="Body sells 2×">
          <InputNumber min={1} max={50} className="!w-full" />
        </Form.Item>
      </div>
      <Form.Item label="Entry (fixed)">
        <LegsPreview wing={wing} lots={lots} fast={fast} slow={slow} />
      </Form.Item>

      <Divider className="my-4" />

      <div className="grid grid-cols-3 gap-x-3">
        <Form.Item name="lot_size" label="Lot size">
          <InputNumber min={1} className="!w-full" />
        </Form.Item>
        <Form.Item name="brokerage_per_order" label="₹ / order">
          <InputNumber min={0} className="!w-full" />
        </Form.Item>
        <Form.Item name="slippage_points" label="Slippage pts">
          <InputNumber min={0} step={0.25} className="!w-full" />
        </Form.Item>
      </div>
      <Form.Item extra="STT 0.1% on sells, NSE charges, SEBI fee, stamp duty, 18% GST.">
        <div className="flex items-center gap-2">
          <Form.Item name="taxes" valuePropName="checked" noStyle>
            <Switch size="small" />
          </Form.Item>
          <Text className="text-xs">Include taxes and exchange charges</Text>
        </div>
      </Form.Item>

      <Form.Item className="mb-0">
        <Button type="primary" htmlType="submit" loading={running} block>
          {running ? "Running…" : "Load trades"}
        </Button>
      </Form.Item>
    </Form>
  );
}

// ---------- Exit controls ----------

function PctControl({
  label,
  hint,
  value,
  onChange,
  max,
  sign,
}: {
  label: string;
  hint: string;
  value: number | null;
  onChange: (v: number | null) => void;
  max: number;
  sign: "+" | "−";
}) {
  const [last, setLast] = useState(value ?? 50);
  const on = value !== null;
  return (
    <div>
      <div className="flex items-center justify-between mb-1">
        <Text className="text-[13px] font-semibold">{label}</Text>
        <Switch size="small" checked={on} onChange={(c) => onChange(c ? last : null)} />
      </div>
      <Text type="secondary" className="text-xs block mb-2">{hint}</Text>
      <div className="flex items-center gap-3">
        <Slider
          className="flex-1"
          min={5}
          max={max}
          step={5}
          disabled={!on}
          value={value ?? last}
          onChange={(v) => {
            setLast(v);
            onChange(v);
          }}
          tooltip={{ formatter: (v) => `${sign}${v}%` }}
        />
        <InputNumber
          size="small"
          className="!w-20"
          min={1}
          max={max}
          disabled={!on}
          value={value ?? last}
          formatter={(v) => `${sign}${v}%`}
          parser={(v) => Number((v ?? "").replace(/[^\d.]/g, ""))}
          onChange={(v) => {
            if (v === null) return;
            setLast(v);
            onChange(v);
          }}
        />
      </div>
    </div>
  );
}

function ExitControls({ rules, setRules, capitalHint }: { rules: T_ExitRules; setRules: (r: T_ExitRules) => void; capitalHint: string }) {
  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
      <div className="flex items-baseline justify-between flex-wrap gap-2 mb-4">
        <Text className="text-[15px] font-semibold">Exit rules</Text>
        <Text type="secondary" className="text-xs">% of premium paid · {capitalHint} · checked at every candle close</Text>
      </div>
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-6">
        <PctControl label="Target" hint="Exit when net P&L reaches +X% of premium." value={rules.targetPct} max={300} sign="+"
          onChange={(targetPct) => setRules({ ...rules, targetPct })} />
        <PctControl label="Stop-loss" hint="Exit when net P&L falls to −X% of premium." value={rules.stopPct} max={100} sign="−"
          onChange={(stopPct) => setRules({ ...rules, stopPct })} />
        <div>
          <Text className="text-[13px] font-semibold block mb-1">Square-off</Text>
          <Text type="secondary" className="text-xs block mb-2">Close anything still open at this time.</Text>
          <Select className="w-full" value={rules.squareOff} options={SQUARE_OFF_TIMES} onChange={(squareOff) => setRules({ ...rules, squareOff })} />
        </div>
        <div>
          <Text className="text-[13px] font-semibold block mb-1">No new entries after</Text>
          <Text type="secondary" className="text-xs block mb-2">Crossovers later in the day are ignored.</Text>
          <Select className="w-full" value={rules.lastEntry} options={LAST_ENTRY_TIMES} onChange={(lastEntry) => setRules({ ...rules, lastEntry })} />
        </div>
      </div>
    </div>
  );
}

// ---------- Heatmap ----------

function Heatmap({
  grid,
  rules,
  onPick,
}: {
  grid: ReturnType<typeof sweep>;
  rules: T_ExitRules;
  onPick: (targetPct: number | null, stopPct: number | null) => void;
}) {
  const [metric, setMetric] = useState<T_HeatMetric>("net_pnl");
  const cells = grid.flat();
  const values = cells.map((c) => c[metric]).filter((v): v is number => v !== null && isFinite(v));
  const center = metric === "net_pnl" ? 0 : metric === "win_rate" ? 50 : 1;
  const maxAbs = Math.max(...values.map((v) => Math.abs(v - center)), 1e-9);
  const best = cells.reduce((b, c) => ((c.net_pnl ?? -Infinity) > (b.net_pnl ?? -Infinity) ? c : b), cells[0]);
  const fmt = (v: number | null) =>
    v === null ? "–" : metric === "net_pnl" ? `${v >= 0 ? "+" : "−"}${(Math.abs(v) / 1000).toFixed(1)}K` : metric === "win_rate" ? `${v.toFixed(0)}%` : v.toFixed(2);
  const label = (v: number | null) => (v === null ? "Off" : `${v}%`);

  return (
    <SectionCard
      title="Target × stop-loss map"
      description={`Every combination with the current square-off and entry cut-off. Blue = better, red = worse. Best net P&L: target ${label(best.targetPct)}, stop ${label(best.stopPct)}. Click a cell to use it.`}
      extra={<Segmented size="small" value={metric} onChange={(v) => setMetric(v as T_HeatMetric)} options={HEAT_METRICS} />}
    >
      <div className="overflow-x-auto">
        <table className="border-separate w-full" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th className="text-left px-1 whitespace-nowrap">
                <Text type="secondary" className="text-[10px] font-medium uppercase tracking-wider">Stop ↓ / Target →</Text>
              </th>
              {GRID_TARGETS.map((t) => (
                <th key={String(t)} className="px-1 min-w-14">
                  <Text type="secondary" className="text-xs font-medium">{t === null ? "Off" : `+${t}%`}</Text>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {grid.map((row, ri) => (
              <tr key={ri}>
                <td className="px-1 whitespace-nowrap">
                  <Text type="secondary" className="text-xs font-medium">{GRID_STOPS[ri] === null ? "Off" : `−${GRID_STOPS[ri]}%`}</Text>
                </td>
                {row.map((c) => {
                  const selected = c.targetPct === rules.targetPct && c.stopPct === rules.stopPct;
                  return (
                    <AntTooltip
                      key={String(c.targetPct)}
                      title={`Target ${label(c.targetPct)} · stop ${label(c.stopPct)}: ${signedInr(c.net_pnl)}, ${c.trades} trades, win ${c.win_rate?.toFixed(0) ?? "–"}%, PF ${c.profit_factor?.toFixed(2) ?? "–"}`}
                    >
                      <td
                        onClick={() => onPick(c.targetPct, c.stopPct)}
                        className="text-center text-xs rounded-sm py-1.5 px-1 cursor-pointer"
                        style={{ ...diverging(c[metric], center, maxAbs), outline: selected ? "2px solid #18181B" : undefined, outlineOffset: -2 }}
                      >
                        {fmt(c[metric])}
                      </td>
                    </AntTooltip>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </SectionCard>
  );
}

// ---------- Charts ----------

function MfeMaeChart({ trades, rules }: { trades: T_SimTrade[]; rules: T_ExitRules }) {
  const wins = trades.filter((t) => t.pnl > 0).map((t) => ({ x: +t.mae_pct.toFixed(1), y: +t.mfe_pct.toFixed(1), t }));
  const losses = trades.filter((t) => t.pnl <= 0).map((t) => ({ x: +t.mae_pct.toFixed(1), y: +t.mfe_pct.toFixed(1), t }));
  return (
    <div className="h-80" role="img" aria-label="Best and worst P&L reached by each trade before square-off">
      <ResponsiveContainer>
        <ScatterChart margin={{ top: 16, right: 16, bottom: 8, left: 0 }}>
          <CartesianGrid stroke={GRID} />
          <XAxis type="number" dataKey="x" name="Worst" unit="%" tick={{ fontSize: 11, fill: AXIS }} stroke={GRID}
            label={{ value: "Worst point before square-off (% of premium)", position: "insideBottom", offset: -4, fontSize: 11, fill: MUTED }} height={40} />
          <YAxis type="number" dataKey="y" name="Best" unit="%" tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={52}
            label={{ value: "Best point", angle: -90, position: "insideLeft", fontSize: 11, fill: MUTED }} />
          <ZAxis range={[48, 48]} />
          {rules.targetPct !== null && <ReferenceLine y={rules.targetPct} stroke={GOOD} strokeDasharray="4 3" label={{ value: `Target +${rules.targetPct}%`, position: "insideTopRight", fontSize: 10, fill: MUTED }} />}
          {rules.stopPct !== null && <ReferenceLine x={-rules.stopPct} stroke={BAD} strokeDasharray="4 3" label={{ value: `Stop −${rules.stopPct}%`, position: "insideTopLeft", fontSize: 10, fill: MUTED }} />}
          <ReferenceLine x={0} stroke={AXIS} />
          <ReferenceLine y={0} stroke={AXIS} />
          <Tooltip
            cursor={{ strokeDasharray: "3 3" }}
            content={({ payload }) => {
              const t = payload?.[0]?.payload?.t as T_SimTrade | undefined;
              if (!t) return null;
              return (
                <div className="bg-white border border-zinc-200 rounded-md px-3 py-2 shadow-sm text-xs">
                  <div className="font-semibold mb-1">{ts(t.entry_time)} · {t.direction === "bullish" ? "Call fly" : "Put fly"}</div>
                  <div>Best {pct(t.mfe_pct)} · worst {pct(t.mae_pct)}</div>
                  <div>Exit {REASON_TAG[t.exit_reason].label.toLowerCase()} at {pct(t.pnl_pct)} ({signedInr(t.pnl)})</div>
                </div>
              );
            }}
          />
          <Legend verticalAlign="top" align="right" wrapperStyle={{ fontSize: 12, paddingBottom: 8 }} formatter={legendText} />
          <Scatter name="Winning trade" data={wins} fill={GOOD} shape="circle" legendType="circle" isAnimationActive={false} />
          <Scatter name="Losing trade" data={losses} fill={BAD} shape="cross" legendType="cross" isAnimationActive={false} />
        </ScatterChart>
      </ResponsiveContainer>
    </div>
  );
}

function EquityChart({ trades }: { trades: T_SimTrade[] }) {
  const data = useMemo(() => {
    let cum = 0;
    return trades.map((t, i) => ({ n: i + 1, time: t.exit_time, equity: Math.round((cum += t.pnl)) }));
  }, [trades]);
  if (!data.length) return <Empty description="No trades with these rules" />;
  return (
    <div className="h-72" role="img" aria-label="Cumulative net P&L by trade">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="time" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={40} />
          <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={76} />
          <ReferenceLine y={0} stroke={AXIS} />
          <Tooltip formatter={(v) => [signedInr(Number(v)), "Cumulative P&L"]} labelFormatter={(d, p) => `Trade ${p?.[0]?.payload?.n ?? ""} · ${dayjs(d as string).format("D MMM YYYY, HH:mm")}`} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
          <Line dataKey="equity" stroke={SERIES.close} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

type T_MarkerProps = { cx?: number; cy?: number; payload?: { bull: number | null; bear: number | null } };

// Scatter renders every chart row; rows without an entry of this direction draw nothing.
function Triangle({ cx, cy, payload, up }: T_MarkerProps & { up: boolean }) {
  if (cx === undefined || cy === undefined || payload?.[up ? "bull" : "bear"] == null) return null;
  const s = 6;
  const points = up ? `${cx},${cy - s} ${cx - s},${cy + s} ${cx + s},${cy + s}` : `${cx},${cy + s} ${cx - s},${cy - s} ${cx + s},${cy - s}`;
  return <polygon points={points} fill={up ? GOOD : BAD} stroke="#fff" strokeWidth={1.5} />;
}

function PriceChart({ result, trades }: { result: T_ButterflyResult; trades: T_SimTrade[] }) {
  const p = result.params;
  // Markers sit on the nearest price row at or before their time (price rows may be thinned).
  const data = useMemo(() => {
    const rows = result.price.map((r) => ({ ...r, bull: null as number | null, bear: null as number | null }));
    const times = rows.map((r) => r.datetime);
    for (const t of trades) {
      let lo = 0, hi = times.length - 1, at = 0;
      while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        if (times[mid] <= t.entry_time) { at = mid; lo = mid + 1; } else hi = mid - 1;
      }
      rows[at][t.direction === "bullish" ? "bull" : "bear"] = t.spot_entry;
    }
    return rows;
  }, [result, trades]);

  return (
    <div className="h-96" role="img" aria-label="NIFTY with fast and slow EMA and trade entries">
      <ResponsiveContainer>
        <ComposedChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="datetime" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={40} />
          <YAxis domain={["auto", "auto"]} tickFormatter={(v) => Number(v).toLocaleString("en-IN")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={64} />
          <Tooltip
            labelFormatter={(d) => dayjs(d as string).format("D MMM YYYY, HH:mm")}
            formatter={(v, name) => [Number(v).toLocaleString("en-IN", { maximumFractionDigits: 2 }), name]}
            cursor={{ stroke: AXIS, strokeDasharray: "3 3" }}
          />
          <Legend wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          <Line dataKey="close" name="NIFTY" stroke={SERIES.close} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="ema_fast" name={`EMA ${p.fast}`} stroke={SERIES.ema_fast} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Line dataKey="ema_slow" name={`EMA ${p.slow}`} stroke={SERIES.ema_slow} strokeWidth={2} dot={false} isAnimationActive={false} />
          <Scatter dataKey="bull" name="▲ Call fly entry" fill={GOOD} shape={(props: T_MarkerProps) => <Triangle {...props} up />} isAnimationActive={false} />
          <Scatter dataKey="bear" name="▼ Put fly entry" fill={BAD} shape={(props: T_MarkerProps) => <Triangle {...props} up={false} />} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------- Trades ----------

function LegsTable({ trade, lotSize, slippage }: { trade: T_SimTrade; lotSize: number; slippage: number }) {
  const rows = trade.legs.map((l, i) => {
    const exit = trade.exit_px[i] - slippage * (l.lots > 0 ? 1 : -1);
    return { ...l, exit, pnl: l.lots * lotSize * (exit - l.entry) };
  });
  return (
    <Table
      size="small"
      rowKey="strike"
      dataSource={rows}
      pagination={false}
      columns={[
        { title: "Leg", render: (_, l) => <Tag color={l.lots > 0 ? "green" : "red"}>{l.lots > 0 ? `Buy ${l.lots}` : `Sell ${-l.lots}`}</Tag> },
        { title: "Contract", render: (_, l) => <Text style={mono}>{`NIFTY ${dayjs(trade.expiry).format("D MMM")} ${l.strike} ${l.right === "call" ? "CE" : "PE"}`}</Text> },
        { title: "Qty", align: "right", render: (_, l) => Math.abs(l.lots) * lotSize },
        { title: "Entry", dataIndex: "entry", align: "right", render: (v: number) => v.toFixed(2) },
        { title: "Exit", dataIndex: "exit", align: "right", render: (v: number) => v.toFixed(2) },
        { title: "Gross P&L", dataIndex: "pnl", align: "right", render: (v: number) => <Pnl value={Math.round(v * 100) / 100} /> },
      ]}
    />
  );
}

function TradesTable({ trades, result }: { trades: T_SimTrade[]; result: T_ButterflyResult }) {
  const printing = usePrintMode();
  return (
    <Table<T_SimTrade & { n: number }>
      size="small"
      rowKey="entry_time"
      dataSource={trades.map((t, i) => ({ ...t, n: i + 1 }))}
      pagination={printing ? false : { pageSize: 20, showSizeChanger: false }}
      scroll={{ x: "max-content" }}
      expandable={{ expandedRowRender: (t) => <LegsTable trade={t} lotSize={result.params.lot_size} slippage={result.params.slippage_points} /> }}
      columns={[
        { title: "#", dataIndex: "n", width: 48 },
        {
          title: "Position",
          dataIndex: "direction",
          filters: [{ text: "Call fly", value: "bullish" }, { text: "Put fly", value: "bearish" }],
          onFilter: (v, t) => t.direction === v,
          render: (d: string) => (
            <span className="whitespace-nowrap">
              <Text style={{ color: d === "bullish" ? GOOD : BAD }}>{d === "bullish" ? "▲" : "▼"}</Text>{" "}
              <Text className="text-xs">{d === "bullish" ? "Call fly" : "Put fly"}</Text>
            </span>
          ),
        },
        { title: "Strikes", render: (_, t) => <Text style={mono} className="text-xs">{t.legs.map((l) => l.strike).join(" / ")}</Text> },
        { title: "Expiry", dataIndex: "expiry", render: (d: string) => dayjs(d).format("D MMM") },
        { title: "Entry", dataIndex: "entry_time", render: ts },
        { title: "Exit", dataIndex: "exit_time", render: (d: string) => dayjs(d).format("HH:mm") },
        {
          title: "Exit reason",
          dataIndex: "exit_reason",
          filters: Object.entries(REASON_TAG).map(([value, r]) => ({ text: r.label, value })),
          onFilter: (v, t) => t.exit_reason === v,
          render: (r: string) => <Tag color={REASON_TAG[r].color}>{REASON_TAG[r].label}</Tag>,
        },
        { title: "Premium paid", dataIndex: "capital", align: "right", render: (v: number) => inr(v) },
        { title: "Net P&L", dataIndex: "pnl", align: "right", sorter: (a, b) => a.pnl - b.pnl, render: (v: number) => <Pnl value={v} /> },
        { title: "% of premium", dataIndex: "pnl_pct", align: "right", sorter: (a, b) => a.pnl_pct - b.pnl_pct, render: (v: number) => pct(v) },
        { title: "Best", dataIndex: "mfe_pct", align: "right", render: (v: number) => <Text type="secondary">{pct(v)}</Text> },
        { title: "Worst", dataIndex: "mae_pct", align: "right", render: (v: number) => <Text type="secondary">{pct(v)}</Text> },
      ]}
    />
  );
}

// ---------- Exit lab ----------

function reportInfo(p: T_ButterflyRequest, rules: T_ExitRules): T_ReportInfo {
  const fmt = (d: string) => dayjs(d).format("D MMM YYYY");
  return {
    title: "EMA crossover butterfly",
    subtitle: `NIFTY · ${fmt(p.from_date)} - ${fmt(p.to_date)} · ${p.interval} candles`,
    meta: [
      ["Entry signal", `EMA ${p.fast} / ${p.slow} crossover, next candle open`],
      ["Bullish", `Buy ATM CE, sell 2x ATM+${p.wing} CE, buy ATM+${2 * p.wing} CE`],
      ["Bearish", `Buy ATM PE, sell 2x ATM-${p.wing} PE, buy ATM-${2 * p.wing} PE`],
      ["Expiry", "Nearest weekly after entry day"],
      ["Target", rules.targetPct === null ? "None" : `+${rules.targetPct}% of premium`],
      ["Stop-loss", rules.stopPct === null ? "None" : `-${rules.stopPct}% of premium`],
      ["Square-off", rules.squareOff],
      ["No entries after", rules.lastEntry],
      ["Size", `${p.lots} lot per wing x ${p.lot_size}`],
      ["Costs", `Rs ${p.brokerage_per_order}/order, ${p.slippage_points} pt slippage, taxes ${p.taxes ? "on" : "off"}`],
    ],
    fileName: `ema-butterfly-backtest_${p.from_date}_${p.to_date}.pdf`,
  };
}

function ExitLab({
  result,
  runId,
  savedView,
  autoPdf,
  onPdfDone,
}: {
  result: T_ButterflyResult;
  runId: string | null;
  savedView: T_ExitRules | null;
  autoPdf: boolean;
  onPdfDone: () => void;
}) {
  const intervalMin = INTERVAL_MIN[result.params.interval];
  const [rules, setRules] = useState<T_ExitRules>(savedView ?? { targetPct: 50, stopPct: 30, squareOff: "15:15", lastEntry: "15:00" });
  const deferred = useDeferredValue(rules);
  const { trades, metrics: m } = useMemo(() => simulate(result.candidates, deferred, intervalMin), [result, deferred, intervalMin]);
  const grid = useMemo(
    () => sweep(result.candidates, { squareOff: deferred.squareOff, lastEntry: deferred.lastEntry }, intervalMin),
    [result, deferred.squareOff, deferred.lastEntry, intervalMin],
  );

  const updateRun = useUpdateRun();

  // Keep the saved run in step with the exit settings, so it reopens as left and the list shows these numbers.
  useEffect(() => {
    if (!runId) return;
    const t = setTimeout(
      () => updateRun.mutate({ id: runId, view: deferred, summary: { net_pnl: m.net_pnl, trades: m.trades, win_rate: m.win_rate } }),
      800,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, deferred, m]);

  if (!result.candidates.length) return <Empty description="No crossovers could be traded in this range" />;

  return (
    <ReportScope info={reportInfo(result.params, rules)} savedHint={runId ? "Saved to Saved runs · exit settings save automatically" : undefined}
      autoDownload={autoPdf}
      onAutoDownloaded={onPdfDone}
    >
      <ExitControls rules={rules} setRules={setRules} capitalHint={`avg premium ${inr(m.avg_capital)}`} />

      <div data-report-section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        <StatCard label="Net P&L" value={signedInr(m.net_pnl)} hint={`${pct(m.avg_pnl_pct)} of premium per trade on average`} />
        <StatCard label="Win rate" value={m.win_rate === null ? "–" : `${m.win_rate.toFixed(1)}%`} hint={`${m.wins} of ${m.trades} trades · avg win ${inr(m.avg_win)} · avg loss ${inr(m.avg_loss)}`} />
        <StatCard label="Exits" value={`${m.by_reason.target} / ${m.by_reason.stop} / ${m.by_reason.time}`} hint="Target / stop-loss / time" />
        <StatCard label="Profit factor" value={m.profit_factor?.toFixed(2) ?? "–"} hint="Gross wins ÷ gross losses, after costs" />
        <StatCard label="Max drawdown" value={inr(m.max_drawdown)} hint={`Best ${signedInr(m.best)} · worst ${signedInr(m.worst)}`} />
        <StatCard label="Trades taken" value={m.trades} hint={`${result.candidates.length} crossovers · others fell inside an open trade or after the cut-off`} />
      </div>

      <Heatmap grid={grid} rules={rules} onPick={(targetPct, stopPct) => setRules({ ...rules, targetPct, stopPct })} />

      <div data-report-section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <SectionCard title="How far did trades go?" description="Each point is a trade: its best and worst P&L before square-off. Winners above your target line would have been banked; losers left of the stop line would have been cut.">
          <MfeMaeChart trades={trades} rules={rules} />
        </SectionCard>
        <SectionCard title="Equity curve" description="Cumulative net P&L after each trade with these exit rules.">
          <EquityChart trades={trades} />
        </SectionCard>
      </div>

      <SectionCard title="Signals" description={`NIFTY ${result.params.interval} with EMA ${result.params.fast} / ${result.params.slow}. Only entries taken under the current rules are marked.`}>
        <PriceChart result={result} trades={trades} />
      </SectionCard>

      <SectionCard title="Trades" description="Expand a row for the three legs. Best / worst are the extremes reached before square-off.">
        <TradesTable trades={trades} result={result} />
      </SectionCard>
    </ReportScope>
  );
}

export default function OptionStrategyPage() {
  const [search, setSearch] = useSearchParams();
  const runId = search.get("run");
  const autoPdf = search.get("pdf") === "1";
  const onPdfDone = () => setSearch(runId ? { run: runId } : {}, { replace: true });
  const start = useStartButterfly();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<T_ButterflyResult>(jobId);
  const running = start.isPending || job.data?.status === "running";
  const jobResult = job.data?.status === "done" ? job.data.result : null;
  const saved = useRun<T_ButterflyResult>(jobResult?.run_id === runId ? null : runId);
  const result = jobResult && jobResult.run_id === runId ? jobResult : (saved.data?.result ?? null);

  useEffect(() => {
    if (jobResult?.run_id && jobResult.run_id !== runId) setSearch({ run: jobResult.run_id }, { replace: true });
  }, [jobResult, runId, setSearch]);

  return (
    <div style={{ padding: 24 }}>
      <PageTitle
        title="EMA crossover butterfly"
        description="Entries on 9/21 EMA crossovers. Choose the exit (target, stop-loss, square-off) in the exit lab."
        pageTitle={[backtestCrumb, { title: "EMA butterfly" }]}
      />
      <ConnectionGate>
        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">
          <SectionCard title="Configuration" description="Signal, legs and costs. Exits are set on the right after loading.">
            <ConfigForm
              key={saved.data?.id ?? "new"}
              initial={saved.data?.params as T_ButterflyRequest | undefined}
              onRun={(b) => start.mutate(b, { onSuccess: (r) => setJobId(r.job_id) })}
              running={running}
            />
          </SectionCard>

          <div className="min-w-0 space-y-6">
            {start.error && <Alert type="error" showIcon message={errorMessage(start.error)} />}
            {saved.error && <Alert type="error" showIcon message={errorMessage(saved.error)} />}
            {saved.isLoading && <Spin className="block py-16" />}
            {job.data?.status === "error" && <Alert type="error" showIcon message="Loading trades failed" description={job.data.error} />}
            {job.data?.status === "running" && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                <Text className="block text-[15px] font-semibold mb-2">Loading crossovers and option prices</Text>
                <Progress percent={job.data.total ? Math.round((job.data.done / job.data.total) * 100) : 0} status="active" />
                <Text type="secondary" className="text-xs">{job.data.message}</Text>
              </div>
            )}
            {result && result.skipped.length > 0 && (
              <Alert
                type="warning"
                showIcon
                message={`${result.skipped.length} crossovers couldn't be priced`}
                description={result.skipped.slice(0, 5).map((s) => `${ts(s.time)}: ${s.reason}`).join(" · ") + (result.skipped.length > 5 ? " …" : "")}
              />
            )}
            {result ? (
              <ExitLab
                key={runId ?? "new"}
                result={result}
                runId={runId}
                autoPdf={autoPdf}
                onPdfDone={onPdfDone}
                savedView={(jobResult?.run_id === runId ? null : (saved.data?.view as T_ExitRules | null)) ?? null}
              />
            ) : (
              !running && !saved.isLoading && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm py-16">
                  <Empty description="Load trades, then tune the exit" />
                </div>
              )
            )}
          </div>
        </div>
      </ConnectionGate>
    </div>
  );
}
