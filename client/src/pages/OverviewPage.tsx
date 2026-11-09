import { Button, Empty, Progress, Tag, Typography } from "antd";
import {
  AppstoreOutlined,
  ArrowRightOutlined,
  CheckCircleFilled,
  FundOutlined,
  LineChartOutlined,
  ThunderboltOutlined,
} from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { useAuthStatus, useDataStatus, useRuns, type T_RunMeta } from "../api/client";
import StatCard from "../components/StatCard";

const { Text, Title } = Typography;

// ---------- Constants ----------

const QUICK_START = [
  { title: "Strategy builder", desc: "Any options strategy, no code: legs, indicators, exits.", icon: <AppstoreOutlined />, to: "/backtest/strategies", color: "from-fuchsia-500 to-indigo-500" },
  { title: "ATM straddle", desc: "Buy or sell the straddle at a set time, per-DTE targets and stops.", icon: <ThunderboltOutlined />, to: "/backtest/straddle", color: "from-indigo-500 to-violet-500" },
  { title: "EMA butterfly", desc: "Butterfly on EMA crossovers, with an interactive exit lab.", icon: <FundOutlined />, to: "/backtest/ema-butterfly", color: "from-sky-500 to-indigo-500" },
  { title: "Stock strategy", desc: "SMA / RSI strategies on any NSE stock or index.", icon: <LineChartOutlined />, to: "/backtest/stock", color: "from-emerald-500 to-teal-500" },
];

const RUN_PATH: Record<string, string> = { stock: "/backtest/stock", butterfly: "/backtest/ema-butterfly", straddle: "/backtest/straddle", custom: "/backtest/builder", portfolio: "/backtest/portfolio" };

// ---------- Helpers ----------

const inr = (n: number) => `${n < 0 ? "−" : n > 0 ? "+" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;

function greeting() {
  const h = new Date().getHours();
  return h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening";
}

// ---------- Sections ----------

function GettingStarted({ connected, hasData, hasRuns }: { connected: boolean; hasData: boolean; hasRuns: boolean }) {
  const navigate = useNavigate();
  const steps = [
    { done: connected, title: "Log in to Breeze", desc: "Today's session lets the app fetch market data.", cta: "Log in", to: "/session" },
    { done: hasData, title: "Download market data", desc: "Fill the local store with NIFTY / SENSEX options history.", cta: "Plan download", to: "/data?tab=download" },
    { done: hasRuns, title: "Run your first backtest", desc: "Start with the ATM straddle; every run is saved.", cta: "New backtest", to: "/backtest/straddle" },
  ];
  const done = steps.filter((s) => s.done).length;
  if (done === steps.length) return null;
  const next = steps.findIndex((s) => !s.done);
  return (
    <div className="rounded-2xl border border-indigo-100 bg-gradient-to-br from-indigo-50 to-white p-6">
      <div className="flex items-center justify-between gap-4 flex-wrap mb-4">
        <div>
          <Text className="block text-[15px] font-semibold">Get set up</Text>
          <Text type="secondary" className="text-xs">{done} of {steps.length} done</Text>
        </div>
        <Progress percent={Math.round((done / steps.length) * 100)} showInfo={false} className="!w-48 !m-0" />
      </div>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-3">
        {steps.map((s, i) => (
          <div key={s.title} className={`rounded-xl border p-4 ${s.done ? "border-emerald-100 bg-white/70" : "border-slate-200 bg-white"}`}>
            <div className="flex items-center gap-2 mb-1">
              {s.done ? (
                <CheckCircleFilled className="text-emerald-500" />
              ) : (
                <span className="flex h-5 w-5 items-center justify-center rounded-full bg-indigo-100 text-[11px] font-semibold text-indigo-600">{i + 1}</span>
              )}
              <Text className={`text-[13px] font-semibold ${s.done ? "!text-slate-400 line-through" : ""}`}>{s.title}</Text>
            </div>
            <Text type="secondary" className="text-xs block mb-3">{s.desc}</Text>
            {!s.done && <Button size="small" type={i === next ? "primary" : "default"} onClick={() => navigate(s.to)}>{s.cta}</Button>}
          </div>
        ))}
      </div>
    </div>
  );
}

function RecentRuns({ runs }: { runs: T_RunMeta[] }) {
  const navigate = useNavigate();
  return (
    <div className="bg-white rounded-2xl border border-slate-200/70 shadow-sm">
      <div className="flex items-center justify-between px-6 pt-5 pb-3">
        <div>
          <Text className="block text-[15px] font-semibold">Recent backtests</Text>
          <Text type="secondary" className="text-xs">Reopen exactly where you left off</Text>
        </div>
        <Button type="link" onClick={() => navigate("/backtest/saved")}>View all <ArrowRightOutlined /></Button>
      </div>
      {runs.length === 0 ? (
        <Empty className="!pb-8" image={Empty.PRESENTED_IMAGE_SIMPLE} description="No backtests yet" />
      ) : (
        <div className="divide-y divide-slate-100">
          {runs.slice(0, 6).map((r) => {
            const pnl = r.summary?.net_pnl;
            return (
              <div key={r.id} onClick={() => navigate(`${RUN_PATH[r.strategy]}?run=${r.id}`)} className="flex items-center gap-4 px-6 py-3 cursor-pointer hover:bg-slate-50">
                <div className="min-w-0 flex-1">
                  <Text className="block truncate text-[13px] font-medium">{r.name}</Text>
                  <Text type="secondary" className="text-xs">{r.strategy_name} · {dayjs(r.created_at).format("D MMM, HH:mm")}</Text>
                </div>
                {typeof r.summary?.trades === "number" && <Tag className="!m-0">{r.summary.trades} trades</Tag>}
                <Text className={`w-28 text-right tabular-nums text-[13px] font-semibold ${typeof pnl === "number" ? (pnl >= 0 ? "!text-emerald-600" : "!text-red-500") : "!text-slate-400"}`}>
                  {typeof pnl === "number" ? inr(pnl) : "–"}
                </Text>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}

// ---------- Page ----------

export default function OverviewPage() {
  const navigate = useNavigate();
  const auth = useAuthStatus();
  const data = useDataStatus();
  const runs = useRuns();
  const connected = !!auth.data?.connected;
  const stored = data.data?.store.underlyings ?? {};
  const hasData = Object.values(stored).some((x) => x.days > 0);
  const all = runs.data ?? [];
  const withPnl = all.filter((r) => typeof r.summary?.net_pnl === "number");
  const best = withPnl.reduce<T_RunMeta | null>((b, r) => (!b || (r.summary!.net_pnl as number) > (b.summary!.net_pnl as number) ? r : b), null);
  const w = data.data?.worker;

  return (
    <div className="mx-auto max-w-7xl space-y-6" style={{ padding: 24 }}>
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <div>
          <Text type="secondary" className="text-xs">{dayjs().format("dddd, D MMMM YYYY")}</Text>
          <Title level={3} className="!mt-1 !mb-0 !font-semibold">{greeting()}</Title>
        </div>
      </div>

      <GettingStarted connected={connected} hasData={hasData} hasRuns={all.length > 0} />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard
          label="Breeze session"
          value={connected ? "Connected" : "Logged out"}
          dot={connected ? "good" : "bad"}
          hint={connected && auth.data?.connected_at ? `Since ${dayjs(auth.data.connected_at).format("HH:mm, D MMM")}` : "Sessions expire daily"}
        />
        <StatCard label="Saved backtests" value={all.length} hint={best ? `Best: ${inr(best.summary!.net_pnl as number)}` : "Every run is saved"} />
        <StatCard
          label="Days of data stored"
          value={Object.values(stored).reduce((s, x) => s + x.days, 0).toLocaleString("en-IN")}
          hint={Object.keys(stored).length ? Object.entries(stored).map(([u, x]) => `${u} ${x.days}`).join(" · ") : "Nothing downloaded yet"}
        />
        <StatCard
          label="Breeze calls today"
          value={w ? w.calls_today.toLocaleString("en-IN") : "–"}
          hint={w ? `of ${w.daily_budget.toLocaleString("en-IN")} budget · ${w.queue.pending.toLocaleString("en-IN")} downloads queued` : undefined}
        />
      </div>

      <div>
        <Text className="block text-[15px] font-semibold mb-3">Start a backtest</Text>
        <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
          {QUICK_START.map((q) => (
            <div
              key={q.title}
              onClick={() => navigate(q.to)}
              className="group cursor-pointer rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md"
            >
              <div className={`mb-4 flex h-10 w-10 items-center justify-center rounded-xl bg-gradient-to-br ${q.color} text-lg text-white shadow-sm`}>{q.icon}</div>
              <Text className="block text-[14px] font-semibold group-hover:!text-indigo-600">{q.title}</Text>
              <Text type="secondary" className="text-xs">{q.desc}</Text>
            </div>
          ))}
        </div>
      </div>

      <RecentRuns runs={all} />
    </div>
  );
}
