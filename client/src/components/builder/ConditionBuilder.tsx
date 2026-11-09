import { useMemo } from "react";
import { Button, Input, InputNumber, Popover, Segmented, Select, Tooltip, Typography } from "antd";
import { DeleteOutlined, PlusOutlined, BranchesOutlined, SlidersOutlined } from "@ant-design/icons";
import { useIndicatorCatalogue } from "../../api/client";
import {
  BUILTIN_GROUPS,
  INDICATORS,
  OPS,
  TIMEFRAMES,
  indDef,
  isDailyTf,
  isGroup,
  newRule,
  operand,
  type T_BuiltinInd,
  type T_Cond,
  type T_Group,
  type T_IndicatorCatalogue,
  type T_Operand,
  type T_Rule,
  type T_TF,
} from "../../lib/spec";

const { Text } = Typography;

// Operands that only make sense as a plain series (no other symbol, no shift/scale).
const NO_MORE = new Set(["value"]);
const NO_SYMBOL = new Set(["value", "weekday", "dte", "regime"]);
const SYMBOLS = [
  { value: "", label: "Index (default)" },
  { value: "VIX", label: "India VIX" },
];

type T_Option = { value: string; label: string; title?: string };

// Indicator Select options grouped by category: built-ins first, then the extended library's categories.
function useIndOptions(cat: T_IndicatorCatalogue | undefined, current: string) {
  return useMemo(() => {
    const groups = new Map<string, T_Option[]>(BUILTIN_GROUPS.filter((g) => g !== "Number").map((g) => [g, []]));
    (Object.keys(INDICATORS) as T_BuiltinInd[]).forEach((k) => {
      const d = INDICATORS[k];
      if (d.group === "Number") return;
      groups.get(d.group)!.push({ value: k, label: d.label, title: d.description });
    });
    for (const x of cat?.extended ?? []) {
      if (x.name in INDICATORS) continue;
      const d = indDef(x.name, cat);
      const g = groups.get(x.category) ?? [];
      g.push({ value: x.name, label: d.label, title: x.description });
      groups.set(x.category, g);
    }
    groups.set("Number", [{ value: "value", label: INDICATORS.value.label }]);
    const known = [...groups.values()].some((g) => g.some((o) => o.value === current));
    if (!known) groups.set("Library", [...(groups.get("Library") ?? []), { value: current, label: indDef(current).label }]);
    return [...groups.entries()].filter(([, o]) => o.length).map(([label, options]) => ({ label, title: label, options }));
  }, [cat, current]);
}

// shift / mul / add / symbol, kept out of the JSON when at their defaults.
function clean(o: T_Operand): T_Operand {
  const out: T_Operand = { ...o };
  if (!out.shift) delete out.shift;
  if (out.mul == null || out.mul === 1) delete out.mul;
  if (!out.add) delete out.add;
  if (out.params && "symbol" in out.params && !out.params.symbol) {
    out.params = Object.fromEntries(Object.entries(out.params).filter(([k]) => k !== "symbol"));
  }
  return out;
}

function MoreEditor({ value, onChange }: { value: T_Operand; onChange: (o: T_Operand) => void }) {
  const set = (patch: Partial<T_Operand>) => onChange(clean({ ...value, ...patch }));
  const symbol = String(value.params?.symbol ?? "");
  return (
    <div className="space-y-3 w-64">
      <div className="grid grid-cols-[1fr_110px] items-center gap-2">
        <Text className="text-xs">Candles ago</Text>
        <InputNumber size="small" min={0} max={500} value={value.shift ?? 0} onChange={(v) => set({ shift: v ?? 0 })} />
        <Text className="text-xs">Multiply by</Text>
        <InputNumber size="small" step={0.01} value={value.mul ?? 1} onChange={(v) => set({ mul: v ?? 1 })} />
        <Text className="text-xs">Then add</Text>
        <InputNumber size="small" value={value.add ?? 0} onChange={(v) => set({ add: v ?? 0 })} />
      </div>
      <Text type="secondary" className="block text-[11px]">Value = indicator N candles ago × multiplier + add, e.g. close &gt; 1.01 × EMA, or EMA &gt; EMA 5 candles ago.</Text>
      {!NO_SYMBOL.has(value.ind) && (
        <div>
          <Text className="text-xs block mb-1">Series</Text>
          <Select size="small" className="w-full" value={symbol} options={SYMBOLS}
            onChange={(sym: string) => onChange(clean({ ...value, params: { ...value.params, symbol: sym }, tf: sym && !isDailyTf(value.tf) ? "1d" : value.tf }))} />
          <Text type="secondary" className="block text-[11px] mt-1">India VIX is read from daily candles (1d / 1w).</Text>
        </div>
      )}
    </div>
  );
}

function moreSummary(o: T_Operand): string | null {
  const parts = [
    o.params?.symbol ? "VIX" : null,
    o.shift ? `[${o.shift}]` : null,
    o.mul != null && o.mul !== 1 ? `×${o.mul}` : null,
    o.add ? `${o.add > 0 ? "+" : "−"}${Math.abs(o.add)}` : null,
  ].filter(Boolean);
  return parts.length ? parts.join(" ") : null;
}

function OperandEditor({ value, onChange, tf, values }: {
  value: T_Operand;
  onChange: (o: T_Operand) => void;
  tf: T_TF;
  values?: { value: number; label: string }[]; // categorical right-hand side (weekday, regime)
}) {
  const { data: cat } = useIndicatorCatalogue();
  const def = indDef(value.ind, cat, value);
  const options = useIndOptions(cat, value.ind);
  const summary = moreSummary(value);
  const symbolTf = !!value.params?.symbol;

  if (value.ind === "value" && values) {
    const v = Number(value.params?.value ?? 0);
    return (
      <div className="flex flex-wrap items-center gap-1.5">
        <Select size="small" className="!w-44" value={values.some((x) => x.value === v) ? v : undefined} placeholder="choose…" options={values}
          onChange={(n: number) => onChange({ ...value, params: { value: n } })} />
      </div>
    );
  }
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        size="small"
        className="!w-40"
        value={value.ind}
        options={options}
        showSearch
        optionFilterProp="label"
        popupMatchSelectWidth={220}
        onChange={(ind: string) => onChange({ ...operand(ind, cat), tf: value.tf })}
      />
      {def.params.map((p) =>
        p.options ? (
          <Tooltip key={p.key} title={p.label}>
            <Select size="small" className="!w-40" value={String(value.params?.[p.key] ?? p.default)} options={p.options}
              onChange={(v: string) => onChange({ ...value, params: { ...value.params, [p.key]: v } })} />
          </Tooltip>
        ) : typeof p.default === "number" ? (
          <Tooltip key={p.key} title={p.label}>
            <InputNumber
              size="small"
              className="!w-16"
              value={Number(value.params?.[p.key] ?? p.default)}
              onChange={(v) => v !== null && onChange({ ...value, params: { ...value.params, [p.key]: v } })}
            />
          </Tooltip>
        ) : (
          <Tooltip key={p.key} title={p.label}>
            <Input
              size="small"
              className="!w-16"
              value={String(value.params?.[p.key] ?? p.default)}
              onChange={(e) => onChange({ ...value, params: { ...value.params, [p.key]: e.target.value } })}
            />
          </Tooltip>
        ),
      )}
      {def.fields && (
        <Select size="small" className="!w-24" value={value.field ?? def.fields[0]} options={def.fields.map((f) => ({ value: f, label: f.replace("_", " ") }))}
          onChange={(field) => onChange({ ...value, field })} />
      )}
      {(def.usesTf || symbolTf) && (
        <Select
          size="small"
          className="!w-28"
          value={value.tf ?? ""}
          options={[
            { value: "", label: `${tf} (default)` },
            ...TIMEFRAMES.filter((t) => !symbolTf || isDailyTf(t)).map((t) => ({ value: t, label: t })),
          ]}
          onChange={(v) => onChange({ ...value, tf: (v || null) as T_TF | null })}
        />
      )}
      {!NO_MORE.has(value.ind) && (
        <Popover trigger="click" placement="bottom" title="Offset, scale, series" content={<MoreEditor value={value} onChange={onChange} />}>
          <Tooltip title={summary ? undefined : "N candles ago, × / + adjustments, India VIX"}>
            <Button size="small" type={summary ? "default" : "text"} icon={<SlidersOutlined />} className={summary ? "!text-indigo-600 !border-indigo-200" : "!text-slate-400"}>
              {summary && <span className="text-[11px]">{summary}</span>}
            </Button>
          </Tooltip>
        </Popover>
      )}
    </div>
  );
}

function RuleRow({ rule, onChange, onRemove, tf }: { rule: T_Rule; onChange: (r: T_Rule) => void; onRemove: () => void; tf: T_TF }) {
  const leftValues = indDef(rule.left.ind).values?.(rule.left);
  const setLeft = (left: T_Operand) => {
    const vals = indDef(left.ind).values?.(left);
    const cur = Number(rule.right.params?.value);
    if (vals && (left.ind !== rule.left.ind || rule.right.ind !== "value" || !vals.some((v) => v.value === cur))) {
      // Categorical (weekday, regime): compare with one of its labels.
      onChange({ left, op: left.ind !== rule.left.ind ? "==" : rule.op, right: { ind: "value", params: { value: vals[0].value } } });
    } else onChange({ ...rule, left });
  };
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <OperandEditor value={rule.left} onChange={setLeft} tf={tf} />
      <Select size="small" className="!w-32" value={rule.op} options={OPS} onChange={(op) => onChange({ ...rule, op })} />
      <OperandEditor value={rule.right} onChange={(right) => onChange({ ...rule, right })} tf={tf} values={leftValues} />
      <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={onRemove} className="ml-auto" />
    </div>
  );
}

function GroupEditor({ group, onChange, onRemove, tf, depth }: { group: T_Group; onChange: (g: T_Group) => void; onRemove?: () => void; tf: T_TF; depth: number }) {
  const kind = group.all ? "all" : "any";
  const items = group.all ?? group.any ?? [];
  const setItems = (next: T_Cond[]) => onChange({ [kind]: next } as T_Group);
  return (
    <div className={`space-y-2 rounded-xl ${depth ? "border border-dashed border-indigo-200 bg-indigo-50/40 p-3" : ""}`}>
      <div className="flex items-center gap-2">
        <Segmented
          size="small"
          value={kind}
          onChange={(k) => onChange({ [k as string]: items } as T_Group)}
          options={[{ value: "all", label: "All of (AND)" }, { value: "any", label: "Any of (OR)" }]}
        />
        {onRemove && <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={onRemove}>Remove group</Button>}
      </div>
      {items.map((c, i) => {
        const set = (next: T_Cond) => setItems(items.map((x, j) => (j === i ? next : x)));
        const remove = () => setItems(items.filter((_, j) => j !== i));
        return isGroup(c) ? (
          <GroupEditor key={i} group={c} onChange={set} onRemove={remove} tf={tf} depth={depth + 1} />
        ) : (
          <RuleRow key={i} rule={c} onChange={set} onRemove={remove} tf={tf} />
        );
      })}
      <div className="flex gap-2">
        <Button size="small" icon={<PlusOutlined />} onClick={() => setItems([...items, newRule()])}>Condition</Button>
        {depth < 1 && (
          <Button size="small" icon={<BranchesOutlined />} onClick={() => setItems([...items, { any: [newRule()] }])}>Group</Button>
        )}
      </div>
    </div>
  );
}

// Edits a condition tree. A single rule is shown as a one-item AND group; an empty group becomes null.
export default function ConditionBuilder({ value, onChange, tf, emptyHint, addLabel = "Add condition", initial }: {
  value: T_Cond | null | undefined;
  onChange: (c: T_Cond | null) => void;
  tf: T_TF;
  emptyHint?: string;
  addLabel?: string;
  initial?: () => T_Rule; // first rule when switched on (default EMA 9 crosses above EMA 21)
}) {
  if (!value) {
    return (
      <div className="flex items-center gap-3">
        <Button icon={<PlusOutlined />} onClick={() => onChange({ all: [(initial ?? newRule)()] })}>{addLabel}</Button>
        {emptyHint && <Text type="secondary" className="text-xs">{emptyHint}</Text>}
      </div>
    );
  }
  const group: T_Group = isGroup(value) ? value : { all: [value] };
  return (
    <GroupEditor
      group={group}
      tf={tf}
      depth={0}
      onChange={(g) => onChange((g.all ?? g.any ?? []).length ? g : null)}
    />
  );
}
