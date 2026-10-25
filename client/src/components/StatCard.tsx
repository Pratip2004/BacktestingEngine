import { Typography } from "antd";

const { Text } = Typography;

export default function StatCard({
  label,
  value,
  hint,
  dot,
}: {
  label: string;
  value: React.ReactNode;
  hint?: React.ReactNode;
  dot?: "good" | "bad";
}) {
  return (
    <div className="bg-white rounded-xl border border-slate-200/70 shadow-sm p-4">
      <div className="flex items-center gap-2 mb-1">
        {dot && (
          <span className="inline-block w-2 h-2 rounded-full" style={{ background: dot === "good" ? "#22C55E" : "#EF4444" }} />
        )}
        <Text className="text-[22px] sm:text-[28px] font-semibold leading-tight">{value}</Text>
      </div>
      <Text type="secondary" className="text-xs block">
        {label}
      </Text>
      {hint && (
        <Text type="secondary" className="!text-slate-400 text-xs block mt-1">
          {hint}
        </Text>
      )}
    </div>
  );
}
