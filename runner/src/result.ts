import type { Fill, FundingPayment } from "./hl-exchange.ts";
import { parseScaled } from "./pricing.ts";
import type { Side } from "./ranks.ts";

/**
 * What one bet returned, worked out from Hyperliquid's own records (01 §9.3 step "report"; on testnet the program
 * cannot see Hyperliquid, so the runner reports this number and 01 §14 says so).
 *
 *   returned = margin + trading result − fees + funding
 *
 * The trading result comes from the fills' prices and sizes, not from Hyperliquid's `closedPnl`, whose treatment
 * of fees its docs do not state; `closedPnl` is kept in the detail as a cross-check. Every amount is read exactly:
 * for these markets a price has at most 6 − d decimals and a size d, so price × size has at most 6, and fees and
 * funding are in USDC with 6. Anything that does not fit is refused, not rounded.
 *
 * Checked against one real bet (round 7 of the real contract, 2026-11-12): two opening fills and one closing fill;
 * the result equalled the change in Hyperliquid's own account value, while `closedPnl` (fees left out, average entry
 * price cut to 6 decimals) was $0.00019 off. Partial fills and funding have run only in the tests.
 */

export interface Window {
  from: number;
  to: number;
}

export interface BetOnExchange {
  position_id: number;
  /** Hyperliquid's name, e.g. "kPEPE". */
  coin: string;
  side: Side;
  margin_e6: bigint;
  /** The size the contract signed for the opening order (`Position.sz_e8`), if known. */
  ordered_sz_e8: bigint | null;
  /** When the opening order could have been executed: from signing to expiry. Null if it was never signed. */
  open: Window | null;
  /** The same for each closing order signed. */
  close: Window[];
}

export interface ResultDetail {
  open_sz: string;
  close_sz: string;
  open_value_e6: bigint;
  close_value_e6: bigint;
  fees_e6: bigint;
  funding_e6: bigint;
  closed_pnl_e6: bigint;
  open_oids: number[];
  close_oids: number[];
}

export type Outcome =
  | { kind: "returned"; returned_e6: bigint; note: string; detail: ResultDetail }
  /** Not finished on the exchange yet (part or all of the bet is still open). */
  | { kind: "waiting"; reason: string; detail: ResultDetail }
  /** Something the runner must not guess about. A person has to look. */
  | { kind: "needs-person"; reason: string };

/** Fills and funding can be stamped a little before or after NEAR's clock: allowed slack, in ms. */
export const CLOCK_SLACK_MS = 10_000;

function inWindow(t: number, w: Window): boolean {
  return t >= w.from - CLOCK_SLACK_MS && t <= w.to + CLOCK_SLACK_MS;
}

function overlaps(a: Window, b: Window): boolean {
  return a.from - CLOCK_SLACK_MS <= b.to + CLOCK_SLACK_MS && b.from - CLOCK_SLACK_MS <= a.to + CLOCK_SLACK_MS;
}

/** price × size in dollars × 10^6, exactly, or null if it does not fit in 6 decimals. */
function valueE6(px: string, sz: string): bigint | null {
  const p = parseScaled(px, 8);
  const s = parseScaled(sz, 8);
  const v = p * s; // scaled by 10^16
  return v % 10n ** 10n === 0n ? v / 10n ** 10n : null;
}

/**
 * Works out what `bet` returned. `others` are the other bets of the same round still on the exchange: if one
 * trades the same coin at overlapping times their fills and funding cannot be told apart, and a person must look.
 * Funding is counted from the first opening fill to the last closing fill.
 */
export function workOutReturned(
  bet: BetOnExchange,
  fills: readonly Fill[],
  funding: readonly FundingPayment[],
  others: readonly BetOnExchange[],
): Outcome {
  const windows = [...(bet.open ? [bet.open] : []), ...bet.close];
  for (const o of others) {
    if (o.position_id === bet.position_id || o.coin !== bet.coin) continue;
    const theirs = [...(o.open ? [o.open] : []), ...o.close];
    const span = (ws: Window[]): Window | null =>
      ws.length === 0
        ? null
        : { from: Math.min(...ws.map((w) => w.from)), to: Math.max(...ws.map((w) => w.to)) };
    const a = span(windows);
    const b = span(theirs);
    if (a && b && overlaps(a, b)) {
      return {
        kind: "needs-person",
        reason: `bets ${bet.position_id} and ${o.position_id} both trade ${bet.coin} at the same time; their fills cannot be told apart`,
      };
    }
  }

  const openDir = bet.side === "LONG" ? "Open Long" : "Open Short";
  const closeDir = bet.side === "LONG" ? "Close Long" : "Close Short";
  const mine = fills.filter((f) => f.coin === bet.coin && windows.some((w) => inWindow(f.time, w)));
  const strange = mine.filter((f) => f.dir !== openDir && f.dir !== closeDir);
  if (strange.length > 0) {
    return {
      kind: "needs-person",
      reason: `unexpected fills on ${bet.coin}: ${strange.map((f) => `${f.dir} ${f.sz} (tid ${f.tid})`).join(", ")}`,
    };
  }
  const opens = mine.filter((f) => f.dir === openDir && bet.open !== null && inWindow(f.time, bet.open));
  const closes = mine.filter((f) => f.dir === closeDir && bet.close.some((w) => inWindow(f.time, w)));
  if (opens.length + closes.length !== mine.length) {
    return { kind: "needs-person", reason: `fills on ${bet.coin} outside the windows of their own orders` };
  }
  for (const f of [...opens, ...closes]) {
    if (f.feeToken !== "USDC")
      return { kind: "needs-person", reason: `fee paid in ${f.feeToken} (tid ${f.tid})` };
  }

  let openSz = 0n;
  let closeSz = 0n;
  let openValue = 0n;
  let closeValue = 0n;
  let fees = 0n;
  let closedPnl = 0n;
  try {
    for (const f of opens) {
      const v = valueE6(f.px, f.sz);
      if (v === null)
        return { kind: "needs-person", reason: `fill ${f.tid}: price × size has more than 6 decimals` };
      openSz += parseScaled(f.sz, 8);
      openValue += v;
      fees += parseScaled(f.fee, 6);
    }
    for (const f of closes) {
      const v = valueE6(f.px, f.sz);
      if (v === null)
        return { kind: "needs-person", reason: `fill ${f.tid}: price × size has more than 6 decimals` };
      closeSz += parseScaled(f.sz, 8);
      closeValue += v;
      fees += parseScaled(f.fee, 6);
      closedPnl += parseScaled(f.closedPnl, 6);
    }
  } catch (e) {
    return {
      kind: "needs-person",
      reason: `a fill could not be read exactly: ${e instanceof Error ? e.message : String(e)}`,
    };
  }

  const heldFrom = opens.length > 0 ? Math.min(...opens.map((f) => f.time)) : null;
  const heldTo = closes.length > 0 ? Math.max(...closes.map((f) => f.time)) : null;
  let fundingE6 = 0n;
  if (heldFrom !== null && heldTo !== null) {
    try {
      for (const p of funding) {
        if (p.coin === bet.coin && p.time > heldFrom && p.time <= heldTo) fundingE6 += parseScaled(p.usdc, 6);
      }
    } catch (e) {
      return {
        kind: "needs-person",
        reason: `a funding record could not be read: ${e instanceof Error ? e.message : String(e)}`,
      };
    }
  }

  const detail: ResultDetail = {
    open_sz: openSz.toString(),
    close_sz: closeSz.toString(),
    open_value_e6: openValue,
    close_value_e6: closeValue,
    fees_e6: fees,
    funding_e6: fundingE6,
    closed_pnl_e6: closedPnl,
    open_oids: [...new Set(opens.map((f) => f.oid))],
    close_oids: [...new Set(closes.map((f) => f.oid))],
  };

  if (openSz === 0n) {
    if (closeSz !== 0n)
      return { kind: "needs-person", reason: `closing fills on ${bet.coin} without an opening fill` };
    return {
      kind: "returned",
      returned_e6: bet.margin_e6,
      note: "the opening order did not fill: the margin is reported back in full",
      detail,
    };
  }
  if (closeSz < openSz) {
    return { kind: "waiting", reason: `${bet.coin}: ${closeSz} of ${openSz} (×10^-8) closed so far`, detail };
  }
  if (closeSz > openSz) {
    return { kind: "needs-person", reason: `${bet.coin}: more closed (${closeSz}) than opened (${openSz})` };
  }
  const trading = bet.side === "LONG" ? closeValue - openValue : openValue - closeValue;
  const returned = bet.margin_e6 + trading - fees + fundingE6;
  if (returned < 0n) {
    return {
      kind: "needs-person",
      reason: `the result is below zero (${returned}); a liquidation is likely`,
    };
  }
  const partial =
    bet.ordered_sz_e8 !== null && openSz < bet.ordered_sz_e8
      ? `; the opening order filled only in part (${openSz} of ${bet.ordered_sz_e8}, ×10^-8)`
      : "";
  return { kind: "returned", returned_e6: returned, note: `opened and closed ${bet.coin}${partial}`, detail };
}
