// Strategy portfolios on the client: member gates ("when may this algo trade?") built from market regimes or
// custom conditions, and their plain-English description. Mirrors app/strategy/portfolio.py.

import type { T_Portfolio, T_PortfolioMember } from "../api/client";
import { REGIME_LABELS, describeCond, isGroup, type T_Cond, type T_Rule } from "./spec";

export type T_GateMode = "always" | "regime" | "custom";

const regimeRule = (model: string, code: number): T_Rule => ({
  left: { ind: "regime", params: { model }, tf: "1d" },
  op: "==",
  right: { ind: "value", params: { value: code } },
});

// Trade only while the daily regime (known at the previous close) is one of `codes`.
export function regimeGate(model: string, codes: number[]): T_Cond | null {
  if (!codes.length) return null;
  const rules = [...codes].sort((a, b) => a - b).map((c) => regimeRule(model, c));
  return rules.length === 1 ? rules[0] : { any: rules };
}

// The {model, codes} a gate was built from by regimeGate(), or null for any other condition.
export function parseRegimeGate(g: T_Cond | null | undefined): { model: string; codes: number[] } | null {
  if (!g) return null;
  const rules = isGroup(g) ? (g.any ?? null) : [g];
  if (!rules?.length || rules.some((r) => isGroup(r))) return null;
  const rs = rules as T_Rule[];
  const model = String(rs[0].left.params?.model ?? "trend_vol");
  const ok = rs.every((r) => r.left.ind === "regime" && r.op === "==" && r.right.ind === "value" && String(r.left.params?.model ?? "trend_vol") === model);
  return ok ? { model, codes: rs.map((r) => Number(r.right.params?.value)) } : null;
}

export const gateMode = (g: T_Cond | null | undefined): T_GateMode => (!g ? "always" : parseRegimeGate(g) ? "regime" : "custom");

export function describeGate(g: T_Cond | null | undefined): string {
  if (!g) return "Always";
  const r = parseRegimeGate(g);
  if (r) {
    const labels = REGIME_LABELS[r.model] ?? REGIME_LABELS.trend_vol;
    return `Regime: ${r.codes.map((c) => labels.find((l) => l.value === c)?.label ?? c).join(" or ")}`;
  }
  return `When ${describeCond(g, "1d")}`;
}

// A good first custom gate: India VIX (daily close) below 18.
export const VIX_RULE = (): T_Rule => ({
  left: { ind: "price", params: { symbol: "VIX" }, field: "close", tf: "1d" },
  op: "<",
  right: { ind: "value", params: { value: 18 } },
});

export function newMemberId(members: T_PortfolioMember[]): string {
  let i = members.length + 1;
  while (members.some((m) => m.id === `m${i}`)) i++;
  return `m${i}`;
}

export const BLANK_PORTFOLIO: T_Portfolio = { name: "Untitled portfolio", description: "", capital: 500000, members: [] };
