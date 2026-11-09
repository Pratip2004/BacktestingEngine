import { useMemo, useState } from "react";
import { Alert, App, Button, Empty, Input, Popconfirm, Segmented, Table, Tag, Tooltip, Typography } from "antd";
import { DeleteOutlined, DownloadOutlined, FolderOpenOutlined, SearchOutlined, DiffOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { errorMessage, useDeleteRun, useRuns, useUpdateRun, type T_RunMeta, type T_RunStrategy } from "../api/client";
import { entryLabel, formatLevel, upgradeRules } from "../lib/straddleSim";
import PageTitle from "../components/PageTitle";
import { backtestCrumb } from "../lib/nav";
import StatCard from "../components/StatCard";

const { Text } = Typography;

// ---------- Constants ----------

const STRATEGY: Record<T_RunStrategy, { label: string; path: string; color: string }> = {
  stock: { label: "Stock strategy", path: "/backtest/stock", color: "blue" },
  butterfly: { label: "EMA butterfly", path: "/backtest/ema-butterfly", color: "purple" },
  straddle: { label: "ATM straddle", path: "/backtest/straddle", color: "gold" },
  custom: { label: "Strategy builder", path: "/backtest/builder", color: "geekblue" },
  portfolio: { label: "Portfolio", path: "/backtest/portfolio", color: "cyan" },
};

const FILTERS = [
  { value: "all", label: "All" },
  { value: "stock", label: "Stock" },
  { value: "butterfly", label: "EMA butterfly" },
  { value: "straddle", label: "Straddle" },
  { value: "custom", label: "Builder" },
  { value: "portfolio", label: "Portfolio" },
];

// ---------- Helpers ----------

const inr = (n: number) => `${n < 0 ? "−" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
const signedInr = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${inr(n)}`);
const period = (p: Record<string, unknown>) =>
  `${dayjs(String(p.from_date)).format("D MMM YY")} – ${dayjs(String(p.to_date)).format("D MMM YY")}`;

// The exit settings a run was last viewed with, in words.
function settings(run: T_RunMeta): string {
  const v = run.view as Record<string, unknown> | null;
  const p = run.params;
  if (run.strategy === "stock") {
    const params = Object.entries((p.params as Record<string, unknown>) ?? {}).map(([k, x]) => `${k} ${x}`).join(", ");
    return `${String(p.stock_code)} · ${String(p.strategy)}${params ? ` (${params})` : ""}`;
  }
  if (run.strategy === "custom") {
    const spec = p.spec as { name?: string; underlying?: string; position?: { legs?: unknown[]; bullish?: unknown[] }; schedule?: { entry?: { type?: string; time?: string } } } | undefined;
    const legs = spec?.position?.legs?.length ?? spec?.position?.bullish?.length ?? 0;
    const entry = spec?.schedule?.entry?.type === "signal" ? "signal entry" : `entry ${spec?.schedule?.entry?.time ?? ""}`;
    return `${spec?.underlying ?? ""} · ${legs} leg${legs === 1 ? "" : "s"} · ${entry}`;
  }
  if (run.strategy === "portfolio") {
    const pf = p.portfolio as { members?: { name?: string | null; enabled?: boolean }[] } | undefined;
    const on = (pf?.members ?? []).filter((m) => m.enabled !== false);
    return `${on.length} algo${on.length === 1 ? "" : "s"}${on.length ? `: ${on.map((m) => m.name ?? "member").join(", ")}` : ""}`;
  }
  if (run.strategy === "straddle") {
    const fallbackEntry = (p.entry_times as string[] | undefined)?.[0] ?? String(p.entry_time ?? "09:30");
    const r = upgradeRules(v, fallbackEntry);
    const days = r.dtes ? r.dtes.map((d) => `${d}DTE`).join("/") : "all days";
    const lv = r.levels[r.side];
    const levels = r.perDte
      ? "per-day levels"
      : r.side === "buy"
        ? `target ${formatLevel("buy", "target", lv.target)}`
        : `target ${formatLevel("sell", "target", lv.target)} · SL ${formatLevel("sell", "stop", lv.stop)}`;
    return `${r.side === "buy" ? "Buy" : "Sell"} · ${entryLabel(r.entry)} · ${days} · ${levels} · out ${r.squareOff}`;
  }
  if (!v) return `EMA ${String(p.fast)}/${String(p.slow)} · wing ${String(p.wing)}`;
  const t = v.targetPct === null ? "no target" : `+${v.targetPct}%`;
  const s = v.stopPct === null ? "no stop" : `−${v.stopPct}%`;
  return `EMA ${String(p.fast)}/${String(p.slow)} · ${t} / ${s} · out ${String(v.squareOff)}`;
}

// ---------- Page ----------

export default function RunsPage() {
  const { message } = App.useApp();
  const navigate = useNavigate();
  const runs = useRuns();
  const update = useUpdateRun();
  const remove = useDeleteRun();
  const [filter, setFilter] = useState("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<string[]>([]);

  const rows = useMemo(
    () =>
      (runs.data ?? []).filter(
        (r) => (filter === "all" || r.strategy === filter) && r.name.toLowerCase().includes(query.trim().toLowerCase()),
      ),
    [runs.data, filter, query],
  );
  const all = runs.data ?? [];
  const withPnl = all.filter((r) => typeof r.summary?.net_pnl === "number");
  const best = withPnl.reduce<T_RunMeta | null>((b, r) => (!b || (r.summary!.net_pnl as number) > (b.summary!.net_pnl as number) ? r : b), null);
  const open = (r: T_RunMeta, pdf = false) => navigate(`${STRATEGY[r.strategy].path}?run=${r.id}${pdf ? "&pdf=1" : ""}`);

  return (
    <div style={{ padding: 24 }}>
      <PageTitle title="Saved runs" description="Every backtest you run is saved here. Open one to pick up where you left off, or download its report." pageTitle={[backtestCrumb, { title: "Saved runs" }]} />

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3 mb-5">
        <StatCard label="Saved backtests" value={all.length} hint={all[0] ? `Latest ${dayjs(all[0].created_at).format("D MMM, HH:mm")}` : "None yet"} />
        {(Object.keys(STRATEGY) as T_RunStrategy[]).map((k) => {
          const mine = all.filter((r) => r.strategy === k);
          const net = mine.reduce((s, r) => s + ((r.summary?.net_pnl as number | null) ?? 0), 0);
          return <StatCard key={k} label={STRATEGY[k].label} value={mine.length} hint={mine.length ? `Combined net ${signedInr(net)}` : "No runs yet"} />;
        })}
      </div>

      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-6">
        <div className="flex items-center justify-between gap-3 flex-wrap mb-4">
          <Segmented value={filter} onChange={(v) => setFilter(String(v))} options={FILTERS} />
          <div className="flex items-center gap-2">
            <Button icon={<DiffOutlined />} disabled={selected.length < 2} onClick={() => navigate(`/backtest/compare?ids=${selected.join(",")}`)}>
              Compare{selected.length ? ` (${selected.length})` : ""}
            </Button>
            <Input allowClear prefix={<SearchOutlined className="text-zinc-400" />} placeholder="Search by name" className="!w-64" value={query} onChange={(e) => setQuery(e.target.value)} />
          </div>
        </div>
        {runs.error && <Alert className="mb-4" type="error" showIcon message={errorMessage(runs.error)} />}
        {best && (
          <Text type="secondary" className="text-xs block mb-3">
            Best so far: <a onClick={() => open(best)}>{best.name}</a> ({signedInr(best.summary!.net_pnl as number)})
          </Text>
        )}
        <div className="overflow-x-auto">
          <Table<T_RunMeta>
            size="small"
            rowKey="id"
            rowSelection={{
              selectedRowKeys: selected,
              onChange: (keys) => setSelected((keys as string[]).slice(-4)),
              columnTitle: <Tooltip title="Pick 2–4 runs to compare"><span className="text-[11px] text-slate-400">Compare</span></Tooltip>,
            }}
            loading={runs.isLoading}
            dataSource={rows}
            pagination={rows.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
            scroll={{ x: "max-content" }}
            locale={{ emptyText: <Empty description="No saved backtests yet. Run one from Backtest, Option strategy or Straddle." /> }}
            columns={[
              {
                title: "Name",
                dataIndex: "name",
                render: (name: string, r) => (
                  <Text
                    className="text-[13px] font-medium"
                    style={{ maxWidth: 220 }}
                    ellipsis={{ tooltip: name }}
                    editable={{
                      tooltip: "Rename",
                      onChange: (v) => v.trim() && v !== name && update.mutate({ id: r.id, name: v.trim() }, { onSuccess: () => message.success("Renamed") }),
                    }}
                  >
                    {name}
                  </Text>
                ),
              },
              { title: "Strategy", dataIndex: "strategy", render: (s: T_RunStrategy) => <Tag color={STRATEGY[s].color}>{STRATEGY[s].label}</Tag> },
              { title: "Period", render: (_, r) => <span className="whitespace-nowrap">{period(r.params)}</span> },
              {
                title: "Settings",
                render: (_, r) => (
                  <Text type="secondary" className="text-xs" style={{ maxWidth: 180 }} ellipsis={{ tooltip: settings(r) }}>
                    {settings(r)}
                  </Text>
                ),
              },
              { title: "Trades", align: "right", render: (_, r) => r.summary?.trades ?? "–" },
              {
                title: "Win rate",
                align: "right",
                render: (_, r) => (typeof r.summary?.win_rate === "number" ? `${r.summary.win_rate.toFixed(0)}%` : "–"),
              },
              {
                title: "Net P&L",
                align: "right",
                sorter: (a, b) => ((a.summary?.net_pnl as number) ?? -Infinity) - ((b.summary?.net_pnl as number) ?? -Infinity),
                render: (_, r) => {
                  const v = r.summary?.net_pnl;
                  if (typeof v !== "number") return <Tooltip title="Open it once to calculate">–</Tooltip>;
                  return <Text type={v > 0 ? "success" : v < 0 ? "danger" : undefined}>{signedInr(v)}</Text>;
                },
              },
              {
                title: "Run on",
                dataIndex: "created_at",
                defaultSortOrder: "descend",
                sorter: (a, b) => a.created_at.localeCompare(b.created_at),
                render: (d: string) => <span className="whitespace-nowrap">{dayjs(d).format("D MMM, HH:mm")}</span>,
              },
              {
                title: "",
                key: "actions",
                render: (_, r) => (
                  <div className="flex items-center gap-1 whitespace-nowrap">
                    <Button size="small" type="link" icon={<FolderOpenOutlined />} onClick={() => open(r)}>Open</Button>
                    <Tooltip title="Open and download the PDF report">
                      <Button size="small" type="text" icon={<DownloadOutlined />} onClick={() => open(r, true)} />
                    </Tooltip>
                    <Popconfirm
                      title="Delete this backtest?"
                      description="Its saved results and settings are removed."
                      okText="Delete"
                      okButtonProps={{ danger: true }}
                      onConfirm={() => remove.mutate(r.id, { onSuccess: () => message.success("Deleted") })}
                    >
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </div>
                ),
              },
            ]}
          />
        </div>
      </div>
    </div>
  );
}
