import { App, Button, Empty, Popconfirm, Segmented, Skeleton, Table, Tag, Typography } from "antd";
import { DeleteOutlined, EditOutlined, PlusOutlined, ThunderboltOutlined, FundOutlined, FireOutlined } from "@ant-design/icons";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import dayjs from "dayjs";
import { useDeleteStrategy, useSavedStrategies, useTemplates, type T_SavedStrategyMeta } from "../api/client";
import PageTitle from "../components/PageTitle";
import { backtestCrumb } from "../lib/nav";
import { describeLeg, isDirectional, normalizeSpec, type T_Template } from "../lib/spec";

const { Text } = Typography;

const CATEGORY_ICON: Record<string, React.ReactNode> = {
  Volatility: <ThunderboltOutlined />,
  "Premium selling": <FireOutlined />,
  Directional: <FundOutlined />,
};
const CATEGORY_COLOR: Record<string, string> = {
  Volatility: "from-indigo-500 to-violet-500",
  "Premium selling": "from-rose-500 to-orange-500",
  Directional: "from-emerald-500 to-teal-500",
};

function TemplateCard({ t, onUse }: { t: T_Template; onUse: () => void }) {
  const spec = normalizeSpec(t.spec);
  const legs = (isDirectional(spec) ? spec.position.bullish : spec.position.legs) ?? [];
  return (
    <div onClick={onUse} className="group flex cursor-pointer flex-col rounded-2xl border border-slate-200/70 bg-white p-5 shadow-sm transition-all hover:-translate-y-0.5 hover:border-indigo-200 hover:shadow-md">
      <div className="mb-3 flex items-center justify-between">
        <div className={`flex h-9 w-9 items-center justify-center rounded-xl bg-gradient-to-br ${CATEGORY_COLOR[t.category] ?? "from-slate-500 to-slate-700"} text-white`}>
          {CATEGORY_ICON[t.category] ?? <FundOutlined />}
        </div>
        <Tag className="!m-0">{t.category}</Tag>
      </div>
      <Text className="block text-[14px] font-semibold group-hover:!text-indigo-600">{t.name}</Text>
      <Text type="secondary" className="text-xs flex-1">{t.description}</Text>
      <div className="mt-3 flex flex-wrap gap-1">
        {legs.slice(0, 4).map((l) => (
          <Tag key={l.id} color={l.action === "buy" ? "green" : "red"} className="!m-0 !text-[10px]">{describeLeg(l, spec).replace(/ \(.*\)$/, "")}</Tag>
        ))}
        {isDirectional(spec) && <Tag className="!m-0 !text-[10px]">+ mirrored</Tag>}
      </div>
    </div>
  );
}

export default function StrategiesPage() {
  const navigate = useNavigate();
  const { message } = App.useApp();
  const templates = useTemplates();
  const saved = useSavedStrategies();
  const remove = useDeleteStrategy();
  const [category, setCategory] = useState("All");
  const categories = useMemo(() => ["All", ...new Set((templates.data ?? []).map((t) => t.category))], [templates.data]);
  const shown = (templates.data ?? []).filter((t) => category === "All" || t.category === category);

  return (
    <div style={{ padding: 24 }} className="space-y-6">
      <div className="flex items-end justify-between gap-4 flex-wrap">
        <PageTitle title="Strategies" description="Your saved strategies and ready-made templates. Open one in the builder, change anything, and backtest it." pageTitle={[backtestCrumb, { title: "Strategies" }]} />
        <Button type="primary" icon={<PlusOutlined />} onClick={() => navigate("/backtest/builder")}>Blank strategy</Button>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200/70 shadow-sm">
        <div className="px-6 pt-5 pb-3">
          <Text className="block text-[15px] font-semibold">Your strategies</Text>
          <Text type="secondary" className="text-xs">Saved from the builder. Each save keeps a version; runs remember which version they used.</Text>
        </div>
        {saved.isLoading ? <div className="px-6 pb-6"><Skeleton active /></div> : (saved.data ?? []).length === 0 ? (
          <Empty className="!pb-8" image={Empty.PRESENTED_IMAGE_SIMPLE} description="Nothing saved yet. Start from a template below." />
        ) : (
          <Table<T_SavedStrategyMeta>
            size="small"
            rowKey="id"
            dataSource={saved.data}
            pagination={false}
            onRow={(r) => ({ onClick: () => navigate(`/backtest/builder?strategy=${r.id}`), className: "cursor-pointer" })}
            columns={[
              { title: "Name", dataIndex: "name", render: (n: string) => <Text className="font-medium">{n}</Text> },
              { title: "Underlying", dataIndex: "underlying", render: (u: string) => <Tag color="blue">{u}</Tag> },
              { title: "Entry", dataIndex: "entry", render: (e: string) => (e === "signal" ? "Indicator signal" : "Fixed time") },
              { title: "Legs", dataIndex: "legs", align: "right" },
              { title: "Version", dataIndex: "version", render: (v: number) => `v${v}` },
              { title: "Updated", dataIndex: "updated_at", render: (d: string) => dayjs(d).format("D MMM, HH:mm") },
              {
                title: "",
                key: "a",
                render: (_, r) => (
                  <div className="flex justify-end gap-1" onClick={(e) => e.stopPropagation()}>
                    <Button size="small" type="link" icon={<EditOutlined />} onClick={() => navigate(`/backtest/builder?strategy=${r.id}`)}>Open</Button>
                    <Popconfirm title="Delete this strategy?" description="Saved runs of it are kept." okText="Delete" okButtonProps={{ danger: true }}
                      onConfirm={() => remove.mutate(r.id, { onSuccess: () => message.success("Strategy deleted") })}>
                      <Button size="small" type="text" danger icon={<DeleteOutlined />} />
                    </Popconfirm>
                  </div>
                ),
              },
            ]}
          />
        )}
      </div>

      <div>
        <div className="flex items-center justify-between gap-3 flex-wrap mb-3">
          <div>
            <Text className="block text-[15px] font-semibold">Templates</Text>
            <Text type="secondary" className="text-xs">Complete strategies to start from. Open one, adjust it, run it.</Text>
          </div>
          <Segmented value={category} onChange={(v) => setCategory(String(v))} options={categories} />
        </div>
        {templates.isLoading ? <Skeleton active /> : (
          <div className="grid grid-cols-1 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4 gap-3">
            {shown.map((t) => <TemplateCard key={t.id} t={t} onUse={() => navigate(`/backtest/builder?template=${t.id}`)} />)}
          </div>
        )}
      </div>
    </div>
  );
}
