import type { Market } from "./markets.ts";

/**
 * The three ranks, copied from 01-SHARED-INTERFACE.md section 3 (interface version 1.0; the numbers are
 * PROPOSED there). In the product the contract's `get_constants().ranks` is the authority.
 */
export type RankName = "INTERN" | "ANALYST" | "TRADER";
export type Side = "LONG" | "SHORT";

export interface Limits {
  readonly rank: RankName;
  readonly per_bet_bps: number;
  readonly max_bets: number;
  readonly per_round_bps: number;
  readonly sides: readonly Side[];
  readonly max_leverage: number;
  readonly markets: readonly Market[];
}

const FOUR: readonly Market[] = ["DOGE", "SHIB", "PEPE", "PENGU"];
const SIX: readonly Market[] = [...FOUR, "WIF", "TRUMP"];

export const RANKS: Readonly<Record<RankName, Limits>> = {
  INTERN: {
    rank: "INTERN",
    per_bet_bps: 200,
    max_bets: 1,
    per_round_bps: 200,
    sides: ["LONG"],
    max_leverage: 1,
    markets: FOUR,
  },
  ANALYST: {
    rank: "ANALYST",
    per_bet_bps: 500,
    max_bets: 2,
    per_round_bps: 800,
    sides: ["LONG"],
    max_leverage: 1,
    markets: SIX,
  },
  TRADER: {
    rank: "TRADER",
    per_bet_bps: 1000,
    max_bets: 3,
    per_round_bps: 2000,
    sides: ["LONG", "SHORT"],
    max_leverage: 2,
    markets: SIX,
  },
};

/**
 * `min_notional`, $11 in 6 decimals (01 1.2 §3). Hyperliquid refuses orders under $10; an order is sized
 * floor(notional / px) cut to the size decimals, so a $10 bet would always become an order a little under $10.
 * The shadow run does not read this constant: it keeps the rulebook it started with (shadow/src/prompts.ts).
 */
export const MIN_NOTIONAL_E6 = 11_000_000n;

/** A limit in dollars (6 decimals): brave_at_open × bps / 10000, rounded down (01 §3). */
export function dollarLimit(braveAtOpenE6: bigint, bps: number): bigint {
  return (braveAtOpenE6 * BigInt(bps)) / 10_000n;
}
