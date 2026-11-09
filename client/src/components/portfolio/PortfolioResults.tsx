import { useMemo, useState } from "react";
import { Alert, Table, Tabs, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import type { T_EngineResult, T_PortfolioMemberSummary, T_PortfolioResult } from "../../api/client";
import { describeGate } from "../../lib/portfolio";
import type { T_ReportInfo } from "../../lib/report";
import { REGIME_LABELS } from "../../lib/spec";
import ReplayDrawer from "../ReplayDrawer";
import ReportScope from "../ReportScope";
import SectionCard from "../SectionCard";
import StatCard from "../StatCard";
import StrategyResults, { TradesTable } from "../StrategyResults";

const { Text } = Typography;

const TOTAL = "#4F46E5";
const MEMBER_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#00a2b8", "#8a6d3b", "#5b6b7f", "#b04fc4"];
const GRID = "#F1F5F9";
const AXIS = "#94A3B8";
const BAD = "#EF4444";

const inr = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${n < 0 ? "−" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
const signed = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${inr(n)}`);
const pct = (n: number | null | undefined, digits = 1) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${n.toFixed(digits)}%`);

function Pnl({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <>–</>;
  return <Text type={v > 0 ? "success" : v < 0 ? "danger" : undefined} className="tabular-nums">{signed(v)}</Text>;
}

// Signed P&L cell with a green / red tint scaled to the largest value in the table.
function HeatCell({ v, max }: { v: number | undefined; max: number }) {
  if (v === undefined) return <Text type="secondary">·</Text>;
  const a = max ? Math.min(1, Math.abs(v) / max) * 0.35 : 0;
  return (
    <span className="inline-block w-full px-2 py-0.5 rounded tabular-nums text-right"
      style={{ background: v >= 0 ? `rgba(34,197,94,${a})` : `rgba(239,68,68,${a})` }}>
      {signed(v)}
    </span>
  );
}

function reportInfoFor(r: T_PortfolioResult): T_ReportInfo {
  const p = r.params.portfolio;
  const fmt = (d: string) => dayjs(d).format("D MMM YYYY");
  return {
    title: p.name,
    subtitle: `Portfolio · ${fmt(r.params.from_date)} - ${fmt(r.params.to_date)} · ${r.members.length} algos · ${r.metrics.trades} trades`,
    meta: r.members.map((m, i) => [i === 0 ? "Algos" : "", `${m.name} (x${m.lots}) - ${describeGate(m.gate)}`] as [string, string]),
    fileName: `${p.name.toLowerCase().replace(/[^a-z0-9]+/g, "-")}_${r.params.from_date}_${r.params.to_date}.pdf`,
  };
}

function MembersTable({ members, colors, onOpen }: { members: T_PortfolioMemberSummary[]; colors: Record<string, string>; onOpen: (id: string) => void }) {
  return (
    <Table<T_PortfolioMemberSummary>
      size="small"
      rowKey="id"
      pagination={false}
      dataSource={members}
      scroll={{ x: "max-content" }}
      onRow={(m) => ({ onClick: () => onOpen(m.id), className: "cursor-pointer" })}
      columns={[
        {
          title: "Algo", dataIndex: "name", render: (n: string, m) => (
            <div className="flex items-center gap-2">
              <span className="inline-block w-2.5 h-2.5 rounded-full shrink-0" style={{ background: colors[m.id] }} />
              <div className="min-w-0">
                <Text className="text-[13px] font-medium">{n}</Text>{m.lots > 1 && <Tag className="!ml-2">×{m.lots}</Tag>}
                <Text type="secondary" className="block text-xs">{describeGate(m.gate)}</Text>
              </div>
            </div>
          ),
        },
        { title: "Holding", dataIndex: "holding", render: (h?: string) => (h ? <Tag color={h === "swing" ? "purple" : "default"}>{h === "swing" ? "Multi-day" : "Intraday"}</Tag> : "–") },
        { title: "Trades", align: "right", render: (_, m) => m.error ? <Text type="danger" className="text-xs">{m.error}</Text> : m.metrics?.trades },
        { title: "Net P&L", align: "right", sorter: (a, b) => (a.metrics?.net_pnl ?? 0) - (b.metrics?.net_pnl ?? 0), render: (_, m) => <Pnl v={m.metrics?.net_pnl} /> },
        { title: "Share", dataIndex: "contribution_pct", align: "right", render: (v?: number | null) => pct(v, 0) },
        { title: "Win %", align: "right", render: (_, m) => (m.metrics?.win_rate == null ? "–" : `${m.metrics.win_rate.toFixed(0)}%`) },
        { title: "PF", align: "right", render: (_, m) => m.metrics?.profit_factor?.toFixed(2) ?? "–" },
        { title: "Max DD", align: "right", render: (_, m) => inr(m.metrics?.max_drawdown) },
        { title: "Sharpe", align: "right", render: (_, m) => m.metrics?.sharpe ?? "–" },
        { title: "In market", dataIndex: "in_market_pct", align: "right", render: (v?: number | null) => (v == null ? "–" : `${v.toFixed(0)}% of days`) },
      ]}
    />
  );
}

function Combined({ result, runId, colors, onOpen }: { result: T_PortfolioResult; runId: string | null; colors: Record<string, string>; onOpen: (id: string) => void }) {
  const m = result.metrics;
  const ok = result.members.filter((x) => !x.error);
  const names = Object.fromEntries(result.members.map((x) => [x.id, x.name]));
  const [replay, setReplay] = useState<{ member: string; index: number } | null>(null);

  const underwater = useMemo(() => {
    let peak = 0;
    return result.equity.map((r) => {
      peak = Math.max(peak, r.total);
      return { d: r.d, dd: Math.round(r.total - peak) };
    });
  }, [result]);

  const months = Object.keys(result.monthly);
  const monthRows = months.map((k) => {
    const row = result.monthly[k];
    return { key: k, cells: row, total: Object.values(row).reduce((a, b) => a + b, 0) };
  });
  const monthMax = Math.max(1, ...monthRows.flatMap((r) => ok.map((x) => Math.abs(r.cells[x.id] ?? 0))));
  const monthTotMax = Math.max(1, ...monthRows.map((r) => Math.abs(r.total)));

  const regimes = result.by_regime;
  const regimeRows = regimes
    ? REGIME_LABELS.trend_vol.map((l) => ({ key: String(l.value), label: l.label, days: regimes.days[String(l.value)] ?? 0, cells: regimes.trades[String(l.value)] ?? {} }))
    : [];
  const regimeMax = Math.max(1, ...regimeRows.flatMap((r) => Object.values(r.cells).map((c) => Math.abs(c.net_pnl))));

  // Combined trades → each member's own trade index, for the replay endpoint.
  const openReplay = (n: number) => {
    const t = result.trades[n];
    const own = result.member_results[t.member] as T_EngineResult;
    const index = own.trades.findIndex((x) => x.entry_at === t.entry_at);
    if (index >= 0) setReplay({ member: t.member, index });
  };

  return (
    <div className="space-y-6">
      <div data-report-section className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Net P&L" value={signed(m.net_pnl)} hint={`${pct(m.return_pct, 2)} of ${inr(m.capital)} · costs ${inr(m.costs)}`} />
        <StatCard label="Max drawdown" value={inr(m.max_drawdown)} hint={`${pct(m.max_drawdown_pct, 1)} of capital · daily mark-to-market`} />
        <StatCard label="Sharpe" value={m.sharpe ?? "–"} hint={`Sortino ${m.sortino ?? "–"} · profit factor ${m.profit_factor?.toFixed(2) ?? "–"}`} />
        <StatCard label="Trades" value={m.trades} hint={`Win rate ${m.win_rate?.toFixed(1) ?? "–"}% · ${m.days_in_market ?? m.days_traded} of ${result.trading_days} days in market`} />
        <StatCard label="Algos" value={`${ok.length}`} hint={`${ok.filter((x) => (x.metrics?.net_pnl ?? 0) > 0).length} profitable · ${result.members.length - ok.length} failed`} />
        <StatCard label="Peak open positions" value={m.peak_open_positions} hint="Most positions open at once, across algos" />
        <StatCard label="Peak combined margin" value={inr(m.peak_combined_margin)} hint="Margin of positions open at the same time" />
        <StatCard label="Best / worst trade" value={`${signed(m.best)} / ${signed(m.worst)}`} hint={`Avg ${signed(m.avg_trade)} per trade`} />
      </div>

      <SectionCard title="Equity" description="Cumulative net P&L of the portfolio and each algo, open multi-day positions marked at each close.">
        <div className="h-80">
          <ResponsiveContainer>
            <LineChart data={result.equity} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="d" tickFormatter={(d) => dayjs(d).format("D MMM YY")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={40} />
              <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={80} />
              <ReferenceLine y={0} stroke={AXIS} />
              <Tooltip formatter={(v, k) => [signed(Number(v)), k === "total" ? "Portfolio" : names[String(k)] ?? k]} labelFormatter={(d) => dayjs(d as string).format("ddd D MMM YYYY")} />
              <Legend formatter={(k) => (k === "total" ? "Portfolio" : names[String(k)] ?? k)} wrapperStyle={{ fontSize: 12 }} />
              {ok.map((x) => <Line key={x.id} dataKey={x.id} stroke={colors[x.id]} strokeWidth={1.5} dot={false} isAnimationActive={false} />)}
              <Line dataKey="total" stroke={TOTAL} strokeWidth={2.5} dot={false} isAnimationActive={false} />
            </LineChart>
          </ResponsiveContainer>
        </div>
        <div className="h-28 mt-2">
          <ResponsiveContainer>
            <AreaChart data={underwater} margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
              <CartesianGrid stroke={GRID} vertical={false} />
              <XAxis dataKey="d" hide />
              <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 10, fill: AXIS }} stroke={GRID} width={80} />
              <Tooltip formatter={(v) => [inr(Number(v)), "Below peak"]} labelFormatter={(d) => dayjs(d as string).format("ddd D MMM YYYY")} />
              <Area dataKey="dd" stroke={BAD} fill={BAD} fillOpacity={0.12} strokeWidth={1.5} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <Text type="secondary" className="text-xs">Lower chart: portfolio drawdown from its running peak.</Text>
      </SectionCard>

      <SectionCard title="Algos" description="Each algo's own result inside the portfolio. Click a row to open its full report.">
        <MembersTable members={result.members} colors={colors} onOpen={onOpen} />
      </SectionCard>

      <div data-report-section className="grid grid-cols-1 2xl:grid-cols-2 gap-6">
        <SectionCard title="By market regime" description="Net P&L of trades by the daily regime known at entry (trend × India VIX). Shows which algo earns in which cycle.">
          {!regimes ? <Text type="secondary" className="text-xs">Regime labels weren't available for this run (needs daily candles; log in to Breeze).</Text> : (
            <Table
              size="small"
              pagination={false}
              rowKey="key"
              scroll={{ x: "max-content" }}
              dataSource={regimeRows}
              columns={[
                { title: "Regime", dataIndex: "label", render: (l: string, r) => <div><Text className="text-[13px]">{l}</Text><Text type="secondary" className="block text-xs">{r.days} days</Text></div> },
                ...ok.map((x) => ({
                  title: <span style={{ color: colors[x.id] }}>{x.name}</span>,
                  key: x.id,
                  align: "right" as const,
                  render: (_: unknown, r: (typeof regimeRows)[number]) => {
                    const c = r.cells[x.id];
                    return c ? <div><HeatCell v={c.net_pnl} max={regimeMax} /><Text type="secondary" className="block text-[11px] text-right">{c.trades} trades</Text></div> : <Text type="secondary">·</Text>;
                  },
                })),
              ]}
            />
          )}
        </SectionCard>
        <SectionCard title="Correlation" description="Correlation of the algos' daily P&L. Low or negative values mean they make and lose money at different times.">
          {ok.length < 2 ? <Text type="secondary" className="text-xs">Needs at least two algos with results.</Text> : (
            <Table
              size="small"
              pagination={false}
              rowKey="id"
              scroll={{ x: "max-content" }}
              dataSource={ok}
              columns={[
                { title: "", dataIndex: "name", render: (n: string, x) => <span style={{ color: colors[x.id] }}>{n}</span> },
                ...ok.map((y) => ({
                  title: <span style={{ color: colors[y.id] }}>{y.name.length > 18 ? `${y.name.slice(0, 16)}…` : y.name}</span>,
                  key: y.id,
                  align: "right" as const,
                  render: (_: unknown, x: T_PortfolioMemberSummary) => {
                    const v = result.correlation[x.id]?.[y.id];
                    if (v === null || v === undefined) return "–";
                    const a = x.id === y.id ? 0 : Math.min(1, Math.abs(v)) * 0.4;
                    return <span className="inline-block w-full px-2 py-0.5 rounded tabular-nums text-right" style={{ background: `rgba(42,120,214,${a})` }}>{v.toFixed(2)}</span>;
                  },
                })),
              ]}
            />
          )}
        </SectionCard>
      </div>

      <SectionCard title="Monthly" description="Net P&L per month for each algo and the portfolio.">
        <Table
          size="small"
          pagination={false}
          rowKey="key"
          scroll={{ x: "max-content" }}
          dataSource={monthRows}
          columns={[
            { title: "Month", dataIndex: "key", render: (k: string) => dayjs(`${k}-01`).format("MMM YYYY") },
            ...ok.map((x) => ({
              title: <span style={{ color: colors[x.id] }}>{x.name}</span>,
              key: x.id,
              align: "right" as const,
              render: (_: unknown, r: (typeof monthRows)[number]) => <HeatCell v={r.cells[x.id]} max={monthMax} />,
            })),
            { title: "Portfolio", dataIndex: "total", align: "right" as const, render: (v: number) => <b><HeatCell v={v} max={monthTotMax} /></b> },
          ]}
        />
        <Text type="secondary" className="text-xs block mt-2">
          {monthRows.filter((r) => r.total > 0).length} of {monthRows.length} months profitable for the portfolio.
        </Text>
      </SectionCard>

      <SectionCard title="Trades" description="Every algo's trades in time order. Expand a trade to see its legs, or replay it minute by minute.">
        <TradesTable
          trades={result.trades}
          onReplay={runId ? openReplay : undefined}
          extraColumns={[{
            title: "Algo", key: "member",
            filters: ok.map((x) => ({ text: x.name, value: x.id })),
            onFilter: (v, t) => (t as unknown as { member: string }).member === v,
            render: (_: unknown, t) => {
              const id = (t as unknown as { member: string }).member;
              return <Tag color={colors[id]} className="!text-white !border-0">{names[id]}</Tag>;
            },
          }]}
        />
      </SectionCard>
      {runId && <ReplayDrawer runId={runId} member={replay?.member} index={replay?.index ?? null} onClose={() => setReplay(null)} />}
    </div>
  );
}

export default function PortfolioResults({ result, runId, autoPdf, onPdfDone }: { result: T_PortfolioResult; runId: string | null; autoPdf?: boolean; onPdfDone?: () => void }) {
  const [tab, setTab] = useState("all");
  const colors = useMemo(() => Object.fromEntries(result.members.map((x, i) => [x.id, MEMBER_COLORS[i % MEMBER_COLORS.length]])), [result]);
  const items = [
    {
      key: "all",
      label: "Portfolio",
      children: (
        <ReportScope info={reportInfoFor(result)} savedHint={runId ? "Saved to Saved runs" : undefined} autoDownload={autoPdf} onAutoDownloaded={onPdfDone}>
          <Combined result={result} runId={runId} colors={colors} onOpen={setTab} />
        </ReportScope>
      ),
    },
    ...result.members.map((x) => {
      const r = result.member_results[x.id];
      return {
        key: x.id,
        label: <span><span className="inline-block w-2 h-2 rounded-full mr-1.5" style={{ background: colors[x.id] }} />{x.name}</span>,
        children: !r || "error" in r
          ? <Alert type="error" showIcon message={`${x.name} couldn't run`} description={r && "error" in r ? r.error : undefined} />
          : (
            <div className="space-y-3">
              <Text type="secondary" className="text-xs block">{describeGate(x.gate)}{x.lots > 1 ? ` · ×${x.lots} lots` : ""}</Text>
              <StrategyResults result={r} runId={runId} member={x.id} />
            </div>
          ),
      };
    }),
  ];
  return <Tabs activeKey={tab} onChange={setTab} items={items} destroyInactiveTabPane />;
}
