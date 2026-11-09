import { useEffect, useMemo, useRef, useState } from "react";
import { Input, Modal, Typography } from "antd";
import type { InputRef } from "antd";
import { SearchOutlined, EnterOutlined } from "@ant-design/icons";
import { useNavigate } from "react-router-dom";
import { useRuns } from "../api/client";

const { Text } = Typography;

type T_Command = { id: string; group: string; label: string; hint?: string; to: string };

const PAGES: T_Command[] = [
  { id: "p-home", group: "Pages", label: "Overview", to: "/" },
  { id: "p-research", group: "Pages", label: "Research lab", hint: "Live strategy-research program", to: "/research" },
  { id: "p-strategies", group: "Pages", label: "Backtest · Strategies", hint: "Your strategies and templates", to: "/backtest/strategies" },
  { id: "p-builder", group: "Pages", label: "Backtest · Strategy builder", hint: "Build any strategy without code", to: "/backtest/builder" },
  { id: "p-portfolio", group: "Pages", label: "Backtest · Portfolio", hint: "Several algos together, each gated by regime or indicators", to: "/backtest/portfolio" },
  { id: "p-straddle", group: "Pages", label: "Backtest · Straddle", hint: "Buy or sell the ATM straddle", to: "/backtest/straddle" },
  { id: "p-fly", group: "Pages", label: "Backtest · EMA butterfly", hint: "EMA crossover butterfly with exit lab", to: "/backtest/ema-butterfly" },
  { id: "p-stock", group: "Pages", label: "Backtest · Stock strategy", to: "/backtest/stock" },
  { id: "p-saved", group: "Pages", label: "Saved runs", hint: "Every backtest you've run", to: "/backtest/saved" },
  { id: "p-data", group: "Pages", label: "Data store", hint: "Coverage, downloads, settings", to: "/data" },
  { id: "p-options", group: "Pages", label: "Options analytics", hint: "Live chain, expiry comparison", to: "/options" },
  { id: "p-market", group: "Pages", label: "Market data", to: "/market" },
  { id: "p-account", group: "Pages", label: "Account", to: "/account" },
  { id: "p-session", group: "Pages", label: "Session", hint: "Daily Breeze login", to: "/session" },
];

const ACTIONS: T_Command[] = [
  { id: "a-download", group: "Actions", label: "Download market data", hint: "Plan a backfill", to: "/data?tab=download" },
  { id: "a-login", group: "Actions", label: "Log in to Breeze", to: "/session" },
  { id: "a-new-strategy", group: "Actions", label: "New strategy", hint: "Blank strategy in the builder", to: "/backtest/builder" },
  { id: "a-new-straddle", group: "Actions", label: "New straddle backtest", to: "/backtest/straddle" },
];

const RUN_PATH: Record<string, string> = { stock: "/backtest/stock", butterfly: "/backtest/ema-butterfly", straddle: "/backtest/straddle", custom: "/backtest/builder", portfolio: "/backtest/portfolio" };

// ⌘K / Ctrl+K: jump to any page, action or saved run by typing.
export default function CommandPalette({ open, onClose }: { open: boolean; onClose: () => void }) {
  const navigate = useNavigate();
  const runs = useRuns();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const input = useRef<InputRef>(null);

  const items = useMemo(() => {
    const saved: T_Command[] = (runs.data ?? []).slice(0, 50).map((r) => ({
      id: `r-${r.id}`,
      group: "Saved runs",
      label: r.name,
      hint: r.strategy_name,
      to: `${RUN_PATH[r.strategy]}?run=${r.id}`,
    }));
    const q = query.trim().toLowerCase();
    const all = [...ACTIONS, ...PAGES, ...saved];
    return q ? all.filter((c) => `${c.label} ${c.hint ?? ""} ${c.group}`.toLowerCase().includes(q)) : [...ACTIONS, ...PAGES, ...saved.slice(0, 5)];
  }, [query, runs.data]);

  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      setTimeout(() => input.current?.focus(), 50);
    }
  }, [open]);
  useEffect(() => setActive(0), [query]);

  const go = (c: T_Command | undefined) => {
    if (!c) return;
    onClose();
    navigate(c.to);
  };

  let lastGroup = "";
  return (
    <Modal open={open} onCancel={onClose} footer={null} closable={false} width={600} styles={{ body: { padding: 0 }, content: { padding: 0, overflow: "hidden" } }}>
      <div className="border-b border-slate-200 px-3 py-2">
        <Input
          ref={input}
          variant="borderless"
          size="large"
          prefix={<SearchOutlined className="text-slate-400 mr-1" />}
          placeholder="Search pages, actions and saved runs…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "ArrowDown") { e.preventDefault(); setActive((i) => Math.min(i + 1, items.length - 1)); }
            if (e.key === "ArrowUp") { e.preventDefault(); setActive((i) => Math.max(i - 1, 0)); }
            if (e.key === "Enter") go(items[active]);
          }}
        />
      </div>
      <div className="max-h-[420px] overflow-y-auto py-2">
        {items.length === 0 && <Text type="secondary" className="block px-5 py-6 text-center">No matches</Text>}
        {items.map((c, i) => {
          const header = c.group !== lastGroup ? (lastGroup = c.group) : null;
          return (
            <div key={c.id}>
              {header && <Text className="block px-5 pt-3 pb-1 !text-[11px] font-medium uppercase tracking-wider !text-slate-400">{header}</Text>}
              <div
                onMouseEnter={() => setActive(i)}
                onClick={() => go(c)}
                className={`mx-2 flex items-center justify-between gap-3 rounded-lg px-3 py-2 cursor-pointer ${i === active ? "bg-indigo-50" : ""}`}
              >
                <div className="min-w-0">
                  <Text className={`block truncate text-[13px] ${i === active ? "!text-indigo-700" : ""}`}>{c.label}</Text>
                  {c.hint && <Text type="secondary" className="block truncate text-xs">{c.hint}</Text>}
                </div>
                {i === active && <EnterOutlined className="text-indigo-400" />}
              </div>
            </div>
          );
        })}
      </div>
      <div className="flex items-center gap-4 border-t border-slate-200 bg-slate-50 px-5 py-2">
        <Text type="secondary" className="text-xs">↑↓ to move · Enter to open · Esc to close</Text>
      </div>
    </Modal>
  );
}
