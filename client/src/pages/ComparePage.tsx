import { useMemo } from "react";
import { Alert, Button, Empty, Skeleton, Table, Tag, Typography } from "antd";
import { ArrowLeftOutlined } from "@ant-design/icons";
import { useQueries } from "@tanstack/react-query";
import { useNavigate, useSearchParams } from "react-router-dom";
import dayjs from "dayjs";
import { CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { api, type T_EngineResult, type T_Run } from "../api/client";
import PageTitle from "../components/PageTitle";
import SectionCard from "../components/SectionCard";
import { backtestCrumb } from "../lib/nav";

const { Text } = Typography;

const COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100"]; // categorical slots 1–4, fixed order
const GRID = "#F1F5F9";
const AXIS = "#94A3B8";

const inr = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${n < 0 ? "−" : n > 0 ? "+" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;

type T_Row = { id: string; name: string; strategy: string; period: string; color: string } & Record<string, number | string | null>;

export default function ComparePage() {
  const [search] = useSearchParams();
  const navigate = useNavigate();
  const ids = (search.get("ids") ?? "").split(",").filter(Boolean).slice(0, 4);
  const queries = useQueries({
    queries: ids.map((id) => ({ queryKey: ["run", id], queryFn: () => api.get<T_Run<unknown>>(`/runs/${id}`).then((r) => r.data), staleTime: Infinity })),
  });
  const loading = queries.some((q) => q.isLoading);
  const runs = queries.map((q) => q.data).filter(Boolean) as T_Run<unknown>[];

  const rows: T_Row[] = runs.map((r, i) => {
    const custom = r.strategy === "custom" ? (r.result as T_EngineResult) : null;
    const m = custom?.metrics;
    const p = r.params as { from_date?: string; to_date?: string };
    return {
      id: r.id, name: r.name, strategy: r.strategy_name, color: COLORS[i],
      period: `${dayjs(String(p.from_date)).format("D MMM YY")} – ${dayjs(String(p.to_date)).format("D MMM YY")}`,
      net_pnl: (m?.net_pnl ?? r.summary?.net_pnl ?? null) as number | null,
      trades: (m?.trades ?? r.summary?.trades ?? null) as number | null,
      win_rate: (m?.win_rate ?? r.summary?.win_rate ?? null) as number | null,
      profit_factor: m?.profit_factor ?? null,
      max_drawdown: m?.max_drawdown ?? null,
      sharpe: m?.sharpe ?? null,
      avg_trade: m?.avg_trade ?? null,
      costs: m?.costs ?? null,
    };
  });

  // Equity by day for builder runs, each starting at 0, on a shared date axis.
  const equity = useMemo(() => {
    const byDay = new Map<string, Record<string, number | string>>();
    runs.forEach((r) => {
      if (r.strategy !== "custom") return;
      const res = r.result as T_EngineResult;
      const daily = new Map<string, number>();
      res.trades.forEach((t) => daily.set(t.trade_day, (daily.get(t.trade_day) ?? 0) + t.net));
      let c = 0;
      [...daily.entries()].sort().forEach(([d, pnl]) => byDay.set(d, { ...(byDay.get(d) ?? { day: d }), [r.id]: Math.round((c += pnl)) }));
    });
    return [...byDay.values()].sort((a, b) => String(a.day).localeCompare(String(b.day)));
  }, [runs]);
  const curveRuns = runs.filter((r) => r.strategy === "custom");

  return (
    <div style={{ padding: 24 }} className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <PageTitle title="Compare runs" description="Saved backtests side by side." pageTitle={[backtestCrumb, { title: "Saved runs", link: "/backtest/saved" }, { title: "Compare" }]} />
        <Button icon={<ArrowLeftOutlined />} onClick={() => navigate("/backtest/saved")}>Back to saved runs</Button>
      </div>
      {ids.length < 2 && <Alert type="info" showIcon message="Pick 2–4 runs on the Saved runs page to compare them." />}
      {loading ? <Skeleton active /> : (
        <>
          <SectionCard title="Metrics" description="Builder runs show full metrics; other strategy pages show their saved summary.">
            <div className="overflow-x-auto">
              <Table<T_Row>
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={rows}
                columns={[
                  { title: "Run", dataIndex: "name", render: (n: string, r) => (
                    <span className="flex items-center gap-2"><span className="h-2.5 w-2.5 rounded-full" style={{ background: r.color }} /><Text className="font-medium">{n}</Text></span>) },
                  { title: "Strategy", dataIndex: "strategy", render: (s: string) => <Tag>{s}</Tag> },
                  { title: "Period", dataIndex: "period", className: "whitespace-nowrap" },
                  { title: "Trades", dataIndex: "trades", align: "right" },
                  { title: "Win rate", dataIndex: "win_rate", align: "right", className: "whitespace-nowrap tabular-nums", render: (v: number | null) => (v === null ? "–" : `${v.toFixed(1)}%`) },
                  { title: "Net P&L", dataIndex: "net_pnl", align: "right", className: "whitespace-nowrap tabular-nums", render: (v: number | null) => <Text type={v === null ? undefined : v >= 0 ? "success" : "danger"} className="tabular-nums">{inr(v)}</Text> },
                  { title: "Avg trade", dataIndex: "avg_trade", align: "right", className: "whitespace-nowrap tabular-nums", render: inr },
                  { title: "Profit factor", dataIndex: "profit_factor", align: "right", className: "whitespace-nowrap tabular-nums", render: (v: number | null) => v ?? "–" },
                  { title: "Max DD", dataIndex: "max_drawdown", align: "right", className: "whitespace-nowrap tabular-nums", render: inr },
                  { title: "Sharpe", dataIndex: "sharpe", align: "right", className: "whitespace-nowrap tabular-nums", render: (v: number | null) => v ?? "–" },
                  { title: "Costs", dataIndex: "costs", align: "right", className: "whitespace-nowrap tabular-nums", render: (v: number | null) => (v === null ? "–" : `₹${Math.round(v).toLocaleString("en-IN")}`) },
                ]}
              />
            </div>
          </SectionCard>
          <SectionCard title="Equity curves" description="Cumulative net P&L by day (strategy-builder runs).">
            {curveRuns.length === 0 ? <Empty description="No strategy-builder runs selected" /> : (
              <div className="h-80">
                <ResponsiveContainer>
                  <LineChart data={equity} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
                    <CartesianGrid stroke={GRID} vertical={false} />
                    <XAxis dataKey="day" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={30} />
                    <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={80} />
                    <ReferenceLine y={0} stroke={AXIS} />
                    <Tooltip formatter={(v, name) => [inr(Number(v)), runs.find((r) => r.id === name)?.name ?? name]} labelFormatter={(d) => dayjs(String(d)).format("ddd D MMM YYYY")} />
                    <Legend wrapperStyle={{ fontSize: 12 }} formatter={(v) => <span style={{ color: "#64748B" }}>{runs.find((r) => r.id === v)?.name ?? v}</span>} />
                    {runs.map((r, i) => r.strategy === "custom" && (
                      <Line key={r.id} dataKey={r.id} stroke={COLORS[i]} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                    ))}
                  </LineChart>
                </ResponsiveContainer>
              </div>
            )}
          </SectionCard>
        </>
      )}
    </div>
  );
}
