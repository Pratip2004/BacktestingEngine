// Option charges by date and the margin a position blocks; mirrors app/data/store.py DEFAULT_COSTS and
// app/strategy/margin.py so the client-side labs (straddle) charge what the backend engine charges.

type T_OptionRates = { stt: number; exchange: number; sebi: number; stamp: number; gst: number };

// Newest first: [effective from (YYYY-MM-DD), rates as fractions of premium turnover].
const OPTION_RATES: [string, T_OptionRates][] = [
  ["2026-04-01", { stt: 0.0015, exchange: 0.0003503, sebi: 0.000001, stamp: 0.00003, gst: 0.18 }], // Budget 2026-27
  ["2024-10-01", { stt: 0.001, exchange: 0.0003503, sebi: 0.000001, stamp: 0.00003, gst: 0.18 }],
  ["2023-04-01", { stt: 0.000625, exchange: 0.000495, sebi: 0.000001, stamp: 0.00003, gst: 0.18 }],
  ["2000-01-01", { stt: 0.0005, exchange: 0.000495, sebi: 0.000001, stamp: 0.00003, gst: 0.18 }],
];

export function optionRates(day: string): T_OptionRates {
  return (OPTION_RATES.find(([since]) => day.slice(0, 10) >= since) ?? OPTION_RATES[OPTION_RATES.length - 1])[1];
}

// Brokerage + statutory charges for `orders` orders on `turnover` rupees of option premium on `day`.
export function optionCosts(day: string, turnover: number, isBuy: boolean, orders: number, brokeragePerOrder: number, taxes: boolean) {
  const brokerage = brokeragePerOrder * orders;
  if (!taxes) return brokerage;
  const r = optionRates(day);
  const exchange = r.exchange * turnover;
  const sebi = r.sebi * turnover;
  return brokerage + exchange + sebi + (isBuy ? r.stamp : r.stt) * turnover + r.gst * (brokerage + exchange + sebi);
}

// Default share of contract value blocked for an uncovered short index option (backend setting short_margin_pct).
export const DEFAULT_SHORT_MARGIN_PCT = 13;

// Money blocked by a straddle: the premium when buying; exchange margin when selling (margined on one side,
// approximated as a share of spot × quantity), which is many times the premium received.
export function straddleMargin(sell: boolean, premiumRupees: number, spot: number, qty: number, shortMarginPct = DEFAULT_SHORT_MARGIN_PCT) {
  return sell ? (shortMarginPct / 100) * spot * qty : premiumRupees;
}
