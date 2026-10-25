import { DatePicker, Form, Input, Select } from "antd";
import type { Dayjs } from "dayjs";

const ISO = "YYYY-MM-DDTHH:mm:ss";

// Form values → query params: dayjs values become ISO strings, a [from, to] `range` is split
// into from_date (start of day) / to_date (end of day), and empty values are dropped.
export function toApiParams<T>(values: Record<string, unknown>): T {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(values)) {
    if (v === undefined || v === null || v === "") continue;
    if (k === "range" && Array.isArray(v)) {
      out.from_date = (v[0] as Dayjs).startOf("day").format(ISO);
      out.to_date = (v[1] as Dayjs).endOf("day").format(ISO);
    } else if (typeof v === "object" && "format" in (v as object)) {
      out[k] = (v as Dayjs).format(ISO);
    } else {
      out[k] = v;
    }
  }
  return out as T;
}

// Shared instrument inputs. F&O fields only appear when the product type needs them.

export const EXCHANGES = ["NSE", "BSE", "NFO", "BFO", "MCX", "NDX"].map((v) => ({ value: v, label: v }));
export const INTERVALS = ["1second", "1minute", "5minute", "30minute", "1day"].map((v) => ({ value: v, label: v }));
export const PRODUCT_TYPES = ["cash", "futures", "options"].map((v) => ({ value: v, label: v }));
export const RIGHTS = [
  { value: "", label: "–" },
  { value: "call", label: "Call" },
  { value: "put", label: "Put" },
  { value: "others", label: "Others" },
];

const mono = { fontFamily: "'JetBrains Mono', ui-monospace, monospace" };

export default function InstrumentFields({ showProduct = true }: { showProduct?: boolean }) {
  const productType = Form.useWatch("product_type");

  return (
    <>
      <Form.Item
        name="stock_code"
        label="Stock code"
        rules={[{ required: true }]}
        extra="ICICI code, e.g. RELIND, NIFTY, CNXBAN. Look it up under Market data → Names."
      >
        <Input placeholder="RELIND" style={mono} />
      </Form.Item>
      <Form.Item name="exchange_code" label="Exchange">
        <Select options={EXCHANGES} />
      </Form.Item>
      {showProduct && (
        <Form.Item name="product_type" label="Product type">
          <Select options={PRODUCT_TYPES} />
        </Form.Item>
      )}
      {showProduct && productType && productType !== "cash" && (
        <>
          <Form.Item name="expiry_date" label="Expiry date" rules={[{ required: true }]}>
            <DatePicker className="w-full" />
          </Form.Item>
          {productType === "options" && (
            <>
              <Form.Item name="right" label="Right">
                <Select options={RIGHTS} />
              </Form.Item>
              <Form.Item name="strike_price" label="Strike price">
                <Input placeholder="22000" />
              </Form.Item>
            </>
          )}
        </>
      )}
    </>
  );
}
