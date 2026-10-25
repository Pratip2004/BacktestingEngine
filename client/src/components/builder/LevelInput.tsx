import { useState } from "react";
import { InputNumber, Select, Switch } from "antd";
import type { T_Level } from "../../lib/spec";

const UNITS = [
  { value: "pct", label: "% premium" },
  { value: "rupees", label: "₹" },
  { value: "points", label: "points" },
];

// A target / stop level: on/off, value and unit. Remembers the last value while switched off.
export default function LevelInput({
  value,
  onChange,
  defaultValue = 30,
  size = "middle",
  allowOff = true,
}: {
  value: T_Level | null | undefined;
  onChange: (v: T_Level | null) => void;
  defaultValue?: number;
  size?: "small" | "middle";
  allowOff?: boolean;
}) {
  const [last, setLast] = useState<T_Level>(value ?? { unit: "pct", value: defaultValue });
  const on = value != null;
  const cur = value ?? last;
  const set = (v: T_Level) => {
    setLast(v);
    onChange(v);
  };
  return (
    <div className="flex items-center gap-2">
      {allowOff && <Switch size="small" checked={on} onChange={(c) => onChange(c ? last : null)} />}
      <InputNumber
        size={size}
        className="!w-24"
        min={0.01}
        disabled={!on}
        value={cur.value}
        onChange={(v) => v !== null && set({ ...cur, value: v })}
      />
      <Select size={size} className="!w-28" disabled={!on} value={cur.unit} options={UNITS} onChange={(unit) => set({ ...cur, unit })} />
    </div>
  );
}
