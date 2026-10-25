import { useMemo, useState } from "react";
import { Alert, Button, Empty, Table, Tag, Typography } from "antd";
import { PlayCircleOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import { Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { T_Breakdown, T_EngineLeg, T_EngineResult, T_EngineTrade } from "../api/client";
import { describeSpec } from "../lib/spec";
import type { T_ReportInfo } from "../lib/report";
import ReportScope, { usePrintMode } from "./ReportScope";
import ReplayDrawer from "./ReplayDrawer";
import SectionCard from "./SectionCard";
import StatCard from "./StatCard";

const { Text } = Typography;

const SERIES = "#4F46E5";
const GOOD = "#22C55E";
const BAD = "#EF4444";
const GRID = "#F1F5F9";
const AXIS = "#94A3B8";
const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const REASONS: Record<string, { label: string; color: string }> = {
  target: { label: "Target", color: "success" },
  stop: { label: "Stop-loss", color: "error" },
  trail: { label: "Trailing stop", color: "orange" },
  time: { label: "Square-off", color: "default" },
  leg_stop: { label: "Leg stop", color: "volcano" },
  leg_target: { label: "Leg target", color: "lime" },
  signal: { label: "Exit signal", color: "purple" },
  opposite_signal: { label: "Opposite signal", color: "purple" },
  spot_move: { label: "Spot move", color: "gold" },
};

const inr = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${n < 0 ? "−" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
const signed = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${inr(n)}`);

function Pnl({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <>–</>;
  return <Text type={v > 0 ? "success" : v < 0 ? "danger" : undefined} className="tabular-nums">{signed(v)}</Text>;
}

function BreakdownTable({ title, data, label }: { title: string; data: T_Breakdown; label: (k: string) => string }) {
  const rows = Object.entries(data).map(([k, v]) => ({ key: k, ...v }));
  return (
    <div>
      <Text className="block text-[13px] font-semibold mb-2">{title}</Text>
      <Table
        size="small"
        pagination={false}
        dataSource={rows}
        columns={[
          { title: "", dataIndex: "key", render: label },
          { title: "Trades", dataIndex: "trades", align: "right" },
          { title: "Win %", dataIndex: "win_rate", align: "right", render: (v: number) => `${v.toFixed(0)}%` },
          { title: "Net P&L", dataIndex: "net_pnl", align: "right", render: (v: number) => <Pnl v={v} /> },
        ]}
      />
    </div>
  );
}

function TradesTable({ trades, onReplay }: { trades: T_EngineTrade[]; onReplay?: (index: number) => void }) {
  const printing = usePrintMode();
  return (
    <Table<T_EngineTrade & { n: number }>
      size="small"
      rowKey="n"
      dataSource={trades.map((t, i) => ({ ...t, n: i + 1 }))}
      pagination={printing ? false : { pageSize: 25, showSizeChanger: false }}
      scroll={{ x: "max-content" }}
      expandable={{
        expandedRowRender: (t) => (
          <Table<T_EngineLeg>
            size="small"
            rowKey="id"
            pagination={false}
            dataSource={t.legs}
            columns={[
              { title: "Leg", dataIndex: "id" },
              { title: "", dataIndex: "action", render: (a: string) => <Tag color={a === "buy" ? "green" : "red"}>{a === "buy" ? "Buy" : "Sell"}</Tag> },
              { title: "Contract", dataIndex: "label" },
              { title: "Qty", dataIndex: "qty", align: "right" },
              { title: "Entry", dataIndex: "entry", align: "right", render: (v: number) => v.toFixed(2) },
              { title: "Exit", dataIndex: "exit", align: "right", render: (v: number | null) => v?.toFixed(2) ?? "–" },
              { title: "Exit at", dataIndex: "exit_at", render: (v: string | null) => v?.slice(11) ?? "–" },
              { title: "Reason", dataIndex: "reason", render: (r: string | null) => (r ? <Tag color={REASONS[r]?.color}>{REASONS[r]?.label ?? r}</Tag> : "–") },
              { title: "P&L", dataIndex: "pnl", align: "right", render: (v: number | null) => <Pnl v={v} /> },
            ]}
          />
        ),
      }}
      columns={[
        { title: "#", dataIndex: "n", width: 48 },
        { title: "Day", dataIndex: "trade_day", render: (d: string) => dayjs(d).format("ddd D MMM YY") },
        { title: "DTE", dataIndex: "dte", render: (d: number) => <Tag color={d === 0 ? "gold" : "default"}>{d}DTE</Tag> },
        { title: "Side", dataIndex: "direction", render: (d: string | null) => (d ? <Text style={{ color: d === "bullish" ? GOOD : BAD }}>{d === "bullish" ? "▲ Bull" : "▼ Bear"}</Text> : "–") },
        { title: "Entry", dataIndex: "entry_at", render: (v: string, t) => (v.slice(0, 10) === t.trade_day ? v.slice(11) : dayjs(v).format("ddd HH:mm")) },
        { title: "Exit", dataIndex: "exit_at", render: (v: string | null) => v?.slice(11) ?? "–" },
        {
          title: "Reason",
          dataIndex: "reason",
          filters: Object.entries(REASONS).map(([value, r]) => ({ text: r.label, value })),
          onFilter: (v, t) => t.reason === v,
          render: (r: string) => <Tag color={REASONS[r]?.color}>{REASONS[r]?.label ?? r}</Tag>,
        },
        { title: "Spot", dataIndex: "spot_entry", align: "right", render: (v: number) => v.toFixed(0) },
        { title: "Premium", dataIndex: "premium", align: "right", render: (v: number) => <Text className="tabular-nums">{v >= 0 ? `${inr(v)} paid` : `${inr(-v)} recd`}</Text> },
        { title: "Costs", dataIndex: "costs", align: "right", render: inr },
        { title: "Net P&L", dataIndex: "net", align: "right", sorter: (a, b) => a.net - b.net, render: (v: number) => <Pnl v={v} /> },
        { title: "% prem", dataIndex: "pct", align: "right", render: (v: number | null) => (v === null ? "–" : `${v > 0 ? "+" : ""}${v.toFixed(1)}%`) },
        ...(onReplay && !printing
          ? [{ title: "", key: "replay", render: (_: unknown, t: T_EngineTrade & { n: number }) => (
              <Button size="small" type="link" icon={<PlayCircleOutlined />} onClick={() => onReplay(t.n - 1)}>Replay</Button>
            ) }]
          : []),
      ]}
    />
  );
}

function reportInfoFor(result: T_EngineResult): T_ReportInfo {
  const s = result.params.spec;
  const fmt = (d: string) => dayjs(d).format("D MMM YYYY");
  return {
    title: s.name,
    subtitle: `${s.underlying} · ${fmt(result.params.from_date)} - ${fmt(result.params.to_date)} · ${result.metrics.trades} trades`,
    meta: describeSpec(s).map((line, i) => [i === 0 ? "Strategy" : "", line] as [string, string]),
    fileName: `${s.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}_${result.params.from_date}_${result.params.to_date}.pdf`,
  };
}

export default function StrategyResults({ result, runId, autoPdf, onPdfDone }: { result: T_EngineResult; runId: string | null; autoPdf?: boolean; onPdfDone?: () => void }) {
  const [replay, setReplay] = useState<number | null>(null);
  const m = result.metrics;
  const b = result.breakdowns;
  const daily = useMemo(() => {
    const by = new Map<string, number>();
    result.trades.forEach((t) => by.set(t.trade_day, (by.get(t.trade_day) ?? 0) + t.net));
    return [...by.entries()].map(([day, pnl]) => ({ day, pnl: Math.round(pnl) }));
  }, [result]);
  const equity = useMemo(() => {
    let c = 0;
    return daily.map((d) => ({ day: d.day, equity: (c += d.pnl) }));
  }, [daily]);

  if (!result.trades.length) {
    return (
      <div className="space-y-4">
        {result.skipped.length > 0 && <Alert type="warning" showIcon message={`${result.skipped.length} entries couldn't be traded`} description={result.skipped.slice(0, 4).map((s) => s.reason).join(" · ")} />}
        <div className="bg-white rounded-2xl border border-slate-200/70 py-14"><Empty description={`No trades in ${result.trade_days} eligible days. Loosen the entry conditions or the day filters.`} /></div>
      </div>
    );
  }

  return (
    <ReportScope info={reportInfoFor(result)} savedHint={runId ? "Saved to Saved runs" : undefined} autoDownload={autoPdf} onAutoDownloaded={onPdfDone}>
      {result.skipped.length > 0 && (
        <Alert type="warning" showIcon message={`${result.skipped.length} entries couldn't be traded`}
          description={[...new Set(result.skipped.map((s) => s.reason.replace(/ on \d+ \w+$/, "")))].slice(0, 4).join(" · ")} />
      )}

      <div data-report-section className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Net P&L" value={signed(m.net_pnl)} hint={`${signed(m.avg_trade)} per trade · costs ${inr(m.costs)}`} />
        <StatCard label="Win rate" value={m.win_rate === null ? "–" : `${m.win_rate.toFixed(1)}%`} hint={`${m.wins} of ${m.trades} trades · ${m.days_traded} days`} />
        <StatCard label="Max drawdown" value={inr(m.max_drawdown)} hint={`Longest losing streak ${m.longest_losing_streak}`} />
        <StatCard label="Profit factor" value={m.profit_factor?.toFixed(2) ?? "–"} hint={`Sharpe ${m.sharpe ?? "–"} · Sortino ${m.sortino ?? "–"}`} />
        <StatCard label="Avg win / loss" value={`${inr(m.avg_win)} / ${inr(m.avg_loss)}`} hint={`Best ${signed(m.best)} · worst ${signed(m.worst)}`} />
        <StatCard label="Avg premium" value={inr(m.avg_capital)} hint="Net premium per trade" />
        <StatCard label="Exits" value={Object.values(m.exit_reasons).reduce((a, b2) => a + b2, 0)}
          hint={Object.entries(m.exit_reasons).map(([k, v]) => `${REASONS[k]?.label ?? k} ${v}`).join(" · ")} />
        <StatCard label="Stale fills" value={`${m.stale_fill_pct}%`} hint="Legs filled after the entry minute (illiquid strikes)" />
      </div>

      <div data-report-section className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <SectionCard title="Equity curve" description="Cumulative net P&L by day.">
          <div className="h-64">
            <ResponsiveContainer>
              <LineChart data={equity} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="day" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={30} />
                <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={76} />
                <ReferenceLine y={0} stroke={AXIS} />
                <Tooltip formatter={(v) => [signed(Number(v)), "Cumulative"]} labelFormatter={(d) => dayjs(d as string).format("ddd D MMM YYYY")} />
                <Line dataKey="equity" stroke={SERIES} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>
        <SectionCard title="Daily P&L" description="Net P&L of each trading day.">
          <div className="h-64">
            <ResponsiveContainer>
              <BarChart data={daily} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                <CartesianGrid stroke={GRID} vertical={false} />
                <XAxis dataKey="day" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={30} />
                <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={70} />
                <ReferenceLine y={0} stroke={AXIS} />
                <Tooltip formatter={(v) => [signed(Number(v)), "Net P&L"]} labelFormatter={(d) => dayjs(d as string).format("ddd D MMM YYYY")} cursor={{ fill: "#F8FAFC" }} />
                <Bar dataKey="pnl" radius={[4, 4, 0, 0]} isAnimationActive={false}>
                  {daily.map((d) => <Cell key={d.day} fill={d.pnl >= 0 ? GOOD : BAD} />)}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </SectionCard>
      </div>

      <SectionCard title="Breakdowns" description="Where the P&L came from.">
        <div className="grid grid-cols-1 lg:grid-cols-2 2xl:grid-cols-4 gap-6">
          <BreakdownTable title="By month" data={b.monthly} label={(k) => dayjs(`${k}-01`).format("MMM YYYY")} />
          <BreakdownTable title="By days to expiry" data={b.by_dte} label={(k) => (k === "0" ? "0DTE (expiry)" : `${k}DTE`)} />
          <BreakdownTable title="By weekday" data={b.by_weekday} label={(k) => WEEKDAYS[Number(k)]} />
          <BreakdownTable title="By exit reason" data={b.by_reason} label={(k) => REASONS[k]?.label ?? k} />
          {Object.keys(b.by_direction).length > 1 && <BreakdownTable title="By direction" data={b.by_direction} label={(k) => k} />}
        </div>
      </SectionCard>

      <SectionCard title="Trades" description="Expand a trade to see each leg's fills, or replay it minute by minute.">
        <TradesTable trades={result.trades} onReplay={runId ? setReplay : undefined} />
      </SectionCard>
      {runId && <ReplayDrawer runId={runId} index={replay} onClose={() => setReplay(null)} />}
    </ReportScope>
  );
}
