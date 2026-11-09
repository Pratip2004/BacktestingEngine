import { useMemo, useState } from "react";
import { Alert, Button, Collapse, Drawer, Empty, Progress, Select, Skeleton, Table, Tabs, Tag, Timeline, Tooltip, Typography } from "antd";
import {
  AuditOutlined,
  CheckCircleFilled,
  CloseCircleFilled,
  CommentOutlined,
  ExperimentOutlined,
  FlagOutlined,
  PauseCircleOutlined,
  PlayCircleOutlined,
  RobotOutlined,
  SettingOutlined,
} from "@ant-design/icons";
import dayjs from "dayjs";
import { Link, useSearchParams } from "react-router-dom";
import { Area, AreaChart, Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import {
  errorMessage,
  useExperiment,
  useExperiments,
  usePaperRefresh,
  usePaperWatch,
  usePlaybook,
  usePlaybooks,
  useResearchRunner,
  useResearchStatus,
  type T_Experiment,
  type T_ExperimentMeta,
  type T_ExperimentStatus,
  type T_PaperSignal,
  type T_PbStats,
  type T_ResearchEventKind,
  type T_ResearchExt,
  type T_ResearchHeadline,
  type T_ResearchPeriod,
  type T_ResearchResult,
  type T_ResearchStatus,
  type T_Verdict,
} from "../api/client";
import { describeSpec } from "../lib/spec";
import PageTitle from "../components/PageTitle";
import SectionCard from "../components/SectionCard";
import StatCard from "../components/StatCard";

const { Text } = Typography;

// ---------- Constants ----------

const SERIES = "#2a78d6";
const GOOD = "#22C55E";
const BAD = "#EF4444";
const GRID = "#F1F5F9";
const AXIS = "#94A3B8";

const VERDICT: Record<T_Verdict, { label: string; color: string; hint: string }> = {
  pending: { label: "Pending", color: "#94A3B8", hint: "Not judged yet." },
  rejected: { label: "Rejected", color: "red", hint: "Failed its pre-registered criteria. Dropped." },
  revise: { label: "Revise", color: "orange", hint: "Promising in part; a changed version will be tested." },
  inconclusive: { label: "Inconclusive", color: "default", hint: "Not enough evidence either way." },
  advance: { label: "Advance", color: "blue", hint: "Passed this stage; moves on to the next, harder checks." },
  promoted: { label: "Promoted", color: "green", hint: "Passed every stage including the locked holdout. Paper observation only." },
};

const STATUS: Record<T_ExperimentStatus, { label: string; color: string }> = {
  queued: { label: "Queued", color: "default" },
  running: { label: "Running", color: "processing" },
  done: { label: "Done", color: "success" },
  failed: { label: "Failed", color: "error" },
  blocked: { label: "Blocked", color: "warning" },
  cancelled: { label: "Cancelled", color: "default" },
};

const STAGE: Record<string, string> = {
  A: "Stage A: first test on the in-sample half",
  B: "Stage B: stress costs, an extra historical period and neighbouring settings",
  C: "Stage C: the locked holdout, run once",
};

const RUN_STAGE: Record<string, string> = {
  "preparing data": "Preparing data",
  executing: "Running the backtest",
  evaluating: "Computing metrics",
};

const EVENT: Record<T_ResearchEventKind, { color: string; icon: React.ReactNode; label: string }> = {
  decision: { color: "#4F46E5", icon: <FlagOutlined />, label: "Decision" },
  experiment: { color: "#2a78d6", icon: <ExperimentOutlined />, label: "Experiment" },
  audit: { color: "#F59E0B", icon: <AuditOutlined />, label: "Audit" },
  critic: { color: "#A855F7", icon: <CommentOutlined />, label: "Critic" },
  agent: { color: "#64748B", icon: <RobotOutlined />, label: "Team" },
  system: { color: "#94A3B8", icon: <SettingOutlined />, label: "System" },
};

// What each kind of test period is for.
const ROLE: Record<string, string> = {
  in_sample: "In-sample: the period the ideas are tested and tuned on. Good results here alone prove little.",
  stress: "The same period with harsher costs (e.g. doubled slippage). A real edge should survive worse fills.",
  holdout: "Holdout: data kept locked away and run once, only after the pass/fail rules are written down. The fairest test.",
  historical: "An extra, earlier period the idea was not developed on.",
  out_of_sample: "Out-of-sample: data the idea was not tuned on.",
};

const SEVERITY: Record<string, string> = { critical: "red", high: "volcano", medium: "orange", low: "gold", info: "default" };

// Plain-English explanations for the terms used on this page.
const TERMS = {
  net: "Profit or loss after every cost: brokerage, taxes, exchange fees and slippage.",
  in_sample: ROLE.in_sample,
  stress: ROLE.stress,
  holdout: ROLE.holdout,
  pf: "Profit factor: total won ÷ total lost. Above 1 makes money; 1.15+ is the bar here.",
  t_stat: "t-stat: how sure we are the daily average isn't just luck. Around 2 or more is convincing; below 1 is noise.",
  sharpe: "Sharpe: yearly return per unit of day-to-day swing. Higher is smoother; below 0 loses money.",
  sortino: "Like Sharpe, but only counts the downside swings.",
  dd: "Max drawdown: the largest fall from a peak in account value, as % of capital. The worst pain you'd have sat through.",
  checks: "How many of the pre-registered pass/fail rules this period met.",
  fits: "Whether 1 lot fits within the experiment's research capital (premium paid, worst-case loss for hedged positions, or estimated margin for short options and futures).",
  ex_top5: "Net P&L with the 5 best trades removed. If this is negative, a few lucky days carried the result.",
  boot: "Bootstrap: the days are reshuffled 2,000 times to see the range the total could plausibly have landed in.",
  stage: "Stage A tests on in-sample data; B adds stress costs and another period; C is the one-off holdout test.",
  verdict: "The research lead's decision after reading the results and the audit.",
};

// ---------- Helpers ----------

const inr = (n: number | null | undefined) =>
  n === null || n === undefined ? "–" : `${n < 0 ? "−" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
const signed = (n: number | null | undefined) => (n === null || n === undefined ? "–" : `${n > 0 ? "+" : ""}${inr(n)}`);
const num = (n: number | null | undefined, d = 2) => (n === null || n === undefined ? "–" : n.toFixed(d));
const pct = (n: number | null | undefined, d = 1) => (n === null || n === undefined ? "–" : `${n.toFixed(d)}%`);
const time = (t: string) => (dayjs(t).isSame(dayjs(), "day") ? dayjs(t).format("HH:mm:ss") : dayjs(t).format("D MMM, HH:mm"));

// A headline that ran without error.
type T_Ok = Exclude<T_ResearchHeadline, { error: string }>;
const ok = (h: T_ResearchHeadline | undefined): T_Ok | null => (h && !("error" in h && h.error) ? (h as T_Ok) : null);

// Period keys by role across protocol versions (v2: is / holdout / stress · v3: pooled · v4: train / test / test_2x).
const IN_SAMPLE_KEYS = ["is", "pooled", "train"];
const OUT_KEYS = ["holdout", "test"];
const STRESS_KEYS = ["stress", "stress_2x", "test_2x"];
const pick = (e: T_ExperimentMeta, keys: string[]) => keys.map((k) => e.results[k]).find((h) => h !== undefined);

function runnerState(s: T_ResearchStatus): { label: string; color: string } {
  if (s.runner.paused) return { label: "Paused", color: "default" };
  if (s.runner.current) return { label: `Running ${s.runner.current.id}`, color: "processing" };
  if (s.runner.message.startsWith("waiting")) return { label: "Waiting for Breeze", color: "warning" };
  return { label: "Idle", color: "success" };
}

// ---------- Small pieces ----------

// A label with a dotted underline that explains itself on hover.
function Term({ children, tip }: { children: React.ReactNode; tip: string }) {
  return (
    <Tooltip title={tip}>
      <span className="cursor-help border-b border-dotted border-slate-400">{children}</span>
    </Tooltip>
  );
}

function Pnl({ v }: { v: number | null | undefined }) {
  if (v === null || v === undefined) return <>–</>;
  return <Text type={v > 0 ? "success" : v < 0 ? "danger" : undefined} className="tabular-nums">{signed(v)}</Text>;
}

function VerdictTag({ v }: { v: T_Verdict }) {
  const x = VERDICT[v] ?? VERDICT.pending;
  return <Tooltip title={x.hint}><Tag color={x.color} className="!m-0">{x.label}</Tag></Tooltip>;
}

// Net P&L of one period with its trade count, for table cells.
function PeriodCell({ h }: { h: T_ResearchHeadline | undefined }) {
  if (!h) return <Text type="secondary">–</Text>;
  if ("error" in h && h.error) return <Tooltip title={h.error}><Tag color="error" className="!m-0">Error</Tag></Tooltip>;
  const x = h as T_Ok;
  return (
    <span className="whitespace-nowrap">
      <Pnl v={x.net_pnl} /> <Text type="secondary" className="text-xs">({x.trades})</Text>
    </span>
  );
}

function Prose({ title, text }: { title: string; text: string | null | undefined }) {
  if (!text) return null;
  return (
    <div>
      <Text className="block text-[13px] font-semibold mb-1">{title}</Text>
      <Text className="text-[13px] whitespace-pre-line">{text}</Text>
    </div>
  );
}

// ---------- Header ----------

function Header({ s }: { s: T_ResearchStatus }) {
  const runner = useResearchRunner();
  const st = runnerState(s);
  const budget = s.daily_budget ?? 0;
  const counts = Object.entries(s.counts).filter(([, n]) => n);
  const verdicts = (Object.keys(VERDICT) as T_Verdict[]).filter((v) => s.verdicts[v]);

  return (
    <div className="space-y-3">
      <div className="bg-white rounded-2xl border border-slate-200/70 shadow-sm p-6 flex items-start justify-between gap-4 flex-wrap">
        <div className="min-w-0">
          <div className="flex items-center gap-2 flex-wrap mb-1">
            <Tag color="geekblue" className="!m-0">Cycle {s.state.cycle}</Tag>
            <Text className="text-[15px] font-semibold">{s.state.phase || "Not started"}</Text>
          </div>
          {s.state.phase_detail && <Text type="secondary" className="text-[13px] block">{s.state.phase_detail}</Text>}
          {s.state.updated_at && <Text type="secondary" className="!text-slate-400 text-xs block mt-1">Plan updated {time(s.state.updated_at)}</Text>}
        </div>
        <div className="flex items-center gap-3">
          <div className="text-right">
            <Tag color={st.color} className="!m-0">{st.label}</Tag>
            <Text type="secondary" className="text-xs block mt-1 max-w-xs truncate">{s.runner.message}</Text>
          </div>
          <Button
            icon={s.runner.paused ? <PlayCircleOutlined /> : <PauseCircleOutlined />}
            loading={runner.isPending}
            onClick={() => runner.mutate(s.runner.paused ? "resume" : "pause")}
          >
            {s.runner.paused ? "Resume" : "Pause"}
          </Button>
        </div>
      </div>
      {runner.error && <Alert type="error" showIcon message={errorMessage(runner.error)} />}
      {st.label === "Waiting for Breeze" && (
        <Alert type="warning" showIcon message="The runner needs a Breeze session to fetch missing data" action={<Link to="/session"><Button size="small">Log in</Button></Link>} />
      )}

      <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label="Experiments" value={s.experiments} hint={`${s.families} distinct strategy ideas`} />
        <StatCard
          label="By status"
          value={s.counts.done ?? 0}
          hint={counts.length ? counts.map(([k, n]) => `${STATUS[k as T_ExperimentStatus]?.label ?? k} ${n}`).join(" · ") : "Nothing queued"}
        />
        <StatCard
          label={<Term tip={TERMS.verdict}>Advanced or promoted</Term>}
          value={(s.verdicts.advance ?? 0) + (s.verdicts.promoted ?? 0)}
          hint={
            <span className="flex flex-wrap gap-1 mt-1">
              {verdicts.length ? verdicts.map((v) => <Tag key={v} color={VERDICT[v].color} className="!m-0">{VERDICT[v].label} {s.verdicts[v]}</Tag>) : "None yet"}
            </span>
          }
        />
        <StatCard
          label="Breeze calls today"
          value={s.breeze_calls_today.toLocaleString("en-IN")}
          hint={
            budget ? (
              <>
                of {budget.toLocaleString("en-IN")} budget
                <Progress percent={Math.min(100, Math.round((s.breeze_calls_today / budget) * 100))} showInfo={false} size="small" className="!m-0" />
              </>
            ) : undefined
          }
        />
      </div>
    </div>
  );
}

// ---------- Now running + team ----------

function NowRunning({ s, onOpen }: { s: T_ResearchStatus; onOpen: (id: string) => void }) {
  const running = s.running ?? (s.current ? [{ ...s.current, source: null }] : []);
  return (
    <SectionCard title="Now running" description="Experiments the runner is working on right now (several run in parallel).">
      {running.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={s.runner.paused ? "Paused" : s.counts.queued ? "Between experiments" : "Nothing queued"} />
      ) : (
        <div className="space-y-4">
          {running.map((cur) => {
            const p = cur.progress;
            return (
              <div key={cur.id} className="space-y-1.5">
                <div>
                  <a onClick={() => onOpen(cur.id)} className="text-[13px] font-medium">{cur.id} · {cur.name}</a>
                  {cur.source && <Text type="secondary" className="text-xs ml-2">by {cur.source}</Text>}
                </div>
                {p ? (
                  <>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Tag className="!m-0">Period: {p.period}</Tag>
                      <Tag color="processing" className="!m-0">{RUN_STAGE[p.stage] ?? p.stage}</Tag>
                    </div>
                    {p.total > 0 && (
                      <div>
                        <Progress percent={Math.round((p.done / p.total) * 100)} status="active" size="small" />
                        <Text type="secondary" className="text-xs tabular-nums">{p.done.toLocaleString("en-IN")} / {p.total.toLocaleString("en-IN")} trading days</Text>
                      </div>
                    )}
                    <Text type="secondary" className="text-xs block">{p.message}</Text>
                  </>
                ) : (
                  <Text type="secondary" className="text-xs">Starting…</Text>
                )}
              </div>
            );
          })}
        </div>
      )}
    </SectionCard>
  );
}

function Team({ s }: { s: T_ResearchStatus }) {
  return (
    <SectionCard title="Team" description="Who is working on the research and what they are doing.">
      {s.state.agents.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No team yet" />
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
          {s.state.agents.map((a) => (
            <div key={a.name} className="rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between gap-2">
                <Text className="text-[13px] font-semibold truncate">{a.name}</Text>
                <Tag color={a.status === "active" ? "processing" : a.status === "done" ? "success" : "default"} className="!m-0">{a.status}</Tag>
              </div>
              <Text type="secondary" className="text-xs block">{a.role}</Text>
              {a.task && <Text className="text-xs block mt-2">{a.task}</Text>}
            </div>
          ))}
        </div>
      )}
    </SectionCard>
  );
}

// ---------- Leaderboard ----------

function Leaderboard({ rows, loading, onOpen }: { rows: T_ExperimentMeta[]; loading: boolean; onOpen: (id: string) => void }) {
  const ranked = useMemo(
    () => rows.filter((e) => ok(pick(e, IN_SAMPLE_KEYS))).sort((a, b) => (ok(pick(b, IN_SAMPLE_KEYS))!.net_pnl ?? -Infinity) - (ok(pick(a, IN_SAMPLE_KEYS))!.net_pnl ?? -Infinity)),
    [rows],
  );
  const is = (e: T_ExperimentMeta) => ok(pick(e, IN_SAMPLE_KEYS))!;

  return (
    <SectionCard title="Candidate leaderboard" description="Every experiment with an in-sample result, best in-sample net P&L first. Numbers in brackets are trade counts.">
      <div className="overflow-x-auto">
        <Table<T_ExperimentMeta>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={ranked}
          pagination={ranked.length > 15 ? { pageSize: 15, showSizeChanger: false } : false}
          scroll={{ x: "max-content" }}
          onRow={(e) => ({ onClick: () => onOpen(e.id), className: "cursor-pointer" })}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No in-sample results yet" /> }}
          columns={[
            { title: "#", render: (_, __, i) => <Text type="secondary">{i + 1}</Text> },
            { title: "ID", dataIndex: "id", render: (id: string) => <Text className="font-medium">{id}</Text> },
            { title: "Name", dataIndex: "name", render: (n: string) => <Text style={{ maxWidth: 260 }} ellipsis={{ tooltip: n }}>{n}</Text> },
            { title: "Family", dataIndex: "family", render: (f: string) => <Tag className="!m-0">{f}</Tag> },
            { title: <Term tip={TERMS.stage}>Stage</Term>, dataIndex: "stage", render: (s: string) => <Tooltip title={STAGE[s]}>{s}</Tooltip> },
            { title: <Term tip={TERMS.verdict}>Verdict</Term>, dataIndex: "verdict", render: (v: T_Verdict) => <VerdictTag v={v} /> },
            { title: "Trades", align: "right", render: (_, e) => is(e).trades },
            { title: <Term tip={`${TERMS.net} ${TERMS.in_sample}`}>Net P&L (in-sample)</Term>, align: "right", render: (_, e) => <Pnl v={is(e).net_pnl} /> },
            { title: <Term tip={TERMS.stress}>Stress net</Term>, align: "right", render: (_, e) => <PeriodCell h={pick(e, STRESS_KEYS)} /> },
            { title: <Term tip={TERMS.holdout}>Out-of-sample net</Term>, align: "right", render: (_, e) => <PeriodCell h={pick(e, OUT_KEYS)} /> },
            { title: <Term tip={TERMS.pf}>PF</Term>, align: "right", render: (_, e) => num(is(e).profit_factor) },
            { title: <Term tip={TERMS.t_stat}>t-stat</Term>, align: "right", render: (_, e) => num(is(e).t_stat) },
            { title: <Term tip={TERMS.dd}>Max DD</Term>, align: "right", render: (_, e) => pct(is(e).max_drawdown_pct) },
            {
              title: <Term tip={TERMS.checks}>Checks</Term>,
              align: "right",
              render: (_, e) => {
                const x = is(e);
                return <Text type={x.passed === x.checks ? "success" : undefined} className="tabular-nums">{x.passed}/{x.checks}</Text>;
              },
            },
            {
              title: <Term tip={TERMS.fits}>Fits capital</Term>,
              align: "center",
              render: (_, e) => (is(e).fits_capital ? <CheckCircleFilled className="text-emerald-500" /> : <CloseCircleFilled className="text-red-500" />),
            },
          ]}
        />
      </div>
    </SectionCard>
  );
}

// ---------- Paper watch ----------

function SignalTag({ x }: { x: T_PaperSignal | null | undefined }) {
  if (x?.holds == null) return <Text type="secondary">–</Text>;
  return x.holds ? <Tag color="green" className="!m-0">On</Tag> : <Tag className="!m-0">Off</Tag>;
}

function PaperWatch({ onOpen }: { onOpen: (id: string) => void }) {
  const q = usePaperWatch();
  const refresh = usePaperRefresh();
  const rows = q.data ?? [];
  if (!rows.length) return null;
  return (
    <SectionCard
      title="Paper watch"
      description="Watchlisted strategies re-run every weekday from their start date with their exact rules, to see how they behave on data nobody has seen. Nothing is ever ordered."
    >
      <div className="space-y-4">
        {rows.map((w) => {
          const s = w.last;
          const sig = s?.signal;
          const bucket = w.kind === "portfolio";
          return (
            <div key={w.experiment_id} className="space-y-3">
              <div className="flex flex-wrap items-center gap-2">
                {bucket ? (
                  <Tag color="purple" className="!m-0">Bucket</Tag>
                ) : (
                  <Button type="link" className="!p-0" onClick={() => onOpen(w.experiment_id)}>{w.experiment_id}</Button>
                )}
                <Text strong>{w.name}</Text>
                {w.verdict && <VerdictTag v={w.verdict} />}
                <Text type="secondary">since {w.since}{s ? ` · up to ${s.until} · updated ${dayjs(s.updated_at).format("D MMM HH:mm")}` : ""}</Text>
                <Button size="small" loading={refresh.isPending} onClick={() => refresh.mutate(w.experiment_id)}>Refresh now</Button>
                {s?.run_id && <Link to={bucket ? `/backtest/portfolio?run=${s.run_id}` : `/backtest/builder?run=${s.run_id}`}>Open run</Link>}
                {bucket && w.portfolio_id && <Link to={`/backtest/portfolio?portfolio=${w.portfolio_id}`}>Open bucket</Link>}
              </div>
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3">
                <StatCard label="Paper P&L" value={<Pnl v={s?.net_pnl ?? 0} />} hint={`${s?.trades.length ?? 0} trades`} />
                <StatCard label="Position" value={s?.open_position ? <Tag color="blue" className="!m-0">Open since {s.open_position.entry_at.slice(0, 10)}</Tag> : "Flat"}
                  hint={s?.open_position ? <>marked at the last close: <Pnl v={s.open_position.net} /></> : undefined} />
                {bucket ? (
                  <StatCard label="Members ready to enter" value={`${Object.values(s?.member_signals ?? {}).filter((m) => m.holds).length} of ${Object.keys(s?.member_signals ?? {}).length}`}
                    hint="entry condition with its regime gate, at the last close" />
                ) : (
                  <StatCard label="Entry signal at last close" value={<SignalTag x={sig} />}
                    hint={sig?.votes != null ? `${sig.votes} of ${sig.of} conditions${sig.needed ? `, needs ${sig.needed}` : ""}` : sig?.error} />
                )}
                <StatCard label="Max drawdown" value={<Pnl v={s?.max_drawdown ?? 0} />} />
              </div>
              {bucket &&
                Object.entries(s?.member_signals ?? {}).map(([id, m]) => (
                  <div key={id} className="flex flex-wrap items-center gap-2">
                    <SignalTag x={m} />
                    <Text>{m.name}</Text>
                    {(m.conditions ?? []).map((c) => (
                      <Tag key={c.rule} color={c.holds ? "green" : undefined} className="!m-0">{c.holds ? "✓" : "✗"} {c.rule}</Tag>
                    ))}
                    {m.error && <Text type="danger">{m.error}</Text>}
                  </div>
                ))}
              {sig?.conditions && (
                <div className="flex flex-wrap gap-2">
                  {sig.conditions.map((c) => (
                    <Tag key={c.rule} color={c.holds ? "green" : undefined} className="!m-0">{c.holds ? "✓" : "✗"} {c.rule}</Tag>
                  ))}
                </div>
              )}
              {!!s?.trades.length && (
                <Table
                  size="small"
                  rowKey="entry_at"
                  pagination={false}
                  dataSource={s.trades}
                  columns={[
                    { title: "Entry", dataIndex: "entry_at", render: (t: string) => t.slice(0, 16) },
                    { title: "Exit", dataIndex: "exit_at", render: (t: string | null, r) => (r.open ? <Tag color="blue">open</Tag> : t?.slice(0, 16)) },
                    ...(bucket ? [{ title: "Algo", dataIndex: "member", render: (m: string) => <Tag className="!m-0">{m}</Tag> }] : []),
                    { title: "Side", dataIndex: "direction", render: (d: string | null) => d ?? "–" },
                    { title: "Reason", dataIndex: "reason", render: (r: string | null, t) => (t.open ? "–" : r) },
                    { title: "Net", dataIndex: "net", align: "right" as const, render: (v: number) => <Pnl v={v} /> },
                  ]}
                />
              )}
            </div>
          );
        })}
      </div>
    </SectionCard>
  );
}

// ---------- Walk-forward regime playbook ----------

const REGIMES: Record<string, string> = {
  "1": "Up · calm", "2": "Up · volatile", "3": "Range · calm", "4": "Range · volatile", "5": "Down · calm", "6": "Down · volatile",
};

function StatsCells({ x }: { x: T_PbStats | undefined }) {
  if (!x || !x.trades) return <Text type="secondary">–</Text>;
  return (
    <span className="tabular-nums">
      <Pnl v={x.net} /> <Text type="secondary">({x.trades})</Text>
    </span>
  );
}

function Playbook() {
  const list = usePlaybooks();
  const [picked, setPicked] = useState<string | null>(null);
  const id = picked ?? list.data?.[0]?.id ?? null;
  const pb = usePlaybook(id);
  const d = pb.data;
  const names = useMemo(() => Object.fromEntries((d?.candidates ?? []).map((c) => [c.id, c.name])), [d]);
  const cand = (cid: string) => (
    <Tooltip title={names[cid] ?? cid}>
      <Tag className="!m-0">{cid}</Tag>
    </Tooltip>
  );

  return (
    <SectionCard
      title="Regime playbook (walk-forward)"
      description="Each quarter, the best algo per market regime is chosen using only trades that closed before the quarter, then traded in it. The stitched quarters are the out-of-sample answer to “does switching algos by market cycle work?”."
      extra={
        list.data && list.data.length > 1 ? (
          <Select size="small" style={{ width: 220 }} value={id ?? undefined} onChange={setPicked}
            options={list.data.map((p) => ({ value: p.id, label: `${p.id} · ${p.settings?.per_regime ?? 1}/regime` }))} />
        ) : undefined
      }
    >
      {!list.data?.length ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No playbook run yet" />
      ) : !d ? (
        <Skeleton active />
      ) : (
        <div className="space-y-4">
          <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
            <StatCard label="Out-of-sample net" value={<Pnl v={d.oos.net} />} dot={d.oos.net > 0 ? "good" : "bad"}
              hint={`${d.settings.test_start} → ${d.settings.end}`} />
            <StatCard label="Trades" value={d.oos.trades} hint={`win rate ${num(d.oos.win_rate)}%`} />
            <StatCard label={<Term tip={TERMS.pf}>Profit factor</Term>} value={num(d.oos.pf)} hint={`t ${num(d.oos.t)}`} />
            <StatCard label="Quarters positive" value={`${d.oos.by_quarter_positive}/${d.oos.quarters}`} />
            <StatCard label="Confirmed (gated buckets)" value={d.confirm ? <Pnl v={d.confirm.oos.net} /> : "–"}
              hint={d.confirm ? `${d.confirm.oos.trades} trades, re-run through the engine` : "not run"} />
          </div>
          <div className="overflow-x-auto">
            <Table
              size="small"
              rowKey="from"
              pagination={false}
              dataSource={d.quarters}
              scroll={{ x: "max-content" }}
              columns={[
                { title: "Quarter", dataIndex: "from", render: (f: string, q) => <Text className="tabular-nums">{f} → {q.to.slice(5)}</Text> },
                ...Object.keys(REGIMES).map((code) => ({
                  title: <Tooltip title="Algo chosen for this regime (days in the quarter)">{REGIMES[code]}</Tooltip>,
                  key: code,
                  render: (_: unknown, q: (typeof d.quarters)[number]) => (
                    <span className="flex items-center gap-1">
                      {(q.choice[code] ?? []).length ? (q.choice[code] ?? []).map(cand) : <Text type="secondary">stand aside</Text>}
                      <Text type="secondary" className="text-xs">{q.regime_days[code] ?? 0}d</Text>
                    </span>
                  ),
                })),
                { title: "Test net", align: "right" as const, render: (_: unknown, q: (typeof d.quarters)[number]) => <StatsCells x={q.test} /> },
              ]}
            />
          </div>
          <div className="grid grid-cols-1 xl:grid-cols-2 gap-4">
            <div className="overflow-x-auto">
              <Text strong>Same window, no switching</Text>
              <Table
                size="small"
                rowKey="id"
                pagination={false}
                dataSource={Object.entries(d.baselines).map(([cid, x]) => ({ id: cid, ...x, hind: d.hindsight[cid] }))}
                columns={[
                  { title: "Algo", dataIndex: "id", render: (cid: string) => (cid === "all_on" ? <Text strong>All always on</Text> : <span>{cand(cid)} <Text type="secondary" className="text-xs">{names[cid]}</Text></span>) },
                  { title: "Always on", align: "right", render: (_, x) => <StatsCells x={x} /> },
                  { title: "PF", align: "right", render: (_, x) => num(x.pf) },
                  {
                    title: <Tooltip title="Gated on the regimes that were profitable in this same window: an upper bound the walk-forward isn't allowed to see.">Hindsight best regimes</Tooltip>,
                    align: "right",
                    render: (_, x) => (x.hind ? <span><StatsCells x={x.hind} /> <Text type="secondary" className="text-xs">{x.hind.regimes.join(",") || "none"}</Text></span> : "–"),
                  },
                ]}
              />
            </div>
            <div className="overflow-x-auto">
              <Text strong>Playbook from today (trained on everything)</Text>
              <Table
                size="small"
                rowKey="code"
                pagination={false}
                dataSource={Object.keys(REGIMES).map((code) => ({ code, picks: d.final[code] ?? [], oos: d.oos.by_regime[code] }))}
                columns={[
                  { title: "Regime", dataIndex: "code", render: (c: string) => REGIMES[c] },
                  { title: "Algo", render: (_, r) => (r.picks.length ? r.picks.map((p) => cand(p.id)) : <Text type="secondary">stand aside</Text>) },
                  { title: "Its record in this regime", align: "right", render: (_, r) => (r.picks[0] ? <span><StatsCells x={r.picks[0]} /> <Text type="secondary" className="text-xs">t {num(r.picks[0].t)}</Text></span> : "–") },
                  { title: "Out-of-sample here", align: "right", render: (_, r) => <StatsCells x={r.oos} /> },
                ]}
              />
            </div>
          </div>
        </div>
      )}
    </SectionCard>
  );
}

// ---------- Experiments ----------

function Experiments({ rows, loading, onOpen }: { rows: T_ExperimentMeta[]; loading: boolean; onOpen: (id: string) => void }) {
  return (
    <SectionCard title="All experiments" description="Every hypothesis queued, running or finished. Click a row for the full detail.">
      <div className="overflow-x-auto">
        <Table<T_ExperimentMeta>
          size="small"
          rowKey="id"
          loading={loading}
          dataSource={rows}
          pagination={rows.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
          scroll={{ x: "max-content" }}
          onRow={(e) => ({ onClick: () => onOpen(e.id), className: "cursor-pointer" })}
          locale={{ emptyText: <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="No experiments yet" /> }}
          columns={[
            { title: "ID", dataIndex: "id", defaultSortOrder: "descend", sorter: (a, b) => a.id.localeCompare(b.id), render: (id: string) => <Text className="font-medium">{id}</Text> },
            { title: "Name", dataIndex: "name", render: (n: string, e) => <Text style={{ maxWidth: 280 }} ellipsis={{ tooltip: e.hypothesis || n }}>{n}</Text> },
            { title: "Family", dataIndex: "family", render: (f: string) => <Tag className="!m-0">{f}</Tag> },
            { title: "Stage", dataIndex: "stage" },
            {
              title: "Status",
              dataIndex: "status",
              render: (s: T_ExperimentStatus, e) => (
                <span className="whitespace-nowrap">
                  <Tag color={STATUS[s]?.color} className="!m-0">{STATUS[s]?.label ?? s}</Tag>
                  {s === "running" && e.progress && e.progress.total > 0 && (
                    <Text type="secondary" className="text-xs ml-2 tabular-nums">{e.progress.period} {e.progress.done}/{e.progress.total}</Text>
                  )}
                </span>
              ),
            },
            { title: "Verdict", dataIndex: "verdict", render: (v: T_Verdict) => <VerdictTag v={v} /> },
            {
              title: "Periods run",
              render: (_, e) => (
                <span className="flex gap-1 flex-wrap">
                  {e.periods.map((p) => {
                    const h = e.results[p.key];
                    const color = !h ? "default" : "error" in h && h.error ? "error" : (h as T_Ok).net_pnl! > 0 ? "success" : "red";
                    return <Tooltip key={p.key} title={`${p.label}${h ? "" : " · not run yet"}`}><Tag color={color} className="!m-0">{p.key}</Tag></Tooltip>;
                  })}
                </span>
              ),
            },
            { title: "Next action", dataIndex: "next_action", render: (n: string) => (n ? <Text type="secondary" className="text-xs" style={{ maxWidth: 260 }} ellipsis={{ tooltip: n }}>{n}</Text> : "–") },
            { title: "Updated", dataIndex: "updated_at", sorter: (a, b) => a.updated_at.localeCompare(b.updated_at), render: (t: string) => <span className="whitespace-nowrap">{time(t)}</span> },
          ]}
        />
      </div>
    </SectionCard>
  );
}

// ---------- Timeline + protocol ----------

function Events({ s, onOpen }: { s: T_ResearchStatus; onOpen: (id: string) => void }) {
  return (
    <SectionCard title="Timeline" description="Decisions, experiments, audit findings and team changes, newest first.">
      {s.events.length === 0 ? (
        <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing yet" />
      ) : (
        <div className="max-h-[560px] overflow-y-auto pt-2 pr-2">
          <Timeline
            items={s.events.map((ev) => {
              const k = EVENT[ev.kind] ?? EVENT.system;
              return {
                color: k.color,
                dot: <span style={{ color: k.color }}>{k.icon}</span>,
                children: (
                  <div>
                    <div className="flex items-center gap-2 flex-wrap">
                      <Text type="secondary" className="text-xs tabular-nums">{time(ev.t)}</Text>
                      <Text className="text-xs font-medium">{ev.actor}</Text>
                      <Tag className="!m-0 !text-[11px]">{k.label}</Tag>
                      {ev.experiment_id && <a className="text-xs" onClick={() => onOpen(ev.experiment_id!)}>{ev.experiment_id}</a>}
                    </div>
                    <Text className="text-[13px] whitespace-pre-line">{ev.text}</Text>
                  </div>
                ),
              };
            })}
          />
        </div>
      )}
    </SectionCard>
  );
}

function Protocol({ s }: { s: T_ResearchStatus }) {
  return (
    <SectionCard title="Protocol and summary" description="The rules fixed before any result, and the lead's running summary.">
      <div className="space-y-5">
        <div>
          <Text className="block text-[13px] font-semibold mb-1">Summary so far</Text>
          {s.state.summary ? <Text className="text-[13px] whitespace-pre-line">{s.state.summary}</Text> : <Text type="secondary" className="text-[13px]">No summary yet.</Text>}
        </div>
        <div>
          <Text className="block text-[13px] font-semibold mb-1">Protocol</Text>
          {s.state.protocol ? <Text className="text-[13px] whitespace-pre-line">{s.state.protocol}</Text> : <Text type="secondary" className="text-[13px]">Not written yet.</Text>}
        </div>
      </div>
    </SectionCard>
  );
}

// ---------- Detail drawer: one period ----------

function EquityCharts({ daily }: { daily: T_ResearchExt["daily"] }) {
  return (
    <div>
      <Text className="block text-[13px] font-semibold">Account value</Text>
      <Text type="secondary" className="text-xs block mb-2">Capital plus cumulative net P&L, every trading day.</Text>
      <div className="h-56">
        <ResponsiveContainer>
          <LineChart data={daily} syncId="research-equity" margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="d" tickFormatter={(d) => dayjs(d).format("D MMM")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} minTickGap={30} />
            <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={84} domain={["auto", "auto"]} />
            <ChartTooltip formatter={(v) => [inr(Number(v)), "Account value"]} labelFormatter={(d) => dayjs(d as string).format("ddd D MMM YYYY")} />
            <Line dataKey="equity" stroke={SERIES} strokeWidth={2} dot={false} activeDot={{ r: 4 }} isAnimationActive={false} />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <Text className="block text-[13px] font-semibold mt-3"><Term tip={TERMS.dd}>Drawdown</Term></Text>
      <div className="h-28">
        <ResponsiveContainer>
          <AreaChart data={daily} syncId="research-equity" margin={{ top: 4, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="d" hide />
            <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={84} />
            <ChartTooltip formatter={(v) => [inr(Number(v)), "Below peak"]} labelFormatter={(d) => dayjs(d as string).format("ddd D MMM YYYY")} />
            <Area dataKey="dd" stroke={BAD} strokeWidth={1.5} fill={BAD} fillOpacity={0.15} isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

// Gross before slippage, minus each cost, down to net.
function CostWaterfall({ x }: { x: T_ResearchExt }) {
  const c = x.cost_components;
  const parts: [string, number][] = [
    ["Slippage", c.slippage],
    ["Brokerage", c.brokerage],
    ["STT", c.stt],
    ["Exchange fees", c.exchange],
    ["GST", c.gst],
    ["Stamp duty", c.stamp],
    ["SEBI fees", c.sebi],
  ];
  const max = Math.max(1, Math.abs(x.gross_before_slippage ?? 0), ...parts.map(([, v]) => v), Math.abs(x.net_pnl ?? 0));
  const Row = ({ label, v, kind }: { label: string; v: number | null; kind: "total" | "cost" }) => (
    <div className="flex items-center gap-3 py-1">
      <Text className={`w-36 shrink-0 text-[13px] ${kind === "total" ? "font-semibold" : ""}`}>{label}</Text>
      <div className="flex-1 h-3 rounded bg-slate-50 overflow-hidden">
        <div className="h-full rounded" style={{ width: `${(Math.abs(v ?? 0) / max) * 100}%`, background: kind === "cost" ? "#CBD5E1" : (v ?? 0) >= 0 ? GOOD : BAD }} />
      </div>
      <Text className="w-28 shrink-0 text-right text-[13px] tabular-nums">{kind === "cost" ? `−${inr(v)}` : signed(v)}</Text>
    </div>
  );
  return (
    <div>
      <Text className="block text-[13px] font-semibold">Where the money went</Text>
      <Text type="secondary" className="text-xs block mb-2">
        P&L before any slippage, each cost taken off, net at the end.
        {x.cost_share_of_gross !== null && ` Costs ate ${x.cost_share_of_gross.toFixed(0)}% of the gross.`}
      </Text>
      <Row label="Gross before slippage" v={x.gross_before_slippage} kind="total" />
      {parts.filter(([, v]) => v > 0).map(([l, v]) => <Row key={l} label={l} v={v} kind="cost" />)}
      <Row label="Net P&L" v={x.net_pnl} kind="total" />
    </div>
  );
}

function MonthlyBars({ monthly }: { monthly: T_ResearchExt["monthly"] }) {
  const data = Object.entries(monthly).map(([m, pnl]) => ({ m, pnl: pnl ?? 0 }));
  return (
    <div>
      <Text className="block text-[13px] font-semibold mb-2">Net P&L by month</Text>
      <div className="h-48">
        <ResponsiveContainer>
          <BarChart data={data} margin={{ top: 8, right: 16, bottom: 0, left: 0 }}>
            <CartesianGrid stroke={GRID} vertical={false} />
            <XAxis dataKey="m" tickFormatter={(m) => dayjs(`${m}-01`).format("MMM YY")} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} />
            <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 11, fill: AXIS }} stroke={GRID} width={76} />
            <ReferenceLine y={0} stroke={AXIS} />
            <ChartTooltip formatter={(v) => [signed(Number(v)), "Net P&L"]} labelFormatter={(m) => dayjs(`${m}-01`).format("MMMM YYYY")} cursor={{ fill: "#F8FAFC" }} />
            <Bar dataKey="pnl" radius={[4, 4, 0, 0]} isAnimationActive={false}>
              {data.map((d) => <Cell key={d.m} fill={d.pnl >= 0 ? GOOD : BAD} />)}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      </div>
    </div>
  );
}

function PeriodView({ period, r, capital }: { period: T_ResearchPeriod; r: T_ResearchResult | undefined; capital: number }) {
  if (!r) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description="Not run yet" />;
  if (r.error || !r.ext) return <Alert type="error" showIcon message="This period failed" description={r.error ?? "No metrics"} />;
  const x = r.ext;
  const hours = Object.entries(x.by_hour).map(([h, v]) => ({ h, ...v }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <Text type="secondary" className="text-xs">
          {dayjs(period.from).format("D MMM YYYY")} – {dayjs(period.to).format("D MMM YYYY")} · {x.trading_days} trading days, traded on {x.days_traded}
          {x.skipped ? ` · ${x.skipped} signals skipped` : ""}
          {period.cost_overrides && ` · cost changes: ${Object.entries(period.cost_overrides).map(([k, v]) => `${k} ${v}`).join(", ")}`}
        </Text>
        {r.run_id && <Link to={`/backtest/builder?run=${r.run_id}`}><Button size="small">Open in builder</Button></Link>}
      </div>
      {r.reused_from && (
        <Alert type="info" showIcon message={`Result reused from ${r.reused_from}`} description="An identical strategy and period had already been run, so its result was reused instead of running again." />
      )}

      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <StatCard label={<Term tip={TERMS.net}>Net P&L</Term>} value={signed(x.net_pnl)} hint={`${pct(x.return_pct)} of ${inr(capital)} · ${pct(x.annualized_return_pct)} a year`} />
        <StatCard label="Trades" value={x.trades} hint={`Win rate ${pct(x.win_rate)} · avg ${signed(x.expectancy)} per trade`} />
        <StatCard label={<Term tip={TERMS.pf}>Profit factor</Term>} value={num(x.profit_factor)} hint={`Avg win ${inr(x.avg_win)} · avg loss ${inr(x.avg_loss)}`} />
        <StatCard label={<Term tip={TERMS.dd}>Max drawdown</Term>} value={pct(x.max_drawdown_pct)} hint={`${inr(x.max_drawdown)} · ${x.recovery_days === null ? "not recovered" : `recovered in ${x.recovery_days} days`}`} />
        <StatCard label={<Term tip={TERMS.t_stat}>t-stat (daily)</Term>} value={num(x.t_stat)} hint={<Term tip={TERMS.boot}>{`Chance of a loss ${pct(x.boot_p_loss)}`}</Term>} />
        <StatCard label={<Term tip={TERMS.sharpe}>Sharpe</Term>} value={num(x.sharpe)} hint={<Term tip={TERMS.sortino}>{`Sortino ${num(x.sortino)}`}</Term>} />
        <StatCard label={<Term tip={TERMS.boot}>Likely range of total</Term>} value={`${inr(x.boot_ci[0])} to ${inr(x.boot_ci[1])}`} hint="95% of reshuffled outcomes" />
        <StatCard label={<Term tip={TERMS.ex_top5}>Without best 5 trades</Term>} value={signed(x.net_ex_top5)} hint={`Longest losing streak ${x.longest_losing_streak}`} />
        <StatCard label="Costs" value={inr(x.costs_total)} hint={`Gross before slippage ${signed(x.gross_before_slippage)}`} />
        <StatCard
          label={<Term tip={TERMS.fits}>Capital per lot</Term>}
          value={inr(x.peak_capital_required)}
          dot={x.fits_capital ? "good" : "bad"}
          hint={`Peak; avg ${inr(x.avg_capital_required)} · ${x.max_lots_by_capital ?? 0} lots fit`}
        />
        <StatCard label="Holding time" value={x.avg_hold_min === null ? "–" : `${Math.round(x.avg_hold_min)} min`} hint={`In the market ${pct(x.exposure_pct)} of session time`} />
        {x.weekly && <StatCard label="Weeks" value={`${pct(x.weekly.pct_positive, 0)} up`} hint={`Best ${signed(x.weekly.best)} · worst ${signed(x.weekly.worst)}`} />}
      </div>

      {r.checks && r.checks.length > 0 && (
        <div>
          <Text className="block text-[13px] font-semibold mb-2">Pass/fail rules ({r.checks.filter((c) => c.pass).length} of {r.checks.length} met)</Text>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-x-6 gap-y-1">
            {r.checks.map((c) => (
              <div key={c.name} className="flex items-center gap-2">
                {c.pass ? <CheckCircleFilled className="text-emerald-500" /> : <CloseCircleFilled className="text-red-500" />}
                <Text className="text-[13px] flex-1">{c.name}</Text>
                <Text type="secondary" className="text-xs tabular-nums">{typeof c.value === "number" ? c.value.toLocaleString("en-IN") : String(c.value ?? "–")}</Text>
              </div>
            ))}
          </div>
        </div>
      )}

      {x.daily.length > 0 && <EquityCharts daily={x.daily} />}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <CostWaterfall x={x} />
        <MonthlyBars monthly={x.monthly} />
      </div>

      <div>
        <Text className="block text-[13px] font-semibold mb-2">By entry hour</Text>
        <Table
          size="small"
          rowKey="h"
          pagination={false}
          dataSource={hours}
          columns={[
            { title: "Hour", dataIndex: "h" },
            { title: "Trades", dataIndex: "trades", align: "right" },
            { title: "Net P&L", dataIndex: "net", align: "right", render: (v: number | null) => <Pnl v={v} /> },
          ]}
        />
      </div>
    </div>
  );
}

// ---------- Detail drawer ----------

function Detail({ e }: { e: T_Experiment }) {
  const summary = useMemo(() => {
    try {
      return describeSpec(e.spec);
    } catch {
      return [];
    }
  }, [e.spec]);

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-2 flex-wrap">
        <Tag color={STATUS[e.status]?.color} className="!m-0">{STATUS[e.status]?.label ?? e.status}</Tag>
        <VerdictTag v={e.verdict} />
        <Tooltip title={STAGE[e.stage]}><Tag className="!m-0">Stage {e.stage}</Tag></Tooltip>
        <Tag className="!m-0">{e.family}</Tag>
        <Text type="secondary" className="text-xs">v{e.version}{e.parent_id ? ` of ${e.parent_id}` : ""} · by {e.source} · priority {e.priority} · code {e.code_rev}</Text>
      </div>

      {(e.decision_reason || e.next_action) && (
        <div className="rounded-xl border border-indigo-100 bg-indigo-50/50 p-4 space-y-3">
          <Prose title="Decision" text={e.decision_reason} />
          <Prose title="Next action" text={e.next_action} />
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
        <Prose title="Hypothesis" text={e.hypothesis} />
        <Prose title="Why it might work" text={e.mechanism} />
        <Prose title="What's new about it" text={e.novelty} />
        <Prose title="How it could fail" text={e.failure_modes} />
      </div>

      {e.criteria && Object.keys(e.criteria).length > 0 && (
        <div>
          <Text className="block text-[13px] font-semibold mb-1">Pre-registered criteria (overrides of the defaults)</Text>
          <div className="flex flex-wrap gap-1">
            {Object.entries(e.criteria).map(([k, v]) => <Tag key={k} className="!m-0">{k.replace(/_/g, " ")}: {String(v)}</Tag>)}
          </div>
        </div>
      )}

      <Tabs
        items={e.periods.map((p) => ({
          key: p.key,
          label: (
            <Tooltip title={ROLE[p.role] ?? p.role}>
              <span>{p.label}</span>
            </Tooltip>
          ),
          children: <PeriodView period={p} r={e.results[p.key]} capital={e.capital} />,
        }))}
      />

      {(e.audit.length > 0 || e.critic.length > 0) && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-5">
          <div>
            <Text className="block text-[13px] font-semibold mb-2">Audit findings</Text>
            {e.audit.length === 0 ? <Text type="secondary" className="text-xs">None</Text> : (
              <div className="space-y-2">
                {e.audit.map((a, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 p-3">
                    <div className="flex items-center gap-2 mb-1">
                      <Tag color={SEVERITY[a.severity] ?? "default"} className="!m-0">{a.severity}</Tag>
                      <Text type="secondary" className="text-xs">{a.by} · {time(a.t)}</Text>
                    </div>
                    <Text className="text-[13px] whitespace-pre-line">{a.finding}</Text>
                  </div>
                ))}
              </div>
            )}
          </div>
          <div>
            <Text className="block text-[13px] font-semibold mb-2">Critic notes</Text>
            {e.critic.length === 0 ? <Text type="secondary" className="text-xs">None</Text> : (
              <div className="space-y-2">
                {e.critic.map((c, i) => (
                  <div key={i} className="rounded-lg border border-slate-200 p-3">
                    <Text type="secondary" className="text-xs block mb-1">{c.by} · {time(c.t)}</Text>
                    <Text className="text-[13px] whitespace-pre-line">{c.note}</Text>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {e.similar.length > 0 && (
        <div>
          <Text className="block text-[13px] font-semibold mb-2">Similar experiments</Text>
          <div className="space-y-1">
            {e.similar.map((s) => (
              <div key={s.id} className="flex items-center gap-2">
                <Link to={`/research?exp=${s.id}`} className="text-[13px]">{s.id}</Link>
                <Text className="text-[13px] flex-1 truncate">{s.name}</Text>
                <VerdictTag v={s.verdict} />
              </div>
            ))}
          </div>
        </div>
      )}

      <div>
        <Text className="block text-[13px] font-semibold mb-2">Run log</Text>
        {e.log.length === 0 ? <Text type="secondary" className="text-xs">Nothing yet</Text> : (
          <div className="rounded-lg bg-slate-50 p-3 space-y-0.5 max-h-60 overflow-y-auto">
            {e.log.map((l, i) => (
              <div key={i} className="text-xs">
                <span className="text-slate-400 tabular-nums mr-2">{time(l.t)}</span>
                <span className="text-slate-700">{l.msg}</span>
              </div>
            ))}
          </div>
        )}
      </div>

      <Collapse
        size="small"
        items={[
          {
            key: "spec",
            label: "Strategy definition",
            children: (
              <div className="space-y-3">
                {summary.length > 0 && <ul className="list-disc pl-5 text-[13px] text-slate-700">{summary.map((s, i) => <li key={i}>{s}</li>)}</ul>}
                <pre className="text-[11px] bg-slate-50 rounded-lg p-3 overflow-x-auto max-h-96">{JSON.stringify(e.spec, null, 2)}</pre>
              </div>
            ),
          },
        ]}
      />
    </div>
  );
}

function ExperimentDrawer({ id, onClose }: { id: string | null; onClose: () => void }) {
  const exp = useExperiment(id);
  return (
    <Drawer
      open={!!id}
      onClose={onClose}
      width="min(1100px, 95vw)"
      title={exp.data ? `${exp.data.id} · ${exp.data.name}` : id}
      destroyOnClose
    >
      {exp.error && <Alert type="error" showIcon message={errorMessage(exp.error)} />}
      {exp.isLoading && <Skeleton active />}
      {exp.data && <Detail e={exp.data} />}
    </Drawer>
  );
}

// ---------- Page ----------

export default function ResearchPage() {
  const status = useResearchStatus();
  const experiments = useExperiments();
  const [search, setSearch] = useSearchParams();
  const openId = search.get("exp");
  const open = (id: string) => setSearch({ exp: id });
  const close = () => setSearch({});
  const s = status.data;
  const rows = experiments.data ?? [];

  return (
    <div className="mx-auto max-w-7xl space-y-6" style={{ padding: 24 }}>
      <PageTitle
        title="Research lab"
        description="An autonomous research program testing strategy ideas against fixed rules. Updates live; hover any underlined term for what it means."
        pageTitle={[{ title: "Research lab" }]}
      />
      {status.error && <Alert type="error" showIcon message={errorMessage(status.error)} />}
      {!s ? (
        <Skeleton active />
      ) : (
        <>
          <Header s={s} />
          <div className="grid grid-cols-1 xl:grid-cols-[2fr_3fr] gap-6">
            <NowRunning s={s} onOpen={open} />
            <Team s={s} />
          </div>
        </>
      )}
      {experiments.error && <Alert type="error" showIcon message={errorMessage(experiments.error)} />}
      <PaperWatch onOpen={open} />
      <Leaderboard rows={rows} loading={experiments.isLoading} onOpen={open} />
      <Playbook />
      <Experiments rows={rows} loading={experiments.isLoading} onOpen={open} />
      {s && (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          <Events s={s} onOpen={open} />
          <Protocol s={s} />
        </div>
      )}
      <ExperimentDrawer id={openId} onClose={close} />
    </div>
  );
}
