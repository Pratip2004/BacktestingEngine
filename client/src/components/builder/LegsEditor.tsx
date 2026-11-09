import { Button, Checkbox, Dropdown, Input, InputNumber, Popover, Segmented, Select, Tag, Tooltip, Typography } from "antd";
import { DeleteOutlined, PlusOutlined, AppstoreAddOutlined, SettingOutlined } from "@ant-design/icons";
import { LEG_PRESETS, STRIKE_BY, newLeg, type T_Leg } from "../../lib/spec";
import LevelInput from "./LevelInput";

const { Text } = Typography;

const EXPIRY_N = [
  { value: 0, label: "Nearest" },
  { value: 1, label: "Next" },
  { value: 2, label: "3rd" },
  { value: 3, label: "4th" },
];

function LegExits({ leg, onChange }: { leg: T_Leg; onChange: (l: T_Leg) => void }) {
  const ex = leg.exits ?? {};
  const set = (k: "target" | "stop", v: unknown) => {
    const next = { ...ex, [k]: v };
    onChange({ ...leg, exits: next.target || next.stop ? next : null });
  };
  return (
    <div className="space-y-3 w-72">
      <Text type="secondary" className="text-xs block">Overrides the per-leg defaults for this leg only. % is of this leg's premium.</Text>
      <div>
        <Text className="text-xs block mb-1">Target</Text>
        <LevelInput size="small" value={ex.target} defaultValue={50} onChange={(v) => set("target", v)} />
      </div>
      <div>
        <Text className="text-xs block mb-1">Stop-loss</Text>
        <LevelInput size="small" value={ex.stop} defaultValue={25} onChange={(v) => set("stop", v)} />
      </div>
    </div>
  );
}

function LegRow({ leg, onChange, onRemove, swing }: { leg: T_Leg; onChange: (l: T_Leg) => void; onRemove: () => void; swing?: boolean }) {
  const fut = leg.instrument === "FUT";
  const unit = STRIKE_BY.find((s) => s.value === leg.strike.by)?.unit;
  return (
    <div className="grid grid-cols-[minmax(80px,110px)_150px_90px_1fr_auto] items-center gap-2 rounded-xl border border-slate-200 bg-white p-3 max-xl:grid-cols-2">
      <Input size="small" value={leg.id} onChange={(e) => onChange({ ...leg, id: e.target.value.replace(/\s+/g, "_").slice(0, 20) })} />
      <Segmented
        size="small"
        value={leg.action}
        onChange={(v) => onChange({ ...leg, action: v as "buy" | "sell" })}
        options={[
          { value: "buy", label: <span className={leg.action === "buy" ? "text-emerald-600 font-medium" : ""}>Buy</span> },
          { value: "sell", label: <span className={leg.action === "sell" ? "text-red-500 font-medium" : ""}>Sell</span> },
        ]}
      />
      <Select size="small" value={leg.instrument} onChange={(instrument) => onChange({ ...leg, instrument, expiry: instrument === "FUT" ? { by: "monthly", n: 0 } : leg.expiry })}
        options={[{ value: "CE", label: "Call (CE)" }, { value: "PE", label: "Put (PE)" }, { value: "FUT", label: "Future" }]} />
      <div className="flex flex-wrap items-center gap-2">
        {!fut && (
          <>
            <Select size="small" className="!w-36" value={leg.strike.by} options={STRIKE_BY.map(({ value, label }) => ({ value, label }))}
              onChange={(by) => onChange({ ...leg, strike: { by, value: by === "delta" ? 0.25 : by === "premium" ? 50 : by === "pct_otm" ? 1 : 0 } })} />
            <InputNumber size="small" className="!w-24" value={leg.strike.value} step={leg.strike.by === "delta" ? 0.05 : leg.strike.by === "points" ? 50 : 1}
              addonAfter={unit} onChange={(v) => v !== null && onChange({ ...leg, strike: { ...leg.strike, value: v } })} />
          </>
        )}
        <Select size="small" className="!w-24" value={leg.expiry.n} options={EXPIRY_N} onChange={(n) => onChange({ ...leg, expiry: { ...leg.expiry, n } })} />
        <Select size="small" className="!w-24" value={leg.expiry.by} disabled={fut}
          options={[{ value: "weekly", label: "weekly" }, { value: "monthly", label: "monthly" }]} onChange={(by) => onChange({ ...leg, expiry: { ...leg.expiry, by } })} />
        {!fut && leg.expiry.by === "weekly" && leg.expiry.n === 0 && (
          <Checkbox className="!text-xs" checked={!!leg.expiry.skip_expiry_day} onChange={(e) => onChange({ ...leg, expiry: { ...leg.expiry, skip_expiry_day: e.target.checked } })}>
            Skip expiry day
          </Checkbox>
        )}
        {(swing || !!leg.expiry.min_days) && (
          <Tooltip title="Only expiries at least this many trading days after entry, so a multi-day trade needn't be rolled.">
            <InputNumber size="small" className="!w-28" min={0} max={40} value={leg.expiry.min_days ?? 0} addonBefore="≥" addonAfter="days"
              onChange={(v) => onChange({ ...leg, expiry: { ...leg.expiry, min_days: v ?? 0 } })} />
          </Tooltip>
        )}
        <InputNumber size="small" className="!w-24" min={1} max={100} value={leg.lots} addonAfter="lots" onChange={(v) => v !== null && onChange({ ...leg, lots: v })} />
      </div>
      <div className="flex items-center gap-1 justify-end">
        <Popover trigger="click" content={<LegExits leg={leg} onChange={onChange} />} title={`Exits for ${leg.id}`}>
          <Button size="small" type="text" icon={<SettingOutlined />}>
            {leg.exits ? <Tag color="blue" className="!m-0 !text-[10px]">own exits</Tag> : null}
          </Button>
        </Popover>
        <Button size="small" type="text" danger icon={<DeleteOutlined />} onClick={onRemove} />
      </div>
    </div>
  );
}

export default function LegsEditor({ legs, onChange, swing }: { legs: T_Leg[]; onChange: (legs: T_Leg[]) => void; swing?: boolean }) {
  return (
    <div className="space-y-2">
      <div className="hidden xl:grid grid-cols-[minmax(80px,110px)_150px_90px_1fr_auto] gap-2 px-3">
        {["Leg", "Action", "Type", "Strike · expiry · lots", ""].map((h) => (
          <Text key={h} className="!text-[11px] uppercase tracking-wider !text-slate-400">{h}</Text>
        ))}
      </div>
      {legs.map((leg, i) => (
        <LegRow key={i} leg={leg} swing={swing} onChange={(l) => onChange(legs.map((x, j) => (j === i ? l : x)))} onRemove={() => onChange(legs.filter((_, j) => j !== i))} />
      ))}
      <div className="flex gap-2 pt-1">
        <Button icon={<PlusOutlined />} onClick={() => onChange([...legs, newLeg(legs)])}>Add leg</Button>
        <Dropdown
          menu={{
            items: LEG_PRESETS.map((p) => ({ key: p.key, label: p.label })),
            onClick: ({ key }) => onChange(structuredClone(LEG_PRESETS.find((p) => p.key === key)!.legs)),
          }}
        >
          <Button icon={<AppstoreAddOutlined />}>Use a structure</Button>
        </Dropdown>
      </div>
    </div>
  );
}
