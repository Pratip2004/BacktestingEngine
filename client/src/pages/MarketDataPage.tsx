import { Alert, Button, DatePicker, Form, Select, Table, Tabs, Typography } from "antd";
import dayjs from "dayjs";
import { CartesianGrid, Line, LineChart, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import {
  errorMessage,
  useHistorical,
  useNames,
  useOptionChain,
  useQuotes,
  type T_Candle,
  type T_HistoricalParams,
  type T_InstrumentParams,
} from "../api/client";
import PageTitle from "../components/PageTitle";
import SectionCard from "../components/SectionCard";
import BreezeData from "../components/BreezeData";
import ConnectionGate from "../components/ConnectionGate";
import StatCard from "../components/StatCard";
import InstrumentFields, { INTERVALS, toApiParams } from "../components/InstrumentFields";

const { Text } = Typography;

// Chart tokens: categorical slot 1 for the single price series; recessive grid and axis ink.
const SERIES_1 = "#2a78d6";
const GRID = "#F4F4F5";
const AXIS = "#A1A1AA";

const inr = (n: number) => n.toLocaleString("en-IN", { maximumFractionDigits: 2 });
const isIntraday = (d: string) => !d.endsWith("00:00:00");

// ---------- Historical ----------

function PriceChart({ candles }: { candles: T_Candle[] }) {
  const intraday = candles.some((c) => isIntraday(c.datetime));
  const tickFmt = (d: string) => dayjs(d).format(intraday ? "D MMM HH:mm" : "D MMM YY");
  return (
    <div className="h-80" role="img" aria-label="Close price over time">
      <ResponsiveContainer>
        <LineChart data={candles} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
          <CartesianGrid stroke={GRID} vertical={false} />
          <XAxis dataKey="datetime" tickFormatter={tickFmt} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={40} />
          <YAxis domain={["auto", "auto"]} tickFormatter={inr} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={70} />
          <Tooltip
            labelFormatter={(d) => dayjs(d as string).format(intraday ? "D MMM YYYY, HH:mm" : "D MMM YYYY")}
            formatter={(v) => [`₹${inr(Number(v))}`, "Close"]}
            cursor={{ stroke: AXIS, strokeDasharray: "3 3" }}
          />
          <Line type="monotone" dataKey="close" stroke={SERIES_1} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
        </LineChart>
      </ResponsiveContainer>
    </div>
  );
}

function HistoricalTab() {
  const historical = useHistorical();
  const candles = historical.data?.candles ?? [];
  const first = candles[0];
  const last = candles[candles.length - 1];
  const change = first && last ? ((last.close / first.open - 1) * 100).toFixed(2) : null;

  return (
    <div className="space-y-6">
      <SectionCard title="Historical candles" description="OHLCV from get_historical_data_v2. Long ranges are fetched in 1000-candle chunks.">
        <Form
          layout="vertical"
          initialValues={{ exchange_code: "NSE", product_type: "cash", interval: "1day", range: [dayjs().subtract(1, "year"), dayjs()] }}
          onFinish={(v) => historical.mutate(toApiParams<T_HistoricalParams>(v))}
          className="grid grid-cols-1 md:grid-cols-3 gap-x-4"
        >
          <InstrumentFields />
          <Form.Item name="interval" label="Interval">
            <Select options={INTERVALS} />
          </Form.Item>
          <Form.Item name="range" label="Date range" rules={[{ required: true }]}>
            <DatePicker.RangePicker className="w-full" />
          </Form.Item>
          <Form.Item className="mb-0 md:col-span-3">
            <Button type="primary" htmlType="submit" loading={historical.isPending}>
              Fetch candles
            </Button>
          </Form.Item>
        </Form>
      </SectionCard>

      {historical.error && <Alert type="error" showIcon message={errorMessage(historical.error)} />}

      {historical.data && (
        <>
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3">
            <StatCard label="Candles" value={candles.length} />
            <StatCard label="Last close" value={last ? `₹${inr(last.close)}` : "–"} hint={last && dayjs(last.datetime).format("D MMM YYYY")} />
            <StatCard label="Change over range" value={change ? `${change}%` : "–"} />
            <StatCard
              label="Range high / low"
              value={candles.length ? `₹${inr(Math.max(...candles.map((c) => c.high)))}` : "–"}
              hint={candles.length ? `Low ₹${inr(Math.min(...candles.map((c) => c.low)))}` : undefined}
            />
          </div>

          {candles.length > 0 && (
            <SectionCard title="Close price" description="Hover for the close at each bar.">
              <PriceChart candles={candles} />
            </SectionCard>
          )}

          <SectionCard title="Candle data" description="Raw candles, newest first.">
            <Table
              size="small"
              rowKey="datetime"
              dataSource={[...candles].reverse()}
              pagination={{ pageSize: 15 }}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "Datetime", dataIndex: "datetime", render: (d: string) => dayjs(d).format("D MMM YYYY HH:mm") },
                ...(["open", "high", "low", "close"] as const).map((k) => ({
                  title: k,
                  dataIndex: k,
                  align: "right" as const,
                  render: inr,
                })),
                { title: "volume", dataIndex: "volume", align: "right" as const, render: (v: number) => v?.toLocaleString("en-IN") },
              ]}
            />
          </SectionCard>
        </>
      )}
    </div>
  );
}

// ---------- Quotes / option chain / names ----------

function QuotesTab() {
  const quotes = useQuotes();
  return (
    <SectionCard title="Quotes" description="Live LTP, OHLC, best bid/ask and volume (get_quotes).">
      <Form
        layout="vertical"
        initialValues={{ exchange_code: "NSE", product_type: "cash" }}
        onFinish={(v) => quotes.mutate(toApiParams<T_InstrumentParams>(v))}
        className="grid grid-cols-1 md:grid-cols-3 gap-x-4"
      >
        <InstrumentFields />
        <Form.Item className="md:col-span-3">
          <Button type="primary" htmlType="submit" loading={quotes.isPending}>
            Get quote
          </Button>
        </Form.Item>
      </Form>
      {(quotes.data !== undefined || quotes.error) && <BreezeData data={quotes.data} error={quotes.error} />}
    </SectionCard>
  );
}

function OptionChainTab() {
  const chain = useOptionChain();
  return (
    <SectionCard title="Option chain" description="Quotes for every strike of an expiry (get_option_chain_quotes). Set a right or a strike.">
      <Form
        layout="vertical"
        initialValues={{ exchange_code: "NFO", product_type: "options", right: "call" }}
        onFinish={(v) => chain.mutate(toApiParams<T_InstrumentParams>(v))}
        className="grid grid-cols-1 md:grid-cols-3 gap-x-4"
      >
        <InstrumentFields />
        <Form.Item className="md:col-span-3">
          <Button type="primary" htmlType="submit" loading={chain.isPending}>
            Load chain
          </Button>
        </Form.Item>
      </Form>
      {(chain.data !== undefined || chain.error) && <BreezeData data={chain.data} error={chain.error} />}
    </SectionCard>
  );
}

function NamesTab() {
  const names = useNames();
  return (
    <SectionCard title="Symbol lookup" description="Map an exchange symbol (RELIANCE) to its ICICI stock code (RELIND) with get_names.">
      <Form
        layout="vertical"
        initialValues={{ exchange_code: "NSE" }}
        onFinish={(v) => names.mutate(v)}
        className="grid grid-cols-1 md:grid-cols-3 gap-x-4"
      >
        <InstrumentFields showProduct={false} />
        <Form.Item className="md:col-span-3">
          <Button type="primary" htmlType="submit" loading={names.isPending}>
            Look up
          </Button>
        </Form.Item>
      </Form>
      {(names.data !== undefined || names.error) && <BreezeData data={names.data} error={names.error} emptyText="No match" />}
      <Text type="secondary" className="text-xs block mt-3">
        Enter the NSE/BSE symbol in the stock code field for this lookup.
      </Text>
    </SectionCard>
  );
}

export default function MarketDataPage() {
  return (
    <div className="max-w-6xl mx-auto px-4 py-8">
      <PageTitle title="Market data" description="Historical candles, live quotes, option chains and symbol lookup." pageTitle={[{ title: "Market data" }]} />
      <ConnectionGate>
        <Tabs
          destroyOnHidden={false}
          items={[
            { key: "historical", label: "Historical", children: <HistoricalTab /> },
            { key: "quotes", label: "Quotes", children: <QuotesTab /> },
            { key: "chain", label: "Option chain", children: <OptionChainTab /> },
            { key: "names", label: "Names", children: <NamesTab /> },
          ]}
        />
      </ConnectionGate>
    </div>
  );
}
