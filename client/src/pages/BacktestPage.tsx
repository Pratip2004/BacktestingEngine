import { useEffect, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { Alert, Button, DatePicker, Divider, Empty, Form, InputNumber, Select, Spin, Table, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { CartesianGrid, Legend, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  errorMessage,
  useBacktest,
  useRun,
  useStrategies,
  type T_BacktestRequest,
  type T_BacktestResult,
  type T_EquityPoint,
  type T_Trade,
} from "../api/client";
import PageTitle from "../components/PageTitle";
import { backtestCrumb } from "../lib/nav";
import SectionCard from "../components/SectionCard";
import StatCard from "../components/StatCard";
import ConnectionGate from "../components/ConnectionGate";
import ReportScope, { usePrintMode } from "../components/ReportScope";
import type { T_ReportInfo } from "../lib/report";
import InstrumentFields, { INTERVALS, toApiParams } from "../components/InstrumentFields";

const { Text } = Typography;

// Chart tokens: categorical slots 1 and 2 (blue, orange) in fixed order; recessive grid and axis ink.
const SERIES = { equity: { color: "#2a78d6", name: "Strategy" }, buy_and_hold: { color: "#eb6834", name: "Buy & hold" } };
const GRID = "#F4F4F5";
const AXIS = "#A1A1AA";

const inr = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const pct = (n: number | null) => (n === null ? "–" : `${n > 0 ? "+" : ""}${n}%`);
const humanize = (s: string) => s.replace(/_/g, " ").replace(/^\w/, (c) => c.toUpperCase());

// ---------- Form ----------

function BacktestForm({ onRun, loading, initial }: { onRun: (body: T_BacktestRequest) => void; loading: boolean; initial?: T_BacktestRequest }) {
  const [form] = Form.useForm();
  const strategies = useStrategies();
  const strategy: string | undefined = Form.useWatch("strategy", form);
  const paramDefaults = strategy ? strategies.data?.[strategy]?.params : undefined;
  const keepSavedParams = useRef(!!initial);

  // Reset the parameter inputs to the chosen strategy's defaults (but keep a saved run's own params on open).
  useEffect(() => {
    if (!paramDefaults) return;
    if (keepSavedParams.current) {
      keepSavedParams.current = false;
      return;
    }
    form.setFieldValue("params", { ...paramDefaults });
  }, [paramDefaults, form]);

  return (
    <Form
      form={form}
      layout="vertical"
      initialValues={
        initial
          ? {
              ...initial,
              range: [dayjs(initial.from_date), dayjs(initial.to_date)],
              expiry_date: initial.expiry_date ? dayjs(initial.expiry_date) : undefined,
            }
          : {
              exchange_code: "NSE",
              product_type: "cash",
              interval: "1day",
              range: [dayjs().subtract(2, "year"), dayjs()],
              strategy: "sma_crossover",
              initial_capital: 100000,
              commission_pct: 0.03,
            }
      }
      onFinish={(v) => onRun({ ...toApiParams<T_BacktestRequest>(v), params: v.params ?? {}, include_equity_curve: true })}
    >
      <InstrumentFields />
      <Form.Item name="interval" label="Interval">
        <Select options={INTERVALS} />
      </Form.Item>
      <Form.Item name="range" label="Date range" rules={[{ required: true }]}>
        <DatePicker.RangePicker className="w-full" />
      </Form.Item>

      <Divider className="my-4" />

      <Form.Item name="strategy" label="Strategy" extra={strategy && strategies.data?.[strategy]?.description}>
        <Select
          loading={strategies.isLoading}
          options={Object.keys(strategies.data ?? {}).map((s) => ({ value: s, label: humanize(s) }))}
        />
      </Form.Item>
      {paramDefaults && (
        <div className="grid grid-cols-2 gap-x-3">
          {Object.keys(paramDefaults).map((p) => (
            <Form.Item key={p} name={["params", p]} label={humanize(p)} rules={[{ required: true }]}>
              <InputNumber className="!w-full" />
            </Form.Item>
          ))}
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-3">
        <Form.Item name="initial_capital" label="Initial capital (₹)">
          <InputNumber className="!w-full" min={1000} step={10000} />
        </Form.Item>
        <Form.Item name="commission_pct" label="Commission %" extra="Per fill, on turnover">
          <InputNumber className="!w-full" min={0} step={0.01} />
        </Form.Item>
      </div>

      <Form.Item className="mb-0">
        <Button type="primary" htmlType="submit" loading={loading} block>
          Run backtest
        </Button>
      </Form.Item>
    </Form>
  );
}

// ---------- Results ----------

function EquityChart({ data }: { data: T_EquityPoint[] }) {
  const intraday = data.some((d) => !d.datetime.endsWith("00:00:00"));
  return (
    <div className="h-80" role="img" aria-label="Strategy equity versus buy and hold">
      <ResponsiveContainer>
        <LineChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis
            dataKey="datetime"
            tickFormatter={(d) => dayjs(d).format(intraday ? "D MMM HH:mm" : "MMM YY")}
            tick={{ fontSize: 11, fill: AXIS }}
            stroke={GRID}
            minTickGap={40}
          />
          <YAxis domain={["auto", "auto"]} tickFormatter={(v) => `₹${inr(v)}`} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={84} />
          <Tooltip
            labelFormatter={(d) => dayjs(d as string).format(intraday ? "D MMM YYYY, HH:mm" : "D MMM YYYY")}
            formatter={(v, name) => [`₹${inr(Number(v))}`, name]}
            cursor={{ stroke: AXIS, strokeDasharray: "3 3" }}
          />
          <Legend
            iconType="plainline"
            wrapperStyle={{ fontSize: 12 }}
            formatter={(value) => <span style={{ color: "#71717A" }}>{value}</span>}
          />
          {(Object.keys(SERIES) as (keyof typeof SERIES)[]).map((k) => (
            <Line
              key={k}
              type="monotone"
              dataKey={k}
              name={SERIES[k].name}
              stroke={SERIES[k].color}
              strokeWidth={2}
              dot={false}
              activeDot={{ r: 4, stroke: "#fff", strokeWidth: 2 }}
              isAnimationActive={false}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function reportInfo(p: T_BacktestRequest): T_ReportInfo {
  const fmt = (d: string) => dayjs(d).format("D MMM YYYY");
  const params = Object.entries(p.params ?? {}).map(([k, v]) => `${k} ${v}`).join(", ");
  return {
    title: `${humanize(p.strategy)} backtest`,
    subtitle: `${p.stock_code} (${p.exchange_code}) · ${fmt(p.from_date)} - ${fmt(p.to_date)} · ${p.interval} candles`,
    meta: [
      ["Strategy", humanize(p.strategy)],
      ["Parameters", params || "Defaults"],
      ["Instrument", `${p.stock_code} · ${p.exchange_code} · ${p.product_type ?? "cash"}`],
      ["Position", "Long-only, all-in, next-bar open fills"],
      ["Initial capital", `Rs ${p.initial_capital.toLocaleString("en-IN")}`],
      ["Commission", `${p.commission_pct}% per fill`],
    ],
    fileName: `${p.strategy}-${p.stock_code}-backtest_${p.from_date.slice(0, 10)}_${p.to_date.slice(0, 10)}.pdf`,
  };
}

function Results({ result }: { result: T_BacktestResult }) {
  const printing = usePrintMode();
  const m = result.metrics;
  const beat = m.total_return_pct - m.buy_and_hold_return_pct;

  return (
    <>
      <div data-report-section className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Total return" value={pct(m.total_return_pct)} hint={`₹${inr(m.final_equity)} final equity`} />
        <StatCard label="Buy & hold" value={pct(m.buy_and_hold_return_pct)} hint={`${beat >= 0 ? "Beat" : "Lagged"} by ${Math.abs(beat).toFixed(2)} pts`} />
        <StatCard label="Max drawdown" value={`${m.max_drawdown_pct}%`} hint={`${m.bars} bars`} />
        <StatCard
          label="Win rate"
          value={pct(m.win_rate_pct).replace("+", "")}
          hint={`${m.closed_trades} closed of ${m.trades} trades${m.open_position ? " · position open" : ""}`}
        />
      </div>

      {result.equity_curve && result.equity_curve.length > 0 && (
        <SectionCard title="Equity curve" description="Strategy equity against holding the instrument for the whole range.">
          <EquityChart data={result.equity_curve} />
        </SectionCard>
      )}

      <SectionCard title="Trades" description="Entries and exits fill at the open of the bar after the signal.">
        <Table<T_Trade>
          size="small"
          rowKey="entry_time"
          dataSource={result.trades}
          pagination={!printing && result.trades.length > 15 ? { pageSize: 15 } : false}
          scroll={{ x: "max-content" }}
          locale={{ emptyText: "The strategy never entered a position" }}
          columns={[
            { title: "Entry", dataIndex: "entry_time", render: (d: string) => dayjs(d).format("D MMM YYYY HH:mm") },
            { title: "Entry price", dataIndex: "entry_price", align: "right", render: inr },
            { title: "Qty", dataIndex: "quantity", align: "right" },
            { title: "Exit", dataIndex: "exit_time", render: (d: string | null) => (d ? dayjs(d).format("D MMM YYYY HH:mm") : <Tag>Open</Tag>) },
            { title: "Exit price", dataIndex: "exit_price", align: "right", render: (v: number | null) => (v === null ? "–" : inr(v)) },
            {
              title: "P&L (₹)",
              dataIndex: "pnl",
              align: "right",
              sorter: (a, b) => (a.pnl ?? 0) - (b.pnl ?? 0),
              render: (v: number | null) =>
                v === null ? "–" : <Text type={v >= 0 ? "success" : "danger"}>{`${v >= 0 ? "+" : ""}${inr(v)}`}</Text>,
            },
          ]}
        />
      </SectionCard>
    </>
  );
}

// PDF-mode reads the context, so the provider (ReportScope) must sit above Results.
function SavedResults({
  result,
  request,
  runId,
  autoPdf,
  onPdfDone,
}: {
  result: T_BacktestResult;
  request: T_BacktestRequest;
  runId: string | null;
  autoPdf: boolean;
  onPdfDone: () => void;
}) {
  return (
    <ReportScope info={reportInfo(request)} savedHint={runId ? "Saved to Saved runs" : undefined}
      autoDownload={autoPdf}
      onAutoDownloaded={onPdfDone}
    >
      <Results result={result} />
    </ReportScope>
  );
}

export default function BacktestPage() {
  const [search, setSearch] = useSearchParams();
  const runId = search.get("run");
  const autoPdf = search.get("pdf") === "1";
  const onPdfDone = () => setSearch(runId ? { run: runId } : {}, { replace: true });
  const backtest = useBacktest();
  const fresh = backtest.data && backtest.data.run_id === runId ? backtest.data : null;
  const saved = useRun<T_BacktestResult>(fresh ? null : runId);
  const result = fresh ?? saved.data?.result ?? null;
  const request = (fresh ? backtest.variables : saved.data?.params) as T_BacktestRequest | undefined;

  useEffect(() => {
    if (backtest.data?.run_id && backtest.data.run_id !== runId) setSearch({ run: backtest.data.run_id }, { replace: true });
  }, [backtest.data, runId, setSearch]);

  return (
    <div style={{ padding: 24 }}>
      <PageTitle title="Stock strategy" description="Run a long-only strategy over Breeze historical data." pageTitle={[backtestCrumb, { title: "Stock strategy" }]} />
      <ConnectionGate>
        <div className="grid grid-cols-1 lg:grid-cols-[360px_1fr] gap-6 items-start">
          <SectionCard title="Configuration" description="Instrument, range, strategy and costs.">
            <BacktestForm
              key={saved.data?.id ?? "new"}
              initial={saved.data?.params as T_BacktestRequest | undefined}
              onRun={(body) => backtest.mutate(body)}
              loading={backtest.isPending}
            />
          </SectionCard>

          <div className="min-w-0 space-y-6">
            {backtest.error && <Alert type="error" showIcon message={errorMessage(backtest.error)} />}
            {saved.error && <Alert type="error" showIcon message={errorMessage(saved.error)} />}
            {saved.isLoading ? (
              <Spin className="block py-16" />
            ) : result && request ? (
              <SavedResults result={result} request={request} runId={runId} autoPdf={autoPdf} onPdfDone={onPdfDone} />
            ) : (
              <div className="bg-white rounded-2xl border border-gray-100 shadow-sm py-16">
                <Empty description={backtest.isPending ? "Fetching candles and running…" : "Configure a backtest and run it to see results"} />
              </div>
            )}
          </div>
        </div>
      </ConnectionGate>
    </div>
  );
}
