/**
 * Every contract rule and number the simulation uses that is not a rank limit, each with the section of
 * 01-SHARED-INTERFACE.md (version 1.5) it comes from. The rank limits are not here: they come from
 * runner/src/ranks.ts and every proposal is judged by runner/src/rules.ts, the same files the runner and the shadow
 * run use. test/sim-rules01.test.ts compares these numbers with the live testnet coin's views, saved on 2026-11-13.
 *
 * This file is pure (no node: imports), so the website can use the projection later.
 */

/** When things happen inside a round: offsets from the round's start, in milliseconds (01 §5). */
export interface RoundClock {
  round_ms: number;
  guess_close_ms: number;
  propose_from_ms: number;
  propose_until_ms: number;
  close_from_ms: number;
}

/** 01 §5, "Real product": one round a day, starting 00:00 UTC; proposals 12:00 to 13:00; closing from 22:00. */
export const PRODUCT_CLOCK: RoundClock = {
  round_ms: 86_400_000,
  guess_close_ms: 42_900_000,
  propose_from_ms: 43_200_000,
  propose_until_ms: 46_800_000,
  close_from_ms: 79_200_000,
};

/** 01 §5, "Demo deployment (PROPOSED)": 30-minute rounds, as on the live testnet coin. */
export const DEMO_CLOCK: RoundClock = {
  round_ms: 1_800_000,
  guess_close_ms: 840_000,
  propose_from_ms: 900_000,
  propose_until_ms: 1_200_000,
  close_from_ms: 1_500_000,
};

export const DAY_MS = 86_400_000;

/**
 * The clock for a round length in minutes. 01 §5 gives the phase offsets only for the product (1440) and the demo
 * (30); any other length would need offsets 01 does not have, so it is refused rather than guessed.
 */
export function clockFor(roundMinutes: number): RoundClock {
  if (roundMinutes === 1440) return PRODUCT_CLOCK;
  if (roundMinutes === 30) return DEMO_CLOCK;
  throw new Error(
    `01 §5 gives the phase offsets only for 1440-minute (product) and 30-minute (demo) rounds, not ${roundMinutes}`,
  );
}

/** Rounds in one day for a clock (1 for the product, 48 for the demo). */
export function roundsPerDay(clock: RoundClock): number {
  return DAY_MS / clock.round_ms;
}

/**
 * 01 §9.2, `get_constants().vote` (PROPOSED there). `vote_ms`, how long a vote stays open, is one round length, so
 * a vote opened in round r closes at the same moment of round r + 1.
 */
export const VOTE = {
  promote_pass_bps: 5_000,
  promote_quorum_bps: 2_000,
  tighten_pass_bps: 3_400,
  weight_full_rounds: 7,
} as const;

/** 01 §9.5 (1.3): `coach_cut_bps`, PROPOSED 1,000 = 10% of a winning round's result, paid to the playbook's authors. */
export const COACH_CUT_BPS = 1_000;

/** 01 §9.7 (1.4): the reward ladder's constants, `get_rewards().constants`. */
export const REWARDS = {
  golden_odds: 50,
  golden_cap: 100,
  /** The sixteen refusal codes of 01 §7: a golden sticker is one of them. */
  golden_codes: 16,
  jackpot_streak: 7,
  min_boss_usd_e6: 10_000_000n,
  min_boss_rounds: 7,
  tip_to_jackpot_bps: 5_000,
  draw_rounds: 7,
  draw_top_bps: 7_000,
  draw_runners: 10,
  max_entrants: 200,
} as const;

/**
 * 01 §9.6 (1.3): the STAND-IN lender pays a fixed test rate, PROPOSED 5% a year, on what is lent. 01 says only "a
 * year"; the lender counts simple interest over 365 days (`YEAR_MS` in crates/lender/src/lib.rs). Since 1.4 the
 * interest goes to the payday draw, not to the pool (01 §9.6, §9.7).
 */
export const LENDER = { rate_bps: 500, year_ms: 31_536_000_000 } as const;

/** 01 §9.1 (1.4): registering costs 1,280 bytes of storage, 0.0128 NEAR. Counted for fake accounts; NEAR is not simulated. */
export const REGISTRATION_NEAR = 0.0128;

/** 01 §9.1: 1,000 units of coin from the first deposit ever are locked for ever. */
export const LOCKED_FOREVER = 1_000n;

/**
 * 01 §9.1 names `min_first_deposit` but gives no number. This is the live testnet coin's value
 * (`get_constants().min_first_deposit`, read 2026-11-13); the product's own value is UNVERIFIED.
 */
export const MIN_FIRST_DEPOSIT_E6 = 10_000_000n;

/** 01 §9.6: `rebalance` lends what is idle beyond the Intern's slice only if it is at least $10. */
export const MIN_LEND_E6 = 10_000_000n;

/** Hyperliquid refuses orders under $10 (01 §3, VERIFIED there). Used only when the rank limits are switched off. */
export const HL_MIN_ORDER_E6 = 10_000_000n;

/** 01 §6.3 (1.2): the pinned model, whose recorded answers the Intern replays by default. */
export const PINNED_MODEL = "z-ai/glm-5.3-flash";

/** Basis points in one whole, and millionths in one whole. */
export const BPS = 10_000n;
export const PPM = 1_000_000;
