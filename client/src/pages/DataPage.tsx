import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  Checkbox,
  DatePicker,
  Drawer,
  Empty,
  Form,
  InputNumber,
  Popconfirm,
  Progress,
  Segmented,
  Skeleton,
  Switch,
  Table,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from "antd";
import {
  CloudDownloadOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  ReloadOutlined,
  StopOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { Link, useSearchParams } from "react-router-dom";
import {
  errorMessage,
  useAuthStatus,
  useBackfill,
  useCoverage,
  useDataAction,
  useDataStatus,
  useDayDetail,
  useUpdateDataSettings,
  type T_BackfillPlan,
  type T_CoverageDay,
  type T_DataSettings,
  type T_DataUnderlying,
  type T_WorkerState,
} from "../api/client";
import PageTitle from "../components/PageTitle";
import SectionCard from "../components/SectionCard";
import StatCard from "../components/StatCard";

const { Text } = Typography;

// ---------- Constants ----------

const UNDERLYINGS: T_DataUnderlying[] = ["NIFTY", "SENSEX"];

const STATE: Record<T_WorkerState, { label: string; color: string; hint: string }> = {
  starting: { label: "Starting", color: "default", hint: "The downloader is starting up." },
  waiting_for_login: { label: "Waiting for login", color: "warning", hint: "Log in to Breeze and downloads continue automatically." },
  paused: { label: "Paused", color: "default", hint: "Resume to continue downloading." },
  budget_used: { label: "Daily budget used", color: "gold", hint: "Continues tomorrow, or raise the daily budget in settings." },
  idle: { label: "Idle", color: "success", hint: "Nothing queued. New trading days are fetched nightly." },
  downloading: { label: "Downloading", color: "processing", hint: "Running in the background; you can keep working." },
};

// Coverage calendar colours: status of a day's contracts.
const CELL = {
  none: "#F1F5F9", // nothing stored
  partial: "#C7D2FE", // some contracts still queued
  complete: "#4F46E5",
  failed: "#F87171",
};

const PERIODS = [
  { value: "1m", label: "1 month", months: 1 },
  { value: "3m", label: "3 months", months: 3 },
  { value: "6m", label: "6 months", months: 6 },
  { value: "1y", label: "1 year", months: 12 },
];

// ---------- Helpers ----------

const num = (n: number | undefined | null) => (n === undefined || n === null ? "–" : n.toLocaleString("en-IN"));

function cellState(d: T_CoverageDay | undefined): keyof typeof CELL {
  if (!d) return "none";
  if (d.opt.failed > 0 || d.spot === "failed") return "failed";
  if (d.opt.pending > 0 || d.spot === "pending" || d.fut === "pending") return "partial";
  if (d.opt.ok + d.opt.empty > 0 || d.spot === "ok") return "complete";
  return "none";
}

// ---------- Downloader ----------

function Downloader() {
  const status = useDataStatus();
  const action = useDataAction();
  const { message } = App.useApp();
  const w = status.data?.worker;
  if (!w) return <SectionCard title="Downloader" description="Background downloads from Breeze."><Skeleton active /></SectionCard>;
  const st = STATE[w.state];
  const paused = w.state === "paused";

  return (
    <SectionCard
      title="Downloader"
      description="Fills the store from Breeze in the background, within your daily call budget."
      extra={
        <div className="flex items-center gap-2">
          <Button
            size="small"
            icon={paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
            onClick={() => action.mutate({ kind: paused ? "resume" : "pause" })}
          >
            {paused ? "Resume" : "Pause"}
          </Button>
          {w.queue.failed > 0 && (
            <Button size="small" icon={<ReloadOutlined />} onClick={() => action.mutate({ kind: "retry" }, { onSuccess: () => message.success("Failed downloads re-queued") })}>
              Retry {num(w.queue.failed)} failed
            </Button>
          )}
          {w.queue.pending > 0 && (
            <Popconfirm title="Cancel all queued downloads?" description="Data already downloaded stays." okText="Cancel downloads" okButtonProps={{ danger: true }}
              onConfirm={() => action.mutate({ kind: "clear" }, { onSuccess: () => message.success("Queue cleared") })}>
              <Button size="small" danger icon={<StopOutlined />}>Cancel queue</Button>
            </Popconfirm>
          )}
        </div>
      }
    >
      <div className="flex items-start gap-3 mb-4">
        <Tag color={st.color} className="!m-0">{st.label}</Tag>
        <div className="min-w-0">
          <Text className="text-[13px] block truncate">{w.current ?? st.hint}</Text>
          {w.current && <Text type="secondary" className="text-xs">{st.hint}</Text>}
        </div>
      </div>
      {w.state === "waiting_for_login" && (
        <Alert className="!mb-4" type="warning" showIcon message="Breeze isn't connected" action={<Link to="/session"><Button size="small">Log in</Button></Link>} />
      )}
      {w.last_error && w.queue.failed > 0 && <Alert className="!mb-4" type="error" showIcon message="Last error" description={w.last_error} />}

      {w.jobs.length ? (
        <div className="space-y-3">
          {w.jobs.slice(0, 5).map((j) => {
            const pct = j.total ? Math.round(((j.done + j.failed) / j.total) * 100) : 0;
            return (
              <div key={j.job_id}>
                <div className="flex justify-between gap-3">
                  <Text className="text-[13px] truncate">{j.label}</Text>
                  <Text type="secondary" className="text-xs tabular-nums whitespace-nowrap">
                    {num(j.done)} / {num(j.total)} calls{j.failed ? ` · ${num(j.failed)} failed` : ""}
                  </Text>
                </div>
                <Progress percent={pct} size="small" status={pct === 100 ? (j.failed ? "exception" : "success") : "active"} />
              </div>
            );
          })}
        </div>
      ) : (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No downloads yet. Plan one with the backfill planner." />
      )}
    </SectionCard>
  );
}

// ---------- Backfill planner ----------

function Planner({ settings, connected }: { settings: T_DataSettings; connected: boolean }) {
  const { message } = App.useApp();
  const backfill = useBackfill();
  const [plan, setPlan] = useState<T_BackfillPlan | null>(null);
  const [form] = Form.useForm();
  const [period, setPeriod] = useState("1y");

  const values = () => {
    const v = form.getFieldsValue();
    const [start, end] = v.range as [Dayjs, Dayjs];
    return {
      underlyings: v.underlyings,
      start: start.format("YYYY-MM-DD"),
      end: end.format("YYYY-MM-DD"),
      band: v.band,
      expiries_ahead: v.expiries_ahead,
      include_monthly: v.include_monthly,
      include_futures: v.include_futures,
    };
  };
  const estimate = () => backfill.mutate({ ...values(), dry_run: true }, { onSuccess: setPlan });
  const start = () =>
    backfill.mutate({ ...values(), dry_run: false }, {
      onSuccess: (p) => {
        setPlan(null);
        message.success(`Queued ${num(p.calls)} downloads. They run in the background.`);
      },
    });

  return (
    <SectionCard title="Backfill planner" description="Choose what to download; see the cost before starting.">
      <Form
        form={form}
        layout="vertical"
        onValuesChange={() => setPlan(null)}
        initialValues={{
          underlyings: settings.underlyings,
          range: [dayjs().subtract(1, "year"), dayjs().subtract(1, "day")],
          band: settings.strike_band,
          expiries_ahead: settings.expiries_ahead,
          include_monthly: settings.include_monthly,
          include_futures: true,
        }}
      >
        <Form.Item name="underlyings" label="Underlyings" rules={[{ required: true }]}>
          <Checkbox.Group options={UNDERLYINGS} />
        </Form.Item>
        <Form.Item label="Period" className="!mb-2">
          <Segmented
            block
            value={period}
            options={PERIODS.map(({ value, label }) => ({ value, label }))}
            onChange={(v) => {
              setPeriod(String(v));
              const months = PERIODS.find((p) => p.value === v)!.months;
              form.setFieldValue("range", [dayjs().subtract(months, "month"), dayjs().subtract(1, "day")]);
              setPlan(null);
            }}
          />
        </Form.Item>
        <Form.Item name="range">
          <DatePicker.RangePicker className="w-full" disabledDate={(d) => d.isAfter(dayjs(), "day")} onChange={() => setPeriod("")} />
        </Form.Item>
        <div className="grid grid-cols-2 gap-x-3">
          <Form.Item name="band" label="Strikes each side of ATM" tooltip="Around each day's opening ATM. NIFTY ±40 = ±2,000 points; SENSEX ±40 = ±4,000.">
            <InputNumber min={1} max={100} className="!w-full" />
          </Form.Item>
          <Form.Item name="expiries_ahead" label="Weekly expiries" tooltip="Nearest N weekly expiries on each day.">
            <InputNumber min={1} max={4} className="!w-full" />
          </Form.Item>
        </div>
        <div className="flex flex-wrap gap-x-6 gap-y-2 mb-4">
          <Form.Item name="include_monthly" valuePropName="checked" noStyle>
            <Checkbox>Monthly expiry too</Checkbox>
          </Form.Item>
          <Form.Item name="include_futures" valuePropName="checked" noStyle>
            <Checkbox>Futures</Checkbox>
          </Form.Item>
        </div>
        {!connected && <Alert className="!mb-4" type="warning" showIcon message="Log in to Breeze to plan downloads" description="Planning needs each day's opening price to pick the strikes." />}
        {backfill.error && <Alert className="!mb-4" type="error" showIcon message={errorMessage(backfill.error)} />}

        {plan && (
          <div className="rounded-xl border border-indigo-100 bg-indigo-50/60 p-4 mb-4">
            <div className="flex items-baseline justify-between gap-3">
              <Text className="text-[13px] font-semibold">{num(plan.calls)} Breeze calls</Text>
              <Text type="secondary" className="text-xs">
                ≈ {plan.eta.days_at_budget} day{plan.eta.days_at_budget === 1 ? "" : "s"} at your budget · {plan.eta.hours_at_full_speed} h of downloading
              </Text>
            </div>
            <div className="mt-2 space-y-1">
              {Object.entries(plan.underlyings).map(([u, x]) => (
                <Text key={u} type="secondary" className="text-xs block">
                  <b className="text-slate-700">{u}</b>{" "}
                  {x.error ? x.error : `${num(x.trading_days)} trading days · ${num(x.contract_days)} contract-days to fetch · ${num(x.already_have)} already stored`}
                </Text>
              ))}
            </div>
          </div>
        )}

        <div className="flex gap-2">
          <Button onClick={estimate} loading={backfill.isPending && !plan} disabled={!connected}>
            Estimate
          </Button>
          <Button type="primary" icon={<CloudDownloadOutlined />} onClick={start} disabled={!connected || !plan || plan.calls === 0} loading={backfill.isPending && !!plan}>
            {plan && plan.calls === 0 ? "Already downloaded" : "Start download"}
          </Button>
        </div>
      </Form>
    </SectionCard>
  );
}

// ---------- Coverage ----------

function CoverageCalendar({ days, onPick }: { days: T_CoverageDay[]; onPick: (d: string) => void }) {
  const byDate = useMemo(() => new Map(days.map((d) => [d.date, d])), [days]);
  // 53 weekly columns ending this week, Mon–Fri rows.
  const end = dayjs().startOf("day");
  const firstMonday = end.subtract(52, "week").day(1);
  const weeks = Array.from({ length: 53 }, (_, w) => Array.from({ length: 5 }, (_, d) => firstMonday.add(w, "week").add(d, "day")));
  // Label a column when its month starts, unless the previous label is under 3 columns away (they'd collide).
  const labels: string[] = [];
  let lastAt = -10;
  weeks.forEach((w, i) => {
    const starts = i === 0 || w[0].month() !== weeks[i - 1][0].month();
    if (starts && i - lastAt >= 3) {
      lastAt = i;
      labels.push(w[0].format("MMM"));
    } else {
      labels.push("");
    }
  });
  const monthLabel = (_: Dayjs[], i: number) => labels[i];

  return (
    <div className="overflow-x-auto">
      <div className="inline-flex flex-col gap-1">
        <div className="flex gap-[3px] pl-9">
          {weeks.map((w, i) => (
            <div key={i} className="w-[14px] text-[10px] text-slate-400 overflow-visible whitespace-nowrap">{monthLabel(w, i)}</div>
          ))}
        </div>
        {["Mon", "Tue", "Wed", "Thu", "Fri"].map((label, row) => (
          <div key={label} className="flex items-center gap-[3px]">
            <div className="w-9 text-[10px] text-slate-400">{row % 2 === 0 ? label : ""}</div>
            {weeks.map((w, i) => {
              const day = w[row];
              if (day.isAfter(end)) return <div key={i} className="h-[14px] w-[14px]" />;
              const d = byDate.get(day.format("YYYY-MM-DD"));
              const state = cellState(d);
              const tip = d
                ? `${day.format("ddd D MMM YYYY")} · ${num(d.opt.ok)} contracts with data, ${num(d.opt.empty)} empty${d.opt.failed ? `, ${d.opt.failed} failed` : ""}${d.opt.pending ? `, ${d.opt.pending} queued` : ""}`
                : `${day.format("ddd D MMM YYYY")} · not downloaded`;
              return (
                <Tooltip key={i} title={tip} mouseEnterDelay={0.05}>
                  <div
                    onClick={() => d && onPick(day.format("YYYY-MM-DD"))}
                    className={`h-[14px] w-[14px] rounded-[3px] ${d ? "cursor-pointer hover:ring-2 hover:ring-indigo-300" : ""}`}
                    style={{ background: CELL[state] }}
                  />
                </Tooltip>
              );
            })}
          </div>
        ))}
        <div className="flex items-center gap-4 pl-9 pt-2">
          {(Object.keys(CELL) as (keyof typeof CELL)[]).map((k) => (
            <span key={k} className="flex items-center gap-1.5 text-[11px] text-slate-500">
              <span className="h-[10px] w-[10px] rounded-[2px]" style={{ background: CELL[k] }} />
              {{ none: "Not stored", partial: "Downloading", complete: "Stored", failed: "Has failures" }[k]}
            </span>
          ))}
        </div>
      </div>
    </div>
  );
}

function DayDrawer({ underlying, day, onClose }: { underlying: T_DataUnderlying; day: string | null; onClose: () => void }) {
  const detail = useDayDetail(underlying, day);
  const c = detail.data?.contracts ?? [];
  const opts = c.filter((x) => x.kind === "opt");
  const counts = opts.reduce<Record<string, number>>((acc, x) => ({ ...acc, [x.status]: (acc[x.status] ?? 0) + 1 }), {});
  return (
    <Drawer open={!!day} onClose={onClose} width={560} title={day ? `${underlying} · ${dayjs(day).format("ddd D MMM YYYY")}` : ""}>
      {detail.isLoading ? <Skeleton active /> : (
        <div className="space-y-4">
          <div className="flex flex-wrap gap-2">
            {c.filter((x) => x.kind !== "opt").map((x) => (
              <Tag key={x.kind + x.expiry} color={x.status === "ok" ? "success" : x.status === "failed" ? "error" : "default"}>
                {x.kind === "spot" ? "Index" : `Future ${dayjs(x.expiry).format("D MMM")}`} · {x.status} ({num(x.rows)} candles)
              </Tag>
            ))}
            <Tag color="blue">Options: {num(counts.ok ?? 0)} ok · {num(counts.empty ?? 0)} empty{counts.failed ? ` · ${counts.failed} failed` : ""}</Tag>
            {!!detail.data?.pending && <Tag color="processing">{detail.data.pending} still queued</Tag>}
          </div>
          <Table
            size="small"
            rowKey={(r) => `${r.expiry}-${r.strike}-${r.right}`}
            dataSource={opts}
            pagination={{ pageSize: 50, showSizeChanger: false }}
            columns={[
              { title: "Expiry", dataIndex: "expiry", render: (d: string) => dayjs(d).format("D MMM") },
              { title: "Strike", dataIndex: "strike", align: "right" },
              { title: "Type", dataIndex: "right", render: (r: string) => (r === "call" ? "CE" : "PE") },
              { title: "Candles", dataIndex: "rows", align: "right" },
              {
                title: "Status",
                dataIndex: "status",
                filters: ["ok", "empty", "failed"].map((s) => ({ text: s, value: s })),
                onFilter: (v, r) => r.status === v,
                render: (s: string, r) => (
                  <Tooltip title={r.error}>
                    <Tag color={s === "ok" ? "success" : s === "failed" ? "error" : "default"}>{s}</Tag>
                  </Tooltip>
                ),
              },
            ]}
          />
        </div>
      )}
    </Drawer>
  );
}

function Coverage() {
  const [u, setU] = useState<T_DataUnderlying>("NIFTY");
  const [day, setDay] = useState<string | null>(null);
  const end = dayjs().format("YYYY-MM-DD");
  const start = dayjs().subtract(53, "week").format("YYYY-MM-DD");
  const cov = useCoverage(u, start, end);
  const days = cov.data?.days ?? [];
  const stored = days.filter((d) => cellState(d) === "complete").length;
  return (
    <SectionCard
      title="Coverage"
      description={`Last 12 months, one square per trading day. ${num(stored)} days fully stored for ${u}. Click a day to see every contract.`}
      extra={<Segmented value={u} onChange={(v) => setU(v as T_DataUnderlying)} options={UNDERLYINGS} />}
    >
      {cov.isLoading ? <Skeleton active /> : <CoverageCalendar days={days} onPick={setDay} />}
      <DayDrawer underlying={u} day={day} onClose={() => setDay(null)} />
    </SectionCard>
  );
}

// ---------- Settings ----------

function SettingsCard({ settings }: { settings: T_DataSettings }) {
  const { message } = App.useApp();
  const update = useUpdateDataSettings();
  return (
    <SectionCard title="Settings" description="Applies to the nightly job and as planner defaults.">
      <Form
        layout="vertical"
        initialValues={{ ...settings, nightly_time: dayjs(settings.nightly_time, "HH:mm") }}
        onFinish={(v) =>
          update.mutate({ ...v, nightly_time: (v.nightly_time as Dayjs).format("HH:mm") }, { onSuccess: () => message.success("Settings saved") })
        }
      >
        <Form.Item name="daily_budget" label="Daily Breeze call budget" extra="Breeze allows about 5,000 calls a day. Leave some for live use.">
          <InputNumber min={0} max={5000} step={250} className="!w-full" />
        </Form.Item>
        <Form.Item name="underlyings" label="Underlyings kept up to date">
          <Checkbox.Group options={UNDERLYINGS} />
        </Form.Item>
        <div className="grid grid-cols-2 gap-x-3">
          <Form.Item name="strike_band" label="Strikes each side">
            <InputNumber min={1} max={100} className="!w-full" />
          </Form.Item>
          <Form.Item name="expiries_ahead" label="Weekly expiries">
            <InputNumber min={1} max={4} className="!w-full" />
          </Form.Item>
        </div>
        <div className="grid grid-cols-2 gap-x-3 items-end">
          <Form.Item name="nightly_enabled" label="Nightly update" valuePropName="checked">
            <Switch />
          </Form.Item>
          <Form.Item name="nightly_time" label="Runs at (IST)">
            <TimePicker format="HH:mm" minuteStep={5} className="!w-full" allowClear={false} />
          </Form.Item>
        </div>
        <Form.Item name="include_monthly" valuePropName="checked">
          <Checkbox>Include the monthly expiry</Checkbox>
        </Form.Item>
        <Form.Item className="!mb-0">
          <Button type="primary" htmlType="submit" loading={update.isPending}>Save settings</Button>
        </Form.Item>
      </Form>
    </SectionCard>
  );
}

// ---------- Page ----------

export default function DataPage() {
  const status = useDataStatus();
  const auth = useAuthStatus();
  const [search] = useSearchParams();
  const plannerRef = useRef<HTMLDivElement>(null);
  const s = status.data;
  const totalRows = s ? s.store.rows.opt_1m + s.store.rows.spot_1m + s.store.rows.fut_1m : 0;

  useEffect(() => {
    if (search.get("tab") === "download" && s) plannerRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
  }, [search, s]);

  return (
    <div style={{ padding: 24 }} className="space-y-6">
      <PageTitle
        title="Data store"
        description="1-minute index, futures and options history kept on this machine, so backtests run without waiting on Breeze."
        pageTitle={[{ title: "Data store" }]}
      />
      {status.error && <Alert type="error" showIcon message={errorMessage(status.error)} />}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Candles stored" value={s ? num(totalRows) : "–"} hint={s ? `${s.store.size_mb} MB on disk` : undefined} />
        {UNDERLYINGS.map((u) => {
          const x = s?.store.underlyings[u];
          return (
            <StatCard
              key={u}
              label={`${u} days stored`}
              value={x ? num(x.days) : "0"}
              hint={x ? `${dayjs(x.first_day).format("D MMM YY")} – ${dayjs(x.last_day).format("D MMM YY")} · ${num(x.contract_days)} contract-days` : "Nothing downloaded yet"}
            />
          );
        })}
        <StatCard
          label="Breeze calls today"
          value={s ? `${num(s.worker.calls_today)}` : "–"}
          hint={s ? `of ${num(s.worker.daily_budget)} daily budget · ${num(s.worker.queue.pending)} queued` : undefined}
        />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6 items-start">
        <div className="space-y-6 min-w-0">
          <Downloader />
          <Coverage />
        </div>
        <div className="space-y-6" ref={plannerRef}>
          {s && <Planner settings={s.settings} connected={!!auth.data?.connected} />}
          {s && <SettingsCard settings={s.settings} />}
        </div>
      </div>
    </div>
  );
}
