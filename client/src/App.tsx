import { useEffect, useState } from "react";
import { Button, Layout, Menu, Progress, Tooltip, Typography } from "antd";
import {
  ApiOutlined,
  DashboardOutlined,
  DatabaseOutlined,
  ExperimentOutlined,
  LineChartOutlined,
  MenuFoldOutlined,
  MenuUnfoldOutlined,
  PlusOutlined,
  SearchOutlined,
  TableOutlined,
  WalletOutlined,
} from "@ant-design/icons";
import { Navigate, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { useAuthStatus, useDataStatus, useHealth } from "./api/client";
import CommandPalette from "./components/CommandPalette";
import OverviewPage from "./pages/OverviewPage";
import SessionPage from "./pages/SessionPage";
import MarketDataPage from "./pages/MarketDataPage";
import OptionsPage from "./pages/OptionsPage";
import OptionStrategyPage from "./pages/OptionStrategyPage";
import StraddlePage from "./pages/StraddlePage";
import RunsPage from "./pages/RunsPage";
import AccountPage from "./pages/AccountPage";
import BacktestPage from "./pages/BacktestPage";
import BacktestHub, { BacktestIndex, RedirectKeepQuery } from "./pages/BacktestHub";
import DataPage from "./pages/DataPage";

const { Sider, Header, Content } = Layout;
const { Text } = Typography;

const NAV_GROUPS = [
  {
    type: "group" as const,
    label: "Research",
    children: [
      { key: "/", icon: <DashboardOutlined />, label: "Overview" },
      { key: "/backtest", icon: <ExperimentOutlined />, label: "Backtest" },
      { key: "/options", icon: <TableOutlined />, label: "Options analytics" },
    ],
  },
  {
    type: "group" as const,
    label: "Data",
    children: [
      { key: "/data", icon: <DatabaseOutlined />, label: "Data store" },
      { key: "/market", icon: <LineChartOutlined />, label: "Market data" },
    ],
  },
  {
    type: "group" as const,
    label: "Account",
    children: [
      { key: "/account", icon: <WalletOutlined />, label: "Account" },
      { key: "/session", icon: <ApiOutlined />, label: "Session" },
    ],
  },
];
const NAV_KEYS = NAV_GROUPS.flatMap((g) => g.children.map((c) => c.key));

const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);

// Breeze session + today's call budget, pinned to the bottom of the sidebar.
function ConnectionCard({ collapsed }: { collapsed: boolean }) {
  const navigate = useNavigate();
  const health = useHealth();
  const auth = useAuthStatus();
  const data = useDataStatus();
  const connected = !!auth.data?.connected;
  const online = health.isSuccess;
  const color = !online ? "#EF4444" : connected ? "#22C55E" : "#F59E0B";
  const label = !online ? "Server offline" : connected ? "Breeze connected" : "Breeze logged out";
  const w = data.data?.worker;
  const used = w ? Math.min(100, Math.round((w.calls_today / Math.max(1, w.daily_budget)) * 100)) : 0;

  if (collapsed) {
    return (
      <Tooltip title={label} placement="right">
        <div className="mx-auto my-3 h-2.5 w-2.5 rounded-full" style={{ background: color }} />
      </Tooltip>
    );
  }
  return (
    <div className="mx-3 mb-3 rounded-xl border border-white/10 bg-white/5 p-3 cursor-pointer hover:bg-white/10" onClick={() => navigate(connected ? "/data" : "/session")}>
      <div className="flex items-center gap-2">
        <span className="h-2 w-2 rounded-full" style={{ background: color }} />
        <Text className="!text-slate-200 text-xs font-medium">{label}</Text>
      </div>
      {w && (
        <div className="mt-2">
          <div className="flex justify-between">
            <Text className="!text-slate-400 text-[11px]">Breeze calls today</Text>
            <Text className="!text-slate-300 text-[11px] tabular-nums">{w.calls_today.toLocaleString("en-IN")} / {w.daily_budget.toLocaleString("en-IN")}</Text>
          </div>
          <Progress percent={used} showInfo={false} size="small" strokeColor="#6366F1" trailColor="rgba(255,255,255,0.08)" className="!m-0" />
          {w.state === "downloading" && <Text className="!text-indigo-300 text-[11px] block truncate">Downloading · {w.queue.pending.toLocaleString("en-IN")} left</Text>}
        </div>
      )}
      {!connected && online && <Text className="!text-amber-300 text-[11px] block mt-1">Log in to fetch data →</Text>}
    </div>
  );
}

export default function App() {
  const [collapsed, setCollapsed] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const selected = NAV_KEYS.filter((k) => (k === "/" ? pathname === "/" : pathname.startsWith(k))).pop() ?? pathname;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <Layout className="min-h-screen">
      <Sider
        width={244}
        collapsedWidth={68}
        collapsed={collapsed}
        breakpoint="lg"
        onBreakpoint={setCollapsed}
        trigger={null}
        className="!sticky top-0 h-screen"
      >
        <div className="flex h-full flex-col">
          <div className={`flex h-16 items-center gap-3 ${collapsed ? "justify-center" : "px-5"}`}>
            <div className="flex h-8 w-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-500 shadow-lg shadow-indigo-500/30">
              <LineChartOutlined className="!text-white text-base" />
            </div>
            {!collapsed && (
              <div className="leading-tight">
                <Text className="!text-white font-semibold text-[15px] block">Backtest Studio</Text>
                <Text className="!text-slate-400 text-[11px] block">NIFTY · SENSEX options</Text>
              </div>
            )}
          </div>
          <Menu
            theme="dark"
            mode="inline"
            selectedKeys={[selected]}
            items={NAV_GROUPS}
            onClick={({ key }) => navigate(key)}
            className="!border-e-0 flex-1 overflow-y-auto"
          />
          <ConnectionCard collapsed={collapsed} />
          <div className="border-t border-white/10 p-2">
            <Button
              type="text"
              block
              icon={collapsed ? <MenuUnfoldOutlined /> : <MenuFoldOutlined />}
              onClick={() => setCollapsed(!collapsed)}
              className="!text-slate-400 hover:!text-white hover:!bg-white/5"
            >
              {!collapsed && "Collapse"}
            </Button>
          </div>
        </div>
      </Sider>
      <Layout>
        <Header className="!h-16 !px-6 !leading-normal flex items-center justify-between gap-4 border-b border-slate-200 sticky top-0 z-10">
          <button
            onClick={() => setPaletteOpen(true)}
            className="flex w-full max-w-md items-center gap-2 rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-left text-slate-400 hover:border-slate-300 hover:bg-white transition-colors cursor-pointer"
          >
            <SearchOutlined />
            <span className="flex-1 text-[13px]">Search pages, actions, saved runs…</span>
            <kbd className="rounded border border-slate-200 bg-white px-1.5 text-[11px] font-medium text-slate-500">{isMac ? "⌘" : "Ctrl"} K</kbd>
          </button>
          <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate("/backtest/straddle")}>
            New backtest
          </Button>
        </Header>
        <Content>
          <Routes>
            <Route path="/" element={<OverviewPage />} />
            <Route path="/backtest" element={<BacktestHub />}>
              <Route index element={<BacktestIndex />} />
              <Route path="stock" element={<BacktestPage />} />
              <Route path="ema-butterfly" element={<OptionStrategyPage />} />
              <Route path="straddle" element={<StraddlePage />} />
              <Route path="saved" element={<RunsPage />} />
            </Route>
            {/* Older links and saved bookmarks */}
            <Route path="/option-strategy" element={<RedirectKeepQuery to="/backtest/ema-butterfly" />} />
            <Route path="/straddle" element={<RedirectKeepQuery to="/backtest/straddle" />} />
            <Route path="/runs" element={<RedirectKeepQuery to="/backtest/saved" />} />
            <Route path="/data" element={<DataPage />} />
            <Route path="/options" element={<OptionsPage />} />
            <Route path="/market" element={<MarketDataPage />} />
            <Route path="/account" element={<AccountPage />} />
            <Route path="/session" element={<SessionPage />} />
            <Route path="*" element={<Navigate to="/" replace />} />
          </Routes>
        </Content>
      </Layout>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} />
    </Layout>
  );
}
