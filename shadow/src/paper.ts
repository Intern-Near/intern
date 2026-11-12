import type { Market } from "../../runner/src/markets.ts";
import type { Side } from "../../runner/src/ranks.ts";

/**
 * Paper positions for the shadow run's two portfolios. Paper only: no order is placed anywhere.
 *
 * A position opens at the first price read at or after the decision, and closes at the first price read at or
 * after the hold time has passed. A round-trip cost is charged on the notional. It counts as liquidated, losing its
 * whole margin, if at any price read during the hold the loss reached the margin. Funding payments are not counted.
 */

/** Prices read at one moment: Hyperliquid mark prices, and each market's maximum leverage. */
export interface PricePoint {
  at: number;
  mark: Partial<Record<Market, number>>;
  maxLeverage: Partial<Record<Market, number>>;
}

export interface PaperBet {
  market: Market;
  side: Side;
  marginUsd: number;
  leverage: number;
  /** When the decision was made. */
  at: number;
}

export type Outcome =
  | {
      status: "closed";
      entry: number;
      exit: number;
      entryAt: number;
      exitAt: number;
      pnlUsd: number;
      liquidated: boolean;
    }
  | { status: "open"; entry: number; entryAt: number }
  | { status: "no-price"; reason: string }
  | { status: "not-placeable"; reason: string };

export interface PaperOptions {
  holdMs: number;
  costBps: number;
  /** How far after the wanted time a price may be read and still count. */
  toleranceMs: number;
}

/** Hyperliquid's minimum order value (01 §3). */
export const MIN_ORDER_USD = 10;

/** The first price point at or after `t`, if it is within `toleranceMs` of it. `series` is sorted by time. */
export function pointAtOrAfter(
  series: readonly PricePoint[],
  t: number,
  toleranceMs: number,
): PricePoint | null {
  let lo = 0;
  let hi = series.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((series[mid]?.at ?? Number.POSITIVE_INFINITY) < t) lo = mid + 1;
    else hi = mid;
  }
  const p = series[lo];
  return p !== undefined && p.at - t <= toleranceMs ? p : null;
}

export function runPosition(bet: PaperBet, series: readonly PricePoint[], opts: PaperOptions): Outcome {
  const notional = bet.marginUsd * bet.leverage;
  if (notional < MIN_ORDER_USD) return { status: "not-placeable", reason: "under Hyperliquid's $10 minimum" };

  const entryPoint = pointAtOrAfter(series, bet.at, opts.toleranceMs);
  const entry = entryPoint?.mark[bet.market];
  if (entryPoint === null || entry === undefined)
    return { status: "no-price", reason: "no price at the decision" };

  const exitTarget = entryPoint.at + opts.holdMs;
  const exitPoint = pointAtOrAfter(series, exitTarget, opts.toleranceMs);
  if (exitPoint === null) {
    const last = series[series.length - 1];
    if (last === undefined || last.at < exitTarget) return { status: "open", entry, entryAt: entryPoint.at };
    return { status: "no-price", reason: "a gap in the prices where the close should be" };
  }
  const exit = exitPoint.mark[bet.market];
  if (exit === undefined) return { status: "no-price", reason: "no price at the close" };

  const direction = bet.side === "LONG" ? 1 : -1;
  let liquidated = false;
  for (const p of series) {
    if (p.at < entryPoint.at || p.at > exitPoint.at) continue;
    const px = p.mark[bet.market];
    if (px !== undefined && direction * (px / entry - 1) * bet.leverage <= -1) {
      liquidated = true;
      break;
    }
  }
  const pnlUsd = liquidated
    ? -bet.marginUsd
    : notional * direction * (exit / entry - 1) - (notional * opts.costBps) / 10_000;
  return { status: "closed", entry, exit, entryAt: entryPoint.at, exitAt: exitPoint.at, pnlUsd, liquidated };
}

/**
 * The "without the rank" version of a bet: taken as asked, except what no pool or exchange allows: the margin is
 * capped at the pool, and the leverage at the market's maximum on Hyperliquid.
 */
export function noRankBet(
  bet: PaperBet,
  poolUsd: number,
  maxLeverage: number | undefined,
): { bet: PaperBet; capped: boolean } {
  const marginUsd = Math.min(bet.marginUsd, poolUsd);
  const leverage = maxLeverage === undefined ? bet.leverage : Math.min(bet.leverage, maxLeverage);
  return {
    bet: { ...bet, marginUsd, leverage },
    capped: marginUsd !== bet.marginUsd || leverage !== bet.leverage,
  };
}

export interface ArmSummary {
  bets: number;
  closed: number;
  open: number;
  noPrice: number;
  notPlaceable: number;
  liquidated: number;
  capped: number;
  /** Sum of the closed positions' results, in dollars. */
  pnlUsd: number;
}

export function emptyArm(): ArmSummary {
  return { bets: 0, closed: 0, open: 0, noPrice: 0, notPlaceable: 0, liquidated: 0, capped: 0, pnlUsd: 0 };
}

export function addOutcome(arm: ArmSummary, outcome: Outcome, capped = false): void {
  arm.bets += 1;
  if (capped) arm.capped += 1;
  if (outcome.status === "closed") {
    arm.closed += 1;
    arm.pnlUsd += outcome.pnlUsd;
    if (outcome.liquidated) arm.liquidated += 1;
  } else if (outcome.status === "open") arm.open += 1;
  else if (outcome.status === "no-price") arm.noPrice += 1;
  else arm.notPlaceable += 1;
}
