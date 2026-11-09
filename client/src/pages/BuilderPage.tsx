import { useEffect, useMemo, useRef, useState } from "react";
import {
  Alert,
  App,
  Button,
  DatePicker,
  Divider,
  Input,
  InputNumber,
  Progress,
  Segmented,
  Select,
  Skeleton,
  Steps,
  Switch,
  Tabs,
  Tag,
  TimePicker,
  Tooltip,
  Typography,
} from "antd";
import { CheckCircleFilled, CopyOutlined, PlayCircleOutlined, PlusOutlined, SaveOutlined, WarningFilled, CloseCircleFilled, DeleteOutlined } from "@ant-design/icons";
import dayjs, { type Dayjs } from "dayjs";
import { Area, AreaChart, CartesianGrid, ReferenceLine, ResponsiveContainer, Tooltip as ChartTooltip, XAxis, YAxis } from "recharts";
import { useSearchParams } from "react-router-dom";
import {
  errorMessage,
  useDataCheck,
  useJob,
  useRun,
  useRunStrategy,
  useSaveStrategy,
  useSavedStrategy,
  useTemplates,
  useValidateSpec,
  type T_EngineResult,
  type T_SavedStrategy,
  type T_SpecCheck,
} from "../api/client";
import {
  BLANK_SPEC,
  DEFAULT_HOLDING,
  DEFAULT_UNDERLYING_STOP,
  INTRADAY_TFS,
  TIMEFRAMES,
  WEEKDAYS,
  describeSpec,
  isDailyTf,
  isDirectional,
  isSwing,
  normalizeSpec,
  samplePayoff,
  type T_Combined,
  type T_Entry,
  type T_Holding,
  type T_Leg,
  type T_Rule,
  type T_Spec,
  type T_TF,
  type T_UnderlyingStop,
} from "../lib/spec";
import { backtestCrumb } from "../lib/nav";
import PageTitle from "../components/PageTitle";
import SectionCard from "../components/SectionCard";
import ConnectionGate from "../components/ConnectionGate";
import StrategyResults from "../components/StrategyResults";
import ConditionBuilder from "../components/builder/ConditionBuilder";
import LegsEditor from "../components/builder/LegsEditor";
import LevelInput from "../components/builder/LevelInput";
import SweepPanel from "../components/builder/SweepPanel";
import type { T_SweepParam } from "../api/client";

const { Text } = Typography;

// ---------- Constants ----------

const STEPS = [
  { key: "basics", title: "Basics & days" },
  { key: "entry", title: "Entry" },
  { key: "legs", title: "Legs" },
  { key: "exits", title: "Exits & risk" },
  { key: "costs", title: "Costs" },
];
const DTES = [0, 1, 2, 3, 4];
const PERIODS = [
  { value: 1, label: "1M" },
  { value: 3, label: "3M" },
  { value: 6, label: "6M" },
  { value: 12, label: "1Y" },
];

// ---------- Helpers ----------

const inr = (n: number) => `${n < 0 ? "−" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
const hm = (s: string) => dayjs(s, "HH:mm");

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div>
      <Text className="block text-[13px] font-medium mb-1">{label}</Text>
      {hint && <Text type="secondary" className="block text-xs mb-2">{hint}</Text>}
      {children}
    </div>
  );
}

function ChipSet({ all, value, onChange, render }: { all: number[]; value: number[] | null | undefined; onChange: (v: number[] | null) => void; render: (n: number) => string }) {
  const sel = value ?? all;
  return (
    <div className="flex flex-wrap gap-1.5">
      <Tag.CheckableTag checked={!value} onChange={() => onChange(null)} className="!m-0 !px-3 !py-1 !rounded-md !border !border-slate-200">All</Tag.CheckableTag>
      {all.map((n) => (
        <Tag.CheckableTag
          key={n}
          checked={!!value && sel.includes(n)}
          onChange={(c) => {
            const base = value ?? [];
            const next = c ? [...base, n].sort((a, b) => a - b) : base.filter((x) => x !== n);
            onChange(next.length && next.length < all.length ? next : null);
          }}
          className="!m-0 !px-3 !py-1 !rounded-md !border !border-slate-200"
        >
          {render(n)}
        </Tag.CheckableTag>
      ))}
    </div>
  );
}

// ---------- Steps ----------

type T_StepProps = { spec: T_Spec; set: (fn: (s: T_Spec) => T_Spec) => void };

function HoldingFields({ spec, set }: T_StepProps) {
  const h = spec.holding ?? DEFAULT_HOLDING;
  const swing = h.mode === "swing";
  const setH = (patch: Partial<T_Holding>) => set((s) => ({ ...s, holding: { ...DEFAULT_HOLDING, ...s.holding, ...patch } }));
  return (
    <div className="space-y-4">
      <Field label="Holding" hint={swing ? "Positions are held across days and closed at the exit time on the last day, or earlier by any exit rule." : "Every position is closed by the square-off time on its trade day."}>
        <Segmented value={h.mode} onChange={(v) => setH({ mode: v as T_Holding["mode"] })}
          options={[{ value: "intraday", label: "Intraday" }, { value: "swing", label: "Multi-day (swing)" }]} />
      </Field>
      {swing && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <Field label="Max days held" hint="Trading days, entry day = 1.">
              <InputNumber min={1} max={30} value={h.max_days} onChange={(v) => v && setH({ max_days: v })} />
            </Field>
            <Field label="Exit time, last day" hint="Close on the final day at this time.">
              <TimePicker format="HH:mm" value={hm(h.exit_time)} allowClear={false} onChange={(t) => t && setH({ exit_time: t.format("HH:mm") })} />
            </Field>
            <Field label="Close before expiry" hint="Option legs exit this many trading days before expiry (0 = may hold into expiry day).">
              <InputNumber min={0} max={10} value={h.exit_before_expiry} addonAfter="days" onChange={(v) => setH({ exit_before_expiry: v ?? 0 })} />
            </Field>
            <Field label="Check exits every" hint="Target / stop checked at each candle close; the underlying stop every minute.">
              <Select className="!w-24" value={h.check} options={INTRADAY_TFS.map((t) => ({ value: t, label: t }))} onChange={(check: T_TF) => setH({ check })} />
            </Field>
          </div>
          <Alert type="info" showIcon className="!text-xs"
            message="Overnight positions must have defined risk: short options need a long option of the same type, futures need a stop. Pick leg expiries that outlive the holding period (Legs → min. days out). Exits are checked at each 'check exits every' candle close on every day held; the underlying stop every minute (an overnight gap fills at the open)." />
        </>
      )}
    </div>
  );
}

function BasicsStep({ spec, set }: T_StepProps) {
  const daily = isDailyTf(spec.timeframe);
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Field label="Underlying">
          <Segmented value={spec.underlying} options={["NIFTY", "SENSEX"]} onChange={(v) => set((s) => ({ ...s, underlying: v as T_Spec["underlying"] }))} />
        </Field>
        <Field label="Signal timeframe" hint={daily ? "Daily / weekly candles are known only after the 15:30 close: signal entries on them need multi-day holding (below)." : "Candles that entry/exit conditions are checked on."}>
          <Select className="!w-32" value={spec.timeframe} options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} onChange={(timeframe) => set((s) => ({ ...s, timeframe }))} />
        </Field>
        <Field label="Base lots" hint="Every leg's lots are multiplied by this.">
          <InputNumber min={1} max={100} value={spec.lots} onChange={(v) => v && set((s) => ({ ...s, lots: v }))} />
        </Field>
        <Field label="Lot size" hint="Exchange lot size on each date (NIFTY 75 → 65, SENSEX 20), or a fixed one.">
          <div className="flex items-center gap-3">
            <Switch checked={spec.lot_size == null} onChange={(c) => set((s) => ({ ...s, lot_size: c ? null : s.underlying === "NIFTY" ? 65 : 20 }))} />
            <Text className="text-xs">{spec.lot_size == null ? "Exchange lot size by date" : "Fixed"}</Text>
            {spec.lot_size != null && <InputNumber min={1} value={spec.lot_size} onChange={(v) => v && set((s) => ({ ...s, lot_size: v }))} />}
          </div>
        </Field>
      </div>
      <Divider className="!my-2" />
      <HoldingFields spec={spec} set={set} />
      <Divider className="!my-2" />
      <Field label="Weekdays">
        <ChipSet all={[0, 1, 2, 3, 4]} value={spec.schedule.weekdays} render={(d) => WEEKDAYS[d]} onChange={(weekdays) => set((s) => ({ ...s, schedule: { ...s.schedule, weekdays } }))} />
      </Field>
      <Field label="Days to expiry" hint="Trading days to the nearest weekly expiry on the trade day. 0DTE = expiry day.">
        <ChipSet all={DTES} value={spec.schedule.dte} render={(d) => `${d}DTE`} onChange={(dte) => set((s) => ({ ...s, schedule: { ...s.schedule, dte } }))} />
      </Field>
      <Field label="Description">
        <Input.TextArea rows={2} value={spec.description} placeholder="Optional notes" onChange={(e) => set((s) => ({ ...s, description: e.target.value }))} />
      </Field>
    </div>
  );
}

// Starting conditions. Time entries read the latest closed candle, so levels (not crosses) fit them.
const COND = {
  emaUp: (): T_Rule => ({ left: { ind: "ema", params: { period: 9 } }, op: "crosses_above", right: { ind: "ema", params: { period: 21 } } }),
  emaDown: (): T_Rule => ({ left: { ind: "ema", params: { period: 9 } }, op: "crosses_below", right: { ind: "ema", params: { period: 21 } } }),
  aboveEma: (): T_Rule => ({ left: { ind: "price", field: "close" }, op: ">", right: { ind: "ema", params: { period: 20 } } }),
  belowEma: (): T_Rule => ({ left: { ind: "price", field: "close" }, op: "<", right: { ind: "ema", params: { period: 20 } } }),
  calmVix: (): T_Rule => ({ left: { ind: "price", field: "close", params: { symbol: "VIX" }, tf: "1d" }, op: "<", right: { ind: "value", params: { value: 18 } } }),
};

const addMinutes = (t: string, m: number) => {
  const x = hm(t).add(m, "minute");
  return x.isAfter(hm("15:00")) ? "15:00" : x.format("HH:mm");
};

function EntryTimes({ spec, set }: T_StepProps) {
  const e = spec.schedule.entry;
  const times = e.times?.length ? e.times : null;
  const maxTrades = spec.schedule.max_trades_per_day;
  const setTimes = (next: string[]) =>
    set((s) => {
      const uniq = [...new Set(next)].sort();
      const entry = { ...s.schedule.entry, ...(uniq.length > 1 ? { times: uniq, time: uniq[0] } : { times: null, time: uniq[0] ?? s.schedule.entry.time }) };
      return { ...s, schedule: { ...s.schedule, entry, max_trades_per_day: Math.max(s.schedule.max_trades_per_day, uniq.length) } };
    });
  const list = times ?? [e.time];
  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        {list.map((t, i) => (
          <span key={`${t}-${i}`} className="flex items-center gap-0.5">
            <TimePicker format="HH:mm" value={hm(t)} allowClear={false} className="!w-24"
              onChange={(v) => v && setTimes(list.map((x, j) => (j === i ? v.format("HH:mm") : x)))} />
            {list.length > 1 && <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={() => setTimes(list.filter((_, j) => j !== i))} />}
          </span>
        ))}
        <Tooltip title={e.prev_day ? "Not available with a previous-day entry" : "Try another entry later in the day"}>
          <Button size="small" icon={<PlusOutlined />} disabled={!!e.prev_day || list.length >= 20}
            onClick={() => setTimes([...list, addMinutes(list[list.length - 1], 90)])}>Add time</Button>
        </Tooltip>
      </div>
      {times && (
        <Text type={times.length > maxTrades ? "warning" : "secondary"} className="block text-xs">
          Each time is tried in order, one position at a time (a time is skipped while a trade is still open).
          {times.length > maxTrades ? ` Max trades a day is ${maxTrades}: raise it to at least ${times.length} to use every time.` : ""}
        </Text>
      )}
    </div>
  );
}

function EntryStep({ spec, set }: T_StepProps) {
  const e = spec.schedule.entry;
  const directional = isDirectional(spec);
  const swing = isSwing(spec);
  const dailySignal = e.type === "signal" && isDailyTf(spec.timeframe);
  const multi = (e.times?.length ?? 0) > 1;
  const setEntry = (patch: Partial<T_Entry>) => set((s) => ({ ...s, schedule: { ...s.schedule, entry: { ...s.schedule.entry, ...patch } } }));
  const toDirectional = (on: boolean) =>
    set((s) => {
      const en = s.schedule.entry;
      if (on) {
        const time = en.type === "time";
        // Signal: the neutral condition becomes the bullish one, bearish starts as the EMA 9/21 cross-down.
        // Time: levels read at the entry time (close above / below EMA 20).
        const bullish = (time ? null : en.signal) ?? { all: [time ? COND.aboveEma() : COND.emaUp()] };
        const bearish = { all: [time ? COND.belowEma() : COND.emaDown()] };
        return {
          ...s,
          schedule: { ...s.schedule, entry: { ...en, signal: null, bullish, bearish } },
          position: { legs: null, bullish: s.position.legs ?? s.position.bullish ?? [], bearish: null, bearish_mirror: true },
        };
      }
      return {
        ...s,
        schedule: { ...s.schedule, entry: { ...en, signal: en.type === "signal" ? en.bullish ?? null : null, bullish: null, bearish: null } },
        position: { legs: s.position.bullish ?? s.position.legs ?? [], bullish: null, bearish: null, bearish_mirror: false },
      };
    });
  const maxTrades = (
    <Field label="Max trades a day">
      <InputNumber min={1} max={50} value={spec.schedule.max_trades_per_day} onChange={(v) => v && set((s) => ({ ...s, schedule: { ...s.schedule, max_trades_per_day: v } }))} />
    </Field>
  );
  const readAt = e.type === "time" ? `Read on the latest closed ${spec.timeframe} candle at each entry time.` : `Checked at every ${spec.timeframe} candle close; entry at the next minute's open.`;

  return (
    <div className="space-y-6">
      <Field label="Enter">
        <Segmented
          value={e.type}
          options={[{ value: "time", label: "At a fixed time" }, { value: "signal", label: "On an indicator signal" }]}
          onChange={(v) => {
            const type = v as "time" | "signal";
            if (directional) {
              // Crosses suit signals, levels suit fixed times: restart the directional conditions for the new type.
              const time = type === "time";
              setEntry({ type, prev_day: false, bullish: { all: [time ? COND.aboveEma() : COND.emaUp()] }, bearish: { all: [time ? COND.belowEma() : COND.emaDown()] } });
            } else setEntry({ type, prev_day: false, signal: type === "signal" ? e.signal ?? { all: [COND.emaUp()] } : null });
          }}
        />
      </Field>
      {e.type === "time" ? (
        <>
          <Field label={multi ? "Entry times" : "Entry time"} hint="Add several times to trade more than once a day (e.g. 09:20, 11:00, 13:30).">
            <EntryTimes spec={spec} set={set} />
          </Field>
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            <Field label="Previous trading day" hint="Enter near the previous close and hold overnight into the trade day.">
              <Tooltip title={multi ? "Not available with several entry times" : undefined}>
                <Switch checked={!!e.prev_day} disabled={multi} onChange={(prev_day) => setEntry({ prev_day })} />
              </Tooltip>
            </Field>
            <Field label="Re-enter after a stop" hint="Open a fresh position (new ATM) after a stop-loss, up to this many times a day.">
              <InputNumber min={0} max={10} value={spec.schedule.reentry_after_stop}
                onChange={(v) => set((s) => ({ ...s, schedule: { ...s.schedule, reentry_after_stop: v ?? 0, max_trades_per_day: Math.max(s.schedule.max_trades_per_day, (v ?? 0) + 1) } }))} />
            </Field>
            {maxTrades}
          </div>
          <Field label="Only trade when" hint={`Optional filter, ${readAt.toLowerCase()} A day (or time) where it's false is skipped.`}>
            <ConditionBuilder value={e.filter} tf={spec.timeframe} onChange={(filter) => setEntry({ filter })} initial={COND.calmVix}
              addLabel="Add filter" emptyHint="e.g. India VIX below 18, a regime, a weekday or days to expiry." />
          </Field>
          <Field label="Direction">
            <Segmented
              value={directional ? "dir" : "neutral"}
              onChange={(v) => toDirectional(v === "dir")}
              options={[{ value: "neutral", label: "Same legs every time" }, { value: "dir", label: "Bullish / bearish (choose legs at entry)" }]}
            />
          </Field>
          {directional && (
            <>
              <Field label="▲ Bullish legs when" hint={`${readAt} No trade when neither side holds.`}>
                <ConditionBuilder value={e.bullish} tf={spec.timeframe} onChange={(bullish) => setEntry({ bullish })} initial={COND.aboveEma} />
              </Field>
              <Field label="▼ Bearish legs when">
                <ConditionBuilder value={e.bearish} tf={spec.timeframe} onChange={(bearish) => setEntry({ bearish })} initial={COND.belowEma} emptyHint="Leave empty to trade bullish days only." />
              </Field>
            </>
          )}
        </>
      ) : (
        <div className="space-y-5">
          {dailySignal && !swing && (
            <Alert type="warning" showIcon message={`${spec.timeframe} candles are known after the close, so a signal on them can only be traded the next day: set Holding to Multi-day in Basics.`} />
          )}
          <Field label="Direction">
            <Segmented
              value={directional ? "dir" : "neutral"}
              onChange={(v) => toDirectional(v === "dir")}
              options={[{ value: "neutral", label: "One condition, same legs" }, { value: "dir", label: "Bullish / bearish (different legs)" }]}
            />
          </Field>
          {directional ? (
            <>
              <Field label="▲ Bullish when" hint={readAt}>
                <ConditionBuilder value={e.bullish} tf={spec.timeframe} onChange={(bullish) => setEntry({ bullish })} initial={COND.emaUp} />
              </Field>
              <Field label="▼ Bearish when">
                <ConditionBuilder value={e.bearish} tf={spec.timeframe} onChange={(bearish) => setEntry({ bearish })} initial={COND.emaDown} emptyHint="Leave empty to trade bullish signals only." />
              </Field>
            </>
          ) : (
            <Field label="Enter when" hint={readAt}>
              <ConditionBuilder value={e.signal} tf={spec.timeframe} onChange={(signal) => setEntry({ signal })} />
            </Field>
          )}
          <div className="grid grid-cols-2 md:grid-cols-3 gap-6">
            {dailySignal && swing ? (
              <Field label="Enter next day at" hint={`A ${spec.timeframe} signal is known at 15:30; the trade opens on the next trading day at this time.`}>
                <TimePicker format="HH:mm" value={hm(e.next_day_time ?? "09:20")} allowClear={false} onChange={(t) => t && setEntry({ next_day_time: t.format("HH:mm") })} />
              </Field>
            ) : (
              <>
                <Field label="From">
                  <TimePicker format="HH:mm" value={hm(e.window_start)} allowClear={false} onChange={(t) => t && setEntry({ window_start: t.format("HH:mm") })} />
                </Field>
                <Field label="No new entries after">
                  <TimePicker format="HH:mm" value={hm(e.last_entry)} allowClear={false} onChange={(t) => t && setEntry({ last_entry: t.format("HH:mm") })} />
                </Field>
              </>
            )}
            {maxTrades}
          </div>
        </div>
      )}
    </div>
  );
}

function LegsStep({ spec, set }: T_StepProps) {
  const setPos = (patch: Partial<T_Spec["position"]>) => set((s) => ({ ...s, position: { ...s.position, ...patch } }));
  const swing = isSwing(spec);
  if (!isDirectional(spec)) {
    return <LegsEditor legs={spec.position.legs ?? []} swing={swing} onChange={(legs) => setPos({ legs })} />;
  }
  return (
    <Tabs
      items={[
        { key: "bull", label: "▲ Bullish legs", children: <LegsEditor legs={spec.position.bullish ?? []} swing={swing} onChange={(bullish) => setPos({ bullish })} /> },
        {
          key: "bear",
          label: "▼ Bearish legs",
          children: (
            <div className="space-y-4">
              <div className="flex items-center gap-3">
                <Switch checked={!!spec.position.bearish_mirror} onChange={(m) => setPos({ bearish_mirror: m, bearish: m ? null : structuredClone(spec.position.bullish ?? []) })} />
                <Text className="text-[13px]">Mirror the bullish legs (calls ↔ puts, strike offsets flipped)</Text>
              </div>
              {!spec.position.bearish_mirror && <LegsEditor legs={spec.position.bearish ?? []} swing={swing} onChange={(bearish) => setPos({ bearish })} />}
            </div>
          ),
        },
      ]}
    />
  );
}

function CombinedLevels({ value, onChange }: { value: T_Combined; onChange: (c: T_Combined) => void }) {
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
      <Field label="Target"><LevelInput value={value.target} defaultValue={50} onChange={(target) => onChange({ ...value, target })} /></Field>
      <Field label="Stop-loss"><LevelInput value={value.stop} defaultValue={30} onChange={(stop) => onChange({ ...value, stop })} /></Field>
    </div>
  );
}

function ExitsStep({ spec, set }: T_StepProps) {
  const x = spec.exits;
  const setX = (patch: Partial<T_Spec["exits"]>) => set((s) => ({ ...s, exits: { ...s.exits, ...patch } }));
  const overrides = Object.entries(x.dte_overrides ?? {});
  const free = DTES.filter((d) => !(String(d) in (x.dte_overrides ?? {})));
  const swing = isSwing(spec);
  const h = spec.holding ?? DEFAULT_HOLDING;
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        {swing ? (
          <Field label="Check exits" hint="Multi-day holding checks targets and stops at each candle close of the timeframe set in Basics → Holding.">
            <Text className="text-[13px]">At each {h.check} close</Text>
          </Field>
        ) : (
          <Field label="Check exits" hint="Every minute uses highs/lows (targets fill as limit orders, stops with slippage); candle close checks only at closes.">
            <div className="flex items-center gap-2">
              <Segmented value={x.evaluation.mode} onChange={(mode) => setX({ evaluation: { ...x.evaluation, mode: mode as "intrabar" | "close" } })}
                options={[{ value: "intrabar", label: "Every minute" }, { value: "close", label: "At candle close" }]} />
              {x.evaluation.mode === "close" && (
                <Select className="!w-20" value={x.evaluation.every} options={INTRADAY_TFS.map((t) => ({ value: t, label: t }))} onChange={(every: T_TF) => setX({ evaluation: { ...x.evaluation, every } })} />
              )}
            </div>
          </Field>
        )}
        <Field label="Levels apply to" hint="P&L before costs, or after brokerage, taxes and slippage.">
          <Segmented value={x.pnl_basis} onChange={(v) => setX({ pnl_basis: v as "gross" | "net" })} options={[{ value: "gross", label: "Before costs" }, { value: "net", label: "After costs" }]} />
        </Field>
      </div>

      <Divider orientation="left" orientationMargin={0} className="!my-1"><Text className="text-xs uppercase tracking-wider !text-slate-400">Whole position</Text></Divider>
      <CombinedLevels value={x.combined} onChange={(combined) => setX({ combined })} />
      <Field label="Trailing stop" hint="Once P&L reaches the activation level, exit if it falls this far below its peak.">
        <div className="flex flex-wrap items-center gap-4">
          <Switch checked={!!x.combined.trailing} onChange={(c) => setX({ combined: { ...x.combined, trailing: c ? { activate: { unit: "pct", value: 30 }, trail: { unit: "pct", value: 15 } } : null } })} />
          {x.combined.trailing && (
            <>
              <span className="flex items-center gap-2"><Text className="text-xs">activate at</Text><LevelInput allowOff={false} value={x.combined.trailing.activate} onChange={(v) => v && setX({ combined: { ...x.combined, trailing: { ...x.combined.trailing!, activate: v } } })} /></span>
              <span className="flex items-center gap-2"><Text className="text-xs">trail by</Text><LevelInput allowOff={false} value={x.combined.trailing.trail} onChange={(v) => v && setX({ combined: { ...x.combined, trailing: { ...x.combined.trailing!, trail: v } } })} /></span>
            </>
          )}
        </div>
      </Field>

      <Field label="Different levels by days to expiry" hint="Replace the whole-position target / stop on chosen DTEs (e.g. 0DTE target 50%, 1DTE 20%).">
        <div className="space-y-2">
          {overrides.map(([dte, lv]) => (
            <div key={dte} className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 p-3">
              <Tag color={dte === "0" ? "gold" : "blue"}>{dte}DTE</Tag>
              <CombinedLevels value={lv} onChange={(c) => setX({ dte_overrides: { ...x.dte_overrides, [dte]: c } })} />
              <Button size="small" type="text" danger icon={<DeleteOutlined />} className="ml-auto"
                onClick={() => setX({ dte_overrides: Object.fromEntries(overrides.filter(([d]) => d !== dte)) })} />
            </div>
          ))}
          {free.length > 0 && (
            <Select placeholder={<span><PlusOutlined /> Add a DTE</span>} className="!w-40" value={null as unknown as number}
              options={free.map((d) => ({ value: d, label: `${d}DTE` }))}
              onChange={(d: number) => setX({ dte_overrides: { ...x.dte_overrides, [String(d)]: { ...x.combined, trailing: null } } })} />
          )}
        </div>
      </Field>

      <Divider orientation="left" orientationMargin={0} className="!my-1"><Text className="text-xs uppercase tracking-wider !text-slate-400">Each leg</Text></Divider>
      <div className="flex items-center gap-3">
        <Switch checked={!!x.per_leg} onChange={(c) => setX({ per_leg: c ? { target: null, stop: { unit: "pct", value: 25 }, on_stop: "keep_others" } : null })} />
        <Text className="text-[13px]">Per-leg target / stop (% of each leg's own premium)</Text>
      </div>
      {x.per_leg && (
        <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
          <Field label="Leg target"><LevelInput value={x.per_leg.target} defaultValue={50} onChange={(target) => setX({ per_leg: { ...x.per_leg!, target } })} /></Field>
          <Field label="Leg stop-loss"><LevelInput value={x.per_leg.stop} defaultValue={25} onChange={(stop) => setX({ per_leg: { ...x.per_leg!, stop } })} /></Field>
          <Field label="After a leg stop">
            <Select className="w-full" value={x.per_leg.on_stop} onChange={(on_stop) => setX({ per_leg: { ...x.per_leg!, on_stop } })}
              options={[{ value: "keep_others", label: "Keep other legs" }, { value: "exit_all", label: "Exit everything" }, { value: "others_to_cost", label: "Move other stops to cost" }]} />
          </Field>
        </div>
      )}

      <Divider orientation="left" orientationMargin={0} className="!my-1"><Text className="text-xs uppercase tracking-wider !text-slate-400">Other exits & risk</Text></Divider>
      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        {swing ? (
          <Field label="Square-off time" hint="Not used for multi-day holding: trades are held across days.">
            <Text className="text-[13px]">Closed at {h.exit_time} on day {h.max_days} (Basics → Holding)</Text>
          </Field>
        ) : (
          <Field label="Square-off time">
            <TimePicker format="HH:mm" value={hm(x.square_off)} allowClear={false} onChange={(t) => t && setX({ square_off: t.format("HH:mm") })} />
          </Field>
        )}
        <Field label="Exit if spot moves" hint="Points from the entry spot, either way.">
          <InputNumber min={1} placeholder="off" value={x.spot_move_points ?? undefined} addonAfter="pts" onChange={(v) => setX({ spot_move_points: v || null })} />
        </Field>
        <Field label="Max loss per day" hint="No new entries once the day's realised loss reaches this.">
          <InputNumber min={1} placeholder="off" value={spec.risk.max_loss_per_day ?? undefined} addonBefore="₹" onChange={(v) => set((s) => ({ ...s, risk: { max_loss_per_day: v || null } }))} />
        </Field>
      </div>
      {isDirectional(spec) && (
        <div className="flex items-center gap-3">
          <Switch checked={!!x.exit_on_opposite_signal} onChange={(c) => setX({ exit_on_opposite_signal: c })} />
          <Text className="text-[13px]">Exit when the opposite signal fires</Text>
        </div>
      )}
      <Field label="Exit when" hint="Optional indicator exit, checked at candle closes.">
        <ConditionBuilder value={x.exit_signal} tf={spec.timeframe} onChange={(exit_signal) => setX({ exit_signal })} />
      </Field>

      <Divider orientation="left" orientationMargin={0} className="!my-1"><Text className="text-xs uppercase tracking-wider !text-slate-400">Underlying stop</Text></Divider>
      <UnderlyingStopFields value={x.underlying_stop ?? null} onChange={(underlying_stop) => setX({ underlying_stop })} swing={swing} />
    </div>
  );
}

function UnderlyingStopFields({ value, onChange, swing }: { value: T_UnderlyingStop | null; onChange: (v: T_UnderlyingStop | null) => void; swing: boolean }) {
  const byPoints = value?.points != null;
  const set = (patch: Partial<T_UnderlyingStop>) => value && onChange({ ...value, ...patch });
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <Switch checked={!!value} onChange={(c) => onChange(c ? { ...DEFAULT_UNDERLYING_STOP } : null)} />
        <Text className="text-[13px]">Stop on the index moving against the trade (directional: against its direction; neutral: either way)</Text>
      </div>
      {value && (
        <>
          <div className="grid grid-cols-2 md:grid-cols-4 gap-6">
            <Field label="Distance in">
              <Segmented value={byPoints ? "points" : "atr"}
                onChange={(v) => onChange(v === "points" ? { ...value, points: 100, atr_mult: null } : { ...value, points: null, atr_mult: 2 })}
                options={[{ value: "atr", label: "ATR" }, { value: "points", label: "Points" }]} />
            </Field>
            {byPoints ? (
              <Field label="Stop distance">
                <InputNumber min={1} value={value.points ?? undefined} addonAfter="pts" onChange={(v) => v && set({ points: v })} />
              </Field>
            ) : (
              <>
                <Field label="Stop distance" hint="Multiple of ATR at entry.">
                  <InputNumber min={0.1} step={0.25} value={value.atr_mult ?? 2} addonAfter="× ATR" onChange={(v) => v && set({ atr_mult: v })} />
                </Field>
                <Field label="ATR">
                  <div className="flex items-center gap-2">
                    <InputNumber min={2} max={100} className="!w-20" value={value.atr_period} onChange={(v) => v && set({ atr_period: v })} />
                    <Select className="!w-20" value={value.tf} options={TIMEFRAMES.map((t) => ({ value: t, label: t }))} onChange={(tf: T_TF) => set({ tf })} />
                  </div>
                </Field>
              </>
            )}
            <Field label="Take profit at" hint={byPoints ? "Optional, × the stop distance." : "Optional, in ATRs."}>
              <InputNumber min={0.1} step={0.5} placeholder="off" value={value.target_mult ?? undefined} addonAfter={byPoints ? "× pts" : "× ATR"}
                onChange={(v) => set({ target_mult: v || null })} />
            </Field>
          </div>
          <div className="flex items-center gap-3">
            <Switch size="small" checked={value.trail} onChange={(trail) => set({ trail })} />
            <Text className="text-[13px]">Trail it from the best index price since entry</Text>
          </div>
          <Text type="secondary" className="block text-xs">
            Checked every minute on the index; the exit fills at the next minute's open.
            {!swing && " Multi-day holding only: intraday strategies use the spot-move exit instead (Checks will flag it)."}
          </Text>
        </>
      )}
    </div>
  );
}

function CostsStep({ spec, set }: T_StepProps) {
  const c = spec.costs;
  const setC = (patch: Partial<T_Spec["costs"]>) => set((s) => ({ ...s, costs: { ...s.costs, ...patch } }));
  return (
    <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
      <Field label="Brokerage per order"><InputNumber min={0} value={c.brokerage_per_order} addonBefore="₹" onChange={(v) => setC({ brokerage_per_order: v ?? 0 })} /></Field>
      <Field label="Slippage per option leg" hint="Market orders, each side."><InputNumber min={0} step={0.25} value={c.slippage_points} addonAfter="pts" onChange={(v) => setC({ slippage_points: v ?? 0 })} /></Field>
      <Field label="Slippage per futures fill" hint="Futures legs, each side."><InputNumber min={0} step={0.25} value={c.fut_slippage_points ?? 1} addonAfter="pts" onChange={(v) => setC({ fut_slippage_points: v ?? 0 })} /></Field>
      <Field label="Taxes & exchange charges" hint="STT (by date), NSE/BSE charges, SEBI fee, stamp duty, GST.">
        <Switch checked={c.taxes} onChange={(taxes) => setC({ taxes })} />
      </Field>
    </div>
  );
}

// ---------- Side panel ----------

function Payoff({ spec }: { spec: T_Spec }) {
  const p = useMemo(() => {
    const legs: T_Leg[] = (isDirectional(spec) ? spec.position.bullish : spec.position.legs) ?? [];
    return legs.length ? samplePayoff(spec, legs) : null;
  }, [spec]);
  if (!p) return <Text type="secondary" className="text-xs">Add legs to see the payoff.</Text>;
  const unlimitedUp = p.points[p.points.length - 1].pnl < p.points[p.points.length - 2].pnl - 1 && p.points[p.points.length - 1].pnl < 0;
  return (
    <div>
      <div className="h-36">
        <ResponsiveContainer>
          <AreaChart data={p.points} margin={{ top: 4, right: 4, bottom: 0, left: 0 }}>
            <defs>
              <linearGradient id="pay" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stopColor="#4F46E5" stopOpacity={0.25} />
                <stop offset="100%" stopColor="#4F46E5" stopOpacity={0.02} />
              </linearGradient>
            </defs>
            <CartesianGrid stroke="#F1F5F9" vertical={false} />
            <XAxis dataKey="spot" tick={{ fontSize: 10, fill: "#94A3B8" }} stroke="#F1F5F9" minTickGap={30} />
            <YAxis tickFormatter={(v) => `${Math.round(v / 1000)}K`} tick={{ fontSize: 10, fill: "#94A3B8" }} stroke="#F1F5F9" width={36} />
            <ReferenceLine y={0} stroke="#94A3B8" />
            <ReferenceLine x={p.spot} stroke="#CBD5E1" strokeDasharray="3 3" />
            <ChartTooltip formatter={(v) => [inr(Number(v)), "P&L at expiry"]} labelFormatter={(x) => `Spot ${Number(x).toLocaleString("en-IN")}`} />
            <Area dataKey="pnl" stroke="#4F46E5" strokeWidth={2} fill="url(#pay)" isAnimationActive={false} />
          </AreaChart>
        </ResponsiveContainer>
      </div>
      <div className="flex justify-between mt-1">
        <Text type="secondary" className="text-xs">Max profit <b className="text-emerald-600">{inr(p.maxProfit)}</b></Text>
        <Text type="secondary" className="text-xs">Max loss <b className="text-red-500">{unlimitedUp ? "unlimited" : inr(p.maxLoss)}</b></Text>
      </div>
      <Text type="secondary" className="block text-[11px] mt-1">
        Illustrative: expiry payoff at {spec.underlying} {p.spot.toLocaleString("en-IN")} with Black-Scholes prices (12% IV, 3 days). {isDirectional(spec) ? "Bullish legs shown." : ""}
      </Text>
    </div>
  );
}

function Checks({ check, pending }: { check: T_SpecCheck | undefined; pending: boolean }) {
  if (!check) return <Skeleton active paragraph={{ rows: 1 }} />;
  return (
    <div className="space-y-2">
      {check.errors.map((e, i) => (
        <div key={i} className="flex gap-2 text-[13px]"><CloseCircleFilled className="text-red-500 mt-0.5" /><span>{e.path ? <code className="text-xs text-slate-500">{e.path}</code> : null} {e.message}</span></div>
      ))}
      {check.warnings.map((w, i) => (
        <div key={i} className="flex gap-2 text-[13px]"><WarningFilled className="text-amber-500 mt-0.5" /><span>{w}</span></div>
      ))}
      {check.ok && !check.warnings.length && (
        <div className="flex gap-2 text-[13px]"><CheckCircleFilled className="text-emerald-500 mt-0.5" /><span>Ready to backtest</span></div>
      )}
      {pending && <Text type="secondary" className="text-xs">Checking…</Text>}
    </div>
  );
}

// ---------- Editor ----------

function Editor({ initial, saved, templateId, runResult }: { initial: T_Spec; saved: T_SavedStrategy | null; templateId: string | null; runResult: T_EngineResult | null }) {
  const { message } = App.useApp();
  const [search, setSearch] = useSearchParams();
  const runId = search.get("run");
  const [spec, setSpec] = useState<T_Spec>(initial);
  const [baseline, setBaseline] = useState(JSON.stringify(initial));
  const [step, setStep] = useState(0);
  const [range, setRange] = useState<[Dayjs, Dayjs]>(() =>
    runResult ? [dayjs(runResult.params.from_date), dayjs(runResult.params.to_date)] : [dayjs().subtract(3, "month"), dayjs().subtract(1, "day")]);
  const validate = useValidateSpec();
  const save = useSaveStrategy();
  const run = useRunStrategy();
  const [jobId, setJobId] = useState<string | null>(null);
  const job = useJob<T_EngineResult>(jobId);
  const resultsRef = useRef<HTMLDivElement>(null);
  const dirty = JSON.stringify(spec) !== baseline;
  const set = (fn: (s: T_Spec) => T_Spec) => setSpec((s) => fn(s));
  const from = range[0].format("YYYY-MM-DD");
  const to = range[1].format("YYYY-MM-DD");
  const dataCheck = useDataCheck(spec.underlying, from, to);

  // Validate on the server shortly after each change.
  useEffect(() => {
    const t = setTimeout(() => validate.mutate(spec), 350);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec]);

  const jobResult = job.data?.status === "done" ? job.data.result : null;
  useEffect(() => {
    if (jobResult?.run_id && jobResult.run_id !== runId) {
      setSearch((p) => { const n = new URLSearchParams(p); n.set("run", jobResult.run_id!); return n; }, { replace: true });
      setTimeout(() => resultsRef.current?.scrollIntoView({ behavior: "smooth", block: "start" }), 200);
    }
  }, [jobResult, runId, setSearch]);
  const result = jobResult ?? runResult;
  const running = run.isPending || job.data?.status === "running";

  const doSave = (asNew = false) =>
    save.mutate({ id: asNew ? null : saved?.id, spec: asNew ? { ...spec, name: `${spec.name} (copy)` } : spec, template: templateId }, {
      onSuccess: (doc) => {
        setBaseline(JSON.stringify(asNew ? spec : doc.spec));
        if (asNew) setSpec(doc.spec);
        setSearch((p) => { const n = new URLSearchParams(p); n.set("strategy", doc.id); n.delete("template"); return n; }, { replace: true });
        message.success(asNew ? "Saved as a new strategy" : `Saved (version ${doc.version})`);
      },
      onError: (e) => message.error(errorMessage(e)),
    });
  const doRun = () =>
    run.mutate({ spec, from_date: from, to_date: to, strategy_id: saved?.id }, { onSuccess: (r) => setJobId(r.job_id), onError: (e) => message.error(errorMessage(e)) });

  const StepBody = [BasicsStep, EntryStep, LegsStep, ExitsStep, CostsStep][step];

  // Put swept values into the spec (dotted paths, e.g. exits.combined.target.value).
  const applySweep = (params: T_SweepParam[], values: (number | string)[]) => {
    set((s) => {
      const next = structuredClone(s) as unknown as Record<string, unknown>;
      params.forEach((p, i) => {
        const keys = p.path.split(".");
        let node = next as Record<string, unknown>;
        for (let k = 0; k < keys.length - 1; k++) {
          if (node[keys[k]] == null) node[keys[k]] = {}; // e.g. a target that was switched off
          node = node[keys[k]] as Record<string, unknown>;
        }
        const last = keys[keys.length - 1];
        if (last === "value" && node.unit === undefined) node.unit = "pct";
        node[last] = values[i];
      });
      return next as unknown as T_Spec;
    });
    message.success(`Applied ${params.map((p, i) => `${p.label} ${values[i]}`).join(", ")}. Run the backtest to see it.`);
    window.scrollTo({ top: 0, behavior: "smooth" });
  };
  const check = validate.data;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-center gap-3 justify-between">
        <div className="flex items-center gap-3 min-w-0 flex-1">
          <Input variant="borderless" className="!text-[20px] !font-semibold !px-0 max-w-xl" value={spec.name} onChange={(e) => set((s) => ({ ...s, name: e.target.value }))} />
          <Tag color="blue">{spec.underlying}</Tag>
          {saved ? <Tag>v{saved.version}{dirty ? " · edited" : ""}</Tag> : <Tag color="gold">Not saved</Tag>}
        </div>
        <div className="flex gap-2">
          {saved && <Button icon={<CopyOutlined />} onClick={() => doSave(true)}>Save as new</Button>}
          <Button icon={<SaveOutlined />} loading={save.isPending} disabled={!!saved && !dirty} onClick={() => doSave(false)}>{saved ? "Save" : "Save strategy"}</Button>
          <Button type="primary" icon={<PlayCircleOutlined />} loading={running} disabled={!check?.ok} onClick={doRun}>Run backtest</Button>
        </div>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-[1fr_380px] gap-6 items-start">
        <div className="bg-white rounded-2xl border border-slate-200/70 shadow-sm min-w-0">
          <div className="px-6 pt-5 overflow-x-auto">
            <Steps size="small" current={step} onChange={setStep} items={STEPS.map((s) => ({ title: s.title }))} />
          </div>
          <Divider className="!my-4" />
          <div className="px-6 pb-6"><StepBody spec={spec} set={set} /></div>
          <div className="flex justify-between border-t border-slate-100 px-6 py-3">
            <Button disabled={step === 0} onClick={() => setStep(step - 1)}>Back</Button>
            {step < STEPS.length - 1 ? <Button type="primary" ghost onClick={() => setStep(step + 1)}>Next: {STEPS[step + 1].title}</Button>
              : <Button type="primary" icon={<PlayCircleOutlined />} disabled={!check?.ok} loading={running} onClick={doRun}>Run backtest</Button>}
          </div>
        </div>

        <div className="space-y-4 xl:sticky xl:top-20">
          <SectionCard title="In plain English" description="What this strategy will do.">
            <ul className="space-y-1.5 text-[13px] text-slate-700 list-none pl-0">
              {describeSpec(spec).map((line, i) => <li key={i}>{line}</li>)}
            </ul>
          </SectionCard>
          <SectionCard title="Payoff" description="Shape of the position at entry.">
            <Payoff spec={spec} />
          </SectionCard>
          <SectionCard title="Checks" description="Problems to fix before running.">
            <Checks check={check} pending={validate.isPending} />
          </SectionCard>
          <SectionCard title="Backtest period" description="Uses the local data store; anything missing is fetched from Breeze.">
            <div className="space-y-3">
              <Segmented block options={PERIODS} value={null as unknown as number}
                onChange={(m) => setRange([dayjs().subtract(Number(m), "month"), dayjs().subtract(1, "day")])} />
              <DatePicker.RangePicker className="w-full" value={range} allowClear={false} disabledDate={(d) => d.isAfter(dayjs(), "day")} onChange={(r) => r && setRange(r as [Dayjs, Dayjs])} />
              {dataCheck.data && (
                <Text type="secondary" className="text-xs block">
                  {dataCheck.data.option_days} of {dataCheck.data.weekdays} weekdays already have option data stored
                  {dataCheck.data.option_days < dataCheck.data.weekdays ? "; the rest will be fetched (slower, uses Breeze calls)." : "."}
                </Text>
              )}
              {job.data?.status === "running" && (
                <div>
                  <Progress percent={job.data.total ? Math.round((job.data.done / job.data.total) * 100) : 0} status="active" size="small" />
                  <Text type="secondary" className="text-xs">{job.data.message}</Text>
                </div>
              )}
              {job.data?.status === "error" && <Alert type="error" showIcon message="Backtest failed" description={job.data.error} />}
              <Tooltip title={!check?.ok ? "Fix the problems in Checks first" : undefined}>
                <Button type="primary" block icon={<PlayCircleOutlined />} disabled={!check?.ok} loading={running} onClick={doRun}>Run backtest</Button>
              </Tooltip>
            </div>
          </SectionCard>
        </div>
      </div>

      <div ref={resultsRef}>
        {result && (
          <div className="space-y-4">
            <Text className="block text-[17px] font-semibold">Results · {dayjs(result.params.from_date).format("D MMM YY")} – {dayjs(result.params.to_date).format("D MMM YY")}</Text>
            <StrategyResults result={result} runId={runId}
              autoPdf={search.get("pdf") === "1"}
              onPdfDone={() => setSearch((p) => { const n = new URLSearchParams(p); n.delete("pdf"); return n; }, { replace: true })} />
            <SectionCard title="Optimize" description="Try every combination of one or two settings over the same period; check it holds up out-of-sample.">
              <SweepPanel spec={spec} from={from} to={to} onApply={applySweep} />
            </SectionCard>
          </div>
        )}
      </div>
    </div>
  );
}

// ---------- Page ----------

export default function BuilderPage() {
  const [search] = useSearchParams();
  const strategyId = search.get("strategy");
  const templateId = search.get("template");
  const runId = search.get("run");
  const templates = useTemplates();
  const saved = useSavedStrategy(strategyId);
  const run = useRun<T_EngineResult>(runId);

  const loading = (strategyId && saved.isLoading) || (templateId && templates.isLoading) || (runId && run.isLoading);
  // Priority: the strategy being edited > a run's spec > a template > blank.
  const source = useMemo(() => {
    if (loading) return null;
    if (strategyId && saved.data) return { key: `s-${saved.data.id}`, spec: saved.data.spec };
    if (runId && run.data) return { key: `r-${runId}`, spec: run.data.result.params.spec };
    const t = templates.data?.find((x) => x.id === templateId);
    if (t) return { key: `t-${t.id}`, spec: t.spec };
    return { key: "blank", spec: BLANK_SPEC };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, strategyId, saved.data?.id, runId, run.data, templateId, templates.data]);

  return (
    <div style={{ padding: 24 }}>
      <PageTitle title="Strategy builder" description="Build any options strategy without code, then backtest it on stored market data." pageTitle={[backtestCrumb, { title: "Builder" }]} />
      <ConnectionGate>
        {saved.error && <Alert type="error" showIcon message={errorMessage(saved.error)} className="!mb-4" />}
        {!source ? <Skeleton active /> : (
          <Editor key={source.key} initial={normalizeSpec(source.spec)} saved={saved.data ?? null} templateId={templateId}
            runResult={run.data?.result ?? null} />
        )}
      </ConnectionGate>
    </div>
  );
}
