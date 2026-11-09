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
  Spin,
  Switch,
  Table,
  Tag,
  Tooltip as AntTooltip,
  Typography,
} from "antd";
import dayjs, { type Dayjs } from "dayjs";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { errorMessage, useDataStatus, useJob, useRun, useStartStraddle, useUpdateRun, type T_StraddleRequest, type T_StraddleResult } from "../api/client";
import type { T_ReportInfo } from "../lib/report";
import {
  bestTargetPerDte,
  compareDtes,
  compareEntries,
  entryLabel,
  formatLevel,
  isOvernight,
  levelsFor,
  normalizeStraddleDays,
  sellMap,
  simulateStraddle,
  sweepTargets,
  upgradeRules,
  type T_ExitReason,
  type T_Levels,
  type T_Side,
  type T_StraddleDay,
  type T_StraddleParams,
  type T_StraddleRules,
  type T_StraddleTrade,
} from "../lib/straddleSim";
import { DEFAULT_SHORT_MARGIN_PCT } from "../lib/fees";
import PageTitle from "../components/PageTitle";
import { backtestCrumb } from "../lib/nav";
import SectionCard from "../components/SectionCard";
import StatCard from "../components/StatCard";
import ConnectionGate from "../components/ConnectionGate";
import ReportScope, { usePrintMode } from "../components/ReportScope";

const { Text } = Typography;

// ---------- Types ----------

type T_FormValues = Omit<T_StraddleRequest, "from_date" | "to_date" | "stock_code" | "entry_time"> & { range: [Dayjs, Dayjs] };

// ---------- Constants ----------

const SERIES_1 = "#2a78d6";
const GOOD = "#22C55E";
const BAD = "#EF4444";
const GRID = "#F4F4F5";
const AXIS = "#A1A1AA";
const MUTED = "#71717A";
const mono = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" };
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function minutes(from: string, to: string, step: number) {
  const toMin = (s: string) => Number(s.slice(0, 2)) * 60 + Number(s.slice(3));
  const out: string[] = [];
  for (let m = toMin(from); m <= toMin(to); m += step) out.push(`${String(Math.floor(m / 60)).padStart(2, "0")}:${String(m % 60).padStart(2, "0")}`);
  return out;
}

const ENTRY_OPTIONS = [
  {
    label: "Previous day, held overnight",
    options: minutes("15:00", "15:40", 1).map((m) => ({ value: `D-1 ${m}`, label: `Prev day ${m}` })),
  },
  {
    label: "Trade day",
    options: [...minutes("09:15", "10:30", 1), ...minutes("10:35", "14:55", 5)].map((m) => ({ value: m, label: m })),
  },
];
const DEFAULT_ENTRIES = ["D-1 15:25", "09:20", "09:30"];
const SQUARE_OFF_TIMES = minutes("09:30", "15:40", 5).map((m) => ({ value: m, label: m }));

// ---------- Helpers ----------

const inr = (n: number | null | undefined, digits = 0) =>
  n === null || n === undefined ? "–" : `${n < 0 ? "−" : ""}₹${Math.abs(n).toLocaleString("en-IN", { maximumFractionDigits: digits })}`;
const signedInr = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${inr(Math.round(n))}`);
const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`);
const dteShort = (d: number) => `${d}DTE`;

// The weekday a DTE usually falls on (holidays can shift it), for the chips.
function usualWeekday(days: T_StraddleDay[], dte: number) {
  const counts = new Map<number, number>();
  days.filter((d) => d.dte === dte).forEach((d) => counts.set(dayjs(d.date).day(), (counts.get(dayjs(d.date).day()) ?? 0) + 1));
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  return top ? WEEKDAYS[top[0]] : "";
}

function Pnl({ value }: { value: number | null }) {
  if (value === null) return <>–</>;
  return <Text type={value > 0 ? "success" : value < 0 ? "danger" : undefined}>{signedInr(value)}</Text>;
}

// ---------- Config ----------

function ConfigForm({ onRun, running, initial }: { onRun: (b: T_StraddleRequest) => void; running: boolean; initial?: T_StraddleRequest }) {
  const [form] = Form.useForm<T_FormValues>();
  const side = Form.useWatch("side", form) ?? initial?.side ?? "buy";
  return (
    <Form<T_FormValues>
      form={form}
      layout="vertical"
      initialValues={
        initial
          ? {
              ...initial,
              side: initial.side ?? "buy",
              entry_times: initial.entry_times ?? (initial.entry_time ? [initial.entry_time] : DEFAULT_ENTRIES),
              range: [dayjs(initial.from_date), dayjs(initial.to_date)],
            }
          : {
              range: [dayjs().subtract(3, "month"), dayjs().subtract(1, "day")],
              side: "buy",
              entry_times: DEFAULT_ENTRIES,
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
      <Form.Item name="side" label="Trade" extra="You can still switch sides in the results; both use the same data.">
        <Segmented
          block
          options={[
            { value: "buy", label: "Option buy (long)" },
            { value: "sell", label: "Option sell (short)" },
          ]}
        />
      </Form.Item>
      <Form.Item name="range" label="Backtest period" rules={[{ required: true }]}>
        <DatePicker.RangePicker
          className="w-full"
          disabledDate={(d) => d.isAfter(dayjs(), "day")}
          presets={[
            { label: "Last month", value: [dayjs().subtract(1, "month"), dayjs().subtract(1, "day")] },
            { label: "Last 3 months", value: [dayjs().subtract(3, "month"), dayjs().subtract(1, "day")] },
            { label: "Last 6 months", value: [dayjs().subtract(6, "month"), dayjs().subtract(1, "day")] },
          ]}
        />
      </Form.Item>
      <Form.Item
        name="entry_times"
        label="Entry times to load"
        rules={[{ required: true, message: "Pick at least one entry time" }]}
        extra="You switch between these instantly in the results. Each costs about 2 Breeze calls per day the first time (CE + PE, 1-minute), fewer when the ATM strike repeats. Previous-day times are skipped on days with no trading at that minute."
      >
        <Select mode="multiple" options={ENTRY_OPTIONS} maxCount={12} placeholder="e.g. Prev day 15:25, 09:20" showSearch optionFilterProp="label" />
      </Form.Item>
      <Form.Item label="Position">
        <div className="rounded-lg border border-zinc-200 p-3">
          <Text type="secondary" className="text-xs block" style={mono}>
            {side === "sell" ? "Sell 1 ATM CE · Sell 1 ATM PE" : "Buy 1 ATM CE · Buy 1 ATM PE"}
          </Text>
          <Text type="secondary" className="text-xs block mt-1">Nearest weekly expiry on or after the trade day (0-DTE on expiry day).</Text>
        </div>
      </Form.Item>

      <Divider className="my-4" />

      <div className="grid grid-cols-2 gap-x-3">
        <Form.Item name="lots" label="Lots per leg">
          <InputNumber min={1} max={50} className="!w-full" />
        </Form.Item>
        <Form.Item name="lot_size" label="Lot size">
          <InputNumber min={1} className="!w-full" />
        </Form.Item>
        <Form.Item name="brokerage_per_order" label="₹ / order">
          <InputNumber min={0} className="!w-full" />
        </Form.Item>
        <Form.Item name="slippage_points" label="Slippage pts" extra="Market orders only">
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
          {running ? "Running…" : "Run backtest"}
        </Button>
      </Form.Item>
    </Form>
  );
}

// ---------- Controls ----------

const SIDE_TEXT = {
  buy: {
    target: "Sell both legs when CE + PE reaches this multiple of the premium paid (limit order).",
    unit: "×",
  },
  sell: {
    target: "Buy back both legs once this % of the premium collected is kept (limit order).",
    unit: "%",
  },
};

function LevelInput({
  side,
  kind,
  value,
  onChange,
  size = "middle",
}: {
  side: T_Side;
  kind: "target" | "stop";
  value: number | null;
  onChange: (v: number | null) => void;
  size?: "small" | "middle";
}) {
  const buy = side === "buy";
  const [last, setLast] = useState(value ?? (kind === "stop" ? 30 : buy ? 1.5 : 50));
  return (
    <div className="flex items-center gap-2">
      <Switch size="small" checked={value !== null} onChange={(c) => onChange(c ? last : null)} />
      <InputNumber
        size={size}
        className="!w-24"
        disabled={value === null}
        min={buy ? 1.01 : 1}
        max={buy ? 5 : kind === "target" ? 99 : 500}
        step={buy ? 0.05 : 5}
        value={value ?? last}
        formatter={(v) => (buy ? `${v}×` : kind === "stop" ? `+${v}%` : `${v}%`)}
        parser={(v) => Number((v ?? "").replace(/[^\d.]/g, ""))}
        onChange={(v) => {
          if (v === null) return;
          setLast(v);
          onChange(v);
        }}
      />
    </div>
  );
}

function PerDayLevels({
  rules,
  setRules,
  dteValues,
  best,
}: {
  rules: T_StraddleRules;
  setRules: (r: T_StraddleRules) => void;
  dteValues: number[];
  best: ReturnType<typeof bestTargetPerDte>;
}) {
  const side = rules.side;
  const current = (dte: number) => levelsFor(rules, dte);
  const setDte = (dte: number, lv: T_Levels) =>
    setRules({ ...rules, dteLevels: { ...rules.dteLevels, [side]: { ...rules.dteLevels[side], [String(dte)]: lv } } });
  const applyBest = () =>
    setRules({
      ...rules,
      dteLevels: {
        ...rules.dteLevels,
        [side]: Object.fromEntries(best.map((b) => [String(b.dte), { ...current(b.dte), target: b.target }])),
      },
    });
  return (
    <div className="rounded-lg border border-zinc-200 overflow-hidden">
      <Table
        size="small"
        rowKey="dte"
        pagination={false}
        dataSource={dteValues.map((dte) => ({ dte }))}
        rowClassName={({ dte }) => (rules.dtes && !rules.dtes.includes(dte) ? "[&>td]:!text-zinc-400" : "")}
        columns={[
          { title: "Day", dataIndex: "dte", render: (d: number) => <Tag color={d === 0 ? "gold" : "default"}>{dteShort(d)}</Tag> },
          {
            title: side === "buy" ? "Target (× premium)" : "Target (% kept)",
            render: (_, { dte }) => (
              <LevelInput size="small" side={side} kind="target" value={current(dte).target} onChange={(target) => setDte(dte, { ...current(dte), target })} />
            ),
          },
          ...(side === "sell"
            ? [
                {
                  title: "Stop-loss (% above)",
                  render: (_: unknown, { dte }: { dte: number }) => (
                    <LevelInput size="small" side={side} kind="stop" value={current(dte).stop} onChange={(stop) => setDte(dte, { ...current(dte), stop })} />
                  ),
                },
              ]
            : []),
          {
            title: "Best target for this day",
            render: (_, { dte }) => {
              const b = best.find((x) => x.dte === dte);
              return b ? (
                <span className="whitespace-nowrap">
                  <Text className="text-xs">{formatLevel(side, "target", b.target)}</Text>{" "}
                  <Text type="secondary" className="text-xs">({signedInr(b.net)})</Text>{" "}
                  <Button size="small" type="link" className="!px-1" onClick={() => setDte(dte, { ...current(dte), target: b.target })}>Use</Button>
                </span>
              ) : "–";
            },
          },
        ]}
      />
      <div className="flex items-center justify-between gap-2 px-3 py-2 bg-zinc-50 border-t border-zinc-200">
        <Text type="secondary" className="text-xs">Best = highest net P&L for that day alone{side === "sell" ? ", with its stop-loss" : ""}. Past results; beware of overfitting.</Text>
        <Button size="small" onClick={applyBest}>Use best for every day</Button>
      </div>
    </div>
  );
}

function RulesControls({
  rules,
  setRules,
  entries,
  days,
  best,
}: {
  rules: T_StraddleRules;
  setRules: (r: T_StraddleRules) => void;
  entries: string[];
  days: T_StraddleDay[];
  best: ReturnType<typeof bestTargetPerDte>;
}) {
  const side = rules.side;
  const lv = rules.levels[side];
  const dteValues = useMemo(() => [...new Set(days.map((d) => d.dte))].sort((a, b) => a - b), [days]);
  const selected = rules.dtes ?? dteValues;
  const toggleDte = (dte: number, on: boolean) => {
    const next = on ? [...selected, dte].sort((a, b) => a - b) : selected.filter((x) => x !== dte);
    if (!next.length) return; // keep at least one kind of day
    setRules({ ...rules, dtes: next.length === dteValues.length ? null : next });
  };
  const setLevels = (next: T_Levels) => setRules({ ...rules, levels: { ...rules.levels, [side]: next } });

  return (
    <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6 space-y-5">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div className="flex items-center gap-3">
          <Text className="text-[15px] font-semibold">Trade rules</Text>
          <Segmented
            value={side}
            onChange={(v) => setRules({ ...rules, side: v as T_Side })}
            options={[
              { value: "buy", label: "Buy straddle" },
              { value: "sell", label: "Sell straddle" },
            ]}
          />
        </div>
        <Text type="secondary" className="text-xs">Every change updates the results instantly</Text>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div>
          <Text className="text-[13px] font-semibold block mb-1">Entry time</Text>
          <Text type="secondary" className="text-xs block mb-2">Prev-day entries are placed near the previous close and held overnight.</Text>
          <Segmented
            value={rules.entry}
            onChange={(v) => setRules({ ...rules, entry: String(v) })}
            options={entries.map((e) => ({ value: e, label: entryLabel(e) }))}
            className="flex-wrap"
          />
        </div>
        <div>
          <div className="flex items-center justify-between mb-1">
            <Text className="text-[13px] font-semibold">Trade on</Text>
            {rules.dtes && (
              <Button size="small" type="link" className="!px-0" onClick={() => setRules({ ...rules, dtes: null })}>
                All days
              </Button>
            )}
          </div>
          <Text type="secondary" className="text-xs block mb-2">Days to expiry, counted in trading days on the day you exit. 0DTE = expiry day.</Text>
          <div className="flex flex-wrap gap-2">
            {dteValues.map((dte) => {
              const on = selected.includes(dte);
              const n = days.filter((d) => d.dte === dte).length;
              return (
                <Tag.CheckableTag
                  key={dte}
                  checked={on}
                  onChange={(c) => toggleDte(dte, c)}
                  className={`!m-0 !px-3 !py-1 !rounded-md !border ${on ? "" : "!border-zinc-200"}`}
                >
                  {dteShort(dte)} · {usualWeekday(days, dte)} <span className="opacity-70">({n})</span>
                </Tag.CheckableTag>
              );
            })}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-[2fr_1fr] gap-6">
        <div>
          <div className="flex items-center justify-between mb-1 gap-3 flex-wrap">
            <Text className="text-[13px] font-semibold">Exit levels</Text>
            <Segmented
              size="small"
              value={rules.perDte ? "per" : "same"}
              onChange={(v) => setRules({ ...rules, perDte: v === "per" })}
              options={[
                { value: "same", label: "Same for all days" },
                { value: "per", label: "Per day (DTE)" },
              ]}
            />
          </div>
          <Text type="secondary" className="text-xs block mb-3">
            {SIDE_TEXT[side].target}
            {side === "sell" ? " Stop-loss buys back both legs if CE + PE rises this % above the premium collected." : " No stop-loss."}
          </Text>
          {rules.perDte ? (
            <PerDayLevels rules={rules} setRules={setRules} dteValues={dteValues} best={best} />
          ) : (
            <div className="flex flex-wrap gap-6">
              <div>
                <Text type="secondary" className="text-xs block mb-1">Target</Text>
                <LevelInput key={`${side}-t`} side={side} kind="target" value={lv.target} onChange={(target) => setLevels({ ...lv, target })} />
              </div>
              {side === "sell" && (
                <div>
                  <Text type="secondary" className="text-xs block mb-1">Stop-loss</Text>
                  <LevelInput key="sell-s" side={side} kind="stop" value={lv.stop} onChange={(stop) => setLevels({ ...lv, stop })} />
                </div>
              )}
            </div>
          )}
        </div>
        <div>
          <Text className="text-[13px] font-semibold block mb-1">Exit time (square-off)</Text>
          <Text type="secondary" className="text-xs block mb-2">On the trade day, if no target{side === "sell" ? " or stop-loss" : ""} was hit.</Text>
          <Select className="w-full" showSearch value={rules.squareOff} options={SQUARE_OFF_TIMES} onChange={(squareOff) => setRules({ ...rules, squareOff })} />
        </div>
      </div>
    </div>
  );
}

// ---------- Charts ----------

function TargetSweepCharts({
  side,
  sweep,
  target,
  onPick,
  perDte,
}: {
  side: T_Side;
  sweep: ReturnType<typeof sweepTargets>;
  target: number | null;
  onPick: (x: number) => void;
  perDte: boolean;
}) {
  const best = sweep.reduce((b, s) => (s.net_pnl > b.net_pnl ? s : b), sweep[0]);
  const fmt = (v: number) => formatLevel(side, "target", v);
  const common = {
    data: sweep,
    margin: { top: 16, right: 16, bottom: 0, left: 0 },
    onClick: (e: { activeLabel?: string | number }) => e?.activeLabel !== undefined && onPick(Number(e.activeLabel)),
  };
  const xAxis = <XAxis dataKey="target" tickFormatter={fmt} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} interval={side === "buy" ? 3 : 1} />;
  const marker = target !== null && !perDte && <ReferenceLine x={target} stroke={MUTED} strokeDasharray="4 3" label={{ value: fmt(target), position: "top", fontSize: 10, fill: MUTED }} />;
  return (
    <SectionCard
      title="Which target?"
      description={`Every ${side === "buy" ? "target from 1.05× to 3×" : "target from 5% to 95% kept (current stop-loss)"}, one level for all selected days, with the current entry and exit time. Best net P&L at ${fmt(best.target)} (${signedInr(best.net_pnl)}). Click a chart to use that target.`}
    >
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <div>
          <Text className="block text-[13px] font-semibold">Net P&L</Text>
          <div className="h-60 cursor-pointer" role="img" aria-label="Net P&L by target">
            <ResponsiveContainer>
              <LineChart {...common}>
                <CartesianGrid stroke={GRID} vertical={false} />
                {xAxis}
                <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={76} />
                <ReferenceLine y={0} stroke={AXIS} />
                {marker}
                <Tooltip formatter={(v) => [signedInr(Number(v)), "Net P&L"]} labelFormatter={(v) => `Target ${fmt(Number(v))}`} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
                <Line dataKey="net_pnl" stroke={SERIES_1} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
        <div>
          <Text className="block text-[13px] font-semibold">Days the target is reached</Text>
          <div className="h-60 cursor-pointer" role="img" aria-label="Percent of days reaching each target">
            <ResponsiveContainer>
              <LineChart {...common}>
                <CartesianGrid stroke={GRID} vertical={false} />
                {xAxis}
                <YAxis domain={[0, 100]} tickFormatter={(v) => `${v}%`} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={44} />
                {marker}
                <Tooltip formatter={(v) => [`${Number(v).toFixed(1)}%`, "Days reaching target"]} labelFormatter={(v) => `Target ${fmt(Number(v))}`} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
                <Line dataKey="hit_rate" stroke={SERIES_1} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>
    </SectionCard>
  );
}

// Diverging blue (gain) ↔ red (loss) around a neutral gray midpoint.
const DIV_POS = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];
const DIV_NEG = ["#fadcdc", "#f5b5b4", "#ee8b8a", "#e34948", "#c23736", "#962827"];

function divergingCell(v: number, maxAbs: number) {
  const x = maxAbs ? Math.max(-1, Math.min(1, v / maxAbs)) : 0;
  if (Math.abs(x) < 0.04) return { background: "#f0efec", color: "#18181B" };
  const ramp = x > 0 ? DIV_POS : DIV_NEG;
  const i = Math.min(ramp.length - 1, Math.floor(Math.abs(x) * ramp.length));
  return { background: ramp[i], color: i >= 3 ? "#FFFFFF" : "#18181B" };
}

function SellMap({ map, rules, onPick }: { map: ReturnType<typeof sellMap>; rules: T_StraddleRules; onPick: (lv: T_Levels) => void }) {
  const cells = map.rows.flatMap((r) => r.cells);
  const maxAbs = Math.max(...cells.map((c) => Math.abs(c.net_pnl)), 1);
  const best = cells.reduce((b, c) => (c.net_pnl > b.net_pnl ? c : b), cells[0]);
  const cur = rules.levels.sell;
  return (
    <SectionCard
      title="Target × stop-loss map"
      description={`Net P&L for every target (% kept) and stop-loss pair, one level for all selected days. Blue = profit, red = loss. Best: target ${formatLevel("sell", "target", best.target)}, stop ${formatLevel("sell", "stop", best.stop)} (${signedInr(best.net_pnl)}). Click a cell to use it.`}
    >
      <div className="overflow-x-auto">
        <table className="border-separate w-full" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th className="text-left px-1 whitespace-nowrap">
                <Text type="secondary" className="text-[10px] font-medium uppercase tracking-wider">Stop ↓ / Target →</Text>
              </th>
              {map.targets.map((t) => (
                <th key={t} className="px-1 min-w-14"><Text type="secondary" className="text-xs font-medium">{t}%</Text></th>
              ))}
            </tr>
          </thead>
          <tbody>
            {map.rows.map((row) => (
              <tr key={String(row.stop)}>
                <td className="px-1 whitespace-nowrap"><Text type="secondary" className="text-xs font-medium">{formatLevel("sell", "stop", row.stop)}</Text></td>
                {row.cells.map((c) => {
                  const selected = !rules.perDte && c.target === cur.target && c.stop === cur.stop;
                  return (
                    <AntTooltip key={c.target} title={`Target ${c.target}% · stop ${formatLevel("sell", "stop", c.stop)}: ${signedInr(c.net_pnl)}, win ${c.win_rate?.toFixed(0) ?? "–"}%, ${c.targets} targets / ${c.stops} stops`}>
                      <td
                        onClick={() => onPick({ target: c.target, stop: c.stop })}
                        className="text-center text-xs rounded-sm py-1.5 px-1 cursor-pointer"
                        style={{ ...divergingCell(c.net_pnl, maxAbs), outline: selected ? "2px solid #18181B" : undefined, outlineOffset: -2 }}
                      >
                        {`${c.net_pnl >= 0 ? "+" : "−"}${(Math.abs(c.net_pnl) / 1000).toFixed(1)}K`}
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

function DailyPnlChart({ trades }: { trades: T_StraddleTrade[] }) {
  const data = trades.map((t) => ({ date: t.date, pnl: Math.round(t.pnl), reason: t.exit_reason }));
  return (
    <div className="h-72" role="img" aria-label="Net P&L per trade day">
      <ResponsiveContainer>
        <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={24} />
          <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={70} />
          <ReferenceLine y={0} stroke={AXIS} />
          <Tooltip
            formatter={(v, _n, item) => [signedInr(Number(v)), item?.payload?.reason === "target" ? "Target hit" : "Squared off"]}
            labelFormatter={(d) => dayjs(d as string).format("ddd D MMM YYYY")}
            cursor={{ fill: "#F4F4F5" }}
          />
          <Bar dataKey="pnl" radius={[4, 4, 0, 0]} isAnimationActive={false}>
            {data.map((d) => <Cell key={d.date} fill={d.pnl >= 0 ? GOOD : BAD} />)}
          </Bar>
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function EquityChart({ trades }: { trades: T_StraddleTrade[] }) {
  const data = useMemo(() => {
    let cum = 0;
    return trades.map((t) => ({ date: t.date, equity: Math.round((cum += t.pnl)) }));
  }, [trades]);
  return (
    <div className="h-72" role="img" aria-label="Cumulative net P&L">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={24} />
          <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={76} />
          <ReferenceLine y={0} stroke={AXIS} />
          <Tooltip formatter={(v) => [signedInr(Number(v)), "Cumulative P&L"]} labelFormatter={(d) => dayjs(d as string).format("ddd D MMM YYYY")} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
          <Line dataKey="equity" stroke={SERIES_1} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// ---------- Comparison tables ----------

const metricColumns = [
  { title: "Days", dataIndex: "trades", align: "right" as const },
  { title: "Win rate", dataIndex: "win_rate", align: "right" as const, render: (v: number | null) => (v === null ? "–" : `${v.toFixed(0)}%`) },
  { title: "Target / stop", align: "right" as const, render: (_: unknown, r: { targets: number; stops: number }) => `${r.targets} / ${r.stops}` },
  { title: "Avg premium", dataIndex: "avg_capital", align: "right" as const, render: (v: number | null) => inr(v) },
  { title: "Avg P&L / day", dataIndex: "avg_pnl", align: "right" as const, render: (v: number | null) => <Pnl value={v} /> },
  { title: "Net P&L", dataIndex: "net_pnl", align: "right" as const, render: (v: number) => <Pnl value={v} /> },
];

function EntryCompareTable({ rows, selected, onPick }: { rows: ReturnType<typeof compareEntries>; selected: string; onPick: (e: string) => void }) {
  return (
    <Table
      size="small"
      rowKey="entry"
      dataSource={rows}
      pagination={false}
      scroll={{ x: "max-content" }}
      onRow={(r) => ({ onClick: () => onPick(r.entry), className: "cursor-pointer" })}
      rowClassName={(r) => (r.entry === selected ? "[&>td]:!bg-blue-50 [&>td]:font-semibold" : "")}
      columns={[{ title: "Entry time", dataIndex: "entry", render: (e: string) => entryLabel(e) }, ...metricColumns]}
    />
  );
}

function DteCompareTable({ rows, selected, onToggle }: { rows: ReturnType<typeof compareDtes>; selected: number[] | null; onToggle: (dte: number) => void }) {
  return (
    <Table
      size="small"
      rowKey="dte"
      dataSource={rows}
      pagination={false}
      scroll={{ x: "max-content" }}
      onRow={(r) => ({ onClick: () => onToggle(r.dte), className: "cursor-pointer" })}
      rowClassName={(r) => (!selected || selected.includes(r.dte) ? "" : "[&>td]:!text-zinc-400")}
      columns={[
        {
          title: "Day",
          dataIndex: "dte",
          render: (d: number) => (
            <span className="whitespace-nowrap">
              <Tag color={!selected || selected.includes(d) ? "blue" : "default"} className="!mr-2">{dteShort(d)}</Tag>
              {d === 0 ? "Expiry day" : `${d} trading day${d > 1 ? "s" : ""} before`}
            </span>
          ),
        },
        ...metricColumns,
      ]}
    />
  );
}

const REASON_TAG: Record<T_ExitReason, { color: string; label: string }> = {
  target: { color: "success", label: "Target" },
  stop: { color: "error", label: "Stop-loss" },
  time: { color: "default", label: "Exit time" },
};

function TradesTable({ trades, side }: { trades: T_StraddleTrade[]; side: T_Side }) {
  const printing = usePrintMode();
  const sell = side === "sell";
  return (
    <Table<T_StraddleTrade>
      size="small"
      rowKey="date"
      dataSource={trades}
      pagination={printing ? false : { pageSize: 25, showSizeChanger: false }}
      scroll={{ x: "max-content" }}
      columns={[
        { title: "Trade day", dataIndex: "date", render: (d: string) => dayjs(d).format("ddd D MMM YY") },
        { title: "DTE", dataIndex: "dte", render: (d: number) => <Tag color={d === 0 ? "gold" : "default"}>{dteShort(d)}</Tag> },
        { title: "Entry", dataIndex: "entry_at", render: (v: string, t) => <span className="whitespace-nowrap">{t.overnight ? dayjs(v).format("ddd HH:mm") : v.slice(11)}</span> },
        { title: "Expiry", dataIndex: "expiry", render: (d: string) => dayjs(d).format("D MMM") },
        { title: "Spot", dataIndex: "spot", align: "right", render: (v: number) => v.toFixed(0) },
        { title: "Strike", dataIndex: "atm", render: (v: number) => <Text style={mono}>{v}</Text> },
        { title: "CE / PE entry", align: "right", render: (_, t) => <Text className="text-xs">{`${t.ce_entry.toFixed(2)} / ${t.pe_entry.toFixed(2)}`}</Text> },
        { title: sell ? "Premium collected" : "Premium paid", dataIndex: "capital", align: "right", render: (v: number) => inr(v) },
        ...(sell
          ? [{ title: "Margin blocked", dataIndex: "margin", align: "right" as const, render: (v: number) => <Text type="secondary">≈ {inr(v)}</Text> }]
          : []),
        {
          title: "Levels",
          render: (_, t) => (
            <Text type="secondary" className="text-xs whitespace-nowrap">
              T {formatLevel(side, "target", t.levels.target)}{sell ? ` · SL ${formatLevel(side, "stop", t.levels.stop)}` : ""}
            </Text>
          ),
        },
        sell
          ? { title: "Lowest reached", dataIndex: "min_x", align: "right", sorter: (a, b) => a.min_x - b.min_x, render: (v: number) => `${v.toFixed(2)}×` }
          : { title: "Best reached", dataIndex: "max_x", align: "right", sorter: (a, b) => a.max_x - b.max_x, render: (v: number) => `${v.toFixed(2)}×` },
        ...(sell ? [{ title: "Highest reached", dataIndex: "max_x", align: "right" as const, render: (v: number) => `${v.toFixed(2)}×` }] : []),
        { title: "Exit", dataIndex: "exit_at", render: (v: string) => v.slice(11) },
        {
          title: "Exit reason",
          dataIndex: "exit_reason",
          filters: (Object.keys(REASON_TAG) as T_ExitReason[]).filter((r) => sell || r !== "stop").map((r) => ({ text: REASON_TAG[r].label, value: r })),
          onFilter: (v, t) => t.exit_reason === v,
          render: (r: T_ExitReason) => <Tag color={REASON_TAG[r].color}>{REASON_TAG[r].label}</Tag>,
        },
        { title: "Exit value", dataIndex: "exit_value", align: "right", render: (v: number, t) => `${v.toFixed(2)} (${(v / t.premium).toFixed(2)}×)` },
        { title: "Costs", dataIndex: "costs", align: "right", render: (v: number) => inr(v) },
        { title: "Net P&L", dataIndex: "pnl", align: "right", sorter: (a, b) => a.pnl - b.pnl, render: (v: number) => <Pnl value={v} /> },
        { title: "% of premium", dataIndex: "pnl_pct", align: "right", render: (v: number) => pct(v) },
        ...(sell ? [{ title: "% of margin", dataIndex: "pnl_margin_pct", align: "right" as const, render: (v: number) => pct(v, 2) }] : []),
      ]}
    />
  );
}

// ---------- Lab ----------

function levelsText(rules: T_StraddleRules, dtes: number[]): string {
  const side = rules.side;
  const one = (lv: T_Levels) =>
    side === "buy"
      ? `target ${formatLevel(side, "target", lv.target)}`
      : `target ${formatLevel(side, "target", lv.target)} kept, SL ${formatLevel(side, "stop", lv.stop)}`;
  if (!rules.perDte) return one(rules.levels[side]);
  return dtes.map((d) => `${dteShort(d)}: ${one(levelsFor(rules, d))}`).join("; ");
}

function reportInfo(p: T_StraddleRequest, rules: T_StraddleRules, trades: number, dtes: number[]): T_ReportInfo {
  const fmt = (d: string) => dayjs(d).format("D MMM YYYY");
  const sell = rules.side === "sell";
  return {
    title: sell ? "ATM straddle (short)" : "ATM straddle (long)",
    subtitle: `NIFTY · ${fmt(p.from_date)} - ${fmt(p.to_date)} · ${trades} trade days`,
    meta: [
      ["Position", `${sell ? "Sell" : "Buy"} ATM CE + PE at ${entryLabel(rules.entry)}${isOvernight(rules.entry) ? " (held overnight)" : ""}`],
      ["Days traded", rules.dtes ? rules.dtes.map(dteShort).join(", ") : "Every day"],
      ["Expiry", "Nearest weekly on or after the trade day"],
      ["Exit levels", levelsText(rules, rules.dtes ?? dtes)],
      ["Exit time", `${rules.squareOff} on the trade day`],
      ["Fills", sell ? "Target: limit buy-back; SL: stop-market + slippage" : "Target: limit sell"],
      ["Size", `${p.lots} lot x ${p.lot_size} per leg`],
      ["Costs", `Rs ${p.brokerage_per_order}/order, ${p.slippage_points} pt slippage, taxes ${p.taxes ? "on" : "off"}`],
    ],
    fileName: `straddle-${rules.side}-backtest_${p.from_date}_${p.to_date}.pdf`,
  };
}

function StraddleLab({
  result,
  runId,
  savedView,
  autoPdf,
  onPdfDone,
}: {
  result: T_StraddleResult;
  runId: string | null;
  savedView: Record<string, unknown> | null;
  autoPdf: boolean;
  onPdfDone: () => void;
}) {
  const { days, entries: loaded } = useMemo(() => normalizeStraddleDays(result.days, result.params), [result]);
  // Only entry times that produced at least one trade day.
  const entries = useMemo(() => loaded.filter((e) => days.some((d) => d.entries[e])), [loaded, days]);
  const dataStatus = useDataStatus();
  const shortMarginPct = dataStatus.data?.settings.short_margin_pct;
  const params = useMemo(
    () => ({ ...(result.params as T_StraddleParams), short_margin_pct: shortMarginPct }),
    [result.params, shortMarginPct],
  );
  const allDtes = useMemo(() => [...new Set(days.map((d) => d.dte))].sort((a, b) => a - b), [days]);

  const [rules, setRules] = useState<T_StraddleRules>(() => {
    const r = upgradeRules(savedView, entries[0] ?? "09:30");
    if (!savedView?.side && result.params.side) r.side = result.params.side;
    return entries.includes(r.entry) ? r : { ...r, entry: entries[0] ?? r.entry };
  });
  const deferred = useDeferredValue(rules);
  const { trades, metrics: m } = useMemo(() => simulateStraddle(days, deferred, params), [days, deferred, params]);
  const sweep = useMemo(() => sweepTargets(days, deferred, params), [days, deferred, params]);
  const best = useMemo(() => (deferred.perDte ? bestTargetPerDte(days, deferred, params) : []), [days, deferred, params]);
  const map = useMemo(() => (deferred.side === "sell" ? sellMap(days, deferred, params) : null), [days, deferred, params]);
  const byEntry = useMemo(() => compareEntries(days, deferred, entries, params), [days, deferred, entries, params]);
  const byDte = useMemo(() => compareDtes(days, deferred, params), [days, deferred, params]);
  const updateRun = useUpdateRun();
  const sell = rules.side === "sell";

  // Keep the saved run in step with the rules, so it reopens as left and the list shows these numbers.
  useEffect(() => {
    if (!runId) return;
    const t = setTimeout(
      () =>
        updateRun.mutate({
          id: runId,
          view: deferred,
          summary: { net_pnl: m.net_pnl, trades: m.trades, win_rate: m.win_rate, target_hits: m.targets, stops: m.stops },
        }),
      800,
    );
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [runId, deferred, m]);

  if (!days.length || !entries.length) return <Empty description="No tradable days in this period" />;

  const toggleDte = (dte: number) => {
    const sel = rules.dtes ?? allDtes;
    const next = sel.includes(dte) ? sel.filter((x) => x !== dte) : [...sel, dte].sort((a, b) => a - b);
    if (next.length) setRules({ ...rules, dtes: next.length === allDtes.length ? null : next });
  };
  const applyLevels = (lv: T_Levels) => setRules({ ...rules, perDte: false, levels: { ...rules.levels, [rules.side]: lv } });

  return (
    <ReportScope
      info={reportInfo(result.params, rules, m.trades, allDtes)}
      savedHint={runId ? "Saved to Saved runs · rules save automatically" : undefined}
      autoDownload={autoPdf}
      onAutoDownloaded={onPdfDone}
    >
      <RulesControls key={rules.side} rules={rules} setRules={setRules} entries={entries} days={days} best={best} />

      <div data-report-section className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 gap-3">
        <StatCard label="Net P&L" value={signedInr(m.net_pnl)} hint={`${signedInr(m.avg_pnl)} per trade day on average`} />
        <StatCard label="Win rate" value={m.win_rate === null ? "–" : `${m.win_rate.toFixed(1)}%`} hint={`${m.wins} of ${m.trades} days profitable`} />
        <StatCard
          label={sell ? "Target / stop-loss / exit time" : "Target hit"}
          value={sell ? `${m.targets} / ${m.stops} / ${m.time_exits}` : `${m.targets} / ${m.trades}`}
          hint={sell ? `Exit time ${rules.squareOff}` : `${m.time_exits} closed at ${rules.squareOff}`}
        />
        <StatCard
          label={sell ? "Avg premium collected" : "Avg premium paid"}
          value={inr(m.avg_capital)}
          hint={sell ? "Most you can make on a day; losses aren't capped" : "Also the most you can lose on a day"}
        />
        {sell && (
          <StatCard
            label="Margin blocked"
            value={`≈ ${inr(m.peak_margin)}`}
            hint={`Exchange margin to sell, ~${shortMarginPct ?? DEFAULT_SHORT_MARGIN_PCT}% of spot × qty (estimate). Return on it: ${pct(m.return_on_margin_pct)}`}
          />
        )}
        <StatCard label="Max drawdown" value={inr(m.max_drawdown)} hint={`Best day ${signedInr(m.best)} · worst ${signedInr(m.worst)}`} />
        <StatCard label="Profit factor" value={m.profit_factor?.toFixed(2) ?? "–"} hint="Gross wins ÷ gross losses, after costs" />
      </div>

      <div className="space-y-6">
        <SectionCard title="Compare entry times" description="Each loaded entry time with the current side, days and exit levels. Click a row to use it.">
          <EntryCompareTable rows={byEntry} selected={rules.entry} onPick={(entry) => setRules({ ...rules, entry })} />
        </SectionCard>
        <SectionCard title="Compare days to expiry" description="Each DTE on its own with the current side, entry and exit levels. Click to include or exclude it.">
          <DteCompareTable rows={byDte} selected={rules.dtes} onToggle={toggleDte} />
        </SectionCard>
      </div>

      {map && <SellMap map={map} rules={rules} onPick={applyLevels} />}

      <TargetSweepCharts
        side={rules.side}
        sweep={sweep}
        target={rules.levels[rules.side].target}
        perDte={rules.perDte}
        onPick={(target) => applyLevels({ ...rules.levels[rules.side], target })}
      />

      <div data-report-section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <SectionCard title="Daily P&L" description="Net P&L of each trade day. Green = profit, red = loss.">
          <DailyPnlChart trades={trades} />
        </SectionCard>
        <SectionCard title="Equity curve" description="Cumulative net P&L.">
          <EquityChart trades={trades} />
        </SectionCard>
      </div>

      <SectionCard
        title="Trades"
        description={sell ? "One short straddle per trade day. Lowest / highest = the straddle's range before the exit time, as a multiple of premium collected." : "One straddle per trade day. Best reached = highest value before the exit time, as a multiple of premium."}
      >
        <TradesTable trades={trades} side={rules.side} />
      </SectionCard>
    </ReportScope>
  );
}

// Group skipped (day, entry) pairs by entry and reason, so 40 identical lines read as one.
function SkippedAlert({ skipped }: { skipped: T_StraddleResult["skipped"] }) {
  const groups = new Map<string, number>();
  skipped.forEach((s) => {
    const entry = (s as { entry?: string }).entry;
    const key = `${entry && entry !== "all" ? `${entryLabel(entry)}: ` : ""}${s.reason.replace(/ on \d+ \w+$/, "")}`;
    groups.set(key, (groups.get(key) ?? 0) + 1);
  });
  return (
    <Alert
      type="warning"
      showIcon
      message={`${skipped.length} day / entry combinations couldn't be traded`}
      description={[...groups.entries()].map(([k, n]) => `${k} (${n} day${n > 1 ? "s" : ""})`).join(" · ")}
    />
  );
}

export default function StraddlePage() {
  const [search, setSearch] = useSearchParams();
  const runId = search.get("run");
  const autoPdf = search.get("pdf") === "1";
  const onPdfDone = () => setSearch(runId ? { run: runId } : {}, { replace: true });
  const start = useStartStraddle();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<T_StraddleResult>(jobId);
  const running = start.isPending || job.data?.status === "running";
  const jobResult = job.data?.status === "done" ? job.data.result : null;
  const saved = useRun<T_StraddleResult>(jobResult?.run_id === runId ? null : runId);
  const result = jobResult && jobResult.run_id === runId ? jobResult : (saved.data?.result ?? null);

  useEffect(() => {
    if (jobResult?.run_id && jobResult.run_id !== runId) setSearch({ run: jobResult.run_id }, { replace: true });
  }, [jobResult, runId, setSearch]);

  return (
    <div style={{ padding: 24 }}>
      <PageTitle
        title="ATM straddle"
        description="Buy or sell the NIFTY ATM straddle (previous evening or that morning). Exit at a target (per day if you like), a stop-loss when selling, or the exit time."
        pageTitle={[backtestCrumb, { title: "Straddle" }]}
      />
      <ConnectionGate>
        <div className="grid grid-cols-1 lg:grid-cols-[340px_1fr] gap-6 items-start">
          <SectionCard title="Configuration" description="Period, entry times to load and costs.">
            <ConfigForm
              key={saved.data?.id ?? "new"}
              initial={saved.data?.params as T_StraddleRequest | undefined}
              onRun={(b) => start.mutate(b, { onSuccess: (r) => setJobId(r.job_id) })}
              running={running}
            />
          </SectionCard>

          <div className="min-w-0 space-y-6">
            {start.error && <Alert type="error" showIcon message={errorMessage(start.error)} />}
            {saved.error && <Alert type="error" showIcon message={errorMessage(saved.error)} />}
            {saved.isLoading && <Spin className="block py-16" />}
            {job.data?.status === "error" && <Alert type="error" showIcon message="Backtest failed" description={job.data.error} />}
            {job.data?.status === "running" && (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
                <Text className="block text-[15px] font-semibold mb-2">Loading each day's straddles</Text>
                <Progress percent={job.data.total ? Math.round((job.data.done / job.data.total) * 100) : 0} status="active" />
                <Text type="secondary" className="text-xs">{job.data.message}</Text>
              </div>
            )}
            {result && result.skipped.length > 0 && <SkippedAlert skipped={result.skipped} />}
            {result ? (
              <StraddleLab
                key={runId ?? "new"}
                result={result}
                runId={runId}
                autoPdf={autoPdf}
                onPdfDone={onPdfDone}
                savedView={jobResult?.run_id === runId ? null : (saved.data?.view as Record<string, unknown> | null) ?? null}
              />
            ) : (
              !running && !saved.isLoading && (
                <div className="bg-white rounded-2xl border border-gray-100 shadow-sm py-16">
                  <Empty description="Choose a period and entry times, then run the backtest" />
                </div>
              )
            )}
          </div>
        </div>
      </ConnectionGate>
    </div>
  );
}
