import { useMemo } from "react";
import { Alert, Drawer, Skeleton, Tag, Typography } from "antd";
import dayjs from "dayjs";
import { Area, AreaChart, CartesianGrid, Legend, Line, LineChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from "recharts";
import { errorMessage, useReplay } from "../api/client";

const { Text } = Typography;

// Categorical slots for legs (fixed order).
const LEG_COLORS = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#6250d6", "#e34948"];
const GRID = "#F1F5F9";
const AXIS = "#94A3B8";

const inr = (n: number) => `${n < 0 ? "−" : n > 0 ? "+" : ""}₹${Math.abs(Math.round(n)).toLocaleString("en-IN")}`;
const hhmm = (t: string) => t.slice(11, 16);

// Minute-by-minute view of one trade: the underlying, each leg's price and the position's P&L.
export default function ReplayDrawer({ runId, index, onClose, member }: { runId: string; index: number | null; onClose: () => void; member?: string | null }) {
  const q = useReplay(runId, index, member);
  const multiDay = !!q.data && q.data.trade.entry_at.slice(0, 10) !== (q.data.trade.exit_at ?? q.data.trade.entry_at).slice(0, 10);
  const tick = (t: string) => (multiDay ? dayjs(t).format("D MMM HH:mm") : hhmm(t));
  const r = q.data;
  const entry = r?.trade.entry_at;
  const exit = r?.trade.exit_at ?? undefined;

  const legRows = useMemo(() => {
    if (!r) return [];
    const by = new Map<string, Record<string, number | string>>();
    r.legs.forEach((l) => l.series.forEach((p) => by.set(p.t, { ...(by.get(p.t) ?? { t: p.t }), [l.id]: p.close })));
    return [...by.values()].sort((a, b) => String(a.t).localeCompare(String(b.t)));
  }, [r]);

  const marks = (
    <>
      {entry && <ReferenceLine x={entry} stroke="#22C55E" strokeDasharray="4 3" label={{ value: "Entry", position: "top", fontSize: 10, fill: "#16A34A" }} />}
      {exit && <ReferenceLine x={exit} stroke="#EF4444" strokeDasharray="4 3" label={{ value: "Exit", position: "top", fontSize: 10, fill: "#DC2626" }} />}
    </>
  );
  const xAxis = <XAxis dataKey="t" tickFormatter={tick} tick={{ fontSize: 10, fill: AXIS }} stroke={GRID} minTickGap={40} />;

  return (
    <Drawer open={index !== null} onClose={onClose} width={760}
      title={r ? `Trade ${index! + 1} · ${dayjs(r.trade.trade_day).format("ddd D MMM YYYY")}` : "Trade replay"}>
      {q.error && <Alert type="error" showIcon message={errorMessage(q.error)} />}
      {!r ? <Skeleton active /> : (
        <div className="space-y-6">
          <div className="flex flex-wrap gap-2">
            <Tag>{tick(r.trade.entry_at)} → {r.trade.exit_at ? tick(r.trade.exit_at) : "–"}</Tag>
            <Tag color={r.trade.net >= 0 ? "success" : "error"}>Net {inr(r.trade.net)}</Tag>
            <Tag>Exit: {r.trade.reason}</Tag>
            {r.trade.direction && <Tag color={r.trade.direction === "bullish" ? "green" : "red"}>{r.trade.direction}</Tag>}
            <Tag>Best {r.trade.mfe !== null ? inr(r.trade.mfe) : "–"} · worst {r.trade.mae !== null ? inr(r.trade.mae) : "–"}</Tag>
          </div>

          <div>
            <Text className="block text-[13px] font-semibold mb-1">Position P&L (before costs)</Text>
            <div className="h-48">
              <ResponsiveContainer>
                <AreaChart data={r.pnl} margin={{ top: 14, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  {xAxis}
                  <YAxis tickFormatter={(v) => inr(v)} tick={{ fontSize: 10, fill: AXIS }} stroke={GRID} width={70} />
                  <ReferenceLine y={0} stroke={AXIS} />
                  {marks}
                  <Tooltip formatter={(v) => [inr(Number(v)), "P&L"]} labelFormatter={(t) => hhmm(String(t))} />
                  <Area dataKey="pnl" stroke="#4F46E5" strokeWidth={2} fill="#4F46E5" fillOpacity={0.08} isAnimationActive={false} />
                </AreaChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div>
            <Text className="block text-[13px] font-semibold mb-1">{r.underlying}</Text>
            <div className="h-40">
              <ResponsiveContainer>
                <LineChart data={r.spot} margin={{ top: 14, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  {xAxis}
                  <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: AXIS }} stroke={GRID} width={70} />
                  {marks}
                  <Tooltip formatter={(v) => [Number(v).toLocaleString("en-IN"), r.underlying]} labelFormatter={(t) => hhmm(String(t))} />
                  <Line dataKey="close" stroke="#0F172A" strokeWidth={1.5} dot={false} isAnimationActive={false} />
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>

          <div>
            <Text className="block text-[13px] font-semibold mb-1">Leg prices</Text>
            <div className="h-56">
              <ResponsiveContainer>
                <LineChart data={legRows} margin={{ top: 14, right: 12, bottom: 0, left: 0 }}>
                  <CartesianGrid stroke={GRID} vertical={false} />
                  {xAxis}
                  <YAxis domain={["auto", "auto"]} tick={{ fontSize: 10, fill: AXIS }} stroke={GRID} width={70} />
                  {marks}
                  <Tooltip labelFormatter={(t) => hhmm(String(t))} />
                  <Legend wrapperStyle={{ fontSize: 11 }} formatter={(v) => <span style={{ color: "#64748B" }}>{r.legs.find((l) => l.id === v)?.label ?? v}</span>} />
                  {r.legs.map((l, i) => (
                    <Line key={l.id} dataKey={l.id} stroke={LEG_COLORS[i % LEG_COLORS.length]} strokeWidth={2} dot={false} connectNulls isAnimationActive={false} />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}
    </Drawer>
  );
}
