import {
  BASELINE_COMMUNITY,
  type CommunityInputs,
  type FakeInputs,
  type RunInputs,
  type WhaleInputs,
} from "./community.ts";

/**
 * The scenarios and their pass marks. The pass marks were written here before the first full run and are printed in
 * the report's header before any result. They are our bar for "the parameters are good enough", not contract
 * rules; each says where its number comes from. Pure: no node: imports.
 */

/** What a run is measured on (src/sim/metrics.ts works each one out). */
export type MetricName =
  | "price_floor_pct"
  | "worst_loss_vs_limit"
  | "approved_over_limit"
  | "cashout_price_drop_e6"
  | "rank_changes"
  | "tighten_passed"
  | "fake_draw_excess_pts"
  | "honest_refused_full"
  | "fake_jackpot_excess_pts"
  | "prizes_beyond_sources_e6"
  | "book_failures";

export interface PassMark {
  id: string;
  text: string;
  why: string;
  metric: MetricName;
  op: ">=" | "<=";
  value: number;
}

export interface Scenario {
  name: string;
  title: string;
  about: string;
  community: CommunityInputs;
  /** "recorded": the model's own answers from the shadow run; "max": always the most it is told it may bet. */
  intern: "recorded" | "max";
  /** "runner": as many proposals a round as the runner makes (one); "until-full": until the rank's bets are used. */
  asks: "runner" | "until-full";
  /** Days (1 is the first) in which every bet is set against the real price move. */
  losing: { from_day: number; days: number } | null;
  whale: WhaleInputs | null;
  fakes: FakeInputs | null;
  run: RunInputs | null;
  marks: PassMark[];
}

/**
 * The two stress tests' community: the baseline, with cash-outs only after each round's bets have closed. Otherwise
 * a cash-out before the proposal makes a bet of exactly `max_margin_e6` fail OVER_TRADE_LIMIT (01 §3, §6.1), and one
 * during the hold leaves its share of the margin out to those who stay (01 §9.1); both would flatter the limits.
 */
const STRESS_COMMUNITY: CommunityInputs = { ...BASELINE_COMMUNITY, cash_out_any_time: false };

const FLOOR_WHY =
  "INTERN risks at most 2% of the pool a round (01 §3) and the bosses act after a 10% fall (assumed); losing a fifth of the pool in 60 days would mean the limits are too loose";

const ROUND_LIMIT: Omit<PassMark, "id"> = {
  text: "No round loses more than its rank's per-round limit (INTERN 2%, ANALYST 8%, TRADER 20% of the pool when the round opened)",
  why: "01 §3: a bet can lose at most its margin, and a round's margins must fit inside the per-round limit",
  metric: "worst_loss_vs_limit",
  op: "<=",
  value: 1,
};

/** Marks checked on every run of every scenario. */
export const GLOBAL_MARKS: PassMark[] = [
  {
    id: "G1",
    text: "The books balance after every round of every run: coins held add up to the supply, pending money and SAFE add up",
    why: "the simulation's own bookkeeping; any failure means a bug in the sim, not in the coin",
    metric: "book_failures",
    op: "<=",
    value: 0,
  },
  {
    id: "G2",
    text: "With the limits on, no bet is ever approved above its per-bet limit on the limit base",
    why: "01 §3 (1.1): the limit base is the smaller of the pool at the opening and the pool now",
    metric: "approved_over_limit",
    op: "<=",
    value: 0,
  },
];

export const SCENARIOS: Scenario[] = [
  {
    name: "baseline",
    title: "Baseline",
    about:
      "Bosses come and go, lock coins and vote as assumed below; the Intern answers as the recorded model did; real prices.",
    community: BASELINE_COMMUNITY,
    intern: "recorded",
    asks: "runner",
    losing: null,
    whale: null,
    fakes: null,
    run: null,
    marks: [
      {
        id: "BL1",
        text: "With the limits on, the coin price never falls below 80% of its start",
        why: FLOOR_WHY,
        metric: "price_floor_pct",
        op: ">=",
        value: 80,
      },
      { id: "BL2", ...ROUND_LIMIT },
    ],
  },
  {
    name: "losing-streak",
    title: "A losing streak",
    about:
      "As the baseline, but for the first 30 days every bet is set on the side that lost the real price move: the worst luck the prices allow. Bosses cash out only after each round's bets have closed, so no bet is refused for money that left and nobody leaves a share of an open bet behind.",
    community: STRESS_COMMUNITY,
    intern: "recorded",
    asks: "runner",
    losing: { from_day: 1, days: 30 },
    whale: null,
    fakes: null,
    run: null,
    marks: [
      {
        id: "LS1",
        text: "With the limits on, the coin price stays above 80% of its start although every bet of the first 30 days loses",
        why: FLOOR_WHY,
        metric: "price_floor_pct",
        op: ">=",
        value: 80,
      },
      { id: "LS2", ...ROUND_LIMIT },
    ],
  },
  {
    name: "brave-run",
    title: "A run on BRAVE",
    about:
      "As the baseline, but on days 20 and 21 each boss holding coins leaves with a 60% chance: unlocks, takes back pending money and cashes out every coin, some while bets are open.",
    community: BASELINE_COMMUNITY,
    intern: "recorded",
    asks: "runner",
    losing: null,
    whale: null,
    fakes: null,
    run: { day: 20, days: 2, share: 0.6 },
    marks: [
      {
        id: "RB1",
        text: "No cash-out lowers the coin price for those who stay",
        why: "01 §2: rounding always favours the pool; 01 §9.1: a cash-out pays its share of what the pool holds, leaving out margin on open bets",
        metric: "cashout_price_drop_e6",
        op: "<=",
        value: 0,
      },
      {
        id: "RB2",
        text: "With the limits on, no bet is approved above the limit worked out on the money still in the pool",
        why: "01 §3 (1.1): a limit must never be sized on money that has left",
        metric: "approved_over_limit",
        op: "<=",
        value: 0,
      },
      {
        id: "RB3",
        text: "With the limits on, the coin price never falls below 80% of its start",
        why: FLOOR_WHY,
        metric: "price_floor_pct",
        op: ">=",
        value: 80,
      },
    ],
  },
  {
    name: "always-max",
    title: "An Intern that always bets the maximum",
    about:
      "The Intern ignores the record and always asks for the most it is told it may: the largest margin, the highest leverage, a random allowed market and side; the runner asks until the rank's bets are used. Bosses cash out only after each round's bets have closed, so no bet is refused for money that left and nobody leaves a share of an open bet behind.",
    community: STRESS_COMMUNITY,
    intern: "max",
    asks: "until-full",
    losing: null,
    whale: null,
    fakes: null,
    run: null,
    marks: [
      { id: "AM1", ...ROUND_LIMIT },
      {
        id: "AM2",
        text: "With the limits on, the coin price stays above 50% of its start",
        why: "betting the most allowed every round is the worst the ranks allow; losing half the pool in 60 days would mean the ranks are too loose",
        metric: "price_floor_pct",
        op: ">=",
        value: 50,
      },
    ],
  },
  {
    name: "whale-alone",
    title: "A whale who votes alone",
    about:
      "One whale arrives in round 1 holding 25% of the coins then locked and locks them all; he opens a promotion whenever the rules allow and a firing every 10 days, and votes yes. Bosses still lock coins but nobody else votes.",
    community: { ...BASELINE_COMMUNITY, votes: false, playbook_day: null },
    intern: "recorded",
    asks: "runner",
    losing: null,
    whale: { share_of_locked: 0.25, fire_every_days: 10 },
    fakes: null,
    run: null,
    marks: [
      {
        id: "WA1",
        text: "The whale alone, with under 34% of the locked weight, never fires or demotes the Intern",
        why: "01 §9.2 (1.2): demote and fire need yes from 34% of all the weight locked when the vote opened",
        metric: "tighten_passed",
        op: "<=",
        value: 0,
      },
      {
        id: "WA2",
        text: "With the limits on, the coin price stays above 70% of its start while one whale sets the rank",
        why: "a whale with 20% of the locked weight can promote alone (01 §9.2 quorum), up to TRADER's 20% a round (01 §3)",
        metric: "price_floor_pct",
        op: ">=",
        value: 70,
      },
    ],
  },
  {
    name: "nobody-votes",
    title: "Nobody votes",
    about: "As the baseline, but nobody locks coins, so no vote can be opened.",
    community: { ...BASELINE_COMMUNITY, votes: false, lock_share: 0, playbook_day: null },
    intern: "recorded",
    asks: "runner",
    losing: null,
    whale: null,
    fakes: null,
    run: null,
    marks: [
      {
        id: "NV1",
        text: "The rank never changes",
        why: "01 §9.2: only a vote changes the rank, and a vote needs a boss with locked coins",
        metric: "rank_changes",
        op: "<=",
        value: 0,
      },
      { id: "NV2", ...ROUND_LIMIT },
    ],
  },
  {
    name: "fake-farm",
    title: "Fake accounts farming the free guess and the draw",
    about:
      "As the baseline, plus 200 fake accounts registered before the first round, each with $0.01 in BRAVE (to be a boss) and $10 in SAFE (to be jackpot-eligible). They join the draw first and guess every round, covering the guess tree.",
    community: BASELINE_COMMUNITY,
    intern: "recorded",
    asks: "runner",
    losing: null,
    whale: null,
    fakes: { count: 200, brave_usd: 0.01, safe_usd: 10 },
    run: null,
    marks: [
      {
        id: "FF1",
        text: "Fake accounts win no bigger share of the payday draw than their share of the dollars held",
        why: "01 §9.7: tickets are dollars held times rounds, so a fair draw pays in proportion to dollars",
        metric: "fake_draw_excess_pts",
        op: "<=",
        value: 0,
      },
      {
        id: "FF2",
        text: "No honest boss is turned away from the draw because it is full",
        why: "01 §9.7: at most 200 entrants",
        metric: "honest_refused_full",
        op: "<=",
        value: 0,
      },
      {
        id: "FF3",
        text: "Fake accounts win no bigger share of the streak jackpot than their share of the guesses",
        why: "a guess is free; more than their share of guesses means their accounts beat the honest players by covering every answer",
        metric: "fake_jackpot_excess_pts",
        op: "<=",
        value: 0,
      },
      {
        id: "FF4",
        text: "No prize is paid beyond its source: draws from the lender's interest, jackpots from the seed and half the tips",
        why: "01 §9.7: every prize is paid from a named source; nobody's deposit is touched",
        metric: "prizes_beyond_sources_e6",
        op: "<=",
        value: 0,
      },
    ],
  },
];

export function scenarioByName(name: string): Scenario {
  const s = SCENARIOS.find((x) => x.name === name);
  if (!s)
    throw new Error(`no scenario "${name}"; the scenarios are ${SCENARIOS.map((x) => x.name).join(", ")}`);
  return s;
}
