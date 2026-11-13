import type { Decision } from "./decision.ts";
import { dollarLimit, MIN_NOTIONAL_E6, RANKS, type RankName } from "./ranks.ts";

/**
 * A TypeScript copy of the checks in 01-SHARED-INTERFACE.md section 7 (version 1.2), for the runner's forecast of
 * each verdict, its tests and the site's display. The contract's Rust rules are the authority; both pass the 26
 * rule cases of 01 §12 in Engine 1's `intern/interface/vectors/checks.json` (test/rules.test.ts reads that file).
 *
 * Checks 13 to 16 (the funding quote) run only when a quote is attached; nothing here attaches one, so they are
 * not implemented.
 */

/** The sixteen refusal codes, in the order of 01 §7. */
export const REFUSAL_CODES = [
  "OUTSIDE_WINDOW",
  "FIRED",
  "BAD_MODEL_SIGNATURE",
  "WRONG_RULEBOOK",
  "MALFORMED_DECISION",
  "NOT_ON_LIST",
  "SHORT_NOT_UNLOCKED",
  "ZERO_MARGIN",
  "OVER_LEVERAGE",
  "TOO_MANY_TRADES",
  "OVER_TRADE_LIMIT",
  "OVER_ROUND_LIMIT",
  "BAD_QUOTE_SIGNATURE",
  "STALE_QUOTE",
  "QUOTE_MISMATCH",
  "TOO_EXPENSIVE",
] as const;
export type RefusalCode = (typeof REFUSAL_CODES)[number];

export type Phase = "OPEN" | "PROPOSE" | "HOLD" | "CLOSE";
export type Status = "EMPLOYED" | "FIRED";

/** The round as it stands when a proposal arrives. */
export interface RoundState {
  phase: Phase;
  status: Status;
  rank: RankName;
  /** The BRAVE pool when the round opened, dollars with 6 decimals. */
  brave_at_open_e6: bigint;
  /** The BRAVE pool now (`get_pot().brave.total`). The limit base is the smaller of the two (01 1.1 §3). */
  brave_now_e6: bigint;
  bets_used: number;
  at_risk_e6: bigint;
  /** For OUTSIDE_WINDOW's numbers (01 §7): milliseconds into the round, `propose_from_ms` and `propose_until_ms`. */
  ms_into_round: number;
  propose_from_ms: number;
  propose_until_ms: number;
  /**
   * The smallest notional (check 8). Default: 01 1.2's $11. The shadow runs started on 2026-11-11 told the models
   * $10 and are judged with $10 (shadow/src/report.ts).
   */
  min_notional_e6?: bigint;
  /** 01 1.5 (R6): the round's long-shot ticket, from the rulebook's `long_shot:` line (`longShotOf`). */
  ticket?: { margin_e6: bigint; max_leverage: number };
}

/** The most leverage Hyperliquid allows on each market (01 §4): the long-shot ticket is capped by it. */
export const HL_MAX_LEVERAGE: Readonly<Record<string, number>> = {
  DOGE: 10,
  SHIB: 10,
  PEPE: 10,
  TRUMP: 10,
  PENGU: 5,
  WIF: 5,
};

/** 01 §3 (1.1): every dollar limit is a share of the smaller of the pool at the round's start and the pool now. */
export function limitBase(state: Pick<RoundState, "brave_at_open_e6" | "brave_now_e6">): bigint {
  // biome-ignore lint/complexity/useMathMinMax: these are bigints, and Math.min throws on bigint.
  return state.brave_now_e6 < state.brave_at_open_e6 ? state.brave_now_e6 : state.brave_at_open_e6;
}

export type Verdict =
  | { verdict: "YES"; notional_e6: bigint }
  | { verdict: "SKIP" }
  | { verdict: "NOPE"; code: RefusalCode; asked: string | null; limit: string | null };

/** A refusal with 01 §7's `asked` and `limit` numbers as decimal strings. */
export function nope(
  code: RefusalCode,
  asked: bigint | number | null = null,
  limit: bigint | number | null = null,
): Verdict {
  return {
    verdict: "NOPE",
    code,
    asked: asked === null ? null : String(asked),
    limit: limit === null ? null : String(limit),
  };
}

/**
 * Checks 1 and 2: the proposal window, then the firing. Null when both pass. OUTSIDE_WINDOW's limit is
 * `propose_from_ms` when too early (phase OPEN) and `propose_until_ms` when too late (01 1.1 §7).
 */
export function windowAndStatus(state: RoundState): Verdict | null {
  if (state.phase !== "PROPOSE") {
    const limit = state.phase === "OPEN" ? state.propose_from_ms : state.propose_until_ms;
    return nope("OUTSIDE_WINDOW", state.ms_into_round, limit);
  }
  if (state.status === "FIRED") return nope("FIRED");
  return null;
}

/**
 * Checks 6 to 12 for a bet; a skip is accepted (SKIP) and uses none of the limits. Assumes checks 1 to 5 passed.
 * Stops at the first failure, so one proposal gets one code.
 */
export function rankChecks(state: RoundState, decision: Decision): Verdict {
  if (decision.action === "SKIP") return { verdict: "SKIP" };
  const limits = RANKS[state.rank];
  const margin = decision.margin_e6;
  const notional = margin * BigInt(decision.leverage);
  // 6, 7: the market and the direction.
  if (!limits.markets.includes(decision.market)) return nope("NOT_ON_LIST");
  if (!limits.sides.includes(decision.side)) return nope("SHORT_NOT_UNLOCKED");
  // 8: nothing at risk, or under the $11 minimum (01 1.2). `asked` is the notional.
  const minNotional = state.min_notional_e6 ?? MIN_NOTIONAL_E6;
  if (margin === 0n || notional < minNotional) return nope("ZERO_MARGIN", notional, minNotional);
  // 01 1.5 (R6): the round's long-shot ticket: its exact margin above the rank's leverage. Up to the ticket's cap and
  // the market's; one extra bet (10 does not apply); a fixed size (11 does not apply); inside the round's limit (12).
  const t = state.ticket;
  if (t && margin === t.margin_e6 && decision.leverage > limits.max_leverage) {
    const cap = Math.min(t.max_leverage, HL_MAX_LEVERAGE[decision.market] ?? 1);
    if (decision.leverage > cap) return nope("OVER_LEVERAGE", decision.leverage, cap);
    const perRound = dollarLimit(limitBase(state), limits.per_round_bps);
    if (state.at_risk_e6 + margin > perRound)
      return nope("OVER_ROUND_LIMIT", state.at_risk_e6 + margin, perRound);
    return { verdict: "YES", notional_e6: notional };
  }
  // 9: leverage.
  if (decision.leverage > limits.max_leverage)
    return nope("OVER_LEVERAGE", decision.leverage, limits.max_leverage);
  // 10: bets this round.
  if (state.bets_used >= limits.max_bets)
    return nope("TOO_MANY_TRADES", state.bets_used + 1, limits.max_bets);
  // 11, 12: dollars per bet and per round, as shares of the limit base, rounded down.
  const base = limitBase(state);
  const perBet = dollarLimit(base, limits.per_bet_bps);
  if (margin > perBet) return nope("OVER_TRADE_LIMIT", margin, perBet);
  const perRound = dollarLimit(base, limits.per_round_bps);
  if (state.at_risk_e6 + margin > perRound)
    return nope("OVER_ROUND_LIMIT", state.at_risk_e6 + margin, perRound);
  return { verdict: "YES", notional_e6: notional };
}

/** Checks 1, 2 and 6 to 12 for a decision that already passed checks 3 to 5 (signature, rulebook, shape). */
export function checkDecision(state: RoundState, decision: Decision): Verdict {
  return windowAndStatus(state) ?? rankChecks(state, decision);
}
