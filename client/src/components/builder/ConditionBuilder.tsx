import { Button, Input, InputNumber, Segmented, Select, Tooltip, Typography } from "antd";
import { DeleteOutlined, PlusOutlined, BranchesOutlined } from "@ant-design/icons";
import {
  INDICATORS,
  OPS,
  TIMEFRAMES,
  isGroup,
  newRule,
  operand,
  type T_Cond,
  type T_Group,
  type T_IndName,
  type T_Operand,
  type T_Rule,
  type T_TF,
} from "../../lib/spec";

const { Text } = Typography;

const IND_OPTIONS = (Object.keys(INDICATORS) as T_IndName[]).map((k) => ({ value: k, label: INDICATORS[k].label }));

function OperandEditor({ value, onChange, tf }: { value: T_Operand; onChange: (o: T_Operand) => void; tf: T_TF }) {
  const def = INDICATORS[value.ind];
  return (
    <div className="flex flex-wrap items-center gap-1.5">
      <Select
        size="small"
        className="!w-36"
        value={value.ind}
        options={IND_OPTIONS}
        showSearch
        optionFilterProp="label"
        onChange={(ind: T_IndName) => onChange({ ...operand(ind), tf: value.tf })}
      />
      {def.params.map((p) =>
        typeof p.default === "number" ? (
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
        <Select size="small" className="!w-24" value={value.field ?? def.fields[0]} options={def.fields.map((f) => ({ value: f, label: f }))}
          onChange={(field) => onChange({ ...value, field })} />
      )}
      {def.usesTf && (
        <Select
          size="small"
          className="!w-32"
          value={value.tf ?? ""}
          options={[{ value: "", label: `${tf} (default)` }, ...TIMEFRAMES.map((t) => ({ value: t, label: t }))]}
          onChange={(v) => onChange({ ...value, tf: (v || null) as T_TF | null })}
        />
      )}
    </div>
  );
}

function RuleRow({ rule, onChange, onRemove, tf }: { rule: T_Rule; onChange: (r: T_Rule) => void; onRemove: () => void; tf: T_TF }) {
  return (
    <div className="flex flex-wrap items-center gap-2 rounded-lg border border-slate-200 bg-white px-3 py-2">
      <OperandEditor value={rule.left} onChange={(left) => onChange({ ...rule, left })} tf={tf} />
      <Select size="small" className="!w-32" value={rule.op} options={OPS} onChange={(op) => onChange({ ...rule, op })} />
      <OperandEditor value={rule.right} onChange={(right) => onChange({ ...rule, right })} tf={tf} />
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
export default function ConditionBuilder({ value, onChange, tf, emptyHint }: { value: T_Cond | null | undefined; onChange: (c: T_Cond | null) => void; tf: T_TF; emptyHint?: string }) {
  if (!value) {
    return (
      <div className="flex items-center gap-3">
        <Button icon={<PlusOutlined />} onClick={() => onChange({ all: [newRule()] })}>Add condition</Button>
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
