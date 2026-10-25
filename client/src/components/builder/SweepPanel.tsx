import { useMemo, useState } from "react";
import { Alert, Button, Progress, Segmented, Select, Slider, Switch, Tooltip, Typography } from "antd";
import { ExperimentOutlined } from "@ant-design/icons";
import { errorMessage, useJob, useStartSweep, type T_SweepMetrics, type T_SweepParam, type T_SweepResult } from "../../api/client";
import { isDirectional, type T_Spec } from "../../lib/spec";

const { Text } = Typography;

type T_Def = { key: string; label: string; path: string; defaults: (number | string)[]; time?: boolean };
type T_MetricKey = "net_pnl" | "win_rate" | "profit_factor" | "sharpe";

const METRICS: { value: T_MetricKey; label: string }[] = [
  { value: "net_pnl", label: "Net P&L" },
  { value: "win_rate", label: "Win rate" },
  { value: "profit_factor", label: "Profit factor" },
  { value: "sharpe", label: "Sharpe" },
];
const POS = ["#cde2fb", "#9ec5f4", "#6da7ec", "#3987e5", "#256abf", "#184f95"];
const NEG = ["#fadcdc", "#f5b5b4", "#ee8b8a", "#e34948", "#c23736", "#962827"];

// Parameters worth sweeping for this spec, with sensible starting values.
function sweepable(s: T_Spec): T_Def[] {
  const out: T_Def[] = [];
  const x = s.exits;
  const unit = (u?: string) => (u === "pct" ? "%" : u === "rupees" ? "₹" : u === "points" ? " pts" : "");
  out.push({ key: "target", label: `Target${unit(x.combined.target?.unit ?? "pct")}`, path: "exits.combined.target.value", defaults: [20, 30, 40, 50, 60] });
  out.push({ key: "stop", label: `Stop${unit(x.combined.stop?.unit ?? "pct")}`, path: "exits.combined.stop.value", defaults: [20, 30, 40, 60] });
  if (s.schedule.entry.type === "time") out.push({ key: "entry", label: "Entry time", path: "schedule.entry.time", defaults: ["09:20", "09:30", "09:45", "10:00"], time: true });
  else out.push({ key: "last", label: "No entries after", path: "schedule.entry.last_entry", defaults: ["12:00", "13:30", "15:00"], time: true });
  out.push({ key: "sq", label: "Square-off", path: "exits.square_off", defaults: ["14:30", "15:00", "15:15", "15:25"], time: true });
  if (x.per_leg?.stop) out.push({ key: "legstop", label: "Leg stop", path: "exits.per_leg.stop.value", defaults: [15, 20, 25, 30, 40] });
  if (x.combined.trailing) out.push({ key: "trail", label: "Trail by", path: "exits.combined.trailing.trail.value", defaults: [10, 15, 20, 30] });
  const group = isDirectional(s) ? "bullish" : "legs";
  (s.position[group] ?? []).forEach((l, i) => {
    if (l.instrument === "FUT") return;
    const v = l.strike.value;
    const step = l.strike.by === "points" ? 100 : l.strike.by === "premium" ? 10 : l.strike.by === "delta" ? 0.05 : 1;
    const defaults = [-2, -1, 0, 1, 2].map((k) => +(v + k * step).toFixed(2)).filter((x) => l.strike.by === "atm_offset" || l.strike.by === "points" || x > 0);
    out.push({ key: `leg${i}`, label: `${l.id} strike (${l.strike.by.replace("_", " ")})`, path: `position.${group}.${i}.strike.value`, defaults });
  });
  return out;
}

function cellStyle(v: number | null | undefined, metric: T_MetricKey, maxAbs: number) {
  if (v === null || v === undefined || !isFinite(v)) return { background: "#F8FAFC", color: "#94A3B8" };
  const center = metric === "win_rate" ? 50 : metric === "profit_factor" ? 1 : 0;
  const x = maxAbs ? Math.max(-1, Math.min(1, (v - center) / maxAbs)) : 0;
  if (Math.abs(x) < 0.04) return { background: "#f0efec", color: "#0F172A" };
  const ramp = x > 0 ? POS : NEG;
  const i = Math.min(ramp.length - 1, Math.floor(Math.abs(x) * ramp.length));
  return { background: ramp[i], color: i >= 3 ? "#fff" : "#0F172A" };
}

const fmt = (v: number | null | undefined, metric: T_MetricKey) =>
  v === null || v === undefined ? "–" : metric === "net_pnl" ? `${v < 0 ? "−" : "+"}${(Math.abs(v) / 1000).toFixed(1)}K` : metric === "win_rate" ? `${v.toFixed(0)}%` : v.toFixed(2);

function Heatmap({ result, part, metric, best, onPick }: { result: T_SweepResult; part: "in" | "out"; metric: T_MetricKey; best: string; onPick: (values: (number | string)[]) => void }) {
  const [p1, p2] = result.params;
  const center = metric === "win_rate" ? 50 : metric === "profit_factor" ? 1 : 0;
  const vals = result.cells.map((c) => (c[part] as T_SweepMetrics | undefined)?.[metric]).filter((v): v is number => typeof v === "number");
  const maxAbs = Math.max(...vals.map((v) => Math.abs(v - center)), 1e-9);
  const rows = p2 ? p2.values : [null];
  const find = (a: number | string, b: number | string | null) => result.cells.find((c) => c.values[0] === a && (b === null || c.values[1] === b));
  return (
    <div className="overflow-x-auto">
      <table className="border-separate" style={{ borderSpacing: 3 }}>
        <thead>
          <tr>
            <th className="px-2 text-left"><Text type="secondary" className="text-[10px] uppercase tracking-wider">{p2 ? `${p2.label} ↓ / ${p1.label} →` : p1.label}</Text></th>
            {p1.values.map((v) => <th key={String(v)} className="px-2 min-w-16"><Text type="secondary" className="text-xs">{String(v)}</Text></th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={String(r)}>
              <td className="px-2 whitespace-nowrap"><Text type="secondary" className="text-xs">{r === null ? "" : String(r)}</Text></td>
              {p1.values.map((a) => {
                const c = find(a, r);
                const m = c?.[part] as T_SweepMetrics | undefined;
                const v = m?.[metric] as number | null | undefined;
                const id = JSON.stringify(c?.values);
                return (
                  <Tooltip key={String(a)} title={m?.error ?? (m ? `Net ₹${Math.round(m.net_pnl).toLocaleString("en-IN")} · ${m.trades} trades · win ${m.win_rate?.toFixed(0) ?? "–"}% · PF ${m.profit_factor ?? "–"} · max DD ₹${Math.round(m.max_drawdown).toLocaleString("en-IN")}` : "")}>
                    <td onClick={() => c && onPick(c.values)} className="cursor-pointer rounded-md px-2 py-2 text-center text-xs tabular-nums"
                      style={{ ...cellStyle(v, metric, maxAbs), outline: id === best ? "2px solid #0F172A" : undefined, outlineOffset: -2 }}>
                      {m?.error ? "err" : fmt(v, metric)}
                    </td>
                  </Tooltip>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export default function SweepPanel({ spec, from, to, onApply }: { spec: T_Spec; from: string; to: string; onApply: (params: T_SweepParam[], values: (number | string)[]) => void }) {
  const defs = useMemo(() => sweepable(spec), [spec]);
  const [k1, setK1] = useState(defs[0]?.key);
  const [k2, setK2] = useState<string | null>(defs[1]?.key ?? null);
  const d1 = defs.find((d) => d.key === k1) ?? defs[0];
  const d2 = defs.find((d) => d.key === k2) ?? null;
  const [v1, setV1] = useState<(number | string)[]>(d1?.defaults ?? []);
  const [v2, setV2] = useState<(number | string)[]>(d2?.defaults ?? []);
  const [wf, setWf] = useState(false);
  const [inPct, setInPct] = useState(70);
  const [metric, setMetric] = useState<T_MetricKey>("net_pnl");
  const start = useStartSweep();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<T_SweepResult>(jobId);
  const result = job.data?.status === "done" ? job.data.result : null;
  const running = start.isPending || job.data?.status === "running";
  const combos = v1.length * (d2 ? v2.length : 1);

  const parse = (d: T_Def, vals: (number | string)[]) => vals.map((v) => (d.time ? String(v) : Number(v))).filter((v) => d.time || !Number.isNaN(v));
  const params = (): T_SweepParam[] => [
    { path: d1.path, label: d1.label, values: parse(d1, v1) },
    ...(d2 ? [{ path: d2.path, label: d2.label, values: parse(d2, v2) }] : []),
  ];

  const best = useMemo(() => {
    if (!result) return "";
    const score = (m?: T_SweepMetrics) => (m && !m.error ? (m[metric] as number | null) ?? -Infinity : -Infinity);
    const b = result.cells.reduce((acc, c) => (score(c.in) > score(acc.in) ? c : acc), result.cells[0]);
    return JSON.stringify(b.values);
  }, [result, metric]);
  const bestCell = result?.cells.find((c) => JSON.stringify(c.values) === best);
  const oosRank = result?.walk_forward && bestCell?.out
    ? [...result.cells].sort((a, b) => ((b.out?.[metric] as number) ?? -Infinity) - ((a.out?.[metric] as number) ?? -Infinity)).findIndex((c) => c === bestCell) + 1
    : null;

  const field = (label: string, def: T_Def | null, setKey: (k: string) => void, vals: (number | string)[], setVals: (v: (number | string)[]) => void, optional = false) => (
    <div className="space-y-1.5">
      <Text className="block text-[13px] font-medium">{label}</Text>
      <Select className="w-full" value={def?.key ?? "__none"} allowClear={false}
        options={[...(optional ? [{ value: "__none", label: "— none —" }] : []), ...defs.map((d) => ({ value: d.key, label: d.label }))]}
        onChange={(k) => { setKey(k); const d = defs.find((x) => x.key === k); setVals(d?.defaults ?? []); }} />
      {def && (
        <Select mode="tags" className="w-full" value={vals.map(String)} tokenSeparators={[",", " "]}
          onChange={(v: string[]) => setVals(v)} placeholder="Values to try" />
      )}
    </div>
  );

  if (!defs.length) return null;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        {field("Parameter 1 (columns)", d1, (k) => setK1(k), v1, setV1)}
        {field("Parameter 2 (rows)", d2, (k) => setK2(k === "__none" ? null : k), v2, setV2, true)}
      </div>
      <div className="flex flex-wrap items-center gap-6">
        <div className="flex items-center gap-2">
          <Switch checked={wf} onChange={setWf} />
          <Text className="text-[13px]">Walk-forward check</Text>
          <Tooltip title="Choose on the first part of the period, check on the rest. A big drop out-of-sample means the setting was luck.">
            <Text type="secondary" className="text-xs cursor-help">(?)</Text>
          </Tooltip>
        </div>
        {wf && (
          <div className="flex items-center gap-2 w-72">
            <Text type="secondary" className="text-xs whitespace-nowrap">In-sample {inPct}%</Text>
            <Slider className="flex-1" min={50} max={85} step={5} value={inPct} onChange={setInPct} />
          </div>
        )}
        <Button type="primary" icon={<ExperimentOutlined />} loading={running} disabled={!v1.length || combos > 36}
          onClick={() => start.mutate({ spec, from_date: from, to_date: to, params: params(), walk_forward: wf, in_sample_pct: inPct }, { onSuccess: (r) => setJobId(r.job_id) })}>
          Run {combos} combination{combos === 1 ? "" : "s"}{wf ? " × 2" : ""}
        </Button>
        {combos > 36 && <Text type="danger" className="text-xs">At most 36 combinations</Text>}
      </div>
      {start.error && <Alert type="error" showIcon message={errorMessage(start.error)} />}
      {job.data?.status === "running" && (
        <div>
          <Progress percent={job.data.total ? Math.round((job.data.done / job.data.total) * 100) : 0} status="active" size="small" />
          <Text type="secondary" className="text-xs">{job.data.message}</Text>
        </div>
      )}
      {job.data?.status === "error" && <Alert type="error" showIcon message="Sweep failed" description={job.data.error} />}
      {result && (
        <div className="space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <Segmented size="small" value={metric} onChange={(v) => setMetric(v as T_MetricKey)} options={METRICS} />
            {bestCell && (
              <Text className="text-xs">
                Best {result.walk_forward ? "in-sample" : ""}: <b>{result.params.map((p, i) => `${p.label} ${bestCell.values[i]}`).join(", ")}</b>
                {oosRank && <> · ranks <b>#{oosRank}</b> of {result.cells.length} out-of-sample</>}
                {" "}<Button size="small" type="link" onClick={() => onApply(result.params, bestCell.values)}>Use it</Button>
              </Text>
            )}
          </div>
          <div className={`grid gap-6 ${result.walk_forward ? "grid-cols-1 2xl:grid-cols-2" : "grid-cols-1"}`}>
            <div>
              <Text className="block text-[13px] font-semibold mb-1">{result.walk_forward ? `In-sample (choose) · ${result.periods.in[0]} → ${result.periods.in[1]}` : `${result.periods.in[0]} → ${result.periods.in[1]}`}</Text>
              <Heatmap result={result} part="in" metric={metric} best={best} onPick={(v) => onApply(result.params, v)} />
            </div>
            {result.walk_forward && result.periods.out && (
              <div>
                <Text className="block text-[13px] font-semibold mb-1">Out-of-sample (check) · {result.periods.out[0]} → {result.periods.out[1]}</Text>
                <Heatmap result={result} part="out" metric={metric} best={best} onPick={(v) => onApply(result.params, v)} />
              </div>
            )}
          </div>
          <Text type="secondary" className="text-xs block">Click a cell to put those values in the strategy. Outlined = best {result.walk_forward ? "in-sample" : ""} by the selected metric. Past results; prefer a broad good region over a single bright cell.</Text>
        </div>
      )}
    </div>
  );
}
