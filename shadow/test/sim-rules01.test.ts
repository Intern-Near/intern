import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { MIN_NOTIONAL_E6, RANKS } from "../../runner/src/ranks.ts";
import {
  COACH_CUT_BPS,
  clockFor,
  DEMO_CLOCK,
  LENDER,
  MIN_FIRST_DEPOSIT_E6,
  PINNED_MODEL,
  PRODUCT_CLOCK,
  REWARDS,
  VOTE,
} from "../src/sim/rules01.ts";
import { view } from "./sim-fixtures.ts";

// The numbers the simulation cites from 01, against the live testnet coin's own views, saved by src/sim/fetch.ts on
// 2026-11-13 (shadow/fixtures/sim/testnet-views-2026-11-13). The live coin is the demo deployment (30-minute rounds).

interface Constants {
  ranks: {
    rank: string;
    per_bet_bps: number;
    max_bets: number;
    per_round_bps: number;
    max_leverage: number;
  }[];
  min_notional: string;
  round: Record<string, number>;
  vote: Record<string, number>;
  model: { id: string };
  min_first_deposit: string;
  coach_cut_bps: number;
}

const constants = view("get_constants") as Constants;
const rewards = (view("get_rewards") as { constants: Record<string, number | string> }).constants;

describe("01's numbers in src/sim/rules01.ts match the live coin", () => {
  it("vote rules (01 §9.2), one round per vote", () => {
    assert.equal(constants.vote.promote_pass_bps, VOTE.promote_pass_bps);
    assert.equal(constants.vote.promote_quorum_bps, VOTE.promote_quorum_bps);
    assert.equal(constants.vote.tighten_pass_bps, VOTE.tighten_pass_bps);
    assert.equal(constants.vote.weight_full_rounds, VOTE.weight_full_rounds);
    assert.equal(constants.vote.vote_ms, DEMO_CLOCK.round_ms);
  });

  it("the demo round's offsets (01 §5)", () => {
    for (const k of [
      "round_ms",
      "guess_close_ms",
      "propose_from_ms",
      "propose_until_ms",
      "close_from_ms",
    ] as const) {
      assert.equal(constants.round[k], DEMO_CLOCK[k], k);
    }
    assert.equal(clockFor(30), DEMO_CLOCK);
    assert.equal(clockFor(1440), PRODUCT_CLOCK);
    assert.throws(() => clockFor(60), /only for 1440-minute \(product\) and 30-minute \(demo\)/);
  });

  it("the rank limits the runner uses are the live coin's (01 §3)", () => {
    for (const r of constants.ranks) {
      const ours = RANKS[r.rank as keyof typeof RANKS];
      assert.equal(ours.per_bet_bps, r.per_bet_bps);
      assert.equal(ours.max_bets, r.max_bets);
      assert.equal(ours.per_round_bps, r.per_round_bps);
      assert.equal(ours.max_leverage, r.max_leverage);
    }
    assert.equal(BigInt(constants.min_notional), MIN_NOTIONAL_E6);
  });

  it("the reward ladder's constants (01 §9.7)", () => {
    assert.equal(rewards.golden_odds, REWARDS.golden_odds);
    assert.equal(rewards.golden_cap, REWARDS.golden_cap);
    assert.equal(rewards.jackpot_streak, REWARDS.jackpot_streak);
    assert.equal(BigInt(rewards.min_boss_usd as string), REWARDS.min_boss_usd_e6);
    assert.equal(rewards.min_boss_rounds, REWARDS.min_boss_rounds);
    assert.equal(rewards.tip_to_jackpot_bps, REWARDS.tip_to_jackpot_bps);
    assert.equal(rewards.draw_rounds, REWARDS.draw_rounds);
    assert.equal(rewards.draw_top_bps, REWARDS.draw_top_bps);
    assert.equal(rewards.draw_runners, REWARDS.draw_runners);
    assert.equal(rewards.max_entrants, REWARDS.max_entrants);
  });

  it("coach cut, first deposit, pinned model, the stand-in lender's rate", () => {
    assert.equal(constants.coach_cut_bps, COACH_CUT_BPS);
    assert.equal(BigInt(constants.min_first_deposit), MIN_FIRST_DEPOSIT_E6);
    assert.equal(constants.model.id, PINNED_MODEL);
    assert.equal(view("lender-get_rate"), LENDER.rate_bps);
  });
});
