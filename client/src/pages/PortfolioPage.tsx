import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert, App, Button, Checkbox, DatePicker, Empty, Input, InputNumber, Popconfirm, Progress, Segmented, Select, Skeleton, Switch, Tag, Tooltip, Typography,
} from "antd";
import {
  CheckCircleFilled, CloseCircleFilled, CopyOutlined, DeleteOutlined, EditOutlined, ExclamationCircleFilled, FolderOpenOutlined, PlayCircleOutlined, SaveOutlined,
} from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { Link, useSearchParams } from "react-router-dom";
import {
  errorMessage, useDeletePortfolio, useJob, useRun, useRunPortfolio, useSavedPortfolio, useSavedPortfolios, useSavedStrategies, useSavedStrategy,
  useSavePortfolio, useTemplates, useValidatePortfolio,
  type T_Portfolio, type T_PortfolioCheck, type T_PortfolioMember, type T_PortfolioResult, type T_SavedPortfolio,
} from "../api/client";
import ConditionBuilder from "../components/builder/ConditionBuilder";
import ConnectionGate from "../components/ConnectionGate";
import PageTitle from "../components/PageTitle";
import PortfolioResults from "../components/portfolio/PortfolioResults";
import SectionCard from "../components/SectionCard";
import { backtestCrumb } from "../lib/nav";
import { BLANK_PORTFOLIO, VIX_RULE, describeGate, gateMode, newMemberId, parseRegimeGate, regimeGate, type T_GateMode } from "../lib/portfolio";
import { REGIME_LABELS, REGIME_MODELS, describeSpec, normalizeSpec, type T_Spec } from "../lib/spec";

const { Text } = Typography;

const PERIODS = [
  { label: "3M", value: 3 },
  { label: "6M", value: 6 },
  { label: "1Y", value: 12 },
  { label: "2Y", value: 24 },
];

// ---------- one algo in the bucket ----------

function GateEditor({ value, onChange }: { value: T_PortfolioMember["gate"]; onChange: (g: T_PortfolioMember["gate"]) => void }) {
  const [mode, setMode] = useState<T_GateMode>(gateMode(value));
  const regime = parseRegimeGate(value) ?? { model: "trend_vol", codes: [] };
  const switchTo = (m: T_GateMode) => {
    setMode(m);
    if (m === "always") onChange(null);
    if (m === "regime") onChange(null); // pick regimes next
    if (m === "custom") onChange({ all: [VIX_RULE()] });
  };
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-3">
        <Text className="text-[13px] font-medium">When may it trade?</Text>
        <Segmented size="small" value={mode} onChange={(m) => switchTo(m as T_GateMode)}
          options={[{ value: "always", label: "Always" }, { value: "regime", label: "Market regime" }, { value: "custom", label: "Indicator conditions" }]} />
      </div>
      {mode === "regime" && (
        <div className="space-y-2">
          <div className="flex items-center gap-2">
            <Text type="secondary" className="text-xs">Model</Text>
            <Select size="small" className="!w-44" value={regime.model} options={REGIME_MODELS}
              onChange={(model) => onChange(regimeGate(model, []))} />
          </div>
          <Checkbox.Group
            value={regime.codes}
            onChange={(codes) => onChange(regimeGate(regime.model, codes as number[]))}
            options={(REGIME_LABELS[regime.model] ?? REGIME_LABELS.trend_vol).map((l) => ({ value: l.value, label: l.label }))}
          />
          <Text type="secondary" className="text-xs block">
            {regime.codes.length ? "" : "Pick the regimes this algo suits; with none picked it trades always. "}
            Regimes come from daily candles and India VIX, known at the previous close (trend: close vs 50-day average + ADX; volatile: VIX above its 60th percentile of the past year).
          </Text>
        </div>
      )}
      {mode === "custom" && (
        <div>
          <ConditionBuilder value={value} onChange={(c) => { onChange(c); if (!c) setMode("always"); }} tf="1d" addLabel="Add condition" initial={VIX_RULE} />
          <Text type="secondary" className="text-xs block mt-1">
            Read on the latest closed candle before each entry (daily candles by default; change the timeframe per indicator). ANDed with the algo's own entry rules.
          </Text>
        </div>
      )}
    </div>
  );
}

function MemberCard({ member, index, color, onChange, onRemove, sourceOptions, templateSpecs, check }: {
  member: T_PortfolioMember;
  index: number;
  color: string;
  onChange: (m: T_PortfolioMember) => void;
  onRemove: () => void;
  sourceOptions: { label: string; options: { value: string; label: string }[] }[];
  templateSpecs: Record<string, T_Spec>;
  check: T_PortfolioCheck | undefined;
}) {
  const saved = useSavedStrategy(member.strategy_id ?? null);
  const spec = member.strategy_id ? saved.data?.spec : member.spec;
  const source = member.strategy_id ? `str:${member.strategy_id}` : member.spec ? `inline` : undefined;
  const errors = check?.errors.filter((e) => e.member === member.id) ?? [];
  const warnings = check?.warnings.filter((e) => e.member === member.id) ?? [];
  const pick = (v: string) => {
    if (v.startsWith("str:")) onChange({ ...member, strategy_id: v.slice(4), spec: null, name: null });
    else if (v.startsWith("tpl:")) {
      const s = templateSpecs[v.slice(4)];
      onChange({ ...member, strategy_id: null, spec: normalizeSpec(s), name: s.name });
    }
  };
  return (
    <div className={`bg-white rounded-2xl border shadow-sm p-5 space-y-4 ${member.enabled ? "border-slate-200/70" : "border-dashed border-slate-300 opacity-70"}`}>
      <div className="flex flex-wrap items-center gap-3">
        <span className="inline-block w-3 h-3 rounded-full shrink-0" style={{ background: color }} />
        <Text type="secondary" className="text-xs">Algo {index + 1}</Text>
        <Input className="!w-64" placeholder={spec?.name ?? "Name"} value={member.name ?? ""} onChange={(e) => onChange({ ...member, name: e.target.value || null })} />
        <Select className="!w-72" showSearch optionFilterProp="label"
          placeholder={source === "inline" ? `Inline: ${member.spec?.name ?? "strategy"}` : "Choose a saved strategy or template"}
          value={source === "inline" ? undefined : source} options={sourceOptions} onChange={pick} />
        <Tooltip title="Multiplies the strategy's own lots">
          <InputNumber className="!w-24" min={1} max={50} value={member.lots} addonBefore="×" onChange={(v) => v && onChange({ ...member, lots: v })} />
        </Tooltip>
        <Tooltip title={member.enabled ? "Included in the backtest" : "Left out of the backtest"}>
          <Switch checked={member.enabled} onChange={(enabled) => onChange({ ...member, enabled })} checkedChildren="On" unCheckedChildren="Off" />
        </Tooltip>
        <div className="flex-1" />
        {member.strategy_id && <Link to={`/backtest/builder?strategy=${member.strategy_id}`}><Button size="small" type="link" icon={<EditOutlined />}>Edit strategy</Button></Link>}
        <Popconfirm title="Remove this algo?" onConfirm={onRemove}><Button size="small" type="text" danger icon={<DeleteOutlined />} /></Popconfirm>
      </div>

      {spec ? (
        <ul className="text-[13px] text-slate-600 list-none pl-0 space-y-0.5 m-0">
          {describeSpec(normalizeSpec(spec)).slice(0, 4).map((l, i) => <li key={i}>{l}</li>)}
        </ul>
      ) : member.strategy_id && saved.isLoading ? <Skeleton active paragraph={{ rows: 1 }} title={false} /> : (
        <Text type="secondary" className="text-xs">Choose what this algo trades.</Text>
      )}

      <GateEditor value={member.gate} onChange={(gate) => onChange({ ...member, gate })} />

      {(errors.length > 0 || warnings.length > 0) && (
        <div className="space-y-1">
          {errors.map((e, i) => <div key={i} className="flex gap-2 text-[13px]"><CloseCircleFilled className="text-red-500 mt-0.5" /><span>{e.message}</span></div>)}
          {warnings.map((w, i) => <div key={i} className="flex gap-2 text-[13px] text-slate-600"><ExclamationCircleFilled className="text-amber-500 mt-0.5" /><span>{w.message}</span></div>)}
        </div>
      )}
    </div>
  );
}

// ---------- editor ----------

const COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948", "#00a2b8", "#8a6d3b", "#5b6b7f", "#b04fc4"];

function Editor({ initial, saved, runResult }: { initial: T_Portfolio; saved: T_SavedPortfolio | null; runResult: T_PortfolioResult | null }) {
  const { message } = App.useApp();
  const [search, setSearch] = useSearchParams();
  const runId = search.get("run");
  const [pf, setPf] = useState<T_Portfolio>(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() =>
    runResult ? [dayjs(runResult.params.from_date), dayjs(runResult.params.to_date)] : [dayjs().subtract(6, "month"), dayjs().subtract(1, "day")]);
  const strategies = useSavedStrategies();
  const templates = useTemplates();
  const validate = useValidatePortfolio();
  const save = useSavePortfolio();
  const run = useRunPortfolio();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<T_PortfolioResult>(jobId);
  const resultsRef = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(pf) !== baseline;
  const from = range[0].format("YYYY-MM-DD");
  const to = range[1].format("YYYY-MM-DD");

  useEffect(() => {
    if (!pf.members.length) return;
    const t = setTimeout(() => validate.mutate(pf), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pf]);

  const jobResult = job.data?.status === "done" ? job.data.result : null;
  useEffect(() => {
    if (jobResult?.run_id && jobResult.run_id !== runId) {
      setSearch((p) => { const n = new URLSearchParams(p); n.set("run", jobResult.run_id!); return n; }, { replace: true });
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
    }
  }, [jobResult, runId, setSearch]);
  const result = jobResult ?? runResult;
  const running = run.isPending || job.data?.status === "running";
  const check = pf.members.length ? validate.data : undefined;

  const templateSpecs = useMemo(() => Object.fromEntries((templates.data ?? []).map((t) => [t.id, t.spec])), [templates.data]);
  const sourceOptions = useMemo(() => [
    { label: "Saved strategies", options: (strategies.data ?? []).map((s) => ({ value: `str:${s.id}`, label: `${s.name} · v${s.version}` })) },
    { label: "Templates", options: (templates.data ?? []).map((t) => ({ value: `tpl:${t.id}`, label: `${t.name} (template)` })) },
  ], [strategies.data, templates.data]);

  const setMember = (i: number, m: T_PortfolioMember) => setPf((p) => ({ ...p, members: p.members.map((x, j) => (j === i ? m : x)) }));
  const addMember = (v: string) => setPf((p) => {
    const base: T_PortfolioMember = { id: newMemberId(p.members), lots: 1, enabled: true, gate: null };
    if (v.startsWith("str:")) return { ...p, members: [...p.members, { ...base, strategy_id: v.slice(4) }] };
    const s = templateSpecs[v.slice(4)];
    return { ...p, members: [...p.members, { ...base, spec: normalizeSpec(s), name: s.name }] };
  });

  const doSave = (asNew = false) =>
    save.mutate({ id: asNew ? null : saved?.id, portfolio: asNew ? { ...pf, name: `${pf.name} (copy)` } : pf }, {
      onSuccess: (doc) => {
        setBaseline(JSON.stringify(doc.portfolio));
        setPf(doc.portfolio);
        setSearch((p) => { const n = new URLSearchParams(p); n.set("portfolio", doc.id); return n; }, { replace: true });
        message.success(asNew ? "Saved as a new portfolio" : "Portfolio saved");
      },
      onError: (e) => message.error(errorMessage(e)),
    });
  const doRun = () =>
    run.mutate({ portfolio: pf, from_date: from, to_date: to, portfolio_id: saved?.id }, { onSuccess: (r) => setJobId(r.job_id), onError: (e) => message.error(errorMessage(e)) });
  const canRun = !!check?.ok && pf.members.some((m) => m.enabled);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Input variant="borderless" className="!text-[20px] !font-semibold !px-0 max-w-xl" value={pf.name} onChange={(e) => setPf((p) => ({ ...p, name: e.target.value }))} />
          {saved ? <Tag>{dirty ? "Edited" : "Saved"}</Tag> : <Tag color="gold">Not saved</Tag>}
        </div>
        <div className="flex gap-2">
          {saved && <Button icon={<CopyOutlined />} onClick={() => doSave(true)}>Save as new</Button>}
          <Button icon={<SaveOutlined />} loading={save.isPending} disabled={(!!saved && !dirty) || !pf.members.length} onClick={() => doSave(false)}>{saved ? "Save" : "Save portfolio"}</Button>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={running} disabled={!canRun} onClick={doRun}>Run backtest</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_360px] gap-6 items-start">
        <div className="space-y-4 min-w-0">
          {pf.members.length === 0 && (
            <div className="bg-white rounded-2xl border border-slate-200/70 py-10">
              <Empty description={<span>Add the algos for this bucket. Give each one a <b>gate</b> (e.g. only in an uptrend, only when VIX is calm) so it trades only in the market cycle it suits.</span>} />
            </div>
          )}
          {pf.members.map((m, i) => (
            <MemberCard key={m.id} member={m} index={i} color={COLORS[i % COLORS.length]} check={check} sourceOptions={sourceOptions} templateSpecs={templateSpecs}
              onChange={(x) => setMember(i, x)} onRemove={() => setPf((p) => ({ ...p, members: p.members.filter((_, j) => j !== i) }))} />
          ))}
          {pf.members.length < 12 && (
            <Select className="!w-80" showSearch optionFilterProp="label" placeholder="+ Add an algo (saved strategy or template)" value={null as unknown as string}
              options={sourceOptions} onChange={addMember} loading={strategies.isLoading || templates.isLoading} />
          )}
        </div>

        <div className="space-y-4 xl:sticky xl:top-20">
          <SectionCard title="Portfolio" description="Capital is what returns and drawdown % are measured against.">
            <div className="space-y-3">
              <InputNumber className="!w-full" min={10000} step={50000} value={pf.capital} addonBefore="Capital ₹"
                formatter={(v) => `${v}`.replace(/\B(?=(\d{3})+(?!\d))/g, ",")} parser={(v) => Number((v ?? "").replace(/,/g, ""))}
                onChange={(v) => v && setPf((p) => ({ ...p, capital: v }))} />
              <Input.TextArea rows={2} placeholder="Notes (what this bucket is for)" value={pf.description} onChange={(e) => setPf((p) => ({ ...p, description: e.target.value }))} />
              <ul className="text-[13px] text-slate-600 list-none pl-0 space-y-1 m-0">
                {pf.members.filter((m) => m.enabled).map((m) => (
                  <li key={m.id}><b className="font-medium text-slate-800">{m.name ?? "Algo"}</b> · {describeGate(m.gate)}</li>
                ))}
              </ul>
            </div>
          </SectionCard>
          <SectionCard title="Checks" description="Each algo is checked with its gate applied.">
            {!pf.members.length ? <Text type="secondary" className="text-xs">Add an algo first.</Text> : !check ? <Skeleton active paragraph={{ rows: 1 }} /> : (
              <div className="space-y-2 text-[13px]">
                {check.errors.filter((e) => !e.member).map((e, i) => <div key={i} className="flex gap-2"><CloseCircleFilled className="text-red-500 mt-0.5" /><span>{e.message}</span></div>)}
                {check.warnings.filter((e) => !e.member).map((w, i) => <div key={i} className="flex gap-2 text-slate-600"><ExclamationCircleFilled className="text-amber-500 mt-0.5" /><span>{w.message}</span></div>)}
                {check.ok
                  ? <div className="flex gap-2"><CheckCircleFilled className="text-emerald-500 mt-0.5" /><span>Ready to run{check.warnings.length ? ` (${check.warnings.length} warning${check.warnings.length > 1 ? "s" : ""} on the algos)` : ""}.</span></div>
                  : check.errors.some((e) => e.member) && <div className="flex gap-2"><CloseCircleFilled className="text-red-500 mt-0.5" /><span>Fix the problems shown on the algos.</span></div>}
              </div>
            )}
          </SectionCard>
          <SectionCard title="Backtest period" description="Every algo runs over the same period; missing data is fetched from Breeze.">
            <div className="space-y-3">
              <Segmented block options={PERIODS} value={null as unknown as number}
                onChange={(m) => setRange([dayjs().subtract(Number(m), "month"), dayjs().subtract(1, "day")])} />
              <DatePicker.RangePicker className="w-full" value={range} allowClear={false} disabledDate={(d) => d.isAfter(dayjs(), "day")} onChange={(r) => r && setRange(r as [Dayjs, Dayjs])} />
              {job.data?.status === "running" && (
                <div>
                  <Progress percent={job.data.total ? Math.round((job.data.done / job.data.total) * 100) : 0} status="active" size="small" />
                  <Text type="secondary" className="text-xs">{job.data.message}</Text>
                </div>
              )}
              {job.data?.status === "error" && <Alert type="error" showIcon message="Backtest failed" description={job.data.error} />}
              <Tooltip title={!canRun ? "Add algos and fix the problems in Checks first" : undefined}>
                <Button type="primary" block icon={<PlayCircleOutlined />} disabled={!canRun} loading={running} onClick={doRun}>Run backtest</Button>
              </Tooltip>
            </div>
          </SectionCard>
          <SavedPortfolios current={saved?.id ?? null} />
        </div>
      </div>

      <div ref={resultsRef}>
        {result && (
          <div className="space-y-4">
            <Text className="block text-[17px] font-semibold">Results · {dayjs(result.params.from_date).format("D MMM YY")} – {dayjs(result.params.to_date).format("D MMM YY")}</Text>
            <PortfolioResults result={result} runId={runId}
              autoPdf={search.get("pdf") === "1"}
              onPdfDone={() => setSearch((p) => { const n = new URLSearchParams(p); n.delete("pdf"); return n; }, { replace: true })} />
          </div>
        )}
      </div>
    </div>
  );
}

function SavedPortfolios({ current }: { current: string | null }) {
  const list = useSavedPortfolios();
  const del = useDeletePortfolio();
  const [, setSearch] = useSearchParams();
  if (!list.data?.length) return null;
  return (
    <SectionCard title="Saved portfolios" description="Open one to edit or rerun it.">
      <div className="space-y-1">
        {list.data.map((p) => (
          <div key={p.id} className={`flex items-center gap-2 rounded-lg px-2 py-1 ${p.id === current ? "bg-indigo-50" : ""}`}>
            <Text className="flex-1 text-[13px] truncate">{p.name}</Text>
            <Text type="secondary" className="text-xs">{p.members} algos</Text>
            <Button size="small" type="text" icon={<FolderOpenOutlined />} onClick={() => setSearch({ portfolio: p.id })} />
            <Popconfirm title="Delete this portfolio?" onConfirm={() => del.mutate(p.id)}>
              <Button size="small" type="text" danger icon={<DeleteOutlined />} />
            </Popconfirm>
          </div>
        ))}
      </div>
    </SectionCard>
  );
}

// ---------- page ----------

export default function PortfolioPage() {
  const [search] = useSearchParams();
  const portfolioId = search.get("portfolio");
  const runId = search.get("run");
  const saved = useSavedPortfolio(portfolioId);
  const run = useRun<T_PortfolioResult>(runId);
  const loading = (portfolioId && saved.isLoading) || (runId && run.isLoading);
  // Priority: the portfolio being edited > a run's portfolio > blank.
  const source = useMemo(() => {
    if (loading) return null;
    if (portfolioId && saved.data) return { key: `p-${saved.data.id}`, portfolio: saved.data.portfolio };
    if (runId && run.data?.result?.params?.portfolio) return { key: `r-${runId}`, portfolio: run.data.result.params.portfolio };
    return { key: "blank", portfolio: BLANK_PORTFOLIO };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, portfolioId, saved.data?.id, runId, run.data]);

  return (
    <div style={{ padding: 24 }}>
      <PageTitle title="Strategy portfolio"
        description="Backtest several algos together. Each keeps its own entry and exit rules, and a gate decides when it may trade, so different algos cover different market cycles."
        pageTitle={[backtestCrumb, { title: "Portfolio" }]} />
      <ConnectionGate>
        {saved.error && <Alert type="error" showIcon message={errorMessage(saved.error)} className="!mb-4" />}
        {run.error && <Alert type="error" showIcon message={errorMessage(run.error)} className="!mb-4" />}
        {!source ? <Skeleton active /> : (
          <Editor key={source.key} initial={source.portfolio} saved={portfolioId ? saved.data ?? null : null}
            runResult={runId && run.data?.strategy === "portfolio" ? run.data.result : null} />
        )}
      </ConnectionGate>
    </div>
  );
}
