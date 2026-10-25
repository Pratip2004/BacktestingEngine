import { useMemo, useState } from "react";
import {
  Alert,
  Button,
  Empty,
  Form,
  Input,
  InputNumber,
  Progress,
  Segmented,
  Select,
  Spin,
  Switch,
  Table,
  Tabs,
  Tag,
  Tooltip as AntTooltip,
  Typography,
} from "antd";
import { ReloadOutlined } from "@ant-design/icons";
import dayjs from "dayjs";
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  Line,
  LineChart,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import {
  errorMessage,
  useExpiries,
  useJob,
  useOptionChainLive,
  useStartComparison,
  type T_Chain,
  type T_ChainRow,
  type T_Comparison,
  type T_ComparisonRequest,
  type T_OptionLeg,
} from "../api/client";
import PageTitle from "../components/PageTitle";
import SectionCard from "../components/SectionCard";
import StatCard from "../components/StatCard";
import ConnectionGate from "../components/ConnectionGate";

const { Text } = Typography;

// ---------- Constants ----------

// Calls and puts keep categorical slots 1 and 2 in every chart on this page.
const CALL = { color: "#2a78d6", tint: "#2a78d61f", name: "Calls (CE)" };
const PUT = { color: "#eb6834", tint: "#eb68341f", name: "Puts (PE)" };
const GRID = "#F4F4F5";
const AXIS = "#A1A1AA";
const MUTED = "#71717A";
const ITM_BG = "#FFFBEB";
const mono = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" };

// Sequential blue ramp (steps 100 → 650) for the strike × expiry heatmap.
const SEQ = ["#cde2fb", "#b7d3f6", "#9ec5f4", "#86b6ef", "#6da7ec", "#5598e7", "#3987e5", "#2a78d6", "#256abf", "#1c5cab", "#184f95", "#104281"];

const MATRIX_METRICS = [
  { value: "call.oi", label: "CE OI" },
  { value: "put.oi", label: "PE OI" },
  { value: "call.iv", label: "CE IV" },
  { value: "put.iv", label: "PE IV" },
  { value: "call.ltp", label: "CE LTP" },
  { value: "put.ltp", label: "PE LTP" },
  { value: "pcr", label: "PCR" },
] as const;
type T_MatrixMetric = (typeof MATRIX_METRICS)[number]["value"];

// ---------- Helpers ----------

const inr = (n: number | null | undefined, digits = 2) =>
  n === null || n === undefined ? "–" : n.toLocaleString("en-IN", { maximumFractionDigits: digits });

// Indian compact units: K, L (lakh), Cr (crore).
function compact(n: number | null | undefined): string {
  if (n === null || n === undefined) return "–";
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1e7) return `${sign}${(a / 1e7).toFixed(2)}Cr`;
  if (a >= 1e5) return `${sign}${(a / 1e5).toFixed(2)}L`;
  if (a >= 1e3) return `${sign}${(a / 1e3).toFixed(1)}K`;
  return `${sign}${a}`;
}

const signed = (n: number | null) => (n === null ? "–" : `${n > 0 ? "+" : ""}${compact(n)}`);
const fmtExpiry = (d: string) => dayjs(d).format("D MMM YY");

function matrixValue(row: T_ChainRow, metric: T_MatrixMetric): number | null {
  if (metric === "pcr") return row.call.oi ? (row.put.oi ?? 0) / row.call.oi : null;
  const [side, key] = metric.split(".") as ["call" | "put", "oi" | "iv" | "ltp"];
  return row[side][key];
}

function formatMatrix(v: number | null, metric: T_MatrixMetric) {
  if (v === null) return "–";
  if (metric.endsWith(".oi")) return compact(v);
  if (metric.endsWith(".iv")) return `${v.toFixed(1)}%`;
  if (metric === "pcr") return v.toFixed(2);
  return inr(v, 1);
}

const legendText = (value: string) => <span style={{ color: MUTED }}>{value}</span>;

// ---------- Charts ----------

function OiByStrikeChart({ chain, field }: { chain: T_Chain; field: "oi" | "chg_oi" }) {
  const data = chain.rows.map((r) => ({ strike: r.strike, call: r.call[field], put: r.put[field] }));
  return (
    <div className="h-72" role="img" aria-label={`${field === "oi" ? "Open interest" : "Change in open interest"} by strike, calls vs puts`}>
      <ResponsiveContainer>
        <BarChart data={data} barGap={2} barCategoryGap="20%" margin={{ top: 16, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="strike" tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} interval={0} angle={-35} textAnchor="end" height={48} />
          <YAxis tickFormatter={compact} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={56} />
          <Tooltip formatter={(v, name) => [compact(Number(v)), name]} labelFormatter={(k) => `Strike ${k}`} cursor={{ fill: "#F4F4F5" }} />
          <Legend iconType="square" wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          <ReferenceLine x={chain.summary.atm} stroke={AXIS} strokeDasharray="3 3" label={{ value: "ATM", position: "top", fontSize: 10, fill: MUTED }} />
          {field === "chg_oi" && <ReferenceLine y={0} stroke={AXIS} />}
          <Bar dataKey="call" name={CALL.name} fill={CALL.color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
          <Bar dataKey="put" name={PUT.name} fill={PUT.color} radius={[4, 4, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
}

function IvSmileChart({ chain }: { chain: T_Chain }) {
  const data = chain.rows.map((r) => ({ strike: r.strike, call: r.call.iv, put: r.put.iv }));
  if (!data.some((d) => d.call || d.put))
    return <Empty description="IV can't be computed (no time to expiry or no prices)" />;
  return (
    <div className="h-72" role="img" aria-label="Implied volatility by strike, calls vs puts">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 16, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="strike" tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} interval={0} angle={-35} textAnchor="end" height={48} />
          <YAxis domain={["auto", "auto"]} tickFormatter={(v) => `${Number(v).toFixed(1)}%`} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={48} />
          <Tooltip formatter={(v, name) => [`${Number(v).toFixed(2)}%`, name]} labelFormatter={(k) => `Strike ${k}`} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          <ReferenceLine x={chain.summary.atm} stroke={AXIS} strokeDasharray="3 3" label={{ value: "ATM", position: "top", fontSize: 10, fill: MUTED }} />
          {[{ k: "call", s: CALL }, { k: "put", s: PUT }].map(({ k, s }) => (
            <Line key={k} dataKey={k} name={s.name} stroke={s.color} strokeWidth={2} connectNulls
              dot={{ r: 4, fill: s.color, stroke: "#fff", strokeWidth: 2 }} isAnimationActive={false} />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// OI path of the ATM call and put over the contract's life (historical snapshots only).
function OiBuildUpChart({ chain }: { chain: T_Chain }) {
  const atm = chain.rows.find((r) => r.offset === 0);
  const data = useMemo(() => {
    const byDate = new Map<string, { date: string; call?: number | null; put?: number | null }>();
    atm?.call.oi_history?.forEach((p) => byDate.set(p.date, { date: p.date, call: p.oi }));
    atm?.put.oi_history?.forEach((p) => byDate.set(p.date, { ...(byDate.get(p.date) ?? { date: p.date }), put: p.oi }));
    return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
  }, [atm]);
  if (!data.length) return <Empty description="No history" />;
  return (
    <div className="h-72" role="img" aria-label="Open interest build-up of the ATM call and put">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 16, right: 8, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="date" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={24} />
          <YAxis tickFormatter={compact} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={56} />
          <Tooltip formatter={(v, name) => [compact(Number(v)), name]} labelFormatter={(d) => dayjs(d as string).format("D MMM YYYY")} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
          <Legend iconType="plainline" wrapperStyle={{ fontSize: 12 }} formatter={legendText} />
          <ReferenceLine x={chain.as_of} stroke={AXIS} strokeDasharray="3 3" label={{ value: "Snapshot", position: "top", fontSize: 10, fill: MUTED }} />
          <Line dataKey="call" name={`${atm?.strike} CE`} stroke={CALL.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />
          <Line dataKey="put" name={`${atm?.strike} PE`} stroke={PUT.color} strokeWidth={2} dot={false} activeDot={{ r: 4 }} connectNulls isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

// One small single-series trend across expiries (oldest → newest).
function TrendChart({ data, dataKey, label, format }: { data: Record<string, unknown>[]; dataKey: string; label: string; format: (v: number) => string }) {
  return (
    <div>
      <Text className="block text-[13px] font-semibold">{label}</Text>
      <div className="h-48" role="img" aria-label={`${label} by expiry`}>
        <ResponsiveContainer>
          <LineChart data={data} margin={{ top: 12, right: 12, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="expiry" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 10, fill: AXIS }} stroke={GRID} minTickGap={8} />
            <YAxis domain={["auto", "auto"]} tickFormatter={format} tick={{ fontSize: 10, fill: AXIS }} stroke={GRID} width={52} />
            <Tooltip formatter={(v) => [format(Number(v)), label]} labelFormatter={(d) => `Expiry ${fmtExpiry(d as string)}`} cursor={{ stroke: AXIS, strokeDasharray: "3 3" }} />
            <Line dataKey={dataKey} stroke={CALL.color} strokeWidth={2} dot={{ r: 4, fill: CALL.color, stroke: "#fff", strokeWidth: 2 }} connectNulls isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// ---------- Chain table + view ----------

// The bar grows outward from the strike column: right-anchored for calls, left-anchored for puts.
function OiCell({ value, max, tint, side }: { value: number | null; max: number; tint: string; side: "call" | "put" }) {
  const pct = value && max ? Math.max(2, (value / max) * 100) : 0;
  return (
    <div className={`relative px-1 ${side === "call" ? "text-right" : "text-left"}`}>
      <div className={`absolute inset-y-0 rounded-sm ${side === "call" ? "right-0" : "left-0"}`} style={{ width: `${pct}%`, background: tint }} />
      <span className="relative">{compact(value)}</span>
    </div>
  );
}

function ChainTable({ chain }: { chain: T_Chain }) {
  const { spot, atm } = chain.summary;
  const maxOi = Math.max(1, ...chain.rows.flatMap((r) => [r.call.oi ?? 0, r.put.oi ?? 0]));

  const legCols = (side: "call" | "put") => {
    const s = side === "call" ? CALL : PUT;
    const itm = (r: T_ChainRow) => (side === "call" ? r.strike < spot : r.strike > spot);
    const onCell = (r: T_ChainRow) => ({ style: itm(r) && r.strike !== atm ? { background: ITM_BG } : undefined });
    const leg = (r: T_ChainRow): T_OptionLeg => r[side];
    const cols = [
      { key: "oi", title: "OI", render: (_: unknown, r: T_ChainRow) => <OiCell value={leg(r).oi} max={maxOi} tint={s.tint} side={side} /> },
      {
        key: "chg_oi", title: "Chg OI", align: "right" as const,
        render: (_: unknown, r: T_ChainRow) => {
          const v = leg(r).chg_oi;
          return <Text type={v === null || v === 0 ? undefined : v > 0 ? "success" : "danger"}>{signed(v)}</Text>;
        },
      },
      { key: "volume", title: "Volume", align: "right" as const, render: (_: unknown, r: T_ChainRow) => compact(leg(r).volume) },
      { key: "iv", title: "IV", align: "right" as const, render: (_: unknown, r: T_ChainRow) => (leg(r).iv === null ? "–" : `${leg(r).iv!.toFixed(1)}%`) },
      { key: "delta", title: "Δ", align: "right" as const, render: (_: unknown, r: T_ChainRow) => leg(r).delta?.toFixed(2) ?? "–" },
      { key: "ltp", title: "LTP", align: "right" as const, render: (_: unknown, r: T_ChainRow) => <Text strong>{inr(leg(r).ltp)}</Text> },
    ].map((c) => ({ ...c, onCell, width: c.key === "oi" ? 96 : undefined }));
    // Calls read outward-in (OI … LTP | strike), puts mirror it (strike | LTP … OI).
    return side === "call" ? cols : [...cols].reverse();
  };

  return (
    <div className="overflow-x-auto">
      <Table<T_ChainRow>
        size="small"
        bordered
        rowKey="strike"
        dataSource={chain.rows}
        pagination={false}
        scroll={{ x: "max-content" }}
        rowClassName={(r) => (r.strike === atm ? "[&>td]:!bg-blue-50 [&>td]:font-semibold" : "")}
        columns={[
          { title: <span style={{ color: CALL.color }}>CALLS</span>, align: "center", children: legCols("call") },
          {
            title: "Strike",
            dataIndex: "strike",
            align: "center",
            width: 90,
            render: (k: number, r) => (
              <div className="flex flex-col items-center">
                <Text strong style={mono}>{k}</Text>
                {r.strike === atm && <Tag color="blue" className="!m-0 !text-[10px] !leading-4">ATM</Tag>}
              </div>
            ),
          },
          { title: <span style={{ color: PUT.color }}>PUTS</span>, align: "center", children: legCols("put") },
        ]}
      />
      <Text type="secondary" className="text-xs block mt-2">
        Shaded cells are in the money. IV and Δ are Black-Scholes values computed from LTP, spot and time to expiry.
      </Text>
    </div>
  );
}

function ChainView({ chain }: { chain: T_Chain }) {
  const s = chain.summary;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-6 gap-3">
        <StatCard label="Spot" value={inr(s.spot)} hint={chain.source === "live" ? `As of ${dayjs(chain.as_of).format("HH:mm:ss")}` : `Close on ${dayjs(chain.as_of).format("D MMM YYYY")}`} />
        <StatCard label="ATM strike" value={s.atm} hint={`${chain.days_to_expiry} days to expiry`} />
        <StatCard label="PCR (OI)" value={s.pcr_oi?.toFixed(2) ?? "–"} hint={`${compact(s.put_oi)} PE / ${compact(s.call_oi)} CE`} />
        <StatCard label="ATM IV" value={s.atm_iv ? `${s.atm_iv}%` : "–"} hint="Average of ATM CE and PE" />
        <StatCard label="ATM straddle" value={s.atm_straddle ? `₹${inr(s.atm_straddle)}` : "–"} hint="CE + PE premium" />
        <StatCard label="Max pain" value={s.max_pain ?? "–"} hint={`CE wall ${s.call_wall ?? "–"} · PE wall ${s.put_wall ?? "–"}`} />
      </div>

      <SectionCard title={`Option chain · ${fmtExpiry(chain.expiry)}`} description={`ATM ± ${(chain.rows.length - 1) / 2} strikes with OI, change in OI, volume, IV and delta.`}>
        <ChainTable chain={chain} />
      </SectionCard>

      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        <SectionCard title="Open interest by strike" description="Where positions sit. The biggest CE bar is resistance, the biggest PE bar support.">
          <OiByStrikeChart chain={chain} field="oi" />
        </SectionCard>
        <SectionCard title="Change in OI" description={chain.source === "live" ? "Today's OI added or removed per strike." : "OI change versus the previous trading day."}>
          <OiByStrikeChart chain={chain} field="chg_oi" />
        </SectionCard>
        <SectionCard title="IV smile" description="Implied volatility across strikes.">
          <IvSmileChart chain={chain} />
        </SectionCard>
        {chain.source === "historical" && (
          <SectionCard title="ATM OI build-up" description="Open interest of the ATM call and put through the contract's life.">
            <OiBuildUpChart chain={chain} />
          </SectionCard>
        )}
      </div>
    </div>
  );
}

// ---------- Live tab ----------

function LiveTab() {
  const expiries = useExpiries();
  const [expiry, setExpiry] = useState<string>();
  const [strikes, setStrikes] = useState(5);
  const [rate, setRate] = useState(6.5);
  const [auto, setAuto] = useState(false);
  const selected = expiry ?? expiries.data?.upcoming[0];
  const chain = useOptionChainLive(
    { expiry: selected, stock_code: "NIFTY", strikes, rate },
    { enabled: true, refetchInterval: auto ? 30_000 : false },
  );

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-2xl border border-gray-100 shadow-sm p-4 flex flex-wrap items-end gap-4">
        <div>
          <Text type="secondary" className="text-xs block mb-1">Expiry</Text>
          <Select
            className="w-44"
            loading={expiries.isLoading}
            value={selected}
            onChange={setExpiry}
            options={expiries.data?.upcoming.map((d) => ({ value: d, label: `${fmtExpiry(d)} · ${dayjs(d).format("ddd")}` }))}
          />
        </div>
        <div>
          <Text type="secondary" className="text-xs block mb-1">Strikes around ATM</Text>
          <Segmented value={strikes} onChange={(v) => setStrikes(Number(v))} options={[3, 5, 8, 10].map((n) => ({ value: n, label: `±${n}` }))} />
        </div>
        <div>
          <Text type="secondary" className="text-xs block mb-1">Risk-free rate %</Text>
          <InputNumber value={rate} onChange={(v) => setRate(v ?? 6.5)} min={0} max={15} step={0.25} className="!w-24" />
        </div>
        <div className="flex items-center gap-2 pb-1">
          <Switch size="small" checked={auto} onChange={setAuto} />
          <Text type="secondary" className="text-xs">Auto-refresh 30s</Text>
        </div>
        <Button icon={<ReloadOutlined />} onClick={() => chain.refetch()} loading={chain.isFetching} className="ml-auto">
          Refresh
        </Button>
      </div>

      {expiries.error && <Alert type="error" showIcon message={errorMessage(expiries.error)} />}
      {chain.error && <Alert type="error" showIcon message={errorMessage(chain.error)} />}
      {chain.isLoading && <Spin className="block py-16" />}
      {chain.data && <ChainView chain={chain.data} />}
    </div>
  );
}

// ---------- Comparison tab ----------

function StrikeMatrix({ result, onPick }: { result: T_Comparison; onPick: (expiry: string) => void }) {
  const [metric, setMetric] = useState<T_MatrixMetric>("call.oi");
  const n = result.strikes_around;
  const offsets = Array.from({ length: 2 * n + 1 }, (_, i) => i - n);
  const values = result.expiries.flatMap((e) => e.rows.map((r) => matrixValue(r, metric))).filter((v): v is number => v !== null);
  const [lo, hi] = [Math.min(...values), Math.max(...values)];
  const shade = (v: number | null) => {
    if (v === null || hi === lo) return { background: "#FAFAFA", color: "#A1A1AA" };
    const i = Math.round(((v - lo) / (hi - lo)) * (SEQ.length - 1));
    return { background: SEQ[i], color: i >= 7 ? "#FFFFFF" : "#18181B" };
  };

  return (
    <SectionCard
      title="Strike × expiry heatmap"
      description="Each row is an expiry, each column a strike offset from that expiry's ATM. Darker = higher. Click a row to open that chain."
      extra={<Select size="small" className="w-28" value={metric} onChange={setMetric} options={MATRIX_METRICS as unknown as { value: string; label: string }[]} />}
    >
      <div className="overflow-x-auto">
        <table className="w-full border-separate" style={{ borderSpacing: 2 }}>
          <thead>
            <tr>
              <th className="text-left px-2 py-1"><Text type="secondary" className="text-xs font-medium">Expiry</Text></th>
              {offsets.map((o) => (
                <th key={o} className="px-1 py-1 min-w-16">
                  <Text type="secondary" className="text-xs font-medium">{o === 0 ? "ATM" : o > 0 ? `+${o}` : o}</Text>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {result.expiries.map((e) => (
              <tr key={e.expiry} className="cursor-pointer" onClick={() => onPick(e.expiry)}>
                <td className="px-2 py-1 whitespace-nowrap"><Text className="text-xs">{fmtExpiry(e.expiry)}</Text></td>
                {offsets.map((o) => {
                  const row = e.rows.find((r) => r.offset === o);
                  const v = row ? matrixValue(row, metric) : null;
                  return (
                    <AntTooltip key={o} title={row ? `${row.strike} · ${formatMatrix(v, metric)}` : undefined}>
                      <td className="text-center text-xs rounded-sm py-1.5 px-1" style={shade(v)}>{formatMatrix(v, metric)}</td>
                    </AntTooltip>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <div className="flex items-center gap-2 mt-3">
        <Text type="secondary" className="text-xs">{formatMatrix(lo, metric)}</Text>
        <div className="h-2 w-40 rounded-full" style={{ background: `linear-gradient(to right, ${SEQ[0]}, ${SEQ[SEQ.length - 1]})` }} />
        <Text type="secondary" className="text-xs">{formatMatrix(hi, metric)}</Text>
      </div>
    </SectionCard>
  );
}

function ComparisonResults({ result }: { result: T_Comparison }) {
  const [picked, setPicked] = useState<string>(result.expiries[0]?.expiry);
  const chain = result.expiries.find((e) => e.expiry === picked);
  const trend = [...result.expiries].reverse().map((e) => ({ expiry: e.expiry, ...e.summary }));

  return (
    <div className="space-y-6">
      {result.skipped.length > 0 && (
        <Alert type="warning" showIcon message={`Skipped ${result.skipped.length} expiries`} description={result.skipped.map((s) => `${s.expiry}: ${s.reason}`).join(" · ")} />
      )}

      <SectionCard title="Expiry summary" description={`Snapshot ${result.days_before_expiry} trading day(s) before each expiry, ATM ± ${result.strikes_around}. Click a row for the full chain.`}>
        <Table
          size="small"
          rowKey="expiry"
          dataSource={result.expiries.map((e) => ({ expiry: e.expiry, as_of: e.as_of, ...e.summary }))}
          pagination={false}
          scroll={{ x: "max-content" }}
          onRow={(r) => ({ onClick: () => setPicked(r.expiry), className: "cursor-pointer" })}
          rowClassName={(r) => (r.expiry === picked ? "[&>td]:!bg-blue-50" : "")}
          columns={[
            { title: "Expiry", dataIndex: "expiry", render: (d: string) => <Text strong>{fmtExpiry(d)}</Text> },
            { title: "Snapshot", dataIndex: "as_of", render: (d: string) => dayjs(d).format("ddd D MMM") },
            { title: "Spot", dataIndex: "spot", align: "right", render: (v: number) => inr(v) },
            { title: "ATM", dataIndex: "atm", align: "right" },
            { title: "ATM IV", dataIndex: "atm_iv", align: "right", render: (v: number | null) => (v ? `${v}%` : "–"), sorter: (a, b) => (a.atm_iv ?? 0) - (b.atm_iv ?? 0) },
            { title: "Straddle", dataIndex: "atm_straddle", align: "right", render: (v: number | null) => inr(v) },
            { title: "PCR", dataIndex: "pcr_oi", align: "right", render: (v: number | null) => v?.toFixed(2) ?? "–", sorter: (a, b) => (a.pcr_oi ?? 0) - (b.pcr_oi ?? 0) },
            { title: "CE OI", dataIndex: "call_oi", align: "right", render: compact },
            { title: "PE OI", dataIndex: "put_oi", align: "right", render: compact },
            { title: "Max pain", dataIndex: "max_pain", align: "right" },
            { title: "CE wall", dataIndex: "call_wall", align: "right" },
            { title: "PE wall", dataIndex: "put_wall", align: "right" },
          ]}
        />
      </SectionCard>

      <SectionCard title="Trends across expiries" description="Oldest to newest. Hover a point for its value.">
        <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
          <TrendChart data={trend} dataKey="atm_iv" label="ATM IV" format={(v) => `${v.toFixed(1)}%`} />
          <TrendChart data={trend} dataKey="pcr_oi" label="PCR (OI)" format={(v) => v.toFixed(2)} />
          <TrendChart data={trend} dataKey="atm_straddle" label="ATM straddle (₹)" format={(v) => inr(v, 0)} />
        </div>
      </SectionCard>

      <StrikeMatrix result={result} onPick={setPicked} />

      {chain && (
        <>
          <div className="flex items-center gap-3 pt-2">
            <Text className="text-[15px] font-semibold">Expiry {fmtExpiry(chain.expiry)}</Text>
            <Select
              size="small"
              className="w-40"
              value={picked}
              onChange={setPicked}
              options={result.expiries.map((e) => ({ value: e.expiry, label: fmtExpiry(e.expiry) }))}
            />
          </div>
          <ChainView chain={chain} />
        </>
      )}
    </div>
  );
}

function ComparisonTab() {
  const start = useStartComparison();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<T_Comparison>(jobId);
  const running = start.isPending || job.data?.status === "running";

  return (
    <div className="space-y-6">
      <SectionCard
        title="Past expiries"
        description="Rebuilds ATM ± N strikes for each expired contract from daily candles. The first run takes a few minutes because of Breeze rate limits. After that it's cached."
      >
        <Form<T_ComparisonRequest>
          layout="vertical"
          initialValues={{ stock_code: "NIFTY", count: 10, kind: "weekly", strikes: 5, days_before_expiry: 1, rate: 6.5 }}
          onFinish={(v) => start.mutate(v, { onSuccess: (r) => setJobId(r.job_id) })}
          className="grid grid-cols-2 md:grid-cols-5 gap-x-4"
        >
          <Form.Item name="stock_code" hidden><Input /></Form.Item>
          <Form.Item name="kind" label="Expiry type">
            <Select options={[{ value: "weekly", label: "Weekly" }, { value: "monthly", label: "Monthly" }]} />
          </Form.Item>
          <Form.Item name="count" label="Expiries">
            <InputNumber min={1} max={26} className="!w-full" />
          </Form.Item>
          <Form.Item name="strikes" label="Strikes ± ATM">
            <InputNumber min={1} max={10} className="!w-full" />
          </Form.Item>
          <Form.Item name="days_before_expiry" label="Days before expiry" tooltip="Trading days before expiry to take the snapshot. 0 = expiry day, where IV is undefined.">
            <InputNumber min={0} max={15} className="!w-full" />
          </Form.Item>
          <Form.Item name="rate" label="Risk-free rate %">
            <InputNumber min={0} max={15} step={0.25} className="!w-full" />
          </Form.Item>
          <Form.Item className="mb-0 col-span-2 md:col-span-5">
            <Button type="primary" htmlType="submit" loading={running}>
              {running ? "Running…" : "Compare expiries"}
            </Button>
          </Form.Item>
        </Form>

        {job.data?.status === "running" && (
          <div className="mt-4">
            <Progress percent={job.data.total ? Math.round((job.data.done / job.data.total) * 100) : 0} status="active" />
            <Text type="secondary" className="text-xs">
              {job.data.message} · {job.data.done}/{job.data.total || "?"} contracts
            </Text>
          </div>
        )}
      </SectionCard>

      {start.error && <Alert type="error" showIcon message={errorMessage(start.error)} />}
      {job.error && <Alert type="error" showIcon message={errorMessage(job.error)} />}
      {job.data?.status === "error" && <Alert type="error" showIcon message="Comparison failed" description={job.data.error} />}
      {job.data?.status === "done" && job.data.result && <ComparisonResults result={job.data.result} />}
    </div>
  );
}

export default function OptionsPage() {
  return (
    <div style={{ padding: 24 }}>
      <PageTitle
        title="NIFTY options"
        description="Live option chain around ATM and a comparison of past expiries, with OI and computed IV."
        pageTitle={[{ title: "Options" }]}
      />
      <ConnectionGate>
        <Tabs
          items={[
            { key: "live", label: "Live chain", children: <LiveTab /> },
            { key: "compare", label: "Expiry comparison", children: <ComparisonTab /> },
          ]}
        />
      </ConnectionGate>
    </div>
  );
}
