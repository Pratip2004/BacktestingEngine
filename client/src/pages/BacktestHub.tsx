import { Tabs } from "antd";
import { HistoryOutlined } from "@ant-design/icons";
import { Navigate, Outlet, useLocation, useNavigate } from "react-router-dom";

// Home / Backtest: every backtesting strategy lives under one hub, switched with tabs.
// Each tab is its own route (/backtest/<tab>), so links, ?run=<id> and refreshes keep working.

const BACKTEST_TABS = [
  { key: "stock", label: "Stock strategy" },
  { key: "ema-butterfly", label: "EMA butterfly" },
  { key: "straddle", label: "Straddle" },
  { key: "saved", label: <span><HistoryOutlined className="mr-1" />Saved runs</span> },
];

export default function BacktestHub() {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const active = pathname.split("/")[2] ?? "stock";
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

// /backtest on its own: a saved stock run (?run=) opens in its tab, otherwise the first tab.
export function BacktestIndex() {
  const { search } = useLocation();
  return <Navigate to={`/backtest/stock${search}`} replace />;
}

// Old top-level routes (/straddle, /option-strategy, /runs) → their tab, keeping ?run= and ?pdf=.
export function RedirectKeepQuery({ to }: { to: string }) {
  const { search } = useLocation();
  return <Navigate to={`${to}${search}`} replace />;
}
