import { Divider, Typography } from "antd";

const { Text } = Typography;

export default function SectionCard({
  title,
  description,
  extra,
  children,
  danger = false,
}: {
  title: string;
  description: string;
  extra?: React.ReactNode;
  children: React.ReactNode;
  danger?: boolean;
}) {
  return (
    <div data-report-section className={`bg-white rounded-2xl p-6 shadow-sm border ${danger ? "border-red-100" : "border-slate-200/70"}`}>
      <div className="flex items-start justify-between gap-4">
        <div>
          <Text className={`block text-[15px] font-semibold ${danger ? "!text-red-600" : ""}`}>{title}</Text>
          <Text type="secondary" className="text-xs block mb-1">
            {description}
          </Text>
        </div>
        {extra}
      </div>
      <Divider className="my-4" />
      {children}
    </div>
  );
}
