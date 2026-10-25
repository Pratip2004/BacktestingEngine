import { Alert, Descriptions, Empty, Spin, Table } from "antd";
import { errorMessage, type T_BreezeData } from "../api/client";

// Breeze returns arrays of flat records for lists and a flat object for single entities.
// Columns are derived from the data, since fields differ by segment and product.

const fmt = (v: unknown) => (v === null || v === undefined || v === "" ? "–" : typeof v === "object" ? JSON.stringify(v) : String(v));

const label = (key: string) => key.replace(/_/g, " ");

export default function BreezeData({
  data,
  loading,
  error,
  emptyText = "No data",
}: {
  data: T_BreezeData | undefined;
  loading?: boolean;
  error?: unknown;
  emptyText?: string;
}) {
  if (error) return <Alert type="error" showIcon message={errorMessage(error)} />;
  if (loading) return <Spin className="block py-8" />;
  if (!data || (Array.isArray(data) && data.length === 0)) return <Empty description={emptyText} />;

  if (Array.isArray(data)) {
    const keys = Array.from(new Set(data.flatMap((row) => Object.keys(row))));
    return (
      <div className="overflow-x-auto">
        <Table
          size="small"
          rowKey={(_, i) => String(i)}
          dataSource={data}
          pagination={data.length > 20 ? { pageSize: 20 } : false}
          scroll={{ x: "max-content" }}
          columns={keys.map((k) => ({
            title: label(k),
            dataIndex: k,
            key: k,
            render: fmt,
            sorter: (a: Record<string, unknown>, b: Record<string, unknown>) =>
              String(a[k] ?? "").localeCompare(String(b[k] ?? ""), undefined, { numeric: true }),
          }))}
        />
      </div>
    );
  }

  return (
    <Descriptions
      size="small"
      bordered
      column={{ xs: 1, sm: 2, lg: 3 }}
      items={Object.entries(data).map(([k, v]) => ({ key: k, label: label(k), children: fmt(v) }))}
    />
  );
}
