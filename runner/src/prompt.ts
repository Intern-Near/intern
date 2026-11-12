import type { PriceRow } from "./hyperliquid.ts";
import type { Network } from "./markets.ts";

/** Change between two decimal price strings, as "+1.25%" or "-0.40%". For display only. */
export function changePct(now: string, before: string): string {
  const a = Number(now);
  const b = Number(before);
  if (!(b > 0) || !Number.isFinite(a)) return "n/a";
  const s = (((a - b) / b) * 100).toFixed(2);
  return s.startsWith("-") && s !== "-0.00" ? `${s}%` : `+${s.replace("-", "")}%`;
}

/**
 * The market-data part of the user message: one line per market, with Hyperliquid's own price strings.
 * kSHIB and kPEPE are quoted per 1,000 coins, and the line says so.
 */
export function marketDataMessage(rows: readonly PriceRow[], fetchedAt: string, network: Network): string {
  return [
    `Market data: Hyperliquid perpetuals (${network}), mark prices at ${fetchedAt}, with the change over 24 hours.`,
    ...rows.map((r) => {
      const unit = r.hl_name === `k${r.market}` ? ` per 1,000 ${r.market}` : "";
      return `${r.market}: ${r.mark_px} USD${unit} (24h ${changePct(r.mark_px, r.prev_day_px)})`;
    }),
  ].join("\n");
}
