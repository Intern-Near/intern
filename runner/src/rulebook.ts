import { dollarLimit, MIN_NOTIONAL_E6, RANKS, type RankName } from "./ranks.ts";

/**
 * The rulebook of 01-SHARED-INTERFACE.md section 6.1, byte for byte.
 *
 * In the product the contract writes this text and the runner fetches it with `get_rulebook` and sends it
 * unchanged; the runner never builds it. Two copies exist here:
 * - `buildRulebook`: 01 version 1.0's template. The step 1 recordings and the shadow runs started on 2026-11-11 use
 *   it (the shadow runs add their own lines to it, shadow/src/prompts.ts), so it stays as it was for them.
 * - `buildRulebookV12`: 01 version 1.2's template, for comparing with the contract's text (`preflight`) and for
 *   tests. It passes Engine 1's three rulebook cases in `intern/interface/vectors/checks.json`.
 */
export interface RulebookInput {
  round_id: number;
  /** 16 lower-case hex characters. */
  nonce: string;
  rank: RankName;
  /** The BRAVE pool when the round opened, dollars with 6 decimals. */
  brave_at_open_e6: bigint;
  bets_used: number;
  at_risk_e6: bigint;
  /** Active playbook text, or null for "none". */
  playbook: string | null;
}

/** The smaller of the per-bet limit and what is left of the per-round limit (01 §6.1). */
export function maxMarginE6(input: RulebookInput): bigint {
  const limits = RANKS[input.rank];
  const perBet = dollarLimit(input.brave_at_open_e6, limits.per_bet_bps);
  const roundLeft = dollarLimit(input.brave_at_open_e6, limits.per_round_bps) - input.at_risk_e6;
  const left = roundLeft > 0n ? roundLeft : 0n;
  // biome-ignore lint/complexity/useMathMinMax: these are bigints, and Math.min throws on bigint.
  return perBet < left ? perBet : left;
}

/** 01 version 1.2 §6.1. `min_notional_e6` is `get_constants().min_notional` ($11). */
export function buildRulebookV12(input: RulebookInput, minNotionalE6: bigint = MIN_NOTIONAL_E6): string {
  const lines = buildRulebook(input).split("\n");
  const limits = RANKS[input.rank];
  const round = input.round_id;
  const nonce = input.nonce;
  return [
    ...lines.slice(0, 8), // the first line to max_margin_e6, as in 1.0
    `min_notional_e6: ${minNotionalE6}`,
    `bets_left: ${Math.max(0, limits.max_bets - input.bets_used)}`,
    `playbook: ${input.playbook ?? "none"}`,
    "Amounts are US dollars times 1,000,000, so 10000000 is $10. A bet's notional is margin_e6 times leverage and must be at least min_notional_e6.",
    "Answer with exactly one line of JSON and nothing else, in one of these two forms:",
    `{"v":1,"round":${round},"nonce":"${nonce}","action":"skip"}`,
    `{"v":1,"round":${round},"nonce":"${nonce}","action":"bet","market":"DOGE","side":"long","margin_e6":"11000000","leverage":1}`,
  ].join("\n");
}

export function buildRulebook(input: RulebookInput): string {
  if (!Number.isSafeInteger(input.round_id) || input.round_id < 0) {
    throw new Error("round_id must be a whole number");
  }
  if (!/^[0-9a-f]{16}$/.test(input.nonce)) throw new Error("nonce must be 16 lower-case hex characters");
  if (
    input.playbook !== null &&
    (input.playbook.includes("\n") || Buffer.byteLength(input.playbook) > 2000)
  ) {
    throw new Error("playbook must be one line of at most 2,000 bytes");
  }
  const limits = RANKS[input.rank];
  const round = input.round_id;
  const nonce = input.nonce;
  return [
    "You are the Intern, an AI trader. A program checks your answer against the rules below. An answer that breaks a rule is refused.",
    `round: ${round}`,
    `nonce: ${nonce}`,
    `rank: ${limits.rank}`,
    `markets: ${limits.markets.join(", ")}`,
    `sides: ${limits.sides.map((s) => s.toLowerCase()).join(", ")}`,
    `max_leverage: ${limits.max_leverage}`,
    `max_margin_e6: ${maxMarginE6(input)}`,
    `bets_left: ${Math.max(0, limits.max_bets - input.bets_used)}`,
    `playbook: ${input.playbook ?? "none"}`,
    "Answer with exactly one line of JSON and nothing else, in one of these two forms:",
    `{"v":1,"round":${round},"nonce":"${nonce}","action":"skip"}`,
    `{"v":1,"round":${round},"nonce":"${nonce}","action":"bet","market":"DOGE","side":"long","margin_e6":"1000000","leverage":1}`,
  ].join("\n");
}
