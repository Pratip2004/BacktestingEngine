import { Tabs } from "antd";
import { HistoryOutlined } from "@ant-design/icons";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";

// Home / Backtest: every backtesting strategy lives under one hub, switched with tabs.
// Each tab is its own route (/backtest/<tab>), so links, ?run=<id> and refreshes keep working.

const BACKTEST_TABS = [
  { key: "strategies", label: "Strategies" },
  { key: "builder", label: "Builder" },
  { key: "straddle", label: "Straddle" },
  { key: "ema-butterfly", label: "EMA butterfly" },
  { key: "stock", label: "Stock strategy" },
  { key: "saved", label: <span><HistoryOutlined className="mr-1" />Saved runs</span> },
];

export default function BacktestHub() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const sub = pathname.split("/")[2] ?? "strategies";
  const active = sub === "compare" ? "saved" : sub; // Compare lives under Saved runs
  return (
    <div>
      <div className="bg-white border-b border-zinc-200 px-6">
        <Tabs
          activeKey={active}
          onChange={(key) => navigate(`/backtest/${key}`)}
          items={BACKTEST_TABS.map(({ key, label }) => ({ key, label }))}
          className="[&_.ant-tabs-nav]:!mb-0"
        />
      </div>
      <Outlet />
    </div>
  );
}

// /backtest on its own opens Strategies; an old saved stock-run link (/backtest?run=) opens its tab.
export function BacktestIndex() {
  const { search } = useLocation();
  return <Navigate to={search.includes("run=") ? `/backtest/stock${search}` : "/backtest/strategies"} replace />;
}

// Old top-level routes (/straddle, /option-strategy, /runs) → their tab, keeping ?run= and ?pdf=.
export function RedirectKeepQuery({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}
